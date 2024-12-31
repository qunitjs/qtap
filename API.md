# QTap API

## Configuration

You can define additional browsers by declaring them in a file called
`qtap.config.js` in the current directory, or any other importable
JavaScript file passed specified via the `qtap --config` option.

```js
// ESM
export default {
  browsers: {
    foo,
    bar,
    quux,
  }
}
```

```js
// CommonJS
module.exports = {
  browsers: {
    foo,
    bar,
    quux,
  }
}
```

## qtap.Browser interface

Browser plugins are defined by implementing a launch function with the
following signature. Launchers are either an async function, or a
function that returns a Promise.

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
 * @return {Promise}
 */
launch(url, signal, logger);
```

The browser is then registered in one of three ways:

* `object`: an object with `launch` method.
* `function`: a function that returns such object.
* `class`: a class that implement a `launch` method.

### Browser examples

```js
const browserObj = {
  async launch(url, signal, logger) {
    // open browser
    // navigate to url
    // stop browser when signal sends 'abort' event.
    // return/resolve once the process ends.
    // throw/reject if the process fails or can't start.
  }
};

export default {
  browsers: {
    foo: browserObj
  }
}
```
```js
function browserFn(logger) {
  // ..

  return {
    async launch(url, signal, logger) {
      // ...
    }
  };
};

export default {
  browsers: {
    foo: browserFn
  }
}
```
```js
class MyBrowser {
  constructor (logger) {
    // ...
  }

  async launch(url, signal, logger) {
    // ...
  }
};

export default {
  browsers: {
    foo: MyBrowser
  }
}
```
