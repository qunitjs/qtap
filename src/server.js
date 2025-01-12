'use strict';

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { fnToStr, qtapClientHead, qtapClientBody } from './client.js';
import * as util from './util.js';
import tapFinished from './tap-finished.js';
/** @import { Logger } from './qtap.js' */

const QTAP_DEBUG = process.env.QTAP_DEBUG === '1';

class ControlServer {
  static nextServerId = 1;
  static nextClientId = 1;

  /**
   * @param {string|undefined} root
   * @param {string} testFile File path or URL
   * @param {Logger} logger
   * @param {Object} options
   * @param {number|undefined} options.idleTimeout
   * @param {number|undefined} options.connectTimeout
   */
  constructor (root, testFile, logger, options) {
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
    this.logger = logger.channel('qtap_server_' + ControlServer.nextServerId++);
    this.idleTimeout = options.idleTimeout || 30;
    this.connectTimeout = options.connectTimeout || 60;

    this.browsers = new Map();
    // Optimization: Prefetch test file in parallel with server creation and browser launching.
    // Once browsers are running and they make their first HTTP request,
    // we'll await this in handleRequest/getTestFile.
    this.testFilePromise = this.fetchTestFile(this.testFile);

    // Optimization: Don't wait for server to start. Let qtap.js proceed to load config/browsers,
    // and we'll await this later in launchBrowser().
    const server = http.createServer();
    this.proxyBase = '';
    this.proxyBasePromise = new Promise((resolve) => {
      server.on('listening', () => {
        // @ts-ignore - Not null after listen()
        this.proxyBase = 'http://localhost:' + server.address().port;
        this.logger.debug('server_listening', `Serving ${this.testFile} at ${this.proxyBase}`);
        resolve(this.proxyBase);
      });
    });

    /**
     * @param {http.IncomingMessage} req
     * @param {http.ServerResponse} resp
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
            await this.handleRequest(req, url, resp);
        }
      } catch (e) {
        this.logger.warning('respond_uncaught', e);
        this.serveError(resp, 500, /** @type {Error} */ (e));
      }
    });

    // Start the server in the background on a random available port
    server.listen();

    this.close = () => {
      if (this.closeCalled) {
        throw new Error('ControlServer.close must only be called once');
      }
      this.closeCalled = true;

      this.logger.debug('http_close');
      server.close();
      server.closeAllConnections();
    };
  }

  /** @return {Promise<string>} HTML */
  async fetchTestFile (file) {
    // fetch() does not yet support file URLs (as of Node.js 21).
    return this.isURL(file)
      ? (await (await fetch(file)).text())
      : (await fsPromises.readFile(file)).toString();
  }

  async launchBrowser (browserFn, browserName, globalSignal) {
    const clientId = 'client_' + ControlServer.nextClientId++;
    const logger = this.logger.channel(`qtap_browser_${clientId}_${browserName}`);

    // TODO: Remove `summary` in favour of `eventbus`
    const summary = { ok: true };
    let clientIdleTimer = null;

    const controller = new AbortController();
    let signal = controller.signal;
    if (QTAP_DEBUG) {
      // Replace with a dummy signal that we never invoke
      signal = (new AbortController()).signal;
      controller.signal.addEventListener('abort', () => {
        logger.warning('browser_signal_debugging', 'Keeping browser open for debugging');
      });
    }

    // Reasons to stop a browser, whichever comes first:
    // 1. tap-finished.
    // 2. tap-parser 'bailout' event (client knows it crashed).
    // 3. timeout (client didn't start, lost connection, or unknowingly crashed).
    const stopBrowser = async (messageCode) => {
      // Ignore any duplicate or late reasons to stop
      if (!this.browsers.has(clientId)) return;

      clearTimeout(clientIdleTimer);
      this.browsers.delete(clientId);
      controller.abort(`QTap: ${messageCode}`);
    };

    const tapParser = tapFinished({ wait: 0 }, () => {
      logger.debug('browser_tap_finished', 'Test run finished, stopping browser');
      stopBrowser('browser_tap_finished');
    });

    tapParser.on('bailout', (reason) => {
      logger.warning('browser_tap_bailout', `Test run bailed, stopping browser. Reason: ${reason}`);
      summary.ok = false;
      stopBrowser('browser_tap_bailout');
    });
    // Debugging
    // tapParser.on('line', logger.debug.bind(logger, 'browser_tap_line'));
    // tapParser.on('assert', logger.debug.bind(logger, 'browser_tap_assert'));
    // tapParser.once('fail', () => logger.debug('browser_tap_fail', 'Found one or more failing tests'));
    // tapParser.on('plan', logger.debug.bind(logger, 'browser_tap_plan'));

    const browser = {
      logger,
      tapParser,
      clientIdleActive: null,
      getDisplayName () {
        return (browserFn.displayName || browserFn.name || 'Browser').slice(0, 50);
      }
    };
    this.browsers.set(clientId, browser);

    // Optimization: The naive approach would be to clearTimeout+setTimeout on every tap line,
    // in `handleTap()` or `tapParser.on('line')`. But that adds significant overhead from
    // Node.js/V8 natively allocating many timers when processing large batches of test results.
    // Instead, merely store performance.now() and check that periodically.
    // TODO: Write test for --connect-timeout by using a no-op browser.
    const TIMEOUT_CHECK_MS = 1000;
    const browserStart = performance.now();
    const qtapCheckTimeout = () => {
      if (!browser.clientIdleActive) {
        if ((performance.now() - browserStart) > (this.connectTimeout * 1000)) {
          logger.warning('browser_connect_timeout', `Browser did not start within ${this.connectTimeout}s, stopping browser`);
          summary.ok = false;
          stopBrowser('browser_connect_timeout');
          return;
        }
      } else {
        if ((performance.now() - browser.clientIdleActive) > (this.idleTimeout * 1000)) {
          logger.warning('browser_idle_timeout', `Browser idle for ${this.idleTimeout}s, stopping browser`);
          summary.ok = false;
          stopBrowser('browser_idle_timeout');
          return;
        }
      }
      clientIdleTimer = setTimeout(qtapCheckTimeout, TIMEOUT_CHECK_MS);
    };
    clientIdleTimer = setTimeout(qtapCheckTimeout, TIMEOUT_CHECK_MS);

    const url = await this.getProxyBase() + '/?qtap_clientId=' + clientId;
    const signals = { browser: signal, global: globalSignal };

    try {
      logger.debug('browser_launch_call');
      await browserFn(url, signals, logger);

      // This stopBrowser() is most likely a no-op (e.g. if we received test results
      // or some error, and we asked the browser to stop). Just in case the browser
      // ended by itself, call it again here so that we can convey it as an error
      // if it was still running from our POV.
      logger.debug('browser_launch_exit');
      stopBrowser('browser_launch_exit');
    } catch (e) {
      // TODO: Report error to TAP. Eg. "No executable found"
      // TODO: logger.warning('browser_launch_exit', err); but catch in qtap.js?
      if (!signal.aborted) {
        logger.warning('browser_launch_error', e);
        stopBrowser('browser_launch_error');
        throw e;
      }
    }
  }

  async getTestFile (clientId) {
    const proxyBase = await this.getProxyBase();
    const qtapUrl = proxyBase + '/.qtap/tap/?qtap_clientId=' + clientId;

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
    html = util.replaceOnce(html, [
      /<head(?:\s[^>]*)?>/i,
      /<html(?:\s[^>]*)?/i,
      /<!doctype[^>]*>/i,
      /^/
    ],
    (m) => m + `<base href="${util.escapeHTML(base)}"/><script>(${fnToStr(qtapClientHead, qtapUrl)})();</script>`
    );

    html = util.replaceOnce(html, [
      /<\/body>(?![\s\S]*<\/body>)/i,
      /<\/html>(?![\s\S]*<\/html>)/i,
      /$/
    ],
    (m) => '<script>(' + fnToStr(qtapClientBody, qtapUrl) + ')();</script>' + m
    );

    return html;
  }

  async handleRequest (req, url, resp) {
    const filePath = path.join(this.root, url.pathname);
    const ext = path.extname(url.pathname).slice(1);
    if (!filePath.startsWith(this.root)) {
      // Disallow outside directory traversal
      this.logger.debug('respond_static_deny', url.pathname);
      return this.serveError(resp, 403, 'Forbidden');
    }

    const clientId = url.searchParams.get('qtap_clientId');
    if (url.pathname === '/' && clientId !== null) {
      const browser = this.browsers.get(clientId);
      if (browser) {
        browser.clientIdleActive = performance.now();
        browser.logger.debug('browser_connected', `${browser.getDisplayName()} connected! Serving test file.`);
      } else {
        this.logger.debug('respond_static_testfile', clientId);
      }
      resp.writeHead(200, { 'Content-Type': util.MIME_TYPES[ext] || util.MIME_TYPES.html });
      resp.write(await this.getTestFile(clientId));
      resp.end();
      return;
    }

    if (!fs.existsSync(filePath)) {
      this.logger.debug('respond_static_notfound', filePath);
      return this.serveError(resp, 404, 'Not Found');
    }

    this.logger.debug('respond_static_pipe', filePath);
    resp.writeHead(200, { 'Content-Type': util.MIME_TYPES[ext] || util.MIME_TYPES.bin });
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
      // Support QUnit 2.x: Strip escape sequences for tap-parser compatibility.
      // Fixed in QUnit 3.0 with https://github.com/qunitjs/qunit/pull/1801.
      body = util.stripAsciEscapes(body);
      const clientId = url.searchParams.get('qtap_clientId');
      const browser = this.browsers.get(clientId);
      if (browser) {
        const now = performance.now();
        browser.tapParser.write(body);
        browser.logger.debug('browser_tap_received',
          `+${util.humanSeconds(now - browser.clientIdleActive)}s`,
          JSON.stringify(body.slice(0, 30) + '…')
        );

        browser.clientIdleActive = performance.now();
      } else {
        this.logger.debug('browser_tap_unhandled', clientId, JSON.stringify(body.slice(0, 30) + '…'));
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
    //   out> Firefox    : SPINNER [blue]
    //   out>              Running test 40.
    //   out> [Chromium] : [grey] [star] [grey] Launching...
    //   out> [Safari]   : [grey] [star] [grey] Launching...
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
   * @param {http.ServerResponse} resp
   * @param {number} statusCode
   * @param {string|Error} e
   */
  serveError (resp, statusCode, e) {
    if (!resp.headersSent) {
      resp.writeHead(statusCode, { 'Content-Type': util.MIME_TYPES.txt });
      // @ts-ignore - Definition lacks Error.stack
      resp.write((e.stack || String(e)) + '\n');
    }
    resp.end();
  }

  async getProxyBase () {
    return this.proxyBase || await this.proxyBasePromise;
  }

  isURL (file) {
    return file.startsWith('http:') || file.startsWith('https:');
  }
}

export { ControlServer };
