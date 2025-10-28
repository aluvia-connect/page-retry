# page-retry

[![npm version](https://badge.fury.io/js/page-retry.svg)](https://www.npmjs.com/package/page-retry)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org)

Retry failed [Playwright](https://playwright.dev) navigations automatically with proxy fallback.

[Read the full documentation](https://docs.aluvia.io/docs/using-aluvia/page-retry-sdk)

## Installation

```bash
npm install page-retry
```

```bash
yarn add page-retry
```

```bash
pnpm add page-retry
```

## Quick Start

```typescript
import { chromium } from "playwright";
import { retryWithProxy } from "page-retry";

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

const { response, page: retriedPage } = await retryWithProxy(page).goto(
  "https://blocked-website.com"
);

console.log("Page title:", await retriedPage.title());
await browser.close();
```

## API Key Setup

This SDK uses an Aluvia API key to fetch proxies when retries occur.
Get your key from your Aluvia account's [Connect to Proxies page](https://dashboard.aluvia.io/connect)
and set it in .env:

```bash
ALUVIA_API_KEY=your_aluvia_api_key
```

## Configuration

You can control how `retryWithProxy` behaves using environment variables or options passed in code.
The environment variables set defaults globally, while the TypeScript options let you override them per call.

### Environment Variables

| Variable             | Description                                                                              | Default                                 |
| -------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------- |
| `ALUVIA_API_KEY`     | Required unless you provide a custom `proxyProvider`. Used to fetch proxies from Aluvia. | _none_                                  |
| `ALUVIA_MAX_RETRIES` | Number of retry attempts after the first failed navigation.                              | `1`                                     |
| `ALUVIA_BACKOFF_MS`  | Base delay (ms) between retries, grows exponentially with jitter.                        | `300`                                   |
| `ALUVIA_RETRY_ON`    | Comma-separated list of retryable error substrings.                                      | `ECONNRESET,ETIMEDOUT,net::ERR,Timeout` |

#### Example `.env`

```env
ALUVIA_API_KEY=your_aluvia_api_key
ALUVIA_MAX_RETRIES=2
ALUVIA_BACKOFF_MS=500
ALUVIA_RETRY_ON=ECONNRESET,ETIMEDOUT,net::ERR,Timeout
```

### TypeScript Options

You can also configure behavior programmatically by passing options to `retryWithProxy()`.

```typescript
import { retryWithProxy } from "page-retry";

const { response, page } = await retryWithProxy(page, {
  maxRetries: 3,
  backoffMs: 500,
  retryOn: ["ECONNRESET", /403/],
  closeOldBrowser: false,
});
```

#### Available Options

| Option            | Type                   | Default                                  | Description                                                          |
| ----------------- | ---------------------- | ---------------------------------------- | -------------------------------------------------------------------- |
| `maxRetries`      | `number`               | `process.env.ALUVIA_MAX_RETRIES` or `1`  | Number of retry attempts after the first failure.                    |
| `backoffMs`       | `number`               | `process.env.ALUVIA_BACKOFF_MS` or `300` | Base delay (in ms) between retries, grows exponentially with jitter. |
| `retryOn`         | `(string \| RegExp)[]` | `process.env.ALUVIA_RETRY_ON`            | Error patterns considered retryable.                                 |
| `closeOldBrowser` | `boolean`              | `true`                                   | Whether to close the old browser when relaunching.                   |
| `proxyProvider`   | `ProxyProvider`        | Uses Aluvia SDK                          | Custom proxy provider that returns proxy credentials.                |

#### Custom Proxy Provider Example

```typescript
const myProxyProvider = {
  async get() {
    return {
      server: "http://myproxy.example.com:8000",
      username: "user123",
      password: "secret",
    };
  },
};

const { response, page } = await retryWithProxy(page, {
  proxyProvider: myProxyProvider,
  maxRetries: 3,
});
```

You can integrate this with any proxy API or local pool, as long as it returns a `server`, `username`, and `password`.

## Requirements

- Node.js >= 18
- Playwright
- Aluvia API key (_if not using a custom proxy provider_)

## About Aluvia

[Aluvia](https://www.aluvia.io/) provides real mobile proxy networks for developers and data teams, built for web automation, testing, and scraping with real device IPs.

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.MD](CONTRIBUTING.MD) for guidelines.

- Fork the repo and create your branch.
- Write clear commit messages.
- Add tests for new features.
- Open a pull request.

## Support

For bugs, feature requests, or questions, please open an issue on [GitHub](https://github.com/xtrella/page-retry/issues).

For commercial support or proxy questions, visit [Aluvia](https://www.aluvia.io/).

## License

MIT License - see the [LICENSE](LICENSE) file for details.

## Author

Xtrella
