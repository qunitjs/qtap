import browsers from './src/browsers.js';

function redpanda () {
  return {
    async launch (clientId, url, signal, logger) {
      const FirefoxBrowser = browsers.firefox;
      const browser = new FirefoxBrowser(logger);
      return await browser.launch(clientId, url, signal, logger);
    }
  };
}

export default {
  browsers: {
    redpanda
  }
};
