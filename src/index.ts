import type {
  Browser,
  BrowserContextOptions,
  BrowserType,
  LaunchOptions,
  Page,
  Response,
} from "playwright";
import Aluvia from "aluvia-ts-sdk";

const DEFAULT_GOTO_TIMEOUT_MS = 15_000;

const ENV_MAX_RETRIES = Math.max(0, parseInt(process.env.ALUVIA_MAX_RETRIES || "1", 10)); // prettier-ignore
const ENV_BACKOFF_MS  = Math.max(0, parseInt(process.env.ALUVIA_BACKOFF_MS  || "300", 10)); // prettier-ignore
const ENV_RETRY_ON = (
  process.env.ALUVIA_RETRY_ON ?? "ECONNRESET,ETIMEDOUT,net::ERR,Timeout"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

/* Pre-compile retry patterns for performance & correctness */
const DEFAULT_RETRY_PATTERNS: (string | RegExp)[] = ENV_RETRY_ON.map((value) =>
  value.startsWith("/") && value.endsWith("/")
    ? new RegExp(value.slice(1, -1))
    : value
);

export type RetryPattern = string | RegExp;

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
}

type GoToOptions = NonNullable<Parameters<Page["goto"]>[1]>;

export interface RetryWithProxyRunner {
  goto(
    url: string,
    options?: GoToOptions
  ): Promise<{ response: Response | null; page: Page }>;
}

export type ProxySettings = {
  server: string;
  username?: string;
  password?: string;
};

let aluviaClient: Aluvia | undefined;

async function getAluviaProxy(): Promise<ProxySettings> {
  const apiKey = process.env.ALUVIA_API_KEY || "";
  if (!apiKey) {
    throw new Error(
      "ALUVIA_API_KEY environment variable is required to fetch proxies."
    );
  }
  aluviaClient ??= new Aluvia(apiKey);
  const proxy = await aluviaClient.first();
  if (!proxy) throw new Error("Failed to get proxy from Aluvia");
  return {
    server: `http://${proxy.host}:${proxy.httpPort}`,
    username: proxy.username,
    password: proxy.password,
  };
}

function backoffDelay(base: number, attempt: number) {
  // exponential + jitter
  const jitter = Math.random() * 100;
  return base * Math.pow(2, attempt) + jitter;
}

function compileRetryable(
  patterns: (string | RegExp)[] = DEFAULT_RETRY_PATTERNS
): (err: unknown) => boolean {
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

function inferBrowserTypeFromPage(page: Page): BrowserType<Browser> {
  const browser = page.context().browser();
  const browserType = (browser as any)?.browserType?.();
  if (!browserType) {
    throw new Error("Cannot infer BrowserType from page");
  }

  return browserType as BrowserType<Browser>;
}

async function inferContextDefaults(
  page: Page
): Promise<BrowserContextOptions> {
  const ctx = page.context();
  const vp = page.viewportSize();
  const ua = await page
    .evaluate(() => navigator.userAgent)
    .catch(() => undefined);
  const storage = await ctx.storageState().catch(() => undefined);

  return {
    storageState: storage,
    userAgent: ua,
    viewport: vp ?? undefined,
  };
}

function inferLaunchDefaults(page: Page): LaunchOptions {
  const browser = page.context().browser();
  const isHeadless =
    browser && typeof (browser as any)._isHeadless === "boolean"
      ? (browser as any)._isHeadless
      : true; // fallback

  return {
    headless: isHeadless,
  };
}

async function relaunchWithProxy(
  proxy: ProxySettings,
  oldPage: Page,
  closeOldBrowser: boolean = true
): Promise<{ page: Page }> {
  const browserType = inferBrowserTypeFromPage(oldPage);
  const launchDefaults = inferLaunchDefaults(oldPage);
  const contextDefaults = await inferContextDefaults(oldPage);

  if (closeOldBrowser) {
    const oldBrowser = oldPage.context().browser();
    try {
      await oldBrowser?.close();
    } catch {}
  }

  const retryLaunch: LaunchOptions = {
    headless: launchDefaults.headless ?? true,
    ...launchDefaults,
    proxy,
  };

  const browser = await browserType.launch(retryLaunch);
  const context = await browser.newContext(contextDefaults);

  const page = await context.newPage();
  return { page };
}

const GOTO_ORIGINAL = Symbol.for("aluvia.gotoOriginal");

export function retryWithProxy(
  page: Page,
  options?: RetryWithProxyOptions
): RetryWithProxyRunner {
  const {
    maxRetries = ENV_MAX_RETRIES,
    backoffMs = ENV_BACKOFF_MS,
    retryOn = DEFAULT_RETRY_PATTERNS,
    closeOldBrowser = true,
  } = options ?? {};

  const isRetryable = compileRetryable(retryOn);

  /** Prefer unpatched goto to avoid recursion */
  const getRawGoto = (p: Page) =>
    ((p as any)[GOTO_ORIGINAL]?.bind(p) ?? p.goto.bind(p)) as Page["goto"];

  return {
    async goto(url: string, gotoOptions?: GoToOptions) {
      const run = async () => {
        let basePage: Page = page;
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

          const proxy = await getAluviaProxy().catch((err) => {
            lastErr = err;
            return undefined;
          });

          if (!proxy) {
            // transient proxy issue; try next loop iteration
            continue;
          }

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

              // non-fatal readiness gate
              try {
                await newPage.waitForFunction(
                  () =>
                    typeof document !== "undefined" && !!document.title?.trim(),
                  { timeout: DEFAULT_GOTO_TIMEOUT_MS }
                );
              } catch {}

              return {
                response: response ?? null,
                page: newPage,
              };
            } catch (err) {
              // navigation on the new page failed — carry this page forward
              basePage = newPage;
              lastErr = err;

              // next loop iteration will close this browser (since we pass basePage)
              continue;
            }
          } catch (err) {
            // relaunch itself failed (no new page created)
            lastErr = err;
            continue;
          }
        }

        if (lastErr instanceof Error) {
          throw lastErr;
        }

        throw new Error(lastErr ? String(lastErr) : "Navigation failed");
      };

      return run();
    },
  };
}
