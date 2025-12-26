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
/** @import { Logger, Browser } from './qtap.js' */

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
    this.serverId = ControlServer.nextServerId++;
    this.logger = logger.channel('qtap_server_S' + this.serverId);

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
      //
      // TODO: Add test case to confirm we favor foo, even if foo?bar exists as file.
      // TODO: Add test case to confirm we favor foo?bar if it exists but foo does not.
      // TODO: Add test case to confirm we mention foo in error message if neither exists.
      if (testFileAbsolute.includes('?')) {
        const withoutQuery = testFileAbsolute.split('?')[0];
        if (fs.existsSync(withoutQuery) || !fs.existsSync(testFileAbsolute)) {
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
    this.debugBrowserProcesses = [];

    this.launchingBrowsers = new Set();
    this.browsers = new Map();
    // Optimization: Prefetch test file in parallel with server creation and browser launching.
    //
    // To prevent a Node.js error (unhandledRejection), we add a no-op catch() handler here.
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

    // Optimization: Don't wait for server to start. Let qtap.js proceed to start other servers,
    // and load user config files (which in turn may import browsers, and other plugins, which can
    // take a while). We await this later, before calling launchBrowser().
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
        this.logger.warning('server_respond_uncaught', e);
        this.serveError(resp, 500,
          'HTTP 500: QTap server_respond_uncaught'
            // @ts-ignore - TypeScript @types/node lacks Error.stack
            + '\n\n' + (e.stack || String(e))
        );

        // At this point, qtap.run() is awaiting ControlServer#launchBrowser
        // (as browerPromise). Make sure we don't get stuck there.
        // That way:
        // - browser.stop() makes launchBrowser() throw/return,
        // - qtap.run() sees runPromise get rejected and emits error/finish,
        // - qtap.runWaitFor() will throw/return.
        this.stopBrowsers(e);
      }
    });

    // Start the server in the background on a random available port
    server.listen();

    this.stopBrowsers = (e) => {
      for (const browser of this.browsers.values()) {
        browser.stop(e);
      }
    };

    this.close = async () => {
      if (this.closeCalled) {
        throw new Error('ControlServer.close must only be called once');
      }
      this.closeCalled = true;
      this.logger.debug('server_close');
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
        // @ts-ignore - TypeScript @types/node lacks `Error(,options)`
        throw new util.QTapError(`Received HTTP ${resp.status} error from ${file}`);
      }
      headers = resp.headers;
      body = await resp.text();
    } else {
      this.logger.debug('testfile_readfile', `Reading file ${file}`);
      headers = new Headers();
      try {
        body = (await fsPromises.readFile(file)).toString();
      } catch (e) {
        // @ts-ignore - TypeScript @types/node lacks `Error(,options)`
        throw new util.QTapError('Could not open ' + this.testFile, { cause: e });
      }
    }

    this.logger.debug('testfile_ready', `Finished fetching ${file}`);
    return { headers, body };
  }

  async getTestFile (clientId) {
    const proxyBase = this.getProxyBase();
    const qtapTapUrl = proxyBase + '/.qtap/tap/?qtap_clientId=' + clientId;

    let headInjectHtml = `<script>(${util.fnToStr(qtapClientHead, qtapTapUrl)})();</script>`;

    // Add <base> tag so that URL-based files can fetch their resources directly from the
    // original server. Prepend as early as possible. If the file has its own <base>, theirs
    // will be after ours and correctly "win" by applying last.
    if (util.isURL(this.testFile)) {
      headInjectHtml = `<base href="${util.escapeHTML(this.testFile)}"/>` + headInjectHtml;
    }

    let bodyInjectHtml = '<script>(' + util.fnToStr(qtapClientBody, qtapTapUrl) + ')();</script>';
    if (this.debugMode) {
      bodyInjectHtml = '<pre id="__qtap_debug_element" style="display: block; max-width: 90%; overflow-x: hidden; white-space: pre-wrap; word-wrap: break-word; background: #fff; color: #000;"></pre>' + bodyInjectHtml;
    }

    const resp = await this.testFilePromise;
    let html = resp.body;

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
      (m) => bodyInjectHtml + m
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
      // If the query parameter is present, serve the testfile, regardless of URL path.
      // The URL path is chosen by launchBrowser().
      if (this.launchingBrowsers.has(clientId)) {
        this.launchingBrowsers.delete(clientId);
        this.eventbus.emit('clientonline', { clientId });
      } else if (this.debugMode) {
        // Allow users to reload the page when in --debug mode.
        // Note that the results of this reload will not be reported, because
        // we already received and wrote a complete TAP report for this client.
        this.logger.debug('browser_reload_debug', clientId);
      } else {
        this.logger.debug('browser_unknown_clientId', clientId);
        return this.serveError(resp, 403, 'HTTP 403: QTap browser_unknown_clientId.\n\nThis clientId was likely already served and cannot be repeated. Run qtap with --debug to bypass this restriction.');
      }

      const testFileResp = await this.getTestFile(clientId);
      for (const [name, value] of testFileResp.headers) {
        // Ignore these incompatible headers from the original response,
        // as otherwise the browser may truncate the amended test file.
        if (!['content-length', 'transfer-encoding', 'content-encoding'].includes(name.toLowerCase())) {
          resp.setHeader(name, value);
        }
      }
      if (!testFileResp.headers.get('Content-Type')) {
        resp.setHeader('Content-Type', util.MIME_TYPES.html);
      }
      resp.writeHead(200);
      resp.write(testFileResp.body);
      resp.end();
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
      //
      // Strip anyway, to avoid double or conflicting color formatting in test names
      body = util.stripAsciEscapes(body);

      // Serve information as transparently as possible
      //
      // - Strip the prefix we added in /src/client.js
      // - Strip the proxyBase and qtap_clientId param we added
      //
      // Firefox: "@http://localhost/test.html:1:2"
      // Chrome: "  at foo (http://localhost/test.html:1:2)"
      //
      // We do this here rather than in tapParser.on('comment')
      // so that it applies to URLs in both assertion failure stack traces,
      // and in "clientconsole" lines.
      body = body.replace(/( {2}at |@|\()(http:\S+):(\S+)(?=\n|$)/gm, (m, at, frameUrlStr, suffix) => {
        const frameUrl = new URL(frameUrlStr);
        if (frameUrl.origin === this.proxyBase) {
          return at + frameUrl.pathname + ':' + suffix;
        }
        return m;
      });
      const clientId = url.searchParams.get('qtap_clientId');
      const browser = this.browsers.get(clientId);
      if (browser) {
        const now = performance.now();
        browser.logger.debug('browser_tap_received',
          `+${util.humanSeconds(now - browser.lastReceived)}s`,
          body
        );
        browser.lastReceived = now;
        browser.tapParser.write(body);
      } else {
        this.logger.debug('browser_tap_unhandled', clientId, body);
      }
    });
    resp.writeHead(204);
    resp.end();
  }

  /**
   * @param {http.ServerResponse} resp
   * @param {number} statusCode
   * @param {string} err
   */
  serveError (resp, statusCode, err) {
    if (!resp.headersSent) {
      resp.writeHead(statusCode, { 'Content-Type': util.MIME_TYPES.txt });
      resp.write(err + '\n');
    }
    resp.end();
  }

  async launchBrowser (browserFn, browserName, globalSignal) {
    const maxTries = (browserFn.allowRetries === false || this.debugMode) ? 1 : 3;
    let i = 1;

    const clientId = 'client_S' + this.serverId + '_C' + ControlServer.nextClientId++;
    const logger = this.logger.channel(`qtap_browser_${clientId}_${browserName}`);
    let controller = new AbortController();

    // TODO: rename browser=>client
    // TODO: remove browserName or rename to browserId.
    // TODO: rename getDisplayName to getBrowserName.
    const browser = {
      clientId,
      logger,
      browserName,
      getDisplayName () {
        return browserFn.displayName || browserName;
      },
      browserProcessPromise: null,
      tapParser: null,
      lastReceived: performance.now(),
      /**
       * Reasons to stop a browser, whichever comes first:
       * 1. tap-finished (client has sent us the test results).
       * 2. tap-parser 'bailout' event (client knows it crashed).
       * 3. connect timeout
       * 4. idle timeout (client idle and presumed lost, or a silent crash).
       *
       * @param {any} reason
       */
      stop: async (reason) => {
        if (!this.browsers.has(clientId)) {
          // Ignore any duplicate or late reasons to stop
          return;
        }

        this.browsers.delete(clientId);
        logger.debug('browser_launch_stopping', String(reason));
        controller.abort(reason);
      }
    };
    this.browsers.set(clientId, browser);

    while (true) {
      const signals = {
        // NOTE: The browser signal tracks both "browser" and "global" controllers,
        // so that if qtap.run() bails out (e.g. uncaught error from a reporter, or
        // test server fails in fetchTestFile due to file not found), and if for
        // some reason the natural shutdown fails (i.e. we don't call
        // server.stopBrowsers or don't await browerPromise), then we have one
        // last chance during shared_cleanup to stop dangling browser processes.
        browser: AbortSignal.any([controller.signal, globalSignal]),
        global: globalSignal
      };

      try {
        await this.launchBrowserAndConnect(browserFn, browser, signals);
        logger.debug('browser_connected', `${browser.getDisplayName()} connected! Serving test file.`);
      } catch (e) {
        // Handle util.BrowserConnectTimeout from launchBrowserAndConnect
        //
        // We only retry BrowserConnectTimeout, as everything else should be deterministic.
        // Uncaught errors from browserFn are generally mistakes in code or configuration.
        // Client-side bailouts should be deterministic once a test has begun, and if
        // we allowed retries after that reporting gets messy as a client would appear to
        // go back in time.
        if (e instanceof util.BrowserConnectTimeout && i < maxTries) {
          i++;
          this.logger.debug('browser_connect_retry', `Retrying, attempt ${i} of ${maxTries}`);
          // Give up on the timed-out attempt and reset controller for the next attempt
          if (!this.debugMode) {
            logger.warning('browser_signal_debugging', 'Keeping timed-out browser process alive for debugging');
            controller.abort(e);
          }
          controller = new AbortController();
          continue;
        }
        if (e instanceof util.BrowserConnectTimeout && maxTries > 1) {
          throw new util.BrowserConnectTimeout(`Browser did not start within ${this.connectTimeout}s after ${i} attempts`);
        }
        if (e instanceof util.QTapError) {
          e.qtapClient = {
            browser: browser.getDisplayName(),
            testFile: this.testFile
          };
        }
        throw e;
      }

      try {
        await this.getClientResult(browser, signals);
        break;
      } catch (e) {
        if (e instanceof util.BrowserStopSignal && this.debugMode) {
          // Ignore "Browser ended unexpectedly" for a manual close when debugging
          logger.debug('browser_signal_debugging', 'Ignore unexpected end when debugging');
          return;
        }
        if (e instanceof util.QTapError) {
          e.qtapClient = {
            browser: browser.getDisplayName(),
            testFile: this.testFile
          };
        }
        throw e;
      }
    }
  }

  /**
   * Launch a browser and ensure it has connected.
   *
   * @param {Browser} browserFn
   * @param {Object} browser
   * @param {Object<string,AbortSignal>} signals
   */
  async launchBrowserAndConnect (browserFn, browser, signals) {
    const proxyBase = this.getProxyBase();
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
    tmpUrl.searchParams.set('qtap_clientId', browser.clientId);
    const url = proxyBase + tmpUrl.pathname + tmpUrl.search;

    // We don't await browserFn() because we first need to handle connectTimeout and retries.
    // Then, hand off the process to getClientResult() where we can then cleanly consume TAP
    // stream without risking that a retry might produce a second result from the next attempt.
    // This way, we consume only from clients that make it to the 'clientonline' event,
    // and we don't retry once past that.
    //
    // We have to attach then()/catch() here instead of later in getClientResult(), as otherwise
    // early errors leave browserProcessPromise without error handler, causing a global unhandled
    // rejection. E.g. when throwing in a reporter from on('clients').
    this.launchingBrowsers.add(browser.clientId);
    browser.logger.debug('browser_launch_call');
    const signalsForBrowserFn = { ...signals };
    if (this.debugMode) {
      // Pass a dummy signal that we never invoke (not even during global cleanup, to debug crashes)
      signalsForBrowserFn.browser = (new AbortController()).signal;

      signals.browser.addEventListener('abort', () => {
        browser.logger.warning('browser_signal_debugging', 'Keeping browser open for debugging');
      });
    }
    const rawBrowserProcessPromise = browserFn(url, signalsForBrowserFn, browser.logger, this.debugMode);

    // Optimization: TODO: Document the fast path
    browser.browserProcessPromise = Promise.race([
      rawBrowserProcessPromise,
      new Promise((resolve) => {
        signals.browser.addEventListener('abort', () => {
          if (signals.browser.reason instanceof util.BrowserStopSignal) {
            browser.logger.debug('browser_signal_race', 'Fast path');
            resolve();
          }
        });
      })
    ])
      .then(() => {
        // Usually browserFn() will return because we asked via browser.stop() when tests finished
        // or timed out. If the browser ended by itself, report is as an error.
        if (signals.browser.aborted) {
          browser.logger.debug('browser_launch_exit');
        } else {
          throw new util.BrowserStopSignal('Browser ended unexpectedly');
        }
      }, /** @type {Error|Object|string} */ e => {
        // Silence any errors from browserFn that happen after we called browser.stop().
        if (!signals.browser.aborted) {
          browser.logger.warning('browser_launch_error', e);
          browser.stop(e);
          throw e;
        }
      });

    if (this.debugMode) {
      this.debugBrowserProcesses.push(rawBrowserProcessPromise);
    }

    // The Promise.race call takes care of three things:
    //
    // * Avoid global uncaught error or global unhandled rejection from browserProcessPromise.
    //
    //   If qtap.js throws between `launchBrowser()` and `await browserPromises`, then
    //   launchBrowser will be discarded and not proceed to getClientResult(),
    //   which means no catch is attached to browserProcessPromise.
    //
    // * Ensure fast cancelling if another browser has raised an error.
    //
    return Promise.race([
      new Promise((resolve, reject) => {
        const connectTimeoutTimer = setTimeout(() => {
          const reason = `Browser did not start within ${this.connectTimeout}s`;
          this.launchingBrowsers.delete(browser.clientId);
          const err = new util.BrowserConnectTimeout(reason);
          browser.logger.warning('browser_connect_timeout', reason);
          reject(err);
        }, this.connectTimeout * 1000);

        this.eventbus.on('error', () => {
          clearTimeout(connectTimeoutTimer);
        });

        this.eventbus.on('clientonline', (event) => {
          if (event.clientId === browser.clientId) {
            clearTimeout(connectTimeoutTimer);
            resolve(null);
          }
        });
      }),
      browser.browserProcessPromise
    ]);
  }

  /**
   * Consume results from a connected browser process.
   *
   * @param {Object} browser
   * @param {Object<string,AbortSignal>} signals
   * @return {Promise<Object>} clientresult
   */
  async getClientResult (browser, signals) {
    let clientIdleTimer;

    let result;
    const tapParser = tapFinished({ wait: 0 }, (finalResult) => {
      clearTimeout(clientIdleTimer);

      result = {
        clientId: browser.clientId,
        ok: finalResult.ok,
        total: finalResult.count,
        // We want to reflect how a summary would describe the result,
        // based on how the failures are presented.
        //
        // In tap-parser, an expected-failing todo is detailed in `finalResult.todos`,
        // but counts towards both `finalResult.fail` and `finalResult.todo`,
        // and not `finalResult.pass`.
        //
        // In tap-parser, an unexpectedly-passing todo is detailed in `finalResult.todos`,
        // but counts towards both `finalResult.pass` and `finalResult.todo`
        // (see fixtures/todo-done.html).
        //
        // If we do nothing, we'd create an odd gap (total 4, passing 3, failed 0).
        // If we use pass+todo, we'd double-count unexpectedly-passing todos.
        // For now, infer as total-failures.
        passed: finalResult.count - finalResult.failures.length,
        // Any unexpectedly-passing todo may or may not be counted here.
        // It is up to the test framework to decide whether or not to enforce
        // that passing todos are corrected to regular tests or not.
        //
        // Tape reports passing todo as "ok". QUnit reports them as "not ok".
        //
        // The number here is consistent with the 'failures' array and thus
        // consistent with how failures are presented by the reporter.
        failed: finalResult.failures.length,
        skips: finalResult.skips,
        todos: finalResult.todos,
        failures: finalResult.failures,
        bailout: finalResult.bailout,
      };
      browser.logger.debug('browser_tap_finished', 'Test run finished', {
        ok: result.ok,
        total: result.total,
        failed: result.failed,
      });
      browser.stop(new util.BrowserStopSignal('browser_tap_finished'));
    });

    tapParser.on('bailout', (reason) => {
      browser.logger.warning('browser_tap_bailout', 'Test run bailed');
      browser.stop(new util.BrowserStopSignal(reason));
    });

    tapParser.on('comment', (comment) => {
      if (!comment.startsWith('# console: ')) {
        return;
      }

      const message = comment
        .replace('# console: ', '')
        .replace(/\n$/, '');

      this.eventbus.emit('clientconsole', {
        clientId: browser.clientId,
        message
      });
    });
    tapParser.on('assert', (result) => {
      this.eventbus.emit('assert', {
        clientId: browser.clientId,
        ok: result.ok,
        fullname: result.fullname,
        diag: result.diag
      });
    });

    // Debugging
    // tapParser.on('line', logger.debug.bind(logger, 'browser_tap_line'));
    // tapParser.on('fail', logger.debug.bind(logger, 'browser_tap_fail'));
    // tapParser.on('plan', logger.debug.bind(logger, 'browser_tap_plan'));

    browser.tapParser = tapParser;
    // It is valid for connectTimeout to be more or equal than idleTimeout.
    // These two should be treated separately and not overlapping, as otherwise
    // a slow launch or retried launch would eat from the first test's idleTimeout
    // and the browser could timeout before it begins.
    //
    // We treat 'clientonline' as the first message received from the browser,
    // and start counting idleTimeout only after that. .
    browser.lastReceived = performance.now();

    // Optimization: The naive approach would be to clearTimeout+setTimeout on every tap line,
    // in `handleTap()` or `tapParser.on('line')`. But that adds significant overhead from
    // Node.js/V8 natively allocating many timers when processing large batches of test results.
    // Instead, merely store performance.now() and check that periodically.
    const TIMEOUT_CHECK_MS = 100;
    const qtapCheckTimeout = () => {
      if ((performance.now() - browser.lastReceived) > (this.idleTimeout * 1000)) {
        const reason = `Test timed out after ${this.idleTimeout}s`;
        browser.logger.warning('browser_idle_timeout', reason);
        browser.stop(new util.BrowserStopSignal(reason));
        return;
      }
      clientIdleTimer = setTimeout(qtapCheckTimeout, TIMEOUT_CHECK_MS);
    };
    clientIdleTimer = setTimeout(qtapCheckTimeout, TIMEOUT_CHECK_MS);

    try {
      await browser.browserProcessPromise;
    } finally {
      clearTimeout(clientIdleTimer);
    }

    if (!result) {
      if (signals.browser.aborted) {
        throw signals.browser.reason;
      } else {
        throw new Error('Browser exited without error yet results not found.');
      }
    }

    browser.logger.debug('event_clientresult', result);
    this.eventbus.emit('clientresult', result);
    return result;
  }

  /** @return {string} */
  getProxyBase () {
    if (!this.proxyBase) {
      throw new Error('Called server.getProxyBase before server was ready');
    }
    return this.proxyBase;
  }
}

export { ControlServer };
