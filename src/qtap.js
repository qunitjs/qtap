'use strict';

import util from 'node:util';

import kleur from 'kleur';
import browsers from './browsers.js';
import { ControlServer } from './server.js';
import { globalController, globalSignal } from './util.js';

/**
 * @typedef {Object} Logger
 * @property {Function} channel
 * @property {Function} debug
 * @property {Function} warning
 */

/**
 * @param {string} defaultChannel
 * @param {Function} printDebug
 * @param {boolean} [verbose]
 * @return {Logger}
 */
function makeLogger (defaultChannel, printDebug, verbose = false) {
  /**
   * @param {Array<any>} params
   * @returns {string}
   */
  const paramsFmt = (params) => params
    .flat()
    .map(param => typeof param === 'string' ? param : util.inspect(param, { colors: false }))
    .join(' ');

  function channel (prefix) {
    return {
      channel,
      debug: !verbose
        ? function () {}
        : function debug (messageCode, ...params) {
          printDebug(kleur.grey(`[${prefix}] ${kleur.bold(messageCode)} ${paramsFmt(params)}`));
        },
      warning: function warning (messageCode, ...params) {
        printDebug(kleur.yellow(`[${prefix}] WARNING ${kleur.bold(messageCode)}`) + ` ${paramsFmt(params)}`);
      }
    };
  }

  return channel(defaultChannel);
}

/**
 * @typedef {Object} qtap.Config
 * @property {Object<string,Function>} [browsers]
 * Refer to API.md for how to define additional browsers.
 */

/**
 * @typedef {Object} qtap.RunOptions
 * @property {qtap.Config|string} [config] Config object, or path to a qtap.config.js file.
 * Refer to API.md for how to define additional browsers.
 * @property {number} [timeout=3] Fail if a browser is idle for this many seconds.
 * @property {number} [connectTimeout=60] How long a browser may initially take
   to launch and open the URL, in seconds.
 * @property {boolean} [verbose=false]
 * @property {string} [root=process.cwd()] Root directory to find files in
 *  and serve up. Ignored if testing from URLs.
 * @property {Function} [printDebug=console.error]
 */

/**
 * @param {string|string[]} browserNames One or more browser names, referring either
 *  to a built-in browser launcher from QTap, or to a key in the optional
 *  `config.browsers` object.
 * @param {string|string[]} files Files and/or URLs.
 * @param {qtap.RunOptions} [options]
 * @return {Promise<number>} Exit code. 0 is success, 1 is failed.
 */
async function run (browserNames, files, options = {}) {
  if (typeof browserNames === 'string') browserNames = [browserNames];
  if (typeof files === 'string') files = [files];

  const logger = makeLogger(
    'qtap_main',
    options.printDebug || console.error,
    options.verbose
  );

  const servers = [];
  for (const file of files) {
    servers.push(new ControlServer(options.root, file, logger, {
      idleTimeout: options.timeout,
      connectTimeout: options.connectTimeout
    }));
  }

  let config;
  async function getNonDefaultBrowser (name, options) {
    if (!options.config) {
      return;
    }
    if (!config) {
      config = typeof options.config === 'string' ? await import(options.config) : options.config;
    }
    return config?.browsers?.[name];
  }

  const browserLaunches = [];
  for (const browserName of browserNames) {
    logger.debug('get_browser', browserName);
    const browserFn = browsers[browserName] || await getNonDefaultBrowser(browserName, options);
    if (typeof browserFn !== 'function') {
      throw new Error('Unknown browser ' + browserName);
    }
    for (const server of servers) {
      // Each launchBrowser() returns a Promise that settles when the browser exits.
      // Launch concurrently, and await afterwards.
      browserLaunches.push(server.launchBrowser(browserFn, browserName));
    }
  }

  try {
    // Instead of calling process.exit(), wait for everything to settle (success
    // and failures alike), and then stop everything we started so that Node.js
    // exits naturally by itself.
    // TODO: Consider just calling process.exit after this await.
    // Is that faster and safe? What if any important clean up would we miss?
    // 1. Removing of temp directories is generally done in browser "launch" functions
    //    after the child process has properly ended (and has to, as otherwise the
    //    files are likely still locked and/or may end up re-created). If we were to
    //    exit earlier, we may leave temp directories behind. This is fine when running
    //    in an ephemeral environment (e.g. CI), but not great for local dev.
    //
    await Promise.allSettled(browserLaunches);
    // Await again, so that any error gets thrown accordingly,
    // we don't do this directly because we first want to wait for all tests
    // to complete, success and failuress alike.
    for (const launched of browserLaunches) {
      await launched;
    }

    logger.debug('shared_cleanup', 'Invoke globalSignal to clean up shared resources');
    globalController.abort();
  } finally {
    browsers.LocalBrowser.rmTempDirs(logger);

    // Avoid dangling browser processes. Even if the above throws,
    // make sure we let each server exit (TODO: Why?)
    // and let each browser do clean up (OK, this is useful, rm tmpdir,
    // excpet no, we already take care of that via launch/finallly, unless
    // process.exit bypasses that?)
    for (const server of servers) {
      server.close();
    }
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
  // TODO: Implement Browser.cleanupOnce somehow. Use case: browserstack tunnel.
  // Each browser launched by it will presumably lazily start the tunnel
  // on the first browser launch, but only after the last browser stopped
  // should the tunnel be cleaned up.
  // Alternative: Some kind of global callback for clean up.
  // Perhpas implmement a global qtap.on('cleanup'), which could be use for
  // temp dirs as well.

  // TODO: Return exit status, to ease programmatic use and testing.
  // TODO: Add parameter for stdout used by reporters.
  return 0;
}

export default {
  run,

  browsers,
  LocalBrowser: browsers.LocalBrowser,
  globalSignal,
};
