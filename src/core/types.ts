export interface Credentials {
  idInstance: string;
  apiTokenInstance: string;
}

export type MessageStatus = 'sending' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'uncertain';
export type ChatType = 'user' | 'group' | 'channel' | 'bot';

export function isChatType(value: unknown): value is ChatType {
  return value === 'user' || value === 'group' || value === 'channel' || value === 'bot';
}

export function isChatId(value: unknown): value is string {
  return typeof value === 'string' && /^-?\d+$/.test(value);
}

export interface Message {
  id: string;
  chatId: string;
  direction: 'incoming' | 'outgoing';
  text: string;
  timestamp: number;
  status: MessageStatus;
  senderName?: string;
  error?: string;
}

export interface Chat {
  id: string;
  phone?: string;
  name: string;
  type?: ChatType;
  messages: Message[];
}

export interface PendingStatus {
  chatId: string;
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  error?: string;
}

export interface History {
  version: 1;
  chats: Chat[];
  pendingStatuses?: PendingStatus[];
}

export interface Messenger {
  phase: 'signed-out' | 'connecting' | 'connected';
  chats: Chat[];
  busyChatIds: string[];
  connection: { status: 'online' | 'reconnecting' | 'storage-error'; message?: string };
  error: string | null;
  notice?: string | null;
  loadingChatIds?: string[];
  login(credentials: Credentials): Promise<boolean>;
  logout(): void;
  createChat(phone: string): Promise<string | null>;
  loadChat(chatId: string): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<boolean>;
  retry(): void;
  clearError(): void;
}
