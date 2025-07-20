/* global QUnit, boom */

QUnit.test('apple', function (assert) {
  assert.true(true, 'stem');
  assert.true(true, 'skin');
});
QUnit.test('banana', function (assert) {
  var done = assert.async();
  setTimeout(function () {
    assert.true(true, 'foo');
    done();
    boom(); // Uncaught ReferenceError
  });
});
QUnit.test('sauerkraut', function (assert) {
  assert.true(true, 'acid rock');
  assert.true(true, 'kraut rock');
});
QUnit.test('dampfnudel', function (assert) {
  assert.true(true, 'stream');
  assert.true(true, 'bun');
});
