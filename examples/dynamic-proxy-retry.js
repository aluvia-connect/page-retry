/**
 * Dynamic proxy retry example (JavaScript version).
 *
 * Shows launching Chromium with a local dynamic proxy (proxy-chain). On initial
 * navigation failure (timeout / network error), we swap in an Aluvia upstream
 * proxy WITHOUT relaunching the browser, then retry.
 *
 * Usage (from repo root):
 *   npm run build
 *   npx playwright install
 *   ALUVIA_API_KEY=<API KEY> node examples/dynamic-proxy-retry.js
 */
import { chromium } from 'playwright';
import { retryWithProxy, startDynamicProxy } from 'page-retry';

// Retry on common timeout/network indicators.
process.env.ALUVIA_RETRY_ON = 'Timeout,ETIMEDOUT,net::ERR';

async function main() {
  const dynamic = await startDynamicProxy();
  console.log('Dynamic proxy listening at', dynamic.url);

  const browser = await chromium.launch({ headless: false, proxy: { server: dynamic.url } });
  const context = await browser.newContext();
  const page = await context.newPage();

  const UNROUTABLE_URL = 'http://10.255.255.1'; // TEST-NET-1 address likely to timeout

  const runner = retryWithProxy(page, {
    dynamicProxy: dynamic,
    maxRetries: 2,
    backoffMs: 500,
    retryOn: ['Timeout', 'ETIMEDOUT', 'net::ERR'],
    onRetry: (attempt, max, err) => {
      console.log(`[retry] attempt ${attempt}/${max} after error:`, err && err.message);
      console.log('Current upstream before attempt:', dynamic.currentUpstream());
    },
    onProxyLoaded: (proxy) => {
      console.log('[proxy-loaded] Using upstream proxy:', proxy.server);
    },
  });

  try {
    console.log('Navigating to', UNROUTABLE_URL, '(expected to fail first)');
    const { page: finalPage } = await runner.goto(UNROUTABLE_URL, { timeout: 8000 });
    console.log('Navigation succeeded. Page title:', await finalPage.title());
  } catch (err) {
    console.error('Navigation ultimately failed:', err);
  } finally {
    await dynamic.close();
    await browser.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });

