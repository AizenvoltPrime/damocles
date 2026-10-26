// PowerShell's reading of a script: its statements, tokens and script blocks (the scanner), how a cmdlet binds its
// parameters (the binder), and the cmdlet, parameter and variable tables, as pwsh 7 and Windows PowerShell 5.1 behave.

/** Whether every element was read; a computed one is undefined. */
export function allRead(values: ReadonlyArray<string | undefined>): values is string[] {
  return !values.includes(undefined);
}

/** A reason detail naming `word`, and the same detail without it, for a word that would repeat a starting-environment value. */
export interface Worded {
  readonly detail: string;
  readonly word: string;
  readonly withoutWord: string;
}

/** The detail naming `word` when there is one, else `withoutWord`. */
export function worded(word: string | undefined, detail: (word: string) => string, withoutWord: string): string | Worded {
  return word === undefined ? withoutWord : { detail: detail(word), word, withoutWord };
}

/** What a walked text shows of the places that can set a variable: each site's name key and offset, and whether it poisons. */
export interface TextScan {
  readonly sites: ReadonlyArray<{ readonly key: string; readonly offset: number }>;
  readonly poisoned: boolean;
}

/** A loop over flat segments: `head` to `start` run once before the part that may repeat, `start` to `end`. */
export interface LoopRange {
  readonly head: number;
  readonly start: number;
  readonly end: number;
}

/** A PowerShell function's body: the segments `start` to `end` of the text that defined it, and the ranges inside them. */
export interface PsFunction {
  readonly segments: readonly PsSegment[];
  readonly text: PsText;
  readonly start: number;
  readonly end: number;
  readonly inner: readonly PsRange[];
}

/** The key every site of a variable counts under, in either shell: its name without case, which can only merge names. */
export function siteKey(name: string): string {
  return name.toLowerCase();
}

export const PS_LOCATION: ReadonlySet<string> = new Set(['set-location', 'sl', 'cd', 'chdir', 'push-location', 'pushd']);
// Statements that leave the straight line, and the blocks an error or a jump enters from wherever the script stood.
export const PS_JUMPS: ReadonlySet<string> = new Set(['break', 'continue', 'return', 'throw', 'catch', 'finally', 'trap']);
// The statements whose script block runs where the walk reaches it (a loop, a pipeline cmdlet, Invoke-Command), or at
// each call the walk follows (a function and its named blocks); any other block may be kept and run later.
const PS_BLOCK_RUNS_HERE: ReadonlySet<string> = new Set([
  'foreach', 'for', 'while', 'do', 'until', 'switch', 'function', 'filter', 'begin', 'process', 'end', 'clean', 'dynamicparam',
  'foreach-object', '%', 'where-object', '?', 'where', 'invoke-command', 'icm', 'measure-command',
]);
// An `if` or `elseif` statement's first token, lower case; PowerShell reads the keyword before a `(` with no space too.
const PS_CONDITION_KEYWORD = /^(if|elseif)(?:\(|$)/;
export const PS_NEW_DRIVE: ReadonlySet<string> = new Set(['new-psdrive', 'ndr', 'mount']);
export const PS_ALIAS: ReadonlySet<string> = new Set(['set-alias', 'sal', 'new-alias', 'nal']);
export const PS_START_PROCESS: ReadonlySet<string> = new Set(['start-process', 'saps', 'start']);
// Cmdlets that set an item or its content, and that copy or move one, with their aliases in pwsh 7 and Windows PowerShell 5.1.
export const PS_ITEM_WRITE: ReadonlySet<string> = new Set(['set-item', 'si', 'new-item', 'ni', 'set-content', 'sc', 'add-content', 'ac']);
export const PS_ITEM_TRANSFER: ReadonlySet<string> = new Set(['copy-item', 'copy', 'cp', 'cpi', 'move-item', 'move', 'mv', 'mi', 'rename-item', 'ren', 'rni']);
// A path on the Env: drive, given directly or as a parameter's attached value.
export const PS_ENV_MENTION: RegExp = /^(?:-\w+:)?(?:(?:microsoft\.powershell\.core\\)?environment::|env:)/i;
// An item on the Alias: or Function: drive, which defines a command.
export const PS_COMMAND_DRIVE: RegExp = /^(?:-\w+:)?(?:(?:microsoft\.powershell\.core\\)?(?:alias|function)::|(?:alias|function):)/i;
export const PS_SET_ENVIRONMENT: RegExp = /\[(?:system\.)?environment\]::setenvironmentvariable\s*\(/i;
// The method named in any other form, which the call reader does not take.
export const PS_SET_ENVIRONMENT_NAME: RegExp = /::\s*['"]?setenvironmentvariable/i;
// Text run as a script, a process started through .NET, WMI or COM, or a variable set by name.
export const PS_RUNS_TEXT: RegExp =
  /scriptblock\]::create\s*\(|\.invokescript\s*\(|\.newscriptblock\s*\(|diagnostics\.process\]\s*::\s*(?:start|new)\s*\(|processstartinfo|\bstartinfo\b|powershell\]\s*::\s*create\b|\.add(?:script|command)\s*\(|\[wmi(?:class)?\]|\.invokemethod\s*\(|gettypefrom(?:progid|clsid)|\.psvariable\.set\s*\(/i;
// A link made through .NET (`CreateSymbolicLink`, `CreateAsSymbolicLink`) or a Win32 call declared with Add-Type.
export const PS_LINK_CALL: RegExp = /create(?:as)?symboliclink|createhardlink/i;
// A command that names Win32_Process and calls a Create method may start a process through the class it got.
export const PS_PROCESS_CLASS: RegExp = /win32_process\b/i;
export const PS_CREATE_CALL: RegExp = /\.\s*['"]?create\b/i;
// The cmdlets that call a WMI or CIM method, Win32_Process's Create among them.
export const PS_INVOKE_METHOD: ReadonlySet<string> = new Set(['invoke-cimmethod', 'icim', 'invoke-wmimethod', 'iwmi']);
export const PS_START_JOB: ReadonlySet<string> = new Set(['start-job', 'sajb']);
export const PS_ASSIGNMENT_OPERATOR: RegExp = /^(?:[-+*/%]|\?\?)?=$/;
// The SessionState location and drive methods, which move the session as Set-Location does.
export const PS_SESSION_LOCATION: RegExp = /\.\s*['"]?(?:setlocation|pushcurrentlocation|poplocation)\b|\.drive\.new\b/i;
export const PS_DEFAULT_PARAMETERS: RegExp = /psdefaultparametervalues/i;
export const PS_NATIVE_PASSING: RegExp = /psnativecommandargumentpassing/i;
// A wildcard character a provider path's `-Path` matches, unless a backtick escapes it.
export const PS_WILDCARD: RegExp = /(?<!`)[*?[]/;
// PowerShell's quote characters, any of a kind opening or closing a string, alike in pwsh 7 and Windows PowerShell 5.1.
const PS_SINGLE_QUOTES = "'\u2018\u2019\u201a\u201b";
const PS_DOUBLE_QUOTES = '"\u201c\u201d\u201e';
// PowerShell's token whitespace: space, tab, VT, FF, NBSP, NEL and every Unicode separator. A CR or LF ends a statement.
const PS_SPACE = String.raw`[\t\v\f \u00a0\u0085\p{Z}]`;
const PS_SPACE_CHARACTER = new RegExp(PS_SPACE, 'u');
const PS_LINE_BREAK = String.raw`(?:\r\n?|\n)`;
const isSingleQuote = (c: string | undefined): boolean => c !== undefined && c !== '' && PS_SINGLE_QUOTES.includes(c);
const isDoubleQuote = (c: string | undefined): boolean => c !== undefined && c !== '' && PS_DOUBLE_QUOTES.includes(c);
// A token PowerShell passes as written: one quoted string, which pwsh off Windows never globs.
export const PS_QUOTED_TOKEN: RegExp = new RegExp(`^(?:[${PS_SINGLE_QUOTES}][^${PS_SINGLE_QUOTES}]*[${PS_SINGLE_QUOTES}]|[${PS_DOUBLE_QUOTES}][^${PS_DOUBLE_QUOTES}]*[${PS_DOUBLE_QUOTES}])$`, 's');
// A redirection operator, alone or with its target attached; `n>&m` merges streams and takes no target.
export const PS_REDIRECTION: RegExp = /^[1-6*]?>>?(&[1-6])?/;
export const PS_DASHES: RegExp = /[\u2013\u2014\u2015]/g;
// Past this many nested subexpressions the parse stops and the command blocks, before the call stack runs out.
const MAX_PS_NESTING = 200;
// A variable as written after `$`: braced, with backtick escapes, or greedy over name characters and `:`.
const PS_NAME = String.raw`(\{(?:[^}\x60]|\x60[\s\S])*\}|[\p{L}\p{Nd}_?:]+)`;
// Whitespace for the text scans, which may only add sites and poisons: JavaScript's whitespace and line breaks, and NEL.
const PS_SCAN_SPACE = String.raw`[\s\u0085]`;
// The places that can set a variable: an assignment or operator-assignment, `++` or `--`, and a foreach header.
const PS_SITE = new RegExp(
  [
    String.raw`\$${PS_NAME}(?:${PS_SCAN_SPACE}*(?:\.[\p{L}\p{Nd}_]+|\[[^\]\r\n]*\]))*${PS_SCAN_SPACE}*(?:[-+*/%]|\?\?)?=(?!=)`,
    String.raw`\$${PS_NAME}${PS_SCAN_SPACE}*(?:\+\+|--)`,
    String.raw`(?:\+\+|--)${PS_SCAN_SPACE}*\$${PS_NAME}`,
    String.raw`\bforeach${PS_SCAN_SPACE}*\(${PS_SCAN_SPACE}*\$${PS_NAME}${PS_SCAN_SPACE}+in\b`,
  ].join('|'),
  'giu',
);
// A `trap` statement anywhere in the text, inside strings and comments too.
export const PS_TRAP: RegExp = /(?<![-\w$.:\\/])trap\b/iu;
// Constructs that can set a variable by a name the text does not show as an assignment.
const PS_POISON = new RegExp(
  String.raw`(?:set|new|clear|remove|get)-variable\b|variable:|\[${PS_SCAN_SPACE}*ref${PS_SCAN_SPACE}*\]|psreference|psvariable|sessionstate|runspace|import-localizeddata|\bparam${PS_SCAN_SPACE}*\(|(?<![-\w$.:\\/])(?:(?:function|filter|workflow|configuration|class)${PS_SCAN_SPACE}+[\w-]|data${PS_SCAN_SPACE}+\w+${PS_SCAN_SPACE}*[{-])|${PS_TRAP.source}`,
  'iu',
);
export const PS_VARIABLE_TOKEN: RegExp = new RegExp(String.raw`\$${PS_NAME}`, 'u');
const PS_LONE_VARIABLE = new RegExp(String.raw`^\$${PS_NAME}$`, 'u');
// One whole string: quoted, two quotes of its kind standing for one, or a here-string.
const PS_STRING_TOKEN = new RegExp(
  `^(?:${[
    `[${PS_SINGLE_QUOTES}](?:[^${PS_SINGLE_QUOTES}]|[${PS_SINGLE_QUOTES}]{2})*[${PS_SINGLE_QUOTES}]`,
    `[${PS_DOUBLE_QUOTES}](?:[^${PS_DOUBLE_QUOTES}\`]|\`[\\s\\S]|[${PS_DOUBLE_QUOTES}]{2})*[${PS_DOUBLE_QUOTES}]`,
    `@[${PS_SINGLE_QUOTES}]${PS_LINE_BREAK}[\\s\\S]*${PS_LINE_BREAK}[${PS_SINGLE_QUOTES}]@`,
    `@[${PS_DOUBLE_QUOTES}]${PS_LINE_BREAK}[\\s\\S]*${PS_LINE_BREAK}[${PS_DOUBLE_QUOTES}]@`,
  ].join('|')})$`,
);
export const PS_SPLAT: RegExp = /^@[\p{L}\p{Nd}_?]/u;
const PS_NAME_CHARACTER = /[\p{L}\p{Nd}_?]/u;
const PS_ATTACHED_PARAMETER = /^-[A-Za-z_?][\w?]*:$/;
// The escapes an expandable string reads alike in pwsh 7 and Windows PowerShell 5.1.
const PS_ESCAPES: Readonly<Record<string, string>> = { '0': '\0', a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
export const PS_VARIABLE_CMDLETS: ReadonlySet<string> = new Set(['set-variable', 'sv', 'set', 'new-variable', 'nv', 'clear-variable', 'clv', 'remove-variable', 'rv', 'get-variable', 'gv']);
export const PS_TEE: ReadonlySet<string> = new Set(['tee-object', 'tee']);
export const PS_IMPORT_MODULE: ReadonlySet<string> = new Set(['import-module', 'ipmo']);
// The common parameters that store output in a variable they name: their aliases, and the shortest prefix that binds each.
const PS_OUT_VARIABLE_ALIASES: ReadonlySet<string> = new Set(['ov', 'ev', 'wv', 'iv', 'pv']);
const PS_OUT_VARIABLES: ReadonlyArray<readonly [string, number]> = [['outvariable', 4], ['errorvariable', 6], ['warningvariable', 8], ['informationvariable', 12], ['pipelinevariable', 2]];
// PowerShell's automatic and preference variables (pwsh 7.5, Windows PowerShell 5.1), which the engine sets.
const PS_AUTOMATIC: ReadonlySet<string> = new Set([
  '$', '?', '^', '_', 'args', 'consolefilename', 'enabledexperimentalfeatures', 'error', 'event', 'eventargs', 'eventsubscriber',
  'executioncontext', 'false', 'foreach', 'home', 'host', 'input', 'iscoreclr', 'islinux', 'ismacos', 'iswindows', 'lastexitcode',
  'matches', 'myinvocation', 'nestedpromptlevel', 'null', 'pid', 'profile', 'psboundparameters', 'pscmdlet', 'pscommandpath',
  'psculture', 'psdebugcontext', 'psedition', 'pshome', 'psitem', 'psscriptroot', 'pssenderinfo', 'psuiculture', 'psversiontable',
  'pwd', 'sender', 'shellid', 'stacktrace', 'switch', 'this', 'true', 'confirmpreference', 'debugpreference', 'erroractionpreference',
  'errorview', 'formatenumerationlimit', 'informationpreference', 'logcommandhealthevent', 'logcommandlifecycleevent',
  'logenginehealthevent', 'logenginelifecycleevent', 'logproviderhealthevent', 'logproviderlifecycleevent', 'maximumaliascount',
  'maximumdrivecount', 'maximumerrorcount', 'maximumfunctioncount', 'maximumhistorycount', 'maximumvariablecount', 'ofs',
  'outputencoding', 'progresspreference', 'psdefaultparametervalues', 'psemailserver', 'psmoduleautoloadingpreference',
  'psnativecommandargumentpassing', 'psnativecommanduseerroractionpreference', 'pssessionapplicationname',
  'pssessionconfigurationname', 'pssessionoption', 'psstyle', 'transcript', 'verbosepreference', 'warningpreference', 'whatifpreference',
]);

/** `switch` takes no value, `value` one this check ignores, `unread` one that leaves the result unread; the others name a value the check reads. */
export type PsParameterKind =
  | 'switch' | 'value' | 'unread' | 'path' | 'literalpath' | 'stackname' | 'file' | 'arguments' | 'directory' | 'environment'
  | 'child' | 'unresolved' | 'parent' | 'leaf' | 'qualifier' | 'leafbase' | 'extension' | 'noqualifier' | 'isabsolute' | 'resolve'
  | 'content' | 'name' | 'itemtype';

interface PsParameter {
  readonly names: readonly string[];
  readonly kind: PsParameterKind;
  /** A switch the check reads: bound with no elements, or its attached value. */
  readonly flag?: true;
}
const PS_COMMON_PARAMETERS: readonly PsParameter[] = [
  { names: ['verbose', 'vb'], kind: 'switch' },
  { names: ['debug', 'db'], kind: 'switch' },
  { names: ['erroraction', 'ea'], kind: 'value' },
  { names: ['warningaction', 'wa'], kind: 'value' },
  { names: ['informationaction', 'infa'], kind: 'value' },
  { names: ['progressaction', 'proga'], kind: 'value' },
  { names: ['errorvariable', 'ev'], kind: 'value' },
  { names: ['warningvariable', 'wv'], kind: 'value' },
  { names: ['informationvariable', 'iv'], kind: 'value' },
  { names: ['outvariable', 'ov'], kind: 'value' },
  { names: ['outbuffer', 'ob'], kind: 'value' },
  { names: ['pipelinevariable', 'pv'], kind: 'value' },
];
const PS_SHOULD_PROCESS: readonly PsParameter[] = [{ names: ['whatif', 'wi'], kind: 'switch' }, { names: ['confirm', 'cf'], kind: 'switch' }];
// Set-Location's and Push-Location's parameters.
export const PS_LOCATION_PARAMETERS: readonly PsParameter[] = [
  { names: ['path'], kind: 'path' },
  { names: ['literalpath', 'pspath', 'lp'], kind: 'literalpath' },
  { names: ['passthru'], kind: 'switch' },
  { names: ['stackname'], kind: 'stackname' },
  ...PS_SHOULD_PROCESS,
  ...PS_COMMON_PARAMETERS,
];
export const PS_IEX_PARAMETERS: readonly PsParameter[] = [{ names: ['command'], kind: 'path' }, ...PS_COMMON_PARAMETERS];
// Start-Process in pwsh 7 (-Environment from 7.4) and Windows PowerShell 5.1.
export const PS_START_PARAMETERS: readonly PsParameter[] = [
  { names: ['filepath', 'path', 'pspath'], kind: 'file' },
  { names: ['argumentlist', 'args'], kind: 'arguments' },
  { names: ['workingdirectory'], kind: 'directory' },
  { names: ['environment'], kind: 'environment' },
  { names: ['credential', 'cred'], kind: 'value' },
  { names: ['loaduserprofile', 'lup'], kind: 'switch' },
  { names: ['nonewwindow', 'nnw'], kind: 'switch' },
  { names: ['passthru'], kind: 'switch' },
  { names: ['redirectstandarderror', 'rse'], kind: 'value' },
  { names: ['redirectstandardinput', 'rsi'], kind: 'value' },
  { names: ['redirectstandardoutput', 'rso'], kind: 'value' },
  { names: ['verb'], kind: 'value' },
  { names: ['windowstyle'], kind: 'value' },
  { names: ['wait'], kind: 'switch' },
  { names: ['usenewenvironment'], kind: 'switch' },
  ...PS_SHOULD_PROCESS,
  ...PS_COMMON_PARAMETERS,
];
// Start-Job in pwsh 7 and Windows PowerShell 5.1, which has no -WorkingDirectory.
export const PS_JOB_PARAMETERS: readonly PsParameter[] = [
  { names: ['workingdirectory'], kind: 'directory' },
  { names: ['scriptblock', 'command'], kind: 'value' },
  { names: ['initializationscript'], kind: 'value' },
  { names: ['name'], kind: 'value' },
  { names: ['credential'], kind: 'value' },
  { names: ['authentication'], kind: 'value' },
  { names: ['runas32'], kind: 'switch' },
  { names: ['psversion'], kind: 'value' },
  { names: ['inputobject'], kind: 'value' },
  { names: ['argumentlist', 'args'], kind: 'value' },
  { names: ['definitionname'], kind: 'value' },
  { names: ['definitionpath'], kind: 'value' },
  { names: ['type'], kind: 'value' },
  { names: ['filepath'], kind: 'value' },
  { names: ['literalpath', 'pspath', 'lp'], kind: 'value' },
  ...PS_COMMON_PARAMETERS,
];
// Join-Path in pwsh 7 and Windows PowerShell 5.1; `unread` binds a parameter that leaves the path unread.
export const PS_JOIN_PARAMETERS: readonly PsParameter[] = [
  { names: ['path', 'pspath'], kind: 'path' },
  { names: ['childpath'], kind: 'child' },
  { names: ['additionalchildpath'], kind: 'unread' },
  { names: ['credential'], kind: 'unread' },
  { names: ['extension'], kind: 'unread' },
  { names: ['resolve'], kind: 'unresolved', flag: true },
  ...PS_COMMON_PARAMETERS,
];
// Split-Path in pwsh 7 and Windows PowerShell 5.1.
export const PS_SPLIT_PARAMETERS: readonly PsParameter[] = [
  { names: ['path'], kind: 'path' },
  { names: ['literalpath', 'pspath', 'lp'], kind: 'unread' },
  { names: ['credential'], kind: 'unread' },
  { names: ['parent'], kind: 'parent', flag: true },
  { names: ['leaf'], kind: 'leaf', flag: true },
  { names: ['qualifier'], kind: 'qualifier', flag: true },
  { names: ['leafbase'], kind: 'leafbase', flag: true },
  { names: ['extension'], kind: 'extension', flag: true },
  { names: ['noqualifier'], kind: 'noqualifier', flag: true },
  { names: ['isabsolute'], kind: 'isabsolute', flag: true },
  { names: ['resolve'], kind: 'resolve', flag: true },
  ...PS_COMMON_PARAMETERS,
];
export const PS_COMBINE: RegExp = /^\[(?:system\.)?io\.path\]::combine\(/i;
export const PS_FRESH_ENVIRONMENT: readonly string[] = ['usenewenvironment', 'credential', 'verb'];
// Set-Item, New-Item, Set-Content and Add-Content.
export const PS_ITEM_PARAMETERS: readonly PsParameter[] = [
  { names: ['path'], kind: 'path' },
  { names: ['literalpath', 'pspath', 'lp'], kind: 'path' },
  { names: ['value'], kind: 'content' },
  { names: ['name'], kind: 'name' },
  { names: ['itemtype', 'type'], kind: 'value' },
  { names: ['force'], kind: 'switch' },
  { names: ['passthru'], kind: 'switch' },
  { names: ['filter'], kind: 'value' },
  { names: ['include'], kind: 'value' },
  { names: ['exclude'], kind: 'value' },
  { names: ['credential'], kind: 'value' },
  { names: ['encoding'], kind: 'value' },
  { names: ['stream'], kind: 'value' },
  { names: ['nonewline'], kind: 'switch' },
  { names: ['asbytestream'], kind: 'switch' },
  ...PS_SHOULD_PROCESS,
  ...PS_COMMON_PARAMETERS,
];
// New-Item in pwsh 7 and Windows PowerShell 5.1 (-UseTransaction); only -Path is positional.
export const PS_NEW_ITEM_PARAMETERS: readonly PsParameter[] = [
  { names: ['path'], kind: 'path' },
  { names: ['name'], kind: 'name' },
  { names: ['itemtype', 'type'], kind: 'itemtype' },
  { names: ['value', 'target'], kind: 'content' },
  { names: ['force'], kind: 'switch' },
  { names: ['credential'], kind: 'value' },
  { names: ['usetransaction', 'usetx'], kind: 'switch' },
  ...PS_SHOULD_PROCESS,
  ...PS_COMMON_PARAMETERS,
];

/** A link New-Item makes: a symbolic link, a junction or a hard link. */
export type PsLinkKind = 'symbolic' | 'junction' | 'hard';
// The FileSystem provider's item types in the order it tries them; the first that matches `<ItemType>*` wins.
const PS_ITEM_TYPES: ReadonlyArray<readonly [string, PsLinkKind | undefined]> = [
  ['directory', undefined], ['container', undefined], ['file', undefined], ['symboliclink', 'symbolic'], ['junction', 'junction'], ['hardlink', 'hard'],
];

/**
 * The links New-Item's `-ItemType` elements may make, read as the FileSystem provider reads the type: a case-blind
 * wildcard with `*` appended. A computed type, a list, or a `[` or backtick may be any link.
 */
export function psLinkKinds(types: ReadonlyArray<string | undefined> | undefined): ReadonlySet<PsLinkKind> {
  if (types === undefined) return new Set();
  const type = types.length === 1 ? types[0] : undefined;
  if (type === undefined || /[[`]/.test(type)) return new Set<PsLinkKind>(['symbolic', 'junction', 'hard']);
  const pattern = new RegExp(`^${[...`${type}*`].map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[\\^$.|+(){}\]]/, '\\$&'))).join('')}$`, 'is');
  const kind = PS_ITEM_TYPES.find(([name]) => pattern.test(name))?.[1];
  return new Set(kind === undefined ? [] : [kind]);
}

/** The kind PowerShell binds `-spelled` to: an alias exactly, a name by any prefix; undefined when nothing matches. */
function psParameterKind(table: readonly PsParameter[], spelled: string): PsParameterKind | 'ambiguous' | undefined {
  const exact = table.find((p) => p.names.includes(spelled));
  if (exact) return exact.kind;
  const kinds = new Set(table.filter((p) => p.names[0]!.startsWith(spelled)).map((p) => p.kind));
  // Where a prefix also matches a parameter whose value the check reads, it is read as that parameter.
  const read = [...kinds].filter((kind) => kind !== 'switch' && kind !== 'value');
  if (read.length === 1) return read[0];
  if (kinds.size > 1) return 'ambiguous';
  return [...kinds][0];
}

/** Each parameter kind bound, its value a list of elements, an element undefined when computed. */
export interface PsBound {
  readonly named: ReadonlyMap<PsParameterKind, Array<string | undefined>>;
  /** Each bound element as written, for a reason to name. */
  readonly spelled: ReadonlyMap<PsParameterKind, string[]>;
}

/** A cmdlet's arguments bound as PowerShell binds them: `-Name value`, `-Name:value`, comma lists, and positional values in `positions` order. */
export function psBind(cmdlet: string, table: readonly PsParameter[], args: ReadonlyArray<string | undefined>, raws: readonly string[], positions: readonly PsParameterKind[]): PsBound | { readonly blocked: string | Worded } {
  const named = new Map<PsParameterKind, Array<string | undefined>>();
  const spelled = new Map<PsParameterKind, string[]>();
  const positional: Array<[Array<string | undefined>, string[]]> = [];
  const list = (first: string | undefined, written: string, k: number): [Array<string | undefined>, string[], number] => {
    const elements = [first];
    const writings = [written];
    while (raws[k + 1] === ',' && k + 2 < args.length) {
      k += 2;
      elements.push(args[k]);
      writings.push(raws[k]!);
    }
    return [elements, writings, k];
  };
  for (let i = 0; i < args.length; i++) {
    const raw = raws[i]!;
    if (raw === ',') continue;
    // A splatted variable binds parameters the text does not show.
    if (/^@[A-Za-z_]/.test(raw)) return { blocked: `${cmdlet} takes splatted parameters, so its target is computed.` };
    const parameter = /^-([A-Za-z_?][\w?]*)(:?)/.exec(raw);
    if (!parameter) {
      const [elements, writings, end] = list(args[i], raw, i);
      positional.push([elements, writings]);
      i = end;
      continue;
    }
    const kind = psParameterKind(table, parameter[1]!.toLowerCase());
    if (kind === undefined || kind === 'ambiguous') return { blocked: worded(raw, (word) => `${cmdlet} ${word} is a parameter this check cannot read.`, `${cmdlet} takes a parameter this check cannot read.`) };
    // A switch takes an attached value only (`-WhatIf:$true`).
    if (kind === 'switch') continue;
    const attached = parameter[2] === ':' && raw.length > parameter[0].length;
    if (table.some((p) => p.kind === kind && p.flag === true)) {
      named.set(kind, attached ? [args[i]?.slice(parameter[0].length)] : []);
      spelled.set(kind, attached ? [raw.slice(parameter[0].length)] : []);
      continue;
    }
    if (attached || i + 1 < args.length) {
      const word = args[i];
      const [elements, writings, end] = attached
        ? list(word === undefined ? undefined : word.slice(parameter[0].length), raw.slice(parameter[0].length), i)
        : list(args[i + 1], raws[i + 1]!, i + 1);
      named.set(kind, elements);
      spelled.set(kind, writings);
      i = end;
    }
  }
  const open = positions.filter((kind) => !named.has(kind));
  positional.forEach(([elements, writings], k) => {
    if (k >= open.length) return;
    named.set(open[k]!, elements);
    spelled.set(open[k]!, writings);
  });
  return { named, spelled };
}

/** Whether a statement's token is an expression, not a command name: a literal, a variable, a subexpression or a type. */
export function psExpression(word: string | undefined, raw: string): boolean {
  return word === undefined || isSingleQuote(raw[0]) || isDoubleQuote(raw[0]) || /^[@[\d]/.test(raw);
}

/** A wildcard path with its backtick escapes removed: the literal path it matches. */
export function psUnescape(spelled: string): string {
  return spelled.replace(/`(.)/gs, '$1');
}

/** A statement's tokens without its redirections and a trailing background `&`: `words` as read, `written` as scanned. */
export function psCommandTokens(segment: PsSegment, resolved: ReadonlyArray<string | undefined>): {
  words: Array<string | undefined>;
  written: Array<string | undefined>;
  heads: string[];
  raws: string[];
  offsets: number[];
} {
  const kept = { words: [] as Array<string | undefined>, written: [] as Array<string | undefined>, heads: [] as string[], raws: [] as string[], offsets: [] as number[] };
  for (let k = 0; k < segment.raws.length; k++) {
    const raw = segment.raws[k]!;
    const redirection = PS_REDIRECTION.exec(raw);
    if (redirection) {
      if (redirection[0] === raw && redirection[1] === undefined) k++;
      continue;
    }
    if (raw === '&' && k > 0 && k === segment.raws.length - 1) continue;
    kept.words.push(resolved[k]);
    kept.written.push(segment.words[k]);
    kept.heads.push(segment.heads[k]!);
    kept.raws.push(raw);
    kept.offsets.push(segment.offsets[k]!);
  }
  return kept;
}

/** A PowerShell variable as written after `$`: braces and their backtick escapes removed, and the scope or drive before its first `:`. */
export function psVariable(written: string): { readonly qualifier: string | undefined; readonly name: string } {
  const bare = written.startsWith('{') ? written.slice(1, written.endsWith('}') ? -1 : undefined).replace(/`(.)/gs, '$1') : written;
  const colon = bare.indexOf(':');
  return colon < 0 ? { qualifier: undefined, name: bare } : { qualifier: bare.slice(0, colon).toLowerCase(), name: bare.slice(colon + 1) };
}

export function psSiteKey(written: string): string {
  return siteKey(psVariable(written).name);
}

/**
 * The constant name and site key of the variable a reference reads: a plain name without case, an `env:` name as
 * the platform matches it; undefined for another scope or drive and for the engine's own variables, except `$HOME` and
 * `$PWD`, which read as the shell's own.
 */
export function psReference(written: string): { readonly name: string; readonly key: string; readonly environment: boolean } | undefined {
  const { qualifier, name } = psVariable(written);
  if (qualifier === 'env') return { name, key: siteKey(name), environment: true };
  const lowered = name.toLowerCase();
  if (qualifier !== undefined || (PS_AUTOMATIC.has(lowered) && lowered !== 'home' && lowered !== 'pwd')) return undefined;
  return { name: lowered, key: siteKey(name), environment: false };
}

/** The value an assignment's lone token gives: a whole string, a lone variable, or `$null`, which unsets; anything else is computed. */
export function psValue(raw: string, word: string | undefined): string | undefined {
  if (raw.toLowerCase() === '$null') return '';
  return PS_STRING_TOKEN.test(raw) || PS_LONE_VARIABLE.test(raw) ? word : undefined;
}

/** Whether a token is one string value in expression mode: a string, a variable other than `$null`, or a `( )` or `$( )` of one statement. */
export function psOperand(raw: string, template: readonly PsPart[] | undefined): boolean {
  if (PS_STRING_TOKEN.test(raw)) return true;
  if (PS_LONE_VARIABLE.test(raw)) return raw.toLowerCase() !== '$null';
  return /^\$?\(/.test(raw) && template !== undefined;
}

/** Whether `-spelled` binds one of the parameters that store output in a variable they name. */
export function psOutVariable(spelled: string): boolean {
  const name = spelled.toLowerCase();
  return PS_OUT_VARIABLE_ALIASES.has(name) || PS_OUT_VARIABLES.some(([full, shortest]) => name.length >= shortest && full.startsWith(name));
}

/** A PowerShell text's sites and whether it poisons; quotes and comments count too, which only adds sites. */
export function psTextScan(text: string): TextScan {
  const sites = [...text.matchAll(PS_SITE)].map((m) => ({ key: psSiteKey(m[1] ?? m[2] ?? m[3] ?? m[4]!), offset: m.index + m[0].indexOf('$') }));
  return { sites, poisoned: PS_POISON.test(text) };
}

/**
 * PowerShell's command line for cmd (Legacy `NeedQuotes`, which pwsh 7 keeps for cmd): an argument with whitespace
 * outside an even run of quotes is wrapped in quotes as it is. pwsh 7 doubles the backslashes that end it and Windows
 * PowerShell 5.1 does not, so both lines are read.
 */
// .NET's `char.IsWhiteSpace`, which `NeedQuotes` tests.
const DOTNET_WHITESPACE = /[\t-\r\u0085\p{Z}]/u;
export function legacyCommandLines(args: ReadonlyArray<string | undefined>): readonly string[] | undefined {
  if (!allRead(args)) return undefined;
  const needQuotes = (arg: string): boolean => {
    let quotes = 0;
    for (let k = 0; k < arg.length; k++) {
      if (arg[k] === '"' && arg[k - 1] !== '\\') quotes++;
      else if (DOTNET_WHITESPACE.test(arg[k]!) && quotes % 2 === 0) return true;
    }
    return false;
  };
  const line = (doubled: boolean): string => args.map((arg) => (needQuotes(arg) ? `"${arg}${doubled ? /\\*$/.exec(arg)![0] : ''}"` : arg)).join(' ');
  return [...new Set([line(true), line(false)])];
}

/**
 * The command lines PowerShell may build for `program`: the Legacy lines, and for any program but cmd, which pwsh 7.3 and
 * later still give Legacy quoting, also the Standard line, each argument quoted as .NET's `PasteArguments` quotes it.
 */
export function psCommandLines(args: ReadonlyArray<string | undefined>, program: string): readonly string[] | undefined {
  const legacy = legacyCommandLines(args);
  if (legacy === undefined || program === 'cmd' || !allRead(args)) return legacy;
  const quote = (arg: string): string => {
    if (arg !== '' && !DOTNET_WHITESPACE.test(arg) && !arg.includes('"')) return arg;
    return `"${arg.replace(/(\\*)("|$)/g, (_, slashes: string, mark: string) => slashes + slashes + (mark === '"' ? '\\"' : ''))}"`;
  };
  return [...new Set([...legacy, args.map(quote).join(' ')])];
}

/** A part of a token PowerShell expands: literal text, a variable as written after `$`, or the one statement of a `( )` or `$( )`. */
export type PsPart = string | { readonly variable: string } | { readonly statement: PsSegment };

interface PsAssign {
  /** As written after `$` (`env:GIT_DIR`, `{wt}`). */
  readonly variable: string;
  readonly operator: string;
  /** The offset of its `$` in the scanned text. */
  readonly offset: number;
  /** No cast, member or index access. */
  readonly plain: boolean;
}

export interface PsSegment {
  readonly words: Array<string | undefined>;
  /** Each token's literal text before its first computed part. */
  readonly heads: string[];
  /** Each token as written; a lone `,` separates array elements. */
  readonly raws: string[];
  /** Each computed token's literal parts and the variables it expands, when nothing else in it is computed. */
  readonly templates: Array<readonly PsPart[] | undefined>;
  /** Each token's offset in the scanned text. */
  readonly offsets: number[];
  /** Whether a pipe feeds this statement. */
  readonly piped: boolean;
  /**
   * Whether the statement runs exactly once where the walk reaches it: outside parentheses and script blocks, ended by
   * `;`, a line break or the text's end, neither piped nor chained by `&&` or `||`, since an assignment takes a whole
   * chain's output.
   */
  topLevel: boolean;
  /** Whether a pipe or `&&` or `||` takes its output on, so an assignment it starts gets what the whole pipeline or chain outputs. */
  feeds: boolean;
  /**
   * `&&` or `||` when the statement runs only where the one before it succeeded or failed: it follows that operator
   * directly, after a statement no pipe feeds, and no subexpression of its own runs before it.
   */
  readonly guard?: '&&' | '||';
  /**
   * Whether the statement runs exactly once each time a walk passes it, given its guard: not in a block that runs at most
   * once (`try`, `&`; an `if` branch is a range of its own), not fed by a pipe, and not chained without a guard; false too
   * for a loop's opening statement.
   */
  sequential: boolean;
  /** The depth of the scan that read it; a subexpression's own statements are one deeper than the statement holding it. */
  readonly depth: number;
  /** The variables the statement's leading assignments set, with their operators. */
  readonly assigns: readonly PsAssign[];
}

/** A script block that may run more than once (a loop's, a function's, or one given as an argument), or an `if` branch. */
export interface PsRange extends LoopRange {
  /** After the block's last segment; a `do` block's range ends after its trailing condition. */
  end: number;
  /**
   * The block of an `if`, whose condition always runs, or of an `elseif` or `else`, whose condition may not: the block
   * runs whole or not at all, and an `elseif`'s condition does too, with the block a branch inside it.
   */
  readonly branch?: 'if' | 'else';
  /** The function or filter it is the body of, without case. */
  readonly name?: string;
  readonly foreach?: PsForeach;
  readonly do?: boolean;
  /**
   * The block may run at a later point the walk does not follow it to: a value, or an argument of a command that may keep
   * it. A barrier after it cannot be ordered after the reads in it.
   */
  readonly later: boolean;
  /**
   * The segments of the statement the block is part of, by index: its own parts, before and after each of its blocks,
   * without the blocks' statements; complete once the scan has read the statement.
   */
  readonly pieces?: readonly number[];
}

/** A `foreach` header whose items are each one string or variable token: its variable as written after `$`, and that `$`'s offset. */
interface PsForeach {
  readonly variable: string;
  readonly offset: number;
  readonly items: ReadonlyArray<{ readonly raw: string; readonly word: string | undefined; readonly template: readonly PsPart[] | undefined }>;
}

/** A statement a scan ended: its tokens, the segment it starts at (its subexpressions included), its own segment, and where it ended. */
interface PsStatementEnd {
  readonly raws: readonly string[];
  readonly head: number;
  readonly index: number;
  readonly at: number;
}

/**
 * The range of the script block opened after `statement`, its first segment `start`: a branch after `if`, `elseif` and
 * `else`; undefined for any other block that runs at most once: after `try`, `catch`, `finally`, `&`, `.` and `@`.
 */
function psBlock(statement: PsStatementEnd | undefined, segments: readonly PsSegment[], start: number): PsRange | undefined {
  const raws = statement?.raws ?? [];
  const first = raws[0]?.toLowerCase();
  const last = raws.at(-1);
  const keyword = PS_CONDITION_KEYWORD.exec(first ?? '')?.[1];
  if (keyword !== undefined || (raws.length === 1 && first === 'else')) return { head: statement!.head, start, end: start, later: false, branch: keyword === 'if' ? 'if' : 'else' };
  if (raws.length === 1 && (first === 'try' || first === 'finally')) return undefined;
  if (first === 'catch' && raws.slice(1).every((raw) => raw === ',' || /^\[[^\]]*\]$/.test(raw))) return undefined;
  if (last === '&' || last === '.' || last === '@') return undefined;
  const range = { head: statement?.head ?? start, start, end: start, later: first === undefined || !PS_BLOCK_RUNS_HERE.has(first) };
  if ((first === 'function' || first === 'filter') && raws.length >= 2) return { ...range, name: raws[1]!.replace(/\(.*$/s, '').replace(/^\w+:/, '').toLowerCase() };
  // The header's parentheses hold one statement, the segment right before the foreach statement's own.
  const foreach = first === 'foreach' && raws.length === 2 && raws[1]!.startsWith('(') && statement!.index - statement!.head === 1 ? psForeach(segments[statement!.index - 1]!) : undefined;
  if (foreach !== undefined) return { ...range, foreach };
  return { ...range, do: first === 'do' && raws.length === 1 };
}

/** A `foreach` header `$name in item, item...`, when each item is one string or variable token. */
function psForeach(header: PsSegment): PsForeach | undefined {
  const variable = PS_LONE_VARIABLE.exec(header.raws[0] ?? '')?.[1];
  if (variable === undefined || header.raws[1]?.toLowerCase() !== 'in' || header.raws.length < 3) return undefined;
  const items: Array<PsForeach['items'][number]> = [];
  for (let k = 2; k < header.raws.length; k += 2) {
    const raw = header.raws[k]!;
    const single = PS_STRING_TOKEN.test(raw) || (PS_LONE_VARIABLE.test(raw) && raw.toLowerCase() !== '$null');
    if (!single || (k + 1 < header.raws.length && header.raws[k + 1] !== ',')) return undefined;
    items.push({ raw, word: header.words[k], template: header.templates[k] });
  }
  return { variable, offset: header.offsets[0]!, items };
}

/** A walked PowerShell text: its id, which keys its sites, and whether its assignments define values. */
export interface PsText {
  readonly id: number;
  readonly defining: boolean;
}

// A statement's leading assignment: simple casts, the variable, member and index accesses, then the operator.
const PS_ASSIGNMENT = new RegExp(
  String.raw`((?:\[[\w.]+(?:\[\])?\]${PS_SPACE}*)*)\$(\{(?:[^}\x60]|\x60[\s\S])*\}|[\p{L}\p{Nd}_:?]+)((?:\.[\p{L}\p{Nd}_]+|\[[^\]()\r\n]*\])*)${PS_SPACE}*((?:[-+*/%]|\?\?)?=)(?!=)`,
  'uy',
);
const PS_BLANK_LINES = new RegExp(`^(?:${PS_SPACE}|[\\r\\n])+$`, 'u');
const LEADING_LINE_BREAK = new RegExp(`^${PS_LINE_BREAK}`);
const SINGLE_HERE_END = new RegExp(`${PS_LINE_BREAK}[${PS_SINGLE_QUOTES}]@`);
const DOUBLE_HERE_END = new RegExp(`${PS_LINE_BREAK}[${PS_DOUBLE_QUOTES}]@`);

/**
 * The statements of `command` from `start` into `segments`, those of each subexpression before the statement holding it,
 * and into `ranges` the script blocks that may run more than once, in the order they open; `braced` when a script block
 * holds the scan. Returns the index of the `)` that ends a scan at `depth` above 0, or the text's length; undefined when
 * the text cannot be read.
 */
export function scanPowershell(command: string, start: number, depth: number, segments: PsSegment[], braced = false, ranges: PsRange[] = [], conditional = false): number | undefined {
  if (depth > MAX_PS_NESTING) return undefined;
  const nested = depth > 0;
  let words: Array<string | undefined> = [];
  let heads: string[] = [];
  let raws: string[] = [];
  let templates: Array<readonly PsPart[] | undefined> = [];
  let offsets: number[] = [];
  let assigns: PsAssign[] = [];
  let piped = false;
  let chained = false;
  // The operator that guards the next statement (PsSegment.guard).
  let guard: '&&' | '||' | undefined;
  let braces = 0;
  // Each open brace's range, undefined for a block that runs at most once.
  const frames: Array<PsRange | undefined> = [];
  // The first segment of the statement being read, its subexpressions' included.
  let statementStart = segments.length;
  // The own segments of the statement being read (PsRange.pieces), and those of each statement a block it is in belongs to.
  let pieces: number[] = [];
  const outerPieces: number[][] = [];
  let last: PsStatementEnd | undefined;
  // A `do` block just closed, which its trailing `while` or `until` condition joins.
  let pendingDo: PsRange | undefined;
  let value = '';
  let computed = false;
  // Computed by more than variables a template reads.
  let opaque = false;
  let parts: PsPart[] = [];
  let partFrom = 0;
  // A statement part outside a string, which reads only as the whole token: `(a)b` is two arguments.
  let bare = false;
  let head = '';
  let inWord = false;
  let wordStart = start;
  let i = start;
  const begin = (): void => {
    if (!inWord) wordStart = i;
    inWord = true;
  };
  const markComputed = (): void => {
    if (!computed) head = value;
    computed = true;
  };
  const markOpaque = (): void => {
    markComputed();
    opaque = true;
  };
  const reference = (variable: string): void => {
    markComputed();
    parts.push(value.slice(partFrom), { variable });
    partFrom = value.length;
  };
  const endWord = (end = i): void => {
    if (inWord) {
      words.push(computed ? undefined : value);
      heads.push(computed ? head : value);
      raws.push(command.slice(wordStart, end));
      const whole = parts.length === 2 && parts[0] === '' && value.length === partFrom;
      templates.push(opaque || parts.length === 0 || (bare && !whole) ? undefined : [...parts, value.slice(partFrom)]);
      offsets.push(wordStart);
    }
    inWord = false;
    value = '';
    computed = false;
    opaque = false;
    parts = [];
    partFrom = 0;
    bare = false;
  };
  // Whether a subexpression of the statement being read may not run each time the walk passes it.
  const maybe = (): boolean => conditional || frames.some((range) => range === undefined) || piped || chained || /^elseif$/i.test(raws[0] ?? command.slice(wordStart, i));
  const endSegment = (then: 'end' | 'pipe' | 'chain' | 'block', operator?: '&&' | '||'): void => {
    endWord();
    if (words.length === 0) {
      if (then !== 'block') pieces = [];
      // A line break after `&&` keeps its guard; anything else between the operator and a statement drops it.
      if (then !== 'end') guard = undefined;
      // A line that starts with `|`, `&&` or `||` continues the statement before it.
      if (then === 'pipe' || then === 'chain') {
        const last = segments.at(-1);
        if (last) {
          last.topLevel = false;
          last.feeds = true;
        }
      }
      // A pipe followed by a line break still feeds the next statement; an assignment takes its value from the next line.
      piped ||= then === 'pipe';
      chained ||= then === 'chain';
      return;
    }
    const inBlock = braced || braces > 0;
    const guarded = chained && statementStart === segments.length ? guard : undefined;
    const sequential = !conditional && !frames.some((range) => range === undefined) && !piped && (!chained || guarded !== undefined);
    segments.push({
      words,
      heads,
      raws,
      templates,
      offsets,
      piped,
      assigns,
      depth,
      topLevel: !nested && !inBlock && !piped && !chained && then === 'end',
      feeds: then === 'pipe' || then === 'chain',
      ...(guarded === undefined ? {} : { guard: guarded }),
      sequential,
    });
    guard = then === 'chain' && !piped ? operator : undefined;
    pieces.push(segments.length - 1);
    if (then !== 'block') pieces = [];
    last = { raws, head: statementStart, index: segments.length - 1, at: i };
    statementStart = segments.length;
    if (pendingDo !== undefined && /^(?:while|until)$/i.test(raws[0]!)) pendingDo.end = segments.length;
    pendingDo = undefined;
    words = [];
    heads = [];
    raws = [];
    templates = [];
    offsets = [];
    assigns = [];
    piped = then === 'pipe';
    chained = then === 'chain';
  };
  // A block left open ends where the scan does.
  const close = (end: number): number => {
    for (const range of frames) if (range !== undefined) range.end = segments.length;
    return end;
  };
  // A subexpression's statements run before the statement holding it. A `( )` or `$( )` of one statement is a part of
  // its token, `inString` or not; any other makes the token computed.
  const subexpression = (open: number, inString?: boolean): number | undefined => {
    const from = segments.length;
    const end = scanPowershell(command, open + 1, depth + 1, segments, braced || braces > 0, ranges, maybe());
    const own = segments.slice(from).filter((segment) => segment.depth === depth + 1);
    if (end === undefined || inString === undefined || own.length !== 1) {
      markOpaque();
      return end;
    }
    markComputed();
    parts.push(value.slice(partFrom), { statement: own[0]! });
    partFrom = value.length;
    bare ||= !inString;
    return end;
  };
  // A backtick escape at `j` in an expandable string; returns the escaped character's index.
  const escape = (j: number): number => {
    const c = command[j + 1];
    if (c === undefined) return j + 1;
    // `e and `u{...} are escapes in pwsh 7 and plain letters in Windows PowerShell 5.1.
    if (c === 'e' || (c === 'u' && command[j + 2] === '{')) markOpaque();
    value += PS_ESCAPES[c] ?? c;
    return j + 1;
  };
  // A `$` at `j` in an expandable string or a bare token; returns the index of its last character.
  const dollar = (j: number, inString: boolean): number | undefined => {
    const next = command[j + 1] ?? '';
    if (next === '(') return subexpression(j + 1, inString);
    if (next === '$' || next === '^') {
      markOpaque();
      return j + 1;
    }
    let end = j + 1;
    if (next === '{') {
      for (end = j + 2; end < command.length && command[end] !== '}'; end++) if (command[end] === '`') end++;
      if (end >= command.length) return undefined;
    } else {
      for (let colon = false; end < command.length; end++) {
        const c = command[end]!;
        if (c === ':' && !colon && command[end + 1] !== ':') colon = true;
        else if (!PS_NAME_CHARACTER.test(c)) break;
      }
      if (end === j + 1) {
        value += '$';
        return j;
      }
      end--;
    }
    // A variable that starts a command argument is an expression, which `.`, `[` or `::` continue.
    const startsArgument = !inString && (j === wordStart || PS_ATTACHED_PARAMETER.test(command.slice(wordStart, j)));
    if (startsArgument && /[.[:]/.test(command[end + 1] ?? '')) markOpaque();
    else reference(command.slice(j + 1, end + 1));
    return end;
  };
  for (; i < command.length; i++) {
    const ch = command[i]!;
    if (!inWord && words.length === 0 && (ch === '$' || ch === '[')) {
      PS_ASSIGNMENT.lastIndex = i;
      const assignment = PS_ASSIGNMENT.exec(command);
      if (assignment) {
        const cast = assignment[1]!;
        assigns.push({ variable: assignment[2]!, operator: assignment[4]!, offset: i + cast.length, plain: cast === '' && assignment[3] === '' });
        i += assignment[0].length - 1;
        continue;
      }
    }
    if (ch === '<' && command[i + 1] === '#') {
      const end = command.indexOf('#>', i + 2);
      if (end < 0) return undefined;
      i = end + 1;
      continue;
    }
    if (ch === '#' && !inWord) {
      const end = command.slice(i).search(/[\r\n]/);
      i = end < 0 ? command.length : i + end - 1;
      continue;
    }
    if (ch === '`') {
      // A backtick before a line break continues the line.
      const lineBreak = LEADING_LINE_BREAK.exec(command.slice(i + 1, i + 3));
      if (lineBreak) {
        endWord();
        i += lineBreak[0].length;
        continue;
      }
      begin();
      if (i + 1 < command.length) value += command[++i];
      continue;
    }
    const literalHere = isSingleQuote(command[i + 1]);
    const opening = ch === '@' && !inWord && (literalHere || isDoubleQuote(command[i + 1])) ? LEADING_LINE_BREAK.exec(command.slice(i + 2, i + 4)) : null;
    if (opening) {
      // A here-string runs to a line that starts with a closing quote of its kind and `@`.
      const close = (literalHere ? SINGLE_HERE_END : DOUBLE_HERE_END).exec(command.slice(i + 2));
      if (!close) return undefined;
      begin();
      const bodyStart = i + 2 + opening[0].length;
      const bodyEnd = i + 2 + close.index;
      if (literalHere) value += command.slice(bodyStart, bodyEnd);
      for (let k = bodyStart; !literalHere && k < bodyEnd; k++) {
        const c = command[k]!;
        if (c === '`') k = escape(k);
        else if (c === '$') {
          const end = dollar(k, true);
          if (end === undefined) return undefined;
          k = end;
        } else {
          value += c;
        }
      }
      i = bodyEnd + close[0].length - 1;
      continue;
    }
    // Two quotes of the string's kind stand for the second of them.
    if (isSingleQuote(ch)) {
      begin();
      let j = i + 1;
      for (; j < command.length; j++) {
        const c = command[j]!;
        if (isSingleQuote(c)) {
          if (!isSingleQuote(command[j + 1])) break;
          value += command[++j];
          continue;
        }
        value += c;
      }
      if (j >= command.length) return undefined;
      i = j;
      continue;
    }
    if (isDoubleQuote(ch)) {
      begin();
      let j = i + 1;
      for (; j < command.length; j++) {
        const c = command[j]!;
        if (isDoubleQuote(c)) {
          if (!isDoubleQuote(command[j + 1])) break;
          value += command[++j];
        } else if (c === '`') {
          j = escape(j);
        } else if (c === '$') {
          const end = dollar(j, true);
          if (end === undefined) return undefined;
          j = end;
        } else {
          value += c;
        }
      }
      if (j >= command.length) return undefined;
      i = j;
      continue;
    }
    // A splatted variable binds parameters the text does not show.
    if (ch === '@' && /[A-Za-z_]/.test(command[i + 1] ?? '')) {
      begin();
      markOpaque();
      while (/[A-Za-z0-9_:]/.test(command[i + 1] ?? '')) i++;
      continue;
    }
    if (ch === '$') {
      begin();
      const end = dollar(i, false);
      if (end === undefined) return undefined;
      i = end;
      continue;
    }
    if (ch === '(' || (ch === '@' && command[i + 1] === '(')) {
      const param = inWord ? words.length === 0 && /^param$/i.test(command.slice(wordStart, i)) : words.length === 1 && /^param$/i.test(raws[0]!);
      begin();
      const end = ch === '(' ? subexpression(i, false) : subexpression(i + 1);
      if (end === undefined) return undefined;
      i = end;
      // A param block ends where its parentheses do; the statements after it need no separator.
      if (param) {
        endWord(i + 1);
        endSegment('block');
      }
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '\r' || ch === '|' || (ch === '&' && command[i + 1] === '&')) {
      const doubled = (ch === '|' || ch === '&') && command[i + 1] === ch;
      endSegment(doubled ? 'chain' : ch === '|' ? 'pipe' : 'end', ch === '&' ? '&&' : '||');
      if (doubled) i++;
      continue;
    }
    if (ch === ',' || (ch === '&' && !inWord)) {
      // An array's comma and the call operator are tokens of their own.
      endWord();
      begin();
      value = ch;
      endWord(i + 1);
      continue;
    }
    if (PS_SPACE_CHARACTER.test(ch)) {
      endWord();
      continue;
    }
    if (ch === ')') {
      endSegment('block');
      if (nested) return close(i);
      continue;
    }
    if (ch === '{' || ch === '}') {
      // A script block given as an assignment's value is computed, and its statements are its own.
      if (ch === '{' && !inWord && words.length === 0 && assigns.length > 0) {
        begin();
        markOpaque();
        endWord(i + 1);
      }
      endSegment('block');
      if (ch === '{') {
        // A block on the line after its keyword (`try` then a line break) still belongs to it; a statement ended before
        // the line break that assigns never opens one, since a defining statement must stay out of a range that repeats.
        const after = last !== undefined && PS_BLANK_LINES.test(command.slice(last.at, i)) && segments[last.index]!.assigns.length === 0;
        const opener = last?.at === i || after ? last : undefined;
        const block = psBlock(opener, segments, segments.length);
        const range = block === undefined ? undefined : { ...block, pieces };
        // A block that may repeat walks its opening statement again after its body, where no guard holds.
        if (range !== undefined && range.branch === undefined && opener !== undefined) segments[opener.index]!.sequential = false;
        frames.push(range);
        if (range !== undefined) ranges.push(range);
        outerPieces.push(pieces);
        pieces = [];
      } else {
        const range = frames.pop();
        if (range !== undefined) range.end = segments.length;
        pendingDo = range?.do === true ? range : undefined;
        pieces = outerPieces.pop() ?? [];
      }
      braces = ch === '{' ? braces + 1 : Math.max(0, braces - 1);
      continue;
    }
    begin();
    value += ch;
  }
  if (nested) return undefined;
  endSegment('end');
  return close(i);
}
