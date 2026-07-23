import type { FormSchema, FormFieldType, FormValues } from '../../../shared/types/forms';
import type { PermissionState } from '../state';
import type { CanUseToolContext, PermissionResult, FormResolveResult, PostMessageFn } from '../types';

export type FormValidationResult =
  | { ok: true; form: FormSchema }
  | { ok: false; reason: string };

/** Field cap mirrors the TypeBox schema's `maxItems` on `fields` (belt-and-suspenders). */
const MAX_FIELDS = 30;

/** Coarse cap on any single agent-supplied string (id/label/selector/placeholder/title/description/
 *  option text). Well above any legitimate label or CSS selector; stops a pathological schema from
 *  bloating the webview payload. */
const MAX_STRING_LEN = 2000;

/** Cap on options per select/radio field. */
const MAX_OPTIONS = 100;

/** The canonical `FormFieldType` union, as a runtime set for validation. Kept in lockstep with
 *  `FormFieldType` in `shared/types/forms.ts`. */
const FIELD_TYPES: ReadonlySet<string> = new Set<FormFieldType>([
  'text', 'password', 'textarea', 'number', 'date', 'email', 'url', 'tel', 'select', 'checkbox', 'radio',
]);

/** Types that require a non-empty `options` array. */
const OPTION_TYPES: ReadonlySet<string> = new Set<FormFieldType>(['select', 'radio']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate an agent-supplied string with a length cap. Returns a VALUE-FREE reason, or null if valid.
 *  An optional (`required=false`) undefined value is valid. */
function badString(value: unknown, path: string, required: boolean): string | null {
  if (value === undefined && !required) return null;
  if (typeof value !== 'string') {
    return required ? `${path} must be a non-empty string` : `${path} must be a string when provided`;
  }
  if (required && value.trim().length === 0) {
    return `${path} must be a non-empty string`;
  }
  if (value.length > MAX_STRING_LEN) {
    return `${path} must be at most ${MAX_STRING_LEN} characters`;
  }
  return null;
}

/**
 * Validate an agent-proposed `BrowserRequestInput` schema. All failure reasons are VALUE-FREE — they
 * describe only structural problems (field index, missing key, bad type). There are no user-entered
 * values at validation time (this runs on the tool INPUT), but the value-free rule is enforced anyway
 * as defense in depth.
 */
export function validateForm(input: unknown): FormValidationResult {
  if (!isRecord(input)) {
    return { ok: false, reason: 'input must be an object' };
  }
  const fields = input['fields'];
  if (!Array.isArray(fields)) {
    return { ok: false, reason: 'fields must be an array' };
  }
  if (fields.length === 0) {
    return { ok: false, reason: 'fields must be a non-empty array' };
  }
  if (fields.length > MAX_FIELDS) {
    return { ok: false, reason: `fields must have at most ${MAX_FIELDS} items, got ${fields.length}` };
  }

  const seenIds = new Set<string>();
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!isRecord(f)) {
      return { ok: false, reason: `fields[${i}] must be an object` };
    }
    const strReason =
      badString(f['id'], `fields[${i}].id`, true) ??
      badString(f['label'], `fields[${i}].label`, true) ??
      badString(f['selector'], `fields[${i}].selector`, true);
    if (strReason) return { ok: false, reason: strReason };

    // Duplicate ids collide in FormValues, the outcome Map, Vue :key, and DOM ids — the later field
    // would silently overwrite the earlier one's value and mis-report required-state. Reject up front.
    const id = f['id'] as string;
    if (seenIds.has(id)) {
      return { ok: false, reason: `fields[${i}].id duplicates an earlier field id` };
    }
    seenIds.add(id);

    const type = f['type'];
    if (typeof type !== 'string' || !FIELD_TYPES.has(type)) {
      return { ok: false, reason: `fields[${i}].type must be one of the supported field types` };
    }

    const options = f['options'];
    const optionsRequired = OPTION_TYPES.has(type);
    if (optionsRequired || options !== undefined) {
      if (!Array.isArray(options) || (optionsRequired && options.length === 0)) {
        return { ok: false, reason: optionsRequired
          ? `fields[${i}].options must be a non-empty array for ${type} fields`
          : `fields[${i}].options must be an array when provided` };
      }
      if (options.length > MAX_OPTIONS) {
        return { ok: false, reason: `fields[${i}].options must have at most ${MAX_OPTIONS} items, got ${options.length}` };
      }
      for (let j = 0; j < options.length; j++) {
        const o = options[j];
        if (!isRecord(o) || typeof o['label'] !== 'string' || typeof o['value'] !== 'string') {
          return { ok: false, reason: `fields[${i}].options[${j}] must have string label and value` };
        }
        if (o['label'].length > MAX_STRING_LEN || o['value'].length > MAX_STRING_LEN) {
          return { ok: false, reason: `fields[${i}].options[${j}] label/value must be at most ${MAX_STRING_LEN} characters` };
        }
      }
    }

    if (f['sensitive'] !== undefined && typeof f['sensitive'] !== 'boolean') {
      return { ok: false, reason: `fields[${i}].sensitive must be a boolean when provided` };
    }
    if (f['required'] !== undefined && typeof f['required'] !== 'boolean') {
      return { ok: false, reason: `fields[${i}].required must be a boolean when provided` };
    }
    const placeholderReason = badString(f['placeholder'], `fields[${i}].placeholder`, false);
    if (placeholderReason) return { ok: false, reason: placeholderReason };
  }

  for (const key of ['submitSelector', 'submitLabel', 'title', 'description'] as const) {
    const reason = badString(input[key], key, false);
    if (reason) return { ok: false, reason };
  }

  return { ok: true, form: input as unknown as FormSchema };
}

/**
 * Drives the `BrowserRequestInput` interactive form prompt, mirroring `QuestionManager`. It posts the
 * SCHEMA to the webview (`requestForm`), stores a pending `{ resolve, cleanup }` keyed by the tool-use
 * id, and awaits the user's answer. On submit it returns `{ behavior:'allow', updatedInput:{ values } }`
 * — the ONLY place user-entered values cross back into the extension, read exclusively into the tool's
 * `execute` local scope. On cancel/abort it denies. Values are never persisted or logged here.
 */
export class FormManager {
  private state: PermissionState;
  private getPostMessage: () => PostMessageFn | null;

  constructor(state: PermissionState, getPostMessage: () => PostMessageFn | null) {
    this.state = state;
    this.getPostMessage = getPostMessage;
  }

  async handleForm(input: Record<string, unknown>, context: CanUseToolContext): Promise<PermissionResult> {
    const validated = validateForm(input);
    if (!validated.ok) {
      return { behavior: 'deny', message: `BrowserRequestInput input invalid: ${validated.reason}` };
    }
    const form = validated.form;

    const result = await this.requestFormFromWebview(form, context);

    if (!result.approved || !result.values) {
      return { behavior: 'deny', message: 'User cancelled the input form' };
    }

    return {
      behavior: 'allow',
      updatedInput: { values: result.values },
    };
  }

  private async requestFormFromWebview(form: FormSchema, context: CanUseToolContext): Promise<FormResolveResult> {
    const postMessage = this.getPostMessage();
    if (!postMessage) {
      return { approved: false };
    }

    const toolUseId = context.toolUseID;
    if (!toolUseId) {
      return { approved: false };
    }

    return new Promise<FormResolveResult>((resolve) => {
      // A signal already aborted before we subscribe will never fire 'abort' again, which would strand
      // the form pending forever. Deny immediately.
      if (context.signal.aborted) {
        resolve({ approved: false });
        return;
      }

      const abortHandler = () => {
        this.state.pendingForms.delete(toolUseId);
        resolve({ approved: false });
      };

      const cleanup = () => {
        context.signal.removeEventListener('abort', abortHandler);
      };

      this.state.addPendingForm(toolUseId, { resolve, cleanup });
      context.signal.addEventListener('abort', abortHandler, { once: true });

      postMessage({
        type: 'requestForm',
        toolUseId,
        form,
        ...(context.parentToolUseId !== undefined ? { parentToolUseId: context.parentToolUseId } : {}),
      });
    });
  }

  /**
   * Resolve a pending form with the user's answer. `values === null` means cancel. Double-resolve is a
   * no-op: the first resolve removes the pending entry, so the second `removePendingForm` returns
   * undefined and we return early.
   */
  resolveForm(toolUseId: string, values: FormValues | null): void {
    const pending = this.state.removePendingForm(toolUseId);
    if (!pending) {
      return;
    }

    pending.cleanup();
    pending.resolve({
      approved: values !== null,
      ...(values !== null ? { values } : {}),
    });
  }
}
