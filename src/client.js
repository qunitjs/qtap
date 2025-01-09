/* eslint-disable no-undef, no-var -- Browser code */
// @ts-nocheck

export function qtapClientHead () {
  // Support QUnit 3.0+: Enable TAP reporter, declaratively.
  window.qunit_config_reporters_tap = true;

  // See ARCHITECTURE.md#qtap-internal-client-send
  var qtapNativeLog = console.log;
  var qtapBuffer = '';
  var qtapShouldSend = true;
  function qtapSend () {
    var body = qtapBuffer;
    qtapBuffer = '';
    qtapShouldSend = false;

    var xhr = new XMLHttpRequest();
    xhr.onload = xhr.onerror = () => {
      qtapShouldSend = true;
      if (qtapBuffer) {
        qtapSend();
      }
    };
    xhr.open('POST', '{{QTAP_URL}}', true);
    xhr.send(body);
  }
  console.log = function qtapLog (str) {
    if (typeof str === 'string') {
      qtapBuffer += str + '\n';
      if (qtapShouldSend) {
        qtapShouldSend = false;
        setTimeout(qtapSend, 0);
      }
    }
    return qtapNativeLog.apply(this, arguments);
  };

  // TODO: Forward console.warn, console.error, and onerror to server.
  // TODO: Report window.onerror as TAP comment, visible by default.
  // TODO: Report console.warn/console.error in --verbose mode.
  window.addEventListener('error', function (error) {
    console.log('Script error: ' + (error.message || 'Unknown error'));
  });
}

export function qtapClientBody () {
  // Support QUnit 2.16 - 2.22: Enable TAP reporter, procedurally.
  if (typeof QUnit !== 'undefined' && QUnit.reporters && QUnit.reporters.tap && (!QUnit.config.reporters || !QUnit.config.reporters.tap)) {
    QUnit.reporters.tap.init(QUnit);
  }
}
