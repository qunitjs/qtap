import path from 'node:path';
import { fileURLToPath } from 'url';
import util from 'node:util';

import qtap from '../src/qtap.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, '..');
const options = {
  root,
  timeout: 2,
  verbose: !!process.env.CI,
  // verbose: true, // debugging
  printDebug: (str) => { console.error('# ' + str); }
};

function debugReporter (eventbus) {
  const steps = [];
  eventbus.on('client', (event) => steps.push(`client: running ${event.testFile}`));
  eventbus.on('online', () => steps.push('online'));
  eventbus.on('bail', (event) => steps.push(`bail: ${event.reason}`));
  eventbus.on('consoleerror', (event) => steps.push(`consoleerror: ${event.message}`));
  eventbus.on('result', (event) => {
    delete event.clientId;
    delete event.skips;
    delete event.todos;
    delete event.failures;
    steps.push(`result: ${util.inspect(event, { colors: false })}`);
  });
  return steps;
}

QUnit.module('qtap', function () {
  QUnit.test.each('run', {
    pass: {
      files: 'test/fixtures/pass.html',
      options,
      expected: [
        'client: running test/fixtures/pass.html',
        'online',
        'result: { ok: true, total: 4, passed: 4, failed: 0 }',
      ],
      exitCode: 0
    },
    fail: {
      files: 'test/fixtures/fail.html',
      options,
      expected: [
        'client: running test/fixtures/fail.html',
        'online',
        'result: { ok: false, total: 3, passed: 2, failed: 1 }',
      ],
      exitCode: 1
    },
    failAndTimeout: {
      files: 'test/fixtures/fail-and-timeout.html',
      options,
      expected: [
        'client: running test/fixtures/fail-and-timeout.html',
        'online',
        'bail: Browser idle for 2s',
      ],
      exitCode: 1
    },
    failAndUncaught: {
      files: 'test/fixtures/fail-and-uncaught.html',
      options,
      expected: [
        'client: running test/fixtures/fail-and-uncaught.html',
        'online',
        'consoleerror: ReferenceError: bar is not defined\n  at /test/fixtures/fail-and-uncaught.html:15',
        'bail: Browser idle for 2s',
      ],
      exitCode: 1
    },
    bail: {
      files: 'test/fixtures/bail.html',
      options,
      expected: [
        'client: running test/fixtures/bail.html',
        'online',
        'bail: Need more cowbell.',
      ],
      exitCode: 1
    },
    qunitPass: {
      files: 'test/fixtures/qunit-pass.html',
      options: {
        ...options,
        timeout: 30,
      },
      expected: [
        'client: running test/fixtures/qunit-pass.html',
        'online',
        'result: { ok: true, total: 1, passed: 1, failed: 0 }',
      ],
      exitCode: 0
    },
    qunitFail: {
      files: 'test/fixtures/qunit-fail.html',
      options: {
        ...options,
        timeout: 30,
      },
      expected: [
        'client: running test/fixtures/qunit-fail.html',
        'online',
        'result: { ok: false, total: 4, passed: 3, failed: 1 }',
      ],
      exitCode: 1
    },
    skip: {
      files: 'test/fixtures/skip.html',
      options,
      expected: [
        'client: running test/fixtures/skip.html',
        'online',
        'result: { ok: true, total: 4, passed: 4, failed: 0 }',
      ],
      exitCode: 0
    },
    slow: {
      files: 'test/fixtures/slow.html',
      options,
      expected: [
        'client: running test/fixtures/slow.html',
        'online',
        'result: { ok: true, total: 4, passed: 4, failed: 0 }',
      ],
      exitCode: 0
    },
    timeout: {
      files: 'test/fixtures/timeout.html',
      options,
      expected: [
        'client: running test/fixtures/timeout.html',
        'online',
        'bail: Browser idle for 2s',
      ],
      exitCode: 1
    },
    todo: {
      files: 'test/fixtures/todo.html',
      options,
      expected: [
        'client: running test/fixtures/todo.html',
        'online',
        'result: { ok: true, total: 4, passed: 4, failed: 0 }',
      ],
      exitCode: 0
    },
    uncaughtEarly: {
      files: 'test/fixtures/uncaught-early.html',
      options,
      expected: [
        'client: running test/fixtures/uncaught-early.html',
        'online',
        'consoleerror: ReferenceError: bar is not defined\n  at /test/fixtures/uncaught-early.html:4',
        'bail: Browser idle for 2s',
      ],
      exitCode: 1
    },
    uncaughtMid: {
      files: 'test/fixtures/uncaught-mid.html',
      options,
      expected: [
        'client: running test/fixtures/uncaught-mid.html',
        'online',
        'consoleerror: ReferenceError: bar is not defined\n  at /test/fixtures/uncaught-mid.html:6',
        'bail: Browser idle for 2s',
      ],
      exitCode: 1
    },
    uncaughtLate: {
      files: 'test/fixtures/uncaught-late.html',
      options,
      expected: [
        'client: running test/fixtures/uncaught-late.html',
        'online',
        'result: { ok: true, total: 4, passed: 4, failed: 0 }',
      ],
      exitCode: 0
    },
    uncaughtCustom: {
      files: 'test/fixtures/uncaught-custom.html',
      options,
      expected: [
        'client: running test/fixtures/uncaught-custom.html',
        'online',
        'consoleerror: Error: Boo\n  at /test/fixtures/uncaught-custom.html:4',
        'bail: Browser idle for 2s',
      ],
      exitCode: 1
    },
    uncaughtMultiple: {
      files: 'test/fixtures/uncaught-multiple.html',
      options,
      expected: [
        'client: running test/fixtures/uncaught-multiple.html',
        'online',
        'consoleerror: ReferenceError: bar is not defined\n  at /test/fixtures/uncaught-multiple.html:4'
          + '\nReferenceError: quux is not defined\n  at /test/fixtures/uncaught-multiple.html:7',
        'bail: Browser idle for 2s',
      ],
      exitCode: 1
    },
  }, async function (assert, params) {
    assert.timeout(10_000);

    const run = qtap.run(
      'firefox',
      params.files,
      params.options
    );

    const steps = debugReporter(run);
    const result = await new Promise((resolve, reject) => {
      run.on('finish', resolve);
      run.on('error', reject);
    });

    assert.deepEqual(steps, params.expected, 'Output');
    assert.deepEqual(result.exitCode, params.exitCode, 'Exit code');
  });
});
