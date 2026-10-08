import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import type { Chat, Message, MessageStatus, Messenger } from './core/types';
import { useMessenger } from './core/useMessenger';
import './styles.css';

const MAX_MESSAGE_LENGTH = 4000;
const timeFormatter = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dateFormatter = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });

function Icon({ name, className = '' }: { name: 'plus' | 'send' | 'back' | 'close' | 'logout' | 'chat' | 'check' | 'double-check'; className?: string }) {
  const paths: Record<typeof name, ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    send: <><path d="m3 3 19 9-19 9 4-9-4-9Z" /><path d="M7 12h15" /></>,
    back: <><path d="m14 6-6 6 6 6" /><path d="M8 12h12" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    logout: <><path d="M10 4H5v16h5M14 8l4 4-4 4M9 12h9" /></>,
    chat: <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-1 1v-9.5a8.5 8.5 0 0 1 17 0Z" />,
    check: <path d="m5 12 4 4L19 6" />,
    'double-check': <><path d="m2 12 4 4L16 6" /><path d="m10 14 2 2L22 6" /></>,
  };
  return <svg className={`icon ${className}`} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function Brand({ large = false }: { large?: boolean }) {
  const gradientId = useId();
  return <div className={`brand${large ? ' brand-large' : ''}`}>
    <svg className="brand-mark" viewBox="0 0 48 48" aria-hidden="true">
      <defs><linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#18d7bd" /><stop offset="1" stopColor="#2589f8" /></linearGradient></defs>
      <rect width="48" height="48" rx="16" fill={`url(#${gradientId})`} />
      <path d="M13 32V17h4l7 9 7-9h4v15h-4V23l-7 9-7-9v9Z" fill="white" />
    </svg>
    <span>MAX<span className="brand-caption">через GREEN-API</span></span>
  </div>;
}

function Avatar({ chat, large = false }: { chat: Chat; large?: boolean }) {
  const characters = chat.name.replace(/[^\p{L}\p{N}]/gu, '');
  const initials = /^\d/.test(characters) ? characters.slice(-2) : characters.slice(0, 2).toUpperCase();
  return <span className={`avatar${large ? ' avatar-large' : ''}`} aria-hidden="true">{initials || 'М'}</span>;
}

function ErrorMessage({ children }: { children: ReactNode }) {
  return <p className="form-error" role="alert">{children}</p>;
}

function Login({ connecting, error, onLogin, onClearError }: { connecting: boolean; error: string | null; onLogin: (id: string, token: string) => Promise<boolean>; onClearError: () => void }) {
  const [idInstance, setIdInstance] = useState('');
  const [apiTokenInstance, setApiTokenInstance] = useState('');
  const [validation, setValidation] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (connecting) return;
    onClearError();
    if (!/^\d+$/.test(idInstance.trim()) || !apiTokenInstance.trim()) {
      setValidation('Укажите числовой idInstance и токен вашего инстанса.');
      return;
    }
    setValidation(null);
    await onLogin(idInstance.trim(), apiTokenInstance.trim());
  }

  return <main className="login-page">
    <div className="login-decoration login-decoration-one" aria-hidden="true" />
    <div className="login-decoration login-decoration-two" aria-hidden="true" />
    <section className="login-card" aria-labelledby="login-heading">
      <Brand large />
      <div className="login-copy"><h1 id="login-heading">Ваши сообщения.<br />В одном окне.</h1><p>Подключите аккаунт GREEN-API,<br className="desktop-break" /> чтобы общаться в MAX.</p></div>
      <form onSubmit={submit} className="login-form">
        <label htmlFor="instance-id">idInstance</label>
        <input id="instance-id" name="idInstance" value={idInstance} onChange={(event) => { setIdInstance(event.target.value); setValidation(null); }} inputMode="numeric" autoComplete="off" placeholder="ID вашего инстанса" disabled={connecting} required />
        <label htmlFor="instance-token">apiTokenInstance</label>
        <input id="instance-token" name="apiTokenInstance" type="password" value={apiTokenInstance} onChange={(event) => { setApiTokenInstance(event.target.value); setValidation(null); }} autoComplete="off" placeholder="Токен вашего инстанса" disabled={connecting} required />
        {(validation || error) && <ErrorMessage>{validation || error}</ErrorMessage>}
        <button type="submit" className="button button-primary login-submit" disabled={connecting}>{connecting ? <><span className="spinner" aria-hidden="true" />Подключаемся…</> : 'Подключиться'}</button>
      </form>
      <p className="login-help">Данные инстанса доступны в <a href="https://console.green-api.com/" target="_blank" rel="noreferrer">личном кабинете GREEN-API</a>.</p>
      <div className="login-note"><span className="privacy-dot" aria-hidden="true" /><p>Токен хранится только до закрытия или обновления страницы. История чатов сохраняется в этом браузере.</p></div>
    </section>
    <p className="login-footer">Текстовые сообщения в MAX · GREEN-API</p>
  </main>;
}

function NewChatDialog({ error, onCreate, onClose, onClearError }: { error: string | null; onCreate: (phone: string) => Promise<string | null>; onClose: () => void; onClearError: () => void }) {
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previousElement = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => { previousElement?.focus(); };
  }, []);

  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !busy) { event.preventDefault(); onClose(); }
    if (event.key !== 'Tab') return;
    const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]') || [])
      .sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    if (!controls.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    onClearError();
    try { await onCreate(phone); } finally { setBusy(false); }
  }

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialog} onKeyDown={keyboard}>
      <button className="icon-button dialog-close" type="button" aria-label="Закрыть" onClick={onClose} disabled={busy}><Icon name="close" /></button>
      <div className="dialog-symbol" aria-hidden="true"><Icon name="chat" /></div>
      <h2 id={titleId}>Новый чат</h2>
      <p className="dialog-description">Введите номер получателя,<br />зарегистрированного в MAX.</p>
      <form onSubmit={submit}>
        <label htmlFor="recipient-phone">Номер телефона</label>
        <input id="recipient-phone" type="tel" name="phone" autoComplete="tel" placeholder="+7 999 123-45-67" value={phone} onChange={(event) => { setPhone(event.target.value); onClearError(); }} disabled={busy} aria-describedby="phone-hint" required />
        <p className="field-hint" id="phone-hint">Россия (+7) или Беларусь (+375)</p>
        {error && <ErrorMessage>{error}</ErrorMessage>}
        <button className="button button-primary dialog-submit" type="submit" disabled={busy}>{busy ? 'Создаём чат…' : 'Создать чат'}</button>
      </form>
    </div>
  </div>;
}

const statusLabels: Record<MessageStatus, string> = { sending: 'Отправляется', queued: 'В очереди', delivered: 'Доставлено', read: 'Прочитано', failed: 'Не отправлено', uncertain: 'Отправка не подтверждена' };

function MessageBubble({ message }: { message: Message }) {
  const outgoing = message.direction === 'outgoing';
  const problem = message.status === 'failed' || message.status === 'uncertain';
  return <div className={`message-row ${outgoing ? 'message-outgoing' : 'message-incoming'}`} data-message-id={message.id}>
    <div className={`message-bubble${problem ? ' message-problem' : ''}`}>
      <p className="message-text">{message.text}</p>
      <div className="message-meta"><time dateTime={new Date(message.timestamp).toISOString()}>{timeFormatter.format(message.timestamp)}</time>
        {outgoing && <span className={`message-status status-${message.status}`} title={message.error || statusLabels[message.status]} aria-label={statusLabels[message.status]}>
          {message.status === 'delivered' || message.status === 'read' ? <><span>{statusLabels[message.status]}</span><Icon name="double-check" /></> : message.status === 'queued' ? <><span>{statusLabels[message.status]}</span><Icon name="check" /></> : message.status === 'sending' ? '· · ·' : statusLabels[message.status]}
        </span>}
      </div>
    </div>
  </div>;
}

function Conversation({ chat, draft, pending, onDraft, onSend, onBack }: { chat: Chat; draft: string; pending: boolean; onDraft: (value: string) => void; onSend: () => void; onBack: () => void }) {
  const messageEnd = useRef<HTMLDivElement>(null);
  const messageList = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const overLimit = draft.length > MAX_MESSAGE_LENGTH;
  const canSend = !pending && !overLimit && Boolean(draft.trim());

  useEffect(() => {
    messageEnd.current?.scrollIntoView?.({ block: 'end' });
  }, [chat.id, chat.messages.length]);

  useEffect(() => {
    if (!composer.current) return;
    composer.current.style.height = 'auto';
    composer.current.style.height = `${Math.min(composer.current.scrollHeight, 142)}px`;
  }, [draft, chat.id]);

  function keyboard(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (canSend) onSend();
  }

  return <section className="conversation" aria-label={`Переписка с ${chat.name}`}>
    <header className="conversation-header">
      <button type="button" className="icon-button mobile-back" aria-label="Назад к чатам" onClick={onBack}><Icon name="back" /></button>
      <Avatar chat={chat} />
      <div className="conversation-contact"><h2>{chat.name}</h2><p>{chat.phone ? `+${chat.phone}` : 'Личный чат MAX'}</p></div>
      <span className="conversation-badge">MAX</span>
    </header>
    <div className="messages" ref={messageList} role="log" aria-label="Сообщения" aria-live="polite" aria-relevant="additions">
      {chat.messages.length === 0 ? <div className="conversation-start"><span><Icon name="chat" /></span><h3>Начните разговор</h3><p>Отправьте первое сообщение {chat.name}.</p></div> : chat.messages.map((message, index) => {
        const previous = chat.messages[index - 1];
        const newDay = !previous || new Date(previous.timestamp).toDateString() !== new Date(message.timestamp).toDateString();
        return <div className="message-group" key={`${message.chatId}:${message.id}`}>
          {newDay && <div className="date-divider"><span>{dateFormatter.format(message.timestamp)}</span></div>}
          <MessageBubble message={message} />
        </div>;
      })}
      <div ref={messageEnd} />
    </div>
    <form className="composer" onSubmit={(event) => { event.preventDefault(); if (canSend) onSend(); }}>
      <div className={`composer-input-wrap${overLimit ? ' composer-invalid' : ''}`}>
        <textarea ref={composer} aria-label="Сообщение" placeholder="Напишите сообщение…" value={draft} onChange={(event) => onDraft(event.target.value)} onKeyDown={keyboard} disabled={pending} rows={1} aria-invalid={overLimit} aria-describedby={overLimit ? 'message-length-error' : 'composer-hint'} />
        <button type="submit" className="send-button" aria-label="Отправить" title="Отправить сообщение" disabled={!canSend}>{pending ? <span className="spinner" aria-hidden="true" /> : <Icon name="send" />}</button>
      </div>
      <div className="composer-footer">{overLimit ? <p id="message-length-error" className="composer-error" role="alert">Максимум 4000 символов</p> : <p id="composer-hint">Enter — отправить · Shift + Enter — новая строка</p>}<span className={overLimit ? 'character-count over-limit' : 'character-count'}>{draft.length > 0 ? `${draft.length} / 4000` : ''}</span></div>
    </form>
  </section>;
}

function ChatWorkspace({ messenger }: { messenger: Messenger }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const sendInFlight = useRef(new Set<string>());
  const mounted = useRef(true);
  const selectedChat = messenger.chats.find((chat) => chat.id === selectedId);
  const orderedChats = [...messenger.chats].sort((a, b) => (b.messages.at(-1)?.timestamp || 0) - (a.messages.at(-1)?.timestamp || 0));

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  function logout() {
    mounted.current = false;
    messenger.logout();
    setSelectedId(null);
    setNewChatOpen(false);
    setDrafts({});
  }

  async function createChat(phone: string) {
    const chatId = await messenger.createChat(phone);
    if (!mounted.current) return null;
    if (chatId) { setSelectedId(chatId); setNewChatOpen(false); messenger.clearError(); }
    return chatId;
  }

  async function sendMessage() {
    if (!selectedChat || sendInFlight.current.has(selectedChat.id)) return;
    const chatId = selectedChat.id;
    const text = drafts[chatId] || '';
    if (!text.trim() || text.length > MAX_MESSAGE_LENGTH) return;
    sendInFlight.current.add(chatId);
    try {
      const success = await messenger.sendMessage(chatId, text);
      if (success && mounted.current) setDrafts((current) => current[chatId] === text ? { ...current, [chatId]: '' } : current);
    } finally { sendInFlight.current.delete(chatId); }
  }

  return <main className={`chat-app${selectedChat ? ' has-selection' : ''}`}>
    <aside className="sidebar" aria-label="Чаты">
      <header className="sidebar-header"><Brand /><button type="button" className="icon-button logout-button" onClick={logout} aria-label="Выйти" title="Выйти"><Icon name="logout" /></button></header>
      <div className="sidebar-heading"><h1>Сообщения</h1><span>{messenger.chats.length}</span></div>
      <div className="new-chat-wrap"><button type="button" className="button new-chat-button" onClick={() => { messenger.clearError(); setNewChatOpen(true); }}><Icon name="plus" />Новый чат</button></div>
      <nav className="chat-list" aria-label="Список чатов">
        {orderedChats.length ? orderedChats.map((chat) => {
          const last = chat.messages.at(-1);
          return <button key={chat.id} type="button" data-chat-id={chat.id} className={`chat-list-item${chat.id === selectedId ? ' selected' : ''}`} onClick={() => setSelectedId(chat.id)} aria-current={chat.id === selectedId ? 'true' : undefined}>
            <Avatar chat={chat} />
            <span className="chat-list-content"><span className="chat-list-top"><span className="chat-name">{chat.name}</span>{last && <time dateTime={new Date(last.timestamp).toISOString()}>{timeFormatter.format(last.timestamp)}</time>}</span><span className="chat-preview">{last ? `${last.direction === 'outgoing' ? 'Вы: ' : ''}${last.text}` : 'Пока нет сообщений'}</span></span>
          </button>;
        }) : <div className="empty-sidebar"><Icon name="chat" /><p>Здесь появятся ваши чаты</p><span>Создайте первый чат<br />по номеру телефона.</span></div>}
      </nav>
      <footer className="sidebar-footer"><span className={`connection-dot ${messenger.connection.status}`} /><span>{messenger.connection.status === 'online' ? 'Подключено к GREEN-API' : messenger.connection.status === 'reconnecting' ? 'Восстанавливаем соединение' : 'Получение приостановлено'}</span>{messenger.connection.status !== 'online' && <button type="button" onClick={messenger.retry}>Повторить</button>}</footer>
    </aside>
    <div className="chat-main">
      {messenger.connection.status !== 'online' && <div className={`connection-banner ${messenger.connection.status}`} role={messenger.connection.status === 'storage-error' ? 'alert' : 'status'}><span>{messenger.connection.message || (messenger.connection.status === 'reconnecting' ? 'Соединение прервано. Пробуем подключиться снова…' : 'Не удалось сохранить историю. Освободите место в браузере, затем повторите попытку.')}</span><button type="button" onClick={messenger.retry}>Повторить</button></div>}
      {messenger.error && !newChatOpen && <div className="error-banner" role="alert"><span>{messenger.error}</span><button type="button" className="icon-button" aria-label="Скрыть ошибку" onClick={messenger.clearError}><Icon name="close" /></button></div>}
      {selectedChat ? <Conversation chat={selectedChat} draft={drafts[selectedChat.id] || ''} pending={messenger.busyChatIds.includes(selectedChat.id)} onDraft={(value) => setDrafts((current) => ({ ...current, [selectedChat.id]: value }))} onSend={() => { void sendMessage(); }} onBack={() => setSelectedId(null)} /> : <section className="welcome-panel" aria-labelledby="welcome-heading"><div className="welcome-symbol"><Icon name="chat" /></div><h2 id="welcome-heading">Всегда на связи</h2><p>Выберите чат слева или начните<br />новый разговор в MAX.</p><button className="button button-primary" type="button" onClick={() => { messenger.clearError(); setNewChatOpen(true); }}><Icon name="plus" />Начать разговор</button><span className="welcome-footnote">Личные чаты · Только текстовые сообщения</span></section>}
    </div>
    {newChatOpen && <NewChatDialog error={messenger.error ?? (messenger.connection.status === 'storage-error' ? messenger.connection.message ?? 'Не удалось сохранить историю в браузере. Закройте окно, освободите место и нажмите «Повторить».' : null)} onCreate={createChat} onClearError={messenger.clearError} onClose={() => { setNewChatOpen(false); messenger.clearError(); }} />}
  </main>;
}

export default function App() {
  const messenger = useMessenger();
  return messenger.phase === 'connected'
    ? <ChatWorkspace messenger={messenger} />
    : <Login connecting={messenger.phase === 'connecting'} error={messenger.error} onClearError={messenger.clearError} onLogin={(idInstance, apiTokenInstance) => messenger.login({ idInstance, apiTokenInstance })} />;
}
