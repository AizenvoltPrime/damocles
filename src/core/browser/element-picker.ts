import { randomBytes } from 'node:crypto';
import type { PageController } from './page-controller';
import { boundConsoleEntries } from './collectors';
import { redactAttributes, redactMarkup, redactSecrets } from './redaction';
import type { ConsoleCollector, NetworkCollector } from './collectors';
import type { MatchedStyleRule } from './types';
import type { ElementAttachment } from '../../shared/types/browser';
import { log } from '../logger';

const MAX_HTML_LENGTH = 2048;

/** Bound a page-controlled string, marking the cut so a reader never mistakes it for the whole value. */
function truncate(text: string): string {
  return text.length > MAX_HTML_LENGTH ? `${text.slice(0, MAX_HTML_LENGTH)}... (truncated)` : text;
}

/** How long an unanswered pick stays armed. Without a bound, a user who opens the picker and never
 *  clicks leaves `pickElement()` pending forever. */
const PICK_TIMEOUT_MS = 60_000;

export class ElementPicker {
  private picking = false;
  private pickResolve: ((attachment: ElementAttachment) => void) | null = null;
  private pickReject: ((reason: Error) => void) | null = null;
  private pickTimer: ReturnType<typeof setTimeout> | null = null;
  private cdp: PageController;
  private consoleCollector: ConsoleCollector;
  private networkCollector: NetworkCollector;

  constructor(cdp: PageController, consoleCollector: ConsoleCollector, networkCollector: NetworkCollector) {
    this.cdp = cdp;
    this.consoleCollector = consoleCollector;
    this.networkCollector = networkCollector;
  }

  get isPicking(): boolean {
    return this.picking;
  }

  async startPicking(): Promise<ElementAttachment> {
    if (this.picking) {
      throw new Error('Element picker is already active');
    }
    this.picking = true;

    const promise = new Promise<ElementAttachment>((resolve, reject) => {
      this.pickResolve = resolve;
      this.pickReject = reject;
      this.pickTimer = setTimeout(() => {
        this.pickTimer = null;
        reject(new Error(`Element picking timed out after ${PICK_TIMEOUT_MS / 1000}s with no selection`));
        this.pickResolve = null;
        this.pickReject = null;
        this.stopPicking().catch((err) =>
          log(`[Browser] Picker stop after timeout failed — ${err instanceof Error ? err.message : String(err)}`),
        );
      }, PICK_TIMEOUT_MS);
    });

    await this.cdp.setInspectMode('searchForNode');

    return promise;
  }

  /** Disarm the abandoned-pick timeout. Every settle path calls this: a timer left running would later
   *  fire against a FRESH pick and cancel it. */
  private clearPickTimer(): void {
    if (this.pickTimer === null) return;
    clearTimeout(this.pickTimer);
    this.pickTimer = null;
  }

  async handleInspectNodeRequested(backendNodeId: number): Promise<void> {
    // Claim the pick SYNCHRONOUSLY, before the first await, taking BOTH settlers together. The
    // collection sequence below is ~8 CDP round trips, so two events arriving close together would
    // otherwise both pass the guard and race the same resolve; whoever claims the settlers here owns
    // this pick and the other returns.
    //
    // BOTH, NOT JUST `resolve`, IS THE POINT. Leaving `pickReject` on the instance kept a settler for a
    // pick that is already claimed: a later failure in this collection would reject whatever pick was
    // armed BY THEN — killing a fresh, unrelated pick — and `stopPicking` would early-return on
    // `picking === false`, so nothing ever cleared it. Captured locally, this collection can only ever
    // settle its own promise.
    const resolve = this.pickResolve;
    const reject = this.pickReject;
    if (!this.picking || !resolve || !reject) return;
    this.pickResolve = null;
    this.pickReject = null;
    this.picking = false;
    this.clearPickTimer();

    try {
      await this.cdp.setInspectMode('none');
      await this.cdp.getDocument();

      const nodeDesc = await this.cdp.describeNode(backendNodeId);
      const outerHTML = await this.cdp.getOuterHTML(undefined, backendNodeId);
      const box = await this.cdp.getBoxModel(undefined, backendNodeId);
      const resolved = await this.cdp.resolveNode(backendNodeId);

      let computedStyles: Record<string, string> = {};
      let htmlPath = '';
      let matchedRules = '';
      let innerText = '';

      if (resolved.objectId) {
        const nodeId = await this.cdp.requestNode(resolved.objectId);

        computedStyles = await this.collectComputedStyles(resolved.objectId);
        htmlPath = await this.collectHtmlPath(resolved.objectId);
        matchedRules = await this.collectMatchedRules(nodeId);
        innerText = truncate(redactSecrets(await this.collectInnerText(resolved.objectId)));
      }

      const attributes: Record<string, string> = {};
      if (nodeDesc.attributes) {
        for (let i = 0; i < nodeDesc.attributes.length; i += 2) {
          const key = nodeDesc.attributes[i];
          const val = nodeDesc.attributes[i + 1];
          if (key !== undefined && val !== undefined) {
            attributes[key] = val;
          }
        }
      }

      const selector = buildSelector(nodeDesc.localName, attributes);

      const x1 = box.content[0] ?? 0;
      const y1 = box.content[1] ?? 0;
      const x2 = box.content[2] ?? 0;
      const y4 = box.content[7] ?? 0;
      const boundingBox = {
        x: x1,
        y: y1,
        width: x2 - x1,
        height: y4 - y1,
      };

      let elementScreenshot = '';
      try {
        if (boundingBox.width > 0 && boundingBox.height > 0) {
          elementScreenshot = await this.cdp.captureScreenshot({
            clip: { ...boundingBox, scale: 1 },
          });
        }
      } catch (err) {
        log(`[Browser] Picker element screenshot failed — ${err instanceof Error ? err.message : String(err)}`);
      }

      // A picked element is broadcast verbatim into the chat transcript and persisted in the session
      // file, so it is an exfiltration path in exactly the way console output is — the DOM is page
      // data, and `<input type=password value=…>` holds a real credential the user typed. Redaction
      // belongs here, at capture, for the same reason it belongs in the collectors: the bound then holds
      // for every consumer instead of every render site having to remember it. Truncation runs AFTER
      // redaction so a clipped tail can never leave half a secret in the clear.
      const attachment: ElementAttachment = {
        id: `el-${Date.now()}-${randomBytes(4).toString('hex')}`,
        selector,
        tagName: nodeDesc.localName,
        attributes: redactAttributes(attributes),
        outerHTML: truncate(redactMarkup(outerHTML, attributes)),
        computedStyles,
        boundingBox,
        elementScreenshot,
        consoleMessages: boundConsoleEntries(this.consoleCollector.getMessages()),
        networkErrors: this.networkCollector.getErrors(),
      };
      if (htmlPath) attachment.htmlPath = redactSecrets(htmlPath);
      if (matchedRules) attachment.matchedRules = matchedRules;
      if (innerText) attachment.innerText = innerText;

      resolve(attachment);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async collectComputedStyles(objectId: string): Promise<Record<string, string>> {
    try {
      const result = await this.cdp.callFunctionOn(objectId, `function() {
        var cs = getComputedStyle(this);
        var styles = {};
        for (var i = 0; i < cs.length; i++) {
          var name = cs[i];
          styles[name] = cs.getPropertyValue(name);
        }
        return styles;
      }`);
      if (result.value && typeof result.value === 'object') {
        return result.value as Record<string, string>;
      }
    } catch (err) {
      log(`[Browser] Picker computed-styles collection failed — ${err instanceof Error ? err.message : String(err)}`);
    }
    return {};
  }

  private async collectHtmlPath(objectId: string): Promise<string> {
    try {
      const result = await this.cdp.callFunctionOn(objectId, `function() {
        var chain = [];
        var el = this;
        while (el && el.nodeType === 1) {
          var entry = el.tagName.toLowerCase();
          if (el.id) entry += '#' + el.id;
          if (el.className && typeof el.className === 'string') {
            var cls = el.className.trim().split(/\\s+/).filter(Boolean);
            if (cls.length > 0) entry += '.' + cls.join('.');
          }
          chain.unshift(entry);
          el = el.parentElement;
        }
        return chain.join(' > ');
      }`);
      if (typeof result.value === 'string') {
        return result.value;
      }
    } catch (err) {
      log(`[Browser] Picker html-path collection failed — ${err instanceof Error ? err.message : String(err)}`);
    }
    return '';
  }

  private async collectInnerText(objectId: string): Promise<string> {
    try {
      const result = await this.cdp.callFunctionOn(objectId, `function() {
        return this.innerText || '';
      }`);
      if (typeof result.value === 'string') {
        return result.value.trim();
      }
    } catch (err) {
      log(`[Browser] Picker inner-text collection failed — ${err instanceof Error ? err.message : String(err)}`);
    }
    return '';
  }

  private async collectMatchedRules(nodeId: number): Promise<string> {
    try {
      const matched = await this.cdp.getMatchedStylesForNode(nodeId);
      const lines: string[] = [];

      if (matched.inlineStyle?.cssProperties) {
        const props = matched.inlineStyle.cssProperties
          .filter(p => p.value && p.name)
          .map(p => `  ${p.name}: ${p.value};`);
        if (props.length > 0) {
          lines.push('/* Inline Styles */', 'style {', ...props, '}', '');
        }
      }

      if (matched.matchedCSSRules) {
        for (const entry of matched.matchedCSSRules) {
          const formatted = formatMatchedRule(entry);
          if (formatted) lines.push(formatted);
        }
      }

      if (matched.inherited) {
        for (let level = 0; level < matched.inherited.length; level++) {
          const ancestor = matched.inherited[level];
          if (!ancestor?.matchedCSSRules?.length) continue;
          const ancestorRules: string[] = [];
          for (const entry of ancestor.matchedCSSRules) {
            const formatted = formatMatchedRule(entry);
            if (formatted) ancestorRules.push(formatted);
          }
          if (ancestorRules.length > 0) {
            lines.push(`/* Inherited (level ${level + 1}) */`, ...ancestorRules);
          }
        }
      }

      return lines.join('\n');
    } catch (err) {
      log(`[Browser] Picker matched-rules collection failed — ${err instanceof Error ? err.message : String(err)}`);
    }
    return '';
  }

  /**
   * Cancel an armed pick.
   *
   * SETTLE FIRST, THEN TALK TO CHROMIUM. Every caller that matters — `handlePageClosed`, `disposeEntry`
   * — runs when the target is ALREADY GONE, so `setInspectMode` rejects. Awaiting it before settling
   * meant the rejection escaped past `pickReject`, both call sites swallowed it, and `pickElement()`
   * stayed pending forever with the toolbar stuck in picking state. The local state is ours and always
   * settles; the CDP call is best-effort cleanup for the live-page case, where a failure is worth a log
   * and nothing more.
   */
  async stopPicking(): Promise<void> {
    if (!this.picking) return;
    this.picking = false;
    this.clearPickTimer();
    const reject = this.pickReject;
    this.pickResolve = null;
    this.pickReject = null;
    reject?.(new Error('Element picking cancelled'));
    await this.cdp.setInspectMode('none').catch((err) =>
      log(`[Browser] Picker inspect-mode reset failed — ${err instanceof Error ? err.message : String(err)}`),
    );
  }
}

function formatMatchedRule(entry: MatchedStyleRule): string | null {
  const rule = entry.rule;
  if (rule.origin === 'user-agent') return null;

  const props = rule.style.cssProperties
    .filter(p => p.value && p.name && !p.name.startsWith('-internal'))
    .map(p => `  ${p.name}: ${p.value};`);
  if (props.length === 0) return null;

  const selectorText = rule.selectorList?.selectors?.map(s => s.text).join(', ') ?? '';
  const origin = rule.origin === 'regular' ? 'regular' : rule.origin;
  return `/* Matched Rule from ${origin} */\n${selectorText} {\n${props.join('\n')}\n}\n`;
}

function buildSelector(tagName: string, attributes: Record<string, string>): string {
  let selector = tagName;
  const id = attributes['id'];
  if (id) {
    selector += `#${id}`;
  }
  const cls = attributes['class'];
  if (cls) {
    const classes = cls.trim().split(/\s+/);
    selector += classes.map(c => `.${c}`).join('');
  }
  return selector;
}
