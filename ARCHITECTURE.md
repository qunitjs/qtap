# QTap Architecture

We've documented our design goals, values, assumptions and considered alternatives, and any significant caveats or intentional trade-offs encountered during development.

## Client buffer

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

* Simple dependency-free implementation, that is long-term stable
  (write once), and widely compatible across older browsers.

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
