import { record } from './api';
import type { Chat, History, Message, MessageStatus, PendingStatus } from './types';

export type NormalizedEvent =
  | { kind: 'message'; message: Message; name?: string; phone?: string; apiEcho: boolean }
  | ({ kind: 'status' } & PendingStatus)
  | { kind: 'state'; state: string }
  | { kind: 'ignore' };

export function normalizeNotification(value: unknown): NormalizedEvent {
  const body = record(value);
  if (!body) return { kind: 'ignore' };
  if (body.typeWebhook === 'stateInstanceChanged' && typeof body.stateInstance === 'string') {
    return { kind: 'state', state: body.stateInstance };
  }
  if (body.typeWebhook === 'outgoingMessageStatus') {
    if (typeof body.chatId !== 'string' || !/^\d+$/.test(body.chatId)
      || typeof body.idMessage !== 'string' || !body.idMessage) return { kind: 'ignore' };
    const status: PendingStatus['status'] | null = body.status === 'delivered' || body.status === 'read'
      ? body.status : ['failed', 'noAccount', 'notInGroup'].includes(String(body.status)) ? 'failed' : null;
    if (!status) return { kind: 'ignore' };
    const error = body.status === 'noAccount' ? 'Получатель не найден в MAX.'
      : status === 'failed' ? 'MAX не смог доставить сообщение.' : undefined;
    return { kind: 'status', chatId: body.chatId, id: body.idMessage, status, ...(error ? { error } : {}) };
  }
  const incoming = body.typeWebhook === 'incomingMessageReceived';
  const apiEcho = body.typeWebhook === 'outgoingAPIMessageReceived';
  const outgoing = apiEcho || body.typeWebhook === 'outgoingMessageReceived';
  if (!incoming && !outgoing) return { kind: 'ignore' };
  const sender = record(body.senderData);
  const data = record(body.messageData);
  if (!sender || !data || typeof sender.chatId !== 'string' || !/^\d+$/.test(sender.chatId)
    || sender.chatType !== undefined && sender.chatType !== 'user'
    || typeof body.idMessage !== 'string' || !body.idMessage
    || typeof body.timestamp !== 'number' || !Number.isFinite(body.timestamp)
    || body.timestamp < 0 || body.timestamp > 8.64e12) return { kind: 'ignore' };
  const text = data.typeMessage === 'textMessage' ? record(data.textMessageData)?.textMessage
    : data.typeMessage === 'extendedTextMessage' ? record(data.extendedTextMessageData)?.text : null;
  if (typeof text !== 'string') return { kind: 'ignore' };
  const name = typeof sender.chatName === 'string' && sender.chatName ? sender.chatName
    : typeof sender.senderName === 'string' && sender.senderName ? sender.senderName : undefined;
  const phone = typeof sender.senderPhoneNumber === 'string' || typeof sender.senderPhoneNumber === 'number'
    ? String(sender.senderPhoneNumber) : undefined;
  return {
    kind: 'message', apiEcho,
    ...(name ? { name } : {}), ...(phone && /^[1-9]\d*$/.test(phone) ? { phone } : {}),
    message: { id: body.idMessage, chatId: sender.chatId, direction: incoming ? 'incoming' : 'outgoing',
      text, timestamp: body.timestamp * 1000, status: incoming ? 'delivered' : 'queued' },
  };
}

const rank: Record<MessageStatus, number> = { sending: 0, queued: 1, uncertain: 1, failed: 2, delivered: 3, read: 4 };

export function mergeStatus(previous: MessageStatus, next: MessageStatus): MessageStatus {
  return rank[next] >= rank[previous] ? next : previous;
}

export function upsertMessage(history: History, event: Extract<NormalizedEvent, { kind: 'message' }>): {
  history: History;
  alias?: { localId: string; serverId: string };
} {
  const message = event.message;
  const previousChat = history.chats.find(chat => chat.id === message.chatId);
  const chat: Chat = previousChat ?? { id: message.chatId, name: event.name ?? event.phone ?? message.chatId,
    ...(event.phone ? { phone: event.phone } : {}), messages: [] };
  let existing = chat.messages.find(item => item.id === message.id);
  let alias: { localId: string; serverId: string } | undefined;
  if (!existing && event.apiEcho) {
    // Only one POST per chat is allowed. An API echo may beat its HTTP response.
    const candidates = chat.messages.filter(item => item.id.startsWith('local:') && item.direction === 'outgoing'
      && (item.status === 'sending' || item.status === 'uncertain') && item.text === message.text
      && message.timestamp >= item.timestamp - 1000 && message.timestamp <= item.timestamp + 60_000);
    if (candidates.length === 1) {
      existing = candidates[0];
      alias = { localId: existing.id, serverId: message.id };
    }
  }
  const merged: Message = existing ? { ...existing, ...message, status: mergeStatus(existing.status, message.status) } : message;
  if (merged.status !== 'failed' && merged.status !== 'uncertain') delete merged.error;
  const messages = (existing ? chat.messages.map(item => item.id === existing.id ? merged : item) : [...chat.messages, merged])
    .sort((first, second) => first.timestamp - second.timestamp);
  const updated: Chat = { ...chat, name: event.name ?? chat.name, ...(event.phone ? { phone: event.phone } : {}), messages };
  return {
    history: { ...history, chats: previousChat ? history.chats.map(item => item.id === chat.id ? updated : item) : [...history.chats, updated] },
    ...(alias ? { alias } : {}),
  };
}

export function updateMessage(history: History, chatId: string, id: string, change: Partial<Message>): History {
  return { ...history, chats: history.chats.map(chat => chat.id !== chatId ? chat : { ...chat,
    messages: chat.messages.map(message => message.id !== id ? message : { ...message, ...change }) }) };
}

export function applyStatus(history: History, event: Extract<NormalizedEvent, { kind: 'status' }>): History {
  const message = history.chats.find(chat => chat.id === event.chatId)?.messages.find(message => message.id === event.id);
  if (!message || message.direction !== 'outgoing') return history;
  const status = mergeStatus(message.status, event.status);
  const updated = { ...message, status };
  if (status === 'failed') updated.error = event.error ?? message.error;
  else delete updated.error;
  return updateMessage(history, event.chatId, event.id, updated);
}

export function confirmSend(history: History, chatId: string, localId: string, serverId: string): History {
  const chat = history.chats.find(chat => chat.id === chatId);
  if (!chat) return history;
  const optimistic = chat.messages.find(message => message.id === localId);
  const echoed = chat.messages.find(message => message.id === serverId);
  if (!optimistic) return echoed ? updateMessage(history, chatId, serverId,
    { status: mergeStatus(echoed.status, 'queued'), error: echoed.status === 'failed' ? echoed.error : undefined }) : history;
  const status = mergeStatus(echoed?.status ?? optimistic.status, 'queued');
  const confirmed = { ...optimistic, ...(echoed ?? {}), id: serverId,
    status, error: status === 'failed' ? echoed?.error ?? optimistic.error : undefined };
  const messages = chat.messages.filter(message => message.id !== serverId || message.id === localId)
    .map(message => message.id === localId ? confirmed : message)
    .sort((first, second) => first.timestamp - second.timestamp);
  return { ...history, chats: history.chats.map(item => item.id === chatId ? { ...chat, messages } : item) };
}
