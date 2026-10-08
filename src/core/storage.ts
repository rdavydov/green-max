import type { Chat, History, Message, MessageStatus, PendingStatus } from './types';
import { record } from './api';

type HistoryStorage = Pick<Storage, 'getItem' | 'setItem'>;

export class HistoryStorageError extends Error {
  constructor(message = 'Не удалось сохранить историю в браузере. Освободите место и нажмите «Повторить».') {
    super(message);
    this.name = 'HistoryStorageError';
  }
}

export function historyKey(idInstance: string): string {
  return `green-max:history:v1:${idInstance}`;
}

const statuses = new Set<MessageStatus>(['sending', 'queued', 'sent', 'delivered', 'read', 'failed', 'uncertain']);

function parseMessage(value: unknown, chatId: string): Message | null {
  const data = record(value);
  if (!data || typeof data.id !== 'string' || !data.id || data.chatId !== chatId
    || data.direction !== 'incoming' && data.direction !== 'outgoing'
    || typeof data.text !== 'string' || typeof data.timestamp !== 'number' || !Number.isFinite(data.timestamp)
    || data.timestamp < 0 || data.timestamp > 8.64e15 || typeof data.status !== 'string' || !statuses.has(data.status as MessageStatus)
    || data.error !== undefined && typeof data.error !== 'string') return null;
  const interrupted = data.status === 'sending';
  return {
    id: data.id, chatId, direction: data.direction, text: data.text, timestamp: data.timestamp,
    status: interrupted ? 'uncertain' : data.status as MessageStatus,
    ...(interrupted ? { error: 'Отправка прервалась. Проверьте доставку в MAX перед повторной отправкой.' }
      : typeof data.error === 'string' ? { error: data.error } : {}),
  };
}

export function parseHistory(value: unknown): History | null {
  const data = record(value);
  if (!data || data.version !== 1 || !Array.isArray(data.chats)) return null;
  const chats: Chat[] = [];
  const ids = new Set<string>();
  for (const item of data.chats) {
    const chat = record(item);
    if (!chat || typeof chat.id !== 'string' || !/^\d+$/.test(chat.id) || ids.has(chat.id)
      || typeof chat.name !== 'string' || chat.phone !== undefined && typeof chat.phone !== 'string'
      || !Array.isArray(chat.messages)) return null;
    ids.add(chat.id);
    const messages: Message[] = [];
    const messageIds = new Set<string>();
    for (const item of chat.messages) {
      const message = parseMessage(item, chat.id);
      if (!message || messageIds.has(message.id)) return null;
      messageIds.add(message.id);
      messages.push(message);
    }
    chats.push({ id: chat.id, name: chat.name, ...(typeof chat.phone === 'string' ? { phone: chat.phone } : {}),
      messages: messages.sort((first, second) => first.timestamp - second.timestamp) });
  }
  const pendingStatuses: PendingStatus[] = [];
  const statusIds = new Set<string>();
  if (data.pendingStatuses !== undefined) {
    if (!Array.isArray(data.pendingStatuses)) return null;
    for (const item of data.pendingStatuses) {
      const status = record(item);
      if (!status || typeof status.chatId !== 'string' || !/^\d+$/.test(status.chatId)
        || typeof status.id !== 'string' || !status.id
        || status.status !== 'sent' && status.status !== 'delivered' && status.status !== 'read' && status.status !== 'failed'
        || status.error !== undefined && typeof status.error !== 'string') return null;
      const key = `${status.chatId}:${status.id}`;
      if (statusIds.has(key)) return null;
      statusIds.add(key);
      pendingStatuses.push({ chatId: status.chatId, id: status.id, status: status.status,
        ...(typeof status.error === 'string' ? { error: status.error } : {}) });
    }
  }
  return { version: 1, chats, ...(pendingStatuses.length ? { pendingStatuses } : {}) };
}

export function loadHistory(idInstance: string, storage?: HistoryStorage): History {
  let raw: string | null;
  try { raw = (storage ?? localStorage).getItem(historyKey(idInstance)); }
  catch { throw new HistoryStorageError('Браузер запретил доступ к истории. Разрешите локальное хранилище для этого сайта.'); }
  if (raw === null) return { version: 1, chats: [] };
  let history: History | null;
  try { history = parseHistory(JSON.parse(raw)); }
  catch { history = null; }
  if (!history) {
    throw new HistoryStorageError('Сохраненная история повреждена. Удалите данные этого сайта в настройках браузера и войдите снова.');
  }
  return history;
}

export function saveHistory(idInstance: string, history: History, storage?: HistoryStorage): void {
  // Persist only the public history model; credentials and webhook envelopes never enter storage.
  const clean: History = { version: 1, chats: history.chats.map(chat => ({
    id: chat.id, name: chat.name, ...(chat.phone ? { phone: chat.phone } : {}),
    messages: chat.messages.map(message => ({
      id: message.id, chatId: message.chatId, direction: message.direction, text: message.text,
      timestamp: message.timestamp, status: message.status, ...(message.error ? { error: message.error } : {}),
    })),
  })), ...(history.pendingStatuses?.length ? { pendingStatuses: history.pendingStatuses.map(status => ({
    chatId: status.chatId, id: status.id, status: status.status, ...(status.error ? { error: status.error } : {}),
  })) } : {}) };
  try { (storage ?? localStorage).setItem(historyKey(idInstance), JSON.stringify(clean)); }
  catch { throw new HistoryStorageError(); }
}
