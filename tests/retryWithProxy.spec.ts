import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as playwrightMocks from "./__mocks__/playwright";
import * as aluviaMocks from "./__mocks__/aluvia-ts-sdk";

// Mocks must be declared before importing the module under test (src/index.ts)
vi.mock("playwright", () => ({
  chromium: playwrightMocks.chromium,
  firefox: playwrightMocks.firefox,
  webkit: playwrightMocks.webkit,
}));

vi.mock("aluvia-ts-sdk", () => ({
  default: aluviaMocks.default,
}));

vi.mock("proxy-chain", () => ({
  Server: class MockProxyChainServer {
    server = { address() { return { port: 5555 }; } } as any;
    async listen() {}
    async close() {}
    constructor(_opts?: any) {}
  }
}));

// Import after mocks
import { retryWithProxy, startDynamicProxy } from "../src/index";
import { FakeBrowser, FakePage, __setOnLaunch } from "./__mocks__/playwright";

const DATA_OK = "data:text/html,<title>ok</title>ok";

async function makeBrowserAndPage() {
  const b = new FakeBrowser("chromium");
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  return { browser: b, page: p };
}

describe("retryWithProxy (mocked Playwright)", () => {
  let browser: FakeBrowser;
  let page: FakePage;

  beforeEach(async () => {
    process.env.ALUVIA_API_KEY = "TEST";
    process.env.ALUVIA_RETRY_ON = "ETIMEDOUT,Timeout,net::ERR";

    // Each relaunch in SDK will get a new fake browser
    __setOnLaunch((type) => new FakeBrowser(type));

    const made = await makeBrowserAndPage();
    browser = made.browser;
    page = made.page;
  });

  afterEach(() => {
    __setOnLaunch(null as any);
  });

  it("uses custom proxyProvider if provided", async () => {
    let called = false;
    const customProxyProvider = {
      async get() {
        called = true;
        return {
          server: "http://custom-proxy:1234",
          username: "customuser",
          password: "custompass",
        };
      },
    };

    // Force first goto to fail once with Timeout
    let failed = false;
    page.__setGoto(async () => {
      if (!failed) {
        failed = true;
        throw new Error("Timeout");
      }
      return null; // success on retry
    });

    const { page: p2 } = await retryWithProxy(page as any, {
      maxRetries: 1,
      backoffMs: 1,
      proxyProvider: customProxyProvider,
      closeOldBrowser: false,
      retryOn: ["Timeout", "ETIMEDOUT", /net::ERR/],
    }).goto(DATA_OK);

    expect(called).toBe(true);
    expect(await p2.title()).toBe("ok");
  });

  it("succeeds without retry on first attempt", async () => {
    page.__setGoto(async () => null); // immediate success

    const { response, page: p2 } = await retryWithProxy(page as any).goto(
      DATA_OK
    );

    expect(response).toBeNull();
    expect(p2).toBe(page as any);
    expect(await p2.title()).toBe("ok");
  });

  it("retries on retryable error and returns a new page", async () => {
    // Fail once with ETIMEDOUT then succeed
    let threw = false;
    page.__setGoto(async () => {
      if (!threw) {
        threw = true;
        const err: any = new Error("ETIMEDOUT simulated");
        err.code = "ETIMEDOUT";
        throw err;
      }
      return null;
    });

    const { response, page: p2 } = await retryWithProxy(page as any, {
      maxRetries: 2,
      backoffMs: 1,
      closeOldBrowser: false,
    }).goto(DATA_OK);

    expect(response).toBeNull();
    expect(p2).not.toBe(page as any);
    expect(await p2.title()).toBe("ok");
  });

  it("respects maxRetries=0 (throws after first failure)", async () => {
    page.__setGoto(async () => {
      const err: any = new Error("net::ERR_CONNECTION_RESET");
      err.message = "net::ERR_CONNECTION_RESET";
      throw err;
    });

    await expect(
      retryWithProxy(page as any, { maxRetries: 0 }).goto(DATA_OK)
    ).rejects.toBeInstanceOf(Error);
  });

  it("closeOldBrowser=false does not kill the original browser", async () => {
    const ctx = await browser.newContext();
    const localPage = await ctx.newPage();

    let failed = false;
    localPage.__setGoto(async () => {
      if (!failed) {
        failed = true;
        throw new Error("Timeout");
      }
      return null;
    });

    const { page: p2 } = await retryWithProxy(localPage as any, {
      maxRetries: 1,
      backoffMs: 1,
      closeOldBrowser: false,
      retryOn: ["Timeout", "ETIMEDOUT", /net::ERR/],
    }).goto(DATA_OK);

    expect(ctx.pages().length).toBeGreaterThan(0); // context still active
    expect(await p2.title()).toBe("ok");
  });

  it("carries forward latest page if a retried navigation fails", async () => {
    page.__setGoto(async () => {
      const e: any = new Error("ETIMEDOUT");
      e.code = "ETIMEDOUT";
      throw e;
    });

    const { page: p2 } = await retryWithProxy(page as any, {
      maxRetries: 2,
      backoffMs: 1,
      closeOldBrowser: false,
    }).goto(DATA_OK);

    expect(await p2.title()).toBe("ok");
  });

  it("dynamicProxy switches upstream without relaunch", async () => {
    const dyn = await startDynamicProxy();

    // Force first failure
    let calls = 0;
    page.__setGoto(async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("Timeout"), { code: "Timeout" });
      return null;
    });

    const { page: same } = await retryWithProxy(page as any, {
      maxRetries: 2,
      backoffMs: 1,
      dynamicProxy: dyn,
      retryOn: ["Timeout"],
      closeOldBrowser: false,
    }).goto(DATA_OK);

    // Should reuse original page instance
    expect(same).toBe(page as any);
    expect(await same.title()).toBe("ok");
    await dyn.close();
  });

  it("dynamicProxy does not retry on non-retryable error", async () => {
    const dyn = await startDynamicProxy();
    page.__setGoto(async () => { throw new Error("NonRetryable") });
    await expect(
      retryWithProxy(page as any, { dynamicProxy: dyn, retryOn: ["Timeout"], maxRetries: 2 }).goto(DATA_OK)
    ).rejects.toThrow();
    await dyn.close();
  });

  it("dynamicProxy performs multiple attempts on retryable errors", async () => {
    const dyn = await startDynamicProxy();
    let attempts = 0;
    page.__setGoto(async () => {
      attempts++;
      if (attempts < 3) throw Object.assign(new Error("Timeout"), { code: "Timeout" });
      return null;
    });
    const { page: same } = await retryWithProxy(page as any, { dynamicProxy: dyn, retryOn: ["Timeout"], maxRetries: 5, backoffMs: 0 }).goto(DATA_OK);
    expect(attempts).toBe(3); // first + two retries
    expect(same).toBe(page as any);
    await dyn.close();
  });

  it("dynamicProxy respects maxRetries", async () => {
    const dyn = await startDynamicProxy();
    page.__setGoto(async () => { throw Object.assign(new Error("Timeout"), { code: "Timeout" }); });
    await expect(
      retryWithProxy(page as any, { dynamicProxy: dyn, retryOn: ["Timeout"], maxRetries: 0 }).goto(DATA_OK)
    ).rejects.toThrow();
    await dyn.close();
  });
});
