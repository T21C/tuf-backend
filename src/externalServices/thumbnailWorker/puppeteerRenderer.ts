import puppeteer, {type Browser, type Page} from 'puppeteer';
import * as Sentry from '@sentry/node';
import {logger} from '@/server/services/core/LoggerService.js';

const BROWSER_LAUNCH_TIMEOUT_MS = 30_000;
const PAGE_CREATE_TIMEOUT_MS = 10_000;
const PAGE_SETUP_TIMEOUT_MS = 5_000;
const PAGE_CONTENT_TIMEOUT_MS = 30_000;
const SCREENSHOT_TIMEOUT_MS = 20_000;
const CLOSE_TIMEOUT_MS = 3_000;

class PuppeteerTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = 'PuppeteerTimeoutError';
  }
}

async function withTimeout<T>(
  operation: string,
  timeoutMs: number,
  promise: Promise<T>,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // Best-effort abort; the timeout error is the one callers handle.
      }
      reject(new PuppeteerTimeoutError(operation, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    void promise.catch(() => undefined);
  }
}

function browserMustBeDiscarded(error: unknown): boolean {
  if (error instanceof PuppeteerTimeoutError) return true;
  if (!(error instanceof Error)) return false;
  return /Protocol error|Connection closed|Target closed|Session closed/i.test(error.message);
}

export class PuppeteerRenderer {
  private browser: Browser | null = null;
  private browserCreation: Promise<Browser> | null = null;

  private async launchBrowser(): Promise<Browser> {
    // puppeteer.launch has its own timeout and owns cleanup of a partially
    // launched child. Wrapping it in Promise.race could leave a late-resolving
    // Chromium process orphaned after our timeout wins.
    const launched = await puppeteer.launch({
      headless: true,
      defaultViewport: null,
      timeout: BROWSER_LAUNCH_TIMEOUT_MS,
      args: [
          '--disable-setuid-sandbox',
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--no-first-run',
          '--no-zygote',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-breakpad',
          '--disable-default-apps',
          '--disable-domain-reliability',
          '--disable-hang-monitor',
          '--disable-notifications',
          '--disable-renderer-backgrounding',
          '--disable-speech-api',
          '--disable-sync',
          '--hide-scrollbars',
          '--ignore-certificate-errors',
          '--metrics-recording-only',
          '--mute-audio',
          '--no-default-browser-check',
          '--no-pings',
          '--password-store=basic',
          '--use-mock-keychain',
          '--window-size=1920,1080',
          '--js-flags=--max-old-space-size=512',
      ],
    });

    launched.on('disconnected', () => {
      if (this.browser === launched) this.browser = null;
      logger.warn('[thumbnail-worker] Chromium disconnected');
    });
    this.browser = launched;
    return launched;
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (!this.browserCreation) {
      this.browserCreation = this.launchBrowser().finally(() => {
        this.browserCreation = null;
      });
    }
    return this.browserCreation;
  }

  private forceKill(target: Browser, reason: string): void {
    if (this.browser === target) this.browser = null;
    const child = target.process();
    if (!child || child.killed) return;
    logger.warn(`[thumbnail-worker] killing Chromium: ${reason}`);
    child.kill('SIGKILL');
  }

  private async discardBrowser(target: Browser, reason: string): Promise<void> {
    if (this.browser === target) this.browser = null;
    try {
      await withTimeout('Puppeteer browser close', CLOSE_TIMEOUT_MS, target.close());
    } catch {
      this.forceKill(target, reason);
    }
  }

  async render(html: string, width: number, height: number): Promise<Buffer> {
    return Sentry.startSpan(
      {name: 'thumbnail_worker.render_html_to_png', op: 'ui.render'},
      async () => {
        const browser = await this.getBrowser();
        let page: Page | null = null;

        try {
          const openedPage = await withTimeout(
            'Puppeteer page creation',
            PAGE_CREATE_TIMEOUT_MS,
            browser.newPage(),
          );
          page = openedPage;
          const abortPage = () => {
            void openedPage.close().catch(() => undefined);
          };
          page.on('error', error => logger.warn('[thumbnail-worker] page error', error));
          page.on('console', message => logger.debug('[thumbnail-worker] page console', message.text()));

          await withTimeout(
            'Puppeteer JavaScript setup',
            PAGE_SETUP_TIMEOUT_MS,
            page.setJavaScriptEnabled(false),
            abortPage,
          );
          await withTimeout(
            'Puppeteer viewport setup',
            PAGE_SETUP_TIMEOUT_MS,
            page.setViewport({width, height}),
            abortPage,
          );
          await withTimeout(
            'Puppeteer HTML rendering',
            PAGE_CONTENT_TIMEOUT_MS,
            page.setContent(html, {timeout: PAGE_CONTENT_TIMEOUT_MS, waitUntil: 'load'}),
            abortPage,
          );
          const screenshot = await withTimeout(
            'Puppeteer screenshot',
            SCREENSHOT_TIMEOUT_MS,
            page.screenshot({type: 'png', omitBackground: true}),
            abortPage,
          );
          return Buffer.from(screenshot);
        } catch (error) {
          if (browserMustBeDiscarded(error)) {
            await this.discardBrowser(browser, error instanceof Error ? error.message : String(error));
          }
          throw error;
        } finally {
          if (page) {
            try {
              await withTimeout('Puppeteer page close', CLOSE_TIMEOUT_MS, page.close());
            } catch (error) {
              logger.warn('[thumbnail-worker] page close failed', error);
              await this.discardBrowser(browser, 'page close failed');
            }
          }
        }
      },
    );
  }

  async close(): Promise<void> {
    const current = this.browser;
    this.browser = null;
    if (current) await this.discardBrowser(current, 'worker shutdown');
  }
}

export const puppeteerRenderer = new PuppeteerRenderer();
