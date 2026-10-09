import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../../../webview/i18n/locales/en.json';
import el from '../../../webview/i18n/locales/el.json';
import { VIEW_CONTEXT_BUTTON } from '../pi-session';

const ROOT = path.join(__dirname, '..', '..', '..', '..');

function bundle(name: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', name), 'utf8')) as Record<string, string>;
}

// A host notice names the webview's View injected context button; the two come from separate catalogs.
describe('the View injected context label', () => {
  it.each([
    ['bundle.l10n.json', en.contextInjection.viewContext],
    ['bundle.l10n.el.json', el.contextInjection.viewContext],
  ])('%s translates the host constant to the button\'s label', (name, label) => {
    expect(bundle(name)[VIEW_CONTEXT_BUTTON]).toBe(label);
  });
});
