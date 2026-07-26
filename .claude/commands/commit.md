Commit the current changes, then push. This command is the user's explicit request to commit and push.

## Inspect state first

Run in parallel:
- `git status` (never the `-uall` flag — it can OOM on large repos)
- `git diff` for both staged and unstaged changes
- `git log` to match this repo's commit message style

## Stage

- Stage specific files by name. Avoid `git add -A` / `git add .` — they can sweep in secrets or large binaries.
- Never stage secrets (`.env`, `credentials.json`, etc.). Warn the user if they explicitly ask to commit such a file.

## Message

- Follow Conventional Commits (https://www.conventionalcommits.org/en/v1.0.0/): `type(scope): summary`.
- Keep it concise and explain the "why", not just the "what".
- Pass multi-line messages via a HEREDOC:

```
git commit -m "$(cat <<'EOF'
type(scope): summary

why this change
EOF
)"
```

### Choosing the type

Derive the type from **the diff you just read**, never from what the previous commit happened to be. A version bump sitting in the diff does not make a changeset a release chore — look at what the source files actually do.

| Type | When |
| --- | --- |
| `feat` | New user-visible capability, new tool, new setting, new behavior |
| `fix` | Corrects behavior that was wrong (bugs, unsound logic, security holes) |
| `perf` | Same behavior, measurably cheaper |
| `refactor` | Restructuring with no behavior change |
| `test` | Only test files changed |
| `docs` | Only prose/docs changed |
| `build` / `ci` | Only build config, deps, or pipeline changed |
| `chore` | Nothing else fits — housekeeping with no product effect |

`chore` is the last resort, not the default. Reserve `chore(release)` for a commit that **only** bumps the version and rearranges the changelog. If the same commit also ships source changes, name the dominant source change instead and mention the bump in the body.

When a changeset mixes types, pick the one carrying the most user-visible weight (`feat` > `fix` > everything else) and cover the rest in the body. Split into separate commits when the parts are genuinely independent.

Scope is the module the change lives in. Reuse the scope names already in `git log` rather than inventing one; omit the scope if none fits.

## Safety

- Create a NEW commit; never `--amend` unless the user asks.
- Never `--no-verify` / skip hooks.
- Never force-push to main/master (warn the user if they request it).
- On pre-commit-hook failure the commit did NOT happen — fix the issue, re-stage, and create a NEW commit (do not `--amend`).

## Push

- After a successful commit, push — unless the user said otherwise.

$ARGUMENTS
