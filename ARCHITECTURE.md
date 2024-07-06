# QTap Architecture

This describes the priorities and values of the QTap project, design goals, considered alternatives, and any significant assumptions, caveats, or intentional trade-offs made during development. These serve as reference to contributors and maintainers when making future decisions, e.g. on proposed changes or reported issues.

## Principles

QTap is built to be simple, lean, and fast; valued and prioritised in that order.

### Simple

We value simplicity in installing and using QTap. This covers the CLI, the public Node.js API (module export), printed output, the overall npm package, and any of concepts required to understand these.

Examples:

* The QTap CLI requires only a single argument.

  ```
  qtap test.html
  ```

  This argument relates directly to a concept we know the user naturally knows and is most concerned about (their test file). There are no other unnamed arguments. There are no required options or flags. The default browser is selected automatically. No awareness of test framework is required (in most cases).

  When invoking `qtap` without arguments out of curiosity, we generate not just an error message but also the `--help` usage documentation.

* We favour a single way of doing something that works everywhere, over marginal gains that would introduce layers of indirection, abstraction, conditional branches, or additional dependencies.

* We favour an explicit and efficient inline implementation (e.g. in the form of a single well-documented function with a clear purpose, which may be relatively long, but is readable and linear), over many local functions that are weaved together.

### Lean

We value low barriers and low costs for installing, using, contributing to, and maintaining QTap. This covers both how the QTap software is installed and used, as well as open-source contributions and maintenance of the QTap project itself.

Examples:

* We prefer to write code once in a way that is long-term stable (low maintenance cost), feasible to understand by inexperienced contributors, and thus affordable to audit by secure or sensitive projects that audit their upstream sources. For this and other reasons, we only use dependencies that are similarly small and auditable.

* We maintain a small bundle size that is fast to download, and quick and easy to install. This includes ensuring our dependencies do not restrict or complicate installation or runtime portability in the form OS constrains or other environment requirements.

* We will directly depend on at most 5 npm packages. Requirements for dependencies:

  * must solve a non-trivial problem, e.g. something that is not easily implemented in under 50 lines of code that we could write once ourselvers and then use long-term without changes.
  * may not exceed 10KB in size (before gzip), and may carry at most 1 indirect or transitive dependency which in turn must have zero dependencies.
  * must be audited and understood by us as if it were our own code, including each time before we upgrade the version we depend on.
  * may not be directly exposed to end-users (whether QTap CLI or QTap Node.js API), so that we could freely upgrade, replace, or remove it in a semver-minor release.

### Fast

Performance is a first-class principle in QTap.

The first priority (after the "Simple" and "Lean" values above) is time to first result. This means the CLI endpoint should as directly as possible launch browsers and start the ControlServer. Any computation, imports and other overhead is deferred when possible.

The second piority is time to last result (e.g. "Done!"), which is generally what a human in local development (especially in watch mode) will be waiting for. Note that this is separate from when the CLI process technically exits, which is less important to us. It is expected that the process will in practice exit immediately after the last result is printed, but when we have a choice, it is important to first get and communicate test results. In particular for watch mode, shutdown logic will not happen on re-runs and thus is avoided if we don't do it in the critical path toward obtaining test results.

## Debugging

Set `QTAP_DEBUG=1` as environment variable, when calling the QTap CLI, to launch local browsers visibly instead of headless.

Set `--verbose` in the QTap CLI to enable verbose debug logging.

## QTap API: Browser launcher

Each browser is implemented as a single async function that launches the browser. The function is called with all required information and services. The [injected](https://en.wikipedia.org/wiki/Dependency_injection) parameters include a URL, an abort signal, and a logger function.

The function is expected to run as long as the browser is running, with the returned Promise representing the browser process. If the browser exits for any reason, you may run any cleanup and then return. If the browser fails or crashes for any reason, this can be conveyed by throwing an error (or rejecting a Promise) from your async function.

It is recommended to use `try-finally` to ensure clean up is reliably run.

One of the passed parameters is a standard [`AbortSignal` object](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal). When QTap has received all test results, or for any reason needs to stop the browser, it will send the `abort` event to your AbortSignal. AbortSignal was popularised by the "Fetch" Web API, and is natively implemented by Node.js and supported in its [`child_process.spawn()` function](https://nodejs.org/docs/latest-v22.x/api/child_process.html#child_processspawncommand-args-options).

```js
// Using our utility
async function myBrowser(url, signal, logger) {
  await LocalBrowser.spawn(['/bin/mybrowser'], ['-headless', url], signal, logger);
}

// Minimal custom implementation on native Node.js
async function myBrowser(url, signal, logger) {
  logger.debug('Spawning /bin/mybrowser');
  const spawned = child_process.spawn('/bin/mybrowser', ['-headless', url], { signal });
  await new Promise((resolve, reject) => {
    spawned.on('error', (error) => reject(error));
    spawned.on('exit', (code) => reject(new Error(`Process exited ${code}`)));
  });
}
```

Alternatives considered:

* **Base class** that plugins must extend, with one or more stub methods to be implemented such as `getPaths`, `getArguments`, `launch`, and `stop`.

  ```js
  class MyBrowser extends BaseBrowser {
    getPaths() {
      return ['/bin/mybrowser']
    }
    getArguments(url) {
      return ['-headless', url];
    }
    // inherited:
    // startExecutable(url) {
    //   ... calls getPaths
    //   ... calls getArguments,
    //   ... spawns child process
    // }

    async launch(url, logger) {
      await this.startExecutable(url);
    }

    stop() {}
  }
  ```

  This kind of inherence and declarative approach was not taken, as it makes ourselves a bottleneck for future expansion, and limits flexibilty. It may make some theoretical basic examples and demos look simpler, but then comes at a steep increase in complexity as soon as you need to step outside of that. And while the basic case may look simpler on-screen, it is harder to write from scratch, and harder to understand. It does not faccilitate learning  what happens underneath, what is required or why, in what order things are done, or what else is available. Nesting and long-term stability is difficult to ensure with stateful functions and inheritence.

  We prefer composition of single-purpose utility functions, and placing the plugin author at a single entrypoint function from where they can translate their needs into a search for a method that does that (whether our utility, or something else).

  In order to expose the information in different places it also requires upstream to add repeat arguments, or mandate a class constructor with stateful properties, and taking care to call (or not override) the parent constructor.

  Catching errors and stopping the browser gets messy once dealing with real browsers. In particular around creation and cleanup of temporary directories.

* **Single function with `stop` method**. The browser launch function would expose a `stop` method, as part of a returned object. This addresses most of the above.

  ```js
  function myBrowser (url, logger) {
    // Native `child_process.spawn(command, [url])`
    // or use our utility:
    const sub = qtap.LocalBrowser.spawn(
      qtap.LocalBrowser.findExecutable(['/bin/mybrowser']),
      [url],
      logger
    );

    return {
      stop: function () {
        sub.kill();
      }
    };
  ```

  What remains unaddressed here is avoiding dangling processes in the case of errors between internal process spawning and the returning of the `stop` function. It places a high responsibility on downstream to catch any and all errors there. It also leave some abiguity over the meaning of uncaught errors and how to convey errors or unexpected subprocess exists, because the only chance we have to convey these above is when starting the browser. Once the browser has started, and our function has returned to expose the `stop`, we have no communication path.

  The next solution uses AbortSignal, which is created by QTap before the launch function is called, thus establishing a way to convey the "stop" signal from the very beginning, leaving no gap for uncertainty or ambiguity to exist in.

* **Single async function with AbortSignal**. The browser is an async function that tracks the lifetime of the browser procoess, and is given an AbortSignal for stopping the process.

  This is what we ended up with, except it still made the launcher responsible for silencing expected errors/exits after receiving a stop signal. We moved this responsibility to QTap.

  ```js
  // Using our utility
  import qtap from 'qtap';

  function myBrowser (url, signal, logger) {
    await qtap.LocalBrowser.spawn(['/bin/mybrowser'], ['-headless', url], signal, logger );
  }

  // Minimal custom implementation
  import child_process from 'node:child_process';

  function myBrowser (url, signal, logger) {
    const spawned = child_process.spawn('/bin/mybrowser', ['-headless', url], { signal });
    await new Promise((resolve, reject) => {
      spawned.on('error', (error) => {
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
    await LocalBrowser.spawn(['/bin/mybrowser'], args, signal, logger);
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

Source code: [function qtapClientHead](./src/server.js).

Goals:

* Report results from browser client to CLI as fast as possible.

* The first result is the most important, as this will instruct the CLI to change reporting of "Launching browser" to "Running tests".
  This implicitly conveys to the developer that:
  - the browser was found and launched correctly,
  - the test file/URL was found and served correctly,
  - most of their application code loaded and executed correctly in the given browser,
  - their chosen test framework and TAP reporter are working,
  - most of their unit tests loaded and executed correctly,
  - one of their tests has finished executing.

Approaches considered:

* **Fixed debounce**, e.g. `setTimeout(send, 200)`.

  Downside:
  - Delays first response by 200ms.
  - Server might receive lines out-of-order, thus requiring an ordering mechanism.

* **Fixed throttle**, e.g. `send() + setTimeout(.., 200)`.

  Downside:
  - First response is just "TAP version" and still delays first real result by 200ms.
  - Idem, out-of-order concern.

* **Now + onload loop** e.g. `send() + XHR.onload` to signal when to send the next buffer.

  This "dynamic" interval is close to the optimum interval and naturally responds to latency changes and back pressure, although in theory is still 2x the smallest possible interval (unless ordering or buffering without any interval), since it waits for 1 RTT (both for client request arriving on server, and for an empty server response to arrive back on the client). It is inherently unknowable when the server has received a chunk without communication. In practice this approach is quicker than anything else, prevents known concerns, and nearly cuts down implementation complexity to a mere 5 lines of code.

  Downside: First roundtrip wasted on merely sending "TAP version".

* **Unthrottled with ordering**, e.g. `send(..., offset=N)`

  This is the approach taken by [tape-testing/testling](https://github.com/tape-testing/testling/blob/v1.7.7/browser/prelude.js) and would involve the client needing an XHR stream (in older browsers) or WebSocket (in newer ones), an ordered event emitter, and JSON wrapping the TAP lines; and the server listening for both XHR and WebSocket, the client discovering the WS URL, and the server buffering and re-constituting chunks in the right order, with some tolerance or timeout between them.

  While this clearly works, it is heavier with more moving parts to write, maintain, or depend on. It also varies behaviour between clients instead of one way that works everywhere. The specific packages used by Testling are additionally affected by the Substack ghosting (i.e. GitHub link 404, account deactivated, commit messages and history no longer has a canonical home, source only available via snapshots on npm).

* **Zero-debounce + onload loop** ⭐️ *Chosen approach*

  E.g. `setTimeout(send,0) + XHR.onload` to dictate frequency.

  The first chunk will include everything until the current event loop tick has been exhausted, thus including not just the first line but also the entirety of the first real result. Waiting for `XHR.onload` naturally ensures correct ordering, and naturally responds to changes in latency and back pressure.
