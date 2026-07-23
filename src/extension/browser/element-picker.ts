import type { PageController } from './page-controller';
import type { ConsoleCollector, NetworkCollector } from './collectors';
import type { MatchedStyleRule } from './types';
import type { ElementAttachment } from '../../shared/types/browser';

const MAX_HTML_LENGTH = 2048;

export class ElementPicker {
  private picking = false;
  private pickResolve: ((attachment: ElementAttachment) => void) | null = null;
  private pickReject: ((reason: Error) => void) | null = null;
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
    });

    await this.cdp.setInspectMode('searchForNode');

    return promise;
  }

  async handleInspectNodeRequested(backendNodeId: number): Promise<void> {
    if (!this.picking || !this.pickResolve) return;

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
        const rawInnerText = await this.collectInnerText(resolved.objectId);
        innerText = rawInnerText.length > MAX_HTML_LENGTH
          ? rawInnerText.slice(0, MAX_HTML_LENGTH) + '... (truncated)'
          : rawInnerText;
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
      } catch {
      }

      const attachment: ElementAttachment = {
        id: `el-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        selector,
        tagName: nodeDesc.localName,
        attributes,
        outerHTML: outerHTML.length > MAX_HTML_LENGTH
          ? outerHTML.slice(0, MAX_HTML_LENGTH) + '... (truncated)'
          : outerHTML,
        computedStyles,
        boundingBox,
        elementScreenshot,
        consoleMessages: this.consoleCollector.getMessages(),
        networkErrors: this.networkCollector.getErrors(),
      };
      if (htmlPath) attachment.htmlPath = htmlPath;
      if (matchedRules) attachment.matchedRules = matchedRules;
      if (innerText) attachment.innerText = innerText;

      this.picking = false;
      this.pickResolve(attachment);
      this.pickResolve = null;
      this.pickReject = null;
    } catch (err) {
      this.picking = false;
      this.pickReject?.(err instanceof Error ? err : new Error(String(err)));
      this.pickResolve = null;
      this.pickReject = null;
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
    } catch {
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
    } catch {
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
    } catch {
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
    } catch {
    }
    return '';
  }

  async stopPicking(): Promise<void> {
    if (!this.picking) return;
    this.picking = false;
    await this.cdp.setInspectMode('none');
    this.pickReject?.(new Error('Element picking cancelled'));
    this.pickResolve = null;
    this.pickReject = null;
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
