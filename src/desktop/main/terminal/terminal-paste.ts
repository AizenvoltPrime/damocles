import { MAX_TERMINAL_INPUT_CHARS, type TerminalPaste } from '../../preload/terminal-channels';
import { GestureGrant } from '../clipboard-gestures';
import type { TerminalMultiLinePasteWarning } from '../desktop-configuration';
import type { AskMessage } from '../message-dialog';

// A lone CR is a line break too: the pty takes it as Enter.
const LINE_BREAK = /\r\n|\r|\n/;
const LINE_BREAKS = /\r\n|\r|\n/g;
// The dialog previews this many lines of at most PREVIEW_WIDTH characters each; PREVIEW_WIDTH + 1 (the ellipsis) must stay
// within MAX_OVERLAY_LABEL_LENGTH and PREVIEW_LINES + 1 within MAX_MESSAGE_PREVIEW_LINES.
export const PREVIEW_LINES = 5;
export const PREVIEW_WIDTH = 60;
const ELLIPSIS = '\u2026';

// text: what Paste sends; lines: text split at its line breaks, for the count and the preview
export type PasteDecision =
  | { readonly kind: 'paste'; readonly text: string }
  | { readonly kind: 'ask'; readonly text: string; readonly lines: readonly string[] };

// A C0 control other than TAB and the line breaks, DEL or a C1 control: outside a bracket a line editor takes it as a key,
// and Ctrl+O, for one, runs the line.
function hasControl(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Whether a paste asks first (VS Code's terminalClipboard.ts): never with the setting off; in auto, not when the shell has
 * bracketed paste mode on, and a single final line break is dropped first, so a copied command never runs by itself. Then
 * it asks for more than one line, or for a control character.
 */
export function pasteDecision(text: string, setting: TerminalMultiLinePasteWarning, bracketedPasteMode: boolean): PasteDecision {
  if (setting === 'never' || (setting === 'auto' && bracketedPasteMode)) return { kind: 'paste', text };
  const all = text.split(LINE_BREAK);
  const pasted = setting === 'auto' && all.length === 2 && all[1]!.trim().length === 0 ? all[0]! : text;
  const lines = pasted.split(LINE_BREAK);
  return lines.length === 1 && !hasControl(pasted) ? { kind: 'paste', text: pasted } : { kind: 'ask', text: pasted, lines };
}

/** Paste as One Line: every line break removed. */
export function pasteAsOneLine(text: string): string {
  return text.replace(LINE_BREAKS, '');
}

/**
 * What the pty receives, as xterm's Clipboard.ts paste prepares it: line breaks become CR, and in bracketed paste mode the text is wrapped
 * in ESC[200~ and ESC[201~ with every ESC of its own removed, so it cannot end the bracket early.
 */
export function preparePaste(text: string, bracketedPasteMode: boolean): string {
  const prepared = text.replace(/\r?\n/g, '\r');
  return bracketedPasteMode ? `\x1b[200~${prepared.replaceAll('\x1b', '')}\x1b[201~` : prepared;
}

/** The data in pieces of at most max UTF-16 units, never splitting a surrogate pair. */
export function pasteChunks(data: string, max: number = MAX_TERMINAL_INPUT_CHARS): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(start + max, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(data.slice(start, end));
    start = end;
  }
  return chunks;
}

// Characters a preview must not show as themselves: controls, format characters (bidi overrides, zero-width) and separators.
const INVISIBLE = /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]$/u;

function visible(char: string): string {
  if (!INVISIBLE.test(char)) return char;
  const code = char.codePointAt(0)!;
  // Unicode's Control Pictures: U+2400 + the C0 code, U+2421 for DEL
  if (code < 0x20) return String.fromCodePoint(0x2400 + code);
  if (code === 0x7f) return '\u2421';
  return `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`;
}

function previewLine(line: string): string {
  let out = '';
  for (const char of line) {
    const shown = visible(char);
    if (out.length + shown.length > PREVIEW_WIDTH) return out + ELLIPSIS;
    out += shown;
  }
  return out;
}

/** The dialog's preview: the first lines, each bounded, with invisible characters as symbols, and an ellipsis line for more. */
export function pastePreview(lines: readonly string[]): string[] {
  const shown = lines.slice(0, PREVIEW_LINES).map(previewLine);
  return lines.length > PREVIEW_LINES ? [...shown, ELLIPSIS] : shown;
}

export interface PasteDeps {
  readonly setting: TerminalMultiLinePasteWarning;
  readonly ask: AskMessage;
  readonly t: (message: string, ...args: Array<string | number>) => string;
  // the prepared data; the terminal service splits it for the pty host
  readonly write: (data: string) => void;
}

/** Pastes clipboard text into a terminal: asks first when the setting says so, then writes the prepared text. */
export async function pasteText(text: string, bracketedPasteMode: boolean, deps: PasteDeps): Promise<void> {
  if (text.length === 0) return;
  const decision = pasteDecision(text, deps.setting, bracketedPasteMode);
  let pasted = decision.text;
  if (decision.kind === 'ask') {
    const multiLine = decision.lines.length > 1;
    const action = await deps.ask({
      severity: 'warning',
      message: multiLine ? deps.t('Paste {0} lines of text into the terminal?', decision.lines.length) : deps.t('Paste text with control characters into the terminal?'),
      preview: pastePreview(decision.lines),
      actions: multiLine ? [deps.t('Paste'), deps.t('Paste as One Line')] : [deps.t('Paste')],
      cancelLabel: deps.t('Cancel'),
    });
    if (action === undefined) return;
    if (action === 1) pasted = pasteAsOneLine(pasted);
  }
  deps.write(preparePaste(pasted, bracketedPasteMode));
}

export interface TerminalPasteGateDeps {
  readonly activeTerminal: () => string | null;
  // the terminal part has keyboard focus
  readonly terminalFocused: () => boolean;
  readonly read: (source: TerminalPaste['source']) => Promise<string>;
  // the clipboard text the request may paste, with the request's bracketed paste mode
  readonly paste: (text: string, request: TerminalPaste) => Promise<void>;
  readonly log: (line: string) => void;
}

/**
 * The shell's paste request reads the clipboard only with a grant main issued when it observed the user's paste key, Linux
 * middle click, terminal menu pick or Edit › Paste, for that terminal and source; each grant answers one request.
 */
export class TerminalPasteGate {
  private readonly grant = new GestureGrant<{ readonly id: string; readonly source: TerminalPaste['source'] }>();
  private readonly deps: TerminalPasteGateDeps;

  constructor(deps: TerminalPasteGateDeps) {
    this.deps = deps;
  }

  /** Allows one paste from `source` into the active terminal. */
  allow(source: TerminalPaste['source']): void {
    const id = this.deps.activeTerminal();
    if (id !== null) this.grant.grant({ id, source });
  }

  clear(): void {
    this.grant.clear();
  }

  async paste(request: TerminalPaste): Promise<void> {
    const allowed = this.grant.take();
    if (!allowed || allowed.id !== request.id || allowed.source !== request.source) {
      this.deps.log('[terminal] refusing a paste: no paste key, middle click or menu pick of the user allowed it');
      return;
    }
    if (request.id !== this.deps.activeTerminal() || !this.deps.terminalFocused()) {
      this.deps.log('[terminal] refusing a paste: that terminal does not have keyboard focus');
      return;
    }
    await this.deps.paste(await this.deps.read(allowed.source), request);
  }
}
