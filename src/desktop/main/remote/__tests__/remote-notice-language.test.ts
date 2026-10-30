// A daemon's core asks for a notification; the daemon routes it to the acting client, whose main renders the text and the
// action labels in its own language and answers with the chosen action's index (docs/invariants.md "Localized text").
import { afterEach, describe, expect, it } from 'vitest';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';
import { inGreek } from '../../../../__mocks__/greek-locale';
import type { Disposable } from '../../../../platform/disposable';
import { englishText, type LocalizedText } from '../../../../shared/localized-text';
import { createCoreEndpoint, createLoopback, createMainEndpoint, processActor } from '../../../core-protocol';
import { createClientMirrors, createCoreRouter, type CoreRouter } from '../../../daemon/core-routes';
import { createRunRegistry } from '../../../daemon/run-registry';
import { createDesktopLocalizationService, type DesktopLanguage } from '../../../local-services/localization-service';
import { createHostServices, type HostServices } from '../../core-services/host-services';
import { hostExtras } from '../../core-services/__tests__/host-deps';
import { createDesktopNotificationService } from '../../platform/notification-service';
import { remoteServices } from '../remote-services';

const quiet = (): void => undefined;
const none = (): Disposable => ({ dispose: () => undefined });
const PROJECT = { key: 'loopback|/srv/app', fsPath: '/srv/app', name: 'app' };

const NOTICE: LocalizedText = { message: 'Could not open file: {0}', args: ['a.ts'] };
const ACTIONS: readonly LocalizedText[] = [{ message: 'Open' }, { message: 'Cancel' }];

const emptyMirrors = {
  trust: { keys: [] },
  folders: { folders: [] },
  editor: {},
  terminal: { shown: false, shortcut: '' },
  language: { language: 'en' as const },
  clientAuth: { providers: {} },
  clientUser: { settings: {}, permissionRules: [] },
  clientPolicy: { voice: false, allowBypass: false },
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

interface Shown { readonly text: string; readonly labels: readonly string[] }

/** A client's main serving a remote core in `language`: what its notices showed, and the label it picks of each. */
function clientMain(router: CoreRouter, id: string, language: DesktopLanguage, pick: number) {
  const loop = createLoopback();
  const endpoint = createMainEndpoint(loop.main, quiet);
  const attached = router.attach({ id, clientId: id, hostId: 'h1', transport: loop.core, mirrors: { ...emptyMirrors, language: { language } }, close: () => undefined, drained: () => Promise.resolve(), lost: () => false, onLostChange: none });
  const localization = createDesktopLocalizationService(process.cwd(), language, quiet);
  const shown: Shown[] = [];
  const notices = createDesktopNotificationService({
    notice: async (_severity, text, labels) => {
      shown.push({ text, labels });
      return pick;
    },
    ask: async () => undefined,
    t: (message) => localization.t(message),
    log: quiet,
  });
  const base = { ...hostExtras(), render: (text: LocalizedText) => localization.render(text), terminalToggle: () => ({ shown: false, shortcut: '' }), createView: () => { throw new Error('no view'); }, git: { available: true }, e2eHooks: false, log: quiet };
  const services: HostServices = createHostServices({
    endpoint,
    ...remoteServices({
      authority: 'loopback',
      hostId: 'h1',
      hostName: () => 'Build server',
      platform: createFakePlatform(),
      projects: () => [PROJECT],
      fileRoots: () => [PROJECT],
      onProjectsChanged: none,
      workspace: () => ({ files: { projectOfPath: async () => undefined, readText: async () => undefined } }) as never,
      trust: { trustedKeys: () => [], onDidGrant: none, requestTrust: async () => false },
      openInEditor: async () => undefined,
      showLog: () => undefined,
      showDiff: async () => ({ close: async () => undefined, closed: Promise.resolve() }),
      showMarkdown: async () => undefined,
      showChatReview: async () => undefined,
      openSettingsFile: async () => undefined,
      pick: async () => undefined,
      ui: { ask: async () => 0, askpass: async () => ({ cancelled: true }), worktrees: hostExtras().ui.worktrees },
      notices,
      user: { credentials: async () => ({ type: 'none' }), speak: async () => undefined, gitCredential: async () => ({ kind: 'none' }) },
      base,
      t: (message, ...args) => localization.t(message, ...args),
    }),
  });
  cleanups.push(() => {
    services.dispose();
    attached.dispose();
    endpoint.close('closed');
  });
  return { endpoint, shown };
}

function daemonCore() {
  const coreLoop = createLoopback();
  const daemonMain = createMainEndpoint(coreLoop.main, quiet, undefined, processActor);
  const core = createCoreEndpoint(coreLoop.core, quiet, undefined, processActor);
  const router = createCoreRouter({ core: daemonMain, state: { snapshot: () => ({}), update: async () => undefined, flush: async () => undefined }, registry: createRunRegistry(), mirrors: createClientMirrors(), secrets: new Map(), e2eHooks: false, reload: quiet, log: quiet });
  cleanups.push(() => {
    router.dispose();
    core.close('closed');
  });
  return { core, router };
}

describe('a daemon\'s core\'s notification on this computer', () => {
  it('main renders a daemon core\'s notification in the client\'s language and answers by index', async () => {
    const { core, router } = daemonCore();
    const greek = clientMain(router, 'greek-laptop', 'el', 1);
    const english = clientMain(router, 'english-desktop', 'en', 0);
    const ask = (): Promise<unknown> => core.request('notifications.show', { severity: 'warn', message: NOTICE, actions: ACTIONS });

    // the client that attached last acts
    expect(await ask()).toBe(0);
    // a client's message makes it the acting one
    await greek.endpoint.request('catalog.list', { projectKey: PROJECT.key, complete: false }).catch(() => undefined);
    expect(await ask()).toBe(1);

    expect(english.shown).toEqual([{ text: 'Could not open file: a.ts', labels: ['Open', 'Cancel'] }]);
    expect(greek.shown).toEqual([{ text: 'Δεν ήταν δυνατό το άνοιγμα του αρχείου: a.ts', labels: ['Άνοιγμα', 'Άκυρο'] }]);
    expect(greek.shown[0]).toEqual({ text: inGreek(NOTICE), labels: ACTIONS.map(inGreek) });
    expect(english.shown[0]).toEqual({ text: englishText(NOTICE), labels: ACTIONS.map(englishText) });
  });
});
