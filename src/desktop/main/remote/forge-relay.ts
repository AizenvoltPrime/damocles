// Only bounded, masked text crosses back to a host: docs/invariants.md "Remote daemon and wire", user.forge.
import { FORGE_TOOLS_OFF_HERE, MAX_FORGE_TOOL_TEXT_CHARS, type ForgeDescribeAnswer, type ForgeToolAnswer, type ForgeToolRequest, type RelayedForgeRequest } from '../../../shared/forge/tools';
import { isInsideFolder } from '../../../shared/project-location';
import { FORGE_READ_TOOLS, FORGE_WRITE_TOOLS } from '../../../shared/tool-names';
import { folderKeyOn } from '../../../core/workspace-folders/folder-key';
import type { RemoteProject } from './authorities';

export interface ForgeRelayDeps {
  readonly authority: string;
  // this host's projects on this computer
  readonly projects: () => readonly RemoteProject[];
  // the host's OS, undefined before its first connection reported it
  readonly os: () => NodeJS.Platform | undefined;
  // damocles.desktop.forge.agentTools on this computer
  readonly enabled: () => boolean;
  // the local core holds a proxy for the live chat view of this host once it settles; false: no chat of this host shows it
  readonly attachView: (viewId: string) => Promise<boolean>;
  readonly tool: (params: { readonly request: ForgeToolRequest; readonly viewId?: string; readonly toolCallId: string }, signal: AbortSignal) => Promise<ForgeToolAnswer>;
  readonly describe: (params: { readonly request: ForgeToolRequest; readonly viewId?: string; readonly toolCallId: string; readonly approval: boolean }, signal: AbortSignal) => Promise<ForgeDescribeAnswer>;
  readonly log: (line: string) => void;
}

type RelayedCall = RelayedForgeRequest & { readonly viewId?: string };

const failed = (text: string): ForgeToolAnswer => ({ text, isError: true });

/** The host project holding folder: the project itself, or the one a folder below it is in. */
function projectOf(deps: ForgeRelayDeps, folder: string): RemoteProject | undefined {
  const os = deps.os();
  if (os === undefined) return undefined;
  const at = folderKeyOn(os, folder);
  const projects = deps.projects().filter((project) => project.authorityKey === deps.authority);
  return projects.find((project) => project.folderKey === at)
    ?? projects.filter((project) => isInsideFolder({ os }, project.fsPath, folder)).sort((a, b) => b.fsPath.length - a.fsPath.length)[0];
}

/** The local core's request, or the answer the call gets without one. */
async function prepare(deps: ForgeRelayDeps, call: RelayedCall): Promise<{ readonly request: ForgeToolRequest; readonly viewId?: string } | { readonly answer: ForgeToolAnswer }> {
  // the name is the host's text until it is one of these, so nothing logs it before
  if (!FORGE_READ_TOOLS.has(call.tool) && !FORGE_WRITE_TOOLS.has(call.tool)) {
    deps.log(`[remote] user.forge refused for ${deps.authority}: not a GitHub or GitLab tool`);
    return { answer: failed('This is not a GitHub or GitLab tool.') };
  }
  if (!deps.enabled()) return { answer: failed(FORGE_TOOLS_OFF_HERE) };
  const project = projectOf(deps, call.folder);
  if (!project) {
    deps.log(`[remote] user.forge refused for ${deps.authority}: the folder is none of the host's projects`);
    return { answer: failed("This chat's folder is not one of this host's projects on the computer that shows the chat, so the GitHub and GitLab tools do not run for it.") };
  }
  const viewId = call.viewId !== undefined && await deps.attachView(call.viewId) ? call.viewId : undefined;
  return {
    request: {
      tool: call.tool,
      input: call.input,
      authorityKey: deps.authority,
      projectKey: project.key,
      project: project.name,
      endpoints: call.endpoints,
      ...(call.pushRemote !== undefined ? { pushRemote: call.pushRemote } : {}),
      ...(call.branch !== undefined ? { branch: call.branch } : {}),
      ...(call.expected !== undefined ? { expected: call.expected } : {}),
    },
    ...(viewId !== undefined ? { viewId } : {}),
  };
}

/** text cut to MAX_FORGE_TOOL_TEXT_CHARS, never ending in half of a surrogate pair. */
function boundedText(text: string): string {
  const cut = text.slice(0, MAX_FORGE_TOOL_TEXT_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** The answer as it leaves for the host, rebuilt field by field and bounded. */
function boundedAnswer(answer: ForgeToolAnswer): ForgeToolAnswer {
  const { refusal } = answer;
  return {
    text: boundedText(answer.text),
    ...(answer.isError === true ? { isError: true as const } : {}),
    ...(refusal ? {
      refusal: {
        serverId: refusal.serverId,
        serverLabel: refusal.serverLabel,
        project: refusal.project,
        account: refusal.account ? { id: refusal.account.id, login: refusal.account.login, ...(refusal.account.avatarKey !== undefined ? { avatarKey: refusal.account.avatarKey } : {}) } : null,
        reason: refusal.reason,
        ...(refusal.org ? { org: { name: refusal.org.name, kind: refusal.org.kind } } : {}),
      },
    } : {}),
  };
}

export async function relayForgeTool(deps: ForgeRelayDeps, call: RelayedCall, signal: AbortSignal): Promise<ForgeToolAnswer> {
  const prepared = await prepare(deps, call);
  if ('answer' in prepared) return prepared.answer;
  deps.log(`[remote] user.forge.tool for ${deps.authority}: ${call.tool}`);
  return boundedAnswer(await deps.tool({ ...prepared, toolCallId: call.toolCallId }, signal));
}

export async function relayForgeDescribe(deps: ForgeRelayDeps, call: RelayedCall & { readonly approval: boolean }, signal: AbortSignal): Promise<ForgeDescribeAnswer> {
  const prepared = await prepare(deps, call);
  if ('answer' in prepared) return { ok: false, answer: prepared.answer };
  deps.log(`[remote] user.forge.describe for ${deps.authority}: ${call.tool}`);
  const answer = await deps.describe({ ...prepared, toolCallId: call.toolCallId, approval: call.approval }, signal);
  if (!answer.ok) return { ok: false, answer: boundedAnswer(answer.answer) };
  const { target } = answer;
  return {
    ok: true,
    project: answer.project,
    target: { serverId: target.serverId, repoPath: target.repoPath, accountId: target.accountId, ...(target.sourceBranch !== undefined ? { sourceBranch: target.sourceBranch } : {}), ...(target.targetBranch !== undefined ? { targetBranch: target.targetBranch } : {}) },
    ...(answer.detail !== undefined ? { detail: answer.detail } : {}),
    ...(answer.suggestion !== undefined ? { suggestion: answer.suggestion } : {}),
  };
}
