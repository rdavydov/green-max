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
});

describe('phone input', () => {
  it.each([['+7 (999) 123-45-67', '79991234567'], ['+375 29 123 45 67', '375291234567']])('normalizes %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });
  it.each(['89991234567', '+1 555 123 4567', '7abc9991234567', '7999'])('rejects %s', input => {
    expect(normalizePhone(input)).toBeNull();
  });
});
