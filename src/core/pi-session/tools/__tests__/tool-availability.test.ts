import { describe, it, expect, vi } from 'vitest';
import type { PiCodingAgentModule } from '../../pi-loader';
import type { PermissionHandler } from '../../../permission-handler';
import { buildCustomTools, moduleToolNames } from '../index';
import { ShellCancelStore } from '../shell-cancel-registry';
import { MEMORY_PI_TOOL_NAMES } from '../memory-tools';
import { COMPASS_PI_TOOL_NAMES } from '../compass-tools';
import { BROWSER_PI_TOOL_NAMES } from '../browser-tools';

vi.mock('../../../logger', () => ({ log: vi.fn() }));

function fakePi(): PiCodingAgentModule {
  return {
    defineTool: (tool: unknown) => tool,
    createEditToolDefinition: vi.fn(() => ({ execute: vi.fn() })),
    // The shell and search overrides spread their metadata from a pi definition, so these stubs must
    // answer with a whole definition, not just an `execute`.
    createBashToolDefinition: vi.fn(() => ({ name: 'bash', label: 'Bash', description: 'pi bash', parameters: {}, execute: vi.fn() })),
    createPowerShellToolDefinition: vi.fn(() => ({ name: 'powershell', label: 'powershell', description: 'pi powershell', parameters: {}, execute: vi.fn() })),
    createGrepToolDefinition: vi.fn(() => ({ name: 'grep', label: 'grep', description: 'pi grep', parameters: {}, execute: vi.fn() })),
    createFindToolDefinition: vi.fn(() => ({ name: 'find', label: 'find', description: 'pi find', parameters: {}, execute: vi.fn() })),
  } as unknown as PiCodingAgentModule;
}

const permissionHandler = { getPermissionMode: () => 'default' } as unknown as PermissionHandler;

type ToolNameOpts = Omit<Parameters<typeof buildCustomTools>[0], 'getShellOptions' | 'shellCancel' | 'deliverUserNote' | 'shellJob'>;

/** The shell deps are required of every caller but say nothing here: this file asserts name sets. */
function buildNames(opts: ToolNameOpts): string[] {
  return buildCustomTools({ ...opts, getShellOptions: () => ({}), shellCancel: new ShellCancelStore(), deliverUserNote: () => undefined, shellJob: undefined }).map((t) => t.name);
}

describe('buildCustomTools — build gate is service-presence, not enablement', () => {
  it('builds memory tools when the service is present EVEN IF the subsystem is disabled', () => {
    const names = buildNames({
      pi: fakePi(),
      cwd: '/cwd',
      permissionHandler,
      memoryService: { isEnabled: false } as never,
      getSessionId: () => 'sid',
    });
    for (const tool of MEMORY_PI_TOOL_NAMES) expect(names).toContain(tool);
  });

  it('builds browser tools whenever the (inert) browser service is present', () => {
    const names = buildNames({
      pi: fakePi(),
      cwd: '/cwd',
      permissionHandler,
      // Tools bind to a scope handle whose methods are only invoked at execute time, so a bare stub is
      // enough to build the (inert) tool definitions.
      browserService: { createAgentScope: () => ({}), chatScope: () => ({}) } as never,
      getSessionId: () => 'sid',
    });
    for (const tool of BROWSER_PI_TOOL_NAMES) expect(names).toContain(tool);
  });

  it("binds the browser tools to the passed browserScopeId, falling back to the chat's human scope", () => {
    // Tab isolation lives entirely in WHICH scope the tools bind to: a stub that discards the arguments
    // would keep every agent collapsed onto the human's tab with the suite still green.
    const scopes: unknown[][] = [];
    const browserService = {
      createAgentScope: (id: string, chat: unknown) => { scopes.push(['agent', id, chat]); return {}; },
      chatScope: (chat: unknown) => { scopes.push(['chat', chat]); return {}; },
    } as never;
    const browserChat = { chat: 'host' } as never;

    buildNames({ pi: fakePi(), cwd: '/cwd', permissionHandler, browserService, browserChat, getSessionId: () => 'sid' });
    buildNames({ pi: fakePi(), cwd: '/cwd', permissionHandler, browserService, browserScopeId: 'agent-7', browserChat, getSessionId: () => 'sid' });

    expect(scopes).toEqual([['chat', browserChat], ['agent', 'agent-7', browserChat]]);
  });

  it('omits module tools only when the service object is absent', () => {
    const names = buildNames({ pi: fakePi(), cwd: '/cwd', permissionHandler, getSessionId: () => 'sid' });
    for (const tool of [...MEMORY_PI_TOOL_NAMES, ...COMPASS_PI_TOOL_NAMES, ...BROWSER_PI_TOOL_NAMES]) {
      expect(names).not.toContain(tool);
    }
  });
});

describe('moduleToolNames — active membership is live-enabled state', () => {
  it('includes a subsystem only when it is live-enabled', () => {
    const names = moduleToolNames({
      memoryService: { isEnabled: true } as never,
      compassService: { isEnabled: false } as never,
      browserEnabled: false,
    });
    for (const tool of MEMORY_PI_TOOL_NAMES) expect(names).toContain(tool);
    for (const tool of COMPASS_PI_TOOL_NAMES) expect(names).not.toContain(tool);
    for (const tool of BROWSER_PI_TOOL_NAMES) expect(names).not.toContain(tool);
  });

  it('gates browser membership on the passed-in browserEnabled flag, not service presence', () => {
    const enabled = moduleToolNames({ browserEnabled: true });
    for (const tool of BROWSER_PI_TOOL_NAMES) expect(enabled).toContain(tool);
    const disabled = moduleToolNames({ browserEnabled: false });
    for (const tool of BROWSER_PI_TOOL_NAMES) expect(disabled).not.toContain(tool);
  });
});
