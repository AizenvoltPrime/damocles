/**
 * The Tools panel contract (webview ↔ extension). Every agent tool is grouped by subsystem and
 * carries a per-tool enable switch; each subsystem carries a master switch + availability flag.
 * The catalog (`ToolCatalogEntry`) is assembled in `pi-session/tools/tool-catalog.ts`; the live
 * snapshot (`ToolsSnapshot`) is produced by `ChatSession.getToolStatus()`.
 */

/** Subsystem a tool belongs to. `core` tools are always on; the rest gate on a subsystem flag. */
export type ToolGroup = 'core' | 'memory' | 'compass' | 'browser' | 'web' | 'subagents' | 'team';

/** A tool's static identity: its active-set name, panel label, blurb, group, and whether it toggles. */
export interface ToolCatalogEntry {
  /** Active-set name: PascalCase for module tools, runtime name for web/core built-ins. */
  name: string;
  /** Human-friendly panel label. */
  label: string;
  /** One-line panel blurb. */
  description?: string;
  group: ToolGroup;
  /** Core built-ins are locked on (`false`); module + web tools toggle (`true`). */
  toggleable: boolean;
}

/** A catalog entry plus its live enabled state, sent to the webview. */
export interface ToolStatusInfo extends ToolCatalogEntry {
  enabled: boolean;
}

/** A subsystem's master state: whether it is enabled, and whether its tools are available at all. */
export interface ToolGroupStatus {
  group: ToolGroup;
  /** The subsystem's master switch (its enable config). */
  enabled: boolean;
  /** Whether the subsystem is wired into this session (always true for core). */
  available: boolean;
}

/** The full Tools-panel snapshot: per-group master state + every tool's live state. */
export interface ToolsSnapshot {
  groups: ToolGroupStatus[];
  tools: ToolStatusInfo[];
}
