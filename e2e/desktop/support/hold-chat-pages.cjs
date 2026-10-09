// Required into a dev launch's main process ahead of the app (LaunchOptions.require): holds every chat page's load until
// the test calls release(), so it can act before a chat is ready, and counts the keyboard focus each WebContents gains.
const { app } = require('electron');

const held = [];
let holding = true;
const focusGains = new Map();
const domReady = new Set();

app.on('web-contents-created', (_event, contents) => {
  contents.on('focus', () => focusGains.set(contents.id, (focusGains.get(contents.id) ?? 0) + 1));
  contents.on('dom-ready', () => domReady.add(contents.id));
  const loadURL = contents.loadURL.bind(contents);
  contents.loadURL = (url, options) => {
    if (!holding || !url.startsWith('app://damocles/panel/')) return loadURL(url, options);
    return new Promise((resolve, reject) => held.push(() => loadURL(url, options).then(resolve, reject)));
  };
});

globalThis.__e2eChatPages = {
  held: () => held.length,
  release: () => {
    holding = false;
    for (const load of held.splice(0)) load();
  },
  focusGains: (id) => focusGains.get(id) ?? 0,
  domReady: (id) => domReady.has(id),
};
