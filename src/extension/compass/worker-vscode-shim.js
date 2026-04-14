const { parentPort } = require('worker_threads');

module.exports = {
  window: {
    createOutputChannel: () => ({
      appendLine: (msg) => {
        if (parentPort) parentPort.postMessage({ type: 'log', message: String(msg) });
      },
      show: () => {},
      dispose: () => {},
    }),
  },
  workspace: {
    getConfiguration: () => ({
      get: () => undefined,
    }),
  },
};
