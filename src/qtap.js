'use strict';

import fs from 'node:fs';
import util from 'node:util';

import kleur from 'kleur';

import { ControlServer } from './server.js';
import { Browser } from './browsers.js';

function makeLogger (defaultChannel, printError, printDebug = null) {
  function channel (prefix) {
    return {
      channel,
      debug: !printDebug
        ? function () {}
        : function debug (messageCode, ...params) {
          const paramsFmt = params.flat().map(param => util.inspect(param, { colors: false })).join(' ');
          printDebug(kleur.grey(`[${prefix}] ${messageCode} ${paramsFmt}`));
        },
      warning: function warning (messageCode, ...params) {
        const paramsFmt = params.flat().map(param => util.inspect(param, { colors: true })).join(' ');
        printError(kleur.yellow(`[${prefix}] WARNING ${messageCode} ${paramsFmt}`));
      }
    };
  }

  return channel(defaultChannel);
}

/**
 * @param {string} browser One or more comma-separated local browser names,
 *  or path starting with "./" to a JSON file.
 * @param {string[]} files Files and/or URLs.
 * @param {Object} [options]
 * @param {boolean} [options.debug=false]
 * @param {Function} [options.printInfo=console.log]
 * @param {Function} [options.printError=console.error]
 * @param {string} [options.root=process.cwd()] Root directory to find files in
 *  and serve up. Ignored if testing from URLs.
 * @return {number} Exit code. 0 is success, 1 is failed.
 */
async function run (browser, files, options) {
  // TODO: Add support for .json browser description.
  // Or, instead of JSON, it can be an importable JS file.
  // Caller decides what modules to import etc. Inspired by ESLint FlatConfig.
  const browserNames = browser.startsWith('./')
    ? JSON.parse(fs.readFileSync(browser))
    : browser.split(',');
  const logger = makeLogger(
    'qtap_main',
    options.printError || console.error,
    options.debug ? console.error : null
  );

  // reporter = reporter || new TapReporter();
  // const expect = 'verbose' ? NaN : (urls.length * browsers.length);
  // TODO: Implement optional plan() method
  // reporter.plan(expect);

  const servers = [];
  for (const file of files) {
    servers.push(new ControlServer(options.root, file, logger));
  }

  // Don't await launchBrowser() now, since each returns a Promise that will
  // not settle until the browser exists. Run concurrently, so add first,
  // then await afterwards.
  const browsers = [];
  const browserLaunches = [];
  for (const browserName of browserNames) {
    const browser = Browser.getBrowser(browserName, logger);
    browsers.push(browser);
    for (const server of servers) {
      browserLaunches.push(server.launchBrowser(browser));
    }
  }

  try {
    // Instead of explicitly exiting here, wait for everything to settle (success
    // and failure alike), and then stop/clean everything so that we can let
    // Node.js naturally exit.
    // TODO: Why? Just await and then forcefully quit, if that's faster?
    // Do we miss out on some hidden clean up if we just await and then return,
    // and call process.exit() in qtap.js?
    await Promise.allSettled(browserLaunches);
    // Await again, so that any error gets thrown accordingly,
    // we don't do this directly because we first want to wait for all tests
    // to complete, success success and failures alike.
    for (const launched of browserLaunches) {
      await launched;
    }
  } finally {
    // Avoid dangling browser processes. Even if the above throws,
    // make sure we  let each server exit (TODO: Why?)
    // and let each browser do clean up (OK, this is useful, rm tmpdir,
    // excpet no, we already take care of that via launch/finallly, unless
    // process.exit bypasses that?)
    for (const server of servers) {
      server.close();
    }
    for (const browser of browsers) {
      await browser.cleanupOnce();
    }
  }

  // TODO: Return exit status, to ease programmatic use and testing.
  // TODO: Add parameter for stdout used by reporters.
}

export default {
  run
};

// const urls = program.args.map(
//   (file) => ( file.startsWith('http:') || file.startsWith('https:') )
//     ? file
//     // expand relative to this.root and format as file:/// URL
//     : url.pathToFileURL(file).toString()
// );
