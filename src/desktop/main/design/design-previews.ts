// The selected design chat's preview tabs (PD-7, PD-31, PD-33, docs/invariants.md "Design mode"): one sandboxed view per
// live tab, at most MAX_LIVE_DESIGN_VIEWS per window, each on its own origin, laid over the frame the shell reports.
import { randomBytes, randomUUID } from 'node:crypto';
import { nativeImage, WebContentsView, type NativeImage, type Rectangle, type WebContents } from 'electron';
import { MARKUP_NAME, MAX_MARKUP_ELEMENT_CHARS, MAX_MARKUP_FACT_CHARS, MAX_MARKUP_FACTS } from '../../../shared/design-markup';
import { MAX_RENDER_IMAGE_SIDE, MAX_RENDER_SCALE, pngSize, renderScale } from '../../../shared/design-render';
import { DESIGN_NAME, isDesignId, SCREEN_FILE } from '../../../shared/design-paths';
import { JOURNEY_STEP_TIMEOUT_MS } from '../../../shared/design-journey';
import { visibleText } from '../../../shared/visible-text';
import { MAX_IMAGE_BASE64_LENGTH } from '../../../shared/types/content';
import type { DesignPreviewImage, DesignPreviewInfo, JourneyStep, JourneyStepResult, TweaksDeclaration } from '../../../shared/types/design';
import { isTweakColor, MAX_TWEAK_LABEL_CHARS, MAX_TWEAK_VALUE_CHARS, TWEAK_ID, TWEAK_TOKEN_NAME, tweakCss } from '../../../shared/design-tweaks';
import {
  MAX_DESIGN_LAST_FRAME_CHARS,
  MAX_DESIGN_TABS,
  type DesignFreeze,
  type DesignFreezeElement,
  type DesignReplayProgress,
  MAX_DESIGN_WIDTH,
  MIN_DESIGN_WIDTH,
  type DesignPreviewStatus,
  type ShellDesignPreview,
  type ShellEditorTab,
} from '../../preload/shell-channels';
import type { BrowserTabsEditor } from '../browser-tabs';
import type { PersistedDesignTab } from '../panel-state-store';
import { DESIGN_SCHEME } from '../protocol';
import { mainFrameLoadFailed, registerDesignContents } from '../security';
import { JOURNEY_HIGHLIGHT_ATTRIBUTE, runJourney, untilAborted } from './design-journey';
import { DESIGN_PARTITION, type DesignViewTarget } from './design-session';

// PD-31: beyond this many live views in a window the least recently shown one is destroyed, and rebuilt when shown again.
export const MAX_LIVE_DESIGN_VIEWS = 4;
const DEFAULT_WIDTH = 1280;
const DEFAULT_STATE = 'default';
// An isolated world of the design page's own, apart from Electron's (999); the page's scripts never see its globals.
const PAGE_WORLD_ID = 1001;
const LAST_FRAME_WIDTH = 960;
const LAST_FRAME_QUALITY = 70;
const PROVENANCE_SELECTOR = '[data-ds-component],[data-ds-variant],[data-ds-bind],[data-ds-decision],[data-ds-new]';

/** The chat a tab belongs to: a loaded chat view, by its view id and authority. */
export interface DesignChat {
  readonly panelId: string;
  readonly authority: string;
}

// whether the authority's core can serve the preview now
export type DesignSupport = 'yes' | 'updateServer' | 'offline';

export interface DesignPreviewsDeps {
  readonly editor: Pick<BrowserTabsEditor, 'activeTabId' | 'activateBrowserTab' | 'leaveBrowserTab' | 'browserTabsChanged'>;
  readonly window: { isDestroyed(): boolean; getContentBounds(): Rectangle; readonly contentView: { addChildView(view: WebContentsView): void; removeChildView(view: WebContentsView): void } };
  // the overlay moves above a view just added
  readonly onRestack: () => void;
  readonly support: (authority: string) => DesignSupport;
  // design.info on the authority's own core
  readonly info: (target: DesignViewTarget, relPath: string) => Promise<DesignPreviewInfo | undefined>;
  readonly setTabs: (chatPanelId: string, tabs: readonly PersistedDesignTab[]) => void;
  // a host teardown closes every chat and leaves the saved tabs as they were
  readonly retainingStates: () => boolean;
  readonly hostName: (authority: string) => string | undefined;
  // main's own loopback server; false when the browser was not opened
  readonly openInBrowser: (target: DesignViewTarget, relPath: string) => Promise<boolean>;
  readonly revoke: (target: DesignViewTarget) => void;
  readonly copy: (text: string) => Promise<void>;
  // mentions the file's absolute path in the chat
  readonly mention: (chat: DesignChat, path: string) => Promise<void>;
  // one toast: the design could not be opened in the browser
  readonly openInBrowserFailed: () => void;
  // a design view that held keyboard focus closed or hid; a hidden view keeps focus, so the owner moves it
  readonly focusAway: () => void;
  readonly log: (line: string) => void;
  // the design session's proxy is set; a view loads only after it, and none loads when it failed (PD-7)
  readonly sessionReady: Promise<void>;
  // a journey replay's progress, for the shell's step strip
  readonly replayProgress: (progress: DesignReplayProgress) => void;
  // a tab closed for good, so the shell lets go of its markup
  readonly tabClosed: (tabId: string) => void;
  readonly replayReadyMs?: number;
  readonly replayPauseMs?: number;
}

interface LiveView {
  readonly view: WebContentsView;
  // the URL host, which names the tab's design (PD-31: an origin per view)
  readonly token: string;
  loaded: boolean;
  // the last main-frame load failed; Electron emits did-finish-load after did-fail-load too, which must not show the error page
  loadFailed: boolean;
  // from dom-ready until the next document starts loading: a sheet inserted now lands in the document dom-ready styled
  documentReady: boolean;
  // the states the current document's sheets name; a user sheet cannot be removed, so one is added only for new states
  sheetStates: string | undefined;
  // the insertCSS key of each tweak in the current document, by property; a new document starts with none
  tweakKeys: Map<string, string>;
  // every tweak insert and removal of the view, in order, so a key is always known before its removal
  tweakQueue: Promise<void>;
}

interface DesignTab {
  readonly id: string;
  readonly chat: DesignChat;
  readonly designId: string;
  readonly relPath: string;
  width: number;
  // the width is the user's or core's, not the primary's
  widthChosen: boolean;
  state: string;
  provenance: boolean;
  status: DesignPreviewStatus;
  info: DesignPreviewInfo | undefined;
  // the shell fetches the frame by its id (designLastFrame), so no editor-state publish carries it
  lastFrame: { readonly id: number; readonly url: string } | undefined;
  live: LiveView | undefined;
  lastShown: number;
  // each info request's number, so an older answer never lands over a newer one
  infoRun: number;
  // markup is on (PD-12): the shell draws over its capture, so the view stays hidden
  markup: boolean;
  // a freeze is capturing the view, so no tweak may change what it captures
  freezing: boolean;
  // the tweaks applied to the tab (PD-13), property → stop token, each a control and stop of info.tweaks; re-applied on every document
  readonly tweaks: Map<string, string>;
}

interface ChatTabs {
  readonly tabs: DesignTab[];
  active: DesignTab | undefined;
  // a design tab was the active editor tab when the chat was left
  shown: boolean;
  persisted: string | undefined;
}

// PD-44: one constant sheet per document names every declared state, and the state shown is an attribute on <html> that the
// isolated world sets, so a static design switches with scripts off and no sheet is ever removed or stacked.
const STATE_ATTRIBUTE = 'data-damocles-state';
const PROVENANCE_ATTRIBUTE = 'data-damocles-provenance';

function statesCss(states: readonly string[]): string {
  return states.map((state) => `html[${STATE_ATTRIBUTE}="${state}"] [data-ds-state-only]:not([data-ds-state-only~="${state}"]) { display: none !important; }`).join('\n');
}

// The replay's outline of each target: an element the journey's isolated world places, styled from this user sheet only.
const REPLAY_CSS = `[${JOURNEY_HIGHLIGHT_ATTRIBUTE}] { position: fixed !important; z-index: 2147483647 !important; pointer-events: none !important; box-sizing: border-box !important; margin: 0 !important; padding: 0 !important; border: 2px solid #7c5cff !important; border-radius: 6px !important; box-shadow: 0 0 0 4px rgb(124 92 255 / 0.25) !important; transition: left 0.2s, top 0.2s, width 0.2s, height 0.2s; }
@media (prefers-reduced-motion: reduce) { [${JOURNEY_HIGHLIGHT_ATTRIBUTE}] { transition: none !important; } }`;
// a replay waits this long for the screen's view to show, and with motion lets each outlined target show this long
const REPLAY_READY_MS = 15_000;
const REPLAY_PAUSE_MS = 600;
const REPLAY_POLL_MS = 100;
// past every step's own deadline and pause, so only a page that stopped answering reaches it
const REPLAY_SLACK_MS = 10_000;

// The markup's read of the live page, in a world of its own apart from the page's (1001) and the runner's (1002).
const FREEZE_WORLD_ID = 1003;
export const MAX_FREEZE_ELEMENTS = 2000;
const MAX_FREEZE_OUTPUT_CHARS: number = 512 * 1024;
const FREEZE_TAG = /^[a-z][a-z0-9-]{0,31}$/;
const DECISION_ID = /^D[1-9][0-9]{0,5}$/;
// coordinates past this many CSS px from the viewport are clamped, so no page can hand main an unbounded number
const FREEZE_PX = 100_000;

// Runs in the freeze world, so the page's scripts cannot reach its globals; bounded here, then parsed as hostile in main.
const FREEZE_SCRIPT = `(() => {
  const cut = (value) => (value === null ? null : String(value).slice(0, ${MAX_MARKUP_FACT_CHARS}));
  const out = { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio, els: [] };
  let size = 0;
  for (const el of document.querySelectorAll(${JSON.stringify(PROVENANCE_SELECTOR)})) {
    if (out.els.length >= ${MAX_FREEZE_ELEMENTS}) break;
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0 || !el.checkVisibility({ visibilityProperty: true })) continue;
    const item = [el.tagName.toLowerCase(), cut(el.getAttribute('data-ds-component')), cut(el.getAttribute('data-ds-variant')), cut(el.getAttribute('data-ds-bind')), cut(el.getAttribute('data-ds-decision')), el.hasAttribute('data-ds-new'), box.x, box.y, box.width, box.height];
    size += JSON.stringify(item).length;
    if (size > ${MAX_FREEZE_OUTPUT_CHARS - 1024}) break;
    out.els.push(item);
  }
  return JSON.stringify(out);
})()`;

const freezeNumber = (value: unknown, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('The page returned a malformed element list');
  return Math.round(Math.min(max, Math.max(min, value)) * 10) / 10;
};
const freezeText = (value: unknown): string | null => {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('The page returned a malformed element list');
  // visibleText keeps a tab, which no markup name or fact may hold (core refuses control characters)
  return visibleText(value).replaceAll('\t', ' ').slice(0, MAX_MARKUP_FACT_CHARS);
};

/** The freeze world's answer, parsed as hostile: a bounded string, then each field typed, clamped and cut. */
export function parseFreezeOutput(raw: unknown): { readonly width: number; readonly height: number; readonly devicePixelRatio: number; readonly elements: DesignFreezeElement[] } {
  if (typeof raw !== 'string' || raw.length > MAX_FREEZE_OUTPUT_CHARS) throw new Error('The page returned a malformed element list');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('The page returned a malformed element list');
  }
  if (typeof data !== 'object' || data === null) throw new Error('The page returned a malformed element list');
  const { w, h, dpr, els } = data as Record<string, unknown>;
  if (!Array.isArray(els) || els.length > MAX_FREEZE_ELEMENTS) throw new Error('The page returned a malformed element list');
  const elements = els.map((item: unknown): DesignFreezeElement => {
    if (!Array.isArray(item) || item.length !== 10 || typeof item[0] !== 'string' || typeof item[5] !== 'boolean') throw new Error('The page returned a malformed element list');
    const component = freezeText(item[1]);
    const facts = ([['variant', item[2]], ['bind', item[3]], ['decision', item[4]]] as const).flatMap(([key, value]) => {
      const shown = freezeText(value);
      return shown === null ? [] : [`${key} ${shown}`.slice(0, MAX_MARKUP_FACT_CHARS)];
    });
    if (item[5]) facts.push('new');
    return {
      element: component !== null && component.trim() !== '' ? component.slice(0, MAX_MARKUP_ELEMENT_CHARS) : FREEZE_TAG.test(item[0]) ? item[0] : 'element',
      rect: [freezeNumber(item[6], -FREEZE_PX, FREEZE_PX), freezeNumber(item[7], -FREEZE_PX, FREEZE_PX), freezeNumber(item[8], 0, FREEZE_PX), freezeNumber(item[9], 0, FREEZE_PX)],
      facts: facts.slice(0, MAX_MARKUP_FACTS),
    };
  });
  if (typeof dpr !== 'number' || !Number.isFinite(dpr) || dpr <= 0 || dpr > 64) throw new Error('The page returned a malformed element list');
  return { width: freezeNumber(w, 0, FREEZE_PX), height: freezeNumber(h, 0, FREEZE_PX), devicePixelRatio: dpr, elements };
}

// A read or capture of the freeze that answers in none of this is the page holding its renderer.
const FREEZE_CAPTURE_MS = 5_000;

function answerWithin<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The live view's viewport (`width` × `height` CSS px, shown at zoom factor `zoom`) as a PNG at PD-41's scale: the largest up
 * to MAX_RENDER_SCALE whose longest side stays at or below MAX_RENDER_IMAGE_SIDE, whatever zoom the tab shows it at. CDP's
 * clip scale renders the page again at that scale with no resize and no reload, so interactive state and the CSS viewport
 * stay as they are. Its output is measured, never assumed.
 */
async function captureAtScale(contents: WebContents, width: number, height: number, zoom: number): Promise<{ readonly png: Buffer; readonly width: number; readonly height: number }> {
  if (contents.debugger.isAttached()) throw new Error('Another debugger holds the preview');
  contents.debugger.attach('1.3');
  try {
    // the clip is in the view's DIP, which page zoom scales: the viewport is width × zoom of them, and each image px per DIP is scale ÷ zoom
    const clip = { x: 0, y: 0, width: width * zoom, height: height * zoom };
    let scale = renderScale(width, height, MAX_RENDER_SCALE);
    for (let attempt = 0; ; attempt++) {
      const answer = await answerWithin(
        contents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false, clip: { ...clip, scale: scale / zoom } }),
        FREEZE_CAPTURE_MS,
        'The preview did not answer the capture',
      ) as { data?: unknown };
      if (typeof answer?.data !== 'string') throw new Error('The preview returned no capture');
      const png = Buffer.from(answer.data, 'base64');
      const size = pngSize(png);
      const longest = Math.max(size.width, size.height);
      // a second try covers a renderer that scales the clip by its own device scale too; the send's fit is the last guard
      if (longest <= MAX_RENDER_IMAGE_SIDE || attempt === 1) return { png, ...size };
      scale = Math.floor(scale * (MAX_RENDER_IMAGE_SIDE / longest) * 1000) / 1000;
    }
  } finally {
    if (!contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
  }
}

// The band a width sits in, as the shell's chip names it: the widest breakpoint at or below it, else base.
function breakpointOf(width: number, info: DesignPreviewInfo): string {
  let band = 'base';
  let reached = 0;
  for (const breakpoint of info.breakpoints) {
    if (MARKUP_NAME.test(breakpoint.name) && breakpoint.width <= width && breakpoint.width > reached) {
      band = breakpoint.name;
      reached = breakpoint.width;
    }
  }
  return band;
}

const PROVENANCE_CSS = `html[${PROVENANCE_ATTRIBUTE}] :is(${PROVENANCE_SELECTOR}) { outline: 1px dashed #7c5cff !important; outline-offset: -1px !important; }`;

// Runs in its own world and writes only attributes and textContent; nothing it returns is read back.
function pageScript(state: string | undefined, provenance: boolean): string {
  return `(() => {
  const root = document.documentElement;
  if (${JSON.stringify(state ?? null)} === null) root.removeAttribute(${JSON.stringify(STATE_ATTRIBUTE)});
  else root.setAttribute(${JSON.stringify(STATE_ATTRIBUTE)}, ${JSON.stringify(state ?? '')});
  if (${provenance ? 'true' : 'false'}) root.setAttribute(${JSON.stringify(PROVENANCE_ATTRIBUTE)}, '');
  else root.removeAttribute(${JSON.stringify(PROVENANCE_ATTRIBUTE)});
  const held = window.__damoclesProvenance;
  if (${provenance ? 'false' : 'true'}) {
    if (held) { document.removeEventListener('mouseover', held.over, true); held.label.remove(); delete window.__damoclesProvenance; }
    return;
  }
  if (held) return;
  const keys = ['component', 'variant', 'bind', 'decision', 'new'];
  const label = document.createElement('div');
  label.setAttribute('aria-hidden', 'true');
  Object.assign(label.style, { position: 'fixed', zIndex: '2147483647', pointerEvents: 'none', padding: '2px 6px', borderRadius: '4px', font: '11px/1.4 ui-monospace, monospace', background: '#1e1b2e', color: '#f4f1ff', maxWidth: '480px', whiteSpace: 'pre-wrap' });
  const over = (event) => {
    const target = event.target instanceof Element ? event.target.closest(${JSON.stringify(PROVENANCE_SELECTOR)}) : null;
    if (!target) { label.remove(); return; }
    label.textContent = keys.flatMap((key) => { const value = target.getAttribute('data-ds-' + key); return value === null ? [] : [value === '' ? key : key + ' ' + value.slice(0, 80)]; }).join(' · ').slice(0, 400);
    const box = target.getBoundingClientRect();
    label.style.left = Math.max(0, box.left) + 'px';
    label.style.top = Math.max(0, box.top - 20) + 'px';
    (document.body || document.documentElement).append(label);
  };
  document.addEventListener('mouseover', over, true);
  window.__damoclesProvenance = { label, over };
})();`;
}

// A state names a CSS attribute value main builds a selector from, and a remote core is another trust domain, so main
// keeps only names of core's own alphabet.
function checkedInfo(info: DesignPreviewInfo): DesignPreviewInfo {
  return {
    ...info,
    screenId: info.screenId !== null && DESIGN_NAME.test(info.screenId) ? info.screenId : null,
    title: info.title === null ? null : visibleText(info.title.slice(0, 200)),
    states: info.states.filter((state) => DESIGN_NAME.test(state)),
    tweaks: checkedTweaks(info.tweaks ?? null),
  };
}

// Main keeps only controls with a plain id, a token property no other control sets, token stops and a well-formed lock, and a
// swatch only over literal colors, so no CSS, DOM id or shell style ever carries a core's other text.
function checkedTweaks(tweaks: TweaksDeclaration | null): TweaksDeclaration | null {
  if (!tweaks) return null;
  const ids = new Set<string>();
  const properties = new Set<string>();
  const controls = tweaks.controls
    .filter((control) => {
      const kept = TWEAK_ID.test(control.id) && !ids.has(control.id) && TWEAK_TOKEN_NAME.test(control.property) && !properties.has(control.property)
        && control.stops.every((stop) => TWEAK_TOKEN_NAME.test(stop.token) && stop.token !== control.property)
        && (control.locked === null || (DECISION_ID.test(control.locked.decisionId) && TWEAK_TOKEN_NAME.test(control.locked.value)));
      ids.add(control.id);
      properties.add(control.property);
      return kept;
    })
    .map((control) => ({
      ...control,
      label: control.label.slice(0, MAX_TWEAK_LABEL_CHARS),
      kind: control.kind === 'swatch' && control.stops.every((stop) => isTweakColor(stop.value)) ? 'swatch' as const : 'segment' as const,
      stops: control.stops.map((stop) => ({ token: stop.token, value: stop.value.slice(0, MAX_TWEAK_VALUE_CHARS) })),
    }));
  return controls.length > 0 ? { toolCallId: tweaks.toolCallId, controls } : null;
}

function tweakLockedAt(info: DesignPreviewInfo, property: string, token: string): boolean {
  return info.tweaks?.controls.some((control) => control.property === property && control.locked?.value === token && control.stops.some((stop) => stop.token === token)) === true;
}

/** Whether `token` is a stop of an unlocked control of `info` whose property is `property`. */
export function tweakOffered(info: DesignPreviewInfo | undefined, property: string, token: string): boolean {
  if (!TWEAK_TOKEN_NAME.test(property) || !TWEAK_TOKEN_NAME.test(token)) return false;
  const control = info?.tweaks?.controls.find((candidate) => candidate.property === property);
  return control !== undefined && control.locked === null && control.stops.some((stop) => stop.token === token);
}

/** `image` as one PNG image block (PD-41): longest side at most MAX_RENDER_IMAGE_SIDE, base64 within MAX_IMAGE_BASE64_LENGTH. */
function fitForModel(image: NativeImage): { readonly data: string; readonly width: number; readonly height: number } {
  const size = image.getSize();
  if (size.width === 0 || size.height === 0) throw new Error('The image is empty');
  let fit = Math.min(1, MAX_RENDER_IMAGE_SIDE / Math.max(size.width, size.height));
  // an extreme aspect ratio would floor its short side to 0
  const scaled = (factor: number) => ({ width: Math.max(1, Math.floor(size.width * factor)), height: Math.max(1, Math.floor(size.height * factor)), quality: 'best' as const });
  let fitted = fit < 1 ? image.resize(scaled(fit)) : image;
  let data = fitted.toPNG().toString('base64');
  // a busy frame shrinks until it fits one image block
  for (let retry = 0; retry < 3 && data.length > MAX_IMAGE_BASE64_LENGTH; retry++) {
    fit *= 0.7;
    fitted = image.resize(scaled(fit));
    data = fitted.toPNG().toString('base64');
  }
  if (data.length > MAX_IMAGE_BASE64_LENGTH) throw new Error('The image is too large for one image');
  const { width, height } = fitted.getSize();
  return { data, width, height };
}

const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';
// The shell draws on a freeze capture of at most MAX_RENDER_IMAGE_SIDE a side; past this a PNG is refused before decoding.
export const MAX_MARKUP_IMAGE_SIDE = 4096;

/** The shell's flattened markup (a PNG data URL) as base64 for the model and feedback/F<n>.png, fitted as `fitForModel` does. */
export function markupPngForModel(dataUrl: string): string {
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) throw new Error('The markup image is not a PNG');
  // the IHDR's 24 bytes are the first 32 base64 characters; a small PNG may declare dimensions the decode would allocate
  const size = pngSize(Buffer.from(dataUrl.slice(PNG_DATA_URL_PREFIX.length, PNG_DATA_URL_PREFIX.length + 32), 'base64'));
  if (size.width > MAX_MARKUP_IMAGE_SIDE || size.height > MAX_MARKUP_IMAGE_SIDE) throw new Error(`The markup image is ${size.width} × ${size.height} px, over ${MAX_MARKUP_IMAGE_SIDE} px`);
  const image = nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) throw new Error('The markup image is not a PNG');
  return fitForModel(image).data;
}

const clampWidth = (width: number): number => Math.min(MAX_DESIGN_WIDTH, Math.max(MIN_DESIGN_WIDTH, Math.round(width)));
const fileName = (relPath: string): string => relPath.slice(relPath.lastIndexOf('/') + 1);

export class DesignPreviews {
  private readonly deps: DesignPreviewsDeps;
  private readonly chats = new Map<DesignChat, ChatTabs>();
  private readonly tokens = new Map<string, DesignTab>();
  private selected: DesignChat | undefined;
  // DIP rectangle of the active design tab's frame, its corner radius and the view's zoom factor; undefined while none shows
  private frame: { readonly tabId: string; readonly bounds: Rectangle; readonly radius: number; readonly zoomFactor: number } | undefined;
  private shownCount = 0;
  private frameIds = 0;
  // the tab layout last showed, so lastShown counts each time a tab is shown, not each layout
  private lastShownId: string | undefined;
  // the tabs whose live view a journey replay drives
  private readonly replaying = new Set<DesignTab>();

  constructor(deps: DesignPreviewsDeps) {
    this.deps = deps;
  }

  /** The design a live view's token names, for the design scheme's handler. */
  targetOf(token: string): DesignViewTarget | undefined {
    const tab = this.tokens.get(token);
    return tab ? { authority: tab.chat.authority, designId: tab.designId } : undefined;
  }

  /** The selected chat's design tabs, in order. */
  tabs(): ShellEditorTab[] {
    const entry = this.selected ? this.chats.get(this.selected) : undefined;
    return (entry?.tabs ?? []).map((tab) => {
      const hostName = tab.chat.authority === 'local' ? undefined : this.deps.hostName(tab.chat.authority);
      const path = tab.info?.path ?? tab.relPath;
      const preview: ShellDesignPreview = {
        designId: tab.designId,
        relPath: tab.relPath,
        path,
        ...(hostName !== undefined ? { hostName } : {}),
        status: tab.status,
        ...(tab.info ? { info: { breakpoints: tab.info.breakpoints, primary: tab.info.primary, checked: tab.info.checked, journey: tab.info.journey, states: tab.info.states, tweaks: tab.info.tweaks ?? null } } : {}),
        width: tab.width,
        state: tab.state,
        provenance: tab.provenance,
        ...(tab.status === 'reconnecting' && tab.lastFrame !== undefined ? { lastFrameId: tab.lastFrame.id } : {}),
        ...(tab.tweaks.size > 0 ? { tweaks: Object.fromEntries(tab.tweaks) } : {}),
      };
      return { id: tab.id, kind: 'designPreview', title: this.titleOf(tab), displayPath: path, dirty: false, readOnly: true, conflict: false, designPreview: preview };
    });
  }

  private titleOf(tab: DesignTab): string {
    const { screenId, title } = tab.info ?? { screenId: null, title: null };
    if (screenId !== null && title !== null) return `${screenId} · ${title}`;
    return title ?? screenId ?? fileName(tab.relPath);
  }

  // A chat holding design tabs stays loaded, as one holding browser pages does, so retention never drops its tabs.
  holdsTabs(chat: DesignChat): boolean {
    return (this.chats.get(chat)?.tabs.length ?? 0) > 0;
  }

  holds(tabId: string): boolean {
    return this.visibleTab(tabId) !== undefined;
  }

  focused(): boolean {
    return this.activeTab()?.live?.view.webContents.isFocused() ?? false;
  }

  /**
   * Opens or shows the preview of `relPath` in design chat `chat` (core's design.openPreview, a webview's Open preview): its
   * tab becomes the chat's active one, and the editor shows it when the chat is selected.
   */
  open(chat: DesignChat, designId: string, relPath: string): void {
    const entry = this.entryOf(chat);
    let tab = entry.tabs.find((candidate) => candidate.designId === designId && candidate.relPath === relPath);
    if (!tab && entry.tabs.length >= MAX_DESIGN_TABS) {
      this.deps.log(`[design] refused a preview of design ${designId}: its chat holds ${MAX_DESIGN_TABS} design tabs`);
      return;
    }
    if (!tab) {
      tab = this.newTab(chat, designId, relPath, {});
      if (!tab) return;
      entry.tabs.push(tab);
    }
    entry.active = tab;
    entry.shown = true;
    this.persist(chat);
    if (chat === this.selected) {
      this.deps.editor.browserTabsChanged();
      this.deps.editor.activateBrowserTab(tab.id);
    }
    this.layout();
  }

  /** A relaunch's saved tabs of a restored chat; they come back without taking the active editor tab. */
  restore(chat: DesignChat, saved: readonly PersistedDesignTab[]): void {
    const entry = this.entryOf(chat);
    for (const tab of saved) {
      if (entry.tabs.length >= MAX_DESIGN_TABS) break;
      if (entry.tabs.some((candidate) => candidate.designId === tab.designId && candidate.relPath === tab.relPath)) continue;
      const restored = this.newTab(chat, tab.designId, tab.relPath, tab);
      if (restored) entry.tabs.push(restored);
    }
    entry.active ??= entry.tabs[0];
    this.persist(chat);
    if (chat === this.selected) this.deps.editor.browserTabsChanged();
  }

  // undefined for a design id the core protocol cannot carry, whose every design.info would fail
  private newTab(chat: DesignChat, designId: string, relPath: string, saved: Partial<Pick<PersistedDesignTab, 'width' | 'state' | 'provenance'>>): DesignTab | undefined {
    if (!isDesignId(designId)) {
      this.deps.log(`[design] refused a preview of a design whose id of ${designId.length} characters is not a design id`);
      return undefined;
    }
    const tab: DesignTab = {
      id: `design-${randomUUID()}`,
      chat,
      designId,
      relPath,
      width: saved.width ?? DEFAULT_WIDTH,
      widthChosen: saved.width !== undefined,
      state: saved.state ?? DEFAULT_STATE,
      provenance: saved.provenance ?? false,
      status: 'loading',
      info: undefined,
      lastFrame: undefined,
      live: undefined,
      lastShown: 0,
      infoRun: 0,
      markup: false,
      freezing: false,
      tweaks: new Map(),
    };
    this.loadInfo(tab);
    return tab;
  }

  // design.info, unless the authority's daemon lacks it (updateServer) or is away (reconnecting, until connectionChanged).
  private loadInfo(tab: DesignTab): void {
    const support = this.deps.support(tab.chat.authority);
    if (support !== 'yes') {
      this.setStatus(tab, support === 'updateServer' ? 'updateServer' : 'reconnecting');
      return;
    }
    const run = ++tab.infoRun;
    this.deps.info({ authority: tab.chat.authority, designId: tab.designId }, tab.relPath).then((info) => {
      if (run !== tab.infoRun || !this.tabExists(tab)) return;
      if (!info) {
        this.deps.log(`[design] design ${tab.designId} has no readable screen ${tab.relPath}`);
        this.setStatus(tab, 'failed');
        return;
      }
      tab.info = checkedInfo(info);
      info = tab.info;
      if (!tab.widthChosen) tab.width = clampWidth(info.primary);
      if (info.states.length === 0) tab.state = DEFAULT_STATE;
      else if (!info.states.includes(tab.state)) tab.state = info.states[0]!;
      // a tweak no longer declared, or locked at another value, leaves the page; one a decision locked at its value stays
      for (const [property, token] of tab.tweaks) if (!tweakOffered(info, property, token) && !tweakLockedAt(info, property, token)) this.removeTweak(tab, property);
      if (tab.live?.loaded) {
        this.insertSheets(tab, tab.live);
        void this.applyPage(tab, tab.live);
      }
      if (tab.status !== 'ready') tab.status = tab.live?.loaded ? 'ready' : 'loading';
      this.changed(tab);
      this.layout();
    }, (err: unknown) => {
      if (run !== tab.infoRun || !this.tabExists(tab)) return;
      this.deps.log(`[design] design.info of ${tab.designId} failed: ${err instanceof Error ? err.message : String(err)}`);
      this.setStatus(tab, this.deps.support(tab.chat.authority) === 'offline' ? 'reconnecting' : 'failed');
    });
  }

  private tabExists(tab: DesignTab): boolean {
    return this.chats.get(tab.chat)?.tabs.includes(tab) === true;
  }

  private setStatus(tab: DesignTab, status: DesignPreviewStatus): void {
    if (tab.status === status) return;
    tab.status = status;
    this.changed(tab);
    this.layout();
  }

  // a tab's shown fields changed; republished when it is one of the selected chat's
  private changed(tab: DesignTab): void {
    this.persist(tab.chat);
    if (tab.chat === this.selected) this.deps.editor.browserTabsChanged();
  }

  /** The shell's frame of the active design tab, in DIPs, and the view's zoom factor; undefined while none shows. */
  setBounds(frame: { readonly tabId: string; readonly bounds: Rectangle; readonly radius: number; readonly zoomFactor: number } | undefined): void {
    this.frame = frame;
    this.layout();
  }

  /** A user's width, state or provenance for a tab of the selected chat; throws for any other tab or a value out of range. */
  set(tabId: string, change: { readonly width?: number; readonly state?: string; readonly provenance?: boolean }): void {
    const tab = this.tabOf(tabId);
    if (change.state !== undefined) {
      const states = tab.info?.states ?? [];
      if (states.length === 0 ? change.state !== DEFAULT_STATE : !states.includes(change.state)) throw new Error('Not a state of the screen');
    }
    if (change.width !== undefined) {
      tab.width = clampWidth(change.width);
      tab.widthChosen = true;
    }
    if (change.state !== undefined && change.state !== tab.state) {
      tab.state = change.state;
      if (tab.live?.loaded) void this.applyPage(tab, tab.live);
    }
    if (change.provenance !== undefined && change.provenance !== tab.provenance) {
      tab.provenance = change.provenance;
      if (tab.live?.loaded) void this.applyPage(tab, tab.live);
    }
    this.changed(tab);
  }

  /** The toolbar's or tab menu's Open in browser, a user's click: main's own server serves the default state. */
  async openInBrowser(tabId: string): Promise<void> {
    const tab = this.tabOf(tabId);
    const opened = await this.deps.openInBrowser({ authority: tab.chat.authority, designId: tab.designId }, tab.relPath).catch((err: unknown) => {
      this.deps.log(`[design] opening design ${tab.designId} in the browser failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    });
    if (!opened) this.deps.openInBrowserFailed();
  }

  /** The toolbar's Screenshot: the active tab's live view as the user sees it, longest side at most MAX_RENDER_IMAGE_SIDE (PD-41). */
  async screenshot(tabId: string): Promise<{ readonly chat: DesignChat; readonly image: DesignPreviewImage }> {
    const tab = this.tabOf(tabId);
    const live = tab.live;
    if (!live?.loaded || tab.status !== 'ready' || !live.view.getVisible()) throw new Error('The preview is not showing');
    const captured = await live.view.webContents.capturePage();
    if (tab.live !== live) throw new Error('The preview closed during the capture');
    const size = captured.getSize();
    if (size.width === 0 || size.height === 0) throw new Error('The preview showed nothing to capture');
    const { data, width, height } = fitForModel(captured);
    return { chat: tab.chat, image: { mimeType: 'image/png', data, width, height } };
  }

  /**
   * Markup's freeze (PD-12, PD-41): the active tab's live view as the user sees it, interactive state kept, and its data-ds
   * elements read from the freeze world, at the tab's width. Markup turns on, so the view hides until `markupExit`.
   */
  async freeze(tabId: string): Promise<DesignFreeze> {
    const tab = this.tabOf(tabId);
    const live = tab.live;
    const info = tab.info;
    if (!live?.loaded || tab.status !== 'ready' || !live.view.getVisible() || !info) throw new Error('The preview is not showing');
    if (!SCREEN_FILE.test(tab.relPath)) throw new Error('Markup takes a screen of screens/ only');
    if (this.replaying.has(tab)) throw new Error('A journey is replaying in this preview');
    if (tab.freezing) throw new Error('A freeze is already capturing this preview');
    // a capture showing a tweak would show the designer a value no file holds
    if (tab.tweaks.size > 0) throw new Error('Tweaks are applied in this preview');
    tab.freezing = true;
    try {
      return await this.capture(tab, live, info);
    } finally {
      tab.freezing = false;
    }
  }

  private async capture(tab: DesignTab, live: LiveView, info: DesignPreviewInfo): Promise<DesignFreeze> {
    const contents = live.view.webContents;
    const zoom = contents.getZoomFactor();
    const page = parseFreezeOutput(await answerWithin(contents.executeJavaScriptInIsolatedWorld(FREEZE_WORLD_ID, [{ code: FREEZE_SCRIPT }]), FREEZE_CAPTURE_MS, 'The preview did not answer the element read'));
    // the 0.35 s preset glide changes the zoom before the width, so a freeze during it would map marks to the wrong width
    if (Math.abs(page.width - tab.width) > 1) throw new Error('The preview is changing width');
    if (page.height < 1) throw new Error('The preview showed nothing to capture');
    if (tab.live !== live || !this.tabExists(tab)) throw new Error('The preview closed during the capture');
    const captured = await captureAtScale(contents, tab.width, page.height, zoom);
    if (tab.live !== live || !this.tabExists(tab)) throw new Error('The preview closed during the capture');
    if (tab.tweaks.size > 0) throw new Error('Tweaks are applied in this preview');
    tab.markup = true;
    this.layout();
    return {
      png: `data:image/png;base64,${captured.png.toString('base64')}`,
      imageWidth: captured.width,
      imageHeight: captured.height,
      width: tab.width,
      height: page.height,
      breakpoint: breakpointOf(tab.width, info),
      zoom,
      pixelRatio: Math.round((page.devicePixelRatio / zoom) * 1000) / 1000,
      scale: Math.round((captured.width / tab.width) * 1000) / 1000,
      state: tab.state,
      screen: info.screenId,
      file: tab.relPath,
      elements: page.elements,
    };
  }

  /** Markup on again over the capture the shell kept (PD-12), with no new capture; the view hides. */
  markupEnter(tabId: string): void {
    this.tabOf(tabId).markup = true;
    this.layout();
  }

  /** Markup off: the view shows again over its frame. Any chat's tab, since a send ends markup after the user may have left the chat. */
  markupExit(tabId: string): void {
    const tab = this.allTabs().find((candidate) => candidate.id === tabId);
    if (!tab) return;
    tab.markup = false;
    this.layout();
  }

  /** The shell's page loaded again: the markup it drew is gone with it, so every view shows again. */
  shellLoaded(): void {
    for (const tab of this.allTabs()) tab.markup = false;
    this.layout();
  }

  /**
   * A stop of a declared tweak on the tab's live view (PD-13): `:root { <property>: var(<token>) !important }` as a user sheet,
   * built only from names that pass TWEAK_TOKEN_NAME and that the tab's latest declaration offers on an unlocked control. It
   * replaces the property's earlier sheet; no file changes.
   */
  applyTweak(tabId: string, property: string, token: string): void {
    const tab = this.tabOf(tabId);
    if (tab.markup || tab.freezing) throw new Error('Markup is on in this preview');
    if (!tweakOffered(tab.info, property, token)) throw new Error('Not a stop of a tweak this design offers');
    tab.tweaks.set(property, token);
    if (tab.live?.documentReady) this.insertTweak(tab, tab.live, property, token);
    this.changed(tab);
  }

  /** Reset: every tweak of the tab leaves its live view. */
  resetTweaks(tabId: string): void {
    const tab = this.tabOf(tabId);
    for (const property of [...tab.tweaks.keys()]) this.removeTweak(tab, property);
    this.changed(tab);
  }

  private removeTweak(tab: DesignTab, property: string): void {
    tab.tweaks.delete(property);
    const live = tab.live;
    if (!live) return;
    this.queueTweak(tab, live, async (contents) => {
      const key = live.tweakKeys.get(property);
      live.tweakKeys.delete(property);
      // a key of the document a navigation replaced names no sheet of the next one
      if (key !== undefined && live.documentReady) await contents.removeInsertedCSS(key);
    });
  }

  private insertTweak(tab: DesignTab, live: LiveView, property: string, token: string): void {
    const css = tweakCss(property, token);
    this.queueTweak(tab, live, async (contents) => {
      if (!live.documentReady) return;
      const previous = live.tweakKeys.get(property);
      live.tweakKeys.delete(property);
      if (previous !== undefined) await contents.removeInsertedCSS(previous);
      // removeInsertedCSS removes an author sheet only (measured on Electron 45: a user-origin sheet stays)
      live.tweakKeys.set(property, await contents.insertCSS(css, { cssOrigin: 'author' }));
    });
  }

  // One queue per view; a failed step is logged and the next one still runs.
  private queueTweak(tab: DesignTab, live: LiveView, step: (contents: WebContents) => Promise<void>): void {
    live.tweakQueue = live.tweakQueue.then(async () => {
      if (tab.live !== live || live.view.webContents.isDestroyed()) return;
      await step(live.view.webContents);
    }).catch((err: unknown) => this.cssFailed(tab, err));
  }

  /** The design chat a tab of the selected chat belongs to, for a markup send. */
  chatOfTab(tabId: string): DesignChat {
    return this.tabOf(tabId).chat;
  }

  /**
   * A journey replayed in the live view of `relPath`'s tab in design chat `chat`, opened or shown first, at the tab's width
   * (D93): the view's debugger is attached for the replay only and detached in `finally`, each target is outlined from the
   * journey's isolated world and a user sheet, never the page's script, and the view reloads after, which restores the page.
   * The journey's state shows on the page only, so the tab's own state and panels.json never change.
   */
  async replayJourney(chat: DesignChat, designId: string, relPath: string, state: string | null, steps: readonly JourneyStep[], reducedMotion: boolean, signal: AbortSignal): Promise<void> {
    this.open(chat, designId, relPath);
    const tab = this.chats.get(chat)?.tabs.find((candidate) => candidate.designId === designId && candidate.relPath === relPath);
    if (!tab) throw new Error('The design chat holds too many preview tabs');
    if (this.replaying.has(tab)) throw new Error('A journey is already replaying in this preview');
    this.replaying.add(tab);
    try {
      const live = await this.whenShowing(tab, signal);
      const contents = live.view.webContents;
      if (contents.debugger.isAttached()) throw new Error('Another debugger holds the preview');
      const pauseMs = reducedMotion ? 0 : this.deps.replayPauseMs ?? REPLAY_PAUSE_MS;
      const deadlineMs = steps.length * (JOURNEY_STEP_TIMEOUT_MS + pauseMs) + REPLAY_SLACK_MS;
      const stop = new AbortController();
      const abort = AbortSignal.any([signal, stop.signal]);
      const onDetach = (): void => stop.abort(new Error('The preview closed during the replay'));
      // a call the page never answered (a script looping in a handler) means its renderer is held, so no reload would run
      let unanswered = 0;
      const answered = <T>(work: Promise<T>): Promise<T> => {
        unanswered++;
        return untilAborted(work.finally(() => unanswered--), abort);
      };
      const results: JourneyStepResult[] = [];
      const post = (active: number | null, done: boolean): void => this.deps.replayProgress({ tabId: tab.id, steps, active, results: [...results], done, reducedMotion });
      contents.debugger.attach('1.3');
      contents.debugger.on('detach', onDetach);
      const deadline = setTimeout(() => stop.abort(new Error(`The replay took longer than ${Math.round(deadlineMs / 1000)} s`)), deadlineMs);
      try {
        post(null, false);
        await answered(contents.insertCSS(REPLAY_CSS, { cssOrigin: 'user' }));
        if (state !== null && state !== tab.state && (tab.info?.states ?? []).includes(state)) await answered(this.applyPage(tab, live, state));
        await runJourney({ send: (method, params) => answered(contents.debugger.sendCommand(method, params)) }, steps, {
          width: tab.width,
          signal: abort,
          ...(reducedMotion ? {} : { highlight: { pauseMs } }),
          onStep: (index, result) => {
            if (result) results.push(result);
            post(result ? null : index, false);
          },
        });
      } finally {
        clearTimeout(deadline);
        contents.debugger.off('detach', onDetach);
        if (!contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
        post(null, true);
        if (tab.live === live && !contents.isDestroyed()) {
          if (unanswered > 0) {
            this.deps.log(`[design] the page of design ${tab.designId} stopped answering during a replay; its view is built again`);
            this.destroyView(tab);
            this.setStatus(tab, 'loading');
          } else {
            live.loaded = false;
            contents.reload();
          }
        }
      }
    } finally {
      this.replaying.delete(tab);
    }
  }

  // The tab's live view once it is loaded and shown; a replay drives nothing the user cannot see.
  private async whenShowing(tab: DesignTab, signal: AbortSignal): Promise<LiveView> {
    const deadline = Date.now() + (this.deps.replayReadyMs ?? REPLAY_READY_MS);
    for (;;) {
      signal.throwIfAborted();
      if (!this.tabExists(tab)) throw new Error('The preview closed');
      const live = tab.live;
      if (live?.loaded && tab.status === 'ready' && live.view.getVisible()) return live;
      if (Date.now() >= deadline) throw new Error('The preview is not showing: select its design chat and try again');
      await new Promise<void>((resolve) => setTimeout(resolve, REPLAY_POLL_MS));
    }
  }

  async copyPath(tabId: string): Promise<void> {
    const tab = this.tabOf(tabId);
    if (!tab.info) throw new Error('The screen has not loaded yet');
    await this.deps.copy(tab.info.path);
  }

  /** The header's @: the screen's absolute path, mentioned in its design chat. */
  async mention(tabId: string): Promise<void> {
    const tab = this.tabOf(tabId);
    if (!tab.info) throw new Error('The screen has not loaded yet');
    await this.deps.mention(tab.chat, tab.info.path);
  }

  close(tabId: string): void {
    const tab = this.tabOf(tabId);
    const entry = this.chats.get(tab.chat)!;
    const index = entry.tabs.indexOf(tab);
    const wasActive = this.deps.editor.activeTabId() === tab.id;
    entry.tabs.splice(index, 1);
    if (entry.active === tab) entry.active = entry.tabs[Math.min(index, entry.tabs.length - 1)];
    if (entry.tabs.length === 0) entry.shown = false;
    this.dropTab(tab);
    this.persist(tab.chat);
    this.deps.editor.browserTabsChanged();
    if (wasActive && entry.active) this.deps.editor.activateBrowserTab(entry.active.id);
    else if (wasActive) this.deps.editor.leaveBrowserTab();
    this.layout();
  }

  // The active editor tab changed: a design tab becomes its chat's active one and the one view shown.
  activeChanged(tabId: string | null): void {
    const tab = tabId === null ? undefined : this.visibleTab(tabId);
    if (tab) this.chats.get(tab.chat)!.active = tab;
    // a user's activation retries a screen that failed: its facts when they never arrived, else its page
    if (tab?.status === 'failed' && !tab.info) this.loadInfo(tab);
    else if (tab?.status === 'failed' && !tab.live) tab.status = 'loading';
    else if (tab?.status === 'failed' && tab.live?.loadFailed) {
      tab.live.loaded = false;
      tab.status = 'loading';
      tab.live.view.webContents.reload();
      this.changed(tab);
    }
    this.layout();
  }

  /**
   * The swap, as browser tabs do it: the chat left keeps whether a design tab was active, the one selected shows its tab again.
   * `swapPages` runs the browser tabs' own swap once this selection moved, so neither falls back onto the other's old tabs.
   */
  chatSelected(chat: DesignChat | undefined, swapPages: () => void = () => undefined): void {
    const previous = this.selected;
    if (previous === chat) {
      swapPages();
      return;
    }
    const active = this.deps.editor.activeTabId();
    const left = previous ? this.chats.get(previous) : undefined;
    const leftShowing = left?.tabs.some((tab) => tab.id === active) ?? false;
    if (left) left.shown = leftShowing;
    this.selected = chat;
    swapPages();
    const entry = chat ? this.chats.get(chat) : undefined;
    this.deps.editor.browserTabsChanged();
    if (entry?.shown && entry.active) this.deps.editor.activateBrowserTab(entry.active.id);
    else if (leftShowing && this.deps.editor.activeTabId() === active) this.deps.editor.leaveBrowserTab();
    this.layout();
  }

  // A design tab never outlives its chat (PD-33).
  chatClosed(chat: DesignChat): void {
    if (chat === this.selected) this.chatSelected(undefined);
    const entry = this.chats.get(chat);
    this.chats.delete(chat);
    for (const tab of entry?.tabs ?? []) this.dropTab(tab);
  }

  /**
   * The designer wrote `paths` of design `designId` on `authority`, or with none a chat there began to hold it: its tabs read
   * their facts again, and after a write their views reload.
   */
  designChanged(authority: string, designId: string, paths: readonly string[]): void {
    for (const tab of this.allTabs()) {
      if (tab.chat.authority !== authority || tab.designId !== designId) continue;
      this.loadInfo(tab);
      if (tab.live && paths.length > 0) {
        tab.live.loaded = false;
        tab.live.view.webContents.reload();
      }
    }
  }

  /**
   * The authority's connection dropped or came back. A dropped one keeps each live view's last frame for the shell to dim under
   * Reconnecting…, and hides the view; one back reads each tab's facts again and reloads its view.
   */
  connectionChanged(authority: string, connected: boolean): void {
    for (const tab of this.allTabs()) {
      if (tab.chat.authority !== authority) continue;
      if (!connected) {
        if (tab.status === 'reconnecting') continue;
        // asked while the view still shows: a hidden view's surface may already be gone
        if (tab.live?.loaded) this.captureLastFrame(tab, tab.live);
        this.setStatus(tab, 'reconnecting');
        continue;
      }
      // a connection back before its core is ready leaves the frame until the core's chats reopened
      if (this.deps.support(authority) !== 'yes' || (tab.status !== 'reconnecting' && tab.status !== 'updateServer')) continue;
      tab.lastFrame = undefined;
      tab.status = 'loading';
      this.loadInfo(tab);
      if (tab.live) {
        tab.live.loaded = false;
        tab.live.view.webContents.reload();
      }
      this.changed(tab);
    }
    this.layout();
  }

  private captureLastFrame(tab: DesignTab, live: LiveView): void {
    live.view.webContents.capturePage().then((image) => {
      if (!this.tabExists(tab) || tab.status !== 'reconnecting') return;
      const size = image.getSize();
      if (image.isEmpty() || size.width === 0 || size.height === 0) {
        this.deps.log(`[design] the last frame of design ${tab.designId} was empty; none is kept`);
        return;
      }
      const scaled = size.width > LAST_FRAME_WIDTH ? image.resize({ width: LAST_FRAME_WIDTH }) : image;
      const url = `data:image/jpeg;base64,${scaled.toJPEG(LAST_FRAME_QUALITY).toString('base64')}`;
      if (url.length > MAX_DESIGN_LAST_FRAME_CHARS) {
        this.deps.log(`[design] the last frame of design ${tab.designId} is ${url.length} characters, over the cap; none is kept`);
        return;
      }
      tab.lastFrame = { id: ++this.frameIds, url };
      this.changed(tab);
    }, (err: unknown) => this.deps.log(`[design] capturing the last frame of design ${tab.designId} failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** The last frame of a reconnecting tab of the selected chat, which `tabs()` names by its id; null when it has none. */
  lastFrame(tabId: string): string | null {
    const tab = this.tabOf(tabId);
    return tab.status === 'reconnecting' ? tab.lastFrame?.url ?? null : null;
  }

  /** Closes every view and revokes every design's URLs; the window is going, and the app may outlive it (macOS). */
  dispose(): void {
    const revoked = new Set<string>();
    for (const tab of this.allTabs()) {
      this.destroyView(tab);
      const key = `${tab.chat.authority}\0${tab.designId}`;
      if (revoked.has(key)) continue;
      revoked.add(key);
      this.deps.revoke({ authority: tab.chat.authority, designId: tab.designId });
    }
    this.chats.clear();
    this.tokens.clear();
  }

  private allTabs(): DesignTab[] {
    return [...this.chats.values()].flatMap((entry) => entry.tabs);
  }

  private entryOf(chat: DesignChat): ChatTabs {
    let entry = this.chats.get(chat);
    if (!entry) {
      entry = { tabs: [], active: undefined, shown: false, persisted: undefined };
      this.chats.set(chat, entry);
    }
    return entry;
  }

  private visibleTab(tabId: string): DesignTab | undefined {
    return this.selected ? this.chats.get(this.selected)?.tabs.find((tab) => tab.id === tabId) : undefined;
  }

  // A tab id from the shell names one of the selected chat's design tabs, or nothing.
  private tabOf(tabId: string): DesignTab {
    const tab = this.visibleTab(tabId);
    if (!tab) throw new Error('Unknown design tab');
    return tab;
  }

  private activeTab(): DesignTab | undefined {
    const active = this.deps.editor.activeTabId();
    return active === null ? undefined : this.visibleTab(active);
  }

  // A tab closed for good; its design's served URLs stop working once no other tab in this window shows that design.
  private dropTab(tab: DesignTab): void {
    tab.infoRun++;
    tab.markup = false;
    this.destroyView(tab);
    this.deps.tabClosed(tab.id);
    const target = { authority: tab.chat.authority, designId: tab.designId };
    if (!this.allTabs().some((other) => other !== tab && other.chat.authority === target.authority && other.designId === target.designId)) this.deps.revoke(target);
  }

  private persist(chat: DesignChat): void {
    const entry = this.chats.get(chat);
    if (!entry || this.deps.retainingStates()) return;
    const tabs: PersistedDesignTab[] = entry.tabs.map((tab) => ({
      designId: tab.designId,
      relPath: tab.relPath,
      ...(tab.widthChosen ? { width: tab.width } : {}),
      ...(tab.state !== DEFAULT_STATE ? { state: tab.state } : {}),
      ...(tab.provenance ? { provenance: true } : {}),
    }));
    const persisted = JSON.stringify(tabs);
    if (persisted === entry.persisted) return;
    entry.persisted = persisted;
    this.deps.setTabs(chat.panelId, tabs);
  }

  private buildView(tab: DesignTab): LiveView {
    const view = new WebContentsView({
      webPreferences: {
        partition: DESIGN_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        javascript: true,
        disableDialogs: true,
        devTools: false,
        spellcheck: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        // Electron focuses a WebContents when it navigates; a design loading must leave focus where it is.
        focusOnNavigation: false,
      },
    });
    const token = randomBytes(16).toString('hex');
    // Before the first load, so the navigation lock applies to it.
    registerDesignContents(view.webContents, `${DESIGN_SCHEME}://${token}`);
    // WebRTC's sockets bypass webRequest and CSP; with UDP only through the session's refusing proxy, ICE reaches no host.
    view.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    view.setBackgroundColor('#ffffff');
    view.setVisible(false);
    const live: LiveView = { view, token, loaded: false, loadFailed: false, documentReady: false, sheetStates: undefined, tweakKeys: new Map(), tweakQueue: Promise.resolve() };
    this.tokens.set(token, tab);
    const contents = view.webContents;
    contents.on('dom-ready', () => {
      if (tab.live !== live) return;
      // insertCSS lasts one document, so each load adds the sheets again, the tweaks included.
      live.documentReady = true;
      live.sheetStates = undefined;
      this.insertSheets(tab, live);
      void this.applyPage(tab, live);
      this.queueTweak(tab, live, async () => live.tweakKeys.clear());
      for (const [property, tweakToken] of tab.tweaks) this.insertTweak(tab, live, property, tweakToken);
    });
    // a tweak applied while the next document loads waits for its dom-ready, which applies every tweak of the tab
    contents.on('did-start-navigation', (details) => {
      if (tab.live !== live || !details.isMainFrame || details.isSameDocument) return;
      live.documentReady = false;
      live.loadFailed = false;
    });
    contents.on('did-finish-load', () => {
      if (tab.live !== live || live.loadFailed || tab.status === 'reconnecting' || tab.status === 'updateServer') return;
      live.loaded = true;
      if (tab.info) this.setStatus(tab, 'ready');
    });
    contents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (tab.live !== live || !mainFrameLoadFailed(errorCode, isMainFrame)) return;
      this.deps.log(`[design] design ${tab.designId} failed to load: ${errorDescription}`);
      live.loaded = false;
      live.loadFailed = true;
      this.setStatus(tab, 'failed');
    });
    // A page's cancelling beforeunload would hold main's reload after a designer edit or a reconnect.
    contents.on('will-prevent-unload', (event) => event.preventDefault());
    contents.on('render-process-gone', (_event, details) => {
      if (tab.live !== live) return;
      this.deps.log(`[design] the page of design ${tab.designId} ended: ${details.reason}`);
      this.destroyView(tab);
      this.setStatus(tab, 'failed');
    });
    this.deps.window.contentView.addChildView(view);
    this.deps.onRestack();
    const url = `${DESIGN_SCHEME}://${token}/${tab.relPath.split('/').map(encodeURIComponent).join('/')}`;
    this.deps.sessionReady.then(() => {
      if (tab.live !== live) return;
      contents.loadURL(url).catch((err: unknown) => {
        // a reload or a navigation that replaced this load rejects it too; did-fail-load reports a real failure
        this.deps.log(`[design] loading design ${tab.designId}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, (err: unknown) => {
      this.deps.log(`[design] the preview session's proxy could not be set, so design ${tab.designId} does not load: ${err instanceof Error ? err.message : String(err)}`);
      if (tab.live === live) this.setStatus(tab, 'failed');
    });
    return live;
  }

  private destroyView(tab: DesignTab): void {
    const live = tab.live;
    if (!live) return;
    tab.live = undefined;
    this.tokens.delete(live.token);
    const hadFocus = !live.view.webContents.isDestroyed() && live.view.webContents.isFocused();
    if (!this.deps.window.isDestroyed()) this.deps.window.contentView.removeChildView(live.view);
    if (!live.view.webContents.isDestroyed()) live.view.webContents.close();
    if (hadFocus) this.deps.focusAway();
  }

  // The provenance sheet once per document, and a states sheet only when the declared states changed: removeInsertedCSS
  // leaves a user sheet in place, so every insert would stack another.
  private insertSheets(tab: DesignTab, live: LiveView): void {
    const contents = live.view.webContents;
    const states = tab.info?.states ?? [];
    const key = states.join('\n');
    if (live.sheetStates === key) return;
    const first = live.sheetStates === undefined;
    live.sheetStates = key;
    for (const css of [...(states.length > 0 ? [statesCss(states)] : []), ...(first ? [PROVENANCE_CSS] : [])]) {
      contents.insertCSS(css, { cssOrigin: 'user' }).then(() => undefined, (err: unknown) => this.cssFailed(tab, err));
    }
  }

  // `state` defaults to the tab's; a replay shows its journey's state this way without changing the tab's.
  private applyPage(tab: DesignTab, live: LiveView, state: string = tab.state): Promise<void> {
    const shown = (tab.info?.states.length ?? 0) > 0 ? state : undefined;
    // Its result is page-influenced, so it is never read.
    return live.view.webContents.executeJavaScriptInIsolatedWorld(PAGE_WORLD_ID, [{ code: pageScript(shown, tab.provenance) }]).then(() => undefined, (err: unknown) => this.cssFailed(tab, err));
  }

  private cssFailed(tab: DesignTab, err: unknown): void {
    this.deps.log(`[design] styling the preview of design ${tab.designId} failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The shell's report can lag a resize by a frame, so a view never extends past the window.
  private area(): Rectangle | undefined {
    const reported = this.frame?.bounds;
    if (!reported || this.deps.window.isDestroyed()) return undefined;
    const { width, height } = this.deps.window.getContentBounds();
    const x = Math.min(Math.max(0, reported.x), width);
    const y = Math.min(Math.max(0, reported.y), height);
    const area = { x, y, width: Math.min(reported.width, width - x), height: Math.min(reported.height, height - y) };
    return area.width > 0 && area.height > 0 ? area : undefined;
  }

  // Only the active design tab's view shows, only while its screen is ready, and only over the frame the shell reports.
  private layout(): void {
    const active = this.activeTab();
    if (active && !active.live && active.info && (active.status === 'loading' || active.status === 'ready')) this.goLive(active);
    if (active?.live && active.id !== this.lastShownId) active.lastShown = ++this.shownCount;
    this.lastShownId = active?.id;
    const area = active && this.frame?.tabId === active.id ? this.area() : undefined;
    const shown = area && active?.status === 'ready' && !active.markup ? active : undefined;
    let lostFocus = false;
    for (const tab of this.allTabs()) {
      const live = tab.live;
      if (!live) continue;
      const visible = tab === shown;
      if (visible) {
        live.view.setBounds(area!);
        live.view.setBorderRadius(this.frame!.radius);
        live.view.webContents.setZoomFactor(this.frame!.zoomFactor);
      }
      if (live.view.getVisible() === visible) continue;
      lostFocus ||= !visible && live.view.webContents.isFocused();
      live.view.setVisible(visible);
    }
    if (lostFocus) this.deps.focusAway();
  }

  // The tab shown gets a view; past the cap the least recently shown other view goes (PD-31).
  private goLive(tab: DesignTab): void {
    tab.status = 'loading';
    tab.live = this.buildView(tab);
    const live = this.allTabs().filter((other) => other.live !== undefined);
    while (live.length > MAX_LIVE_DESIGN_VIEWS) {
      const oldest = live.filter((other) => other !== tab).reduce((a, b) => (a.lastShown <= b.lastShown ? a : b));
      this.destroyView(oldest);
      live.splice(live.indexOf(oldest), 1);
    }
    this.changed(tab);
  }
}
