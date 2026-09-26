Initiate @"Code Reviewer (agent)" that will only check the files that have uncommitted changes and all the files related to them.

**Tell every reviewer both hazards.** Work here is often staged but not committed, and sometimes only partly staged. The changed set is therefore `git diff HEAD`, which covers staged and unstaged edits together, plus `git status --short` for untracked files. A bare `git diff` is empty on a fully staged changeset, and `git diff --cached` misses unstaged edits.

Reviewers are read-only. No reviewer may run any command that writes the index, the working tree or `node_modules`, on any path, for any reason. That includes `git checkout`, `git restore`, `git stash`, `git reset`, `git clean`, `git add`, `git commit`, `npm install`, `npm ci` and `vitest -u`. A commit, for example, empties the diff the other reviewers are reading.

If the set of changed files is extensive, launch more than one Code Reviewer in parallel, splitting the work into coherent groups (e.g. by feature/module, by layer such as backend vs frontend, or by directory) so each reviewer owns a focused, related slice of the changes. Make sure every changed file (and its related files) is covered by exactly one reviewer, avoid overlap between groups, and keep tightly-coupled files in the same group so each reviewer has the context it needs. For a small changeset, a single Code Reviewer is sufficient.

## Reporting

Report **every** issue each reviewer found — never summarise to "the notable ones", never collapse a severity band into a count, never drop nits. Do not ask whether I want the full list; produce it directly.

Structure the report as one section per reviewer group, and within each group order findings by severity (Blocker → High → Medium → Low → Nit). For each finding keep the reviewer's `file:line`, the concrete problem, why it matters, and the suggested fix. Also carry over each group's "verified clean" notes and its verdict, and close with the total count per severity band.

Where two groups found the same underlying defect, report it once with a cross-reference: under the group whose scope owns it, naming the other group and the `file:line` it saw the same defect at. Never omit the second sighting outright. A second location is usually a second fix.

## Saving the results

Once every reviewer has returned, write the report described under "Reporting" to `CODE_REVIEW_<timestamp>.md` at the project root, with the timestamp taken from `date +%Y-%m-%d_%H%M%S`, run in Bash (PowerShell's `date` is `Get-Date`). The report goes in the file only; do not repeat it in chat. The chat answer is the path of the file written.

`CODE_REVIEW_*.md` files are review output, not changes under review: exclude them from the changed set handed to reviewers.

$ARGUMENTS
