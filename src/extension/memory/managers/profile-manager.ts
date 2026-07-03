import * as vscode from 'vscode';
import { log } from '../../logger';
import type { UserProfile } from '@shared/types/memory';
import type { DatabaseInstance } from '../types';
import type { MemoryWriteQueue } from '../write-queue';
import type { MemorySubCallRunner } from '../subcall-runner';
import { estimateTokens } from '../token-estimate';

type ProfileScope = 'project' | 'global';
type ProfileSection = 'static' | 'dynamic';

interface ProfileSectionRow {
  section: ProfileSection;
  content: string;
}

interface MemoryContentRow {
  content: string;
}

const RECENT_MEMORY_LIMIT = 40;
const STATIC_CHAR_CAP = 1200;
const DYNAMIC_CHAR_CAP = 600;

const PROFILE_SYSTEM_PROMPT =
  "Maintain a concise user/project profile. 'static' = durable, stable facts and preferences. " +
  "'dynamic' = a short summary of recent activity and current focus. " +
  'Update from the prior profile + recent memories; keep each section tight. ' +
  "Keep 'static' under ~1200 characters and 'dynamic' under ~600 characters. " +
  "Every statement in 'static' must derive from the prior profile or the listed memories — " +
  'never invent facts about the user.';

const PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    static: { type: 'string' },
    dynamic: { type: 'string' },
  },
  required: ['static', 'dynamic'],
  additionalProperties: false,
} satisfies Record<string, unknown>;

/**
 * Shape guard for the `profile` sub-call output: the runner's `T` is an unvalidated cast, so a
 * hallucinated shape (missing or non-string sections) would reach `value.static.slice(...)` and
 * throw. Narrows to a real {@link UserProfile}; an invalid shape is a logged no-op skip at the call site.
 */
export function isUserProfileShape(v: unknown): v is UserProfile {
  if (!v || typeof v !== 'object') return false;
  const p = v as { static?: unknown; dynamic?: unknown };
  return typeof p.static === 'string' && typeof p.dynamic === 'string';
}

/** How far back from the hard cut to look for a natural boundary. */
const BOUNDARY_LOOKBACK = 200;

/**
 * Cap `text` to `cap` chars without slicing through a word: prefer a sentence boundary within the
 * last {@link BOUNDARY_LOOKBACK} chars, else the last space, else a hard cut. Result is right-trimmed.
 */
export function truncateAtBoundary(text: string, cap: number): string {
  if (text.length <= cap) return text;

  const cut = text.slice(0, cap);
  const searchFrom = Math.max(0, cut.length - BOUNDARY_LOOKBACK);

  // Rightmost sentence boundary in the lookback window: punctuation boundaries keep the punctuation
  // (idx + 1); a newline cut drops the newline (idx).
  let sentenceEnd = -1;
  for (const marker of ['. ', '! ', '? ']) {
    const idx = cut.lastIndexOf(marker);
    if (idx >= searchFrom) sentenceEnd = Math.max(sentenceEnd, idx + 1); // keep the punctuation
  }
  const newlineIdx = cut.lastIndexOf('\n');
  if (newlineIdx >= searchFrom) sentenceEnd = Math.max(sentenceEnd, newlineIdx); // drop the newline
  if (sentenceEnd >= 0) return cut.slice(0, sentenceEnd).replace(/\s+$/, '');

  const spaceIdx = cut.lastIndexOf(' ');
  if (spaceIdx >= 0) return cut.slice(0, spaceIdx).replace(/\s+$/, '');

  // No boundary fits (one long unbroken token): hard-cut at the cap.
  return cut.replace(/\s+$/, '');
}

function renderSection(tag: ProfileSection, content: string): string {
  return `<${tag}>${content}</${tag}>`;
}

function renderScope(tag: ProfileScope, profile: UserProfile): string | null {
  const sections: string[] = [];
  if (profile.static.trim()) sections.push(renderSection('static', profile.static.trim()));
  if (profile.dynamic.trim()) sections.push(renderSection('dynamic', profile.dynamic.trim()));
  if (sections.length === 0) return null;
  return `<${tag}>\n${sections.join('\n')}\n</${tag}>`;
}

/**
 * Owns the auto-maintained user profile: a stable `static` section plus a recent-activity `dynamic`
 * section, stored per scope in `memory_profile`. Reads degrade to empty sections; `updateProfile`
 * skips the write when the sub-call yields no value.
 */
export class ProfileManager {
  private db: DatabaseInstance;
  private writeQueue: MemoryWriteQueue;
  private runner: MemorySubCallRunner;

  constructor(db: DatabaseInstance, writeQueue: MemoryWriteQueue, runner: MemorySubCallRunner) {
    this.db = db;
    this.writeQueue = writeQueue;
    this.runner = runner;
  }

  /** Read both sections for one scope; missing sections resolve to ''. Pass workspace='' for global. */
  getProfile(scope: ProfileScope, workspace: string): UserProfile {
    const rows = this.db
      .prepare('SELECT section, content FROM memory_profile WHERE scope = ? AND workspace = ?')
      .all(scope, workspace) as ProfileSectionRow[];

    const profile: UserProfile = { static: '', dynamic: '' };
    for (const row of rows) {
      if (row.section === 'static') profile.static = row.content;
      else if (row.section === 'dynamic') profile.dynamic = row.content;
    }
    return profile;
  }

  /** Upsert one section's content under the write queue. */
  setProfileSection(scope: ProfileScope, workspace: string, section: ProfileSection, content: string): Promise<void> {
    return this.writeQueue.run(() => {
      this.upsertSection(scope, workspace, section, content);
    });
  }

  /**
   * Regenerate both profile sections for one scope from the prior profile plus the most recent
   * live fact/preference memories. Skips the write when the sub-call returns no value (graceful
   * degrade); otherwise upserts both sections atomically under the write queue, hard-capping length.
   */
  async updateProfile(scope: ProfileScope, workspace: string): Promise<void> {
    const recent = this.recentMemories(scope, workspace);
    const prior = this.getProfile(scope, workspace);

    // CAS: snapshot each section's updated_at before the ~45s LLM call. A concurrent user edit bumps
    // it; we re-compare inside the post-LLM transaction and skip the moved section so the edit wins.
    const beforeStatic = this.sectionUpdatedAt(scope, workspace, 'static');
    const beforeDynamic = this.sectionUpdatedAt(scope, workspace, 'dynamic');

    const { value } = await this.runner.run<UserProfile>({
      purpose: 'profile',
      systemPrompt: PROFILE_SYSTEM_PROMPT,
      prompt: this.buildUpdatePrompt(prior, recent),
      schema: PROFILE_SCHEMA,
    });

    if (value === null) return;
    if (!isUserProfileShape(value)) {
      log('[ProfileManager] profile sub-call returned an invalid shape; skipping profile update (no-op): %o', value);
      return;
    }

    const nextStatic = truncateAtBoundary(value.static, STATIC_CHAR_CAP);
    const nextDynamic = truncateAtBoundary(value.dynamic, DYNAMIC_CHAR_CAP);

    // CAS commit: re-read updated_at inside the transaction and upsert only if unchanged since the
    // snapshot. Re-read + upsert share one transaction, so there's no TOCTOU window.
    await this.writeQueue.run(() => {
      if (this.sectionUpdatedAt(scope, workspace, 'static') === beforeStatic) {
        this.upsertSection(scope, workspace, 'static', nextStatic);
      }
      if (this.sectionUpdatedAt(scope, workspace, 'dynamic') === beforeDynamic) {
        this.upsertSection(scope, workspace, 'dynamic', nextDynamic);
      }
    });
  }

  /**
   * Build the `<user_profile>` injection block from the project and global profiles, omitting empty
   * sections. Returns '' when disabled or empty. Enforces `tokenBudget` by dropping lowest-priority
   * content (global dynamic, then project dynamic) while keeping static content.
   */
  buildProfileInjection(workspace: string, tokenBudget: number): string {
    const cfg = vscode.workspace.getConfiguration('damocles.memory');
    const enabled = cfg.get<boolean>('profile.enabled', true) ?? true;
    if (!enabled) return '';

    const project = this.getProfile('project', workspace);
    const global = this.getProfile('global', '');

    const render = (proj: UserProfile, glob: UserProfile): string => {
      const scopes: string[] = [];
      const projectBlock = renderScope('project', proj);
      const globalBlock = renderScope('global', glob);
      if (projectBlock) scopes.push(projectBlock);
      if (globalBlock) scopes.push(globalBlock);
      if (scopes.length === 0) return '';
      return `<user_profile>\n${scopes.join('\n')}\n</user_profile>`;
    };

    const trims: Array<() => void> = [
      () => {
        global.dynamic = '';
      },
      () => {
        project.dynamic = '';
      },
    ];

    let output = render(project, global);
    for (const trim of trims) {
      if (output === '' || estimateTokens(output) <= tokenBudget) break;
      trim();
      output = render(project, global);
    }

    if (output !== '' && estimateTokens(output) > tokenBudget) {
      log(
        '[ProfileManager] Profile injection (~%d tokens) exceeds budget (%d) after trimming dynamics; static sections kept',
        estimateTokens(output),
        tokenBudget,
      );
    }

    return output;
  }

  /** The `updated_at` stamp of one section, or `null` when missing. Backs the CAS in {@link updateProfile}. */
  private sectionUpdatedAt(scope: ProfileScope, workspace: string, section: ProfileSection): number | null {
    const row = this.db
      .prepare('SELECT updated_at FROM memory_profile WHERE scope = ? AND workspace = ? AND section = ?')
      .get(scope, workspace, section) as { updated_at: number } | undefined;
    return row ? row.updated_at : null;
  }

  private upsertSection(scope: ProfileScope, workspace: string, section: ProfileSection, content: string): void {
    this.db
      .prepare(
        `INSERT INTO memory_profile (scope, workspace, section, content, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(scope, workspace, section)
         DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
      )
      .run(scope, workspace, section, content, Date.now());
  }

  private recentMemories(scope: ProfileScope, workspace: string): string[] {
    const baseFilter = "kind IN ('fact', 'preference') AND is_latest = 1 AND forgotten = 0";
    const sql =
      scope === 'project'
        ? `SELECT content FROM memories WHERE ${baseFilter} AND workspace = ? ORDER BY updated_at DESC LIMIT ?`
        : `SELECT content FROM memories WHERE ${baseFilter} AND scope = 'global' ORDER BY updated_at DESC LIMIT ?`;

    const params: unknown[] = scope === 'project' ? [workspace, RECENT_MEMORY_LIMIT] : [RECENT_MEMORY_LIMIT];
    const rows = this.db.prepare(sql).all(...params) as MemoryContentRow[];
    return rows.map(row => row.content);
  }

  private buildUpdatePrompt(prior: UserProfile, recent: string[]): string {
    const priorBlock = `Prior profile:\nstatic: ${prior.static || '(empty)'}\ndynamic: ${prior.dynamic || '(empty)'}`;
    const memoriesBlock = recent.length > 0 ? recent.map(content => `- ${content}`).join('\n') : '(none)';
    return `${priorBlock}\n\nRecent memories:\n${memoriesBlock}`;
  }
}
