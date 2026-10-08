import type { Credentials } from './types';

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
}

export interface GreenApi {
  getState(signal: AbortSignal): Promise<string>;
  getSettings(signal: AbortSignal): Promise<InstanceSettings>;
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

export function createGreenApi(credentials: Credentials, baseUrl?: string): GreenApi {
  const configuredUrl = baseUrl ?? import.meta.env.VITE_GREEN_API_URL ?? 'https://api.green-api.com/v3';
  const url = configuredUrl.replace(/\/+$/, '');
  const instance = encodeURIComponent(credentials.idInstance);
  const token = encodeURIComponent(credentials.apiTokenInstance);

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
      return { typeInstance: data.typeInstance, webhookUrl: data.webhookUrl, incomingWebhook: data.incomingWebhook };
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
