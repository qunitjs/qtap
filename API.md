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

You can define a browser launcher by implementing a function with the following signature. These launchers should either be async functions, or functions that return a Promise.

```js
/**
 * A browser launcher is responsible for opening a URL in the browser.
 *
 * A launcher is not responsible for knowing whether the browser succeeded in
 * opening or navigating to this URL.
 *
 * If a browser crashes or otherwise exits unexpectedly,
 * you should throw an Error or reject your returned Promise.
 *
 * @param {string} url
 *  URL that the browser should navigate to, HTTP or HTTPS.
 * @param {AbortSignal} signal
 *  The browser process must be terminated when this signal receives an "abort" event.
 *  QTap sends the "abort" event when it finds that a test run has finished, or if it
 *  needs to stop the browser for any other reason.
 * @param {qtap-Logger} logger
 * @return Promise<void>
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
import which from 'which';

async function mybrowser(url, signal, logger) {
  // spawn() uses the first entry that exists. If none of them exist, it throws.
  const binPaths = [
    process.env.MYBROWSER_BIN,                           // optional override
    which.sync('mybrowser', { nothrow: true }),          // Linux, search PATH
    '/Applications/MyBrowser.app/Contents/MacOS/mybrow', // macOS
    'C:\\Program Files\\MyBrowser\\mybrowser.exe',       // Windows
  ];
  await LocalBrowser.spawn(binPaths, [url, '-headless'], signal, logger);
}
```

### Example: Browser plugin with conditional locations

If you need conditionals or other logic, it is recommended to write a generator function so that as little logic is performed as possible. This way you don't need to compute a full array just to try the first few.

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

async function mybrowser(url, signal, logger) {
  await LocalBrowser.spawn(getMyPaths(), [url, '-headless'], signal, logger);
}
```

### Example: Browser plugin in plain Node.js

```js
async function mybrowser(url, signal, logger) {
    // 1. start browser that navigates to url
    // 2. when signal receives 'abort' event, stop browser.
    // 3. return/resolve once the process has ended.
    // 4. throw/reject if the process fails or can't start.

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
