/**
 * Copyright (c) 2013 James Halliday
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * --
 *
 * This is based on https://github.com/tapjs/tap-finished/tree/v0.0.3 with
 * the following modifications for QTap:
 *
 * - https://github.com/tapjs/tap-finished/pull/2
 *   Upgrade from tap-parser@5 to tap-parser@18, so that QTap doesn't pull in the
 *   35 dependencies that tap-parser@5 carried to support old Node.js versions.
 */
'use strict';

import { Parser } from 'tap-parser';

export default function tapFinished (opts, cb) {
  if (typeof opts === 'function') {
    cb = opts;
    opts = {};
  }
  if (!opts) { opts = {}; }
  if (opts.wait === undefined) { opts.wait = 1000; }

  const p = new Parser();
  const seen = {
    /** @type {number|null} */
    plan: null,
    /** @type {any[]} https://stackoverflow.com/a/57563877/319266 */
    asserts: []
  };
  let finished = false;
  let ended = false;

  function finish () {
    finished = true;

    p.on('complete', function (finalResult) {
      cb(Object.assign({}, finalResult, { asserts: seen.asserts }));
    });
    if (opts.wait && !ended) {
      setTimeout(function () { p.end(); }, opts.wait);
    } else { p.end(); }
  }

  function check () {
    if (finished) { return; }
    if (seen.plan === null || seen.asserts.length < seen.plan) { return; }
    finish();
  }

  p.on('end', function () { ended = true; });

  p.on('assert', function (result) {
    seen.asserts.push(result);
    check();
  });

  p.on('plan', function (plan) {
    seen.plan = plan.end - plan.start;
    check();
  });

  p.on('complete', function () {
    if (finished) { return; }
    finish();
  });

  return p;
}
