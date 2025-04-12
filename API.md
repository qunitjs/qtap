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

## QTap basic events

### Event: `'error'`

* `error <Error|string>`

### Event: `'finish'`

* `event.ok <boolean>` Aggregate status of each client's results. If any failed, this is false.
* `event.exitCode <number>` Suggested exit code, 0 for success, 1 for failed.
* `event.bails <Object<string,string>>` For clients that bailed, this contains the bail reason keyed by client ID.
* `event.results <Object<string,Object>>` For clients completed their test, this contains the detailed `result` event object, keyed by client ID.

## QTap reporter events

A client will never emit these events more than once, except for `consoleerror`.

### Event: `'client'`

The `client` event is emitted when a client is created. A client is a dedicated browser instance that runs one test suite. For example, if you run 2 test suites in 3 different browsers, there will be 6 clients.

* `event.clientId <string>` An identifier unique within the current qtap process (e.g. `client_123`).
* `event.testFile <string>` Relative file path or URL (e.g. `test/index.html` or `http://localhost/test/`).
* `event.browserName <string>` Browser name, as specified in config or CLI (e.g. `firefox`).
* `event.displayName <string>` Browser pretty name, (e.g. "Headless Firefox").

### Event: `'online'`

The `online` event is emitted when a browser has successfully started and opened the test file. If a browser fails to connect, a `bail` event is emitted instead.

* `event.clientId <string>`

### Event: `'result'`

The `result` event is emitted when a browser has completed a test run. This is mutually exclusive with the `bail` event.

* `event.clientId <string>`
* `event.ok <boolean>`
* `event.total <number>`
* `event.passed <number>`
* `event.failed <number>`
* `event.skips <array>` Details about skipped tests (count as passed).
* `event.todos <array>` Details about todo tests (count as passed).
* `event.failures <array>` Details about failed tests.

### Event: `'bail'`

The `bail` event is emitted when a browser was unable to start or complete a test run.

* `event.clientId <string>`
* `event.reason <string>`

### Event: `'consoleerror'`

The `consoleerror` is event for any warnings or errors that may be observed from the browser console. These are for debug purposes only, and do not indicate that any test has failed. A complete and successful test run, may nonetheless print warnings or errors to the console.

It is recommended that reporters only display these if a browser bailed, or if the result includes failed tests.

* `event.clientId <string>`
* `event.message <string>`
