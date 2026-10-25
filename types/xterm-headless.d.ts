// What the xterm addons' `@xterm/xterm` type imports resolve to in the Node programs, which run them on @xterm/headless:
// xterm.d.ts references the DOM lib, whose fetch types would replace Node's.
export type { Terminal, ITerminalAddon, IMarker, IBufferRange } from '@xterm/headless';
