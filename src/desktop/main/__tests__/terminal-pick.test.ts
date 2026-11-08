import { describe, expect, it, vi } from 'vitest';
import { MAX_MENU_ITEMS, MAX_OVERLAY_ITEMS, type OverlayAnswer, type OverlayMenuItem, type OverlayRequest } from '../../preload/overlay-channels';
import { TERMINAL_COLORS, TERMINAL_CUSTOM_ICONS, type TerminalColor, type TerminalCustomIcon, type TerminalInfo, type TerminalProfileOption, type TerminalProjectOption } from '../../preload/terminal-channels';
import {
  buildNewTerminalMenu,
  joinTerminalItems,
  openNewTerminalMenu,
  parseTerminalPickCall,
  pickDefaultProfile,
  pickNewTerminal,
  pickTerminalColor,
  pickTerminalIcon,
  serveTerminalPick,
  startPickedTerminal,
  TerminalPickSession,
  type DefaultProfileHost,
  type DefaultProfileShells,
  type HostShells,
  type TerminalAppearance,
} from '../terminal-pick';

function overlay(...answers: OverlayAnswer[]) {
  const requests: OverlayRequest[] = [];
  return { requests, request: (request: OverlayRequest) => { requests.push(request); return Promise.resolve(answers[requests.length - 1] ?? { kind: 'dismissed' as const }); } };
}

// An overlay whose requests stay open until answered or withdrawn by their signal.
function heldOverlay() {
  const open: Array<{ request: OverlayRequest; answer: (answer: OverlayAnswer) => void }> = [];
  return {
    open,
    request: (request: OverlayRequest, _focus: undefined, _shown?: undefined, _browse?: undefined, signal?: AbortSignal) => new Promise<OverlayAnswer>((resolve) => {
      open.push({ request, answer: resolve });
      signal?.addEventListener('abort', () => resolve({ kind: 'dismissed' }), { once: true });
    }),
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const detected = { args: [], source: 'detected', customIcon: null, color: null } as const;
const shell = (id: string, isDefault = false): TerminalProfileOption => ({ id, name: id.toUpperCase(), path: `/bin/${id}`, icon: 'bash', isDefault, ...detected });
const project = (key: string, name: string, host?: string, reachable = true): TerminalProjectOption => ({
  key, name, path: `/${name}`, current: false, authority: host === undefined ? { kind: 'local' } : { kind: 'ssh', name: host }, reachable,
});
const ALPHA = project('c:\\alpha', 'alpha');
const API = project('ssh+h1|/srv/api', 'api', 'prod');
const WEB = project('ssh+h2|/srv/web', 'web', 'lab', false);
const LABELS = { local: 'This computer', home: 'Home folder', detecting: 'Detecting shells…', none: 'No shells found', notConnected: 'Not connected', selectDefault: 'Select Default Profile...' };
const ids = (items: readonly OverlayMenuItem[]): string[] => items.flatMap((item) => (item.kind === 'separator' ? ['-'] : [item.label]));

const APPEARANCE: TerminalAppearance = { icon: 'powershell', customIcon: 'rocket', color: 'green' };
const ICONS = Object.fromEntries(TERMINAL_CUSTOM_ICONS.map((icon) => [icon, `Icon ${icon}`])) as Record<TerminalCustomIcon, string>;
const COLORS = Object.fromEntries(TERMINAL_COLORS.map((color) => [color, color.toUpperCase()])) as Record<TerminalColor, string>;

describe('terminal quick picks', () => {
  it('offers the profile icon and every curated icon in the terminal\'s color, the current one marked', async () => {
    const fake = overlay({ kind: 'quickPick', itemId: 'bug', query: '' });
    expect(await pickTerminalIcon(fake, APPEARANCE, { placeholder: 'Icon', profileIcon: 'Default', icons: ICONS }, undefined)).toEqual({ customIcon: 'bug' });
    const request = fake.requests[0] as Extract<OverlayRequest, { kind: 'quickPick' }>;
    expect(request.items).toHaveLength(TERMINAL_CUSTOM_ICONS.length + 1);
    expect(request.items[0]).toEqual({ id: 'default', label: 'Default', glyph: 'powershell', color: 'green', current: false });
    expect(request.items.filter((item) => item.current).map((item) => item.id)).toEqual(['rocket']);
    expect(request.items.find((item) => item.id === 'flask-conical')?.label).toBe('Icon flask-conical');
    expect(request.items.every((item) => item.color === 'green')).toBe(true);
    expect(await pickTerminalIcon(overlay({ kind: 'quickPick', itemId: 'default', query: '' }), APPEARANCE, { placeholder: 'Icon', profileIcon: 'Default', icons: ICONS }, undefined)).toEqual({ customIcon: null });
    expect(await pickTerminalIcon(overlay({ kind: 'dismissed' }), APPEARANCE, { placeholder: 'Icon', profileIcon: 'Default', icons: ICONS }, undefined)).toBeUndefined();
  });

  it('offers no color and the eight hues, each row showing the terminal\'s icon', async () => {
    const fake = overlay({ kind: 'quickPick', itemId: 'magenta', query: '' });
    expect(await pickTerminalColor(fake, APPEARANCE, { placeholder: 'Color', noColor: 'No color', colors: COLORS }, undefined)).toEqual({ color: 'magenta' });
    const request = fake.requests[0] as Extract<OverlayRequest, { kind: 'quickPick' }>;
    expect(request.items.map((item) => [item.id, item.label, item.color ?? null, item.glyph, item.current])).toEqual([
      ['default', 'No color', null, 'rocket', false],
      ...TERMINAL_COLORS.map((color) => [color, color.toUpperCase(), color, 'rocket', color === 'green']),
    ]);
    expect(await pickTerminalColor(overlay({ kind: 'quickPick', itemId: 'default', query: '' }), APPEARANCE, { placeholder: 'Color', noColor: 'No color', colors: COLORS }, undefined)).toEqual({ color: null });
  });

  const LOCAL: DefaultProfileHost = { authority: 'local', name: 'This computer', reachable: true, saved: true };
  const PROFILE_LABELS = {
    hostPlaceholder: 'Host',
    notConnected: 'Not connected',
    detecting: 'Detecting shells…',
    profilePlaceholder: (host: DefaultProfileHost) => `Profile for ${host.name}`,
    noShells: (host: DefaultProfileHost) => `No shells on ${host.name}`,
    unsaved: (host: DefaultProfileHost) => `${host.name} is not saved`,
  };
  const listing = (profiles: readonly TerminalProfileOption[]) => ({
    shellsOf: (): HostShells => ({ kind: 'detected', profiles }),
    detected: () => Promise.resolve(),
    tell: vi.fn<(message: string) => void>(),
  });

  it('offers the listed profiles with their paths, a user profile in its icon and color, the default marked', async () => {
    const profiles: TerminalProfileOption[] = [
      { id: 'pwsh', name: 'PowerShell', path: 'C:\\pwsh.exe', icon: 'powershell', isDefault: false, ...detected },
      { id: 'wsl:Ubuntu', name: 'Ubuntu', path: 'C:\\wsl.exe', icon: 'wsl', isDefault: true, ...detected },
      { id: 'user:Dev', name: 'Dev', path: 'C:\\ps.exe', args: ['-NoExit'], source: 'user', icon: 'powershell', customIcon: 'code', color: 'magenta', isDefault: false },
    ];
    const fake = overlay({ kind: 'quickPick', itemId: 'wsl:Ubuntu', query: '' });
    expect(await pickDefaultProfile(fake, [LOCAL], listing(profiles), PROFILE_LABELS, undefined)).toEqual({ authority: 'local', profileId: 'wsl:Ubuntu' });
    expect(fake.requests[0]).toEqual({
      kind: 'quickPick',
      placeholder: 'Profile for This computer',
      items: [
        { id: 'pwsh', label: 'PowerShell', description: 'C:\\pwsh.exe', glyph: 'powershell', current: false },
        { id: 'wsl:Ubuntu', label: 'Ubuntu', description: 'C:\\wsl.exe', glyph: 'wsl', current: true },
        { id: 'user:Dev', label: 'Dev', description: 'C:\\ps.exe', glyph: 'code', color: 'magenta', current: false },
      ],
    });
  });

  it('asks for the host first when there are several, lists a disconnected one disabled, then lists that host\'s shells', async () => {
    const hosts: DefaultProfileHost[] = [LOCAL, { authority: 'ssh+h1', name: 'prod', reachable: true, saved: true }, { authority: 'ssh+h2', name: 'lab', reachable: false, saved: true }];
    const asked: string[] = [];
    const shells: DefaultProfileShells = {
      shellsOf: (authority) => {
        asked.push(authority);
        return { kind: 'detected', profiles: [shell('bash'), shell('zsh', true)] };
      },
      detected: () => Promise.resolve(),
      tell: () => undefined,
    };
    const fake = overlay({ kind: 'quickPick', itemId: 'ssh+h1', query: '' }, { kind: 'quickPick', itemId: 'bash', query: '' });
    expect(await pickDefaultProfile(fake, hosts, shells, PROFILE_LABELS, undefined)).toEqual({ authority: 'ssh+h1', profileId: 'bash' });
    expect(new Set(asked)).toEqual(new Set(['ssh+h1']));
    expect(fake.requests[0]).toEqual({
      kind: 'quickPick',
      placeholder: 'Host',
      items: [
        { id: 'local', label: 'This computer' },
        { id: 'ssh+h1', label: 'prod' },
        { id: 'ssh+h2', label: 'lab', description: 'Not connected', info: true },
      ],
    });
    expect(fake.requests[1]).toMatchObject({ placeholder: 'Profile for prod', items: [{ id: 'bash', current: false }, { id: 'zsh', current: true }] });
    // Escape at the host step asks for no shells
    asked.length = 0;
    expect(await pickDefaultProfile(overlay({ kind: 'dismissed' }), hosts, shells, PROFILE_LABELS, undefined)).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it('ends with a toast for a host with no shell, or with no saved record to keep its default in', async () => {
    const none = listing([]);
    const empty = overlay();
    expect(await pickDefaultProfile(empty, [LOCAL], none, PROFILE_LABELS, undefined)).toBeUndefined();
    expect(empty.requests).toEqual([]);
    expect(none.tell).toHaveBeenCalledWith('No shells on This computer');

    const loopback: DefaultProfileHost = { authority: 'ssh+loop', name: 'loop', reachable: true, saved: false };
    const unsaved = listing([shell('bash')]);
    const fake = overlay({ kind: 'quickPick', itemId: 'ssh+loop', query: '' });
    expect(await pickDefaultProfile(fake, [LOCAL, loopback], unsaved, PROFILE_LABELS, undefined)).toBeUndefined();
    expect(fake.requests).toHaveLength(1);
    expect(unsaved.tell).toHaveBeenCalledWith('loop is not saved');
  });

  it('says the shells are being detected after the host step, until they are, and Escape there ends it', async () => {
    const prod: DefaultProfileHost = { authority: 'ssh+h1', name: 'prod', reachable: true, saved: true };
    let found: HostShells = { kind: 'detecting' };
    let finish!: () => void;
    const shells: DefaultProfileShells = { shellsOf: () => found, detected: () => new Promise<void>((resolve) => (finish = resolve)), tell: vi.fn() };
    const fake = heldOverlay();
    const picked = pickDefaultProfile(fake, [prod], shells, PROFILE_LABELS, undefined);
    await settle();
    expect(fake.open.map((entry) => entry.request)).toEqual([{ kind: 'quickPick', placeholder: 'Profile for prod', items: [{ id: 'detecting', label: 'Detecting shells…', info: true }] }]);
    found = { kind: 'detected', profiles: [shell('bash', true)] };
    finish();
    await settle();
    expect(fake.open[1]?.request).toMatchObject({ placeholder: 'Profile for prod', items: [{ id: 'bash', current: true }] });
    fake.open[1]!.answer({ kind: 'quickPick', itemId: 'bash', query: '' });
    expect(await picked).toEqual({ authority: 'ssh+h1', profileId: 'bash' });

    found = { kind: 'detecting' };
    const escaped = heldOverlay();
    const dismissed = pickDefaultProfile(escaped, [prod], shells, PROFILE_LABELS, undefined);
    await settle();
    escaped.open[0]!.answer({ kind: 'dismissed' });
    expect(await dismissed).toBeUndefined();
    finish();
    await settle();
    expect(escaped.open).toHaveLength(1);
    expect(shells.tell).not.toHaveBeenCalled();
  });
});

describe('the New Terminal pick session', () => {
  it('serves shells only for an offered reachable project, default first, and accepts only a served shell or the default', async () => {
    const session = new TerminalPickSession([ALPHA, API, WEB]);
    expect(session.offers(ALPHA.key)).toBe(true);
    expect(session.offers(WEB.key)).toBe(false);
    expect(session.offers(null)).toBe(false);
    expect(session.serve(WEB.key, [shell('bash')])).toBeUndefined();
    expect(session.serve(API.key, [shell('bash'), shell('zsh', true)])?.map((profile) => profile.id)).toEqual(['zsh', 'bash']);
    expect(session.accepts(API.key, 'zsh')).toBe(true);
    expect(session.accepts(API.key, null)).toBe(true);
    // a shell served for another project, or never served, is no answer for this one
    expect(session.accepts(ALPHA.key, 'zsh')).toBe(false);
    expect(session.accepts(API.key, 'fish')).toBe(false);
    expect(session.accepts(WEB.key, null)).toBe(false);

    const answered = overlay({ kind: 'newTerminal', projectKey: API.key, profileId: 'zsh' });
    expect(await pickNewTerminal(answered, session, undefined)).toEqual({ profileId: 'zsh', target: { project: API.key } });
    expect(answered.requests).toEqual([{ kind: 'newTerminal', projects: [ALPHA, API, WEB] }]);
    expect(await pickNewTerminal(overlay({ kind: 'newTerminal', projectKey: ALPHA.key, profileId: 'zsh' }), session, undefined)).toBeUndefined();
    expect(await pickNewTerminal(overlay({ kind: 'newTerminal', projectKey: ALPHA.key, profileId: null }), session, undefined)).toEqual({ profileId: null, target: { project: ALPHA.key } });
  });

  it('offers the home folder only while no listed project is reachable', () => {
    expect(new TerminalPickSession([]).offers(null)).toBe(true);
    const offline = new TerminalPickSession([WEB]);
    expect(offline.offers(null)).toBe(true);
    expect(offline.serve(null, [shell('pwsh', true)])?.map((profile) => profile.id)).toEqual(['pwsh']);
    expect(offline.accepts(null, 'pwsh')).toBe(true);
  });

  it('reads step 2\'s call only as exactly { projectKey }, a string or null', () => {
    expect(parseTerminalPickCall({ projectKey: API.key })).toBe(API.key);
    expect(parseTerminalPickCall({ projectKey: null })).toBeNull();
    for (const raw of [undefined, null, 'x', [], [API.key], {}, { projectKey: 3 }, { projectKey: API.key, extra: 1 }, { key: API.key }]) {
      expect(() => parseTerminalPickCall(raw)).toThrow('Malformed New Terminal shells request');
    }
  });

  // A host that goes away while the pick shows: step 2 says it is not connected rather than offering its kept shells.
  it('serves step 2 once the host\'s shells are detected, and answers notConnected for a host that went away', async () => {
    const session = new TerminalPickSession([ALPHA, API]);
    let connected = true;
    let finish!: () => void;
    const host = { connected: (key: string | null) => key !== API.key || connected, detected: () => new Promise<void>((resolve) => (finish = resolve)), profiles: () => [shell('bash'), shell('zsh', true)] };
    const served = serveTerminalPick(session, { projectKey: API.key }, host);
    finish();
    expect(await served).toEqual({ kind: 'shells', profiles: [shell('zsh', true), shell('bash')] });
    expect(session.accepts(API.key, 'bash')).toBe(true);

    const during = serveTerminalPick(session, { projectKey: API.key }, host);
    connected = false;
    finish();
    expect(await during).toEqual({ kind: 'notConnected' });
    expect(await serveTerminalPick(session, { projectKey: API.key }, { ...host, detected: () => Promise.resolve() })).toEqual({ kind: 'notConnected' });
    await expect(serveTerminalPick(session, { projectKey: WEB.key }, host)).rejects.toThrow('Not a target the New Terminal pick offers');
    await expect(serveTerminalPick(undefined, { projectKey: ALPHA.key }, host)).rejects.toThrow('Not a target the New Terminal pick offers');
  });

  it('starts a picked terminal once its host\'s shells are known, and says why when its host went away or has no shell', async () => {
    let connected = true;
    const tell = vi.fn();
    const create = vi.fn((): { readonly ok: false; readonly reason: 'noProfile' } | { readonly ok: true; readonly id: string } => ({ ok: true, id: 'term-1' }));
    const deps = {
      host: { connected: (key: string | null) => key === null || connected, detected: () => Promise.resolve() },
      create,
      tell,
      notConnected: (key: string) => `${key} is not connected`,
      noShells: (key: string | null) => `no shells for ${String(key)}`,
    };
    expect(await startPickedTerminal({ profileId: 'bash', target: { project: API.key } }, deps)).toEqual({ ok: true, id: 'term-1' });
    expect(create).toHaveBeenCalledWith({ profileId: 'bash', target: { project: API.key } });

    connected = false;
    create.mockClear();
    expect(await startPickedTerminal({ profileId: 'bash', target: { project: API.key } }, deps)).toEqual({ ok: false, reason: 'notConnected' });
    expect(create).not.toHaveBeenCalled();
    expect(tell).toHaveBeenLastCalledWith(`${API.key} is not connected`);

    connected = true;
    const goesAway = { ...deps, host: { ...deps.host, detected: () => { connected = false; return Promise.resolve(); } } };
    expect(await startPickedTerminal({ profileId: null, target: { project: API.key } }, goesAway)).toEqual({ ok: false, reason: 'notConnected' });
    expect(create).not.toHaveBeenCalled();

    create.mockReturnValueOnce({ ok: false, reason: 'noProfile' });
    expect(await startPickedTerminal({ profileId: null, target: { home: true } }, deps)).toEqual({ ok: false, reason: 'noProfile' });
    expect(tell).toHaveBeenLastCalledWith('no shells for null');
  });
});

describe('the New Terminal arrow menu', () => {
  const ready = (profiles: TerminalProfileOption[]): HostShells => ({ kind: 'detected', profiles });

  it('lists one project\'s shells flat, then Select Default Profile..., each shell starting there', () => {
    const menu = buildNewTerminalMenu([ALPHA], () => ready([shell('pwsh', true), { ...shell('dev'), source: 'user', customIcon: 'wrench', color: 'magenta' }]), LABELS);
    expect(menu.items).toEqual([
      { kind: 'item', id: 'shell-0', label: 'PWSH', glyph: 'bash' },
      { kind: 'item', id: 'shell-1', label: 'DEV', glyph: 'wrench', color: 'magenta' },
      { kind: 'separator' },
      { kind: 'item', id: 'selectDefaultProfile', label: 'Select Default Profile...' },
    ]);
    expect(menu.actions.get('shell-1')).toEqual({ kind: 'create', profileId: 'dev', target: { project: ALPHA.key } });
    expect(menu.actions.get('selectDefaultProfile')).toEqual({ kind: 'selectDefault' });
    const home = buildNewTerminalMenu([], () => ready([shell('pwsh', true)]), LABELS);
    expect(home.actions.get('shell-0')).toEqual({ kind: 'create', profileId: 'pwsh', target: { home: true } });
  });

  it('gives each project a submenu with its host as a hint when hosts differ, and says when a host is detecting, has no shell or is not connected', () => {
    const lab = project('ssh+h3|/srv/lab', 'lab-app', 'lab');
    const shellsOf = (key: string | null): HostShells => (key === ALPHA.key ? ready([shell('pwsh')]) : key === API.key ? { kind: 'detecting' } : ready([]));
    const menu = buildNewTerminalMenu([ALPHA, API, lab, WEB], shellsOf, LABELS);
    expect(menu.items).toEqual([
      { kind: 'submenu', id: 'project-0', label: 'alpha', hint: 'This computer', items: [{ kind: 'item', id: 'shell-0', label: 'PWSH', glyph: 'bash' }] },
      { kind: 'submenu', id: 'project-1', label: 'api', hint: 'prod', items: [{ kind: 'item', id: 'info-1', label: 'Detecting shells…', disabled: true }] },
      { kind: 'submenu', id: 'project-2', label: 'lab-app', hint: 'lab', items: [{ kind: 'item', id: 'info-2', label: 'No shells found', disabled: true }] },
      { kind: 'item', id: 'info-3', label: 'web', hint: 'lab', disabled: true, disabledReason: 'Not connected' },
      { kind: 'separator' },
      { kind: 'item', id: 'selectDefaultProfile', label: 'Select Default Profile...' },
    ]);
    expect([...menu.actions.keys()]).toEqual(['selectDefaultProfile', 'shell-0']);
    // projects on one host need no hint
    const same = buildNewTerminalMenu([ALPHA, project('c:\\beta', 'beta')], () => ready([shell('pwsh')]), LABELS);
    expect(same.items.every((item) => item.kind !== 'submenu' || item.hint === undefined)).toBe(true);
  });

  // The picker offers the home folder while no listed project is reachable, so the arrow does too.
  it('leads with the home folder\'s shells on this computer while no listed project is reachable', () => {
    const shellsOf = (key: string | null): HostShells => (key === null ? ready([shell('pwsh', true)]) : ready([shell('bash')]));
    const one = buildNewTerminalMenu([WEB], shellsOf, LABELS);
    expect(one.items).toEqual([
      { kind: 'submenu', id: 'project-0', label: 'Home folder', hint: 'This computer', items: [{ kind: 'item', id: 'shell-0', label: 'PWSH', glyph: 'bash' }] },
      { kind: 'item', id: 'info-1', label: 'web', hint: 'lab', disabled: true, disabledReason: 'Not connected' },
      { kind: 'separator' },
      { kind: 'item', id: 'selectDefaultProfile', label: 'Select Default Profile...' },
    ]);
    expect(one.actions.get('shell-0')).toEqual({ kind: 'create', profileId: 'pwsh', target: { home: true } });
    const offline = project('ssh+h3|/srv/lab', 'lab-app', 'lab', false);
    expect(ids(buildNewTerminalMenu([WEB, offline], shellsOf, LABELS).items)).toEqual(['Home folder', 'web', 'lab-app', '-', 'Select Default Profile...']);
    expect(ids(buildNewTerminalMenu([ALPHA, WEB], shellsOf, LABELS).items)).toEqual(['alpha', 'web', '-', 'Select Default Profile...']);
  });

  it('resolves once the menu closed, and starts the chosen action without waiting for it, reporting its failure', async () => {
    const menu = buildNewTerminalMenu([ALPHA], () => ready([shell('pwsh', true)]), LABELS);
    const placement = { label: 'New terminal with a shell', anchor: { x: 1, y: 2, width: 3, height: 4 } };
    const run = vi.fn(() => new Promise<void>(() => undefined));
    const report = vi.fn(() => () => undefined);
    await openNewTerminalMenu(overlay({ kind: 'menu', itemId: 'selectDefaultProfile' }), menu, placement, undefined, run, report);
    expect(run).toHaveBeenCalledWith({ kind: 'selectDefault' });

    const failed = vi.fn();
    await openNewTerminalMenu(overlay({ kind: 'menu', itemId: 'shell-0' }), menu, placement, undefined, () => Promise.reject(new Error('no pty')), () => failed);
    await settle();
    expect(failed).toHaveBeenCalledWith(new Error('no pty'));

    run.mockClear();
    const asked = overlay({ kind: 'dismissed' });
    await openNewTerminalMenu(asked, menu, placement, undefined, run, report);
    expect(asked.requests).toEqual([{ kind: 'menu', label: 'New terminal with a shell', anchor: placement.anchor, items: menu.items }]);
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps every level within the menu bounds', () => {
    const projects = Array.from({ length: 120 }, (_, index) => project(`c:\\p${index}`, `p${index}`));
    const many = Array.from({ length: 120 }, (_, index) => shell(`s${index}`));
    const menu = buildNewTerminalMenu(projects, () => ready(many), LABELS);
    expect(menu.items.length).toBeLessThanOrEqual(MAX_OVERLAY_ITEMS);
    const submenus = menu.items.flatMap((item) => (item.kind === 'submenu' ? [item] : []));
    expect(submenus.every((item) => item.items.length >= 1 && item.items.length <= MAX_OVERLAY_ITEMS)).toBe(true);
    expect(menu.items.length + submenus.reduce((sum, item) => sum + item.items.length, 0)).toBeLessThanOrEqual(MAX_MENU_ITEMS);
  });
});

describe('Join Terminals rows', () => {
  it('shows each candidate as its row does: its icon in its color, its title and its project', () => {
    const row = (id: string, extra: Partial<TerminalInfo>): TerminalInfo => ({
      id, title: 'pwsh', name: null, profileId: 'pwsh', icon: 'powershell', customIcon: null, color: null, projectKey: 'c:\\alpha', projectName: 'alpha', status: 'running',
      exitCode: null, description: null, running: null, integrated: false, restoring: false, windowsBuild: null, pathFlavor: 'win32', placement: 'panel', ...extra,
    });
    expect(joinTerminalItems([row('term-2', { title: 'npm run dev', customIcon: 'rocket', color: 'green' }), row('term-3', { projectKey: null, projectName: '' })])).toEqual([
      { id: 'term-2', label: 'npm run dev', description: 'alpha', glyph: 'rocket', color: 'green' },
      { id: 'term-3', label: 'pwsh', glyph: 'powershell' },
    ]);
  });
});
