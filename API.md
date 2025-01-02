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

## QTap browser interface

Browsers are defined by implementing a launcher function with the following signature. Launchers are either an async function, or a function that returns a Promise.

```js
/**
 * A browser launcher is responsible for knowing whether the process failed to
 * launch or spawn, and whether it exited unexpectedly.
 *
 * A launcher is not responsible for knowing whether it succeeded in
 * opening or navigating to the given URL.
 *
 * It is the responsiblity of ControlServer to send the "abort" event
 * to AbortSignal if it believes the browser has failed to load the
 * URL within a reasonable timeout, or if the browser has not sent
 * any message for a while.
 *
 * If a browser exits on its own (i.e. ControlServer did not call send
 * an abort signal), then launch() should throw an Error or reject its
 * returned Promise.
 *
 * @param {string} url
 *  URL that the browser should navigate to, HTTP or HTTPS.
 * @param {AbortSignal} signal
 *  The launched browser process must be terminated when this signal
 *  receives an "abort" event. QTap sends the abort event when it finds that
 *  a test has finished, or if it needs to stop the browser for any other
 *  reason.
 * @param {qtap-Logger} logger
 */
async function myBrowserLauncher(url, signal, logger);
```

### Example: Browser plugin with `LocalBrowser.spawn()`

```js
import { LocalBrowser } from 'qtap';

async function mybrowser(url, signal, logger) {
  await LocalBrowser.spawn('/bin/mybrowser', [url, '-headless'], signal, logger);
}

export default {
  browsers: { mybrowser }
}
```

### Example: Browser plugin with multiple possible locations

Support different locations where the browser may be installed, including across OS platforms.

```js
import { LocalBrowser } from 'qtap';

async function mybrowser(url, signal, logger) {
  // spawn() uses the first entry that exists, or fails the test by throwing if none was found
  const binPaths = [
    process.env.MYBROWSER_BIN,                           // optional override
    which.sync('mybrowser', { nothrow: true }),          // Linux, search PATH
    '/Applications/Firefox.app/Contents/MacOS/firefox',  // macOS
    'C:\\Program Files\\Mozilla Firefox\\firefox.exe',   // Windows
  ];
  await LocalBrowser.spawn(binPaths, [url, '-headless'], signal, logger);
}
```

### Example: Browser plugin with conditional locations

If you need conditionals or other logic, it is recommended to write a generator function so that as little logic is performed as possible. This way you don't need to compute a full array just to try the first few.

```js
import { LocalBrowser } from 'qtap';

function* getMyPaths() {
  yield process.env.MYBROWSER_BIN;
  yield which.sync('mybrowser', { nothrow: true });

  if (process.platform === 'darwin') yield '/Applications/MyBrowser.app/Contents/MacOS/mybrow';

  if (process.platform === 'win32') {
    for (const prefix of [
      process.env.LOCALAPPDATA,
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.ProgramW6432,
      'C:\\Program Files'
    ]) {
      if (prefix) yield prefix + '\\MyBrowser\\mybrow.exe';
    }
  }
}

async function mybrowser(url, signal, logger) {
  await LocalBrowser.spawn(getMyPaths(), [url, '-headless'], signal, logger);
}
```

### Example: Browser plugin in plain Node.js

```js
async function mybrowser(url, signal, logger) {
    // 1. start browser that navigates to url
    // 2. when signal sends 'abort' event, stop browser.
    // 3. return/resolve once the process has ended.
    // 4. throw/reject if the process fails to start.

    const spawned = child_process.spawn('/bin/mybrowser', ['-headless', url], { signal });
    await new Promise((resolve, reject) => {
      spawned.on('error', (error) => reject(error));
      spawned.on('exit', (code) => reject(new Error(`Process exited ${code}`)));
    });
}

export default {
  browsers: { mybrowser }
}
```
