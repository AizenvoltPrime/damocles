import type { HostCapabilities } from '../../shared/types/messages';
import type { DesignRuleSetId } from '../../shared/types/design';
import {
  TOOL_DECLARE_TWEAKS,
  TOOL_DESIGN_CHECK,
  TOOL_DESIGN_PARITY,
  TOOL_DESIGN_SCREENSHOT,
  TOOL_EXTRACT_TOKENS,
  TOOL_FINISH_DESIGN,
  TOOL_IMPORT_ASSET,
  TOOL_INVENTORY,
  TOOL_LOAD_DESIGN_SKILL,
  TOOL_MAP_REFERENCE,
  TOOL_OPEN_PREVIEW,
  TOOL_PREVIEW_JOURNEY,
  TOOL_RECORD_DECISION,
  TOOL_REMOVE_DESIGN_FILE,
  TOOL_START_DESIGN,
} from '../../shared/tool-names';

/** What FinishDesign requires before it stamps a version. Warnings never block (PD-52). */
export interface DesignGate {
  /** No static DesignCheck error. */
  readonly staticCheck: true;
  /** No DesignCheck error at the checked widths. */
  readonly widthChecks: boolean;
  /** For an interactive design, every screen's journey passed (PD-21). */
  readonly journeys: boolean;
}

/** One of the two rule sets; the tool set, the FinishDesign gate, the guidance and the webview read only this. */
export interface DesignRuleSet {
  readonly id: DesignRuleSetId;
  /** The design chat's design tools, later slices' included; only the ones built are activated. */
  readonly designTools: readonly string[];
  /** The design tools a parent chat gets. */
  readonly parentTools: readonly string[];
  readonly gate: DesignGate;
  /** The host has the sandboxed preview tab. */
  readonly preview: boolean;
  /** A chat's cards and header open the design in the browser through the host's `DesignHost`; FULL opens it from main's preview toolbar only (PD-35). */
  readonly openInBrowserFromChat: boolean;
}

const SHARED_DESIGN_TOOLS = [TOOL_INVENTORY, TOOL_EXTRACT_TOKENS, TOOL_IMPORT_ASSET, TOOL_RECORD_DECISION, TOOL_DESIGN_CHECK, TOOL_FINISH_DESIGN, TOOL_LOAD_DESIGN_SKILL, TOOL_MAP_REFERENCE, TOOL_REMOVE_DESIGN_FILE] as const;

const FULL: DesignRuleSet = {
  id: 'full',
  designTools: [...SHARED_DESIGN_TOOLS, TOOL_DESIGN_SCREENSHOT, TOOL_PREVIEW_JOURNEY, TOOL_DECLARE_TWEAKS, TOOL_OPEN_PREVIEW],
  parentTools: [TOOL_START_DESIGN, TOOL_DESIGN_PARITY],
  gate: { staticCheck: true, widthChecks: true, journeys: true },
  preview: true,
  openInBrowserFromChat: false,
};

const REDUCED: DesignRuleSet = {
  id: 'reduced',
  designTools: [...SHARED_DESIGN_TOOLS],
  parentTools: [TOOL_START_DESIGN],
  gate: { staticCheck: true, widthChecks: false, journeys: false },
  preview: false,
  openInBrowserFromChat: true,
};

/** FULL where the host has the design preview (desktop), REDUCED elsewhere (VS Code). */
export function designRuleSet(capabilities: Pick<HostCapabilities, 'designPreview'>): DesignRuleSet {
  return capabilities.designPreview ? FULL : REDUCED;
}

/** The rule set a design chat recorded in its role entry. */
export function designRuleSetById(id: DesignRuleSetId): DesignRuleSet {
  return id === 'full' ? FULL : REDUCED;
}

/** Every design tool name of either rule set, parent tools included; they run by settings rule, and nested agents never get one. */
export const DESIGN_PI_TOOL_NAMES: ReadonlySet<string> = new Set([...FULL.designTools, ...FULL.parentTools, ...REDUCED.designTools, ...REDUCED.parentTools]);

/** The design tools that write nothing into the chat's checkpointed folder, so never wait for its baseline (PD-42). */
export const DESIGN_TOOLS_WITHOUT_FOLDER_WRITES: ReadonlySet<string> = new Set([TOOL_START_DESIGN, TOOL_DESIGN_PARITY, TOOL_LOAD_DESIGN_SKILL, TOOL_DECLARE_TWEAKS, TOOL_OPEN_PREVIEW]);
