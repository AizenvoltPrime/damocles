// The theme tools of a chat on a remote host: the daemon's core resolves sources on the host and sends the store work to the
// device its turn is pinned to (user.theme.*), whose core alone writes (docs/invariants.md "Remote daemon and wire").
import type { CssDroppedPart } from './css-types';
import type { ThemeChangeAction, ThemeChangeItem, ThemeContrastIssue, ThemeLaterChange, ThemeShowEndReason, ThemeShowRefusal, ThemeToolDetails } from './agent';
import type { ThemeInstallCommit, ThemeInstallCommitted, ThemeInstallPreview } from './install';
import type { LocalizedText } from '../localized-text';
import type { ThemeFile } from './schema';
import type { LookKind } from './tokens';
import { MAX_MOVING_BYTES } from './wallpapers';

// The one FEATURES name of the whole theme contract: every user.theme.* request and event, and the theme prompt kinds.
export const THEMES_FEATURE = 'themes';

// One message stays far below the wire's unacknowledged bound (MAX_HELD_BYTES in src/remote/mux.ts).
export const THEME_UPLOAD_CHUNK_BYTES: number = 4 * 1024 * 1024;
export const MAX_THEME_UPLOAD_BYTES: number = MAX_MOVING_BYTES;
export const RELAYED_DRAFT_TTL_MS: number = 24 * 60 * 60 * 1000;
export const MAX_COMPUTER_NAME_CHARS = 64;
// A relayed answer's texts and images, each bounded by the device's core where it builds the answer; the parsers refuse more.
export const MAX_RELAYED_THEME_TEXT_CHARS = 200_000;
export const MAX_RELAYED_THEME_PNG_BYTES: number = 16 * 1024 * 1024;

// main's refusal while damocles.desktop.themes.agentTools is off on the computer the request reached
export const CLIENT_THEMES_OFF = 'client-themes-off';

/** One part of a tool result: text, or a PNG image. */
export type ThemeContentPart = { readonly type: 'text'; readonly text: string } | { readonly type: 'image'; readonly png: Uint8Array };

/** The host project a remote chat's folder maps to on this computer: its project key here and its name. */
export interface RelayedThemeProject {
  readonly key: string;
  readonly name: string;
}

export interface ThemeChat {
  readonly id: string;
  readonly title?: string;
}

export const THEME_READ_ABOUT = ['current', 'installed', 'theme', 'schedule', 'project'] as const;

export interface ThemeReadRequest {
  readonly about?: (typeof THEME_READ_ABOUT)[number];
  // a theme id, never empty
  readonly theme?: string;
  readonly preview?: boolean;
}

export interface ThemeReadAnswer {
  readonly content: readonly ThemeContentPart[];
  readonly isError?: true;
}

/** A proposing call of ThemeSet (a theme, a project look, an undo) or ThemeSchedule. */
export interface ThemeStageRequest {
  readonly tool: 'set' | 'schedule';
  readonly input: Readonly<Record<string, unknown>>;
  readonly toolCallId: string;
  readonly chat: ThemeChat;
  readonly planMode: boolean;
  // the upload holding the bytes of the call's asset, which the input names
  readonly upload?: string;
}

/** What the theme card shows, as the core that holds the store built it. */
export interface ThemeStagedCard {
  readonly action: ThemeChangeAction;
  readonly theme?: ThemeFile;
  readonly themeName?: string;
  readonly looks: readonly LookKind[];
  readonly isNew: boolean;
  readonly changes: readonly ThemeChangeItem[];
  readonly contrast: readonly ThemeContrastIssue[];
  readonly droppedCss?: readonly CssDroppedPart[];
  // how many more parts the sanitizer removed than droppedCss lists
  readonly droppedCssMore?: number;
  readonly planMode: boolean;
  readonly canShowInWindow: boolean;
}

export type ThemeStageAnswer =
  // the call ended without a card or banner: staged, refused, nothing to change
  | { readonly kind: 'done'; readonly content: readonly ThemeContentPart[]; readonly details: ThemeToolDetails; readonly isError?: true; readonly notes?: string }
  | {
    readonly kind: 'change';
    readonly stageId: string;
    readonly card: ThemeStagedCard;
    readonly details: ThemeToolDetails;
    // every outcome's result is the outcome's sentence, this text after it, and this image
    readonly summary: { readonly text: string; readonly png?: Uint8Array };
    // applied at once on commit, then held until the keep-changes banner ends
    readonly onTheFly: boolean;
    // added to the result of a call that did not fail
    readonly notes?: string;
    // set by main on a relayed answer: the computer the change lands on, which another device's card names
    readonly computer?: string;
  };

export type ThemeCommitAnswer =
  | { readonly outcome: 'applied' | 'kept' | 'reverted' | 'stopped' | 'outdated' | 'unchanged' }
  | { readonly refused: string; readonly laterChange?: ThemeLaterChange };

export interface ThemeUploadStart {
  readonly sha256: string;
  readonly bytes: number;
  // the asset's file name, whose extension the import checks against its bytes
  readonly name?: string;
}

export interface ThemeUploadChunk {
  readonly uploadId: string;
  readonly offset: number;
  readonly data: Uint8Array;
}

/** received: the bytes held so far; complete once they are all there and their SHA-256 matched. */
export interface ThemeUploadAck {
  readonly received: number;
  readonly complete: boolean;
}

export interface ThemeShot {
  readonly shotId: string;
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

/** The user.theme.* requests a daemon's core sends the pinned device, each with that device's client id beside its params. */
export interface UserThemeCalls {
  readonly read: { readonly params: { readonly request: ThemeReadRequest; readonly folder?: string }; readonly result: ThemeReadAnswer };
  readonly uploadStart: { readonly params: ThemeUploadStart & { readonly sessionId: string }; readonly result: { readonly uploadId: string } };
  readonly uploadChunk: { readonly params: ThemeUploadChunk; readonly result: ThemeUploadAck };
  readonly stage: { readonly params: ThemeStageRequest & { readonly folder?: string }; readonly result: ThemeStageAnswer };
  readonly commit: { readonly params: { readonly stageId: string }; readonly result: ThemeCommitAnswer };
  // keepDraft: the card ended with Change, so only the stage goes and its draft waits for the chat's next call
  readonly discard: { readonly params: { readonly stageId: string; readonly keepDraft?: boolean }; readonly result: void };
  // Show in window of the card promptId names; showing: whether the window shows it now
  // refused: why the device's window cannot paint the proposal, with showing false
  readonly preview: { readonly params: { readonly stageId: string; readonly promptId: string; readonly on: boolean }; readonly result: { readonly showing: boolean; readonly refused?: ThemeShowRefusal } };
  readonly screenshotTake: { readonly params: object; readonly result: ThemeShot };
  readonly screenshot: { readonly params: { readonly shotId: string }; readonly result: { readonly png: Uint8Array } };
  readonly screenshotDrop: { readonly params: { readonly shotId: string }; readonly result: void };
  // ThemeSet install of an https URL the chat's gate judged as its WebFetch: the device downloads and stages it; computer: the
  // device's name, which another device's card names
  readonly installPrepare: { readonly params: { readonly url: string }; readonly result: { readonly preview: ThemeInstallPreview; readonly computer: string } | { readonly refused: LocalizedText } };
  readonly installCommit: { readonly params: ThemeInstallCommit & { readonly chat: ThemeChat }; readonly result: ThemeInstallCommitted };
  readonly installCancel: { readonly params: { readonly installId: string }; readonly result: void };
}

/** The device's window ended the Show in window of the card promptId names. */
export interface ThemeShowEnded {
  readonly stageId: string;
  readonly promptId: string;
  readonly reason: ThemeShowEndReason;
}

/** text cut to max, never ending in half of a surrogate pair. */
export function boundedRelayText(text: string, max: number = MAX_RELAYED_THEME_TEXT_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** A result's parts as they leave for the host: texts bounded, an oversize image left out. */
function boundedRelayContent(content: readonly ThemeContentPart[]): ThemeContentPart[] {
  return content.flatMap((part): ThemeContentPart[] => {
    if (part.type === 'text') return [{ type: 'text', text: boundedRelayText(part.text) }];
    return part.png.byteLength <= MAX_RELAYED_THEME_PNG_BYTES ? [{ type: 'image', png: part.png }] : [{ type: 'text', text: 'The image was too large to send.' }];
  });
}

export function boundedRelayRead(answer: ThemeReadAnswer): ThemeReadAnswer {
  return { content: boundedRelayContent(answer.content), ...(answer.isError === true ? { isError: true as const } : {}) };
}

export function boundedRelayStage(answer: ThemeStageAnswer): ThemeStageAnswer {
  const notes = answer.notes !== undefined ? { notes: boundedRelayText(answer.notes) } : {};
  if (answer.kind === 'done') return { ...answer, content: boundedRelayContent(answer.content), ...notes };
  const { png: _png, ...summary } = answer.summary;
  const png = answer.summary.png !== undefined && answer.summary.png.byteLength <= MAX_RELAYED_THEME_PNG_BYTES ? { png: answer.summary.png } : {};
  return { ...answer, summary: { ...summary, text: boundedRelayText(answer.summary.text), ...png }, ...notes };
}

export function boundedRelayCommit(answer: ThemeCommitAnswer): ThemeCommitAnswer {
  return 'refused' in answer ? { ...answer, refused: boundedRelayText(answer.refused) } : answer;
}

export type UserThemeMethod = keyof UserThemeCalls;

export const USER_THEME_METHODS: readonly UserThemeMethod[] = [
  'read', 'uploadStart', 'uploadChunk', 'stage', 'commit', 'discard', 'preview', 'screenshotTake', 'screenshot', 'screenshotDrop',
  'installPrepare', 'installCommit', 'installCancel',
];
