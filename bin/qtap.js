#!/usr/bin/env node
'use strict';

import { program, InvalidArgumentError } from 'commander';
import qtap from '../src/qtap.js';

const optionBrowserDefault = ['detect'];

program
  .name('qtap')
  .usage('[--browser <name>] <file> [file...]')
  .description('Run unit tests in real browsers', {
    file: 'One or more local HTML files or URLs'
  })
  .argument('[file...]')
  .addOption(
    program.createOption(
      '-b, --browser <name>',
      'One or more browser names.\n'
         + 'Available: detect, firefox, chrome, chromium, edge, safari.'
    )
      .argParser((val, list) => {
        if (list === optionBrowserDefault) {
        // https://github.com/tj/commander.js/issues/1641
          return [val];
        }
        return list.concat(val);
      })
      .default(optionBrowserDefault, '"detect"')
  )
  .option('-c, --config <file>', 'Optional config file to define additional browsers.')
  .option('--timeout <number>',
    'The maximum timeout of any single test.\n'
      + 'The test is stopped if it takes longer than this between results.',
    function (val) {
      const num = Number(val);
      if (num < 0 || !Number.isFinite(num)) {
        throw new InvalidArgumentError('Not a number.');
      }
      return num;
    },
    5
  )
  .option('--connect-timeout <number>',
    'How many seconds a browser may take to start up.',
    function (val) {
      const num = Number(val);
      if (num < 0 || !Number.isFinite(num)) {
        throw new InvalidArgumentError('Not a number.');
      }
      return num;
    },
    60
  )
  .option('-r, --reporter <reporter>', 'One of "minimal", "dynamic", or "none".', 'minimal')
  .option('-w, --watch', 'Watch files for changes and re-run the test suite.')
  .option('-d, --debug', 'Enable debug mode (non-headless browser, and verbose logging).')
  .option('-v, --verbose', 'Enable verbose logging.')
  .option('-V, --version', 'Display version number.')
  .helpOption('-h, --help', 'Display this usage information.')
  .showHelpAfterError()
  .parse(process.argv);

const opts = program.opts();

if (opts.version) {
  const packageFile = new URL('../package.json', import.meta.url);
  const fs = await import('node:fs');
  const version = JSON.parse(fs.readFileSync(packageFile).toString()).version;
  console.log(version);
} else if (!program.args.length) {
  program.help();
} else {
  try {
    const result = await qtap.runWaitFor(opts.browser, program.args, {
      config: opts.config,
      idleTimeout: opts.timeout,
      connectTimeout: opts.connectTimeout,
      reporter: opts.reporter,
      debugMode: opts.debug || (process.env.QTAP_DEBUG === '1'),
      verbose: opts.debug || opts.verbose,
    });
    process.exit(result.exitCode);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

/**
 * TODO: --concurrency=Infinity Always on? Responsibility of OS for sytem browsers
 *  to manage resources and figure it out, most cases will have 1 file and 1-3 browsers.
 *  likely reasons to want to limit it:
 *   - test file served from an app that cannot handle ANY concurrency.
 *     solution: run this one at a time in a loop consequtively with similar params.
 *  - using a cloud browser like browserstack or saucelabs and wanting to test N
 *    browsers but may only launch <N browsers concurrently. Ideally, the service
 *    will queue but in practice may fail/throttle hard?
 *    solution: browserstack just queues, no problem.
 *    saucelabs? TBD.
 *    If problematic, perhaps make it the qtap-plugin responsiblity
 *    that adds support for one of these cloud browsers, with a reasonable
 *    default and a dedicated env var to change it (e.g. QTAP_SAUCELABS_CONCURRENCY
 *    or SAUCELABS_CONCURRENCY), without needing qtap itself to have a global
 *    CLI parameter.
 */
