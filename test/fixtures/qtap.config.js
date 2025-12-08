function throwIfNotOK (resp) {
  if (!resp.ok || !resp.status) {
    // throw new Error(`HTTP ${resp.status} error`);
  }
  return resp;
}

async function fake (url) {
  fake.displayName = 'FakeBrowser';

  // Fetch page to indicate that the client connected, and to fetch the fake results.
  // We use the response for real to validate that `files` and `cwd` are
  // resolved and served correctly.
  const body = await fetch(url).then(throwIfNotOK).then(resp => resp.text());
  const tapDocument = body.replace(/<script>.*<\/script>/g, '');

  // Find submission endpoint, leave `qtap_clientId` in urlObj.search unchanged
  const qtapTapUrl = String(Object.assign(new URL(url), {
    pathname: '/.qtap/tap/'
  }));

  // Submit fake results
  await fetch(qtapTapUrl, {
    method: 'POST',
    body: tapDocument
  });
}

/**
 * Echo the URL back to the server.
 * This is to end-to-end test how launchBrowser() formats the URL.
 */
async function fakeEcho (url, signals) {
  const runtime = new Promise((resolve) => {
    signals.browser.addEventListener('abort', () => resolve());
  });

  // Fetch page to indicate that the client connected, and to fetch the fake results.
  // We use the response for real to validate that `files` and `cwd` are
  // resolved and served correctly.
  const body = await fetch(url).then(throwIfNotOK).then(resp => resp.text());
  const tapDocument = body
    .replace(/<script>.*<\/script>/, '\n# console: <script> found\n')
    .replace(/<script>.*<\/script>/g, '');

  // Find submission endpoint, leave `qtap_clientId` in urlObj.search unchanged
  const qtapTapUrl = String(Object.assign(new URL(url), {
    pathname: '/.qtap/tap/'
  }));

  const browserUrl = new URL(url);
  await fetch(qtapTapUrl, {
    method: 'POST',
    body: '# console: Browser URL is ' + browserUrl.pathname + browserUrl.search + '\n'
      // Submit fake results
      + tapDocument
  });

  await runtime;
}

let serialEcho = Promise.resolve();

async function fakeEchoA (url, signals) {
  const runtime = new Promise((resolve) => {
    signals.browser.addEventListener('abort', () => resolve());
  });
  await serialEcho;
  serialEcho = serialEcho.finally(() => runtime);

  const body = await fetch(url).then(throwIfNotOK).then(resp => resp.text());
  const tapDocument = body.replace(/<script>.*<\/script>/g, '');

  const qtapTapUrl = String(Object.assign(new URL(url), {
    pathname: '/.qtap/tap/'
  }));

  await fetch(qtapTapUrl, {
    method: 'POST',
    body: '# console: EchoA loaded ' + new URL(url).pathname + '\n' + tapDocument
  });

  await runtime;
}

async function fakeEchoB (url, signals) {
  const runtime = new Promise((resolve) => {
    signals.browser.addEventListener('abort', () => resolve());
  });
  await serialEcho;
  serialEcho = serialEcho.finally(() => runtime);

  const body = await fetch(url).then(throwIfNotOK).then(resp => resp.text());
  const tapDocument = body.replace(/<script>.*<\/script>/g, '');

  const qtapTapUrl = String(Object.assign(new URL(url), {
    pathname: '/.qtap/tap/'
  }));

  await fetch(qtapTapUrl, {
    method: 'POST',
    body: '# console: EchoB loaded ' + new URL(url).pathname + '\n' + tapDocument
  });

  await runtime;
}

async function fakeFailSync () {
  // eslint-disable-next-line no-undef
  boom();
}

async function fakeFailAsync (url, signals) {
  await new Promise((resolve, reject) => {
    setTimeout(() => {
      reject(new Error('Boom'));
    }, 10);
  });

  const runtime = new Promise((resolve) => {
    signals.browser.addEventListener('abort', () => resolve());
  });
  await runtime;
}

async function fakeSlowFail (url, signals) {
  await new Promise((resolve, reject) => {
    setTimeout(() => {
      reject('Still alive after 3s. connectTimeout not working?');
    }, 3000);

    signals.browser.addEventListener('abort', () => reject(new Error('Bye')));
  });
}
fakeSlowFail.allowRetries = false;

async function fakeRefuse (_url, signals) {
  await new Promise((resolve, reject) => {
    signals.browser.addEventListener('abort', () => {
      reject('I dare you, I double dare you. Do not try to restart me.');
    });
  });
}
fakeRefuse.allowRetries = false;

async function fakeRefuseAlways (_url, signals) {
  await new Promise((resolve, reject) => {
    signals.browser.addEventListener('abort', () => {
      reject('You may retry but I will never connect.');
    });
  });
}

const snoozeByFile = {};
async function fakeLazy (url, signals, logger) {
  const path = new URL(url).pathname;
  snoozeByFile[path] ??= 0;
  snoozeByFile[path]++;
  if (snoozeByFile[path] < 3) {
    logger.warning('Meh, I do not want to start. Ask me again later!');
    // Sleep until aborted
    return await new Promise((resolve, reject) => {
      signals.browser.addEventListener('abort', () => {
        reject('Try again, please.');
      });
    });
  }
  return await fake(url);
}

function failOnClients (eventbus) {
  eventbus.on('clients', function () {
    throw new Error('boo');
  });
}

export default {
  browsers: {
    fake,
    fakeEcho,
    fakeEchoA,
    fakeEchoB,
    fakeFailSync,
    fakeFailAsync,
    fakeSlowFail,
    fakeRefuse,
    fakeRefuseAlways,
    fakeLazy,
  },
  reporters: {
    failOnClients
  }
};
