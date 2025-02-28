export default {
  browsers: {
    noop_true () {
    },

    /**
     * @param {string} url
     */
    fake: async function fake (url) {
      fake.displayName = 'FakeBrowser';

      // Fetch page to indicate that we're online, and to fetch fake results.
      // We use the response for real to validate that `files` and `cwd` are
      // resolved and served correctly.
      const body = await (await fetch(url)).text();
      const tapDocument = body.replace(/<script>.*<\/script>/, '');

      // Determine submission endpoint
      // Leave `qtap_clientId` in urlObj.search unchanged
      const qtapTapUrl = String(Object.assign(new URL(url), {
        pathname: '/.qtap/tap/'
      }));

      // Submit fake results
      await fetch(qtapTapUrl, {
        method: 'POST',
        body: tapDocument
      });
    },

    async noop_false (url, signals) {
      await new Promise((resolve, reject) => {
        setTimeout(() => {
          reject(new Error('Burp'));
        }, 3000);
        signals.browser.addEventListener('abort', () => {
          reject(new Error('Bye'));
        });
      });
    }
  }
};
