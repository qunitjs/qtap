'use strict';

import { EventEmitter } from 'node:events';
import path from 'node:path';
import url from 'node:url';
import util from 'node:util';

import browsers from './browsers.js';
import reporters from './reporters.js';
import { ControlServer } from './server.js';
import { LocalBrowser, QTapError } from './util.js';

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
  if (!files || !files.length) {
    throw new QTapError('Must pass one or more test files to run');
  }
  if (!browserNames || !browserNames.length) {
    throw new QTapError('Must pass one or more browser names or omit for the default');
  }
  // Remove duplicates by using a Set
  files = Array.from(new Set(typeof files === 'string' ? [files] : files));
  browserNames = Array.from(new Set(typeof browserNames === 'string' ? [browserNames] : browserNames));
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
  const globalSignal = globalController.signal;

  // Disable MaxListenersExceededWarning because ControlServer.launchBrowserAndConnect adds
  // an 'error' listener for every browser launch (N test files * N browsers * N retries).
  eventbus.setMaxListeners(0);

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

    if (options.reporter) {
      const reporter = reporters[options.reporter] || config?.reporters?.[options.reporter];
      if (typeof reporter !== 'function') {
        const available = Array.from(new Set([
          ...Object.keys(reporters),
          ...(config?.reporters ? Object.keys(config.reporters) : [])
        ]));
        throw new QTapError(`Unknown reporter ${options.reporter}\n\nAvailable reporters:\n* ${available.join('\n* ')}`);
      }

      logger.debug('reporter_init', options.reporter);

      // Create a safe event listener object, which will:
      // - Catch any errors from reporter functions,
      //   so that emit() is safe in our internal code.
      // - Prevent reporter functions from tampering with the internal eventbus
      //   object (can only call "on", not "emit"; cannot break "on" for other reporters)
      //   to protect integrity of QTap, and other reporters.
      // - Print detailed errors in verbose mode. Any thrown erorrs here are likely
      //   internal to QTap and not reported in detail to users by default.
      // - Re-throw as util.BrowserStopSignal so that ControlServer#launchBrowser
      //   won't retry/rerun tests due to an internal error (likely deterministic).
      const safeEventConsumer = {
        on (event, fn) {
          eventbus.on(event, function () {
            try {
              fn.apply(null, arguments);
            } catch (e) {
              logger.warning('reporter_caught', e);
              // @ts-ignore - TypeScript @types/node lacks `Error(,options)`
              const niceErr = new Error(`The "${options.reporter}" reporter encountered an error in the "${event}" event handler.` + (!options.verbose ? ' Run with --verbose to output a stack trace.' : ''), { cause: e });
              for (const server of servers) {
                server.stopBrowsers(niceErr);
              }
            }
          });
        }
      };
      reporter(safeEventConsumer);
    }

    const browserPromises = [];
    for (const browserName of browserNames) {
      logger.debug('get_browser', browserName);
      const browserFn = browsers[browserName] || config?.browsers?.[browserName];
      if (typeof browserFn !== 'function') {
        const available = Array.from(new Set([
          ...Object.keys(browsers),
          ...(config?.browsers ? Object.keys(config.browsers) : [])
        ]));
        throw new QTapError(`Unknown browser ${browserName}\n\nAvailable browsers:\n* ${available.join('\n* ')}`);
      }
      for (const server of servers) {
        await server.proxyBasePromise;
        // Each launchBrowser() returns a Promise that settles when the browser exits.
        // Launch concurrently, and await afterwards.
        browserPromises.push(server.launchBrowser(browserFn, browserName, globalSignal));
      }
    }

    // The 'clients' event must be emitted:
    // * ... after launchBrowser() and browserFn(), because they may browserFn.displayName
    //       up until their first async logic. This powers the dynamic display name set by
    //       the "detect" browser (to indicate to the selected browser),
    //       and by the BrowserStack plugin (to expand strings like "firefox_latest").
    // * ... early, so that reporters can quickly indicate that the browser is starting.
    // * ... exactly once, regardless of launch retries.
    //
    // Therefore, we must not await browserPromises until after this event is emitted.
    // Therefore, server.launchBrowser and server.launchBrowserAttempt must not have
    // any async logic before it calls browserFn, as otherwise we'd read it too soon.
    const clients = {};
    for (const server of servers) {
      for (const browser of server.browsers.values()) {
        clients[browser.clientId] = {
          clientId: browser.clientId,
          testFile: server.testFile + server.testFileQueryString,
          browserName: browser.browserName,
          displayName: browser.getDisplayName(),
        };
      }
    }
    logger.debug('event_clients', clients);
    eventbus.emit('clients', { clients: clients });

    const finish = {
      ok: true,
      exitCode: 0,
      total: 0,
      passed: 0,
      failed: 0,
      bailout: false
    };
    eventbus.on('clientresult', (event) => {
      finish.total += event.total;
      finish.passed += event.passed;
      finish.failed += event.failed;

      if (finish.ok && !event.ok) {
        finish.ok = false;
        finish.exitCode = 1;
        finish.bailout = event.bailout;
      }
    });

    // If we receive any unrecoverable browser error (i.e. command not found from browserFn,
    // file not found from ControlServer, or browser connect timeout from launchBrowser),
    // then tell other test servers to stop their browsers early.
    // This will be the 'error' event and there is no reporting after that.
    let firstError;
    try {
      await Promise.all(browserPromises);
    } catch (e) {
      firstError = e;
      for (const server of servers) {
        // @ts-ignore - TypeScript @types/node lacks `Error(,options)`
        server.stopBrowsers(new Error('Cancelled because another browser errored', { cause: e }));
      }
    }
    // Re-await for clean shutdown, including for other failed servers
    await Promise.allSettled(browserPromises);
    // Let the first error bubble up
    if (firstError) {
      throw firstError;
    }

    logger.debug('event_finish', finish);
    eventbus.emit('finish', finish);

    if (options.debugMode) {
      console.log('\nKeeping browser open for debugging');
      for (const server of servers) {
        await Promise.all(server.debugBrowserProcesses);
      }
    }
  })();
  runPromise
    .finally(() => {
      logger.debug('runpromise_finally');
      for (const server of servers) {
        server.close();
      }

      // Normally each browerPromise ends with an abort signal (browser.stop) to clean itself.
      // If we're here because a browerPromise errored early, then globalController will also
      // indirectly abort the remaining per-browser controllers and thus avoid any
      // dangling proceses/resources from the other browsers.
      logger.debug('shared_cleanup', 'Invoke global signal to clean up shared resources');
      globalController.abort();
    })
    .catch((error) => {
      logger.warning('runpromise_catch', error);
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
  LocalBrowser,
  QTapError
};
