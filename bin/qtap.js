#!/usr/bin/env node

'use strict';

/**
 * usage: qbrow [--browser <name|file>] <file|url> [<file|url>...]
 *
 * --browser  dotless = comma-separated names
 *            "./" file = JS or JSON file that returns an array
 *            Default: firefox (all are headless, open the file yourself for non-headless)
 *            Options:
 *            - firefox
 *            - chrome (chrome+chromium+edge)
 *            - chromium (chromium+chrome+edge)
 *            - edge (edge+chrome+chromium)
 *            - safari
 *            - browserstack/firefox_45
 *            - browserstack/firefox_previous
 *            - browserstack/firefox_current,
 *            - ["browserstack", {
 *                 "browser": "opera",
 *                 "browser_version": "36.0",
 *                 "device": null,
 *                 "os": "OS X",
 *                 "os_version": "Sierra"
 *              ]
 *            - saucelabs
 *            - puppeteer
 *            - puppeteer_coverage { outputDir: instanbul }
 *            // TODO: integration test with nyc as example with console+html output
 *
 * --file  local file path or URL
 *
 * --concurrency=Infinity Always on? Responsibility of OS for sytem browsers
 *  to manage resources and figure it out, most cases will have 1 file and 1-3 browsers.
 *  likely reasons to want to limit it:
 *   - test file served from an app that cannot handle ANY concurrency.
 *     solution: run this one at a time in a loop consequtively with similar params.
 *  - using a cloud browser like browserstack or saucelabs and wanting to test N
 *    browsers but may only launch <N browsers concurrently. Ideally, the service
 *    will queue but in practice may fail/throttle hard?
 *    solution: browserstack just queues, no problem.
 *    saucelabs? TBD.
 */