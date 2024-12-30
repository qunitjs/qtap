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

  async cleanupOnce() {
    // Optional
  }
};

export default {
  browsers: {
    foo: MyBrowser
  }
}
```
