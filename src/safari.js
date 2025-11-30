import which from 'which';
import { LocalBrowser, QTapError, CommandNotFoundError } from './util.js';
/** @import { Logger } from './qtap.js' */

async function delay (wait) {
  await new Promise(resolve => setTimeout(resolve, wait));
}

async function launchSafariDriver (bin, port, signals, logger) {
  try {
    // Use signals.global instead of signals.browser, as the driver may be shared by other clients
    await LocalBrowser.spawn(bin, ['-p', port], { browser: signals.global }, logger);
  } catch (e) {
    // Flaky "Operation not permitted", https://github.com/flutter/engine/pull/48791
    // Retry until the first browser's connect timed is reached
    if (String(e).includes('Operation not permitted') && !signals.browser.aborted) {
      await delay(1000);
      launchSafariDriver(bin, port, signals, logger);
    }
  }
}

/**
 * The Safari app can only be claimed (or "driven") by one safaridriver process at once,
 * so we have to re-use a single instance. The launcher function may be called multiple
 * times, e.g. when running multiple HTML test files, each will get its own browser.
 *
 * If we didn't support concurrency, we could pass `signal` to the spawn() call for safaridriver,
 * and let QTap abort the process directly, noting that safaridriver automatically closes all
 * tabs that you started when you kill the safaridriver process.
 *
 * But, since we do support concurrency, we listen to the 'abort event below, and use it to close
 * only our own tab.
 *
 * @type {number|null}
 */
let sharedSafariDriverPort = null;

/**
 * This supports setting SAFARIDRIVER_BIN to Safari Technology Preview.
 * https://developer.apple.com/documentation/webkit/testing-with-webdriver-in-safari
 *
 * @param {string} url
 * @param {Object<string,AbortSignal>} signals
 * @param {Logger} logger
 * @returns {Promise<void>}
 */
async function safariOne (url, signals, logger) {
  // Step 1: Start safaridriver
  if (!sharedSafariDriverPort) {
    const safaridriverBin = process.env.SAFARIDRIVER_BIN || which.sync('safaridriver', { nothrow: true });
    if (process.platform !== 'darwin' || !safaridriverBin) {
      throw new CommandNotFoundError('Safari requires macOS and safaridriver');
    }
    sharedSafariDriverPort = await LocalBrowser.findAvailablePort();
    launchSafariDriver(safaridriverBin, sharedSafariDriverPort, signals, logger);
  } else {
    // This is not an optimization. Safari can only be claimed by one safaridriver.
    logger.debug('safaridriver_reuse', 'Use existing safaridriver process');
  }
  const port = sharedSafariDriverPort;

  /**
   * https://developer.apple.com/documentation/webkit/macos-webdriver-commands-for-safari-12-and-later
   *
   * @param {string} method
   * @param {string} endpoint
   * @param {null|any} body
   * @param {null|AbortSignal} signal
   */
  async function webdriverReq (method, endpoint, body = null, signal = null) {
    logger.debug('safaridriver_req', method + ' ' + endpoint);
    // Since Node.js 18, connecting to "localhost" favours IPv6 (::1), whereas safaridriver
    // listens exclusively on IPv4 (127.0.0.1). This was fixed in Node.js 20 by trying both.
    // https://github.com/nodejs/node/issues/40702
    // https://github.com/nodejs/node/pull/44731
    // https://github.com/node-fetch/node-fetch/issues/1624
    const resp = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
      method,
      signal,
      body: body && JSON.stringify(body)
    });
    /** @type {any} */
    const data = await resp.json();
    if (!resp.ok) {
      throw `${data?.value?.message || ''}\nHTTP ${resp.status} ${data?.value?.error}`;
    }
    return data.value;
  }

  // Step 2: Create a session
  // This re-tries indefinitely until safaridriver is ready, or until we get an abort signal.
  let session;
  for (let i = 1; true; i++) {
    try {
      session = await webdriverReq('POST', '/session/', { capabilities: { browserName: 'safari' } }, signals.browser);
      // Connected!
      break;
    } catch (err) {
      // Give up once QTap declares browser_connect_timeout or otherwise cancels it
      if (signals.browser.aborted) return;
      /** @type {any} - TypeScript @types/node lacks Error.code */
      const e = err;
      if (e.code === 'ECONNREFUSED' || (e.cause && e.cause.code === 'ECONNREFUSED')) {
        // Back off from 50ms upto 1.0s each attempt
        const wait = Math.min(i * 50, 1000);
        logger.debug('safaridriver_waiting', `Attempt ${i}: ${e.code || e.cause.code}. Try again in ${wait}ms.`);
        await delay(wait);
        continue;
      }
      logger.warning('safaridriver_session_error', e);
      throw new QTapError((e.message || e) + '\nFailed to create a Safari session.');
    }
  }

  // Step 3: Open a URL
  try {
    await webdriverReq('POST', `/session/${session.sessionId}/url`, { url: url }, signals.browser);
  } catch (e) {
    logger.warning('safaridriver_url_error', e);
    throw new Error('Failed to create new tab');
  }

  // Step 4: Close the tab once we receive an 'abort' signal.
  return await new Promise((resolve, reject) => {
    signals.browser.addEventListener('abort', async () => {
      try {
        // Do not pass `signals.browser` here. This must go through to ensure
        // a clean exit for the next Safari client.
        await webdriverReq('DELETE', `/session/${session.sessionId}`);
        resolve();
      } catch (e) {
        logger.warning('safaridriver_delete_error', e);
        reject(new Error('Unable to stop safaridriver session'));
      }
    });
  });
}
safariOne.previous = Promise.resolve();

/**
 * In addition to Safari requiring a single safaridriver globally,
 * paired with a single Safari instance, Safari also limits safaridriver
 * to a single webdriver session (i.e. browser tab).
 *
 * This means we have no choice but to serialize test files.
 * Without this, `POST /session` would return:
 *
 * > HTTP 500 session not created,
 * > Could not create a session:
 * > The Safari instance is already paired with a different session.
 *
 * https://developer.apple.com/documentation/webkit/about-webdriver-for-safari#One-Session-at-a-Time-to-Mimic-User-Interaction
 */
async function safari (url, signals, logger) {
  const current = safariOne.previous = safariOne.previous.finally(
    () => safariOne(url, signals, logger)
  );
  await current;
}
safari.displayName = 'Safari';

export default safari;
