import type { RemoteHost } from '../../../platform/remote-host';
import type { PanelHost } from '../../../platform/window-service';
import { CLIENT_FEATURE_MISSING, CREDENTIAL_CLIENT_ABSENT } from '../../../shared/remote-user';
import type { ChatRepository, ForgeDescribeAnswer, ForgeToolAnswer, RelayedForgeRequest } from '../../../shared/forge/tools';
import { englishText } from '../../../shared/localized-text';
import { currentPin } from '../../client-snapshots';
import { forgeClosedReason } from '../../user-scope';
import { DecidedTargets, type ForgeCall, type ForgeToolsPort } from './forge-tools';

// A daemon's core's GitHub and GitLab tools run on the turn's pinned device: docs/invariants.md "Remote daemon and wire".

export interface ForgeRelayDeps {
  readonly remote: RemoteHost;
  readonly chat: PanelHost;
  readonly folder: () => string;
  readonly repository: (folder: string) => Promise<ChatRepository>;
  /** Shows the refused notice an answer carries, under the call's card in this chat's views. */
  readonly refused: (call: ForgeCall, answer: ForgeToolAnswer) => void;
}

const failed = (text: string): ForgeToolAnswer => ({ text, isError: true });

function relayFailure(err: unknown): ForgeToolAnswer {
  if (err instanceof Error && err.message === CREDENTIAL_CLIENT_ABSENT) return failed(englishText(forgeClosedReason()));
  if (err instanceof Error && err.message === CLIENT_FEATURE_MISSING) return failed('The Damocles on the computer that shows this chat is too old to run GitHub and GitLab tools for a remote host. Update Damocles there.');
  throw err;
}

export function relayedForgeTools(deps: ForgeRelayDeps): ForgeToolsPort {
  const decided = new DecidedTargets();

  /** The relayed request, or the answer the call gets without one. */
  async function prepare(call: ForgeCall): Promise<{ readonly clientId: string; readonly request: RelayedForgeRequest } | { readonly answer: ForgeToolAnswer }> {
    const clientId = currentPin(deps.remote).clientId;
    if (clientId === undefined || !deps.remote.clients.attached(clientId)) return { answer: failed(englishText(forgeClosedReason())) };
    const folder = deps.folder();
    const read = await deps.repository(folder);
    if (!read.ok) return { answer: failed(read.text) };
    const { projectPath, endpoints, pushRemote, branch } = read.repository;
    return {
      clientId,
      request: {
        toolCallId: call.toolCallId,
        folder: projectPath,
        endpoints,
        ...(pushRemote !== undefined ? { pushRemote } : {}),
        ...(branch !== undefined ? { branch } : {}),
        tool: call.tool,
        input: call.input,
      },
    };
  }

  async function describe(call: ForgeCall, approval: boolean, signal: AbortSignal): Promise<ForgeDescribeAnswer> {
    const prepared = await prepare(call);
    if ('answer' in prepared) return { ok: false, answer: prepared.answer };
    let answer: ForgeDescribeAnswer;
    try {
      answer = await deps.remote.forgeDescribe(prepared.clientId, deps.chat, { ...prepared.request, approval }, signal);
    } catch (err) {
      return { ok: false, answer: relayFailure(err) };
    }
    if (!answer.ok) deps.refused(call, answer.answer);
    else decided.decided(call.toolCallId, answer.target);
    return answer;
  }

  return {
    async run(call, signal) {
      const expected = decided.take(call.toolCallId);
      const prepared = await prepare(call);
      if ('answer' in prepared) return prepared.answer;
      let answer: ForgeToolAnswer;
      try {
        answer = await deps.remote.forgeTool(prepared.clientId, deps.chat, expected ? { ...prepared.request, expected } : prepared.request, signal);
      } catch (err) {
        return relayFailure(err);
      }
      deps.refused(call, answer);
      return answer;
    },

    async target(call, signal) {
      const answer = await describe(call, false, signal);
      return answer.ok ? { ok: true, project: answer.project } : answer;
    },

    async approval(call, signal) {
      const answer = await describe(call, true, signal);
      if (!answer.ok) return answer;
      if (answer.detail === undefined || answer.suggestion === undefined) return { ok: false, answer: failed('The computer that shows this chat answered no approval card for this write.') };
      return { ok: true, project: answer.project, detail: answer.detail, suggestion: answer.suggestion, target: answer.target };
    },
  };
}
