import tapFinished from '../src/tap-finished.js';

QUnit.module('tap-finished', function () {
  QUnit.test.each('results', {
    all_ok: {
      lines: [
        'TAP version 13',
        '# wait',
        'ok 1 (unnamed assert)',
        'ok 2 should be equal',
        '1..2',
        '# tests 2',
        '# pass 2'
      ],
      wait: 0,
      expectedLeft: 2, // finish on plan before last comments
      expectedResults: {
        ok: true,
        count: 2,
        pass: 2,
        fail: 0,
        bailout: false,
        todo: 0,
        skip: 0,
        plan: { // FinalPlan
          start: 1,
          end: 2,
          skipAll: false,
          skipReason: '',
          comment: ''
        },
        failures: [],
        asserts: [ // Result objects
          { ok: true, id: 1, name: '(unnamed assert)' },
          { ok: true, id: 2, name: 'should be equal' }
        ]
      }
    },
    excess: {
      lines: [
        'TAP version 13',
        '# wait',
        'ok 1 first thing',
        'ok 2 second thing',
        '1..2',
        '# tests 2',
        '# pass  1',
        '# fail  1',
        'ok 3 third thing'
      ],
      wait: 250,
      expectedLeft: 0, // all consumed after wait
      expectedResults: {
        ok: true,
        count: 2,
        pass: 2,
        fail: 0,
        bailout: false,
        todo: 0,
        skip: 0,
        plan: { // FinalPlan
          start: 1,
          end: 2,
          skipAll: false,
          skipReason: '',
          comment: ''
        },
        failures: [],
        asserts: [ // Result object
          { ok: true, id: 1, name: 'first thing' },
          { ok: true, id: 2, name: 'second thing' }
        ]
      }
    },
    has_failure: {
      lines: [
        'TAP version 13',
        '# wait',
        'ok 1 (unnamed assert)',
        'not ok 2 should be equal',
        '  ---',
        '    operator: equal',
        '    expected: 5',
        '    actual:   4',
        '  ...',
        '',
        '1..2',
        '# tests 2',
        '# pass  1',
        '# fail  1'
      ],
      wait: 0,
      expectedLeft: 3,
      expectedResults: {
        ok: false,
        count: 2,
        pass: 1,
        fail: 1,
        bailout: false,
        todo: 0,
        skip: 0,
        plan: {
          start: 1,
          end: 2,
          skipAll: false,
          skipReason: '',
          comment: ''
        },
        failures: [
          {
            ok: false,
            id: 2,
            name: 'should be equal',
            diag: { operator: 'equal', expected: 5, actual: 4 }
          }
        ],
        asserts: [
          { ok: true, id: 1, name: '(unnamed assert)' },
          { ok: false, id: 2, name: 'should be equal' }
        ]
      }
    }
  }, async function (assert, { lines, wait, expectedLeft, expectedResults }) {
    const results = await new Promise((resolve) => {
      const stream = tapFinished({ wait }, resolve);
      const i = setInterval(() => {
        if (lines.length === 0) {
          clearInterval(i);
          return;
        }
        stream.write(lines.shift() + '\n');
      }, 5);
    });

    assert.equal(lines.length, expectedLeft, 'lines remaining');
    assert.propContains(results, expectedResults, 'results');
  });

  QUnit.test('results [no_trailing_newline]', async function (assert) {
    const lines = [
      'TAP version 13',
      '# wait',
      'ok 1 (unnamed assert)',
      'not ok 2 should be equal',
      '  ---',
      '    operator: equal',
      '    expected: 5',
      '    actual:   4',
      '  ...',
      '',
      '1..2',
      '# tests 2',
      '# pass  1',
      '# fail  1'
    ];
    const results = await new Promise((resolve) => {
      const stream = tapFinished({ wait: 0 }, resolve);
      stream.write(lines.join('\n'));
    });

    assert.propContains(results, {
      ok: false,
      count: 2,
      pass: 1,
      fail: 1,
      bailout: false,
      todo: 0,
      skip: 0,
      plan: {
        start: 1,
        end: 2,
        skipAll: false,
        skipReason: '',
        comment: ''
      },
      failures: [
        {
          ok: false,
          id: 2,
          name: 'should be equal',
          diag: { operator: 'equal', expected: 5, actual: 4 }
        }
      ],
      asserts: [
        { ok: true, id: 1, name: '(unnamed assert)' },
        { ok: false, id: 2, name: 'should be equal' }
      ]
    }, 'results');
  });

  QUnit.test('not finished [no_plan]', async function (assert) {
    const lines = [
      'TAP version 13',
      '# wait',
      'ok 1 (unnamed assert)',
      'not ok 2 should be equal',
      '  ---',
      '    operator: equal',
      '    expected: 5',
      '    actual:   4',
      '  ...',
      '',
      '# tests 2',
      '# pass  1',
      '# fail  1'
    ];

    let called = false;
    const stream = tapFinished({ wait: 0 }, () => {
      called = true;
    });

    // write to stream
    await new Promise((resolve) => {
      const i = setInterval(() => {
        if (lines.length === 0) {
          clearInterval(i);
          resolve();
          return;
        }
        stream.write(lines.shift() + '\n');
      }, 5);
    });
    // wait a little extra
    await new Promise((resolve) => setTimeout(resolve, 5));

    assert.false(called, 'called');
  });
});
