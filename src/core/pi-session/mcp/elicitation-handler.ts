/*
 * Adapted from pi-mcp-adapter (MIT). Copyright (c) 2026 Nico Bailon.
 * See THIRD-PARTY-NOTICES.md.
 */
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ElicitRequestFormParams } from "@modelcontextprotocol/sdk/types.js";
import { log } from "../../logger";
import type { McpElicitationHandler } from "./types";

/** The narrow UI surface the form renderer needs from the webview-bridged `ExtensionUIContext`. */
export type ElicitationUI = Pick<ExtensionUIContext, "select" | "input" | "notify"> & {
  /**
   * The same bridge with agent attribution stripped. Present only on a per-agent UI
   * (`AgentElicitationUI`); the panel's own context simply does not have it, and its absence means
   * there is no attribution to strip. Used by `routeElicitation` when the server↔agent mapping is
   * ambiguous — see `mcp-client-manager.ts`.
   */
  unattributed?: () => ElicitationUI;
};

type FormSchema = ElicitRequestFormParams["requestedSchema"];
type FormProperty = FormSchema["properties"][string];
type FieldValue = string | number | boolean | string[] | undefined;
type ElicitationContent = Record<string, string | number | boolean | string[]>;
type ElicitationResult = { action: "accept" | "decline" | "cancel"; content?: ElicitationContent };

interface ParsedFormRequest {
  message: string;
  schema: FormSchema;
}

/**
 * Build a form-only MCP `elicitation/create` handler bound to a single session's UI bridge.
 * The returned handler matches the parent's `McpElicitationHandler` contract: it receives the raw
 * request params plus the originating server name and resolves to the MCP elicitation result.
 * URL elicitation and sampling are unsupported in v1 and degrade with a clear notice.
 */
export function createElicitationHandler(ui: ElicitationUI): McpElicitationHandler {
  return async (params: unknown, serverName: string) => {
    const parsed = parseFormRequest(params);
    if (!parsed) {
      ui.notify(`MCP server "${serverName}" requested unsupported input (only form elicitation is supported).`, "warning");
      log("[Elicitation] %s requested an unsupported elicitation mode", serverName);
      return { action: "decline" };
    }
    return runForm(ui, serverName, parsed);
  };
}

/** Narrow `unknown` params to the supported form shape; `null` for any non-form mode or malformed input. */
function parseFormRequest(params: unknown): ParsedFormRequest | null {
  if (typeof params !== "object" || params === null) return null;
  const record = params as Record<string, unknown>;
  // Allowlist the form mode (absent defaults to form) — a denylist would let a future mode (e.g. "url2")
  // fall through and be mis-rendered as a form.
  if (record["mode"] !== undefined && record["mode"] !== "form") return null;
  if (typeof record["message"] !== "string") return null;

  const requestedSchema = record["requestedSchema"];
  if (typeof requestedSchema !== "object" || requestedSchema === null) return null;
  const schemaRecord = requestedSchema as Record<string, unknown>;
  const properties = schemaRecord["properties"];
  if (typeof properties !== "object" || properties === null) return null;

  return { message: record["message"], schema: requestedSchema as FormSchema };
}

async function runForm(ui: ElicitationUI, serverName: string, request: ParsedFormRequest): Promise<ElicitationResult> {
  const decision = await ui.select(`MCP Input Request\nServer: ${serverName}\n\n${sanitizeServerText(request.message)}`, ["Continue", "Decline"]);
  if (decision === undefined) return { action: "cancel" };
  if (decision === "Decline") return { action: "decline" };

  const properties = Object.entries(request.schema.properties);
  const values: Record<string, FieldValue> = {};
  for (const [name, schema] of properties) {
    const field = await collectValidField(ui, request.schema, name, schema);
    if (!field.collected) return { action: "cancel" };
    values[name] = field.value;
  }

  for (;;) {
    let content: ElicitationContent;
    try {
      content = coerceAndValidate(request.schema, values);
    } catch (error) {
      ui.notify(messageOf(error), "error");
      const field = await reEnterFirstInvalid(ui, request.schema, properties, values);
      if (!field) return { action: "cancel" };
      values[field.name] = field.value;
      continue;
    }

    const reviewActions = properties.length > 0 ? ["Submit", "Edit", "Decline"] : ["Submit", "Decline"];
    const action = await ui.select(formatReview(serverName, properties, content), reviewActions);
    if (action === undefined) return { action: "cancel" };
    if (action === "Decline") return { action: "decline" };
    if (action === "Submit") return { action: "accept", content };

    const labels = properties.map(([name, schema]) => `${labelText(schema.title ?? humanizeName(name))} (${labelText(name)})`);
    const selected = await ui.select("Choose a field to edit", labels);
    if (selected === undefined) return { action: "cancel" };
    const property = properties[labels.indexOf(selected)];
    if (!property) continue;
    const [name, schema] = property;
    const field = await collectValidField(ui, request.schema, name, schema, values[name]);
    if (!field.collected) return { action: "cancel" };
    values[name] = field.value;
  }
}

/** Re-prompt the first field that fails whole-form validation so the user can correct it. */
async function reEnterFirstInvalid(
  ui: ElicitationUI,
  schema: FormSchema,
  properties: Array<[string, FormProperty]>,
  values: Record<string, FieldValue>,
): Promise<{ name: string; value: FieldValue } | null> {
  for (const [name, prop] of properties) {
    const fieldSchema = singleFieldSchema(name, prop, isRequired(schema, name));
    if (isFieldValid(fieldSchema, name, values[name])) continue;
    const field = await collectValidField(ui, schema, name, prop, values[name]);
    if (!field.collected) return null;
    return { name, value: field.value };
  }
  const first = properties[0];
  if (!first) return null;
  const [name, prop] = first;
  const field = await collectValidField(ui, schema, name, prop, values[name]);
  if (!field.collected) return null;
  return { name, value: field.value };
}

type CollectResult = { collected: false } | { collected: true; value: FieldValue };

/** Prompt a single field and re-prompt until it passes per-field validation or is cancelled. */
async function collectValidField(
  ui: ElicitationUI,
  schema: FormSchema,
  name: string,
  property: FormProperty,
  current?: FieldValue,
): Promise<CollectResult> {
  const required = isRequired(schema, name);
  const fieldSchema = singleFieldSchema(name, property, required);
  let value = current;
  for (;;) {
    const result = await collectField(ui, property, name, required, value);
    if (!result.collected) return result;
    if (isFieldValid(fieldSchema, name, result.value)) return result;
    ui.notify(fieldErrorOf(fieldSchema, name, property, result.value), "error");
    value = result.value;
  }
}

async function collectField(ui: ElicitationUI, property: FormProperty, name: string, required: boolean, current: FieldValue): Promise<CollectResult> {
  const heading = labelText(property.title ?? humanizeName(name));
  const description = property.description ? labelText(property.description) : "";
  const title = [heading, required ? "(required)" : "", description].filter(Boolean).join(" ");
  const hasDefault = "default" in property && property.default !== undefined;

  if (property.type === "string" && "enum" in property) {
    const names = "enumNames" in property ? property.enumNames : undefined;
    return collectEnum(ui, property.enum, names, defaultOf(property), title, required, hasDefault);
  }

  if (property.type === "boolean") {
    const actions = ["Yes", "No"];
    if (hasDefault) actions.push("Use default");
    if (!required) actions.push("Omit");
    const action = await ui.select(title, actions);
    if (action === undefined) return { collected: false };
    if (action === "Use default") return { collected: true, value: defaultOf(property) };
    if (action === "Omit") return { collected: true, value: undefined };
    return { collected: true, value: action === "Yes" };
  }

  if (property.type === "array") {
    return collectMultiSelect(ui, property, title, required, hasDefault, current);
  }

  const actions = ["Enter value"];
  if (hasDefault) actions.push("Use default");
  if (!required) actions.push("Omit");
  const action = await ui.select(title, actions);
  if (action === undefined) return { collected: false };
  if (action === "Use default") return { collected: true, value: defaultOf(property) };
  if (action === "Omit") return { collected: true, value: undefined };
  const entered = await ui.input(title, current === undefined ? undefined : String(current));
  return entered === undefined ? { collected: false } : { collected: true, value: entered };
}

async function collectEnum(
  ui: ElicitationUI,
  values: string[],
  names: string[] | undefined,
  defaultValue: FieldValue,
  title: string,
  required: boolean,
  hasDefault: boolean,
): Promise<CollectResult> {
  const choices = values.map((value, index) => ({
    value,
    display: formatChoice(value, names?.[index]),
  }));
  const displays = uniqueLabels(choices.map((choice) => choice.display));
  const actions = [...displays];
  const useDefault = hasDefault ? uniqueAction("Use default", actions) : undefined;
  if (useDefault) actions.push(useDefault);
  const omit = required ? undefined : uniqueAction("Omit", actions);
  if (omit) actions.push(omit);

  const action = await ui.select(title, actions);
  if (action === undefined) return { collected: false };
  if (useDefault !== undefined && action === useDefault) return { collected: true, value: defaultValue };
  if (omit !== undefined && action === omit) return { collected: true, value: undefined };
  // Resolve back to the raw enum value at the chosen index; never yield undefined for a picked option
  // (a duplicate-value/length-mismatch enum would otherwise loop a required field forever) (L9).
  const index = displays.indexOf(action);
  const value = index >= 0 ? values[index] : undefined;
  return value === undefined ? { collected: false } : { collected: true, value };
}

type ArrayProperty = Extract<FormProperty, { type: "array" }>;

/** The selectable options of a multi-select array field, from either `items.enum` or `items.anyOf`. */
function arrayOptions(property: ArrayProperty): Array<{ value: string; display: string }> {
  const items = property.items;
  if ("enum" in items) {
    return items.enum.map((value) => ({ value, display: value }));
  }
  return items.anyOf.map((option) => ({ value: option.const, display: formatChoice(option.const, option.title) }));
}

/**
 * Collect a multi-select (array) field by repeated single-select: each turn offers the still-unselected
 * options plus Done/Use-default/Omit/Clear controls, accumulating a `string[]`. Respects minItems
 * (Done is withheld until met) and maxItems (no further options once reached). Without this branch an
 * array field fell through to the text path and looped forever on `coerceArray`'s "must be a list" (H2).
 */
async function collectMultiSelect(
  ui: ElicitationUI,
  property: ArrayProperty,
  title: string,
  required: boolean,
  hasDefault: boolean,
  current: FieldValue,
): Promise<CollectResult> {
  const options = arrayOptions(property);
  const minItems = Math.min(property.minItems ?? (required ? 1 : 0), options.length);
  const maxItems = property.maxItems ?? options.length;
  const selected: string[] = Array.isArray(current) ? options.filter((o) => current.includes(o.value)).map((o) => o.value) : [];

  for (;;) {
    const remaining = options.filter((o) => !selected.includes(o.value));
    const canAddMore = remaining.length > 0 && selected.length < maxItems;
    const optionLabels = canAddMore ? uniqueLabels(remaining.map((o) => o.display)) : [];

    const choices = [...optionLabels];
    const done = selected.length >= minItems ? uniqueAction("Done", choices) : undefined;
    if (done) choices.push(done);
    const useDefault = hasDefault && selected.length === 0 ? uniqueAction("Use default", choices) : undefined;
    if (useDefault) choices.push(useDefault);
    const omit = !required && selected.length === 0 ? uniqueAction("Omit", choices) : undefined;
    if (omit) choices.push(omit);
    const clear = selected.length > 0 ? uniqueAction("Clear selections", choices) : undefined;
    if (clear) choices.push(clear);

    const summary = selected.length
      ? selected.map((value) => options.find((o) => o.value === value)?.display ?? labelText(value)).join(", ")
      : "(none selected)";
    const action = await ui.select(`${title}\nSelected: ${summary}`, choices);
    if (action === undefined) return { collected: false };
    if (done !== undefined && action === done) return { collected: true, value: [...selected] };
    if (useDefault !== undefined && action === useDefault) return { collected: true, value: defaultOf(property) };
    if (omit !== undefined && action === omit) return { collected: true, value: undefined };
    if (clear !== undefined && action === clear) {
      selected.length = 0;
      continue;
    }
    const picked = remaining[optionLabels.indexOf(action)];
    if (picked) selected.push(picked.value);
  }
}

function singleFieldSchema(name: string, property: FormProperty, required: boolean): FormSchema {
  return {
    type: "object",
    properties: { [name]: property },
    ...(required ? { required: [name] } : {}),
  };
}

function isFieldValid(schema: FormSchema, name: string, value: FieldValue): boolean {
  try {
    coerceAndValidate(schema, { [name]: value });
    return true;
  } catch {
    return false;
  }
}

function fieldErrorOf(schema: FormSchema, name: string, property: FormProperty, value: FieldValue): string {
  try {
    coerceAndValidate(schema, { [name]: value });
    return `Invalid value for ${property.title ?? humanizeName(name)}`;
  } catch (error) {
    return messageOf(error);
  }
}

/**
 * Coerce raw field values to their schema types and enforce required/range/length/enum constraints.
 * Throws on the first violation; the message is surfaced to the user via `notify`.
 */
export function coerceAndValidate(schema: FormSchema, values: Record<string, FieldValue>): ElicitationContent {
  const output: ElicitationContent = {};
  const required = new Set(schema.required ?? []);

  for (const [name, property] of Object.entries(schema.properties)) {
    const value = values[name];
    if (value === undefined) {
      if (required.has(name)) throw new Error(`Missing required elicitation field: ${name}`);
      continue;
    }

    if (property.type === "string") {
      output[name] = coerceString(property, name, value);
      continue;
    }
    if (property.type === "number" || property.type === "integer") {
      output[name] = coerceNumber(property, name, value);
      continue;
    }
    if (property.type === "boolean") {
      output[name] = typeof value === "boolean" ? value : value === "true";
      continue;
    }
    if (property.type === "array") {
      output[name] = coerceArray(property, name, value);
    }
  }
  return output;
}

function coerceString(property: Extract<FormProperty, { type: "string" }>, name: string, value: FieldValue): string {
  const stringValue = String(value);
  if ("minLength" in property && property.minLength !== undefined && stringValue.length < property.minLength) {
    throw new Error(`Elicitation field ${name} is shorter than minimum length ${property.minLength}`);
  }
  if ("maxLength" in property && property.maxLength !== undefined && stringValue.length > property.maxLength) {
    throw new Error(`Elicitation field ${name} is longer than maximum length ${property.maxLength}`);
  }
  if ("enum" in property && !property.enum.includes(stringValue)) {
    throw new Error(`Elicitation field ${name} is not an allowed value`);
  }
  return stringValue;
}

function coerceNumber(property: Extract<FormProperty, { type: "number" | "integer" }>, name: string, value: FieldValue): number {
  if (typeof value === "string" && value.trim() === "") {
    throw new Error(`Elicitation field ${name} must be a number`);
  }
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) throw new Error(`Elicitation field ${name} must be a number`);
  if (property.type === "integer" && !Number.isInteger(numberValue)) {
    throw new Error(`Elicitation field ${name} must be an integer`);
  }
  if (property.minimum !== undefined && numberValue < property.minimum) {
    throw new Error(`Elicitation field ${name} is below minimum ${property.minimum}`);
  }
  if (property.maximum !== undefined && numberValue > property.maximum) {
    throw new Error(`Elicitation field ${name} is above maximum ${property.maximum}`);
  }
  return numberValue;
}

function coerceArray(property: Extract<FormProperty, { type: "array" }>, name: string, value: FieldValue): string[] {
  if (!Array.isArray(value)) throw new Error(`Elicitation field ${name} must be a list`);
  const arrayValue = value.map(String);
  if (property.minItems !== undefined && arrayValue.length < property.minItems) {
    throw new Error(`Elicitation field ${name} has fewer than ${property.minItems} selections`);
  }
  if (property.maxItems !== undefined && arrayValue.length > property.maxItems) {
    throw new Error(`Elicitation field ${name} has more than ${property.maxItems} selections`);
  }
  return arrayValue;
}

function defaultOf(property: FormProperty): FieldValue {
  return "default" in property ? property.default : undefined;
}

function isRequired(schema: FormSchema, name: string): boolean {
  return schema.required?.includes(name) === true;
}

function formatChoice(value: string, title?: string): string {
  const v = labelText(value);
  const t = title !== undefined ? labelText(title) : undefined;
  return t && t !== v ? `${t} (${v})` : v;
}

function uniqueLabels(labels: string[]): string[] {
  const used = new Set<string>();
  return labels.map((label) => {
    let unique = label;
    while (used.has(unique)) unique += "...";
    used.add(unique);
    return unique;
  });
}

function uniqueAction(label: string, choices: string[]): string {
  let unique = label;
  while (choices.includes(unique)) unique += "...";
  return unique;
}

function formatReview(serverName: string, properties: Array<[string, FormProperty]>, content: ElicitationContent): string {
  const rows = properties.map(([name, schema]) => {
    const value = content[name];
    return `${labelText(schema.title ?? humanizeName(name))}: ${value === undefined ? "(omitted)" : labelText(String(value))}`;
  });
  return [`Review input for ${serverName}`, "", ...rows].join("\n");
}

function humanizeName(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (char) => char.toUpperCase());
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MAX_SERVER_MESSAGE_LENGTH = 500;

/**
 * Flatten a server-supplied string to a single capped line before it is shown next to the trusted
 * "Server:" attribution. The whitespace class collapses every newline/separator (LF, CR, and the
 * Unicode line/paragraph separators) so a malicious server cannot inject a forged attribution line,
 * and the length cap bounds UI-flooding (L11).
 */
function sanitizeServerText(text: string, maxLength = MAX_SERVER_MESSAGE_LENGTH): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length > maxLength ? `${flattened.slice(0, maxLength)}...` : flattened;
}

const MAX_FIELD_LABEL_LENGTH = 200;

/**
 * Flatten + cap a server-supplied label (field title/description, property key, enum option, reviewed
 * value) before it is rendered next to the trusted "Server:" attribution. Every server string in a
 * dialog must pass through here so a malicious server cannot inject a newline to forge attribution (L1).
 */
function labelText(text: string): string {
  return sanitizeServerText(text, MAX_FIELD_LABEL_LENGTH);
}
