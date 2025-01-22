import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

QUnit.module('structure', function () {
  QUnit.test('fixtures', function (assert) {
    const actualFilesTested = fs.readdirSync(path.join(__dirname, 'fixtures'))
      .filter((name) => name.endsWith('.html'))
      .sort();

    const expectedHtmlFiles = fs.readFileSync(path.join(__dirname, 'qtap.test.js'), 'utf8')
      .split('\n')
      .map((line) => line.replace(/^\s*files: 'test\/fixtures\/(.+\.html)',$|^.*$|/, '$1'))
      .filter(Boolean)
      .sort();

    // Each test case's fixture should exist.
    // Each fixture should have a test case declaring the expected behavior.
    assert.deepEqual(actualFilesTested, expectedHtmlFiles, 'Only tested HTML files');
  });
});
