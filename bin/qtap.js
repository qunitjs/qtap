#!/usr/bin/env node
'use strict';

import { program } from 'commander';
import qtap from '../index.js';

program
  .name('qtap')
  .usage('[--browser <name>] <file> [file...]')
  .description('Run unit tests in real browsers', {
    file: 'One or more local HTML files or URLs'
  })
  .arguments('<file...>')
  .option('-b, --browser <name>',
    'One or more comma-separated local browser names, or ./path to a JSON file.\n' +
      'Choices: "firefox", "chrome", "safari"\n' +
      'Example: "firefox,chrome"\n' +
      'Default: "firefox"'
  )
  .option('-w, --watch', 'Watch files for changes and re-run the test suite')
  .option('-d, --debug', 'Enable verbose debugging')
  .option('-V, --version', 'Display version number')
  .helpOption('-h, --help', 'Display this usage information')
  .parse(process.argv);

const opts = program.opts();

if (opts.version) {
  const packageFile = new URL('../package.json', import.meta.url);
  const fs = await import('node:fs');
  const version = JSON.parse(fs.readFileSync(packageFile)).version;
  console.log(version);
} else if (!program.args.length) {
  program.help();
} else {
  try {
    const exitCode = await qtap.run(opts.browser || 'firefox', program.args, {
      debug: opts.debug
    });
    process.exit(exitCode);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

/**
 * --browser  dotless = comma-separated names
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
