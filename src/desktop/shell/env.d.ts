/// <reference types="vite/client" />

interface Window {
  // Exposed by src/desktop/preload/shell.ts; the shell's only channel to main.
  damoclesShell?: import('../preload/shell-channels').DamoclesShellApi;
  // Exposed by src/desktop/preload/pane.ts on the pane page only.
  damoclesPane?: import('../preload/pane-channels').DamoclesPaneApi;
}
