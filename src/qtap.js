'use strict';

import { EventEmitter } from 'node:events';
import path from 'node:path';
import url from 'node:url';
import util from 'node:util';

import browsers from './browsers.js';
import reporters from './reporters.js';
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
          printDebug(util.styleText('grey', `[${prefix}] ${util.styleText('bold', messageCode)} ${paramsFmt(params)}`));
        },
      warning: !verbose
        ? function () {}
        : function warning (messageCode, ...params) {
          printDebug(util.styleText('yellow', `[${prefix}] WARNING ${util.styleText('bold', messageCode)}`) + ` ${paramsFmt(params)}`);
        }
    };
  }

  return channel(defaultChannel);
}

/**
 * @typedef {((
 *  url: string,
 *  signals: Object<string,AbortSignal>,
 *  logger: Logger,
 *  debugMode: boolean
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
 * @property {number} [idleTimeout=5] How long a browser may be quiet between results.
 * @property {number} [connectTimeout=60] How many seconds a browser may take to start up.
 * @property {boolean} [debugMode=false]
 * @property {boolean} [verbose=false]
 * @property {string} [reporter="none"]
 * @property {string} [cwd=process.cwd()] Base directory to interpret test file paths
 *  relative to. Ignored if testing from URLs.
 * @property {Function} [printDebug=console.error]
 */

/**
 * @param {string|string[]} browserNames One or more browser names, referring either
 *  to a built-in browser from QTap, or to a key in the optional `config.browsers` object.
 * @param {string|string[]} files Files and/or URLs.
 * @param {qtap.RunOptions} [runOptions]
 * @return {EventEmitter}
 */
function run (browserNames, files, runOptions = {}) {
  if (typeof browserNames === 'string') browserNames = [browserNames];
  if (typeof files === 'string') files = [files];
  const options = {
    cwd: process.cwd(),
    idleTimeout: 5,
    connectTimeout: 60,
    debugMode: false,
    ...runOptions
  };

  const logger = makeLogger(
    'qtap_main',
    options.printDebug || console.error,
    options.verbose
  );
  const eventbus = new EventEmitter();

  if (options.reporter) {
    if (options.reporter in reporters) {
      logger.debug('reporter_init', options.reporter);
      reporters[options.reporter](eventbus);
    } else {
      logger.warning('reporter_unknown', options.reporter);
    }
  }

  const servers = [];
  for (const file of files) {
    servers.push(new ControlServer(file, eventbus, logger, options));
  }

  const runPromise = (async () => {
    // TODO: Add test for config file not found
    // TODO: Add test for config file with runtime errors
    // TODO: Add test for relative config file without leading `./`, handled by process.resolve()
    let config;
    if (typeof options.config === 'string') {
      logger.debug('load_config', options.config);
      // Support Windows: Unlike require(), import() also both file paths and URLs.
      // Windows file paths are mistaken for URLs ("C:" is protocol-like), and must
      // thus be converted to file:// URLs first.
      const configFileUrl = url.pathToFileURL(path.resolve(options.cwd, options.config)).toString();
      config = (await import(configFileUrl)).default;
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

    const finish = {
      ok: true,
      exitCode: 0,
      bails: {},
      results: {}
    };
    eventbus.on('bail', (event) => {
      finish.ok = false;
      finish.exitCode = 1;
      finish.bails[event.clientId] = event;
    });
    eventbus.on('result', (event) => {
      if (!event.ok) {
        finish.ok = false;
        finish.exitCode = 1;
      }
      finish.results[event.clientId] = event;
    });

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

    eventbus.emit('finish', finish);
  })();
  runPromise.catch((error) => {
    // Node.js automatically ensures users cannot forget to listen for the 'error' event.
    // For this reason, runWaitFor() is a separate method, because that converts the
    // 'error' event into a rejected Promise. If we created that Promise as part of run()
    // like `return {eventbus, promise}`), then we loose this useful detection, because
    // we'd have already listened for it. Plus, it causes an unhandledRejection error
    // for those that only want the events and not the Promise.
    eventbus.emit('error', error);
  });

  return eventbus;
}

/**
 * Same as run() but can awaited.
 *
 * Use this if all you want is a boolean result and/or if you use the 'reporter'
 * option for any output/display. For detailed events, call run() instead.
 *
 * @return {Promise<{ok: boolean, exitCode: number}>}
 * - ok: true for success, false for failure.
 * - exitCode: 0 for success, 1 for failure.
 */
async function runWaitFor (browserNames, files, options = {}) {
  const eventbus = run(browserNames, files, options);

  const result = await new Promise((resolve, reject) => {
    eventbus.on('finish', resolve);
    eventbus.on('error', reject);
  });
  return result;
}

export default {
  run,
  runWaitFor,

  browsers,
  LocalBrowser: browsers.LocalBrowser,
};
