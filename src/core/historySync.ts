import type { AccountSettings } from './api';
import { upsertMessage } from './notifications';
import type { Chat, History, Message } from './types';

export function mergeRemoteChats(history: History, remoteChats: Chat[], account?: AccountSettings): History {
  const chats = new Map(history.chats.map(chat => [chat.id, chat]));
  for (const remote of remoteChats) {
    const existing = chats.get(remote.id);
    chats.set(remote.id, { ...existing, ...remote,
      name: remote.name === remote.id && existing ? existing.name : remote.name,
      ...(remote.type ?? existing?.type ? { type: remote.type ?? existing?.type } : {}),
      messages: existing?.messages ?? remote.messages,
      ...(remote.phone || existing?.phone ? { phone: remote.phone ?? existing?.phone } : {}) });
  }
  if (account) {
    const self = chats.get(account.chatId);
    if (self) chats.set(account.chatId, { ...self, type: 'user', name: 'Избранное', phone: account.phone });
  }
  return { ...history, chats: [...chats.values()] };
}

export function mergeRemoteHistory(history: History, chatId: string, messages: Message[]): History {
  let merged = history;
  for (const message of messages) {
    if (message.chatId !== chatId) continue;
    merged = upsertMessage(merged, { kind: 'message', message, apiEcho: false }).history;
  }
  return merged;
}
