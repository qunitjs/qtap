# QTap Architecture

This describes priorities and values, design goals, considered alternatives, and any significant assumptions, caveats, or intentional trade-offs made during development.

## High-level

We write simple and long-term stable code in Node.js.

We favour a single way of doing something that works everywhere,
over marginal gains that would introduce layers of indirection,
abstraction, conditional branches, or add dependencies.

We favour explicit and efficient inlined implementation in the form
of a single stable and well-documented (but slightly) function, over
many local single-use functions.

We will have at most 5 npm packages as direct dependencies.

Requirements for dependencies:

* must solve a non-trivial problem, e.g. something that is not
  easily implemented in <50 lines of code that we could write once
  inline and then use long-term without changes.
* may not exceed 10KB in size (minified before gzip), and
  may carry at most 1 indirect or transitive dependency which
  in turn may not have any dependencies.
* must be audited and understood by us as if they were our own code,
  including after each time we upgrade the version we depend on.
* may not be directly exposed via the QTap API (whether QTap module
  export or QTap CLI), such that we can freely internally upgrade,
  replace, or remove this dependency in a semver-minor release.

## Debugging

Set `QTAP_DEBUG=1` as environment variable, when calling the QTap CLI,
to launch local browsers visibly instead of headless.

Set `--verbose` in the QTap CLI to enable verbose debug logging.

## QTap API: Browser launcher

Each browser is implemented as a single async function that launches
the browser. The function is called with all required information
and services (client metadata, URL, logger function).

The function is expected to run as long as the browser is running,
with the Promise representing the browser process. If the browser
exits for any reason, you may run any cleanup and then return also.
If the browser fails or crashes for any reason, this can be conveyed
by throwing an error (or rejected promise) from your async function.

You ensure any clean up is applied by using `try-finally`.

One of the passed parameters is a standard AbortSignal object.
When QTap has received all test results, or for another reason
needs to stop the browser, it will send the `abort` event to this
object. This establishes a way to convey a stop signal from the start.
AbortSignal is natively supported by Node.js `child_process.spawn()`.

```js
function myBrowser(clientId, url, logger) {
  // Native
  const spawned = child_process.spawn('/bin/mybrowser', ['-headless', url], { signal });
  await new Promise((resolve, reject) => {
    spawned.on('error', error => {
      (signal.aborted ? resolve() : reject(error));
    });
    spawned.on('exit', () => {
      (signal.aborted ? resolve(): reject(new Error('Process exited'));
    });
  });

  // Or, use our utility
  try {
    await LocalBrowser.startExecutable(['/bin/mybrowser'], ['-headless', url],
      clientId, url, signal, logger
    );
  } finally {
    // Any clean up here
  }
```

Alternatives considered:

* A base class that plugins must extend,
  with one or more stub methods to be implemented such as `launch`,
  `getCandidates`, `stop`, and `cleanup`.

  This kind of inherence and declarative

  ```js
  class MyBrowser extends BaseBrowser {
    getCandidates() {
      return ['/bin/mybrowser']
    }
    getArguments(url) {
      return ['-headless', url];
    }

    async launch(clientId, url, logger) {
      // inherited startExecutable, uses getCandidates and getArguments,
      // and spawns child process
      await this.startExecutable();
    }

    stop() {}
    cleanup() {}
  ```

  This approach was not taken as makes ourselves a bottleneck for
  future expansion and limits flexibilty. It may make some theoretical
  simple cases and demos simpler, but then comes at a steep increase
  in complexity as soon as you need to step outside of that.

  Testing and long-term stability more difficult to ensure with
  stateful functions and inheritence over composition of single-purpose
  utilities.

  In order to expose the information in different places it requires
  upstream to add repeat arguments or class properties via constructor.

  Catching errors and stopping the browser gets messy once dealing with
  real browsers. In particular around creation and cleanup of temporary
  directories.

* A single browser launch function, exposing a `stop` function,
  as part of a returned object. This addresses most of the above.

  ```js
  function myBrowser(clientId, url, logger) {
    // Native `child_process.spawn(command, [url])`
    // or use our utility:
    const sub = qtap.LocalBrowser.startExecutable(
      qtap.LocalBrowser.getExecutable(['/bin/mybrowser']),
      [url],
      logger
    );

    return {
      stop() {
        sub.kill();
      }
    };
  ```

  What remains unaddressed here is avoiding dangling processes
  in the case of errors between internal process spawning and
  the returning of the `stop` function. It places a high
  responsibility on downstream to catch any and all errors there.
  It also leave some abiguity over the meaning of uncaught errors
  and how to convey errors or unexpected subprocess exists, because
  the only chance we have to convey these above is when starting
  the browser. Once the browser has started, and our function has
  returned to expose the `stop`, we have no communication path.

## QTap Client

Source code: [function qtapClientHead](./src/server.js#170).

Goal:

* Report results from browser client to CLI as fast as possible.

* The first result is the most important, as this will signal
  the CLI to change reporting of "Launching browser" to "Running tests".
  This implicitly conveys to the developer that:
  - the browser was found and launched correctly,
  - the test file/URL was found and served correctly,
  - most of their application code loaded and executed correctly in the
    given browser,
  - their chosen test framework and TAP reporter are working,
  - most of their unit tests loaded and executed correctly,
  - one of their tests has finished executing.

Approaches considered:

* **Fixed debounce**, e.g. `setTimeout(send, 200)`.
  Downside:
  - Delays first response by 200ms.
  - Server might receive lines out-of-order, thus requiring an ordering
    mechanism.
* **Fixed throttle**, e.g. `send() + setTimeout(.., 200)`.
  Downside:
  - First response is just "TAP version" and still delays
    first real result by 200ms.
  - Idem, out-of-order concern.
* **Now + onload loop**, e.g. `send() + XHR.onload` to signal when to
  send the next buffer. This "dynamic" interval is close to the optimum
  interval and naturally responds to latency changes and back pressure,
  although in theory is still 2x the smallest possible interval (unless
  ordering or buffering without any interval), since it waits for 1 RTT
  (both for client request arriving on server, and for an empty server
  response to arrive back on the client). It is inherently unknowable
  when the server has received a chunk without communication. In practice
  this approach is quicker than anything else, prevents known concerns,
  and nearly cuts down implementation complexity to a mere 5 lines of
  code.

  Downside: First roundtrip wasted on merely sending "TAP version".

* **Unthrottled with ordering**, e.g. `send(..., offset=N)`
  This is the approach taken by [tape-testing/testling](https://github.com/tape-testing/testling/blob/v1.7.7/browser/prelude.js) and would involve the client needing an XHR stream
  (in older browsers) or WebSocket (in newer ones), an ordered event
  emitter, and JSON wrapping the TAP lines; and the server listening
  for both XHR and WebSocket, the client discovering the WS URL,
  and the server buffering and re-constituting chunks in the right
  order, with some tolerance or timeout between them. While this
  clearly works, it is heavier and involves more moving parts than I
  care to write, maintain, or depend on. It also varies behaviour
  between clients instead of one way that works everywhere. The specific
  packages used the Testling additionally suffer from having largely
  been ghosted (i.e. GitHub link 404, author deactivated, commit messages
  and history no longer has a canonical home, source only browsable
  via npm).

* **Zero-debounce + onload loop** ⭐️ *Chosen approach*,
  e.g. `setTimeout(send,0) + XHR.onload` to dictate frequency.
  The first chunk will include everything until the current event loop
  tick has been exhausted, thus including not just the first line
  but also the entirety of the first real result. Waiting for `XHR.onload`
  naturally ensures correct ordering, and naturally responds to changes
  in latency and back pressure.
