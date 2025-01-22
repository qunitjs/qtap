export default {
  browsers: {
    noop_true () {
    },
    async noop_false (url, signals) {
      await new Promise((resolve, reject) => {
        setTimeout(() => {
          reject(new Error('Burp'));
        }, 3000);
        signals.browser.addEventListener('abort', () => {
          reject(new Error('Boo'));
        });
      });
    }
  }
};
