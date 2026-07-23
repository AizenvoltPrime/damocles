import { describe, it, expect } from 'vitest';
import { FULL_TOOL_CATALOG, GATEABLE_MODULE_NAMES } from '../tool-catalog';
import { MEMORY_PI_TOOL_NAMES } from '../memory-tools';
import { COMPASS_PI_TOOL_NAMES } from '../compass-tools';
import { BROWSER_PI_TOOL_NAMES } from '../browser-tools';
import { TEAM_MAIN_PI_TOOL_NAMES, TEAM_AGENT_PI_TOOL_NAMES } from '../team-tools';
import { CUSTOM_TOOL_NAMES } from '../index';
import { PI_TOOL_NAME_MAP } from '../../tool-normalization';
import { WEB_TOOLS, PLAN_MODE_INTERACTIVE_TOOLS } from '../../pi-models';
import { TOOL_BROWSER_REQUEST_INPUT } from '../../../../shared/tool-names';

const MODULE_NAMES = [...MEMORY_PI_TOOL_NAMES, ...COMPASS_PI_TOOL_NAMES, ...BROWSER_PI_TOOL_NAMES];
const TEAM_NAMES = [...TEAM_MAIN_PI_TOOL_NAMES, ...TEAM_AGENT_PI_TOOL_NAMES];

describe('FULL_TOOL_CATALOG', () => {
  const catalogNames = FULL_TOOL_CATALOG.map((e) => e.name);

  it('contains every module tool name', () => {
    for (const name of MODULE_NAMES) {
      expect(catalogNames).toContain(name);
    }
  });

  it('has unique names', () => {
    expect(new Set(catalogNames).size).toBe(catalogNames.length);
  });

  it('names every module tool in PascalCase', () => {
    for (const name of MODULE_NAMES) {
      expect(name, `${name} is not PascalCase`).toMatch(/^[A-Z][A-Za-z]*$/);
    }
  });

  it('keeps module names collision-free against every webview-known display name', () => {
    const knownDisplayNames = new Set<string>([
      ...Object.values(PI_TOOL_NAME_MAP),
      ...CUSTOM_TOOL_NAMES,
      ...FULL_TOOL_CATALOG.filter((e) => e.group === 'core').map((e) => e.name),
    ]);
    for (const name of MODULE_NAMES) {
      expect(knownDisplayNames.has(name), `${name} collides with a known display name`).toBe(false);
    }
  });

  it('marks core tools as non-toggleable and module/web tools as toggleable', () => {
    for (const entry of FULL_TOOL_CATALOG) {
      expect(entry.toggleable).toBe(entry.group !== 'core');
    }
  });
});

describe('MEMORY_PI_TOOL_NAMES — Slice 16 new tools', () => {
  const NEW_NAMES = ['UnforgetMemory', 'UpdateMemory'];

  // The exact set (not a bare count) documents intent: adding/removing a tool is a deliberate edit
  // here, and duplicates/typos in MEMORY_SPECS fail loudly instead of passing a stale number.
  const EXPECTED_MEMORY_TOOLS = [
    'SaveObservation', 'SearchMemories', 'GetMemoryDetails', 'SaveMemory', 'SaveNote', 'ListNotes',
    'ResetObservationStaleness', 'ForgetMemory', 'GetMemoryHistory', 'GetRelatedMemories',
    'UnforgetMemory', 'UpdateMemory',
  ];

  it('exposes exactly the expected memory tools (no dupes, no drift)', () => {
    expect([...MEMORY_PI_TOOL_NAMES].sort()).toEqual([...EXPECTED_MEMORY_TOOLS].sort());
    expect(new Set(MEMORY_PI_TOOL_NAMES).size).toBe(MEMORY_PI_TOOL_NAMES.length);
  });

  it('includes the new tools, PascalCase and gateable', () => {
    for (const name of NEW_NAMES) {
      expect(MEMORY_PI_TOOL_NAMES).toContain(name);
      expect(name, `${name} is not PascalCase`).toMatch(/^[A-Z][A-Za-z]*$/);
      expect(GATEABLE_MODULE_NAMES.has(name)).toBe(true);
    }
  });
});

describe('GATEABLE_MODULE_NAMES', () => {
  it('equals memory + compass + browser + team coordination tools exactly', () => {
    expect([...GATEABLE_MODULE_NAMES].sort()).toEqual([...MODULE_NAMES, ...TEAM_NAMES].sort());
  });

  it('auto-allows every team coordination tool (no fs/shell — gated like module tools)', () => {
    for (const name of TEAM_NAMES) {
      expect(GATEABLE_MODULE_NAMES.has(name)).toBe(true);
    }
  });

  it('excludes the web tools (auto-allowed as reads, not module-gated)', () => {
    for (const name of WEB_TOOLS) {
      expect(GATEABLE_MODULE_NAMES.has(name)).toBe(false);
    }
  });
});

describe('BrowserRequestInput (Slice 4)', () => {
  it('is a gateable module tool (auto-allowed at the pi tool_call gate)', () => {
    expect(GATEABLE_MODULE_NAMES.has(TOOL_BROWSER_REQUEST_INPUT)).toBe(true);
  });

  it('is registered in the browser tool catalog + names', () => {
    expect(BROWSER_PI_TOOL_NAMES).toContain(TOOL_BROWSER_REQUEST_INPUT);
    expect(FULL_TOOL_CATALOG.map((e) => e.name)).toContain(TOOL_BROWSER_REQUEST_INPUT);
  });

  it('is NOT a plan-mode interactive tool (form-fill must not run while planning)', () => {
    expect(PLAN_MODE_INTERACTIVE_TOOLS).not.toContain(TOOL_BROWSER_REQUEST_INPUT);
  });
});
