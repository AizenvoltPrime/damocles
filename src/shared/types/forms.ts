/**
 * Shared type contract for the `BrowserRequestInput` interactive form-fill tool (Slice 4).
 *
 * SECURITY: User-entered form VALUES must never reach the model, logs, transcript, or the session
 * JSONL. Only the SCHEMA (labels/types/selectors — proposed by the agent) is persisted as the tool
 * input, and only a REDACTED `FormResult` (no values) is returned to the model and rendered in the
 * transcript card. `FormValues` exists solely as the in-process webview→extension `answerForm`
 * payload; it is read into a local variable, injected into the live page, then discarded.
 */

/** The set of input controls the webview `FormPrompt` can render for a single field. */
export type FormFieldType =
  | 'text'
  | 'password'
  | 'textarea'
  | 'number'
  | 'date'
  | 'email'
  | 'url'
  | 'tel'
  | 'select'
  | 'checkbox'
  | 'radio';

/** One field the agent proposes. `options` is required for `select`/`radio`. `sensitive` marks a
 *  field whose transcript-card representation must be masked (••••); values are never stored anyway. */
export interface FormFieldSchema {
  id: string;
  label: string;
  type: FormFieldType;
  /** CSS selector of the live-page element the entered value is injected into. */
  selector: string;
  options?: { label: string; value: string }[];
  sensitive?: boolean;
  required?: boolean;
  placeholder?: string;
}

/** The agent-proposed form: fields plus an optional submit control. */
export interface FormSchema {
  title?: string;
  description?: string;
  fields: FormFieldSchema[];
  /** When set, the extension clicks this selector after injecting all values. */
  submitSelector?: string;
  submitLabel?: string;
}

/**
 * The REDACTED result returned to the model and rendered in the transcript card. Contains NO values —
 * only per-field metadata (label/type/ok) plus counts. `masked` mirrors the field's `sensitive` flag
 * so the card renders •••• for those fields (defense in depth — there are no values to render anyway).
 * `reason` is a value-free failure explanation (e.g. "selector not found"). `skipped` marks an optional
 * field the user intentionally left blank — not injected and NOT a failure (excluded from `filled`).
 */
export interface FormResult {
  filled: number;
  submitted: boolean;
  fields: {
    label: string;
    type: FormFieldType;
    ok: boolean;
    reason?: string;
    masked?: boolean;
    skipped?: boolean;
  }[];
}

/** Webview store shape (mirrors `PendingQuestionInfo`). Holds only the SCHEMA — never any values. */
export interface PendingFormInfo {
  toolUseId: string;
  form: FormSchema;
  parentToolUseId?: string | null;
  agentDescription?: string;
}

/**
 * The `answerForm` payload (in-process webview→extension only — NOT network, NOT persisted): keyed by
 * `FormFieldSchema.id`. `string` for text-like/select/radio, `boolean` for checkbox, `string[]`
 * reserved for future multi-value fields.
 */
export type FormValues = Record<string, string | boolean | string[]>;
