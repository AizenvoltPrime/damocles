import { promises as fs } from 'node:fs';
import { EDITOR_FORMAT_TIMEOUT_MS, type EditorFormatReason, type EditorFormatReply } from '../../preload/shell-channels';
import { isInsideRealRoot, type Project } from '../documents/confine';
import type { HostOutcome, HostRoot } from './formatter-hosts';
import { isPrettierConfigured, nearestPrettierConfig, resolvePrettier, supportedMajor } from './prettier-resolve';

// Monaco's built-in formatters in the shell: the TypeScript worker for TS and JS, the JSON worker for JSON.
const BUILTIN_LANGUAGES: ReadonlySet<string> = new Set(['typescript', 'javascript', 'json']);
// Characters of an error's first line the Format log keeps.
const MAX_LOGGED_ERROR_CHARS = 500;

/** An open, editable text document inside a project, as the editor pane holds it. */
export interface FormatTarget {
  // the file's real path when it was opened
  readonly path: string;
  readonly projectKey: string;
  // '/' separated, inside the project
  readonly relativePath: string;
  readonly name: string;
  readonly languageId: string;
}

export interface FormatAction {
  readonly label: string;
  readonly run: () => void;
}

export interface FormatServiceDeps {
  readonly target: (documentId: string) => FormatTarget | undefined;
  // the listed projects, read on every request
  readonly projects: () => readonly Project[];
  // read on every request: trust is checked when the request arrives and again right before Prettier runs
  readonly isTrusted: (fsPath: string) => boolean;
  readonly requestTrust: (fsPath: string) => void;
  readonly formatOnSave: () => boolean;
  readonly hosts: { format(target: HostRoot, request: { readonly prettier: string; readonly config: string | null; readonly file: string; readonly text: string }): Promise<HostOutcome> };
  // a NotificationService notice, which never takes focus
  readonly notify: (severity: 'info' | 'warning', message: string, action?: FormatAction) => void;
  // the Format log sink; show opens it as a log tab (D36)
  readonly formatLog: { appendLine(line: string): void; show(): void };
  readonly log: (line: string) => void;
  readonly t: (message: string, ...args: Array<string | number>) => string;
}

// starting: Prettier had not loaded within the budget, and its host keeps loading
type Failure = { readonly by: 'prettier' | 'builtin'; readonly timedOut: boolean; readonly starting?: boolean };

// The Format log opens as an editor tab (D36), so it holds no file text: an error's first line only, without control characters.
export function loggedError(message: string): string {
  const first = message.split(/\r?\n/, 1)[0] ?? '';
  // eslint-disable-next-line no-control-regex -- control characters are what this removes
  return first.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, MAX_LOGGED_ERROR_CHARS);
}

/**
 * Format on save and Format Document (D29): picks each file's formatter and runs Prettier through the formatter host of
 * the file's root. The shell gets formatted text or a verdict, never a path.
 */
export class FormatService {
  private readonly deps: FormatServiceDeps;
  // notices a save shows once per run, by project, kind and detail
  private readonly noticed = new Set<string>();

  constructor(deps: FormatServiceDeps) {
    this.deps = deps;
  }

  async format(documentId: string, text: string, reason: EditorFormatReason): Promise<EditorFormatReply> {
    if (reason === 'save' && !this.deps.formatOnSave()) return { kind: 'skipped' };
    const target = this.deps.target(documentId);
    if (!target) return { kind: 'skipped' };
    const project = this.trustedProject(target.projectKey);
    if (project === 'missing') return { kind: 'skipped' };
    if (project === 'untrusted') {
      this.untrustedNotice(this.projectOf(target.projectKey)!, reason);
      return { kind: 'skipped' };
    }
    try {
      return await this.formatTrusted(project, target, text, reason);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log(`[format] formatting ${target.path} failed: ${message}`);
      this.failed(project, target, reason, { by: 'prettier', timedOut: false }, `not formatted: ${loggedError(message)}`);
      return { kind: 'failed' };
    }
  }

  /** The shell's built-in formatter failed or ran past the budget, and the save went on unformatted. */
  builtinFailed(documentId: string, reason: EditorFormatReason, timedOut: boolean, message: string): void {
    const target = this.deps.target(documentId);
    const project = target ? this.trustedProject(target.projectKey) : 'missing';
    if (!target || typeof project === 'string') return;
    const outcome = timedOut ? `the built-in formatter took longer than ${EDITOR_FORMAT_TIMEOUT_MS} ms` : `the built-in formatter failed: ${loggedError(message)}`;
    this.failed(project, target, reason, { by: 'builtin', timedOut }, outcome);
  }

  private projectOf(projectKey: string): Project | undefined {
    return this.deps.projects().find((project) => project.key === projectKey);
  }

  private trustedProject(projectKey: string): Project | 'missing' | 'untrusted' {
    const project = this.projectOf(projectKey);
    if (!project) return 'missing';
    return this.deps.isTrusted(project.fsPath) ? project : 'untrusted';
  }

  private async formatTrusted(project: Project, target: FormatTarget, text: string, reason: EditorFormatReason): Promise<EditorFormatReply> {
    const realRoot = await fs.realpath(project.fsPath);
    let realFile: string;
    try {
      realFile = await fs.realpath(target.path);
    } catch (err) {
      // A file deleted under its editor has no folder to resolve from; the save recreates it unformatted.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'skipped' };
      throw err;
    }
    if (!isInsideRealRoot(realRoot, realFile)) {
      this.deps.log(`[format] refused to format ${target.path}: it is no longer inside ${project.fsPath}`);
      return { kind: 'skipped' };
    }
    const nested = await this.untrustedProjectHolding(realRoot, project, realFile);
    if (nested) {
      this.untrustedNotice(nested, reason);
      return { kind: 'skipped' };
    }
    const resolved = await resolvePrettier(realRoot, realFile);
    if (resolved.kind === 'outside') {
      this.notice(reason, project, `outside\n${resolved.packageDir}`, 'warning',
        this.deps.t('Prettier was not run on {0}. The nearest Prettier is outside the project, at {1}. Add the folder that holds it as a project to use it.', target.name, resolved.packageDir));
      this.logLine(project, target, `not formatted: the nearest Prettier is outside the project, at ${resolved.packageDir}`);
      return { kind: 'skipped' };
    }
    if (resolved.kind === 'inside') {
      const major = supportedMajor(resolved.version);
      if (major === undefined) {
        const version = resolved.version === '' ? this.deps.t('of an unknown version') : resolved.version;
        this.notice(reason, project, `version\n${resolved.version}`, 'warning', this.deps.t('Prettier {0} was not run on {1}. Format on save runs Prettier 2 and 3.', version, target.name));
        this.logLine(project, target, `not formatted: Prettier ${resolved.version || 'of an unknown version'} is not supported`);
        return { kind: 'skipped' };
      }
      // A config past the root, or the plugins it names, is code the user never trusted; the host loads only this one.
      const config = await nearestPrettierConfig(realRoot, realFile, major);
      if (config && !config.inside) {
        this.notice(reason, project, `configOutside\n${config.path}`, 'warning',
          this.deps.t('Prettier was not run on {0}. Its nearest config is outside the project, at {1}. Add a Prettier config to this project, or add the folder that holds that config as a project.', target.name, config.path));
        this.logLine(project, target, `not formatted: the nearest Prettier config is outside the project, at ${config.path}`);
        return { kind: 'skipped' };
      }
      // Read again after the awaits above: trust and the project list can change while the resolution runs.
      if (typeof this.trustedProject(target.projectKey) === 'string') return { kind: 'skipped' };
      const outcome = await this.deps.hosts.format({ key: project.key, root: realRoot }, { prettier: resolved.entry, config: config?.path ?? null, file: realFile, text });
      if (outcome.kind === 'formatted') return outcome.text === text ? { kind: 'unchanged' } : { kind: 'formatted', text: outcome.text };
      if (outcome.kind === 'ignored') return { kind: 'unchanged' };
      if (outcome.kind === 'refused') {
        this.notice(reason, project, `refused\n${outcome.path}`, 'warning',
          this.deps.t('Prettier could not format {0}: it needs {1}, which is outside the project, so it was not loaded. Install it in this project, or add the folder that holds it as a project.', target.name, outcome.path));
        this.logLine(project, target, `not formatted: Prettier ${resolved.version} needs ${outcome.path}, which is outside the project`);
        return { kind: 'failed' };
      }
      if (outcome.kind === 'timeout') {
        const logged = outcome.starting
          ? `Prettier ${resolved.version} took longer than ${EDITOR_FORMAT_TIMEOUT_MS} ms to load; it keeps loading for the next format`
          : `Prettier ${resolved.version} took longer than ${EDITOR_FORMAT_TIMEOUT_MS} ms and was stopped`;
        this.failed(project, target, reason, { by: 'prettier', timedOut: true, starting: outcome.starting }, logged);
        return { kind: 'failed' };
      }
      this.failed(project, target, reason, { by: 'prettier', timedOut: false }, `Prettier ${resolved.version} failed: ${loggedError(outcome.message)}`);
      return { kind: 'failed' };
    }
    if (await isPrettierConfigured(realRoot, realFile)) {
      this.notice(reason, project, 'notInstalled', 'warning',
        this.deps.t('Prettier is configured in this project but not installed, so {0} was not formatted. Install the project\'s dependencies to format it.', target.name));
      this.logLine(project, target, 'not formatted: Prettier is configured but not installed');
      return { kind: 'skipped' };
    }
    return BUILTIN_LANGUAGES.has(target.languageId) ? { kind: 'builtin' } : { kind: 'skipped' };
  }

  // Trust is per folder: a listed project nested in this one formats its files only while it is trusted itself.
  private async untrustedProjectHolding(realRoot: string, project: Project, realFile: string): Promise<Project | undefined> {
    for (const other of this.deps.projects()) {
      if (other.key === project.key || this.deps.isTrusted(other.fsPath)) continue;
      let realOther: string;
      try {
        realOther = await fs.realpath(other.fsPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      // An untrusted folder around this project is no concern: its files outside the root never reach the host.
      if (isInsideRealRoot(realRoot, realOther) && isInsideRealRoot(realOther, realFile)) return other;
    }
    return undefined;
  }

  private untrustedNotice(project: Project, reason: EditorFormatReason): void {
    const message = reason === 'save'
      ? this.deps.t('Format on save is off in untrusted folders. Trust {0} to format its files.', project.name)
      : this.deps.t('Format Document is off in untrusted folders. Trust {0} to format its files.', project.name);
    this.notice(reason, project, 'untrusted', 'info', message, { label: this.deps.t('Trust'), run: () => this.deps.requestTrust(project.fsPath) });
  }

  // A save shows each notice once per project and run; Format Document, which the user asked for, shows it every time.
  private notice(reason: EditorFormatReason, project: Project, key: string, severity: 'info' | 'warning', message: string, action?: FormatAction): void {
    const id = `${project.key}\n${key}`;
    if (reason === 'save' && this.noticed.has(id)) return;
    this.noticed.add(id);
    this.deps.notify(severity, message, action);
  }

  private failed(project: Project, target: FormatTarget, reason: EditorFormatReason, failure: Failure, logged: string): void {
    this.logLine(project, target, logged);
    const { t } = this.deps;
    const seconds = EDITOR_FORMAT_TIMEOUT_MS / 1000;
    const what = failure.by === 'builtin'
      ? (failure.timedOut ? t('The built-in formatter took longer than {0} seconds on {1} and was stopped.', seconds, target.name) : t('The built-in formatter could not format {0}.', target.name))
      : failure.starting ? t('Prettier took longer than {0} seconds to start for {1}.', seconds, target.name)
        : failure.timedOut ? t('Prettier took longer than {0} seconds on {1} and was stopped.', seconds, target.name) : t('Prettier could not format {0}.', target.name);
    const message = reason === 'save' ? `${what} ${t('The file was saved unformatted.')}` : what;
    this.deps.notify('warning', message, { label: t('Show Output'), run: () => this.deps.formatLog.show() });
  }

  private logLine(project: Project, target: FormatTarget, outcome: string): void {
    this.deps.formatLog.appendLine(`${new Date().toISOString()} [${project.name}] ${target.relativePath}: ${outcome}`);
  }
}
