import type {
  Browser,
  BrowserContextOptions,
  BrowserType,
  LaunchOptions,
  Page,
  Response,
} from "playwright";
import { Server as ProxyChainServer } from "proxy-chain";

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

export interface ProxyProvider {
  get(): Promise<ProxySettings>;
}

enum AluviaErrorCode {
  NoApiKey = "ALUVIA_NO_API_KEY",
  NoProxy = "ALUVIA_NO_PROXIES",
  ProxyFetchFailed = "ALUVIA_PROXY_FETCH_FAILED",
  InsufficientBalance = "ALUVIA_INSUFFICIENT_BALANCE",
  BalanceFetchFailed = "ALUVIA_BALANCE_FETCH_FAILED",
}

export class AluviaError extends Error {
  code?: AluviaErrorCode;
  constructor(message: string, code?: AluviaErrorCode) {
    super(message);
    this.name = "AluviaError";
    this.code = code;
  }
}

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
   * import { retryWithProxy } from "page-retry";
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

  /**
   * Optional callback fired before each retry attempt (after backoff).
   *
   * @param attempt Current retry attempt number (1-based)
   * @param maxRetries Maximum number of retries
   * @param lastError The error that triggered the retry
   */
  onRetry?: (
    attempt: number,
    maxRetries: number,
    lastError: unknown
  ) => void | Promise<void>;

  /**
   * Optional callback fired when a proxy has been successfully fetched.
   *
   * @param proxy The proxy settings that were fetched or provided
   */
  onProxyLoaded?: (proxy: ProxySettings) => void | Promise<void>;

  /**
   * Optional dynamic proxy. If provided, retries will switch upstream proxy
   * via this local proxy instead of relaunching the browser.
   *
   * To use: const dyn = await startDynamicProxy();
   * chromium.launch({ proxy: { server: dyn.url } })
   * Then pass { dynamicProxy: dyn } to retryWithProxy().
   */
  dynamicProxy?: DynamicProxy;
}

let aluviaClient: any | undefined; // lazy-loaded Aluvia client instance

async function getAluviaProxy(): Promise<ProxySettings> {
  const apiKey = process.env.ALUVIA_API_KEY || "";
  if (!apiKey) {
    throw new AluviaError(
      "Missing ALUVIA_API_KEY environment variable.",
      AluviaErrorCode.NoApiKey
    );
  }

  if (!aluviaClient) {
    // Dynamic import to play nicely with test mocks (avoids top-level evaluation before vi.mock)
    const mod: any = await import("aluvia-ts-sdk");
    const AluviaCtor = mod?.default || mod;
    aluviaClient = new AluviaCtor(apiKey);
  }

  const proxy = await aluviaClient.first();

  if (!proxy) {
    throw new AluviaError(
      "Failed to obtain a proxy for retry attempts. Check your balance and proxy pool at https://dashboard.aluvia.io/.",
      AluviaErrorCode.NoProxy
    );
  }

  return {
    server: `http://${proxy.host}:${proxy.httpPort}`,
    username: proxy.username,
    password: proxy.password,
  };
}

async function getAluviaBalance() {
  const apiKey = process.env.ALUVIA_API_KEY || "";
  if (!apiKey) {
    throw new AluviaError(
      "Missing ALUVIA_API_KEY environment variable.",
      AluviaErrorCode.NoApiKey
    );
  }

  const response = await fetch("https://api.aluvia.io/account/status", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new AluviaError(
      `Failed to fetch Aluvia account status: ${response.status} ${response.statusText}`,
      AluviaErrorCode.BalanceFetchFailed
    );
  }

  const data = await response.json();
  return data.data.balance_gb;
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
  const context = page.context();
  const options = (context as any)._options as BrowserContextOptions;
  return options ?? {};
}

function inferLaunchDefaults(page: Page): LaunchOptions {
  const browser = page.context().browser();
  const options = (browser as any)._options as LaunchOptions | undefined;
  return options ?? {};
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
    proxyProvider,
    onRetry,
    onProxyLoaded,
    dynamicProxy,
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
          if (!isRetryable(err)) {
            throw err;
          }
        }

        if (!proxyProvider) {
          const balance = await getAluviaBalance().catch(() => null);
          if (balance !== null && balance <= 0) {
            throw new AluviaError(
              "Your Aluvia account has no remaining balance. Please top up at https://dashboard.aluvia.io/ to continue using proxies.",
              AluviaErrorCode.InsufficientBalance
            );
          }
        }

        const proxy = await (proxyProvider?.get() ?? getAluviaProxy()).catch(
          (err) => {
            lastErr = err;
            return undefined;
          }
        );

        if (!proxy) {
          throw new AluviaError(
            "Failed to obtain a proxy for retry attempts. Check your balance and proxy pool at https://dashboard.aluvia.io/.",
            AluviaErrorCode.ProxyFetchFailed
          );
        } else {
          await onProxyLoaded?.(proxy);
        }

        // If dynamic proxy supplied, switch upstream & retry on same page without relaunch.
        if (dynamicProxy) {
          await dynamicProxy.setUpstream(proxy);

          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            if (backoffMs > 0) {
              const delay = backoffDelay(backoffMs, attempt - 1);
              await new Promise((r) => setTimeout(r, delay));
            }
            await onRetry?.(attempt, maxRetries, lastErr);
            try {
              const response = await getRawGoto(basePage)(url, {
                ...(gotoOptions ?? {}),
                timeout: gotoOptions?.timeout ?? DEFAULT_GOTO_TIMEOUT_MS,
                waitUntil: gotoOptions?.waitUntil ?? "domcontentloaded",
              });
              return { response: response ?? null, page: basePage };
            } catch (err) {
              lastErr = err;
              if (!isRetryable(err)) break; // stop early on non-retryable error
              continue; // next attempt
            }
          }

          if (lastErr instanceof Error) throw lastErr;
          throw new Error(lastErr ? String(lastErr) : "Navigation failed");
        }

        // Original relaunch path if no dynamic proxy provided
        // Retries with proxy
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          if (backoffMs > 0) {
            const delay = backoffDelay(backoffMs, attempt - 1);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }

          await onRetry?.(attempt, maxRetries, lastErr);

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

/**
 * Starts a local proxy-chain server which can have its upstream changed at runtime
 * without relaunching the browser. Launch Playwright with { proxy: { server: dynamic.url } }.
 */
export async function startDynamicProxy(port?: number): Promise<DynamicProxy> {
  let upstream: ProxySettings | null = null;

  const server = new ProxyChainServer({
    port: port || 0,
    prepareRequestFunction: async () => {
      if (!upstream) return {};
      let url = upstream.server.startsWith("http") ? upstream.server : `http://${upstream.server}`;
      if (upstream.username && upstream.password) {
        try {
          const u = new URL(url);
          u.username = upstream.username;
          u.password = upstream.password;
          url = u.toString();
        } catch {}
      }
      return { upstreamProxyUrl: url } as any;
    },
  });

  await server.listen();
  const address = server.server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port || 8000;
  const url = `http://127.0.0.1:${resolvedPort}`;

  return {
    url,
    async setUpstream(p: ProxySettings | null) {
      upstream = p;
    },
    async close() {
      try { await server.close(false); } catch {}
    },
    currentUpstream() { return upstream; },
  };
}

export interface DynamicProxy {
  /** Local proxy URL (host:port) to be used in Playwright launch options */
  url: string;
  /** Update upstream proxy; null disables upstream (direct connection) */
  setUpstream(proxy: ProxySettings | null): Promise<void>;
  /** Dispose the local proxy server */
  close(): Promise<void>;
  /** Returns the currently configured upstream settings (if any) */
  currentUpstream(): ProxySettings | null;
}
