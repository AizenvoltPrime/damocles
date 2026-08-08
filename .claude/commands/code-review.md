Initiate @"Code Reviewer (agent)" that will only check the files that have uncommited changes and all the files related to them.

If the set of changed files is extensive, launch more than one Code Reviewer in parallel, splitting the work into coherent groups (e.g. by feature/module, by layer such as backend vs frontend, or by directory) so each reviewer owns a focused, related slice of the changes. Make sure every changed file (and its related files) is covered by exactly one reviewer, avoid overlap between groups, and keep tightly-coupled files in the same group so each reviewer has the context it needs. For a small changeset, a single Code Reviewer is sufficient.

## Reporting

Report **every** issue each reviewer found — never summarise to "the notable ones", never collapse a severity band into a count, never drop nits. Do not ask whether I want the full list; produce it directly.

Structure the final answer as one section per reviewer group, and within each group order findings by severity (Blocker → High → Medium → Low → Nit). For each finding keep the reviewer's `file:line`, the concrete problem, why it matters, and the suggested fix. Also carry over each group's "verified clean" notes and its verdict, and close with the total count per severity band.

Where two groups found the same underlying defect, report it in both places and note the link rather than deduplicating it away.

$ARGUMENTS
