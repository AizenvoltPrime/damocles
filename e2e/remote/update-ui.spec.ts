import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page, TestInfo } from '@playwright/test';
import type { OverlayToast } from '../../src/desktop/preload/overlay-channels';
import type { HostUpdate } from '../../src/shared/host-update';
import type { DesktopApp, LaunchOptions } from '../desktop/support/app';
import { writeUserSettings, type HermeticHome } from '../desktop/support/hermetic';
import { cleanUp } from '../desktop/support/loopback';
import { sendPrompt } from '../desktop/support/loopback-agent';
import type { OpenAIStub } from '../desktop/support/openai-stub';
import { settled } from '../desktop/support/screenshots';
import { setContentSize } from '../desktop/support/settings';
import { heldToasts, overlayPage, popupPage, recordedPopupToasts, recordToasts, shellPage, shellState } from '../desktop/support/shell';
import { listChats, titleBar } from '../desktop/support/shell-ui';
import { activeTerminal, openTerminal, runInTerminal } from '../desktop/support/terminal';
import { awaitTurnEnd, chatInput, clickMenu, setLook } from '../desktop/support/ui';
import { CONNECT_TO_HOST_MENU } from './support/connect-ui';
import { expectNoAccountProcesses, shutdownHostDaemon } from './support/daemon-teardown';
import { expect, test } from './support/flaky';
import { CURRENT_PACKAGE, daemonVersions, installOlderServer, OLD, securityFloor, type OlderServerOptions } from './support/older-server';
import { APP_VERSION, LINUX_TARGET, serverVersionOf, type ReleaseMirror } from './support/release-mirror';
import { addHost, dropConnection, lastConnectStep, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG } from './support/remote';
import { exited, requestQuit } from './support/remote-runs';
import { outsideRepository, REMOTE_SHOTS } from './support/review-shots';
import { secondDevice } from './support/second-device';
import type { SshClientHome, SshdFixture } from './support/sshd';
import { newRemoteChat, startTargetStub } from './support/target-agent';

// The design "Remote server update states" (screens S1 to S5) replayed against the app: what each state of a pending server
// switch shows and how assistive technology names it. What the daemons do in each state is app-update.spec.ts's and
// multi-device.spec.ts's.

const HOST = 'prod-1';
const NEWER = '99.0.0';
const OTHER_PROTOCOL = 2;
const APP = '/srv/app';
// the design's checked widths, and the two its journeys replay at
const CHECKED_WIDTHS = [390, 768, 1024, 1280] as const;
const JOURNEY_WIDTHS = [1280, 390] as const;
const WINDOW = { width: 1280, height: 820 } as const;
const MIN_PAGE_HEIGHT = 480;
const AGENTS = ['Fix flaky login test', 'Refactor billing export'] as const;
const TERMINAL_SLEEP = 'sleep 3600';

type Lang = 'en' | 'el';

const rx = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SPOKEN: Record<Lang, string> = { en: '(?:less than a minute|1 minute|\\d+ minutes)', el: '(?:λιγότερο από ένα λεπτό|1 λεπτό|\\d+ λεπτά)' };

/**
 * `text` as a pattern's source: {time} is a short time on the 24-hour clock, {clock} the ticking mm:ss with its spoken
 * minutes, {minutes} the spoken minutes, and {systemTime} a short time as main words it in a notice, in the system's format.
 */
function source(text: string, lang: Lang = 'en'): string {
  return text.split(/(\{time\}|\{systemTime\}|\{clock\}|\{minutes\})/).map((part) => {
    if (part === '{time}') return '\\d\\d:\\d\\d';
    if (part === '{systemTime}') return '\\d{1,2}\\S\\d\\d(?:\\s\\S+)?';
    if (part === '{clock}') return `\\d\\d:\\d\\d\\s*${SPOKEN[lang]}`;
    if (part === '{minutes}') return SPOKEN[lang];
    return rx(part);
  }).join('');
}

// toHaveText keeps an element's surrounding white space when it matches a pattern
const whole = (inner: string): RegExp => new RegExp(`^\\s*${inner}\\s*$`);
/** `text` (see source) as the whole of an element's text. */
const pattern = (text: string, lang: Lang = 'en'): RegExp => whole(source(text, lang));
const SHORT_TIME = whole('\\d\\d:\\d\\d');

const plural = (count: number, one: string, other: string): string => (count === 1 ? one : other);

// The design's copy (shared/proto.js COPY.en and COPY.el) for host prod-1, an old server `from` and this app `to`.
const COPY = {
  en: {
    whenIdle: 'Switch when they finish', now: 'Switch now', cancel: 'Cancel', showHost: 'Show host', dismiss: 'Dismiss notification', close: 'Close',
    checkUpdates: 'Check for updates', notConnected: 'Not connected', closesTag: 'Closes on switch',
    open: /^Open \S/, kill: /^Kill \S/,
    offer: (agents: number, from: string, to: string) => `${HOST} is running ${plural(agents, '1 agent', `${agents} agents`)} on Damocles ${from}. Damocles ${to} is ready.`,
    waiting: (agents: number, to: string) => `${HOST} switches to Damocles ${to} when ${plural(agents, '1 agent finishes', `${agents} agents finish`)}.`,
    waitingDrain: (to: string) => `${HOST} switches to Damocles ${to} at {time}. 1 other device reconnects then.`,
    required: (to: string) => `${HOST} must switch to Damocles ${to} by {time}, in 3 h. 1 agent is still running.`,
    countdown: (to: string) => `${HOST} switches to Damocles ${to} in {clock}. 1 agent will stop.`,
    switching: (to: string) => `Switching ${HOST} to Damocles ${to}.`,
    terminalCloses: ' Its terminal closes when it switches.',
    outdated: (server: string) => `${HOST} runs Damocles ${server}. Update this app to use it.`,
    outdatedFloor: (floor: string) => `${HOST} needs Damocles ${floor} or later. Update this app to use it.`,
    leadOffer: (from: string, to: string) => `Damocles ${to} is ready. This host runs ${from}.`,
    leadWaiting: (to: string) => `Switches to Damocles ${to} when it is free.`,
    leadDrain: (to: string) => `Switches to Damocles ${to} at {time}.`,
    leadRequired: (to: string) => `Must switch to Damocles ${to} by {time}, in 3 h.`,
    leadCountdown: (to: string) => `Switches to Damocles ${to} in {clock}.`,
    leadOutdated: (server: string) => `This host runs Damocles ${server}. Update this app to use it.`,
    leadFloor: (floor: string) => `This host needs Damocles ${floor} or later. Update this app to use it.`,
    agentsRunning: (agents: number) => plural(agents, '1 agent running', `${agents} agents running`),
    agentStops: '1 agent will stop',
    devicesAfter: '1 other device reconnects after the switch',
    devicesAt: '1 other device reconnects at {time}',
    terminalClosesRow: '1 terminal closes on the switch',
    survive: 'Terminals keep running',
    outdatedSub: (app: string) => `This computer runs ${app}. Damocles never moves a server back to an older version.`,
    floorSub: (app: string, floor: string) => `This app is ${app}. A required update set ${floor} as the minimum on ${HOST}.`,
    inUse: (from: string) => `This host runs Damocles ${from} because 1 other device uses it.`,
    dialogTitle: (to: string) => `Switch ${HOST} to Damocles ${to} now?`,
    dialogAgents: (agents: number) => (agents === 0 ? 'No agent is running.' : plural(agents,
      'This agent stops now. Its chat keeps the transcript, and you can continue it after the switch.',
      `These ${agents} agents stop now. Their chats keep the transcript, and you can continue them after the switch.`)),
    dialogSurvive: 'Terminals keep running.',
    dialogCloses: 'This terminal closes, and what runs in it stops.',
    dialogDevices: (to: string) => `1 other device connected to ${HOST} disconnects, then reconnects to Damocles ${to}.`,
    agentLine: /^Agent: \S/, terminalLine: /^Terminal: \S/,
    reminderTitle: (from: string) => `${HOST} still runs Damocles ${from}`,
    reminderAgents: (to: string) => `Damocles ${to} waits for 1 agent to finish.`,
    reminderDrain: (to: string) => `It switches to Damocles ${to} at {systemTime}. 1 other device reconnects then.`,
    reminderRequired: (to: string) => `It must switch to Damocles ${to} by {systemTime}, in 3 h. 1 agent is running and stops then.`,
    reminderTerminal: ' Its terminal closes too.',
    countdownTitle: `${HOST} switches in`,
    countdownMessage: (to: string) => `Damocles ${to} is required. 1 agent stops then; its chat is kept.`,
    doneTitle: (to: string) => `${HOST} now runs Damocles ${to}`,
    forced: 'The required update ran at {systemTime}.',
    stopped: (agents: number) => plural(agents, '1 agent stopped; its chat is kept.', `${agents} agents stopped; their chats are kept.`),
    terminalClosed: '1 terminal closed.',
    pending: 'update pending', badgeRequired: 'update required by {time}', badgeCountdown: 'switches in {minutes}',
    badgeSwitching: (to: string) => `switching to Damocles ${to}`, badgeOutdated: 'update this app',
    tagMinutes: whole('(?:\\d+ min|< 1 min)'),
    floorTooltip: (floor: string) => `Needs Damocles ${floor} or later. Update this app to use it.`,
    mirrorTitle: `${HOST} runs a newer Damocles`, mirrorTitleFloor: `${HOST} needs a newer Damocles`,
    mirrorNote: 'This chat is read-only until this app updates. Its transcript is the copy this computer keeps.',
  },
  el: {
    whenIdle: 'Μετάβαση όταν ολοκληρωθούν', now: 'Μετάβαση τώρα', cancel: 'Ακύρωση', showHost: 'Εμφάνιση υπολογιστή', dismiss: 'Απόρριψη ειδοποίησης', close: 'Κλείσιμο',
    checkUpdates: 'Έλεγχος για ενημερώσεις', notConnected: 'Χωρίς σύνδεση', closesTag: 'Κλείνει με τη μετάβαση',
    open: /^Άνοιγμα του \S/, kill: /^Τερματισμός του \S/,
    offer: (agents: number, from: string, to: string) => `${plural(agents, `Στο ${HOST} τρέχει 1 agent`, `Στο ${HOST} τρέχουν ${agents} agents`)} στο Damocles ${from}. Το Damocles ${to} είναι έτοιμο.`,
    waiting: (agents: number, to: string) => `Το ${HOST} μεταβαίνει στο Damocles ${to} όταν ${plural(agents, 'ολοκληρωθεί 1 agent', `ολοκληρωθούν ${agents} agents`)}.`,
    waitingDrain: (to: string) => `Το ${HOST} μεταβαίνει στο Damocles ${to} στις {time}. Τότε επανασυνδέεται 1 ακόμη συσκευή.`,
    required: (to: string) => `Το ${HOST} πρέπει να μεταβεί στο Damocles ${to} έως τις {time}, σε 3 ώρες. Τρέχει ακόμη 1 agent.`,
    countdown: (to: string) => `Το ${HOST} μεταβαίνει στο Damocles ${to} σε {clock}. Θα σταματήσει 1 agent.`,
    switching: (to: string) => `Μετάβαση του ${HOST} στο Damocles ${to}.`,
    terminalCloses: ' Το τερματικό του κλείνει με τη μετάβαση.',
    outdated: (server: string) => `Το ${HOST} τρέχει Damocles ${server}. Ενημερώστε αυτή την εφαρμογή για να το χρησιμοποιήσετε.`,
    outdatedFloor: (floor: string) => `Το ${HOST} χρειάζεται Damocles ${floor} ή νεότερο. Ενημερώστε αυτή την εφαρμογή για να το χρησιμοποιήσετε.`,
    leadOffer: (from: string, to: string) => `Το Damocles ${to} είναι έτοιμο. Αυτός ο απομακρυσμένος υπολογιστής τρέχει ${from}.`,
    leadWaiting: (to: string) => `Μεταβαίνει στο Damocles ${to} όταν ελευθερωθεί.`,
    leadDrain: (to: string) => `Μεταβαίνει στο Damocles ${to} στις {time}.`,
    leadRequired: (to: string) => `Πρέπει να μεταβεί στο Damocles ${to} έως τις {time}, σε 3 ώρες.`,
    leadCountdown: (to: string) => `Μεταβαίνει στο Damocles ${to} σε {clock}.`,
    leadOutdated: (server: string) => `Αυτός ο απομακρυσμένος υπολογιστής τρέχει Damocles ${server}. Ενημερώστε αυτή την εφαρμογή για να τον χρησιμοποιήσετε.`,
    leadFloor: (floor: string) => `Αυτός ο απομακρυσμένος υπολογιστής χρειάζεται Damocles ${floor} ή νεότερο. Ενημερώστε αυτή την εφαρμογή για να τον χρησιμοποιήσετε.`,
    agentsRunning: (agents: number) => plural(agents, 'Τρέχει 1 agent', `Τρέχουν ${agents} agents`),
    agentStops: 'Θα σταματήσει 1 agent',
    devicesAfter: '1 ακόμη συσκευή επανασυνδέεται μετά τη μετάβαση',
    devicesAt: '1 ακόμη συσκευή επανασυνδέεται στις {time}',
    terminalClosesRow: '1 τερματικό κλείνει με τη μετάβαση',
    survive: 'Τα τερματικά συνεχίζουν να τρέχουν',
    outdatedSub: (app: string) => `Αυτός ο υπολογιστής τρέχει ${app}. Το Damocles δεν επαναφέρει ποτέ έναν διακομιστή σε παλαιότερη έκδοση.`,
    floorSub: (app: string, floor: string) => `Αυτή η εφαρμογή είναι η έκδοση ${app}. Μια υποχρεωτική ενημέρωση όρισε την ${floor} ως ελάχιστη έκδοση στο ${HOST}.`,
    inUse: (from: string) => `Αυτός ο απομακρυσμένος υπολογιστής τρέχει Damocles ${from} γιατί τον χρησιμοποιεί 1 ακόμη συσκευή.`,
    dialogTitle: (to: string) => `Μετάβαση του ${HOST} στο Damocles ${to} τώρα;`,
    dialogAgents: (agents: number) => (agents === 0 ? 'Δεν τρέχει κανένας agent.' : plural(agents,
      'Αυτός ο agent σταματά τώρα. Η συνομιλία του κρατά το ιστορικό και μπορείτε να τη συνεχίσετε μετά τη μετάβαση.',
      `Αυτοί οι ${agents} agents σταματούν τώρα. Οι συνομιλίες τους κρατούν το ιστορικό και μπορείτε να τις συνεχίσετε μετά τη μετάβαση.`)),
    dialogSurvive: 'Τα τερματικά συνεχίζουν να τρέχουν.',
    dialogCloses: 'Αυτό το τερματικό κλείνει και ό,τι τρέχει σε αυτό σταματά.',
    dialogDevices: (to: string) => `1 ακόμη συσκευή συνδεδεμένη στο ${HOST} θα αποσυνδεθεί και θα επανασυνδεθεί στο Damocles ${to}.`,
    agentLine: /^Agent: \S/, terminalLine: /^Τερματικό: \S/,
    reminderTitle: (from: string) => `Το ${HOST} τρέχει ακόμη Damocles ${from}`,
    reminderAgents: (to: string) => `Το Damocles ${to} περιμένει να ολοκληρωθεί 1 agent.`,
    reminderDrain: (to: string) => `Μεταβαίνει στο Damocles ${to} στις {systemTime}. Τότε επανασυνδέεται 1 ακόμη συσκευή.`,
    reminderRequired: (to: string) => `Πρέπει να μεταβεί στο Damocles ${to} έως τις {systemTime}, σε 3 ώρες. Τρέχει 1 agent, που θα σταματήσει τότε.`,
    reminderTerminal: ' Κλείνει και το τερματικό του.',
    countdownTitle: `Το ${HOST} μεταβαίνει σε`,
    countdownMessage: (to: string) => `Το Damocles ${to} είναι υποχρεωτικό. Τότε σταματά 1 agent. Η συνομιλία του κρατιέται.`,
    doneTitle: (to: string) => `Το ${HOST} τρέχει πλέον Damocles ${to}`,
    forced: 'Η υποχρεωτική ενημέρωση έγινε στις {systemTime}.',
    stopped: (agents: number) => plural(agents, 'Σταμάτησε 1 agent. Η συνομιλία του κρατήθηκε.', `Σταμάτησαν ${agents} agents. Οι συνομιλίες τους κρατήθηκαν.`),
    terminalClosed: 'Έκλεισε 1 τερματικό.',
    pending: 'εκκρεμεί ενημέρωση', badgeRequired: 'απαιτείται ενημέρωση έως τις {time}', badgeCountdown: 'μεταβαίνει σε {minutes}',
    badgeSwitching: (to: string) => `μετάβαση στο Damocles ${to}`, badgeOutdated: 'ενημερώστε αυτή την εφαρμογή',
    tagMinutes: whole('(?:\\d+ λεπ\\.|< 1 λεπ\\.)'),
    floorTooltip: (floor: string) => `Χρειάζεται Damocles ${floor} ή νεότερο. Ενημερώστε αυτή την εφαρμογή για να το χρησιμοποιήσετε.`,
    mirrorTitle: `Το ${HOST} τρέχει νεότερο Damocles`, mirrorTitleFloor: `Το ${HOST} χρειάζεται νεότερο Damocles`,
    mirrorNote: 'Αυτή η συνομιλία είναι μόνο για ανάγνωση μέχρι να ενημερωθεί αυτή η εφαρμογή. Η καταγραφή της είναι το αντίγραφο που κρατά αυτός ο υπολογιστής.',
  },
};
type Copy = (typeof COPY)[Lang];
// What the app shows: the design's copy but for two Greek labels, which keep the app's one wording of Cancel and Show host.
const SHOWN: Record<Lang, Copy> = { en: COPY.en, el: { ...COPY.el, cancel: 'Άκυρο', showHost: 'Εμφάνιση απομακρυσμένου υπολογιστή' } };

// The connected host's own name, which the update phrase follows after a comma. The design's Greek sample keeps "ms".
const CONNECTED_NAME: Record<Lang, string> = { en: `${rx(HOST)} · \\d+ ms`, el: `${rx(HOST)} · \\d+ (?:ms|χλστ\\.)` };
/** The badge's accessible name: any state of the host's own name, then `phrase` after a comma. */
const badgeName = (phrase: string, lang: Lang = 'en', own = `${rx(HOST)}\\b.*`): RegExp => new RegExp(`^${own}, ${source(phrase, lang)}$`);
const connectedBadge = (phrase: string, lang: Lang = 'en'): RegExp => badgeName(phrase, lang, CONNECTED_NAME[lang]);

interface Launcher {
  readonly home: HermeticHome;
  readonly launch: (options?: LaunchOptions) => Promise<DesktopApp>;
  readonly mirror: ReleaseMirror;
  readonly ssh: SshClientHome;
}

async function connect(app: ElectronApplication): Promise<{ hostId: string; key: string }> {
  const hostId = await addHost(app, { alias: HOST, name: HOST });
  const key = await openRemoteFolder(app, hostId, APP);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  return { hostId, key };
}

async function hostIdOf(app: ElectronApplication): Promise<string> {
  const hosts = await app.evaluate(() => (globalThis as unknown as { __damoclesE2e: { remote: { hosts(): Array<{ hostId: string }> } } }).__damoclesE2e.remote.hosts());
  expect(hosts).toHaveLength(1);
  return hosts[0]!.hostId;
}

/**
 * The chat page the window shows that satisfies `shows`. A launch can load one chat in two pages, the restored one and the one
 * the mirror's sync opens, and main shows one of them in a view while the other's is empty, so the page must hold the view
 * for three polls running. A rejoin may also reload a page while it is looked at, which fails only that attempt: toPass retries
 * it and reports the last error if none passes.
 */
async function shownPage(app: ElectronApplication, shows: (page: Page) => Promise<boolean>): Promise<Page> {
  let found: Page | undefined;
  let steady = 0;
  await expect(async () => {
    const before = found;
    found = undefined;
    for (const page of app.windows().filter((candidate) => !candidate.isClosed() && candidate.url().includes('/panel/'))) {
      // a page a rejoin closes while it is looked at shows nothing
      const shown = await page.evaluate(() => window.innerWidth > 0 && document.visibilityState === 'visible').then((laidOut) => laidOut && shows(page)).catch((error: unknown) => {
        if (page.isClosed()) return false;
        throw error;
      });
      if (shown) found = page;
    }
    steady = found !== undefined && found === before ? steady + 1 : 0;
    expect(steady, 'polls running that showed the same page').toBeGreaterThanOrEqual(2);
  }).toPass({ timeout: 60_000, intervals: [500] });
  return found!;
}

/** The shown chat page with `text` in it. */
const shownChat = (app: ElectronApplication, text: string): Promise<Page> => shownPage(app, (page) => page.getByText(text, { exact: false }).first().isVisible());

const hostUpdateOf = async (app: ElectronApplication, hostId: string): Promise<HostUpdate | undefined> => (await shellState(app)).hosts.find((host) => host.hostId === hostId)?.update;

/** Opens the chat titled `title` from the APP project's Chats list, as a user does; resolves with its page showing `showing`. */
async function openListedChat(app: ElectronApplication, title: string, showing: string): Promise<Page> {
  let projectKey = '';
  await expect.poll(async () => (projectKey = (await shellState(app)).projects.find((project) => project.fsPath === APP)?.key ?? '')).not.toBe('');
  let chatId = '';
  await expect.poll(async () => (chatId = (await listChats(app, projectKey)).chats.find((chat) => chat.title === title)?.id ?? ''), { timeout: 60_000 }).not.toBe('');
  expect(await (await shellPage(app)).evaluate((id) => window.damoclesShell!.selectChat(id), chatId)).toEqual({ ok: true });
  return shownChat(app, showing);
}

/** A terminal on the target whose process is TERMINAL_SLEEP. */
async function sleepingTerminal(app: ElectronApplication, fixture: Pick<SshdFixture, 'sh'>): Promise<void> {
  const shell = await openTerminal(app);
  await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'running');
  await runInTerminal(shell, `exec ${TERMINAL_SLEEP}`);
  await expect.poll(async () => (await fixture.sh(`pgrep -u dev -f '^${TERMINAL_SLEEP}$' || true`)).trim(), { timeout: 30_000 }).toMatch(/^\d+$/);
}

/** Quits with Keep running, whatever the display language. */
async function quitKeepRunning(desktop: DesktopApp): Promise<void> {
  await requestQuit(desktop.app);
  await (await overlayPage(desktop.app)).getByTestId('close-remote-keep').click({ timeout: 60_000 });
  await exited(desktop);
}

const firstReply = (title: string): string => `Working on ${title}.`;

interface BusyServer {
  readonly stub: OpenAIStub;
  readonly env: Record<string, string>;
  /** Lets every held reply end, which a switch that stopped its agent leaves waiting in the stub. */
  release(): void;
}

/**
 * The host as an update finds it: `server` installed and running as the older app left it, with `agents` chats mid-turn
 * (titled AGENTS) and, with `terminal`, one terminal. The older app has quit with Keep running.
 */
async function busyOlderServer({ home, launch, mirror, ssh }: Launcher, fixture: SshdFixture, server: OlderServerOptions, options: { agents: number; terminal: boolean; protocol?: number }): Promise<BusyServer> {
  await installOlderServer(fixture, CURRENT_PACKAGE, server);
  const stub = await startTargetStub(home, fixture);
  const env = remoteEnv(ssh, mirror);
  const releases: Array<() => void> = [];
  try {
    const old = await launch({ env: { ...env, DAMOCLES_E2E_APP_VERSION: server.version ?? OLD, ...(options.protocol !== undefined ? { DAMOCLES_E2E_PROTOCOL_VERSION: String(options.protocol) } : {}) } });
    const { key } = await connect(old.app);
    if (options.terminal) await sleepingTerminal(old.app, fixture);
    for (const title of AGENTS.slice(0, options.agents)) {
      stub.replies.push({ chunks: [firstReply(title), ' Finished.'], holdAfterFirst: new Promise<void>((resolve) => releases.push(resolve)) });
      const tab = await newRemoteChat(old.app, key);
      await sendPrompt(tab, title);
      await expect(tab.getByText(firstReply(title), { exact: false })).toBeVisible({ timeout: 60_000 });
    }
    if (options.agents > 0 || options.terminal) await quitKeepRunning(old);
    else await old.close();
  } catch (error) {
    for (const release of releases) release();
    await stub.close();
    throw error;
  }
  return { stub, env, release: () => releases.forEach((release) => release()) };
}

/** Launches this app in `lang` at the design's widest checked window, recording its toasts from the start. */
async function launchIn(launcher: Launcher, lang: Lang, env: Record<string, string>): Promise<DesktopApp> {
  writeUserSettings(launcher.home, { 'damocles.desktop.language': lang });
  const desktop = await launcher.launch({ env });
  await recordToasts(desktop.app);
  await setContentSize(desktop.app, WINDOW.width, WINDOW.height);
  return desktop;
}

/**
 * Runs `run` with `page` laid out `width` CSS px wide. The window's minimum width is 900 px (MIN_WINDOW_WIDTH), so a design
 * width below it is applied to the surface the design draws at that width, not to the window.
 */
async function atWidth<T>(page: Page, width: number, run: () => Promise<T>): Promise<T> {
  const real = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const cdp = await page.context().newCDPSession(page);
  try {
    // the popup window is only as tall as its toasts, which wrap taller in a narrower page
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: Math.max(real.height, MIN_PAGE_HEIGHT), deviceScaleFactor: 1, mobile: false });
    await page.waitForFunction((expected) => window.innerWidth === expected, width);
    return await run();
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await page.waitForFunction((expected) => window.innerWidth === expected, real.width);
    await cdp.detach();
  }
}

/** Runs `check` on `page` at each width the design's journeys replay at. */
async function atJourneyWidths(page: Page, check: (width: number) => Promise<void>): Promise<void> {
  for (const width of JOURNEY_WIDTHS) await atWidth(page, width, () => check(width));
}

/**
 * When review captures are asked for, saves `update-ui/<name>-<width>.png` of `page` (or `target` on it) under REMOTE_SHOTS at
 * each of the design's checked widths, for comparison with the design's screens by eye, and attaches each.
 */
async function screens(testInfo: TestInfo, page: Page, name: string, target?: () => Locator): Promise<void> {
  if (REMOTE_SHOTS === undefined) return;
  if (!outsideRepository(REMOTE_SHOTS)) throw new Error(`DAMOCLES_REMOTE_SHOTS must name an absolute folder outside the repository, not ${REMOTE_SHOTS}`);
  const folder = path.join(REMOTE_SHOTS, 'update-ui');
  fs.mkdirSync(folder, { recursive: true });
  for (const width of CHECKED_WIDTHS) {
    await atWidth(page, width, async () => {
      await settled(page);
      const file = path.join(folder, `${name}-${width}.png`);
      await (target?.() ?? page).screenshot({ path: file, animations: 'disabled' });
      await testInfo.attach(`${name}-${width}`, { path: file, contentType: 'image/png' });
    });
  }
}

const stripOf = (page: Page): Locator => page.getByTestId('host-update-banner');

/** The shown chat page with the update strip; a reconnect may have replaced the page a test held. */
const stripPage = (app: ElectronApplication): Promise<Page> => shownPage(app, (page) => stripOf(page).isVisible());

interface StripState {
  readonly state: string;
  readonly tone: 'info' | 'warning' | 'danger';
  readonly text: string | RegExp;
  /** The accessible names of its buttons, in order. */
  readonly actions: readonly string[];
}

/** The update strip reads `expected` in its status region and offers exactly its actions. */
async function expectStrip(page: Page, expected: StripState, timeout = 60_000): Promise<Locator> {
  const strip = stripOf(page);
  await expect(strip.getByRole('status')).toHaveText(expected.text, { timeout });
  await expect(strip).toHaveAttribute('data-state', expected.state);
  await expect(strip).toHaveAttribute('data-tone', expected.tone);
  await expect(strip.getByRole('button')).toHaveText([...expected.actions]);
  for (const name of expected.actions) await expect(strip.getByRole('button', { name, exact: true })).toBeVisible();
  return strip;
}

/** Whether the strip's actions sit under its sentence, as under 24rem of strip width, or beside it. */
const actionsStacked = (strip: Locator): Promise<boolean> => strip.evaluate((node) => {
  const text = node.querySelector('[data-testid="host-update-banner-text"]')!.getBoundingClientRect();
  const action = node.querySelector('button')!.getBoundingClientRect();
  return action.top >= text.bottom - 1;
});

/** The strip as S1 draws it: the same sentence and actions at both journey widths, its actions stacked in a 20rem chat pane. */
async function expectStripAtWidths(page: Page, expected: StripState): Promise<void> {
  await atJourneyWidths(page, async (width) => {
    const strip = await expectStrip(page, expected);
    const box = (await strip.boundingBox())!;
    expect(box.x + box.width, `the strip fits ${width} px`).toBeLessThanOrEqual(width + 0.5);
    if (expected.actions.length > 0 && width === 1280) expect(await actionsStacked(strip)).toBe(false);
  });
  if (expected.actions.length === 0) return;
  const narrow = await page.evaluate(() => Math.round(parseFloat(getComputedStyle(document.documentElement).fontSize) * 20));
  await atWidth(page, narrow, async () => expect(await actionsStacked(await expectStrip(page, expected))).toBe(true));
}

const chipOf = (shell: Page): Locator => titleBar(shell).getByTestId('title-bar-host');

interface BadgeState {
  readonly badge: 'pending' | 'required' | 'countdown' | 'switching' | 'appOutdated';
  readonly pip: 'circle' | 'triangle' | 'square' | 'ring' | 'diamond';
  readonly name: RegExp;
  /** The tag beside the name; none when absent. */
  readonly tag?: RegExp;
}

/** The title bar chip is a button named `name` whose dot carries the state's pip, which is decorative and never animates. */
async function expectBadge(shell: Page, expected: BadgeState, timeout = 30_000): Promise<Locator> {
  const chip = chipOf(shell);
  await expect(chip).toHaveAccessibleName(expected.name, { timeout });
  await expect(shell.getByRole('button', { name: expected.name })).toBeVisible();
  await expect(chip.getByTestId('host-status-dot')).toHaveAttribute('data-update', expected.badge);
  const pip = chip.getByTestId('host-update-pip');
  await expect(pip).toHaveAttribute('data-pip', expected.pip);
  await expect(pip).toHaveAttribute('aria-hidden', 'true');
  // its entrance may still be running; an animation that never ends fails here
  await expect.poll(() => pip.evaluate((node) => node.getAnimations({ subtree: true }).length), { timeout: 5_000 }).toBe(0);
  const tag = chip.getByTestId('host-update-tag');
  if (expected.tag === undefined) await expect(tag).toHaveCount(0);
  else {
    await expect(tag).toHaveText(expected.tag);
    await expect(tag).toHaveAttribute('aria-hidden', 'true');
  }
  return chip;
}

/** The sidebar's group header of the host in the grouped Projects view. */
async function groupHeaderOf(shell: Page): Promise<Locator> {
  await shell.evaluate(() => window.damoclesShell!.setProjectsView('grouped'));
  const header = shell.getByTestId('project-group-header').filter({ hasText: HOST });
  await expect(header).toHaveCount(1);
  return header;
}

interface Card {
  readonly overlay: Page;
  readonly dialog: Locator;
  readonly card: Locator;
  readonly update: Locator;
}

const cardIn = (overlay: Page): Card => {
  const card = overlay.getByTestId('host-card');
  // the design names the dialog by the host; the app's name holds the host's name
  return { overlay, dialog: overlay.getByRole('dialog', { name: HOST }), card, update: card.getByTestId('host-update') };
};

/** Opens the host's card as the centered dialog, from File > Connect to Host... and the host's Details. */
async function openCard(app: ElectronApplication): Promise<Card> {
  const overlay = await overlayPage(app);
  await clickMenu(app, CONNECT_TO_HOST_MENU);
  await overlay.getByTestId('connect-dialog').getByTestId('host-details').click();
  const opened = cardIn(overlay);
  await expect(opened.card).toBeVisible();
  await expect(opened.dialog).toBeVisible();
  return opened;
}

async function closeCard({ overlay, card }: Card): Promise<void> {
  await card.getByTestId('host-card-close').click();
  await expect(overlay.getByTestId('connect-dialog')).toHaveCount(0);
}

interface UpdateSection {
  readonly state: string;
  readonly tone: 'info' | 'warning' | 'danger';
  readonly lead: string | RegExp;
  /** The rows under the lead: what the switch waits for and what it stops, in order. */
  readonly blockers: ReadonlyArray<string | RegExp>;
  readonly actions: readonly string[];
}

/** The card's Update section reads `expected`: its lead in a status region, its blockers and exactly its actions. */
async function expectUpdateSection({ update }: Card, expected: UpdateSection): Promise<void> {
  await expect(update.getByRole('status')).toHaveText(expected.lead, { timeout: 30_000 });
  await expect(update).toHaveAttribute('data-state', expected.state);
  await expect(update).toHaveAttribute('data-tone', expected.tone);
  await expect(update.locator('[data-blocker]')).toHaveText([...expected.blockers]);
  await expect(update.getByRole('button')).toHaveText([...expected.actions]);
}

interface Confirmation {
  /** The detail sentences, joined by a space. */
  readonly detail: string;
  /** The preview's lines, in order. */
  readonly preview: readonly RegExp[];
}

/** The Switch now question is an alertdialog named by its title, with Cancel focused first and the keyboard kept inside. */
async function expectConfirm(overlay: Page, c: Copy, to: string, expected: Confirmation): Promise<Locator> {
  const confirm = overlay.getByRole('alertdialog', { name: c.dialogTitle(to) });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(expected.detail);
  await expect(confirm.getByTestId('overlay-message-preview').locator('> div')).toHaveText([...expected.preview]);
  const cancel = confirm.getByRole('button', { name: c.cancel, exact: true });
  await expect(cancel).toBeFocused();
  await expect(confirm.getByRole('button', { name: c.now, exact: true })).toBeVisible();
  for (let presses = 0; presses < 3; presses++) {
    await overlay.keyboard.press('Tab');
    await expect(confirm.locator(':focus')).toHaveCount(1);
  }
  await cancel.focus();
  return confirm;
}

type NoticeBody = Extract<OverlayToast['body'], { kind: 'notice' | 'hostUpdate' }>;
interface ShownToast {
  readonly toast: OverlayToast;
  readonly body: NoticeBody;
  readonly popup: Page;
  readonly card: Locator;
}

/**
 * The newest popup toast about the host titled `title`, once its card shows. Keyboard focus on the card holds its life, so it
 * stays while it is read.
 */
async function shownToast(app: ElectronApplication, title: string, options: { timeout?: number; after?: readonly string[] } = {}): Promise<ShownToast> {
  let found: OverlayToast | undefined;
  await expect.poll(async () => (found = (await recordedPopupToasts(app))
    .filter((toast) => (toast.body.kind === 'notice' || toast.body.kind === 'hostUpdate') && toast.body.title === title && !(options.after ?? []).includes(toast.id)).at(-1)), { timeout: options.timeout ?? 60_000 }).toBeDefined();
  const toast = found!;
  const popup = await popupPage(app, 10_000);
  const card = popup.locator(`[data-testid="overlay-toast"][data-toast-id="${toast.id}"]`);
  await expect(card).toBeVisible();
  if (!toast.sticky) {
    await card.getByRole('button').first().focus();
    await expect.poll(() => heldToasts(app)).toContain(toast.id);
  }
  return { toast, body: toast.body as NoticeBody, popup, card };
}

/** The toast's card at both journey widths: its title, message and exactly its actions, with Dismiss notification. */
async function expectToastCard({ popup, card }: ShownToast, c: Copy, expected: { title: string | RegExp; message: string | RegExp; actions: readonly string[] }): Promise<void> {
  await atJourneyWidths(popup, async () => {
    await expect(card.getByTestId('overlay-toast-title')).toHaveText(expected.title);
    await expect(card.getByTestId('overlay-toast-message')).toHaveText(expected.message);
    await expect(card.getByRole('button')).toHaveCount(expected.actions.length + 1);
    await expect(card.getByRole('button', { name: c.dismiss, exact: true })).toBeVisible();
    for (const name of expected.actions) await expect(card.getByRole('button', { name, exact: true })).toBeVisible();
  });
}

/** Dismisses the toast; the notification center keeps its entry. */
async function dismissKept(app: ElectronApplication, { popup, card }: ShownToast, c: Copy, title: string): Promise<void> {
  await card.getByRole('button', { name: c.dismiss, exact: true }).click();
  await expect(card).toHaveCount(0);
  await popup.mouse.move(0, 0);
  const shell = await shellPage(app);
  await shell.getByTestId('notification-bell').click();
  const overlay = await overlayPage(app);
  const center = overlay.getByTestId('notification-center');
  await expect(center.getByTestId('notification-row').filter({ hasText: title })).toHaveCount(1);
  await overlay.keyboard.press('Escape');
  await expect(center).toHaveCount(0);
}

/** Records every distinct value `selector`'s elements show on `page` from now on (their text, or `attribute`), under `key`. */
async function watch(page: Page, key: string, selector: string, attribute?: string): Promise<void> {
  await page.evaluate(([name, query, attr]) => {
    const g = window as unknown as { __e2eSeen?: Record<string, string[]> };
    g.__e2eSeen ??= {};
    if (g.__e2eSeen[name]) return;
    const seen: string[] = [];
    g.__e2eSeen[name] = seen;
    const look = (): void => {
      for (const node of document.querySelectorAll(query)) {
        const value = ((attr === null ? node.textContent : node.getAttribute(attr)) ?? '').replace(/\s+/g, ' ').trim();
        if (seen.at(-1) !== value) seen.push(value);
      }
    };
    look();
    new MutationObserver(look).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  }, [key, selector, attribute ?? null] as const);
}

const watched = (page: Page, key: string): Promise<string[]> => page.evaluate((name) => (window as unknown as { __e2eSeen?: Record<string, string[]> }).__e2eSeen?.[name] ?? [], key);

const STRIP_TEXT = '[data-testid="host-update-banner-text"]';
const CHIP_DOT = '[data-testid="title-bar-host"] [data-testid="host-status-dot"]';
const CHIP_PIP = '[data-testid="title-bar-host"] [data-testid="host-update-pip"]';

/** Resolves once the host runs this app's server and nothing is pending for it; `sentWithin` is how long until the switch is sent. */
async function switched(app: ElectronApplication, hostId: string, fixture: Pick<SshdFixture, 'userProcesses'>, sentWithin = 0): Promise<void> {
  await expect.poll(() => daemonVersions(fixture), { timeout: sentWithin + 120_000 }).toEqual([serverVersionOf(LINUX_TARGET)]);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  await expect.poll(() => hostUpdateOf(app, hostId), { timeout: 60_000 }).toBeUndefined();
}

/** Lets the busy server's agents finish, so the switch the app asked for when it connected runs, then ends this version's daemon. */
async function switchOnceIdle(app: ElectronApplication, hostId: string, fixture: SshdFixture, busy: BusyServer): Promise<void> {
  busy.release();
  await switched(app, hostId, fixture);
  await shutdownHostDaemon(app, hostId, fixture);
}

/** Drops the host's connection, so the next one finds the switch still pending, which is when a waiting switch reminds. */
async function reconnectPending(app: ElectronApplication, hostId: string): Promise<void> {
  const before = (await lastConnectStep(app, hostId))?.attemptId;
  await dropConnection(app, hostId);
  await expect.poll(async () => {
    const step = await lastConnectStep(app, hostId);
    return step !== undefined && step.attemptId !== before && step.step === 'connected' && (await hostUpdateOf(app, hostId))?.phase === 'waiting';
  }, { timeout: 120_000 }).toBe(true);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
}

test.beforeEach(({ home }) => {
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': 'bash', 'damocles.desktop.terminal.confirmOnKill': 'never' });
});

test('S1 S2 S3 S4 S5, the offer of a busy daemon of another protocol: the strip, the badge and the card offer both switches in English and Greek; Switch when they finish hands focus to Switch now; Cancel keeps the state; Switch now shows switching and then what it stopped', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }, testInfo) => {
  test.setTimeout(600_000);
  const launcher = { home, launch, mirror, ssh };
  const fixture = await sshd(HOST);
  const busy = await busyOlderServer(launcher, fixture, { version: OLD, protocolVersion: OTHER_PROTOCOL }, { agents: 2, terminal: true, protocol: OTHER_PROTOCOL });
  const to = APP_VERSION;
  try {
    // Greek: the offer on every surface, and the confirmation of two agents, cancelled
    {
      const c = SHOWN.el;
      const greek = await launchIn(launcher, 'el', busy.env);
      const page = await openListedChat(greek.app, AGENTS[1], AGENTS[1]);
      await expectStrip(page, { state: 'offer', tone: 'info', text: c.offer(2, OLD, to), actions: [c.whenIdle, c.now] });
      await expectBadge(await shellPage(greek.app), { badge: 'pending', pip: 'circle', name: badgeName(c.pending, 'el') });
      const card = await openCard(greek.app);
      await expectUpdateSection(card, { state: 'offer', tone: 'info', lead: c.leadOffer(OLD, to), blockers: [c.agentsRunning(2), c.survive], actions: [c.whenIdle, c.now] });
      await expect(card.card.getByRole('button', { name: c.close, exact: true })).toBeVisible();
      await closeCard(card);
      await stripOf(page).getByRole('button', { name: c.now, exact: true }).click();
      const confirm = await expectConfirm(card.overlay, c, to, { detail: `${c.dialogAgents(2)} ${c.dialogSurvive}`, preview: [c.agentLine, c.agentLine] });
      await confirm.getByRole('button', { name: c.cancel, exact: true }).click();
      await expect(confirm).toHaveCount(0);
      await expectStrip(page, { state: 'offer', tone: 'info', text: c.offer(2, OLD, to), actions: [c.whenIdle, c.now] });
      await greek.close();
    }

    const c = SHOWN.en;
    // English, S2's journey: the card's Switch when they finish, then Switch now and Escape
    {
      const first = await launchIn(launcher, 'en', busy.env);
      const { app } = first;
      const page = await openListedChat(app, AGENTS[1], AGENTS[1]);
      const offer: StripState = { state: 'offer', tone: 'info', text: c.offer(2, OLD, to), actions: [c.whenIdle, c.now] };
      await expectStripAtWidths(page, offer);
      await expect(chatInput(page)).toHaveCount(0);
      await screens(testInfo, page, 'S1-banner-offer');

      // S5: the offer's pip on the chip, the project row's badge and the group header, in both themes
      const shell = await shellPage(app);
      const pending: BadgeState = { badge: 'pending', pip: 'circle', name: badgeName(c.pending) };
      await atJourneyWidths(shell, async () => void (await expectBadge(shell, pending)));
      const rowBadge = shell.getByTestId('host-badge');
      await expect(rowBadge.getByTestId('host-update-pip')).toHaveAttribute('data-pip', 'circle');
      await expect(rowBadge.getByTestId('host-update-tag')).toHaveCount(0);
      await setLook(app, 'light');
      await expect(shell.locator('body')).toHaveClass(/(^| )vscode-light( |$)/);
      await expectBadge(shell, pending);
      await screens(testInfo, shell, 'S5-host-badge-offer-light', () => titleBar(shell));
      await setLook(app, 'dark');
      await expect(shell.locator('body')).toHaveClass(/(^| )vscode-dark( |$)/);
      await screens(testInfo, shell, 'S5-host-badge-offer', () => titleBar(shell));
      const header = await groupHeaderOf(shell);
      await expect(header).toHaveAccessibleName(new RegExp(`^${rx(HOST)}, .*${rx(c.pending)}, expanded$`));
      await expect(header.getByRole('img', { name: pending.name })).toBeVisible();
      await expect(header.getByTestId('host-update-pip')).toHaveAttribute('data-pip', 'circle');
      await expect(header.getByTestId('host-update-tag')).toHaveCount(0);

      // S2 at both widths, in the centered dialog
      const offerSection: UpdateSection = { state: 'offer', tone: 'info', lead: c.leadOffer(OLD, to), blockers: [c.agentsRunning(2), c.survive], actions: [c.whenIdle, c.now] };
      const centered = await openCard(app);
      await atJourneyWidths(centered.overlay, async () => {
        await expect(centered.dialog).toBeVisible();
        await expect(centered.card.getByText(c.survive, { exact: true })).toBeVisible();
        await expectUpdateSection(centered, offerSection);
        await expect(centered.card.getByRole('button', { name: c.whenIdle, exact: true })).toBeVisible();
        await expect(centered.card.getByRole('button', { name: c.close, exact: true })).toBeVisible();
      });
      await expect(centered.card.getByRole('button', { name: c.whenIdle, exact: true })).toBeFocused();
      await screens(testInfo, centered.overlay, 'S2-host-card-offer');
      await closeCard(centered);

      // the sidebar's dot opens the card as a popover
      await header.getByTestId('project-group-host-details').click();
      const card = cardIn(await overlayPage(app));
      await expect(card.overlay.locator('[data-testid="connect-dialog"][data-popover]')).toBeVisible();
      const whenIdle = card.card.getByRole('button', { name: c.whenIdle, exact: true });
      await expect(card.card.getByText(c.survive, { exact: true })).toBeVisible();
      await whenIdle.click();
      const waitingSection: UpdateSection = { state: 'waiting', tone: 'info', lead: c.leadWaiting(to), blockers: [c.agentsRunning(2), c.survive], actions: [c.now] };
      await expectUpdateSection(card, waitingSection);
      const cardNow = card.card.getByRole('button', { name: c.now, exact: true });
      await expect(cardNow).toBeFocused();
      await expectStrip(page, { state: 'waiting', tone: 'info', text: c.waiting(2, to), actions: [c.now] });
      await cardNow.press('Enter');
      const confirmation: Confirmation = { detail: `${c.dialogAgents(2)} ${c.dialogSurvive}`, preview: [c.agentLine, c.agentLine] };
      const confirm = await expectConfirm(card.overlay, c, to, confirmation);
      await atJourneyWidths(card.overlay, async () => {
        await expect(confirm).toBeVisible();
        await expect(confirm).toContainText(confirmation.detail);
        await expect(confirm.getByRole('button', { name: c.cancel, exact: true })).toBeVisible();
        await expect(confirm.getByRole('button', { name: c.now, exact: true })).toBeVisible();
      });
      await screens(testInfo, card.overlay, 'S3-confirm-terminals-survive', () => confirm);
      await confirm.getByRole('button', { name: c.cancel, exact: true }).press('Escape');
      await expect(confirm).toBeHidden();
      await expectUpdateSection(card, waitingSection);
      await card.card.getByRole('button', { name: c.close, exact: true }).press('Escape');
      await expect(card.dialog).toBeHidden();
      await first.close();
    }

    // English, S1's journey: the strip's Switch when they finish in a 390 px pane, then Switch now through the confirmation
    const second = await launchIn(launcher, 'en', busy.env);
    const { app } = second;
    const hostId = await hostIdOf(app);
    const page = await openListedChat(app, AGENTS[1], AGENTS[1]);
    const strip = await expectStrip(page, { state: 'offer', tone: 'info', text: c.offer(2, OLD, to), actions: [c.whenIdle, c.now] });
    await atWidth(page, 390, async () => {
      await strip.getByRole('button', { name: c.whenIdle, exact: true }).click();
      await expect(page.getByText(c.waiting(2, to), { exact: true })).toBeVisible();
    });
    await expectStrip(page, { state: 'waiting', tone: 'info', text: c.waiting(2, to), actions: [c.now] });
    await expect(strip.getByRole('button', { name: c.now, exact: true })).toBeFocused();
    await screens(testInfo, page, 'S1-banner-waiting');
    const shell = await shellPage(app);
    await watch(page, 'strip', STRIP_TEXT);
    await watch(shell, 'chip', CHIP_DOT, 'aria-label');
    await strip.getByRole('button', { name: c.now, exact: true }).click();
    const overlay = await overlayPage(app);
    const confirm = await expectConfirm(overlay, c, to, { detail: `${c.dialogAgents(2)} ${c.dialogSurvive}`, preview: [c.agentLine, c.agentLine] });
    await confirm.getByRole('button', { name: c.now, exact: true }).click();
    await expect.poll(() => watched(page, 'strip'), { timeout: 60_000 }).toContain(c.switching(to));
    await expect.poll(async () => (await watched(shell, 'chip')).some((name) => badgeName(c.badgeSwitching(to)).test(name)), { timeout: 60_000 }).toBe(true);
    await switched(app, hostId, fixture);
    busy.release();

    // S4: what the chosen switch stopped, with no action; Dismiss notification leaves it in the notification center
    const done = await shownToast(app, c.doneTitle(to));
    expect(done.toast).toMatchObject({ body: { kind: 'hostUpdate', severity: 'info', message: c.stopped(2), actions: [], host: HOST } });
    await expectToastCard(done, c, { title: c.doneTitle(to), message: c.stopped(2), actions: [] });
    await screens(testInfo, done.popup, 'S4-notices-after-switch', () => done.card);
    await dismissKept(app, done, c, c.doneTitle(to));
    const resumed = await shownChat(app, firstReply(AGENTS[1]));
    await expect(chatInput(resumed)).toBeVisible({ timeout: 60_000 });
    await expect(stripOf(resumed)).toHaveCount(0);
    await expect(chipOf(shell).getByTestId('host-update-pip')).toHaveCount(0);
    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    busy.release();
    await busy.stub.close();
  }
});

test('S1 S2 S3 S4 S5, a waiting legacy daemon: the strip and the card say its terminal closes, its Running row is tagged Closes on switch, the pip sits on a slow ring, the reminder\'s Show host and Switch now work, and the switch says what it stopped and closed', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, proxied }, testInfo) => {
  test.setTimeout(600_000);
  const launcher = { home, launch, mirror, ssh };
  const target = await proxied(HOST);
  const { fixture } = target;
  const busy = await busyOlderServer(launcher, fixture, { version: OLD, withoutFeature: 'control.handOver' }, { agents: 1, terminal: true });
  const to = APP_VERSION;
  try {
    // Greek: the legacy sentence, the card's rows and tag, the badge's name, and the reminder, whose second action shows the host
    {
      const c = SHOWN.el;
      const greek = await launchIn(launcher, 'el', busy.env);
      const { app } = greek;
      const hostId = await hostIdOf(app);
      await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
      const page = await shownChat(app, firstReply(AGENTS[0]));
      await expectStrip(page, { state: 'waiting', tone: 'info', text: `${c.waiting(1, to)}${c.terminalCloses}`, actions: [c.now] });
      const shell = await shellPage(app);
      await expectBadge(shell, { badge: 'pending', pip: 'circle', name: connectedBadge(c.pending, 'el') });
      const card = await openCard(app);
      await expectUpdateSection(card, { state: 'waiting', tone: 'info', lead: c.leadWaiting(to), blockers: [c.agentsRunning(1), c.terminalClosesRow], actions: [c.now] });
      await expect(card.card.getByTestId('host-run-closes')).toHaveText([c.closesTag]);
      await expect(card.card.getByTestId('host-run').getByRole('button', { name: c.kill })).toHaveCount(1);
      await closeCard(card);

      await reconnectPending(app, hostId);
      const reminder = await shownToast(app, c.reminderTitle(OLD));
      expect(reminder.toast).toMatchObject({ body: { kind: 'hostUpdate', severity: 'info', message: `${c.reminderAgents(to)}${c.reminderTerminal}`, host: HOST } });
      expect(reminder.body.actions).toEqual([c.now, c.showHost]);
      await expect(reminder.card.getByTestId('overlay-toast-title')).toHaveText(c.reminderTitle(OLD));
      await reminder.card.getByRole('button', { name: c.showHost, exact: true }).click();
      const shown = cardIn(await overlayPage(app));
      await expect(shown.card.getByRole('button', { name: c.now, exact: true })).toBeVisible();
      await closeCard(shown);
      await quitKeepRunning(greek);
    }

    const c = SHOWN.en;
    const english = await launchIn(launcher, 'en', busy.env);
    const { app } = english;
    const hostId = await hostIdOf(app);
    await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    // shown before the link slows: a folder check the delay outlasts finds the folder Not available until the next focus
    let page = await shownChat(app, firstReply(AGENTS[0]));
    // S5: one slow measurement puts the pip on the slow ring
    target.proxy.delay(1600);
    await expect.poll(async () => (await shellState(app)).hosts.find((host) => host.hostId === hostId)?.latency?.slow, { timeout: 120_000 }).toBe(true);
    target.proxy.delay(0);
    const shell = await shellPage(app);
    const slowChip = await expectBadge(shell, { badge: 'pending', pip: 'circle', name: new RegExp(`^Slow connection to ${rx(HOST)} \\(\\d+ ms\\), ${rx(c.pending)}$`) });
    await expect(slowChip.getByTestId('host-status-dot')).toHaveAttribute('data-shape', 'slow');
    await screens(testInfo, shell, 'S5-host-badge-pending-slow-ring', () => titleBar(shell));

    const waiting: StripState = { state: 'waiting', tone: 'info', text: `${c.waiting(1, to)}${c.terminalCloses}`, actions: [c.now] };
    await expectStripAtWidths(page, waiting);
    await screens(testInfo, page, 'S1-banner-waiting-legacy');
    const header = await groupHeaderOf(shell);
    await expect(header).toHaveAccessibleName(new RegExp(`^${rx(HOST)}, .*${rx(c.pending)}, expanded$`));

    // S2: the legacy rows, and the Running list's tag and Kill
    const section: UpdateSection = { state: 'waiting', tone: 'info', lead: c.leadWaiting(to), blockers: [c.agentsRunning(1), c.terminalClosesRow], actions: [c.now] };
    const card = await openCard(app);
    await atJourneyWidths(card.overlay, async () => {
      await expectUpdateSection(card, section);
      await expect(card.card.getByTestId('host-run-closes')).toHaveText([c.closesTag]);
      await expect(card.card.getByTestId('host-run').getByRole('button', { name: c.kill })).toBeVisible();
    });
    await expect(card.card.getByRole('button', { name: c.now, exact: true })).toBeFocused();
    await screens(testInfo, card.overlay, 'S2-host-card-waiting-legacy');
    await closeCard(card);

    // S4's journey: the reminder names what the switch waits for; its Switch now asks, and Escape changes nothing (S3)
    await reconnectPending(app, hostId);
    page = await shownChat(app, firstReply(AGENTS[0]));
    const reminder = await shownToast(app, c.reminderTitle(OLD));
    expect(reminder.toast).toMatchObject({ body: { kind: 'hostUpdate', severity: 'info', host: HOST } });
    await expectToastCard(reminder, c, { title: c.reminderTitle(OLD), message: `${c.reminderAgents(to)}${c.reminderTerminal}`, actions: [c.now, c.showHost] });
    await expect(reminder.popup.getByTestId('overlay-toasts-polite')).toContainText(`${c.reminderTitle(OLD)}: ${c.reminderAgents(to)}`);
    await screens(testInfo, reminder.popup, 'S4-notices-reminder', () => reminder.card);
    await reminder.card.getByRole('button', { name: c.now, exact: true }).click();
    const overlay = await overlayPage(app);
    const closes: Confirmation = { detail: `${c.dialogAgents(1)} ${c.dialogCloses}`, preview: [c.agentLine, c.terminalLine] };
    const asked = await expectConfirm(overlay, c, to, closes);
    await atJourneyWidths(overlay, async () => {
      await expect(asked).toContainText(closes.detail);
      await expect(asked.getByTestId('overlay-message-preview').locator('> div')).toHaveText([...closes.preview]);
    });
    await screens(testInfo, overlay, 'S3-confirm-terminals-close', () => asked);
    await asked.getByRole('button', { name: c.cancel, exact: true }).press('Escape');
    await expect(asked).toBeHidden();
    await expectStrip(page, waiting);
    expect(await daemonVersions(fixture)).toEqual([OLD]);

    // S1 and S3: the strip's Switch now, confirmed; focus goes to the chat heading once the strip's action is gone
    const strip = stripOf(page);
    await watch(page, 'strip', STRIP_TEXT);
    await watch(shell, 'chip', CHIP_DOT, 'aria-label');
    await strip.getByRole('button', { name: c.now, exact: true }).click();
    const confirm = await expectConfirm(overlay, c, to, closes);
    await confirm.getByRole('button', { name: c.now, exact: true }).click();
    await expect.poll(() => watched(page, 'strip'), { timeout: 60_000 }).toContain(c.switching(to));
    await expect(page.getByTestId('chat-header-title')).toBeFocused();
    await expect.poll(async () => (await watched(shell, 'chip')).some((name) => badgeName(c.badgeSwitching(to)).test(name)), { timeout: 60_000 }).toBe(true);
    await switched(app, hostId, fixture);
    busy.release();

    const done = await shownToast(app, c.doneTitle(to));
    const stoppedAndClosed = `${c.stopped(1)} ${c.terminalClosed}`;
    expect(done.toast).toMatchObject({ body: { kind: 'hostUpdate', severity: 'info', message: stoppedAndClosed, actions: [] } });
    await expectToastCard(done, c, { title: c.doneTitle(to), message: stoppedAndClosed, actions: [] });
    await dismissKept(app, done, c, c.doneTitle(to));
    await expect(stripOf(await shownChat(app, firstReply(AGENTS[0])))).toHaveCount(0);
    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    busy.release();
    await busy.stub.close();
  }
});

test('S1 S2 S3 S4 S5, the drain with a second computer: the strip, the card and the reminder give the drain\'s end, the card lists the other computer\'s terminal with Open and Kill, the reminder\'s Show host opens the card, and the confirmation says the other computer reconnects', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }, testInfo) => {
  test.setTimeout(600_000);
  const launcher = { home, launch, mirror, ssh };
  const fixture = await sshd(HOST);
  await installOlderServer(fixture, CURRENT_PACKAGE, { version: OLD });
  const other = await secondDevice(fixture, HOST, mirror);
  const to = APP_VERSION;
  let failure: unknown;
  try {
    // the other computer runs the older app and stays connected, idle, with one terminal of its own
    writeUserSettings(other.home, { 'damocles.desktop.terminal.defaultProfile': 'bash', 'damocles.desktop.terminal.confirmOnKill': 'never' });
    const secondDesktop = await other.launch({ DAMOCLES_E2E_APP_VERSION: OLD });
    await connect(secondDesktop.app);
    await sleepingTerminal(secondDesktop.app, fixture);
    // longer than the test: the switch comes from Switch now
    const env = { ...remoteEnv(ssh, mirror), DAMOCLES_E2E_SWITCH_DRAIN_MS: '1800000' };

    // Greek: the drain's end on the strip and the card, and the confirmation's other computer, cancelled
    {
      const c = SHOWN.el;
      const greek = await launchIn(launcher, 'el', env);
      const { key } = await connect(greek.app);
      const page = await newRemoteChat(greek.app, key);
      await expectStrip(page, { state: 'waiting', tone: 'info', text: pattern(c.waitingDrain(to), 'el'), actions: [c.now] });
      const card = await openCard(greek.app);
      await expectUpdateSection(card, { state: 'waiting', tone: 'info', lead: pattern(c.leadDrain(to), 'el'), blockers: [pattern(c.devicesAt, 'el'), c.survive], actions: [c.now] });
      await expect(card.card.getByTestId('host-run').getByRole('button', { name: c.open })).toHaveCount(1);
      await expect(card.card.getByTestId('host-run').getByRole('button', { name: c.kill })).toHaveCount(1);
      await card.card.getByRole('button', { name: c.now, exact: true }).click();
      const confirm = await expectConfirm(card.overlay, c, to, { detail: `${c.dialogAgents(0)} ${c.dialogSurvive} ${c.dialogDevices(to)}`, preview: [] });
      await confirm.getByRole('button', { name: c.cancel, exact: true }).click();
      await expect(confirm).toHaveCount(0);
      await closeCard(card);
      await greek.close();
    }

    const c = SHOWN.en;
    const english = await launchIn(launcher, 'en', env);
    const { app } = english;
    const hostId = await hostIdOf(app);
    const key = await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    let page = await newRemoteChat(app, key);
    const draining: StripState = { state: 'waiting', tone: 'info', text: pattern(c.waitingDrain(to)), actions: [c.now] };
    await expectStripAtWidths(page, draining);
    await screens(testInfo, page, 'S1-banner-waiting-drain');
    const shell = await shellPage(app);
    await expectBadge(shell, { badge: 'pending', pip: 'circle', name: connectedBadge(c.pending) });

    // S2's journey: the other computer reconnects at the drain's end; its terminal has Open and Kill
    const card = await openCard(app);
    await atJourneyWidths(card.overlay, async () => {
      await expectUpdateSection(card, { state: 'waiting', tone: 'info', lead: pattern(c.leadDrain(to)), blockers: [pattern(c.devicesAt), c.survive], actions: [c.now] });
      await expect(card.card.getByText(pattern(c.devicesAt))).toBeVisible();
      await expect(card.card.getByTestId('host-run').getByRole('button', { name: c.open })).toBeVisible();
      await expect(card.card.getByTestId('host-run').getByRole('button', { name: c.kill })).toBeVisible();
    });
    await expect(card.card.getByTestId('host-run-closes')).toHaveCount(0);
    await expect(card.card.getByTestId('host-device')).toHaveCount(2);
    await screens(testInfo, card.overlay, 'S2-host-card-waiting-drain');
    // Open shows the other computer's terminal here; Kill ends it, and with it the row and the Update section's terminal line
    await card.card.getByTestId('host-run').getByRole('button', { name: c.open }).click();
    await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'running', { timeout: 30_000 });
    const again = await openCard(app);
    await again.card.getByTestId('host-run').getByRole('button', { name: c.kill }).click();
    await expect(again.card.getByTestId('host-run')).toHaveCount(0, { timeout: 30_000 });
    await expectUpdateSection(again, { state: 'waiting', tone: 'info', lead: pattern(c.leadDrain(to)), blockers: [pattern(c.devicesAt)], actions: [c.now] });
    await closeCard(again);

    // S4: the reminder gives the drain's end, and Show host opens the card
    await reconnectPending(app, hostId);
    const reminder = await shownToast(app, c.reminderTitle(OLD));
    await expectToastCard(reminder, c, { title: c.reminderTitle(OLD), message: pattern(c.reminderDrain(to)), actions: [c.now, c.showHost] });
    await screens(testInfo, reminder.popup, 'S4-notices-reminder-drain', () => reminder.card);
    await reminder.card.getByRole('button', { name: c.showHost, exact: true }).click();
    const shown = cardIn(await overlayPage(app));
    await expect(shown.dialog).toBeVisible();
    await expect(shown.card.getByRole('button', { name: c.now, exact: true })).toBeVisible();
    await closeCard(shown);

    // S1's journey: Switch now, the confirmation names the reconnection, and the strip shows switching
    page = await stripPage(app);
    await watch(page, 'strip', STRIP_TEXT);
    await stripOf(page).getByRole('button', { name: c.now, exact: true }).click();
    const overlay = await overlayPage(app);
    const confirm = await expectConfirm(overlay, c, to, { detail: `${c.dialogAgents(0)} ${c.dialogDevices(to)}`, preview: [] });
    await expect(confirm).toContainText(`then reconnects to Damocles ${to}`);
    // the scrim cancels as Escape does
    await overlay.mouse.click(4, 4);
    await expect(confirm).toHaveCount(0);
    await expectStrip(page, draining);
    await stripOf(page).getByRole('button', { name: c.now, exact: true }).click();
    await (await expectConfirm(overlay, c, to, { detail: `${c.dialogAgents(0)} ${c.dialogDevices(to)}`, preview: [] })).getByRole('button', { name: c.now, exact: true }).click();
    await expect.poll(() => watched(page, 'strip'), { timeout: 60_000 }).toContain(c.switching(to));
    await switched(app, hostId, fixture);
    await expect(shell.getByTestId('host-update-banner')).toHaveCount(0);
    await secondDesktop.close();
    await shutdownHostDaemon(app, hostId, fixture);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanUp(testInfo, failure, () => other.dispose(testInfo, failure !== undefined));
  }
});

test('S1 S2 S4 S5, a required update with hours left: the warning strip, the deadline tag on a colored chip, and the required reminder in English and Greek; the chip opens the card, Enter on its Switch now asks, and Switch now shows switching and then what it stopped', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }, testInfo) => {
  test.setTimeout(600_000);
  const launcher = { home, launch, mirror, ssh };
  const fixture = await sshd(HOST);
  const busy = await busyOlderServer(launcher, fixture, { version: OLD }, { agents: 1, terminal: true });
  const to = APP_VERSION;
  const env = { ...busy.env, DAMOCLES_E2E_SERVER_REQUIREMENT: JSON.stringify({ minimumServerVersion: APP_VERSION, graceHours: 3 }) };
  try {
    let deadline = 0;
    {
      const c = SHOWN.el;
      const greek = await launchIn(launcher, 'el', env);
      const { app } = greek;
      const hostId = await hostIdOf(app);
      await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
      const page = await shownChat(app, firstReply(AGENTS[0]));
      await expectStrip(page, { state: 'required', tone: 'warning', text: pattern(c.required(to), 'el'), actions: [c.now] });
      deadline = (await hostUpdateOf(app, hostId))!.required!.deadline;
      await expectBadge(await shellPage(app), { badge: 'required', pip: 'triangle', name: connectedBadge(c.badgeRequired, 'el'), tag: SHORT_TIME });
      const card = await openCard(app);
      await expectUpdateSection(card, { state: 'required', tone: 'warning', lead: pattern(c.leadRequired(to), 'el'), blockers: [c.agentsRunning(1), c.survive], actions: [c.now] });
      await closeCard(card);
      const reminder = await shownToast(app, c.reminderTitle(OLD));
      expect(reminder.toast).toMatchObject({ body: { kind: 'hostUpdate', severity: 'warning', host: HOST } });
      expect(reminder.body.message).toMatch(pattern(c.reminderRequired(to), 'el'));
      await expect(reminder.card.getByTestId('overlay-toast-message')).toHaveText(pattern(c.reminderRequired(to), 'el'));
      await expect(reminder.card.getByRole('button', { name: c.now, exact: true })).toBeVisible();
      await quitKeepRunning(greek);
      // a safety color for the host, which the next launch reads
      const hostsFile = path.join(home.userData, 'remote-hosts.json');
      const stored = JSON.parse(fs.readFileSync(hostsFile, 'utf8')) as { hosts: Record<string, Record<string, unknown>> };
      stored.hosts[hostId]!['color'] = 'danger';
      fs.writeFileSync(hostsFile, JSON.stringify(stored, null, 2));
    }

    const c = SHOWN.en;
    const english = await launchIn(launcher, 'en', env);
    const { app } = english;
    const hostId = await hostIdOf(app);
    await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    const page = await shownChat(app, firstReply(AGENTS[0]));
    // the deadline counts from the first detection, across the relaunch
    await expect.poll(async () => (await hostUpdateOf(app, hostId))?.required?.deadline, { timeout: 60_000 }).toBe(deadline);

    // S4: the required reminder comes at detection, as a warning
    const reminder = await shownToast(app, c.reminderTitle(OLD));
    expect(reminder.toast).toMatchObject({ body: { kind: 'hostUpdate', severity: 'warning', host: HOST } });
    await expect(reminder.card).toHaveAttribute('data-severity', 'warning');
    await expectToastCard(reminder, c, { title: c.reminderTitle(OLD), message: pattern(c.reminderRequired(to)), actions: [c.now, c.showHost] });
    await screens(testInfo, reminder.popup, 'S4-notices-reminder-required', () => reminder.card);
    await dismissKept(app, reminder, c, c.reminderTitle(OLD));

    const required: StripState = { state: 'required', tone: 'warning', text: pattern(c.required(to)), actions: [c.now] };
    await expectStripAtWidths(page, required);
    await screens(testInfo, page, 'S1-banner-required');
    // the shell continues the strip across the gutter in its tone
    const shell = await shellPage(app);
    await expect(shell.locator('[data-testid="connection-banner-edge"][data-state="update"]')).toHaveClass(/warning/);

    // S5: the triangle and the deadline tag after the colored name, in both themes; the tooltip is the card's lead
    const badge: BadgeState = { badge: 'required', pip: 'triangle', name: connectedBadge(c.badgeRequired), tag: SHORT_TIME };
    const chip = await expectBadge(shell, badge);
    await atJourneyWidths(shell, async () => void (await expectBadge(shell, badge)));
    await expect(chip).toHaveAttribute('data-tone', 'danger');
    await expect(chip.locator('[data-testid="title-bar-host-name"] + [data-testid="host-update-tag"]')).toHaveAttribute('data-state', 'required');
    const tagTime = ((await chip.getByTestId('host-update-tag').textContent()) ?? '').trim();
    await expect(chip).toHaveAccessibleName(new RegExp(`by ${rx(tagTime)}$`));
    await expect(chip).toHaveAttribute('title', new RegExp(`^${CONNECTED_NAME.en}\\n${source(c.leadRequired(to))}$`));
    await screens(testInfo, shell, 'S5-host-badge-required', () => titleBar(shell));
    await setLook(app, 'light');
    await expect(shell.locator('body')).toHaveClass(/(^| )vscode-light( |$)/);
    await expectBadge(shell, badge);
    await screens(testInfo, shell, 'S5-host-badge-required-light', () => titleBar(shell));
    await setLook(app, 'dark');
    await expect(shell.locator('body')).toHaveClass(/(^| )vscode-dark( |$)/);
    const header = await groupHeaderOf(shell);
    await expect(header).toHaveAccessibleName(new RegExp(`^${rx(HOST)}, .*${source(c.badgeRequired)}, expanded$`));
    await expect(header.getByTestId('host-update-tag')).toHaveText(tagTime);
    await screens(testInfo, shell, 'S5-host-badge-required-sidebar', () => header);

    // S2 at both widths
    const section: UpdateSection = { state: 'required', tone: 'warning', lead: pattern(c.leadRequired(to)), blockers: [c.agentsRunning(1), c.survive], actions: [c.now] };
    const centered = await openCard(app);
    await atJourneyWidths(centered.overlay, () => expectUpdateSection(centered, section));
    await screens(testInfo, centered.overlay, 'S2-host-card-required');
    await closeCard(centered);

    // S5's journey: the chip opens the card at Switch now; Enter asks; Switch now shows switching on the chip; Escape closes
    await watch(shell, 'chip', CHIP_DOT, 'aria-label');
    await watch(shell, 'pip', CHIP_PIP, 'data-pip');
    await shell.getByRole('button', { name: badge.name }).click();
    const card = cardIn(await overlayPage(app));
    await expect(card.dialog).toContainText(new RegExp(source(c.leadRequired(to))));
    const cardNow = card.card.getByRole('button', { name: c.now, exact: true });
    await cardNow.press('Enter');
    const confirm = await expectConfirm(card.overlay, c, to, { detail: `${c.dialogAgents(1)} ${c.dialogSurvive}`, preview: [c.agentLine] });
    await confirm.getByRole('button', { name: c.now, exact: true }).click();
    await expect.poll(async () => (await watched(shell, 'chip')).some((name) => badgeName(c.badgeSwitching(to)).test(name)), { timeout: 60_000 }).toBe(true);
    // the switching pip is the ring, with no tag
    expect(await watched(shell, 'pip')).toContain('ring');
    await card.card.getByRole('button', { name: c.close, exact: true }).press('Escape');
    await expect(card.dialog).toBeHidden();
    await switched(app, hostId, fixture);
    busy.release();

    // S4's journey: the notice of what the switch stopped, dismissed
    const done = await shownToast(app, c.doneTitle(to));
    expect(done.toast).toMatchObject({ body: { kind: 'hostUpdate', severity: 'info', message: c.stopped(1), actions: [] } });
    await expectToastCard(done, c, { title: c.doneTitle(to), message: c.stopped(1), actions: [] });
    await dismissKept(app, done, c, c.doneTitle(to));
    await expect(chipOf(shell).getByTestId('host-update-pip')).toHaveCount(0);
    await expect(chipOf(shell).getByTestId('host-update-tag')).toHaveCount(0);
    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    busy.release();
    await busy.stub.close();
  }
});

// 12 minutes, inside the countdown's 15: the countdown runs from the first detection, and the English and Greek checks end well
// before its deadline
const COUNTDOWN_GRACE_HOURS = 0.2;
// 36 seconds from the launch that waits for the forced switch, which brings the stored deadline in
const FORCED_GRACE_HOURS = 0.01;

/** The spoken minutes the clock's mm:ss stands for: the minutes left, rounded up. */
function spokenMinutes(clock: string): string[] {
  const [minutes, seconds] = clock.split(':').map(Number) as [number, number];
  const left = minutes * 60 + seconds;
  const words = (total: number): string => {
    const found = Math.ceil(total / 60);
    return found === 0 ? 'less than a minute' : found === 1 ? '1 minute' : `${found} minutes`;
  };
  // the clock rounds up to the second, so on a minute's own second either side is right
  return [words(left), words(left - 1)];
}

test('S1 S2 S4 S5, the countdown of a required update: the danger strip and card tick for the eye and speak the minutes left rounded up, as the badge counts them, the sticky notice comes back after Cancel, and the forced switch says when it ran, in English and Greek', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }, testInfo) => {
  test.setTimeout(900_000);
  const launcher = { home, launch, mirror, ssh };
  const fixture = await sshd(HOST);
  const busy = await busyOlderServer(launcher, fixture, { version: OLD }, { agents: 1, terminal: true });
  const to = APP_VERSION;
  const requiring = (graceHours: number): Record<string, string> => ({ ...busy.env, DAMOCLES_E2E_SERVER_REQUIREMENT: JSON.stringify({ minimumServerVersion: APP_VERSION, graceHours }) });
  const env = requiring(COUNTDOWN_GRACE_HOURS);
  try {
    let deadline = 0;
    {
      const c = SHOWN.en;
      const english = await launchIn(launcher, 'en', env);
      const { app } = english;
      const hostId = await hostIdOf(app);
      await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
      const page = await shownChat(app, firstReply(AGENTS[0]));
      const counting: StripState = { state: 'countdown', tone: 'danger', text: pattern(c.countdown(to)), actions: [c.now] };
      const strip = await expectStrip(page, counting);
      deadline = (await hostUpdateOf(app, hostId))!.required!.deadline;

      // S1: the mm:ss is for the eye, its sibling speaks the minutes left, and the clock ticks
      const clock = strip.getByTestId('countdown-clock');
      const spoken = strip.getByTestId('countdown-spoken');
      await expect(clock).toHaveAttribute('aria-hidden', 'true');
      await expect(spoken).toHaveClass(/sr-only/);
      const read = await strip.evaluate((node) => ({ clock: node.querySelector('[data-testid="countdown-clock"]')!.textContent!.trim(), spoken: node.querySelector('[data-testid="countdown-spoken"]')!.textContent!.trim() }));
      expect(spokenMinutes(read.clock)).toContain(read.spoken);
      await expect(clock).not.toHaveText(read.clock, { timeout: 5_000 });
      await expectStripAtWidths(page, counting);
      await screens(testInfo, page, 'S1-banner-countdown');
      const shell = await shellPage(app);
      await expect(shell.locator('[data-testid="connection-banner-edge"][data-state="update"]')).toHaveClass(/danger/);

      // S5: the square, and whole minutes on the tag and in the name
      const badge: BadgeState = { badge: 'countdown', pip: 'square', name: connectedBadge(c.badgeCountdown), tag: c.tagMinutes };
      const chip = await expectBadge(shell, badge);
      await expect(chip.getByTestId('host-update-tag')).toHaveAttribute('data-state', 'countdown');
      await screens(testInfo, shell, 'S5-host-badge-countdown', () => titleBar(shell));

      // S4: the sticky notice, assertive and heard once; its Switch now asks, and Cancel brings the notice back
      const sticky = await shownToast(app, c.countdownTitle);
      expect(sticky.toast).toMatchObject({ sticky: true, body: { kind: 'notice', severity: 'error', message: c.countdownMessage(to), actions: [c.now], host: HOST, countdownTo: deadline } });
      await expectToastCard(sticky, c, { title: pattern(`${c.countdownTitle} {clock}`), message: c.countdownMessage(to), actions: [c.now] });
      await expect(sticky.card.getByTestId('countdown-clock')).toHaveAttribute('aria-hidden', 'true');
      const heard = sticky.popup.getByTestId('overlay-toasts-assertive').locator('p');
      await expect(heard).toHaveText([new RegExp(`${rx(c.countdownTitle)} ${SPOKEN.en}: ${rx(c.countdownMessage(to))}`)]);
      await screens(testInfo, sticky.popup, 'S4-notices-countdown', () => sticky.card);
      await sticky.card.getByRole('button', { name: c.now, exact: true }).click();
      const confirm = await expectConfirm(await overlayPage(app), c, to, { detail: `${c.dialogAgents(1)} ${c.dialogSurvive}`, preview: [c.agentLine] });
      await confirm.getByRole('button', { name: c.cancel, exact: true }).click();
      await expect(confirm).toHaveCount(0);
      const back = await shownToast(app, c.countdownTitle, { after: [sticky.toast.id] });
      expect(back.toast).toMatchObject({ sticky: true, body: { countdownTo: deadline } });

      // S2: the card's lead ticks too, and says the agent will stop
      const card = await openCard(app);
      await expectUpdateSection(card, { state: 'countdown', tone: 'danger', lead: pattern(c.leadCountdown(to)), blockers: [c.agentStops, c.survive], actions: [c.now] });
      await expect(card.update.getByTestId('countdown-clock')).toHaveAttribute('aria-hidden', 'true');
      await expect(card.card.getByRole('button', { name: c.now, exact: true })).toBeFocused();
      await screens(testInfo, card.overlay, 'S2-host-card-countdown');
      await closeCard(card);
      await quitKeepRunning(english);
    }

    // Greek: the same countdown goes on across the relaunch
    {
      const c = SHOWN.el;
      const greek = await launchIn(launcher, 'el', env);
      const { app } = greek;
      const hostId = await hostIdOf(app);
      await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
      const page = await shownChat(app, firstReply(AGENTS[0]));
      await expectStrip(page, { state: 'countdown', tone: 'danger', text: pattern(c.countdown(to), 'el'), actions: [c.now] });
      await expectBadge(await shellPage(app), { badge: 'countdown', pip: 'square', name: connectedBadge(c.badgeCountdown, 'el'), tag: c.tagMinutes });
      const sticky = await shownToast(app, c.countdownTitle);
      expect(sticky.toast).toMatchObject({ sticky: true, body: { kind: 'notice', severity: 'error', message: c.countdownMessage(to), actions: [c.now], host: HOST, countdownTo: deadline } });
      await expect(sticky.card.getByTestId('overlay-toast-title')).toHaveText(pattern(`${c.countdownTitle} {clock}`, 'el'));
      const card = await openCard(app);
      await expectUpdateSection(card, { state: 'countdown', tone: 'danger', lead: pattern(c.leadCountdown(to), 'el'), blockers: [c.agentStops, c.survive], actions: [c.now] });
      await closeCard(card);
      const left = deadline - Date.now();
      testInfo.annotations.push({ type: 'countdown', description: `${Math.round(left / 1000)} s were left of ${COUNTDOWN_GRACE_HOURS * 3600} s when the checks ended` });
      expect(left, 'the checks ran inside the countdown').toBeGreaterThan(0);
      await quitKeepRunning(greek);
    }

    // a shorter grace brings the deadline in, which then switches with no question
    const c = SHOWN.el;
    const forced = await launchIn(launcher, 'el', requiring(FORCED_GRACE_HOURS));
    const { app } = forced;
    const hostId = await hostIdOf(app);
    await expect.poll(async () => (await hostUpdateOf(app, hostId))?.required?.deadline ?? Number.POSITIVE_INFINITY, { timeout: 60_000 }).toBeLessThan(deadline);
    const near = (await hostUpdateOf(app, hostId))!.required!.deadline;
    const sticky = await shownToast(app, c.countdownTitle);
    expect(sticky.toast).toMatchObject({ sticky: true, body: { countdownTo: near } });

    // the notice says when the required update ran, as a warning, and the countdown is withdrawn
    await switched(app, hostId, fixture, Math.max(0, near - Date.now()));
    busy.release();
    const done = await shownToast(app, c.doneTitle(to));
    expect(done.toast).toMatchObject({ body: { kind: 'notice', severity: 'warning', actions: [] } });
    await expectToastCard(done, c, { title: c.doneTitle(to), message: pattern(`${c.forced} ${c.stopped(1)}`, 'el'), actions: [] });
    await expect(done.card).toHaveAttribute('data-severity', 'warning');
    await expect(sticky.card).toHaveCount(0);
    await screens(testInfo, done.popup, 'S4-notices-after-forced-switch', () => done.card);
    await expect(stripOf(await shownChat(app, firstReply(AGENTS[0])))).toHaveCount(0);
    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    busy.release();
    await busy.stub.close();
  }
});

const OUTDATED_CHAT = 'Asked on the newer server';
const OUTDATED_ANSWER = 'Answered by the newer server.';

/**
 * A host this app is too old for: a newer server of another protocol runs on it, whose release required itself and so raised
 * the host's security floor, and this computer keeps a copy of one chat. Ending that server leaves the floor alone.
 */
async function newerServer({ home, launch, mirror, ssh }: Launcher, fixture: SshdFixture): Promise<Record<string, string>> {
  await installOlderServer(fixture, CURRENT_PACKAGE, { version: NEWER, protocolVersion: OTHER_PROTOCOL, minimumServerVersion: NEWER });
  const env = remoteEnv(ssh, mirror);
  const stub = await startTargetStub(home, fixture);
  try {
    const newer = await launch({ env: { ...env, DAMOCLES_E2E_APP_VERSION: NEWER, DAMOCLES_E2E_PROTOCOL_VERSION: String(OTHER_PROTOCOL) } });
    const { key } = await connect(newer.app);
    stub.replies.push({ chunks: [OUTDATED_ANSWER] });
    const tab = await newRemoteChat(newer.app, key);
    await sendPrompt(tab, OUTDATED_CHAT);
    await expect(tab.getByText(OUTDATED_ANSWER)).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);
    await newer.close();
  } finally {
    await stub.close();
  }
  expect(await daemonVersions(fixture)).toEqual([NEWER]);
  expect(await securityFloor(fixture)).toBe(NEWER);
  return env;
}

/** Ends newerServer's daemon, which no control of this app reaches; the floor keeps this app's from starting, so nothing runs after. */
async function endNewerServer(app: ElectronApplication, fixture: SshdFixture): Promise<void> {
  await fixture.sh('pkill -u dev -f \'/dist/daemon.js serve\'');
  await expectNoAccountProcesses(app, await hostIdOf(app), fixture);
}

interface OutdatedCopy {
  readonly strip: string;
  readonly mirrorTitle: string;
  readonly lead: string;
  readonly sub: string;
  /** The tooltip's second line. */
  readonly tooltip: string;
}

const outdatedCopy = (c: Copy, variant: 'runs' | 'floor'): OutdatedCopy => (variant === 'runs'
  ? { strip: c.outdated(NEWER), mirrorTitle: c.mirrorTitle, lead: c.leadOutdated(NEWER), sub: c.outdatedSub(APP_VERSION), tooltip: c.leadOutdated(NEWER) }
  : { strip: c.outdatedFloor(NEWER), mirrorTitle: c.mirrorTitleFloor, lead: c.leadFloor(NEWER), sub: c.floorSub(APP_VERSION, NEWER), tooltip: c.floorTooltip(NEWER) });

/** Every surface of the outdated-app state in one variant; with the updater off it offers no action, and the card's focus goes to Close. */
async function expectOutdated(app: ElectronApplication, page: Page, c: Copy, variant: 'runs' | 'floor'): Promise<void> {
  const copy = outdatedCopy(c, variant);
  const strip = await expectStrip(page, { state: 'appOutdated', tone: 'warning', text: copy.strip, actions: [] });
  // the unpackaged app has no updater, so Check for updates is absent
  await expect(strip.getByRole('button', { name: c.checkUpdates })).toHaveCount(0);
  await expect(chatInput(page)).toHaveCount(0);
  const composer = page.getByTestId('composer-outdated');
  await expect(composer).toHaveRole('status');
  await expect(composer.getByText(copy.mirrorTitle, { exact: true })).toBeVisible();
  await expect(composer.getByText(c.mirrorNote, { exact: true })).toBeVisible();

  const shell = await shellPage(app);
  const chip = await expectBadge(shell, { badge: 'appOutdated', pip: 'diamond', name: badgeName(c.badgeOutdated) });
  await expect(chip).toHaveAttribute('title', new RegExp(`\\n${rx(copy.tooltip)}$`));

  // the card reads not connected, with the diamond on the offline dot
  const card = await openCard(app);
  await expect(card.card.getByTestId('host-card-status')).toHaveText(c.notConnected);
  await expect(card.card.getByTestId('host-status-dot').first()).toHaveAttribute('data-update', 'appOutdated');
  await expect(card.card.getByTestId('host-status-dot').first()).toHaveAttribute('data-shape', 'offline');
  await expect(card.card.getByTestId('host-update-pip').first()).toHaveAttribute('data-pip', 'diamond');
  await expectUpdateSection(card, { state: 'appOutdated', tone: 'warning', lead: copy.lead, blockers: [], actions: [] });
  await expect(card.update.getByTestId('host-update-sub')).toHaveText(copy.sub);
  await expect(card.card.getByRole('button', { name: c.now, exact: true })).toHaveCount(0);
  await expect(card.card.getByRole('button', { name: c.checkUpdates, exact: true })).toHaveCount(0);
  await expect(card.card.getByTestId('host-devices')).toHaveCount(0);
  await expect(card.card.getByTestId('host-run')).toHaveCount(0);
  await expect(card.card.getByTestId('host-card-open-folder')).toHaveCount(0);
  await expect(card.card.getByRole('button', { name: c.close, exact: true })).toBeFocused();
  await closeCard(card);
}

test('S1 S2 S5, an app older than the host: the strip, the composer card, the diamond and the card say to update this app, first for a newer server that runs and then for the host\'s minimum, in English and Greek, with no switch and no Check for updates while the updater is off', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }, testInfo) => {
  test.setTimeout(600_000);
  const launcher = { home, launch, mirror, ssh };
  const fixture = await sshd(HOST);
  const env = await newerServer(launcher, fixture);

  // Greek: the newer server runs
  {
    const greek = await launchIn(launcher, 'el', env);
    const page = await openListedChat(greek.app, OUTDATED_CHAT, OUTDATED_ANSWER);
    await expectOutdated(greek.app, page, SHOWN.el, 'runs');
    await greek.close();
  }

  const c = SHOWN.en;
  {
    const english = await launchIn(launcher, 'en', env);
    const { app } = english;
    const hostId = await hostIdOf(app);
    const page = await openListedChat(app, OUTDATED_CHAT, OUTDATED_ANSWER);
    await expectOutdated(app, page, c, 'runs');
    await expectStripAtWidths(page, { state: 'appOutdated', tone: 'warning', text: c.outdated(NEWER), actions: [] });
    await screens(testInfo, page, 'S1-banner-app-outdated');
    const shell = await shellPage(app);
    await atJourneyWidths(shell, async () => void (await expectBadge(shell, { badge: 'appOutdated', pip: 'diamond', name: badgeName(c.badgeOutdated) })));
    await screens(testInfo, shell, 'S5-host-badge-app-outdated', () => titleBar(shell));
    const header = await groupHeaderOf(shell);
    await expect(header).toHaveAccessibleName(new RegExp(`^${rx(HOST)}, .*${rx(c.badgeOutdated)}, expanded$`));
    // S5: the sidebar's dot opens the card
    await header.getByTestId('project-group-host-details').click();
    const popover = cardIn(await overlayPage(app));
    await expect(popover.dialog).toContainText(c.leadOutdated(NEWER));
    await popover.card.getByRole('button', { name: c.close, exact: true }).press('Escape');
    await expect(popover.dialog).toBeHidden();
    const runs = await openCard(app);
    await atJourneyWidths(runs.overlay, async () => {
      await expect(runs.card.getByText(c.leadOutdated(NEWER), { exact: true })).toBeVisible();
      await expect(runs.card.getByText(c.outdatedSub(APP_VERSION), { exact: true })).toBeVisible();
    });
    await screens(testInfo, runs.overlay, 'S2-host-card-app-outdated');
    await closeCard(runs);

    // the newer server ends, and the host's minimum still keeps this app out: the floor variant, the same look with other copy
    await fixture.sh('pkill -u dev -f \'/dist/daemon.js serve\'');
    await expect.poll(() => hostUpdateOf(app, hostId), { timeout: 120_000 }).toMatchObject({ phase: 'appOutdated', outdated: 'floor', serverVersion: NEWER });
    expect(await daemonVersions(fixture)).toEqual([]);
    const floorPage = await shownChat(app, OUTDATED_ANSWER);
    await expectOutdated(app, floorPage, c, 'floor');
    await expectStripAtWidths(floorPage, { state: 'appOutdated', tone: 'warning', text: c.outdatedFloor(NEWER), actions: [] });
    await atJourneyWidths(floorPage, async () => expect(floorPage.getByText(c.mirrorTitleFloor, { exact: true })).toBeVisible());
    await screens(testInfo, floorPage, 'S1-banner-app-outdated-floor');
    await shell.getByRole('button', { name: badgeName(c.badgeOutdated) }).click();
    const floor = cardIn(await overlayPage(app));
    await expect(floor.dialog).toContainText(c.leadFloor(NEWER));
    await floor.card.getByRole('button', { name: c.close, exact: true }).press('Escape');
    await expect(floor.dialog).toBeHidden();
    const centered = await openCard(app);
    await atJourneyWidths(centered.overlay, async () => expect(centered.card.getByText(c.floorSub(APP_VERSION, NEWER), { exact: true })).toBeVisible());
    await screens(testInfo, centered.overlay, 'S2-host-card-app-outdated-floor');
    await closeCard(centered);
    await english.close();
  }

  // Greek: the floor variant
  const greek = await launchIn(launcher, 'el', env);
  const hostId = await hostIdOf(greek.app);
  await expect.poll(() => hostUpdateOf(greek.app, hostId), { timeout: 120_000 }).toMatchObject({ phase: 'appOutdated', outdated: 'floor' });
  await expectOutdated(greek.app, await openListedChat(greek.app, OUTDATED_CHAT, OUTDATED_ANSWER), SHOWN.el, 'floor');
  expect(await daemonVersions(fixture)).toEqual([]);
  expect(await securityFloor(fixture)).toBe(NEWER);
  await expectNoAccountProcesses(greek.app, hostId, fixture);
});

test('S2, an older server another computer keeps: the card says so in its notices, in English and Greek, with no Update section, strip or badge', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }, testInfo) => {
  test.setTimeout(600_000);
  const launcher = { home, launch, mirror, ssh };
  const fixture = await sshd(HOST);
  // without control.shutdownWhenIdle.clients a newer app may not ask it to switch while another computer uses it
  await installOlderServer(fixture, CURRENT_PACKAGE, { version: OLD, withoutFeature: 'control.shutdownWhenIdle.clients' });
  const other = await secondDevice(fixture, HOST, mirror);
  let failure: unknown;
  try {
    const secondDesktop = await other.launch({ DAMOCLES_E2E_APP_VERSION: OLD });
    await connect(secondDesktop.app);
    const env = remoteEnv(ssh, mirror);
    const inUse = async (app: ElectronApplication, hostId: string, c: Copy): Promise<Card> => {
      const card = await openCard(app);
      const notice = card.card.getByRole('list').getByTestId('host-notice').filter({ hasText: OLD });
      await expect(notice).toHaveText(c.inUse(OLD));
      await expect(notice).toHaveAttribute('data-code', 'serverInUse');
      // the notice shows only while no switch is pending for this computer
      await expect(card.update).toHaveCount(0);
      expect(await hostUpdateOf(app, hostId)).toBeUndefined();
      const shell = await shellPage(app);
      await expect(shell.getByTestId('host-update-banner')).toHaveCount(0);
      await expect(chipOf(shell).getByTestId('host-update-pip')).toHaveCount(0);
      return card;
    };

    const greek = await launchIn(launcher, 'el', env);
    const { hostId } = await connect(greek.app);
    await closeCard(await inUse(greek.app, hostId, SHOWN.el));
    await greek.close();

    const english = await launchIn(launcher, 'en', env);
    await remoteProjectKey(english.app, { authorityKey: `ssh+${hostId}` }, APP);
    const card = await inUse(english.app, hostId, SHOWN.en);
    await atJourneyWidths(card.overlay, async () => expect(card.card.getByText(SHOWN.en.inUse(OLD), { exact: true })).toBeVisible());
    await screens(testInfo, card.overlay, 'S2-host-card-server-in-use');
    await closeCard(card);
    expect(await daemonVersions(fixture)).toEqual([OLD]);
    await secondDesktop.close();
    await shutdownHostDaemon(english.app, hostId, fixture);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanUp(testInfo, failure, () => other.dispose(testInfo, failure !== undefined));
  }
});

// needs a state no fixture brings; its annotation says why
test.fixme('S1 S2, Check for updates in the outdated-app state: the strip and the card offer it, the card\'s focus goes to it, and it shows the title bar\'s update pill checking', {
  tag: SSH_TAG,
  annotation: { type: 'fixme', description: 'The updater runs only in a packaged app (updater.ts: isPackaged), and no e2e hook turns it on, so canCheckForUpdates is never true in this suite. The run asserts the button\'s absence instead.' },
}, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  const launcher = { home, launch, mirror, ssh };
  const fixture = await sshd(HOST);
  const { app } = await launchIn(launcher, 'en', await newerServer(launcher, fixture));
  const page = await openListedChat(app, OUTDATED_CHAT, OUTDATED_ANSWER);
  await expectStrip(page, { state: 'appOutdated', tone: 'warning', text: COPY.en.outdated(NEWER), actions: [COPY.en.checkUpdates] });
  const card = await openCard(app);
  const check = card.card.getByRole('button', { name: COPY.en.checkUpdates, exact: true });
  await expect(check).toBeFocused();
  await check.click();
  await expect((await shellPage(app)).getByTestId('update-pill')).toHaveAttribute('data-state', 'checking');
});

// the design's sample reads "prod-1 · offline"; the app words a host that is not connected as "prod-1, Not connected"
test('S5\'s journey, the outdated host\'s chip is the button "prod-1, Not connected, update this app", with the diamond on the offline dot', {
  tag: SSH_TAG,
}, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const launcher = { home, launch, mirror, ssh };
  const fixture = await sshd(HOST);
  const { app } = await launchIn(launcher, 'en', await newerServer(launcher, fixture));
  await openListedChat(app, OUTDATED_CHAT, OUTDATED_ANSWER);
  const shell = await shellPage(app);
  await expect(shell.getByRole('button', { name: `${HOST}, Not connected, update this app`, exact: true })).toBeVisible();
  await expect(chipOf(shell).getByTestId('host-status-dot')).toHaveAttribute('data-shape', 'offline');
  await endNewerServer(app, fixture);
});

// the design's journeys name the dialog "prod-1"; the app names it by its visible title, as every view of this dialog is
test('S2 S5\'s journeys, the host card is a dialog named by its title, "Details for prod-1"', {
  tag: SSH_TAG,
}, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const launcher = { home, launch, mirror, ssh };
  const fixture = await sshd(HOST);
  const { app } = await launchIn(launcher, 'en', await newerServer(launcher, fixture));
  await openListedChat(app, OUTDATED_CHAT, OUTDATED_ANSWER);
  const card = await openCard(app);
  await expect(card.overlay.getByRole('dialog', { name: `Details for ${HOST}`, exact: true })).toBeVisible();
  await closeCard(card);
  await endNewerServer(app, fixture);
});

test('S4 in Greek, the reminder\'s second action is the app\'s one wording of Show host', {
  tag: SSH_TAG,
}, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const launcher = { home, launch, mirror, ssh };
  const fixture = await sshd(HOST);
  const busy = await busyOlderServer(launcher, fixture, { version: OLD }, { agents: 1, terminal: false });
  try {
    const { app } = await launchIn(launcher, 'el', { ...busy.env, DAMOCLES_E2E_SERVER_REQUIREMENT: JSON.stringify({ minimumServerVersion: APP_VERSION, graceHours: 3 }) });
    const hostId = await hostIdOf(app);
    const reminder = await shownToast(app, COPY.el.reminderTitle(OLD));
    await expect(reminder.card.getByRole('button', { name: SHOWN.el.showHost, exact: true })).toBeVisible();
    await switchOnceIdle(app, hostId, fixture, busy);
  } finally {
    busy.release();
    await busy.stub.close();
  }
});

test('S5, opened from the sidebar\'s dot or the title bar chip, the card\'s focus is on the Update section\'s first action, so Enter asks', {
  tag: SSH_TAG,
}, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const launcher = { home, launch, mirror, ssh };
  const fixture = await sshd(HOST);
  const busy = await busyOlderServer(launcher, fixture, { version: OLD }, { agents: 1, terminal: false });
  try {
    const { app } = await launchIn(launcher, 'en', busy.env);
    const hostId = await hostIdOf(app);
    const shell = await shellPage(app);
    const overlay = await overlayPage(app);
    const switchNow = overlay.getByTestId('host-card').getByRole('button', { name: COPY.en.now, exact: true });
    await (await expectBadge(shell, { badge: 'pending', pip: 'circle', name: connectedBadge(COPY.en.pending) })).click();
    await expect(switchNow).toBeFocused();
    await overlay.keyboard.press('Escape');
    await (await groupHeaderOf(shell)).getByTestId('project-group-host-details').click();
    await expect(switchNow).toBeFocused();
    await overlay.keyboard.press('Enter');
    const confirm = overlay.getByRole('alertdialog', { name: COPY.en.dialogTitle(APP_VERSION) });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: COPY.en.cancel, exact: true }).click();
    await switchOnceIdle(app, hostId, fixture, busy);
  } finally {
    busy.release();
    await busy.stub.close();
  }
});

test('S3 in Greek, the confirmation\'s first button is the app\'s one wording of Cancel, and its preview never names an agent by its panel id', {
  tag: SSH_TAG,
}, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const launcher = { home, launch, mirror, ssh };
  const fixture = await sshd(HOST);
  const busy = await busyOlderServer(launcher, fixture, { version: OLD }, { agents: 1, terminal: false });
  try {
    const { app } = await launchIn(launcher, 'el', busy.env);
    const hostId = await hostIdOf(app);
    await stripOf(await stripPage(app)).getByRole('button', { name: COPY.el.now, exact: true }).click();
    const confirm = (await overlayPage(app)).getByRole('alertdialog', { name: COPY.el.dialogTitle(APP_VERSION) });
    await expect(confirm.getByRole('button', { name: SHOWN.el.cancel, exact: true })).toBeFocused();
    await expect(confirm.getByTestId('overlay-message-preview')).not.toContainText(/host-\d+/);
    await confirm.getByRole('button', { name: SHOWN.el.cancel, exact: true }).click();
    await switchOnceIdle(app, hostId, fixture, busy);
  } finally {
    busy.release();
    await busy.stub.close();
  }
});

test('S4\'s journey, a chosen switch that stopped nothing still shows "prod-1 now runs Damocles" and this version', {
  tag: SSH_TAG,
}, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }, testInfo) => {
  test.setTimeout(600_000);
  const launcher = { home, launch, mirror, ssh };
  const fixture = await sshd(HOST);
  await installOlderServer(fixture, CURRENT_PACKAGE, { version: OLD });
  const other = await secondDevice(fixture, HOST, mirror);
  try {
    const secondDesktop = await other.launch({ DAMOCLES_E2E_APP_VERSION: OLD });
    await connect(secondDesktop.app);
    const { app } = await launchIn(launcher, 'en', { ...remoteEnv(ssh, mirror), DAMOCLES_E2E_SWITCH_DRAIN_MS: '1800000' });
    const { hostId, key } = await connect(app);
    const page = await newRemoteChat(app, key);
    await stripOf(page).getByRole('button', { name: COPY.en.now, exact: true }).click();
    await (await overlayPage(app)).getByRole('alertdialog').getByRole('button', { name: COPY.en.now, exact: true }).click();
    await switched(app, hostId, fixture);
    await shownToast(app, COPY.en.doneTitle(APP_VERSION));
    await secondDesktop.close();
    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    await other.dispose(testInfo, false);
  }
});
