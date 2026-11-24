import { afterAll, describe, expect, it } from 'vitest';
import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gateVerdict, runPermissionGate, runsUnasked, type PanelGateContext, type PreToolUseHookGate } from '../permission-gate';
import { PermissionHandler } from '../../permission-handler';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { FEEDBACK_MARKER, POLICY_BLOCK_MARKER } from '../../../shared/types/constants';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { ShellCancelStore } from '../tools/shell-cancel-registry';
import { THEME_PI_TOOL_NAMES } from '../tools/theme-tool-specs';
import type { DesignScope } from '../../design/design-write-rule';
import { themeSourceRefusal, type ThemeSourceReach } from '../../themes/sources';
import type { ThemeAssetSource } from '../../../shared/themes/asset-source';
import { getPiCodingAgent } from '../pi-loader';

// The theme tools at the gate (docs/invariants.md "Permissions and plan mode"): they raise their own cards, so with no ask rule
// they run unasked in every mode, plan mode and YOLO included; a deny rule blocks; an ask rule gets the generic card first; a
// design chat or a nested agent never runs them.

function ev(toolName: string, toolCallId: string, input: Record<string, unknown> = {}): ToolCallEvent {
  return { type: 'tool_call', toolName, toolCallId, input } as unknown as ToolCallEvent;
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-gate-theme-'));
afterAll(() => fs.rmSync(workspace, { recursive: true, force: true }));

function writeRules(rules: { allow?: string[]; ask?: string[]; deny?: string[] }): void {
  fs.mkdirSync(path.join(workspace, '.damocles'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.damocles', 'settings.local.json'), JSON.stringify({ permissions: rules }));
}

function clearRules(): void {
  fs.rmSync(path.join(workspace, '.damocles'), { recursive: true, force: true });
}

interface Setup {
  readonly mode?: 'default' | 'acceptEdits' | 'plan';
  readonly yolo?: boolean;
  readonly readOnlyShell?: boolean;
  readonly design?: boolean;
  // a design chat whose role entry does not parse
  readonly unreadableDesign?: boolean;
  readonly reach?: ThemeSourceReach;
}

const ON: ThemeSourceReach = { webSearch: true, imageGeneration: 'on' };

function gate(setup: Setup = {}, answer = true) {
  const handler = new PermissionHandler(createFakePlatform(), getPiCodingAgent);
  handler.setWorkspacePath(workspace);
  handler.setCwd(workspace);
  handler.setPermissionMode(setup.mode ?? 'default');
  handler.setDangerouslySkipPermissions(setup.yolo ?? false);
  const prompts: Array<Extract<ExtensionToWebviewMessage, { type: 'requestPermission' }>> = [];
  handler.setPostMessage((msg) => {
    if (msg.type !== 'requestPermission') return;
    prompts.push(msg);
    void handler.resolveApproval(msg.toolUseId, answer);
  });
  const panel = {
    permissionHandler: handler,
    isPlanMode: () => setup.mode === 'plan',
    shellCancel: new ShellCancelStore().forContext(() => undefined),
    ...(setup.readOnlyShell ? { readOnlyShell: true } : {}),
    ...(setup.design ? { designScope: () => ({ folder: workspace, cwd: workspace } as unknown as DesignScope) } : {}),
    ...(setup.unreadableDesign ? { designScope: (): DesignScope => ({ unreadable: true }) } : {}),
    themeSourceRefusal: (source: ThemeAssetSource) => themeSourceRefusal(source, setup.reach ?? ON),
    postMessage: () => undefined,
  } as unknown as PanelGateContext;
  return { panel, handler, prompts };
}

function expectPolicyBlock(result: Awaited<ReturnType<typeof runPermissionGate>>, words: string): void {
  expect(result?.block).toBe(true);
  expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
  expect(result?.reason).not.toContain(FEEDBACK_MARKER);
  expect(result?.reason).toContain(words);
}

// A user's no with no feedback: worded as the user's, and it ends the turn.
function expectUserDeny(result: Awaited<ReturnType<typeof runPermissionGate>>): void {
  expect(result?.block).toBe(true);
  expect(result?.reason).not.toContain(POLICY_BLOCK_MARKER);
  expect(result?.reason).toContain("The user doesn't want to proceed");
  expect(result?.terminate).toBe(true);
}

// A PreToolUse hook that force-allows every call.
function allowingHook(): PreToolUseHookGate {
  return {
    run: async () => ({ decision: 'allow' as const, finalInput: {}, mutated: false, anyFailed: false, systemMessages: [] }),
    onDecision: () => undefined,
    notify: () => undefined,
    stashContext: () => undefined,
  };
}

const MODES: Array<{ name: string; setup: Setup }> = [
  { name: 'default', setup: { mode: 'default' } },
  { name: 'acceptEdits', setup: { mode: 'acceptEdits' } },
  { name: 'plan', setup: { mode: 'plan' } },
  { name: 'YOLO', setup: { mode: 'default', yolo: true } },
  { name: 'plan with YOLO', setup: { mode: 'plan', yolo: true } },
  { name: 'a read-only agent', setup: { mode: 'default', readOnlyShell: true } },
];

describe('the theme tools at the gate', () => {
  for (const { name, setup } of MODES) {
    it(`${name}: every theme tool runs with no generic card and no rule`, async () => {
      clearRules();
      const { panel, prompts } = gate(setup);
      for (const tool of THEME_PI_TOOL_NAMES) {
        expect(await runPermissionGate(ev(tool, `${tool}-1`), panel, undefined), tool).toBeUndefined();
        expect(gateVerdict({ name: tool, input: {}, mcpReadOnly: false, rule: null }, panel)).toEqual({ kind: 'run' });
      }
      expect(prompts).toEqual([]);
    });
  }

  it('a deny rule blocks in every mode outside YOLO, which bypasses rules', async () => {
    writeRules({ deny: ['ThemeSet'] });
    try {
      for (const { name, setup } of MODES.filter((mode) => mode.setup.yolo !== true)) {
        const { panel, prompts } = gate(setup);
        expectPolicyBlock(await runPermissionGate(ev('ThemeSet', `deny-${name}`), panel, undefined), 'Permission denied by a rule in your Damocles settings');
        expect(prompts).toEqual([]);
        expect(await runPermissionGate(ev('ThemeRead', `read-${name}`), panel, undefined), name).toBeUndefined();
      }
      for (const { name, setup } of MODES.filter((mode) => mode.setup.yolo === true)) {
        const { panel, prompts } = gate(setup);
        expect(await runPermissionGate(ev('ThemeSet', `deny-${name}`), panel, undefined), name).toBeUndefined();
        expect(prompts).toEqual([]);
      }
    } finally {
      clearRules();
    }
  });

  it('an ask rule raises the generic card first, in plan mode too; a yes lets the call run to its own card, a no blocks it', async () => {
    writeRules({ ask: ['ThemeSet'] });
    try {
      for (const setup of [{ mode: 'default' as const }, { mode: 'plan' as const }]) {
        const yes = gate(setup, true);
        expect(await runPermissionGate(ev('ThemeSet', 'ask-yes'), yes.panel, undefined)).toBeUndefined();
        expect(yes.prompts.map((prompt) => prompt.toolName)).toEqual(['ThemeSet']);
        const no = gate(setup, false);
        expectUserDeny(await runPermissionGate(ev('ThemeSet', 'ask-no'), no.panel, undefined));
        expect(no.prompts).toHaveLength(1);
      }
    } finally {
      clearRules();
    }
  });

  it('an ask rule asks nobody under YOLO, which approves it as any ask', async () => {
    writeRules({ ask: ['ThemeSet'] });
    try {
      const { panel, prompts } = gate({ mode: 'default', yolo: true });
      expect(await runPermissionGate(ev('ThemeSet', 'ask-yolo'), panel, undefined)).toBeUndefined();
      expect(prompts).toEqual([]);
    } finally {
      clearRules();
    }
  });

  it('a design chat never runs them, YOLO and an allow rule included', async () => {
    writeRules({ allow: ['ThemeSet', 'ThemeRead'] });
    try {
      for (const yolo of [false, true]) {
        const { panel, prompts } = gate({ mode: 'default', design: true, yolo });
        for (const tool of THEME_PI_TOOL_NAMES) expectPolicyBlock(await runPermissionGate(ev(tool, `${tool}-design`), panel, undefined), 'A design chat cannot use the theme tools.');
        expect(prompts).toEqual([]);
      }
    } finally {
      clearRules();
    }
  });

  it('a subagent or a team member never runs them, in YOLO either', async () => {
    for (const yolo of [false, true]) {
      const { panel, prompts } = gate({ mode: 'default', yolo });
      for (const tool of THEME_PI_TOOL_NAMES) {
        expectPolicyBlock(await runPermissionGate(ev(tool, `${tool}-nested`), panel, undefined, 'agent-call-1'), 'Only the main chat can use the theme tools');
      }
      expect(prompts).toEqual([]);
    }
  });

  it("a PreToolUse hook's allow lifts neither refusal, in a design chat whose role cannot be read either", async () => {
    clearRules();
    for (const setup of [{ design: true }, { unreadableDesign: true }, { design: true, yolo: true }]) {
      const { panel } = gate({ mode: 'default', ...setup });
      for (const tool of THEME_PI_TOOL_NAMES) {
        expectPolicyBlock(await runPermissionGate(ev(tool, `${tool}-hook-design`), panel, undefined, null, allowingHook()), 'A design chat cannot use the theme tools.');
      }
    }
    const { panel } = gate({ mode: 'default' });
    for (const tool of THEME_PI_TOOL_NAMES) {
      expectPolicyBlock(await runPermissionGate(ev(tool, `${tool}-hook-nested`), panel, undefined, 'agent-call-1', allowingHook()), 'Only the main chat can use the theme tools');
      expect(await runPermissionGate(ev(tool, `${tool}-hook-main`), panel, undefined, null, allowingHook()), tool).toBeUndefined();
    }
  });

  it('a mode or YOLO change re-decides the generic card of an ask rule only, never the theme card behind it', () => {
    const { panel } = gate({ mode: 'plan' });
    expect(runsUnasked({ name: 'ThemeSet', input: {}, mcpReadOnly: false, rule: 'ask' }, panel)).toBe(false);
    expect(runsUnasked({ name: 'ThemeSet', input: {}, mcpReadOnly: false, rule: null }, panel)).toBe(true);
  });
});

// A ThemeSet asset source is consent for reading or fetching, decided before any byte is read: a file as a Read of it, a URL as a
// WebFetch of it, a generation as GenerateImage is (asked in plan mode too), an attachment by nothing but the theme rules.
describe("ThemeSet's asset sources at the gate", () => {
  const setWith = (id: string, from: Record<string, unknown>) => ev('ThemeSet', id, { name: 'Beach', asset: { name: 'beach', from } });
  const PLAIN_MODES = MODES.filter((mode) => mode.setup.yolo !== true && mode.setup.readOnlyShell !== true);

  it('a file source is a Read of it: a Read deny rule blocks it and an ask rule asks, in every mode; with no rule it runs unasked', async () => {
    writeRules({ deny: ['Read(secrets/**)'], ask: ['Read(asked/**)'] });
    try {
      for (const { name, setup } of PLAIN_MODES) {
        const { panel, prompts } = gate(setup);
        expectPolicyBlock(await runPermissionGate(setWith(`deny-${name}`, { file: 'secrets/beach.png' }), panel, undefined), 'Permission denied by a rule in your Damocles settings');
        expect(await runPermissionGate(setWith(`free-${name}`, { file: 'img/beach.png' }), panel, undefined), name).toBeUndefined();
        expect(prompts, name).toEqual([]);
        expect(await runPermissionGate(setWith(`ask-${name}`, { file: 'asked/beach.png' }), panel, undefined), name).toBeUndefined();
        expect(prompts.map((prompt) => prompt.toolName), name).toEqual(['ThemeSet']);
        const no = gate(setup, false);
        expectUserDeny(await runPermissionGate(setWith(`ask-no-${name}`, { file: 'asked/beach.png' }), no.panel, undefined));
      }
    } finally {
      clearRules();
    }
  });

  it('a URL source is a WebFetch of it: a WebFetch domain deny rule blocks it, an ask rule asks, another host runs unasked', async () => {
    writeRules({ deny: ['WebFetch(domain:blocked.example)'], ask: ['WebFetch(domain:asked.example)'] });
    try {
      for (const { name, setup } of PLAIN_MODES) {
        const { panel, prompts } = gate(setup);
        expectPolicyBlock(await runPermissionGate(setWith(`deny-${name}`, { url: 'https://BLOCKED.example./a.png' }), panel, undefined), 'Permission denied by a rule in your Damocles settings');
        expect(await runPermissionGate(setWith(`free-${name}`, { url: 'https://images.other.org/a.png' }), panel, undefined), name).toBeUndefined();
        expect(prompts, name).toEqual([]);
        expect(await runPermissionGate(setWith(`ask-${name}`, { url: 'https://asked.example/a.png' }), panel, undefined), name).toBeUndefined();
        expect(prompts.map((prompt) => prompt.toolName), name).toEqual(['ThemeSet']);
      }
    } finally {
      clearRules();
    }
  });

  it('a URL source with web search off is refused with its reason before any rule asks', async () => {
    writeRules({ ask: ['WebFetch(domain:asked.example)'] });
    try {
      const { panel, prompts } = gate({ mode: 'default', reach: { webSearch: false, imageGeneration: 'on' } });
      expectPolicyBlock(await runPermissionGate(setWith('web-off', { url: 'https://asked.example/a.png' }), panel, undefined), 'downloads a URL only while Web search is on');
      expect(prompts).toEqual([]);
    } finally {
      clearRules();
    }
  });

  it('install is a WebFetch of its URL: a domain deny blocks it, an ask asks, web search off refuses it, and another field makes it undecidable', async () => {
    const install = (id: string, url: string, extra: Record<string, unknown> = {}) => ev('ThemeSet', id, { install: { url }, ...extra });
    writeRules({ deny: ['WebFetch(domain:blocked.example)'], ask: ['WebFetch(domain:asked.example)'] });
    try {
      for (const { name, setup } of PLAIN_MODES) {
        const { panel, prompts } = gate(setup);
        expectPolicyBlock(await runPermissionGate(install(`deny-${name}`, 'https://blocked.example/t.damocles-theme'), panel, undefined), 'Permission denied by a rule in your Damocles settings');
        expect(await runPermissionGate(install(`free-${name}`, 'https://themes.other.org/t.damocles-theme'), panel, undefined), name).toBeUndefined();
        expect(prompts, name).toEqual([]);
        expect(await runPermissionGate(install(`ask-${name}`, 'https://asked.example/t.damocles-theme'), panel, undefined), name).toBeUndefined();
        expect(prompts.map((prompt) => prompt.toolName), name).toEqual(['ThemeSet']);
      }
      const off = gate({ mode: 'default', reach: { webSearch: false, imageGeneration: 'on' } });
      expectPolicyBlock(await runPermissionGate(install('web-off', 'https://themes.other.org/t.damocles-theme'), off.panel, undefined), 'downloads a URL only while Web search is on');
      const { panel } = gate({ mode: 'default', reach: ON });
      expectPolicyBlock(await runPermissionGate(install('mixed', 'https://themes.other.org/t.damocles-theme', { name: 'X' }), panel, undefined), 'could not be approved');
    } finally {
      clearRules();
    }
  });

  it('a theme rule still applies to a source: a ThemeSet deny blocks it and an ask asks, but a ThemeSet allow approves no read', async () => {
    writeRules({ deny: ['ThemeSet'] });
    try {
      const { panel, prompts } = gate({ mode: 'default' });
      for (const [id, from] of [['file', { file: 'img/a.png' }], ['url', { url: 'https://images.other.org/a.png' }], ['generate', { generate: { prompt: 'dunes' } }], ['attachment', { attachment: 1 }]] as const) {
        expectPolicyBlock(await runPermissionGate(setWith(`own-deny-${id}`, from), panel, undefined), 'Permission denied by a rule in your Damocles settings');
      }
      expect(prompts).toEqual([]);
      writeRules({ allow: ['ThemeSet'], ask: ['Read(asked/**)'] });
      const asked = gate({ mode: 'default' });
      expect(await runPermissionGate(setWith('own-allow', { file: 'asked/a.png' }), asked.panel, undefined)).toBeUndefined();
      expect(asked.prompts).toHaveLength(1);
      // the tool's own ask rule asks once for a source that would run unasked, a generation on the image card
      writeRules({ ask: ['ThemeSet'] });
      for (const [from, mode, card] of [[{ file: 'img/a.png' }, 'default', 'ThemeSet'], [{ url: 'https://images.other.org/a.png' }, 'default', 'ThemeSet'], [{ generate: { prompt: 'dunes' } }, 'acceptEdits', 'GenerateImage']] as const) {
        const own = gate({ mode });
        expect(await runPermissionGate(setWith(`own-ask-${card}`, from), own.panel, undefined), JSON.stringify(from)).toBeUndefined();
        expect(own.prompts.map((prompt) => prompt.toolName), JSON.stringify(from)).toEqual([card]);
      }
    } finally {
      clearRules();
    }
  });

  it('a generated image asks on the image card in default and plan mode, naming no file; acceptEdits and YOLO run it unasked', async () => {
    clearRules();
    for (const mode of ['default', 'plan'] as const) {
      const { panel, prompts } = gate({ mode });
      expect(await runPermissionGate(setWith(`gen-${mode}`, { generate: { prompt: 'warm dunes at dusk', aspect: '16:9' } }), panel, undefined), mode).toBeUndefined();
      expect(prompts, mode).toHaveLength(1);
      expect(prompts[0]).toMatchObject({ toolName: 'GenerateImage', prompt: 'warm dunes at dusk\n\nAspect ratio 16:9 (width:height).' });
      expect(prompts[0]!.filePath).toBeUndefined();
      const no = gate({ mode }, false);
      expectUserDeny(await runPermissionGate(setWith(`gen-no-${mode}`, { generate: { prompt: 'dunes' } }), no.panel, undefined));
    }
    for (const setup of [{ mode: 'acceptEdits' as const }, { mode: 'default' as const, yolo: true }, { mode: 'plan' as const, yolo: true }]) {
      const { panel, prompts } = gate(setup);
      expect(await runPermissionGate(setWith('gen-free', { generate: { prompt: 'dunes' } }), panel, undefined), JSON.stringify(setup)).toBeUndefined();
      expect(prompts).toEqual([]);
    }
  });

  it('a GenerateImage deny rule blocks a generated image, an ask rule asks in acceptEdits too, and generation off refuses it unasked', async () => {
    writeRules({ deny: ['GenerateImage'] });
    try {
      const { panel } = gate({ mode: 'acceptEdits' });
      expectPolicyBlock(await runPermissionGate(setWith('gen-deny', { generate: { prompt: 'dunes' } }), panel, undefined), 'Permission denied by a rule in your Damocles settings');
      writeRules({ ask: ['GenerateImage'] });
      const asked = gate({ mode: 'acceptEdits' });
      expect(await runPermissionGate(setWith('gen-ask', { generate: { prompt: 'dunes' } }), asked.panel, undefined)).toBeUndefined();
      expect(asked.prompts.map((prompt) => prompt.toolName)).toEqual(['GenerateImage']);
    } finally {
      clearRules();
    }
    const off = gate({ mode: 'default', reach: { webSearch: true, imageGeneration: 'off' } });
    expectPolicyBlock(await runPermissionGate(setWith('gen-off', { generate: { prompt: 'dunes' } }), off.panel, undefined), 'Image generation is off');
    expect(off.prompts).toEqual([]);
  });

  it('a mode change re-decides an open image card: acceptEdits or YOLO runs it, plan mode keeps asking', () => {
    const call = { name: 'GenerateImage', tool: 'ThemeSet', input: { prompt: 'dunes' }, mcpReadOnly: false, rule: null };
    const { panel, handler } = gate({ mode: 'plan' });
    expect(runsUnasked(call, panel)).toBe(false);
    handler.setPermissionMode('acceptEdits');
    expect(runsUnasked(call, panel)).toBe(true);
    handler.setPermissionMode('default');
    expect(runsUnasked(call, panel)).toBe(false);
    handler.setDangerouslySkipPermissions(true);
    expect(runsUnasked(call, panel)).toBe(true);
  });

  it('sprites, drawn or recolored, need no source judgement: no Read or WebFetch rule asks for them and they run unasked in every mode', async () => {
    writeRules({ ask: ['Read', 'WebFetch', 'GenerateImage'] });
    try {
      const sprites = [
        { name: 'pip', pixels: { palette: ['#ffffff'], frames: [['0']] } },
        { name: 'pop', recolor: { from: { character: 'Pip', state: 'idle' }, map: { '#ffffff': '#ff0000' } } },
      ];
      for (const { name, setup } of MODES) {
        const { panel, prompts } = gate(setup);
        expect(await runPermissionGate(ev('ThemeSet', `sprites-${name}`, { name: 'Pals', sprites, characterEdits: [{ name: 'Pip', idle: 'pip' }] }), panel, undefined), name).toBeUndefined();
        expect(prompts, name).toEqual([]);
      }
      const { panel } = gate({ mode: 'default' });
      expectPolicyBlock(await runPermissionGate(ev('ThemeSet', 'pixels-asset', { name: 'Pals', asset: { name: 'pip', from: { pixels: { palette: ['#ffffff'], frames: [['0']] } } } }), panel, undefined), 'could not be approved');
    } finally {
      clearRules();
    }
  });

  it('an attachment or no source needs no read; a malformed source cannot be approved; a design chat or nested agent never runs a source', async () => {
    clearRules();
    for (const { name, setup } of MODES) {
      const { panel, prompts } = gate(setup);
      expect(await runPermissionGate(setWith(`att-${name}`, { attachment: 1 }), panel, undefined), name).toBeUndefined();
      expect(prompts, name).toEqual([]);
    }
    const { panel } = gate({ mode: 'default' });
    expectPolicyBlock(await runPermissionGate(setWith('two', { file: 'a.png', url: 'https://a.example/a.png' }), panel, undefined), 'could not be approved');
    expectPolicyBlock(await runPermissionGate(setWith('aspect', { generate: { prompt: 'dunes', aspect: '5:4' } }), panel, undefined), 'aspect is one of');
    const design = gate({ mode: 'default', design: true, yolo: true });
    expectPolicyBlock(await runPermissionGate(setWith('design-file', { file: 'img/a.png' }), design.panel, undefined), 'A design chat cannot use the theme tools.');
    expectPolicyBlock(await runPermissionGate(setWith('nested-url', { url: 'https://images.other.org/a.png' }), panel, undefined, 'agent-call-1'), 'Only the main chat can use the theme tools');
  });
});
