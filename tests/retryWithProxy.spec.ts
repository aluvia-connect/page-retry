import { chromium, type Browser, type Page } from "playwright";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("aluvia-ts-sdk", () => {
  class MockAluvia {
    constructor(_apiKey: string) {}
    async first() {
      return {
        host: "127.0.0.1",
        httpPort: 8888,
        username: "u",
        password: "p",
      };
    }
  }
  return { default: MockAluvia };
});

import { retryWithProxy } from "../src/index";

const DATA_OK = "data:text/html,<title>ok</title>ok";

describe("retryWithProxy", () => {
  let browser: Browser;
  let page: Page;

  beforeEach(async () => {
    process.env.ALUVIA_API_KEY = "TEST";
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext();
    page = await ctx.newPage();
  });

  afterEach(async () => {
    try {
      await page?.context()?.close();
    } catch {}
    try {
      await browser?.close();
    } catch {}
  });

  it("succeeds without retry on first attempt", async () => {
    const { response, page: p2 } = await retryWithProxy(page).goto(DATA_OK);

    // For data: URLs, Playwright returns null Response. That's expected.
    expect(response).toBeNull();
    expect(p2).toBe(page);
    expect(await p2.title()).toBe("ok");
  });

  it("retries on retryable error and returns a new page", async () => {
    // Force the first call to goto to fail with a retryable error
    let threw = false;
    const original = page.goto.bind(page);
    page.goto = vi.fn(async (url, opts) => {
      if (!threw) {
        threw = true;
        const err: any = new Error("ETIMEDOUT simulated");
        err.code = "ETIMEDOUT";
        throw err;
      }
      return original(url, opts);
    }) as any;

    const { response, page: p2 } = await retryWithProxy(page, {
      maxRetries: 2,
      backoffMs: 1,
      // Prevent closing this test's browser so we can still assert after
      closeOldBrowser: false,
    }).goto(DATA_OK);

    // For data: URLs, response is null
    expect(response).toBeNull();
    expect(p2).not.toBe(page); // relaunch happened
    expect(await p2.title()).toBe("ok");
  });

  it("respects maxRetries=0 (throws after first failure)", async () => {
    const original = page.goto.bind(page);
    page.goto = vi.fn(async () => {
      const err: any = new Error("net::ERR_CONNECTION_RESET");
      err.message = "net::ERR_CONNECTION_RESET";
      throw err;
    }) as any;

    await expect(
      retryWithProxy(page, { maxRetries: 0 }).goto(DATA_OK)
    ).rejects.toBeInstanceOf(Error);

    // restore
    page.goto = original as any;
  });

  it("closeOldBrowser=false does not kill the original browser", async () => {
    const ctx = await browser.newContext();
    const localPage = await ctx.newPage();

    let failed = false;
    const original = localPage.goto.bind(localPage);
    localPage.goto = vi.fn(async (url, opts) => {
      if (!failed) {
        failed = true;
        const err: any = new Error("Timeout");
        throw err;
      }
      return original(url, opts);
    }) as any;

    const { page: p2 } = await retryWithProxy(localPage, {
      maxRetries: 1,
      backoffMs: 1,
      closeOldBrowser: false, // keep original browser alive
    }).goto(DATA_OK);

    // original browser still alive; context still usable
    expect(localPage.context().pages().length).toBeGreaterThan(0);
    expect(await p2.title()).toBe("ok");

    await p2.close();
    await localPage.close();
    await ctx.close();
  });

  it("carries forward latest page if a retried navigation fails", async () => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();

    // Initial page always fails to force a relaunch
    const original = p.goto.bind(p);
    p.goto = vi.fn(async () => {
      const e: any = new Error("ETIMEDOUT");
      e.code = "ETIMEDOUT";
      throw e;
    }) as any;

    const { page: p2 } = await retryWithProxy(p, {
      maxRetries: 2,
      backoffMs: 1,
      closeOldBrowser: false,
    }).goto(DATA_OK);

    // After relaunch, navigation to data: should succeed
    expect(await p2.title()).toBe("ok");

    // cleanup
    p.goto = original as any;
    await p2.close();
    await ctx.close();
  });
});
