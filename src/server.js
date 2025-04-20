'use strict';

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { qtapClientHead, qtapClientBody } from './client.cjs';
import * as util from './util.js';
import tapFinished from './tap-finished.js';
/** @import events from 'node:events' */
/** @import { Logger } from './qtap.js' */

class ControlServer {
  static nextServerId = 1;
  static nextClientId = 1;

  /**
   * @param {string} testFile File path or URL
   * @param {events.EventEmitter} eventbus
   * @param {Logger} logger
   * @param {Object} options
   * @param {string} options.cwd
   * @param {number} options.idleTimeout
   * @param {number} options.connectTimeout
   * @param {boolean} options.debugMode
   */
  constructor (testFile, eventbus, logger, options) {
    this.logger = logger.channel('qtap_server_' + ControlServer.nextServerId++);

    // For `qtap <url>`, default root to cwd (unused).
    // For `qtap test/index.html`, default root to cwd.
    let root = options.cwd;
    let testFileAbsolute;
    let testFileQueryString = '';
    if (util.isURL(testFile)) {
      testFileAbsolute = testFile;
    } else {
      // For `qtap ../foobar/test/index.html`, default root to ../foobar.
      //
      // For `qtap /tmp/foobar/test/index.html`, default root to nearest
      // common parent dir (i.e. longest common path between file and cwd).
      //
      testFileAbsolute = path.resolve(root, testFile);
      const relPath = path.relative(root, testFileAbsolute);
      const parent = relPath.match(/^[./\\]+/)?.[0];
      if (parent) {
        root = path.join(root, parent);
      }
      // Support passing "test/index.html?module=foo" as a way to serve index.html,
      // with the query string preserved in the URL used client-side, but not
      // seen as part of the file name server-side.
      if (testFileAbsolute.includes('?') && !fs.existsSync(testFileAbsolute)) {
        const withoutQuery = testFileAbsolute.split('?')[0];
        if (fs.existsSync(withoutQuery)) {
          testFileQueryString = testFileAbsolute.replace(/^[^?]+/, '');
          this.logger.debug('server_testfile_querystring', 'Preserving ' + testFileQueryString);
          testFileAbsolute = withoutQuery;
        }
      }
      // Normalize testFile to "test/index.html".
      testFile = path.relative(root, testFileAbsolute);
      if (!testFile || testFile.startsWith('..')) {
        throw new Error(`Cannot serve ${testFile} from ${root}`);
      }
      // Normalize \backslash to POSIX slash, but only on Windows
      // * To use as-is in URLs (launchBrowser).
      // * Stable values in reporter output text.
      // * Stable values in event data.
      // * Only on Windows (pathToFileURL chooses automatically),
      //   because on POSIX, backslash is a valid character to use in
      //   in a file name, which we must not replace with forward slash.
      const rootUrlPathname = pathToFileURL(root).pathname;
      const fileUrlPathname = pathToFileURL(testFileAbsolute).pathname;
      testFile = fileUrlPathname
        .replace(rootUrlPathname, '')
        .replace(/^\/+/, '');
      this.logger.debug('server_testfile_normalized', testFile);
    }

    this.root = root;
    this.testFile = testFile;
    this.testFileQueryString = testFileQueryString;
    this.eventbus = eventbus;
    this.idleTimeout = options.idleTimeout;
    this.connectTimeout = options.connectTimeout;
    this.debugMode = options.debugMode;

    this.browsers = new Map();
    // Optimization: Prefetch test file in parallel with server creation and browser launching.
    //
    // To prevent a global error (unhandledRejection), we add a no-op catch() handler here.
    // Once launchBrowser is called, we will await this in handleRequest/getTestFile,
    // which is then propertly caught by server.on('request') below, which emits it
    // as 'error' event.
    //
    // The reason we don't emit 'error' directly here, is that that would cause
    // qtap.runWaitFor() to return too early, while stuff is still running in the background.
    this.testFilePromise = this.fetchTestFile(testFileAbsolute);
    this.testFilePromise.catch(() => {
      // No-op
    });

    // Optimization: Don't wait for server to start. Let qtap.js proceed to load config/browsers,
    // and we'll await this later in launchBrowser().
    const server = http.createServer();
    this.proxyBase = '';
    this.proxyBasePromise = new Promise((resolve) => {
      server.on('listening', () => {
        // @ts-ignore - Not null after listen()
        this.proxyBase = 'http://localhost:' + server.address().port;
        this.logger.debug('server_listening', `Serving ${root} at ${this.proxyBase}`);
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
        switch (url.pathname) {
          case '/.qtap/tap/':
            this.handleTap(req, url, resp);
            break;
          default:
            await this.handleRequest(req, url, resp);
        }
      } catch (e) {
        this.logger.warning('respond_uncaught', req.url, String(e));
        eventbus.emit('error', e);
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

  /** @return {Promise<Object>} Headers and HTML document */
  async fetchTestFile (file) {
    let headers, body;

    // fetch() does not support file URLs (as of writing, in Node.js 22).
    if (util.isURL(file)) {
      this.logger.debug('testfile_fetch', `Requesting ${file}`);
      const resp = await fetch(file);
      if (!resp.ok) {
        throw new Error('Remote URL responded with HTTP ' + resp.status);
      }
      headers = resp.headers;
      body = await resp.text();
    } else {
      this.logger.debug('testfile_read', `Reading file ${file}`);
      headers = new Headers();
      body = (await fsPromises.readFile(file)).toString();
    }

    this.logger.debug('testfile_ready', `Finished fetching ${file}`);
    return { headers, body };
  }

  async getTestFile (clientId) {
    const proxyBase = await this.getProxyBase();
    const qtapTapUrl = proxyBase + '/.qtap/tap/?qtap_clientId=' + clientId;

    let headInjectHtml = `<script>(${util.fnToStr(qtapClientHead, qtapTapUrl)})();</script>`;

    // Add <base> tag so that URL-based files can fetch their resources directly from the
    // original server. Prepend as early as possible. If the file has its own <base>, theirs
    // will be after ours and correctly "win" by applying last.
    if (util.isURL(this.testFile)) {
      headInjectHtml = `<base href="${util.escapeHTML(this.testFile)}"/>` + headInjectHtml;
    }

    let resp;
    let html;
    try {
      resp = await this.testFilePromise;
      html = resp.body;
    } catch (e) {
      // @ts-ignore - TypeScript @types/node lacks `Error(,options)`
      throw new Error('Could not open ' + this.testFile, { cause: e });
    }

    // Head injection
    // * Use a callback, to avoid corruption if "$1" appears in the user input.
    // * The headInjectHtml string must be one line without any line breaks,
    //   so that line numbers in stack traces presented in QTap output remain
    //   transparent and correct.
    // * Ignore <heading> and <head-thing>.
    // * Support <head x=y...>, including with tabs or newlines before ">".
    html = util.replaceOnce(html,
      [
        /<head(?:\s[^>]*)?>/i,
        /<html(?:\s[^>]*)?>/i,
        /<!doctype[^>]*>/i,
        /^/
      ],
      (m) => m + headInjectHtml
    );

    html = util.replaceOnce(html,
      [
        /<\/body>(?![\s\S]*<\/body>)/i,
        /<\/html>(?![\s\S]*<\/html>)/i,
        /$/
      ],
      (m) => '<script>(' + util.fnToStr(qtapClientBody, qtapTapUrl) + ')();</script>' + m
    );

    return {
      headers: resp.headers,
      body: html
    };
  }

  async handleRequest (req, url, resp) {
    const filePath = path.join(this.root, url.pathname);
    const ext = path.extname(url.pathname).slice(1);
    if (!filePath.startsWith(this.root)) {
      // Disallow outside directory traversal
      this.logger.debug('respond_static_deny', url.pathname);
      return this.serveError(resp, 403, 'HTTP 403: QTap respond_static_deny');
    }

    const clientId = url.searchParams.get('qtap_clientId');
    if (clientId !== null) {
      // Serve the testfile from any URL path, as chosen by launchBrowser()
      const browser = this.browsers.get(clientId);
      if (browser) {
        browser.logger.debug('browser_connected', `${browser.getDisplayName()} connected! Serving test file.`);
        this.eventbus.emit('online', { clientId });
      } else if (this.debugMode) {
        // Allow users to reload the page when in --debug mode.
        // Note that do not handle more TAP results after a given test run has finished.
        this.logger.debug('browser_reload_debug', clientId);
      } else {
        this.logger.debug('browser_unknown_clientId', clientId);
        return this.serveError(resp, 403, 'HTTP 403: QTap browser_unknown_clientId.\n\nThis clientId was likely already served and cannot be repeated. Run qtap with --debug to bypass this restriction.');
      }

      const testFileResp = await this.getTestFile(clientId);
      for (const [name, value] of testFileResp.headers) {
        // Ignore these incompatible headers from the original response,
        // as otherwise the browser may truncate the amended test file.
        if (!['content-length', 'transfer-encoding'].includes(name.toLowerCase())) {
          resp.setHeader(name, value);
        }
      }
      if (!testFileResp.headers.get('Content-Type')) {
        resp.setHeader('Content-Type', util.MIME_TYPES.html);
      }
      resp.writeHead(200);
      resp.write(testFileResp.body);
      resp.end();

      // Count proxying the test file toward connectTimeout, not idleTimeout.
      if (browser) {
        browser.clientIdleActive = performance.now();
      }
      return;
    }

    if (!fs.existsSync(filePath)) {
      this.logger.debug('respond_static_notfound', filePath);
      return this.serveError(resp, 404, 'HTTP 404: QTap respond_static_notfound');
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
      // Support QUnit 2.16 - 2.23: Strip escape sequences for tap-parser compatibility.
      // Fixed in QUnit 2.23.1 with https://github.com/qunitjs/qunit/pull/1801.
      body = util.stripAsciEscapes(body);
      const bodyExcerpt = body.slice(0, 30) + '…';
      const clientId = url.searchParams.get('qtap_clientId');
      const browser = this.browsers.get(clientId);
      if (browser) {
        const now = performance.now();
        browser.logger.debug('browser_tap_received',
          `+${util.humanSeconds(now - browser.clientIdleActive)}s`,
          bodyExcerpt
        );
        browser.tapParser.write(body);
        browser.clientIdleActive = now;
      } else {
        this.logger.debug('browser_tap_unhandled', clientId, bodyExcerpt);
      }
    });
    resp.writeHead(204);
    resp.end();
  }

  /**
   * @param {http.ServerResponse} resp
   * @param {number} statusCode
   * @param {string|Error} e
   */
  serveError (resp, statusCode, e) {
    if (!resp.headersSent) {
      resp.writeHead(statusCode, { 'Content-Type': util.MIME_TYPES.txt });
      // @ts-ignore - TypeScript @types/node lacks Error.stack
      resp.write((e.stack || String(e)) + '\n');
    }
    resp.end();
  }

  async launchBrowser (browserFn, browserName, globalSignal) {
    const clientId = 'client_' + ControlServer.nextClientId++;
    const logger = this.logger.channel(`qtap_browser_${clientId}_${browserName}`);

    const proxyBase = await this.getProxyBase();
    // Serve the a test file from URL that looks like the original path when possible.
    //
    // - For static files, serve it from a URL that matches were it would be among the
    //   other static files (even though it is treated special).
    //   "foo/bar" => "/foo/bar"
    //   "/tmp/foo/bar" => "/tmp/foo/bar"
    // - For external URLs, match the URL path, including query params, so that these
    //   can be seen both server-side and client-side.
    //
    // NOTE: This is entirely cosmetic. For how the actual fetch, see fetchTestFile().
    // For how resources are requested client side, we use <base href> to ensure correctness.
    //
    // Example: WordPress password-strength-meter.js inspects the hostname and path
    // (e.g. www.mysite.test/mysite/). That test case depends on the real path.
    // https://github.com/WordPress/wordpress-develop/blob/6.7.1/tests/qunit/wp-admin/js/password-strength-meter.js#L100
    const tmpUrl = new URL(this.testFile + this.testFileQueryString, proxyBase);
    tmpUrl.searchParams.set('qtap_clientId', clientId);
    const url = proxyBase + tmpUrl.pathname + tmpUrl.search;

    const maxTries = (browserFn.allowRetries === false || this.debugMode) ? 1 : 3;
    let i = 1;
    while (true) {
      try {
        // The 'client' event must be emitted:
        // * ... early, so that reporters can indicate the browser is starting.
        // * ... exactly once, regardless of retries.
        // * ... with the correct display name from browserFn.displayName, which may be set
        //       dynamically by browserFn() before any async logic, as used by "detect"
        //       (to expand to the selected browser), and by the BrowserStack plugin
        //       (to expand chrome_latest).
        //
        // Separate launchBrowserAttempt() and its browserFn() call from the "await" statement,
        // so that we can emit the 'client' event right after calling browserFn.
        // For this to work, launchBrowserAttempt() must have no async logic before calling browserFn.
        // If we awaited here directly, the event would not be emitted until after the client has
        // finished, which defeats its purpose for reporters.
        const browserPromise = this.launchBrowserAttempt(browserFn, browserName, globalSignal, clientId, url, logger);

        if (i === 1) {
          this.eventbus.emit('client', {
            clientId,
            testFile: this.testFile,
            browserName,
            displayName: browserFn.getDisplayName(),
          });
        }

        const result = await browserPromise;
        this.eventbus.emit('result', result);
        return;
      } catch (e) {
        // Do not retry for test-specific bail reasons, which are expected to be consistent,
        // and unrelated to the browser.
        // Only retry for uncaught errors from browserFn, and for BrowserConnectTimeout.
        if (i >= maxTries || e instanceof util.BrowserStopSignal) {
          if (e instanceof util.BrowserStopSignal || e instanceof util.BrowserConnectTimeout) {
            this.eventbus.emit('bail', { clientId, reason: e.message });
            return;
          } else {
            throw e;
          }
        }

        i++;
        logger.debug('browser_connect_retry', `Retrying, attempt ${i} of ${maxTries}`);
      }
    }
  }

  async launchBrowserAttempt (browserFn, browserName, globalSignal, clientId, url, logger) {
    const controller = new AbortController();
    const signals = { browser: controller.signal, global: globalSignal };
    if (this.debugMode) {
      // Replace with a dummy signal that we never invoke
      signals.browser = (new AbortController()).signal;
      controller.signal.addEventListener('abort', () => {
        logger.warning('browser_signal_debugging', 'Keeping browser open for debugging');
      });
    }

    let clientIdleTimer;

    const browser = {
      logger,
      clientIdleActive: null,
      getDisplayName () {
        return browserFn.getDisplayName();
      },
      /**
       * Reasons to stop a browser, whichever comes first:
       * 1. tap-finished (client has sent us the test results).
       * 2. tap-parser 'bailout' event (client knows it crashed).
       * 3. timeout (client didn't connect, client idle and presumed lost, or a silent crash).
       *
       * @param {any} reason
       */
      stop: async (reason) => {
        if (!this.browsers.has(clientId)) {
          // Ignore any duplicate or late reasons to stop
          return;
        }

        clearTimeout(clientIdleTimer);
        this.browsers.delete(clientId);
        controller.abort(reason);
      }
    };

    let result;
    const tapParser = tapFinished({ wait: 0 }, (finalResult) => {
      result = {
        clientId,
        ok: finalResult.ok,
        total: finalResult.count,
        // avoid precomputed `finalResult.todo` because that would double-count passing todos
        passed: finalResult.pass + finalResult.todos.length,
        // avoid precomputed `finalResult.fail` because that includes todos (expected failure)
        failed: finalResult.failures.length,
        skips: finalResult.skips,
        todos: finalResult.todos,
        failures: finalResult.failures,
      };
      logger.debug('browser_tap_finished', 'Test run finished, stopping browser', {
        ok: result.ok,
        total: result.total,
        failed: result.failed,
      });
      browser.stop(new util.BrowserStopSignal('browser_tap_finished'));
    });

    tapParser.on('bailout', (reason) => {
      logger.warning('browser_tap_bailout', 'Test run bailed, stopping browser');
      browser.stop(new util.BrowserStopSignal(reason));
    });

    tapParser.on('comment', (comment) => {
      if (!comment.startsWith('# console: ')) {
        return;
      }

      // Serve information as transparently as possible
      // - Strip the prefix we added in /src/client.js
      // - Strip the proxyBase and qtap_clientId param we added
      const message = comment
        .replace('# console: ', '')
        .replace(/\n$/, '')
        .replace(/^( {2}at )(http:\S+):(\S+)(?=\n|$)/gm, (m, at, frameUrlStr, lineno) => {
          const frameUrl = new URL(frameUrlStr);
          if (frameUrl.origin === this.proxyBase) {
            return at + frameUrl.pathname + ':' + lineno;
          }
          return m;
        });
      this.eventbus.emit('consoleerror', {
        clientId,
        message
      });
    });

    // Debugging
    // tapParser.on('line', logger.debug.bind(logger, 'browser_tap_line'));
    // tapParser.on('assert', logger.debug.bind(logger, 'browser_tap_assert'));
    // tapParser.once('fail', () => logger.debug('browser_tap_fail', 'Found one or more failing tests'));
    // tapParser.on('plan', logger.debug.bind(logger, 'browser_tap_plan'));

    browser.tapParser = tapParser;
    this.browsers.set(clientId, browser);

    // Optimization: The naive approach would be to clearTimeout+setTimeout on every tap line,
    // in `handleTap()` or `tapParser.on('line')`. But that adds significant overhead from
    // Node.js/V8 natively allocating many timers when processing large batches of test results.
    // Instead, merely store performance.now() and check that periodically.
    const TIMEOUT_CHECK_MS = 100;
    const browserStart = performance.now();
    const qtapCheckTimeout = () => {
      if (!browser.clientIdleActive) {
        if ((performance.now() - browserStart) > (this.connectTimeout * 1000)) {
          const reason = `Browser did not start within ${this.connectTimeout}s`;
          logger.warning('browser_connect_timeout', reason);
          browser.stop(new util.BrowserConnectTimeout(reason));
          return;
        }
      } else {
        if ((performance.now() - browser.clientIdleActive) > (this.idleTimeout * 1000)) {
          const reason = `Browser idle for ${this.idleTimeout}s`;
          logger.warning('browser_idle_timeout', reason);
          browser.stop(new util.BrowserStopSignal(reason));
          return;
        }
      }
      clientIdleTimer = setTimeout(qtapCheckTimeout, TIMEOUT_CHECK_MS);
    };
    clientIdleTimer = setTimeout(qtapCheckTimeout, TIMEOUT_CHECK_MS);

    try {
      logger.debug('browser_launch_call');

      await browserFn(url, signals, logger, this.debugMode);

      // Usually browserFn() will return because we asked via browser.stop(), e.g. tests finished,
      // bailed, or timed out. In case the browser ended by itself, we call browser.stop() here,
      // so that if we didn't called it before, this will report an error.
      // Also, this ensures the signal can clean up any resources created by browserFn.
      logger.debug('browser_launch_exit');
      browser.stop(new util.BrowserStopSignal('Browser ended unexpectedly'));
    } catch (e) {
      // Silence any errors from browserFn that happen after we called browser.stop().
      if (!controller.signal.aborted) {
        logger.warning('browser_launch_error', e);
        browser.stop(new util.BrowserStopSignal('Browser ended unexpectedly'));
        throw e;
      }
    }

    if (!result) {
      // Throw BrowserConnectTimeout for retry purposes.
      throw controller.signal.reason;
    }

    return result;
  }

  async getProxyBase () {
    return this.proxyBase || await this.proxyBasePromise;
  }
}

export { ControlServer };
