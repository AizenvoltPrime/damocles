// Delegation to the user's own credential helpers (docs/invariants.md "GitHub and GitLab accounts", delegation): the
// answering process runs `git credential <op>` itself, without the takeover's config entries, and hands the result to
// its helper. Host-neutral: this computer's core and a daemon's core run it the same way.
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isCredentialValue, MAX_CREDENTIAL_PASSWORD_CHARS, MAX_CREDENTIAL_USERNAME_CHARS, type GitCredentialFields, type GitCredentialOp } from '../../shared/git-credential';
import { childEnv } from '../pi-session/checkpoints/exec';
import { runProcess, type RunOutput } from '../process-launcher/run';
import type { SpawnSpec } from '../process-launcher/protocol';

// Set in every delegation's environment: Damocles' helper, should a leftover entry still name it, answers nothing there.
export const DELEGATING_VARIABLE = 'DAMOCLES_CREDENTIAL_DELEGATE';
const DELEGATE_TIMEOUT_MS = 120_000;
const MAX_FILL_OUTPUT_BYTES = 64 * 1024;
// the variables that give a helper Damocles' capabilities; none reaches the user's helpers
const DAMOCLES_HELPER_VARIABLES: readonly string[] = ['DAMOCLES_ASKPASS_HANDLE', 'DAMOCLES_ASKPASS_NONCE', 'DAMOCLES_CREDENTIAL_NONCE', 'DAMOCLES_ASKPASS_NODE', 'DAMOCLES_ASKPASS_MAIN', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_CONFIG_COUNT'];

export interface DelegateRequest {
  readonly op: GitCredentialOp;
  readonly cwd: string;
  readonly fields: GitCredentialFields;
  // store and erase: the credential git named
  readonly username?: string;
  readonly password?: string;
  // the user's manager may show its own sign-in, through the askpass bridge; otherwise GCM_INTERACTIVE=never
  readonly interactive: boolean;
  // an agent shell's working folder is the agent's choice, so only the system and global helpers answer it
  readonly agentShell: boolean;
}

export interface DelegateDeps {
  // the absolute git resolveGitExecutable found; undefined without one
  readonly git: () => string | undefined;
  // the trusted project folder cwd lies in, whose repository-local helpers may then run; undefined outside one
  readonly trustedProjectAt: (cwd: string) => string | undefined;
  // an interactive registration of the answering process's askpass server, for the user's manager's prompts; a target's
  // delegation has none, since the relay asks this computer when the target's own helpers give nothing
  readonly askpass?: () => Promise<{ readonly env: Readonly<Record<string, string>>; dispose(): void }>;
  readonly log: (line: string) => void;
  readonly tmpdir?: () => string;
  readonly run?: (spec: SpawnSpec, input: string, signal: AbortSignal) => Promise<RunOutput>;
  readonly env?: () => NodeJS.ProcessEnv;
}

/** git's description of the credential: protocol, host, path and the user, plus the password for a store or erase. */
export function delegateInput(request: DelegateRequest): string {
  const { fields } = request;
  const username = request.username ?? fields.username;
  const lines = [
    `protocol=${fields.protocol}`,
    `host=${fields.host}`,
    ...(fields.path !== undefined ? [`path=${fields.path}`] : []),
    ...(username !== undefined ? [`username=${username}`] : []),
    ...(request.op !== 'get' && request.password !== undefined ? [`password=${request.password}`] : []),
  ];
  for (const line of lines) if (/[\0\r\n]/.test(line)) throw new RangeError('a credential field holds a line break or NUL');
  return `${lines.join('\n')}\n\n`;
}

/** The username and password `git credential fill` printed, each within its bound; undefined otherwise. */
export function parseFill(stdout: string): { readonly username: string; readonly password: string } | undefined {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_FILL_OUTPUT_BYTES) return undefined;
  const values = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) values.set(line.slice(0, at), line.slice(at + 1).replace(/\r$/, ''));
  }
  const username = values.get('username') ?? '';
  const password = values.get('password');
  if (!isCredentialValue(username, MAX_CREDENTIAL_USERNAME_CHARS) || !isCredentialValue(password, MAX_CREDENTIAL_PASSWORD_CHARS) || password === '') return undefined;
  return { username, password };
}

const GIT_OP: Readonly<Record<GitCredentialOp, string>> = { get: 'fill', store: 'approve', erase: 'reject' };

export interface Delegator {
  /** A get's credential from the user's helpers, or undefined when they gave none; a store or erase resolves undefined. */
  run(request: DelegateRequest, signal: AbortSignal): Promise<{ readonly username: string; readonly password: string } | undefined>;
}

export function createDelegator(deps: DelegateDeps): Delegator {
  const run = deps.run ?? ((spec, input, signal) => runProcess(spec, { input, signal, timeoutMs: DELEGATE_TIMEOUT_MS }));
  return {
    async run(request, signal) {
      const git = deps.git();
      if (git === undefined) throw new Error('Git was not found on this computer');
      // only a get may show the manager's sign-in
      const prompts = request.interactive && request.op === 'get';
      if (prompts && !deps.askpass) throw new Error('This delegation has no askpass bridge for an interactive request');
      const registration = prompts ? await deps.askpass!() : undefined;
      let empty: string | undefined;
      try {
        const project = request.agentShell ? undefined : deps.trustedProjectAt(request.cwd);
        // outside a trusted project only the system and global helpers run: no repository is discovered from an empty folder
        if (project === undefined) empty = await fs.mkdtemp(path.join((deps.tmpdir ?? os.tmpdir)(), 'damocles-git-credential-'));
        // childEnv drops an inherited GIT_CONFIG_PARAMETERS, the takeover's entries included
        const env: Record<string, string | undefined> = { ...(deps.env ?? childEnv)() };
        for (const key of Object.keys(env)) if (DAMOCLES_HELPER_VARIABLES.includes(key.toUpperCase())) delete env[key];
        // the prompt capability only on an interactive get, never the credential capability
        Object.assign(env, {
          ...registration?.env,
          GIT_TERMINAL_PROMPT: '0',
          [DELEGATING_VARIABLE]: '1',
          ...(prompts ? {} : { GCM_INTERACTIVE: 'never' }),
          // no repository above the project's folder is discovered, whose helpers no trust answer covers
          GIT_CEILING_DIRECTORIES: path.dirname(empty ?? project!),
        });
        const verb = GIT_OP[request.op];
        const output = await run({ file: git, args: ['credential', verb], cwd: empty ?? request.cwd, env, windowsHide: true, shell: false }, delegateInput(request), signal);
        const code = output.exit?.code;
        if (request.op !== 'get') {
          if (code !== 0) deps.log(`[askpass] git credential ${verb} for ${request.fields.host} exited with ${String(code ?? 'a timeout')}`);
          return undefined;
        }
        if (code !== 0) {
          deps.log(`[askpass] your own credential helpers gave nothing for ${request.fields.host} (git credential fill exited with ${String(code ?? 'a timeout')})`);
          return undefined;
        }
        const filled = parseFill(output.stdout.toString('utf8'));
        if (!filled) deps.log(`[askpass] git credential fill for ${request.fields.host} printed no usable credential`);
        return filled;
      } finally {
        registration?.dispose();
        if (empty !== undefined) await fs.rm(empty, { recursive: true, force: true });
      }
    },
  };
}
