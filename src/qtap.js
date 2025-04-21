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
 * @param {Function} printVerbose
 * @param {boolean} [verbose]
 * @return {Logger}
 */
function makeLogger (defaultChannel, printVerbose, verbose = false) {
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
          printVerbose(util.styleText('grey', `[${prefix}] ${util.styleText('bold', messageCode)} ${paramsFmt(params)}`));
        },
      warning: !verbose
        ? function () {}
        : function warning (messageCode, ...params) {
          printVerbose(util.styleText('yellow', `[${prefix}] WARNING ${util.styleText('bold', messageCode)}`) + ` ${paramsFmt(params)}`);
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
 *  relative to. Ignored if testing from URLs.
 * @property {string} [cwd=process.cwd()] Base directory to interpret test file paths
 * @property {qtap.Config|string} [config] Config object, or path to a qtap.config.js file.
 * Refer to API.md for how to define additional browsers.
 * @property {number} [idleTimeout=5] How long a browser may be quiet between results.
 * @property {number} [connectTimeout=60] How many seconds a browser may take to start up.
 * @property {string} [reporter="none"]
 * @property {boolean} [debugMode=false]
 * @property {boolean} [verbose=false]
 * @property {Function} [printVerbose=console.error]
 */

/**
 * @param {string|string[]} files Files and/or URLs.
 * @param {string|string[]} [browserNames] One or more browser names, referring either
 *  to a built-in browser from QTap, or (if you provide a config file via `runOptions.config`)
    to a key in your `config.browsers` object.
 * @param {qtap.RunOptions} [runOptions]
 * @return {EventEmitter}
 */
function run (files, browserNames = 'detect', runOptions = {}) {
  if (typeof files === 'string') files = [files];
  if (typeof browserNames === 'string') browserNames = [browserNames];
  if (!files || !files.length) {
    throw new Error('Must pass one or more test files to run');
  }
  if (!browserNames || !browserNames.length) {
    throw new Error('Must pass one or more browser names or omit for the default');
  }
  const options = {
    cwd: process.cwd(),
    idleTimeout: 5,
    connectTimeout: 60,
    debugMode: false,
    printVerbose: console.error,
    ...runOptions
  };
  // If --cwd is set to an relative path, expand it for consistency.
  options.cwd = path.resolve(options.cwd);

  const logger = makeLogger('qtap_main', options.printVerbose, options.verbose);
  const eventbus = new EventEmitter();
  const globalController = new AbortController();

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
    let config;
    if (typeof options.config === 'string') {
      logger.debug('load_config', options.config);
      // Support Windows: Unlike require(), import() accepts both file paths and URLs.
      // Windows file paths are mistaken for URLs ("C:" is protocol-like),
      // and must therefore be converted to a file:// URL first.
      const configFileUrl = url.pathToFileURL(path.resolve(options.cwd, options.config)).toString();
      try {
        config = (await import(configFileUrl)).default;
      } catch (err) {
        /** @type {any} - TypeScript @types/node lacks Error.code */
        const e = err;
        if (e.code === 'ERR_MODULE_NOT_FOUND') {
          // @ts-ignore - TypeScript @types/node lacks `Error(,options)`
          throw new Error('Could not open ' + options.config, { cause: e });
        }
        // @ts-ignore - TypeScript @types/node lacks `Error(,options)`
        throw new Error(`Loading ${options.config} failed: ${String(e)}`, { cause: e });
      }
    }
    const globalSignal = globalController.signal;

    const browerPromises = [];
    for (const browserName of browserNames) {
      logger.debug('get_browser', browserName);
      const browserFn = browsers[browserName] || config?.browsers?.[browserName];
      if (typeof browserFn !== 'function') {
        throw new Error('Unknown browser ' + browserName);
      }
      browserFn.getDisplayName = () => browserFn.displayName || browserName;
      for (const server of servers) {
        // Each launchBrowser() returns a Promise that settles when the browser exits.
        // Launch concurrently, and await afterwards.
        browerPromises.push(server.launchBrowser(browserFn, browserName, globalSignal));
      }
    }

    const finish = {
      ok: true,
      exitCode: 0,
      total: 0,
      passed: 0,
      failed: 0,
      skips: [],
      todos: [],
      failures: [],
      bailout: false
    };
    eventbus.on('bail', (event) => {
      if (finish.ok) {
        finish.ok = false;
        finish.exitCode = 1;
        finish.bailout = event.reason;
      }
    });
    eventbus.on('result', (event) => {
      finish.total += event.total;
      finish.passed += event.passed;
      finish.failed += event.failed;

      if (finish.ok && !event.ok) {
        finish.ok = false;
        finish.exitCode = 1;
        finish.skips = event.skips;
        finish.todos = event.todos;
        finish.failures = event.failures;
      }
    });

    // Wait for all tests and browsers to finish/stop, regardless of errors thrown,
    // to avoid dangling browser processes.
    await Promise.allSettled(browerPromises);

    // Re-await, this time letting the first of any errors bubble up.
    for (const browerPromise of browerPromises) {
      await browerPromise;
    }

    eventbus.emit('finish', finish);
  })();
  runPromise
    .finally(() => {
      for (const server of servers) {
        server.close();
      }

      logger.debug('shared_cleanup', 'Invoke global signal to clean up shared resources');
      globalController.abort();
    })
    .catch((error) => {
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
 * option for any output/display. For detailed real-time events, call run() instead.
 *
 * @return {Promise<{ok: boolean, exitCode: number}>}
 * - ok: true for success, false for failure.
 * - exitCode: 0 for success, 1 for failure.
 */
async function runWaitFor (files, browserNames, options = {}) {
  const eventbus = run(files, browserNames, options);

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
