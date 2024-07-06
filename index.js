'use strict';

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import util from 'node:util';
import os from 'node:os';
import cp from 'node:child_process';

import kleur from 'kleur';

// TODO: Merge TAP streams from browsers into one unified output
// import TapReporter from '../src/reporters/TapReporter.mjs';
// TODO: tap-parser? TapReporter?

const MIME_TYPES = {
  bin: 'application/octet-stream',
  css: 'text/css; charset=utf-8',
  gif: 'image/gif',
  htm: 'text/html; charset=utf-8',
  html: 'text/html; charset=utf-8',
  jpe: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  png: 'image/png',
  svg: 'image/svg+xml',
  ttf: 'font/sfnt',
  txt: 'text/plain; charset=utf-8',
  woff2: 'application/font-woff2',
  woff2: 'font/woff2',
  woff: 'font/woff',
};

function makeLogger(defaultChannel, printError, printDebug = null) {
  function channel (prefix) {
    return {
      channel: channel,
      debug: !printDebug ? function () {} : function debug (messageCode, ...params) {
        const paramsFmt = params.flat().map(param => util.inspect(param, { colors: false })).join(' ');
        printDebug(kleur.grey(`[DEBUG] ${prefix}: ${messageCode} ${paramsFmt}`));
      },
      warning: function warning (messageCode, ...params) {
        const paramsFmt = params.flat().map(param => util.inspect(param, { colors: true })).join(' ');
        printError(kleur.yellow(`[WARNING] ${prefix}: ${messageCode} ${paramsFmt}`));
      }
    };
  };

  return channel(defaultChannel);
}

class ControlServer {
  static nextServerId = 1
  static nextClientId = 1
  testFile
  browsers
  testFilePromise
  proxyBase
  proxyBasePromise

  constructor (root, testFile, logger) {
    this.root = root || process.cwd()
    this.testFile = testFile;
    // Prefetching the test file in parallel with http.Server#listen.
    this.testFilePromise = this.fetchTestFile(this.testFile);
    this.browsers = new Map();
    this.logger = logger.channel('qbrow_server-' + this.constructor.nextServerId);
    this.constructor.nextServerId++;

    const server = http.createServer();
    this.proxyBasePromise = new Promise((resolve) => {
      server.on('listening', () => {
        this.proxyBase = 'http://localhost:' + server.address().port;
        this.logger.debug('listening', this.proxyBase, this.testFile);
        resolve(this.proxyBase);
      });
    });

    /**
     * @param {node:http.IncomingMessage} req
     * @param {node:http.ServerResponse} resp
     */
    server.on('request', async (req, resp) => {
      // Extract path and query parameters
      try {
        const url = new URL(this.proxyBase + req.url);
        this.logger.debug('request_url', req.url);
        switch (url.pathname) {
        case '/.qbrow/tap/':
          this.handleTap(req, url, resp);
          break;
        case '/.qbrow/stop/':
          this.handleStop(req, url, resp);
          break;
        default:
          this.handleStatic(req, url, resp);
        }
      } catch (e) {
        this.logger.warning('respond_uncaught', e);
        this.serveError(resp, 500, e);
      }
    });

    // Start the server in the background on a random available port
    server.listen();

    this.close = () => {
      this.logger.debug('http_close');
      server.close();
      server.closeAllConnections();
      this.close = null;
    };
  }

  async getProxyBase() {
    return this.proxyBase || await this.proxyBasePromise;
  }

  isURL(file) {
    return file.startsWith('http:') || file.startsWith('https:');
  }

  escapeHTML(text) {
    return text.replace(/['"<>&]/g, ( s ) => {
      switch ( s ) {
        case '\'':
          return '&#039;';
        case '"':
          return '&quot;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '&':
          return '&amp;';
      }
    });
  }

  replaceOnce(input, patterns, replacement) {
    for (const pattern of patterns) {
      if (pattern.test(input)) {
        return input.replace(pattern, replacement);
      }
    }
    return input;
  }

  /** @return {string} HTML */
  async fetchTestFile (file) {
    // As of Node.js 21, fetch() does not yet support file URLs.
    return this.isURL(file)
        ? (await (await fetch(file)).text())
        : (await fsPromises.readFile(file)).toString();
  }

  async getTestFile (clientId) {
    // TODO: eslint-ignore this function, browser env, XMLHttpRequest
    const inlineTapScript = (function qbrowTap() {
      QUnit.reporters.tap.init(QUnit);

        var xhr = new XMLHttpRequest();
        xhr.open(
          'GET',
          '{{STOP_URL}}',
          true
        );
        xhr.send();
    })
      .toString()
      .replace(
        "'{{STOP_URL}}'",
        JSON.stringify(await this.getProxyBase() + '/.qbrow/stop/?qbrow_clientId=' + clientId)
      )
      .replace(/\n|^\s+/gm, ' ');
    const inlineStopScript = (function qbrowStop() {
        var xhr = new XMLHttpRequest();
        xhr.open(
          'GET',
          '{{STOP_URL}}',
          true
        );
        xhr.send();
    })
      .toString()
      .replace(
        "'{{STOP_URL}}'",
        JSON.stringify(await this.getProxyBase() + '/.qbrow/stop/?qbrow_clientId=' + clientId)
      )
      .replace(/\n|^\s+/gm, ' ');

    const base = this.isURL(this.testFile)
      ? this.testFile
      // normalize to a path from the browser perspective relative to the web root
      // especially if it was originally given as an absolute filesystem path
      : path.relative(this.root, path.join(this.root, this.testFile));

    let html = await this.testFilePromise;

    // Inject <base> tag so that /test/index.html can refer to files relative to it,
    // and URL-based files can fetch their resources directly from the original server.
    // * Prepend as early as possible. If the file has its own <base>, theirs will
    //   come later and correctly "win" by applying last (after ours).
    // * Use a callback, to avoid accidental $1 substitutions via user input.
    // * Insert no line breaks, to avoid changing line numbers.
    // * Ignore <heading> and <head-thing>.
    // * Support <head x=y>, including with tab or newline.
    html = this.replaceOnce(html, [
        /<head(?:\s[^>]*)?>/i,
        /<html(?:\s[^>]*)?/i,
        /<!doctype[^>]*>/i,
        /^/,
      ],
      (m) => m + `<base href="${this.escapeHTML(base)}"/>`
    );

    // Injecting our script to collect TAP results and know when to stop
    // await this.getProxyBase() + '/.qbrow/tap/?qbrow_clientId=' + clientId;
    //

    // TODO: Instead of sending "stop" from client (and thus need to call
    // QUnit.done, or parse tap client-side), let the server simply stop
    // the browser process once it has received the end a TAP stream.
    html = this.replaceOnce(html, [
        /<\/body>(?![\s\S]*<\/body>)/i,
        /<\/html>(?![\s\S]*<\/html>)/i,
        /$/,
      ],
      (m) => '<script> QUnit.done(' + inlineStopScript + ');</script>' + m
    );

    return html;
  }

  async handleStatic(req, url, resp) {
    const filePath = path.join(this.root, url.pathname);
    const ext = path.extname(url.pathname).slice(1);
    if (!filePath.startsWith(this.root)) {
      // Disallow outside directory traversal
      this.logger.debug('respond_static_deny', url.pathname);
      return this.serveError(resp, 403, 'Forbidden');
    }

    const clientId = url.searchParams.get('qbrow_clientId');
    if (url.pathname === '/' && clientId !== null) {
      this.logger.debug('respond_static_testfile', clientId);
      resp.writeHead(200, {'Content-Type': MIME_TYPES[ext] || MIME_TYPES.html});
      resp.write(await this.getTestFile(clientId));
      resp.end();
      return;
    }

    if (!fs.existsSync(filePath)) {
      this.logger.debug('respond_static_notfound', filePath);
      return this.serveError(resp, 404, 'Not Found');
    }

    this.logger.debug('respond_static_pipe', filePath);
    resp.writeHead(200, {'Content-Type': MIME_TYPES[ext] || MIME_TYPES.bin});
    fs.createReadStream(filePath)
      .on('error', (err) => {
        this.logger.warning('respond_static_pipe_error', err);
        resp.end();
      })
      .pipe(resp);
  }

  handleTap(req, url, resp) {
      let body = '';
      req.on('data', (data) => {
        body += data;
      });
      req.on('end', () => {
        this.logger.debug('tap', '\n', body);
      });
      resp.writeHead(204);
      resp.end();

      // const clientId = …
      // TODO: Feed to TAP reporter.
      // TODO: Verbose mode?
      //   Default: TAP where each browser is 1 virtual test in case of success.
      //   Verbose: TAP forwarded, test names prepended with [browsername].
      //   Failures are shown either way, with prepended names.
      // TODO: On "runEnd", report runtime
      //   Default: No-op, as overall TAP line as single test (above) can contain runtime
      //   Verbose: Output comment indicatinh browser done, and test runtime.
      // TODO: On "runEnd" call browser.stop();
  }

  handleStop(req, url, resp) {
      resp.writeHead(204);
      resp.end();

      const clientId = url.searchParams.get('qbrow_clientId');
      this.logger.debug('browser_stop', clientId);
      if (!this.browsers.get(clientId)) {
        this.logger.warning('browser_already_gone', clientId);
      }
      this.browsers.get(clientId)?.abort('qbrow requested stop');
      this.browsers.delete(clientId);
  }

  /**
   * @param {node:http.ServerResponse} resp
   * @param {number} statusCode
   * @param {string|Error} e
   */
  serveError(resp, statusCode, e) {
    if (!resp.headersSent) {
      resp.writeHead(statusCode, {'Content-Type': MIME_TYPES.txt});
      resp.write((e.stack || String(e)) + '\n');
    }
    resp.end();
  }

  async launchBrowser (browser) {
    const clientId = 'client_' + this.constructor.nextClientId++;
    const url = await this.getProxyBase() + '/?qbrow_clientId=' + clientId;
    const controller = new AbortController();
    this.browsers.set(clientId, controller);
    try {
      this.logger.debug('browser_launch', clientId, browser.constructor.name);
      await browser.launch(clientId, url, controller.signal);
      this.logger.debug('browser_exit', clientId);
    } catch (err) {
      // TODO: Report failure to TAP
      this.logger.warning('browser_error', err);
      this.browsers.delete(clientId);
    }
  }
}

class BaseBrowser {
  static getBrowser(name, logger) {
    const _chromium = [];
    const _chrome = [];
    const _edge = [];
    const localBrowsers = {
      firefox: FirefoxBrowser,
      safari: [],
      chromium: [],
      chrome: [],
      edge: []
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
  constructor(logger) {
    this.logger = logger.channel('qbrow_browser-' + this.constructor.name);
    this.executable = this.getExecutable(process.platform);
  }
  getExecutable(platform) {
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

  getArguments(clientId, url) {
    return [url];
  }

  /**
   * @param {string} clientId
   * @param {string} url
   * @param {AbortSignal} signal
   * @return {Promise}
   */
  async startExecutable(clientId, url, signal) {
    const exe = this.executable;
    if (!exe) {
      throw new Error('No executable found');
    }
    const args = this.getArguments(clientId, url);
    const logger = this.logger.channel(`qbrow_browser-${this.constructor.name}-${clientId}`);

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

  *getCandidates(platform) {
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
  async launch(clientId, url, signal) {
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
   * of the qbrow process.
   */
  async cleanupOnce() {
  }
}

class LocalBrowser extends BaseBrowser {
  async launch(clientId, url, signal) {
    await this.startExecutable(clientId, url, signal);
  }
}

class FirefoxBrowser extends LocalBrowser {
  *getCandidates(platform) {
    if (platform === 'darwin') {
      if (process.env.HOME) yield process.env.HOME + '/Applications/Firefox.app/Contents/MacOS/firefox';
      yield '/Applications/Firefox.app/Contents/MacOS/firefox';
    }
  }

  getArguments(clientId, url) {
    const tempDir = path.join(os.tmpdir(), 'qbrow-' + clientId);
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.mkdirSync(tempDir, { recursive: true });
    const profileDir = tempDir;
    // TODO: Launch with --headless.
    return [url, '-profile', profileDir, '-no-remote', '-wait-for-browser'];
  }
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
async function run(browser, files, options) {
  // TODO: Add support for .json browser description.
  // Or, instead of JSON, it can be an importable JS file.
  // Caller decides what modules to import etc. Inspired by ESLint FlatConfig.
  const browserNames = browser.startsWith('./')
    ? JSON.parse(fs.readFileSync(browser))
    : browser.split(',');
  const logger = makeLogger(
    'qbrow_main',
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
    const browser = BaseBrowser.getBrowser(browserName, logger);
    browsers.push(browser);
    for (const server of servers) {
      browserLaunches.push(server.launchBrowser(browser));
    }
  }

  // Wait for results and then stop what whatever we started to let Node.js exit.
  try {
    await Promise.allSettled(browserLaunches);
  } finally {
    // Avoid dangling browser processes. Even if the above throws,
    // still let each server exit the browsers it launched
    for (const server of servers) {
      server.close();
    }
    for (const browser of browsers) {
      await browser.cleanupOnce();
    }
  }

  // TODO: Return exit status
  // TODO: Allow controlling where stdout goes
  // TODO: Allow controlling if setting exit status or not, e.g. when used progammatically.
}

export default {
  run
};

/*
    req.onreadystatechange = function () {
      if (req.readyState==4)
        cb(req.responseText);
    };
    var data;
    if(window.CircularJSON) {
      data = window.CircularJSON.stringify(json);
    } else {
      data = JSON.stringify(json);
    }
    req.open("POST", url, true);
    req.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
    req.setRequestHeader('X-Browser-String', BrowserStack.browser_string);
    req.setRequestHeader('X-Worker-UUID', BrowserStack.worker_uuid);
    req.setRequestHeader('Content-type', 'application/json');
    req.send(data);
  }
*/
// const urls = program.args.map(
//   (file) => ( file.startsWith('http:') || file.startsWith('https:') )
//     ? file
//     // expand relative to this.root and format as file:/// URL
//     : url.pathToFileURL(file).toString()
// );
