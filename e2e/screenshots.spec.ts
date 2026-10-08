import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { GreenApiFixture, createChat, incomingText, login, outgoingStatus, sendText } from './fixtures';

test.use({ colorScheme: 'light', timezoneId: 'Asia/Novosibirsk' });

test('скриншоты интерфейса с демонстрационными данными', async ({ page, context }) => {
  test.skip(process.env.PLAYWRIGHT_SCREENSHOTS !== '1', 'Включается отдельной командой, чтобы CI не менял файлы репозитория.');
  const api = new GreenApiFixture();
  await api.install(context);
  await mkdir('docs/screenshots', { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./');
  await page.getByRole('combobox', { name: 'Тема оформления', exact: true }).selectOption('light');
  await page.screenshot({ path: 'docs/screenshots/login.png', fullPage: true, animations: 'disabled' });
  await login(page);
  await createChat(page);
  await sendText(page, 'Привет, Анна! Встречаемся сегодня в 18:00?');
  await api.push(outgoingStatus(31, 'out-1', 'read'));
  await api.push(incomingText(32, 'demo-in-1', 'Привет! Да, до встречи 🙂'));
  await api.push(incomingText(33, 'demo-in-2', 'Адрес здесь: https://green-api.com/max', '10001', true));
  await expect(page.locator('[data-message-id="demo-in-2"]')).toBeVisible();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: 'docs/screenshots/desktop-chat.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 360, height: 780 });
  await page.screenshot({ path: 'docs/screenshots/mobile-chat.png', fullPage: true, animations: 'disabled' });
});

test('скриншоты зелёной и тёмной темы с демонстрационной группой', async ({ page, context }) => {
  test.skip(process.env.PLAYWRIGHT_SCREENSHOTS !== '1', 'Включается отдельной командой, чтобы CI не менял файлы репозитория.');
  const api = new GreenApiFixture();
  api.chats = [
    { chatId: '10001', name: 'Анна', type: 'user', phoneNumber: 79991234567 },
    { chatId: '-10003', name: 'Команда проекта', type: 'group', phoneNumber: 0 },
    { chatId: '-10004', name: 'Новости проекта', type: 'channel', phoneNumber: 0 },
    { chatId: '10005', name: 'Помощник проекта', type: 'bot', phoneNumber: 0 },
  ];
  const timestamp = Date.UTC(2026, 9, 8, 10, 42) / 1000;
  api.chatHistory.set('-10003', [
    { type: 'incoming', idMessage: 'demo-group-1', timestamp, typeMessage: 'textMessage', chatId: '-10003',
      chatType: 'group', textMessage: 'Всем привет! Соберёмся сегодня в 18:00?', senderId: '10001', senderName: 'Анна' },
    { type: 'outgoing', idMessage: 'demo-group-2', timestamp: timestamp + 60, typeMessage: 'textMessage', chatId: '-10003',
      chatType: 'group', textMessage: 'Да, буду. План обсуждения уже готов.', statusMessage: 'read' },
    { type: 'incoming', idMessage: 'demo-group-3', timestamp: timestamp + 120, typeMessage: 'extendedTextMessage',
      chatId: '-10003', chatType: 'group', textMessage: 'Отлично! Ссылка на материалы: https://green-api.com/max',
      senderId: '10002', senderName: 'Михаил' },
  ]);
  await api.install(context);
  await mkdir('docs/screenshots', { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./');
  await login(page);
  await page.locator('[data-chat-id="-10003"]').click();
  await expect(page.locator('[data-message-id="demo-group-3"]')).toBeVisible();
  await expect(page.locator('[data-message-id="demo-group-1"] .message-author')).toHaveText('Анна');
  await expect(page.locator('[data-message-id="demo-group-3"] .message-author')).toHaveText('Михаил');
  await page.mouse.move(0, 0);
  for (const theme of ['green', 'dark']) {
    await page.getByRole('combobox', { name: 'Тема оформления', exact: true }).selectOption(theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.screenshot({ path: `docs/screenshots/desktop-chat-${theme}.png`, fullPage: true, animations: 'disabled' });
  }
  expect(api.sent).toHaveLength(0);
});
