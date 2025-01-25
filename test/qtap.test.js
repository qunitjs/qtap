import path from 'node:path';
import { fileURLToPath } from 'url';
import util from 'node:util';

import qtap from '../src/qtap.js';
import { ControlServer } from '../src/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cwd = path.join(__dirname, '..');
const options = {
  cwd,
  idleTimeout: 30,
  verbose: !!process.env.CI,
  // verbose: true, // debugging
  printDebug: (str) => { console.error('# ' + str); }
};

function debugReporter (eventbus) {
  const events = [];
  eventbus.on('client', (event) => events.push(`client: running ${event.testFile}`));
  eventbus.on('online', () => events.push('online'));
  eventbus.on('bail', (event) => events.push(`bail: ${event.reason}`));
  eventbus.on('consoleerror', (event) => events.push(`consoleerror: ${event.message}`));
  eventbus.on('result', (event) => {
    delete event.clientId;
    delete event.skips;
    delete event.todos;
    delete event.failures;
    events.push(`result: ${util.inspect(event, { colors: false })}`);
  });
  return events;
}

const EXPECTED_FAKE_PASS_4 = {
  ok: true,
  exitCode: 0,
  results: {
    client_1: {
      clientId: 'client_1',
      ok: true, total: 4, passed: 4, failed: 0,
      skips: [], todos: [], failures: [],
    }
  },
  bails: {},
};

QUnit.module('qtap', function (hooks) {
  hooks.beforeEach(() => {
    ControlServer.nextClientId = 1;
  });

  QUnit.test.each('runWaitFor()', {
    basic: {
      files: 'test/fixtures/fake_pass_4.txt',
      options: {
        ...options,
        config: 'test/fixtures/qtap.config.js'
      },
      expected: EXPECTED_FAKE_PASS_4
    },
    'options.cwd': {
      files: 'fixtures/fake_pass_4.txt',
      options: {
        ...options,
        cwd: __dirname,
        config: 'fixtures/qtap.config.js'
      },
      expected: EXPECTED_FAKE_PASS_4
    },
    'options.cwd files=../parent/file': {
      files: '../fake_pass_4.txt',
      options: {
        ...options,
        cwd: path.join(__dirname, 'fixtures/subdir/'),
        config: '../qtap.config.js'
      },
      expected: EXPECTED_FAKE_PASS_4
    },
    'options.cwd files=/full/path/file': {
      files: path.join(__dirname, 'fixtures/fake_pass_4.txt'),
      options: {
        ...options,
        cwd: path.join(__dirname, 'fixtures/subdir/'),
        config: path.join(__dirname, 'fixtures/qtap.config.js')
      },
      expected: EXPECTED_FAKE_PASS_4
    }
  }, async function (assert, params) {
    assert.timeout(40_000);

    const finish = await qtap.runWaitFor(
      'fake',
      params.files,
      params.options
    );

    assert.deepEqual(finish, params.expected);
  });

  QUnit.test.each('run() events', {
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
      options: {
        ...options,
        idleTimeout: 5
      },
      expected: [
        'client: running test/fixtures/fail-and-timeout.html',
        'online',
        'bail: Browser idle for 5s',
      ],
      exitCode: 1
    },
    failAndUncaught: {
      files: 'test/fixtures/fail-and-uncaught.html',
      options,
      expected: [
        'client: running test/fixtures/fail-and-uncaught.html',
        'online',
        'consoleerror: ReferenceError: bar is not defined\n  at /test/fixtures/fail-and-uncaught.html:14',
        'bail: End of fixture',
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
    console: {
      files: 'test/fixtures/console.html',
      options,
      expected: [
        'client: running test/fixtures/console.html',
        'online',
        'consoleerror: My warning 1 {"arr":[true,3]}'
          + '\nMy error 1 {"arr":[true,3]}'
          + '\nCyclical object {"a":"example","cycle":"[Circular]"}',
        'result: { ok: true, total: 1, passed: 1, failed: 0 }',
      ],
      exitCode: 0
    },
    mocking: {
      files: 'test/fixtures/mocking.html',
      options,
      expected: [
        'client: running test/fixtures/mocking.html',
        'online',
        'result: { ok: true, total: 4, passed: 4, failed: 0 }',
      ],
      exitCode: 0
    },
    qunitPass: {
      files: 'test/fixtures/qunit-pass.html',
      options,
      expected: [
        'client: running test/fixtures/qunit-pass.html',
        'online',
        'result: { ok: true, total: 1, passed: 1, failed: 0 }',
      ],
      exitCode: 0
    },
    qunitNotests: {
      files: 'test/fixtures/qunit-notests.html',
      options,
      expected: [
        'client: running test/fixtures/qunit-notests.html',
        'online',
        'result: { ok: false, total: 1, passed: 0, failed: 1 }',
      ],
      exitCode: 1
    },
    qunitFail: {
      files: 'test/fixtures/qunit-fail.html',
      options,
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
      options: {
        ...options,
        idleTimeout: 5
      },
      expected: [
        'client: running test/fixtures/timeout.html',
        'online',
        'bail: Browser idle for 5s',
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
        'consoleerror: ReferenceError: bar is not defined\n  at /test/fixtures/uncaught-early.html:3',
        'bail: End of fixture',
      ],
      exitCode: 1
    },
    uncaughtMid: {
      files: 'test/fixtures/uncaught-mid.html',
      options,
      expected: [
        'client: running test/fixtures/uncaught-mid.html',
        'online',
        'consoleerror: ReferenceError: bar is not defined\n  at /test/fixtures/uncaught-mid.html:5',
        'bail: End of fixture',
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
        'consoleerror: Error: Boo\n  at /test/fixtures/uncaught-custom.html:3',
        'bail: End of fixture',
      ],
      exitCode: 1
    },
    uncaughtMultiple: {
      files: 'test/fixtures/uncaught-multiple.html',
      options,
      expected: [
        'client: running test/fixtures/uncaught-multiple.html',
        'online',
        'consoleerror: ReferenceError: bar is not defined\n  at /test/fixtures/uncaught-multiple.html:3'
          + '\nReferenceError: quux is not defined\n  at /test/fixtures/uncaught-multiple.html:6',
        'bail: End of fixture',
      ],
      exitCode: 1
    },
  }, async function (assert, params) {
    assert.timeout(40_000);

    const run = qtap.run('firefox', params.files, params.options);
    const events = debugReporter(run);
    const result = await new Promise((resolve, reject) => {
      run.on('finish', resolve);
      run.on('error', reject);
    });

    assert.deepEqual(events, params.expected, 'Output');
    assert.deepEqual(result.exitCode, params.exitCode, 'Exit code');
  });
});
