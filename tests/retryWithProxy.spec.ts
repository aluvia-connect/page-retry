import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { retryWithProxy } from "../src/index";
import { FakeBrowser, FakePage, __setOnLaunch } from "./__mocks__/playwright";

vi.mock("playwright", async () => {
  const mod = await import("./__mocks__/playwright");
  return { default: mod.default, __setOnLaunch: mod.__setOnLaunch };
});

vi.mock("aluvia-ts-sdk", async () => {
  const mod = await import("./__mocks__/aluvia-ts-sdk");
  return { default: mod.default };
});

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
});
