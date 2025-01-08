import which from 'which';
import { globalSignal, LocalBrowser } from './util.js';

async function findAvailablePort () {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function launchSafariDriver (safaridriverBin, logger) {
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
 * @param {AbortSignal} signal
 * @param {qtap-Logger} logger
 */
async function safari (url, signal, logger) {
  // Step 1: Start safaridriver
  if (!sharedSafariDriverPort) {
    const safaridriverBin = process.env.SAFARIDRIVER_BIN || which.sync('safaridriver', { nothrow: true });
    if (process.platform !== 'darwin' || !safaridriverBin) {
      throw new Error('Safari requires macOS and safaridriver');
    }
    sharedSafariDriverPort = launchSafariDriver(safaridriverBin, logger);
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
    const data = await resp.json();
    if (!resp.ok) {
      throw `HTTP ${resp.status} ${data?.value?.error}, ${data?.value?.message || ''}`;
    }
    return data.value;
  }

  // Step 2: Create a session
  let session;
  for (let i = 1; i <= 20; i++) {
    try {
      session = await webdriverReq('POST', '/session/', { capabilities: { browserName: 'safari' } });
      // Connected!
      break;
    } catch (e) {
      if (e && (e.code === 'ECONNREFUSED' || (e.cause && e.cause.code === 'ECONNREFUSED'))) {
        // Wait for safaridriver to be ready, try again in another 10ms-200ms, upto ~2s in total.
        logger.debug('safaridriver_waiting', `Attempt #${i}: ${e.code || e.cause.code}. Try again in ${i * 10}ms.`);
        await new Promise(resolve => setTimeout(resolve, i * 10));
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
  await new Promise((resolve, reject) => {
    signal.addEventListener('abort', async () => {
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

export default safari;
