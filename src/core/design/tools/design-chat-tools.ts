// The design chat's tools (PD-42): Inventory, ExtractTokens, ImportAsset, RecordDecision, DesignCheck and LoadDesignSkill.
// Each but LoadDesignSkill writes only core-owned files of the chat's own design folder, and the gate makes it wait for the
// turn's checkpoint baseline first; LoadDesignSkill writes nothing.
import { isDeepStrictEqual } from 'node:util';
import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { PiCodingAgentModule } from '../../pi-session/pi-loader';
import type { FileConfinement } from '../../../platform/file-confinement';
import {
  TOOL_DESIGN_CHECK,
  TOOL_DESIGN_SCREENSHOT,
  TOOL_EXTRACT_TOKENS,
  TOOL_IMPORT_ASSET,
  TOOL_INVENTORY,
  TOOL_LOAD_DESIGN_SKILL,
  TOOL_RECORD_DECISION,
} from '../../../shared/tool-names';
import type { DesignPreviewHost } from '../../../platform/design-preview';
import { DESIGN_DECISIONS_DETAIL_KEY, issueCount, type DesignCheckSummary, type FinishDesignDelivery, type LoadDesignSkillDetails } from '../../../shared/types/design';
import { l } from '../../l10n';
import { LocalizedError } from '../../../shared/localized-text';
import { AssetRefusedError, importAsset, importAssetFile, importAssetUrl } from '../assets';
import { ProjectFiles } from '../citations';
import { DecisionConflictError, DecisionRefusedError, recordChosenDecision, uncheckedText, type DecisionLedger, type RecordedDecision } from '../decisions';
import type { DecisionConflictJudge } from '../decision-conflicts';
import { runDesignCheck } from '../design-check';
import { decisionsOnBranch, MAX_DECISION_FIELD_CHARS, MAX_DECISION_REFS, type DesignRole } from '../design-entries';
import { fidelityOf, readManifest, updateManifest, type ManifestScreen } from '../design-files';
import type { DesignVersionRecord } from '../design-state';
import type { DesignPreviewOpening, DesignStanding } from '../session-design';
import { MAX_CHANGED_PATHS } from '../../../shared/design-render';
import type { DesignApprovalAsk } from '../../permission-handler/managers/design-approval-manager';
import type { DesignApprovalAnswer } from '../../permission-handler/types';
import { inventoryDetails, inventoryProblems, mergeInventory, readInventory, updateInventory, type InventoryInput } from '../inventory';
import { designRuleSetById, type DesignRuleSet } from '../rule-set';
import { designSkill, designSkillNames, loadedSkillHints } from '../skills';
import { designViewports, journeyViewportsOf } from '../design-preview';
import { DesignRenderUnavailableError, runWidthChecks } from '../width-checks';
import { extractTokens, readTokenNames, TokensRefusedError } from '../tokens';

/** What a design chat's tools read of their session, each per call. */
export interface DesignChatToolDeps {
  /** The chat's role; undefined outside a design chat, where every design chat tool refuses. */
  role(): DesignRole | undefined;
  /** `damocles.design.enabled`. */
  enabled(): boolean;
  readonly cwd: string;
  readonly confinement: FileConfinement;
  /** The session's active branch, root first. */
  branch(): readonly unknown[];
  /** Where this chat's decisions are recorded (D99); undefined while no design chat's session is bound. */
  decisions(): DecisionLedger | undefined;
  /** The decision conflict check's sub-call. */
  conflictJudge(): DecisionConflictJudge;
  sessionId(): string;
  /** Where this chat stands in its design's link.json, read now (PD-36). */
  readStanding(): Promise<DesignStanding>;
  /** Where it stood at the last read, or that its own takeover is under way. */
  standing(): DesignStanding;
  /** The manifest changed: the chat's design state follows. */
  publish(): void;
  /** Hands a finished version to the parent (PD-20, PD-27) and says how it travels; `notify`: tell the user when the parent is away. */
  offerResult(record: DesignVersionRecord, role: DesignRole, notify: boolean): Promise<FinishDesignDelivery>;
  /** A main chat would receive a version now: the design has a parent and it still exists. */
  hasParent(role: DesignRole): Promise<boolean>;
  /** Raises FinishDesign's approval prompt in every permission mode until the user answers or `signal` aborts (undefined). */
  requestApproval(ask: DesignApprovalAsk, signal: AbortSignal): Promise<DesignApprovalAnswer | undefined>;
  /** The desktop preview's renders, through the attached client; undefined on a host without the preview. */
  render(): DesignPreviewHost | undefined;
  /** How many images of one tool result the chat's model keeps in context (its image budget); 0 when it reads no images. */
  imageBudget(): number;
  /** The model the tools' results go to, whose published image limits size and encode a render (`renderImageTarget`). */
  model(): Model<Api> | undefined;
  /** Resolves once reference `id`'s files, saved after its message's baseline, are written or given up; at once when none is pending. */
  referenceWritten(id: string): Promise<void>;
  /** Opens or shows the preview tab of `relPath` in this design chat, on the device that shows it (`SessionDesign.openPreview`). */
  openPreview(designId: string, relPath: string): Promise<DesignPreviewOpening>;
  /** `damocles.pi.webSearch.enabled`, without which the chat has no WebFetch, so ImportAsset fetches no URL (D101). */
  webToolsEnabled(): boolean;
  /** Whether a deny or ask WebFetch rule covers a URL's host, which ImportAsset's URL fetch then never redirects to (D101). */
  webHostFilter(): Promise<(url: string) => boolean>;
}

/** The role of an active design chat, or the reason this tool does not run. */
export function activeRole(deps: Pick<DesignChatToolDeps, 'role' | 'enabled'>, toolName: string): DesignRole {
  const role = deps.role();
  if (!role) throw new Error(`${toolName} runs only in a design chat.`);
  if (!deps.enabled()) throw new Error('Design mode is off. Turn on design mode in Settings to continue this design.');
  return role;
}

/** Core wrote or removed `paths` of the chat's design, '/' separated: its open previews reload (D100). */
export function previewFilesChanged(deps: Pick<DesignChatToolDeps, 'render'>, role: DesignRole, paths: readonly string[]): void {
  if (paths.length === 0 || !designRuleSetById(role.ruleSet).preview) return;
  deps.render()?.changed(role.designId, paths.slice(0, MAX_CHANGED_PATHS));
}

function text(value: string): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: value }];
}

/** Runs the static check, with the hints of the skills loaded on `branch`, and records each screen's counts in the manifest. */
export async function checkDesign(role: DesignRole, branch: readonly unknown[]): Promise<{ summary: DesignCheckSummary; screens: ManifestScreen[] }> {
  // read before the journey files, so a journey summary another writer records meanwhile shows as changed (D65)
  const before = await readManifest(role.folder, role.designId);
  const decisions = decisionsOnBranch(branch);
  // REDUCED gates on DesignCheck's other rules only (PD-21)
  const journeys = designRuleSetById(role.ruleSet).gate.journeys ? { widths: journeyViewportsOf(await designViewports(role.folder)).map((viewport) => viewport.width) } : undefined;
  const result = await runDesignCheck({
    folder: role.folder,
    inventory: await readInventory(role.folder),
    tokenNames: await readTokenNames(role.folder),
    decisions,
    fidelity: fidelityOf(decisions),
    skillHints: loadedSkillHints(branch),
    ...(journeys ? { journeys } : {}),
    screenshots: designRuleSetById(role.ruleSet).designTools.includes(TOOL_DESIGN_SCREENSHOT),
  });
  const issues = [...result.summary.errors, ...result.summary.warnings];
  const screens: ManifestScreen[] = result.screens.map((screen) => ({
    id: screen.id,
    file: screen.file,
    contentHash: screen.contentHash,
    check: {
      errors: issueCount(result.summary.errors.filter((issue) => issue.screen === screen.id)),
      warnings: issues.filter((issue) => issue.severity === 'warning' && issue.screen === screen.id).map(({ rule, element, message, more }) => ({ rule, element, message, ...(more ? { more } : {}) })),
    },
    ...(screen.journey ? { journey: screen.journey } : {}),
  }));
  // a screen keeps its width check and screenshot records, which name the content hash they were made at
  await updateManifest(role.folder, role.designId, (current) => ({
    ...current,
    screens: screens.map((screen) => {
      const held = current.screens.find((candidate) => candidate.file === screen.file);
      const journeyMeanwhile = held?.journey !== undefined && !isDeepStrictEqual(held.journey, before.screens.find((candidate) => candidate.file === screen.file)?.journey);
      const { journey, ...checked } = screen;
      return {
        ...checked,
        ...(journeyMeanwhile ? { journey: held.journey } : journey ? { journey } : {}),
        ...(held?.widthCheck ? { widthCheck: held.widthCheck } : {}),
        ...(held?.screenshot ? { screenshot: held.screenshot } : {}),
      };
    }),
  }));
  return { summary: result.summary, screens };
}

/**
 * The static check and, where the chat's rule set has width checks (FULL), the width checks in the attached client
 * (PD-14), in one summary. Throws DesignRenderUnavailableError while no client renders designs.
 */
export async function checkDesignAtWidths(role: DesignRole, deps: Pick<DesignChatToolDeps, 'branch' | 'render'>, reuse: boolean, signal: AbortSignal): Promise<{ summary: DesignCheckSummary; screens: ManifestScreen[] }> {
  const checked = await checkDesign(role, deps.branch());
  if (!designRuleSetById(role.ruleSet).gate.widthChecks) return checked;
  const render = deps.render();
  if (!render) throw new DesignRenderUnavailableError();
  const { widths, issues } = await runWidthChecks({ designId: role.designId, folder: role.folder, screens: checked.screens, render, reuse, signal });
  const { summary } = checked;
  return {
    screens: checked.screens,
    summary: {
      ...summary,
      errors: [...summary.errors, ...issues.filter((issue) => issue.severity === 'error')],
      warnings: [...summary.warnings, ...issues.filter((issue) => issue.severity === 'warning')],
      widths: widths.map((checkedWidth) => checkedWidth.width),
    },
  };
}

/** The check's issues as the model reads them. */
export function describeCheck(summary: DesignCheckSummary): string {
  const at = summary.widths.length > 0 ? ` at ${summary.widths.length} widths (${summary.widths.join(', ')} px) and the overflow sweep` : '';
  const errors = issueCount(summary.errors);
  const warnings = issueCount(summary.warnings);
  const lines = errors === 0
    ? [`DesignCheck: no errors${at}${warnings > 0 ? `, ${warnings} warning(s)` : ''}. Checked ${summary.attributesChecked} data-ds attributes against inventory.json and ${summary.tokensChecked} tokens, plus ${summary.skillHints} skill hints. No model call.`]
    : [`DesignCheck: ${errors} error(s)${warnings > 0 ? ` and ${warnings} warning(s)` : ''}${at}. Fix every error before FinishDesign.`];
  for (const issue of [...summary.errors, ...summary.warnings]) {
    const width = issue.width !== undefined ? ` at ${issue.width} px${issue.breakpoint ? ` (${issue.breakpoint})` : ''}` : '';
    lines.push(`- ${issue.severity} ${issue.rule} in ${issue.screen}${width} at ${issue.element}: ${issue.message}`);
    if (issue.more) lines.push(`- and ${issue.more} more ${issue.rule} issue(s) in ${issue.screen}`);
  }
  return lines.join('\n');
}

/** Why the width checks did not run, for the view: DesignCheck checked statically, FinishDesign refused. */
export const WIDTH_CHECKS_SKIPPED = 'The width checks did not run. They run once this chat is open in the Damocles app.';

const fileLine = Type.String({ description: 'A file relative to the working folder, with ":<line>" where the item is declared.' });

const inventorySchema = Type.Object({
  stack: Type.String({ maxLength: 400, description: 'The stack in one line, such as "Laravel 11, Inertia, Vue 3, Tailwind 4".' }),
  components: Type.Array(Type.Object({
    name: Type.String({ maxLength: 120, description: 'The name screens use in data-ds-component.' }),
    path: Type.String({ description: 'The component file, relative to the working folder.' }),
    line: Type.Optional(Type.Integer({ minimum: 1 })),
    variants: Type.Optional(Type.Array(Type.String({ maxLength: 120 }), { maxItems: 64 })),
    props: Type.Optional(Type.Array(Type.String({ maxLength: 120 }), { maxItems: 128 })),
  }, { additionalProperties: false }), { maxItems: 512 }),
  screens: Type.Array(Type.Object({
    id: Type.String({ maxLength: 120 }),
    entry: Type.String({ description: 'The page file, relative to the working folder.' }),
    route: Type.Optional(Type.String({ maxLength: 400 })),
    container: Type.Optional(Type.String({ maxLength: 400, description: 'The page container, such as max-w-7xl.' })),
  }, { additionalProperties: false }), { maxItems: 256 }),
  types: Type.Array(Type.Object({
    name: Type.String({ maxLength: 120 }),
    path: fileLine,
    fields: Type.Array(Type.String({ maxLength: 120 }), { maxItems: 256 }),
  }, { additionalProperties: false }), { maxItems: 512 }),
  stores: Type.Optional(Type.Array(Type.Object({ name: Type.String({ maxLength: 120 }), path: Type.String() }, { additionalProperties: false }), { maxItems: 256 })),
  actions: Type.Optional(Type.Array(Type.Object({ name: Type.String({ maxLength: 120 }), path: Type.String() }, { additionalProperties: false }), { maxItems: 256 })),
}, { additionalProperties: false });

const declaredSchema = Type.Object({
  name: Type.String({ maxLength: 160 }),
  value: Type.String({ maxLength: 400 }),
  cite: Type.String({ description: '"file:line" whose text holds the value.' }),
}, { additionalProperties: false });

const extractSchema = Type.Object({
  files: Type.Array(Type.String(), { maxItems: 16, description: 'CSS files to scan, relative to the working folder.' }),
  declared: Type.Optional(Type.Array(declaredSchema, { maxItems: 512, description: 'Tokens the scan cannot read (SCSS variables, theme files), each with a citation whose line holds the value.' })),
  breakpoints: Type.Optional(Type.Array(declaredSchema, { maxItems: 16, description: 'Breakpoints the scan cannot read (Tailwind 3 theme.screens, SCSS maps): name such as md, value such as 768px, and a citation.' })),
}, { additionalProperties: false });

const assetSchema = Type.Object({
  path: Type.Optional(Type.String({ description: 'A font or image of the project, relative to the working folder.' })),
  file: Type.Optional(Type.String({ description: 'A font or image on this chat\'s machine, outside the project, named as Read takes it: an absolute path, ~/ or file://.' })),
  url: Type.Optional(Type.String({ maxLength: 2048, description: 'The https URL of a font or image.' })),
}, { additionalProperties: false });

const decisionIds = (description: string) => Type.Optional(Type.Array(Type.String({ pattern: '^D[1-9][0-9]{0,5}$' }), { maxItems: MAX_DECISION_REFS, description }));

const decisionSchema = Type.Object({
  title: Type.String({ maxLength: MAX_DECISION_FIELD_CHARS, description: 'What was decided, in a few words, such as "Table density".' }),
  chosen: Type.String({ maxLength: MAX_DECISION_FIELD_CHARS }),
  rejected: Type.Optional(Type.Array(Type.String({ maxLength: MAX_DECISION_FIELD_CHARS }), { maxItems: 16 })),
  source: Type.Object({
    kind: Type.Union([Type.Literal('chat'), Type.Literal('brief'), Type.Literal('markup'), Type.Literal('tweak'), Type.Literal('reference'), Type.Literal('question')]),
    ref: Type.String({ maxLength: MAX_DECISION_FIELD_CHARS, description: 'chat: the user\'s words, quoted exactly. brief: the brief id. markup: F<n>#pin<k>, a change pin of feedback/F<n>.json, such as F1#pin1. tweak: the id of a control the user kept. reference: R<n>#<element>, a row of the reference mapping. question: D<n>, the question decision this one refines, which replaces names too.' }),
  }, { additionalProperties: false }),
  files: Type.Optional(Type.Array(Type.String({ maxLength: 400 }), { maxItems: 64, description: 'Design files the decision shapes, relative to the design folder.' })),
  replaces: decisionIds('Current decisions this one replaces in full, such as ["D18"]. A replaced decision is no longer current, so restate in this decision anything of it that still holds.'),
  stillHolds: decisionIds('Current decisions that stay valid beside this one, such as ["D8"], when both truly stand.'),
}, { additionalProperties: false });

const checkSchema = Type.Object({}, { additionalProperties: false });

const skillSchema = Type.Object({
  names: Type.Array(Type.String({ maxLength: 64 }), { minItems: 1, maxItems: 8, description: 'The design skills to load, by name.' }),
}, { additionalProperties: false });

// A pure function of the rule set, so the tool list stays constant for the session (PD-17).
function checkDescription(ruleSet: DesignRuleSet): string {
  const widths = ruleSet.gate.widthChecks
    ? ' It then renders every screen in the Damocles app at each checked width (design.md viewports.checked, by default base and each breakpoint) and resizes it from 320 px to the widest breakpoint: an element wider than the viewport is an error (layout.overflow), and a bound field hidden at one width but shown at another a warning (ds.hidden-required).'
    : '';
  return `Check every screen in screens/, every shared file in shared/ and design.md against inventory.json, tokens.css and the decisions, with no model call: known components, variants, bindings and decisions, token-only colors, spacing and radii, no token set to a literal in a screen, declared states, no scripts in a static design, no javascript: links, no network, local assets only, an accessible name on every control, and the validation hints of the design skills you loaded.${widths} Errors block FinishDesign; warnings travel with the version.`;
}

function skillDescription(): string {
  return `Load design skills: guidance on one design topic each, whose validation hints DesignCheck checks from then on in this chat. Load the ones the design needs before you write its screens. Loading writes nothing. The skills: ${designSkillNames().map((name) => `${name} (${designSkill(name)!.description})`).join('; ')}`;
}

/** DesignCheck alone, for the design chat and for its subagents' verification tools. */
export function createDesignCheckTool(pi: PiCodingAgentModule, deps: DesignChatToolDeps, ruleSet: DesignRuleSet): ToolDefinition {
  return pi.defineTool<typeof checkSchema, unknown>({
    name: TOOL_DESIGN_CHECK,
    label: 'DesignCheck',
    // pi then runs the whole batch one call at a time, so a write before it in the batch has landed.
    executionMode: 'sequential',
    description: checkDescription(ruleSet),
    parameters: checkSchema,
    execute: async (_toolCallId, _params, signal) => {
      const role = activeRole(deps, TOOL_DESIGN_CHECK);
      try {
        const { summary } = await checkDesignAtWidths(role, deps, false, signal ?? new AbortController().signal);
        deps.publish();
        return { content: text(describeCheck(summary)), details: summary };
      } catch (err) {
        if (!(err instanceof DesignRenderUnavailableError)) throw err;
        const { summary } = await checkDesign(role, deps.branch());
        deps.publish();
        const details: DesignCheckSummary = { ...summary, widthChecks: { skipped: l(WIDTH_CHECKS_SKIPPED) } };
        return { content: text(`${describeCheck(summary)}\nThe width checks did not run: ${err.message} They run once this chat is open in the Damocles app.`), details };
      }
    },
  });
}

/** The design chat's grounding, decision and check tools; inert outside a design chat and while design mode is off. */
export function createDesignChatTools(pi: PiCodingAgentModule, deps: DesignChatToolDeps, ruleSet: DesignRuleSet): ToolDefinition[] {
  const files = (): ProjectFiles => new ProjectFiles(deps.cwd, deps.confinement);
  return [
    pi.defineTool<typeof inventorySchema, unknown>({
      name: TOOL_INVENTORY,
      label: 'Inventory',
      description: 'Record what the app has, after reading its code: its stack, components (with their variants and props), pages, types with their fields, stores and actions. Damocles checks every file and line against the working folder and writes inventory.json, which DesignCheck checks screens against. Call it again to replace the lists.',
      parameters: inventorySchema,
      execute: async (_toolCallId, params) => {
        const role = activeRole(deps, TOOL_INVENTORY);
        const input = params as unknown as InventoryInput;
        const problems = await inventoryProblems(input, files());
        if (problems.length > 0) throw new Error(`Inventory was not written:\n${problems.map((p) => `- ${p}`).join('\n')}`);
        const inventory = await updateInventory(role.folder, (current) => mergeInventory(current, input));
        const details = inventoryDetails(inventory, await readTokenNames(role.folder));
        return {
          content: text(`inventory.json now lists ${details.categories.map((c) => `${c.count} ${c.key}`).join(', ')}.`),
          details,
        };
      },
    }),
    pi.defineTool<typeof extractSchema, unknown>({
      name: TOOL_EXTRACT_TOKENS,
      label: 'ExtractTokens',
      // pi then runs the whole batch one call at a time, so tokens.css, the inventory and assets/ hold one run's output.
      executionMode: 'sequential',
      description: 'Extract the app\'s design tokens into tokens.css: custom properties in :root and @theme blocks of the CSS files you name, plus tokens and breakpoints you declare with a file:line citation whose line holds the value (for SCSS, Tailwind 3 theme.screens and theme files). Breakpoints come from --breakpoint-* properties; with Tailwind and no overrides they are Tailwind\'s defaults. @font-face sources are copied into assets/. Screens link ../tokens.css and use var(--token) only.',
      parameters: extractSchema,
      execute: async (_toolCallId, params) => {
        const role = activeRole(deps, TOOL_EXTRACT_TOKENS);
        try {
          const outcome = await extractTokens(params, files(), role.folder);
          const { details } = outcome;
          const lines = [
            `tokens.css holds ${details.count} tokens (${Object.entries(details.groups).map(([group, count]) => `${group} ${count}`).join(', ') || 'none'}).`,
            `Breakpoints: ${Object.entries(details.breakpoints.values).map(([name, px]) => `${name} ${px}px`).join(', ') || 'none'} (${details.breakpoints.source}).`,
            ...(details.fonts.length > 0 ? [`Fonts copied: ${details.fonts.join(', ')}.`] : []),
            ...outcome.skippedFonts.map((skipped) => `Font not copied: ${skipped}.`),
          ];
          deps.publish();
          previewFilesChanged(deps, role, ['tokens.css', ...details.fonts]);
          return { content: text(lines.join('\n')), details };
        } catch (err) {
          if (err instanceof TokensRefusedError) throw new Error(`ExtractTokens wrote nothing:\n${err.message}`);
          throw err;
        }
      },
    }),
    pi.defineTool<typeof assetSchema, unknown>({
      name: TOOL_IMPORT_ASSET,
      label: 'ImportAsset',
      // pi then runs the whole batch one call at a time, so two sources with one name never both take the same assets/ file.
      executionMode: 'sequential',
      description: 'Copy a font or image (woff, woff2, ttf, otf, png, jpg, jpeg, webp, avif, gif, svg, ico; at most 5 MiB) into the design\'s assets/, where screens load it from ../assets/. Name exactly one source: path, a project file relative to the working folder; file, a path on this chat\'s machine as Read takes it (absolute, ~/ or file://); or url, an https URL. A file runs under the chat\'s Read permission rules and a URL under its WebFetch rules. The bytes of a file or URL must be the type its name says; a name with no extension takes the type of its bytes. A JPEG is saved as .jpg. The result names the saved file and the source, so record its licence in design.md.',
      parameters: assetSchema,
      execute: async (_toolCallId, params, signal) => {
        const role = activeRole(deps, TOOL_IMPORT_ASSET);
        const sources = [params.path, params.file, params.url].filter((source) => source !== undefined);
        if (sources.length !== 1) throw new Error('ImportAsset takes exactly one of path, file and url.');
        if (params.url !== undefined && !deps.webToolsEnabled()) {
          throw new LocalizedError(l('ImportAsset downloads a URL only while Web search is on, since this chat could not fetch it otherwise. Turn on Web search in Settings, or import the file from a path.'));
        }
        try {
          const details = params.url !== undefined
            ? await importAssetUrl(params.url, role.folder, signal ?? new AbortController().signal, await deps.webHostFilter())
            : params.file !== undefined ? await importAssetFile(params.file, deps.cwd, role.folder) : await importAsset(files(), params.path!, role.folder);
          previewFilesChanged(deps, role, [details.asset]);
          return { content: text(`Copied ${details.source} to ${details.asset} (${details.bytes} bytes). Screens load it as ../${details.asset}.`), details };
        } catch (err) {
          if (err instanceof AssetRefusedError) throw new Error(`ImportAsset copied nothing: ${err.message}`);
          throw err;
        }
      },
    }),
    pi.defineTool<typeof decisionSchema, unknown>({
      name: TOOL_RECORD_DECISION,
      label: 'RecordDecision',
      // pi then runs the whole batch one call at a time, so two decisions of one batch never take the same number.
      executionMode: 'sequential',
      description: 'Record a design decision the user made in this chat rather than through AskUserQuestion. Its source must exist: kind "chat" with the user\'s words quoted exactly (from their messages, the text they typed or noted in an answer, a subagent\'s question included, a change note on FinishDesign or a steer they sent a subagent), kind "brief" with a brief id, kind "markup" with F<n>#pin<k> naming a change pin of a markup the user sent (a note pin is no decision), kind "tweak" with the id of a control the user kept and chosen its kept token, kind "reference" with R<n>#<element> naming a row MapReference recorded, or kind "question" with the id of a question decision this one refines. When the user changes their mind, name the decision this one replaces in replaces and restate what still holds; name decisions that stay valid beside it in stillHolds. A current decision with the same title must be named in one of them. Damocles checks the decision against the current ones with a model and refuses it, recording nothing, when it contradicts or restates one it does not name. Decisions are numbered D1, D2, ... and decisions.md is rebuilt from them.',
      parameters: decisionSchema,
      execute: async (_toolCallId, params, signal) => {
        activeRole(deps, TOOL_RECORD_DECISION);
        // the reference this source names may still be on its way to the folder, after the same baseline this call waited for
        if (params.source.kind === 'reference') await deps.referenceWritten(params.source.ref.split('#', 1)[0]!);
        const ledger = deps.decisions();
        if (!ledger) throw new Error(`${TOOL_RECORD_DECISION} runs only in a design chat.`);
        let recorded: RecordedDecision;
        try {
          recorded = await recordChosenDecision(ledger, deps.conflictJudge(), params, signal ?? new AbortController().signal);
        } catch (err) {
          if (err instanceof DecisionConflictError) throw new Error(err.message);
          if (err instanceof DecisionRefusedError) throw new Error(`RecordDecision recorded nothing: ${err.message}`);
          throw err;
        }
        const { record, review } = recorded;
        const lines = [`Recorded ${record.id} · ${record.title}: ${record.chosen}${record.replaces?.length ? ` (replaces ${record.replaces.join(', ')})` : ''}.`];
        if (record.conflictCheck === 'unchecked') {
          lines.push([
            `The conflict check could not run (${uncheckedText(record.uncheckedReason ?? 'unreachable')}), so ${record.id} is recorded unchecked.`,
            ...(review.length > 0 ? [`Compare it with these current decisions yourself, and record a replacement if it conflicts: ${review.map((decision) => `${decision.id} ${decision.title}: ${decision.chosen}`).join('; ')}.`] : []),
            'FinishDesign checks it again.',
          ].join(' '));
        }
        return { content: text(lines.join('\n')), details: { [DESIGN_DECISIONS_DETAIL_KEY]: [record] } };
      },
    }),
    createDesignCheckTool(pi, deps, ruleSet),
    pi.defineTool<typeof skillSchema, unknown>({
      name: TOOL_LOAD_DESIGN_SKILL,
      label: 'LoadDesignSkill',
      description: skillDescription(),
      parameters: skillSchema,
      execute: async (_toolCallId, params) => {
        activeRole(deps, TOOL_LOAD_DESIGN_SKILL);
        const unknown = params.names.filter((name) => designSkill(name) === undefined);
        if (unknown.length > 0) throw new Error(`No design skill is named ${unknown.join(', ')}. The skills are ${designSkillNames().join(', ')}.`);
        const skills = [...new Set(params.names)].map((name) => designSkill(name)!);
        const details: LoadDesignSkillDetails = { skills: skills.map((skill) => ({ name: skill.name, title: skill.title, hints: skill.validationHints.length })) };
        const bodies = skills.map((skill) => [
          `# Design skill: ${skill.name}`,
          '',
          skill.body,
          ...(skill.validationHints.length > 0 ? ['', 'DesignCheck checks these hints from now on:', ...skill.validationHints.map((hint) => `- ${hint.rule} (${hint.severity}): ${hint.text}`)] : []),
        ].join('\n'));
        return { content: text(bodies.join('\n\n')), details };
      },
    }),
  ];
}
