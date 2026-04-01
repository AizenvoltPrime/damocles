<instruction>
Create a structured implementation plan for the given task. This command produces a plan — it does NOT implement anything.
</instruction>

<approach>
Ultrathink step-by-step. For every task:

1. Gather requirements through clarifying questions
2. Explore the codebase to understand existing patterns and integration points
3. Produce a structured plan

At any point during this process, use the AskUserQuestion tool to ask clarifying questions whenever something is unclear or ambiguous. Do not assume — ask. </approach>

<phase name="1-requirement-gathering">
Before planning, fully understand the user's intent using the AskUserQuestion tool.

<when-to-ask>
Ask clarifying questions when the initial prompt is ambiguous about:

- Problem/Goal: What problem does this solve? What's the primary objective?
- Core Functionality: What are the key actions or behaviors?
- Scope/Boundaries: What should it NOT do? What's out of scope?
- Target Users: Who will use this? What are their constraints?
- Success Criteria: How do we know it's done correctly? </when-to-ask>

<how-to-ask>
Use the AskUserQuestion tool with 2-4 options per question. Structure questions to allow quick selection:

```
Question: "What is the primary goal of this feature?"
Options:
- Improve user onboarding experience
- Increase user retention
- Reduce support burden
```

Do not assume requirements — when in doubt, ask. </how-to-ask> </phase>

<phase name="2-codebase-analysis">
Use the Plan subagent (subagent_type: "Plan") to explore the codebase. It is read-only — it cannot modify files. Use it to:

- Identify existing patterns, components, and utilities to reuse
- Map integration points with existing systems
- Discover database schema relationships relevant to the task
- Find similar implementations to follow as reference

Pass the Plan subagent specific questions derived from Phase 1, not open-ended exploration requests. </phase>

<phase name="3-plan-authoring">
Structure the plan with these sections:

<plan-section name="1-overview">
Brief description of the feature and the problem it solves.
</plan-section>

<plan-section name="2-goals">
Specific, measurable objectives (bullet list).
</plan-section>

<plan-section name="3-user-stories">
Each story needs:
- Title: Short descriptive name
- Description: "As a [user], I want [feature] so that [benefit]"
- Acceptance Criteria: Verifiable checklist of what "done" means

Each story should be small enough to implement in one focused session.

Format:

```markdown
### US-001: [Title]

**Description:** As a [user], I want [feature] so that [benefit].

**Acceptance Criteria:**

- [ ] Specific verifiable criterion
- [ ] Another criterion
- [ ] Typecheck/lint passes
- [ ] **[UI changes only]** Verify in browser
```

Important:

- Acceptance criteria must be verifiable, not vague
- "Works correctly" is bad
- "Button shows confirmation dialog before deleting" is good </plan-section>

<plan-section name="4-functional-requirements">
Numbered list of specific functionalities:
- "FR-1: The system must allow users to..."
- "FR-2: When a user clicks X, the system must..."

Be explicit and unambiguous. </plan-section>

<plan-section name="5-non-goals">
What this feature will NOT include. Critical for managing scope.
</plan-section>

<plan-section name="6-technical-considerations">
- Existing components and patterns to reuse (with file paths)
- Database schema changes needed
- API contracts (endpoints, request/response shapes)
- Dependencies between user stories (implementation order)
- Performance or security considerations
</plan-section>

<plan-section name="7-execution-strategy">
Map each user story (or logical group of stories) to a concrete execution plan for `/implement`.

<subsection name="agent-assignment">
For each unit of work, specify:
- Which subagent type from the available agents best fits the work (e.g., Backend Architect, Frontend Developer, Database Optimizer, Security Engineer)
- Why that agent is the right choice for this piece
</subsection>

<subsection name="sequencing">
Organize work into ordered steps and parallel groups:

```markdown
Step 1 (sequential): US-001 — Database migrations + models → Backend Architect Step 2 (parallel):

- US-002 — API controllers + policies → Backend Architect
- US-003 — TypeScript types + API module → Frontend Developer Step 3 (sequential): US-004 — Vue pages + components → Frontend Developer
```

- Steps run in order — a step only starts after the previous step completes
- Work within a parallel group has no shared files or data dependencies
- Database/migration work always comes first
- Frontend work that depends on API contracts must come after those contracts are built </subsection>

<subsection name="context-handoff">
For each agent dispatch, specify exactly what context the agent needs to receive:
- Requirements: which user stories and acceptance criteria it owns
- File paths: existing files to read or modify
- Contracts: API shapes, types, database schemas produced by earlier steps
- Patterns: existing code patterns or components to follow as reference
- Constraints: anything the agent must NOT do or must be careful about

Agents start with zero context — if it's not in the handoff, the agent doesn't know it. </subsection> </plan-section>

<plan-section name="8-open-questions">
Remaining questions or areas needing clarification before implementation.
</plan-section>
</phase>

<writing-guidelines>
Plans will be read by AI agents and developers. Therefore:

- Be explicit and unambiguous
- Include file paths when referencing existing code
- Provide enough detail to understand purpose and core logic
- Number requirements for easy reference
- Use concrete examples where helpful
- Specify exact API contracts — agents cannot infer them </writing-guidelines>

<task>
$ARGUMENTS
</task>
