import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, createGreenApi, normalizePhone, type GreenApi } from './api';
import { applyStatus, confirmSend, mergeStatus, normalizeNotification, updateMessage, upsertMessage, type NormalizedEvent } from './notifications';
import { loadHistory, saveHistory } from './storage';
import { mergeRemoteChats, mergeRemoteHistory } from './historySync';
import type { Credentials, History, Messenger } from './types';

type StatusEvent = Extract<NormalizedEvent, { kind: 'status' }>;

interface Session {
  generation: number;
  credentials: Credentials;
  api: GreenApi;
  controller: AbortController;
  releaseLock?: () => void;
  history: History;
  ready: boolean;
  polling: boolean;
  paused: boolean;
  pendingReceipt?: { id: number; state?: string };
  busy: Set<string>;
  aliases: Map<string, string>;
  earlyStatuses: Map<string, StatusEvent>;
  wakeRetry?: () => void;
  account?: { chatId: string; phone: string };
  loading: Map<string, Promise<void>>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось выполнить действие. Попробуйте еще раз.';
}

function acquireLock(idInstance: string): Promise<() => void> {
  if (!navigator.locks) return Promise.reject(new Error('Для работы нужен современный браузер с Web Locks и HTTPS (или localhost).'));
  return new Promise((resolve, reject) => {
    void navigator.locks.request(`green-max:instance:${idInstance}`, { ifAvailable: true }, async lock => {
      if (!lock) {
        reject(new Error('Этот инстанс уже открыт в другой вкладке. Выйдите из чата там и попробуйте снова.'));
        return;
      }
      await new Promise<void>(release => { resolve(release); });
    }).catch(reject);
  });
}

function pause(session: Session, milliseconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const signal = session.controller.signal;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      session.wakeRetry = undefined;
    };
    const finish = () => { cleanup(); resolve(); };
    const abort = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(finish, milliseconds);
    session.wakeRetry = finish;
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

export function useMessenger(): Messenger {
  const [phase, setPhase] = useState<Messenger['phase']>('signed-out');
  const [chats, setChats] = useState<Messenger['chats']>([]);
  const [busyChatIds, setBusyChatIds] = useState<string[]>([]);
  const [connection, setConnection] = useState<Messenger['connection']>({ status: 'online' });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadingChatIds, setLoadingChatIds] = useState<string[]>([]);
  const mounted = useRef(true);
  const generation = useRef(0);
  const sessionRef = useRef<Session | null>(null);
  const pollRef = useRef<(session: Session) => Promise<void>>(async () => {});

  const isCurrent = useCallback((session: Session): boolean => mounted.current
    && sessionRef.current === session && generation.current === session.generation && !session.controller.signal.aborted, []);

  const dispose = useCallback(() => {
    const previous = sessionRef.current;
    sessionRef.current = null;
    generation.current += 1;
    if (previous) {
      previous.controller.abort();
      previous.releaseLock?.();
      // Drop the last reference to credentials as soon as this browser session ends.
      previous.credentials = { idInstance: '', apiTokenInstance: '' };
      previous.earlyStatuses.clear();
      previous.aliases.clear();
    }
  }, []);

  const endSession = useCallback((session: Session, message?: string) => {
    if (!isCurrent(session)) return;
    dispose();
    setPhase('signed-out');
    setChats([]);
    setBusyChatIds([]);
    setLoadingChatIds([]);
    setNotice(null);
    setConnection({ status: 'online' });
    setError(message ?? null);
  }, [dispose, isCurrent]);

  const publish = useCallback((session: Session) => {
    if (isCurrent(session)) {
      setChats(session.history.chats);
      setBusyChatIds([...session.busy]);
      setLoadingChatIds([...session.loading.keys()]);
    }
  }, [isCurrent]);

  const persist = useCallback((session: Session): boolean => {
    if (!isCurrent(session)) return false;
    try {
      saveHistory(session.credentials.idInstance, session.history);
      return true;
    } catch (storageError) {
      session.paused = true;
      setConnection({ status: 'storage-error', message: errorText(storageError) });
      return false;
    }
  }, [isCurrent]);

  const applyEarlyStatus = useCallback((session: Session, chatId: string, id: string) => {
    const key = `${chatId}:${id}`;
    const status = session.earlyStatuses.get(key);
    if (status) {
      session.history = applyStatus(session.history, status);
      session.earlyStatuses.delete(key);
      session.history = { ...session.history, pendingStatuses: [...session.earlyStatuses.values()].map(event => ({
        chatId: event.chatId, id: event.id, status: event.status, ...(event.error ? { error: event.error } : {}),
      })) };
    }
  }, []);

  const poll = useCallback(async (session: Session) => {
    if (!isCurrent(session) || !session.ready || session.paused || session.polling) return;
    session.polling = true;
    let failures = 0;
    try {
      while (isCurrent(session) && !session.paused) {
        try {
          if (!session.pendingReceipt) {
            const notification = await session.api.receive(session.controller.signal);
            if (!isCurrent(session)) break;
            failures = 0;
            if (!notification) {
              if (!session.paused) setConnection({ status: 'online' });
              continue;
            }
            session.pendingReceipt = { id: notification.receiptId };
            const event = normalizeNotification(notification.body);
            if (event.kind === 'message') {
              const result = upsertMessage(session.history, event);
              session.history = result.history;
              if (result.alias) session.aliases.set(result.alias.localId, result.alias.serverId);
              applyEarlyStatus(session, event.message.chatId, event.message.id);
            } else if (event.kind === 'status') {
              const exists = session.history.chats.find(chat => chat.id === event.chatId)
                ?.messages.some(message => message.id === event.id);
              const key = `${event.chatId}:${event.id}`;
              if (!exists && (session.busy.has(event.chatId) || session.earlyStatuses.has(key))) {
                const previous = session.earlyStatuses.get(key);
                if (!previous || mergeStatus(previous.status, event.status) === event.status) {
                  session.earlyStatuses.set(key, event);
                }
                session.history = { ...session.history, pendingStatuses: [...session.earlyStatuses.values()].map(status => ({
                  chatId: status.chatId, id: status.id, status: status.status, ...(status.error ? { error: status.error } : {}),
                })) };
              } else {
                session.history = applyStatus(session.history, event);
                if (exists) applyEarlyStatus(session, event.chatId, event.id);
              }
            } else if (event.kind === 'state') session.pendingReceipt.state = event.state;
            session.history = mergeRemoteChats(session.history, [], session.account);
            publish(session);
          }
          // This synchronous write must succeed before consuming the server's receipt.
          if (session.paused || !persist(session)) break;
          const pending = session.pendingReceipt;
          await session.api.acknowledge(pending.id, session.controller.signal);
          if (!isCurrent(session)) break;
          // result:false means this receipt was already deleted or is no longer current.
          // Move on instead of starving the queue by repeatedly deleting the same receipt.
          session.pendingReceipt = undefined;
          failures = 0;
          if (!session.paused) setConnection({ status: 'online' });
          if (pending.state && ['notAuthorized', 'blocked', 'pendingPassword'].includes(pending.state)) {
            endSession(session, 'Инстанс MAX потерял авторизацию. Подключите его в кабинете GREEN-API и войдите снова.');
            break;
          }
        } catch (pollError) {
          if (!isCurrent(session)) break;
          if (pollError instanceof ApiError && pollError.isAuthError) {
            endSession(session, pollError.message);
            break;
          }
          setConnection({ status: 'reconnecting', message: errorText(pollError) });
          const delay = Math.min(1000 * 2 ** Math.min(failures++, 5), 30_000);
          await pause(session, delay);
        }
      }
    } catch {
      // Aborting an old session also cancels its retry timer.
    } finally {
      session.polling = false;
    }
  }, [applyEarlyStatus, endSession, isCurrent, persist, publish]);
  pollRef.current = poll;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; dispose(); };
  }, [dispose]);

  const login = useCallback(async (input: Credentials): Promise<boolean> => {
    const credentials = { idInstance: input.idInstance.trim(), apiTokenInstance: input.apiTokenInstance.trim() };
    if (!/^\d+$/.test(credentials.idInstance) || !credentials.apiTokenInstance || /\s/.test(credentials.apiTokenInstance)) {
      setError('Введите числовой idInstance и apiTokenInstance из кабинета GREEN-API.');
      return false;
    }
    dispose();
    const session: Session = {
      generation: generation.current, credentials, api: createGreenApi(credentials), controller: new AbortController(),
      history: { version: 1, chats: [] }, ready: false, polling: false, paused: false,
      busy: new Set(), aliases: new Map(), earlyStatuses: new Map(), loading: new Map(),
    };
    sessionRef.current = session;
    setPhase('connecting');
    setChats([]);
    setBusyChatIds([]);
    setLoadingChatIds([]);
    setNotice(null);
    setError(null);
    setConnection({ status: 'online' });
    try {
      const release = await acquireLock(credentials.idInstance);
      if (!isCurrent(session)) { release(); return false; }
      session.releaseLock = release;
      const [state, settings] = await Promise.all([
        session.api.getState(session.controller.signal), session.api.getSettings(session.controller.signal),
      ]);
      if (!isCurrent(session)) return false;
      if (settings.typeInstance !== 'v3') throw new Error('Нужен инстанс GREEN-API для MAX. Инстанс другого мессенджера не подойдет.');
      if (state !== 'authorized') throw new Error(`Инстанс MAX не авторизован (${state}). Подключите его в кабинете GREEN-API.`);
      if (settings.webhookUrl !== '' || settings.incomingWebhook !== 'yes') {
        throw new Error('В настройках GREEN-API очистите «Адрес отправки уведомлений (URL)» (Webhook Url / webhookUrl) и включите «Получать уведомления о входящих сообщениях и файлах» (Receive webhooks on incoming messages and files).');
      }
      session.history = loadHistory(credentials.idInstance);
      for (const status of session.history.pendingStatuses ?? []) {
        session.earlyStatuses.set(`${status.chatId}:${status.id}`, { kind: 'status', ...status });
      }
      // A write check also detects unavailable/quota-limited storage before polling consumes anything.
      saveHistory(credentials.idInstance, session.history);
      const [accountResult, chatsResult] = await Promise.allSettled([
        session.api.getAccountSettings(session.controller.signal), session.api.getChats(session.controller.signal),
      ]);
      if (!isCurrent(session)) return false;
      for (const result of [accountResult, chatsResult]) {
        if (result.status === 'rejected' && result.reason instanceof ApiError && result.reason.isAuthError) throw result.reason;
      }
      if (accountResult.status === 'fulfilled') session.account = accountResult.value;
      session.history = mergeRemoteChats(session.history, chatsResult.status === 'fulfilled' ? chatsResult.value : [], session.account);
      saveHistory(credentials.idInstance, session.history);
      if (chatsResult.status === 'rejected') setError('Не удалось загрузить список чатов MAX. Сохранённые чаты доступны; войдите повторно, чтобы обновить список.');
      const missingNotifications = [
        [settings.outgoingWebhook, 'о статусах отправленных сообщений'],
        [settings.outgoingAPIMessageWebhook, 'о сообщениях, отправленных с API'],
        [settings.outgoingMessageWebhook, 'о сообщениях, отправленных с телефона'],
      ].filter(([value]) => value !== undefined && value !== 'yes').map(([, label]) => label);
      if (missingNotifications.length) setNotice(`В GREEN-API включите уведомления ${missingNotifications.join(', ')}. Это нужно для обновления статусов без повторного открытия чата.`);
      session.ready = true;
      setChats(session.history.chats);
      setPhase('connected');
      void pollRef.current(session);
      return true;
    } catch (loginError) {
      if (isCurrent(session)) endSession(session, errorText(loginError));
      return false;
    }
  }, [dispose, endSession, isCurrent]);

  const logout = useCallback(() => {
    dispose();
    setPhase('signed-out');
    setChats([]);
    setBusyChatIds([]);
    setLoadingChatIds([]);
    setNotice(null);
    setError(null);
    setConnection({ status: 'online' });
  }, [dispose]);

  const loadChat = useCallback(async (chatId: string): Promise<void> => {
    const session = sessionRef.current;
    if (!session || !session.ready || !isCurrent(session) || session.paused) return;
    if (!session.history.chats.some(chat => chat.id === chatId)) return;
    const existing = session.loading.get(chatId);
    if (existing) return existing;
    const task = (async () => {
      try {
        const messages = await session.api.getChatHistory(chatId, session.controller.signal);
        if (!isCurrent(session)) return;
        session.history = mergeRemoteHistory(session.history, chatId, messages);
        for (const message of messages) applyEarlyStatus(session, chatId, message.id);
        session.history = mergeRemoteChats(session.history, [], session.account);
        publish(session);
        persist(session);
      } catch (historyError) {
        if (!isCurrent(session)) return;
        if (historyError instanceof ApiError && historyError.isAuthError) endSession(session, historyError.message);
        else setError(`Не удалось загрузить сообщения. Откройте чат ещё раз, чтобы повторить. ${errorText(historyError)}`);
      } finally {
        session.loading.delete(chatId);
        publish(session);
      }
    })();
    session.loading.set(chatId, task);
    publish(session);
    return task;
  }, [applyEarlyStatus, endSession, isCurrent, persist, publish]);

  const createChat = useCallback(async (input: string): Promise<string | null> => {
    const session = sessionRef.current;
    if (!session || !session.ready || !isCurrent(session)) return null;
    if (session.paused) { setError('Сначала восстановите сохранение истории кнопкой «Повторить».'); return null; }
    const phone = normalizePhone(input);
    if (!phone) { setError('Введите номер в международном формате: +7 и 11 цифр или +375 и 12 цифр.'); return null; }
    const existing = session.history.chats.find(chat => chat.phone === phone);
    if (existing) return existing.id;
    setError(null);
    try {
      const id = await session.api.checkAccount(phone, session.controller.signal);
      if (!isCurrent(session)) return null;
      const existingById = session.history.chats.find(chat => chat.id === id);
      session.history = { ...session.history, chats: existingById ? session.history.chats.map(chat => chat.id === id
        ? { ...chat, phone, name: chat.name === id ? `+${phone}` : chat.name } : chat)
        : [...session.history.chats, { id, phone, name: `+${phone}`, messages: [] }] };
      session.history = mergeRemoteChats(session.history, [], session.account);
      publish(session);
      return persist(session) ? id : null;
    } catch (chatError) {
      if (isCurrent(session)) {
        if (chatError instanceof ApiError && chatError.isAuthError) endSession(session, chatError.message);
        else setError(errorText(chatError));
      }
      return null;
    }
  }, [endSession, isCurrent, persist, publish]);

  const sendMessage = useCallback(async (chatId: string, text: string): Promise<boolean> => {
    const session = sessionRef.current;
    if (!session || !session.ready || !isCurrent(session) || session.busy.has(chatId)) return false;
    if (session.paused) { setError('Сначала восстановите сохранение истории кнопкой «Повторить».'); return false; }
    if (!session.history.chats.some(chat => chat.id === chatId)) return false;
    if (session.history.chats.find(chat => chat.id === chatId)?.type === 'channel') {
      setError('Канал доступен только для чтения.');
      return false;
    }
    if (!text.trim() || text.length > 4000) { setError('Сообщение должно содержать от 1 до 4000 символов.'); return false; }
    setError(null);
    const localId = `local:${crypto.randomUUID()}`;
    session.busy.add(chatId);
    session.history = upsertMessage(session.history, { kind: 'message', apiEcho: false,
      message: { id: localId, chatId, direction: 'outgoing', text, timestamp: Date.now(), status: 'sending' } }).history;
    publish(session);
    if (!persist(session)) {
      session.history = updateMessage(session.history, chatId, localId, { status: 'failed', error: 'Сообщение не отправлено: история не сохранена.' });
      session.busy.delete(chatId);
      publish(session);
      return false;
    }
    try {
      const id = await session.api.sendMessage(chatId, text, session.controller.signal);
      if (!isCurrent(session)) return false;
      const alias = session.aliases.get(localId);
      session.history = confirmSend(session.history, chatId, alias ?? localId, id);
      applyEarlyStatus(session, chatId, id);
      publish(session);
      persist(session);
      // The POST succeeded even if browser storage subsequently failed; do not invite a duplicate send.
      return true;
    } catch (sendError) {
      if (!isCurrent(session)) return false;
      if (sendError instanceof ApiError && sendError.isAuthError) {
        session.history = updateMessage(session.history, chatId, localId, { status: 'failed', error: sendError.message });
        persist(session);
        endSession(session, sendError.message);
        return false;
      }
      if (session.aliases.has(localId)) {
        // An API echo independently confirmed the POST that lost its HTTP response.
        return true;
      }
      const uncertain = sendError instanceof ApiError && (sendError.kind !== 'http' || sendError.status >= 500);
      const message = uncertain
        ? 'Доставка неизвестна: ответ GREEN-API не получен. Проверьте MAX перед повторной отправкой.' : errorText(sendError);
      session.history = updateMessage(session.history, chatId, localId, { status: uncertain ? 'uncertain' : 'failed', error: message });
      publish(session);
      persist(session);
      setError(message);
      return false;
    } finally {
      if (isCurrent(session)) {
        session.busy.delete(chatId);
        session.aliases.delete(localId);
        publish(session);
      }
    }
  }, [applyEarlyStatus, endSession, isCurrent, persist, publish]);

  const retry = useCallback(() => {
    const session = sessionRef.current;
    if (!session || !session.ready || !isCurrent(session)) return;
    if (session.paused) {
      if (!persist(session)) return;
      session.paused = false;
      setConnection({ status: 'reconnecting', message: 'Возобновляем получение сообщений…' });
    }
    session.wakeRetry?.();
    void pollRef.current(session);
  }, [isCurrent, persist]);

  const clearError = useCallback(() => setError(null), []);
  return { phase, chats, busyChatIds, loadingChatIds, connection, error, notice, login, logout, createChat, loadChat, sendMessage, retry, clearError };
}
