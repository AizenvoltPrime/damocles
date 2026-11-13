// Known-secret masking of tool results (docs/invariants.md "GitHub and GitLab accounts", masking): the first tool_result
// handler of every Damocles session, so the model, the session file, memory extraction, configured hooks and a parent
// agent only ever see the masked result.
import type { ExtensionAPI, ToolResultEvent, ToolResultEventResult } from '@earendil-works/pi-coding-agent';
import { knownSecrets, MASK } from '../forge/known-secrets';
import { log } from '../logger';
import { joinResultText } from './tool-result-text';

// what a result says in place of its text when the check itself failed: the result never passes unchecked
export const UNCHECKED_RESULT: string = `${MASK} Damocles could not check this tool result for secrets, so its text was withheld.`;

type Walked = unknown[] | Record<string, unknown>;

// only arrays and plain records are walked: a class instance keeps its identity
function isWalked(value: unknown): value is Walked {
  if (Array.isArray(value)) return true;
  if (value === null || typeof value !== 'object') return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// an image block's data is base64 of pixels, never text a secret is read from
const isImageData = (node: Walked, key: string): boolean => !Array.isArray(node) && key === 'data' && node['type'] === 'image';

const entriesOf = (node: Walked): Array<[string, unknown]> => (Array.isArray(node) ? node.map((item, index) => [String(index), item]) : Object.entries(node));

/**
 * value with every string in it masked, object keys included, an image block's data left as it is; the same value when
 * nothing changed. Iterative, so any depth is read; throws on a value that contains itself.
 */
export function maskValue<T>(value: T, mask: (text: string) => string): T {
  if (typeof value === 'string') return mask(value) as T;
  if (!isWalked(value)) return value;
  const done = new Map<Walked, Walked>();
  // expanded and not yet rebuilt: exactly the ancestors of the stack's top
  const open = new Set<Walked>();
  const stack: Walked[] = [value];
  const maskedItem = (item: unknown): unknown => (typeof item === 'string' ? mask(item) : isWalked(item) ? done.get(item) : item);
  while (stack.length > 0) {
    const node = stack.at(-1)!;
    if (done.has(node)) {
      stack.pop();
    } else if (!open.has(node)) {
      open.add(node);
      for (const [, item] of entriesOf(node)) {
        if (!isWalked(item) || done.has(item)) continue;
        if (open.has(item)) throw new RangeError('A tool result contains itself');
        stack.push(item);
      }
    } else {
      stack.pop();
      open.delete(node);
      let changed = false;
      if (Array.isArray(node)) {
        const next = node.map((item: unknown) => {
          const masked = maskedItem(item);
          if (masked !== item) changed = true;
          return masked;
        });
        done.set(node, changed ? next : node);
      } else {
        const next: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(node)) {
          const masked = isImageData(node, key) ? item : maskedItem(item);
          const maskedKey = mask(key);
          if (masked !== item || maskedKey !== key) changed = true;
          next[maskedKey] = masked;
        }
        done.set(node, changed ? next : node);
      }
    }
  }
  return done.get(value) as T;
}

type ResultParts = Pick<ToolResultEvent, 'content' | 'details' | 'structuredContent'>;

/** The masked parts of a tool result, or undefined when it holds no known secret. Never throws. */
export function maskToolResult(event: ResultParts, mask: (text: string) => string = (text) => knownSecrets().mask(text)): ToolResultEventResult | undefined {
  try {
    const content = maskValue(event.content, mask);
    const details = maskValue(event.details, mask);
    const structuredContent = maskValue(event.structuredContent, mask);
    if (content === event.content && details === event.details && structuredContent === event.structuredContent) return undefined;
    // pi drops structured content a handler does not return along with new content
    return { content, ...(details !== event.details ? { details } : {}), ...(structuredContent !== undefined ? { structuredContent } : {}) };
  } catch (err) {
    log('[known-secrets] masking a tool result failed, so its text was withheld: %s', err instanceof Error ? err.name : typeof err);
    return { content: [{ type: 'text', text: UNCHECKED_RESULT }], details: {}, ...(event.structuredContent !== undefined ? { structuredContent: {} } : {}) };
  }
}

/**
 * The text of a streamed partial result (pi's tail snapshot of a running shell) as a card may show it: every known
 * secret masked, and a piece of one cut off at the snapshot's start or end too. Never throws.
 */
export function partialResultText(partialResult: unknown): string {
  try {
    return knownSecrets().maskPartial(joinResultText(partialResult));
  } catch (err) {
    log('[known-secrets] masking a partial tool result failed, so its text was withheld: %s', err instanceof Error ? err.name : typeof err);
    return UNCHECKED_RESULT;
  }
}

/** pi cut the output (a shell's tail, a long line), which may start inside a token: masked as a partial is. */
function truncatedOutput(details: unknown): boolean {
  if (details === null || typeof details !== 'object') return false;
  const truncation = (details as { truncation?: unknown }).truncation;
  return truncation !== null && typeof truncation === 'object' && (truncation as { truncated?: unknown }).truncated === true;
}

/** Registers the masking handler; call it before any other tool_result handler of the session's extension. */
export function registerKnownSecretMasking(pi: ExtensionAPI): void {
  pi.on('tool_result', (event) => {
    const secrets = knownSecrets();
    if (!secrets.holds()) return undefined;
    return maskToolResult(event, truncatedOutput(event.details) ? (text) => secrets.maskPartial(text) : (text) => secrets.mask(text));
  });
}
