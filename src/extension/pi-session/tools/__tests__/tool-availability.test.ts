import { describe, it, expect, vi } from 'vitest';
import type { PiCodingAgentModule } from '../pi-loader';
import type { PermissionHandler } from '../../permission-handler';
import { buildCustomTools, moduleToolNames } from '../index';
import { MEMORY_PI_TOOL_NAMES } from '../memory-tools';
import { COMPASS_PI_TOOL_NAMES } from '../compass-tools';
import { BROWSER_PI_TOOL_NAMES } from '../browser-tools';
import { BrowserService } from '../../../browser';

vi.mock('../../logger', () => ({ log: vi.fn() }));

function fakePi(): PiCodingAgentModule {
  return {
    defineTool: (tool: unknown) => tool,
    createEditToolDefinition: vi.fn(() => ({ execute: vi.fn() })),
  } as unknown as PiCodingAgentModule;
}

const permissionHandler = { getPermissionMode: () => 'default' } as unknown as PermissionHandler;

function buildNames(opts: Parameters<typeof buildCustomTools>[0]): string[] {
  return buildCustomTools(opts).map((t) => t.name);
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
      // Tools now bind to a per-agent scope built via createAgentScope; the returned handle's methods are
      // only invoked at execute time, so a bare stub is enough to build the (inert) tool definitions.
      browserService: { createAgentScope: () => ({}) } as never,
      getSessionId: () => 'sid',
    });
    for (const tool of BROWSER_PI_TOOL_NAMES) expect(names).toContain(tool);
  });

  it('binds the browser tools to the passed browserScopeId, falling back to the primary scope', () => {
    // Tab isolation lives entirely in WHICH id reaches createAgentScope: a stub that discards the
    // argument would keep every agent collapsed onto the human's tab with the suite still green.
    const scopeIds: string[] = [];
    const browserService = { createAgentScope: (id: string) => { scopeIds.push(id); return {}; } } as never;

    buildNames({ pi: fakePi(), cwd: '/cwd', permissionHandler, browserService, getSessionId: () => 'sid' });
    buildNames({ pi: fakePi(), cwd: '/cwd', permissionHandler, browserService, browserScopeId: 'agent-7', getSessionId: () => 'sid' });

    expect(scopeIds).toEqual([BrowserService.PRIMARY_SCOPE_ID, 'agent-7']);
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
