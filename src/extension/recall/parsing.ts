const REPL_BLOCK_PATTERN = /```repl\s*\n([\s\S]*?)```/g;
const FINAL_VAR_LINE_PATTERN = /\bFINAL_VAR\(\s*["']([^"']+)["']\s*\)/;
const FINAL_CALL_LINE_PATTERN = /\bFINAL\(\s*(.*)\s*\)$/;

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

export interface FinalResult {
  type: 'final' | 'final_var';
  value: string;
}

export function detectFinal(text: string): FinalResult | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;

    const varMatch = FINAL_VAR_LINE_PATTERN.exec(line);
    if (varMatch?.[1]) {
      return { type: 'final_var', value: varMatch[1] };
    }

    const callMatch = FINAL_CALL_LINE_PATTERN.exec(line);
    if (callMatch?.[1]) {
      return { type: 'final', value: callMatch[1].trim() };
    }

    break;
  }

  return null;
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
  const finalMatch = /\bFINAL\(([\s\S]+)\)\s*$/.exec(stripped);
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
