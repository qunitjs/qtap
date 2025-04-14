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

    let expectedHtmlFiles = fs.readFileSync(path.join(__dirname, 'qtap.test.js'), 'utf8')
      .split('\n')
      .map((line) => line.replace(/^\s*files: 'test\/fixtures\/(.+\.html)',$|^.*$|/, '$1'))
      .filter(Boolean)
      .sort();
    // Remove duplicates
    expectedHtmlFiles = expectedHtmlFiles.filter((name, i) => expectedHtmlFiles.indexOf(name) === i);

    // Each test case must use a fixture that exists.
    // Each fixture must have a corresponding test case (or be removed).
    assert.deepEqual(actualFilesTested, expectedHtmlFiles, 'Only tested HTML files');
  });

  async function resolveDeps (lock, packageName, depth = 0, seen = new Map(), ret = {}) {
    const pack = lock.packages['node_modules/' + packageName] || lock.packages[packageName];

    if (depth > 100) throw new Error(`Exceeded max depth at ${packageName}`);
    if (!pack) throw new Error(`Could not find ${packageName}`);

    const transient = packageName === '' ? ret : {};
    if (packageName !== '') {
      if (!seen.has(packageName)) {
        if (!pack.resolved) throw new Error(`Missing "resolved" for ${packageName}`);
        const resp = await fetch(pack.resolved);
        const blob = await resp.blob();
        const packageSize = Math.round(blob.size / 1024) + ' KiB';

        seen.set(packageName, blob.size);
        ret[packageName] = { packageSize, dependencies: transient };
      } else {
        ret[packageName] = { packageSize: null, dependencies: transient };
      }
    }

    for (const dep in (pack.dependencies || [])) {
      const child = {};
      await resolveDeps(lock, dep, depth + 1, seen, child);
      Object.assign(transient, child);
    }

    for (const dep in ret) {
      if (ret[dep].dependencies && !Object.keys(ret[dep].dependencies).length) {
        delete ret[dep].dependencies;
      }
    }

    if (packageName === '') {
      ret._total = Math.round([...seen.values()].reduce((sum, val) => sum + val) / 1024) + ' KiB';
    }

    return ret;
  }

  QUnit.test.if('dependencies', process.env.CI, async function (assert) {
    const lock = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../package-lock.json'))
    );
    const directDeps = Object.keys(lock.packages[''].dependencies);
    const allDeps = await resolveDeps(lock, '');

    assert.strictEqual(directDeps.length, 4, 'upto 5 direct dependencies');
    assert.deepEqual(allDeps, {
      _total: '248 KiB',
      commander: {
        packageSize: '47 KiB'
      },
      'tap-parser': {
        packageSize: '68 KiB',
        dependencies: {
          'events-to-array': {
            packageSize: '2 KiB'
          },
          'tap-yaml': {
            packageSize: '6 KiB',
            dependencies: {
              yaml: {
                packageSize: '109 KiB'
              },
              'yaml-types': {
                packageSize: '7 KiB'
              }
            }
          }
        }
      },
      which: {
        packageSize: '3 KiB',
        dependencies: {
          isexe: {
            packageSize: '7 KiB'
          }
        }
      },
      yaml: {
        packageSize: null
      }
    });
  });
});
