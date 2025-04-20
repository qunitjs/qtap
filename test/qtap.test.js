import http from 'node:http';
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
  printVerbose: (str) => { console.error('# ' + str); }
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

  QUnit.test.each('runWaitFor() error handling', {
    'file null': {
      files: null,
      options,
      error: /Must pass one or more test files/,
    },
    'files empty array': {
      files: [],
      options,
      error: /Must pass one or more test files/,
    },
    'browser null': {
      files: 'notfound.html',
      browsers: null,
      options,
      error: /Must pass one or more browser names/,
    },
    'browser empty array': {
      files: 'notfound.html',
      browsers: [],
      options,
      error: /Must pass one or more browser names/,
    },
    'browser unknown': {
      files: 'notfound.html',
      browsers: 'unknown',
      options,
      error: /Unknown browser unknown/,
    },
    'file not found': {
      files: 'notfound.html',
      browsers: 'fake',
      options: {
        ...options,
        config: 'test/fixtures/qtap.config.js'
      },
      error: new Error('Could not open notfound.html'),
    },
    'config not found': {
      files: 'notfound.html',
      browsers: 'maybe',
      options: {
        ...options,
        config: 'test/config-notfound.js'
      },
      error: new Error('Could not open test/config-notfound.js'),
    },
    'config error': {
      files: 'notfound.html',
      browsers: 'maybe',
      options: {
        ...options,
        config: 'test/fixtures/qtap.config.error.js'
      },
      error: new Error('Loading test/fixtures/qtap.config.error.js failed: TypeError: Bad dong'),
    },
  }, async function (assert, params) {
    assert.timeout(10_000);

    await assert.rejects(
      qtap.runWaitFor(params.files, params.browsers, params.options),
      params.error
    );
  });

  QUnit.test.each('runWaitFor() finish', {
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
      params.files,
      'fake',
      params.options
    );

    assert.deepEqual(finish, params.expected);
    assert.deepEqual(finish.exitCode, 0, 'Exit code');
  });

  QUnit.test.each('run() events', {
    'browser URL from filename': {
      files: 'test/fixtures/fake_pass_4.txt',
      browsers: 'fakeEcho',
      options: {
        ...options,
        config: 'test/fixtures/qtap.config.js'
      },
      expected: [
        'client: running test/fixtures/fake_pass_4.txt',
        'online',
        'consoleerror: Browser URL is /test/fixtures/fake_pass_4.txt?qtap_clientId=client_1',
        'consoleerror: <script> found',
        'result: { ok: true, total: 4, passed: 4, failed: 0 }',
      ],
      exitCode: 0
    },
    'browser URL from filename with query string': {
      files: 'test/fixtures/fake_pass_4.txt?banana=1&apple=0',
      browsers: 'fakeEcho',
      options: {
        ...options,
        config: 'test/fixtures/qtap.config.js'
      },
      expected: [
        'client: running test/fixtures/fake_pass_4.txt',
        'online',
        'consoleerror: Browser URL is /test/fixtures/fake_pass_4.txt?banana=1&apple=0&qtap_clientId=client_1',
        'consoleerror: <script> found',
        'result: { ok: true, total: 4, passed: 4, failed: 0 }',
      ],
      exitCode: 0,
    },
    'browser URL from filename and custom cwd': {
      files: 'fixtures/fake_pass_4.txt?apple=0',
      browsers: 'fakeEcho',
      options: {
        ...options,
        cwd: 'test/',
        config: 'fixtures/qtap.config.js',
      },
      expected: [
        'client: running fixtures/fake_pass_4.txt',
        'online',
        'consoleerror: Browser URL is /fixtures/fake_pass_4.txt?apple=0&qtap_clientId=client_1',
        'consoleerror: <script> found',
        'result: { ok: true, total: 4, passed: 4, failed: 0 }',
      ],
      exitCode: 0,
    },
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
        'consoleerror: ReferenceError: bar is not defined',
        'consoleerror:   at /test/fixtures/fail-and-uncaught.html:14',
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
    connectTimeout: {
      files: 'test/fixtures/fake_pass_4.txt',
      browsers: 'fakeSlowFail',
      options: {
        ...options,
        config: 'test/fixtures/qtap.config.js',
        connectTimeout: 0.5
      },
      expected: [
        'client: running test/fixtures/fake_pass_4.txt',
        'bail: Browser did not start within 0.5s',
      ],
      exitCode: 1
    },
    connectFailWithoutRetry: {
      files: 'test/fixtures/fake_pass_4.txt',
      browsers: 'fakeRefuse',
      options: {
        ...options,
        config: 'test/fixtures/qtap.config.js',
        connectTimeout: 0.5
      },
      expected: [
        'client: running test/fixtures/fake_pass_4.txt',
        'bail: Browser did not start within 0.5s',
      ],
      exitCode: 1
    },
    connectAfterRetry: {
      files: 'test/fixtures/fake_pass_4.txt',
      browsers: 'fakeLazy',
      options: {
        ...options,
        config: 'test/fixtures/qtap.config.js',
        connectTimeout: 0.5
      },
      expected: [
        'client: running test/fixtures/fake_pass_4.txt',
        'online',
        'result: { ok: true, total: 4, passed: 4, failed: 0 }',
      ],
      exitCode: 0
    },
    console: {
      files: 'test/fixtures/console.html',
      options,
      expected: [
        'client: running test/fixtures/console.html',
        'online',
        'consoleerror: My warning 1 {"arr":[true,3]}',
        'consoleerror: My error 1 {"arr":[true,3]}',
        'consoleerror: Cyclical object {"a":"example","cycle":"[Circular]"}',
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
    qunitTodoSkip: {
      files: 'test/fixtures/qunit-todo-skip.html',
      options,
      expected: [
        'client: running test/fixtures/qunit-todo-skip.html',
        'online',
        'result: { ok: true, total: 4, passed: 4, failed: 0 }',
      ],
      exitCode: 0
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
        'consoleerror: ReferenceError: bar is not defined',
        'consoleerror:   at /test/fixtures/uncaught-early.html:3',
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
        'consoleerror: ReferenceError: bar is not defined',
        'consoleerror:   at /test/fixtures/uncaught-mid.html:5',
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
        'consoleerror: Error: Boo',
        'consoleerror:   at /test/fixtures/uncaught-custom.html:3',
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
        'consoleerror: ReferenceError: bar is not defined',
        'consoleerror:   at /test/fixtures/uncaught-multiple.html:3',
        'consoleerror: ReferenceError: quux is not defined',
        'consoleerror:   at /test/fixtures/uncaught-multiple.html:6',
        'bail: End of fixture',
      ],
      exitCode: 1
    },
  }, async function (assert, params) {
    assert.timeout(40_000);

    const run = qtap.run(params.files, params.browsers || 'firefox', params.options);
    const events = debugReporter(run);
    const result = await new Promise((resolve, reject) => {
      run.on('finish', resolve);
      run.on('error', reject);
    });

    assert.deepEqual(events, params.expected, 'Output');
    assert.deepEqual(result.exitCode, params.exitCode, 'Exit code');
  });

  // - The test server should serve the test file from an identically-looking
  //   URL (except on our port, and with an extra query parameter),
  //   and browser must see the path and query string of the given URL,
  //   so that you can control the test framework (e.g. QUnit URL parameters)
  //   via these parameters client-side.
  // - The origin server must receive our proxied request with the
  //   original path and parameters (without the qtap query parameter).
  //
  // See code comments in launchBrowser() for more information
  QUnit.test('run() events [browser URL from custom server]', async function (assert) {
    assert.timeout(40_000);

    const server = http.createServer((req, resp) => {
      if (req.url.startsWith('/test/example.html')) {
        resp.writeHead(200);
        resp.end(
          '# console: Origin server URL is ' + req.url + '\n'
            + 'TAP version 13\nok 1 Foo\nok 2 Bar\n1..2\n'
        );
      } else {
        resp.writeHead(404);
        resp.end('Not Found\n');
      }
    });
    server.listen();
    const port = await new Promise((resolve) => {
      // @ts-ignore
      server.on('listening', () => resolve(server.address().port));
    });

    const run = qtap.run(`http://localhost:${port}/test/example.html?foo=bar`,
      'fakeEcho',
      {
        ...options,
        config: 'test/fixtures/qtap.config.js'
      }
    );
    const events = debugReporter(run);
    const result = await new Promise((resolve, reject) => {
      run.on('finish', resolve);
      run.on('error', reject);
    });

    assert.deepEqual(events, [
      `client: running http://localhost:${port}/test/example.html?foo=bar`,
      'online',
      'consoleerror: Browser URL is /test/example.html?foo=bar&qtap_clientId=client_1',
      'consoleerror: <script> found',
      'consoleerror: Origin server URL is /test/example.html?foo=bar',
      'result: { ok: true, total: 2, passed: 2, failed: 0 }',
    ]);
    assert.deepEqual(result.exitCode, 0, 'Exit code');

    server.close();
  });
});
