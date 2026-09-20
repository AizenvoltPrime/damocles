Check these code review results and fix whichever are valid with best practice no bandaid fix solutions and use AskUserQuestion tool to ask me clarifying questions if needed:

$ARGUMENTS

## Fixing

Group the valid findings so each unit of work is a coherent set rather than a grab bag: a specialist carrying two unrelated subsystems in context does worse on both.

Then pick the smallest mechanism that fits each group:

- **Fix it yourself** when the group is a handful of edits in files you have already read. Delegation costs more than the fix.
- **One specialist subagent** (`Agent` with the `subagent_type` matching the subsystem, e.g. `Frontend Developer`, `Backend Architect`, `Accessibility Auditor`, `Test Automation Engineer`) when the group is focused but large enough to be worth handing off, or when the result set would bloat this context.
- **An agent team** only when a group genuinely needs several perspectives at once or an independent reviewer — a security-sensitive change, a cross-cutting redesign, a fix whose correctness is contested. Use as few teams as the work allows and give each a `brief` scoped to its group.

Verify each unit of work yourself before starting the next.
