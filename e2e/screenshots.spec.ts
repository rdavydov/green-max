import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { GreenApiFixture, createChat, incomingText, login, outgoingStatus, sendText } from './fixtures';

test('скриншоты интерфейса с демонстрационными данными', async ({ page, context }) => {
  test.skip(process.env.PLAYWRIGHT_SCREENSHOTS !== '1', 'Включается отдельной командой, чтобы CI не менял файлы репозитория.');
  const api = new GreenApiFixture();
  await api.install(context);
  await mkdir('docs/screenshots', { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./');
  await page.screenshot({ path: 'docs/screenshots/login.png', fullPage: true });
  await login(page);
  await createChat(page);
  await sendText(page, 'Привет, Анна! Встречаемся сегодня в 18:00?');
  await api.push(outgoingStatus(31, 'out-1', 'read'));
  await api.push(incomingText(32, 'demo-in-1', 'Привет! Да, до встречи 🙂'));
  await api.push(incomingText(33, 'demo-in-2', 'Адрес здесь: https://green-api.com/max', '10001', true));
  await expect(page.locator('[data-message-id="demo-in-2"]')).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/desktop-chat.png', fullPage: true });
  await page.setViewportSize({ width: 360, height: 780 });
  await page.screenshot({ path: 'docs/screenshots/mobile-chat.png', fullPage: true });
});
