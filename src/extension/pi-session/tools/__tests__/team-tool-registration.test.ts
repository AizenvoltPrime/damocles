import { describe, expect, it } from 'vitest';
import { TEAM_TOOL_LABELS, TEAM_TOOL_PRESENTATION } from '@shared/team-tool-labels';
import {
  TEAM_AGENT_PI_TOOL_NAMES,
  TEAM_MAIN_PI_TOOL_NAMES,
  TEAM_TOOL_CATALOG,
} from '../team-tools';

/**
 * The seam between what the extension registers and what the shared presentation table can render.
 * It lives on the extension side because it reads both, and `src/shared` is compiled for the webview
 * bundle, which cannot import from the extension host. The table's own behaviour is tested next to it,
 * in `src/shared/__tests__/team-tool-labels.test.ts`.
 */

/** Spelled out rather than derived, so removing a tool from team-tools.ts fails here instead of shrinking the expectation with it. */
const EXPECTED_MAIN_NAMES: readonly string[] = ['cancel_team', 'create_team', 'get_team_status'];

const EXPECTED_AGENT_NAMES: readonly string[] = [
  'team_approve_specialist',
  'team_cancel_specialist',
  'team_flag_brief_conflict',
  'team_get_status',
  'team_read_messages',
  'team_read_scratchpad',
  'team_record_verification',
  'team_redispatch_specialist',
  'team_report_complete',
  'team_request_revision',
  'team_resolve_brief_conflict',
  'team_send_message',
  'team_spawn_specialist',
  'team_standby',
  'team_synthesize_result',
  'team_write_scratchpad',
];

const registeredNames: readonly string[] = [...TEAM_MAIN_PI_TOOL_NAMES, ...TEAM_AGENT_PI_TOOL_NAMES];

describe('registered team tools and the shared presentation table', () => {
  it('holds a label and both card summaries for every team tool name the extension registers', () => {
    expect(registeredNames).toHaveLength(19);
    const unlabelled = registeredNames.filter((name) => TEAM_TOOL_LABELS[name] === undefined);
    expect(unlabelled).toEqual([]);
    const unsummarized = registeredNames.filter((name) => {
      const presentation = TEAM_TOOL_PRESENTATION[name];
      return typeof presentation?.summarizeInput !== 'function' || typeof presentation.summarizeResult !== 'function';
    });
    expect(unsummarized).toEqual([]);
  });

  it('is measured against the full team tool set, main tools and agent tools', () => {
    expect([...TEAM_MAIN_PI_TOOL_NAMES].sort()).toEqual([...EXPECTED_MAIN_NAMES].sort());
    expect([...TEAM_AGENT_PI_TOOL_NAMES].sort()).toEqual([...EXPECTED_AGENT_NAMES].sort());
  });

  it('holds no entry for a name nothing registers', () => {
    const registered = new Set(registeredNames);
    const orphans = Object.keys(TEAM_TOOL_PRESENTATION).filter((name) => !registered.has(name));
    expect(orphans).toEqual([]);
    expect(Object.keys(TEAM_TOOL_LABELS)).toEqual(Object.keys(TEAM_TOOL_PRESENTATION));
  });

  it('is the one table: the Tools panel catalog reads its labels from here', () => {
    expect(TEAM_TOOL_CATALOG).toHaveLength(19);
    for (const entry of TEAM_TOOL_CATALOG) {
      expect(entry.label, `catalog label for ${entry.name}`).toBe(TEAM_TOOL_LABELS[entry.name]);
    }
  });
});
