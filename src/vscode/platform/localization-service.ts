import * as vscode from 'vscode';
import type { LocalizationService } from '../../platform/localization-service';
import type { LocalizedArg, LocalizedText } from '../../shared/localized-text';

function renderArg(arg: LocalizedArg): string | number {
  if (typeof arg === 'string' || typeof arg === 'number') return arg;
  if ('number' in arg) return arg.number.toLocaleString(vscode.env.language);
  return renderVsCode(arg);
}

/** Core's text in VS Code's display language: nested arguments first, then vscode.l10n.t over the extension's bundle. */
export function renderVsCode(text: LocalizedText): string {
  return vscode.l10n.t(text.message, ...(text.args ?? []).map(renderArg));
}

export function createVsCodeLocalizationService(): LocalizationService {
  return {
    get language() { return vscode.env.language; },
  };
}
