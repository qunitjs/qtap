async function fake (url) {
  fake.displayName = 'FakeBrowser';

  // Fetch page to indicate that the client connected, and to fetch the fake results.
  // We use the response for real to validate that `files` and `cwd` are
  // resolved and served correctly.
  const body = await (await fetch(url)).text();
  const tapDocument = body.replace(/<script>.*<\/script>/, '');

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
  const body = await (await fetch(url)).text();
  const tapDocument = body.replace(/<script>.*<\/script>/, '\n# console: <script> found\n');

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

const snoozedFiles = {};
async function fakeLazy (url) {
  const path = new URL(url).pathname;
  snoozedFiles[path] ??= 0;
  snoozedFiles[path]++;
  if (snoozedFiles[path] < 3) {
    throw 'Meh, I do not want to start. Ask me again later!';
  }
  return await fake(url);
}

export default {
  browsers: {
    fake,
    fakeEcho,
    fakeSlowFail,
    fakeRefuse,
    fakeLazy,
  }
};
