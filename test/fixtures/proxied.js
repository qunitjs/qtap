/* global QUnit */

QUnit.module('proxied', function () {
  QUnit.test('example', function (assert) {
    assert.equal(4, 4);
  });
  QUnit.test('Last-Modified header', function (assert) {
    assert.equal(new Date(document.lastModified).toISOString(), '2011-08-12T06:15:00.000Z');
  });
});
