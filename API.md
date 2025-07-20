# QTap API

## Configuration

You can define additional browsers by declaring them in a file called `qtap.config.js` in the current directory, or any other importable JavaScript file passed specified via the `qtap --config` option.

```js
// ESM
export default {
  browsers: {
    foo,
    bar,
    quux
  }
}

// CommonJS
module.exports = {
  browsers: {
    foo,
    bar,
    quux
  }
};
```

## QTap browser plugin

Implement a function with the following signature to define a browser launcher for QTap.

Responsibilities:
* Try to open a URL in the browser. (Do not worry about whether the browser succeeded in opening or navigating to this URL.)
* When you receive an "abort" event on `signals.browser`, you must close the browser.
  QTap sends the "abort" event when it finds that a test results are complete, or if it
  needs to stop the browser for any other reason.
* The async function or Promise must return/resolve after the browser is closed.
* If the browser crashes or fails to start, you should throw an Error or reject the Promise.

```js
/**
 * @param {string} url URL that the browser should navigate to, HTTP or HTTPS.
 * @param {Object<string,AbortSignal>} signals
 * @param {qtap-Logger} logger
 * @return Promise<void>
 */
async function mybrowser(url, signals, logger);
```

### Example: Browser plugin with `LocalBrowser.spawn()`

The `LocalBrowser.spawn()` utility can take care of these responsibilities for you,
in the common case of a browser that you start by executing a local command and that accepts a URL as command-line argument.

```js
import { LocalBrowser } from 'qtap';

export default {
  browsers: {
    async mybrowser(url, signals, logger) {
      await LocalBrowser.spawn('/bin/mybrowser', [url, '-headless'], signals, logger);
    }
  }
}
```

```sh
$ qtap -c qtap.config.js -b mybrowser test/index.html
```

### Example: Browser plugin with multiple possible locations

The `LocalBrowser.spawn()` utility can automatically check multiple locations where the browser may be installed. For example, across different operating systems and platforms. When you pass an array as command, QTap will use the first entry that exists.

```js
import { LocalBrowser } from 'qtap';
import which from 'which';

async function mybrowser(url, signals, logger) {
  const binPaths = [
    process.env.MYBROWSER_BIN,                           // optional override
    which.sync('mybrowser', { nothrow: true }),          // Linux, search PATH
    '/Applications/MyBrowser.app/Contents/MacOS/mybrow', // macOS
    'C:\\Program Files\\MyBrowser\\mybrowser.exe',       // Windows
  ];
  await LocalBrowser.spawn(binPaths, [url, '-headless'], signals, logger);
}
```

### Example: Browser plugin with conditional locations

If you need conditionals or other logic, you could build up an array in steps (e.g. using Array.push, or the spread operator). However, `LocalBrowser.spawn` supports iterators, so an even easier way is by writing a generator function. This way your logic can be written minimally and inline, directly between your values, without needing to create and populate a complete array.

```js
import { LocalBrowser } from 'qtap';
import which from 'which';

function* getMyPaths() {
  yield process.env.MYBROWSER_BIN;
  yield which.sync('mybrowser', { nothrow: true });

  if (process.platform === 'darwin') yield '/Applications/MyBrowser.app/Contents/MacOS/mybrow';

  if (process.platform === 'win32') {
    for (const prefix of new Set([[
      process.env.LOCALAPPDATA,
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.ProgramW6432,
      'C:\\Program Files'
    ])) {
      if (prefix) yield prefix + '\\MyBrowser\\mybrow.exe';
    }
  }
}

async function mybrowser(url, signals, logger) {
  await LocalBrowser.spawn(getMyPaths(), [url, '-headless'], signals, logger);
}
```

### Example: Browser plugin in plain Node.js

```js
async function mybrowser(url, signals, logger) {
    // 1. start browser that navigates to the url
    // 2. when signal receives 'abort' event, child_process kills the browser.
    // 3. return/resolve once the process has ended.
    // 4. throw/reject if the process fails or can't start.

    const spawned = child_process.spawn('/bin/mybrowser', ['-headless', url], { signal: signals.browser });
    await new Promise((resolve, reject) => {
      spawned.on('error', (error) => reject(error));
      spawned.on('exit', (code) => !code ? resolve() : reject(new Error(`Process exited ${code}`)));
    });
}

export default {
  browsers: { mybrowser }
}
```

### Example: Browser plugin entirely custom

To start a cloud-based browser via a Web API, or something else that isn't a local process, you can use the signal and Promise directly, like so:

```js
async function mybrowser (url, signals) {
  const workerId = something.api.start(url);

  await new Promise((resolve, reject) => {
    signals.browser.addEventListener('abort', () => {
      something.api.stop(workerId).then(resolve, reject);
    });
  });
}
```

## QTap summary events

These are emitted at most once for the run overall.

### Event: `'clients'`

The `clients` event conveys which browsers are being started, and which tests will be run. It is emitted as soon as QTap has validated the parameters. Each client is a browser process that runs one test suite. For example, if you run 2 test suites in 3 different browsers, there will be 6 clients.

* `event.clients {Object<string,Object>}` Keyed by clientId
  * `clientId {string}` An identifier unique within the current qtap process (e.g. `client_123`).
  * `testFile {string}` Relative file path or URL (e.g. `test/index.html` or `http://localhost/test/`).
  * `browserName {string}` Browser name, as specified in config or CLI (e.g. `firefox`).
  * `displayName {string}` Browser pretty name (e.g. "Headless Firefox").

### Event: `'error'`

* `error {Error|string}`

### Event: `'finish'`

Summary event based on the `clientresult` events. This is mutually exclusive with `error`.

* `event.ok {boolean}` Aggregate status of each client's results. If any failed or bailed, this is false.
* `event.exitCode {number}` Suggested exit code, 0 for success, 1 for failed or bailed.
* `event.total {number}` Aggregated from `clientresult` events.
* `event.passed {number}` Aggregated from `clientresult` events.
* `event.failed {number}` Aggregated from `clientresult` events.

## QTap client events

These are emitted once per client, except `clientconsole` and `clientassert` which may be emitted many times by a client during a test run.

### Event: `'clientonline'`

The `clientonline` event is emitted when a browser has successfully started and opened the test file. If a browser fails to start or connect, then the `error` event is emitted instead.

* `event.clientId {string}`
* `event.testFile {string}`
* `event.browserName {string}`
* `event.displayName {string}`

### Event: `'clientresult'`

The `clientresult` event is emitted when a browser has completed a test run. This includes if it bailed mid-run, such as when a test run times out.

* `event.clientId {string}`
* `event.ok {boolean}`
* `event.total {number}`
* `event.passed {number}`
* `event.failed {number}`
* `event.skips {array}` Details about skipped tests (count as passed).
* `event.todos {array}` Details about todo tests (count as passed).
* `event.failures {array}` Details about failed tests.
* `event.bailout {false|string}`

### Event: `'clientconsole'`

The `clientconsole` event relays any warnings and uncaught errors from the browser console. These are for debug purposes only, and do not cause a test run to fail per-se. A complete and successful test run, may nonetheless print warnings or errors to the console.

Note that test frameworks such as QUnit may catch global errors during a test

It is recommended that reporters only display console errors if a test run failed (i.e. there was a failed test result, or an uncaught error).

* `event.clientId {string}`
* `event.message {string}`

### Event: `'assert'`

The `assert` event describes a single test result (whether passing or failing). This can be used by reporters to indicate activity, display the name of a test in real-time, or to convey failures early.

* `event.clientId {string}`
* `event.ok {boolean}`
* `event.fullname {string}`
* `event.diag {undefined|Object}`
