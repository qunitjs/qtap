'use strict';

import fs from 'node:fs';
import path from 'node:path';

import which from 'which';
import safari from './safari.js';
import { concatGenFn, LocalBrowser } from './util.js';

const QTAP_DEBUG = process.env.QTAP_DEBUG === '1';

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
  // https://github.com/GoogleChrome/chrome-launcher/blob/main/docs/chrome-flags-for-tools.md
  const dataDir = LocalBrowser.makeTempDir();
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
