import { describe, it, expect } from 'vitest';
import {
  buildMcpServerConfig,
  createArgRow,
  createEmptyFormState,
  createKeyValueRow,
  isMcpFormValid,
  submittedServerName,
  validateMcpServerForm,
  type McpServerFormState,
} from '../mcp-server-form-logic';

/** Form args are identified rows; the built config is still a plain string[]. */
const argRows = (...values: string[]) => values.map((value) => createArgRow(value));

/** Env and header rows carry a stable id, minted the same way the form mints one. */
const kvRows = (...pairs: { key: string; value: string }[]) =>
  pairs.map(({ key, value }) => createKeyValueRow(key, value));
import {
  assertValidMcpServerConfig,
  assertValidMcpServerName,
  isFormEditableMcpServerConfig,
} from '../../../extension/chat-panel/settings-manager/managers/mcp-config-validate';
import { LOCAL_MCP_RELATIVE_PATH, mcpSourceOrder, SHADOWING_SOURCES } from '@shared/types/mcp';
import type { McpServerSource } from '@shared/types/mcp';

/**
 * The invariant BETWEEN the two layers, which neither layer's own tests can express:
 *
 *   if the form reports a definition VALID, the extension must accept it.
 *
 * Break it and a plain typing mistake escapes inline validation, is posted, is refused by the
 * extension, and surfaces as a toast *after* the dialog has closed — taking the user's typed
 * definition with it (see `frontend-mcp-form` FINDING 1).
 *
 * This exists because both defects found in this slice were exactly that class and NEITHER side's
 * unit tests caught them: the form trimmed `args`/`cwd` (silently rewriting stored definitions), and
 * the fix for that then let a whitespace-only `cwd` through to a backend rejection. Each was found
 * only by running one layer's output through the other's validator. So that check is now a test.
 *
 * The validator import reaches into the extension tree on purpose — `mcp-config-validate.ts` is pure
 * and I/O-free, and asserting against the REAL one is the entire point; a copy here could drift from
 * it, which is the failure mode being guarded.
 */

const base = (overrides: Partial<McpServerFormState>): McpServerFormState => ({
  ...createEmptyFormState(),
  name: 'ok-name',
  command: 'node',
  ...overrides,
});

/** Whitespace and emptiness, where the two layers' notions of "blank" are most likely to disagree. */
const AWKWARD = ['', ' ', '   ', '\t', ' x', 'x ', ' x '] as const;

function everyFormShape(): McpServerFormState[] {
  const states: McpServerFormState[] = [
    base({}),
    base({ mode: 'remote', url: 'https://example.test/mcp' }),
  ];
  for (const w of AWKWARD) {
    states.push(
      base({ cwd: w }),
      base({ args: argRows(w) }),
      base({ args: argRows('a', w, 'b') }),
      base({ command: `node${w}` }),
      base({ name: `ok-name${w}` }),
      base({ env: kvRows({ key: 'KEY', value: w }) }),
      base({ env: kvRows({ key: `KEY${w}`, value: 'v' }) }),
      base({ mode: 'remote', url: `https://example.test/${w}` }),
      base({ mode: 'remote', url: 'https://example.test', bearerTokenEnv: w }),
      base({ mode: 'remote', url: 'https://example.test', headers: kvRows({ key: 'H', value: w }) }),
      base({
        mode: 'remote',
        remoteType: 'sse',
        url: 'https://example.test',
        headers: kvRows({ key: `H${w}`, value: 'v' }),
      }),
    );
  }
  return states;
}

describe('cross-layer: a form the UI accepts is a definition the extension accepts', () => {
  it('never emits a name or config the extension validator rejects', () => {
    const escaped: string[] = [];

    for (const state of everyFormShape()) {
      if (!isMcpFormValid(validateMcpServerForm(state, null, []))) continue;
      const name = submittedServerName(state);
      const config = buildMcpServerConfig(state);
      try {
        assertValidMcpServerName(name);
        assertValidMcpServerConfig(config);
      } catch (err) {
        escaped.push(`${JSON.stringify({ name, config })} → ${(err as Error).message}`);
      }
    }

    // Listing the offenders rather than asserting a count: a failure here has to name the exact
    // input that escaped, or the next person has to re-derive it.
    expect(escaped).toEqual([]);
  });

  it('emits configs the extension considers form-representable, so Edit survives a save', () => {
    // If a saved config were not form-representable, `editableConfig` would be withheld on the way
    // back and the Edit button would disappear from a row the user had just edited.
    const notEditable: string[] = [];

    for (const state of everyFormShape()) {
      if (!isMcpFormValid(validateMcpServerForm(state, null, []))) continue;
      const config = buildMcpServerConfig(state);
      if (!isFormEditableMcpServerConfig(config)) notEditable.push(JSON.stringify(config));
    }

    expect(notEditable).toEqual([]);
  });

  it('spells the personal MCP config the same way on both sides of the wire', () => {
    // The host asks git about this path and the panel tells the user to paste it into `.gitignore`.
    // Two literals that must agree became one export; this pins the value and its shape.
    expect(LOCAL_MCP_RELATIVE_PATH).toBe('.damocles/mcp.local.json');
    // Forward slashes on every platform, because git accepts them everywhere and the panel renders
    // the string verbatim as a `.gitignore` line.
    expect(LOCAL_MCP_RELATIVE_PATH).not.toMatch(/\\/);
    expect(LOCAL_MCP_RELATIVE_PATH.startsWith('/')).toBe(false);
  });

  it('derives SHADOWING_SOURCES from the precedence order rather than restating it', () => {
    // Both layers now read this one set, so it is the single thing that has to be right. Recomputed
    // here rather than compared to a literal: a hand-written `{workspace, damocles-local}` would pass
    // an equality check against itself and say nothing about the ordering it is supposed to follow.
    const order = mcpSourceOrder('claude');
    const aboveDamocles = order.slice(order.indexOf('damocles') + 1);

    expect(aboveDamocles.length).toBe(2);
    expect([...SHADOWING_SOURCES].sort()).toEqual([...aboveDamocles].sort());
    // The tie-break only permutes `claude` and `codex`, both below `damocles`, so the set is the same
    // under either precedence. The shared module derives it once from the `"claude"` arm alone.
    const flipped = mcpSourceOrder('codex');
    expect(flipped.slice(flipped.indexOf('damocles') + 1)).toEqual(aboveDamocles);
  });

  it('rejects a name from exactly the shadowing sources the extension refuses to write, no more', () => {
    // The form's inline hint and the host's `assertNotShadowed` are two code paths over one set. Drift
    // is a real defect either way: too narrow lets the user type a name the extension then refuses
    // after the dialog has closed, too wide blocks a name that would have worked.
    const formRejects: McpServerSource[] = [];
    for (const source of mcpSourceOrder('claude')) {
      const errors = validateMcpServerForm(base({ name: 'taken' }), null, [{ name: 'taken', source }]);
      if (errors.name?.key === 'mcp.form.errors.nameShadowedByProject') formRejects.push(source);
    }

    expect([...formRejects].sort()).toEqual([...SHADOWING_SOURCES].sort());
  });

  it('covers a meaningful number of shapes — a vacuous pass would prove nothing', () => {
    const valid = everyFormShape().filter((state) =>
      isMcpFormValid(validateMcpServerForm(state, null, [])),
    );
    expect(valid.length).toBeGreaterThan(40);
  });
});
