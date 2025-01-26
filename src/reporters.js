import util from 'node:util';

import yaml from 'yaml';

function dynamic (eventbus) {
  /**
   * @typedef {Object} ClientState
   * @property {string} clientId
   * @property {string} displayName
   * @property {string} status
   * @property {null|string} lastline
   * @property {Array} failures
   */

  /** @type {Object<string,ClientState[]>} */
  const clientsByFile = Object.create(null);
  /** @type {Object<string,ClientState>} */
  const clientsById = Object.create(null);

  let screen = '';

  function render () {
    const icons = { waiting: '⢎', progress: '⠧', success: '✔', failure: '✘' };
    let str = '';
    for (const testFile in clientsByFile) {
      str += `\nRunning ${testFile}\n`;
      for (const client of clientsByFile[testFile]) {
        str += `* ${client.displayName} ${icons[client.status]} ${client.lastline || ''}\n`;
      }
    }

    if (screen) {
      const oldHeight = screen.split('\n').length;
      for (let i = 1; i < oldHeight; i++) {
        process.stdout.write('\x1b[A\x1b[K');
      }
    }

    process.stdout.write(str);
    screen = str;
  }

  eventbus.on('client', (event) => {
    const client = {
      clientId: event.clientId,
      displayName: event.displayName,
      status: 'waiting',
      lastline: null,
      failures: []
    };

    clientsByFile[event.testFile] ??= [];
    clientsByFile[event.testFile].push(client);
    clientsById[event.clientId] = client;
    render();
  });

  eventbus.on('online', (event) => {
    clientsById[event.clientId].status = 'progress';
    render();
  });

  eventbus.on('bail', (event) => {
    clientsById[event.clientId].status = 'failure';
    clientsById[event.clientId].lastline = event.reason;
    render();
  });

  eventbus.on('result', (event) => {
    clientsById[event.clientId].status = event.ok ? 'success' : 'failure';
    render();
  });
}

function plain (eventbus) {
  // Testing <file> in <browser>
  // Testing N file(s) in N browser(s)

  eventbus.on('client', (event) => {
    console.log(util.styleText('grey', `[${event.clientId}]`) + ` Opening ${event.testFile} in ${event.displayName}`);
  });
  eventbus.on('online', (event) => {
    console.log(util.styleText('grey', `[${event.clientId}]`) + ' Running...');
  });
  eventbus.on('consoleerror', (event) => {
    console.log(util.styleText('grey', `[${event.clientId}]`) + ' Console:\n' + util.styleText('yellow', event.message));
  });
  eventbus.on('bail', (event) => {
    console.log(util.styleText('grey', `[${event.clientId}]`) + ` Error! ${event.reason}`);
  });
  eventbus.on('result', (event) => {
    // TODO: Report wall-clock runtime
    console.log(util.styleText('grey', `[${event.clientId}]`) + ` Finished! Ran ${event.total} tests, ${event.failed} failed.`);

    if (event.skips.length) {
      const minimalResults = event.skips.map((result) => {
        return result.fullname;
      });
      console.log(util.styleText('cyan', `${minimalResults.length} Skipped:`));
      console.log(yaml.stringify(minimalResults));
    }
    if (event.todos.length) {
      const minimalResults = event.todos.map((result) => {
        return {
          name: result.fullname,
          diag: result.diag
        };
      });
      console.log(util.styleText('yellow', `${minimalResults.length} Todos:`));
      console.log(yaml.stringify(minimalResults));
    }
    if (event.failures.length) {
      const minimalResults = event.failures.map((result) => {
        return {
          name: result.fullname,
          diag: result.diag
        };
      });
      console.log(util.styleText('red', `${minimalResults.length} Failures:`));
      console.log(yaml.stringify(minimalResults));
    }
  });
}

const isTTY = false; // process.stdout.isTTY && process.env.TERM !== 'dumb';
const minimal = isTTY ? dynamic : plain;

function none (_eventbus) {}

export default { none, minimal };

// TODO: Add a 'tap' reporter, that merges and verbosely merges and forwards
// all original tap lines. Test names prepended with "Test file in Browser > ".

// TODO: Add an dynamic version of the 'minimal' reporter, falling back if no TTY.
// The main value of this dynamic version would be to show failures right as
// they come in, instead of only after a test run has finished.
/*

  Running /test/pass.html
  * Firefox  ⠧ ok 3 Baz > another thing
  * Chrome   ⠧ ok 1 Foo bar

  ===============================================================

  Running /test/pass.html
  * Firefox  ✔ Ran 4 tests in 42ms
  * Chrome   ✔ Completed 4 tests in 42ms

  ===============================================================

  Running /test/fail.html
  * Firefox  ⠧ not ok 2 example > hello fail
  * Chrome   ⠧ ok 1 Foo bar

  There was 1 failure

  1. Firefox - example > hello fail
    ---
    actual  : foo
    expected: bar
    ...

  ===============================================================

  Running /test/fail.html
  * Firefox  ⠧ ok 3 Quux # update to next result, but with red spinner
  * Chrome   ⠧ ok 3 Quux

  There were 2 failures

  1. Firefox - example > hello fail
    ---
    actual  : foo
    expected: bar
    ...

  2. Chrome - example > hello fail
    ---
    actual  : foo
    expected: bar
    ...

  ===============================================================

  Running /test/fail.html
  * Firefox  ✘ Ran 3 tests in 42ms (1 failed)
  * Chrome   ✘ Completed 3 tests in 42ms (1 failed)
  * Chrome   ✘ 1 failed test

  There were 2 failures

  1. Firefox - example > hello fail
    ---
    actual  : foo
    expected: bar
    ...

  2. Chrome - example > hello fail
    ---
    actual  : foo
    expected: bar
    ...

  ===============================================================

  Running /test/timeout.html
  * Firefox  ⠧ ok 2 Baz > this thing
  * Chrome   ⠧ ok 1 Foo bar

  ===============================================================

  Running /test/timeout.html
  * Firefox  ? Test timed out after 30s of inactivity
  * Chrome   ? Test timed out after 30s of inactivity

  ===============================================================

  Running /test/connect-timeout.html
  * Firefox  ⢎ Waiting...
  * Chrome   ⢎ Waiting...

  Running /test/connect-timeout.html
  * Firefox  ? Browser did not start within 60s
  * Chrome   ? Browser did not start within 60s

        "interval": 80,
        "frames": [
            "⠋",
            "⠙",
            "⠹",
            "⠸",
            "⠼",
            "⠴",
            "⠦",
            "⠧",
            "⠇",
            "⠏"
        ]
        "frames": [
            "⢎ ",
            "⠎⠁",
            "⠊⠑",
            "⠈⠱",
            " ⡱",
            "⢀⡰",
            "⢄⡠",
            "⢆⡀"
        ]
*/
