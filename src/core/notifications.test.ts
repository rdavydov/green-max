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

  it('ignores attachments, unknown chat types and malformed events', () => {
    expect(normalizeNotification({ ...textBody, senderData: { chatId: '-10', chatType: 'unknown' } })).toEqual({ kind: 'ignore' });
    expect(normalizeNotification({ ...textBody, messageData: { typeMessage: 'imageMessage' } })).toEqual({ kind: 'ignore' });
    expect(normalizeNotification(null)).toEqual({ kind: 'ignore' });
    expect(normalizeNotification({ ...textBody, timestamp: 1e20 })).toEqual({ kind: 'ignore' });
  });

  it.each(['group', 'channel', 'bot'])('normalizes text from a %s and creates the matching chat type', chatType => {
    const chatId = chatType === 'bot' ? '10003' : '-10000000000000001';
    const event = normalizeNotification({ ...textBody, senderData: {
      chatId, chatType, chatName: 'Название чата', senderName: 'Анна', senderPhoneNumber: 79991234567,
    } });
    if (event.kind !== 'message') throw new Error('expected message');
    expect(event).toMatchObject({ chatType, name: 'Название чата', message: { chatId, senderName: 'Анна' } });
    expect(event.phone).toBeUndefined();
    expect(upsertMessage(empty, event).history.chats[0]).toMatchObject({ id: chatId, type: chatType, name: 'Название чата' });
  });

  it('does not replace a group name with the author name if chatName is missing', () => {
    const stored: History = { version: 1, chats: [{ id: '-10', type: 'group', name: 'Моя группа', messages: [] }] };
    const event = normalizeNotification({ ...textBody, senderData: { chatId: '-10', chatType: 'group', senderName: 'Анна' } });
    if (event.kind !== 'message') throw new Error('expected message');
    expect(upsertMessage(stored, event).history.chats[0].name).toBe('Моя группа');
  });

  it('retains the known bot type when a notification has no chatType', () => {
    const stored: History = { version: 1, chats: [{ id: '10', type: 'bot', name: 'Бот', messages: [] }] };
    const event = normalizeNotification({ ...textBody, senderData: { chatId: '10', chatName: 'Бот' } });
    if (event.kind !== 'message') throw new Error('expected message');
    expect(upsertMessage(stored, event).history.chats[0].type).toBe('bot');
  });

  it('updates a negative group message status', () => {
    const stored: History = { version: 1, chats: [{ id: '-10', type: 'group', name: 'Группа', messages: [{
      id: 'out-to-group', chatId: '-10', text: 'Привет', direction: 'outgoing', timestamp: 1, status: 'queued',
    }] }] };
    const event = normalizeNotification({ typeWebhook: 'outgoingMessageStatus', chatId: '-10', idMessage: 'out-to-group', status: 'sent' });
    if (event.kind !== 'status') throw new Error('expected status');
    expect(applyStatus(stored, event).chats[0].messages[0].status).toBe('sent');
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
    expect(confirmed.chats[0].messages[0]).toMatchObject({ id: textBody.idMessage, status: 'sent' });
  });

  it('treats outgoing echoes as sent without assuming delivery or reading in Favorites', () => {
    const event = normalizeNotification({ ...textBody, typeWebhook: 'outgoingAPIMessageReceived',
      senderData: { ...textBody.senderData, chatName: 'Избранное' } });
    expect(event).toMatchObject({ kind: 'message', name: 'Избранное', apiEcho: true,
      message: { direction: 'outgoing', status: 'sent' } });
    expect(normalizeNotification({ ...textBody, typeWebhook: 'outgoingMessageReceived' }))
      .toMatchObject({ kind: 'message', apiEcho: false, message: { direction: 'outgoing', status: 'sent' } });
  });

  it('keeps a POST acceptance queued until a notification confirms it was sent', () => {
    const local: History = { version: 1, chats: [{ id: '10', name: 'Alex', messages: [
      { id: 'local:1', chatId: '10', direction: 'outgoing', text: 'hello', timestamp: 1, status: 'sending' },
    ] }] };
    const confirmed = confirmSend(local, '10', 'local:1', 'server');
    expect(confirmed.chats[0].messages[0].status).toBe('queued');
    const status = normalizeNotification({ typeWebhook: 'outgoingMessageStatus', chatId: '10',
      idMessage: 'server', status: 'sent' });
    if (status.kind !== 'status') throw new Error('expected status');
    expect(applyStatus(confirmed, status).chats[0].messages[0].status).toBe('sent');
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
    expect(mergeStatus('sent', 'queued')).toBe('sent');
    expect(mergeStatus('sent', 'failed')).toBe('failed');
    expect(mergeStatus('failed', 'sent')).toBe('failed');
    expect(mergeStatus('read', 'sent')).toBe('read');
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
