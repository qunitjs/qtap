// @ts-nocheck

// See ARCHITECTURE.md#qtap-internal-client-send
function qtapClientHead () {
  // Support QUnit 2.24+: Enable TAP reporter, declaratively.
  window.qunit_config_reporters_tap = true;
  window.qunit_config_reporters_html = false;

  // Cache references to original methods, to avoid getting trapped by mocks (e.g. Sinon)
  var setTimeout = window.setTimeout;
  var XMLHttpRequest = window.XMLHttpRequest;
  var createTextNode = document.createTextNode && document.createTextNode.bind && document.createTextNode.bind(document);

  // Support IE 9: console.log.apply is undefined.
  // Don't bother with Function.apply.call. Skip super call instead.
  var console = window.console || (window.console = {});
  var log = console.log && console.log.apply ? console.log : function () {};
  var warn = console.warn && console.warn.apply ? console.warn : function () {};
  var error = console.error && console.error.apply ? console.error : function () {};
  var jsonStringify = JSON.stringify.bind(JSON);
  var toString = Object.prototype.toString;
  var hasOwn = Object.prototype.hasOwnProperty;

  /**
   * Create a shallow clone of an object, with cycles replaced by "[Circular]".
   */
  function decycledShallowClone (object, ancestors) {
    ancestors = ancestors || [];
    if (ancestors.indexOf(object) !== -1) {
      return '[Circular]';
    }
    if (ancestors.length > 100) {
      return '...';
    }
    var type = toString.call(object).replace(/^\[.+\s(.+?)]$/, '$1').toLowerCase();
    var clone;
    switch (type) {
      case 'array':
        ancestors.push(object);
        clone = [];
        for (var i = 0; i < object.length; i++) {
          clone[i] = decycledShallowClone(object[i], ancestors);
        }
        ancestors.pop();
        break;
      case 'object':
        ancestors.push(object);
        clone = {};
        for (var key in object) {
          if (hasOwn.call(object, key)) {
            clone[key] = decycledShallowClone(object[key], ancestors);
          }
        }
        ancestors.pop();
        break;
      default:
        clone = object;
    }
    return clone;
  }

  function stringify (data) {
    if (typeof data !== 'object') {
      return '' + data;
    }
    return jsonStringify(decycledShallowClone(data));
  }

  function createBufferedWrite (url) {
    var buffer = '';
    var isSending = false;
    var debugElement = false;
    function send () {
      var body = buffer;
      buffer = '';

      var xhr = new XMLHttpRequest();
      xhr.onload = xhr.onerror = function () {
        if (buffer) {
          send();
        } else {
          isSending = false;
        }
      };
      xhr.open('POST', url, true);
      xhr.send(body);

      // Optimization: Only check this once, during the first send
      if (debugElement === false) {
        debugElement = document.getElementById('__qtap_debug_element') || null;
      }
      if (debugElement) {
        debugElement.appendChild(createTextNode(body));
      }
    }
    return function writeTap (str) {
      buffer += str + '\n';
      if (!isSending) {
        isSending = true;
        setTimeout(send, 0);
      }
    };
  }

  var writeTap = createBufferedWrite('{{QTAP_TAP_URL}}');

  function writeConsoleError (str) {
    var prefix = '# console: ';
    writeTap(prefix + str.replace(/\n/g, '\n' + prefix));
  }

  console.log = function qtapConsoleLog (str) {
    if (typeof str === 'string') {
      writeTap(str);
    }
    return log.apply(console, arguments);
  };

  console.warn = function qtapConsoleWarn () {
    var str = [];
    for (var i = 0; i < arguments.length; i++) {
      str[i] = stringify(arguments[i]);
    }
    writeConsoleError(str.join(' '));
    return warn.apply(console, arguments);
  };

  console.error = function qtapConsoleError () {
    var str = [];
    for (var i = 0; i < arguments.length; i++) {
      str[i] = stringify(arguments[i]);
    }
    writeConsoleError(str.join(' '));
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

  // TODO: Add window.addEventListener('unhandledrejection')
}

function qtapClientBody () {
  /* global QUnit */
  // Support QUnit 2.16 - 2.23: Enable TAP reporter, procedurally.
  if (typeof QUnit !== 'undefined' && QUnit.reporters && QUnit.reporters.tap && (!QUnit.config.reporters || !QUnit.config.reporters.tap)) {
    QUnit.reporters.tap.init(QUnit);
  }
}

module.exports = {
  qtapClientHead: qtapClientHead,
  qtapClientBody: qtapClientBody
};
