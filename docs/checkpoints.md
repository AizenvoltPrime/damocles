# Checkpoints, rewind and forking

This page covers file checkpoints, rewinding files and conversations, forking a conversation into a new panel, and rewinding to before a compaction.

## Entry points

Track file changes and rewind to any previous state, or fork the conversation into a new panel without touching the source. There are three entry points:

- the Rewind Browser (`/rewind`)
- the inline rewind button on any user message bubble (hover to reveal)
- `Escape Escape`

## Restore options

The Restore Options modal offers three actions:

- **Fork conversation**: a new panel branched at the selected message; the source is untouched.
- **Roll back files**: restore the workspace; the conversation stays linear.
- **Fork and roll back files**: both.

The "files affected" list is the **live diff** between the workspace now and the checkpoint, so files you deleted since are flagged for restore; clicking a file opens a side-by-side diff.

A rollback first saves your current files, and the Rewind Browser lists each saved state with **Undo rewind** to put them back. A hard restore recreates deleted files and drops ones created after.

Forked panels inherit the source's settings, hydrate history up to the fork point, and pre-fill the rewound prompt. A fork also copies the subagent and team data its conversation had at the fork point, so agent cards keep their history and an interrupted agent, including a team cancelled before the fork, can be resumed in the fork.

## How checkpoints are stored

Checkpoints are backed by one shadow git repo per folder, shared by the folder's conversations and kept entirely separate from your real repo.

A turn's first checkpoint runs in the background, so the reply streams at once; only tools that change files wait for it, up to `damocles.checkpoints.baselineWaitSeconds`, after which the tool runs and that turn is marked not rewindable.

Video, audio, archives, disk images, model weights, Git LFS files and any file over `damocles.checkpoints.maxFileSizeMB` are left out of checkpoints, and so are build and cache folders except for files your project's git tracks there. The rewind view lists what a checkpoint left out under "Not restored by this checkpoint", and a rewind never changes, deletes or restores those files.

A background sweep (shortly after activation, then roughly daily) keeps these shadow repos small, repacking each one so per-turn snapshots delta-compress (rewind history stays fully intact) and removing the checkpoints of any conversation idle beyond `damocles.checkpoints.retentionDays` (default 30; `0` keeps history forever).

A chat with no project folder (no folder open in VS Code, no project loaded on the desktop) runs in your home folder and takes no file checkpoints: each prompt still rewinds and forks the conversation, and the rewind view says why its file options are off.

## Rewind to before compaction

After a conversation is compacted, you can recover the full pre-compaction context. The compaction boundary card carries a **Rewind to before compaction** action, and compaction points also appear in the Rewind Browser (`/rewind`) alongside prompt anchors.

Because Damocles captures a workspace snapshot at each compaction, a compaction point is a **full rewind anchor**: selecting one (from either entry point) opens the Restore Options modal with file counts and per-file diffs, so you can roll workspace files back to the at-compaction state, fork the complete un-summarized conversation into a new panel, or do both. The picker marks these anchors with a file-count badge. Older sessions with no captured snapshot keep the conversation-only fork (source untouched).

This works for manual (`/compact`) and automatic compaction, on live and resumed sessions. A confirmation notes that turns taken after the compaction aren't carried over and that the restored (large) context may re-trigger auto-compaction.
