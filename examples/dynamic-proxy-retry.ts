/**
 * Dynamic proxy retry example.
 *
 * Demonstrates launching Chromium with a local dynamic proxy (proxy-chain) so that
 * when the first navigation attempt times out, we switch the upstream proxy to
 * an Aluvia proxy WITHOUT relaunching the browser.
 *
 * NOTE: The API key below was provided explicitly by the user for example purposes.
 * Avoid committing real secrets in production code. Prefer: export ALUVIA_API_KEY=... && node script.ts
 */
import { chromium } from 'playwright';
import { retryWithProxy, startDynamicProxy } from '../src/index'; // use 'page-retry' when installed from npm

// Provided by user request. Replace with your own via env var in real usage.
process.env.ALUVIA_API_KEY = 'd360cd5cf0f04db51285cf959491b0639dd74d4ee3ac00d3f408c6bbe0eed87a';
// Ensure we treat typical timeout errors as retryable.
process.env.ALUVIA_RETRY_ON = 'Timeout,ETIMEDOUT,net::ERR';

async function main() {
  // Start dynamic local proxy (no upstream yet).
  const dynamic = await startDynamicProxy();
  console.log('Dynamic proxy listening at', dynamic.url);

  // Launch browser pointing at local dynamic proxy. Upstream can change later.
  const browser = await chromium.launch({ headless: true, proxy: { server: dynamic.url } });
  const context = await browser.newContext();
  const page = await context.newPage();

  // A URL that should reliably timeout (non-routable TEST-NET-1 address) to trigger retry.
  const UNROUTABLE_URL = 'http://10.255.255.1';

  const runner = retryWithProxy(page, {
    dynamicProxy: dynamic,
    maxRetries: 2,          // number of retry attempts after initial failure
    backoffMs: 500,          // base backoff (exponential with jitter)
    retryOn: ['Timeout', 'ETIMEDOUT', 'net::ERR'],
    onRetry: (attempt, max, err) => {
      console.log(`[retry] attempt ${attempt}/${max} after error:`, (err as any)?.message);
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

