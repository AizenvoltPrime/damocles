import { computed, shallowRef, triggerRef, type InjectionKey } from 'vue';
import type {
  DamoclesScmApi,
  ScmArtifactsChanged,
  ScmCapabilities,
  ScmChange,
  ScmCloneState,
  ScmCommitInput,
  ScmDecoration,
  ScmRepoSnapshot,
  ScmSetInput,
  ScmSettings,
  ScmShellCommand,
  ScmTone,
  ScmView,
} from '../../preload/scm-channels';

// A folder's dot takes the tone of its strongest descendant, as VS Code's bubbled decoration does.
const FOLDER_TONE_RANK: Readonly<Record<ScmTone, number>> = { conflict: 6, deleted: 5, modified: 4, renamed: 3, added: 2, untracked: 2, submodule: 1, ignored: 0 };

/**
 * Source control's state in the shell: main's views, repository snapshots, decorations and settings as they come, plus the
 * commit box drafts, which live here for the run, one per repository (VS Code keeps one input box per repository), with each
 * box's amend mode and main's commit input (template, message history, HEAD's message).
 */
/** Text for a repository's commit box: main's setInput, or a commit's reply as cause commit. */
export type BoxText = Omit<ScmSetInput, 'cause'> & { readonly cause: ScmSetInput['cause'] | 'commit' };

export function createScmStore(api: DamoclesScmApi) {
  const views = shallowRef(new Map<string, ScmView>());
  const snapshots = shallowRef(new Map<string, ScmRepoSnapshot>());
  const decorations = shallowRef(new Map<string, Readonly<Record<string, ScmDecoration>>>());
  const settings = shallowRef<ScmSettings>({ untrackedChanges: 'mixed', inputValidation: false, inputValidationSubjectLength: 50, inputValidationLength: 72, allowNoVerifyCommit: false, allowForcePush: false });
  // the window's clone, whatever the project, and how the last one ended
  const clone = shallowRef<ScmCloneState>({ running: null, last: null });
  // what the window's git can do; read once, since git does not change under a running app
  const capabilities = shallowRef<ScmCapabilities>({ stashStaged: false });
  const drafts = shallowRef(new Map<string, string>());
  // repositories in amend mode, with the draft held before entering it, which cancel restores
  const amending = shallowRef(new Map<string, string>());
  // repositories with a commit or a message generation running; each guards its own repository only
  const committing = shallowRef(new Set<string>());
  const generating = shallowRef(new Set<string>());
  const inputs = shallowRef(new Map<string, ScmCommitInput>());
  // repositories whose template already had its chance to fill an empty box this run
  const templated = new Set<string>();
  // the latest commitInput read per repository; an older read answering later is dropped
  const inputReads = new Map<string, number>();
  let inputRead = 0;
  const setInputListeners = new Set<(input: BoxText, previous: string) => void>();
  // the operation each repository's draft was prefilled for, so MERGE_MSG fills an empty box once per merge
  const prefilled = new Map<string, string>();
  const commandListeners = new Set<(command: ScmShellCommand) => void>();
  const artifactListeners = new Set<(changed: ScmArtifactsChanged) => void>();
  const stops: Array<() => void> = [];

  const openRepos = (): Set<string> => new Set([...views.value.values()].flatMap((each) => each.repos.map((repo) => repo.repoId)));

  // A repository no longer open drops its snapshot; its draft stays for the run, as VS Code's input does until it closes.
  function dropClosedSnapshots(): void {
    const open = openRepos();
    for (const repoId of snapshots.value.keys()) if (!open.has(repoId)) snapshots.value.delete(repoId);
    triggerRef(snapshots);
  }

  function setView(view: ScmView): void {
    views.value.set(view.projectKey, view);
    triggerRef(views);
    dropClosedSnapshots();
  }

  /** Forgets the views and decorations of projects no longer registered; main sends nothing for a removed project. */
  function retainProjects(projectKeys: ReadonlySet<string>): void {
    const gone = (key: string): boolean => !projectKeys.has(key);
    if (![...views.value.keys(), ...decorations.value.keys()].some(gone)) return;
    for (const key of [...views.value.keys()].filter(gone)) views.value.delete(key);
    for (const key of [...decorations.value.keys()].filter(gone)) decorations.value.delete(key);
    triggerRef(views);
    triggerRef(decorations);
    dropClosedSnapshots();
  }

  function setSnapshot(snapshot: ScmRepoSnapshot): void {
    snapshots.value.set(snapshot.repoId, snapshot);
    triggerRef(snapshots);
    const operation = snapshot.operation;
    if (operation === null) prefilled.delete(snapshot.repoId);
    else if (snapshot.mergeMessage !== undefined && prefilled.get(snapshot.repoId) !== operation) {
      prefilled.set(snapshot.repoId, operation);
      if ((drafts.value.get(snapshot.repoId) ?? '') === '') setDraft(snapshot.repoId, snapshot.mergeMessage);
    }
  }

  function setDecorations(projectKey: string, files: Readonly<Record<string, ScmDecoration>>): void {
    decorations.value.set(projectKey, files);
    triggerRef(decorations);
  }

  function setDraft(repoId: string, text: string): void {
    drafts.value.set(repoId, text);
    triggerRef(drafts);
  }

  function setAmending(repoId: string, previousDraft: string | undefined): void {
    if (previousDraft === undefined) amending.value.delete(repoId);
    else amending.value.set(repoId, previousDraft);
    triggerRef(amending);
  }

  function mark(set: typeof committing, repoId: string, on: boolean): void {
    if (on) set.value.add(repoId);
    else set.value.delete(repoId);
    triggerRef(set);
  }

  // Main's text for the box after a commit (from its reply), an undo or Restore Commit Template.
  function applySetInput(input: BoxText): void {
    const previous = drafts.value.get(input.repoId) ?? '';
    setDraft(input.repoId, input.message);
    if (input.cause !== 'template') setAmending(input.repoId, undefined);
    // A commit or an undo changed the history and HEAD: the box and its input change in one step, so Up right after recalls
    // the new message; a read already under way answers older state and is dropped.
    if (input.commitInput) {
      inputReads.set(input.repoId, ++inputRead);
      inputs.value.set(input.repoId, input.commitInput);
      triggerRef(inputs);
    }
    for (const listener of setInputListeners) listener(input, previous);
    if (input.cause !== 'template' && !input.commitInput) void loadCommitInput(input.repoId);
  }

  /** Reads the repository's commit input again; the first read of the run fills an empty box with the template. */
  async function loadCommitInput(repoId: string): Promise<ScmCommitInput> {
    const read = ++inputRead;
    inputReads.set(repoId, read);
    const input = await api.commitInput(repoId);
    if (inputReads.get(repoId) !== read) return inputs.value.get(repoId) ?? input;
    inputs.value.set(repoId, input);
    triggerRef(inputs);
    if (!templated.has(repoId)) {
      templated.add(repoId);
      if (input.template !== null && (drafts.value.get(repoId) ?? '') === '') setDraft(repoId, input.template);
    }
    return input;
  }

  // Every folder above a decorated file, with the decoration whose tone ranks highest; ignored entries bubble nothing.
  const folders = computed(() => {
    const byProject = new Map<string, Map<string, ScmTone>>();
    for (const [projectKey, files] of decorations.value) {
      const dirs = new Map<string, ScmTone>();
      for (const [path, decoration] of Object.entries(files)) {
        if (decoration.tone === 'ignored') continue;
        for (let end = path.lastIndexOf('/'); end > 0; end = path.lastIndexOf('/', end - 1)) {
          const dir = path.slice(0, end);
          const current = dirs.get(dir);
          if (current === undefined || FOLDER_TONE_RANK[decoration.tone] > FOLDER_TONE_RANK[current]) dirs.set(dir, decoration.tone);
        }
      }
      byProject.set(projectKey, dirs);
    }
    return byProject;
  });

  async function start(): Promise<void> {
    // Subscribed before the first read, so a change between the two is not lost; the read never overwrites a newer push.
    const pushed = { views: new Set<string>(), snapshots: new Set<string>(), decorations: new Set<string>(), settings: false, clone: false };
    stops.push(api.onView((view) => {
      pushed.views.add(view.projectKey);
      setView(view);
    }));
    stops.push(api.onState((snapshot) => {
      pushed.snapshots.add(snapshot.repoId);
      setSnapshot(snapshot);
    }));
    stops.push(api.onDecorations(({ projectKey, files }) => {
      pushed.decorations.add(projectKey);
      setDecorations(projectKey, files);
    }));
    stops.push(api.onSettings((next) => {
      pushed.settings = true;
      settings.value = next;
    }));
    stops.push(api.onClone((next) => {
      pushed.clone = true;
      clone.value = next;
    }));
    stops.push(api.onSetInput(applySetInput));
    stops.push(api.onArtifactsChanged((changed) => {
      for (const listener of artifactListeners) listener(changed);
    }));
    stops.push(api.onCommand((command) => {
      for (const listener of commandListeners) listener(command);
    }));
    const initial = await api.getState();
    for (const view of initial.views) if (!pushed.views.has(view.projectKey)) setView(view);
    // a newer pushed view may have closed a repository the read still holds
    const open = openRepos();
    for (const snapshot of initial.snapshots) if (!pushed.snapshots.has(snapshot.repoId) && open.has(snapshot.repoId)) setSnapshot(snapshot);
    for (const { projectKey, files } of initial.decorations) if (!pushed.decorations.has(projectKey)) setDecorations(projectKey, files);
    if (!pushed.settings) settings.value = initial.settings;
    if (!pushed.clone) clone.value = initial.clone;
    capabilities.value = initial.capabilities;
  }

  function stop(): void {
    for (const each of stops.splice(0)) each();
    commandListeners.clear();
    artifactListeners.clear();
    setInputListeners.clear();
  }

  return {
    api,
    views,
    snapshots,
    settings,
    clone,
    capabilities,
    drafts,
    amending,
    committing,
    generating,
    inputs,
    start,
    stop,
    retainProjects,
    setDraft,
    setAmending,
    setCommitting: (repoId: string, on: boolean): void => mark(committing, repoId, on),
    setGenerating: (repoId: string, on: boolean): void => mark(generating, repoId, on),
    loadCommitInput,
    draftOf: (repoId: string): string => drafts.value.get(repoId) ?? '',
    // Amend mode applies while git can amend: never during a merge, rebase or cherry-pick.
    amendingIn: (repoId: string): boolean => amending.value.has(repoId) && snapshots.value.get(repoId)?.operation === null,
    decorationOf: (projectKey: string | undefined, path: string): ScmDecoration | undefined =>
      (projectKey === undefined ? undefined : decorations.value.get(projectKey)?.[path]),
    folderToneOf: (projectKey: string | undefined, dir: string): ScmTone | undefined =>
      (projectKey === undefined ? undefined : folders.value.get(projectKey)?.get(dir)),
    onCommand(listener: (command: ScmShellCommand) => void): () => void {
      commandListeners.add(listener);
      return () => commandListeners.delete(listener);
    },
    // main's artifactsChanged: a repository's refs, stashes or worktrees changed, and lists showing them read again
    onArtifactsChanged(listener: (changed: ScmArtifactsChanged) => void): () => void {
      artifactListeners.add(listener);
      return () => artifactListeners.delete(listener);
    },
    // previous: the box's text before main replaced it, for the swap's outgoing copy
    applyCommitted: (repoId: string, message: string, commitInput: ScmCommitInput | undefined): void =>
      applySetInput({ repoId, message, cause: 'commit', ...(commitInput ? { commitInput } : {}) }),
    onSetInput(listener: (input: BoxText, previous: string) => void): () => void {
      setInputListeners.add(listener);
      return () => setInputListeners.delete(listener);
    },
  };
}

export type ScmStore = ReturnType<typeof createScmStore>;
export const SCM_STORE: InjectionKey<ScmStore> = Symbol('scm-store');

export type { ScmChange };
