import type { ToolCatalogEntry } from '../../../shared/types/tools';
import {
  TOOL_DECLARE_TWEAKS,
  TOOL_DESIGN_CHECK,
  TOOL_DESIGN_PARITY,
  TOOL_EXTRACT_TOKENS,
  TOOL_FINISH_DESIGN,
  TOOL_IMPORT_ASSET,
  TOOL_DESIGN_SCREENSHOT,
  TOOL_INVENTORY,
  TOOL_LOAD_DESIGN_SKILL,
  TOOL_MAP_REFERENCE,
  TOOL_OPEN_PREVIEW,
  TOOL_PREVIEW_JOURNEY,
  TOOL_RECORD_DECISION,
  TOOL_REMOVE_DESIGN_FILE,
  TOOL_START_DESIGN,
} from '../../../shared/tool-names';

/** The design tools this build has; a rule set's other names stay inactive until their slice builds them. */
export const DESIGN_TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  { name: TOOL_START_DESIGN, label: 'StartDesign', description: 'Open a linked design chat for UI work.', group: 'design', toggleable: true },
  { name: TOOL_INVENTORY, label: 'Inventory', description: "Record the app's components, screens and types.", group: 'design', toggleable: true },
  { name: TOOL_EXTRACT_TOKENS, label: 'ExtractTokens', description: "Extract the app's design tokens and breakpoints.", group: 'design', toggleable: true },
  { name: TOOL_IMPORT_ASSET, label: 'ImportAsset', description: 'Copy a font or image into the design from the project, another file or an https URL.', group: 'design', toggleable: true },
  { name: TOOL_RECORD_DECISION, label: 'RecordDecision', description: 'Record a design decision made in chat.', group: 'design', toggleable: true },
  { name: TOOL_DESIGN_CHECK, label: 'DesignCheck', description: 'Check screens against the inventory and tokens.', group: 'design', toggleable: true },
  { name: TOOL_FINISH_DESIGN, label: 'FinishDesign', description: 'Finish a design version for the main chat.', group: 'design', toggleable: true },
  { name: TOOL_LOAD_DESIGN_SKILL, label: 'LoadDesignSkill', description: 'Load design skills whose hints DesignCheck checks.', group: 'design', toggleable: true },
  { name: TOOL_DESIGN_SCREENSHOT, label: 'Screenshot', description: 'Screenshot screens at every checked width.', group: 'design', toggleable: true },
  { name: TOOL_PREVIEW_JOURNEY, label: 'PreviewJourney', description: 'Run a scripted journey through a screen at every journey width.', group: 'design', toggleable: true },
  { name: TOOL_DECLARE_TWEAKS, label: 'DeclareTweaks', description: "Offer tweak controls whose stops are the app's tokens.", group: 'design', toggleable: true },
  { name: TOOL_MAP_REFERENCE, label: 'MapReference', description: 'Map a reference image onto the inventory and tokens.', group: 'design', toggleable: true },
  { name: TOOL_REMOVE_DESIGN_FILE, label: 'RemoveDesignFile', description: 'Remove a screen, variant or shared file of the design, with its records.', group: 'design', toggleable: true },
  { name: TOOL_OPEN_PREVIEW, label: 'OpenPreview', description: "Open or show a page's preview tab beside the design chat.", group: 'design', toggleable: true },
  { name: TOOL_DESIGN_PARITY, label: 'DesignParity', description: 'Score the running app against the linked design at each width.', group: 'design', toggleable: true },
];

export const BUILT_DESIGN_TOOL_NAMES: ReadonlySet<string> = new Set(DESIGN_TOOL_CATALOG.map((entry) => entry.name));
