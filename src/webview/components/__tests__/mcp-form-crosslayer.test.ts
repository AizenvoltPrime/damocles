import { describe, it, expect } from 'vitest';
import {
  buildMcpServerConfig,
  createArgRow,
  createEmptyFormState,
  isMcpFormValid,
  submittedServerName,
  validateMcpServerForm,
  type McpServerFormState,
} from '../mcp-server-form-logic';

/** Form args are identified rows; the built config is still a plain string[]. */
const argRows = (...values: string[]) => values.map((value) => createArgRow(value));
import {
  assertValidMcpServerConfig,
  assertValidMcpServerName,
  isFormEditableMcpServerConfig,
} from '../../../extension/chat-panel/settings-manager/managers/mcp-config-validate';

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
      base({ env: [{ key: 'KEY', value: w }] }),
      base({ env: [{ key: `KEY${w}`, value: 'v' }] }),
      base({ mode: 'remote', url: `https://example.test/${w}` }),
      base({ mode: 'remote', url: 'https://example.test', bearerTokenEnv: w }),
      base({ mode: 'remote', url: 'https://example.test', headers: [{ key: 'H', value: w }] }),
      base({
        mode: 'remote',
        remoteType: 'sse',
        url: 'https://example.test',
        headers: [{ key: `H${w}`, value: 'v' }],
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

  it('covers a meaningful number of shapes — a vacuous pass would prove nothing', () => {
    const valid = everyFormShape().filter((state) =>
      isMcpFormValid(validateMcpServerForm(state, null, [])),
    );
    expect(valid.length).toBeGreaterThan(40);
  });
});
