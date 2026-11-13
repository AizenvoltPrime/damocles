import { describe, expect, it, vi } from 'vitest';
import { canonicalHostColor } from '../../../shared/host-colors';

vi.mock('electron', () => ({ WebContentsView: vi.fn(), nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() }, protocol: {} }));

import { MAX_BUILD_LOG_LINES, MAX_DEVCONTAINER_TRUST_VALUES, type DevcontainerTrustRequest, type GitCredentialConsent, type HostCardInfo, type OverlayRequest } from '../../preload/overlay-channels';
import { devcontainerTrustAccepted, parseConnectHosts, parseConnectStep, parseDevcontainerTrustRequest, parseGitCredentialConsentRequest, parseHostEntries, parseOverlayAnswer } from '../overlay';
import { parseConnectTarget } from '../remote/connect-channels';

const ID = '28f4e6f33d7eb0c2fa0a1a525fdb39d5ef72c206dbca3f397ed48e8b10aa3a24';
const KEY = 'c'.repeat(32);

const trust: DevcontainerTrustRequest = {
  folder: 'C:\\work\\app',
  configPath: 'C:\\work\\app\\.devcontainer\\devcontainer.json',
  changed: false,
  items: [
    { field: 'initializeCommand', values: [{ text: 'echo ran > init-ran.txt' }] },
    { field: 'mounts', values: [{ text: 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock', danger: 'dockerSocket' }] },
    { field: 'privileged', values: [{ text: 'true', danger: 'privileged' }] },
  ],
};

describe('the devcontainer confirmation', () => {
  it('asks with the listed fields as main built them, and refuses one past the overlay\'s bounds rather than clip it', () => {
    expect(parseDevcontainerTrustRequest(trust)).toEqual({ kind: 'devcontainerTrust', ...trust });
    expect(parseDevcontainerTrustRequest({ ...trust, hostName: 'prod-1', hostColor: 'info' })).toMatchObject({ hostName: 'prod-1', hostColor: 'info' });
    const tooMany = { ...trust, items: [{ field: 'runArgs' as const, values: Array.from({ length: MAX_DEVCONTAINER_TRUST_VALUES + 1 }, (_, n) => ({ text: `--a${n}` })) }] };
    for (const bad of [
      tooMany,
      { ...trust, items: [{ field: 'nope', values: [{ text: 'x' }] }] },
      { ...trust, items: [trust.items[0]!, trust.items[0]!] },
      { ...trust, items: [{ field: 'runArgs', values: [] }] },
      { ...trust, items: [{ field: 'runArgs', values: [{ text: '' }] }] },
      { ...trust, items: [{ field: 'runArgs', values: [{ text: 'x', danger: 'root' }] }] },
      { ...trust, folder: '' },
      { ...trust, hostColor: '#ff0000' },
    ]) {
      expect(parseDevcontainerTrustRequest(bad as DevcontainerTrustRequest)).toBeUndefined();
    }
  });

  it('proceeds only on an explicit accept: Escape, the scrim, Cancel and any other answer refuse', () => {
    const request = parseDevcontainerTrustRequest(trust) as OverlayRequest;
    expect(devcontainerTrustAccepted(parseOverlayAnswer({ kind: 'devcontainerTrust', accept: true }, request)!)).toBe(true);
    expect(devcontainerTrustAccepted(parseOverlayAnswer({ kind: 'devcontainerTrust', accept: false }, request)!)).toBe(false);
    expect(devcontainerTrustAccepted(parseOverlayAnswer({ kind: 'dismissed' }, request)!)).toBe(false);
    expect(parseOverlayAnswer({ kind: 'devcontainerTrust', accept: 'yes' }, request)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'devcontainerTrust', accept: true, extra: 1 }, request)).toBeUndefined();
  });
});

describe('container cards, steps and targets', () => {
  const card: HostCardInfo = {
    hostId: 'h1', kind: 'container', name: 'app', destinationLabel: 'docker · node:24', connection: 'offline', signInNeeded: false, recentFolders: [], projectFolders: [], notices: [],
    allowBypass: false, passwordless: false, keyInstalledByDamocles: false, lingerEnabledByDamocles: false,
    container: { origin: 'devcontainer', state: 'stopped', engine: 'docker', image: 'node:24', via: { hostId: 'h0', name: 'prod-1' }, workspaceFolder: '/srv/app', configPath: '/srv/app/.devcontainer.json' },
  };

  it('shows a container card only with its container detail, and a step with a build log only for a container attempt', () => {
    expect(parseConnectHosts([card])).toEqual([card]);
    expect(parseConnectHosts([{ ...card, container: undefined }])).toBeUndefined();
    expect(parseConnectHosts([{ ...card, kind: 'ssh' }])).toBeUndefined();
    expect(parseConnectHosts([{ ...card, container: { ...card.container!, engine: 'lxc' } }])).toBeUndefined();
    // the Safety line's agent forwarding crosses as a boolean, or not at all
    expect(parseConnectHosts([{ ...card, agentForwarding: true }])).toEqual([{ ...card, agentForwarding: true }]);
    expect(parseConnectHosts([{ ...card, agentForwarding: 'yes' }])).toBeUndefined();
    // a container without the data volume crosses as true, or not at all
    const withoutVolume = { ...card, container: { ...card.container!, withoutDataVolume: true as const } };
    expect(parseConnectHosts([withoutVolume])).toEqual([withoutVolume]);
    expect(parseConnectHosts([{ ...card, container: { ...card.container!, withoutDataVolume: false } }])).toBeUndefined();
    const step = { attemptId: 'a', hostId: 'h1', transport: 'container', step: 'building', visited: ['building'], notices: [], buildLog: { lines: ['#1 FROM node'], total: 1 } };
    expect(parseConnectStep(step)).toEqual(step);
    expect(parseConnectStep({ ...step, transport: 'ssh' })).toBeUndefined();
    expect(parseConnectStep({ ...step, buildLog: { lines: Array(MAX_BUILD_LOG_LINES + 1).fill('x'), total: MAX_BUILD_LOG_LINES + 1 } })).toBeUndefined();
    expect(parseConnectStep({ ...step, buildLog: { lines: ['a', 'b'], total: 1 } })).toBeUndefined();
    expect(parseConnectStep({ ...step, visited: ['building', 'authenticating'] })).toBeUndefined();
  });

  it('lists a container in Settings under its container+<key> authority only', () => {
    const entry = { hostId: 'h1', kind: 'container', container: card.container, authorityKey: `container+${KEY}`, name: 'app', destinationLabel: 'docker', connection: 'offline', settings: { allowBypass: false, forwardAgent: false, rememberPassword: false, browserLocalNetwork: false, openLinksWithoutAsking: false }, facts: { passwordless: false, keyInstalledByDamocles: false, lingerEnabledByDamocles: false, alwaysCredentialHosts: [], alwaysForgeAccounts: [] }, heldMemoryQueues: [] };
    expect(parseHostEntries([entry])).toHaveLength(1);
    expect(parseHostEntries([{ ...entry, authorityKey: 'container+xyz' }])).toBeUndefined();
    expect(parseHostEntries([{ ...entry, authorityKey: 'ssh+h1' }])).toBeUndefined();
  });

  it('takes an attach and a devcontainer target only with a container id, a user and an absolute folder', () => {
    expect(parseConnectTarget({ target: { attach: ID, user: 'root', name: 'web' } })).toEqual({ attach: ID, user: 'root', name: 'web' });
    expect(parseConnectTarget({ target: { attach: ID, user: 'configured', name: 'web', via: 'h0' } })).toEqual({ attach: ID, user: 'configured', name: 'web', via: 'h0' });
    expect(parseConnectTarget({ target: { devcontainer: 'C:\\work\\app', name: 'app' } })).toEqual({ devcontainer: 'C:\\work\\app', name: 'app' });
    for (const target of [{ attach: '--privileged', user: 'root', name: 'x' }, { attach: ID, user: 'admin', name: 'x' }, { devcontainer: 'relative', name: 'x' }, { devcontainer: '/srv/a\nb', name: 'x' }, { devcontainer: '/srv/app', name: 'x', extra: 1 }]) {
      expect(parseConnectTarget({ target })).toBeUndefined();
    }
  });
});

describe('git consent naming a Git hosting account', () => {
  const consent: GitCredentialConsent = { hostName: 'prod-1', credentialHost: 'gitlab.indigital.gr', targetHelper: false };
  const forgeAccount = { serverLabel: 'gitlab.indigital.gr', login: 'astefanopoulos', reason: 'access', repoPath: 'grp/damocles' } as const;

  it('carries the account through, and nothing more than its four fields', () => {
    expect(parseGitCredentialConsentRequest({ ...consent, forgeAccount })).toEqual({ kind: 'gitCredentialConsent', ...consent, forgeAccount });
    const extra = { ...forgeAccount, token: 'secret' } as unknown as NonNullable<GitCredentialConsent['forgeAccount']>;
    expect(parseGitCredentialConsentRequest({ ...consent, forgeAccount: extra })).toEqual({ kind: 'gitCredentialConsent', ...consent, forgeAccount });
  });

  it('shows a hidden or bidi character in the path, login or server as its escape', () => {
    const tricked = { serverLabel: 'gitlab\u200b.com', login: 'astef\u202eadmin', reason: 'access', repoPath: 'grp/\u2066damocles' } as const;
    expect(parseGitCredentialConsentRequest({ ...consent, forgeAccount: tricked })?.forgeAccount).toEqual({
      serverLabel: String.raw`gitlab\u{200B}.com`,
      login: String.raw`astef\u{202E}admin`,
      reason: 'access',
      repoPath: String.raw`grp/\u{2066}damocles`,
    });
  });

  it('refuses a reason that never asks, and an empty or oversized login', () => {
    for (const bad of [{ ...forgeAccount, reason: 'bound' }, { ...forgeAccount, reason: 'hostDefault' }, { ...forgeAccount, login: '' }, { ...forgeAccount, login: 'x'.repeat(10_000) }]) {
      expect(parseGitCredentialConsentRequest({ ...consent, forgeAccount: bad } as unknown as GitCredentialConsent)).toBeUndefined();
    }
  });

  it('takes a deeply nested repository path within its own bound, past the host name\'s', () => {
    const nested = `${'group/'.repeat(49)}project`;
    expect(nested.length).toBe(301);
    expect(parseGitCredentialConsentRequest({ ...consent, forgeAccount: { ...forgeAccount, repoPath: nested } })?.forgeAccount?.repoPath).toBe(nested);
    expect(parseGitCredentialConsentRequest({ ...consent, forgeAccount: { ...forgeAccount, repoPath: 'g/'.repeat(1000) } })).toBeUndefined();
  });

  it('carries the read variant of an access pick', () => {
    expect(parseGitCredentialConsentRequest({ ...consent, forgeAccount: { ...forgeAccount, reason: 'accessRead' } })?.forgeAccount?.reason).toBe('accessRead');
  });
});

// A host color lands in the overlay's inline style, so every request carrying one keeps only a tone or #rrggbbaa.
describe('host colors at the overlay boundary', () => {
  const CUSTOM = canonicalHostColor('#00808099')!;
  const JUNK = ['#ff0000', '#00A0A0FF', '#00a0a000', 'teal', 'url(x)', '#00ff00ff;background:url(x)', 7];

  it('keeps a custom color on the devcontainer confirmation and the git consent, and refuses junk', () => {
    expect(parseDevcontainerTrustRequest({ ...trust, hostName: 'prod-1', hostColor: CUSTOM })).toMatchObject({ hostColor: CUSTOM });
    const consent = { hostName: 'prod-1', hostColor: CUSTOM, credentialHost: 'github.com', targetHelper: false } as GitCredentialConsent;
    expect(parseGitCredentialConsentRequest(consent)).toMatchObject({ hostColor: CUSTOM });
    for (const hostColor of JUNK) {
      expect(parseDevcontainerTrustRequest({ ...trust, hostName: 'prod-1', hostColor } as unknown as DevcontainerTrustRequest)).toBeUndefined();
      expect(parseGitCredentialConsentRequest({ ...consent, hostColor } as unknown as GitCredentialConsent)).toBeUndefined();
    }
  });

  it('keeps a custom color on a Connect card and a Settings host entry, and refuses junk', () => {
    const card = { hostId: 'h1', kind: 'ssh', name: 'prod-1', destinationLabel: 'prod-1', connection: 'offline', signInNeeded: false, recentFolders: [], projectFolders: [], notices: [], allowBypass: false, passwordless: false, keyInstalledByDamocles: false, lingerEnabledByDamocles: false };
    expect(parseConnectHosts([{ ...card, color: CUSTOM }])).toEqual([{ ...card, color: CUSTOM }]);
    const entry = { hostId: 'h1', kind: 'ssh', authorityKey: 'ssh+h1', name: 'prod-1', destinationLabel: 'prod-1', connection: 'offline', settings: { allowBypass: false, forwardAgent: false, rememberPassword: false, browserLocalNetwork: false, openLinksWithoutAsking: false }, facts: { passwordless: false, keyInstalledByDamocles: false, lingerEnabledByDamocles: false, alwaysCredentialHosts: [], alwaysForgeAccounts: [] }, heldMemoryQueues: [] };
    expect(parseHostEntries([{ ...entry, settings: { ...entry.settings, color: CUSTOM } }])?.[0]?.settings.color).toBe(CUSTOM);
    for (const color of JUNK) {
      expect(parseConnectHosts([{ ...card, color }])).toBeUndefined();
      expect(parseHostEntries([{ ...entry, settings: { ...entry.settings, color } }])).toBeUndefined();
    }
  });
});
