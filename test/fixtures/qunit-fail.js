/* global QUnit */

QUnit.test('apple', function (assert) {
  assert.true(true, 'stem');
  assert.true(true, 'skin');
});
QUnit.test('banana', function (assert) {
  assert.true(true, 'foo');
  assert.equal('This is actual.', 'This is expected.', 'example sentence');
  assert.true(true, 'bar');
  assert.true(true, 'baz');
});
QUnit.test('sauerkraut', function (assert) {
  assert.true(true, 'acid rock');
  assert.true(true, 'kraut rock');
});
QUnit.test('dampfnudel', function (assert) {
  assert.true(true, 'stream');
  assert.true(true, 'bun');
});
