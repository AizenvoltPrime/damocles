import * as vscode from 'vscode';
import { log } from '../../logger';
import type { UserProfile } from '@shared/types/memory';
import type { DatabaseInstance } from '../types';
import type { MemoryWriteQueue } from '../write-queue';
import type { MemorySubCallRunner } from '../subcall-runner';

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
const CHARS_PER_TOKEN = 4;

const PROFILE_SYSTEM_PROMPT =
  "Maintain a concise user/project profile. 'static' = durable, stable facts and preferences. " +
  "'dynamic' = a short summary of recent activity and current focus. " +
  'Update from the prior profile + recent memories; keep each section tight.';

const PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    static: { type: 'string' },
    dynamic: { type: 'string' },
  },
  required: ['static', 'dynamic'],
  additionalProperties: false,
} satisfies Record<string, unknown>;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
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
 * Owns the auto-maintained user profile: a stable `static` section plus a recent-activity
 * `dynamic` section, stored per scope (project + global) in `memory_profile`. Reads degrade
 * to empty sections; `updateProfile` skips the write when the sub-call yields no value.
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

  /** Upsert one section's content under the write queue. Used by the webview profile editor (US-011). */
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

    const { value } = await this.runner.run<UserProfile>({
      purpose: 'profile',
      systemPrompt: PROFILE_SYSTEM_PROMPT,
      prompt: this.buildUpdatePrompt(prior, recent),
      schema: PROFILE_SCHEMA,
    });

    if (value === null) return;

    const nextStatic = value.static.slice(0, STATIC_CHAR_CAP);
    const nextDynamic = value.dynamic.slice(0, DYNAMIC_CHAR_CAP);

    await this.writeQueue.run(() => {
      this.upsertSection(scope, workspace, 'static', nextStatic);
      this.upsertSection(scope, workspace, 'dynamic', nextDynamic);
    });
  }

  /**
   * Build the `<user_profile>` injection block from the project (workspace) and global profiles,
   * omitting empty sections/scopes. Returns '' when the profile feature is disabled or everything
   * is empty. Enforces `tokenBudget` by dropping lowest-priority content (global dynamic, then
   * project dynamic) before re-rendering, keeping static content.
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
