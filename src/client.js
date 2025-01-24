/* eslint-disable no-var -- Browser code */
/* global QUnit */
// @ts-nocheck

export function fnToStr (fn, qtapTapUrl, qtapStderrUrl) {
  return fn
    .toString()
    .replace(/\/\/.+$/gm, '')
    .replace(/\n|^\s+/gm, ' ')
    .replace(
      /'{{QTAP_TAP_URL}}'/g,
      JSON.stringify(qtapTapUrl)
    )
    .replace(
      /'{{QTAP_STDERR_URL}}'/g,
      JSON.stringify(qtapStderrUrl)
    );
}

// See ARCHITECTURE.md#qtap-internal-client-send
export function qtapClientHead () {
  // Support QUnit 2.24+: Enable TAP reporter, declaratively.
  window.qunit_config_reporters_tap = true;

  // Cache references to original methods, to avoid getting trapped by mocks (e.g. Sinon)
  var setTimeout = window.setTimeout;
  var XMLHttpRequest = window.XMLHttpRequest;

  // Support IE 9: console.log.apply is undefined.
  // Don't bother with Function.apply.call. Skip super call instead.
  var console = window.console || (window.console = {});
  var log = console.log && console.log.apply ? console.log : function () {};
  var warn = console.warn && console.warn.apply ? console.warn : function () {};
  var error = console.error && console.error.apply ? console.error : function () {};

  function createBufferedWrite (url) {
    var buffer = '';
    var isSending = false;
    function send () {
      isSending = true;

      var body = buffer;
      buffer = '';

      var xhr = new XMLHttpRequest();
      xhr.onload = xhr.onerror = () => {
        isSending = false;
        if (buffer) {
          send();
        }
      };
      xhr.open('POST', url, true);
      xhr.send(body);
    }
    return function write (str) {
      buffer += str + '\n';
      if (!isSending) {
        isSending = true;
        setTimeout(send, 0);
      }
    };
  }

  var writeTap = createBufferedWrite('{{QTAP_TAP_URL}}');
  var writeConsoleError = createBufferedWrite('{{QTAP_STDERR_URL}}');

  console.log = function qtapConsoleLog (str) {
    if (typeof str === 'string') {
      writeTap(str);
    }
    return log.apply(console, arguments);
  };

  console.warn = function qtapConsoleWarn (str) {
    writeConsoleError('' + str);
    return warn.apply(console, arguments);
  };

  console.error = function qtapConsoleError (str) {
    writeConsoleError('' + str);
    return error.apply(console, arguments);
  };

  function errorString (error) {
    var str = '' + error;
    if (str.slice(0, 7) === '[object') {
      // Based on https://es5.github.io/#x15.11.4.4
      return (error.name || 'Error') + (error.message ? (': ' + error.message) : '');
    }
    return str;
  }

  window.addEventListener('error', function (event) {
    var str = event.error ? errorString(event.error) : (event.message || 'Script error');
    if (event.filename && event.lineno) {
      str += '\n  at ' + event.filename + ':' + event.lineno;
    }
    writeConsoleError(str);
  });
}

export function qtapClientBody () {
  // Support QUnit 2.16 - 2.23: Enable TAP reporter, procedurally.
  if (typeof QUnit !== 'undefined' && QUnit.reporters && QUnit.reporters.tap && (!QUnit.config.reporters || !QUnit.config.reporters.tap)) {
    QUnit.reporters.tap.init(QUnit);
  }
}
