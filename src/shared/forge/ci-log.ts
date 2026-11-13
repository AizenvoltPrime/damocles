// CI job logs as GitHub and GitLab serve them, read with linear-time patterns only: the text is the job's own output.

/** The server a log comes from: each writes its own per-line stamps. */
export type CiLogKind = 'github' | 'gitlab';

/** One row as plain text, with the name of the section holding it (a GitLab section's key, a GitHub group's title). */
export interface CiLogLine {
  readonly text: string;
  readonly section?: string;
}

/**
 * A parser that hands each row to onLine as plain text with its section's name, keeping no row itself. A GitHub workflow
 * command keeps its `##[error]` form, so the reader still sees it.
 */
export function ciLogLines(kind: CiLogKind, onLine: (line: CiLogLine) => void): CiLogParser {
  const parser: CiLogParser = new CiLogParser(kind, (row) => {
    const text = row.level === undefined ? rowText(row) : `##[${row.level}]${rowText(row)}`;
    const section = row.section === undefined ? undefined : parser.sections[row.section]!.name;
    onLine(section === undefined ? { text } : { text, section });
  });
  return parser;
}

// CiLogParser below is ported from GitLab Workflow for VS Code (https://gitlab.com/gitlab-org/gitlab-vscode-extension),
// src/desktop/ci/ansi.ts, itself adapted from ANSI Colors (https://github.com/iliazeus/vscode-ansi), Copyright (c) 2020 Ilia
// Pozdnyakov, with the section and timestamp handling of its ansi_decoration_provider.ts and job_log_folding_provider.ts,
// Copyright (c) 2020-present GitLab Inc.; both MIT licensed (THIRD-PARTY-NOTICES.md). It scans each line once, forward only.

export type CiColor = { readonly palette: number } | { readonly rgb: readonly [number, number, number] };

export interface CiLogSpan {
  readonly text: string;
  readonly fg?: CiColor;
  readonly bg?: CiColor;
  readonly bold?: true;
  readonly dim?: true;
  readonly italic?: true;
  readonly underline?: true;
  readonly inverse?: true;
}

/** GitHub's `##[error]`, `##[warning]` and `##[notice]` workflow commands. */
export type CiLogLevel = 'error' | 'warning' | 'notice';

export interface CiLogRow {
  /** 1-based number among the rows shown. */
  readonly line: number;
  readonly spans: readonly CiLogSpan[];
  /** ISO 8601: GitHub's or GitLab's per-line stamp, or a GitLab section header's start. */
  readonly timestamp?: string;
  /** The innermost section holding the row; a header row's is its own section. */
  readonly section?: number;
  /** The row is this section's header. */
  readonly header?: number;
  /** The workflow command the line started with, removed from spans. */
  readonly level?: CiLogLevel;
}

/** A row's text, its spans joined: what Find searches. Joined on each call, so a kept row holds its text once. */
export const rowText = (row: Pick<CiLogRow, 'spans'>): string => (row.spans.length === 1 ? row.spans[0]!.text : row.spans.map((span) => span.text).join(''));

export interface CiLogSection {
  readonly id: number;
  readonly title: string;
  /** GitLab's section key; a GitHub group's title. */
  readonly name: string;
  readonly parent?: number;
  readonly depth: number;
  /** Index into rows. */
  readonly headerRow: number;
  /** Inclusive index into rows; undefined while the section is open. */
  readonly endRow?: number;
  /** The initial state: GitLab's [collapsed=true]. */
  readonly collapsed: boolean;
  readonly durationSeconds?: number;
}

/** The parser's bounds: a log is server output and may be hostile. */
export const CI_LOG_LIMITS: { readonly rawLineChars: number; readonly rowChars: number; readonly spansPerRow: number; readonly sectionDepth: number; readonly sections: number; readonly rows: number; readonly titleChars: number; readonly sgrChars: number } = {
  /** Raw characters kept of one line, escape sequences included; the rest of the line is dropped. */
  rawLineChars: 256 * 1024,
  /** Visible characters of one row. */
  rowChars: 16 * 1024,
  /** Styled spans of one row; text past them takes the last span's style. */
  spansPerRow: 256,
  sectionDepth: 64,
  sections: 50_000,
  /** Rows a parser without a sink keeps; a longer log stops adding rows and sets `capped`. */
  rows: 1_000_000,
  titleChars: 500,
  /** Parameter bytes of an SGR sequence; a longer one is consumed and ignored. */
  sgrChars: 64,
};

interface Style {
  fg?: CiColor;
  bg?: CiColor;
  bold?: true;
  dim?: true;
  italic?: true;
  underline?: true;
  inverse?: true;
}

interface MutableSpan extends Style {
  text: string;
}

interface MutableSection {
  readonly id: number;
  readonly title: string;
  readonly parent?: number;
  readonly depth: number;
  readonly headerRow: number;
  endRow?: number;
  readonly collapsed: boolean;
  durationSeconds?: number;
  // GitLab: section_start's epoch seconds; GitHub: the group line's stamp in epoch ms
  readonly startedAt?: number;
  readonly kind: 'gitlab' | 'github';
  readonly name: string;
}

type Marker =
  | { readonly start: true; readonly name: string; readonly at: number; readonly collapsed: boolean }
  | { readonly start: false; readonly name: string; readonly at: number };

const ISO_STAMP = String.raw`\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z`;
// GitLab runner timestamps: "<ISO> <2 hex stream><O|E><flag>", where flag '+' continues the previous line
const GITLAB_STAMP = new RegExp(`^(${ISO_STAMP}) [0-9A-Fa-f]{2}[OE]([+ ])`);
const GITHUB_STAMP = new RegExp(`^(${ISO_STAMP}) `);
const STAMP_SCAN = 48;
// eslint-disable-next-line no-control-regex
const GITLAB_MARKER = /^section_(start|end):(\d{1,12}):([A-Za-z0-9_.-]{1,200})(?:\[([^\]\r\u001b]{0,200})\])?/;
const MARKER_SCAN = 450;
const GROUP = '##[group]';
const END_GROUP = '##[endgroup]';
const LEVELS: readonly CiLogLevel[] = ['error', 'warning', 'notice'];

/** A row's text with GitHub's group or workflow-command prefix taken off spans in place, and which prefix it was. */
function commandOf(kind: CiLogKind, spans: MutableSpan[], plain: string): { readonly plain: string; readonly group?: 'start' | 'end'; readonly level?: CiLogLevel } {
  if (!plain.startsWith('##[')) return { plain };
  if (plain.startsWith(END_GROUP)) return { plain, group: 'end' };
  if (plain.startsWith(GROUP)) {
    dropPrefix(spans, GROUP.length);
    return { plain: plain.slice(GROUP.length), group: 'start' };
  }
  const level = kind === 'github' ? LEVELS.find((each) => plain.startsWith(`##[${each}]`)) : undefined;
  if (level === undefined) return { plain };
  const prefix = level.length + 4;
  dropPrefix(spans, prefix);
  return { plain: plain.slice(prefix), level };
}

function color256(index: number): CiColor {
  if (index < 16) return { palette: index };
  if (index >= 232) {
    const level = Math.floor((255 * (index - 232)) / 23);
    return { rgb: [level, level, level] };
  }
  const cube = index - 16;
  const step = (value: number): number => Math.floor((255 * value) / 5);
  return { rgb: [step(Math.floor(cube / 36)), step(Math.floor(cube / 6) % 6), step(cube % 6)] };
}

const isByte = (value: number | undefined): value is number => value !== undefined && Number.isInteger(value) && value >= 0 && value <= 255;

/** Applies SGR parameters to style: ansi.ts #applyCodes, for the attributes a row shows. */
function applySgr(style: Style, params: readonly number[]): void {
  for (let at = 0; at < params.length; at++) {
    const code = params[at]!;
    if (code === 0) {
      for (const key of Object.keys(style) as (keyof Style)[]) delete style[key];
    } else if (code === 1) {
      style.bold = true;
      delete style.dim;
    } else if (code === 2) {
      style.dim = true;
      delete style.bold;
    } else if (code === 3) {
      style.italic = true;
    } else if (code === 4) {
      style.underline = true;
    } else if (code === 7) {
      style.inverse = true;
    } else if (code === 22) {
      delete style.bold;
      delete style.dim;
    } else if (code === 23) {
      delete style.italic;
    } else if (code === 24) {
      delete style.underline;
    } else if (code === 27) {
      delete style.inverse;
    } else if (code >= 30 && code <= 37) {
      style.fg = { palette: code - 30 };
    } else if (code >= 40 && code <= 47) {
      style.bg = { palette: code - 40 };
    } else if (code >= 90 && code <= 97) {
      style.fg = { palette: code - 90 + 8 };
    } else if (code >= 100 && code <= 107) {
      style.bg = { palette: code - 100 + 8 };
    } else if (code === 39) {
      delete style.fg;
    } else if (code === 49) {
      delete style.bg;
    } else if (code === 38 || code === 48) {
      const mode = params[at + 1];
      let color: CiColor | undefined;
      if (mode === 5) {
        const index = params[at + 2];
        if (isByte(index)) color = color256(index);
        at += 2;
      } else if (mode === 2) {
        const [r, g, b] = [params[at + 2], params[at + 3], params[at + 4]];
        if (isByte(r) && isByte(g) && isByte(b)) color = { rgb: [r, g, b] };
        at += 4;
      }
      if (color !== undefined && code === 38) style.fg = color;
      else if (color !== undefined) style.bg = color;
    }
  }
}

/**
 * SGR parameters as applySgr reads them. A colon group is one ISO 8613-6 colour ("38:2::r:g:b", "38:2:r:g:b", "38:5:n"),
 * rewritten into the semicolon form; empty parameters read as 0.
 */
function sgrParams(params: string): number[] {
  if (params === '') return [0];
  const out: number[] = [];
  for (const group of params.split(';')) {
    const parts = group.split(':').map((part) => (part === '' ? 0 : Number(part)));
    const code = parts[0]!;
    // a sub-parameter of anything but a colour (such as 4:3, curly underline) keeps only its main code
    if (parts.length === 1 || (code !== 38 && code !== 48)) out.push(code);
    // with a colour space id, "38:2:<id>:r:g:b" has six parts
    else if (parts[1] === 2 && parts.length >= 6) out.push(code, 2, parts[3]!, parts[4]!, parts[5]!);
    else out.push(...parts);
  }
  return out;
}

function sameColor(x: CiColor | undefined, y: CiColor | undefined): boolean {
  if (x === undefined || y === undefined) return x === y;
  if ('palette' in x) return 'palette' in y && x.palette === y.palette;
  return 'rgb' in y && x.rgb[0] === y.rgb[0] && x.rgb[1] === y.rgb[1] && x.rgb[2] === y.rgb[2];
}

function sameStyle(a: Style, b: Style): boolean {
  return sameColor(a.fg, b.fg) && sameColor(a.bg, b.bg) && a.bold === b.bold && a.dim === b.dim && a.italic === b.italic && a.underline === b.underline && a.inverse === b.inverse;
}

/** Removes the first count visible characters from spans, in place. */
function dropPrefix(spans: MutableSpan[], count: number): void {
  let left = count;
  while (left > 0 && spans.length > 0) {
    const first = spans[0]!;
    if (first.text.length <= left) {
      left -= first.text.length;
      spans.shift();
    } else {
      first.text = first.text.slice(left);
      left = 0;
    }
  }
}

/** A GitLab `+` continuation appended to its line, within CI_LOG_LIMITS.rawLineChars. */
function joined(line: string, more: string): string {
  const room = CI_LOG_LIMITS.rawLineChars - line.length;
  return room > 0 ? line + more.slice(0, room) : line;
}

/** The index after the escape sequence at start: an SGR sequence updates style, every other one shows nothing. */
function skipEscape(text: string, start: number, style: Style): number {
  const n = text.length;
  const kind = text.charCodeAt(start + 1);
  if (Number.isNaN(kind)) return start + 1;
  if (kind === 0x5b) {
    let j = start + 2;
    while (j < n && text.charCodeAt(j) >= 0x30 && text.charCodeAt(j) <= 0x3f) j++;
    const paramsEnd = j;
    while (j < n && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) j++;
    const final = text.charCodeAt(j);
    // an unterminated sequence ends where its bytes stop, and what follows is text
    if (Number.isNaN(final) || final < 0x40 || final > 0x7e) return j;
    if (final === 0x6d && paramsEnd === j && paramsEnd - (start + 2) <= CI_LOG_LIMITS.sgrChars) {
      const params = text.slice(start + 2, paramsEnd);
      if (/^[0-9;:]*$/.test(params)) applySgr(style, sgrParams(params));
    }
    return j + 1;
  }
  if (kind === 0x5d) {
    // OSC: up to BEL or ESC \, else to the end of the line
    for (let j = start + 2; j < n; j++) {
      const c = text.charCodeAt(j);
      if (c === 0x07) return j + 1;
      if (c === 0x1b) return text.charCodeAt(j + 1) === 0x5c ? j + 2 : j;
    }
    return n;
  }
  // nF (ESC ( B and the like): intermediates, then one final byte
  let j = start + 1;
  while (j < n && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) j++;
  const final = text.charCodeAt(j);
  return !Number.isNaN(final) && final >= 0x30 && final <= 0x7e ? j + 1 : j;
}

/**
 * A job log as rows of styled spans with GitLab sections and GitHub groups, fed in chunks as it arrives. A chunk may split a
 * line or an escape sequence anywhere: lines are parsed whole, once each, so the work is linear in the input. Rows only grow;
 * a section's endRow and durationSeconds are set when it closes, and end() closes every section still open. Given a sink,
 * the parser hands each row to it and keeps none, so the sink alone decides what a long log costs.
 */
export class CiLogParser {
  /** Every row, when the parser has no sink. */
  readonly rows: CiLogRow[] = [];
  readonly sections: readonly CiLogSection[];
  /** The log had more than CI_LOG_LIMITS.rows rows; the later ones are not kept. */
  capped = false;

  private readonly mutableSections: MutableSection[] = [];
  private readonly open: number[] = [];
  private readonly style: Style = {};
  private rowCount = 0;
  private raw: string[] = [];
  private rawLength = 0;
  private rawPending = false;
  // a GitLab-stamped line, held until the next line shows whether it continues it
  private held: { readonly stamp: string; body: string } | undefined;
  private ended = false;
  private readonly kind: CiLogKind;
  private readonly sink: ((row: CiLogRow) => void) | undefined;

  constructor(kind: CiLogKind, sink?: (row: CiLogRow) => void) {
    this.kind = kind;
    this.sink = sink;
    this.sections = this.mutableSections;
  }

  /** Linear in chunk's length; a partial last line is held until its newline or end(). */
  push(chunk: string): void {
    if (this.ended) throw new Error('CiLogParser.push after end');
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf('\n', start);
      const end = newline < 0 ? chunk.length : newline;
      this.take(chunk, start, end);
      if (newline < 0) return;
      this.completeLine();
      start = newline + 1;
    }
  }

  end(): void {
    if (this.ended) return;
    if (this.rawPending) this.completeLine();
    this.flushHeld();
    while (this.open.length > 0) this.close(this.open.length - 1, undefined);
    this.ended = true;
  }

  /**
   * The rows end() would add now, without adding them: a GitLab-stamped line waiting to learn whether the next continues it,
   * and a partial last line waiting for its newline. They open and close no section and show no fold.
   */
  peekHeld(): CiLogRow[] {
    if (this.ended || this.full()) return [];
    const lines: { body: string; readonly stamp: string | undefined }[] = this.held ? [{ body: this.held.body, stamp: this.held.stamp }] : [];
    if (this.rawPending) {
      const next = this.stamped(this.raw.join(''));
      const last = lines.at(-1);
      if (next.continues && last) last.body = joined(last.body, next.body);
      else lines.push({ body: next.body, stamp: next.stamp });
    }
    const style: Style = { ...this.style };
    const rows: CiLogRow[] = [];
    for (const { body, stamp } of lines) {
      const { spans, plainLength, markers } = this.scan(body, style);
      const command = commandOf(this.kind, spans, spans.map((span) => span.text).join(''));
      if (command.group === 'end' || (markers.length > 0 && plainLength === 0)) continue;
      const section = this.open.at(-1);
      rows.push({
        line: this.rowCount + rows.length + 1,
        spans,
        ...(stamp !== undefined ? { timestamp: stamp } : {}),
        ...(section !== undefined ? { section } : {}),
        ...(command.level !== undefined ? { level: command.level } : {}),
      });
    }
    return rows;
  }

  private full(): boolean {
    return this.sink === undefined && this.rowCount >= CI_LOG_LIMITS.rows;
  }

  private take(chunk: string, start: number, end: number): void {
    if (end > start) this.rawPending = true;
    const stop = Math.min(end, start + Math.max(0, CI_LOG_LIMITS.rawLineChars - this.rawLength));
    if (stop <= start) return;
    this.raw.push(chunk.slice(start, stop));
    this.rawLength += stop - start;
  }

  private completeLine(): void {
    const line = this.raw.length === 0 ? '' : this.raw.join('');
    if (this.raw.length > 0) this.raw = [];
    this.rawLength = 0;
    this.rawPending = false;
    this.line(line);
  }

  /** A whole raw line's body and stamp: GitLab's runner stamps only on a GitLab log, GitHub's only on a GitHub one. */
  private stamped(raw: string): { readonly body: string; readonly stamp: string | undefined; readonly gitlab: boolean; readonly continues: boolean } {
    const head = raw.slice(0, STAMP_SCAN);
    if (this.kind === 'gitlab') {
      const gitlab = GITLAB_STAMP.exec(head);
      if (gitlab) return { body: raw.slice(gitlab[0].length), stamp: gitlab[1]!, gitlab: true, continues: gitlab[2] === '+' };
    } else {
      const github = GITHUB_STAMP.exec(head);
      if (github) return { body: raw.slice(github[0].length), stamp: github[1]!, gitlab: false, continues: false };
    }
    return { body: raw, stamp: undefined, gitlab: false, continues: false };
  }

  private line(raw: string): void {
    const { body, stamp, gitlab, continues } = this.stamped(raw);
    if (continues && this.held) {
      this.held.body = joined(this.held.body, body);
      return;
    }
    this.flushHeld();
    if (gitlab) this.held = { stamp: stamp!, body };
    else this.parseLine(body, stamp);
  }

  private flushHeld(): void {
    const held = this.held;
    if (!held) return;
    this.held = undefined;
    this.parseLine(held.body, held.stamp);
  }

  private parseLine(text: string, stamp: string | undefined): void {
    const { spans, plainLength, markers } = this.scan(text, this.style);
    this.emit(spans, plainLength, markers, stamp);
  }

  /** One line without its stamp, in one forward scan: escape sequences update style, \r overwrites, section markers. */
  private scan(text: string, style: Style): { readonly spans: MutableSpan[]; readonly plainLength: number; readonly markers: Marker[] } {
    const spans: MutableSpan[] = [];
    let plainLength = 0;
    // a \r was seen: the next visible text starts the row again, as a terminal overwrites it
    let overwrite = false;
    let segmentStart = true;
    const markers: Marker[] = [];
    const append = (value: string): void => {
      if (overwrite) {
        spans.length = 0;
        plainLength = 0;
        overwrite = false;
      }
      const room = CI_LOG_LIMITS.rowChars - plainLength;
      if (room <= 0) return;
      const piece = value.length > room ? value.slice(0, room) : value;
      plainLength += piece.length;
      const last = spans.at(-1);
      if (last && (sameStyle(last, style) || spans.length >= CI_LOG_LIMITS.spansPerRow)) last.text += piece;
      else spans.push({ ...style, text: piece });
    };
    const n = text.length;
    let i = 0;
    while (i < n) {
      const code = text.charCodeAt(i);
      if (code === 0x1b) {
        i = skipEscape(text, i, style);
        continue;
      }
      if (code === 0x0d) {
        overwrite = true;
        segmentStart = true;
        i++;
        continue;
      }
      if (segmentStart && code === 0x73 && text.startsWith('section_', i)) {
        const marker = GITLAB_MARKER.exec(text.slice(i, i + MARKER_SCAN));
        if (marker) {
          const at = Number(marker[2]);
          const collapsed = (marker[4] ?? '').split(',').some((option) => option.trim() === 'collapsed=true');
          markers.push(marker[1] === 'start' ? { start: true, name: marker[3]!, at, collapsed } : { start: false, name: marker[3]!, at });
          i += marker[0].length;
          segmentStart = false;
          continue;
        }
      }
      segmentStart = false;
      let j = i;
      while (j < n) {
        const c = text.charCodeAt(j);
        if (c === 0x1b || c === 0x0d || (c < 0x20 && c !== 0x09)) break;
        j++;
      }
      if (j > i) {
        append(text.slice(i, j));
        i = j;
      } else {
        // any other C0 control character shows nothing
        i++;
      }
    }
    return { spans, plainLength, markers };
  }

  private emit(spans: MutableSpan[], plainLength: number, markers: readonly Marker[], stamp: string | undefined): void {
    const rowIndex = this.rowCount;
    const stampMs = stamp !== undefined ? Date.parse(stamp) : undefined;
    let header: number | undefined;
    // a GitLab section is titled by its header row's text, else by its key
    const headerText = markers.length > 0 ? spans.map((span) => span.text).join('').trim() : '';
    for (const marker of markers) {
      if (!marker.start) {
        this.endSection('gitlab', marker.name, marker.at);
        continue;
      }
      const id = this.startSection('gitlab', marker.name, headerText, rowIndex, marker.collapsed, marker.at);
      if (id !== undefined) header = id;
    }
    const { plain, group, level } = commandOf(this.kind, spans, spans.map((span) => span.text).join(''));
    if (group === 'end') {
      this.endSection('github', undefined, stampMs);
      return;
    }
    if (group === 'start') {
      this.endSection('github', undefined, stampMs);
      const title = plain.trim();
      const id = this.startSection('github', title, title, rowIndex, false, stampMs);
      if (id !== undefined) header = id;
    }
    // a line of section_end markers alone shows nothing
    if (markers.length > 0 && header === undefined && plainLength === 0) return;
    if (this.full()) {
      this.capped = true;
      return;
    }
    let timestamp = stamp;
    if (timestamp === undefined && header !== undefined) {
      const started = this.mutableSections[header]!;
      if (started.kind === 'gitlab' && started.startedAt !== undefined) timestamp = new Date(started.startedAt * 1000).toISOString();
    }
    const section = this.open.at(-1);
    const row: CiLogRow = {
      line: rowIndex + 1,
      spans,
      ...(timestamp !== undefined ? { timestamp } : {}),
      ...(section !== undefined ? { section } : {}),
      ...(header !== undefined ? { header } : {}),
      ...(level !== undefined ? { level } : {}),
    };
    this.rowCount++;
    if (this.sink) this.sink(row);
    else this.rows.push(row);
  }

  private startSection(kind: 'gitlab' | 'github', name: string, title: string, headerRow: number, collapsed: boolean, startedAt: number | undefined): number | undefined {
    if (this.open.length >= CI_LOG_LIMITS.sectionDepth || this.mutableSections.length >= CI_LOG_LIMITS.sections || this.full()) return undefined;
    const parent = this.open.at(-1);
    const id = this.mutableSections.length;
    this.mutableSections.push({
      id,
      title: (title === '' ? name : title).slice(0, CI_LOG_LIMITS.titleChars),
      ...(parent !== undefined ? { parent } : {}),
      depth: this.open.length,
      headerRow,
      collapsed,
      ...(startedAt !== undefined && Number.isFinite(startedAt) ? { startedAt } : {}),
      kind,
      name: name.slice(0, CI_LOG_LIMITS.titleChars),
    });
    this.open.push(id);
    return id;
  }

  /**
   * Closes the innermost open section of that kind (and name, when given) with every section opened inside it; nothing when
   * none is open.
   */
  private endSection(kind: 'gitlab' | 'github', name: string | undefined, at: number | undefined): void {
    for (let depth = this.open.length - 1; depth >= 0; depth--) {
      const section = this.mutableSections[this.open[depth]!]!;
      if (section.kind !== kind || (name !== undefined && section.name !== name)) continue;
      while (this.open.length - 1 > depth) this.close(this.open.length - 1, undefined);
      this.close(depth, at);
      return;
    }
  }

  private close(depth: number, at: number | undefined): void {
    const id = this.open[depth]!;
    this.open.length = depth;
    const section = this.mutableSections[id]!;
    section.endRow = Math.max(section.headerRow, this.rowCount - 1);
    if (at === undefined || section.startedAt === undefined || !Number.isFinite(at)) return;
    const seconds = section.kind === 'gitlab' ? at - section.startedAt : (at - section.startedAt) / 1000;
    if (seconds >= 0) section.durationSeconds = Math.round(seconds);
  }
}
