import { isChatId, isChatType, type Chat, type Credentials, type Message, type MessageStatus } from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status = 0,
    public readonly kind: 'http' | 'network' | 'protocol' = 'http',
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isAuthError(): boolean {
    return this.status === 401 || (this.status === 403 && !this.message.includes('suspended'));
  }
}

export interface Notification {
  receiptId: number;
  body: unknown;
}

export interface InstanceSettings {
  typeInstance: string;
  webhookUrl: string;
  incomingWebhook: string;
  outgoingWebhook?: string;
  outgoingAPIMessageWebhook?: string;
  outgoingMessageWebhook?: string;
}

export interface AccountSettings {
  chatId: string;
  phone: string;
}

export interface GreenApi {
  getState(signal: AbortSignal): Promise<string>;
  getSettings(signal: AbortSignal): Promise<InstanceSettings>;
  getAccountSettings(signal: AbortSignal): Promise<AccountSettings>;
  getChats(signal: AbortSignal): Promise<Chat[]>;
  getChatHistory(chatId: string, signal: AbortSignal): Promise<Message[]>;
  checkAccount(phone: string, signal: AbortSignal): Promise<string>;
  sendMessage(chatId: string, message: string, signal: AbortSignal): Promise<string>;
  receive(signal: AbortSignal): Promise<Notification | null>;
  acknowledge(receiptId: number, signal: AbortSignal): Promise<boolean>;
}

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function serverError(status: number, value: unknown): string {
  const data = record(value);
  const detail = [data?.reason, data?.description, data?.error, data?.message]
    .find((part): part is string => typeof part === 'string');
  if (status === 401 || status === 403 && !detail?.includes('suspended')) {
    return 'GREEN-API отклонил учетные данные. Проверьте idInstance и apiTokenInstance.';
  }
  if (detail?.includes('suspended')) return 'Аккаунт MAX временно ограничен (suspended).';
  if (status === 429) return 'Превышена частота запросов GREEN-API. Повторим подключение позже.';
  if (status === 469) return 'MAX ограничил проверку номеров. Попробуйте создать чат позже.';
  if (detail?.includes('custom webhook url')) {
    return 'Очистите webhookUrl в кабинете GREEN-API для получения сообщений через HTTP API.';
  }
  return `Ошибка GREEN-API${status ? ` (${status})` : ''}. Попробуйте еще раз.`;
}

function protocolError(): ApiError {
  return new ApiError('GREEN-API вернул неожиданный ответ. Попробуйте еще раз.', 0, 'protocol');
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    const abort = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function parseRemoteChats(value: unknown): Chat[] {
  if (!Array.isArray(value)) throw protocolError();
  const chats = new Map<string, Chat>();
  for (const item of value) {
    const data = record(item);
    if (!data || !isChatType(data.type)) continue;
    if (!isChatId(data.chatId)
      || typeof data.name !== 'string') throw protocolError();
    const phone = typeof data.phoneNumber === 'number' || typeof data.phoneNumber === 'string'
      ? String(data.phoneNumber) : '';
    chats.set(data.chatId, {
      id: data.chatId, type: data.type, name: data.name || (data.type === 'user' && phone !== '0' && phone ? `+${phone}` : data.chatId),
      ...(data.type === 'user' && /^[1-9]\d*$/.test(phone) ? { phone } : {}), messages: [],
    });
  }
  return [...chats.values()];
}

function parseRemoteHistory(value: unknown, chatId: string): Message[] {
  if (!Array.isArray(value)) throw protocolError();
  const messages = new Map<string, Message>();
  for (const item of value) {
    const data = record(item);
    if (!data || data.chatId !== chatId || data.chatType !== undefined && !isChatType(data.chatType)
      || data.isDeleted === true
      || data.typeMessage !== 'textMessage' && data.typeMessage !== 'extendedTextMessage') continue;
    const text = typeof data.textMessage === 'string' ? data.textMessage : record(data.extendedTextMessage)?.text;
    if (typeof data.idMessage !== 'string' || !data.idMessage || typeof text !== 'string'
      || data.type !== 'incoming' && data.type !== 'outgoing'
      || typeof data.timestamp !== 'number' || !Number.isFinite(data.timestamp)
      || data.timestamp < 0 || data.timestamp > 8.64e12) throw protocolError();
    const status: MessageStatus = data.type === 'incoming' ? 'delivered'
      : data.statusMessage === 'read' || data.statusMessage === 'delivered' || data.statusMessage === 'failed'
        ? data.statusMessage : data.statusMessage === 'pending' ? 'queued'
          : data.statusMessage === 'sent' || data.statusMessage === '' || data.statusMessage === undefined ? 'sent' : 'uncertain';
    messages.set(data.idMessage, {
      id: data.idMessage, chatId, direction: data.type, text, timestamp: data.timestamp * 1000, status,
      ...(data.type === 'incoming' && typeof data.senderName === 'string' && data.senderName
        ? { senderName: data.senderName } : {}),
      ...(status === 'failed' ? { error: 'MAX не смог доставить сообщение.' } : {}),
    });
  }
  return [...messages.values()].sort((first, second) => first.timestamp - second.timestamp);
}

export function createGreenApi(credentials: Credentials, baseUrl?: string): GreenApi {
  const configuredUrl = baseUrl ?? import.meta.env.VITE_GREEN_API_URL ?? 'https://api.green-api.com/v3';
  const url = configuredUrl.replace(/\/+$/, '');
  const instance = encodeURIComponent(credentials.idInstance);
  const token = encodeURIComponent(credentials.apiTokenInstance);
  let historyQueue: Promise<unknown> = Promise.resolve();
  let lastHistoryStart = 0;

  async function request(
    method: string,
    verb: 'GET' | 'POST' | 'DELETE',
    signal: AbortSignal,
    body?: object,
    suffix = '',
    emptyAllowed = false,
  ): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    const timeout = setTimeout(abort, method === 'receiveNotification' ? 40_000 : 20_000);
    try {
      const response = await fetch(`${url}/waInstance${instance}/${method}/${token}${suffix}`, {
        method: verb,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
        signal: controller.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
      const text = await response.text();
      let data: unknown = null;
      if (text.trim()) {
        try { data = JSON.parse(text); }
        catch {
          if (!response.ok) throw new ApiError(serverError(response.status, null), response.status);
          throw protocolError();
        }
      }
      if (!response.ok) throw new ApiError(serverError(response.status, data), response.status);
      if (data === null && !emptyAllowed) throw protocolError();
      return data;
    } catch (error) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (error instanceof ApiError) throw error;
      throw new ApiError('Не удалось связаться с GREEN-API. Проверьте подключение к Интернету.', 0, 'network');
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    }
  }

  return {
    async getState(signal) {
      const data = record(await request('getStateInstance', 'GET', signal));
      if (typeof data?.stateInstance !== 'string') throw protocolError();
      return data.stateInstance;
    },
    async getSettings(signal) {
      const data = record(await request('getSettings', 'GET', signal));
      if (typeof data?.typeInstance !== 'string' || typeof data.webhookUrl !== 'string'
        || typeof data.incomingWebhook !== 'string') throw protocolError();
      return {
        typeInstance: data.typeInstance, webhookUrl: data.webhookUrl, incomingWebhook: data.incomingWebhook,
        ...(typeof data.outgoingWebhook === 'string' ? { outgoingWebhook: data.outgoingWebhook } : {}),
        ...(typeof data.outgoingAPIMessageWebhook === 'string' ? { outgoingAPIMessageWebhook: data.outgoingAPIMessageWebhook } : {}),
        ...(typeof data.outgoingMessageWebhook === 'string' ? { outgoingMessageWebhook: data.outgoingMessageWebhook } : {}),
      };
    },
    async getAccountSettings(signal) {
      const data = record(await request('getAccountSettings', 'GET', signal));
      if (typeof data?.chatId !== 'string' || !/^\d+$/.test(data.chatId)
        || typeof data.phone !== 'string' || !/^[1-9]\d*$/.test(data.phone)) throw protocolError();
      return { chatId: data.chatId, phone: data.phone };
    },
    async getChats(signal) {
      return parseRemoteChats(await request('getChats', 'GET', signal));
    },
    getChatHistory(chatId, signal) {
      const task = historyQueue.catch(() => {}).then(async () => {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const delay = 1050 - (Date.now() - lastHistoryStart);
        if (delay > 0) await wait(delay, signal);
        lastHistoryStart = Date.now();
        return parseRemoteHistory(await request('getChatHistory', 'POST', signal, { chatId, count: 100 }), chatId);
      });
      historyQueue = task;
      return task;
    },
    async checkAccount(phone, signal) {
      const data = record(await request('checkAccount', 'POST', signal, { phoneNumber: Number(phone) }));
      if (data?.status === false) {
        const reason = typeof data.reason === 'string' ? data.reason : '';
        throw new ApiError(reason.includes('limit')
          ? 'MAX ограничил проверку номеров. Попробуйте позже.'
          : 'Инстанс MAX не готов. Проверьте его авторизацию в GREEN-API.');
      }
      if (data?.exist === false) throw new ApiError('Этот номер не найден в MAX или скрыт настройками приватности.');
      if (data?.exist !== true || typeof data.chatId !== 'string' || !/^\d+$/.test(data.chatId)) throw protocolError();
      return data.chatId;
    },
    async sendMessage(chatId, message, signal) {
      const data = record(await request('sendMessage', 'POST', signal, { chatId, message }));
      if (typeof data?.idMessage !== 'string' || !data.idMessage) throw protocolError();
      return data.idMessage;
    },
    async receive(signal) {
      const data = await request('receiveNotification', 'GET', signal, undefined, '?receiveTimeout=30', true);
      if (data === null) return null;
      const notification = record(data);
      if (!notification || !Number.isSafeInteger(notification.receiptId) || Number(notification.receiptId) < 0
        || !('body' in notification)) throw protocolError();
      return { receiptId: notification.receiptId as number, body: notification.body };
    },
    async acknowledge(receiptId, signal) {
      const data = record(await request('deleteNotification', 'DELETE', signal, undefined, `/${receiptId}`));
      if (typeof data?.result !== 'boolean') throw protocolError();
      return data.result;
    },
  };
}

export function normalizePhone(input: string): string | null {
  if (/[^\d\s+()-]/.test(input)) return null;
  const phone = input.replace(/\D/g, '');
  return /^(?:7\d{10}|375\d{9})$/.test(phone) ? phone : null;
}
