import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { runPermissionGate, type PanelGateContext } from '../permission-gate';
import { getPiCodingAgent, initPiLoader } from '../pi-loader';
import { FEEDBACK_MARKER, POLICY_BLOCK_MARKER } from '../../../shared/types/constants';
import { PermissionHandler } from '../../permission-handler';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { englishText } from '../../../shared/localized-text';
import { ShellCancelStore } from '../tools/shell-cancel-registry';
import { ChatServedFiles } from '../../browser/served-files';
import type { ToolCallHookResult } from '../hooks/dispatch';

// The QueryDosDeviceW answer for a drive a test maps, by name (`Q:`); any other asks Windows.
const dosDevices = vi.hoisted(() => new Map<string, string>());
vi.mock('../../dos-devices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../dos-devices')>();
  return { queryDosDevice: (name: string): string | undefined => dosDevices.get(name) ?? actual.queryDosDevice(name) };
});
// the real path Windows answers for a network folder, by its spelling: a mapped drive answers its share's path
const realpaths = vi.hoisted(() => new Map<string, string>());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: (target: string, options?: unknown) => {
      const answer = realpaths.get(String(target).toLowerCase());
      if (answer !== undefined) return Promise.resolve(answer);
      if (/192\.0\.2|^Q:/i.test(String(target))) return Promise.reject(new Error(`a test path reached realpath unmapped: ${String(target)}`));
      return actual.realpath(target, options as never);
    },
  };
});
// every path the gate canonicalizes, which reads the file system there
const canonicalized = vi.hoisted(() => [] as string[]);
vi.mock('../../canonical-path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../canonical-path')>();
  return { ...actual, canonicalPath: (target: string): string => { canonicalized.push(target); return actual.canonicalPath(target); } };
});

// A file page outside the chat's project and design folders asks through the gate, as the network-path card does: rules and
// modes decide, and the call the gate lets run grants the page's folder to that chat (docs/invariants.md "Browser").

beforeAll(async () => {
  await initPiLoader();
});

const roots: string[] = [];
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function ev(toolName: string, toolCallId: string, input: Record<string, unknown> = {}): ToolCallEvent {
  return { type: 'tool_call', toolName, toolCallId, input } as unknown as ToolCallEvent;
}

type PermissionRequest = Extract<ExtensionToWebviewMessage, { type: 'requestPermission' }>;
const SERVED = { url: 'http://dddddddddddddddddddddddddddddddd.localhost:5003/__damocles_preview/open?t=x&p=a.html', origin: 'http://dddddddddddddddddddddddddddddddd.localhost:5003' };

function temp(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

/** A chat in a fresh project whose settings hold `permissions`, with pages outside it; its webview records each prompt and leaves it open. */
function chat(opts: { mode?: 'default' | 'acceptEdits' | 'plan'; yolo?: boolean; permissions?: Record<string, string[]>; files?: ChatServedFiles; home?: string } = {}) {
  const workspace = temp('dam-folder-proj-');
  const outside = temp('dam-folder-out-');
  fs.mkdirSync(path.join(workspace, '.damocles'));
  fs.writeFileSync(path.join(workspace, '.damocles', 'settings.local.json'), JSON.stringify({ permissions: opts.permissions ?? {} }));
  const handler = new PermissionHandler(createFakePlatform(), getPiCodingAgent);
  handler.setWorkspacePath(workspace);
  handler.setCwd(workspace);
  handler.setPermissionMode(opts.mode ?? 'default');
  handler.setDangerouslySkipPermissions(opts.yolo ?? false);
  const posted: ExtensionToWebviewMessage[] = [];
  handler.setPostMessage((msg) => { posted.push(msg); });
  const prompts = (): PermissionRequest[] => posted.filter((msg): msg is PermissionRequest => msg.type === 'requestPermission');
  const serve = vi.fn(async () => SERVED);
  const host = opts.home === undefined ? undefined : { platform: process.platform, env: process.env, home: opts.home, drives: [] };
  const files = opts.files ?? new ChatServedFiles({ roots: () => ({ project: workspace, designs: [] }), serve, ...(host !== undefined ? { host } : {}) });
  const panel = {
    permissionHandler: handler,
    isPlanMode: () => handler.turnPermissionMode() === 'plan',
    shellCancel: new ShellCancelStore().forContext(() => undefined),
    machine: { platform: process.platform, allowedNetworkHosts: () => Promise.resolve(new Set<string>()) },
    browserFiles: files,
  } as unknown as PanelGateContext;
  const page = (name = 'a.html'): string => pathToFileURL(path.join(outside, name)).href;
  return { panel, handler, prompts, posted, files, serve, workspace, outside, page };
}

const card = (prompt: PermissionRequest | undefined) => ({
  title: prompt?.title && englishText(prompt.title),
  subtitle: prompt?.subtitle && englishText(prompt.subtitle),
  facts: prompt?.facts?.map((fact) => `${englishText(fact.label)}: ${fact.value}${fact.note ? ` · ${englishText(fact.note)}` : ''}`),
  approvedStatus: prompt?.approvedStatus && englishText(prompt.approvedStatus),
});

async function answered(c: ReturnType<typeof chat>, call: ToolCallEvent, yes: boolean, message?: string) {
  const pending = runPermissionGate(call, c.panel, undefined);
  await expect.poll(() => c.prompts().some((prompt) => prompt.toolUseId === call.toolCallId)).toBe(true);
  await c.handler.resolveApproval(call.toolCallId, yes, message !== undefined ? { customMessage: message } : undefined);
  return pending;
}

describe('a file page outside the chat\'s folders asks, and the call the gate lets run grants its folder', () => {
  it('asks once naming the action, the file and the folder; Yes serves the folder to this chat and later pages there run unasked', async () => {
    const c = chat();
    expect(await c.files.localTarget(c.page())).toMatchObject({ refused: expect.stringContaining('asks the user') });
    expect(await answered(c, ev('BrowserOpen', 'o1', { url: c.page() }), true)).toBeUndefined();
    expect(card(c.prompts()[0])).toEqual({
      title: 'Open a page outside this chat\'s folders?',
      subtitle: 'the page can read every file in its folder and its subfolders until the chat closes',
      facts: [`File: ${path.join(c.outside, 'a.html')}`, `Folder served: ${c.outside}`],
      approvedStatus: `Allowed. This chat's browser serves ${c.outside} until the chat closes.`,
    });
    // only Yes and No: no rule is offered, so nothing outlives the chat
    expect(c.prompts()[0]?.suggestions).toBeUndefined();
    expect(await c.files.localTarget(c.page())).toEqual({ url: SERVED.url });
    expect(c.serve).toHaveBeenCalledWith({ kind: 'folder', folder: c.outside, relPath: 'a.html' }, c.outside);
    expect(await runPermissionGate(ev('BrowserNavigate', 'o2', { url: pathToFileURL(path.join(c.outside, 'sub', 'b.html')).href }), c.panel, undefined)).toBeUndefined();
    expect(await runPermissionGate(ev('BrowserTabs', 'o3', { action: 'new', url: c.page('c.html') }), c.panel, undefined)).toBeUndefined();
    expect(c.prompts()).toHaveLength(1);
  });

  it('names BrowserNavigate\'s and a new tab\'s action, and asks a second chat for the same folder', async () => {
    const c = chat();
    await answered(c, ev('BrowserNavigate', 'n1', { url: c.page() }), false);
    const other = chat();
    await answered(other, ev('BrowserTabs', 'n2', { action: 'new', url: other.page() }), false);
    expect(card(c.prompts()[0]).title).toBe('Go to a page outside this chat\'s folders?');
    expect(card(other.prompts()[0]).title).toBe('Open a tab with a page outside this chat\'s folders?');
    // a tab listing or a web page loads no file
    expect(await runPermissionGate(ev('BrowserTabs', 'n3', { action: 'list', url: c.page() }), c.panel, undefined)).toBeUndefined();
    expect(await runPermissionGate(ev('BrowserOpen', 'n4', { url: 'https://example.com/' }), c.panel, undefined)).toBeUndefined();
    expect(c.prompts()).toHaveLength(1);
  });

  it('gives a No the user\'s reason and grants nothing', async () => {
    const c = chat();
    const result = await answered(c, ev('BrowserOpen', 'd1', { url: c.page() }), false, 'not that folder');
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(FEEDBACK_MARKER);
    expect(result?.reason).toContain('not that folder');
    expect(await c.files.localTarget(c.page())).toMatchObject({ refused: expect.stringContaining('asks the user') });
  });

  it('blocks it under a deny rule with no card and no grant', async () => {
    const c = chat({ permissions: { deny: ['BrowserOpen'] } });
    const result = await runPermissionGate(ev('BrowserOpen', 'r1', { url: c.page() }), c.panel, undefined);
    expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
    expect(c.prompts()).toEqual([]);
    expect(await c.files.localTarget(c.page())).toMatchObject({ refused: expect.stringContaining('asks the user') });
  });

  it('runs it unasked and grants the folder under an allow rule naming the tool, and under YOLO', async () => {
    for (const c of [chat({ permissions: { allow: ['BrowserOpen'] } }), chat({ yolo: true })]) {
      expect(await runPermissionGate(ev('BrowserOpen', 'a1', { url: c.page() }), c.panel, undefined)).toBeUndefined();
      expect(c.prompts()).toEqual([]);
      expect(await c.files.localTarget(c.page())).toEqual({ url: SERVED.url });
    }
  });

  it('asks in plan mode and acceptEdits, and under an ask rule even inside a granted folder', async () => {
    for (const mode of ['plan', 'acceptEdits'] as const) {
      const c = chat({ mode });
      expect(await answered(c, ev('BrowserOpen', `m-${mode}`, { url: c.page() }), true)).toBeUndefined();
    }
    const asked = chat({ permissions: { ask: ['BrowserNavigate'] } });
    asked.files.grant(asked.outside);
    expect(await answered(asked, ev('BrowserNavigate', 'k1', { url: asked.page() }), true)).toBeUndefined();
  });

  it('keeps the card open when the mode turns to acceptEdits, and YOLO approves it and grants the folder', async () => {
    const c = chat();
    const pending = runPermissionGate(ev('BrowserOpen', 'y1', { url: c.page() }), c.panel, undefined);
    await expect.poll(() => c.prompts().length).toBe(1);
    c.handler.setPermissionMode('acceptEdits');
    expect(c.posted.some((msg) => msg.type === 'permissionAutoResolved')).toBe(false);
    c.handler.setDangerouslySkipPermissions(true);
    expect(await pending).toBeUndefined();
    expect(await c.files.localTarget(c.page())).toEqual({ url: SERVED.url });
  });

  it('decides with a Read rule on the page too: a Read deny blocks, a Read ask asks, a Read allow grants nothing', async () => {
    const denied = chat({ permissions: { allow: ['BrowserOpen'], deny: ['Read(//**/secret.html)'] } });
    const blocked = await runPermissionGate(ev('BrowserOpen', 'rd1', { url: denied.page('secret.html') }), denied.panel, undefined);
    expect(blocked?.reason).toContain(POLICY_BLOCK_MARKER);
    // a granted folder's page is decided by the Read rule too
    denied.files.grant(denied.outside);
    expect((await runPermissionGate(ev('BrowserOpen', 'rd2', { url: denied.page('secret.html') }), denied.panel, undefined))?.block).toBe(true);
    const asked = chat({ permissions: { allow: ['BrowserOpen'], ask: ['Read(//**/a.html)'] } });
    expect(await answered(asked, ev('BrowserOpen', 'ra1', { url: asked.page() }), true)).toBeUndefined();
    const allowed = chat({ permissions: { allow: ['Read'] } });
    expect(await answered(allowed, ev('BrowserOpen', 'rl1', { url: allowed.page() }), true)).toBeUndefined();
  });

  it('grants the folder a PreToolUse hook\'s allow lets through', async () => {
    const c = chat();
    const allow: ToolCallHookResult = { decision: 'allow', mutated: false, finalInput: {}, systemMessages: [], anyFailed: false };
    const hooks = { run: vi.fn(async () => allow), onDecision: vi.fn(), notify: vi.fn(), stashContext: vi.fn() };
    expect(await runPermissionGate(ev('BrowserOpen', 'h1', { url: c.page() }), c.panel, undefined, null, hooks)).toBeUndefined();
    expect(c.prompts()).toEqual([]);
    expect(await c.files.localTarget(c.page())).toEqual({ url: SERVED.url });
  });

  it('lets a nested agent\'s approval grant the folder to the chat its browser belongs to', async () => {
    const c = chat();
    const nested = { ...c.panel, readOnlyShell: true } as PanelGateContext;
    const pending = runPermissionGate(ev('BrowserOpen', 's1', { url: c.page() }), nested, undefined, 'agent-call-1');
    await expect.poll(() => c.prompts().length).toBe(1);
    await c.handler.resolveApproval('s1', true);
    expect(await pending).toBeUndefined();
    expect(await runPermissionGate(ev('BrowserOpen', 's2', { url: c.page('b.html') }), c.panel, undefined)).toBeUndefined();
    expect(c.prompts()).toHaveLength(1);
  });

  it('refuses a folder that can never be granted with no card, telling the agent to move the page, under YOLO too', async () => {
    const home = temp('dam-folder-home-');
    fs.mkdirSync(path.join(home, '.ssh'));
    fs.mkdirSync(path.join(home, 'pages'));
    for (const yolo of [false, true]) {
      const c = chat({ home, yolo });
      for (const [id, page] of [['b1', path.join(home, 'a.html')], ['b2', path.join(home, '.ssh', 'x.html')], ['b3', path.join(path.parse(home).root, 'a.html')]] as const) {
        const result = await runPermissionGate(ev('BrowserOpen', id, { url: pathToFileURL(page).href }), c.panel, undefined);
        expect(result?.reason, page).toContain(POLICY_BLOCK_MARKER);
        expect(result?.reason, page).toMatch(/Move the page/);
      }
      expect(c.prompts()).toEqual([]);
    }
    // a folder whose canonical path is a hidden one is refused too
    const linked = path.join(home, 'pages', 'link');
    fs.symlinkSync(path.join(home, '.ssh'), linked, process.platform === 'win32' ? 'junction' : 'dir');
    const c = chat({ home });
    const result = await runPermissionGate(ev('BrowserOpen', 'b4', { url: pathToFileURL(path.join(linked, 'x.html')).href }), c.panel, undefined);
    expect(result?.reason).toMatch(/hidden folder/);
    expect(c.prompts()).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('asks once for a page on a share or a mapped drive, the network facts and the folder on one card, touching nothing there', async () => {
    const c = chat();
    canonicalized.length = 0;
    dosDevices.set('Q:', String.raw`\Device\LanmanRedirector\;Q:000000000004111a\192.0.2.7\data`);
    realpaths.set('\\\\192.0.2.10\\share\\reports', '\\\\192.0.2.10\\share\\reports');
    realpaths.set('q:\\team\\week', '\\\\192.0.2.7\\data\\team\\week');
    realpaths.set('q:\\team\\dot', '\\\\192.0.2.7\\data\\.secret');
    try {
      expect(await answered(c, ev('BrowserOpen', 'u1', { url: 'file://192.0.2.10/share/reports/x.html' }), true)).toBeUndefined();
      expect(await answered(c, ev('BrowserNavigate', 'u2', { url: 'Q:\\team\\week\\y.html' }), true)).toBeUndefined();
      // the folder is resolved only after the yes, and one whose real path is a hidden folder is not served
      const hidden = await answered(c, ev('BrowserNavigate', 'u5', { url: 'Q:\\team\\dot\\z.html' }), true);
      expect(hidden?.reason).toMatch(/hidden folder/);
      expect(c.files.grantedFile('Q:\\team\\dot\\z.html')).toBeUndefined();
    } finally {
      dosDevices.delete('Q:');
      realpaths.clear();
    }
    // a granted network folder is served from the real path Windows answers for it, which the server's pin compares
    expect(await c.files.localTarget('Q:\\team\\week\\y.html')).toEqual({ url: SERVED.url });
    expect(c.serve).toHaveBeenLastCalledWith({ kind: 'folder', folder: '\\\\192.0.2.7\\data\\team\\week', relPath: 'y.html' }, '\\\\192.0.2.7\\data\\team\\week');
    expect(canonicalized.filter((target) => /192\.0\.2|^Q:/i.test(target))).toEqual([]);
    expect(c.prompts()).toHaveLength(3);
    expect(card(c.prompts()[0])).toEqual({
      title: 'Open a page on 192.0.2.10?',
      subtitle: 'opening it sends your Windows sign-in to that computer',
      facts: ['URL: file://192.0.2.10/share/reports/x.html', 'Computer: 192.0.2.10', 'Folder served: \\\\192.0.2.10\\share\\reports · the page can read every file in it and its subfolders until the chat closes'],
      approvedStatus: 'Allowed once. Your Windows sign-in goes to 192.0.2.10. This chat\'s browser serves \\\\192.0.2.10\\share\\reports until the chat closes.',
    });
    expect(card(c.prompts()[1]).facts).toEqual(['URL: Q:\\team\\week\\y.html', 'Computer: 192.0.2.7', 'Folder served: Q:\\team\\week · the page can read every file in it and its subfolders until the chat closes']);
    // the grant answers the folder question only: a later page there still asks about the computer, with no folder fact
    expect(await answered(c, ev('BrowserOpen', 'u3', { url: 'file://192.0.2.10/share/reports/z.html' }), true)).toBeUndefined();
    expect(card(c.prompts()[3]).facts).toEqual(['URL: file://192.0.2.10/share/reports/z.html', 'Computer: 192.0.2.10']);
    // a share's root is never granted, so it is refused without a card
    const root = await runPermissionGate(ev('BrowserOpen', 'u4', { url: 'file://192.0.2.10/share/x.html' }), c.panel, undefined);
    expect(root?.reason).toMatch(/root of a drive, share/);
    expect(c.prompts()).toHaveLength(4);
  });

  it.runIf(process.platform === 'win32')('asks for a page in the temp folder spelled with an 8.3 name, as its canonical path is no data store', async () => {
    const c = chat();
    // the temp folder as Windows gives it, which may spell the user's folder by its 8.3 name
    const short = path.join(os.tmpdir(), path.relative(fs.realpathSync.native(os.tmpdir()), c.outside));
    expect(await answered(c, ev('BrowserOpen', 'v1', { url: `${short}\\a.html` }), true)).toBeUndefined();
    expect(c.prompts()).toHaveLength(1);
  });

  // ProgramData's 8.3 alias, where the system drive has 8.3 names
  const programData = process.env['ProgramData'] ?? 'C:\\ProgramData';
  const programDataAlias = path.join(path.parse(programData).root, 'PROGRA~3');
  const aliased = process.platform === 'win32' && fs.existsSync(programDataAlias) && fs.realpathSync.native(programDataAlias).toLowerCase() === programData.toLowerCase();
  it.runIf(aliased)('refuses a page under an 8.3 alias of ProgramData through its canonical path, with no card', async () => {
    const c = chat();
    const refused = await runPermissionGate(ev('BrowserOpen', 'v2', { url: `${programDataAlias}\\damocles-x\\a.html` }), c.panel, undefined);
    expect(refused?.reason).toContain(`lies inside ${programData},`);
    expect(c.prompts()).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('refuses every Windows spelling of the home folder', async () => {
    const home = temp('dam-folder-home-');
    const c = chat({ home });
    const parsed = path.parse(home);
    // the temp folder as Windows gives it, which may spell the user's folder by its 8.3 name
    const short = path.join(os.tmpdir(), path.relative(fs.realpathSync.native(os.tmpdir()), home));
    const spellings = [`${home}.`, `${home} `, home.toUpperCase(), `${home}::$INDEX_ALLOCATION`, `\\\\127.0.0.1\\${parsed.root[0]}$${home.slice(2)}`, short];
    for (const [index, folder] of spellings.entries()) {
      const result = await runPermissionGate(ev('BrowserOpen', `w${index}`, { url: `${folder}\\x.html` }), c.panel, undefined);
      expect(result?.reason, folder).toContain(POLICY_BLOCK_MARKER);
    }
    expect(c.prompts()).toEqual([]);
  });
});
