import type { UserContentBlock, TextBlock } from "./types/content";

/** Strip the SDK's <tool_use_error> wrapper from a tool error string; returns input unchanged if absent. */
export function unwrapToolUseError(text: string): string {
  const match = text.match(/^\s*<tool_use_error>([\s\S]*)<\/tool_use_error>\s*$/);
  return (match?.[1] ?? text).trim();
}

/**
 * Escapes HTML special characters to prevent XSS when using v-html.
 */
export function escapeHtml(str: string): string {
  const htmlEscapes: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return str.replace(/[&<>"']/g, char => htmlEscapes[char] || char);
}

/**
 * Extracts display text from slash command XML wrappers.
 * Returns the command name with args (e.g., "/task fix the bug") or null if not a command wrapper.
 */
export function extractSlashCommandDisplay(content: string): string | null {
  if (!content.startsWith('<command-')) {
    return null;
  }

  const nameMatch = content.match(/<command-name>([^<]*)<\/command-name>/);
  if (!nameMatch) {
    return null;
  }

  const argsMatch = content.match(/<command-args>([^<]*)<\/command-args>/);
  const capturedName = nameMatch[1];
  if (!capturedName) return null;
  const commandName = capturedName.trim();
  const commandArgs = argsMatch?.[1]?.trim() || '';

  return commandArgs ? `${commandName} ${commandArgs}` : commandName;
}

/**
 * Formats a Claude model ID into a human-readable display name.
 * E.g., "claude-haiku-4-5-20251001" → "Haiku 4.5"
 */
export function formatModelDisplayName(modelId: string | undefined | null): string | null {
  if (!modelId) return null;

  const versionMatch = modelId.match(/(\d+)-(\d+)/);
  const version = versionMatch ? `${versionMatch[1]}.${versionMatch[2]}` : '';

  if (modelId.includes('fable')) return "Fable 5";
  if (modelId.includes('sonnet-5')) return "Sonnet 5";
  if (modelId.includes('opus')) return `Opus ${version}`.trim();
  if (modelId.includes('sonnet')) return `Sonnet ${version}`.trim();
  if (modelId.includes('haiku')) return `Haiku ${version}`.trim();

  return modelId.split('-').slice(1, 3).join(' ');
}

/**
 * Lowercase a string and collapse every run of non-alphanumeric characters into a single hyphen,
 * trimming leading/trailing hyphens. No length cap — callers slice as needed.
 */
export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

type ContentInput = string | UserContentBlock[];

export function hasImageContent(content: ContentInput): boolean {
  if (typeof content === "string") return false;
  return content.some((block) => block.type === "image");
}

export function extractTextFromContent(content: ContentInput, separator = "\n"): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join(separator);
}
