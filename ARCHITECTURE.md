# QTap Architecture

This describes priorities and values, design goals, considered alternatives, and any significant assumptions, caveats, or intentional trade-offs made during development.

## High-level

We write simple and long-term stable code in Node.js.

We favour a single way of doing something that works everywhere, over marginal gains that would introduce layers of indirection, abstraction, conditional branches, or add dependencies.

We favour explicit and efficient inlined implementation in the form of a single stable and well-documented (but slightly) function, over many local single-use functions.

We will have at most 5 npm packages as direct dependencies.

Requirements for dependencies:

* must solve a non-trivial problem, e.g. something that is not easily implemented in <50 lines of code that we could write once
  inline and then use long-term without changes.
* may not exceed 10KB in size (minified before gzip), and may carry at most 1 indirect or transitive dependency which in turn may not have any dependencies.
* must be audited and understood by us as if they were our own code, including after each time we upgrade the version we depend on.
* may not be directly exposed via the QTap API (whether QTap module export or QTap CLI), such that we can freely internally upgrade, replace, or remove this dependency in a semver-minor release.

## Debugging

Set `QTAP_DEBUG=1` as environment variable, when calling the QTap CLI, to launch local browsers visibly instead of headless.

Set `--verbose` in the QTap CLI to enable verbose debug logging.

## QTap API: Browser launcher

Each browser is implemented as a single async function that launches the browser. The function is called with all required information and services [injected](https://en.wikipedia.org/wiki/Dependency_injection) as parameters (client metadata, URL, logger function).

The function is expected to run as long as the browser is running, with the Promise representing the browser process. If the browser exits for any reason, you may run any cleanup and then return also. If the browser fails or crashes for any reason, this can be conveyed
by throwing an error (or rejecting a Promise) from your async function.

You can ensure any clean up is applied by using `try-finally`.

One of the passed parameters is a standard [`AbortSignal` object](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal). When QTap has received all test results, or for other reasons needs to stop the browser, it will send the `abort` event to this object. This establishes a way to convey a stop signal from the beginning, leaving no gap.

AbortSignal, while popularised in relation to the "Fetch" Web API, is also natively implemented by Node.js and supported in its [`child_process.spawn()` function](https://nodejs.org/docs/latest-v22.x/api/child_process.html#child_processspawncommand-args-options).

```js
// Using our utility
function myBrowser(url, signal, logger) {
  await LocalBrowser.spawn(['/bin/mybrowser'], ['-headless', url], signal, logger);
}

// Minimal custom implementation on native Node.js
function myBrowser(url, signal, logger) {
  const spawned = child_process.spawn('/bin/mybrowser', ['-headless', url], { signal });
  await new Promise((resolve, reject) => {
    spawned.on('error', (error) => reject(error));
    spawned.on('exit', (code) => reject(new Error(`Process exited ${code}`)));
  });
}
```

Alternatives considered:

* **Base class** that plugins must extend, with one or more stub methods to be implemented such as `getCandidates`, `getArguments`, `launch`, and `stop`.

  This kind of inherence and declarative

  ```js
  class MyBrowser extends BaseBrowser {
    getCandidates() {
      return ['/bin/mybrowser']
    }
    getArguments(url) {
      return ['-headless', url];
    }
    // inherited:
    // startExecutable(url) {
    //   ... calls getCandidates
    //   ... calls getArguments,
    //   ... spawns child process
    // }

    async launch(url, logger) {
      await this.startExecutable(url);
    }

    stop() {}
  }
  ```

  This approach was not taken as makes ourselves a bottleneck for future expansion and limits flexibilty. It may make some theoretical simple cases and demos simpler, but then comes at a steep increase in complexity as soon as you need to step outside of that. Nesting and long-term stability more difficult to ensure with stateful functions and inheritence over composition of single-purpose utilities.

  In order to expose the information in different places it requires upstream to add repeat arguments or class properties via constructor.

  Catching errors and stopping the browser gets messy once dealing with real browsers. In particular around creation and cleanup of temporary directories.

* **Single function with `stop` method**. The browser launch function would expose a `stop` method, as part of a returned object. This addresses most of the above.

  ```js
  function myBrowser(url, logger) {
    // Native `child_process.spawn(command, [url])`
    // or use our utility:
    const sub = qtap.LocalBrowser.spawn(
      qtap.LocalBrowser.findExecutable(['/bin/mybrowser']),
      [url],
      logger
    );

    return {
      stop() {
        sub.kill();
      }
    };
  ```

  What remains unaddressed here is avoiding dangling processes in the case of errors between internal process spawning and the returning of the `stop` function. It places a high responsibility on downstream to catch any and all errors there. It also leave some abiguity over the meaning of uncaught errors and how to convey errors or unexpected subprocess exists, because the only chance we have to convey these above is when starting the browser. Once the browser has started, and our function has returned to expose the `stop`, we have no communication path.* A single browser launch function, using an async/Promise to track
  the lifetime of the browser procoess, and an injected AbortSignal.

  This is what we ended up with, except it still made the launcher responsible for silencing expected errors/exits after receiving a stop signal. We moved this responsibility to QTap.

  ```js
  // Using our utility
  import qtap from 'qtap';

  function myBrowser(url, signal, logger) {
    await qtap.LocalBrowser.spawn(['/bin/mybrowser'], ['-headless', url], signal, logger );
  }

  // Minimal custom implementation
  import child_process from 'node:child_process';

  function myBrowser(url, signal, logger) {
    const spawned = child_process.spawn('/bin/mybrowser', ['-headless', url], { signal });
    await new Promise((resolve, reject) => {
      spawned.on('error', error => {
        (signal.aborted ? resolve() : reject(error));
      });
      spawned.on('exit', () => {
        (signal.aborted ? resolve(): reject(new Error('Process exited'));
      });
    });
  }
  ```

* **Passing a `clientId`**.

  It might be appealing to pass a `clientId` argument to the browser launch function for future use cases.

  The parameter was originally there in an early draft, for two use cases in the built-in local browsers:

  1. Give a descriptive prefix to temp directories. Even after adopting `fs.mkdtemp` to create unique temporary directories, we kept using the clientId as descriptive prefix (e.g. `/tmp/qtap_client42_ABCxYz`).
  2. Name the debug log channel.

  ```js
  async function launch (clientId, url, signal, logger) {
    logger = logger.channel(`mybrowser_${clientId}`);

    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qtap_' + clientId + '_'));
    const args = ['-headless', '-profile', profileDir, url];
    try {
      await LocalBrowser.spawn(['/bin/mybrowser'], args, signal, logger);
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  }
  ```

  The logger was solved by a passing `logger` object that already has its channel pre-configured for each client.

  The temporary directory was solved by simplifying the `fs.mkdtemp` call to not include a `clientId`. This is redundant because `fs.mkdtemp` generates a unique temporary name.

  While there is some marginal gain in debugging by having the clientId explicitly in the directory name, the name of this directly will end up associated with the clientId in the debug logs already. E.g. as part of the launch command, we log `[qtap_mybrowser_client44] Spawning /bin/mybrowser -profile /tmp/qtap_ABCxYz`. Plugin authors can additionally call `logger.debug()` when desired for other use cases.

  Removing the `clientId` parameter from the `qtap.Browser` interface avoids misuse of `clientId`. Read "[QTap Internal: Client ID](#qtap-internal-client-id)" to learn why this is likely. It forces plugin authors to ensure uniqueness by other means (e.g. use random available port, or use `mktemp` to generate new temporary directories instead of trying to name it yourself). Removing such potential footgun from the API also avoids developer-unfriendly "you're holding it wrong" arguments in the future.

  To further encourage and make "the right thing" easy, we provide `qtap.LocalBrowser.makeTempDir`.

## QTap Internal: Client ID

The `clientId` is a short string identifying one browser invocation in the current QTap process, e.g. "client_42". The exact format of the string is internal and should not be decoded or parsed.
**Example**: When running QTap with 2 test files (test_a.html, test_b.html) and 2 browsers (Firefox, Chrome), we spawn 4 clients, let's call them "client_1" to "client_4". This identifier is not directly of concern to browser launch functions. It is instead embedded as part the URL that the browser is instructed to navigate to, such as `http://localhost:9412/?qtap_clientId=client_42`.

The URL is responded to by QTap's own internal web server so that it knows which test file to serve, and so that it can inject an inline script that instructs the browser to send TAP lines (from console.log) to the QTap process in a way that is associated with this clientId, so that the QTap process knows which test file and browser the result is from.

The clientId is only unique to a single qtap process and thus should not be used to uniquely identify things outside the current process. It is not a cryptographically secure random number, it is not a globally unique ID across past, future, or concurrent QTap processes.

**Counter example**:

* When launching the internal web server, QTap finds a random available port. This port (not the clientId) is what makes the overall URL unique and safe to run concurrently with other processes.

* When creating a temporary directory for the Firefox browser profile, we call our `LocalBrowser.mkTempDir` utility which uses [Node.js `fs.mkdtemp`](https://nodejs.org/docs/latest-v22.x/api/fs.html#fsmkdtempprefix-options-callback), which creates a new directory with a random name that didn't already exist. This is favoured over `os.tmpdir()` with a prefix like `"qtap" + clientId`, as that would conflict with with concurrent invocations, and any remnants of past invokations.


## QTap Internal: Client send

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
