'use strict';

import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

class Browser {
  static getBrowser (name, logger) {
    const localBrowsers = {
      firefox: FirefoxBrowser,
      safari: [],
      chromium: [],
      chrome: [],
      edge: [],
    };

    // --no-sandbox CHROMIUM_FLAGS
    // Refer to karma launchers.
    // Refer to airtap.
    // Refer to puppeteer.
    // Refer to playwright (Firefox, Safari).

    // TODO: Deal with one-time shared setup across browser of the same provider.
    // to setup browserstack tunnel once, and then tear it down at some point.
    // Refer to karma browser launcher. Maybe just a process-level flag to track
    // the "nonce"/semaphore that it is done for the setup, lazily. Easy enough?

    // What about shutdown? Do we start it in a way that doesn't hold up the Node
    // process and then hope to tie into process.on('exit') to quckly clean it up,
    // risk zombie process. Or an official cleanup(), but then how do we ensure
    // it is only called once. function identity in an ES6 Set(), that qunit-browser

    logger.debug('get_browser', name);
    const Browser = localBrowsers[name];
    if (!Browser) {
      throw new Error('Unknown browser name ' + name);
    }
    return new Browser(logger);
  }

  constructor (logger) {
    this.logger = logger.channel('qtap_browser_' + this.constructor.name);
    this.executable = this.getExecutable(process.platform);
  }

  getExecutable (platform) {
    for (const candidate of this.getCandidates(platform)) {
      // Optimization: Use fs.existsSync. It is on par with accessSync and statSync,
      // and beats concurrent fs/promises.access(cb) via Promise.all().
      // Starting the promise chain alone takes the same time as a loop with
      // 5x existsSync(), not even counting the await and boilerplate to manage it all.
      this.logger.debug('exe_candidate', candidate);
      if (fs.existsSync(candidate)) {
        this.logger.debug('exe_candidate_found');
        return candidate;
      }
    }
    this.logger.debug('exe_found_none');
  }

  /**
   * @param {string[]} args
   * @param {string} clientId
   * @param {string} url
   * @param {AbortSignal} signal
   * @return {Promise}
   */
  async startExecutable (args, clientId, url, signal) {
    const exe = this.executable;
    if (!exe) {
      throw new Error('No executable found');
    }
    const logger = this.logger.channel(`qtap_browser-${this.constructor.name}-${clientId}`);

    logger.debug('exe_start', exe, args);
    const spawned = cp.spawn(exe, args, { signal });

    return new Promise((resolve, reject) => {
      spawned.on('error', error => {
        if (signal.aborted) {
          resolve();
        } else {
          logger.debug('exe_error', error);
          reject(error);
        }
      });
      spawned.on('exit', (code, sig) => {
        logger.debug('exe_exit', code, sig);
        if (!signal.aborted) {
          reject(new Error(`Exit code code=${code} signal=${sig}`));
        } else {
          resolve();
        }
      });
    });
  }

  * getCandidates (platform) {
    throw new Error('not implemented');
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
   * @return {Promise}
   */
  async launch (clientId, url, signal) {
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
  async cleanupOnce () {
  }
}

class FirefoxBrowser extends Browser {
  * getCandidates (platform) {
    if (platform === 'darwin') {
      if (process.env.HOME) yield process.env.HOME + '/Applications/Firefox.app/Contents/MacOS/firefox';
      yield '/Applications/Firefox.app/Contents/MacOS/firefox';
    }
  }

  async launch (clientId, url, signal) {
    // Use mkdtemp (instead of only tmpdir) so that multiple qtap procesess don't clash.
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qtap_' + clientId + '_'));
    // TODO: Launch with --headless.
    const args = [url, '-profile', profileDir, '-no-remote', '-wait-for-browser'];
    try {
      await this.startExecutable(args, clientId, url, signal);
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  }
}

export {
  Browser,
  FirefoxBrowser,
};
