import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { activeChat, selectChatPage } from '../desktop/support/fixtures';
import { activePageTab, browserTabs, chromeEnv, openPage, PAGE_TIMEOUT } from '../desktop/support/browser';
import { editorTab } from '../desktop/support/editor';
import { writeUserSettings } from '../desktop/support/hermetic';
import { lastToolResultRequest } from '../desktop/support/openai-stub';
import { closeSettingsModal } from '../desktop/support/settings';
import { selectedProjectKey, shellPage, shellState } from '../desktop/support/shell';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { openRemoteHostSettings, setHostSwitch } from './support/host-settings-ui';
import { addHost, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import type { SshdFixture } from './support/sshd';
import { newRemoteChat, startTargetStub } from './support/target-agent';

const APP = '/srv/app';
const DEV_SERVER = fs.readFileSync(path.join(__dirname, 'support', 'dev-server.mjs'), 'utf8');
const LOCAL_NETWORK_SWITCH = "Let the agent's browser reach this computer's local network";
// the host forms a page may name this computer by (docs/invariants.md "Ports and the remote browser")
const FORMS = ['localhost', '127.0.0.1', '2130706433', '[::ffff:7f00:1]', '0.0.0.0', '127.0.0.1.nip.io', 'rebind.e2e.test'] as const;
const REBIND = 'rebind.e2e.test';

// The probe a remote chat's page runs against host form H, client port C and TURN port T: with `nav`, a top-level navigation
// of the page itself; else fetch, image, websocket, worker and WebRTC over a TCP TURN server, each given at most 5 s, and the
// title says when all settled.
const PROBE = `<!doctype html><meta charset="utf-8"><title>probe running</title><script>
const query = new URLSearchParams(location.search);
const nav = query.get('nav');
if (nav !== null) location.assign('http://' + nav + ':' + query.get('c') + '/nav?h=' + encodeURIComponent(nav));
const forms = (query.get('forms') ?? '').split(',').filter(Boolean);
const c = query.get('c');
const t = query.get('t');
const within = (promise) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, 5000))]).catch(() => undefined);
const kinds = (h) => [
  within(fetch('http://' + h + ':' + c + '/fetch?h=' + encodeURIComponent(h), { mode: 'no-cors' })),
  within(new Promise((resolve) => { const img = new Image(); img.onload = img.onerror = resolve; img.src = 'http://' + h + ':' + c + '/img?h=' + encodeURIComponent(h); })),
  within(new Promise((resolve) => { const ws = new WebSocket('ws://' + h + ':' + c + '/ws?h=' + encodeURIComponent(h)); ws.onopen = ws.onerror = ws.onclose = resolve; })),
  within(new Promise((resolve) => {
    const source = "fetch('http://" + h + ":" + c + "/worker?h=" + encodeURIComponent(h) + "', { mode: 'no-cors' }).finally(() => postMessage(1))";
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    worker.onmessage = worker.onerror = resolve;
  })),
  within((async () => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'turn:' + h + ':' + t + '?transport=tcp', username: 'u', credential: 'p' }] });
    pc.createDataChannel('probe');
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((resolve) => { pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') resolve(); }; });
    pc.close();
  })()),
];
if (nav === null) Promise.all(forms.flatMap(kinds)).then(() => { document.title = 'probe done'; });
</script>`;

interface ClientService {
  readonly port: number;
  readonly turnPort: number;
  // every request path and websocket upgrade the service saw, and every connection the TURN listener accepted
  readonly seen: string[];
  readonly turns: number;
  close(): Promise<void>;
}

// A service that exists only on this computer, on both loopbacks and every form of them; never forwarded.
async function startClientService(): Promise<ClientService> {
  const seen: string[] = [];
  let turns = 0;
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>client service</title>');
  });
  server.on('upgrade', (req, socket) => {
    seen.push(`UPGRADE ${req.url}`);
    socket.destroy();
  });
  const turn = net.createServer((socket) => {
    turns += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '::', () => resolve()));
  await new Promise<void>((resolve) => turn.listen(0, '::', () => resolve()));
  return {
    port: (server.address() as net.AddressInfo).port,
    turnPort: (turn.address() as net.AddressInfo).port,
    seen,
    get turns() {
      return turns;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => turn.close(() => resolve()));
    },
  };
}

const holdLocalPort = (port: number): Promise<net.Server> => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => resolve(server));
});

async function typeAddress(app: ElectronApplication, url: string): Promise<void> {
  const shell = await shellPage(app);
  // the selected chat's page tab, shown, so its address field is there
  if ((await activePageTab(app)) === undefined) {
    const [page] = await browserTabs(app);
    if (!page) throw new Error('the selected chat has no page');
    await editorTab(shell, page.title).click();
    await expect.poll(async () => (await activePageTab(app))?.id).toBe(page.id);
  }
  // the address field follows the page while it loads, which would overwrite what is typed into it
  await expect.poll(async () => (await activePageTab(app))?.browser.loading, { timeout: PAGE_TIMEOUT }).toBe(false);
  const address = shell.getByTestId('browser-address');
  await address.fill(url);
  await address.press('Enter');
}

// the shown permission card: one that answered leaves through a transition while the next one enters
const permissionCard = (tab: Page): Locator => tab.locator('section[role="region"][aria-label="Permission request"]:not([class*="-leave-"])');

// Answers Yes to every permission card the turn raises until `text` shows in the chat.
async function approveUntil(tab: Page, text: string): Promise<void> {
  await expect.poll(async () => {
    if (await tab.getByText(text).isVisible()) return true;
    const card = permissionCard(tab);
    if (await card.isVisible()) await card.getByRole('option', { name: 'Yes', exact: true }).click();
    return false;
  }, { timeout: PAGE_TIMEOUT, intervals: [500] }).toBe(true);
}

// a project selected again shows the chat it showed, and that chat's page
async function selectProject(app: ElectronApplication, projectKey: string): Promise<void> {
  await (await shellPage(app)).evaluate((target) => window.damoclesShell!.selectProject(target), projectKey);
  await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(projectKey);
}

const pageTitle = async (app: ElectronApplication): Promise<string | undefined> => (await activePageTab(app))?.title;

async function startDevServerFiles(fixture: SshdFixture): Promise<void> {
  await fixture.sh(`cat > ${APP}/dev-server.mjs`, 'dev', DEV_SERVER);
  await fixture.sh(`cat > ${APP}/probe.html`, 'dev', PROBE);
  await fixture.sh(`echo v1 > ${APP}/message.txt`, 'dev');
}

const devLog = (fixture: SshdFixture): Promise<string> => fixture.sh('cat /tmp/dev.log', 'dev');


test('the agent starts the Vite fixture and opens http://localhost:5173: its page renders in the remote chat\'s tab on 5174, a change on the target hot-updates it, the agent sees 5173 throughout; cookies stay per context; a remote page reaches neither this computer\'s loopback nor its network in any form unless the host\'s switch allows it, a forwarded port always; local pages are not proxied', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(900_000);
  writeUserSettings(home, { 'damocles.browser.enabled': true });
  const fixture = await sshd('prod-1');
  const stub = await startTargetStub(home, fixture);
  const client = await startClientService();
  // another project's dev server on this computer holds 5173
  const local5173 = await holdLocalPort(5173);
  try {
    const { app } = await launch({ env: { ...remoteEnv(ssh, mirror), ...chromeEnv() } });
    const localTab = await activeChat(app);
    const localProject = await selectedProjectKey(app);
    // a local chat's page is not proxied: it reaches this computer's own service (and its page keeps the chat loaded)
    await openPage(app, localTab, `http://localhost:${client.port}/local`);
    await expect.poll(() => client.seen).toContain('GET /local');
    const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
    await openRemoteFolder(app, hostId, APP);
    const key = await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    await startDevServerFiles(fixture);
    const node = (await fixture.sh('ls -d /home/dev/.damocles/server/*/node/node | head -n 1', 'dev')).trim();
    const tab = await newRemoteChat(app, key);

    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'bash', arguments: { command: `(setsid ${node} ${APP}/dev-server.mjs ${APP} 5173 > /tmp/dev.log 2>&1 &); sleep 1; cat /tmp/dev.log` } }] },
      { chunks: [], toolCalls: [{ name: 'ToolSearch', arguments: { tools: ['browser'] } }] },
      { chunks: [], toolCalls: [{ name: 'BrowserNavigate', arguments: { url: 'http://localhost:5173/' } }] },
      { chunks: ['The dev server is open.'] },
    );
    await sendPrompt(tab, 'start the dev server and open it');
    await approveUntil(tab, 'The dev server is open.');
    const navigated = lastToolResultRequest(stub);
    expect(navigated).toContain('Navigated to: http://localhost:5173/');
    expect(navigated).not.toContain('5174');

    // the page is a tab of the remote chat, on the forward's local port, chipped with the target's address
    await expect.poll(async () => (await browserTabs(app)).map((page) => [page.browser.url, page.browser.forwardedFrom?.targetUrl]), { timeout: PAGE_TIMEOUT }).toContainEqual(['http://localhost:5174/', 'http://localhost:5173/']);
    await expect.poll(() => pageTitle(app), { timeout: PAGE_TIMEOUT }).toBe('v1 · loads 1');
    // the page's icon comes from the forward through the host's proxy, as the page does
    await expect.poll(async () => (await activePageTab(app))?.browser.iconDataUrl ?? '', { timeout: PAGE_TIMEOUT }).toMatch(/^data:image\/png;base64,/);
    expect(await devLog(fixture)).toContain('request /favicon.ico');
    // a change on the target reaches the page over the hot-reload websocket, through the tunnel, without a reload
    await fixture.sh(`echo v2 > ${APP}/message.txt`, 'dev');
    await expect.poll(() => pageTitle(app), { timeout: 30_000 }).toBe('v2 · loads 1');
    expect(await devLog(fixture)).toContain('hmr update v2');

    // cookies: the remote chat's context and a local chat's never share one, at the same origin either way
    await typeAddress(app, 'http://localhost:5173/cookie?set=remote');
    await expect.poll(() => pageTitle(app), { timeout: PAGE_TIMEOUT }).toBe('cookies:remote=1');
    await selectProject(app, localProject);
    await selectChatPage(app, localTab);
    await typeAddress(app, 'http://localhost:5174/cookie?set=local');
    await expect.poll(() => pageTitle(app), { timeout: PAGE_TIMEOUT }).toBe('cookies:local=1');
    await selectProject(app, key);
    await selectChatPage(app, tab);
    await typeAddress(app, 'http://localhost:5173/cookie');
    await expect.poll(() => pageTitle(app), { timeout: PAGE_TIMEOUT }).toBe('cookies:remote=1');

    // the switch off: no form of this computer's address reaches the client service from a remote page
    await app.evaluate((_electron, answers) => (globalThis as unknown as { __damoclesE2e: { browser: { clientNetworkAnswers(answers: Record<string, string[][]>): Promise<void> } } }).__damoclesE2e.browser.clientNetworkAnswers(answers), { [REBIND]: [['2001:db8::1'], ['127.0.0.1']] });
    let runs = 0;
    // each probe run has its own address, since its new top-level pages take the active tab
    const runProbe = async (port: number, forms: readonly string[]): Promise<void> => {
      const run = ++runs;
      await typeAddress(app, `http://localhost:5173/probe.html?run=${run}&forms=${encodeURIComponent(forms.join(','))}&c=${port}&t=${client.turnPort}`);
      await expect.poll(async () => (await browserTabs(app)).find((page) => page.browser.url.includes(`probe.html?run=${run}&`))?.title, { timeout: 120_000 }).toBe('probe done');
    };
    // the page navigates itself to form H; resolves once the tab left the probe for the navigation's address
    const navigate = async (form: string): Promise<void> => {
      await typeAddress(app, `http://localhost:5173/probe.html?nav=${encodeURIComponent(form)}&c=${client.port}`);
      await expect.poll(async () => (await activePageTab(app))?.browser.url ?? '', { timeout: PAGE_TIMEOUT }).toContain('/nav?h=');
    };
    await runProbe(client.port, FORMS);
    for (const form of FORMS) await navigate(form);
    expect(client.seen.filter((line) => !line.startsWith('GET /local'))).toEqual([]);
    expect(client.turns).toBe(0);
    // the agent's own navigation to this computer's network is refused with the guard's reason
    stub.replies.push({ chunks: [], toolCalls: [{ name: 'BrowserNavigate', arguments: { url: `http://10.0.0.5:${client.port}/agent` } }] }, { chunks: ['Refused.'] });
    await sendPrompt(tab, 'open the client service');
    await approveUntil(tab, 'Refused.');
    expect(lastToolResultRequest(stub)).toContain('is on this computer or its local network');
    expect(client.seen.filter((line) => line.includes('/agent'))).toEqual([]);

    // a forwarded port passes, switch off: the same kinds reach the target's dev server through its forward
    await runProbe(5174, ['localhost', '127.0.0.1']);
    const passed = await devLog(fixture);
    for (const kind of ['/fetch?h=localhost', '/img?h=localhost', '/worker?h=localhost', '/fetch?h=127.0.0.1']) expect(passed).toContain(`request ${kind}`);

    // the switch on: every kind reaches the client service for the loopback literals
    const settings = await openRemoteHostSettings(app, hostId);
    await setHostSwitch(settings.block, LOCAL_NETWORK_SWITCH, true);
    await closeSettingsModal(settings.overlay);
    await runProbe(client.port, ['localhost', '127.0.0.1', '2130706433', '[::ffff:7f00:1]']);
    for (const form of ['localhost', '127.0.0.1', '2130706433', '[::ffff:7f00:1]']) {
      for (const kind of ['fetch', 'img', 'worker']) expect(client.seen, `${kind} ${form}`).toContain(`GET /${kind}?h=${encodeURIComponent(form)}`);
      expect(client.seen, `ws ${form}`).toContain(`UPGRADE /ws?h=${encodeURIComponent(form)}`);
    }
    for (const form of ['localhost', '127.0.0.1', '2130706433', '[::ffff:7f00:1]']) {
      await navigate(form);
      await expect.poll(() => client.seen, { message: `nav ${form}` }).toContain(`GET /nav?h=${encodeURIComponent(form)}`);
    }
    // WebRTC's TURN over TCP reaches the client's listener through the proxy
    expect(client.turns).toBeGreaterThan(0);

    await fixture.sh('pkill -u dev -f dev-server.mjs; true', 'root');
    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    await stub.close();
    await client.close();
    await new Promise<void>((resolve) => local5173.close(() => resolve()));
  }
});
