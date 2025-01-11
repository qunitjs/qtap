'use strict';

import util from 'node:util';

import kleur from 'kleur';
import browsers from './browsers.js';
import { ControlServer } from './server.js';

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
 * @property {number} [timeout=30] How long a browser may be quiet between results.
 * @property {number} [connectTimeout=60] How many seconds a browser may take to start up.
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

  const globalController = new AbortController();
  const globalSignal = globalController.signal;

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
      browserLaunches.push(server.launchBrowser(browserFn, browserName, globalSignal));
    }
  }

  try {
    // Wait for all tests and browsers to finish/stop, regardless of errors thrown,
    // to avoid dangling browser processes.
    await Promise.allSettled(browserLaunches);

    // Re-wait, this time letting the first of any errors bubble up.
    for (const launched of browserLaunches) {
      await launched;
    }

    logger.debug('shared_cleanup', 'Invoke global signal to clean up shared resources');
    globalController.abort();
  } finally {
    // Make sure we close our server even if the above throws, so that Node.js
    // may naturally exit (no open ports remaining)
    for (const server of servers) {
      server.close();
    }
  }

  // TODO: Set exit status to 1 on failures, to ease programmatic use and testing.
  // TODO: Return an event emitter for custom reportering via programmatic use.
  return 0;
}

export default {
  run,

  browsers,
  LocalBrowser: browsers.LocalBrowser,
};
