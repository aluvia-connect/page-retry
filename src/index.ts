import type { Page as PlaywrightPage } from "playwright";
import puppeteer, { Page as PuppeteerPage } from "puppeteer";
import * as playwright from "playwright";
import Aluvia from "aluvia-ts-sdk";

// --- Adapter Interfaces ---
export interface CompatPage {
  goto(url: string, options?: any): Promise<any>;
  url(): string;
  title(): Promise<string>;
  close(): Promise<void>;
  context?(): CompatContext;
  [key: string]: any;
}
export interface CompatBrowser {
  newPage(): Promise<CompatPage>;
  close(): Promise<void>;
  [key: string]: any;
}
export interface CompatContext {
  browser(): CompatBrowser;
  [key: string]: any;
}

// --- Playwright Adapter ---
export function playwrightPageAdapter(page: PlaywrightPage): CompatPage {
  return {
    goto: page.goto.bind(page),
    url: page.url.bind(page),
    title: page.title.bind(page),
    close: page.close.bind(page),
    context: () => playwrightContextAdapter(page.context()),
    [Symbol.for("aluvia.gotoOriginal")]: page.goto.bind(page),
    _raw: page,
  };
}
function playwrightContextAdapter(context: any): CompatContext {
  return {
    browser: () => playwrightBrowserAdapter(context.browser()),
    _raw: context,
  };
}
function playwrightBrowserAdapter(browser: any): CompatBrowser {
  return {
    newPage: async () => playwrightPageAdapter(await browser.newPage()),
    close: browser.close.bind(browser),
    _raw: browser,
  };
}

// --- Puppeteer Adapter ---
export function puppeteerPageAdapter(page: PuppeteerPage): CompatPage {
  return {
    goto: page.goto.bind(page),
    url: page.url.bind(page),
    title: page.title.bind(page),
    close: page.close.bind(page),
    context: () => puppeteerContextAdapter(page.browser()),
    [Symbol.for("aluvia.gotoOriginal")]: page.goto.bind(page),
    _raw: page,
  };
}
function puppeteerContextAdapter(browser: any): CompatContext {
  return {
    browser: () => puppeteerBrowserAdapter(browser),
    _raw: browser,
  };
}
function puppeteerBrowserAdapter(browser: any): CompatBrowser {
  return {
    newPage: async () => puppeteerPageAdapter(await browser.newPage()),
    close: browser.close.bind(browser),
    _raw: browser,
  };
}

// --- Shared Types ---
export type RetryPattern = string | RegExp;
export type ProxySettings = { server: string; username?: string; password?: string; };
export interface ProxyProvider { get(): Promise<ProxySettings>; }
export interface RetryWithProxyOptions {
  /**
   * Number of retry attempts after the first failed navigation.
   *
   * The first `page.goto()` is always attempted without a proxy.
   * If it fails with a retryable error (as defined by `retryOn`),
   * the helper will fetch a new proxy and relaunch the browser.
   *
   * @default process.env.ALUVIA_MAX_RETRIES || 1
   * @example
   * // Try up to 3 proxy relaunches after the first failure
   * { maxRetries: 3 }
   */
  maxRetries?: number;

  /**
   * Base delay (in milliseconds) for exponential backoff between retries.
   *
   * Each retry waits `backoffMs * 2^attempt + random(0–100)` before continuing.
   * Useful to avoid hammering proxy endpoints or triggering rate limits.
   *
   * @default process.env.ALUVIA_BACKOFF_MS || 300
   * @example
   * // Start with 500ms and double each time (with jitter)
   * { backoffMs: 500 }
   */
  backoffMs?: number;

  /**
   * List of error patterns that are considered retryable.
   *
   * A pattern can be a string or a regular expression. When a navigation error’s
   * message, name, or code matches any of these, the helper will trigger a retry.
   *
   * @default process.env.ALUVIA_RETRY_ON
   *          or ["ECONNRESET", "ETIMEDOUT", "net::ERR", "Timeout"]
   * @example
   * // Retry on connection resets and 403 responses
   * { retryOn: ["ECONNRESET", /403/] }
   */
  retryOn?: RetryPattern[];

  /**
   * Whether to close the old browser instance when relaunching with a new proxy.
   *
   * Set to `true` (default) to prevent multiple browsers from staying open,
   * which is safer for most workflows. Set to `false` if you manage browser
   * lifecycles manually or reuse a shared browser across tasks.
   *
   * @default true
   * @example
   * // Keep old browser open (you must close it yourself)
   * { closeOldBrowser: false }
   */
  closeOldBrowser?: boolean;

  /**
   * Optional custom proxy provider used to fetch proxy credentials.
   *
   * By default, `retryWithProxy` automatically uses the Aluvia API
   * via the `aluvia-ts-sdk` and reads the API key from
   * `process.env.ALUVIA_API_KEY`.
   *
   * Supplying your own `proxyProvider` allows you to integrate with
   * any proxy rotation service, database, or in-house pool instead.
   *
   * A proxy provider must expose a `get()` method that returns a
   * `Promise<ProxySettings>` object with `server`, and optionally
   * `username` and `password` fields.
   *
   * @default Uses the built-in Aluvia client with `process.env.ALUVIA_API_KEY`
   * @example
   * ```ts
   * import { retryWithProxy } from "playwright-proxied";
   *
   * // Custom proxy provider example
   * const myProxyProvider = {
   *   async get() {
   *     // Pull from your own proxy pool or API
   *     return {
   *       server: "http://myproxy.example.com:8000",
   *       username: "user123",
   *       password: "secret",
   *     };
   *   },
   * };
   *
   * const { response, page } = await retryWithProxy(page, {
   *   proxyProvider: myProxyProvider,
   *   maxRetries: 3,
   * });
   * ```
   */
  proxyProvider?: ProxyProvider;
}

export interface RetryWithProxyRunner {
  goto(url: string, options?: any): Promise<{ response: any; page: CompatPage }>;
}

// --- Env Defaults ---
const DEFAULT_GOTO_TIMEOUT_MS = 15_000;
const ENV_MAX_RETRIES = Math.max(0, parseInt(process.env.ALUVIA_MAX_RETRIES || "1", 10));
const ENV_BACKOFF_MS  = Math.max(0, parseInt(process.env.ALUVIA_BACKOFF_MS  || "300", 10));
const ENV_RETRY_ON = (
  process.env.ALUVIA_RETRY_ON ?? "ECONNRESET,ETIMEDOUT,net::ERR,Timeout"
).split(",").map((value) => value.trim()).filter(Boolean);
const DEFAULT_RETRY_PATTERNS: (string | RegExp)[] = ENV_RETRY_ON.map((value) =>
  value.startsWith("/") && value.endsWith("/") ? new RegExp(value.slice(1, -1)) : value
);

// --- Aluvia Proxy ---
let aluviaClient: Aluvia | undefined;
async function getAluviaProxy(): Promise<ProxySettings> {
  const apiKey = process.env.ALUVIA_API_KEY || "";
  if (!apiKey) throw new Error("ALUVIA_API_KEY environment variable is required to fetch proxies.");
  aluviaClient ??= new Aluvia(apiKey);
  const proxy = await aluviaClient.first();
  if (!proxy) throw new Error("Failed to get proxy from Aluvia");
  return {
    server: `http://${proxy.host}:${proxy.httpPort}`,
    username: proxy.username,
    password: proxy.password,
  };
}

// --- Retry Logic ---
function backoffDelay(base: number, attempt: number) {
  const jitter = Math.random() * 100;
  return base * Math.pow(2, attempt) + jitter;
}
function compileRetryable(patterns: (string | RegExp)[] = DEFAULT_RETRY_PATTERNS) {
  return (err: unknown) => {
    if (!err) return false;
    const msg = String((err as any)?.message ?? (err as any) ?? "");
    const code = String((err as any)?.code ?? "");
    const name = String((err as any)?.name ?? "");
    return patterns.some((p) =>
      p instanceof RegExp
        ? p.test(msg) || p.test(code) || p.test(name)
        : msg.includes(p) || code.includes(p) || name.includes(p)
    );
  };
}

// --- Inference Helpers (for Playwright/Puppeteer) ---
function inferBrowserTypeFromPage(page: PlaywrightPage | PuppeteerPage): string {
  // --- Detect Playwright ---
  // Playwright pages have `context()` and `context().browser()`
  if ("context" in page && typeof page.context === "function") {
    const browser = (page as PlaywrightPage).context().browser();
    const name =
      (browser as any)?._name ||
      (browser as any)?.browserType?._name;
    if (name) return name.toLowerCase(); // "chromium", "firefox", or "webkit"
    return "chromium";
  }

  // --- Detect Puppeteer ---
  // Puppeteer pages have `browser()` directly
  if ("browser" in page && typeof page.browser === "function") {
    return "puppeteer";
  }

  throw new Error(
    "Cannot infer BrowserType from page. Provide relaunch logic or adapter."
  );
}

async function inferContextDefaults(page: CompatPage): Promise<any> {
  // Playwright: context._options
  // Puppeteer: not available, return {}
  return page.context?.()._raw?._options ?? {};
}
function inferLaunchDefaults(page: CompatPage): any {
  // Playwright: browser._options
  // Puppeteer: not available, return {}
  return page.context?.().browser()._raw?._options ?? {};
}

// --- Relaunch With Proxy ---
async function relaunchWithProxy(
  proxy: ProxySettings,
  oldPage: CompatPage,
  closeOldBrowser: boolean = true
): Promise<{ browser: any; page: CompatPage }> {
  const raw = (oldPage as any)._raw;
  const browserTypeName = inferBrowserTypeFromPage(raw);

  // --- Puppeteer logic ---
  if (browserTypeName === "puppeteer") {
    try {
      if (closeOldBrowser) {
        try {
          const oldBrowser = await raw.browser();
          await oldBrowser?.close().catch(() => {});
        } catch {}
      }

      // Get old browser and infer headless mode
      const oldBrowser = await raw.browser();
      const inferredHeadless = !oldBrowser?.process();
      const args = [
        ...(proxy?.server ? [`--proxy-server=${proxy.server}`] : []),
        '--window-size=1280,720',
      ];

      const browser = await puppeteer.launch({
        headless: inferredHeadless,
        args,
        defaultViewport: {
          width: 1280,
          height: 720,
          deviceScaleFactor: 1,
        },
      });

      const page = await browser.newPage();

      if (proxy?.username && proxy?.password) {
        await page.authenticate({
          username: proxy.username,
          password: proxy.password,
        });
      }

      return { browser, page: puppeteerPageAdapter(page) };
    } catch (err) {
      throw new Error(`Failed to relaunch Puppeteer with proxy: ${err}`);
    }
  }

  // --- Playwright logic ---
  try {
    const browserType = (playwright as any)[browserTypeName];
    if (!browserType) {
      throw new Error(`Unknown Playwright browser type: ${browserTypeName}`);
    }

    const launchDefaults = inferLaunchDefaults(oldPage);
    const contextDefaults = await inferContextDefaults(oldPage);

    if (closeOldBrowser) {
      const oldBrowser = oldPage.context?.().browser();
      try {
        await oldBrowser?.close();
      } catch {}
    }

    const retryLaunch = {
      ...launchDefaults,
      proxy: proxy?.server
        ? {
            server: proxy.server,
            username: proxy.username,
            password: proxy.password,
          }
        : undefined,
    };

    const browser = await browserType.launch(retryLaunch);
    const context = await browser.newContext(contextDefaults);

    if (proxy?.username && proxy?.password) {
      await context.setHTTPCredentials({
        username: proxy.username,
        password: proxy.password,
      });
    }

    const page = await context.newPage();
    return { browser, page: playwrightPageAdapter(page) };
  } catch (e) {
    throw new Error(`Failed to relaunch Playwright with proxy: ${e}`);
  }
}

// --- Main Export ---
const GOTO_ORIGINAL = Symbol.for("aluvia.gotoOriginal");
export function retryWithProxy(
  page: CompatPage,
  options?: RetryWithProxyOptions
): RetryWithProxyRunner {
  const {
    maxRetries = ENV_MAX_RETRIES,
    backoffMs = ENV_BACKOFF_MS,
    retryOn = DEFAULT_RETRY_PATTERNS,
    closeOldBrowser = true,
    proxyProvider,
  } = options ?? {};

  const isRetryable = compileRetryable(retryOn);
  const getRawGoto = (p: CompatPage) =>
    ((p as any)[GOTO_ORIGINAL]?.bind(p) ?? p.goto.bind(p));

  return {
    async goto(url: string, gotoOptions?: any) {
      const run = async () => {
        let basePage: CompatPage = page;
        let lastErr: unknown;

        // First attempt without proxy
        try {
          const response = await getRawGoto(basePage)(url, {
            ...(gotoOptions ?? {}),
            timeout: gotoOptions?.timeout ?? DEFAULT_GOTO_TIMEOUT_MS,
            waitUntil: gotoOptions?.waitUntil ?? "domcontentloaded",
          });
          return { response: response ?? null, page: basePage };
        } catch (err) {
          lastErr = err;
          if (!isRetryable(err)) throw err;
        }

        // Retries with proxy
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          if (backoffMs > 0) {
            const delay = backoffDelay(backoffMs, attempt);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }

          const proxy = await (proxyProvider?.get() ?? getAluviaProxy()).catch(
            (err) => {
              lastErr = err;
              return undefined;
            }
          );
          if (!proxy) continue;

          try {
            const { page: newPage } = await relaunchWithProxy(
              proxy,
              basePage,
              closeOldBrowser
            );
            try {
              const response = await getRawGoto(newPage)(url, {
                ...(gotoOptions ?? {}),
                timeout: gotoOptions?.timeout ?? DEFAULT_GOTO_TIMEOUT_MS,
                waitUntil: gotoOptions?.waitUntil ?? "domcontentloaded",
              });
              try {
                await newPage._raw?.waitForFunction?.(
                  () => typeof document !== "undefined" && !!document.title?.trim(),
                  { timeout: DEFAULT_GOTO_TIMEOUT_MS }
                );
              } catch {}
              return { response: response ?? null, page: newPage };
            } catch (err) {
              basePage = newPage;
              lastErr = err;
              continue;
            }
          } catch (err) {
            lastErr = err;
            continue;
          }
        }

        if (lastErr instanceof Error) throw lastErr;
        throw new Error(lastErr ? String(lastErr) : "Navigation failed");
      };
      return run();
    },
  };
}