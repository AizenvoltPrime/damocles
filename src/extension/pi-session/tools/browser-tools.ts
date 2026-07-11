import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TextContent, ImageContent } from '@earendil-works/pi-ai';
import type { PiCodingAgentModule } from '../pi-loader';
import type { BrowserService } from '../../browser';
import type { ToolCatalogEntry } from '@shared/types/tools';
import { log } from '../../logger';

/**
 * Native pi tools backing the integrated CDP browser. Tools are exposed under PascalCase active-set
 * names (`BrowserOpen`, …) so the model sees clean names and the webview's generic tool card keys off
 * them directly. `BROWSER_SPECS` is the single source of truth for the active-set names, the
 * `defineTool` names, and the Tools-panel catalog.
 * The CDP-driving handler bodies are reused verbatim from the SDK server.
 */

interface ToolSpec {
  /** Original snake_case identity (parity-test mapping only). */
  key: string;
  /** PascalCase active-set name + `defineTool` name + label source. */
  name: string;
  /** Human-friendly Tools-panel label. */
  label: string;
  /** One-line Tools-panel blurb. */
  description: string;
}

const BROWSER_SPECS: readonly ToolSpec[] = [
  { key: 'browser_open', name: 'BrowserOpen', label: 'Open', description: 'Open a URL in the integrated browser.' },
  { key: 'browser_navigate', name: 'BrowserNavigate', label: 'Navigate', description: 'Navigate to a new URL.' },
  { key: 'browser_screenshot', name: 'BrowserScreenshot', label: 'Screenshot', description: 'Capture a screenshot of the page.' },
  { key: 'browser_query', name: 'BrowserQuery', label: 'Query elements', description: 'List interactive elements on the page.' },
  { key: 'browser_click', name: 'BrowserClick', label: 'Click', description: 'Click an element.' },
  { key: 'browser_type', name: 'BrowserType', label: 'Type', description: 'Type text into a field.' },
  { key: 'browser_evaluate', name: 'BrowserEvaluate', label: 'Evaluate', description: 'Run JavaScript in the page.' },
  { key: 'browser_element', name: 'BrowserElement', label: 'Inspect element', description: 'Inspect a DOM element.' },
  { key: 'browser_console', name: 'BrowserConsole', label: 'Console', description: 'Read recent console messages.' },
  { key: 'browser_network', name: 'BrowserNetwork', label: 'Network', description: 'Read recent network errors.' },
  { key: 'browser_accessibility', name: 'BrowserAccessibility', label: 'Accessibility tree', description: 'Get the accessibility tree.' },
  { key: 'browser_hover', name: 'BrowserHover', label: 'Hover', description: 'Hover over an element.' },
  { key: 'browser_scroll', name: 'BrowserScroll', label: 'Scroll', description: 'Scroll the page or a container.' },
  { key: 'browser_select', name: 'BrowserSelect', label: 'Select option', description: 'Select a dropdown option.' },
  { key: 'browser_fill', name: 'BrowserFill', label: 'Fill form', description: 'Fill multiple form fields.' },
  { key: 'browser_wait', name: 'BrowserWait', label: 'Wait', description: 'Wait for an element to appear.' },
  { key: 'browser_drag', name: 'BrowserDrag', label: 'Drag', description: 'Drag an element to a target.' },
  { key: 'browser_snapshot', name: 'BrowserSnapshot', label: 'Snapshot', description: 'Get a text map of the page.' },
  { key: 'browser_act', name: 'BrowserAct', label: 'Act', description: 'Perform actions by element ref.' },
  { key: 'browser_close', name: 'BrowserClose', label: 'Close', description: 'Close the browser.' },
] as const;

const NAME_BY_KEY: Record<string, string> = Object.fromEntries(BROWSER_SPECS.map((s) => [s.key, s.name]));
/** The PascalCase active-set/`defineTool` name for a browser tool key. */
const piName = (key: string): string => NAME_BY_KEY[key]!;

export const BROWSER_PI_TOOL_NAMES: readonly string[] = BROWSER_SPECS.map((s) => s.name);

export const BROWSER_TOOL_CATALOG: readonly ToolCatalogEntry[] = BROWSER_SPECS.map((s) => ({
  name: s.name,
  label: s.label,
  description: s.description,
  group: 'browser',
  toggleable: true,
}));

export interface BrowserPiToolDeps {
  pi: PiCodingAgentModule;
  browserService: BrowserService;
}

/** The SDK browser handlers already emit pi-shaped content blocks (MCP image content is `{ data, mimeType }`). */
type SdkContentBlock = TextContent | ImageContent;
type SdkResult = { content: SdkContentBlock[]; isError?: boolean };

/** Wrap an SDK handler result (`{ content, isError? }`) as an `AgentToolResult`. */
function wrap(result: SdkResult): AgentToolResult<undefined> {
  return {
    content: result.content,
    details: undefined,
    ...(result.isError ? { isError: true } : {}),
  } as AgentToolResult<undefined>;
}

function textResult(text: string): SdkResult {
  return { content: [{ type: 'text', text }] };
}

function imageResult(base64: string, text?: string): SdkResult {
  const content: SdkContentBlock[] = [];
  if (text) content.push({ type: 'text', text });
  content.push({ type: 'image', data: base64, mimeType: 'image/png' });
  return { content };
}

function errorResult(toolName: string, error: unknown): SdkResult {
  const msg = error instanceof Error ? error.message : String(error);
  log(`[Browser MCP] ${toolName} failed — ${msg}`);
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}

const INTERACTIVE_SELECTOR = [
  'a', 'button', 'input', 'textarea', 'select', 'summary',
  '[contenteditable="true"]',
  '[role="button"]', '[role="link"]', '[role="tab"]',
  '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
  '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
  '[role="combobox"]', '[role="option"]', '[role="listbox"]',
  '[role="treeitem"]', '[role="slider"]', '[role="spinbutton"]',
  '[role="searchbox"]', '[role="textbox"]', '[role="gridcell"]',
].join(',');

function buildSnapshotExpression(): string {
  return `(() => {
    if (!document.body) return { snapshot: '(page loading)', refCount: 0, title: document.title || '', url: location.href };
    const SEL = ${JSON.stringify(INTERACTIVE_SELECTOR)};
    const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG','PATH','META','LINK','HEAD','BR','HR','IMG']);
    for (const old of document.querySelectorAll('[data-dq]')) old.removeAttribute('data-dq');
    const interactive = new Set();
    for (const el of document.querySelectorAll(SEL)) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      interactive.add(el);
    }
    let ref = 0;
    const vpH = window.innerHeight;
    let belowFold = 0;
    const lines = [];
    const MAX = 150;
    const q = (s) => s.replace(/"/g, "'");
    const inside = (n) => { let p = n.parentElement; while (p && p !== document.body) { if (interactive.has(p)) return true; p = p.parentElement; } return false; };
    const txt = (e) => (e.textContent || '').trim().replace(/\\s+/g, ' ');
    const desc = (el) => {
      const tag = el.tagName.toLowerCase(), idx = ref++;
      el.setAttribute('data-dq', String(idx));
      const p = ['[' + idx + ']'];
      const role = el.getAttribute('role'), type = el.getAttribute('type');
      if (role === 'button' || tag === 'button') p.push('button');
      else if (tag === 'a') p.push('link');
      else if (tag === 'select') p.push('select');
      else if (tag === 'textarea') p.push('textarea');
      else if (tag === 'input') p.push(type ? 'input[' + type + ']' : 'input');
      else if (role) p.push(role);
      else p.push(tag);
      const al = el.getAttribute('aria-label'), t = txt(el), ph = el.getAttribute('placeholder');
      let lb = al || t || ph || el.getAttribute('title') || '';
      if (!lb && (tag === 'button' || role === 'button')) {
        const svg = el.querySelector('svg');
        if (svg) { const st = svg.querySelector('title'); if (st) lb = st.textContent.trim(); }
        if (!lb) { const sr = el.querySelector('.sr-only, [class*="visually-hidden"]'); if (sr) lb = (sr.textContent || '').trim(); }
        if (!lb) {
          const ac = [el, ...el.querySelectorAll('*')].map(e => (e.className || '').toString().toLowerCase()).join(' ');
          const hints = ['edit','pencil','delete','trash','remove','close','add','view','eye','copy','download','settings','save','cancel','sort','filter','share','refresh','archive','print'];
          for (const h of hints) { if (ac.includes(h)) { lb = '[icon:' + h + ']'; break; } }
        }
      }
      if (lb) p.push('"' + q(lb.length > 60 ? lb.substring(0,57) + '...' : lb) + '"');
      const isForm = tag === 'input' || tag === 'textarea';
      if (isForm && el.value) p.push('val="' + q(el.value.substring(0,40)) + '"');
      if (isForm && ph && lb !== ph) p.push('placeholder="' + q(ph) + '"');
      if (tag === 'a') { const hr = el.getAttribute('href'); if (hr && !hr.startsWith('javascript:')) p.push('-> ' + (hr.length > 80 ? hr.substring(0,77) + '...' : hr)); }
      if (tag === 'select') {
        const si = el.selectedIndex;
        if (si >= 0 && el.options[si]) p.push('selected="' + q(el.options[si].text.trim()) + '"');
        const opts = Array.from(el.options).slice(0,8).map(o => o.text.trim());
        if (el.options.length > 8) opts.push('...');
        p.push('options=[' + opts.join('|') + ']');
      }
      if ((type === 'checkbox' || type === 'radio') && el.checked) p.push('(checked)');
      if (el.disabled) p.push('(disabled)');
      if (el.getBoundingClientRect().top > vpH) { p.push('(off-screen)'); belowFold++; }
      return p.join(' ');
    };
    const walk = (n) => {
      if (lines.length >= MAX) return;
      if (n.nodeType === 3) {
        if (inside(n)) return;
        const t = n.textContent.trim().replace(/\\s+/g, ' ');
        if (t.length >= 2) lines.push(t.length > 200 ? t.substring(0,197) + '...' : t);
        return;
      }
      if (n.nodeType !== 1) return;
      const tag = n.tagName;
      if (SKIP.has(tag)) return;
      if (tag !== 'BODY' && tag !== 'HTML' && getComputedStyle(n).display === 'none') return;
      if (interactive.has(n)) { lines.push(desc(n)); return; }
      const tl = tag.toLowerCase();
      if (/^h[1-6]$/.test(tl)) {
        const ht = txt(n);
        if (ht) lines.push('#'.repeat(parseInt(tl[1])) + ' ' + (ht.length > 120 ? ht.substring(0,117) + '...' : ht));
        return;
      }
      for (const ch of n.childNodes) walk(ch);
    };
    walk(document.body);
    const scrollInfo = [];
    const docH = document.documentElement.scrollHeight;
    if (docH > vpH + 20) {
      const pct = Math.round(window.scrollY / Math.max(1, docH - vpH) * 100);
      scrollInfo.push('page: ' + pct + '%' + (pct < 95 ? ' (more below)' : ''));
    }
    for (const dlg of document.querySelectorAll('[role="dialog"], .modal-body, [data-state="open"], [class*="dialog-content"], [class*="sheet-content"]')) {
      if (dlg.scrollHeight > dlg.clientHeight + 20) {
        const p = Math.round(dlg.scrollTop / Math.max(1, dlg.scrollHeight - dlg.clientHeight) * 100);
        const id = dlg.getAttribute('aria-label') || dlg.id || 'dialog';
        scrollInfo.push(id + ': ' + p + '%' + (p < 95 ? ' (more below)' : ''));
      }
    }
    const emptyFields = [];
    for (const el of document.querySelectorAll('input, textarea, select')) {
      if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      let empty = false;
      if (el.tagName === 'SELECT') { empty = el.selectedIndex <= 0 && el.options[0] && !el.options[0].value; }
      else if (el.type !== 'checkbox' && el.type !== 'radio') { empty = !el.value || !el.value.trim(); }
      if (empty) emptyFields.push(el.id || el.name || el.getAttribute('aria-label') || el.placeholder || el.tagName.toLowerCase());
    }
    return { snapshot: lines.join('\\n'), refCount: ref, title: document.title, url: location.href, belowFold, scrollInfo, emptyFields };
  })()`;
}

const browserOpenSchema = Type.Object(
  { url: Type.String({ description: 'Exact full URL to open' }) },
  { additionalProperties: false },
);

const browserNavigateSchema = Type.Object(
  { url: Type.String({ description: 'Exact full URL to navigate to' }) },
  { additionalProperties: false },
);

const emptySchema = Type.Object({}, { additionalProperties: false });

const browserQuerySchema = Type.Object(
  { filter: Type.Optional(Type.String({ description: 'Filter by tag name or ARIA role. Comma or space separated (e.g. "input,select", "button combobox", "option")' })) },
  { additionalProperties: false },
);

const browserClickSchema = Type.Object(
  {
    selector: Type.Optional(Type.String({ description: 'CSS selector (e.g. [data-dq="3"], button.submit, #login-btn)' })),
    text: Type.Optional(Type.String({ description: 'Visible text of the element to click (e.g. "Sign in", "Submit", "Objectives")' })),
  },
  { additionalProperties: false },
);

const browserTypeSchema = Type.Object(
  {
    text: Type.String({ description: 'Text to type' }),
    selector: Type.Optional(Type.String({ description: 'CSS selector to click/focus before typing' })),
    clear: Type.Optional(Type.Boolean({ description: 'Clear existing text in the field before typing' })),
  },
  { additionalProperties: false },
);

const browserEvaluateSchema = Type.Object(
  {
    expression: Type.String({ description: 'JavaScript expression to evaluate (e.g. "document.title", "document.querySelectorAll(\'input\').length")' }),
    timeoutMs: Type.Optional(Type.Number({ description: 'Max time to await the result in milliseconds (default 15000, clamped to 1000-120000). Raise for expressions that await long-running promises.' })),
  },
  { additionalProperties: false },
);

const browserElementSchema = Type.Object(
  { selector: Type.String({ description: 'CSS selector of the element to inspect' }) },
  { additionalProperties: false },
);

const browserHoverSchema = Type.Object(
  { selector: Type.String({ description: 'CSS selector of the element to hover over' }) },
  { additionalProperties: false },
);

const browserScrollSchema = Type.Object(
  {
    x: Type.Optional(Type.Number({ description: 'Horizontal scroll pixels (positive = right)' })),
    y: Type.Optional(Type.Number({ description: 'Vertical scroll pixels (positive = down, e.g. 500)' })),
    selector: Type.Optional(Type.String({ description: 'CSS selector of a specific scrollable container (auto-detected if omitted)' })),
  },
  { additionalProperties: false },
);

const browserSelectSchema = Type.Object(
  {
    selector: Type.String({ description: 'CSS selector of the select trigger (e.g. [data-dq="5"], #my-select)' }),
    value: Type.Optional(Type.String({ description: 'The value attribute or data-value of the option' })),
    text: Type.Optional(Type.String({ description: 'The visible text of the option (e.g. "High", "IT & Digital Services")' })),
  },
  { additionalProperties: false },
);

const browserFillSchema = Type.Object(
  {
    fields: Type.Array(
      Type.Object({
        selector: Type.String({ description: 'CSS selector of the form field (e.g. #title, [data-dq="5"], [name="priority"])' }),
        value: Type.String({ description: 'Value: text content, option text/value, ISO date YYYY-MM-DD, or ignored for check/uncheck' }),
        type: Type.Optional(
          Type.Union(['text', 'select', 'date', 'check', 'uncheck'].map((v) => Type.Literal(v)), {
            description: 'Field type: "text" for inputs/textareas (default), "select" for dropdowns, "date" for calendar trigger buttons (YYYY-MM-DD), "check"/"uncheck" for checkboxes',
          }),
        ),
      }),
      { minItems: 1, maxItems: 30, description: 'Form fields to fill' },
    ),
  },
  { additionalProperties: false },
);

const browserWaitSchema = Type.Object(
  {
    selector: Type.Optional(Type.String({ description: 'CSS selector to wait for' })),
    text: Type.Optional(Type.String({ description: 'Visible text content to wait for (e.g. "Delete", "Loading complete")' })),
    timeout: Type.Optional(Type.Number({ description: 'Maximum wait time in milliseconds (default: 10000)' })),
  },
  { additionalProperties: false },
);

const browserDragSchema = Type.Object(
  {
    sourceSelector: Type.String({ description: 'CSS selector of the element to drag' }),
    targetSelector: Type.String({ description: 'CSS selector of the drop target' }),
  },
  { additionalProperties: false },
);

const browserActSchema = Type.Object(
  {
    actions: Type.Array(
      Type.Object({
        action: Type.Union(['click', 'type', 'select', 'key', 'hover'].map((v) => Type.Literal(v)), { description: 'Action type' }),
        ref: Type.Optional(Type.Number({ description: 'Element [ref] number from snapshot (required for click/type/select/hover)' })),
        text: Type.Optional(Type.String({ description: 'For type: text to enter. For key: key name (Enter, Escape, Tab, ArrowDown, Backspace)' })),
        value: Type.Optional(Type.String({ description: 'For select: option text or value to select' })),
        clear: Type.Optional(Type.Boolean({ description: 'For type: clear field before typing' })),
      }),
      { minItems: 1, maxItems: 20, description: 'Actions to perform sequentially' },
    ),
  },
  { additionalProperties: false },
);

/**
 * Resolve to `onAbort()` the instant `signal` fires, instead of waiting for `work`. CDP calls (launch,
 * connect, screenshot, evaluate) have no per-request cancellation, so a slow/hung one would otherwise
 * block the agent loop — which `await`s the tool's `execute` — and thus pi's `abort()`/`waitForIdle()`.
 * Racing at the tool boundary honors pi's abort contract: the agent unblocks immediately and the
 * orphaned CDP op settles harmlessly in the background (the browser session is reused or closed later).
 */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined, onAbort: () => T): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.resolve(onAbort());
  return new Promise<T>((resolve, reject) => {
    const onAbortEvent = (): void => resolve(onAbort());
    signal.addEventListener('abort', onAbortEvent, { once: true });
    void work.then(
      (value) => { signal.removeEventListener('abort', onAbortEvent); resolve(value); },
      (err) => { signal.removeEventListener('abort', onAbortEvent); reject(err); },
    );
  });
}

/** Wrap a tool so its `execute` returns the instant the turn is aborted (see `raceAbort`). */
export function abortableTool(tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    execute: (toolCallId, params, signal, onUpdate, ctx) =>
      raceAbort(
        tool.execute(toolCallId, params, signal, onUpdate, ctx),
        signal,
        () => wrap(textResult(`${tool.name} aborted`)) as AgentToolResult<unknown>,
      ),
  };
}

/** Build the `damocles-browser` tools as pi-native definitions, reusing the SDK CDP handler logic. */
export function buildBrowserPiTools(deps: BrowserPiToolDeps): ToolDefinition[] {
  const { pi, browserService } = deps;

  function requireCdp(_toolName: string) {
    const cdp = browserService.getCdp();
    if (!cdp) {
      throw new Error('Browser is not connected. Use browser_open first.');
    }
    return cdp;
  }

  async function screenshotAfter(cdp: ReturnType<typeof requireCdp>, delayMs: number, text: string): Promise<SdkResult> {
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      const screenshot = await cdp.captureScreenshot();
      return imageResult(screenshot, text);
    } catch {
      return textResult(`${text} (screenshot unavailable)`);
    }
  }

  async function takeSnapshot(cdp: ReturnType<typeof requireCdp>): Promise<string> {
    const result = await cdp.evaluate(buildSnapshotExpression());
    const data = result.value as { snapshot: string; refCount: number; title: string; url: string; belowFold: number; scrollInfo: string[]; emptyFields: string[] };
    const header = [`[Page] ${data.title}`, `[URL] ${data.url}`];
    const elemInfo = data.belowFold > 0
      ? `${data.refCount} interactive elements, ${data.belowFold} off-screen below`
      : `${data.refCount} interactive elements`;
    header.push(`[${elemInfo}]`);
    if (data.scrollInfo?.length > 0) header.push(`[Scroll] ${data.scrollInfo.join(' | ')}`);
    if (data.emptyFields?.length > 0) header.push(`[Empty fields] ${data.emptyFields.join(', ')}`);
    header.push('');
    header.push(data.snapshot);
    return header.join('\n');
  }

  async function screenshotWithSnapshot(cdp: ReturnType<typeof requireCdp>, delayMs: number, text: string): Promise<SdkResult> {
    await new Promise((r) => setTimeout(r, delayMs));
    const snap = await takeSnapshot(cdp);
    try {
      const screenshot = await cdp.captureScreenshot();
      return {
        content: [
          { type: 'text', text: `${text}\n\n${snap}` },
          { type: 'image', data: screenshot, mimeType: 'image/png' },
        ],
      };
    } catch {
      return textResult(`${text} (screenshot unavailable)\n\n${snap}`);
    }
  }

  const definitions: ToolDefinition[] = [
    pi.defineTool<typeof browserOpenSchema, undefined>({
      name: piName('browser_open'),
      label: piName('browser_open'),
      description: "Open a URL in VS Code's integrated browser with full automation. User sees the browser live. If already open, navigates to the new URL. Provide exact, complete URLs — look up routes in the codebase rather than guessing. After opening, call BrowserQuery to discover interactive elements on the page.",
      parameters: browserOpenSchema,
      execute: async (_id, input, signal) => {
        try {
          await browserService.open(input.url, signal);
          const cdpReady = await browserService.waitForCdp(25_000, signal);
          if (signal?.aborted) return wrap(textResult(`Opened browser: ${input.url}`));
          if (cdpReady) {
            const cdp = browserService.getCdp()!;
            return wrap(await screenshotWithSnapshot(cdp, 2000, `Opened browser: ${input.url}`));
          }
          return wrap(textResult(`Opened browser: ${input.url}\nNote: CDP automation not available — screenshot and interaction tools will not work.`));
        } catch (error) {
          return wrap(errorResult('browser_open', error));
        }
      },
    }),

    pi.defineTool<typeof browserNavigateSchema, undefined>({
      name: piName('browser_navigate'),
      label: piName('browser_navigate'),
      description: 'Navigate the integrated browser to a new URL. The user sees navigation live in the VS Code panel. IMPORTANT: Provide the exact, complete URL path. Do not guess URL paths — look up routes in the codebase or ask the user. Wrong paths will silently load a 404 or wrong page. Returns a screenshot after navigation.',
      parameters: browserNavigateSchema,
      execute: async (_id, input, signal) => {
        try {
          await browserService.open(input.url, signal);
          const cdpReady = await browserService.waitForCdp(25_000, signal);
          if (signal?.aborted) return wrap(textResult(`Navigated to: ${input.url}`));
          if (cdpReady) {
            const cdp = browserService.getCdp()!;
            return wrap(await screenshotWithSnapshot(cdp, 1500, `Navigated to: ${input.url}`));
          }
          return wrap(textResult(`Navigated to: ${input.url}\nNote: CDP automation not available — screenshot not captured.`));
        } catch (error) {
          return wrap(errorResult('browser_navigate', error));
        }
      },
    }),

    pi.defineTool<typeof emptySchema, undefined>({
      name: piName('browser_screenshot'),
      label: piName('browser_screenshot'),
      description: 'Capture a screenshot of the current page. The user sees the page live, but you need this to see it. To discover interactive elements (buttons, inputs, links, selects), prefer BrowserQuery — it returns structured data with reliable selectors.',
      parameters: emptySchema,
      execute: async () => {
        try {
          const cdp = requireCdp('browser_screenshot');
          const screenshot = await cdp.captureScreenshot();
          return wrap(imageResult(screenshot, `Screenshot of: ${browserService.getCurrentUrl() ?? 'current page'}`));
        } catch (error) {
          return wrap(errorResult('browser_screenshot', error));
        }
      },
    }),

    pi.defineTool<typeof browserQuerySchema, undefined>({
      name: piName('browser_query'),
      label: piName('browser_query'),
      description: 'List all interactive elements on the page with their text, attributes, and viewport position. Elements marked offScreen:true are below the viewport fold — scroll down to discover and interact with them. Reports scroll state and empty form fields. Each element is tagged with data-dq="N" — use [data-dq="N"] as a CSS selector in other browser tools. Call this BEFORE interacting with a page. IMPORTANT: Always check the scroll/empty fields metadata before submitting forms.',
      parameters: browserQuerySchema,
      execute: async (_id, input) => {
        try {
          const cdp = requireCdp('browser_query');
          const filterClause = input.filter
            ? (() => {
                const terms = input.filter.split(/[\s,]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
                return `{ const _ft = new Set(${JSON.stringify(terms)}); if (!_ft.has(tag) && !(rl && _ft.has(rl))) continue; }`;
              })()
            : '';
          const result = await cdp.evaluate(`(() => {
            const vpH = window.innerHeight;
            for (const old of document.querySelectorAll('[data-dq]')) old.removeAttribute('data-dq');
            const sel = ${JSON.stringify(INTERACTIVE_SELECTOR)};
            const els = document.querySelectorAll(sel);
            const items = [];
            let idx = 0;
            for (const el of els) {
              const r = el.getBoundingClientRect();
              const s = getComputedStyle(el);
              if ((r.width === 0 && r.height === 0) || s.display === 'none' || s.visibility === 'hidden') continue;
              const tag = el.tagName.toLowerCase();
              const rl = el.getAttribute('role');
              ${filterClause}
              el.setAttribute('data-dq', String(idx));
              const item = { i: idx, tag };
              const tp = el.getAttribute('type');
              if (tp) item.type = tp;
              if (rl) item.role = rl;
              const tx = (el.textContent || '').trim();
              if (tx) item.text = tx.length <= 80 ? tx : tx.substring(0, 77) + '...';
              const isForm = tag === 'input' || tag === 'textarea' || tag === 'select';
              if (isForm && el.value !== '') item.value = el.value.substring(0, 80);
              const ph = el.getAttribute('placeholder');
              if (ph) item.placeholder = ph;
              if (el.name) item.name = el.name;
              if (el.id) item.id = el.id;
              if (tag === 'a') { const hr = el.getAttribute('href'); if (hr) item.href = hr; }
              const al = el.getAttribute('aria-label');
              if (al) item.label = al;
              if (el.disabled) item.disabled = true;
              if (r.top > vpH) item.offScreen = true;
              if (tag === 'select') {
                item.options = Array.from(el.options).map(o => ({ v: o.value, t: o.text.trim() }));
              }
              items.push(item);
              idx++;
            }
            const meta = {};
            const docH = document.documentElement.scrollHeight;
            if (docH > vpH + 20) {
              meta.scroll = Math.round(window.scrollY / Math.max(1, docH - vpH) * 100) + '%';
              meta.moreBelow = window.scrollY + vpH < docH - 10;
            }
            for (const dlg of document.querySelectorAll('[role="dialog"], .modal-body, [data-state="open"]')) {
              if (dlg.scrollHeight > dlg.clientHeight + 20) {
                const p = Math.round(dlg.scrollTop / Math.max(1, dlg.scrollHeight - dlg.clientHeight) * 100);
                meta.dialogScroll = p + '%';
                meta.dialogMoreBelow = p < 95;
              }
            }
            const emptyFields = [];
            for (const el of document.querySelectorAll('input, textarea, select')) {
              if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') continue;
              const cs = getComputedStyle(el);
              if (cs.display === 'none' || cs.visibility === 'hidden') continue;
              const r = el.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) continue;
              let empty = false;
              if (el.tagName === 'SELECT') { empty = el.selectedIndex <= 0 && el.options[0] && !el.options[0].value; }
              else if (el.type !== 'checkbox' && el.type !== 'radio') { empty = !el.value || !el.value.trim(); }
              if (empty) emptyFields.push(el.id || el.name || el.getAttribute('aria-label') || el.placeholder || el.tagName.toLowerCase());
            }
            if (emptyFields.length > 0) meta.emptyFields = emptyFields;
            return { items, meta };
          })()`);
          const data = result.value as { items: any[]; meta: { scroll?: string; moreBelow?: boolean; dialogScroll?: string; dialogMoreBelow?: boolean; emptyFields?: string[] } };
          const elements = data?.items ?? result.value;
          if (!elements || (Array.isArray(elements) && elements.length === 0)) {
            return wrap(textResult('No interactive elements found on the page.'));
          }
          const count = Array.isArray(elements) ? elements.length : '?';
          const queryLines = [`Found ${count} interactive elements (use [data-dq="N"] as selector):`, JSON.stringify(elements, null, 1)];
          const meta = data?.meta;
          if (meta) {
            if (meta.scroll) queryLines.push(`\nScroll: ${meta.scroll}${meta.moreBelow ? ' — more content below, scroll down to discover all fields' : ''}`);
            if (meta.dialogScroll) queryLines.push(`Dialog scroll: ${meta.dialogScroll}${meta.dialogMoreBelow ? ' — more fields below in dialog' : ''}`);
            if (meta.emptyFields?.length) queryLines.push(`Empty fields: ${meta.emptyFields.join(', ')}`);
          }
          return wrap(textResult(queryLines.join('\n')));
        } catch (error) {
          return wrap(errorResult('browser_query', error));
        }
      },
    }),

    pi.defineTool<typeof browserClickSchema, undefined>({
      name: piName('browser_click'),
      label: piName('browser_click'),
      description: 'Click an element. Provide EITHER a CSS selector OR visible text content. Use [data-dq="N"] selectors from BrowserQuery for maximum reliability. Standard CSS only — Playwright pseudo-selectors like :has-text() do NOT work. Returns a screenshot.',
      parameters: browserClickSchema,
      execute: async (_id, input) => {
        try {
          const cdp = requireCdp('browser_click');
          if (!input.selector && !input.text) {
            return wrap({ content: [{ type: 'text', text: 'Error: Provide either selector or text parameter.' }], isError: true });
          }
          if (input.text) {
            const result = await cdp.evaluate(`(() => {
              const text = ${JSON.stringify(input.text)};
              const sel = ${JSON.stringify(INTERACTIVE_SELECTOR)};
              const exactEls = [];
              const partialEls = [];
              for (const el of document.querySelectorAll(sel)) {
                if (el.tagName === 'SELECT') continue;
                const r = el.getBoundingClientRect();
                if (r.width === 0 && r.height === 0) continue;
                const t = (el.textContent || '').trim();
                if (t === text) exactEls.push(el);
                else if (t && t.includes(text)) partialEls.push({ el, len: t.length });
              }
              let match;
              if (exactEls.length > 0) match = exactEls[exactEls.length - 1];
              else if (partialEls.length > 0) { partialEls.sort((a, b) => a.len - b.len); match = partialEls[0].el; }
              if (!match) return null;
              match.scrollIntoView({ block: 'nearest', inline: 'nearest' });
              const r = match.getBoundingClientRect();
              const t = (match.textContent || '').trim();
              return { x: r.x + r.width/2, y: r.y + r.height/2, desc: match.tagName + ' "' + t.substring(0,50) + '"' };
            })()`);
            if (!result.value) {
              return wrap({ content: [{ type: 'text', text: `Error: No clickable element found with text "${input.text}".` }], isError: true });
            }
            const { x, y, desc } = result.value as { x: number; y: number; desc: string };
            await cdp.dispatchMouseEvent('mousePressed', x, y, { clickCount: 1 });
            await cdp.dispatchMouseEvent('mouseReleased', x, y, { clickCount: 1 });
            return wrap(await screenshotAfter(cdp, 500, `Clicked: ${desc}`));
          }
          await cdp.clickSelector(input.selector!);
          return wrap(await screenshotAfter(cdp, 500, `Clicked: ${input.selector}`));
        } catch (error) {
          return wrap(errorResult('browser_click', error));
        }
      },
    }),

    pi.defineTool<typeof browserTypeSchema, undefined>({
      name: piName('browser_type'),
      label: piName('browser_type'),
      description: 'Type text into an input field. Use [data-dq="N"] selectors from BrowserQuery for reliable targeting. Optionally click a selector first to focus it. Set clear=true to clear existing text before typing. Returns a screenshot.',
      parameters: browserTypeSchema,
      execute: async (_id, input) => {
        try {
          const cdp = requireCdp('browser_type');
          if (input.selector) {
            await cdp.clickSelector(input.selector);
            await new Promise((r) => setTimeout(r, 200));
          }
          if (input.clear) {
            await cdp.selectAllAndDelete();
            await new Promise((r) => setTimeout(r, 100));
          }
          await cdp.typeText(input.text);
          return wrap(await screenshotAfter(cdp, 300, `Typed "${input.text}"${input.selector ? ` into ${input.selector}` : ''}`));
        } catch (error) {
          return wrap(errorResult('browser_type', error));
        }
      },
    }),

    pi.defineTool<typeof browserEvaluateSchema, undefined>({
      name: piName('browser_evaluate'),
      label: piName('browser_evaluate'),
      description: 'Execute JavaScript in the page context and return the result. Code with return statements is auto-wrapped in an IIFE. Expressions with const/let are auto-wrapped in a block scope. Prefer BrowserQuery + BrowserClick/BrowserType/BrowserSelect for standard interactions.',
      parameters: browserEvaluateSchema,
      execute: async (_id, input) => {
        try {
          const cdp = requireCdp('browser_evaluate');
          let expr = input.expression;
          const trimmed = expr.trim();
          if (/\breturn\s/.test(trimmed) && !trimmed.startsWith('(')) {
            expr = `(() => {\n${expr}\n})()`;
          } else if (/\b(const|let|class)\s/.test(trimmed) && !trimmed.startsWith('(') && !trimmed.startsWith('{')) {
            expr = `{\n${expr}\n}`;
          }
          const timeoutMs = input.timeoutMs !== undefined
            ? Math.min(Math.max(input.timeoutMs, 1_000), 120_000)
            : undefined;
          const result = await cdp.evaluate(expr, true, timeoutMs);
          const value = result.value !== undefined
            ? JSON.stringify(result.value, null, 2)
            : result.description ?? result.type;
          return wrap(textResult(`Result: ${value}`));
        } catch (error) {
          return wrap(errorResult('browser_evaluate', error));
        }
      },
    }),

    pi.defineTool<typeof browserElementSchema, undefined>({
      name: piName('browser_element'),
      label: piName('browser_element'),
      description: 'Get details about a DOM element: outer HTML, bounding box dimensions, and computed visual styles. Useful for inspecting page structure before interacting.',
      parameters: browserElementSchema,
      execute: async (_id, input) => {
        try {
          const cdp = requireCdp('browser_element');
          const doc = await cdp.getDocument();
          const nodeId = await cdp.querySelector(doc.root.nodeId, input.selector);
          if (!nodeId) return wrap(textResult(`Element not found: ${input.selector}`));

          const html = await cdp.getOuterHTML(nodeId);
          const box = await cdp.getBoxModel(nodeId);

          let styles: Record<string, string> = {};
          try {
            const computed = await cdp.getComputedStyleForNode(nodeId);
            const visualProps = new Set([
              'display', 'position', 'width', 'height', 'margin', 'padding',
              'color', 'background-color', 'font-size', 'font-weight', 'border',
              'opacity', 'visibility', 'overflow', 'z-index',
            ]);
            styles = Object.fromEntries(
              computed.filter((s) => visualProps.has(s.name)).map((s) => [s.name, s.value]),
            );
          } catch { /* non-element node types may not support computed styles */ }

          const truncatedHtml = html.length > 2048 ? html.slice(0, 2048) + '... (truncated)' : html;
          const parts = [
            `Selector: ${input.selector}`,
            `Size: ${box.width}×${box.height}`,
            `Position: (${box.content[0]}, ${box.content[1]})`,
            Object.keys(styles).length > 0 ? `Styles: ${JSON.stringify(styles)}` : null,
            `HTML:\n${truncatedHtml}`,
          ].filter(Boolean);

          return wrap(textResult(parts.join('\n')));
        } catch (error) {
          return wrap(errorResult('browser_element', error));
        }
      },
    }),

    pi.defineTool<typeof emptySchema, undefined>({
      name: piName('browser_console'),
      label: piName('browser_console'),
      description: 'Get recent browser console messages. Useful for debugging JavaScript errors, checking application logs, or verifying API responses logged to console.',
      parameters: emptySchema,
      execute: async () => {
        try {
          const messages = browserService.getConsoleMessages();
          if (messages.length === 0) return wrap(textResult('No console messages captured.'));
          const text = messages.map((m) => `[${m.level}] ${m.text}`).join('\n');
          return wrap(textResult(text));
        } catch (error) {
          return wrap(errorResult('browser_console', error));
        }
      },
    }),

    pi.defineTool<typeof emptySchema, undefined>({
      name: piName('browser_network'),
      label: piName('browser_network'),
      description: 'Get recent network errors (failed requests, HTTP 4xx/5xx responses). Useful for debugging API calls or asset loading issues.',
      parameters: emptySchema,
      execute: async () => {
        try {
          const errors = browserService.getNetworkErrors();
          if (errors.length === 0) return wrap(textResult('No network errors captured.'));
          const text = errors.map((e) =>
            e.status ? `[${e.status} ${e.statusText ?? ''}] ${e.url}` : `[${e.type}] ${e.url}`,
          ).join('\n');
          return wrap(textResult(text));
        } catch (error) {
          return wrap(errorResult('browser_network', error));
        }
      },
    }),

    pi.defineTool<typeof emptySchema, undefined>({
      name: piName('browser_accessibility'),
      label: piName('browser_accessibility'),
      description: 'Get the accessibility tree of the page. Useful for understanding page structure and finding interactive elements when CSS selectors are unclear.',
      parameters: emptySchema,
      execute: async () => {
        try {
          const cdp = requireCdp('browser_accessibility');
          const tree = await cdp.getFullAXTree();
          const text = JSON.stringify(tree, null, 2);
          return wrap(textResult(text.length > 8000 ? text.slice(0, 8000) + '\n... (truncated)' : text));
        } catch (error) {
          return wrap(errorResult('browser_accessibility', error));
        }
      },
    }),

    pi.defineTool<typeof browserHoverSchema, undefined>({
      name: piName('browser_hover'),
      label: piName('browser_hover'),
      description: 'Move the mouse over an element to trigger hover state. Returns a screenshot. Useful for revealing tooltips, dropdown menus, or hover-dependent UI.',
      parameters: browserHoverSchema,
      execute: async (_id, input) => {
        try {
          const cdp = requireCdp('browser_hover');
          const { x, y } = await cdp.resolveSelector(input.selector);
          await cdp.dispatchMouseEvent('mouseMoved', x, y);
          return wrap(await screenshotAfter(cdp, 300, `Hovered: ${input.selector}`));
        } catch (error) {
          return wrap(errorResult('browser_hover', error));
        }
      },
    }),

    pi.defineTool<typeof browserScrollSchema, undefined>({
      name: piName('browser_scroll'),
      label: piName('browser_scroll'),
      description: 'Scroll the page or a scrollable container (dialog, modal, overflow div). Auto-detects the scrollable container — works inside modals, dialogs, and overflow divs, not just the window. If neither x nor y is provided, scrolls down by ~75% of viewport height. When a selector is provided, finds the nearest scrollable element within or around it. Returns a screenshot.',
      parameters: browserScrollSchema,
      execute: async (_id, input) => {
        try {
          const cdp = requireCdp('browser_scroll');
          const explicitX = input.x !== undefined;
          const explicitY = input.y !== undefined;
          const scrollX = input.x ?? 0;
          const scrollY = input.y ?? 0;
          const result = await cdp.evaluate(`(() => {
            let dx = ${scrollX}, dy = ${scrollY};
            const noAmount = ${!explicitX && !explicitY};
            if (noAmount) dy = Math.round(window.innerHeight * 0.75);
            const sel = ${input.selector ? JSON.stringify(input.selector) : 'null'};
            function isScrollable(el) {
              const s = getComputedStyle(el);
              const oy = s.overflowY, ox = s.overflowX;
              const canY = (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight;
              const canX = (ox === 'auto' || ox === 'scroll' || ox === 'overlay') && el.scrollWidth > el.clientWidth;
              return (dy !== 0 && canY) || (dx !== 0 && canX);
            }
            function findScrollableUp(el) {
              while (el && el !== document.body && el !== document.documentElement) {
                if (isScrollable(el)) return el;
                el = el.parentElement;
              }
              return null;
            }
            function findScrollableIn(root) {
              if (isScrollable(root)) return root;
              for (const child of root.querySelectorAll('*')) {
                if (isScrollable(child)) return child;
              }
              return null;
            }
            let target;
            if (sel) {
              const match = document.querySelector(sel);
              if (!match) return { error: 'Element not found: ' + sel };
              target = findScrollableIn(match) || findScrollableUp(match);
            } else {
              const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
              const centerEl = document.elementFromPoint(cx, cy);
              if (centerEl) target = findScrollableUp(centerEl);
            }
            if (target) {
              const before = { x: target.scrollLeft, y: target.scrollTop };
              target.scrollBy(dx, dy);
              const after = { x: target.scrollLeft, y: target.scrollTop };
              const tag = target.tagName.toLowerCase();
              const id = target.id ? '#' + target.id : '';
              return {
                container: tag + id,
                dx: Math.round(after.x - before.x),
                dy: Math.round(after.y - before.y),
                atEnd: dy > 0 && Math.abs(target.scrollTop + target.clientHeight - target.scrollHeight) < 2,
                atStart: dy < 0 && target.scrollTop < 2,
                usedDefault: noAmount,
              };
            }
            const before = { x: window.scrollX, y: window.scrollY };
            window.scrollBy(dx, dy);
            const after = { x: window.scrollX, y: window.scrollY };
            return {
              container: 'window',
              dx: Math.round(after.x - before.x),
              dy: Math.round(after.y - before.y),
              atEnd: dy > 0 && Math.abs(window.scrollY + window.innerHeight - document.documentElement.scrollHeight) < 2,
              atStart: dy < 0 && window.scrollY < 2,
              usedDefault: noAmount,
            };
          })()`);
          const r = result.value as { container: string; dx: number; dy: number; atEnd: boolean; atStart: boolean; usedDefault: boolean; error?: string };
          if (r.error) return wrap(errorResult('browser_scroll', new Error(r.error)));
          const parts = [`Scrolled ${r.container} by (${r.dx}, ${r.dy})`];
          if (r.atEnd) parts.push('(reached bottom)');
          if (r.atStart) parts.push('(reached top)');
          if (r.dx === 0 && r.dy === 0) parts.push('(no movement — not scrollable or already at edge)');
          return wrap(await screenshotAfter(cdp, 300, parts.join(' ')));
        } catch (error) {
          return wrap(errorResult('browser_scroll', error));
        }
      },
    }),

    pi.defineTool<typeof browserSelectSchema, undefined>({
      name: piName('browser_select'),
      label: piName('browser_select'),
      description: 'Select an option from any dropdown — native <select> or custom components (Radix, Reka, Headless UI, shadcn). For native selects, sets value directly. For custom selects (combobox triggers), clicks the trigger then clicks the matching [role="option"] via CDP coordinates. Returns a screenshot.',
      parameters: browserSelectSchema,
      execute: async (_id, input) => {
        try {
          const cdp = requireCdp('browser_select');
          if (!input.value && !input.text) {
            return wrap({ content: [{ type: 'text', text: 'Error: Provide either value or text parameter.' }], isError: true });
          }
          const tagResult = await cdp.evaluate(
            `document.querySelector(${JSON.stringify(input.selector)})?.tagName`,
          );
          if (!tagResult.value) {
            return wrap(errorResult('browser_select', new Error(`Element not found: ${input.selector}`)));
          }
          if (tagResult.value === 'SELECT') {
            const matchExpr = input.text
              ? `const opt = Array.from(el.options).find(o => o.text.trim() === ${JSON.stringify(input.text)});
                 if (!opt) throw new Error('Option not found: ' + ${JSON.stringify(input.text)});
                 el.value = opt.value;`
              : `el.value = ${JSON.stringify(input.value)};`;
            await cdp.evaluate(
              `(() => {
                const el = document.querySelector(${JSON.stringify(input.selector)});
                ${matchExpr}
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              })()`,
            );
          } else {
            await cdp.clickSelector(input.selector);
            await new Promise((r) => setTimeout(r, 300));
            const searchText = input.text ?? input.value!;
            const optResult = await cdp.evaluate(`(() => {
              const search = ${JSON.stringify(searchText)};
              for (const opt of document.querySelectorAll('[role="option"]')) {
                const r = opt.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                const t = (opt.textContent || '').trim();
                const v = opt.getAttribute('data-value') || '';
                if (t === search || v === search) return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: t };
              }
              for (const opt of document.querySelectorAll('[role="option"]')) {
                const r = opt.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                const t = (opt.textContent || '').trim();
                if (t.includes(search) || search.includes(t)) return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: t };
              }
              return null;
            })()`);
            if (!optResult.value) {
              return wrap(errorResult('browser_select', new Error(
                `No visible option matching "${searchText}". The dropdown may not have opened or options use non-standard markup.`,
              )));
            }
            const { x, y } = optResult.value as { x: number; y: number };
            await cdp.dispatchMouseEvent('mousePressed', x, y, { clickCount: 1 });
            await cdp.dispatchMouseEvent('mouseReleased', x, y, { clickCount: 1 });
          }
          const label = input.text ?? input.value;
          return wrap(await screenshotAfter(cdp, 300, `Selected "${label}" in ${input.selector}`));
        } catch (error) {
          return wrap(errorResult('browser_select', error));
        }
      },
    }),

    pi.defineTool<typeof browserFillSchema, undefined>({
      name: piName('browser_fill'),
      label: piName('browser_fill'),
      description: 'Fill multiple form fields in a single call with post-fill verification. Each text field is verified after filling — WARN is reported if the value did not stick (read-only field, wrong selector, framework rejection). Much faster than separate BrowserType/BrowserSelect calls — text is inserted in one operation (not character-by-character). Prefer this over individual calls when filling 2+ fields. Use stable CSS selectors (#id, [name="..."], or [data-dq="N"] from BrowserQuery). Field types: "text" (default) clears and types into input/textarea. "select" handles native and custom dropdowns. "date" takes ISO YYYY-MM-DD — pass the calendar trigger button selector (e.g. the "Pick a date" button); auto-opens the popover, navigates months, and clicks the target day in one step. "check"/"uncheck" toggles checkboxes/switches. Returns a screenshot.',
      parameters: browserFillSchema,
      execute: async (_id, input) => {
        try {
          const cdp = requireCdp('browser_fill');
          const results: string[] = [];

          for (const field of input.fields) {
            // pi's `Static` over a `.map`-built literal union does not narrow to the literal set, so
            // type it as `string` here to keep the SDK switch body verbatim and type-safe.
            const fieldType: string = field.type ?? 'text';
            try {
              switch (fieldType) {
                case 'text': {
                  await cdp.clickSelector(field.selector);
                  await new Promise((r) => setTimeout(r, 100));
                  await cdp.selectAllAndDelete();
                  await new Promise((r) => setTimeout(r, 50));
                  await cdp.insertText(field.value);
                  const verifyResult = await cdp.evaluate(`(() => {
                    const el = document.querySelector(${JSON.stringify(field.selector)});
                    return el ? (el.value || el.textContent || '').substring(0, 100) : null;
                  })()`);
                  const actual = verifyResult.value as string | null;
                  const preview = field.value.length > 40 ? field.value.substring(0, 37) + '...' : field.value;
                  if (actual === null) {
                    results.push(`WARN text ${field.selector} = "${preview}" (element lost after fill)`);
                  } else if (!actual.trim()) {
                    results.push(`WARN text ${field.selector} = "${preview}" (field appears empty after fill — may need different selector or field is read-only)`);
                  } else {
                    results.push(`OK text ${field.selector} = "${preview}"`);
                  }
                  break;
                }
                case 'select': {
                  const tagResult = await cdp.evaluate(
                    `document.querySelector(${JSON.stringify(field.selector)})?.tagName`,
                  );
                  if (!tagResult.value) throw new Error(`Element not found: ${field.selector}`);
                  if (tagResult.value === 'SELECT') {
                    await cdp.evaluate(`(() => {
                      const el = document.querySelector(${JSON.stringify(field.selector)});
                      const search = ${JSON.stringify(field.value)};
                      const searchLower = search.toLowerCase();
                      const opt = Array.from(el.options).find(o => o.text.trim().toLowerCase() === searchLower || o.value.toLowerCase() === searchLower);
                      if (!opt) throw new Error('Option not found: ' + search + '. Available: ' + Array.from(el.options).map(o => o.text.trim()).join(', '));
                      el.value = opt.value;
                      el.dispatchEvent(new Event('input', { bubbles: true }));
                      el.dispatchEvent(new Event('change', { bubbles: true }));
                    })()`);
                  } else {
                    await cdp.clickSelector(field.selector);
                    await new Promise((r) => setTimeout(r, 300));
                    const optResult = await cdp.evaluate(`(() => {
                      const search = ${JSON.stringify(field.value)};
                      const searchLower = search.toLowerCase();
                      const available = [];
                      for (const opt of document.querySelectorAll('[role="option"]')) {
                        const r = opt.getBoundingClientRect();
                        if (r.width === 0 || r.height === 0) continue;
                        const t = (opt.textContent || '').trim();
                        const v = opt.getAttribute('data-value') || '';
                        available.push(t);
                        if (t.toLowerCase() === searchLower || v.toLowerCase() === searchLower) return { x: r.x + r.width/2, y: r.y + r.height/2, text: t };
                      }
                      for (const opt of document.querySelectorAll('[role="option"]')) {
                        const r = opt.getBoundingClientRect();
                        if (r.width === 0 || r.height === 0) continue;
                        const t = (opt.textContent || '').trim();
                        const tLower = t.toLowerCase();
                        if (tLower.includes(searchLower) || searchLower.includes(tLower)) return { x: r.x + r.width/2, y: r.y + r.height/2, text: t };
                      }
                      return { available };
                    })()`);
                    const optVal = optResult.value as { x?: number; y?: number; text?: string; available?: string[] } | null;
                    if (!optVal || !optVal.x) {
                      await cdp.dispatchKeyEvent('keyDown', { key: 'Escape', code: 'Escape' });
                      await cdp.dispatchKeyEvent('keyUp', { key: 'Escape', code: 'Escape' });
                      await new Promise((r) => setTimeout(r, 100));
                      const avail = optVal?.available?.join(', ') || 'none visible';
                      throw new Error(`Option "${field.value}" not found in dropdown. Available: ${avail}`);
                    }
                    await cdp.dispatchMouseEvent('mousePressed', optVal.x!, optVal.y!, { clickCount: 1 });
                    await cdp.dispatchMouseEvent('mouseReleased', optVal.x!, optVal.y!, { clickCount: 1 });
                  }
                  results.push(`OK select ${field.selector} = "${field.value}"`);
                  break;
                }
                case 'date': {
                  const nativeResult = await cdp.evaluate(`(() => {
                    const el = document.querySelector(${JSON.stringify(field.selector)});
                    if (!el) return { error: 'not_found' };
                    if (el.tagName === 'INPUT' && (el.type === 'date' || el.type === 'datetime-local')) {
                      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                      if (setter) setter.call(el, ${JSON.stringify(field.value)});
                      else el.value = ${JSON.stringify(field.value)};
                      el.dispatchEvent(new Event('input', { bubbles: true }));
                      el.dispatchEvent(new Event('change', { bubbles: true }));
                      return { done: true };
                    }
                    return { done: false };
                  })()`);
                  const nv = nativeResult.value as { done: boolean; error?: string };
                  if (nv.error === 'not_found') throw new Error(`Element not found: ${field.selector}`);
                  if (nv.done) {
                    results.push(`OK date ${field.selector} = "${field.value}" (native input)`);
                    break;
                  }
                  await cdp.clickSelector(field.selector);
                  await new Promise((r) => setTimeout(r, 500));
                  const calResult = await cdp.evaluate(`(async () => {
                    const dateStr = ${JSON.stringify(field.value)};
                    const parts = dateStr.split('-').map(Number);
                    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return { error: 'Invalid date format. Use YYYY-MM-DD.' };
                    const [y, m, d] = parts;
                    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
                    const short = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

                    function simulateClick(el) {
                      const r = el.getBoundingClientRect();
                      const cx = r.x + r.width/2, cy = r.y + r.height/2;
                      const common = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window, button: 0 };
                      el.dispatchEvent(new PointerEvent('pointerdown', { ...common, pointerId: 1, pointerType: 'mouse' }));
                      el.dispatchEvent(new MouseEvent('mousedown', common));
                      el.dispatchEvent(new PointerEvent('pointerup', { ...common, pointerId: 1, pointerType: 'mouse' }));
                      el.dispatchEvent(new MouseEvent('mouseup', common));
                      el.dispatchEvent(new MouseEvent('click', common));
                    }

                    function findCalendarContainer() {
                      for (const g of document.querySelectorAll('[role="grid"]')) {
                        const r = g.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) {
                          return g.closest('[data-radix-popper-content-wrapper], [data-state="open"], [role="dialog"], [data-dismissable-layer]')
                            || g.parentElement?.parentElement || g.parentElement;
                        }
                      }
                      const layerSels = ['[data-radix-popper-content-wrapper]', '[data-dismissable-layer]', '[popover]:popover-open'];
                      for (const sel of layerSels) {
                        try {
                          for (const el of document.querySelectorAll(sel)) {
                            const r = el.getBoundingClientRect();
                            if (r.width <= 0 || r.height <= 0) continue;
                            const cells = el.querySelectorAll('[role="gridcell"], td, button, [role="button"]');
                            let dayCount = 0;
                            for (const c of cells) {
                              const n = parseInt((c.textContent || '').trim());
                              if (n >= 1 && n <= 31) dayCount++;
                            }
                            if (dayCount >= 7) return el;
                          }
                        } catch { /* :popover-open may not be supported */ }
                      }
                      for (const tbl of document.querySelectorAll('table')) {
                        const r = tbl.getBoundingClientRect();
                        if (r.width <= 0 || r.height <= 0) continue;
                        const cells = tbl.querySelectorAll('td');
                        let dayCount = 0;
                        for (const c of cells) {
                          const n = parseInt((c.textContent || '').trim());
                          if (n >= 1 && n <= 31) dayCount++;
                        }
                        if (dayCount >= 7) {
                          return tbl.closest('[data-radix-popper-content-wrapper], [data-state="open"], [role="dialog"], [data-dismissable-layer]')
                            || tbl.parentElement?.parentElement || tbl.parentElement;
                        }
                      }
                      return null;
                    }

                    const container = findCalendarContainer();
                    if (!container) return { error: 'Calendar not found after clicking trigger' };

                    const heading = container.querySelector('[role="heading"]')
                      || container.querySelector('h2, h3, [class*="heading"], [class*="caption"]');
                    let ht = heading?.textContent?.trim() || '';
                    if (!ht) {
                      for (const el of container.querySelectorAll('div, span, button')) {
                        const t = (el.textContent || '').trim();
                        const hasMonth = months.some(mn => t.includes(mn)) || short.some(s => t.includes(s));
                        if (hasMonth && /\\d{4}/.test(t) && t.length < 40) { ht = t; break; }
                      }
                    }
                    let curMonth = -1, curYear = -1;
                    for (let i = 0; i < 12; i++) {
                      if (ht.includes(months[i]) || ht.includes(short[i])) {
                        curMonth = i;
                        const ym = ht.match(/\\d{4}/);
                        if (ym) curYear = parseInt(ym[0]);
                        break;
                      }
                    }
                    if (curMonth < 0 || curYear < 0) return { error: 'Cannot parse calendar heading: ' + ht };

                    const delta = (y - curYear) * 12 + ((m - 1) - curMonth);
                    if (delta !== 0) {
                      const allBtns = Array.from(container.querySelectorAll('button')).filter(b => {
                        const r = b.getBoundingClientRect();
                        return r.width > 0 && r.height > 0;
                      });
                      let prevBtn, nextBtn;
                      for (const btn of allBtns) {
                        const al = (btn.getAttribute('aria-label') || '').toLowerCase();
                        if (al.includes('prev')) prevBtn = btn;
                        else if (al.includes('next')) nextBtn = btn;
                      }
                      if (!prevBtn || !nextBtn) {
                        const headerBtns = allBtns.filter(btn => {
                          const br = btn.getBoundingClientRect();
                          const hr = container.getBoundingClientRect();
                          return br.top < hr.top + hr.height * 0.25 && !parseInt((btn.textContent || '').trim());
                        });
                        if (headerBtns.length >= 2) {
                          headerBtns.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
                          if (!prevBtn) prevBtn = headerBtns[0];
                          if (!nextBtn) nextBtn = headerBtns[headerBtns.length - 1];
                        }
                      }
                      const navBtn = delta > 0 ? nextBtn : prevBtn;
                      if (!navBtn) return { error: 'Calendar nav button not found (need ' + (delta > 0 ? 'next' : 'prev') + ', delta=' + delta + ')' };
                      for (let i = 0; i < Math.abs(delta); i++) {
                        simulateClick(navBtn);
                        await new Promise(r => setTimeout(r, 80));
                      }
                      await new Promise(r => setTimeout(r, 300));
                    }

                    const pad = (n) => String(n).padStart(2, '0');
                    const isoTarget = y + '-' + pad(m) + '-' + pad(d);
                    const dayCells = container.querySelectorAll('[role="gridcell"], td');
                    for (const gc of dayCells) {
                      const btn = gc.querySelector('button, [role="button"], div[tabindex]') || gc;
                      const dv = btn.getAttribute('data-value') || gc.getAttribute('data-value') || '';
                      if (dv.includes(isoTarget)) {
                        const r = btn.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) {
                          simulateClick(btn);
                          await new Promise(r => setTimeout(r, 200));
                          return { done: true, desc: months[m-1] + ' ' + d + ', ' + y };
                        }
                      }
                    }
                    for (const gc of dayCells) {
                      const btn = gc.querySelector('button, [role="button"], div[tabindex]') || gc;
                      const t = (btn.textContent || '').trim();
                      if (t !== String(d)) continue;
                      if (btn.hasAttribute('data-disabled') || btn.hasAttribute('data-outside-visible-months') || btn.hasAttribute('data-outside-month')) continue;
                      if (btn.closest('[data-disabled], [data-outside-visible-months], [data-outside-month]')) continue;
                      if (btn.getAttribute('aria-disabled') === 'true') continue;
                      const cs = getComputedStyle(btn);
                      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
                      const r = btn.getBoundingClientRect();
                      if (r.width > 0 && r.height > 0) {
                        simulateClick(btn);
                        await new Promise(r => setTimeout(r, 200));
                        return { done: true, desc: months[m-1] + ' ' + d + ', ' + y };
                      }
                    }
                    return { error: 'Day ' + d + ' not found in ' + months[m-1] + ' ' + y + ' calendar' };
                  })()`);
                  const cv = calResult.value as { done?: boolean; desc?: string; error?: string };
                  if (cv.error) {
                    await cdp.dispatchKeyEvent('keyDown', { key: 'Escape', code: 'Escape' });
                    await cdp.dispatchKeyEvent('keyUp', { key: 'Escape', code: 'Escape' });
                    await new Promise((r) => setTimeout(r, 100));
                    throw new Error(cv.error);
                  }
                  if (!cv.done) {
                    throw new Error('Calendar interaction failed — no date selected');
                  }
                  results.push(`OK date ${field.selector} = "${cv.desc}"`);
                  break;
                }
                case 'check':
                case 'uncheck': {
                  const stateResult = await cdp.evaluate(`(() => {
                    const el = document.querySelector(${JSON.stringify(field.selector)});
                    if (!el) return null;
                    const isNative = el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio');
                    const isCustom = el.getAttribute('role') === 'checkbox' || el.getAttribute('role') === 'switch';
                    if (!isNative && !isCustom) return { error: 'Not a checkbox/switch element' };
                    const checked = isNative ? el.checked : (el.getAttribute('aria-checked') === 'true' || el.getAttribute('data-state') === 'checked');
                    const r = el.getBoundingClientRect();
                    return { checked, x: r.x + r.width/2, y: r.y + r.height/2 };
                  })()`);
                  if (!stateResult.value) throw new Error(`Element not found: ${field.selector}`);
                  const state = stateResult.value as { checked: boolean; x: number; y: number; error?: string };
                  if (state.error) throw new Error(state.error);
                  const needsClick = (fieldType === 'check' && !state.checked) || (fieldType === 'uncheck' && state.checked);
                  if (needsClick) {
                    await cdp.dispatchMouseEvent('mousePressed', state.x, state.y, { clickCount: 1 });
                    await cdp.dispatchMouseEvent('mouseReleased', state.x, state.y, { clickCount: 1 });
                  }
                  results.push(`OK ${fieldType} ${field.selector}${needsClick ? '' : ' (already ' + (fieldType === 'check' ? 'checked' : 'unchecked') + ')'}`);
                  break;
                }
              }
              await new Promise((r) => setTimeout(r, 150));
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error);
              results.push(`FAIL ${fieldType} ${field.selector} — ${msg}`);
            }
          }

          return wrap(await screenshotAfter(cdp, 500, results.join('\n')));
        } catch (error) {
          return wrap(errorResult('browser_fill', error));
        }
      },
    }),

    pi.defineTool<typeof browserWaitSchema, undefined>({
      name: piName('browser_wait'),
      label: piName('browser_wait'),
      description: 'Wait for an element to appear on the page. Provide EITHER a CSS selector OR visible text content. Returns a screenshot once the element is found.',
      parameters: browserWaitSchema,
      execute: async (_id, input, signal) => {
        try {
          const cdp = requireCdp('browser_wait');
          if (!input.selector && !input.text) {
            return wrap({ content: [{ type: 'text', text: 'Error: Provide either selector or text parameter.' }], isError: true });
          }
          const timeoutMs = input.timeout ?? 10000;
          if (input.text) {
            const pollInterval = 100;
            const maxAttempts = Math.ceil(timeoutMs / pollInterval);
            for (let i = 0; i < maxAttempts; i++) {
              if (signal?.aborted) return wrap({ content: [{ type: 'text', text: `Aborted waiting for text: "${input.text}"` }], isError: true });
              const found = await cdp.evaluate(`(() => {
                const target = ${JSON.stringify(input.text)};
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                let node;
                while (node = walker.nextNode()) {
                  if (node.textContent && node.textContent.includes(target)) {
                    const el = node.parentElement;
                    if (el) {
                      const r = el.getBoundingClientRect();
                      const s = getComputedStyle(el);
                      if (r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden') return true;
                    }
                  }
                }
                return false;
              })()`);
              if (found.value === true) {
                const screenshot = await cdp.captureScreenshot();
                return wrap(imageResult(screenshot, `Text appeared: "${input.text}"`));
              }
              await new Promise((r) => setTimeout(r, pollInterval));
            }
            return wrap({ content: [{ type: 'text', text: `Error: Timeout waiting for text: "${input.text}"` }], isError: true });
          }
          await cdp.waitForSelector(input.selector!, timeoutMs);
          const screenshot = await cdp.captureScreenshot();
          return wrap(imageResult(screenshot, `Element appeared: ${input.selector}`));
        } catch (error) {
          return wrap(errorResult('browser_wait', error));
        }
      },
    }),

    pi.defineTool<typeof browserDragSchema, undefined>({
      name: piName('browser_drag'),
      label: piName('browser_drag'),
      description: 'Drag an element to a drop target using HTML5 Drag-and-Drop events (dragstart/dragover/drop). Also dispatches pointer events for frameworks that use them. Returns a screenshot showing the result — verify the drag visually.',
      parameters: browserDragSchema,
      execute: async (_id, input) => {
        try {
          const cdp = requireCdp('browser_drag');
          const result = await cdp.evaluate(`(() => {
            const src = document.querySelector(${JSON.stringify(input.sourceSelector)});
            const tgt = document.querySelector(${JSON.stringify(input.targetSelector)});
            if (!src) return { error: 'source not found' };
            if (!tgt) return { error: 'target not found' };

            src.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            const sr = src.getBoundingClientRect();
            const sx = sr.x + sr.width / 2, sy = sr.y + sr.height / 2;
            tgt.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            const tr = tgt.getBoundingClientRect();
            const tx = tr.x + tr.width / 2, ty = tr.y + tr.height / 2;

            const dt = new DataTransfer();
            const commonInit = { bubbles: true, cancelable: true };
            const dragInit = { ...commonInit, dataTransfer: dt };

            src.dispatchEvent(new PointerEvent('pointerdown', { ...commonInit, clientX: sx, clientY: sy, pointerId: 1 }));
            src.dispatchEvent(new MouseEvent('mousedown', { ...commonInit, clientX: sx, clientY: sy }));

            const ds = src.dispatchEvent(new DragEvent('dragstart', { ...dragInit, clientX: sx, clientY: sy }));
            src.dispatchEvent(new DragEvent('drag', { ...dragInit, clientX: sx, clientY: sy }));

            tgt.dispatchEvent(new DragEvent('dragenter', { ...dragInit, clientX: tx, clientY: ty }));
            tgt.dispatchEvent(new DragEvent('dragover', { ...dragInit, clientX: tx, clientY: ty }));
            tgt.dispatchEvent(new DragEvent('drop', { ...dragInit, clientX: tx, clientY: ty }));
            src.dispatchEvent(new DragEvent('dragend', { ...dragInit, clientX: tx, clientY: ty }));

            src.dispatchEvent(new PointerEvent('pointerup', { ...commonInit, clientX: tx, clientY: ty, pointerId: 1 }));
            src.dispatchEvent(new MouseEvent('mouseup', { ...commonInit, clientX: tx, clientY: ty }));

            return { ok: true, dragStartDefault: ds };
          })()`);

          const val = result.value as { error?: string; ok?: boolean; dragStartDefault?: boolean } | null;
          if (val?.error) {
            return wrap({ content: [{ type: 'text', text: `Error: Element not found: ${val.error === 'source not found' ? input.sourceSelector : input.targetSelector}` }], isError: true });
          }

          return wrap(await screenshotAfter(cdp, 500, `Dragged ${input.sourceSelector} → ${input.targetSelector}`));
        } catch (error) {
          return wrap(errorResult('browser_drag', error));
        }
      },
    }),

    pi.defineTool<typeof emptySchema, undefined>({
      name: piName('browser_snapshot'),
      label: piName('browser_snapshot'),
      description: 'Get a compact text map of the page — headings, visible text, and all interactive elements with numbered [ref] markers. Reports scroll state, off-screen elements below the viewport fold, and empty form fields in the header. IMPORTANT: Before submitting any form, check for [Empty fields] in the header and (off-screen) markers on elements — scroll down if needed to discover and fill all fields. Use [ref] numbers with BrowserAct to interact. Ref numbers are reassigned each call — always use refs from the most recent snapshot.',
      parameters: emptySchema,
      execute: async () => {
        try {
          const cdp = requireCdp('browser_snapshot');
          const snap = await takeSnapshot(cdp);
          return wrap(textResult(snap));
        } catch (error) {
          return wrap(errorResult('browser_snapshot', error));
        }
      },
    }),

    pi.defineTool<typeof browserActSchema, undefined>({
      name: piName('browser_act'),
      label: piName('browser_act'),
      description: 'Perform actions using [ref] numbers from the most recent page snapshot (from BrowserSnapshot, BrowserOpen, BrowserNavigate, or a previous BrowserAct). Supports batching multiple actions in one call for maximum speed. Returns a fresh page snapshot after all actions complete. Actions: click (ref), type (ref + text, optional clear), select (ref + value, handles native & custom dropdowns), key (key name like Enter/Escape/Tab, optional ref to focus first), hover (ref).',
      parameters: browserActSchema,
      execute: async (_id, input) => {
        try {
          const cdp = requireCdp('browser_act');
          const results: string[] = [];

          for (const [i, a] of input.actions.entries()) {
            try {
              const sel = a.ref !== undefined ? `[data-dq="${a.ref}"]` : undefined;

              switch (a.action) {
                case 'click': {
                  if (!sel) throw new Error('ref is required for click');
                  await cdp.clickSelector(sel);
                  results.push(`OK click [${a.ref}]`);
                  break;
                }
                case 'type': {
                  if (!sel) throw new Error('ref is required for type');
                  if (!a.text) throw new Error('text is required for type');
                  await cdp.clickSelector(sel);
                  await new Promise((r) => setTimeout(r, 100));
                  if (a.clear) {
                    await cdp.selectAllAndDelete();
                    await new Promise((r) => setTimeout(r, 50));
                  }
                  await cdp.typeText(a.text);
                  results.push(`OK type [${a.ref}] "${a.text}"`);
                  break;
                }
                case 'select': {
                  if (!sel) throw new Error('ref is required for select');
                  if (!a.value) throw new Error('value is required for select');
                  const tagResult = await cdp.evaluate(
                    `document.querySelector(${JSON.stringify(sel)})?.tagName`,
                  );
                  if (!tagResult.value) throw new Error(`Element [${a.ref}] not found`);
                  if (tagResult.value === 'SELECT') {
                    await cdp.evaluate(`(() => {
                      const el = document.querySelector(${JSON.stringify(sel)});
                      const search = ${JSON.stringify(a.value)};
                      const opt = Array.from(el.options).find(o => o.text.trim() === search || o.value === search);
                      if (!opt) throw new Error('Option not found: ' + search);
                      el.value = opt.value;
                      el.dispatchEvent(new Event('input', { bubbles: true }));
                      el.dispatchEvent(new Event('change', { bubbles: true }));
                    })()`);
                  } else {
                    await cdp.clickSelector(sel);
                    await new Promise((r) => setTimeout(r, 300));
                    const optResult = await cdp.evaluate(`(() => {
                      const search = ${JSON.stringify(a.value)};
                      for (const opt of document.querySelectorAll('[role="option"]')) {
                        const r = opt.getBoundingClientRect();
                        if (r.width === 0 || r.height === 0) continue;
                        const t = (opt.textContent || '').trim();
                        const v = opt.getAttribute('data-value') || '';
                        if (t === search || v === search) return { x: r.x + r.width/2, y: r.y + r.height/2 };
                      }
                      for (const opt of document.querySelectorAll('[role="option"]')) {
                        const r = opt.getBoundingClientRect();
                        if (r.width === 0 || r.height === 0) continue;
                        const t = (opt.textContent || '').trim();
                        if (t.includes(search) || search.includes(t)) return { x: r.x + r.width/2, y: r.y + r.height/2 };
                      }
                      return null;
                    })()`);
                    if (!optResult.value) throw new Error(`Option "${a.value}" not found in dropdown`);
                    const { x, y } = optResult.value as { x: number; y: number };
                    await cdp.dispatchMouseEvent('mousePressed', x, y, { clickCount: 1 });
                    await cdp.dispatchMouseEvent('mouseReleased', x, y, { clickCount: 1 });
                  }
                  results.push(`OK select [${a.ref}] "${a.value}"`);
                  break;
                }
                case 'key': {
                  if (!a.text) throw new Error('text is required for key (key name)');
                  if (sel) {
                    await cdp.clickSelector(sel);
                    await new Promise((r) => setTimeout(r, 50));
                  }
                  await cdp.dispatchKeyEvent('keyDown', { key: a.text, code: a.text });
                  await cdp.dispatchKeyEvent('keyUp', { key: a.text, code: a.text });
                  results.push(`OK key "${a.text}"${a.ref !== undefined ? ` on [${a.ref}]` : ''}`);
                  break;
                }
                case 'hover': {
                  if (!sel) throw new Error('ref is required for hover');
                  const { x, y } = await cdp.resolveSelector(sel);
                  await cdp.dispatchMouseEvent('mouseMoved', x, y);
                  results.push(`OK hover [${a.ref}]`);
                  break;
                }
              }
              await new Promise((r) => setTimeout(r, 150));
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error);
              results.push(`FAIL ${a.action}${a.ref !== undefined ? ` [${a.ref}]` : ''} — ${msg}`);
              results.push(`(stopped at action ${i})`);
              break;
            }
          }

          await new Promise((r) => setTimeout(r, 300));
          try {
            for (let attempt = 0; attempt < 10; attempt++) {
              const rs = await cdp.evaluate('document.readyState');
              if (rs.value === 'complete') break;
              await new Promise((r) => setTimeout(r, 200));
            }
          } catch { /* page may have navigated */ }

          const snap = await takeSnapshot(cdp);
          return wrap(textResult(results.join('\n') + '\n\n' + snap));
        } catch (error) {
          return wrap(errorResult('browser_act', error));
        }
      },
    }),

    pi.defineTool<typeof emptySchema, undefined>({
      name: piName('browser_close'),
      label: piName('browser_close'),
      description: 'Close the browser and end the automation session. Closes the VS Code browser panel, stops the headless Chrome process, and releases all resources.',
      parameters: emptySchema,
      execute: async () => {
        try {
          await browserService.close();
          return wrap(textResult('Browser closed.'));
        } catch (error) {
          return wrap(errorResult('browser_close', error));
        }
      },
    }),
  ];

  // Every browser tool honors the turn's abort signal at its boundary (CDP has no per-request cancel).
  return definitions.map(abortableTool);
}
