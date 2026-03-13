import { describe, it, expect } from 'vitest';
import { extractCodeBlocks, stripPostCodeContent, detectFinalInModelResponse } from '../parsing';

// ─────────────────────────────────────────────────────────────────────────────
// extractCodeBlocks
// ─────────────────────────────────────────────────────────────────────────────

describe('extractCodeBlocks', () => {
  it('extracts a single repl block', () => {
    const text = 'Some text\n```repl\nconsole.log("hi")\n```\nMore text';
    expect(extractCodeBlocks(text)).toEqual(['console.log("hi")']);
  });

  it('extracts multiple repl blocks', () => {
    const text = '```repl\nconst a = 1;\n```\n\ntext\n\n```repl\nconst b = 2;\n```';
    expect(extractCodeBlocks(text)).toEqual(['const a = 1;', 'const b = 2;']);
  });

  it('returns empty array when no repl blocks exist', () => {
    expect(extractCodeBlocks('no code here')).toEqual([]);
    expect(extractCodeBlocks('```js\nconst x = 1;\n```')).toEqual([]);
    expect(extractCodeBlocks('```python\nprint("hi")\n```')).toEqual([]);
  });

  it('ignores empty repl blocks', () => {
    const text = '```repl\n\n```';
    expect(extractCodeBlocks(text)).toEqual([]);
  });

  it('trims whitespace inside blocks', () => {
    const text = '```repl\n  const x = 1;  \n```';
    expect(extractCodeBlocks(text)).toEqual(['const x = 1;']);
  });

  it('handles multiline code blocks', () => {
    const text = '```repl\nconst a = 1;\nconst b = 2;\nconsole.log(a + b);\n```';
    const blocks = extractCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('const a = 1;');
    expect(blocks[0]).toContain('const b = 2;');
    expect(blocks[0]).toContain('console.log(a + b);');
  });

  it('handles repl with extra whitespace after language tag', () => {
    const text = '```repl  \nconst x = 1;\n```';
    expect(extractCodeBlocks(text)).toEqual(['const x = 1;']);
  });

  it('does not match nested backticks inside code', () => {
    const text = '```repl\nconst s = "```";\nconsole.log(s);\n```';
    const blocks = extractCodeBlocks(text);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
  });

  it('handles consecutive blocks with no separator', () => {
    const text = '```repl\na();\n```\n```repl\nb();\n```';
    expect(extractCodeBlocks(text)).toEqual(['a();', 'b();']);
  });

  it('is idempotent across multiple calls (regex lastIndex reset)', () => {
    const text = '```repl\nfoo();\n```';
    expect(extractCodeBlocks(text)).toEqual(['foo();']);
    expect(extractCodeBlocks(text)).toEqual(['foo();']);
    expect(extractCodeBlocks(text)).toEqual(['foo();']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stripPostCodeContent
// ─────────────────────────────────────────────────────────────────────────────

describe('stripPostCodeContent', () => {
  it('strips text after the last repl block', () => {
    const text = 'prefix\n```repl\ncode();\n```\nthis should be stripped';
    const result = stripPostCodeContent(text);
    expect(result).toBe('prefix\n```repl\ncode();\n```');
  });

  it('strips text after the last of multiple repl blocks', () => {
    const text = '```repl\nfirst();\n```\nmiddle\n```repl\nsecond();\n```\nstripped';
    const result = stripPostCodeContent(text);
    expect(result).toBe('```repl\nfirst();\n```\nmiddle\n```repl\nsecond();\n```');
  });

  it('returns full text when no repl blocks exist', () => {
    const text = 'just some text without code';
    expect(stripPostCodeContent(text)).toBe(text);
  });

  it('returns full text when repl block is at the end', () => {
    const text = 'prefix\n```repl\ncode();\n```';
    expect(stripPostCodeContent(text)).toBe(text);
  });

  it('handles text with non-repl code blocks', () => {
    const text = '```js\ncode();\n```\nmore text';
    expect(stripPostCodeContent(text)).toBe(text);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectFinalInModelResponse
// ─────────────────────────────────────────────────────────────────────────────

describe('detectFinalInModelResponse', () => {
  describe('FINAL() detection', () => {
    it('detects FINAL with a simple string argument', () => {
      const text = 'Some analysis...\nFINAL("the answer")';
      const result = detectFinalInModelResponse(text);
      expect(result).toEqual({ type: 'final', value: 'the answer' });
    });

    it('detects FINAL with single quotes', () => {
      const text = "FINAL('the answer')";
      const result = detectFinalInModelResponse(text);
      expect(result).toEqual({ type: 'final', value: 'the answer' });
    });

    it('detects FINAL with backtick quotes', () => {
      const text = 'FINAL(`the answer`)';
      const result = detectFinalInModelResponse(text);
      expect(result).toEqual({ type: 'final', value: 'the answer' });
    });

    it('detects FINAL with multiline content', () => {
      const text = 'FINAL("line1\nline2\nline3")';
      const result = detectFinalInModelResponse(text);
      expect(result).toEqual({ type: 'final', value: 'line1\nline2\nline3' });
    });

    it('detects FINAL with trailing semicolon', () => {
      const text = 'FINAL("answer");';
      const result = detectFinalInModelResponse(text);
      expect(result).toEqual({ type: 'final', value: 'answer' });
    });

    it('ignores FINAL inside code blocks', () => {
      const text = '```repl\nFINAL("inside code")\n```';
      const result = detectFinalInModelResponse(text);
      expect(result).toBeNull();
    });

    it('detects FINAL outside code blocks when code blocks also exist', () => {
      const text = '```repl\nconst x = 1;\n```\n\nFINAL("outside code")';
      const result = detectFinalInModelResponse(text);
      expect(result).toEqual({ type: 'final', value: 'outside code' });
    });
  });

  describe('FINAL_VAR() detection', () => {
    it('detects FINAL_VAR with a variable name', () => {
      const text = 'FINAL_VAR("result")';
      const result = detectFinalInModelResponse(text);
      expect(result).toEqual({ type: 'final_var', value: 'result' });
    });

    it('detects FINAL_VAR with single quotes', () => {
      const text = "FINAL_VAR('myVar')";
      const result = detectFinalInModelResponse(text);
      expect(result).toEqual({ type: 'final_var', value: 'myVar' });
    });

    it('detects FINAL_VAR without quotes', () => {
      const text = 'FINAL_VAR(result)';
      const result = detectFinalInModelResponse(text);
      expect(result).toEqual({ type: 'final_var', value: 'result' });
    });

    it('detects FINAL_VAR with property access', () => {
      const text = 'FINAL_VAR(lastTurn.assistantResponse)';
      const result = detectFinalInModelResponse(text);
      expect(result).toEqual({ type: 'final_var', value: 'lastTurn.assistantResponse' });
    });

    it('prioritizes FINAL_VAR over FINAL when both present', () => {
      const text = 'FINAL_VAR("result")\nFINAL("direct value")';
      const result = detectFinalInModelResponse(text);
      expect(result).toEqual({ type: 'final_var', value: 'result' });
    });

    it('ignores FINAL_VAR inside code blocks', () => {
      const text = '```repl\nFINAL_VAR("x")\n```';
      const result = detectFinalInModelResponse(text);
      expect(result).toBeNull();
    });
  });

  describe('<FINAL> XML tag format', () => {
    it('detects <FINAL> tags', () => {
      const text = '<FINAL>the answer</FINAL>';
      const result = detectFinalInModelResponse(text);
      expect(result).toEqual({ type: 'final', value: 'the answer' });
    });

    it('detects <FINAL> tags case-insensitively', () => {
      const text = '<final>the answer</final>';
      const result = detectFinalInModelResponse(text);
      expect(result).toEqual({ type: 'final', value: 'the answer' });
    });

    it('trims whitespace in <FINAL> content', () => {
      const text = '<FINAL>  the answer  </FINAL>';
      const result = detectFinalInModelResponse(text);
      expect(result).toEqual({ type: 'final', value: 'the answer' });
    });

    it('handles multiline <FINAL> content', () => {
      const text = '<FINAL>\nline1\nline2\n</FINAL>';
      const result = detectFinalInModelResponse(text);
      expect(result).toEqual({ type: 'final', value: 'line1\nline2' });
    });
  });

  describe('edge cases', () => {
    it('returns null for empty text', () => {
      expect(detectFinalInModelResponse('')).toBeNull();
    });

    it('returns null when no FINAL pattern is found', () => {
      expect(detectFinalInModelResponse('just regular text')).toBeNull();
    });

    it('returns null for FINAL() with empty value', () => {
      expect(detectFinalInModelResponse('FINAL()')).toBeNull();
    });

    it('does not match partial FINAL keywords', () => {
      expect(detectFinalInModelResponse('FINALIZE("something")')).toBeNull();
    });

    it('handles FINAL with complex template literal content', () => {
      const text = 'FINAL("Turn 1: ${context[0].userMessage}")';
      const result = detectFinalInModelResponse(text);
      expect(result).not.toBeNull();
      expect(result?.type).toBe('final');
    });
  });
});
