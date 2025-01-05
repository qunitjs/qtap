'use strict';

import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import which from 'which';
import { concatGenFn, globalSignal } from './util.js';

const QTAP_DEBUG = process.env.QTAP_DEBUG === '1';
const tempDirs = [];

const LocalBrowser = {
  /**
   * @param {string|Array<string|null>|Iterator<string|null>} paths
   *  Path to an executable command or an iterable list of candidate paths to
   *  check and use the first one that exists.
   *
   *  If you need to vary list items by platform or environment variables, it may
   *  be easier to write your list as a generator function with as little or much
   *  conditional logic around yield statements as-needed.
   *
   *  Any `undefined` or `null` entries are automatically skipped, to make it
   *  easy to include the result of `process.env.YOUR_KEY` or `which.sync()`.
   *
   *  See getFirefoxPaths for an example.
   *
   * @param {Array<string>} args List of string arguments, passed to child_process.spawn()
   *  which will automatically quote and escape these.
   * @param {AbortSignal} signal
   * @return {Promise}
   */
  async spawn (paths, args, signal, logger) {
    if (typeof paths === 'string') {
      paths = [paths];
    }
    let exe;
    for (const candidate of paths) {
      if (candidate !== undefined && candidate !== null) {
        // Optimization: Use fs.existsSync. It is on par with accessSync and statSync,
        // and beats concurrent fs/promises.access(cb) via Promise.all().
        // Starting the promise chain alone takes the same time as a loop with
        // 5x existsSync(), not even counting the await and boilerplate to manage it all.
        if (fs.existsSync(candidate)) {
          logger.debug('browser_exe_found', candidate);
          exe = candidate;
          break;
        } else {
          logger.debug('browser_exe_check', candidate);
        }
      }
    }
    if (!exe) {
      throw new Error('No executable found');
    }

    logger.debug('browser_exe_spawn', exe, args);
    const spawned = cp.spawn(exe, args, { signal });

    let stdout = '';
    let stderr = '';
    spawned.stdout.on('data', data => {
      stdout += data;
    });
    spawned.stderr.on('data', data => {
      stderr += data;
    });

    return new Promise((resolve, reject) => {
      spawned.on('error', error => {
        if (signal.aborted) {
          resolve();
        } else {
          logger.debug('browser_exe_error', error);
          reject(error);
        }
      });
      spawned.on('exit', (code, sig) => {
        const indent = (str) => str.trim().split('\n').map(line => '    ' + line).join('\n');
        const details = 'Process exited'
          + `\n  exit code: ${code}`
          + (sig ? `\n  signal: ${sig}` : '')
          + (stderr ? `\n  stderr:\n${indent(stderr)}` : '')
          + (stdout ? `\n  stdout:\n${indent(stdout)}` : '');
        if (!signal.aborted) {
          reject(new Error(details));
        } else {
          logger.debug('browser_natural_exit', `Process exitted with code ${code} and signal ${sig}`);
          resolve();
        }
      });
    });
  },

  /**
   * Create a new temporary directory and return its name.
   *
   * This creates subdirectories inside Node.js `os.tmpdir`, which honors
   * any TMPDIR, TMP, or TEMP environment variable.
   *
   * The newly created directory is automatically cleaned up at the end of the process.
   *
   * @returns {string}
   */
  makeTempDir () {
    // Use mkdtemp (instead of only tmpdir) to avoid clash with past or concurrent qtap procesess.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qtap_'));
    tempDirs.push(dir);
    return dir;
  },

  rmTempDirs (logger) {
    // On Windows, after spawn() returns for a stopped firefox.exe, we sometimes can't delete
    // a temporary file because it is somehow still in use (EBUSY). Perhaps a race condition,
    // or an lagged background process?
    // > BUSY: resource busy or locked,
    // > unlink 'C:\Users\RUNNER~1\AppData\Local\Temp\qtap_EZ4IoO\bounce-tracking-protection.sqlite'
    //
    // Workaround: Enable `maxRetries` in case we just need to wait a little bit, and beyond that
    // use a try-catch to ignore a failed retry, because it is not critical for test completion.
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
      } catch (e) {
        logger.warning('browser_rmtempdir_fail', e);
      }
    }
    tempDirs.length = 0;
  }
};

// - use Set to remove duplicate values, because `PROGRAMFILES` and `ProgramW6432` are often
//   both "C:\Program Files", which, we'd check three times otherwise.
// - it is important that this preserves order of precedence.
// - use filter() to remove empty/unset environment variables.
//
// https://github.com/karma-runner/karma-chrome-launcher/blob/v3.2.0/index.js
// https://github.com/vweevers/win-detect-browsers/blob/v7.0.0/lib/browsers.js
const WINDOWS_DIRS = new Set([
  process.env.LOCALAPPDATA,
  process.env.PROGRAMFILES,
  process.env['PROGRAMFILES(X86)'],
  process.env.ProgramW6432,
  'C:\\Program Files'
].filter(Boolean));

function createFirefoxPrefsJs (prefs) {
  let js = '';
  for (const key in prefs) {
    js += 'user_pref("' + key + '", ' + JSON.stringify(prefs[key]) + ');\n';
  }
  return js;
}

function * getFirefoxPaths () {
  // Handle unix-like platforms such as linux, WSL, darwin/macOS, freebsd, openbsd.
  // Note that firefox-esr on Debian/Ubuntu includes a 'firefox' alias.
  //
  // Example: /usr/bin/firefox
  yield process.env.FIREFOX_BIN;
  yield which.sync('firefox', { nothrow: true });

  if (process.platform === 'darwin') {
    const appPath = '/Applications/Firefox.app/Contents/MacOS/firefox';
    if (process.env.HOME) yield process.env.HOME + appPath;
    yield appPath;
  }

  if (process.platform === 'win32') {
    for (const dir of WINDOWS_DIRS) yield dir + '\\Mozilla Firefox\\firefox.exe';
  }
}

function * getChromePaths () {
  yield process.env.CHROME_BIN;
  yield which.sync('google-chrome', { nothrow: true });
  yield which.sync('google-chrome-stable', { nothrow: true });

  if (process.platform === 'darwin') {
    const appPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (process.env.HOME) yield process.env.HOME + appPath;
    yield appPath;
  }

  if (process.platform === 'win32') {
    for (const dir of WINDOWS_DIRS) yield dir + '\\Google\\Chrome\\Application\\chrome.exe';
  }
}

function * getChromiumPaths () {
  // Try 'chromium-browser' first to avoid conflict with 'chromium' from chromium-bsu on Debian
  yield process.env.CHROMIUM_BIN;
  yield which.sync('chromium-browser', { nothrow: true });
  yield which.sync('chromium', { nothrow: true });

  if (process.platform === 'darwin') {
    const appPath = '/Applications/Chromium.app/Contents/MacOS/Chromium';
    if (process.env.HOME) yield process.env.HOME + appPath;
    yield appPath;
  }

  if (process.platform === 'win32') {
    for (const dir of WINDOWS_DIRS) yield dir + '\\Chromium\\Application\\chrome.exe';
  }
}

function * getEdgePaths () {
  // Debian packages from https://packages.microsoft.com
  // https://learn.microsoft.com/en-us/linux/packages
  // https://github.com/actions/runner-images/blob/1ffc99a7ae/images/ubuntu/scripts/build/install-microsoft-edge.sh#L11
  // https://github.com/microsoft/playwright/blob/v1.49.1/packages/playwright-core/src/server/registry/index.ts#L560
  yield process.env.EDGE_BIN;
  yield which.sync('microsoft-edge', { nothrow: true });
  yield which.sync('microsoft-edge-stable', { nothrow: true });
  yield '/opt/microsoft/msedge/msedge';

  if (process.platform === 'darwin') {
    const appPath = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
    if (process.env.HOME) yield process.env.HOME + appPath;
    yield appPath;
  }

  if (process.platform === 'win32') {
    for (const dir of WINDOWS_DIRS) yield dir + '\\Microsoft\\Edge\\Application\\msedge.exe';
  }
}

async function firefox (url, signal, logger) {
  const profileDir = LocalBrowser.makeTempDir();
  const args = [url, '-profile', profileDir, '-no-remote', '-wait-for-browser'];
  if (!QTAP_DEBUG) {
    args.push('-headless');
  }

  // http://kb.mozillazine.org/About:config_entries
  // https://github.com/sitespeedio/browsertime/blob/v23.5.0/lib/firefox/settings/firefoxPreferences.js
  // https://github.com/airtap/the-last-browser-launcher/blob/v0.1.1/lib/launch/index.js
  // https://github.com/karma-runner/karma-firefox-launcher/blob/v2.1.3/index.js
  logger.debug('firefox_prefs_create', 'Creating temporary prefs.js file');
  fs.writeFileSync(path.join(profileDir, 'prefs.js'), createFirefoxPrefsJs({
    'app.update.disabledForTesting': true, // Disable auto-updates
    'browser.bookmarks.max_backups': 0, // Optimization, via sitespeedio/browsertime
    'browser.bookmarks.restore_default_bookmarks': false, // Optimization
    'browser.cache.disk.capacity': 0, // Optimization: Avoid disk writes
    'browser.cache.disk.smart_size.enabled': false, // Optimization
    'browser.chrome.guess_favicon': false, // Optimization: Avoid likely 404 for unspecified favicon
    'browser.EULA.override': true, // Blank start, disable extra tab
    'browser.pagethumbnails.capturing_disabled': true, // Optimization, via sitespeedio/browsertime
    'browser.search.region': 'US', // Optimization: Avoid internal geoip lookup
    'browser.sessionstore.enabled': false, // Optimization
    'browser.sessionstore.resume_from_crash': false,
    'browser.shell.checkDefaultBrowser': false,
    'browser.startup.firstrunSkipsHomepage': false, // Blank start, disable extra tab
    'browser.startup.page': 0, // Blank start
    'datareporting.policy.dataSubmissionPolicyBypassNotification': true, // Blank start, disable extra tab for mozilla.org/en-US/privacy/firefox/
    'dom.disable_open_during_load': false,
    'dom.max_script_run_time': 0, // Disable "slow script" dialogs
    'dom.min_background_timeout_value': 10, // Optimization, via https://github.com/karma-runner/karma-firefox-launcher/issues/19
    'extensions.autoDisableScopes': 1,
    'extensions.update.enabled': false, // Disable auto-updates
    'startup.homepage_override_url': '', // Blank start, disable extra tab
    'startup.homepage_welcome_url': '', // Blank start, disable extra tab
    'startup.homepage_welcome_url.additional': '', // Blank start, disable extra tab
  }));
  await LocalBrowser.spawn(getFirefoxPaths(), args, signal, logger);
}

async function chromium (paths, url, signal, logger) {
  const dataDir = LocalBrowser.makeTempDir();
  // https://github.com/GoogleChrome/chrome-launcher/blob/main/docs/chrome-flags-for-tools.md
  const args = [
    '--user-data-dir=' + dataDir,
    '--no-default-browser-check',
    '--no-first-run',
    '--disable-default-apps',
    '--disable-popup-blocking',
    '--disable-translate',
    '--disable-background-timer-throttling',
    ...(QTAP_DEBUG ? [] : [
      '--headless',
      '--disable-gpu',
      '--disable-dev-shm-usage'
    ]),
    ...(process.env.CHROMIUM_FLAGS ? process.env.CHROMIUM_FLAGS.split(/\s+/) : (
      process.env.CI ? ['--no-sandbox'] : [])
    ),
    url
  ];
  await LocalBrowser.spawn(paths, args, signal, logger);
}

/**
 * Known approaches:
 *
 * - `Safari <file>`. This does not allow URLs. Safari allows only local files to be passed.
 *
 * - `Safari redirect.html`, without other arguments, worked from 2012-2018, as used by Karma.
 *   This "trampoline" approach involves creating a temporary HTML file
 *   with `<script>window.location='<url>';</script>`, which we open instead.
 *   https://github.com/karma-runner/karma-safari-launcher/blob/v1.0.0/index.js
 *   https://github.com/karma-runner/karma/blob/v0.3.5/lib/launcher.js#L213
 *   https://github.com/karma-runner/karma/commit/5513fd66ae
 *
 *   This is no longer viable after macOS 10.14 Mojave, because macOS SIP prompts the user
 *   due to our temporary file being outside `~/Library/Containers/com.apple.Safari`.
 *   https://github.com/karma-runner/karma-safari-launcher/issues/29
 *
 * - `open -F -W -n -b com.apple.Safari <url>`. This starts correctly, but doesn't expose
 *   a PID to cleanly end the process.
 *   https://github.com/karma-runner/karma-safari-launcher/issues/29
 *
 * - `Safari container/redirect.html`. macOS SIP denies this by default for the same reason.
 *   But, as long as you grant an exemption to Terminal to write to Safari's container, or
 *   grant it Full Disk Access, this is viable.
 *   https://github.com/flutter/engine/pull/27567
 *   https://github.com/marcoscaceres/karma-safaritechpreview-launcher/issues/7
 *
 *   It seems that GitHub CI has pre-approved limited access in its macOS images, to make
 *   this work [1][2]. This might be viable if it is tolerable to prompt on first local use,
 *   and require granting said access to the Terminal in general (which has lasting
 *   consequences beyond QTap).
 *
 * - native app Swift/ObjectiveC proxy. This reportedly works but requires
 *   a binary which requires compilation and makes auditing significantly harder.
 *   https://github.com/karma-runner/karma-safari-launcher/issues/29
 *   https://github.com/muthu90ec/karma-safarinative-launcher/
 *
 * - `osascript -e <script>`
 *   As of macOS 13 Ventura (or earlier?), this results in a prompt for
 *   "Terminal wants access to control Safari", from which osascript will eventually
 *   timeout and report "Safari got an error: AppleEvent timed out".
 *
 *   While past discussions suggest that GitHub CI has this pre-approved [1][2],
 *   as of writing in Jan 2025 with macOS 13 images, this approval does not include
 *   access from Terminal to Safari, thus causing the same "AppleEvent timed out".
 *
 *   https://github.com/brandonocasey/karma-safari-applescript-launcher
 *   https://github.com/brandonocasey/karma-safari-applescript-launcher/issues/5
 *
 * - `osascript MyScript.scpt`. This avoids the need for quote escaping in the URL, by
 *   injecting it properly as a parameter instead. Used by Google's karma-webkit-launcher
 *   https://github.com/google/karma-webkit-launcher/commit/31a2ad8037
 *
 * - `safaridriver -p <port>`, and then make an HTTP request to create a session,
 *   navigate the session, and to delete the session. This addresses all the concerns,
 *   and seems to be the best as of 2025. The only downside is that it requires a bit
 *   more code (available port, and HTTP requests).
 *   https://github.com/flutter/engine/pull/33757
 *
 * See also:
 * - Unresolved as of writing, https://github.com/testem/testem/issues/1387
 * - Unresolved as of writing, https://github.com/emberjs/data/issues/7170
 *
 * [1]: https://github.com/actions/runner-images/issues/4201
 * [2]: https://github.com/actions/runner-images/issues/7531
 */
let pSafariDriverPort = null;

async function launchSafariDriver (safaridriverBin, logger) {
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

  const port = await findAvailablePort();
  LocalBrowser.spawn(safaridriverBin, ['-p', port], globalSignal, logger);
  return port;
}

async function safari (url, signal, logger) {
  if (!pSafariDriverPort) {
    // Support overriding via SAFARIDRIVER_BIN to Safari Technology Preview.
    // https://developer.apple.com/documentation/webkit/testing-with-webdriver-in-safari
    const safaridriverBin = process.env.SAFARIDRIVER_BIN || which.sync('safaridriver', { nothrow: true });
    if (process.platform !== 'darwin' || !safaridriverBin) {
      throw new Error('Safari requires macOS and safaridriver');
    }
    pSafariDriverPort = launchSafariDriver(safaridriverBin, logger);
  } else {
    // This is not an optimization. Safari can only be claimed by one safaridriver.
    logger.debug('safaridriver_reuse', 'Found existing safaridriver process');
  }
  const port = await pSafariDriverPort;

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

  let sessionId;
  for (let i = 1; i <= 20; i++) {
    try {
      const session = await webdriverReq('POST', '/session/', { capabilities: { browserName: 'safari' } });
      sessionId = session.sessionId;
      // Connected!
      break;
    } catch (e) {
      if (e && (e.code === 'ECONNREFUSED' || (e.cause && e.cause.code === 'ECONNREFUSED'))) {
        // Wait another 10ms-200ms for safaridriver to start, upto ~2s in total.
        logger.debug('safaridriver_waiting', `Attempt #${i}: ${e.code || e.cause.code}. Try again in ${i * 10}ms.`);
        await new Promise(resolve => setTimeout(resolve, i * 10));
        continue;
      }
      logger.warning('safaridriver_session_error', e);
      throw new Error('Failed to create new session');
    }
  }

  try {
    await webdriverReq('POST', `/session/${sessionId}/url`, { url: url });
  } catch (e) {
    logger.warning('safaridriver_url_error', e);
    throw new Error('Failed to create new tab');
  }

  // NOTE: If we didn't support concurrency, the `signal` could kill the safaridriver process,
  // which would automatically closes our tabs, not needing an 'abort' listener and DELETE.
  await new Promise((resolve, reject) => {
    signal.addEventListener('abort', async () => {
      try {
        await webdriverReq('DELETE', `/session/${sessionId}`);
        resolve();
      } catch (e) {
        logger.warning('safaridriver_delete_error', e);
        reject(new Error('Unable to stop safaridriver session'));
      }
    });
  });
}

export default {
  LocalBrowser,

  firefox,
  chrome: chromium.bind(null, concatGenFn(getChromePaths, getChromiumPaths, getEdgePaths)),
  chromium: chromium.bind(null, concatGenFn(getChromiumPaths, getChromePaths, getEdgePaths)),
  edge: chromium.bind(null, concatGenFn(getEdgePaths)),
  safari,

  // TODO: browserstack
  // - browserstack/firefox_45
  // - browserstack/firefox_previous
  // - browserstack/firefox_current,
  // - ["browserstack", {
  //      "browser": "opera",
  //      "browser_version": "36.0",
  //      "device": null,
  //      "os": "OS X",
  //      "os_version": "Sierra"
  //   ]
  // TODO: saucelabs
  // TODO: puppeteer
  // TODO: puppeteer_coverage { outputDir: instanbul }
  // TODO: integration test with nyc as example with console+html output
};
