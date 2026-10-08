import { StrictMode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createGreenApi, type GreenApi, type Notification } from './api';
import { historyKey, saveHistory } from './storage';
import { useMessenger } from './useMessenger';

vi.mock('./api', async importOriginal => ({
  ...await importOriginal<typeof import('./api')>(), createGreenApi: vi.fn(),
}));

const credentials = { idInstance: '3100000000', apiTokenInstance: 'secret' };
type PendingReceive = { resolve: (notification: Notification | null) => void; reject: (error: unknown) => void };
let api: GreenApi;
let receives: PendingReceive[];
let heldLocks: Set<string>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  localStorage.clear();
  receives = [];
  heldLocks = new Set();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: vi.fn((name: string, _options: unknown, callback: (lock: unknown) => Promise<void>) => {
      const available = !heldLocks.has(name);
      if (available) heldLocks.add(name);
      return Promise.resolve().then(() => callback(available ? { name, mode: 'exclusive' } : null))
        .finally(() => { if (available) heldLocks.delete(name); });
    }),
  } });
  api = {
    getState: vi.fn().mockResolvedValue('authorized'),
    getSettings: vi.fn().mockResolvedValue({ typeInstance: 'v3', webhookUrl: '', incomingWebhook: 'yes' }),
    checkAccount: vi.fn().mockResolvedValue('10'),
    sendMessage: vi.fn().mockResolvedValue('server'),
    acknowledge: vi.fn().mockResolvedValue(true),
    receive: vi.fn().mockImplementation((signal: AbortSignal) => new Promise((resolve, reject) => {
      const pending = { resolve, reject };
      receives.push(pending);
      signal.addEventListener('abort', () => {
        const index = receives.indexOf(pending);
        if (index >= 0) receives.splice(index, 1);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    })),
  };
  vi.mocked(createGreenApi).mockReturnValue(api);
});

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

async function connected() {
  saveHistory(credentials.idInstance, { version: 1, chats: [{ id: '10', name: 'Alex', phone: '79991234567', messages: [] }] });
  const hook = renderHook(() => useMessenger(), { wrapper: StrictMode });
  await act(async () => { expect(await hook.result.current.login(credentials)).toBe(true); });
  return hook;
}

function incoming(id = 'incoming'): Notification {
  return { receiptId: 12, body: { typeWebhook: 'incomingMessageReceived', timestamp: 1_700_000_000, idMessage: id,
    senderData: { chatId: '10', chatType: 'user', chatName: 'Alex' },
    messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'reply' } } } };
}

describe('messenger session lifecycle', () => {
  it('starts exactly one polling loop under StrictMode and stores no token', async () => {
    const { result } = await connected();
    expect(result.current.phase).toBe('connected');
    expect(api.receive).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(historyKey(credentials.idInstance))).not.toContain(credentials.apiTokenInstance);
  });

  it('refuses a second tab using the same instance before making API requests', async () => {
    await connected();
    const second = renderHook(() => useMessenger());
    await act(async () => { expect(await second.result.current.login(credentials)).toBe(false); });
    expect(second.result.current.error).toContain('другой вкладке');
    expect(api.getState).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ typeInstance: 'whatsapp', webhookUrl: '', incomingWebhook: 'yes' }, 'MAX'],
    [{ typeInstance: 'v3', webhookUrl: 'https://other-service.example', incomingWebhook: 'yes' }, 'webhookUrl'],
    [{ typeInstance: 'v3', webhookUrl: '', incomingWebhook: 'no' }, 'входящих сообщениях'],
  ])('validates MAX and polling settings without mutating them', async (settings, error) => {
    vi.mocked(api.getSettings).mockResolvedValue(settings);
    const { result } = renderHook(() => useMessenger());
    await act(async () => { expect(await result.current.login(credentials)).toBe(false); });
    expect(result.current.error).toContain(error);
    expect(api.receive).not.toHaveBeenCalled();
    expect(heldLocks.size).toBe(0);
  });

  it('persists an incoming message before deleting its receipt', async () => {
    await connected();
    vi.mocked(api.acknowledge).mockImplementation(async id => {
      expect(loadStoredMessages()[0]).toMatchObject({ id: 'incoming', text: 'reply' });
      expect(id).toBe(12);
      return true;
    });
    await act(async () => receives.shift()!.resolve(incoming()));
    await waitFor(() => expect(api.acknowledge).toHaveBeenCalledWith(12, expect.any(AbortSignal)));
  });

  it('withholds DELETE on storage failure and retry persists the same receipt before resuming', async () => {
    const { result } = await connected();
    const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    await act(async () => receives.shift()!.resolve(incoming()));
    await waitFor(() => expect(result.current.connection.status).toBe('storage-error'));
    expect(api.acknowledge).not.toHaveBeenCalled();
    expect(result.current.chats[0].messages).toHaveLength(1);
    save.mockRestore();
    act(() => result.current.retry());
    await waitFor(() => expect(api.acknowledge).toHaveBeenCalledTimes(1));
    expect(loadStoredMessages()).toHaveLength(1);
    expect(api.receive).toHaveBeenCalledTimes(2);
  });

  it('keeps a storage error visible when an already pending receive times out', async () => {
    const { result } = await connected();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    await act(async () => { expect(await result.current.sendMessage('10', 'hello')).toBe(false); });
    expect(result.current.connection.status).toBe('storage-error');
    await act(async () => receives.shift()!.resolve(null));
    expect(result.current.connection.status).toBe('storage-error');
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.receive).toHaveBeenCalledTimes(1);
  });

  it('stages a received notification during a storage pause and waits for explicit retry', async () => {
    const { result } = await connected();
    const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    await act(async () => { await result.current.sendMessage('10', 'hello'); });
    save.mockRestore();
    await act(async () => receives.shift()!.resolve(incoming()));
    expect(result.current.connection.status).toBe('storage-error');
    expect(api.acknowledge).not.toHaveBeenCalled();
    await act(async () => result.current.retry());
    await waitFor(() => expect(api.acknowledge).toHaveBeenCalledTimes(1));
    expect(loadStoredMessages()).toHaveLength(2);
  });

  it('keeps a storage error visible if an already pending DELETE completes', async () => {
    const { result } = await connected();
    const deletion = deferred<boolean>();
    vi.mocked(api.acknowledge).mockReturnValue(deletion.promise);
    await act(async () => receives.shift()!.resolve(incoming()));
    await waitFor(() => expect(api.acknowledge).toHaveBeenCalledTimes(1));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    await act(async () => { await result.current.sendMessage('10', 'hello'); });
    await act(async () => deletion.resolve(true));
    expect(result.current.connection.status).toBe('storage-error');
    expect(api.receive).toHaveBeenCalledTimes(1);
  });

  it('continues the queue after result:false and safely acknowledges unsupported events', async () => {
    await connected();
    vi.mocked(api.acknowledge).mockResolvedValue(false);
    await act(async () => receives.shift()!.resolve({ receiptId: 2, body: { typeWebhook: 'unsupported' } }));
    await waitFor(() => expect(api.receive).toHaveBeenCalledTimes(2));
    expect(api.acknowledge).toHaveBeenCalledTimes(1);
    expect(loadStoredMessages()).toHaveLength(0);
  });

  it('stops polling, clears credentials and releases the lock after an auth failure', async () => {
    const { result } = await connected();
    await act(async () => receives.shift()!.reject(new ApiError('Invalid token', 401)));
    await waitFor(() => expect(result.current.phase).toBe('signed-out'));
    expect(result.current.error).toBe('Invalid token');
    expect(heldLocks.size).toBe(0);
    expect(api.receive).toHaveBeenCalledTimes(1);
  });

  it('backs off failed receives up to 30 seconds and cancels the timer on logout', async () => {
    vi.useFakeTimers();
    const { result } = await connected();
    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (let index = 0; index < delays.length; index += 1) {
      await act(async () => receives.shift()!.reject(new ApiError('Offline', 0, 'network')));
      expect(result.current.connection.status).toBe('reconnecting');
      await act(async () => { await vi.advanceTimersByTimeAsync(delays[index] - 1); });
      expect(api.receive).toHaveBeenCalledTimes(index + 1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(api.receive).toHaveBeenCalledTimes(index + 2);
    }
    await act(async () => receives.shift()!.reject(new ApiError('Offline', 0, 'network')));
    act(() => result.current.logout());
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(api.receive).toHaveBeenCalledTimes(delays.length + 1);
    expect(heldLocks.size).toBe(0);
  });

  it('manual retry wakes a network backoff without creating a second polling loop', async () => {
    vi.useFakeTimers();
    const { result } = await connected();
    await act(async () => receives.shift()!.reject(new ApiError('Offline', 0, 'network')));
    await act(async () => result.current.retry());
    expect(api.receive).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(api.receive).toHaveBeenCalledTimes(2);
  });

  it('normalizes new recipient numbers and avoids repeatedly checking existing chats', async () => {
    const { result } = await connected();
    await act(async () => { expect(await result.current.createChat('+7 (999) 123-45-67')).toBe('10'); });
    expect(api.checkAccount).not.toHaveBeenCalled();
    await act(async () => { expect(await result.current.createChat('89991234567')).toBeNull(); });
    expect(api.checkAccount).not.toHaveBeenCalled();
    vi.mocked(api.checkAccount).mockResolvedValue('20');
    await act(async () => { expect(await result.current.createChat('+375 29 123-45-67')).toBe('20'); });
    expect(api.checkAccount).toHaveBeenCalledWith('375291234567', expect.any(AbortSignal));
    expect(result.current.chats).toHaveLength(2);
  });

  it('ignores a login response arriving after unmount', async () => {
    const state = deferred<string>();
    vi.mocked(api.getState).mockReturnValue(state.promise);
    const { result, unmount } = renderHook(() => useMessenger());
    let login!: Promise<boolean>;
    act(() => { login = result.current.login(credentials); });
    await waitFor(() => expect(api.getState).toHaveBeenCalledTimes(1));
    unmount();
    state.resolve('authorized');
    expect(await login).toBe(false);
    expect(localStorage.getItem(historyKey(credentials.idInstance))).toBeNull();
    expect(api.receive).not.toHaveBeenCalled();
    expect(heldLocks.size).toBe(0);
  });

  it('ignores a late POST completion after logout without overwriting stored history', async () => {
    const { result } = await connected();
    const post = deferred<string>();
    vi.mocked(api.sendMessage).mockReturnValue(post.promise);
    let send!: Promise<boolean>;
    act(() => { send = result.current.sendMessage('10', 'hello'); });
    const beforeLogout = localStorage.getItem(historyKey(credentials.idInstance));
    act(() => result.current.logout());
    await act(async () => { post.resolve('server'); expect(await send).toBe(false); });
    expect(result.current.phase).toBe('signed-out');
    expect(localStorage.getItem(historyKey(credentials.idInstance))).toBe(beforeLogout);
    expect(loadStoredMessages()[0].status).toBe('sending');
  });

  it('retains an uncertain outgoing message and returns false after a network failure without retrying POST', async () => {
    const { result } = await connected();
    vi.mocked(api.sendMessage).mockRejectedValue(new ApiError('Network unavailable', 0, 'network'));
    await act(async () => { expect(await result.current.sendMessage('10', 'hello')).toBe(false); });
    expect(result.current.chats[0].messages[0]).toMatchObject({ text: 'hello', status: 'uncertain' });
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(result.current.busyChatIds).toEqual([]);
  });

  it('deduplicates an API echo arriving before POST completion', async () => {
    const { result } = await connected();
    const post = deferred<string>();
    vi.mocked(api.sendMessage).mockReturnValue(post.promise);
    let send!: Promise<boolean>;
    act(() => { send = result.current.sendMessage('10', 'hello'); });
    const now = Math.floor(Date.now() / 1000);
    await act(async () => receives.shift()!.resolve({ receiptId: 3, body: {
      typeWebhook: 'outgoingAPIMessageReceived', idMessage: 'server', timestamp: now,
      senderData: { chatId: '10', chatType: 'user' },
      messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'hello' } },
    } }));
    await waitFor(() => expect(api.acknowledge).toHaveBeenCalledTimes(1));
    expect(result.current.chats[0].messages).toHaveLength(1);
    await act(async () => { post.resolve('server'); expect(await send).toBe(true); });
    expect(result.current.chats[0].messages).toEqual([expect.objectContaining({ id: 'server', status: 'queued' })]);
  });

  it('applies a read status arriving before POST response and prevents a later delivered regression', async () => {
    const { result } = await connected();
    const post = deferred<string>();
    vi.mocked(api.sendMessage).mockReturnValue(post.promise);
    let send!: Promise<boolean>;
    act(() => { send = result.current.sendMessage('10', 'hello'); });
    await act(async () => receives.shift()!.resolve({ receiptId: 3, body: {
      typeWebhook: 'outgoingMessageStatus', idMessage: 'server', chatId: '10', status: 'read',
    } }));
    await waitFor(() => expect(api.acknowledge).toHaveBeenCalledTimes(1));
    await act(async () => { post.resolve('server'); await send; });
    expect(result.current.chats[0].messages[0].status).toBe('read');
    await act(async () => receives.shift()!.resolve({ receiptId: 4, body: {
      typeWebhook: 'outgoingMessageStatus', idMessage: 'server', chatId: '10', status: 'delivered',
    } }));
    await waitFor(() => expect(api.acknowledge).toHaveBeenCalledTimes(2));
    expect(result.current.chats[0].messages[0].status).toBe('read');
  });

  it('durably saves an early acknowledged read status and restores it when its API echo arrives after reload', async () => {
    const first = await connected();
    const post = deferred<string>();
    vi.mocked(api.sendMessage).mockReturnValue(post.promise);
    let send!: Promise<boolean>;
    act(() => { send = first.result.current.sendMessage('10', 'hello'); });
    const timestamp = Math.floor(Date.now() / 1000);
    await act(async () => receives.shift()!.resolve({ receiptId: 3, body: {
      typeWebhook: 'outgoingMessageStatus', idMessage: 'server', chatId: '10', status: 'read',
    } }));
    await waitFor(() => expect(api.acknowledge).toHaveBeenCalledTimes(1));
    expect(JSON.parse(localStorage.getItem(historyKey(credentials.idInstance))!).pendingStatuses)
      .toEqual([{ chatId: '10', id: 'server', status: 'read' }]);
    await act(async () => first.result.current.logout());
    await act(async () => { post.resolve('server'); expect(await send).toBe(false); });
    const second = renderHook(() => useMessenger());
    await act(async () => { expect(await second.result.current.login(credentials)).toBe(true); });
    expect(second.result.current.chats[0].messages[0].status).toBe('uncertain');
    await act(async () => receives.shift()!.resolve({ receiptId: 4, body: {
      typeWebhook: 'outgoingAPIMessageReceived', idMessage: 'server', timestamp,
      senderData: { chatId: '10', chatType: 'user' },
      messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'hello' } },
    } }));
    await waitFor(() => expect(api.acknowledge).toHaveBeenCalledTimes(2));
    expect(second.result.current.chats[0].messages).toEqual([expect.objectContaining({ id: 'server', status: 'read' })]);
    expect(JSON.parse(localStorage.getItem(historyKey(credentials.idInstance))!).pendingStatuses).toBeUndefined();
  });
});

function loadStoredMessages(): Array<{ id: string; text: string; status: string }> {
  return JSON.parse(localStorage.getItem(historyKey(credentials.idInstance))!).chats[0].messages;
}
