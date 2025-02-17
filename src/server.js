'use strict';

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { fnToStr, qtapClientHead, qtapClientBody } from './client.js';
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
    if (this.isURL(testFile)) {
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
      // Normalize testFile to "test/index.html".
      testFile = path.relative(root, testFileAbsolute);
      if (!testFile || testFile.startsWith('..')) {
        throw new Error(`Cannot serve ${testFile} from ${root}`);
      }
      // Normalize \backslash to POSIX slash, but only on Windows
      // * To use as-is in URLs (launchBrowser/qtapUrlPath).
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
    this.eventbus = eventbus;
    this.idleTimeout = options.idleTimeout;
    this.connectTimeout = options.connectTimeout;
    this.debugMode = options.debugMode;

    this.browsers = new Map();
    // Optimization: Prefetch test file in parallel with server creation and browser launching.
    // Once browsers are running and they make their first HTTP request,
    // we'll await this in handleRequest/getTestFile.
    this.testFilePromise = this.fetchTestFile(testFileAbsolute);

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

  /** @return {Promise<string>} HTML */
  async fetchTestFile (file) {
    // fetch() does not yet support file URLs (as of Node.js 21).
    if (this.isURL(file)) {
      this.logger.debug('testfile_fetch', `Requesting a copy of ${file}`);
      const resp = await fetch(file);
      if (!resp.ok) {
        throw new Error('Remote URL responded with HTTP ' + resp.status);
      }
      return await resp.text();
    } else {
      this.logger.debug('testfile_read', `Reading file contents from ${file}`);
      return (await fsPromises.readFile(file)).toString();
    }
  }

  async launchBrowser (browserFn, browserName, globalSignal) {
    const clientId = 'client_' + ControlServer.nextClientId++;
    const logger = this.logger.channel(`qtap_browser_${clientId}_${browserName}`);
    let clientIdleTimer = null;

    const controller = new AbortController();
    let signal = controller.signal;
    if (this.debugMode) {
      // Replace with a dummy signal that we never invoke
      signal = (new AbortController()).signal;
      controller.signal.addEventListener('abort', () => {
        logger.warning('browser_signal_debugging', 'Keeping browser open for debugging');
      });
    }

    /**
     * Reasons to stop a browser, whichever comes first:
     * 1. tap-finished.
     * 2. tap-parser 'bailout' event (client knows it crashed).
     * 3. timeout (client didn't start, lost connection, or unknowingly crashed).
     *
     * @param {string} messageCode
     * @param {string} [reason]
     * @param {Object} [finalResult]
     */
    const stopBrowser = async (messageCode, reason = '', finalResult = null) => {
      // Ignore any duplicate or late reasons to stop
      if (!this.browsers.has(clientId)) return;

      clearTimeout(clientIdleTimer);
      this.browsers.delete(clientId);
      controller.abort(`QTap: ${messageCode}`);

      if (finalResult) {
        this.eventbus.emit('result', {
          clientId,
          ok: finalResult.ok,
          total: finalResult.count,
          // avoid `finalResult.todo` because it would double-count passing TODOs
          passed: finalResult.pass + finalResult.todos.length,
          // avoid `finalResult.fail` because it includes TODOs (expected failure)
          failed: finalResult.failures.length,
          skips: finalResult.skips,
          todos: finalResult.todos,
          failures: finalResult.failures,
        });
      } else {
        this.eventbus.emit('bail', {
          clientId,
          reason,
        });
      }
    };

    const tapParser = tapFinished({ wait: 0 }, (finalResult) => {
      logger.debug('browser_tap_finished', 'Test run finished, stopping browser', {
        ok: finalResult.ok,
        total: finalResult.count,
        failed: finalResult.failures.length,
      });
      stopBrowser('browser_tap_finished', '', finalResult);
    });

    tapParser.on('bailout', (reason) => {
      logger.warning('browser_tap_bailout', `Test run bailed, stopping browser. Reason: ${reason}`);
      stopBrowser('browser_tap_bailout', reason);
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
    const TIMEOUT_CHECK_MS = 100;
    const browserStart = performance.now();
    const qtapCheckTimeout = () => {
      if (!browser.clientIdleActive) {
        if ((performance.now() - browserStart) > (this.connectTimeout * 1000)) {
          logger.warning('browser_connect_timeout', `Browser did not start within ${this.connectTimeout}s, stopping browser`);
          stopBrowser('browser_connect_timeout', `Browser did not start within ${this.connectTimeout}s`);
          return;
        }
      } else {
        if ((performance.now() - browser.clientIdleActive) > (this.idleTimeout * 1000)) {
          logger.warning('browser_idle_timeout', `Browser idle for ${this.idleTimeout}s, stopping browser`);
          stopBrowser('browser_idle_timeout', `Browser idle for ${this.idleTimeout}s`);
          return;
        }
      }
      clientIdleTimer = setTimeout(qtapCheckTimeout, TIMEOUT_CHECK_MS);
    };
    clientIdleTimer = setTimeout(qtapCheckTimeout, TIMEOUT_CHECK_MS);

    // Serve the a test file from URL that looks like the original path when possible.
    //
    // - For static files, serve it from a URL that matches were it would be among the
    //   other static files (even though it is treated special).
    //   "foo/bar" => "/foo/bar"
    //   "/tmp/foo/bar" => "/tmp/foo/bar"
    // - For external URLs, match the URL path, including query params, so that these
    //   can be seen both server-side and client-side.
    //
    // NOTE: This is entirely cosmetic. For how it is fetched, see fetchTestFile().
    // For how resources are fetched client side, we ensure correctness via <base href>.
    //
    // TODO: Add test case to validate this.
    //
    // Example: WordPress password-strength-meter.js inspects the hostname and path name
    // (e.g. www.mysite.test/mysite/). The test case for defaults observes this.
    // https://github.com/WordPress/wordpress-develop/blob/6.7.1/tests/qunit/wp-admin/js/password-strength-meter.js#L100
    let qtapUrlPath;
    if (this.isURL(this.testFile)) {
      const tmpUrl = new URL(this.testFile);
      tmpUrl.searchParams.set('qtap_clientId', clientId);
      qtapUrlPath = tmpUrl.pathname + tmpUrl.search;
    } else {
      qtapUrlPath = '/' + this.testFile + '?qtap_clientId=' + clientId;
    }

    const url = await this.getProxyBase() + qtapUrlPath;
    const signals = { browser: signal, global: globalSignal };

    try {
      logger.debug('browser_launch_call');

      // Separate calling browserFn() from awaiting so that we can emit an event
      // right after calling it (which may set Browser.displayName). If we awaited first,
      // then the event would be emitted after the client is done instead of when it starts.
      const browerPromise = browserFn(url, signals, logger, this.debugMode);
      this.eventbus.emit('client', {
        clientId,
        testFile: this.testFile,
        browserName,
        displayName: browser.getDisplayName(),
      });
      await browerPromise;

      // This stopBrowser() is most likely a no-op (e.g. if we received test results
      // or some error, and we asked the browser to stop). Just in case the browser
      // ended by itself, call it again here so that we can convey it as an error
      // if it was still running from our POV.
      logger.debug('browser_launch_exit');
      stopBrowser('browser_launch_exit', 'Browser ended unexpectedly');
    } catch (e) {
      if (!signal.aborted) {
        logger.warning('browser_launch_error', e);
        stopBrowser('browser_launch_error', 'Browser ended unexpectedly');
        throw e;
      }
    }
  }

  async getTestFile (clientId) {
    const proxyBase = await this.getProxyBase();
    const qtapTapUrl = proxyBase + '/.qtap/tap/?qtap_clientId=' + clientId;

    let headInjectHtml = `<script>(${fnToStr(qtapClientHead, qtapTapUrl)})();</script>`;

    // and URL-based files can fetch their resources directly from the original server.
    // * Prepend as early as possible. If the file has its own <base>, theirs will
    //   come later and correctly "win" by applying last (after ours).
    if (this.isURL(this.testFile)) {
      // especially if it was originally given as an absolute filesystem path
      headInjectHtml = `<base href="${util.escapeHTML(this.testFile)}"/>` + headInjectHtml;
    }

    let html = await this.testFilePromise;
    this.logger.debug('testfile_ready', `Finished fetching ${this.testFile}`);

    // Head injection
    // * Use a callback, to avoid accidental $1 substitutions via user input.
    // * Insert no line breaks, to avoid changing line numbers.
    // * Ignore <heading> and <head-thing>.
    // * Support <head x=y>, including with tab or newline.
    html = util.replaceOnce(html, [
      /<head(?:\s[^>]*)?>/i,
      /<html(?:\s[^>]*)?>/i,
      /<!doctype[^>]*>/i,
      /^/
    ],
    (m) => m + headInjectHtml
    );

    html = util.replaceOnce(html, [
      /<\/body>(?![\s\S]*<\/body>)/i,
      /<\/html>(?![\s\S]*<\/html>)/i,
      /$/
    ],
    (m) => '<script>(' + fnToStr(qtapClientBody, qtapTapUrl) + ')();</script>' + m
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
    if (clientId !== null) {
      // Serve the testfile from any URL path, as chosen by launchBrowser()
      const browser = this.browsers.get(clientId);
      if (!browser) {
        this.logger.debug('browser_connected_unknown', clientId);
        return this.serveError(resp, 403, 'Forbidden');
      }

      browser.logger.debug('browser_connected', `${browser.getDisplayName()} connected! Serving test file.`);
      this.eventbus.emit('online', { clientId });

      resp.writeHead(200, { 'Content-Type': util.MIME_TYPES[ext] || util.MIME_TYPES.html });
      resp.write(await this.getTestFile(clientId));
      resp.end();

      // Count proxying the test file toward connectTimeout, not idleTimeout.
      browser.clientIdleActive = performance.now();
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
