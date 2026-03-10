const REPL_BLOCK_PATTERN = /```repl\s*\n([\s\S]*?)```/g;

export function extractCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  REPL_BLOCK_PATTERN.lastIndex = 0;
  let match;
  while ((match = REPL_BLOCK_PATTERN.exec(text)) !== null) {
    const block = match[1]?.trim();
    if (block) blocks.push(block);
  }
  return blocks;
}

export function stripPostCodeContent(text: string): string {
  const pattern = /```repl\s*\n[\s\S]*?```/g;
  let lastMatchEnd = -1;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    lastMatchEnd = match.index + match[0].length;
  }
  if (lastMatchEnd === -1) return text;
  return text.slice(0, lastMatchEnd);
}

export interface FinalResult {
  type: 'final' | 'final_var';
  value: string;
}

export function detectFinalInModelResponse(text: string): FinalResult | null {
  // Strip code blocks to avoid matching FINAL inside ```repl blocks
  const stripped = text.replace(/```[\s\S]*?```/g, '');

  // FINAL_VAR — capture any expression inside parens, strip surrounding quotes
  // Original RLM: r"^\s*FINAL_VAR\((.*?)\)" with re.MULTILINE | re.DOTALL
  const varMatch = /\bFINAL_VAR\(\s*([\s\S]*?)\s*\)/.exec(stripped);
  if (varMatch?.[1]) {
    const raw = varMatch[1].trim().replace(/^["']|["']$/g, '');
    if (raw) return { type: 'final_var', value: raw };
  }

  // FINAL — greedy multiline match anchored to end of text
  // Original RLM: r"^\s*FINAL\((.*)\)\s*$" with re.MULTILINE | re.DOTALL
  // [\s\S]+ is the JS equivalent of .+ with re.DOTALL
  const finalMatch = /\bFINAL\(([\s\S]+)\)\s*;?\s*$/.exec(stripped);
  if (finalMatch?.[1]) {
    let value = finalMatch[1].trim();
    const unquoted = value.replace(/^(["'`])([\s\S]*)\1$/, '$2');
    if (unquoted) value = unquoted;
    if (value) return { type: 'final', value };
  }

  // <FINAL>...</FINAL> XML tag format — models sometimes use this variant
  const tagMatch = /<FINAL>\s*([\s\S]+?)\s*<\/FINAL>/i.exec(stripped);
  if (tagMatch?.[1]) {
    return { type: 'final', value: tagMatch[1].trim() };
  }

  return null;
}
