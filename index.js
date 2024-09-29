'use strict';

import cp from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import stream from 'node:stream';
import util from 'node:util';

import kleur from 'kleur';
import tapFinished from '@tapjs/tap-finished';

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
  woff: 'font/woff'
};

class ControlServer {
  static nextServerId = 0;
  static nextClientId = 1;

  constructor (root, testFile, logger) {
    this.constructor.nextServerId++;

    if (!root) {
      // For `qtap test/index.html`, default root to cwd.
      root = process.cwd();
      const relPath = path.relative(root, path.join(root, testFile));
      const parent = relPath.match(/^[./\\]+/)?.[0];
      // For `qtap ../foobar/test/index.html`, default root to ../foobar.
      if (parent) {
        root = path.join(root, parent);
      }
    }

    this.root = root;
    this.testFile = testFile;
    this.browsers = new Map();
    this.logger = logger.channel('qtap_server_' + this.constructor.nextServerId);
    // Optimization: Prefetch test file in parallel with http.Server#listen.
    this.testFilePromise = this.fetchTestFile(this.testFile);

    const server = http.createServer();
    this.proxyBase = null;
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
      try {
        const url = new URL(this.proxyBase + req.url);
        this.logger.debug('request_url', req.url);
        switch (url.pathname) {
          case '/.qtap/tap/':
            this.handleTap(req, url, resp);
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
      // Strictly "call only once"
      this.close = null;
    };
  }

  /** @return {string} HTML */
  async fetchTestFile (file) {
    // As of Node.js 21, fetch() does not yet support file URLs.
    return this.isURL(file)
      ? (await (await fetch(file)).text())
      : (await fsPromises.readFile(file)).toString();
  }

  async getTestFile (clientId) {
    /* eslint-disable no-undef -- Browser code */
    const qtapInitFunctionStr = function qtapInit () {
      // Support QUnit 2.16 - 2.22: Enable TAP reporter.
      // In QUnit 3.0+, we do this declaratively qunit_config_reporters_tap.
      if (typeof QUnit !== 'undefined' && QUnit.reporters && QUnit.reporters.tap && (!QUnit.config.reporters || !QUnit.config.reporters.tap)) {
        QUnit.reporters.tap.init(QUnit);
      }

      let qtapBuffer = '';
      let qtapSendNext = true;
      const qtapConsoleLog = console.log;

      function qtapSend () {
        const body = qtapBuffer;
        qtapBuffer = '';
        qtapSendNext = false;

        const xhr = new XMLHttpRequest();
        xhr.onload = xhr.onerror = () => {
          qtapSendNext = true;
          if (qtapBuffer) {
            qtapSend();
          }
        };
        xhr.open('POST', '{{QTAP_URL}}', true);
        xhr.send(body);
      }

      console.log = function qtapLog (str) {
        if (typeof str === 'string') {
          qtapBuffer += str + '\n';
          // Considerations:
          // - Fixed debounce, e.g. setTimeout(send,200).
          //   Downside: Delays first response by 200ms. And server could
          //   receive out-of-order, thus requires an ordering mechanism.
          // - Fixed throttle, e.g. send(), setTimeout(..,200).
          //   Downside: First response is just "TAP version" and first real
          //   result still delayed by 200ms. Plus, out-of-order concern.
          // - send() now + XHR.onload to dictate when to send the next buffer.
          //   This "dynamic" interval is in theory slower than needed, by waiting
          //   for full RTT instead of only receipt, but receipt is unknowable.
          //   In practice this is quicker than anything else, and avoids concerns.
          //   Downside: First response is still just "TAP version".
          // Actual:
          // - setTimeout(send,0) now + XHR.onload to dictate frequency.
          //   The first chunk will include everything from the same synchronous
          //   chunk executed by test runner, thus at least one real result.
          //   Waiting for XHR.onload is naturally ordered, and optimal throttling.
          if (qtapSendNext) {
            qtapSendNext = false;
            setTimeout(qtapSend, 0);
          }
        }
        return qtapConsoleLog.apply(this, arguments);
      };
      /* eslint-enable no-undef */
    }
      .toString()
      .replace(/\/\/.+$/gm, '')
      .replace(/\n|^\s+/gm, ' ')
      .replace(
        "'{{QTAP_URL}}'",
        JSON.stringify(await this.getProxyBase() + '/.qtap/tap/?qtap_clientId=' + clientId)
      );

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
      /^/
    ],
    (m) => m + `<base href="${this.escapeHTML(base)}"/><script>window.qunit_config_reporters_tap = true;</script>`
    );

    html = this.replaceOnce(html, [
      /<\/body>(?![\s\S]*<\/body>)/i,
      /<\/html>(?![\s\S]*<\/html>)/i,
      /$/
    ],
    (m) => '<script>(' + qtapInitFunctionStr + ')();</script>' + m
    );

    return html;
  }

  async handleStatic (req, url, resp) {
    const filePath = path.join(this.root, url.pathname);
    const ext = path.extname(url.pathname).slice(1);
    if (!filePath.startsWith(this.root)) {
      // Disallow outside directory traversal
      this.logger.debug('respond_static_deny', url.pathname);
      return this.serveError(resp, 403, 'Forbidden');
    }

    const clientId = url.searchParams.get('qtap_clientId');
    if (url.pathname === '/' && clientId !== null) {
      this.logger.debug('respond_static_testfile', clientId);
      resp.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || MIME_TYPES.html });
      resp.write(await this.getTestFile(clientId));
      resp.end();
      return;
    }

    if (!fs.existsSync(filePath)) {
      this.logger.debug('respond_static_notfound', filePath);
      return this.serveError(resp, 404, 'Not Found');
    }

    this.logger.debug('respond_static_pipe', filePath);
    resp.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || MIME_TYPES.bin });
    fs.createReadStream(filePath)
      .on('error', (err) => {
        this.logger.warning('respond_static_pipe_error', err);
        resp.end();
      })
      .pipe(resp);
  }

  handleTap (req, url, resp) {
    let body = '';
    req.on('data', (data) => {
      body += data;
    });
    req.on('end', () => {
      // Support QUnit 2.x: Strip escape sequences for tap-parser and tap-finished.
      // Fixed in QUnit 3.0 with https://github.com/qunitjs/qunit/pull/1801.
      // eslint-disable-next-line no-control-regex
      body = body.replace(/\x1b\[[0-9]+m/g, '');
      const clientId = url.searchParams.get('qtap_clientId');
      this.logger.debug('browser_tap', clientId, body.slice(0, 10) + '…' + body.slice(-10));
      const browser = this.browsers.get(clientId);
      if (browser) {
        browser.readableController.enqueue(body);
      }
    });
    resp.writeHead(204);
    resp.end();

    // TODO: Pipe to one of two options, based on --reporter:
    // - [tap | default in piped and CI?]: tap-parser + some kind of renumbering or prefixing.
    //   client_1> ok 40 foo > bar
    //   out> ok 1 - qtap > Firefox (client_1) connected! Running test/index.html.
    //   out> ok 42 - foo > bar
    //   -->
    //   client_1> ok 40 foo > bar
    //   client_2> ok 40 foo > bar
    //   out> ok 1 - qtap > Firefox (client_1) connected! Running test/index.html.
    //   out> ok 2 - qtap > Chromium (client_2) connected! Running test/index.html.
    //   out> ok 81 - foo > bar [Firefox client_1]
    //   out> ok 82 - foo > bar [Chromium client_2]
    // - [minimal|default in interactive mode]
    //   out> Testing /test/index.html
    //   out>
    //   out> [Firefox client_1] [blue *spinner] Running test 40.
    //   out> [Chromium client_2] [grey] [star] [grey] Launching...
    //   out> [Safari client_3] [grey] [star] [grey] Launching...
    //   -->
    //   out> Testing /test/index.html
    //   out>
    //   out> [Firefox client_1]: ✔ [green] Completed 123 tests in 42ms.
    //   out> [Chromium client2]: [blue*spinner] Running test 40.
    //   out> [Safari client_3] [grey] [star] [grey] Launching...
    //   -->
    //   out> Testing /test/index.html
    //   out>
    //   out> not ok 40 foo > bar # Chromium client_2
    //   out> ---
    //   out> message: failed
    //   out> actual  : false
    //   out> expected: true
    //   out> stack: |
    //   out>   @/example.js:46:12
    //   out> ...
    //   out>
    //   out> [Firefox client_1]: ✔ [green] Completed 123 tests in 42ms.
    //   out> [Chromium client_2]: ✘ [red] 2 failures.
    //
    //   If minimal is selected explicilty in piped/non-interactive/CI mode,
    //   then it will have no spinners, and also lines won't overwrite each other.
    //   Test counting will be disabled along with the spinner so instead we'll print:
    //   out> Firefox client_1: Launching...
    //   out> Firefox client_1: Running tests... [= instead of spinner/counter]
    //   out> Firefox client_1: Completed 123 tets in 42ms.

    // "▓", "▒", "░" // noise, 100
    // "㊂", "㊀", "㊁" // toggle10, 100
    // await new Promise(r=>setTimeout(r,100)); process.stdout.write('\r' + frames[i % frames.length] + '     ');
    // writable.isTTY
    // !process.env.CI

    //   Default: TAP where each browser is 1 virtual test in case of success.
    //   Verbose: TAP forwarded, test names prepended with [browsername].
    //   Failures are shown either way, with prepended names.
    // TODO: On "runEnd", report runtime
    //   Default: No-op, as overall TAP line as single test (above) can contain runtime
    //   Verbose: Output comment indicatinh browser done, and test runtime.
  }

  /**
   * @param {node:http.ServerResponse} resp
   * @param {number} statusCode
   * @param {string|Error} e
   */
  serveError (resp, statusCode, e) {
    if (!resp.headersSent) {
      resp.writeHead(statusCode, { 'Content-Type': MIME_TYPES.txt });
      resp.write((e.stack || String(e)) + '\n');
    }
    resp.end();
  }

  async launchBrowser (browser) {
    const clientId = 'client_' + this.constructor.nextClientId++;
    const url = await this.getProxyBase() + '/?qtap_clientId=' + clientId;

    const controller = new AbortController();

    let readableController;
    const readable = new ReadableStream({
      start (controller) {
        readableController = controller;
      }
    });

    this.browsers.set(clientId, {
      controller,
      readableController
    });

    const tapFinishFinder = tapFinished({ wait: 0 }, () => {
      this.logger.debug('browser_tap_finished', clientId);
      // Re-retrieve it to prevent races and reduce held references
      const browserData = this.browsers.get(clientId);
      if (!browserData) {
        this.logger.warning('browser_already_gone', clientId);
      } else {
        browserData.controller.abort('qtap requested browser stop');
      }
      this.browsers.delete(clientId);
    });

    const readableForFinished = readable;
    // // Debugging
    // const [readableForFinished, readeableForParser] = readable.tee();
    // import('tap-parser').then(function (tapParser) {
    //   const p = tapParser.default();
    //   readeableForParser.pipeTo(stream.Writable.toWeb(p));
    //   p.on('assert', console.log.bind(console, 'assert'));
    //   p.on('plan', console.log.bind(console, 'plan'));
    // });

    readableForFinished.pipeTo(stream.Writable.toWeb(tapFinishFinder));

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

  async getProxyBase () {
    return this.proxyBase || await this.proxyBasePromise;
  }

  isURL (file) {
    return file.startsWith('http:') || file.startsWith('https:');
  }

  escapeHTML (text) {
    return text.replace(/['"<>&]/g, (s) => {
      switch (s) {
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

  replaceOnce (input, patterns, replacement) {
    for (const pattern of patterns) {
      if (pattern.test(input)) {
        return input.replace(pattern, replacement);
      }
    }
    return input;
  }
}

class BaseBrowser {
  static getBrowser (name, logger) {
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

  constructor (logger) {
    this.logger = logger.channel('qtap_browser_' + this.constructor.name);
    this.executable = this.getExecutable(process.platform);
  }

  getExecutable (platform) {
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

  /**
   * @param {string[]} args
   * @param {string} clientId
   * @param {string} url
   * @param {AbortSignal} signal
   * @return {Promise}
   */
  async startExecutable (args, clientId, url, signal) {
    const exe = this.executable;
    if (!exe) {
      throw new Error('No executable found');
    }
    const logger = this.logger.channel(`qtap_browser-${this.constructor.name}-${clientId}`);

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
   * @return {Promise}
   */
  async launch (clientId, url, signal) {
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
  }
}

class FirefoxBrowser extends BaseBrowser {
  * getCandidates (platform) {
    if (platform === 'darwin') {
      if (process.env.HOME) yield process.env.HOME + '/Applications/Firefox.app/Contents/MacOS/firefox';
      yield '/Applications/Firefox.app/Contents/MacOS/firefox';
    }
  }

  async launch (clientId, url, signal) {
    // Use mkdtemp (instead of only tmpdir) so that multiple qtap procesess don't clash.
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qtap_' + clientId + '_'));
    // TODO: Launch with --headless.
    const args = [url, '-profile', profileDir, '-no-remote', '-wait-for-browser'];
    try {
      await this.startExecutable(args, clientId, url, signal);
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  }
}

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
    const browser = BaseBrowser.getBrowser(browserName, logger);
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
