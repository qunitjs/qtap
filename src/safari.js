import which from 'which';
import { LocalBrowser, CommandNotFoundError } from './util.js';
/** @import { Logger } from './qtap.js' */

async function findAvailablePort () {
  const net = await import('node:net');
  return new Promise((resolve, _reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      // @ts-ignore - Not null after listen()
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function launchSafariDriver (safaridriverBin, globalSignal, logger) {
  const port = await findAvailablePort();
  LocalBrowser.spawn(safaridriverBin, ['-p', port], globalSignal, logger);
  return port;
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
 * only our tab.
 *
 * @type {Promise<number>|null}
 */
let sharedSafariDriverPort = null;

/**
 *
 * Support overriding via SAFARIDRIVER_BIN to Safari Technology Preview.
 * https://developer.apple.com/documentation/webkit/testing-with-webdriver-in-safari
 *
 * @param {string} url
 * @param {Object<string,AbortSignal>} signals
 * @param {Logger} logger
 * @returns {Promise<void>}
 */
async function safari (url, signals, logger) {
  // Step 1: Start safaridriver
  if (!sharedSafariDriverPort) {
    const safaridriverBin = process.env.SAFARIDRIVER_BIN || which.sync('safaridriver', { nothrow: true });
    if (process.platform !== 'darwin' || !safaridriverBin) {
      throw new CommandNotFoundError('Safari requires macOS and safaridriver');
    }
    sharedSafariDriverPort = launchSafariDriver(safaridriverBin, signals.global, logger);
  } else {
    // This is not an optimization. Safari can only be claimed by one safaridriver.
    logger.debug('safaridriver_reuse', 'Use existing safaridriver process');
  }
  const port = await sharedSafariDriverPort;

  // https://developer.apple.com/documentation/webkit/macos-webdriver-commands-for-safari-12-and-later
  async function webdriverReq (method, endpoint, body) {
    // Since Node.js 18, connecting to "localhost" favours IPv6 (::1), whereas safaridriver
    // listens exclusively on IPv4 (127.0.0.1). This was fixed in Node.js 20 by trying both.
    // https://github.com/nodejs/node/issues/40702
    // https://github.com/nodejs/node/pull/44731
    // https://github.com/node-fetch/node-fetch/issues/1624
    const resp = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
      method: method,
      body: JSON.stringify(body)
    });
    /** @type {any} */
    const data = await resp.json();
    if (!resp.ok) {
      throw `HTTP ${resp.status} ${data?.value?.error}, ${data?.value?.message || ''}`;
    }
    return data.value;
  }

  // Step 2: Create a session
  // This re-tries indefinitely until safaridriver is ready, or until we get an abort signal.
  let session;
  for (let i = 1; true; i++) {
    try {
      session = await webdriverReq('POST', '/session/', { capabilities: { browserName: 'safari' } });
      // Connected!
      break;
    } catch (err) {
      /** @type {any} - TypeScript @types/node lacks Error.code */
      const e = err;
      if (e.code === 'ECONNREFUSED' || (e.cause && e.cause.code === 'ECONNREFUSED')) {
        // Give up once QTap declared browser_connect_timeout
        if (signals.browser.aborted) return;

        // Back off from 50ms upto 1.0s each attempt
        const wait = Math.min(i * 50, 1000);
        logger.debug('safaridriver_waiting', `Attempt #${i}: ${e.code || e.cause.code}. Try again in ${wait}ms.`);
        await new Promise(resolve => setTimeout(resolve, wait));
        continue;
      }
      logger.warning('safaridriver_session_error', e);
      throw new Error('Failed to create new session');
    }
  }

  // Step 3: Open a URL
  try {
    await webdriverReq('POST', `/session/${session.sessionId}/url`, { url: url });
  } catch (e) {
    logger.warning('safaridriver_url_error', e);
    throw new Error('Failed to create new tab');
  }

  // Step 4: Close the tab once we receive an 'abort' signal.
  return await new Promise((resolve, reject) => {
    signals.browser.addEventListener('abort', async () => {
      try {
        await webdriverReq('DELETE', `/session/${session.sessionId}`);
        resolve();
      } catch (e) {
        logger.warning('safaridriver_delete_error', e);
        reject(new Error('Unable to stop safaridriver session'));
      }
    });
  });
}
safari.displayName = 'Safari';

export default safari;
