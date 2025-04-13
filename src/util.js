'use strict';

import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MIME_TYPES = {
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

/**
 * @param {number} msDuration
 * @returns {string} Something like "0.7", "2", or "3.1"
 */
export function humanSeconds (msDuration) {
  return (msDuration / 1000)
    .toFixed(1)
    .replace(/\.(0+)?$/, '');
}

export function concatGenFn (...fns) {
  return function * () {
    for (const fn of fns) {
      yield * fn();
    }
  };
}

export function stripAsciEscapes (text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9]+m/g, '');
}

export function fnToStr (fn, qtapTapUrl) {
  return fn
    .toString()
    .replace(/\/\/.+$/gm, '')
    .replace(/\n|^\s+/gm, ' ')
    .replace(
      /'{{QTAP_TAP_URL}}'/g,
      JSON.stringify(qtapTapUrl)
    );
}

export function escapeHTML (text) {
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

export function replaceOnce (input, patterns, replacement) {
  for (const pattern of patterns) {
    if (pattern.test(input)) {
      return input.replace(pattern, replacement);
    }
  }
  return input;
}

export class CommandNotFoundError extends Error {}

export const LocalBrowser = {
  /**
   * @param {string|Array<string|null>|Generator<string|null|undefined>} paths
   *  Path to an executable command or an iterable list of candidate paths to
   *  check and use the first one that exists.
   *
   *  If you need to vary list items by platform or environment variables, it may
   *  be easier to write your list as a generator function with as little or much
   *  conditional logic around yield statements as-needed.
   *
   *  Any `undefined` or `null` entries are automatically skipped, to make it
   *  easy to include the result of `process.env.YOUR_KEY` or `which.sync()`.
   *
   *  See getFirefoxPaths for an example.
   *
   * @param {Array<string>} args List of string arguments, passed to child_process.spawn()
   *  which will automatically quote and escape these.
   * @param {Object<string,AbortSignal>} signals
   * @return {Promise<void>}
   */
  async spawn (paths, args, signals, logger) {
    if (typeof paths === 'string') {
      paths = [paths];
    }
    let exe;
    for (const candidate of paths) {
      if (candidate !== undefined && candidate !== null) {
        // Optimization: Use fs.existsSync. It is on par with accessSync and statSync,
        // and beats concurrent fs/promises.access(cb) via Promise.all().
        // Starting the promise chain alone takes the same time as a loop with
        // 5x existsSync(), not even counting the await and boilerplate to manage it all.
        if (fs.existsSync(candidate)) {
          logger.debug('browser_exe_found', candidate);
          exe = candidate;
          break;
        } else {
          logger.debug('browser_exe_check', candidate);
        }
      }
    }
    if (!exe) {
      throw new CommandNotFoundError('No executable found');
    }

    logger.debug('browser_spawn_command', exe, args);
    const spawned = cp.spawn(exe, args, { signal: signals.browser });

    let stdout = '';
    let stderr = '';
    spawned.stdout.on('data', data => {
      stdout += data;
    });
    spawned.stderr.on('data', data => {
      stderr += data;
    });

    return new Promise((resolve, reject) => {
      spawned.on('error', error => {
        reject(error);
      });
      spawned.on('exit', (code, sig) => {
        const indent = (str) => str.trim().split('\n').map(line => '    ' + line).join('\n');
        if (!code) {
          logger.debug('browser_spawn_exit', `Process exited with code ${code}`);
          resolve();
        } else {
          const details = `Process exited with code ${code}`
            + (sig ? `\n  signal: ${sig}` : '')
            + (stderr ? `\n  stderr:\n${indent(stderr)}` : '')
            + (stdout ? `\n  stdout:\n${indent(stdout)}` : '');
          logger.debug('browser_spawn_exit', details);
          reject(new Error(details));
        }
      });
    });
  },

  /**
   * Create a new temporary directory and return its name.
   *
   * This creates subdirectories inside Node.js `os.tmpdir`, which honors
   * any TMPDIR, TMP, or TEMP environment variable.
   *
   * The newly created directory is automatically cleaned up at the end of the process.
   *
   * @param {Object<string,AbortSignal>} signals
   * @returns {string}
   */
  makeTempDir (signals, logger) {
    // Use mkdtemp (instead of only tmpdir) to avoid clash with past or concurrent qtap procesess.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qtap_'));

    logger.debug('tempdir_created', dir);

    signals.global.addEventListener('abort', () => {
      // Support Windows, Node 20-23: Avoid ENOTEMPTY after spawn() returns for mwedge.exe
      // It seems a background process continues to write files, thus turning emptied dirs
      // back into non-empty dirs.
      // > ENOTEMPTY: directory not empty
      // > at Object.rmdirSync (node:fs)
      // > at rimrafSync (node:internal/fs/rimraf)
      // > at fs.rmSync (node:fs)
      // This affects Node 20-23. Node 24 switches from rimraf/rmdirSync to native.
      //
      // Support Windows: Avoid EBUSY after spawn() returns for firefox.exe.
      // We sometimes can't delete a temporary file because it is somehow still in use.
      // Perhaps a race condition, or a lagged background process?
      // > BUSY: resource busy or locked,
      // > at unlink 'C:\Users\gh\AppData\Local\Temp\qtap_EZ\bounce-tracking-protection.sqlite'
      //
      // Workaround:
      // - Enable `maxRetries` in case we just need to wait a little bit
      // - use try-catch to ignore further errors, because it is not critical for test completion.
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
        logger.debug('tempdir_removed', dir);
      } catch (e) {
        logger.warning('tempdir_rm_error', e);
      }
    });

    return dir;
  }
};
