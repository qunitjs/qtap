<div align="center">

[![Continuous integration](https://github.com/qunitjs/qtap/actions/workflows/CI.yaml/badge.svg)](https://github.com/qunitjs/qtap/actions/workflows/CI.yaml)
[![Tested with QUnit](https://qunitjs.com/testedwith.svg)](https://qunitjs.com/)
[![npm](https://img.shields.io/npm/v/qtap.svg?style=flat)](https://www.npmjs.com/package/qtap)

# QTap

_Run JavaScript unit tests in real browsers, real fast._

</div>


## Getting started

Install QTap:
```
npm install --save-dev qtap
```

Run your tests:
```
npx qtap test/index.html
```

## Features

* **Anywhere**
  - Cross-platform on Linux, Mac, and Windows.
  - Built-in support for headless and local browsers (including Firefox, Chrome, Chromium, Edge, and Safari).

* **Simplicity**
  - No configuration files.
  - No changes to how you write your tests.
  - No installation wizard.

* **Real Debugging**
  - Retreive console errors, uncaught errors, and unhandled Promise rejections from the browser directly in your build output.
  - Instantly debug your tests locally in a real browser of your choosing with full access to browser DevTools to set breakpoints, measure performance, step through function calls, measure code coverage, and more.
  - No imposed bundling or transpilation. Only your unchanged source code or production bundler of choice, running as-is.
  - No need to inspect Node.js or attach it to an incomplete version of Chrome DevTools.

* **Real Browsers**
  - No need to support yet another "browser" just for testing (jsdom emulation in Node.js).
  - No Selenium or WebDriver to install, update, and manage (e.g. chromedriver or geckodriver).
  - No downloading large binaries of Chrome (e.g. Puppeteer).
  - No patched or modified versions of browsers (e.g. Playwright).
  - No Docker containers.

* **Continuous Integration**
  GitHub, Jenkins, Travis, Circle, you can run anywhere.

* **Ecosystem**
  Your test framework likely already supports TAP.

  When you enable TAP in your frontend unit tests or backend Node.js tests, a door opens to an ecosystem of test runners, output formatters, and other [tools that consume the TAP protocol](https://testanything.org/consumers.html).

## Prior art

QTap was inspired by [Airtap](https://github.com/airtap/airtap) and [testling](https://github.com/tape-testing/testling). It may also be an alternative to [Testem](https://github.com/testem/testem/), [Web Test Runner](https://modern-web.dev/docs/test-runner/overview/), [TestCafé](https://testcafe.io/), [Karma Runner](https://github.com/karma-runner/) (including Testacular, [karma-tap](https://github.com/bySabi/karma-tap), and [karma-qunit](https://github.com/karma-runner/karma-qunit/)), [grunt-contrib-qunit](https://github.com/gruntjs/grunt-contrib-qunit), [wdio-qunit-service](https://webdriver.io/docs/wdio-qunit-service/), and [node-qunit-puppeteer](https://github.com/ameshkov/node-qunit-puppeteer).
