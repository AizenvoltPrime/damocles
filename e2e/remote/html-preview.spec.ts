import { activeTab, filesRow } from '../desktop/support/editor';
import { chooseMenuItem } from '../desktop/support/overlay';
import { shellPage } from '../desktop/support/shell';
import { addHost, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';

// An SSH project's HTML file previews in a chat-less tab, read over the wire through the host's workspace, a byte range
// included, and a change made on the host reloads it.

const APP = '/srv/app';
const PAGE = (heading: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>static</title><link rel="stylesheet" href="/css/site.css"></head><body><h1 id="heading">${heading}</h1><script>addEventListener("load", async () => { const data = await fetch("/data.json").then((r) => r.json()); const range = await fetch("/data.json", { headers: { Range: "bytes=2-8" } }).then(async (r) => [r.status, r.headers.get("content-range"), await r.text()]); document.title = "report:" + JSON.stringify({ heading: document.getElementById("heading").textContent, color: getComputedStyle(document.getElementById("heading")).color, data: data.value, range }); });</script></body></html>`;
// data.json as the host's printf writes it
const DATA_BYTES = Buffer.byteLength('{ "value": "host data" }\n');

test('an SSH project\'s page previews from the host and reloads after a change there', { tag: SSH_TAG }, async ({ foreground: _foreground, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  await fixture.sh(`mkdir -p ${APP}/css && cat > ${APP}/index.html`, 'dev', PAGE('On the host'));
  await fixture.sh(`printf '#heading { color: rgb(1, 2, 3); }\\n' > ${APP}/css/site.css && printf '{ "value": "host data" }\\n' > ${APP}/data.json`, 'dev');

  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  await openRemoteFolder(app, hostId, APP);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  const shell = await shellPage(app);

  await filesRow(shell, 'index.html').click({ button: 'right' });
  await chooseMenuItem(app, 'openPreview');
  const tab = shell.locator('[data-testid="editor-tab"][data-kind="htmlPreview"]');
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(tab.getByTestId('editor-tab-title')).toHaveText('Preview index.html');
  await expect.poll(async () => (await activeTab(app))?.htmlPreview?.status, { timeout: 120_000 }).toBe('ready');

  const report = async (): Promise<unknown> => {
    const title = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((contents) => !contents.isDestroyed() && contents.getURL().startsWith('damocles-preview:'))?.getTitle());
    return title?.startsWith('report:') ? JSON.parse(title.slice('report:'.length)) : title;
  };
  // a 206 shows the host answered the ranged request (files.readFileRange)
  await expect.poll(report, { timeout: 60_000 }).toEqual({ heading: 'On the host', color: 'rgb(1, 2, 3)', data: 'host data', range: [206, `bytes 2-8/${DATA_BYTES}`, '"value"'] });

  // A change on the host, to the page and to a stylesheet it loaded, reloads the tab.
  await fixture.sh(`cat > ${APP}/index.html`, 'dev', PAGE('Changed on the host'));
  await expect.poll(report, { timeout: 60_000 }).toMatchObject({ heading: 'Changed on the host' });
  await fixture.sh(`printf '#heading { color: rgb(4, 5, 6); }\\n' > ${APP}/css/site.css`, 'dev');
  await expect.poll(report, { timeout: 60_000 }).toMatchObject({ heading: 'Changed on the host', color: 'rgb(4, 5, 6)' });
});
