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

## Safety

- Create a NEW commit; never `--amend` unless the user asks.
- Never `--no-verify` / skip hooks.
- Never force-push to main/master (warn the user if they request it).
- On pre-commit-hook failure the commit did NOT happen — fix the issue, re-stage, and create a NEW commit (do not `--amend`).

## Push

- After a successful commit, push — unless the user said otherwise.

$ARGUMENTS
