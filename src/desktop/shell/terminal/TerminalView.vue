<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useElementSize, useResizeObserver } from '@vueuse/core';
import { ArrowDown, CircleAlert, CircleCheck, RotateCcw } from 'lucide-vue-next';
import { Terminal, type IBufferRange, type ILink, type ILinkHandler } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { Button } from '@/components/ui/button';
import { remPx } from '@/composables/useRemPx';
import type { OverlayRect } from '../../preload/overlay-channels';
import type { DamoclesShellApi, ShellPlatform } from '../../preload/shell-channels';
import { MAX_TERMINAL_COLS, MAX_TERMINAL_ROWS, TERMINAL_ACK_CHARS, type TerminalAction, type TerminalInfo, type TerminalPaste, type TerminalSettings } from '../../preload/terminal-channels';
import { capTerminalText } from '../../preload/terminal-attachment-cap';
import { groupPanes, TERMINAL_STORE } from './terminal-store';
import { inputChunks, isShiftF10, parseAccelerator, terminalKeyAction, type KeyChord } from './terminal-keys';
import { confirmedLinks, lineCandidates, rangeOf, readWrappedLine, requestPaths } from './terminal-links';
import { commandMenuItems, runTerminalAction, terminalMenuAction, terminalMenuItems, type CommandMenuAction, type CommandMenuContext } from './terminal-menu';
import { commandStatus } from './terminal-commands';
import { createTerminalMarks, type TerminalMarks, type XtermCommand } from './terminal-marks';
import { isFontList, liveOptions } from './terminal-options';
import { createPtyResize } from './pty-resize';
import { terminalTheme, watchHostTheme } from './terminal-theme';
import TerminalFind from './TerminalFind.vue';
import TerminalLinkHover, { type LinkHover } from './TerminalLinkHover.vue';
import TerminalMarkHover, { type MarkHover } from './TerminalMarkHover.vue';

// One terminal's xterm. It stays mounted while another terminal is active (hidden), so its output keeps parsing and acking.
const props = defineProps<{
  api: DamoclesShellApi;
  terminal: TerminalInfo;
  shown: boolean;
  settings: TerminalSettings;
  passKeys: readonly string[];
  platform: ShellPlatform;
  // main's Split Terminal key, which the context menu shows
  splitShortcut: string;
  // TerminalState.screenReader and windowsBuild
  screenReader: boolean;
  windowsBuild: number;
}>();
// resizePane: main's Resize Pane Left or Right, with this xterm's cell width in px, which the split layout moves by
const emit = defineEmits<{ resizePane: [direction: 'left' | 'right', cellPx: number] }>();
const { t } = useI18n();
const store = inject(TERMINAL_STORE)!;

const host = ref<HTMLElement | null>(null);
const term = shallowRef<Terminal | null>(null);
const search = shallowRef<SearchAddon | null>(null);
const findOpen = ref(false);
const find = ref<InstanceType<typeof TerminalFind> | null>(null);
const atEnd = ref(true);
const exited = computed(() => props.terminal.status === 'exited');
const mac = props.platform === 'darwin';
const linkOs = props.platform === 'win32' ? 'windows' : 'posix';
const passChords = computed(() => props.passKeys.flatMap((key) => parseAccelerator(key, mac) ?? ([] as KeyChord[])));
const linkHover = shallowRef<LinkHover | null>(null);
// The text of the last line whose links were provided (main's answer included), which e2e waits on before asserting none.
const linksProvidedFor = ref<string | null>(null);
const markHover = shallowRef<MarkHover | null>(null);
// What screen readers hear when Ctrl+Up or Ctrl+Down reaches a command.
const announcement = ref('');
let marks: TerminalMarks | undefined;
let markSeq = 0;
const { width: hostWidth, height: hostHeight } = useElementSize(host);
let fit: FitAddon | undefined;
// The size the pty last got, which the shell's own column count follows.
const sent = shallowRef<{ cols: number; rows: number } | undefined>(undefined);
const ptyResize = createPtyResize((size) => {
  sent.value = size;
  props.api.terminal.resize({ id: props.terminal.id, ...size });
});
let parsed = 0;
// xterm defers a paused renderer's resize (its screen is not visible) to idle time and meanwhile measures its viewport with
// the old height, taking the clamped scroll for the user scrolling up, after which it no longer follows the output.
let screenVisible = false;
let linkSeq = 0;
const stops: Array<() => void> = [];

// The settings' font size is px at the default font, so it follows the root font size like every rem size.
const fontSize = computed(() => remPx(props.settings.fontSize / 16));
const options = computed(() => liveOptions(props.settings, props.platform, getComputedStyle(document.documentElement).getPropertyValue('--d-mono').trim(), fontSize.value, (family) => isFontList(family, (property, value) => CSS.supports(property, value))));
const modifierDown = (event: MouseEvent | KeyboardEvent): boolean => (mac ? event.metaKey : event.ctrlKey);
// A font that fails to load still opens the terminal: xterm then measures whatever font the browser falls back to.
const loadFont = (font: string): Promise<unknown> => document.fonts.load(font).catch(() => []);

// The shell gets the size on screen before it reads the user's keys: readline redraws a prompt that wrapped at the old
// width on SIGWINCH, and arriving after the command's output, that redraw would erase it.
function send(data: string): void {
  ptyResize.flush();
  for (const chunk of inputChunks(data)) props.api.terminal.input({ id: props.terminal.id, data: chunk });
}

// Fits the xterm to its box and, once the size settles, tells the pty, so the shell's own column count (`tput cols`) matches what shows.
function refit(): void {
  const xterm = term.value;
  if (!xterm || !fit || !props.shown || !screenVisible || !fit.proposeDimensions()) return;
  fit.fit();
  ptyResize.request({ cols: Math.min(xterm.cols, MAX_TERMINAL_COLS), rows: Math.min(xterm.rows, MAX_TERMINAL_ROWS) });
}

function readEnd(xterm: Terminal): void {
  const buffer = xterm.buffer.active;
  atEnd.value = buffer.viewportY >= buffer.baseY;
}

function focus(): void {
  term.value?.focus();
}

// Every paste goes through main, which reads the clipboard only for a paste gesture it saw, may ask about several lines, and
// writes to the pty itself.
function paste(source: TerminalPaste['source']): void {
  const xterm = term.value;
  if (!xterm || exited.value) return;
  ptyResize.flush();
  props.api.terminal.paste({ id: props.terminal.id, bracketedPasteMode: xterm.modes.bracketedPasteMode, source });
}

// The copy event lands on xterm's own textarea, whose handler puts the selection on the clipboard.
function copy(): void {
  if (!term.value?.hasSelection()) return;
  focus();
  document.execCommand('copy');
}

// Text that is not the selection (a command, its output) goes through the same page copy, with this copy event's data.
function copyText(text: string): void {
  if (text === '') return;
  const write = (event: ClipboardEvent): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
    event.clipboardData?.setData('text/plain', text);
  };
  document.addEventListener('copy', write, true);
  try {
    document.execCommand('copy');
  } finally {
    document.removeEventListener('copy', write, true);
  }
}

function commandContext(command: XtermCommand | undefined): CommandMenuContext | null {
  if (!command || !marks) return null;
  return { hasCommandLine: command.commandLine !== '', hasOutput: (marks.outputText(command) ?? '').trim() !== '' };
}

function commandName(command: XtermCommand): string {
  return command.commandLine.split('\n')[0] || t('terminal.mark.unnamed');
}

function markLabel(command: XtermCommand): string {
  const status = commandStatus(command);
  if (status === 'failure') return t('terminal.mark.failure', { command: commandName(command), code: command.exitCode ?? '' });
  return t(status === 'running' ? 'terminal.mark.running' : 'terminal.mark.success', { command: commandName(command) });
}

// Main labels the attachment from its own record of the command and caps the text again.
function attach(source: 'selection' | 'command', text: string, commandId: number | null): void {
  const capped = capTerminalText(text);
  props.api.terminal.addToChat({ id: props.terminal.id, source, commandId, text: capped.text, omittedLines: capped.omittedLines });
}

function rerun(command: XtermCommand): void {
  const xterm = term.value;
  const line = command.commandLine;
  if (!xterm || exited.value || line === '') return;
  send(`${line.includes('\n') && xterm.modes.bracketedPasteMode ? `\x1b[200~${line}\x1b[201~` : line}\r`);
  // The rerun runs at the prompt, so the reader follows it there from wherever navigation left them.
  xterm.scrollToBottom();
  focus();
}

function runCommandAction(action: CommandMenuAction, command: XtermCommand): void {
  if (!marks) return;
  if (action === 'rerunCommand') rerun(command);
  else if (action === 'copyCommand') copyText(command.commandLine);
  else {
    const output = marks.outputText(command);
    if (output === null) return;
    if (action === 'copyOutput') copyText(output);
    else attach('command', output, command.id);
  }
}

async function openCommandMenu(command: XtermCommand, element: HTMLElement): Promise<void> {
  const context = commandContext(command);
  if (!context) return;
  hoveredMark = null;
  markHover.value = null;
  const rect = element.getBoundingClientRect();
  const answer = await props.api.requestOverlay({
    kind: 'menu',
    label: t('terminal.mark.menuLabel', { command: commandName(command) }),
    anchor: { x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: rect.width, height: rect.height },
    items: commandMenuItems(context, t),
  });
  const action = answer.kind === 'menu' ? terminalMenuAction(answer.itemId) : undefined;
  if (action === 'rerunCommand' || action === 'copyCommand' || action === 'copyOutput' || action === 'addOutputToChat') runCommandAction(action, command);
}

// The hovered mark, so its card follows the command when it finishes under the pointer.
let hoveredMark: { readonly id: number; readonly element: HTMLElement } | null = null;
function showMarkHover(command: XtermCommand, element: HTMLElement | null): void {
  hoveredMark = element ? { id: command.id, element } : null;
  if (!element || !host.value) {
    markHover.value = null;
    return;
  }
  const box = host.value.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  markHover.value = {
    key: String(++markSeq),
    commandLine: command.commandLine,
    status: commandStatus(command),
    exitCode: command.exitCode,
    startTime: command.startTime,
    endTime: command.endTime,
    top: rect.top - box.top,
    bottom: rect.bottom - box.top,
    right: rect.right - box.left,
  };
}

// Cleared first, so a second command with the same label is announced again.
function scrollToCommand(direction: 'previous' | 'next'): void {
  const command = marks?.scroll(direction);
  announcement.value = '';
  if (command) void nextTick(() => (announcement.value = markLabel(command)));
}

function addSelectionOrLastOutput(): void {
  const selection = term.value?.getSelection() ?? '';
  if (selection !== '') {
    attach('selection', selection, null);
    return;
  }
  const last = marks?.lastFinished();
  const output = last ? marks?.outputText(last) : null;
  if (last && output) attach('command', output, last.id);
}

// The palette's buffer commands, which main sends to the active terminal after giving it focus.
function runPaletteAction(action: TerminalAction): void {
  const last = marks?.lastFinished();
  if (action === 'resizePaneLeft' || action === 'resizePaneRight') resizePane(action === 'resizePaneLeft' ? 'left' : 'right');
  else if (action === 'scrollToPreviousCommand') scrollToCommand('previous');
  else if (action === 'scrollToNextCommand') scrollToCommand('next');
  else if (action === 'addToChat') addSelectionOrLastOutput();
  else if (last && marks) copyText(action === 'copyLastCommand' ? last.commandLine : marks.outputText(last) ?? '');
}

function resizePane(direction: 'left' | 'right'): void {
  const xterm = term.value;
  const screen = host.value?.querySelector<HTMLElement>('.xterm-screen');
  if (!xterm || !screen || xterm.cols === 0) return;
  emit('resizePane', direction, screen.getBoundingClientRect().width / xterm.cols);
}

/** The box of buffer cells, px within the terminal's box: each row's underline and the link's outer edges. */
function hoverBox(xterm: Terminal, range: IBufferRange, kind: LinkHover['kind']): LinkHover | null {
  const screen = host.value?.querySelector<HTMLElement>('.xterm-screen');
  if (!host.value || !screen) return null;
  const box = host.value.getBoundingClientRect();
  const rect = screen.getBoundingClientRect();
  const cellWidth = rect.width / xterm.cols;
  const cellHeight = rect.height / xterm.rows;
  const viewportY = xterm.buffer.active.viewportY;
  const segments: Array<{ left: number; top: number; width: number }> = [];
  for (let y = range.start.y; y <= range.end.y; y++) {
    const row = y - 1 - viewportY;
    if (row < 0 || row >= xterm.rows) continue;
    const from = y === range.start.y ? range.start.x : 1;
    const to = y === range.end.y ? range.end.x : xterm.cols;
    // The glyphs sit centred in the cell, so the underline runs just under the text's descenders, not at the cell's edge.
    const top = rect.top - box.top + row * cellHeight + cellHeight / 2 + fontSize.value * 0.55;
    segments.push({ left: Math.round(rect.left - box.left + (from - 1) * cellWidth), top: Math.round(top), width: Math.round((to - from + 1) * cellWidth) });
  }
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (!first || !last) return null;
  const startRow = Math.max(0, range.start.y - 1 - viewportY);
  const endRow = Math.min(xterm.rows - 1, range.end.y - 1 - viewportY);
  return {
    key: String(++linkSeq),
    segments,
    top: rect.top - box.top + startRow * cellHeight,
    bottom: rect.top - box.top + (endRow + 1) * cellHeight,
    left: first.left,
    kind,
  };
}

// While a link is hovered, the modifier key shows the pointer, as VS Code's links do; the underline shows throughout.
let hovered: ILink | null = null;
function syncModifier(event: MouseEvent | KeyboardEvent): void {
  if (hovered?.decorations) hovered.decorations.pointerCursor = modifierDown(event);
}

function onLinkHover(link: ILink, kind: LinkHover['kind'], event: MouseEvent): void {
  const xterm = term.value;
  if (!xterm) return;
  hovered = link;
  syncModifier(event);
  window.addEventListener('keydown', syncModifier, true);
  window.addEventListener('keyup', syncModifier, true);
  host.value?.addEventListener('mousemove', syncModifier);
  linkHover.value = hoverBox(xterm, link.range, kind);
}

function onLinkLeave(link: ILink): void {
  if (hovered !== link) return;
  hovered = null;
  window.removeEventListener('keydown', syncModifier, true);
  window.removeEventListener('keyup', syncModifier, true);
  host.value?.removeEventListener('mousemove', syncModifier);
  linkHover.value = null;
}

// OSC 8 hyperlinks, which xterm offers for http and https only and underlines itself: they open like a web link, as VS Code's
// terminalLinkManager sets linkHandler; without one xterm asks with window.confirm.
const hyperlinks: ILinkHandler = {
  activate: (event, uri) => {
    if (!modifierDown(event)) return;
    linkHover.value = null;
    window.open(uri);
  },
  hover: (_event, _uri, range) => {
    const xterm = term.value;
    const box = xterm ? hoverBox(xterm, range, 'web') : null;
    linkHover.value = box && { ...box, segments: [] };
  },
  leave: () => {
    linkHover.value = null;
  },
};

/**
 * The links in one wrapped line: web links at once, file and folder paths only once main confirms them inside the project.
 * Each link opens on Ctrl+click (Cmd+click).
 */
async function provideLinks(bufferLine: number, callback: (links: ILink[] | undefined) => void): Promise<void> {
  const xterm = term.value;
  if (!xterm) {
    callback(undefined);
    return;
  }
  const buffer = xterm.buffer.active;
  const line = readWrappedLine(buffer, bufferLine - 1, xterm.cols, buffer.getNullCell());
  const candidates = lineCandidates(line.text, linkOs);
  const paths = requestPaths(candidates);
  const links: ILink[] = [];
  const add = (start: number, end: number, text: string, kind: LinkHover['kind'], open: () => void): void => {
    const range = rangeOf(line, start, end);
    if (!range) return;
    const link: ILink = {
      range,
      text,
      decorations: { pointerCursor: false, underline: false },
      activate: (event) => {
        if (!modifierDown(event)) return;
        onLinkLeave(link);
        open();
      },
      hover: (event) => onLinkHover(link, kind, event),
      leave: () => onLinkLeave(link),
    };
    links.push(link);
  };
  try {
    for (const web of candidates.web) add(web.start, web.end, web.url, 'web', () => window.open(web.url));
    // Main refuses a terminal that is gone (killed while hovered); its paths are then no links.
    const kinds = paths.length > 0 ? await props.api.terminal.resolveLinks({ id: props.terminal.id, paths }).catch(() => []) : [];
    for (const link of confirmedLinks(candidates, paths, kinds)) {
      const request = { id: props.terminal.id, path: link.path, line: link.line, column: link.column };
      add(link.start, link.end, line.text.slice(link.start, link.end), link.kind, () => props.api.terminal.openLink(request));
    }
  } finally {
    callback(links.length > 0 ? links : undefined);
    linksProvidedFor.value = line.text;
  }
}

async function openMenu(anchor: OverlayRect): Promise<void> {
  const xterm = term.value;
  if (!xterm) return;
  const last = marks?.lastFinished();
  const navigated = marks?.current();
  const answer = await props.api.requestOverlay({
    kind: 'menu',
    label: t('terminal.menu.label', { title: props.terminal.title }),
    anchor: { x: Math.max(0, anchor.x), y: Math.max(0, anchor.y), width: anchor.width, height: anchor.height },
    items: terminalMenuItems({ target: 'terminal', hasSelection: xterm.hasSelection(), platform: props.platform, group: { panes: groupPanes(store.state.value, props.terminal.id), shortcut: props.splitShortcut }, lastCommand: commandContext(last), navigated: commandContext(navigated) }, t),
  });
  const action = answer.kind === 'menu' ? terminalMenuAction(answer.itemId) : undefined;
  if (action === undefined) return;
  if (action === 'rerunCommand' || action === 'copyCommand' || action === 'copyOutput' || action === 'addOutputToChat') {
    if (navigated) runCommandAction(action, navigated);
  } else if (action === 'copyLastCommand' || action === 'copyLastCommandOutput') runPaletteAction(action);
  else if (action === 'addToChat') addSelectionOrLastOutput();
  else if (action === 'copy') copy();
  else if (action === 'paste') {
    focus();
    paste('clipboard');
  } else if (action === 'selectAll') {
    xterm.selectAll();
    focus();
  } else if (action === 'clear') {
    marks?.clear();
    focus();
  } else runTerminalAction(action, props.terminal.id, { api: props.api.terminal, store, returnTo: 'terminal' });
}

// After xterm's own handler, which on macOS selects the clicked word first (rightClickSelectsWord). The context menu key
// arrives here too, as the browser's own contextmenu event at the focused textarea, which xterm keeps at the cursor.
function onContextMenu(event: MouseEvent): void {
  event.preventDefault();
  void openMenu({ x: event.clientX, y: event.clientY, width: 0, height: 0 });
}

function onKey(event: KeyboardEvent): boolean {
  const xterm = term.value;
  // An open Find takes Escape and Shift+Escape from the program (VS Code's hideFind).
  if (findOpen.value && event.code === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey) {
    if (event.type === 'keydown') {
      event.preventDefault();
      closeFind();
    }
    return false;
  }
  const action = terminalKeyAction(event, props.platform, xterm?.hasSelection() === true, passChords.value);
  if (action === undefined) return true;
  if (isShiftF10(event)) {
    if (event.type === 'keydown') {
      event.preventDefault();
      const cursor = xterm?.textarea?.getBoundingClientRect();
      if (cursor) void openMenu({ x: cursor.left, y: cursor.top, width: cursor.width, height: cursor.height });
    }
    return false;
  }
  // The context menu key stays out of the pty and keeps its default, which is the contextmenu event onContextMenu takes.
  if (event.type !== 'keydown' || action === 'pass' || action === 'menu') return false;
  event.preventDefault();
  if (action === 'find') openFind();
  else if (action === 'copy') copy();
  else if (action === 'copyAndClear') {
    copy();
    xterm?.clearSelection();
  } else if (action === 'paste') paste('clipboard');
  else if (action === 'previousCommand') scrollToCommand('previous');
  else if (action === 'nextCommand') scrollToCommand('next');
  return false;
}

function openFind(): void {
  if (findOpen.value) find.value?.focus();
  else findOpen.value = true;
}

function closeFind(): void {
  findOpen.value = false;
  focus();
}

function scrollToEnd(): void {
  term.value?.scrollToBottom();
  focus();
}

function restart(): void {
  props.api.terminal.restart(props.terminal.id);
  focus();
}

// xterm's own paste handlers on its textarea and element never run: the clipboard reaches the pty only through main.
function blockNativePaste(element: HTMLElement): () => void {
  const block = (event: Event): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  element.addEventListener('paste', block, true);
  if (props.platform !== 'linux') return () => element.removeEventListener('paste', block, true);
  // Linux's middle click pastes the primary selection: Blink's own paste on the button's release is cancelled, and the
  // click asks main for the selection instead.
  const middle = (event: MouseEvent): void => {
    if (event.button === 1) event.preventDefault();
  };
  // A program that tracks the mouse (tmux, vim, htop) gets the press from xterm instead; Shift forces the paste, as in xterm.
  const middleClick = (event: MouseEvent): void => {
    if (event.button !== 1) return;
    event.preventDefault();
    if (term.value?.modes.mouseTrackingMode !== 'none' && !event.shiftKey) return;
    focus();
    paste('selection');
  };
  element.addEventListener('mousedown', middle, true);
  element.addEventListener('mouseup', middle, true);
  element.addEventListener('auxclick', middleClick, true);
  return () => {
    element.removeEventListener('paste', block, true);
    element.removeEventListener('mousedown', middle, true);
    element.removeEventListener('mouseup', middle, true);
    element.removeEventListener('auxclick', middleClick, true);
  };
}

async function open(): Promise<void> {
  // xterm measures its cell once per font, so the webfont loads first.
  const initial = options.value;
  await loadFont(`${initial.fontSize}px ${initial.fontFamily}`);
  if (!host.value) return;
  const xterm = new Terminal({
    allowProposedApi: true,
    ...initial,
    cursorInactiveStyle: 'outline',
    disableStdin: exited.value,
    theme: terminalTheme(getComputedStyle(document.documentElement)),
    // Program colours are lifted to AA against the theme's background (G26); not a setting.
    minimumContrastRatio: 4.5,
    rightClickSelectsWord: mac,
    linkHandler: hyperlinks,
    screenReaderMode: props.screenReader,
    // xterm turns reflow off and its wrapped-line heuristics on below conpty's build 21376.
    ...(props.platform === 'win32' ? { windowsPty: { backend: 'conpty', buildNumber: props.windowsBuild } } : {}),
  });
  fit = new FitAddon();
  const searchAddon = new SearchAddon();
  xterm.loadAddon(fit);
  xterm.loadAddon(searchAddon);
  xterm.loadAddon(new Unicode11Addon());
  xterm.unicode.activeVersion = '11';
  const linkProvider = xterm.registerLinkProvider({ provideLinks: (line, callback) => void provideLinks(line, callback) });
  xterm.attachCustomKeyEventHandler(onKey);
  const input = xterm.onData(send);
  const binary = xterm.onBinary(send);
  const scroll = xterm.onScroll(() => readEnd(xterm));
  const resized = xterm.onResize(() => readEnd(xterm));
  const written = xterm.onWriteParsed(() => readEnd(xterm));
  stops.push(() => [linkProvider, input, binary, scroll, resized, written].forEach((subscription) => subscription.dispose()));
  stops.push(blockNativePaste(host.value));
  xterm.open(host.value);
  // Observed after xterm's own observer, which reports first in the same task, so xterm's renderer runs when this refits.
  const visibility = new IntersectionObserver((entries) => {
    screenVisible = entries[entries.length - 1]!.isIntersecting;
    refit();
  });
  visibility.observe(xterm.element!.querySelector('.xterm-screen')!);
  stops.push(() => visibility.disconnect());
  term.value = xterm;
  search.value = searchAddon;
  const commandMarks = createTerminalMarks(xterm, {
    integrated: () => props.terminal.integrated,
    decorationsEnabled: () => props.settings.decorationsEnabled,
    label: markLabel,
    activate: (command, element) => void openCommandMenu(command, element),
    hover: showMarkHover,
  });
  marks = commandMarks;
  stops.push(() => commandMarks.dispose());
  refit();
  stops.push(store.attach(props.terminal.id, ({ data, events }) => {
    // Each event applies once xterm has parsed the output before it, so its marker lands on the cursor's row then.
    // Main sends offsets in 0..data.length, non-decreasing.
    let at = 0;
    for (const { offset, event } of events ?? []) {
      xterm.write(data.slice(at, offset), () => {
        commandMarks.handle(event);
        if (event.kind === 'commandFinished' && hoveredMark && hoveredMark.id === event.commandId) {
          const command = commandMarks.byId(event.commandId);
          if (command) showMarkHover(command, hoveredMark.element);
        }
      });
      at = offset;
    }
    // Acknowledged once parsed, so the host's flow control paces the pty to what xterm keeps up with.
    xterm.write(data.slice(at), () => {
      parsed += data.length;
      if (parsed < TERMINAL_ACK_CHARS) return;
      props.api.terminal.ack({ id: props.terminal.id, chars: parsed });
      parsed = 0;
    });
  }));
  stops.push(watchHostTheme(() => {
    xterm.options.theme = terminalTheme(getComputedStyle(document.documentElement));
  }));
  takeFocusRequest();
}

// Main's focus after a user action, or a click in the list, reaches the xterm once it is open and shown.
function takeFocusRequest(): void {
  const request = store.focusRequest.value;
  if (!request || request.id !== props.terminal.id || !term.value || !props.shown) return;
  store.focusRequest.value = null;
  void nextTick(focus);
}
watch(() => [store.focusRequest.value, props.shown], takeFocusRequest);

// Main asks for the Edit menu's Paste only while this xterm's input has focus.
watch(store.pasteRequest, (request) => {
  if (request?.id === props.terminal.id) paste('clipboard');
});

// The palette's buffer command for this terminal.
watch(store.actionRequest, (request) => {
  if (request?.id === props.terminal.id) runPaletteAction(request.action);
});

watch(() => props.shown, (shown) => {
  if (shown) void nextTick(refit);
});

// Hiding the marks also narrows the gutter they sit in, so the columns change.
watch(() => props.settings.decorationsEnabled, (enabled) => {
  marks?.setDecorationsEnabled(enabled);
  void nextTick(refit);
});
useResizeObserver(host, refit);

watch(() => props.screenReader, (enabled) => {
  if (term.value) term.value.options.screenReaderMode = enabled;
});

// Settings › Terminal applies to open terminals at once; a new font family loads before xterm measures it, as at open.
watch(options, async (next, before) => {
  if (next.fontFamily !== before.fontFamily) await loadFont(`${next.fontSize}px ${next.fontFamily}`);
  const xterm = term.value;
  if (!xterm || options.value !== next) return;
  Object.assign(xterm.options, next);
  refit();
});

// A restart reuses the row with a new process, which starts on a clean screen.
watch(exited, (now, before) => {
  const xterm = term.value;
  if (!xterm) return;
  xterm.options.disableStdin = now;
  if (before && !now) {
    xterm.reset();
    marks?.reset();
    parsed = 0;
    sent.value = undefined;
    ptyResize.reset();
    refit();
  }
});

onMounted(() => void open());
onBeforeUnmount(() => {
  if (hovered) onLinkLeave(hovered);
  for (const stop of stops.splice(0)) stop();
  ptyResize.dispose();
  marks = undefined;
  term.value?.dispose();
});

defineExpose({ focus, openFind });
</script>

<template>
  <div
    :id="`terminal-panel-${terminal.id}`"
    data-testid="terminal-view"
    :data-terminal-id="terminal.id"
    :data-status="terminal.status"
    :data-cols="sent?.cols"
    :data-rows="sent?.rows"
    :data-links-provided-for="linksProvidedFor ?? undefined"
    role="tabpanel"
    :aria-labelledby="`terminal-row-${terminal.id} terminal-tab-${terminal.id}`"
    :aria-label="terminal.title"
    class="terminal-view absolute inset-0 flex flex-col bg-(--d-bg)"
  >
    <div class="relative min-h-0 flex-1">
      <div
        ref="host"
        class="terminal-host absolute inset-0"
        :class="{ 'terminal-host-marks': settings.decorationsEnabled }"
        @contextmenu="onContextMenu"
      />
      <TerminalMarkHover
        :hover="markHover"
        :width="hostWidth"
        :height="hostHeight"
      />
      <p
        class="sr-only"
        aria-live="polite"
        data-testid="terminal-announcement"
      >
        {{ announcement }}
      </p>
      <TerminalLinkHover
        :hover="linkHover"
        :mac="mac"
        :width="hostWidth"
        :height="hostHeight"
      />
      <Transition name="t-pop">
        <TerminalFind
          v-if="findOpen && search"
          ref="find"
          :search="search"
          @close="closeFind"
        />
      </Transition>
      <Transition name="t-pop">
        <!-- Shows while the reader is above the end; the xterm stays where they left it until this is pressed. -->
        <Button
          v-if="!atEnd"
          variant="outline"
          size="icon"
          data-testid="terminal-scroll-to-end"
          class="d-press absolute right-5 bottom-3 size-7.5 rounded-full border-(--d-border2) bg-(--d-card) text-(--d-muted) shadow-(--d-shadow) hover:bg-(--d-card) hover:text-(--d-text) [&_svg]:size-3.5"
          :title="t('terminal.scrollToEnd')"
          :aria-label="t('terminal.scrollToEnd')"
          @click="scrollToEnd"
        >
          <ArrowDown aria-hidden="true" />
        </Button>
      </Transition>
    </div>
    <Transition name="t-up">
      <div
        v-if="exited"
        role="status"
        data-testid="terminal-exited"
        class="flex shrink-0 items-center gap-2.5 border-t border-(--d-border) bg-(--d-panel) py-1.5 pr-2 pl-3.5"
      >
        <span
          class="flex size-5.5 shrink-0 items-center justify-center rounded-full"
          :class="terminal.exitCode === 0 ? 'bg-[color-mix(in_srgb,var(--d-success)_14%,transparent)] text-(--d-success-text)' : 'bg-[color-mix(in_srgb,var(--d-danger)_14%,transparent)] text-(--d-danger-text)'"
        >
          <CircleCheck
            v-if="terminal.exitCode === 0"
            aria-hidden="true"
            class="size-3.5"
          />
          <CircleAlert
            v-else
            aria-hidden="true"
            class="size-3.5"
          />
        </span>
        <p class="min-w-0 flex-1 truncate text-12.5 text-(--d-text)">
          {{ terminal.exitCode === null ? t('terminal.hostStopped') : t('terminal.exited', { code: terminal.exitCode }) }}
        </p>
        <Button
          size="sm"
          variant="outline"
          data-testid="terminal-restart"
          class="d-press h-6.5 gap-1.5 rounded-7 border-(--d-border2) bg-(--d-card) px-2.5 text-xs hover:border-(--d-accent) hover:bg-(--d-card) [&_svg]:size-3.25"
          @click="restart"
        >
          <RotateCcw aria-hidden="true" />{{ t('terminal.restart') }}
        </Button>
      </div>
    </Transition>
  </div>
</template>
