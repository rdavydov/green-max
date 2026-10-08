import { expect, type BrowserContext, type Page, type Request, type Route } from '@playwright/test';

export const credentials = { idInstance: '3100000001', apiTokenInstance: 'test-only-token' };
export const phones = { first: '+7 999 123-45-67', second: '+7 999 765-43-21' };

interface Notification {
  receiptId: number;
  body: Record<string, unknown>;
}

export function incomingText(
  receiptId: number,
  idMessage: string,
  text: string,
  chatId = '10001',
  withUrl = false,
): Notification {
  return {
    receiptId,
    body: {
      typeWebhook: 'incomingMessageReceived',
      instanceData: { idInstance: 3100000001, wid: '79990000000@c.us', typeInstance: 'v3' },
      timestamp: Math.ceil(Date.now() / 1000) + 1,
      idMessage,
      senderData: {
        chatId,
        chatName: chatId === '10001' ? 'Анна' : 'Михаил',
        chatType: 'user',
        sender: chatId,
        senderName: chatId === '10001' ? 'Анна' : 'Михаил',
        senderType: 'user',
        senderContactName: '',
        senderPhoneNumber: chatId === '10001' ? 79991234567 : 79997654321,
      },
      messageData: withUrl
        ? { typeMessage: 'extendedTextMessage', extendedTextMessageData: { text } }
        : { typeMessage: 'textMessage', textMessageData: { textMessage: text } },
    },
  };
}

export function outgoingStatus(receiptId: number, idMessage: string, status: 'sent' | 'delivered' | 'read'): Notification {
  return {
    receiptId,
    body: {
      typeWebhook: 'outgoingMessageStatus',
      instanceData: { idInstance: 3100000001, wid: '79990000000@c.us', typeInstance: 'v3' },
      timestamp: Math.ceil(Date.now() / 1000) + 1,
      idMessage,
      chatId: '10001',
      status,
    },
  };
}

/** The pending receive stays unresolved until a notification is explicitly released. */
export class GreenApiFixture {
  readonly sent: { chatId: string; message: string; idMessage: string }[] = [];
  readonly deleted: number[] = [];
  readonly requests: { action: string; method: string }[] = [];
  chats: Record<string, unknown>[] = [];
  readonly chatHistory = new Map<string, Record<string, unknown>[]>();
  account = { chatId: '999', phone: '79990000000', stateInstance: 'authorized' };
  checkAccountDelayMs = 0;
  failNextSend = false;
  holdDeletes = false;
  maxPendingReceives = 0;
  private queue: Notification[] = [];
  private pending = new Map<Request, Route>();
  private unacknowledged: Notification | undefined;
  private pendingDeletes: Route[] = [];

  async install(context: BrowserContext) {
    context.on('requestfailed', (request) => this.pending.delete(request));
    await context.route(/https:\/\/(?:[\w-]+\.)?api\.green-api\.com\/v3\//, async (route) => {
      const request = route.request();
      const action = new URL(request.url()).pathname.split('/')[3]?.toLowerCase() ?? '';
      if (request.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: this.headers() });
        return;
      }
      this.requests.push({ action, method: request.method() });
      switch (action) {
        case 'getstateinstance':
          await this.json(route, { stateInstance: 'authorized' });
          break;
        case 'getsettings':
          await this.json(route, {
            typeInstance: 'v3',
            incomingWebhook: 'yes',
            outgoingWebhook: 'yes',
            outgoingAPIMessageWebhook: 'yes',
            outgoingMessageWebhook: 'yes',
            webhookUrl: '',
          });
          break;
        case 'getaccountsettings':
          await this.json(route, this.account);
          break;
        case 'getchats':
          await this.json(route, this.chats);
          break;
        case 'getchathistory': {
          const { chatId } = request.postDataJSON() as { chatId: string };
          await this.json(route, this.chatHistory.get(chatId) ?? []);
          break;
        }
        case 'checkaccount': {
          const { phoneNumber } = request.postDataJSON() as { phoneNumber: number | string };
          if (this.checkAccountDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, this.checkAccountDelayMs));
          }
          await this.json(route, { exist: true, chatId: String(phoneNumber).endsWith('54321') ? '10002' : '10001' });
          break;
        }
        case 'sendmessage': {
          if (this.failNextSend) {
            this.failNextSend = false;
            await route.abort('failed');
            break;
          }
          const body = request.postDataJSON() as { chatId: string; message: string };
          const idMessage = `out-${this.sent.length + 1}`;
          this.sent.push({ ...body, idMessage });
          await this.json(route, { idMessage });
          break;
        }
        case 'receivenotification':
          this.pending.set(request, route);
          this.maxPendingReceives = Math.max(this.maxPendingReceives, this.pending.size);
          await this.deliver();
          break;
        case 'deletenotification': {
          const receiptId = Number(new URL(request.url()).pathname.split('/').at(-1));
          this.deleted.push(receiptId);
          if (this.holdDeletes) {
            this.pendingDeletes.push(route);
            break;
          }
          const matches = this.unacknowledged?.receiptId === receiptId;
          if (matches) this.unacknowledged = undefined;
          await this.json(route, { result: matches, reason: matches ? '' : 'Already deleted' });
          break;
        }
        default:
          await this.json(route, { error: `Unexpected fixture method: ${action}` }, 500);
      }
    });
  }

  async push(notification: Notification) {
    this.queue.push(notification);
    await this.deliver();
  }

  async waitForPoll() {
    await expect.poll(() => this.pending.size).toBe(1);
  }

  get pendingReceives() {
    return this.pending.size;
  }

  async releaseDeletes() {
    this.holdDeletes = false;
    this.unacknowledged = undefined;
    const routes = this.pendingDeletes.splice(0);
    await Promise.all(routes.map((route) => this.json(route, { result: true, reason: '' }).catch(() => undefined)));
  }

  private async deliver() {
    if (!this.pending.size) return;
    this.unacknowledged ??= this.queue.shift();
    if (!this.unacknowledged) return;
    const [request, route] = this.pending.entries().next().value as [Request, Route];
    this.pending.delete(request);
    await this.json(route, this.unacknowledged).catch(() => undefined);
  }

  private headers() {
    return {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-headers': 'Content-Type',
    };
  }

  private async json(route: Route, value: unknown, status = 200) {
    await route.fulfill({ status, contentType: 'application/json', headers: this.headers(), body: JSON.stringify(value) });
  }
}

export async function login(page: Page, idInstance = credentials.idInstance) {
  await page.getByLabel('idInstance', { exact: true }).fill(idInstance);
  await page.getByLabel('apiTokenInstance', { exact: true }).fill(credentials.apiTokenInstance);
  await page.getByRole('button', { name: 'Подключиться', exact: true }).click();
}

export async function createChat(page: Page, phone = phones.first) {
  await page.getByRole('button', { name: 'Новый чат', exact: true }).click();
  await page.getByLabel('Номер телефона', { exact: true }).fill(phone);
  await page.getByRole('button', { name: 'Создать чат', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Новый чат', exact: true })).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toBeVisible();
}

export async function sendText(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
}
