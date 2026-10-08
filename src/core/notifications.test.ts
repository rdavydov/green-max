import { describe, expect, it } from 'vitest';
import { applyStatus, confirmSend, mergeStatus, normalizeNotification, upsertMessage } from './notifications';
import type { History } from './types';

const textBody = {
  typeWebhook: 'incomingMessageReceived', timestamp: 1_700_000_000, idMessage: '126543123451133331119',
  senderData: { chatId: '10', chatType: 'user', chatName: 'Alex', senderPhoneNumber: 79991234567 },
  messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'hello' } },
};
const empty: History = { version: 1, chats: [] };

describe('MAX notifications', () => {
  it('normalizes private text and converts UNIX seconds to milliseconds', () => {
    expect(normalizeNotification(textBody)).toMatchObject({ kind: 'message', name: 'Alex', phone: '79991234567',
      message: { id: '126543123451133331119', chatId: '10', timestamp: 1_700_000_000_000, text: 'hello', direction: 'incoming' } });
  });

  it('includes text containing URLs without needing link preview UI', () => {
    expect(normalizeNotification({ ...textBody, messageData: { typeMessage: 'extendedTextMessage',
      extendedTextMessageData: { text: 'hello https://example.com', jpegThumbnail: 'unused' } } }))
      .toMatchObject({ kind: 'message', message: { text: 'hello https://example.com' } });
  });

  it('preserves a known recipient phone when MAX hides senderPhoneNumber as zero', () => {
    const stored: History = { version: 1, chats: [{ id: '10', name: 'Alex', phone: '79991234567', messages: [] }] };
    const event = normalizeNotification({ ...textBody, senderData: { ...textBody.senderData, senderPhoneNumber: 0 } });
    if (event.kind !== 'message') throw new Error('expected message');
    expect(event.phone).toBeUndefined();
    expect(upsertMessage(stored, event).history.chats[0].phone).toBe('79991234567');
  });

  it('ignores groups, attachments and malformed events', () => {
    expect(normalizeNotification({ ...textBody, senderData: { chatId: '-10', chatType: 'group' } })).toEqual({ kind: 'ignore' });
    expect(normalizeNotification({ ...textBody, messageData: { typeMessage: 'imageMessage' } })).toEqual({ kind: 'ignore' });
    expect(normalizeNotification(null)).toEqual({ kind: 'ignore' });
    expect(normalizeNotification({ ...textBody, timestamp: 1e20 })).toEqual({ kind: 'ignore' });
  });

  it('adds an unknown incoming chat and deduplicates a replayed message', () => {
    const event = normalizeNotification(textBody);
    if (event.kind !== 'message') throw new Error('expected message');
    const first = upsertMessage(empty, event).history;
    const replay = upsertMessage(first, event).history;
    expect(replay.chats).toHaveLength(1);
    expect(replay.chats[0].messages).toHaveLength(1);
  });

  it('orders a queued old incoming notification before a newer locally sent message', () => {
    const newer: History = { version: 1, pendingStatuses: [{ chatId: '10', id: 'future', status: 'read' }],
      chats: [{ id: '10', name: 'Alex', messages: [
      { id: 'new', chatId: '10', direction: 'outgoing', text: 'new', timestamp: 1_800_000_000_000, status: 'queued' },
    ] }] };
    const event = normalizeNotification(textBody);
    if (event.kind !== 'message') throw new Error('expected message');
    const updated = upsertMessage(newer, event).history;
    expect(updated.pendingStatuses).toEqual(newer.pendingStatuses);
    expect(updated.chats[0].messages.map(message => message.id))
      .toEqual([textBody.idMessage, 'new']);
  });

  it('merges an early API echo into a single optimistic outgoing bubble', () => {
    const local: History = { version: 1, chats: [{ id: '10', name: 'Alex', messages: [
      { id: 'local:1', chatId: '10', direction: 'outgoing', text: 'hello', timestamp: 1_700_000_000_200, status: 'sending' },
    ] }] };
    const event = normalizeNotification({ ...textBody, typeWebhook: 'outgoingAPIMessageReceived' });
    if (event.kind !== 'message') throw new Error('expected message');
    const echoed = upsertMessage(local, event);
    expect(echoed.alias).toEqual({ localId: 'local:1', serverId: textBody.idMessage });
    expect(echoed.history.chats[0].messages).toHaveLength(1);
    const confirmed = confirmSend(echoed.history, '10', textBody.idMessage, textBody.idMessage);
    expect(confirmed.chats[0].messages).toHaveLength(1);
    expect(confirmed.chats[0].messages[0]).toMatchObject({ id: textBody.idMessage, status: 'queued' });
  });

  it('collapses an optimistic bubble and an already stored server message on POST completion', () => {
    const stored: History = { version: 1, chats: [{ id: '10', name: 'Alex', messages: [
      { id: 'local:1', chatId: '10', direction: 'outgoing', text: 'hello', timestamp: 1, status: 'sending' },
      { id: 'server', chatId: '10', direction: 'outgoing', text: 'hello', timestamp: 2, status: 'read' },
    ] }] };
    expect(confirmSend(stored, '10', 'local:1', 'server').chats[0].messages).toEqual([
      expect.objectContaining({ id: 'server', status: 'read' }),
    ]);
  });

  it('does not regress delivery or read state when notifications arrive out of order', () => {
    expect(mergeStatus('read', 'queued')).toBe('read');
    expect(mergeStatus('delivered', 'failed')).toBe('delivered');
    expect(mergeStatus('failed', 'queued')).toBe('failed');
    expect(mergeStatus('queued', 'failed')).toBe('failed');
    const history: History = { version: 1, chats: [{ id: '10', name: 'Alex', messages: [
      { id: 'server', chatId: '10', direction: 'outgoing', text: 'hello', timestamp: 1, status: 'read' },
    ] }] };
    expect(applyStatus(history, { kind: 'status', chatId: '10', id: 'server', status: 'failed' }).chats[0].messages[0].status).toBe('read');
  });

  it('handles noAccount as a failed outgoing message', () => {
    expect(normalizeNotification({ typeWebhook: 'outgoingMessageStatus', chatId: '10', idMessage: 'server', status: 'noAccount' }))
      .toMatchObject({ kind: 'status', status: 'failed', error: expect.stringContaining('не найден') });
    const failed: History = { version: 1, chats: [{ id: '10', name: 'Alex', messages: [
      { id: 'server', chatId: '10', direction: 'outgoing', text: 'hello', timestamp: 1, status: 'failed', error: 'Получатель не найден в MAX.' },
    ] }] };
    expect(confirmSend(failed, '10', 'server', 'server').chats[0].messages[0])
      .toMatchObject({ status: 'failed', error: 'Получатель не найден в MAX.' });
  });
});
