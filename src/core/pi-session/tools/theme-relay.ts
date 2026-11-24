// The theme tools of a chat on a remote host (docs/invariants.md "Remote daemon and wire", user.theme): the daemon's core keeps
// the flow, the cards and the sources, and sends the store and window work to the device its turn is pinned to, whose own
// core alone writes its theme files (createThemeRelayHost below).
import { createHash, randomUUID, type Hash } from 'node:crypto';
import { Value } from 'typebox/value';
import type { RemoteHost } from '../../../platform/remote-host';
import type { Disposable } from '../../../platform/disposable';
import { CLIENT_FEATURE_MISSING, CREDENTIAL_CLIENT_ABSENT } from '../../../shared/remote-user';
import { englishText, LocalizedError } from '../../../shared/localized-text';
import {
  boundedRelayCommit, boundedRelayRead, boundedRelayStage, CLIENT_THEMES_OFF, MAX_THEME_UPLOAD_BYTES, RELAYED_DRAFT_TTL_MS, THEME_UPLOAD_CHUNK_BYTES,
  type RelayedThemeProject, type ThemeCommitAnswer, type ThemeReadAnswer, type ThemeReadRequest, type ThemeStageAnswer, type ThemeStageRequest, type ThemeUploadAck, type UserThemeCalls, type UserThemeMethod,
} from '../../../shared/themes/relay';
import { TOOL_THEME_SCHEDULE, TOOL_THEME_SET } from '../../../shared/tool-names';
import { TOOL_GROUP_SETTINGS } from '../../../shared/types/tools';
import type { ThemeShowRefusal } from '../../../shared/themes/agent';
import type { ThemeFile } from '../../../shared/themes/schema';
import type { ThemeInstallCommitted, ThemeInstallPrepared, ThemeInstallPreview } from '../../../shared/themes/install';
import { l } from '../../l10n';
import { currentPin } from '../../client-snapshots';
import { log } from '../../logger';
import { themeClosedReason, themeOffReason, themeOutdatedReason } from '../../user-scope';
import { THEME_TOOL_SPECS } from './theme-tool-specs';
import { applyModeOf, createLocalThemeBackend, ThemeStages, ThemeUnavailableError, UPLOAD_IDLE_MS, type LocalThemeBackend, type ThemeAgentHost, type ThemeBackend } from './theme-tools';

const MB = 1024 * 1024;
// A call that ends something on the device runs after the tool's signal aborted, so this bounds it instead.
const CLEANUP_CALL_MS = 30_000;
const cleanupDeadline = (): AbortSignal => AbortSignal.timeout(CLEANUP_CALL_MS);

export interface ThemeRelayDeps {
  readonly remote: RemoteHost;
  // the chat's project folder on this host (a chat worktree's is its project's), which the device maps to its own project
  readonly folder: () => string;
}

/** The refusals the relay answers with, in the model's words; anything else stays an error of the call. */
function unavailable(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  if (err.message === CREDENTIAL_CLIENT_ABSENT) return new ThemeUnavailableError(englishText(themeClosedReason()));
  if (err.message === CLIENT_FEATURE_MISSING) return new ThemeUnavailableError(englishText(themeOutdatedReason()));
  if (err.message === CLIENT_THEMES_OFF) return new ThemeUnavailableError(englishText(themeOffReason()));
  return err;
}

/** A file name from the host without its folders, which stay on the host. */
const baseName = (name: string): string => name.split(/[\\/]/).pop()!.slice(0, 255);

/** A daemon's core's theme tools: every call goes to exactly the device the turn is pinned to, and the stage it made there. */
export function relayedThemeBackend(deps: ThemeRelayDeps): ThemeBackend {
  // each stage, screenshot and staged install is answered by the device that made it
  const owners = new Map<string, string>();
  // the card each stage's Show in window shows on its device, which only that device may end
  const shownFor = new Map<string, string>();
  let uploading: Promise<unknown> = Promise.resolve();

  const pinned = (): string => {
    const clientId = currentPin(deps.remote).clientId;
    if (clientId === undefined || !deps.remote.clients.attached(clientId)) throw new ThemeUnavailableError(englishText(themeClosedReason()));
    return clientId;
  };
  const call = async <M extends UserThemeMethod>(clientId: string, method: M, params: UserThemeCalls[M]['params'], signal?: AbortSignal): Promise<UserThemeCalls[M]['result']> => {
    try {
      return await deps.remote.themeCall(clientId, method, params, signal);
    } catch (err) {
      throw unavailable(err);
    }
  };
  const ownerOf = (id: string): string => owners.get(id) ?? pinned();

  const send = async (bytes: Uint8Array, name: string | undefined, sessionId: string, signal: AbortSignal): Promise<{ readonly upload: string } | { readonly error: string }> => {
    const clientId = pinned();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const { uploadId } = await call(clientId, 'uploadStart', { sessionId, sha256, bytes: bytes.byteLength, ...(name !== undefined ? { name: baseName(name) } : {}) }, signal);
    let ack: ThemeUploadAck = { received: 0, complete: false };
    // one chunk at a time, each well under the wire's unacknowledged bound
    for (let offset = 0; offset < bytes.byteLength; offset += THEME_UPLOAD_CHUNK_BYTES) {
      ack = await call(clientId, 'uploadChunk', { uploadId, offset, data: bytes.subarray(offset, offset + THEME_UPLOAD_CHUNK_BYTES) }, signal);
    }
    if (!ack.complete || ack.received !== bytes.byteLength) return { error: 'the bytes that reached the computer that shows this chat did not match their SHA-256; nothing was changed there.' };
    return { upload: uploadId };
  };

  return {
    read: (request, chat, signal) => call(pinned(), 'read', { request, chat, folder: deps.folder() }, signal),
    // the device decides whether the chat holds the grant, so this core's granted is not sent
    async screenshotTake({ chat, draft }, signal) {
      const clientId = pinned();
      const taken = await call(clientId, 'screenshotTake', { chat: { id: chat.id }, ...(draft !== undefined ? { draft } : {}) }, signal);
      if (taken.kind === 'shot') owners.set(taken.shot.shotId, clientId);
      if (taken.kind === 'draft') owners.set(taken.captureId, clientId);
      return taken;
    },
    async screenshotCapture(captureId, signal) {
      const clientId = ownerOf(captureId);
      owners.delete(captureId);
      const taken = await call(clientId, 'screenshotCapture', { captureId }, signal);
      if (taken.kind === 'shot') owners.set(taken.shot.shotId, clientId);
      return taken;
    },
    screenshotRead: async (shotId, signal) => (await call(ownerOf(shotId), 'screenshot', { shotId }, signal)).png,
    async screenshotDrop(id) {
      const clientId = ownerOf(id);
      owners.delete(id);
      await call(clientId, 'screenshotDrop', { shotId: id }, cleanupDeadline());
    },
    upload(asset, sessionId, signal) {
      if (asset.bytes.byteLength > MAX_THEME_UPLOAD_BYTES) return Promise.resolve({ error: `the image is larger than ${MAX_THEME_UPLOAD_BYTES / MB} MB, the most a theme asset may be.` });
      // one upload of this chat at a time, as the device receives one per chat
      const run = uploading.then(() => send(asset.bytes, asset.name, sessionId, signal)).catch((err: unknown) => {
        if (err instanceof ThemeUnavailableError || signal.aborted) throw err;
        return { error: err instanceof Error ? err.message : String(err) };
      });
      uploading = run.catch(() => undefined);
      return run;
    },
    async stage(request, signal) {
      const clientId = pinned();
      const answer = await call(clientId, 'stage', { ...request, folder: deps.folder() }, signal);
      if (answer.kind === 'change') owners.set(answer.stageId, clientId);
      return answer;
    },
    async commit(stageId, signal) {
      let answer: ThemeCommitAnswer;
      try {
        answer = await call(ownerOf(stageId), 'commit', { stageId }, signal);
      } catch (err) {
        // the request left for the device, so a failure under a stopped turn says nothing of what the device did
        if (signal.aborted && !(err instanceof ThemeUnavailableError)) return { outcome: 'interrupted' };
        throw err;
      }
      // a refusal and an outdated answer leave the stage to discard
      if ('outcome' in answer && answer.outcome !== 'outdated') {
        owners.delete(stageId);
        shownFor.delete(stageId);
      }
      return answer;
    },
    async discard(stageId, keepDraft) {
      // a stage with no owner already ended on its device
      const clientId = owners.get(stageId);
      if (clientId === undefined) return;
      owners.delete(stageId);
      shownFor.delete(stageId);
      await call(clientId, 'discard', { stageId, ...(keepDraft === true ? { keepDraft: true } : {}) }, cleanupDeadline());
    },
    async show(stageId, promptId, on, signal) {
      if (!on) {
        shownFor.delete(stageId);
        await call(ownerOf(stageId), 'preview', { stageId, promptId, on }, cleanupDeadline());
        return { showing: false };
      }
      // set before the call: the device's end can arrive ahead of its answer, and must find the card
      shownFor.set(stageId, promptId);
      let refused: ThemeShowRefusal | undefined;
      try {
        const answer = await call(ownerOf(stageId), 'preview', { stageId, promptId, on }, signal);
        if (answer.showing) return { showing: shownFor.get(stageId) === promptId };
        refused = answer.refused;
      } catch (err) {
        if (shownFor.get(stageId) === promptId) shownFor.delete(stageId);
        throw err;
      }
      if (shownFor.get(stageId) === promptId) shownFor.delete(stageId);
      return { showing: false, ...(refused !== undefined ? { refused } : {}) };
    },
    // an end while this host is not connected to the device never arrives, and the card's toggle stays on until it is used again
    onShowEnded: (listener): Disposable => deps.remote.onThemeShowEnded(({ clientId, stageId, promptId, reason }) => {
      if (owners.get(stageId) !== clientId || shownFor.get(stageId) !== promptId) return;
      shownFor.delete(stageId);
      listener(promptId, reason);
    }),
    // only the device that took the screenshot speaks for it
    onScreenshotGone: (listener): Disposable => deps.remote.onThemeScreenshotGone(({ clientId, shotId }) => {
      if (owners.get(shotId) === clientId) listener(shotId);
    }),
    device: (id) => owners.get(id),
    // the device downloads, stages, commits and cancels; this core resolves nothing about the link and carries no Allow flashing
    install: {
      async prepare(url, signal) {
        const clientId = pinned();
        const answer = await call(clientId, 'installPrepare', { url }, signal);
        if ('refused' in answer) throw new LocalizedError(answer.refused);
        owners.set(answer.preview.installId, clientId);
        return answer;
      },
      async commit(commit, actor, signal) {
        const answer = await call(ownerOf(commit.installId), 'installCommit', { ...commit, chat: { id: actor.chatId, ...(actor.title !== '' ? { title: actor.title } : {}) } }, signal);
        if ('installed' in answer) owners.delete(commit.installId);
        return answer;
      },
      async cancel(installId) {
        const clientId = ownerOf(installId);
        owners.delete(installId);
        await call(clientId, 'installCancel', { installId }, cleanupDeadline());
      },
      // only the device that staged the install speaks for it
      onUpdated: (listener): Disposable => deps.remote.onThemeInstallUpdated(({ clientId, preview }) => {
        if (owners.get(preview.installId) === clientId) listener(preview);
      }),
      onProgress: (listener): Disposable => deps.remote.onThemeInstallProgress(({ clientId, ...progress }) => {
        if (owners.get(progress.installId) === clientId) listener(progress);
      }),
      onExpired: (listener): Disposable => deps.remote.onThemeInstallExpired(({ clientId, installId }) => {
        if (owners.get(installId) === clientId) listener(installId);
      }),
    },
  };
}

// Uploads one authority sends at once, past which its oldest is dropped; each holds at most MAX_THEME_UPLOAD_BYTES.
const MAX_RECEIVING = 2;
// Installs one authority keeps staged at once: a chat's ThemeSet holds one. Core's own bound (MAX_STAGED_INSTALLS) is across all.
const MAX_RELAYED_INSTALLS = 2;
const UPLOAD_NOT_OPEN = 'This upload is not open: it ended, it waited too long for its next chunk, or a newer upload of this host replaced it';
// How often relayed drafts past RELAYED_DRAFT_TTL_MS are looked for.
export const RELAYED_DRAFT_SWEEP_MS: number = 60 * 60 * 1000;

interface Receiving {
  readonly authority: string;
  readonly sessionId: string;
  readonly sha256: string;
  readonly declared: number;
  // nothing is allocated for the declared size: the chunks are joined once, when the last arrived
  readonly chunks: Uint8Array[];
  readonly hash: Hash;
  readonly name?: string;
  received: number;
  idle: ReturnType<typeof setTimeout>;
}

/** This computer's core's side of the relay: a remote host's theme tool calls on its own store and window, per authority. */
export interface ThemeRelayHost {
  read(authority: string, request: ThemeReadRequest, chat: string, project: RelayedThemeProject | undefined, signal: AbortSignal): Promise<ThemeReadAnswer>;
  uploadStart(authority: string, start: UserThemeCalls['uploadStart']['params']): { readonly uploadId: string };
  uploadChunk(authority: string, chunk: UserThemeCalls['uploadChunk']['params']): ThemeUploadAck;
  stage(authority: string, request: ThemeStageRequest, project: RelayedThemeProject | undefined, signal: AbortSignal): Promise<ThemeStageAnswer>;
  // pressed: main saw the card's Apply posted by its own page for this stage; a stage that raised a card commits on nothing else
  commit(authority: string, stageId: string, pressed: boolean, signal: AbortSignal): Promise<UserThemeCalls['commit']['result']>;
  discard(authority: string, stageId: string, keepDraft?: boolean): Promise<void>;
  preview(authority: string, params: UserThemeCalls['preview']['params']): Promise<UserThemeCalls['preview']['result']>;
  // ThemeSet install of a URL the remote chat's gate judged as its WebFetch, downloaded here only while web search is on here
  installPrepare(authority: string, url: string, signal: AbortSignal): Promise<ThemeInstallPrepared>;
  // commit, cancel and Allow act only on an install `authority` staged
  installCommit(authority: string, commit: UserThemeCalls['installCommit']['params']): Promise<ThemeInstallCommitted>;
  installCancel(authority: string, installId: string): Promise<void>;
  // only main calls it, for a press on that authority's chat page on this computer; the remote core cannot
  allowFlash(authority: string, installId: string, sha256: string): Promise<{ readonly allowed: boolean }>;
  // only main calls it, for a screenshot of a draft: the draft's name and theme when it is one of that authority's chat's own
  draftTheme(authority: string, chat: string, draft: string): Promise<{ readonly name: string; readonly theme: ThemeFile } | { readonly refused: string }>;
  // removes the relayed drafts last changed more than RELAYED_DRAFT_TTL_MS ago that no stage names; how many went
  expireDrafts(now?: number): Promise<number>;
  // Forget host: the authority's drafts, stages, uploads and staged installs go
  forgetAuthority(authority: string): Promise<void>;
  // forgetAuthority for every authority but these, for a host forgotten while this core was not running
  keepAuthorities(keep: ReadonlySet<string>): Promise<void>;
}

/** Whether a relayed tool input holds up as the tool's schema, as pi checks a local call's before it runs. */
function validInput(request: ThemeStageRequest): boolean {
  const name = request.tool === 'schedule' ? TOOL_THEME_SCHEDULE : TOOL_THEME_SET;
  const spec = THEME_TOOL_SPECS.find((candidate) => candidate.name === name);
  return spec !== undefined && Value.Check(spec.parameters, request.input);
}

export function createThemeRelayHost(agent: ThemeAgentHost): ThemeRelayHost {
  const stagesOf = new Map<string, ThemeStages>();
  const receiving = new Map<string, Receiving>();
  // the authority that staged each install; core's staged install expires on its own, so every count prunes first
  const installs = new Map<string, string>();
  const endReceiving = (uploadId: string): void => {
    const upload = receiving.get(uploadId);
    if (!upload) return;
    clearTimeout(upload.idle);
    receiving.delete(uploadId);
  };
  const idleTimer = (uploadId: string): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => endReceiving(uploadId), UPLOAD_IDLE_MS);
    timer.unref();
    return timer;
  };
  const openInstalls = (authority: string): number => {
    for (const installId of [...installs.keys()]) if (!agent.themes.installOpen(installId)) installs.delete(installId);
    return [...installs.values()].filter((owner) => owner === authority).length;
  };
  const stages = (authority: string): ThemeStages => {
    let held = stagesOf.get(authority);
    if (!held) {
      held = new ThemeStages();
      stagesOf.set(authority, held);
    }
    return held;
  };
  // a remote authority's drafts are owned by that authority, never by this core's own chats
  const backend = (authority: string, project: RelayedThemeProject | undefined): LocalThemeBackend =>
    createLocalThemeBackend({ ...agent, authority }, { stages: stages(authority), project: () => project });
  const expireDrafts = async (now = Date.now()): Promise<number> => {
    const staged = new Set([...stagesOf.values()].flatMap((held) => held.draftIds()));
    return agent.themes.drafts.removeRelayedBefore(agent.authority, now - RELAYED_DRAFT_TTL_MS, staged);
  };
  const forgetAuthority = async (authority: string): Promise<void> => {
    stagesOf.get(authority)?.dispose();
    stagesOf.delete(authority);
    for (const [uploadId, upload] of [...receiving]) if (upload.authority === authority) endReceiving(uploadId);
    const staged = [...installs].filter(([, owner]) => owner === authority).map(([installId]) => installId);
    for (const installId of staged) installs.delete(installId);
    await Promise.all(staged.map((installId) => agent.themes.installCancel(installId)));
    await agent.themes.drafts.removeOfAuthority(authority);
  };

  return {
    read: async (authority, request, chat, project, signal) => boundedRelayRead(await backend(authority, project).read(request, chat, signal)),
    uploadStart(authority, start) {
      if (start.bytes > MAX_THEME_UPLOAD_BYTES) throw new Error(`A theme asset is at most ${MAX_THEME_UPLOAD_BYTES / MB} MB`);
      for (const [id, other] of [...receiving]) if (other.authority === authority && other.sessionId === start.sessionId) endReceiving(id);
      const uploadId = randomUUID();
      receiving.set(uploadId, {
        authority, sessionId: start.sessionId, sha256: start.sha256, declared: start.bytes, chunks: [], hash: createHash('sha256'),
        ...(start.name !== undefined ? { name: start.name } : {}), received: 0, idle: idleTimer(uploadId),
      });
      const own = [...receiving].filter(([, other]) => other.authority === authority).map(([id]) => id);
      for (const old of own.slice(0, Math.max(0, own.length - MAX_RECEIVING))) endReceiving(old);
      return { uploadId };
    },
    uploadChunk(authority, { uploadId, offset, data }) {
      const upload = receiving.get(uploadId);
      if (!upload || upload.authority !== authority) throw new Error(UPLOAD_NOT_OPEN);
      if (offset !== upload.received || data.byteLength === 0 || offset + data.byteLength > upload.declared) {
        endReceiving(uploadId);
        throw new Error('The upload\'s chunks did not arrive in order');
      }
      upload.chunks.push(data);
      upload.hash.update(data);
      upload.received += data.byteLength;
      clearTimeout(upload.idle);
      if (upload.received < upload.declared) {
        upload.idle = idleTimer(uploadId);
        return { received: upload.received, complete: false };
      }
      receiving.delete(uploadId);
      if (upload.hash.digest('hex') !== upload.sha256) {
        log('[themes] an upload of %s did not match its SHA-256, so it was dropped', authority);
        return { received: upload.received, complete: false };
      }
      stages(authority).putUpload(upload.sessionId, { bytes: Buffer.concat(upload.chunks, upload.declared), ...(upload.name !== undefined ? { name: upload.name } : {}) }, uploadId);
      return { received: upload.received, complete: true };
    },
    async stage(authority, request, project, signal) {
      if (!validInput(request)) {
        return { kind: 'done', content: [{ type: 'text', text: 'The tool input is not valid for this tool. Nothing was changed.' }], details: { tool: request.tool === 'schedule' ? TOOL_THEME_SCHEDULE : TOOL_THEME_SET }, isError: true };
      }
      await expireDrafts().catch((err: unknown) => log('[themes] relayed drafts could not be expired: %s', err instanceof Error ? err.message : String(err)));
      return boundedRelayStage(await backend(authority, project).stage(request, signal));
    },
    async commit(authority, stageId, pressed, signal) {
      const stage = stages(authority).get(stageId);
      // read from this core's own stage and setting, never from the request: only a change the keep-changes banner holds needs no press
      const banner = stage?.onTheFly === true && applyModeOf(agent.settings) === 'onTheFly';
      if (stage && !pressed && !banner) return { refused: 'Not applied: nobody pressed Apply for this change on the computer that shows this chat.' };
      return boundedRelayCommit(await backend(authority, undefined).commit(stageId, signal));
    },
    discard: (authority, stageId, keepDraft) => backend(authority, undefined).discard(stageId, keepDraft),
    preview: (authority, { stageId, promptId, on }) => backend(authority, undefined).show(stageId, promptId, on),
    async installPrepare(authority, url, signal) {
      // the remote chat's gate judged the URL as its WebFetch; this computer downloads it only while its own web search is on
      if (agent.settings.get<unknown>(TOOL_GROUP_SETTINGS.web) !== true) return { refused: l('This computer downloads a theme for a chat on a remote host only while its web search is on. Turn on Settings › Tools & integrations › Web search on this computer, or install the theme with Install from link in Settings › Appearance.') };
      if (openInstalls(authority) >= MAX_RELAYED_INSTALLS) return { refused: l('{0} theme installs are already open. Install or cancel one first.', String(MAX_RELAYED_INSTALLS)) };
      let preview: ThemeInstallPreview;
      try {
        preview = await agent.themes.installPrepare({ kind: 'url', url }, { agent: true, signal });
      } catch (err) {
        if (err instanceof LocalizedError) return { refused: err.text };
        throw err;
      }
      installs.set(preview.installId, authority);
      return { preview };
    },
    async installCommit(authority, { installId, onClash, useArrangement, chat }) {
      if (installs.get(installId) !== authority) return { refused: l('This theme install is no longer open. Start it again.') };
      const committed = await agent.themes.installCommit({ installId, useArrangement, ...(onClash !== undefined ? { onClash } : {}) }, { kind: 'agent', chatId: chat.id, title: chat.title ?? '' });
      if ('installed' in committed) installs.delete(installId);
      return committed;
    },
    async installCancel(authority, installId) {
      if (installs.get(installId) !== authority) return;
      installs.delete(installId);
      await agent.themes.installCancel(installId);
    },
    allowFlash: async (authority, installId, sha256) => ({ allowed: installs.get(installId) === authority && await agent.themes.installAllowFlash(installId, sha256) }),
    async draftTheme(authority, chat, draft) {
      const found = await agent.themes.drafts.get(draft);
      if (found?.owner.authority !== authority || found.owner.sessionId !== chat) return { refused: 'This chat has no such theme draft.' };
      return { name: found.theme.name, theme: found.theme };
    },
    expireDrafts,
    forgetAuthority,
    async keepAuthorities(keep) {
      const known = new Set([...stagesOf.keys(), ...[...receiving.values()].map((upload) => upload.authority), ...installs.values(), ...await agent.themes.drafts.authorities()]);
      for (const authority of known) if (authority !== agent.authority && !keep.has(authority)) await forgetAuthority(authority);
    },
  };
}
