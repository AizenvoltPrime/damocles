// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { type FakeWebviewPanel } from 'vscode';
import { wrapBrowserPanel } from '../webview-hosts';

// The VS Code host builds the browser page with its own strings, rendered by vscode.l10n.t in VS Code's display language.

const MARKER = 'ZZQXLOCALEMARKERZZ';

function browserPageHtml(): string {
  const panel = vscode.window.createWebviewPanel('damocles-browser-view', 'Browser', 1) as unknown as FakeWebviewPanel;
  wrapBrowserPanel(panel as unknown as vscode.WebviewPanel).showPage!({ kind: 'browser', toolbar: true });
  return panel.webview.html;
}

/** The page with every vscode.l10n.t() call replaced by a uniquely-identifiable marker. */
function markedHtml(): { html: string; keys: string[] } {
  const keys: string[] = [];
  let n = 0;
  vi.spyOn(vscode.l10n, 't').mockImplementation(((message: string) => {
    keys.push(message);
    return `${MARKER}${n++}`;
  }) as typeof vscode.l10n.t);
  return { html: browserPageHtml(), keys };
}

/** Visible text nodes, excluding <script> and <style>, both letter-bearing by construction. */
function visibleTextNodes(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of [...doc.querySelectorAll('script, style')]) el.remove();
  const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_TEXT);
  const out: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? '').trim();
    if (text) out.push(text);
  }
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the browser page VS Code builds', () => {
  it('has no hardcoded letter-bearing visible text: every text node is a marker', () => {
    const { html } = markedHtml();

    for (const text of visibleTextNodes(html)) {
      // Anything with a letter that is not a marker is user-visible English baked into the source.
      if (/\p{L}/u.test(text)) expect(text).toContain(MARKER);
    }
  });

  it('has no hardcoded title or placeholder attribute: every one is a marker', () => {
    const doc = new DOMParser().parseFromString(markedHtml().html, 'text/html');

    const attrs = [...doc.querySelectorAll('[title], [placeholder]')].flatMap((el) =>
      ['title', 'placeholder'].map((a) => el.getAttribute(a)).filter((v): v is string => v !== null),
    );
    expect(attrs.length).toBeGreaterThanOrEqual(7);
    for (const value of attrs) {
      if (/\p{L}/u.test(value)) expect(value).toContain(MARKER);
    }
  });

  it('requests exactly the documented key set, and every key is in both l10n bundles', () => {
    const { keys } = markedHtml();
    const expected = [
      'Back', 'Forward', 'Reload', 'Pick Element',
      'Open Developer Tools (F12)', 'New Tab', 'Enter URL...', 'Waiting for browser frames...', 'Not secure',
      'The connection to this site is not encrypted, so others on the network can read and change what it sends.',
    ];

    expect([...keys].sort()).toEqual([...expected].sort());

    const root = join(__dirname, '..', '..', '..', '..');
    const en = JSON.parse(readFileSync(join(root, 'l10n', 'bundle.l10n.json'), 'utf8')) as Record<string, string>;
    const el = JSON.parse(readFileSync(join(root, 'l10n', 'bundle.l10n.el.json'), 'utf8')) as Record<string, string>;
    for (const key of expected) {
      expect(`en:${key}:${key in en}`).toBe(`en:${key}:true`);
      expect(`el:${key}:${key in el}`).toBe(`el:${key}:true`);
      expect(el[key]).not.toBe('');
    }
  });

  // Strings read once at module load would miss a display language set after the extension loaded.
  it('reads its strings per page, not at module load', () => {
    const first = markedHtml();
    vi.restoreAllMocks();
    const second = markedHtml();

    expect(second.keys).toEqual(first.keys);
    expect(second.html).toContain(MARKER);
  });

  it('escapes the strings, so a translation holding markup cannot break out', () => {
    vi.spyOn(vscode.l10n, 't').mockImplementation((() => '"><img src=x onerror=alert(1)>\'&') as typeof vscode.l10n.t);
    const html = browserPageHtml();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // These land in title="..." and placeholder="..." attributes, so all five of &<>"' must be escaped.
    expect(doc.querySelector('img')).toBeNull();
    expect(html).not.toContain('<img');
    expect(doc.getElementById('btn-back')!.getAttribute('title')).toBe('"><img src=x onerror=alert(1)>\'&');
    expect(doc.getElementById('btn-back')!.hasAttribute('onerror')).toBe(false);
    expect(doc.getElementById('url-input')!.getAttribute('placeholder')).toBe('"><img src=x onerror=alert(1)>\'&');
  });
});
