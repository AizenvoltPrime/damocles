import * as vscode from 'vscode';
import type { LocalizationService } from '../../platform/localization-service';

export function createVsCodeLocalizationService(): LocalizationService {
  return {
    t: (message, ...args) => vscode.l10n.t(message, ...args),
    get language() { return vscode.env.language; },
  };
}
