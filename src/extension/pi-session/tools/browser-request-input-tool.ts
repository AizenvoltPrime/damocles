import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Page } from 'patchright';
import type { PiCodingAgentModule } from '../pi-loader';
import type { BrowserService } from '../../browser';
import type { PermissionHandler } from '../../permission-handler';
import type { FormSchema, FormFieldSchema, FormFieldType, FormResult, FormValues } from '../../../shared/types/forms';
import { buildCanUseToolContext, formatDenyReason } from '../permission-gate';
import { validateForm } from '../../permission-handler/managers/form-manager';
import { TOOL_BROWSER_REQUEST_INPUT } from '../../../shared/tool-names';
import { log } from '../../logger';

/**
 * Finite upper bound (ms) on every Playwright locator action, mirroring `ACTION_TIMEOUT_MS` in
 * browser-tools.ts, so a single field can never block the agent loop unbounded.
 */
const ACTION_TIMEOUT_MS = 15_000;

/**
 * A per-field injection failure carrying a VALUE-FREE `reason` (plus optional label/type for context).
 * `reason` MUST NEVER contain the user-entered value — it describes only the failure class
 * ("selector not found", "element not fillable/timed out"). Thrown inside `injectField`, caught in the
 * per-field loop, and surfaced only through the REDACTED `FormResult`.
 */
export class BrowserFormInjectionError extends Error {
  readonly reason: string;
  readonly label?: string;
  readonly type?: FormFieldType;

  constructor(reason: string, opts?: { label?: string; type?: FormFieldType }) {
    super(reason);
    this.name = 'BrowserFormInjectionError';
    this.reason = reason;
    if (opts?.label !== undefined) this.label = opts.label;
    if (opts?.type !== undefined) this.type = opts.type;
  }
}

const fieldTypeUnion = Type.Union(
  ['text', 'password', 'textarea', 'number', 'date', 'email', 'url', 'tel', 'select', 'checkbox', 'radio'].map((v) => Type.Literal(v)),
  { description: 'The input control the human fills. `select`/`radio` require `options`.' },
);

const optionSchema = Type.Object({
  label: Type.String({ description: 'Human-visible option text.' }),
  value: Type.String({ description: 'The value injected into the page when this option is chosen.' }),
});

const fieldSchema = Type.Object({
  id: Type.String({ description: 'Stable unique id for this field (the key the entered value is returned under). Never shown to the user.' }),
  label: Type.String({ description: 'Human-visible field label shown in the form and the transcript card.' }),
  type: fieldTypeUnion,
  selector: Type.String({ description: 'CSS selector of the live-page element the entered value is injected into. For `radio`, this targets the group CONTAINER (the entered value selects the `input[type=radio]` inside it whose value matches); for every other type it targets the control itself.' }),
  options: Type.Optional(Type.Array(optionSchema, { description: 'Required (non-empty) for `select`/`radio` fields.' })),
  sensitive: Type.Optional(Type.Boolean({ description: 'Mark secrets (passwords, OTP, card numbers). The transcript card masks these as ••••.' })),
  required: Type.Optional(Type.Boolean({ description: 'When true, the user cannot submit until this field is filled.' })),
  placeholder: Type.Optional(Type.String({ description: 'Optional placeholder shown in the input.' })),
});

const formSchema = Type.Object(
  {
    title: Type.Optional(Type.String({ description: 'Optional form title shown at the top of the prompt.' })),
    description: Type.Optional(Type.String({ description: 'Optional instructions shown under the title.' })),
    fields: Type.Array(fieldSchema, { minItems: 1, maxItems: 30, description: 'The fields the human must fill (1-30).' }),
    submitSelector: Type.Optional(Type.String({ description: 'When set, the extension clicks this selector after injecting all values (submits the live form).' })),
    submitLabel: Type.Optional(Type.String({ description: 'Optional label for the prompt submit button (default "Submit").' })),
  },
  { additionalProperties: false },
);

/** One field's injection outcome. Carries ONLY value-free metadata — never the entered value.
 *  `skipped` marks an optional field left blank: not injected, not a failure (ok stays true). */
export interface InjectionOutcome {
  id: string;
  label: string;
  type: FormFieldType;
  ok: boolean;
  reason?: string;
  skipped?: boolean;
}

/**
 * Build the REDACTED `FormResult` returned to the model and rendered in the transcript card. PURE and
 * provably value-free: it reads ONLY the schema (label/type/sensitive) and the per-field outcomes
 * (ok/reason — reasons are value-free by construction in `injectField`). It NEVER reads `FormValues`.
 */
export function buildRedactedResult(
  schema: FormSchema,
  outcomes: InjectionOutcome[],
  submitted: boolean,
): FormResult {
  const outcomeById = new Map(outcomes.map((o) => [o.id, o]));
  const fields = schema.fields.map((f) => {
    const outcome = outcomeById.get(f.id);
    const ok = outcome?.ok ?? false;
    const skipped = outcome?.skipped === true;
    return {
      label: f.label,
      type: f.type,
      ok,
      ...(outcome?.reason !== undefined ? { reason: outcome.reason } : {}),
      masked: f.sensitive === true,
      ...(skipped ? { skipped: true } : {}),
    };
  });
  const filled = fields.reduce((n, f) => (f.ok && !f.skipped ? n + 1 : n), 0);
  return { filled, submitted, fields };
}

/** Escape a string for embedding inside a double-quoted CSS attribute selector value. Exported for
 *  direct testing of the radio value-injection surface. */
export function cssAttrValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Inject a single field's value into the live page via a Playwright locator with a finite timeout.
 * All thrown errors carry a VALUE-FREE reason (the entered value is never included). The value passes
 * through this function's local scope only and is discarded when the caller's loop iteration ends.
 */
export async function injectField(page: Page, field: FormFieldSchema, value: FormValues[string] | undefined): Promise<void> {
  if (value === undefined) {
    throw new BrowserFormInjectionError('no value provided', { label: field.label, type: field.type });
  }
  const locator = page.locator(field.selector).first();
  try {
    switch (field.type) {
      case 'text':
      case 'password':
      case 'textarea':
      case 'number':
      case 'email':
      case 'url':
      case 'tel':
      case 'date':
        await locator.fill(String(value), { timeout: ACTION_TIMEOUT_MS });
        return;
      case 'select':
        // A bare string matches an option by BOTH its value and its visible label (Playwright/Patchright
        // semantics), so a single call covers either — no second attempt, no doubled timeout budget.
        await locator.selectOption(String(value), { timeout: ACTION_TIMEOUT_MS });
        return;
      case 'checkbox':
        await locator.setChecked(Boolean(value), { timeout: ACTION_TIMEOUT_MS });
        return;
      case 'radio': {
        // Check the radio input inside the field's container whose value attribute matches the chosen
        // option value. The value is embedded ONLY in a local CSS selector — never logged.
        const radio = page
          .locator(field.selector)
          .locator(`input[type="radio"][value="${cssAttrValue(String(value))}"]`)
          .first();
        await radio.check({ timeout: ACTION_TIMEOUT_MS });
        return;
      }
    }
  } catch (err) {
    if (err instanceof BrowserFormInjectionError) throw err;
    const reason = err instanceof Error && err.name === 'TimeoutError'
      ? 'element not found or not fillable (timed out)'
      : 'element not fillable';
    throw new BrowserFormInjectionError(reason, { label: field.label, type: field.type });
  }
}

/**
 * The `BrowserRequestInput` interactive form-fill tool. It asks the HUMAN to fill a form; the entered
 * values are injected directly into the live page and are NEVER seen by the model. Mirrors
 * `AskUserQuestion`: `execute` drives `FormManager` through `permissionHandler.canUseTool` (the gate
 * auto-allows it without re-prompting), reads the entered `values` into a LOCAL variable for injection,
 * then discards them. Only the REDACTED `FormResult` (labels/types/ok/counts — no values) is returned.
 */
export function createBrowserRequestInputTool(
  pi: PiCodingAgentModule,
  browserService: BrowserService,
  permissionHandler: PermissionHandler,
): ToolDefinition {
  return pi.defineTool<typeof formSchema, undefined>({
    name: TOOL_BROWSER_REQUEST_INPUT,
    label: TOOL_BROWSER_REQUEST_INPUT,
    description: 'Ask the human to fill a form; values are entered directly into the live page and never seen by the model. PREFER this over BrowserFill whenever a HUMAN must enter values or secrets — e.g. login credentials, MFA/OTP codes, payment details.',
    parameters: formSchema,
    execute: async (toolCallId, params, signal) => {
      // Validate the agent's schema up front so a malformed schema is reported as a fixable TOOL ERROR,
      // not framed as a user denial by the permission layer.
      const validation = validateForm(params);
      if (!validation.ok) {
        return {
          content: [{ type: 'text', text: `Error: invalid form schema — ${validation.reason}` }],
          isError: true,
          details: undefined,
        };
      }
      const schema = validation.form;

      // Confirm a live page exists BEFORE prompting. Never make the human type a secret (password / OTP /
      // card number) only to discard it because there was nowhere to inject it.
      if (!browserService.getActivePage()) {
        return {
          content: [{ type: 'text', text: 'Error: No active browser page. Use BrowserOpen first.' }],
          isError: true,
          details: undefined,
        };
      }

      const result = await permissionHandler.canUseTool(
        TOOL_BROWSER_REQUEST_INPUT,
        params as Record<string, unknown>,
        buildCanUseToolContext(toolCallId, signal),
      );
      if (result.behavior === 'deny') {
        // Mirror AskUserQuestion: a cancelled form is an error tool result so the card renders "denied".
        throw new Error(formatDenyReason(result.message));
      }

      // The ONLY place user-entered values enter the tool. Read into a local const; injected below and
      // then discarded when `execute` returns. Never logged, never returned to the model. Optional-chain
      // updatedInput: an auto-allow path (e.g. dangerouslySkipPermissions) may return `allow` with no
      // updatedInput, in which case there are simply no values to inject.
      const values = (result.updatedInput as { values?: FormValues } | undefined)?.values ?? {};

      const page = browserService.getActivePage();
      if (!page) {
        // Race: the page closed while the user was filling the form.
        return {
          content: [{ type: 'text', text: 'Error: the browser page closed before the entered values could be applied.' }],
          isError: true,
          details: undefined,
        };
      }

      const outcomes: InjectionOutcome[] = [];

      for (const field of schema.fields) {
        const raw = values[field.id];
        const blank = raw === undefined || raw === '';
        if (blank) {
          if (field.required === true) {
            // Defense in depth: the webview blocks submitting an empty required field, but if one ever
            // slips through we must NOT inject "" and report success — record a value-free failure.
            outcomes.push({ id: field.id, label: field.label, type: field.type, ok: false, reason: 'required field was left empty' });
          } else {
            // An optional field intentionally left blank is skipped, not injected — reporting it as a
            // failure would be wrong. (Checkboxes carry an explicit boolean, so they are never blank.)
            outcomes.push({ id: field.id, label: field.label, type: field.type, ok: true, skipped: true });
          }
          continue;
        }
        try {
          await injectField(page, field, raw);
          outcomes.push({ id: field.id, label: field.label, type: field.type, ok: true });
        } catch (err) {
          // No silent swallowing: every per-field failure is recorded as a redacted (value-free) outcome.
          const reason = err instanceof BrowserFormInjectionError ? err.reason : 'injection failed';
          outcomes.push({ id: field.id, label: field.label, type: field.type, ok: false, reason });
        }
      }

      let submitted = false;
      if (schema.submitSelector) {
        // Never submit a partially-filled live form: if any REQUIRED field failed to inject, skip the
        // submit click so the page is not posted with missing/invalid required values.
        const requiredFailed = schema.fields.some(
          (f) => f.required === true && outcomes.find((o) => o.id === f.id)?.ok === false,
        );
        if (!requiredFailed) {
          try {
            await page.locator(schema.submitSelector).first().click({ timeout: ACTION_TIMEOUT_MS });
            submitted = true;
          } catch {
            submitted = false;
          }
        }
      }

      const redacted = buildRedactedResult(schema, outcomes, submitted);
      // Log ONLY labels/types/counts — never values or a value-bearing selector.
      log(`[BrowserRequestInput] fields=${schema.fields.length} filled=${redacted.filled} submitted=${submitted} types=[${schema.fields.map((f) => f.type).join(',')}]`);
      return { content: [{ type: 'text', text: JSON.stringify(redacted) }], details: undefined };
    },
  });
}
