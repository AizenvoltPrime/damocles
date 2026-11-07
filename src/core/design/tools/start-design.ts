// StartDesign (PD-2, PD-37, PD-43, PD-53): opens the parent's linked design chat, or reopens it with a new brief. It writes
// nothing into the chat's checkpointed folder, runs with no prompt by settings rule, works in plan mode, and a turn decider
// ends the parent's turn after it (PD-28, PD-49).
import { promises as fs } from 'node:fs';
import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../../pi-session/pi-loader';
import { TOOL_START_DESIGN } from '../../../shared/tool-names';
import type { DesignRuleSetId, StartDesignDetails } from '../../../shared/types/design';
import { inheritedDesignLink, MAX_TITLE_CHARS, ownDesignLink, type DesignLink } from '../design-entries';
import { designFolderOf, designStateDirOf, forkDesignId, newDesignId } from '../design-paths';
import { readDesignLink, updateDesignLink, writeBriefRecord, writeBriefToCurrentChat, type DesignBriefContext } from '../design-state';

/** A new design chat's identity, written as its role entry at its first bind; `title` names the chat. */
export interface DesignSeed {
  readonly designId: string;
  readonly title: string;
  readonly parentSessionId: string;
  readonly ruleSet: DesignRuleSetId;
}

/** Where a chat asked to show is: shown here, open in another Damocles process (its lease), or its file is gone. */
export type SessionShown = 'shown' | 'elsewhere' | 'missing';

/** What the panel layer does for a design chat and its main chat. */
export interface DesignPanels {
  /** Opens a new design chat beside the parent, in the parent's working folder; resolves its session id once it started. */
  openDesignChat(seed: DesignSeed): Promise<string>;
  /** Shows the chat holding stored session `sessionId`, opening it when no panel holds it. */
  showSession(sessionId: string): Promise<SessionShown>;
  /** Stored chat `sessionId`'s current title: its name, else its AI title, else its first message; undefined while it is not listed. */
  sessionTitle(sessionId: string): Promise<string | undefined>;
}

export interface StartDesignDeps {
  enabled(): boolean;
  /** This chat is itself a design chat, which never starts another. */
  designChat(): boolean;
  /** The parent's session id. */
  sessionId(): string;
  /** The parent's first message, the plan file's slug source. */
  firstMessage(): string;
  branch(): readonly unknown[];
  ruleSet(): DesignRuleSetId;
  appendLink(link: DesignLink): void;
  /** Offers a written brief to its design chat where that chat is live. */
  offerBrief(designSessionId: string, briefId: string): void;
  panels(): DesignPanels | undefined;
  publish(): void;
}

const startSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: MAX_TITLE_CHARS, description: 'A short name for the design, such as "Contacts list".' }),
  brief: Type.String({ minLength: 1, maxLength: 20_000, description: 'What to design: the screens, the user\'s goal, constraints and what you already know of the app.' }),
}, { additionalProperties: false });

export function createStartDesignTool(pi: PiCodingAgentModule, deps: StartDesignDeps): ToolDefinition {
  return pi.defineTool<typeof startSchema, unknown>({
    name: TOOL_START_DESIGN,
    label: 'StartDesign',
    description: 'Open a linked design chat for UI work whose layout or behavior is still open, or when the user asks to design first. The design chat does the design with the user; this chat waits for its "Design finished" result and then builds from it. Called again, it reopens the same design chat with the new request as a brief. Your turn ends after it.',
    parameters: startSchema,
    execute: async (_toolCallId, params) => {
      if (!deps.enabled()) throw new Error('Design mode is off. The user turns it on in Settings.');
      if (deps.designChat()) throw new Error('A design chat cannot start another design.');
      const panels = deps.panels();
      if (!panels) throw new Error('This chat cannot open a design chat here.');
      const sessionId = deps.sessionId();
      const branch = deps.branch();
      const title = params.title.trim().slice(0, MAX_TITLE_CHARS);
      const own = ownDesignLink(branch, sessionId);
      const inherited = own ? undefined : inheritedDesignLink(branch, sessionId);
      const designId = own?.designId ?? (inherited ? forkDesignId(inherited.designId, sessionId) : newDesignId(sessionId, deps.firstMessage()));
      const folder = designFolderOf(designId);
      const stateDir = designStateDirOf(designId);
      const existing = await readDesignLink(stateDir);
      if (existing && existing.parentSessionId !== sessionId) throw new Error(`The design folder ${folder} belongs to another chat.`);
      if (!own) deps.appendLink({ designId, folder, parentSessionId: sessionId, title: existing?.title ?? title });

      // Written before the chat opens: its bind delivers what its branch lacks, and the offer covers a chat already live.
      const brief = existing?.designSessionId ? await writeBriefToCurrentChat(stateDir, { parentSessionId: sessionId, text: params.brief, reopened: true }) : undefined;
      const current = brief?.designSessionId ?? null;
      if (brief && current !== null) {
        // A chat another process holds takes the brief from that process's watch.
        if ((await panels.showSession(current)) !== 'missing') {
          deps.offerBrief(current, brief.briefId);
          deps.publish();
          return result({ designId, folder, designSessionId: current, reopened: true, title: existing!.title });
        }
      }

      const context: DesignBriefContext | undefined = current !== null || (existing && (await folderHasFiles(folder)))
        ? { kind: 'takeover' }
        : inherited ? { kind: 'fork', folder: inherited.folder } : undefined;
      await fs.mkdir(folder, { recursive: true });
      await updateDesignLink(stateDir, (link) => link ?? { schemaVersion: 1, designId, folder, title, parentSessionId: sessionId, designSessionId: null, superseded: [] });
      await writeBriefRecord(stateDir, { parentSessionId: sessionId, designSessionId: null, text: params.brief, reopened: false, ...(context ? { context } : {}) });
      const designSessionId = await panels.openDesignChat({ designId, title: existing?.title ?? title, parentSessionId: sessionId, ruleSet: deps.ruleSet() });
      deps.publish();
      return result({ designId, folder, designSessionId, reopened: false, title: existing?.title ?? title });
    },
  });
}

async function folderHasFiles(folder: string): Promise<boolean> {
  try {
    return (await fs.readdir(folder)).length > 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function result(details: StartDesignDetails): { content: { type: 'text'; text: string }[]; details: StartDesignDetails } {
  const text = details.reopened
    ? `The design chat for "${details.title}" is open again with your request as a brief. Its result arrives here as a "Design finished" report. Your turn ends here.`
    : `A design chat for "${details.title}" opened on ${details.folder}. Its result arrives here as a "Design finished" report. Your turn ends here.`;
  return { content: [{ type: 'text', text }], details };
}
