'use strict';

import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const QTAP_DEBUG = process.env.QTAP_DEBUG === '1';

class LocalBrowser {
  constructor (logger) {
    this.executable = null;

    for (const candidate of this.getCandidates(process.platform)) {
      logger.debug('browser_exe_check', candidate);
      // Optimization: Use fs.existsSync. It is on par with accessSync and statSync,
      // and beats concurrent fs/promises.access(cb) via Promise.all().
      // Starting the promise chain alone takes the same time as a loop with
      // 5x existsSync(), not even counting the await and boilerplate to manage it all.
      if (fs.existsSync(candidate)) {
        logger.debug('browser_exe_found');
        this.executable = candidate;
        break;
      }
    }
  }

  /**
   * @param {string[]} args
   * @param {string} clientId
   * @param {string} url
   * @param {AbortSignal} signal
   * @return {Promise}
   */
  async startExecutable (args, clientId, url, signal, logger) {
    const exe = this.executable;
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
        let details = 'Process exited'
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
   * @param {qtap-Logger} logger
   * @return {Promise}
   */
  async launch (clientId, url, signal, logger) {
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
    // TODO: Implement cleanupOnce support. Use case: browserstack tunnel.
  }
}

class FirefoxBrowser extends LocalBrowser {
  * getCandidates (platform) {
    if (platform === 'darwin') {
      if (process.env.HOME) yield process.env.HOME + '/Applications/Firefox.app/Contents/MacOS/firefox';
      yield '/Applications/Firefox.app/Contents/MacOS/firefox';
    }
  }

  async launch (clientId, url, signal, logger) {
    // TODO: Move mkdtemp to LocalBrowser.
    // Use mkdtemp (instead of only tmpdir) so that multiple qtap procesess don't clash.
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qtap_' + clientId + '_'));
    const args = [url, '-profile', profileDir, '-no-remote', '-wait-for-browser'];
    if (!QTAP_DEBUG) {
      args.push('-headless');
    }
    try {
      await this.startExecutable(args, clientId, url, signal, logger);
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  }
}

export default {
  firefox: FirefoxBrowser,
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
