import { expect, test } from '@playwright/test';
import { GreenApiFixture, createChat, credentials, incomingText, login, outgoingStatus, phones, sendText } from './fixtures';

test('существующие чаты и Избранное загружаются из MAX, история не дублируется с уведомлениями', async ({ page, context }) => {
  const api = new GreenApiFixture();
  api.chats = [
    { chatId: '10001', name: 'Анна', type: 'user', phoneNumber: 79991234567 },
    { chatId: '999', name: 'Имя аккаунта', type: 'user', phoneNumber: 79990000000 },
    { chatId: '-10003', name: 'Группа MAX', type: 'group', phoneNumber: 0 },
  ];
  const timestamp = Math.floor(Date.now() / 1000);
  api.chatHistory.set('10001', [
    { type: 'outgoing', idMessage: 'old-outgoing', timestamp, typeMessage: 'textMessage',
      chatId: '10001', chatType: 'user', textMessage: 'Уже отправленное сообщение', statusMessage: 'sent' },
    { type: 'incoming', idMessage: 'old-incoming', timestamp: timestamp - 1, typeMessage: 'extendedTextMessage',
      chatId: '10001', chatType: 'user', textMessage: 'Старая ссылка https://example.org' },
  ]);
  api.chatHistory.set('999', [
    { type: 'outgoing', idMessage: 'saved-note', timestamp, typeMessage: 'textMessage',
      chatId: '999', chatType: 'user', textMessage: 'Моя заметка в Избранном', statusMessage: '' },
  ]);
  await api.install(context);
  await page.goto('./');
  await login(page);
  await expect(page.locator('[data-chat-id="10001"]')).toContainText('Анна');
  await expect(page.locator('[data-chat-id="999"]')).toContainText('Избранное');
  await expect(page.getByText('Группа MAX', { exact: true })).toHaveCount(0);
  await page.locator('[data-chat-id="10001"]').click();
  await expect(page.locator('[data-message-id="old-outgoing"]')).toContainText('Отправлено');
  await expect(page.locator('[data-message-id="old-incoming"]')).toContainText('Старая ссылка https://example.org');
  await api.push(outgoingStatus(100, 'old-outgoing', 'read'));
  await expect(page.locator('[data-message-id="old-outgoing"]')).toContainText('Прочитано');
  await api.push(incomingText(101, 'old-incoming', 'Старая ссылка https://example.org', '10001', true));
  await expect.poll(() => api.deleted.includes(101)).toBe(true);
  await expect(page.locator('[data-message-id="old-incoming"]')).toHaveCount(1);
  await page.locator('[data-chat-id="999"]').click();
  await expect(page.locator('[data-message-id="saved-note"]')).toContainText('Моя заметка в Избранном');
  await expect(page.locator('[data-message-id="saved-note"]')).toContainText('Отправлено');
  await page.locator('[data-chat-id="10001"]').click();
  await expect(page.locator('[data-message-id="old-outgoing"]')).toContainText('Прочитано');
  const stored = await page.evaluate(() => Object.values(localStorage).join('\n'));
  expect(stored).toContain('saved-note');
  expect(stored).not.toContain(credentials.apiTokenInstance);
});

test('статус sent меняет очередь на отправлено до получения доставки', async ({ page, context }) => {
  const api = new GreenApiFixture();
  await api.install(context);
  await page.goto('./');
  await login(page);
  await createChat(page);
  await sendText(page, 'Тест статуса отправки');
  await expect.poll(() => api.sent.length).toBe(1);
  await expect(page.locator('[data-message-id="out-1"]')).toContainText('В очереди');
  await api.push(outgoingStatus(102, 'out-1', 'sent'));
  await expect(page.locator('[data-message-id="out-1"]')).toContainText('Отправлено');
  await api.push(outgoingStatus(103, 'out-1', 'delivered'));
  await expect(page.locator('[data-message-id="out-1"]')).toContainText('Доставлено');
});

test('обмен текстом и URL, статусы, два чата и отсутствие дублей в StrictMode', async ({ page, context }) => {
  const api = new GreenApiFixture();
  await api.install(context);
  await page.goto('./');
  await login(page);
  await api.waitForPoll();
  await createChat(page);
  await sendText(page, 'Привет, Анна!');
  await expect.poll(() => api.sent.length).toBe(1);
  await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toHaveValue('');
  await api.push(outgoingStatus(1, 'out-1', 'delivered'));
  await expect(page.getByText('Доставлено', { exact: true })).toBeVisible();
  await api.push(incomingText(2, 'in-1', 'Привет! Рада тебя видеть.'));
  await expect(page.getByText('Привет! Рада тебя видеть.', { exact: true }).last()).toBeVisible();
  await api.push(incomingText(3, 'in-url', 'Посмотри https://green-api.com/max', '10001', true));
  await expect(page.getByText('Посмотри https://green-api.com/max', { exact: true }).last()).toBeVisible();
  await api.push(incomingText(4, 'in-1', 'Привет! Рада тебя видеть.'));
  await expect.poll(() => api.deleted.includes(4)).toBe(true);
  const visibleMessages = page.locator('[data-message-id="in-1"]');
  await expect(visibleMessages).toHaveCount(1);
  // Recipient lookup is asynchronous; the previous chat remains visible until it completes.
  api.checkAccountDelayMs = 200;
  await createChat(page, phones.second);
  await sendText(page, 'Сообщение для Михаила');
  await expect.poll(() => api.sent.length).toBe(2);
  expect(api.sent[1]).toMatchObject({ chatId: '10002', message: 'Сообщение для Михаила' });
  await api.push(incomingText(5, 'in-other', 'Ответ для первого чата', '10001'));
  await expect.poll(() => api.deleted.includes(5)).toBe(true);
  await page.locator('[data-chat-id="10001"]').click();
  await expect(page.locator('[data-message-id="in-other"]')).toContainText('Ответ для первого чата');
  expect(api.maxPendingReceives).toBe(1);
  expect(api.requests.filter((request) => request.action === 'sendmessage')).toHaveLength(2);
});

test('сохранённый до ACK текст не дублируется после перезагрузки, токен не сохраняется', async ({ page, context }) => {
  const api = new GreenApiFixture();
  await api.install(context);
  await page.goto('./');
  await login(page);
  await createChat(page);
  api.holdDeletes = true;
  await api.push(incomingText(10, 'persisted-before-ack', 'Ответ переживает перезагрузку'));
  await expect(page.locator('[data-message-id="persisted-before-ack"]')).toHaveCount(1);
  await expect.poll(() => api.deleted.includes(10)).toBe(true);
  const stored = await page.evaluate(() => Object.values(localStorage).join('\n'));
  expect(stored).toContain('persisted-before-ack');
  expect(stored).not.toContain(credentials.apiTokenInstance);
  await page.reload();
  await expect(page.getByLabel('apiTokenInstance', { exact: true })).toHaveValue('');
  api.holdDeletes = false;
  await login(page);
  await expect.poll(() => api.deleted.filter((id) => id === 10).length).toBe(2);
  await page.locator('[data-chat-id="10001"]').click();
  await expect(page.locator('[data-message-id="persisted-before-ack"]')).toHaveCount(1);
});

test('сетевая ошибка отправки сохраняет черновик и разблокирует кнопку', async ({ page, context }) => {
  const api = new GreenApiFixture();
  await api.install(context);
  await page.goto('./');
  await login(page);
  await createChat(page);
  api.failNextSend = true;
  await sendText(page, 'Сохранить этот черновик');
  await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toHaveValue('Сохранить этот черновик');
  await expect(page.getByRole('button', { name: 'Отправить', exact: true })).toBeEnabled();
  await expect(page.getByText(/Не удалось|неизвест|провер|соединени/i).last()).toBeVisible();
  expect(api.sent).toHaveLength(0);
});

test('вторая вкладка не получает очередь того же инстанса и может войти после выхода первой', async ({ page, context }) => {
  const api = new GreenApiFixture();
  await api.install(context);
  await page.goto('./');
  await login(page);
  await api.waitForPoll();
  const secondPage = await context.newPage();
  await secondPage.goto('./');
  await login(secondPage);
  await expect(secondPage.getByText(/другой вкладке/i)).toBeVisible();
  expect(api.requests.filter((request) => request.action === 'receivenotification')).toHaveLength(1);
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.getByLabel('apiTokenInstance', { exact: true })).toHaveValue('');
  await login(secondPage);
  await expect(secondPage.getByRole('button', { name: 'Новый чат', exact: true })).toBeVisible();
});

test('выход отменяет pending Receive и поздний ответ не возвращает историю на экран входа', async ({ page, context }) => {
  const api = new GreenApiFixture();
  await api.install(context);
  await page.goto('./');
  await login(page);
  await api.waitForPoll();
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Подключиться', exact: true })).toBeVisible();
  await expect.poll(() => api.pendingReceives).toBe(0);
  await api.push(incomingText(20, 'late-message', 'Поздний ответ старой сессии'));
  await expect(page.getByText('Поздний ответ старой сессии', { exact: true })).toHaveCount(0);
  expect(api.deleted).not.toContain(20);
  expect(api.requests.filter((request) => request.action === 'receivenotification')).toHaveLength(1);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 360, height: 780 }]) {
  test(`чат доступен без горизонтальной прокрутки при ${viewport.width}×${viewport.height}`, async ({ page, context }) => {
    const api = new GreenApiFixture();
    await api.install(context);
    await page.setViewportSize(viewport);
    await page.goto('./');
    await login(page);
    await createChat(page);
    await sendText(page, 'Длинный текст '.repeat(40));
    await expect.poll(() => api.sent.length).toBe(1);
    await expect(page.getByRole('button', { name: 'Отправить', exact: true })).toBeVisible();
    const dimensions = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, screen: window.innerWidth }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.screen);
  });
}
