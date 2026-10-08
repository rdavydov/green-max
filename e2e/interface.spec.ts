import { expect, test, type Page } from '@playwright/test';
import { GreenApiFixture, createChat, incomingText, login, sendText } from './fixtures';

const viewports = [{ width: 1440, height: 900 }, { width: 360, height: 780 }];

async function backToList(page: Page, width: number) {
  if (width < 768) await page.getByRole('button', { name: 'Назад к чатам', exact: true }).click();
}

async function expectNoOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, screen: innerWidth }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.screen);
}

for (const viewport of viewports) {
  test(`четыре темы, системная настройка и сохранение выбора при ${viewport.width}×${viewport.height}`, async ({ page, context }) => {
    const api = new GreenApiFixture();
    await api.install(context);
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('./');
    const selector = page.getByRole('combobox', { name: 'Тема оформления', exact: true });
    await expect(selector).toHaveValue('system');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    for (const theme of ['light', 'green', 'dark']) {
      await selector.selectOption(theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expectNoOverflow(page);
      await page.reload();
      await expect(selector).toHaveValue(theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    }
    await selector.selectOption('green');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'green');
    await login(page);
    await expect(page.getByRole('combobox', { name: 'Тема оформления', exact: true })).toHaveValue('green');
    await createChat(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'green');
    await expectNoOverflow(page);
    await backToList(page, viewport.width);
    await page.getByRole('combobox', { name: 'Тема оформления', exact: true }).selectOption('system');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'Выйти', exact: true }).click();
    await expect(selector).toHaveValue('system');
    await page.reload();
    await expect(selector).toHaveValue('system');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test(`группы, каналы и боты: история, уведомления и отправка при ${viewport.width}×${viewport.height}`, async ({ page, context }) => {
    const api = new GreenApiFixture();
    api.chats = [
      { chatId: '-10003', name: 'Команда проекта', type: 'group', phoneNumber: 0 },
      { chatId: '-10004', name: 'Новости проекта', type: 'channel', phoneNumber: 0 },
      { chatId: '10005', name: 'Помощник проекта', type: 'bot', phoneNumber: 0 },
    ];
    const timestamp = Math.floor(Date.now() / 1000) - 60;
    api.chatHistory.set('-10003', [{ type: 'incoming', idMessage: 'group-history', timestamp,
      typeMessage: 'textMessage', chatId: '-10003', chatType: 'group', textMessage: 'Старое сообщение группы',
      senderId: '10001', senderName: 'Анна' }]);
    api.chatHistory.set('-10004', [{ type: 'incoming', idMessage: 'channel-history', timestamp,
      typeMessage: 'extendedTextMessage', chatId: '-10004', chatType: 'channel',
      extendedTextMessage: { text: 'Новость https://example.org' } }]);
    api.chatHistory.set('10005', [{ type: 'incoming', idMessage: 'bot-history', timestamp,
      typeMessage: 'textMessage', chatId: '10005', chatType: 'bot', textMessage: 'Здравствуйте! Чем помочь?' }]);
    await api.install(context);
    await page.setViewportSize(viewport);
    await page.goto('./');
    await login(page);
    await expect(page.locator('[data-chat-id="-10003"]')).toContainText('Группа');
    await expect(page.locator('[data-chat-id="-10004"]')).toContainText('Канал');
    await expect(page.locator('[data-chat-id="10005"]')).toContainText('Бот');
    await page.locator('[data-chat-id="-10003"]').click();
    await expect(page.locator('[data-message-id="group-history"]')).toContainText('Старое сообщение группы');
    await expect(page.locator('[data-message-id="group-history"] .message-author')).toContainText('Анна');
    await sendText(page, 'Сообщение участникам группы');
    await expect.poll(() => api.sent.length).toBe(1);
    expect(api.sent[0]).toMatchObject({ chatId: '-10003', message: 'Сообщение участникам группы' });
    await api.push(incomingText(201, 'group-live', 'Ответ участника', '-10003', false,
      { type: 'group', name: 'Команда проекта', senderName: 'Михаил', senderId: '10002' }));
    await expect(page.locator('[data-message-id="group-live"]')).toContainText('Ответ участника');
    await expect(page.locator('[data-message-id="group-live"] .message-author')).toContainText('Михаил');
    await backToList(page, viewport.width);
    await page.locator('[data-chat-id="10005"]').click();
    await expect(page.locator('[data-message-id="bot-history"]')).toContainText('Здравствуйте! Чем помочь?');
    await sendText(page, 'Команда для бота');
    await expect.poll(() => api.sent.length).toBe(2);
    expect(api.sent[1]).toMatchObject({ chatId: '10005', message: 'Команда для бота' });
    await backToList(page, viewport.width);
    await page.locator('[data-chat-id="-10004"]').click();
    await expect(page.locator('[data-message-id="channel-history"]')).toContainText('Новость https://example.org');
    await expect(page.getByText('Канал доступен только для чтения', { exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toHaveCount(0);
    await expectNoOverflow(page);
    await backToList(page, viewport.width);
    await api.push(incomingText(202, 'new-group-message', 'Первое сообщение новой группы', '-10006', false,
      { type: 'group', name: 'Новая группа', senderName: 'Елена', senderId: '10007' }));
    await api.push(incomingText(203, 'new-bot-message', 'Ответ нового бота', '10008', false,
      { type: 'bot', name: 'Новый бот' }));
    await api.push(incomingText(204, 'new-channel-message', 'Публикация нового канала', '-10009', true,
      { type: 'channel', name: 'Новый канал' }));
    await expect.poll(() => api.deleted.includes(204)).toBe(true);
    for (const id of ['-10006', '10008', '-10009']) await expect(page.locator(`[data-chat-id="${id}"]`)).toBeVisible();
    await page.locator('[data-chat-id="-10006"]').click();
    await expect(page.locator('[data-message-id="new-group-message"]')).toContainText('Первое сообщение новой группы');
    await expect(page.locator('[data-message-id="new-group-message"] .message-author')).toContainText('Елена');
    const sendsBeforeReload = api.sent.length;
    await page.reload();
    await login(page);
    await page.locator('[data-chat-id="-10006"]').click();
    await expect(page.locator('[data-message-id="new-group-message"]')).toHaveCount(1);
    expect(api.sent).toHaveLength(sendsBeforeReload);
    await expectNoOverflow(page);
  });

  test(`уведомления закрываются в списке и переписке при ${viewport.width}×${viewport.height}`, async ({ page, context }) => {
    const api = new GreenApiFixture();
    api.settings.outgoingWebhook = 'no';
    api.settings.outgoingAPIMessageWebhook = 'no';
    await api.install(context);
    await page.setViewportSize(viewport);
    await page.goto('./');
    await login(page);
    await expect(page.locator('[data-notice="settings"]')).toBeVisible();
    await page.getByRole('button', { name: 'Скрыть уведомление', exact: true }).click();
    await expect(page.locator('[data-notice="settings"]')).toHaveCount(0);
    await createChat(page);
    await expect(page.locator('[data-notice="settings"]')).toHaveCount(0);
    api.failNextSend = true;
    await sendText(page, 'Черновик после ошибки');
    const error = page.locator('.error-banner');
    await expect(error).toBeVisible();
    await page.getByRole('button', { name: 'Скрыть ошибку', exact: true }).click();
    await expect(error).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toHaveValue('Черновик после ошибки');
    await api.failPendingReceive();
    const connection = page.locator('[data-notice="connection"]');
    const summary = page.locator('[data-notice="connection-summary"]');
    await expect(connection).toBeVisible();
    await page.getByRole('button', { name: 'Свернуть уведомление', exact: true }).click();
    await expect(connection).toHaveCount(0);
    await expect(summary).toBeVisible();
    await expect(summary.getByRole('button', { name: 'Повторить', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Развернуть уведомление', exact: true }).click();
    await expect(connection).toBeVisible();
    await expect(summary).toHaveCount(0);
    await page.getByRole('button', { name: 'Свернуть уведомление', exact: true }).click();
    await backToList(page, viewport.width);
    await expect(page.locator('.sidebar-footer').getByRole('button', { name: 'Повторить', exact: true })).toBeVisible();
    await expect(connection).toHaveCount(0);
    await expect(summary).toBeVisible();
    await page.locator('[data-chat-id="10001"]').click();
    await expect(connection).toHaveCount(0);
    await expect(summary).toBeVisible();
    await backToList(page, viewport.width);
    await page.getByRole('button', { name: 'Выйти', exact: true }).click();
    await login(page);
    await expect(page.locator('[data-notice="settings"]')).toBeVisible();
  });
}
