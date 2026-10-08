import { describe, expect, it } from 'vitest';
import { mergeRemoteChats, mergeRemoteHistory } from './historySync';
import type { History, Message } from './types';

const message = (change: Partial<Message> = {}): Message => ({
  id: 'message-1', chatId: '100', direction: 'outgoing', text: 'Привет', timestamp: 100_000, status: 'read', ...change,
});
const history = (): History => ({ version: 1, chats: [
  { id: '100', phone: '79991234567', name: '+79991234567', messages: [message()] },
] });

describe('MAX chat synchronization', () => {
  it('updates chat names without losing browser history or a known hidden phone', () => {
    const merged = mergeRemoteChats(history(), [
      { id: '100', name: 'Анна', messages: [] }, { id: '101', name: 'Борис', messages: [] },
    ]);
    expect(merged.chats).toEqual([
      { id: '100', phone: '79991234567', name: 'Анна', messages: [message()] },
      { id: '101', name: 'Борис', messages: [] },
    ]);
  });

  it('identifies Favorites from the account chat ID instead of a guessed phone', () => {
    const merged = mergeRemoteChats(history(), [{ id: '100', name: 'Roman', messages: [] }], {
      chatId: '100', phone: '79991234567',
    });
    expect(merged.chats[0].name).toBe('Избранное');
    expect(merged.chats[0].messages).toEqual([message()]);
  });

  it('keeps a known name when the server has no name for a chat', () => {
    expect(mergeRemoteChats(history(), [{ id: '100', name: '100', messages: [] }]).chats[0].name).toBe('+79991234567');
  });

  it('retains known nonpersonal chat types when merging a legacy chat without a type', () => {
    const stored: History = { version: 1, chats: [{ id: '-100', type: 'channel', name: 'Канал', messages: [] }] };
    const merged = mergeRemoteChats(stored, [{ id: '-100', name: 'Канал', messages: [] }]);
    expect(merged.chats[0].type).toBe('channel');
  });

  it('merges group text without changing the group to a personal chat', () => {
    const stored: History = { version: 1, chats: [{ id: '-100', type: 'group', name: 'Группа', messages: [] }] };
    const merged = mergeRemoteHistory(stored, '-100', [message({ chatId: '-100', direction: 'incoming', senderName: 'Анна' })]);
    expect(merged.chats[0].type).toBe('group');
    expect(merged.chats[0].messages[0].senderName).toBe('Анна');
  });

  it('deduplicates imported text and preserves a newer delivered status', () => {
    const first = mergeRemoteHistory(history(), '100', [message({ status: 'sent' }), message({ id: 'message-2', timestamp: 50_000 })]);
    const second = mergeRemoteHistory(first, '100', [message({ status: 'sent' })]);
    expect(second.chats[0].messages.map(item => item.id)).toEqual(['message-2', 'message-1']);
    expect(second.chats[0].messages[1].status).toBe('read');
  });

  it('does not mistake an older same-text message for a send whose HTTP response was lost', () => {
    const previous = history();
    previous.chats[0].messages = [message({ id: 'local:one', status: 'uncertain' })];
    const merged = mergeRemoteHistory(previous, '100', [message({ status: 'sent', timestamp: 101_000 })]);
    expect(merged.chats[0].messages).toHaveLength(2);
    expect(merged.chats[0].messages[0]).toMatchObject({ id: 'local:one', status: 'uncertain' });
    expect(merged.chats[0].messages[1]).toMatchObject({ id: 'message-1', status: 'sent' });
  });
});
