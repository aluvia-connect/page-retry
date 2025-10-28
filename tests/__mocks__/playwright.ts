import { vi } from "vitest";

type BrowserTypeName = "chromium" | "firefox" | "webkit";
type GotoFn = (url: string, opts?: any) => Promise<any>;

export class FakePage {
  private _title = "ok";
  private _gotoImpl: GotoFn;
  private _ctx: FakeContext;

  constructor(ctx: FakeContext, gotoImpl?: GotoFn) {
    this._ctx = ctx;
    this._gotoImpl = gotoImpl ?? (async () => null); // mimic data: URL -> null Response
  }

  async goto(url: string, opts?: any) {
    return this._gotoImpl(url, opts);
  }

  async title() {
    return this._title;
  }

  context() {
    return this._ctx;
  }

  async close() {}

  /** Test helper: override goto behavior */
  __setGoto(fn: GotoFn) {
    this._gotoImpl = fn;
  }
}

export class FakeContext {
  private _browser: FakeBrowser;
  private _pages: FakePage[] = [];

  constructor(browser: FakeBrowser) {
    this._browser = browser;
  }

  async newPage() {
    const p = new FakePage(this);
    this._pages.push(p);
    return p;
  }

  pages() {
    return this._pages;
  }

  browser() {
    return this._browser;
  }

  async close() {}

  // Optional fields some SDKs read
  _options = {
    userAgent: "fake-UA",
    viewport: { width: 1280, height: 720 },
    storageState: undefined as any,
  };
}

export class FakeBrowser {
  private _type: BrowserTypeName;
  private _contexts: FakeContext[] = [];
  private _closed = false;

  constructor(type: BrowserTypeName = "chromium") {
    this._type = type;
  }

  async newContext() {
    const ctx = new FakeContext(this);
    this._contexts.push(ctx);
    return ctx;
  }

  contexts() {
    return this._contexts;
  }

  async close() {
    this._closed = true;
  }

  isClosed() {
    return this._closed;
  }

  /** return a BrowserType *object* with .launch() */
  browserType() {
    switch (this._type) {
      case "chromium":
        return chromium;
      case "firefox":
        return firefox;
      case "webkit":
        return webkit;
      default:
        return chromium;
    }
  }

  __type() {
    return this._type;
  }
}

let onLaunch: ((type: BrowserTypeName) => FakeBrowser) | null = null;

/** Allow tests to control what launch() returns */
export function __setOnLaunch(
  fn: ((type: BrowserTypeName) => FakeBrowser) | null
) {
  onLaunch = fn;
}

const make = (type: BrowserTypeName) => ({
  launch: vi.fn(async () =>
    onLaunch ? onLaunch(type) : new FakeBrowser(type)
  ),
});

export const chromium = make("chromium");
export const firefox = make("firefox");
export const webkit = make("webkit");

export default { chromium, firefox, webkit };
