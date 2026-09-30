import type { SettingsStore } from '../../../platform/settings-store';
import { log } from '../../logger';
import type { UserProfile } from '@shared/types/memory';
import type { DatabaseInstance } from '../types';
import type { MemoryWriteQueue } from '../write-queue';
import type { MemorySubCallRunner } from '../subcall-runner';
import { estimateTokens } from '../token-estimate';
import { USEFULNESS_RUBRIC } from '../rubric';
import { neutralizeTags } from '../injection/render';

export type ProfileScope = 'project' | 'global';
export type ProfileSection = 'static' | 'dynamic';

interface ProfileSectionRow {
  section: ProfileSection;
  content: string;
}

interface MemoryContentRow {
  content: string;
}

const RECENT_MEMORY_LIMIT = 40;
const PREFERENCE_LIMIT = 40;
export const STATIC_CHAR_CAP = 1200;
export const DYNAMIC_CHAR_CAP = 600;

export const PROFILE_SYSTEM_PROMPT: string = `Maintain a concise profile for one scope: either one project (a repository) or global (the user and their machine across projects).

'static' holds only identity and environment facts that change how an agent works in this scope: who the user is, the machine, toolchains, services, and conventions of the codebase. A project profile holds only facts about that project. A global profile holds only facts that apply across projects.
'dynamic' is the current focus in this scope: what the user is working on now and what comes next, so a new conversation can pick up the thread.

Never restate a preference listed under "Preferences already injected verbatim". Those reach the agent word for word, so repeating them wastes tokens and drifts from the source.
Drop any prior-profile line that fails the usefulness test below or belongs to another scope; do not carry it forward.

${USEFULNESS_RUBRIC}

Keep 'static' under ~1200 characters and 'dynamic' under ~600 characters. Every statement must derive from the prior profile or the listed memories; never invent facts about the user.`;

export const PROFILE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    static: { type: 'string' },
    dynamic: { type: 'string' },
  },
  required: ['static', 'dynamic'],
  additionalProperties: false,
};

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
  return `<${tag}>${neutralizeTags(content)}</${tag}>`;
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
  private readonly settings: SettingsStore;

  constructor(db: DatabaseInstance, writeQueue: MemoryWriteQueue, runner: MemorySubCallRunner, settings: SettingsStore) {
    this.settings = settings;
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
   * live fact/episode memories. Skips the write when the sub-call returns no value (graceful
   * degrade); otherwise upserts both sections atomically under the write queue, hard-capping length.
   */
  async updateProfile(scope: ProfileScope, workspace: string): Promise<void> {
    const prior = this.getProfile(scope, workspace);

    // CAS: snapshot each section's updated_at before the ~45s LLM call. A concurrent user edit bumps
    // it; we re-compare inside the post-LLM transaction and skip the moved section so the edit wins.
    const beforeStatic = this.sectionUpdatedAt(scope, workspace, 'static');
    const beforeDynamic = this.sectionUpdatedAt(scope, workspace, 'dynamic');

    const { value } = await this.runner.run<UserProfile>({
      purpose: 'profile',
      systemPrompt: PROFILE_SYSTEM_PROMPT,
      prompt: this.buildUpdatePrompt(scope, workspace, prior),
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
   * sections. Returns '' when disabled or empty. Never exceeds `tokenBudget`: it drops the global then
   * the project dynamic section, then cuts the global then the project static section at sentence
   * boundaries, keeping the project's facts longest because they are the more specific.
   */
  buildProfileInjection(workspace: string, tokenBudget: number): string {
    const enabled = this.settings.get<boolean>('damocles.memory.profile.enabled', true) ?? true;
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

    let output = render(project, global);
    const overBy = (): number => (output === '' ? 0 : estimateTokens(output) - tokenBudget);

    for (const drop of [() => (global.dynamic = ''), () => (project.dynamic = '')]) {
      if (overBy() <= 0) break;
      drop();
      output = render(project, global);
    }
    // estimateTokens counts at least a quarter token per character, so cutting 4 characters per excess
    // token always removes the excess; each cut strictly shortens the section, so the loop ends.
    for (const profile of [global, project]) {
      while (overBy() > 0 && profile.static !== '') {
        profile.static = truncateAtBoundary(profile.static, Math.max(0, profile.static.length - 4 * overBy()));
        output = render(project, global);
      }
    }
    return output;
  }

  /** One stored section, or `null` when the row is missing. */
  readSection(scope: ProfileScope, workspace: string, section: ProfileSection): { content: string; updatedAt: number } | null {
    const row = this.db
      .prepare('SELECT content, updated_at FROM memory_profile WHERE scope = ? AND workspace = ? AND section = ?')
      .get(scope, workspace, section) as { content: string; updated_at: number } | undefined;
    return row ? { content: row.content, updatedAt: row.updated_at } : null;
  }

  /**
   * Upsert one section only while its `updated_at` still equals `expectedUpdatedAt` (`null` = row missing).
   * Synchronous: the caller must already hold the write queue. Returns the new `updated_at`, or `null` when the CAS failed.
   */
  writeSectionIfUnchanged(
    scope: ProfileScope,
    workspace: string,
    section: ProfileSection,
    content: string,
    expectedUpdatedAt: number | null,
  ): number | null {
    if (this.sectionUpdatedAt(scope, workspace, section) !== expectedUpdatedAt) return null;
    this.upsertSection(scope, workspace, section, content);
    return this.sectionUpdatedAt(scope, workspace, section);
  }

  /** Delete one section only while its `updated_at` still equals `expectedUpdatedAt`. Synchronous, like {@link writeSectionIfUnchanged}. */
  deleteSectionIfUnchanged(scope: ProfileScope, workspace: string, section: ProfileSection, expectedUpdatedAt: number): boolean {
    return (
      this.db
        .prepare('DELETE FROM memory_profile WHERE scope = ? AND workspace = ? AND section = ? AND updated_at = ?')
        .run(scope, workspace, section, expectedUpdatedAt).changes > 0
    );
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
    const baseFilter = "kind IN ('fact', 'episode') AND is_latest = 1 AND forgotten = 0";
    const sql =
      scope === 'project'
        ? `SELECT content FROM memories WHERE ${baseFilter} AND scope = 'project' AND workspace = ? ORDER BY updated_at DESC LIMIT ?`
        : `SELECT content FROM memories WHERE ${baseFilter} AND scope = 'global' ORDER BY updated_at DESC LIMIT ?`;

    const params: unknown[] = scope === 'project' ? [workspace, RECENT_MEMORY_LIMIT] : [RECENT_MEMORY_LIMIT];
    const rows = this.db.prepare(sql).all(...params) as MemoryContentRow[];
    return rows.map(row => row.content);
  }

  private scopePreferences(scope: ProfileScope, workspace: string): string[] {
    const baseFilter = "kind = 'preference' AND is_latest = 1 AND forgotten = 0";
    const sql =
      scope === 'project'
        ? `SELECT content FROM memories WHERE ${baseFilter} AND scope = 'project' AND workspace = ? ORDER BY updated_at DESC LIMIT ?`
        : `SELECT content FROM memories WHERE ${baseFilter} AND scope = 'global' ORDER BY updated_at DESC LIMIT ?`;
    const params: unknown[] = scope === 'project' ? [workspace, PREFERENCE_LIMIT] : [PREFERENCE_LIMIT];
    return (this.db.prepare(sql).all(...params) as MemoryContentRow[]).map(row => row.content);
  }

  /** The `profile` sub-call prompt for one scope: its name, the prior profile, recent memories and the preferences not to restate. */
  buildUpdatePrompt(scope: ProfileScope, workspace: string, prior: UserProfile): string {
    const list = (items: string[]): string => (items.length > 0 ? items.map(c => `- ${c}`).join('\n') : '(none)');
    const scopeLine = scope === 'project' ? `Scope: project ${workspace}` : 'Scope: global';
    const priorBlock = `Prior profile:\nstatic: ${prior.static || '(empty)'}\ndynamic: ${prior.dynamic || '(empty)'}`;
    return (
      `${scopeLine}\n\n${priorBlock}\n\n` +
      `Recent memories:\n${list(this.recentMemories(scope, workspace))}\n\n` +
      `Preferences already injected verbatim (do not restate):\n${list(this.scopePreferences(scope, workspace))}`
    );
  }
}
