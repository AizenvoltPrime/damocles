import { join } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../__mocks__/source-tree';
import { SCM_CALL_LOCALIZED_TEXT, WORKTREE_CALL_LOCALIZED_TEXT } from '../../desktop/core-protocol/call-results';
import { SCM_CALLS, WORKTREE_CALLS } from '../../desktop/core-protocol/scm-calls';
import { WEBVIEW_LOCALIZED_TEXT } from '../../shared/localized-paths';

/**
 * Core never renders user-facing text (docs/invariants.md "Engine and message contract", "Localized text"): what a view or a
 * host shows reaches it as `LocalizedText`, which each renders in its own language. This guard reads the types, not the
 * code: a field named for user text in a webview message, in a request or event core sends main, in core's answer to a
 * request of main's, or in a mirror core publishes fails when typed `string`, unless ALLOWED names it as data that is no
 * one's to translate. It cannot see a `LocalizedText` built from a string core rendered. It also holds the tables of where
 * that text sits, by which each receiver parses it before rendering (localized-paths.ts), to the types.
 */

const USER_TEXT_FIELDS = new Set(['message', 'error', 'detail', 'title', 'label', 'description', 'reason', 'text']);

const CONTRACTS = [
  { file: 'src/shared/types/messages.ts', type: 'ExtensionToWebviewMessage' },
  { file: 'src/desktop/core-protocol/messages.ts', type: 'CoreRequests', params: true },
  { file: 'src/desktop/core-protocol/messages.ts', type: 'MainRequests', results: true },
  { file: 'src/desktop/core-protocol/messages.ts', type: 'CoreEvents' },
  { file: 'src/desktop/core-protocol/messages.ts', type: 'CoreMirrorTopics' },
] as const;

// The results main parses with SCM_CALL_LOCALIZED_TEXT and WORKTREE_CALL_LOCALIZED_TEXT, by each method's return type.
const CALL_RESULTS = [
  { file: 'src/core/scm/scm-service.ts', type: 'ScmService', methods: SCM_CALLS, table: SCM_CALL_LOCALIZED_TEXT },
  { file: 'src/desktop/core-protocol/scm-calls.ts', type: 'WorktreeCalls', methods: WORKTREE_CALLS, table: WORKTREE_CALL_LOCALIZED_TEXT },
] as const;

// Nested types are walked this deep (the deepest path of a contract ends at 13); a path cut off here fails the guard.
const MAX_DEPTH = 16;

// Why a field stays `string`: its words are no one's to translate, so every language shows them as written.
const MODEL = "the model's, a subagent's or a tool's own words, which the model reads in English";
const USER = "the user's own text, given back as written";
const THIRD_PARTY = 'text another program wrote: an MCP server, a pi extension, a provider, a model catalog, a web page, git or the file system';
const NAME = 'a name or title of a file, folder, model, session or memory, or a description the user wrote for an agent, command or skill';
const COMPASS = "Compass's index data, which its tools give the model in English too";
const CODE = 'a code or raw error text the view words itself or shows beside its own words';

const ALLOWED: Readonly<Record<string, string>> = {
  'ExtensionToWebviewMessage[type="assistant"].data.message.content[][type="text"].text': MODEL,
  'ExtensionToWebviewMessage[type="assistantReplay"].contentBlocks[][type="text"].text': MODEL,
  'ExtensionToWebviewMessage[type="assistantReplay"].tools[].agentLaunch.description': MODEL,
  // an error message keeps its English block for the model beside `error`, which the view renders
  'ExtensionToWebviewMessage[type="assistantReplay"].tools[].agentMessages[].contentBlocks[][type="text"].text': MODEL,
  // the card is worded by its reason; this is the provider's own error
  'ExtensionToWebviewMessage[type="authFailure"].message': THIRD_PARTY,
  'ExtensionToWebviewMessage[type="availableModels"].models[].description': THIRD_PARTY,
  'ExtensionToWebviewMessage[type="backgroundTaskStarted"].task.description': MODEL,
  'ExtensionToWebviewMessage[type="browserElementPicked"].element.consoleMessages[].text': THIRD_PARTY,
  'ExtensionToWebviewMessage[type="btwComplete"].text': MODEL,
  'ExtensionToWebviewMessage[type="btwStreaming"].text': MODEL,
  'ExtensionToWebviewMessage[type="compassGraphData"].data.communities[].description': COMPASS,
  'ExtensionToWebviewMessage[type="compassStatusUpdate"].status.error': THIRD_PARTY,
  'ExtensionToWebviewMessage[type="compassValidationResult"].data.issues[].description': COMPASS,
  'ExtensionToWebviewMessage[type="composerAppend"].text': USER,
  'ExtensionToWebviewMessage[type="consolidationProgress"].event.meta.reason': CODE,
  'ExtensionToWebviewMessage[type="consolidationResult"].result.failure.detail': CODE,
  'ExtensionToWebviewMessage[type="consolidationRunning"].runSoFar.failure.detail': CODE,
  'ExtensionToWebviewMessage[type="contextInjectionLoaded"].memoryData.added[].title': NAME,
  'ExtensionToWebviewMessage[type="contextInjectionLoaded"].memoryData.carried[].title': NAME,
  'ExtensionToWebviewMessage[type="contextInjectionLoaded"].memoryData.compass.text': MODEL,
  'ExtensionToWebviewMessage[type="contextInjectionLoaded"].memoryData.notices[].title': NAME,
  'ExtensionToWebviewMessage[type="contextInjectionLoaded"].memoryData.profile.text': MODEL,
  'ExtensionToWebviewMessage[type="customAgents"].agents[].description': NAME,
  'ExtensionToWebviewMessage[type="customSlashCommands"].commands[].description': NAME,
  'ExtensionToWebviewMessage[type="editorShowDiff"].modified.body[kind="unreadable"].error': THIRD_PARTY,
  'ExtensionToWebviewMessage[type="editorShowDiff"].original.body[kind="unreadable"].error': THIRD_PARTY,
  'ExtensionToWebviewMessage[type="extensionUiRequest"].items[].description': THIRD_PARTY,
  'ExtensionToWebviewMessage[type="extensionUiRequest"].items[].detail': THIRD_PARTY,
  'ExtensionToWebviewMessage[type="extensionUiRequest"].items[].label': THIRD_PARTY,
  'ExtensionToWebviewMessage[type="extensionUiRequest"].message': THIRD_PARTY,
  'ExtensionToWebviewMessage[type="extensionUiRequest"].title': THIRD_PARTY,
  'ExtensionToWebviewMessage[type="interruptRecovery"].contentBlocks[][type="text"].text': USER,
  'ExtensionToWebviewMessage[type="interruptRecovery"].parts[].content[][type="text"].text': USER,
  'ExtensionToWebviewMessage[type="mcpConfigUpdate"].servers[].description': THIRD_PARTY,
  'ExtensionToWebviewMessage[type="mcpConfigUpdate"].servers[].editableConfig.description': USER,
  'ExtensionToWebviewMessage[type="mcpConfigUpdate"].servers[].tools[].description': THIRD_PARTY,
  'ExtensionToWebviewMessage[type="mcpResourceChildren"].children[].description': THIRD_PARTY,
  'ExtensionToWebviewMessage[type="mcpResourceChildren"].children[].title': THIRD_PARTY,
  'ExtensionToWebviewMessage[type="mcpResourceTemplates"].templates[].description': THIRD_PARTY,
  'ExtensionToWebviewMessage[type="mcpResourceTemplates"].templates[].title': THIRD_PARTY,
  'ExtensionToWebviewMessage[type="mcpResources"].resources[].description': THIRD_PARTY,
  'ExtensionToWebviewMessage[type="mcpResources"].resources[].title': THIRD_PARTY,
  'ExtensionToWebviewMessage[type="mcpServerStatus"].servers[].description': THIRD_PARTY,
  'ExtensionToWebviewMessage[type="mcpServerStatus"].servers[].editableConfig.description': USER,
  'ExtensionToWebviewMessage[type="mcpServerStatus"].servers[].tools[].description': THIRD_PARTY,
  'ExtensionToWebviewMessage[type="memoriesUpdate"].memories[].title': NAME,
  'ExtensionToWebviewMessage[type="memoryAuditState"].state.proposals[].reason': MODEL,
  'ExtensionToWebviewMessage[type="memoryAuditState"].state.proposals[].title': NAME,
  'ExtensionToWebviewMessage[type="memoryCreated"].memory.title': NAME,
  'ExtensionToWebviewMessage[type="memoryHistory"].entries[].title': NAME,
  'ExtensionToWebviewMessage[type="memoryInjectionUpdate"].data.added[].title': NAME,
  'ExtensionToWebviewMessage[type="memoryInjectionUpdate"].data.carried[].title': NAME,
  'ExtensionToWebviewMessage[type="memoryInjectionUpdate"].data.compass.text': MODEL,
  'ExtensionToWebviewMessage[type="memoryInjectionUpdate"].data.notices[].title': NAME,
  'ExtensionToWebviewMessage[type="memoryInjectionUpdate"].data.profile.text': MODEL,
  'ExtensionToWebviewMessage[type="memoryUpdated"].memory.title': NAME,
  'ExtensionToWebviewMessage[type="messageQueued"].message.content[][type="text"].text': USER,
  'ExtensionToWebviewMessage[type="moreObservationsLoaded"].observations[].title': NAME,
  'ExtensionToWebviewMessage[type="partial"].data.content[][type="text"].text': MODEL,
  'ExtensionToWebviewMessage[type="prefillInput"].text': USER,
  'ExtensionToWebviewMessage[type="promptReturned"].content[][type="text"].text': USER,
  'ExtensionToWebviewMessage[type="promptReturned"].parts[].content[][type="text"].text': USER,
  'ExtensionToWebviewMessage[type="queueBatchProcessed"].contentBlocks[][type="text"].text': USER,
  'ExtensionToWebviewMessage[type="relatedMemories"].entries[].title': NAME,
  'ExtensionToWebviewMessage[type="requestElicitation"].message': THIRD_PARTY,
  'ExtensionToWebviewMessage[type="requestForm"].form.description': MODEL,
  'ExtensionToWebviewMessage[type="requestForm"].form.fields[].label': MODEL,
  'ExtensionToWebviewMessage[type="requestForm"].form.fields[].options[].label': MODEL,
  'ExtensionToWebviewMessage[type="requestForm"].form.title': MODEL,
  'ExtensionToWebviewMessage[type="requestQuestion"].questions[].options[].description': MODEL,
  'ExtensionToWebviewMessage[type="requestQuestion"].questions[].options[].label': MODEL,
  'ExtensionToWebviewMessage[type="rewindHistory"].prompts[].notRewindable.params.error': THIRD_PARTY,
  // the Memory panel words its verdict from rerankClassifierScore
  'ExtensionToWebviewMessage[type="searchResults"].results[].reason': MODEL,
  'ExtensionToWebviewMessage[type="searchResults"].results[].title': NAME,
  'ExtensionToWebviewMessage[type="steerTargets"].agents[][kind="subagent"].description': MODEL,
  'ExtensionToWebviewMessage[type="storedSessions"].sessions[].workspaceFolder.label': NAME,
  'ExtensionToWebviewMessage[type="subagentMessagesUpdate"].messages[].contentBlocks[][type="text"].text': MODEL,
  'ExtensionToWebviewMessage[type="subagentStart"].description': MODEL,
  'ExtensionToWebviewMessage[type="subagentSteered"].description': MODEL,
  'ExtensionToWebviewMessage[type="subagentSteered"].message': USER,
  'ExtensionToWebviewMessage[type="supportedCommands"].commands[].description': NAME,
  'ExtensionToWebviewMessage[type="taskProgress"].description': MODEL,
  'ExtensionToWebviewMessage[type="taskStarted"].description': MODEL,
  'ExtensionToWebviewMessage[type="teamAgentAssistant"].content[][type="text"].text': MODEL,
  'ExtensionToWebviewMessage[type="teamAgentDataLoaded"].messages[].content[][type="text"].text': MODEL,
  'ExtensionToWebviewMessage[type="teamAgentDataLoaded"].streaming.text': MODEL,
  'ExtensionToWebviewMessage[type="teamAgentStatusUpdate"].description': MODEL,
  'ExtensionToWebviewMessage[type="teamAgentStreamDelta"].text': MODEL,
  'ExtensionToWebviewMessage[type="teamStarted"].team.agents[].description': MODEL,
  'ExtensionToWebviewMessage[type="teamStarted"].team.title': MODEL,
  // the tool result the model read
  'ExtensionToWebviewMessage[type="toolFailed"].error': MODEL,
  'ExtensionToWebviewMessage[type="toolStatus"].data.tools[].description': MODEL,
  'ExtensionToWebviewMessage[type="toolStatus"].data.tools[].label': NAME,
  'ExtensionToWebviewMessage[type="toolStreaming"].contentBlocks[][type="text"].text': MODEL,
  'ExtensionToWebviewMessage[type="transcriptionResult"].text': USER,
  'ExtensionToWebviewMessage[type="usageStats"].report.byModel[].label': NAME,
  'ExtensionToWebviewMessage[type="usageStats"].report.bySource[].detail': CODE,
  'ExtensionToWebviewMessage[type="usageStats"].report.filterOptions.models[].label': NAME,
  'ExtensionToWebviewMessage[type="usageStats"].report.topSessions[].title': NAME,
  'ExtensionToWebviewMessage[type="userMessage"].contentBlocks[][type="text"].text': USER,
  'ExtensionToWebviewMessage[type="userReplay"].contentBlocks[][type="text"].text': USER,
  'ExtensionToWebviewMessage[type="userReplay"].steerTarget.description': MODEL,
  'ExtensionToWebviewMessage[type="voiceModelUpgradeAvailable"].upgrades[].description': THIRD_PARTY,
  'ExtensionToWebviewMessage[type="voiceTranscriptFinal"].text': USER,
  'ExtensionToWebviewMessage[type="workspaceFolderUpdate"].folders[].label': NAME,
  'ExtensionToWebviewMessage[type="worktreeState"].heldPrompt.text': USER,
  // git's or ssh's own prompt, which main shows beside its own words
  'CoreRequests.askpass.prompt.params.text': THIRD_PARTY,
  'CoreRequests.clipboard.writeText.params.text': USER,
  'CoreRequests.user.voice.speak.params.text': MODEL,
  'CoreEvents.chat.worktreeState.event.state.heldPrompt.text': USER,
  'CoreMirrorTopics.chats.entry.folder.label': NAME,
  'CoreMirrorTopics.folderTargets.targets[].label': NAME,
};

interface Root {
  readonly name: string;
  readonly type: ts.Type;
  readonly params: boolean;
  readonly results: boolean;
}

function program(): { checker: ts.TypeChecker; roots: Root[]; calls: Array<{ readonly name: string; readonly type: ts.Type; readonly methods: readonly string[]; readonly table: Readonly<Record<string, readonly string[] | undefined>> }> } {
  const config = ts.getParsedCommandLineOfConfigFile(join(REPO_ROOT, 'tsconfig.json'), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  });
  const files = [...new Set([...CONTRACTS, ...CALL_RESULTS].map((contract) => join(REPO_ROOT, contract.file)))];
  const built = ts.createProgram(files, { ...config!.options, noEmit: true });
  const checker = built.getTypeChecker();
  const declared = (contract: { readonly file: string; readonly type: string }): ts.Type => {
    const source = built.getSourceFile(join(REPO_ROOT, contract.file));
    const symbol = source && checker.getSymbolAtLocation(source)?.exports?.get(contract.type as ts.__String);
    if (!symbol) throw new Error(`${contract.file} exports no ${contract.type}`);
    return checker.getDeclaredTypeOfSymbol(symbol);
  };
  return {
    checker,
    roots: CONTRACTS.map((contract) => ({ name: contract.type, type: declared(contract), params: 'params' in contract, results: 'results' in contract })),
    calls: CALL_RESULTS.map((contract) => ({ name: contract.type, type: declared(contract), methods: contract.methods, table: contract.table })),
  };
}

interface Found {
  // user-text fields typed `string`
  readonly strings: Set<string>;
  // LocalizedText fields
  readonly localized: Set<string>;
  // LocalizedText in a union with another type, which no parser could tell apart
  readonly mixed: Set<string>;
  // paths the walk cut off at MAX_DEPTH
  readonly truncated: Set<string>;
}

/** Walks `type` from `path`, recording into `found`. */
function walker(checker: ts.TypeChecker, found: Found): (type: ts.Type, path: string) => void {
  const isPlainString = (type: ts.Type): boolean =>
    (type.flags & ts.TypeFlags.String) !== 0 || (type.isUnion() && type.types.some((member) => (member.flags & ts.TypeFlags.String) !== 0));
  const isLocalizedText = (type: ts.Type): boolean => (type.aliasSymbol ?? type.getSymbol())?.getName() === 'LocalizedText';
  const tagOf = (type: ts.Type): string | undefined => {
    for (const name of ['type', 'kind', 'phase', 'status']) {
      const property = checker.getPropertyOfType(type, name);
      const value = property && checker.getTypeOfSymbol(property);
      if (value?.isStringLiteral()) return `[${name}="${value.value}"]`;
    }
    return undefined;
  };
  const walk = (type: ts.Type, path: string, depth: number, stack: readonly ts.Type[]): void => {
    if (stack.includes(type)) return;
    if (depth > MAX_DEPTH) {
      found.truncated.add(path);
      return;
    }
    const inner = [...stack, type];
    if (type.isUnion()) {
      if (type.types.some(isLocalizedText) && type.types.some((member) => !isLocalizedText(member) && !(member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)))) found.mixed.add(path);
      for (const member of type.types) walk(member, `${path}${tagOf(member) ?? ''}`, depth + 1, inner);
      return;
    }
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      for (const arg of checker.getTypeArguments(type as ts.TypeReference)) walk(arg, `${path}[]`, depth + 1, inner);
      return;
    }
    if (!(type.flags & ts.TypeFlags.Object) && !type.isIntersection()) return;
    if (type.getCallSignatures().length > 0) return;
    if (isLocalizedText(type)) {
      found.localized.add(path);
      return;
    }
    const symbol = type.aliasSymbol ?? type.getSymbol();
    const library = symbol?.getDeclarations()?.some((declaration) => declaration.getSourceFile().hasNoDefaultLib || declaration.getSourceFile().fileName.includes('/node_modules/'));
    if (library) return;
    for (const property of checker.getPropertiesOfType(type)) {
      const value = checker.getTypeOfSymbol(property);
      const at = `${path}.${property.name}`;
      if (USER_TEXT_FIELDS.has(property.name) && isPlainString(value)) found.strings.add(at);
      walk(value, at, depth + 1, inner);
    }
  };
  return (type, path) => walk(type, path, 0, []);
}

const emptyFound = (): Found => ({ strings: new Set(), localized: new Set(), mixed: new Set(), truncated: new Set() });

function walkRoot(checker: ts.TypeChecker, root: Root, found: Found): void {
  const walk = walker(checker, found);
  if (!root.params && !root.results) {
    walk(root.type, root.name);
    return;
  }
  const field = root.params ? 'params' : 'result';
  for (const method of checker.getPropertiesOfType(root.type)) {
    const part = checker.getPropertyOfType(checker.getTypeOfSymbol(method), field);
    if (part) walk(checker.getTypeOfSymbol(part), `${root.name}.${method.name}.${field}`);
  }
}

/** Each method's LocalizedText paths in what its promise resolves with, relative to the result. */
function callResultText(checker: ts.TypeChecker, call: { readonly name: string; readonly type: ts.Type; readonly methods: readonly string[] }, found: Found): Record<string, string[]> {
  const table: Record<string, string[]> = {};
  for (const method of call.methods) {
    const property = checker.getPropertyOfType(call.type, method);
    if (!property) throw new Error(`${call.name} has no method ${method}`);
    const own = emptyFound();
    for (const signature of checker.getTypeOfSymbol(property).getCallSignatures()) {
      const returned = signature.getReturnType();
      walker(checker, own)(checker.getAwaitedType(returned) ?? returned, '');
    }
    for (const path of own.mixed) found.mixed.add(`${call.name}.${method}()${path}`);
    for (const path of own.truncated) found.truncated.add(`${call.name}.${method}()${path}`);
    if (own.localized.size > 0) table[method] = [...own.localized].sort();
  }
  return table;
}

const WEBVIEW_PATH = /^ExtensionToWebviewMessage\[type="([^"]+)"\](.*)$/;

describe('core sends user-facing text as LocalizedText', () => {
  const { checker, roots, calls } = program();
  const found = emptyFound();
  for (const root of roots) walkRoot(checker, root, found);
  const callTables = calls.map((call) => ({ call, derived: callResultText(checker, call, found) }));
  const strings = [...found.strings].sort();

  it('types every user-text field core sends a view or main LocalizedText, or allows it with a reason', () => {
    expect(strings.filter((path) => !Object.hasOwn(ALLOWED, path))).toEqual([]);
  });

  it('allows only fields that are still typed string', () => {
    expect(Object.keys(ALLOWED).filter((path) => !strings.includes(path))).toEqual([]);
  });

  it('walks every contract to its end', () => {
    expect([...found.truncated]).toEqual([]);
  });

  it('never puts LocalizedText in a union a parser could not tell apart', () => {
    expect([...found.mixed]).toEqual([]);
  });

  it('parses in every page each webview message\'s LocalizedText, where the types put it', () => {
    const derived: Record<string, string[]> = {};
    for (const path of found.localized) {
      const match = WEBVIEW_PATH.exec(path);
      if (match) (derived[match[1]!] ??= []).push(match[2]!);
    }
    const table = Object.fromEntries(Object.entries(WEBVIEW_LOCALIZED_TEXT).map(([type, paths]) => [type, [...paths].sort()]));
    expect(table).toEqual(Object.fromEntries(Object.entries(derived).map(([type, paths]) => [type, paths.sort()])));
  });

  it('parses in main the LocalizedText of each scm.call and worktrees.call result, where the types put it', () => {
    for (const { call, derived } of callTables) {
      const table = Object.fromEntries(Object.entries(call.table).map(([method, paths]) => [method, [...(paths ?? [])].sort()]));
      expect({ [call.name]: table }).toEqual({ [call.name]: derived });
    }
  });
});
