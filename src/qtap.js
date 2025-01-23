'use strict';

import util from 'node:util';
import path from 'node:path';

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
  // Characters to avoid to ensure easy single lines of CLI debug output
  // * x00-1F: e.g. NULL, backspace (\b), line breaks (\r\n), ESC,
  //   ASNI escape codes (terminal colors).
  // * x74: DEL.
  // * xA0: non-breaking space.
  //
  // See https://en.wikipedia.org/wiki/ASCII#Character_order
  //
  // eslint-disable-next-line no-control-regex
  const rNonObviousStr = /[\x00-\x1F\x7F\xA0]/;

  /**
   * @param {Array<any>} params
   * @returns {string}
   */
  const paramsFmt = (params) => params
    .flat()
    .map(param => typeof param === 'string'
      ? (rNonObviousStr.test(param) ? JSON.stringify(param) : param)
      : util.inspect(param, { colors: false }))
    .join(' ');

  function channel (prefix) {
    return {
      channel,
      debug: !verbose
        ? function () {}
        : function debug (messageCode, ...params) {
          printDebug(kleur.grey(`[${prefix}] ${kleur.bold(messageCode)} ${paramsFmt(params)}`));
        },
      warning: !verbose
        ? function () {}
        : function warning (messageCode, ...params) {
          printDebug(kleur.yellow(`[${prefix}] WARNING ${kleur.bold(messageCode)}`) + ` ${paramsFmt(params)}`);
        }
    };
  }

  return channel(defaultChannel);
}

/**
 * @typedef {((
 *  url: string,
 *  signals: Object<string,AbortSignal>,
 *  logger: Logger
 * ) => Promise<void>) & { displayName?: string }} Browser
 */

/**
 * @typedef {Object} qtap.Config
 * @property {Object<string,Browser>} [browsers]
 * Refer to API.md for how to define additional browsers.
 */

/**
 * @typedef {Object} qtap.RunOptions
 * @property {qtap.Config|string} [config] Config object, or path to a qtap.config.js file.
 * Refer to API.md for how to define additional browsers.
 * @property {number} [timeout=30] How long a browser may be quiet between results.
 * @property {number} [connectTimeout=60] How many seconds a browser may take to start up.
 * @property {boolean} [verbose=false]
 * @property {string} [cwd=process.cwd()] Base directory to interpret test file paths
 *  relative to. Ignored if testing from URLs.
 * @property {Function} [printDebug=console.error]
 */

/**
 * @param {string|string[]} browserNames One or more browser names, referring either
 *  to a built-in browser from QTap, or to a key in the optional `config.browsers` object.
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
    servers.push(new ControlServer(options.cwd, file, logger, {
      idleTimeout: options.timeout,
      connectTimeout: options.connectTimeout
    }));
  }

  // TODO: Add test for config file not found
  // TODO: Add test for config file with runtime errors
  // TODO: Add test for relative config file without leading `./`, handled by process.resolve()
  let config;
  if (typeof options.config === 'string') {
    logger.debug('load_config', options.config);
    config = (await import(path.resolve(process.cwd(), options.config))).default;
  }
  const globalController = new AbortController();
  const globalSignal = globalController.signal;

  const browerPromises = [];
  for (const browserName of browserNames) {
    logger.debug('get_browser', browserName);
    const browserFn = browsers[browserName] || config?.browsers?.[browserName];
    if (typeof browserFn !== 'function') {
      throw new Error('Unknown browser ' + browserName);
    }
    for (const server of servers) {
      // Each launchBrowser() returns a Promise that settles when the browser exits.
      // Launch concurrently, and await afterwards.
      browerPromises.push(server.launchBrowser(browserFn, browserName, globalSignal));
    }
  }

  try {
    // Wait for all tests and browsers to finish/stop, regardless of errors thrown,
    // to avoid dangling browser processes.
    await Promise.allSettled(browerPromises);

    // Re-wait, this time letting the first of any errors bubble up.
    for (const browerPromise of browerPromises) {
      await browerPromise;
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
  // TODO: Return an event emitter for custom reporting via programmatic use.
  return 0;
}

export default {
  run,

  browsers,
  LocalBrowser: browsers.LocalBrowser,
};
