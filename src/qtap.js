'use strict';

import fs from 'node:fs';
import util from 'node:util';

import kleur from 'kleur';

import { ControlServer } from './server.js';
import browsers from './browsers.js';

function makeLogger (defaultChannel, printError, printDebug = null) {
  const paramsFmt = (params) => params
    .flat()
    .map(param => typeof param === 'string' ? param : util.inspect(param, { colors: false }))
    .join(' ');
  function channel (prefix) {
    return {
      channel,
      debug: !printDebug
        ? function () {}
        : function debug (messageCode, ...params) {
          printDebug(kleur.grey(`[${prefix}] ${kleur.bold(messageCode)} ${paramsFmt(params)}`));
        },
      warning: function warning (messageCode, ...params) {
        printError(kleur.yellow(`[${prefix}] WARNING ${kleur.bold(messageCode)}`) + ` ${paramsFmt(params)}`);
      }
    };
  }

  return channel(defaultChannel);
}

/**
 * @param {string[]} browsers One or more local browser names,
 *  or path starting with "./" to a JSON file.
 * @param {string} files Files and/or URLs.
 * @param {Object} [options]
 * @param {string} [options.config] Path to JS file that exports additional browsers.
 *  User controls how and what modules to import there. Inspired by ESLint FlatConfig.
 * @param {boolean} [options.debug=false]
 * @param {Function} [options.printInfo=console.log]
 * @param {Function} [options.printError=console.error]
 * @param {string} [options.root=process.cwd()] Root directory to find files in
 *  and serve up. Ignored if testing from URLs.
 * @return {number} Exit code. 0 is success, 1 is failed.
 */
async function run (browserNames, files, options) {
  const logger = makeLogger(
    'qtap_main',
    options.printError || console.error,
    options.debug ? console.error : null
  );

  const servers = [];
  for (const file of files) {
    servers.push(new ControlServer(options.root, file, logger));
  }

  let config;
  async function getNonDefaultBrowser (name, options) {
    if (!options.config) {
      return;
    }
    if (!config) {
      config = await import(options.config);
    }
    return config?.browsers?.[name];
  }

  const browserLaunches = [];
  for (const browserName of browserNames) {
    logger.debug('get_browser', browserName);
    const Browser = browsers[browserName] || await getNonDefaultBrowser(browserName, options);
    if (!Browser) {
      throw new Error('Unknown browser ' + browserName);
    }
    const browser = new Browser(logger.channel('qtap_browser_' + browserName));
    for (const server of servers) {
      // Each launchBrowser() returns a Promise that settles when the browser exits.
      // Launch concurrently, and await afterwards.
      browserLaunches.push(server.launchBrowser(browser, browserName));
    }
  }

  try {
    // Instead of calling process.exit(), wait for everything to settle (success
    // and failures alike), and then stop everything we started so that Node.js
    // exits naturally by itself.
    // TODO: Consider just calling process.exit after this await.
    // Is that faster and safe? What if any important clean up would we miss?
    await Promise.allSettled(browserLaunches);
    // Await again, so that any error gets thrown accordingly,
    // we don't do this directly because we first want to wait for all tests
    // to complete, success and failuress alike.
    for (const launched of browserLaunches) {
      await launched;
    }
  } finally {
    // Avoid dangling browser processes. Even if the above throws,
    // make sure we let each server exit (TODO: Why?)
    // and let each browser do clean up (OK, this is useful, rm tmpdir,
    // excpet no, we already take care of that via launch/finallly, unless
    // process.exit bypasses that?)
    for (const server of servers) {
      server.close();
    }
  }

  // TODO: Return exit status, to ease programmatic use and testing.
  // TODO: Add parameter for stdout used by reporters.
}

export default {
  run
};
