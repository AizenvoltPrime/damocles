/**
 * Maps a tool name to its themed Tailwind class string.
 * Shared between ToolBadge.vue and the +N overflow chip in PromptNavigator.vue
 * so the overflow badge falls back to the neutral palette.
 */
export function getToolColorClass(name: string): string {
  if (name === "Bash" || name === "PowerShell") {
    return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
  }
  if (name === "Write" || name === "Edit" || name === "MultiEdit") {
    return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  }
  if (name === "Read" || name === "Grep" || name === "Glob") {
    return "bg-sky-500/15 text-sky-300 border-sky-500/30";
  }
  return "bg-muted text-muted-foreground border-border";
}
