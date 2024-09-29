'use strict';

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import stream from 'node:stream';

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
  woff: 'font/woff',
};

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

export { ControlServer };
