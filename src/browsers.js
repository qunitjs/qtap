'use strict';

import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import which from 'which';

const QTAP_DEBUG = process.env.QTAP_DEBUG === '1';

class LocalBrowser {
  /**
   * @param {string|Array<string|null>|Iterator<string|null>} candidates
   *  Path to an executable or an iterable of candidate paths to check and use the first one that exists.
   *  If you need to vary entries by platform or environment variables, it may be easier
   *  to write your list as a generator function with inline changes as-needed.
   *  See FirefoxBrowser.getCandidates for an example.
   * @param {Array<string>} args
   * @param {string} clientId
   * @param {string} url
   * @param {AbortSignal} signal
   * @return {Promise}
   */
  static async startExecutable (candidates, args, clientId, url, signal, logger) {
    if (typeof candidates === 'string') {
      candidates = [candidates];
    }
    let exe;
    for (const candidate of candidates) {
      if (candidate !== null) {
        logger.debug('browser_exe_check', candidate);
        // Optimization: Use fs.existsSync. It is on par with accessSync and statSync,
        // and beats concurrent fs/promises.access(cb) via Promise.all().
        // Starting the promise chain alone takes the same time as a loop with
        // 5x existsSync(), not even counting the await and boilerplate to manage it all.
        if (fs.existsSync(candidate)) {
          logger.debug('browser_exe_found');
          exe = candidate;
          break;
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
          logger.debug('browser_natural_exit', details);
          resolve();
        }
      });
    });
  }

  /**
   * Create a new temporary directory and return its name.
   *
   * @returns {string}
   */
  static mkTempDir(clientId) {
    // Use mkdtemp (instead of only tmpdir) to avoid clash with past or concurrent qtap procesess.
    return fs.mkdtempSync(path.join(os.tmpdir(), 'qtap_' + clientId + '_'));
  }

  /**
   * Detect Windows Subsystem for Linux
   *
   * @returns {bool}
   */
  static isWsl() {
    try {
      return (
        process.platform == 'linux'
        // confirm "Microsoft" (WSL 1) or "microsoft" lowercase (WSL 2)
        && fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft')
        // not in a Podman container
        && !fs.existsSync('/run/.containerenv')
        // not in a Docker container
        && !fs.existsSync('/.dockerenv')
      );
    } catch (err) {
      // Ignore: /proc/version not found
      return false;
    }
  }

  /**
   * A browser is responsible for knowing whether the process failed to
   * launch or spawn, and whether it exited unexpectedly.
   *
   * A browser is not responsible for knowing whether it succeeded in
   * navigating to the given URL.
   *
   * It is the responsiblity of ControlServer to call controller.abort(),
   * if it believes the browser has likely failed to load the start URL
   * (e.g. a reasonable timeout if a browser has not sent its first TAP
   * message, or has not sent anything else for a while).
   *
   * If a browser exits on its own (i.e. ControlServer did not call
   * controller.abort), then start() should throw an Error or reject its
   * returned Promise.
   *
   * @param {string} clientId
   * @param {string} url
   * @param {AbortSignal} signal
   * @param {qtap-Logger} logger
   * @return {Promise}
   */
  static async launch (clientId, url, signal, logger) {
    throw new Error('not implemented');
  }

  /**
   * Clean up any shared resources.
   *
   * The same browser may start() several times concurrently in order
   * to test multiple URLs. In general, anything started or created
   * by start() should also be stopped or otherwise cleaned up by start().
   *
   * If you lazy-create any shared resources (such as a tunnel connection
   * for a cloud browser provider, a server or other socket, a cache directory,
   * etc) then this method can be used to tear those down once at the end
   * of the qtap process.
   */
  // TODO: Implement cleanupOnce support. Use case: browserstack tunnel.
  // async cleanupOnce () {
  // }
}

class FirefoxBrowser {
  * getCandidates () {
    if (process.env.FIREFOX_BIN) yield process.env.FIREFOX_BIN;

    // Find /usr/bin/firefox on platforms like linux (including WSL), freebsd, openbsd.
    yield which.sync('firefox', { nothrow: true });

    if (process.platform === 'darwin') {
      if (process.env.HOME) yield process.env.HOME + '/Applications/Firefox.app/Contents/MacOS/firefox';
      yield '/Applications/Firefox.app/Contents/MacOS/firefox';
    }

    if (process.platform == 'win32') {
      if (process.env.PROGRAMFILES) yield process.env.PROGRAMFILES + '\\Mozilla Firefox\\firefox.exe';
      if (process.env['PROGRAMFILES(X86)']) yield process.env['PROGRAMFILES(X86)'] + '\\Mozilla Firefox\\firefox.exe';
      yield 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
    }

    // TODO: Support launching Firefox on Windows from inside WSL
    // if (LocalBrowser.isWsl()) { }
  }

  static createPrefsJs (prefs) {
    let js = '';
    for (const key in prefs) {
      js += 'user_pref("' + key + '", ' + JSON.stringify(prefs[key]) + ');\n';
    }
    return js;
  }

  async launch (clientId, url, signal, logger) {
    const profileDir = LocalBrowser.mkTempDir(clientId);
    const args = [url, '-profile', profileDir, '-no-remote', '-wait-for-browser'];
    if (!QTAP_DEBUG) {
      args.push('-headless');
    }

    // http://kb.mozillazine.org/About:config_entries
    // https://github.com/sitespeedio/browsertime/blob/v23.5.0/lib/firefox/settings/firefoxPreferences.js
    // https://github.com/airtap/the-last-browser-launcher/blob/v0.1.1/lib/launch/index.js
    // https://github.com/karma-runner/karma-firefox-launcher/blob/v2.1.3/index.js
    logger.debug('firefox_prefs_create', 'Creating temporary prefs.js file');
    fs.writeFileSync(path.join(profileDir, 'prefs.js'), FirefoxBrowser.createPrefsJs({
      'app.update.disabledForTesting': true, // Disable auto-updates
      'browser.sessionstore.resume_from_crash': false,
      'browser.shell.checkDefaultBrowser': false,
      'dom.disable_open_during_load': false,
      'dom.max_script_run_time': 0, // Disable "slow script" dialogs
      'extensions.autoDisableScopes': 1,
      'extensions.update.enabled': false, // Disable auto-updates

      // Blank home, blank new tab, disable extra welcome tabs for "first launch"
      'browser.EULA.override': true,
      'browser.startup.firstrunSkipsHomepage': false,
      'browser.startup.page': 0,
      'datareporting.policy.dataSubmissionPolicyBypassNotification': true, // Avoid extra tab for mozilla.org/en-US/privacy/firefox/
      'startup.homepage_override_url': '',
      'startup.homepage_welcome_url': '',
      'startup.homepage_welcome_url.additional': '',

      // Performance optimizations
      'browser.bookmarks.max_backups': 0, // Optimization, via sitespeedio/browsertime
      'browser.bookmarks.restore_default_bookmarks': false, // Optimization
      'browser.cache.disk.capacity': 0, // Optimization: Avoid disk writes
      'browser.cache.disk.smart_size.enabled': false, // Optimization
      'browser.chrome.guess_favicon': false, // Optimization: Avoid likely 404 for unspecified favicon
      'browser.pagethumbnails.capturing_disabled': true, // Optimization, via sitespeedio/browsertime
      'browser.search.region': 'US', // Optimization: Avoid internal geoip lookup
      'browser.sessionstore.enabled': false, // Optimization
      'dom.min_background_timeout_value': 10, // Optimization, via https://github.com/karma-runner/karma-firefox-launcher/issues/19
    }));

    try {
      await LocalBrowser.startExecutable(this.getCandidates(), args, clientId, url, signal, logger);
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  }
}

export default {
  LocalBrowser,

  firefox: FirefoxBrowser,
  // https://github.com/vweevers/win-detect-browsers/blob/v7.0.0/lib/browsers.js
  //
  // TODO: safari: [],
  // TODO: chromium: [], // chromium+chrome+edge
  // --no-sandbox CHROMIUM_FLAGS

  // TODO: chrome: [], // chrome+chromium+edge
  // TODO: edge: [], // edge+chrome+chromium
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
