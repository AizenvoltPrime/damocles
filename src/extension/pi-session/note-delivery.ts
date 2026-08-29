import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { log } from '../logger';

/**
 * How a shell-cancel note reaches the agent that ran the command. One builder per context
 * `buildCustomTools` is called for, so the target is fixed when the tools are built rather than
 * guessed when the Stop button is clicked.
 *
 * The note is user turn content, not tool output, so each builder uses the channel that context
 * already uses for a typed user message. Every builder returns a callback that starts delivery and
 * returns: the caller is the cancel path, and a note must never make the user wait for the process to
 * die. What a builder must not do is claim delivery it has not got, because the panel's echo of the
 * note is what tells the user the agent was told.
 */

/**
 * The panel's own session: queue the note as a real user message for the next turn boundary.
 *
 * `expandPromptTemplates: false` is the whole leading-slash guard. With it, `prompt()` skips the
 * extension-command dispatch and the skill/template expansion, so a note beginning with `/` is
 * delivered as literal text and can never be executed or throw. The session is read through a thunk
 * because the tools are built before the session that runs them exists; the thunk resolves to the one
 * session those tools were built for, never to whatever session replaced it.
 *
 * Resolves once pi has accepted the note, so the caller can hold its echo until then.
 */
export function sessionNoteDelivery(session: () => AgentSession | undefined): (text: string) => Promise<void> {
  return async (text) => {
    const target = session();
    if (!target) throw new Error('the pi session these tools were built for was never created');
    await target.sendUserMessage(text, { deliverAs: 'followUp', expandPromptTemplates: false });
  };
}

/** One running subagent: the same steer channel a user-typed `/steer` uses, so the chip is echoed too. */
export function subagentNoteDelivery(
  steer: (agentId: string, message: string) => Promise<void>,
  agentId: string,
): (text: string) => void {
  return (text) => {
    void steer(agentId, text).catch((err) => log('[PiSession] cancel note delivery to subagent %s failed: %O', agentId, err));
  };
}

/**
 * One team agent: the delivery its own runner owns, which queues the note into the live run and echoes
 * it to the overlay exactly once. A `false` return means no live run consumed it, so nothing was echoed
 * and nothing was persisted; this is the only place that failure becomes visible, hence the log. Adding
 * an echo here on the `true` path would double the one the runner already emitted.
 */
export function teamAgentNoteDelivery(deliver: (text: string) => boolean, agentName: string): (text: string) => void {
  return (text) => {
    if (!deliver(text)) log('[PiSession] cancel note to team agent %s reached no live run', agentName);
  };
}
