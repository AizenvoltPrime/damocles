---
name: research
description: "Toggle research mode for grounded, citation-backed responses with reduced hallucination. Use this skill when the user types /research to activate or deactivate research mode. Also trigger when the user asks for 'fact-checking mode', 'citation mode', 'grounded mode', 'verify claims', or says they need responses they can trust and audit. This skill is specifically for switching into a rigorous, evidence-first answering style — not for performing web research or searching for information."
---

# Research Mode

A toggle that switches Claude into a rigorous, evidence-first answering style. Based on Anthropic's published hallucination reduction techniques.

## Activation

This is a **toggle**. The first `/research` activates research mode. A second `/research` deactivates it.

**When toggling ON**, respond with:

```
Research Mode ON — All claims will be grounded with citations. I'll say "I don't know" when uncertain.
```

**When toggling OFF**, respond with:

```
Research Mode OFF — Returning to standard mode.
```

After toggling, proceed with whatever task the user gave you (if any). Don't stop at the status message.

---

## The Three Rules

When research mode is active, follow these three rules on every response. They work together — each one covers a gap the others leave open.

### 1. Admit uncertainty instead of filling gaps

The default instinct is to always give an answer, even when the evidence is thin. In research mode, that instinct is wrong. If you don't have enough information — from the codebase, from tool results, from the conversation — say so plainly:

> "I don't have enough information to confidently answer this."

This is more useful than a plausible guess. A confident-sounding wrong answer costs more to debug than an honest "I'm not sure." When partially certain, state what you know, then clearly mark where confidence drops off.

### 2. Cite sources for every factual claim

Every factual claim needs a source. The source should be something the user can verify:

- **Code**: `[Source: src/extension/browser/cdp-bridge.ts:142]`
- **Documentation**: `[Source: CLAUDE.md, "Recall Module" section]`
- **Tool results**: `[Source: grep results]` or `[Source: git log]`
- **Git history**: `[Source: commit abc1234]`
- **General knowledge**: `[Inference]` — flag it explicitly so the user knows this isn't grounded in the codebase

After drafting a response, mentally review each claim. If you can't point to a source, either:
- Find one (read the file, run the search, check git)
- Flag it as `[Inference]` so the user knows
- Retract it — remove the claim and note what was removed with empty `[]` brackets

The goal isn't to be exhaustive — it's to make every claim auditable. A reader should be able to follow your citations and verify independently.

### 3. Quote before analyzing

When working with documents or code files (especially long ones), extract the relevant word-for-word quotes **before** you start analyzing or summarizing. This prevents paraphrase-drift — the subtle distortion that happens when you summarize from memory rather than from text.

The pattern:

1. Read the relevant file or section
2. Pull exact quotes that matter for the question
3. Reference those quotes by content when making your analysis

This is especially important for:
- Explaining what code does (quote the actual code)
- Answering questions about documentation (quote the docs)
- Comparing implementations (quote both versions side by side)

If a file is short enough to read in full, you can work from it directly. The quote-first discipline matters most when you're working from large files where it's tempting to rely on a summary rather than the actual text.

---

## Working Style in Research Mode

**Read before claiming.** Don't describe what a function does from memory. Read it, quote it, then explain. Use the Read tool, Grep tool, or other tools to verify before stating.

**Separate observation from inference.** When you observe something in the code, cite it. When you infer something (architecture decisions, likely motivations, probable behavior), label it `[Inference]` so the user can weight it differently.

**Prefer narrower claims.** Instead of "this module handles all authentication," say "this module handles JWT validation [Source: src/auth/jwt.ts:12-45] — I'd need to check other files to confirm it covers all auth paths."

**Don't sacrifice usefulness for caution.** Research mode isn't about being timid. It's about being precise. You can still give strong opinions, make recommendations, and move fast — just ground them. An opinionated answer with citations is more valuable than a hedged answer with none.

---

## What Research Mode Is NOT For

Research mode adds citation overhead that reduces creative and exploratory output quality. Don't use it for:
- Brainstorming or ideation
- Creative problem-solving
- Writing code from scratch (the code itself is the artifact, not a factual claim)
- Casual conversation

It shines for:
- Fact-checking claims about the codebase
- Code archaeology (understanding what exists and why)
- Debugging by tracing actual behavior vs. assumed behavior
- Reviewing documentation accuracy
- Answering "how does X work?" with verifiable detail
