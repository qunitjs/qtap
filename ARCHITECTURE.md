# QTap Architecture

This describes the priorities and values of the QTap project, design goals, considered alternatives, and any significant assumptions, caveats, or intentional trade-offs made during development. These serve as reference to inform future decisions by contributors and maintainers, e.g. after proposed changes or reported issues.

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
  * may not exceed 100KB in size (as measured by `https://registry.npmjs.org/PACKAGE/-/PACKAGE-VERSION.tgz`), and may carry at most 4 indirect or transitive dependencies in total.
  * must be audited and understood by us as if it were our own code, including each time before we upgrade the version we depend on.
  * may not be directly exposed to end-users (whether QTap CLI or QTap Node.js API), so that we could freely upgrade, replace, or remove it in a semver-minor release.

### Fast

Performance is a first-class principle in QTap.

The first priority (after the "Simple" and "Lean" values above) is time to first result. This means the CLI endpoint should as directly as possible launch browsers and start the ControlServer. Any computation, imports and other overhead is deferred when possible.

The second piority is time to last result (e.g. "Done!"), which is generally what a human in local development (especially in watch mode) will be waiting for. Note that this is separate from when the CLI process technically exits, which is less important to us. It is expected that the process will in practice exit immediately after the last result is printed, but when we have a choice, it is important to first get and communicate test results. In particular for watch mode, shutdown logic will not happen on re-runs and thus is avoided if we don't do it in the critical path toward obtaining test results.

## Debugging

Set `QTAP_DEBUG=1` as environment variable, when calling the QTap CLI, to launch local browsers visibly instead of headless.

Set `--verbose` in the QTap CLI to enable verbose debug logging.

## QTap Internal: Server

### Requirements

* Support simple projects where the test suite is a static HTML file and/or a list of JS files.
  This will be passed as `qtap test/index.html` and we will automatically decide which base directory
  to serve static files from, and automatically start a static file server for that, and point
  browsers at our generated URL accordingly.

  Why:
  - This avoids overhead and complexity for end-users to support running in a `file:///` protocol context. This context would cause your source code to have significant differences in behaviour and restrictions, thus requiring you to support both HTTP contexts (for production) and the file protocol just for testing.
  - This avoids missed bugs or false positives where things pass in the file protocol, but fail over HTTP.
  - This removes the need for end-users to have to install and manage a static web server.
    In particular picking available ports, passing dynamic URLs, and careful starting/stopping of the server. These are easy for the test runner to do, but non-trivial to do manually out of bound.
    To avoid:
    - [Example 1](https://github.com/gruntjs/grunt-contrib-qunit/blob/v10.1.1/Gruntfile.js): This uses grunt-contrib-qunit, with node-connect and a hardcoded port. This made it easy to configure in Gruntfile.js, but also makes it likely to conflict with other projects the user may be working on locally.
    - [Example 2](https://github.com/qunitjs/qunit/blob/2.23.1/Gruntfile.js): This uses grunt-contrib-qunit, with node-connect and a configurable port. This allows the end-user to resolve a conflict by manually picking a different port. The user is however not likely to know or discover that this option exists, and is not likely to know what port to choose. The maintainer meanwhile has to come up with ad-hoc code to change the URLs. The `useAvailablePort` option of node-connect doesn't help since these two Grunt plugins are both configured declaratively, so while it could make node-connect use a good port, the other plugin wouldn't know about that ([workaround](https://github.com/qunitjs/qunit/commit/e77a763991a6330b68af5867cc5fccdb81edc7d0?w=1)).
* Support applications that serve their own JS/CSS files, by letting them load source code, test suites, and the test HTML from their own URLs. This ensures you meaningfully test your source code witn the same bundler, and any generated or transformed files that your application would normally perform.

  Why:
  - This avoids maintenance costs from having to support two bundlers (the prod one, and whatever a test runner like QTap might prescribe).
  - This avoids bugs or false positives from something that works with your test bundler, but might fail or behave differently in your production setup. E.g. missing dependencies, different compiler/transpiler settings.
  - This avoids needless mocking of files that may be auto-generated.
  - This allows web applications to provide automatic discovery of test suites, for both their own components, and for any plugins. For example, MediaWiki allows extensions to register test suites. When running [MediaWiki's QUnit page](https://www.mediawiki.org/wiki/Manual:JavaScript_unit_testing) in CI, MediaWiki will include tests from any extensions that are installed on that site as well. WordPress and Drupal could do something similar. Likewise, Node.js web apps that lazily bundle or transform JavaScript code may also want to make use of this.

### Considerations

* Proxying every single request can add a noticable delay to large test suites. If possible, we want most requests to go directly to the specified URL.
* References to relative or absolute paths (e.g. `./foo` or `/foo` without a domain name) are likely to fail, because the browser would interpret them relative to where our proxy serves the file.
  To avoid:
  - Karma provided a way to [configure proxies](http://karma-runner.github.io/6.4/config/configuration-file.html#proxies) which would let you add custom paths like `/foo` to Karma's proxy server, and forward those to your application. I'd like this to placing this complexity on the end-user. Not by proxying things better or more automatically, but by not breaking these absolute references in the first place.
  - Karma recommended against full transparent proxing (e.g. `/*`) as this would interfere with its own internal files and base directories. It'd be great to avoid imposing such limitation.
* Invisible or non-portable HTML compromises easy debugging of your own code:
  - [Airtap](https://github.com/airtap/airtap) takes full control over the HTML by taking only a list of JS files. While generating the HTML automatically is valuable for large projects (e.g. support wildcards, avoid manually needing to list each JS file in the HTML), this makes debugging harder as you then need to work with your test runner to debug it (disable headless, disable shutdown after test completion, enable visual test reporter). While some projects invest in a high-quality debugging experience, it's always going to lag behind what the browser offers to "normal" web pages.
  - [Jest](https://jestjs.io/docs/api), and others that don't even run in a real browser by default, require you to hook up the Node.js/V8 inspector to Chrome to have a reasonable debugging experience. This is non-trivial for new developers, and comes with various limitations and confusing aspects that don't affect working with DevTools on regular web pages.
  - Karma offers [configurable customDebugFile](http://karma-runner.github.io/6.4/config/configuration-file.html#customdebugfile) to let you customize (most) of the generated HTML. This is great, but comes at the cost of learning a new template file, and an extra thing to setup and maintain.
  - [Testem](https://github.com/testem/testem/) takes an HTML-first approach, but does come with two restrictions: You have to include `<script src="/testem.js"></script>` and call `Testem.hookIntoTestFramework();`. These make the HTML file no longer work well on their own (unless you modify the snippet in undocumented ways to make these inclusions conditional and/or fail gracefully). The benefit is of course that the HTML is very transparent and inspectable (no difficult to debug magic or secret sauce).
  - [browserstack-runner](https://github.com/browserstack/browserstack-runner) takes an HTML-first approach, and does not pose any requirements or restrictions on this HTML. It works by dynamically modifying the HTML to inject scripts at the end of the `<body>`, from which it adds relevant event listeners and hooks, which then beacon data off to your command line output. If memory serves correctly, the idea for this came partly out of conversations at [jQuery Conference 2013 Portland](https://blog.jquery.com/2013/01/25/jquery-comes-to-portland/) between the BrowserStack Team and jQuery Team, which in turn learned from [TestSwarm](https://github.com/jquery/testswarm) and its model of running existing HTML test suites as-is (QUnit, Mocha, Jasmine).
* To receive test results on the command-line there are broadly two approaches:

  **Browser-side script injection**

  This means the page can be unaware of the test runner (no script tag requirement, no manual page modification). Instead you use WebDriver, Puppeteer, or a browser extension, to communicate natively with the browser and instruct it to run additional JavaScript at "the right time", from which we'd subscribe to `console.log` (or directly by adding an event listener or reporter to a unit test framework), and from there beacon the results to your command-line process.

  Downside:
  - Gap in error telemetry between the browser and page starting to load, and potentially miss the first few test results, until your script is injected. Or, yield control over when the tests begin to the test runner.
  - Puppeteer offers a Chrome-only `Page.evaluateOnNewDocument` method which promises to run before other scripts, but, the standard WebDriver protocol has no such capability yet.
  - For true cross-browser testing we'd want to incldue cloud browsers like BrowserStack and SauceLabs, where there are even fewer capabilities.

  **Page-side script injection**

  This means the end-user has to modify the page in some way. Or, the test runner introduces a mandatory proxy that modifies the page on-demand.

  This has the benefit of requiring no control over the browser process. The only responsiblity of a browser launcher is to navigate to a single URL.

### Approach taken

* **HTML-first**. The HTML file is yours, and you can open and debug it directly in any browser, using familiar and fully capable devtools in that browser. If we generate it automatically from a one or more JavaScript file names (e.g. wildcards or glob patterns), then we'll save the file to the current working directory for transparency and ease of debugging.

* **Minimal proxy**. The HTML file is served from an automatically started web server. References to relative and absolute paths work correctly, by using a `<base>` tag pointing back to the original URL. This means no proxies have to be configured by the user, no other requests have to be proxied by us, and thus no conflicts or abmiguities can arise between paths in end-user code, and paths for the test runner.

  This means we need only 1 web server, which can both serve the HTML test file, and receive test results.

* **Page-side script injection**. The HTML file is modified to include an inline script that subscribes to `console.log` and other events, and beacons to our command-line process. More details at [QTap Internal: Client send](#qtap-internal-client-send).

  This means browser can be launched by any means, pointed at a URL, and then forgotten about until we shut it down. It requires no control over the browser process. And the requirements for someone writing a browser launcher, is thus merely to open a single URL. More details at [QTap API: Browser launcher](#qtap-internal-client-send).

## QTap API: Browser launcher

Each browser is implemented as a single async function that launches the browser. The function is called with all required information and services. The [injected](https://en.wikipedia.org/wiki/Dependency_injection) parameters include a URL, an abort signal, and a logger function.

The function is expected to run as long as the browser is running, with the returned Promise representing the browser process. If the browser exits for any reason, you may run any cleanup and then return. If the browser fails or crashes for any reason, this can be conveyed by throwing an error (or rejecting a Promise) from your async function.

It is recommended to use `try-finally` to ensure clean up is reliably run.

One of the passed parameters is a standard [`AbortSignal` object](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal). When QTap has received all test results, or for any reason needs to stop the browser, it will send the `abort` event to your AbortSignal. AbortSignal was popularised by the "Fetch" Web API, and is natively implemented by Node.js and supported in its [`child_process.spawn()` function](https://nodejs.org/docs/latest-v22.x/api/child_process.html#child_processspawncommand-args-options).

```js
// Using our utility
async function myBrowser (url, signal, logger) {
  await LocalBrowser.spawn(['/bin/mybrowser'], ['-headless', url], signal, logger);
}

// Minimal sub process
import child_process from 'node:child_process';
async function myBrowser (url, signal, logger) {
  logger.debug('Spawning /bin/mybrowser');
  const spawned = child_process.spawn('/bin/mybrowser', ['-headless', url], { signal });
  await new Promise((resolve, reject) => {
    spawned.on('error', (error) => reject(error));
    spawned.on('exit', (code) => reject(new Error(`Process exited ${code}`)));
  });
}

// Minimal custom
async function myBrowser (url, signal, logger) {
  // * start browser and navigate to `url`
  // * if you encounter problems, throw
  await new Promise((resolve, reject) => {
    // * once browser has stopped, call resolve()
    // * if you encounter problems, call reject()
    signal.addEventListener('abort', () => {
      // stop browser
    });
  });
}
```

### Alternatives considered

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

  async function myBrowser (url, signal, logger) {
    await qtap.LocalBrowser.spawn(['/bin/mybrowser'], ['-headless', url], signal, logger );
  }

  // Minimal sub process
  import child_process from 'node:child_process';
  async function myBrowser (url, signal, logger) {
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

## QTap API: Config file

Inspired by ESLint FlatConfig.

User controls how and what modules to import there. Avoid hard-to-debug YAML or JSON.

## QTap Internal: Client send

_See also: `function qtapClientHead` in [/src/server.js](./src/server.js)_.

### Requirements

* Report results from browser client to CLI as fast as possible.

* The first result is the most important, as this will instruct the CLI to change reporting of "Launching browser" to "Running tests".
  This implicitly conveys to the developer that:
  - the browser was found and launched correctly,
  - the test file/URL was found and served correctly,
  - most of their application code loaded and executed correctly in the given browser,
  - their chosen test framework and TAP reporter are working,
  - most of their unit tests loaded and executed correctly,
  - one of their tests has finished executing.

### Approaches

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

## QTap Internal: Safari launcher

Safari has long resisted the temptation to offer a reasonable command-line interface. Below is the state of the art as known in January 2025.

* `Safari <file>`. This argument does not permit URLs in practice. Safari allows only local file paths.

* `Safari redirect.html`, without other arguments, worked from 2012-2018 and was used by Karma.

  You create a temporary HTML file, which acts as "trampoline", using `<script>window.location='<url>';</script>` to redirect the browser. You then open Safari with the path to this file instead of the URL.

  - https://github.com/karma-runner/karma-safari-launcher/blob/v1.0.0/index.js
  - https://github.com/karma-runner/karma/blob/v0.3.5/lib/launcher.js#L213
  - https://github.com/karma-runner/karma/commit/5513fd66ae

  This approach is no longer viable since 2018 (after macOS 10.14 Mojave), because macOS SIP will put up a blocking permission prompts in the GUI, due to our temporary file being outside `~/Library/Containers/com.apple.Safari`.

  - https://github.com/karma-runner/karma-safari-launcher/issues/29

* `open -F -W -n -b com.apple.Safari <url>`. This starts correctly, but doesn't expose a PID to cleanly end the process.

  - https://github.com/karma-runner/karma-safari-launcher/issues/29

* `Safari container/redirect.html`. macOS SIP denies this by default for the same reason. But, as long as you grant an exemption to Terminal to write to Safari's container, or grant it Full Disk Access, this is viable.

  It seems that GitHub CI even pre-approves limited access to Terminal in its macOS images, to make this work. <sup>[[1]][[2]]</sup> This might thus be viable if you only support GitHub CI, and if you find it tolerable to have a blocking GUI prompt on first local use, and require granting said access to the Terminal app (which has lasting consequences beyond QTap, and there won't be a GUI prompt if the user previously denied this for other programs).

  - https://github.com/flutter/engine/pull/27567
  - https://github.com/marcoscaceres/karma-safaritechpreview-launcher/issues/7

* **native Swift/ObjectiveC app**. This reportedly works. The tiny app does nothing more than call `LSLaunchURLSpec` from the Mac SDK in Swift or ObjectiveC, akin to how the user might click a link in a messaging app which then opens the browser, and works similar to the `open` approach above. This approach requires distributing a binary, compilation, and makes auditing significantly harder. It is also unclear if this could wait for and subsequently close the tab/browser.

  - https://github.com/karma-runner/karma-safari-launcher/issues/29
  - https://github.com/muthu90ec/karma-safarinative-launcher/

* `osascript -e <script>`

  As of macOS 13 Ventura (or earlier?), this results in a prompt for "Terminal wants access to control Safari", from which osascript will eventually timeout and report "Safari got an error: AppleEvent timed out".

  While past discussions suggest that GitHub CI has this pre-approved,<sup>[[1]][[2]]</sup> as of writing in Jan 2025 with macOS 13 images, this approval does not include access from Terminal to Safari, thus causing the same "AppleEvent timed out".

  - https://github.com/brandonocasey/karma-safari-applescript-launcher
  - https://github.com/brandonocasey/karma-safari-applescript-launcher/issues/5

* `osascript MyScript.scpt`. This avoids the need for quote escaping in the URL, by injecting it properly as a parameter instead. Used by Google's karma-webkit-launcher. https://github.com/google/karma-webkit-launcher/commit/31a2ad8037

* `safaridriver -p <port>` ⭐️ _Chosen approach_

  Start driver, and then make HTTP requests to create a session, navigate the session, and to delete the session.

  This addresses all previous concerns, and seems to be the best as of 2025. The only downside is that it requires a bit more code to setup (find available port, and perform various HTTP requests).

  - https://webkit.org/blog/6900/webdriver-support-in-safari-10/
  - https://developer.apple.com/documentation/webkit/macos-webdriver-commands-for-safari-12-and-later
  - Inspired by https://github.com/flutter/engine/pull/33757

### See also

Other interesting discussions:

* Testem (unresolved as of Jan 2025), https://github.com/testem/testem/issues/1387
* Ember.js (unresolved as of Jan 2025), https://github.com/emberjs/data/issues/7170

[1]: https://github.com/actions/runner-images/issues/4201
[2]: https://github.com/actions/runner-images/issues/7531
