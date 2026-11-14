import { createHash } from 'node:crypto';
import type { ResolveHow } from '../../../shared/forge/bindings';
import type { ForgeApprovalAnswer, ForgeTarget, ForgeToolAnswer, ForgeToolRefusal, ForgeToolRequest } from '../../../shared/forge/tools';
import type { LocalizedText } from '../../../shared/localized-text';
import { ciLogLines, type CiLogKind } from '../../../shared/forge/ci-log';
import type { PermissionDetail, PermissionFact } from '../../../shared/types/permissions';
import {
  TOOL_FORGE_COMMENT,
  TOOL_FORGE_ISSUE,
  TOOL_FORGE_ISSUES,
  TOOL_FORGE_JOB_ACTION,
  TOOL_FORGE_JOB_LOG,
  TOOL_FORGE_JOBS,
  TOOL_FORGE_MERGE_REQUEST,
  TOOL_FORGE_MERGE_REQUESTS,
  TOOL_FORGE_OPEN_MERGE_REQUEST,
  TOOL_FORGE_PIPELINES,
  FORGE_READ_TOOLS,
  FORGE_WRITE_TOOLS,
} from '../../../shared/tool-names';
import { l } from '../../l10n';
import { isRemoteName } from '../../scm/remotes';
import type { BindingStore } from '../bindings/binding-store';
import { resolveWithoutAccess } from '../bindings/resolve';
import type { ForgeHttp } from '../http';
import { MAX_LIST_PAGES } from '../paging';
import { matchServer } from '../remote-url';
import { ForgeHttpError, type AccountRecord, type ForgeServer } from '../types';
import { checkedBranch, checkedRepoPath, InputError, MAX_JOB_LOG_BYTES, type ForgeRepoApi, type Issue, type Job, type MergeRequest, type Note, type Pipeline, type RepoContext } from './api';
import { githubRepoApi } from './github';
import { gitlabRepoApi } from './gitlab';
import { boundedText, cleanLine, cleanText, frameOutput } from './output';

// The agent's GitHub and GitLab tools on the chat's own repository: docs/invariants.md "GitHub and GitLab accounts".

/** Lines ForgeJobLog returns at most. */
export const JOB_LOG_TAIL_LINES = 200;
const MAX_LIST = 50;
const DEFAULT_LIST = 20;
const NOTES_SHOWN = 20;
const MAX_TEXT_CHARS = 60_000;
const MAX_TITLE_CHARS = 255;
const MAX_FILTER_CHARS = 200;
// section names ForgeJobLog lists at most
const MAX_LISTED_SECTIONS = 100;
const MAX_REFUSAL_CHARS = 1_000;
// GitHub's job statuses before `completed`; a completed job reads as its conclusion (statusOf in github.ts)
const GITHUB_UNFINISHED: ReadonlySet<string> = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

export interface ForgeToolsDeps {
  readonly servers: () => readonly ForgeServer[];
  readonly accounts: () => readonly AccountRecord[];
  readonly bindings: BindingStore;
  /** The access check's one pick (push, else read) among accounts that need no sign-in. */
  readonly pickByAccess: (accounts: readonly AccountRecord[], server: ForgeServer, repoPath: string, signal: AbortSignal) => Promise<AccountRecord | undefined>;
  /** Runs with a live token of the account's own server; a 401 marks the account "Sign in again". */
  readonly withToken: <T>(account: AccountRecord, server: ForgeServer, run: (token: string) => Promise<T>) => Promise<T>;
  readonly http: ForgeHttp;
  readonly needsSignIn: (account: AccountRecord) => boolean;
  readonly avatarKey: (account: AccountRecord) => string | undefined;
  /** damocles.desktop.forge.agentReadAnyRepository. */
  readonly readAnyRepository: () => boolean;
  /** An organization keeps the account out; the notice's action opens url (SSO) or the app's approval page. */
  readonly noteOrgAccess: (account: AccountRecord, finding: { readonly kind: 'ssoRequired' | 'appNotApproved'; readonly org: string; readonly url?: string }) => void;
  readonly log: (line: string) => void;
}

export interface ForgeTools {
  run(request: ForgeToolRequest, signal: AbortSignal): Promise<ForgeToolAnswer>;
  /** A write's approval card and option 2's rule, resolved before the prompt; or the answer the call gets instead. */
  approval(request: ForgeToolRequest, signal: AbortSignal): Promise<ForgeApprovalAnswer>;
  /** The call's target as a settings rule names it ("<server>/<path>") and as run checks it, or the answer the call gets instead. */
  target(request: ForgeToolRequest, signal: AbortSignal): Promise<{ readonly ok: true; readonly project: string; readonly target: ForgeTarget } | { readonly ok: false; readonly answer: ForgeToolAnswer }>;
}

interface Target {
  readonly server: ForgeServer;
  readonly repoPath: string;
  readonly account: AccountRecord;
  readonly how: ResolveHow;
  readonly api: ForgeRepoApi;
  /** ForgeOpenMergeRequest only: the fork the remote pushes to, on the same server, when it is not the repository it fetches. */
  readonly sourceRepoPath?: string;
}

/** A write whose repository, account, branches or text resolve otherwise than when the gate decided it (and the card showed it). */
export const TARGET_CHANGED = 'The repository, account, branch or text changed after this call was approved, so nothing was sent. Call the tool again.';
/** A read whose repository or account resolves otherwise than when the gate decided it. */
export const READ_TARGET_CHANGED = 'The repository or account changed after the gate decided this call, so nothing was read. Call the tool again.';

const failed = (text: string): ForgeToolAnswer => ({ text, isError: true });

function kindName(server: ForgeServer): string {
  return server.kind === 'github' ? 'GitHub' : 'GitLab';
}

function mrRef(server: ForgeServer, number: number): string {
  return server.kind === 'github' ? `#${number}` : `!${number}`;
}

function mrWord(server: ForgeServer): string {
  return server.kind === 'github' ? 'pull request' : 'merge request';
}

/** What a 404 on a list or a repository read says the server has none of. */
function repositoryNoun(target: { readonly repoPath: string }): string {
  return `repository ${target.repoPath}`;
}


type Input = Readonly<Record<string, unknown>>;

function positiveInt(input: Input, key: string, max = Number.MAX_SAFE_INTEGER): number {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) throw new InputError(`${key} must be a whole number from 1 to ${max}.`);
  return value;
}

function optionalInt(input: Input, key: string, max: number, fallback: number): number {
  return input[key] === undefined ? fallback : positiveInt(input, key, max);
}

function text(input: Input, key: string, max: number, required: boolean): string | undefined {
  const value = input[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || (required && value.trim() === '') || value.length > max) throw new InputError(`${key} must be text of at most ${max} characters${required ? ', not empty' : ''}.`);
  return value;
}

/** fallback undefined: the key is required. */
function oneOf<T extends string>(input: Input, key: string, values: readonly T[], fallback?: T): T {
  const value = input[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) throw new InputError(`${key} must be one of ${values.join(', ')}.`);
  return value as T;
}

/** The input's branch, else fallback (the chat's branch), each only when checkedBranch keeps it. */
function branch(input: Input, key: string, fallback?: string): string | undefined {
  const value = input[key];
  if (value === undefined) {
    if (fallback !== undefined && checkedBranch(fallback) === undefined) throw new InputError(`This chat's branch name cannot be sent; give ${key}.`);
    return fallback;
  }
  if (typeof value !== 'string' || checkedBranch(value) === undefined) throw new InputError(`${key} must be a branch name.`);
  return value;
}

/** What a write sends, exactly as its approval card shows it: hidden characters removed, secrets redacted and masked. */
function outgoing(value: string): string {
  return cleanText(value);
}


const shortSha = (sha: string | undefined): string => (sha !== undefined ? ` · ${cleanLine(sha, 12).slice(0, 8)}` : '');
const when = (at: string | undefined): string => (at !== undefined ? ` · ${cleanLine(at, 40)}` : '');
const link = (url: string | undefined): string => (url !== undefined ? `\n${cleanLine(url, 500)}` : '');

function pipelineLine(server: ForgeServer, pipeline: Pipeline): string {
  const what = server.kind === 'github' ? 'Run' : 'Pipeline';
  const name = pipeline.name !== undefined ? ` · ${cleanLine(pipeline.name, 120)}` : '';
  const ref = pipeline.ref !== undefined ? ` · ${cleanLine(pipeline.ref, 120)}` : '';
  return `${what} ${pipeline.id} · ${cleanLine(pipeline.status, 40)}${ref}${shortSha(pipeline.sha)}${name}${when(pipeline.createdAt)}`;
}

function jobLine(job: Job): string {
  const stage = job.stage !== undefined ? ` · stage ${cleanLine(job.stage, 80)}` : '';
  const duration = job.durationSeconds !== undefined ? ` · ${job.durationSeconds} s` : '';
  return `Job ${job.id} · ${cleanLine(job.name, 120)} · ${cleanLine(job.status, 40)}${stage}${duration}`;
}

function notesText(notes: readonly Note[]): string {
  if (notes.length === 0) return 'No comments.';
  return notes.map((note) => `--- ${cleanLine(note.author, 80)}${when(note.createdAt)}\n${boundedText(note.body, MAX_TEXT_CHARS)}`).join('\n\n');
}

// a GitHub pull request's notes are its issue comments, its conversation; its review comments and reviews are not read
const commentsHeading = (server: ForgeServer, pull: boolean): string => (server.kind === 'github' && pull ? 'Latest conversation comments (review comments not included):' : 'Latest comments:');

function mergeRequestText(server: ForgeServer, mr: MergeRequest, notes: readonly Note[]): string {
  const head = `${mrRef(server, mr.number)} ${cleanLine(mr.title, MAX_TITLE_CHARS)}\nState: ${cleanLine(mr.state, 40)}${mr.draft ? ', draft' : ''} · author ${cleanLine(mr.author, 80)} · ${cleanLine(mr.sourceBranch, 255)} into ${cleanLine(mr.targetBranch, 255)}${when(mr.createdAt)}${link(mr.webUrl)}`;
  return `${head}\n\nDescription:\n${boundedText(mr.description, MAX_TEXT_CHARS) || '(none)'}\n\n${commentsHeading(server, true)}\n${notesText(notes)}`;
}

function issueText(server: ForgeServer, issue: Issue, notes: readonly Note[]): string {
  const labels = issue.labels.length > 0 ? ` · labels ${issue.labels.map((label) => cleanLine(label, 80)).join(', ')}` : '';
  const head = `#${issue.number} ${cleanLine(issue.title, MAX_TITLE_CHARS)}\nState: ${cleanLine(issue.state, 40)} · author ${cleanLine(issue.author, 80)}${labels}${when(issue.createdAt)}${link(issue.webUrl)}`;
  return `${head}\n\nDescription:\n${boundedText(issue.description, MAX_TEXT_CHARS) || '(none)'}\n\n${commentsHeading(server, false)}\n${notesText(notes)}`;
}

/**
 * The last lines of a job log as plain text, only those in a section whose name holds `section` when given, read in one pass
 * that keeps only those lines and the first section names.
 */
export function jobLogTail(kind: CiLogKind, raw: string, lines: number, section: string | undefined): { readonly text: string; readonly shown: number; readonly total: number; readonly sections: readonly string[] } {
  const wanted = section?.toLowerCase();
  const ring: string[] = [];
  const sections = new Set<string>();
  let total = 0;
  let lastSection: string | undefined;
  let lastWanted = wanted === undefined;
  const parser = ciLogLines(kind, (line) => {
    if (line.section !== lastSection) {
      lastSection = line.section;
      lastWanted = wanted === undefined || lastSection?.toLowerCase().includes(wanted) === true;
      if (lastSection !== undefined && sections.size < MAX_LISTED_SECTIONS) sections.add(lastSection);
    }
    if (!lastWanted) return;
    ring[total % lines] = line.text;
    total++;
  });
  parser.push(raw);
  parser.end();
  const shown = Math.min(total, lines);
  const tail = Array.from({ length: shown }, (_, at) => ring[(total - shown + at) % lines]!);
  return { text: tail.join('\n'), shown, total, sections: [...sections] };
}


function signInAgainText(target: { readonly account: AccountRecord; readonly server: ForgeServer }): string {
  return `${target.account.login} on ${target.server.id} must sign in again before the GitHub and GitLab tools can use it. Ask the user to sign in again in Settings › Models & accounts › Git hosting.`;
}

/** frame: the server's own text under the result header, fenced as the server's content is everywhere else. */
async function failureText(err: unknown, server: ForgeServer, what: string, frame: (body: string) => Promise<string>): Promise<string> {
  if (err instanceof InputError) return err.message;
  if (err instanceof ForgeHttpError && err.foreignHost !== undefined) {
    const where = `${err.foreignHost}, where ${server.id} redirected the request,`;
    switch (err.kind) {
      case 'network': return err.privateAddress
        ? `${where} is a private address, which Damocles reaches only as a Git hosting server's own address.`
        : `Could not reach ${err.foreignHost}, where ${server.id} redirected the request.`;
      case 'tls': return `${where} presented a certificate this computer does not trust.`;
      default: return `${where} could not answer: ${cleanLine(err.message)}.`;
    }
  }
  if (err instanceof ForgeHttpError) {
    switch (err.kind) {
      case 'refused': {
        const refused = `${server.id} refused the request${err.status !== undefined ? ` (HTTP ${err.status})` : ''}.`;
        return err.serverText !== undefined ? `${refused} The server's reason:\n${await frame(cleanLine(err.serverText, MAX_REFUSAL_CHARS))}` : refused;
      }
      case 'notFound': return `${server.id} has no ${what}, or the account cannot see it.`;
      case 'forbidden': return `${server.id} refused this request: the account lacks the permission it needs.`;
      case 'rateLimited': return `${server.id} is limiting requests${err.retryAt !== undefined ? ` until ${new Date(err.retryAt).toISOString()}` : ''}. Try again later.`;
      case 'unauthorized': return `${server.id} refused the account's token. Ask the user to sign in again in Settings › Models & accounts › Git hosting.`;
      case 'network': return `Could not reach ${server.id}.`;
      case 'tls': return `${server.id} presented a certificate this computer does not trust.`;
      default: return `${server.id} could not answer: ${cleanLine(err.message)}.`;
    }
  }
  return `The request to ${server.id} failed: ${cleanLine(err instanceof Error ? err.message : String(err))}.`;
}

export function createForgeTools(deps: ForgeToolsDeps): ForgeTools {
  /** The refused notice's data for a call that found no account on server. */
  function noAccount(request: ForgeToolRequest, server: ForgeServer, text: string, account?: AccountRecord): ForgeToolAnswer {
    const refusal: ForgeToolRefusal = { serverId: server.id, serverLabel: server.id, project: request.project, account: account ? accountOf(account) : null, reason: 'noAccount' };
    return { text, isError: true, refusal };
  }

  function accountOf(account: AccountRecord): ForgeToolRefusal['account'] {
    const avatarKey = deps.avatarKey(account);
    return { id: account.id, login: account.login, ...(avatarKey !== undefined ? { avatarKey } : {}) };
  }

  async function resolve(request: ForgeToolRequest, write: boolean, signal: AbortSignal): Promise<{ readonly target: Target } | { readonly answer: ForgeToolAnswer }> {
    const input = request.input;
    const remoteName = input['remote'];
    if (remoteName !== undefined && (typeof remoteName !== 'string' || !isRemoteName(remoteName))) return { answer: failed('remote must be the name of one of the repository\'s git remotes.') };
    const project = input['project'];
    if (project !== undefined && write) return { answer: failed('Writes act only on this project\'s own repository; project is for reads.') };
    if (project !== undefined && !deps.readAnyRepository()) {
      return { answer: failed('Reading another repository is off. The GitHub and GitLab tools read only this project\'s repositories unless the user turns on "Let agent tools read any repository" in Settings.') };
    }
    const servers = deps.servers();
    // the fetch URL names the repository, else a managed push URL; a push URL at another path of the same server is a fork
    const located = request.endpoints.flatMap((endpoint) => {
      const fetched = endpoint.fetch ? matchServer(endpoint.fetch, servers) : undefined;
      const pushed = endpoint.push ? matchServer(endpoint.push, servers) : undefined;
      const match = fetched ?? pushed;
      if (!match) return [];
      const usernameHint = (fetched ? endpoint.fetch : endpoint.push)!.usernameHint;
      const fork = fetched && pushed && pushed.server.id === fetched.server.id && pushed.repoPath !== fetched.repoPath ? pushed.repoPath : undefined;
      return [{ remote: endpoint.remote, ...match, usernameHint, ...(fork !== undefined ? { fork } : {}) }];
    });
    if (remoteName !== undefined && !request.endpoints.some((endpoint) => endpoint.remote === remoteName)) {
      return { answer: failed(`This repository has no remote named ${remoteName}. Its remotes: ${request.endpoints.map((endpoint) => endpoint.remote).join(', ') || 'none'}.`) };
    }
    const chosen = remoteName !== undefined
      ? located.find((item) => item.remote === remoteName)
      : located.find((item) => item.remote === (request.pushRemote ?? 'origin')) ?? located.find((item) => item.remote === 'origin') ?? located[0];
    if (!chosen) {
      return { answer: failed(remoteName !== undefined
        ? `The remote ${remoteName} is not on a GitHub or GitLab server Damocles knows.`
        : 'This project has no git remote on a GitHub or GitLab server Damocles knows, so the GitHub and GitLab tools have nothing to work on.') };
    }
    const { server } = chosen;
    let repoPath = checkedRepoPath(server.kind, chosen.repoPath);
    if (repoPath === undefined) return { answer: failed(`The remote ${chosen.remote} names a repository path the GitHub and GitLab tools do not accept.`) };
    const ownPath = repoPath;
    const sourceRepoPath = request.tool === TOOL_FORGE_OPEN_MERGE_REQUEST && chosen.fork !== undefined ? checkedRepoPath(server.kind, chosen.fork) : undefined;
    if (request.tool === TOOL_FORGE_OPEN_MERGE_REQUEST && chosen.fork !== undefined && sourceRepoPath === undefined) {
      return { answer: failed(`The remote ${chosen.remote} pushes to a repository path the GitHub and GitLab tools do not accept.`) };
    }
    if (typeof project === 'string') {
      const other = checkedRepoPath(server.kind, project);
      if (other === undefined) return { answer: failed(server.kind === 'github' ? 'project must be owner/repo.' : 'project must be a project path such as group/project.') };
      repoPath = other;
    } else if (project !== undefined) {
      return { answer: failed('project must be text.') };
    }
    const accounts = deps.accounts().filter((account) => account.serverId === server.id);
    if (accounts.length === 0) return { answer: noAccount(request, server, `Damocles has no account on ${server.id}. Ask the user to sign in to ${server.id} in Settings › Models & accounts › Git hosting.`) };
    const settled = resolveWithoutAccess({ ...(request.projectKey !== undefined ? { projectKey: request.projectKey } : {}), authorityKey: request.authorityKey, server, ...(chosen.usernameHint !== undefined ? { usernameHint: chosen.usernameHint } : {}) }, accounts, deps.bindings);
    if (settled?.account === null) {
      return { answer: noAccount(request, server, `This project uses Git's own credentials on ${server.id}, so the GitHub and GitLab tools have no account there. Ask the user to choose an account for this project.`) };
    }
    if (signal.aborted) throw signal.reason;
    const account = settled?.account ?? await deps.pickByAccess(accounts.filter((candidate) => !deps.needsSignIn(candidate)), server, ownPath, signal);
    if (!account) return { answer: noAccount(request, server, `Damocles could not tell which ${server.id} account this project uses. Ask the user to choose one in the notice below this call.`) };
    const how: ResolveHow = settled?.how ?? 'access';
    const expected = request.expected;
    // a relayed target's branches come from the target host, so they pass the same check as an input's
    const branchRefused = (name: string | undefined): boolean => name !== undefined && checkedBranch(name) === undefined;
    if (expected && (expected.serverId !== server.id || expected.repoPath !== repoPath || expected.accountId !== account.id || expected.sourceRepoPath !== sourceRepoPath
      || branchRefused(expected.sourceBranch) || branchRefused(expected.targetBranch))) {
      deps.log(`[forge] ${request.tool} refused: its repository, account or branches changed after the gate decided it`);
      return { answer: failed(write ? TARGET_CHANGED : READ_TARGET_CHANGED) };
    }
    return { target: { server, repoPath, account, how, api: server.kind === 'github' ? githubRepoApi : gitlabRepoApi, ...(sourceRepoPath !== undefined ? { sourceRepoPath } : {}) } };
  }

  /** Runs with the target's token; an organization policy or a sign-in becomes the call's answer. */
  async function withTarget(request: ForgeToolRequest, target: Target, signal: AbortSignal, what: string, work: (ctx: RepoContext) => Promise<ForgeToolAnswer>): Promise<ForgeToolAnswer> {
    if (deps.needsSignIn(target.account)) return failed(signInAgainText(target));
    try {
      return await deps.withToken(target.account, target.server, (token) => work({ http: deps.http, server: target.server, token, repoPath: target.repoPath, signal }));
    } catch (err) {
      if (signal.aborted) throw err;
      if (err instanceof ForgeHttpError && (err.kind === 'ssoRequired' || err.kind === 'appNotApproved')) {
        const org = target.repoPath.split('/')[0]!;
        deps.noteOrgAccess(target.account, { kind: err.kind, org, ...(err.ssoUrl !== undefined ? { url: err.ssoUrl } : {}) });
        const text = err.kind === 'ssoRequired'
          ? `The ${org} organization requires SAML single sign-on, and ${target.account.login}'s token is not authorized for it. Ask the user to authorize Damocles for ${org}.`
          : `The ${org} organization has not approved Damocles, so ${target.account.login}'s token cannot see its repositories. Ask the user to request approval.`;
        const refusal: ForgeToolRefusal = { serverId: target.server.id, serverLabel: target.server.id, project: request.project, account: accountOf(target.account), reason: 'orgAccess', org: { name: org, kind: err.kind === 'ssoRequired' ? 'sso' : 'approval' } };
        return { text, isError: true, refusal };
      }
      deps.log(`[forge] ${request.tool} on ${target.server.id} failed: ${err instanceof ForgeHttpError ? err.kind : err instanceof Error ? err.name : typeof err}`);
      return failed(await failureText(err, target.server, what, async (body) => (await framed(target, request, body)).text));
    }
  }

  async function framed(target: Target, request: ForgeToolRequest, body: string): Promise<ForgeToolAnswer> {
    return { text: await frameOutput({ kind: kindName(target.server), server: target.server.id, project: target.repoPath, login: target.account.login }, body, request.authorityKey === 'local') };
  }

  async function read(request: ForgeToolRequest, target: Target, signal: AbortSignal): Promise<ForgeToolAnswer> {
    const input = request.input;
    const { server, api } = target;
    switch (request.tool) {
      case TOOL_FORGE_PIPELINES: {
        const ref = branch(input, 'branch', request.branch);
        const limit = optionalInt(input, 'limit', MAX_LIST, DEFAULT_LIST);
        return withTarget(request, target, signal, repositoryNoun(target), async (ctx) => {
          const pipelines = await api.pipelines(ctx, { ...(ref !== undefined ? { ref } : {}), limit });
          const body = pipelines.length === 0 ? `No ${server.kind === 'github' ? 'workflow runs' : 'pipelines'}${ref !== undefined ? ` for ${ref}` : ''}.` : pipelines.map((pipeline) => pipelineLine(server, pipeline)).join('\n');
          return framed(target, request, body);
        });
      }
      case TOOL_FORGE_JOBS: {
        const pipeline = positiveInt(input, 'pipeline');
        return withTarget(request, target, signal, `${server.kind === 'github' ? 'workflow run' : 'pipeline'} ${pipeline}`, async (ctx) => {
          const { jobs, truncated } = await api.jobs(ctx, pipeline);
          const cut = truncated ? `\nThe list is cut: ${server.id} lists more jobs than the ${MAX_LIST_PAGES} pages read${server.kind === 'gitlab' ? ', and the earliest stages are the ones left out' : ''}.` : '';
          return framed(target, request, `${jobs.length === 0 ? `Pipeline ${pipeline} has no jobs.` : jobs.map(jobLine).join('\n')}${cut}`);
        });
      }
      case TOOL_FORGE_JOB_LOG: {
        const job = positiveInt(input, 'job');
        const lines = optionalInt(input, 'lines', JOB_LOG_TAIL_LINES, JOB_LOG_TAIL_LINES);
        const section = text(input, 'section', MAX_FILTER_CHARS, false);
        return withTarget(request, target, signal, `job ${job}`, async (ctx) => {
          const details = await api.job(ctx, job);
          if (server.kind === 'github' && GITHUB_UNFINISHED.has(details.status)) return framed(target, request, `${jobLine(details)}\nGitHub publishes this job's log when the job completes.`);
          const log = await api.jobLog(ctx, job);
          const tail = jobLogTail(server.kind, log.text, lines, section);
          const sections = tail.sections.length > 0 ? `\nSections: ${tail.sections.map((name) => cleanLine(name, 120)).join(', ')}` : '';
          const filter = section !== undefined ? ` in sections matching "${cleanLine(section, MAX_FILTER_CHARS)}"` : '';
          const of = log.truncated ? `the log's last ${MAX_JOB_LOG_BYTES / 1024 / 1024} MiB, ${tail.total}` : String(tail.total);
          return framed(target, request, `${jobLine(details)}\nLast ${tail.shown} of ${of} lines${filter}.${sections}\n\n${tail.text}`);
        });
      }
      case TOOL_FORGE_MERGE_REQUEST: {
        const number = positiveInt(input, 'number');
        return withTarget(request, target, signal, `${mrWord(server)} ${mrRef(server, number)}`, async (ctx) => {
          const [mr, notes] = await Promise.all([api.mergeRequest(ctx, number), api.mergeRequestNotes(ctx, number, NOTES_SHOWN)]);
          return framed(target, request, mergeRequestText(server, mr, notes));
        });
      }
      case TOOL_FORGE_MERGE_REQUESTS: {
        const state = oneOf(input, 'state', ['open', 'closed', 'merged', 'all'] as const, 'open');
        const limit = optionalInt(input, 'limit', MAX_LIST, DEFAULT_LIST);
        return withTarget(request, target, signal, repositoryNoun(target), async (ctx) => {
          const mrs = await api.mergeRequests(ctx, { state, limit });
          const body = mrs.length === 0 ? `No ${state === 'all' ? '' : `${state} `}${mrWord(server)}s.` : mrs.map((mr) => `${mrRef(server, mr.number)} ${cleanLine(mr.title, MAX_TITLE_CHARS)} · ${cleanLine(mr.state, 40)}${mr.draft ? ', draft' : ''} · ${cleanLine(mr.author, 80)} · ${cleanLine(mr.sourceBranch, 255)} into ${cleanLine(mr.targetBranch, 255)}`).join('\n');
          return framed(target, request, body);
        });
      }
      case TOOL_FORGE_ISSUE: {
        const number = positiveInt(input, 'number');
        return withTarget(request, target, signal, `issue #${number}`, async (ctx) => {
          const [issue, notes] = await Promise.all([api.issue(ctx, number), api.issueNotes(ctx, number, NOTES_SHOWN)]);
          return framed(target, request, issueText(server, issue, notes));
        });
      }
      case TOOL_FORGE_ISSUES: {
        const state = oneOf(input, 'state', ['open', 'closed', 'all'] as const, 'open');
        const limit = optionalInt(input, 'limit', MAX_LIST, DEFAULT_LIST);
        return withTarget(request, target, signal, repositoryNoun(target), async (ctx) => {
          const issues = await api.issues(ctx, { state, limit });
          const body = issues.length === 0 ? `No ${state === 'all' ? '' : `${state} `}issues.` : issues.map((issue) => `#${issue.number} ${cleanLine(issue.title, MAX_TITLE_CHARS)} · ${cleanLine(issue.state, 40)} · ${cleanLine(issue.author, 80)}`).join('\n');
          return framed(target, request, body);
        });
      }
      default:
        return failed(`${request.tool} is not a GitHub or GitLab tool.`);
    }
  }

  /** A write's parsed input, exactly what run sends and the approval card shows. */
  type WriteCall =
    | { readonly tool: typeof TOOL_FORGE_COMMENT; readonly on: 'mergeRequest' | 'issue'; readonly number: number; readonly body: string }
    | { readonly tool: typeof TOOL_FORGE_JOB_ACTION; readonly job: number; readonly action: 'retry' | 'cancel' }
    | { readonly tool: typeof TOOL_FORGE_OPEN_MERGE_REQUEST; readonly sourceBranch: string; readonly targetBranch: string | undefined; readonly title: string; readonly body: string; readonly draft: boolean };

  function writeCall(request: ForgeToolRequest): WriteCall {
    const input = request.input;
    switch (request.tool) {
      case TOOL_FORGE_COMMENT:
        return { tool: TOOL_FORGE_COMMENT, on: oneOf(input, 'on', ['mergeRequest', 'issue'] as const, 'mergeRequest'), number: positiveInt(input, 'number'), body: outgoing(text(input, 'body', MAX_TEXT_CHARS, true)!) };
      case TOOL_FORGE_JOB_ACTION:
        return { tool: TOOL_FORGE_JOB_ACTION, job: positiveInt(input, 'job'), action: oneOf(input, 'action', ['retry', 'cancel'] as const) };
      case TOOL_FORGE_OPEN_MERGE_REQUEST: {
        const sourceBranch = branch(input, 'sourceBranch', request.branch);
        if (sourceBranch === undefined) throw new InputError('sourceBranch must be a branch name; this chat is on no branch.');
        const title = outgoing(text(input, 'title', MAX_TITLE_CHARS, true)!).replace(/\s+/g, ' ').trim();
        if (title === '') throw new InputError('title must hold visible text; hidden characters are removed before it is sent.');
        return {
          tool: TOOL_FORGE_OPEN_MERGE_REQUEST,
          sourceBranch,
          targetBranch: branch(input, 'targetBranch'),
          title,
          body: outgoing(text(input, 'body', MAX_TEXT_CHARS, false) ?? ''),
          draft: input['draft'] === true,
        };
      }
      default:
        throw new InputError(`${request.tool} is not a GitHub or GitLab write tool.`);
    }
  }

  async function write(request: ForgeToolRequest, target: Target, call: WriteCall, signal: AbortSignal): Promise<ForgeToolAnswer> {
    const { server, api } = target;
    const as = `${target.account.login} on ${server.id}`;
    const contentHash = contentHashOf(server, call);
    if (request.expected?.contentHash !== undefined && request.expected.contentHash !== contentHash) {
      deps.log(`[forge] ${request.tool} refused: its text changed after its card showed it`);
      return failed(TARGET_CHANGED);
    }
    switch (call.tool) {
      case TOOL_FORGE_COMMENT: {
        const what = call.on === 'mergeRequest' ? `${mrWord(server)} ${mrRef(server, call.number)}` : `issue #${call.number}`;
        return withTarget(request, target, signal, what, async (ctx) => {
          const posted = await api.comment(ctx, call.on, call.number, call.body);
          return { text: `Posted comment ${posted.id} on ${what} of ${target.repoPath} as ${as}.` };
        });
      }
      case TOOL_FORGE_JOB_ACTION:
        return withTarget(request, target, signal, `job ${call.job}`, async (ctx) => {
          const job = await api.jobAction(ctx, call.job, call.action);
          if (job === null) return framed(target, request, `Requested a rerun of job ${call.job}. GitHub does not list its new attempt yet; ForgeJobs on its workflow run lists it once it starts.`);
          const verb = call.action === 'retry' ? 'Retried' : server.kind === 'github' ? 'Cancelled the workflow run of' : 'Cancelled';
          return framed(target, request, `${verb} job ${call.job}. Now: ${jobLine(job)}`);
        });
      case TOOL_FORGE_OPEN_MERGE_REQUEST: {
        const expected = request.expected;
        const title = postedTitleOf(server, call);
        if (expected?.sourceBranch !== undefined && expected.sourceBranch !== call.sourceBranch) return failed(TARGET_CHANGED);
        if (expected?.targetBranch !== undefined && call.targetBranch !== undefined && expected.targetBranch !== call.targetBranch) return failed(TARGET_CHANGED);
        return withTarget(request, target, signal, repositoryNoun(target), async (ctx) => {
          const targetBranch = expected?.targetBranch ?? call.targetBranch ?? await defaultBranchOf(api, ctx);
          const mr = await api.openMergeRequest(ctx, {
            sourceBranch: call.sourceBranch,
            ...(target.sourceRepoPath !== undefined ? { sourceRepoPath: target.sourceRepoPath } : {}),
            targetBranch,
            title,
            body: call.body,
            draft: call.draft,
          });
          return framed(target, request, `Opened ${mrWord(server)} ${mrRef(server, mr.number)} from ${cleanLine(mr.sourceBranch, 255)} into ${cleanLine(mr.targetBranch, 255)} as ${as}.${link(mr.webUrl)}`);
        });
      }
    }
  }

  /** The repository's default branch, refused when it is no branch name a request may carry. */
  async function defaultBranchOf(api: ForgeRepoApi, ctx: RepoContext): Promise<string> {
    const name = await api.defaultBranch(ctx);
    if (checkedBranch(name) === undefined) throw new InputError('The repository names a default branch the GitHub and GitLab tools do not accept; give targetBranch.');
    return name;
  }

  function howNote(how: ResolveHow): LocalizedText {
    switch (how) {
      case 'bound': return l('chosen by you');
      case 'hostDefault': return l('the host default');
      default: return l('chosen automatically');
    }
  }

  async function approvalOf(request: ForgeToolRequest, target: Target, call: WriteCall, signal: AbortSignal): Promise<ForgeApprovalAnswer> {
    const { server, api, account } = target;
    const login = account.login;
    const shownTitle = call.tool === TOOL_FORGE_OPEN_MERGE_REQUEST ? postedTitleOf(server, call) : undefined;
    let title: LocalizedText;
    let subjectDetail: string | undefined;
    // facts of the call's subject, shown after the project's; their detail is data only
    const subjectFacts: PermissionFact[] = [];
    let approvedStatus: LocalizedText;
    let content: PermissionDetail['content'];
    let branches: { readonly sourceBranch: string; readonly targetBranch: string } | undefined;
    const what = call.tool === TOOL_FORGE_COMMENT
      ? call.on === 'mergeRequest' ? `${mrWord(server)} ${mrRef(server, call.number)}` : `issue #${call.number}`
      : call.tool === TOOL_FORGE_JOB_ACTION ? `job ${call.job}` : repositoryNoun(target);
    const looked = await withTarget(request, target, signal, what, async (ctx) => {
      switch (call.tool) {
        case TOOL_FORGE_COMMENT: {
          const ref = call.on === 'mergeRequest' ? mrRef(server, call.number) : `#${call.number}`;
          const subject = call.on === 'mergeRequest' ? await api.mergeRequest(ctx, call.number) : await api.issue(ctx, call.number);
          subjectDetail = `${ref} ${cleanLine(subject.title, MAX_TITLE_CHARS)}`;
          title = call.on === 'issue'
            ? l('Comment on issue {0}?', ref)
            : server.kind === 'github' ? l('Comment on pull request {0}?', ref) : l('Comment on merge request {0}?', ref);
          approvedStatus = l('Allowed once. Posting the comment to {0} as {1} on {2}.', ref, login, server.id);
          content = { label: l('Comment text'), text: call.body };
          break;
        }
        case TOOL_FORGE_JOB_ACTION: {
          const job = await api.job(ctx, call.job);
          const name = cleanLine(job.name, 120);
          subjectFacts.push({ label: l('Job'), value: name, detail: String(call.job) });
          title = call.action === 'retry' ? l('Retry job {0}?', name) : server.kind === 'github' ? l('Cancel the workflow run of job {0}?', name) : l('Cancel job {0}?', name);
          approvedStatus = call.action === 'retry'
            ? l('Allowed once. Retrying job {0} as {1} on {2}.', name, login, server.id)
            : server.kind === 'github'
              ? l('Allowed once. Cancelling the workflow run of job {0} as {1} on {2}.', name, login, server.id)
              : l('Allowed once. Cancelling job {0} as {1} on {2}.', name, login, server.id);
          break;
        }
        case TOOL_FORGE_OPEN_MERGE_REQUEST: {
          const targetBranch = call.targetBranch ?? await defaultBranchOf(api, ctx);
          branches = { sourceBranch: call.sourceBranch, targetBranch };
          subjectFacts.push(
            { label: l('Source branch'), value: call.sourceBranch, ...(target.sourceRepoPath !== undefined ? { detail: target.sourceRepoPath } : {}) },
            { label: l('Target branch'), value: targetBranch },
          );
          title = server.kind === 'github'
            ? call.draft ? l('Open a draft pull request from {0} into {1}?', call.sourceBranch, targetBranch) : l('Open a pull request from {0} into {1}?', call.sourceBranch, targetBranch)
            : call.draft ? l('Open a draft merge request from {0} into {1}?', call.sourceBranch, targetBranch) : l('Open a merge request from {0} into {1}?', call.sourceBranch, targetBranch);
          approvedStatus = server.kind === 'github'
            ? l('Allowed once. Opening the pull request as {0} on {1}.', login, server.id)
            : l('Allowed once. Opening the merge request as {0} on {1}.', login, server.id);
          content = { label: l('Title and description'), text: call.body === '' ? shownTitle! : `${shownTitle!}\n\n${call.body}` };
          break;
        }
      }
      return { text: '' };
    });
    if (looked.isError) return { ok: false, answer: looked };
    const avatarKey = deps.avatarKey(account);
    const facts: PermissionFact[] = [
      { label: l('Server'), value: server.id },
      { label: l('Project'), value: target.repoPath, ...(subjectDetail !== undefined ? { detail: subjectDetail } : {}) },
      ...subjectFacts,
      { label: l('Account'), value: login, avatar: avatarKey !== undefined ? { key: avatarKey } : {}, note: howNote(target.how) },
    ];
    const contentHash = contentHashOf(server, call);
    const detail: PermissionDetail = {
      title: title!,
      subtitle: l('writes to the server as you'),
      facts,
      ...(content !== undefined ? { content } : {}),
      alwaysAllowLabel: l("Yes, and don't ask again for {0} on {1}", request.tool, target.repoPath),
      approvedStatus: approvedStatus!,
    };
    const project = ruleContentOf(target);
    return {
      ok: true,
      project,
      detail,
      suggestion: { type: 'addRules', rules: [{ toolName: request.tool, ruleContent: project }], behavior: 'allow', destination: 'localSettings' },
      target: { ...targetOf(target), ...(branches ?? {}), ...(contentHash !== undefined ? { contentHash } : {}) },
    };
  }

  const isTool = (tool: string): boolean => FORGE_READ_TOOLS.has(tool) || FORGE_WRITE_TOOLS.has(tool);

  /** An input the tool refuses is the call's answer; anything else is thrown on. */
  async function guarded<T>(work: () => Promise<T>, onInput: (answer: ForgeToolAnswer) => T): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof InputError) return onInput(failed(err.message));
      throw err;
    }
  }

  return {
    async run(request, signal) {
      if (!isTool(request.tool)) return failed(`${request.tool} is not a GitHub or GitLab tool.`);
      const writes = FORGE_WRITE_TOOLS.has(request.tool);
      return guarded(async () => {
        const call = writes ? writeCall(request) : undefined;
        const resolved = await resolve(request, writes, signal);
        if ('answer' in resolved) return resolved.answer;
        return call !== undefined ? write(request, resolved.target, call, signal) : read(request, resolved.target, signal);
      }, (answer) => answer);
    },

    async approval(request, signal) {
      if (!FORGE_WRITE_TOOLS.has(request.tool)) return { ok: false, answer: failed(`${request.tool} is not a GitHub or GitLab write tool.`) };
      return guarded(async (): Promise<ForgeApprovalAnswer> => {
        const call = writeCall(request);
        const resolved = await resolve(request, true, signal);
        if ('answer' in resolved) return { ok: false, answer: resolved.answer };
        return approvalOf(request, resolved.target, call, signal);
      }, (answer) => ({ ok: false, answer }));
    },

    async target(request, signal) {
      if (!isTool(request.tool)) return { ok: false, answer: failed(`${request.tool} is not a GitHub or GitLab tool.`) };
      const resolved = await resolve(request, FORGE_WRITE_TOOLS.has(request.tool), signal);
      return 'answer' in resolved ? { ok: false, answer: resolved.answer } : { ok: true, project: ruleContentOf(resolved.target), target: targetOf(resolved.target) };
    },
  };
}

function targetOf(target: Target): ForgeTarget {
  return { serverId: target.server.id, repoPath: target.repoPath, accountId: target.account.id, ...(target.sourceRepoPath !== undefined ? { sourceRepoPath: target.sourceRepoPath } : {}) };
}

/** The title an opened merge request is posted with: GitLab marks a draft in the title, GitHub by a flag. */
function postedTitle(server: ForgeServer, call: { readonly title: string; readonly draft: boolean }): string {
  return server.kind === 'gitlab' && call.draft ? `Draft: ${call.title}` : call.title;
}

/** postedTitle, refused past the servers' 255 characters (GitLab's limit, the draft prefix and any redaction included). */
function postedTitleOf(server: ForgeServer, call: { readonly title: string; readonly draft: boolean }): string {
  const posted = postedTitle(server, call);
  if ([...posted].length > MAX_TITLE_CHARS) throw new InputError(`The title as posted${server.kind === 'gitlab' && call.draft ? ' ("Draft: " included)' : ''} is longer than ${MAX_TITLE_CHARS} characters; shorten title.`);
  return posted;
}

/** SHA-256 of the text a write posts as its card shows it, as hex; undefined for a write that posts no text. */
function contentHashOf(server: ForgeServer, call: { readonly tool: string; readonly body?: string; readonly title?: string; readonly draft?: boolean }): string | undefined {
  if (call.body === undefined) return undefined;
  const title = call.title !== undefined ? postedTitle(server, { title: call.title, draft: call.draft === true }) : null;
  return createHash('sha256').update(JSON.stringify([call.tool, title, call.body])).digest('hex');
}

/** What a settings rule names a call's target by: "<server>/<repository path>", such as "gitlab.com/grp/damocles". */
export function ruleContentOf(target: { readonly server: ForgeServer; readonly repoPath: string }): string {
  return `${target.server.id}/${target.repoPath}`;
}
