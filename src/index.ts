import type {
  Browser,
  BrowserContextOptions,
  BrowserType,
  LaunchOptions,
  Page,
  Response,
} from "playwright";
import Aluvia from "aluvia-ts-sdk";

const ENV_MAX_RETRIES = parseInt(process.env.ALUVIA_MAX_RETRIES || "1", 10); // extra attempts after first
const ENV_BACKOFF_MS = parseInt(process.env.ALUVIA_BACKOFF_MS || "300", 10);
const ENV_RETRY_ON = (
  process.env.ALUVIA_RETRY_ON ?? "ECONNRESET,ETIMEDOUT,net::ERR,Timeout"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/* Pre-compile retry patterns for performance & correctness */
const DEFAULT_RETRY_PATTERNS: (string | RegExp)[] = ENV_RETRY_ON.map((p) =>
  p.startsWith("/") && p.endsWith("/") ? new RegExp(p.slice(1, -1)) : p
);

export type RetryPattern = string | RegExp;

export interface RetryWithProxyOptions {
  /** Inject a BrowserType (chromium/firefox/webkit). Defaults to inferring from page. */
  browserType?: BrowserType<Browser>;
  /** Launch options reused on relaunch. */
  launchDefaults?: LaunchOptions;
  /** Context options reused on relaunch. */
  contextDefaults?: BrowserContextOptions;
  /** waitUntil used on retried navigations when not provided in goto(). Defaults to "domcontentloaded". */
  waitUntil?: NonNullable<Parameters<Page["goto"]>[1]>["waitUntil"];
  /** Number of extra retry attempts after the initial failure. Default: env ALUVIA_MAX_RETRIES or 1. */
  maxRetries?: number;
  /** Base backoff (exponential with jitter). Default: env ALUVIA_BACKOFF_MS or 300. */
  baseBackoffMs?: number;
  /** Retry on these error patterns. Default: env ALUVIA_RETRY_ON or sane defaults. */
  retryOn?: RetryPattern[];
  /** Close the old browser when relaunching (safer default). Set false if you manage lifecycles yourself. */
  closeOldBrowser?: boolean;
  /** Abort the whole operation with a signal. Optional. */
  signal?: AbortSignal;
  /** Hard cap across all retries (ms). Optional. */
  overallTimeoutMs?: number;
  /** Optional logging hook. If true, logs to console; if function, receives log lines. */
  log?: boolean | ((msg: string) => void);
  /** Lifecycle hooks (optional) */
  onRetry?: (attempt: number, err: unknown) => void;
  onProxyRotate?: (proxy: ProxySettings) => void;
  onGiveUp?: (lastError: unknown) => void;
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

function logMaybe(logger: RetryWithProxyOptions["log"], msg: string) {
  if (!logger) return;
  if (logger === true) console.log(`[aluvia] ${msg}`);
  else logger(msg);
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
  const b = page.context().browser();
  const bt = (b as any)?.browserType?.();
  if (!bt) throw new Error("Cannot infer BrowserType from page");
  return bt as BrowserType<Browser>;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    const err = new Error("Operation aborted");
    (err as any).name = "AbortError";
    throw err;
  }
}

async function withOverallTimeout<T>(
  p: Promise<T>,
  ms?: number,
  signal?: AbortSignal
): Promise<T> {
  if (!ms) return p;
  let to: any;
  const timeout = new Promise<never>((_, rej) => {
    to = setTimeout(
      () => rej(new Error(`Operation timed out after ${ms} ms`)),
      ms
    );
  });
  try {
    const result = await Promise.race([p, timeout]);
    return result as T;
  } finally {
    clearTimeout(to);
    throwIfAborted(signal);
  }
}

export async function relaunchWithProxy(
  browserType: BrowserType<Browser>,
  launchDefaults: LaunchOptions,
  contextDefaults: BrowserContextOptions,
  proxy: ProxySettings,
  oldPage: Page,
  opts?: { closeOldBrowser?: boolean }
): Promise<{ page: Page }> {
  // Capture state/shape from old session
  const oldCtx = oldPage.context();
  const state = await oldCtx.storageState().catch(() => undefined);
  const vp = oldPage.viewportSize();
  const ua = await oldPage
    .evaluate(() => navigator.userAgent)
    .catch(() => undefined);

  // Optionally close old browser (default true)
  if (opts?.closeOldBrowser !== false) {
    try {
      await oldCtx.browser()?.close();
    } catch {}
  }

  const retryLaunch: LaunchOptions = {
    headless: launchDefaults.headless ?? true,
    ...launchDefaults,
    proxy,
  };

  const browser = await browserType.launch(retryLaunch);
  const context = await browser.newContext({
    ...contextDefaults,
    storageState: state,
    userAgent: ua ?? contextDefaults.userAgent,
    viewport: vp ?? contextDefaults.viewport,
  });
  const page = await context.newPage();
  return { page };
}

const GOTO_ORIGINAL = Symbol.for("aluvia.gotoOriginal");

export function retryWithProxy(
  page: Page,
  options?: RetryWithProxyOptions
): RetryWithProxyRunner {
  const {
    browserType,
    launchDefaults = {},
    contextDefaults = {},
    waitUntil,
    maxRetries = ENV_MAX_RETRIES,
    baseBackoffMs = ENV_BACKOFF_MS,
    retryOn = DEFAULT_RETRY_PATTERNS,
    closeOldBrowser = true,
    signal,
    overallTimeoutMs,
    log,
    onRetry,
    onProxyRotate,
    onGiveUp,
  } = options ?? {};

  const isRetryable = compileRetryable(retryOn);

  /** Prefer unpatched goto to avoid recursion */
  const getRawGoto = (p: Page) =>
    ((p as any)[GOTO_ORIGINAL]?.bind(p) ?? p.goto.bind(p)) as Page["goto"];

  return {
    async goto(url: string, gotoOptions?: GoToOptions) {
      throwIfAborted(signal);

      const run = async () => {
        // 1) First attempt on the current page
        try {
          logMaybe(log, `First attempt: ${url}`);
          const resp = await getRawGoto(page)(url, gotoOptions);
          return { response: resp ?? null, page };
        } catch (err) {
          if (!isRetryable(err)) throw err;
          logMaybe(
            log,
            `First attempt failed & retryable: ${(err as Error).message ?? err}`
          );
        }

        // 2) Retries with proxy
        let lastErr: unknown;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          throwIfAborted(signal);

          // backoff
          if (baseBackoffMs > 0) {
            const delay = backoffDelay(baseBackoffMs, attempt);
            await new Promise((r) => setTimeout(r, delay));
          }

          // proxy
          const proxy = await getAluviaProxy().catch((e) => {
            lastErr = e;
            logMaybe(log, `Proxy fetch failed: ${(e as Error).message ?? e}`);
            return undefined;
          });
          if (!proxy) break;

          onProxyRotate?.(proxy);
          logMaybe(log, `Retry #${attempt + 1} with proxy ${proxy.server}`);

          // relaunch
          try {
            const bt = browserType ?? inferBrowserTypeFromPage(page);
            const { page: newPage } = await relaunchWithProxy(
              bt,
              launchDefaults,
              contextDefaults,
              proxy,
              page,
              { closeOldBrowser }
            );

            // navigate on the new page
            const resp = await getRawGoto(newPage)(url, {
              ...(gotoOptions ?? {}),
              waitUntil:
                gotoOptions?.waitUntil ?? waitUntil ?? "domcontentloaded",
            });

            // small readiness gate (non-fatal if times out)
            try {
              await newPage.waitForFunction(
                () =>
                  typeof document !== "undefined" && !!document.title?.trim(),
                { timeout: 15000 }
              );
            } catch {
              /* ignore readiness gate timeout */
            }

            return { response: resp ?? null, page: newPage };
          } catch (err) {
            lastErr = err;
            onRetry?.(attempt + 1, err);
            logMaybe(
              log,
              `Retry #${attempt + 1} failed: ${(err as Error).message ?? err}`
            );
            // continue to next attempt
          }
        }

        onGiveUp?.(lastErr);
        throw lastErr;
      };

      const result = await withOverallTimeout(run(), overallTimeoutMs, signal);
      return result;
    },
  };
}
