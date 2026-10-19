import { shallowRef } from 'vue';
import { type FileIconTheme, parseFileIconTheme } from '../main/desktop-configuration';
import type { ThemeKind } from '../preload/panel-channels';

export interface HostAppearance {
  readonly kind: ThemeKind;
  readonly fileIconTheme: FileIconTheme;
}

// The preload's applyHostTheme and main's page HTML set these attributes; the renderer reads them, never main's settings.
function readDocument(): HostAppearance {
  return {
    kind: document.body.dataset['vscodeThemeKind'] === 'vscode-light' ? 'light' : 'dark',
    fileIconTheme: parseFileIconTheme(document.documentElement.dataset['fileIconTheme']),
  };
}

const appearance = shallowRef<HostAppearance>({ kind: 'dark', fileIconTheme: 'material' });
let watching = false;

/** The page's theme kind and file icon theme, reactive: a render or computed that reads it reruns when main switches either. */
export function hostAppearance(): HostAppearance {
  if (!watching) {
    watching = true;
    // Seeded before this caller reads the ref, so no effect ever writes state it tracks; later changes come from the observer.
    appearance.value = readDocument();
    const observer = new MutationObserver(() => {
      const next = readDocument();
      if (next.kind !== appearance.value.kind || next.fileIconTheme !== appearance.value.fileIconTheme) appearance.value = next;
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-file-icon-theme'] });
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-vscode-theme-kind'] });
  }
  return appearance.value;
}
