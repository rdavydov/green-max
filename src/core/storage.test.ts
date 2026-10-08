import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryStorageError, historyKey, loadHistory, parseHistory, saveHistory } from './storage';
import type { History } from './types';

const history: History = { version: 1, chats: [{ id: '10', name: 'Contact', phone: '79991234567', messages: [
  { id: '126543123451133331119', chatId: '10', text: 'hello', timestamp: 1_700_000_000_000, direction: 'outgoing', status: 'queued' },
] }] };

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe('browser history', () => {
  it('isolates accounts and preserves large string message IDs', () => {
    saveHistory('3100000001', history);
    expect(loadHistory('3100000001')).toEqual(history);
    expect(loadHistory('3100000002')).toEqual({ version: 1, chats: [] });
  });

  it('persists only the history model, excluding credentials and raw webhook fields', () => {
    const extra = { ...history, apiTokenInstance: 'secret', receiptId: 99, body: { incoming: true } };
    saveHistory('1', extra);
    const stored = localStorage.getItem(historyKey('1'))!;
    expect(stored).not.toContain('secret');
    expect(stored).not.toContain('receiptId');
    expect(stored).not.toContain('body');
  });

  it.each(['{', '{"version":2,"chats":[]}', '{"version":1,"chats":[{"id":"-1"}]}'])('preserves corrupted data %s instead of overwriting it', raw => {
    localStorage.setItem(historyKey('1'), raw);
    expect(() => loadHistory('1')).toThrow('повреждена');
    expect(localStorage.getItem(historyKey('1'))).toBe(raw);
  });

  it('rejects duplicate IDs and mismatched message chat references', () => {
    expect(parseHistory({ ...history, chats: [...history.chats, ...history.chats] })).toBeNull();
    expect(parseHistory({ version: 1, chats: [{ ...history.chats[0], messages: [
      { ...history.chats[0].messages[0], chatId: '20' },
    ] }] })).toBeNull();
    expect(parseHistory({ ...history, pendingStatuses: [{ chatId: '10', id: 'server', status: 'unknown' }] })).toBeNull();
  });

  it('persists early status projections without webhook envelopes and retains them on reload', () => {
    const withStatus: History = { ...history, pendingStatuses: [{ chatId: '10', id: 'server', status: 'read' }] };
    saveHistory('1', withStatus);
    expect(loadHistory('1')).toEqual(withStatus);
  });

  it('restores a confirmed sent status and early sent notification after reload', () => {
    const sent: History = { version: 1, chats: [{ ...history.chats[0], messages: [
      { ...history.chats[0].messages[0], status: 'sent' },
    ] }], pendingStatuses: [{ chatId: '10', id: 'new-message', status: 'sent' }] };
    saveHistory('1', sent);
    expect(loadHistory('1')).toEqual(sent);
  });

  it('marks a sending message uncertain after a reload', () => {
    const sending: History = { version: 1, chats: [{ ...history.chats[0], messages: [
      { ...history.chats[0].messages[0], id: 'local:1', status: 'sending' },
    ] }] };
    saveHistory('1', sending);
    expect(loadHistory('1').chats[0].messages[0]).toMatchObject({ status: 'uncertain', error: expect.stringContaining('прервалась') });
  });

  it('reports quota failures so the polling caller can withhold its acknowledgement', () => {
    const storage = { getItem: vi.fn(), setItem: vi.fn(() => { throw new DOMException('QuotaExceeded', 'QuotaExceededError'); }) };
    expect(() => saveHistory('1', history, storage)).toThrow(HistoryStorageError);
  });
});
