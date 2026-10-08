import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createGreenApi, normalizePhone } from './api';

const credentials = { idInstance: '3100000000', apiTokenInstance: 'secret-token' };
const signal = () => new AbortController().signal;
const response = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

afterEach(() => vi.unstubAllGlobals());

describe('GREEN-API MAX client', () => {
  it('resolves the phone to the MAX chat ID with a numeric phoneNumber', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ exist: true, chatId: '10000000000000000', fromCache: false }));
    vi.stubGlobal('fetch', fetch);
    const api = createGreenApi(credentials, 'https://api.green-api.com/v3/');
    await expect(api.checkAccount('79991234567', signal())).resolves.toBe('10000000000000000');
    expect(fetch).toHaveBeenCalledWith('https://api.green-api.com/v3/waInstance3100000000/checkAccount/secret-token',
      expect.objectContaining({ method: 'POST', body: '{"phoneNumber":79991234567}', credentials: 'omit' }));
  });

  it('rejects an HTTP 200 body failure and a missing account', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response({ status: false, reason: 'User get contact info limit reached' }))
      .mockResolvedValueOnce(response({ exist: false, chatId: '' })));
    const api = createGreenApi(credentials);
    await expect(api.checkAccount('79991234567', signal())).rejects.toThrow('ограничил проверку');
    await expect(api.checkAccount('79991234567', signal())).rejects.toThrow('не найден');
  });

  it('accepts both JSON null and an empty long poll timeout', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(null)).mockResolvedValueOnce(response(''));
    vi.stubGlobal('fetch', fetch);
    const api = createGreenApi(credentials);
    await expect(api.receive(signal())).resolves.toBeNull();
    await expect(api.receive(signal())).resolves.toBeNull();
    expect(fetch.mock.calls[0][0]).toContain('?receiveTimeout=30');
  });

  it('uses DELETE and propagates result:false rather than retrying a stale receipt', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ result: false, reason: 'already removed' }));
    vi.stubGlobal('fetch', fetch);
    await expect(createGreenApi(credentials).acknowledge(123, signal())).resolves.toBe(false);
    expect(fetch.mock.calls[0][0]).toContain('/deleteNotification/secret-token/123');
    expect(fetch.mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'DELETE' }));
  });

  it('distinguishes rejected credentials from a suspended MAX account', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(response({ error: 'Your account is suspended' }, 403)));
    const api = createGreenApi(credentials);
    await expect(api.getState(signal())).rejects.toMatchObject({ isAuthError: true });
    await expect(api.sendMessage('1', 'hello', signal())).rejects.toMatchObject({ isAuthError: false });
  });

  it('does not automatically retry an ambiguous POST failure', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetch);
    await expect(createGreenApi(credentials).sendMessage('1', 'hello', signal())).rejects.toMatchObject({ kind: 'network' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('recognizes a caller abort without presenting a network error', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, options: RequestInit) => {
      expect(options.signal?.aborted).toBe(true);
      throw new DOMException('Aborted', 'AbortError');
    }));
    controller.abort();
    await expect(createGreenApi(credentials).getState(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not expose endpoint tokens in HTTP error messages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response('request to https://host/secret-token failed', 500)));
    await expect(createGreenApi(credentials).getState(signal())).rejects.toThrow(ApiError);
    try { await createGreenApi(credentials).getState(signal()); }
    catch (error) { expect((error as Error).message).not.toContain(credentials.apiTokenInstance); }
  });

  it('loads personal, group, channel and bot chats and preserves hidden phone numbers as absent', async () => {
    const fetch = vi.fn().mockResolvedValue(response([
      { chatId: '10000000000000001', name: 'Анна', type: 'user', phoneNumber: 79991234567 },
      { chatId: '10000000000000002', name: 'Скрытый номер', type: 'user', phoneNumber: 0 },
      { chatId: '-123', name: 'Группа', type: 'group', phoneNumber: 0 },
      { chatId: '300', name: 'Бот', type: 'bot', phoneNumber: 0 },
      { chatId: '-124', name: 'Канал', type: 'channel', phoneNumber: 0 },
    ]));
    vi.stubGlobal('fetch', fetch);
    await expect(createGreenApi(credentials).getChats(signal())).resolves.toEqual([
      { id: '10000000000000001', type: 'user', name: 'Анна', phone: '79991234567', messages: [] },
      { id: '10000000000000002', type: 'user', name: 'Скрытый номер', messages: [] },
      { id: '-123', type: 'group', name: 'Группа', messages: [] },
      { id: '300', type: 'bot', name: 'Бот', messages: [] },
      { id: '-124', type: 'channel', name: 'Канал', messages: [] },
    ]);
    expect(fetch.mock.calls[0][0]).toContain('/getChats/');
  });

  it.each(['group', 'channel', 'bot'])('retrieves %s history and retains the incoming sender name', async chatType => {
    const chatId = chatType === 'bot' ? '10002' : '-10000000000000001';
    const fetch = vi.fn().mockResolvedValue(response([{
      chatId, chatType, idMessage: 'text-from-chat', type: 'incoming', timestamp: 100,
      typeMessage: 'textMessage', textMessage: 'Текст чата', senderName: 'Анна',
    }]));
    vi.stubGlobal('fetch', fetch);
    await expect(createGreenApi(credentials).getChatHistory(chatId, signal())).resolves.toEqual([{
      chatId, id: 'text-from-chat', direction: 'incoming', timestamp: 100_000,
      text: 'Текст чата', status: 'delivered', senderName: 'Анна',
    }]);
    expect(fetch.mock.calls[0][1]).toEqual(expect.objectContaining({ body: JSON.stringify({ chatId, count: 100 }) }));
  });

  it('keeps a negative group chat ID as a string when sending', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ idMessage: 'sent-to-group' }));
    vi.stubGlobal('fetch', fetch);
    await expect(createGreenApi(credentials).sendMessage('-10000000000000001', 'Всем привет', signal())).resolves.toBe('sent-to-group');
    expect(fetch.mock.calls[0][1]).toEqual(expect.objectContaining({
      body: '{"chatId":"-10000000000000001","message":"Всем привет"}',
    }));
  });

  it('retrieves the account chat ID for identifying Favorites', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      chatId: '10000000000000001', phone: '79991234567', stateInstance: 'authorized',
    })));
    await expect(createGreenApi(credentials).getAccountSettings(signal())).resolves.toEqual({
      chatId: '10000000000000001', phone: '79991234567',
    });
  });

  it('preserves notification settings so the UI can explain missing message status events', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      typeInstance: 'v3', incomingWebhook: 'yes', webhookUrl: '', outgoingWebhook: 'no',
      outgoingAPIMessageWebhook: 'yes', outgoingMessageWebhook: 'no',
    })));
    await expect(createGreenApi(credentials).getSettings(signal())).resolves.toMatchObject({
      outgoingWebhook: 'no', outgoingAPIMessageWebhook: 'yes', outgoingMessageWebhook: 'no',
    });
  });

  it('loads the latest 100 text messages chronologically and recognizes sent journal entries', async () => {
    const fetch = vi.fn().mockResolvedValue(response([
      { chatId: '100', chatType: 'user', idMessage: '3', type: 'outgoing', timestamp: 300,
        typeMessage: 'extendedTextMessage', extendedTextMessage: { text: 'https://example.org' }, statusMessage: '' },
      { chatId: '100', chatType: 'user', idMessage: '2', type: 'outgoing', timestamp: 200,
        typeMessage: 'textMessage', textMessage: 'Прочитано', statusMessage: 'read' },
      { chatId: '100', chatType: 'user', idMessage: '1', type: 'incoming', timestamp: 100,
        typeMessage: 'textMessage', textMessage: 'Привет' },
      { chatId: '100', chatType: 'user', idMessage: '4', type: 'incoming', timestamp: 400,
        typeMessage: 'imageMessage', caption: 'Изображение' },
      { chatId: '100', chatType: 'user', idMessage: '5', type: 'incoming', timestamp: 500,
        typeMessage: 'textMessage', textMessage: 'Удалено', isDeleted: true },
      { chatId: '100', chatType: 'user', idMessage: '6', type: 'outgoing', timestamp: 600,
        typeMessage: 'textMessage', textMessage: 'Неизвестный статус', statusMessage: 'unknown' },
    ]));
    vi.stubGlobal('fetch', fetch);
    const messages = await createGreenApi(credentials).getChatHistory('100', signal());
    expect(messages.map(message => [message.id, message.text, message.status, message.timestamp])).toEqual([
      ['1', 'Привет', 'delivered', 100_000], ['2', 'Прочитано', 'read', 200_000],
      ['3', 'https://example.org', 'sent', 300_000],
      ['6', 'Неизвестный статус', 'uncertain', 600_000],
    ]);
    expect(fetch.mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'POST', body: '{"chatId":"100","count":100}' }));
  });

  it('does not accept an error object as an empty chat list or history', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response({ status: false, reason: 'failure' })));
    await expect(createGreenApi(credentials).getChats(signal())).rejects.toThrow('неожиданный ответ');
    await expect(createGreenApi(credentials).getChatHistory('100', signal())).rejects.toThrow('неожиданный ответ');
  });

  it('serializes history calls with the documented one request per second limit and cancels the delay', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn().mockImplementation(async () => response([]));
      vi.stubGlobal('fetch', fetch);
      const api = createGreenApi(credentials);
      await api.getChatHistory('100', signal());
      const controller = new AbortController();
      const waiting = api.getChatHistory('101', controller.signal);
      const aborted = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetch).toHaveBeenCalledTimes(1);
      controller.abort();
      await aborted;
      const next = api.getChatHistory('102', signal());
      await vi.advanceTimersByTimeAsync(50);
      await next;
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});

describe('phone input', () => {
  it.each([['+7 (999) 123-45-67', '79991234567'], ['+375 29 123 45 67', '375291234567']])('normalizes %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });
  it.each(['89991234567', '+1 555 123 4567', '7abc9991234567', '7999'])('rejects %s', input => {
    expect(normalizePhone(input)).toBeNull();
  });
});
