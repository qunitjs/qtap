'use strict';

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import stream from 'node:stream';

import { Parser as TapParser } from 'tap-parser';
import tapFinished from '@tapjs/tap-finished';
import { MIME_TYPES, humanSeconds } from './util.js';

const QTAP_DEBUG = process.env.QTAP_DEBUG === '1';

class ControlServer {
  static nextServerId = 1;
  static nextClientId = 1;

  constructor (root, testFile, logger) {
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
    this.logger = logger.channel('qtap_server_' + this.constructor.nextServerId++);
    // Optimization: Prefetch test file in parallel with server starting and browser launching.
    // Once browsers are launched and they make their first HTTP request,
    // we'll await this in handleRequest/getTestFile.
    this.testFilePromise = this.fetchTestFile(this.testFile);

    const server = http.createServer();
    this.proxyBase = null;

    // Optimization: Allow qtap.js to proceed and load browser functions.
    // We'll await this later in launchBrowser().
    this.proxyBasePromise = new Promise((resolve) => {
      server.on('listening', () => {
        this.proxyBase = 'http://localhost:' + server.address().port;
        this.logger.debug('server_listening', `Serving ${this.testFile} at ${this.proxyBase}`);
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
            await this.handleRequest(req, url, resp);
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

  async launchBrowser (browserFn, browserName) {
    const clientId = 'client_' + this.constructor.nextClientId++;
    const url = await this.getProxyBase() + '/?qtap_clientId=' + clientId;
    const logger = this.logger.channel(`qtap_browser_${browserName}_${clientId}`);

    const controller = new AbortController();
    const summary = { ok: true };

    const CLIENT_IDLE_TIMEOUT = 5000;
    const CLIENT_IDLE_INTERVAL = 1000;
    let clientIdleTimer = null;

    let readableController;
    const readable = new ReadableStream({
      start (readableControllerParam) {
        readableController = readableControllerParam;
      }
    });

    const browser = {
      logger,
      readableController,
      clientIdleActive: performance.now(),
    };
    this.browsers.set(clientId, browser);

    // NOTE: The below does not need to check browsers.get() before
    // calling browsers.delete() or controller.abort() , because both of
    // these are safely idempotent and ignore all but the first call
    // for a given client. Hence no need to guard against race conditions
    // where two reasons may both try to stop the browser.
    //
    // Possible stop reasons, whichever is reached first:
    // 1. tap-finished.
    // 2. tap-parser 'bailout' event (client knows it crashed),
    //    because tap-finished doesn't handle this.
    // 3. timeout after browser has not been idle for too long
    //   (likely failed to start, lost connection, or crashed unknowingly)

    const stopBrowser = async (reason) => {
      clearTimeout(clientIdleTimer);
      this.browsers.delete(clientId);
      controller.abort(reason);
    };

    const tapFinishFinder = tapFinished({ wait: 0 }, () => {
      logger.debug('browser_tap_finished', 'Requesting browser stop');

      stopBrowser('QTap: browser_tap_finished');
    });

    const tapParser = new TapParser();
    tapParser.on('bailout', (reason) => {
      summary.ok = false;
      logger.debug('browser_tap_bailout', reason);

      stopBrowser('QTap: browser_tap_bailout');
    });
    tapParser.once('fail', () => {
      summary.ok = false;
      logger.debug('browser_tap_fail', 'One or more tests failed');
    });
    // Debugging
    // tapParser.on('assert', logger.debug.bind(logger, 'browser_tap_assert'));
    // tapParser.on('plan', logger.debug.bind(logger, 'browser_tap_plan'));

    // TODO: Make timeout configurable, e.g. --timeout=3000s
    //
    // TODO: Consider handling timeout client-side by setting options.timeout to
    // qunit_config_testtimeout in getTestFile() and send a "Bail out!" tap
    // message which makes the server stop the browser.
    // Pro - timeouts are in sync. Con - we still need a "real" timeout
    // on this side.
    //
    // TODO: Dynamically increase this to whatever timeout the client's test framework
    // has set (QUnit, Mocha, Jasmine), with one second tolerance added for delay
    // (network/interprocess) between client and QTap.
    // We could probably read out smth like QUnit.config.testTimeout
    // and collect it via an endpoint like /.qtap/set_timeout?clientId=
    //
    // NOTE: We use performance.now() instead of natively clearTimeout+setTimeout
    // on each event, because that would add significant overhead from Node.js/V8
    // creating tons of timers when processing a large batch of test results back-to-back.
    clientIdleTimer = setTimeout(function qtapClientTimeout () {
      if ((performance.now() - browser.clientIdleActive) > CLIENT_IDLE_TIMEOUT) {
        logger.debug('browser_idle_timeout', 'Requesting browser stop');
        // TODO:
        // Produce a tap line to report this test failure to CLI output/reporters.
        summary.ok = false;
        stopBrowser('QTap: browser_idle_timeout');
      } else {
        clientIdleTimer = setTimeout(qtapClientTimeout, CLIENT_IDLE_INTERVAL);
      }
    }, CLIENT_IDLE_INTERVAL);

    const [readeableForParser, readableForFinished] = readable.tee();
    readeableForParser.pipeTo(stream.Writable.toWeb(tapParser));
    readableForFinished.pipeTo(stream.Writable.toWeb(tapFinishFinder));

    let signal = controller.signal;
    if (QTAP_DEBUG) {
      // Replace with dummy signal that is never aborted
      signal = (new AbortController()).signal;
      controller.signal.addEventListener('abort', () => {
        logger.warning('browser_debugging_abort', 'Keeping browser open for debugging');
      });
    }

    try {
      logger.debug('browser_launch_start');
      await browserFn(url, signal, logger);
      logger.debug('browser_launch_ended');
    } catch (err) {
      // TODO: Report browser_launch_exit to TAP. Eg. "No executable found"
      logger.warning('browser_launch_exit', err);
      this.browsers.delete(clientId);
      throw err;
    }
  }

  async getTestFile (clientId) {
    /* eslint-disable no-undef, no-var -- Browser code */
    function qtapClientHead () {
      // Support QUnit 3.0+: Enable TAP reporter, declaratively.
      window.qunit_config_reporters_tap = true;

      // See ARCHITECTURE.md#qtap-internal-client-send
      var qtapNativeLog = console.log;
      var qtapBuffer = '';
      var qtapShouldSend = true;
      function qtapSend () {
        var body = qtapBuffer;
        qtapBuffer = '';
        qtapShouldSend = false;

        var xhr = new XMLHttpRequest();
        xhr.onload = xhr.onerror = () => {
          qtapShouldSend = true;
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
          if (qtapShouldSend) {
            qtapShouldSend = false;
            setTimeout(qtapSend, 0);
          }
        }
        return qtapNativeLog.apply(this, arguments);
      };

      window.addEventListener('error', function (error) {
        console.log('Script error: ' + (error.message || 'Unknown error'));
      });
    }
    function qtapClientBody () {
      // Support QUnit 2.16 - 2.22: Enable TAP reporter, procedurally.
      if (typeof QUnit !== 'undefined' && QUnit.reporters && QUnit.reporters.tap && (!QUnit.config.reporters || !QUnit.config.reporters.tap)) {
        QUnit.reporters.tap.init(QUnit);
      }
    }
    /* eslint-enable no-undef, no-var */

    const proxyBase = await this.getProxyBase();
    function fnToStr (fn) {
      return fn
        .toString()
        .replace(/\/\/.+$/gm, '')
        .replace(/\n|^\s+/gm, ' ')
        .replace(
          "'{{QTAP_URL}}'",
          JSON.stringify(proxyBase + '/.qtap/tap/?qtap_clientId=' + clientId)
        );
    }

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
    (m) => m + `<base href="${this.escapeHTML(base)}"/><script>(${fnToStr(qtapClientHead)})();</script>`
    );

    html = this.replaceOnce(html, [
      /<\/body>(?![\s\S]*<\/body>)/i,
      /<\/html>(?![\s\S]*<\/html>)/i,
      /$/
    ],
    (m) => '<script>(' + fnToStr(qtapClientBody) + ')();</script>' + m
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
      const browser = this.browsers.get(clientId);
      if (browser) {
        const now = performance.now();
        browser.readableController.enqueue(body);
        browser.logger.debug('browser_tap_received',
          `+${humanSeconds(now - browser.clientIdleActive)}s`,
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

export { ControlServer };
