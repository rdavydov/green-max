import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Messenger } from './core/types';
import App from './App';

const { useMessengerMock } = vi.hoisted(() => ({ useMessengerMock: vi.fn() }));
vi.mock('./core/useMessenger', () => ({ useMessenger: useMessengerMock }));

let messenger: Messenger;

beforeEach(() => {
  messenger = {
    phase: 'signed-out',
    chats: [
      { id: 'chat-1', name: 'Анна', phone: '79991234567', messages: [] },
      { id: 'chat-2', name: 'Борис', phone: '79997654321', messages: [] },
    ],
    busyChatIds: [],
    connection: { status: 'online' },
    error: null,
    login: vi.fn().mockResolvedValue(true),
    logout: vi.fn(),
    createChat: vi.fn().mockResolvedValue('chat-1'),
    loadChat: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(true),
    retry: vi.fn(),
    clearError: vi.fn(),
  };
  useMessengerMock.mockReturnValue(messenger);
});

function openConversation(name = 'Анна') {
  messenger.phase = 'connected';
  const result = render(<App />);
  fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }));
  return result;
}

describe('credentials form', () => {
  it('hides the token and submits trimmed credentials', async () => {
    render(<App />);
    expect(screen.getByLabelText('apiTokenInstance')).toHaveAttribute('type', 'password');
    fireEvent.change(screen.getByLabelText('idInstance'), { target: { value: ' 123456 ' } });
    fireEvent.change(screen.getByLabelText('apiTokenInstance'), { target: { value: ' token ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Подключиться' }));
    await waitFor(() => expect(messenger.login).toHaveBeenCalledWith({ idInstance: '123456', apiTokenInstance: 'token' }));
  });

  it('rejects a nonnumeric instance ID before calling the API', async () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText('idInstance'), { target: { value: 'bad-id' } });
    fireEvent.change(screen.getByLabelText('apiTokenInstance'), { target: { value: 'token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Подключиться' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Укажите числовой idInstance');
    expect(messenger.login).not.toHaveBeenCalled();
  });

  it('shows an API error and disables all credential controls while connecting', () => {
    messenger.phase = 'connecting';
    messenger.error = 'Инстанс не авторизован';
    render(<App />);
    expect(screen.getByRole('alert')).toHaveTextContent('Инстанс не авторизован');
    expect(screen.getByLabelText('idInstance')).toBeDisabled();
    expect(screen.getByLabelText('apiTokenInstance')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Подключаемся…' })).toBeDisabled();
  });
});

describe('new chat dialog', () => {
  it('shows a storage failure inside the modal when creating the chat cannot persist', async () => {
    messenger.phase = 'connected';
    messenger.createChat = vi.fn().mockResolvedValue(null);
    const { rerender } = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Новый чат' }));
    fireEvent.change(screen.getByLabelText('Номер телефона'), { target: { value: '+79991234567' } });
    fireEvent.click(screen.getByRole('button', { name: 'Создать чат' }));
    await waitFor(() => expect(messenger.createChat).toHaveBeenCalledOnce());
    messenger.connection = { status: 'storage-error', message: 'Не удалось сохранить историю. Освободите место.' };
    rerender(<App />);
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent('Не удалось сохранить историю. Освободите место.');
    expect(screen.getByLabelText('Номер телефона')).toHaveValue('+79991234567');
  });

  it('focuses the phone field, opens an existing chat, and closes the dialog', async () => {
    messenger.phase = 'connected';
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Новый чат' }));
    const phone = screen.getByLabelText('Номер телефона');
    expect(phone).toHaveFocus();
    fireEvent.change(phone, { target: { value: '+7 (999) 123-45-67' } });
    fireEvent.click(screen.getByRole('button', { name: 'Создать чат' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(messenger.createChat).toHaveBeenCalledWith('+7 (999) 123-45-67');
    expect(screen.getByRole('region', { name: 'Переписка с Анна' })).toBeInTheDocument();
  });

  it('keeps focus inside the modal and returns it to its trigger on Escape', () => {
    messenger.phase = 'connected';
    render(<App />);
    const trigger = screen.getByRole('button', { name: 'Новый чат' });
    trigger.focus();
    fireEvent.click(trigger);
    const submit = screen.getByRole('button', { name: 'Создать чат' });
    submit.focus();
    fireEvent.keyDown(submit, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Закрыть' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe('message composer', () => {
  it('sends on Enter but leaves Shift+Enter and IME confirmation alone', async () => {
    openConversation();
    const composer = screen.getByRole('textbox', { name: 'Сообщение' });
    fireEvent.change(composer, { target: { value: 'Привет!\nКак дела?' } });
    expect(fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(composer, { key: 'Enter', isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(composer, { key: 'Enter', keyCode: 229 })).toBe(true);
    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(composer, { key: 'Enter' })).toBe(false);
    await waitFor(() => expect(messenger.sendMessage).toHaveBeenCalledWith('chat-1', 'Привет!\nКак дела?'));
    await waitFor(() => expect(composer).toHaveValue(''));
  });

  it('rejects empty text and 4001 characters, accepting exactly 4000', () => {
    openConversation();
    const composer = screen.getByRole('textbox', { name: 'Сообщение' });
    const submit = screen.getByRole('button', { name: 'Отправить' });
    expect(submit).toBeDisabled();
    fireEvent.change(composer, { target: { value: '   \n ' } });
    expect(submit).toBeDisabled();
    fireEvent.change(composer, { target: { value: 'a'.repeat(4001) } });
    expect(submit).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Максимум 4000 символов');
    expect(composer).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(composer, { target: { value: 'a'.repeat(4000) } });
    expect(submit).not.toBeDisabled();
  });

  it('keeps independent drafts while switching chats and returning to the list', () => {
    openConversation();
    fireEvent.change(screen.getByRole('textbox', { name: 'Сообщение' }), { target: { value: 'Черновик Анне' } });
    fireEvent.click(screen.getByRole('button', { name: /Борис/ }));
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveValue('');
    fireEvent.change(screen.getByRole('textbox', { name: 'Сообщение' }), { target: { value: 'Черновик Борису' } });
    fireEvent.click(screen.getByRole('button', { name: 'Назад к чатам' }));
    fireEvent.click(screen.getByRole('button', { name: /Анна/ }));
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveValue('Черновик Анне');
  });

  it('keeps a draft after a send failure', async () => {
    messenger.sendMessage = vi.fn().mockResolvedValue(false);
    openConversation();
    fireEvent.change(screen.getByRole('textbox', { name: 'Сообщение' }), { target: { value: 'Повторить вручную' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    await waitFor(() => expect(messenger.sendMessage).toHaveBeenCalledOnce());
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveValue('Повторить вручную');
  });

  it('prevents duplicate submissions before the pending hook state is published', async () => {
    let resolveSend: ((success: boolean) => void) | undefined;
    messenger.sendMessage = vi.fn().mockImplementation(() => new Promise<boolean>((resolve) => { resolveSend = resolve; }));
    openConversation();
    fireEvent.change(screen.getByRole('textbox', { name: 'Сообщение' }), { target: { value: 'Один раз' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Сообщение' }), { key: 'Enter' });
    expect(messenger.sendMessage).toHaveBeenCalledOnce();
    await act(async () => { resolveSend?.(true); });
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveValue('');
  });

  it('blocks the composer when the selected chat has a pending send', () => {
    messenger.busyChatIds = ['chat-1'];
    openConversation();
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeDisabled();
  });
});

describe('history and connection state', () => {
  it('closes a settings notice for the current session while switching conversations', () => {
    messenger.notice = 'Включите уведомления о статусах';
    messenger.phase = 'connected';
    const { container } = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Скрыть уведомление' }));
    expect(container.querySelector('[data-notice="settings"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Анна/ }));
    expect(container.querySelector('[data-notice="settings"]')).toBeNull();
  });

  it('collapses a storage warning without losing recovery controls, and expands it again', () => {
    messenger.connection = { status: 'storage-error', message: 'Нужен доступ к хранилищу' };
    const { container } = openConversation();
    fireEvent.click(screen.getByRole('button', { name: 'Свернуть уведомление' }));
    expect(container.querySelector('[data-notice="connection"]')).toBeNull();
    expect(container.querySelector('[data-notice="connection-summary"]')).toHaveTextContent('Получение приостановлено');
    fireEvent.click(screen.getByRole('button', { name: 'Развернуть уведомление' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Нужен доступ к хранилищу');
  });

  it('shows group authors and keeps channels read-only', () => {
    messenger.chats[0].type = 'group';
    messenger.chats[0].messages = [{ id: 'group-text', chatId: 'chat-1', direction: 'incoming', text: 'Ответ группы',
      timestamp: 1720000000000, status: 'delivered', senderName: 'Елена' }];
    messenger.chats[1].type = 'channel';
    const { container } = openConversation();
    expect(container.querySelector('.message-author')).toHaveTextContent('Елена');
    fireEvent.click(screen.getByRole('button', { name: /Борис/ }));
    expect(screen.getByText('Канал доступен только для чтения')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Сообщение' })).not.toBeInTheDocument();
  });

  it('loads the selected chat and distinguishes sent from queued', () => {
    messenger.chats[0].messages = [
      { id: 'm-1', chatId: 'chat-1', direction: 'outgoing', text: 'Подтверждено MAX', timestamp: 1720000000000, status: 'sent' },
      { id: 'm-2', chatId: 'chat-1', direction: 'outgoing', text: 'Принято GREEN-API', timestamp: 1720000060000, status: 'queued' },
    ];
    openConversation();
    expect(messenger.loadChat).toHaveBeenCalledWith('chat-1');
    expect(screen.getByLabelText('Отправлено')).toBeInTheDocument();
    expect(screen.getByLabelText('В очереди')).toBeInTheDocument();
  });

  it('shows a chat-list fetch error in the sidebar before a conversation is selected', () => {
    messenger.phase = 'connected';
    messenger.error = 'Не удалось загрузить список чатов MAX';
    render(<App />);
    expect(within(screen.getByRole('complementary', { name: 'Чаты' })).getByRole('alert')).toHaveTextContent(messenger.error);
  });

  it('discards local drafts and selection on authentication loss before another login', () => {
    const { rerender } = openConversation();
    fireEvent.change(screen.getByRole('textbox', { name: 'Сообщение' }), { target: { value: 'Старый аккаунт' } });
    messenger.phase = 'signed-out';
    rerender(<App />);
    expect(screen.getByLabelText('apiTokenInstance')).toBeInTheDocument();
    messenger.phase = 'connected';
    rerender(<App />);
    expect(screen.queryByRole('textbox', { name: 'Сообщение' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Анна/ }));
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveValue('');
  });

  it('ignores a late chat creation result after the connected session ends', async () => {
    let resolveCreate: ((chatId: string | null) => void) | undefined;
    messenger.createChat = vi.fn().mockImplementation(() => new Promise<string | null>((resolve) => { resolveCreate = resolve; }));
    messenger.phase = 'connected';
    const { rerender } = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Новый чат' }));
    fireEvent.change(screen.getByLabelText('Номер телефона'), { target: { value: '+79991234567' } });
    fireEvent.click(screen.getByRole('button', { name: 'Создать чат' }));
    messenger.phase = 'signed-out';
    rerender(<App />);
    messenger.phase = 'connected';
    rerender(<App />);
    vi.mocked(messenger.clearError).mockClear();
    await act(async () => { resolveCreate?.('chat-1'); });
    expect(screen.queryByRole('textbox', { name: 'Сообщение' })).not.toBeInTheDocument();
    expect(messenger.clearError).not.toHaveBeenCalled();
  });

  it('shows incoming text, outgoing read status and multiline content', () => {
    messenger.chats[0].messages = [
      { id: 'm-1', chatId: 'chat-1', direction: 'incoming', text: 'Привет!\nВот ссылка: https://example.com', timestamp: 1720000000000, status: 'delivered' },
      { id: 'm-2', chatId: 'chat-1', direction: 'outgoing', text: 'Спасибо', timestamp: 1720000060000, status: 'read' },
    ];
    const { container } = openConversation();
    expect(container.querySelector('[data-message-id="m-1"]')).toHaveTextContent('Вот ссылка: https://example.com');
    expect(screen.getByLabelText('Прочитано')).toBeInTheDocument();
    expect(container.querySelector('[data-message-id="m-2"]')).toHaveTextContent('Прочитано');
  });

  it('shows storage recovery without removing the draft', () => {
    messenger.connection = { status: 'storage-error', message: 'Не удалось сохранить историю' };
    openConversation();
    fireEvent.change(screen.getByRole('textbox', { name: 'Сообщение' }), { target: { value: 'Черновик' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Не удалось сохранить историю');
    fireEvent.click(screen.getAllByRole('button', { name: 'Повторить' })[0]);
    expect(messenger.retry).toHaveBeenCalledOnce();
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveValue('Черновик');
  });
});
