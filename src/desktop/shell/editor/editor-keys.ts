import type { editor as MonacoEditor, IDisposable } from 'monaco-editor/editor/editor.api';
import type { Monaco } from '@/components/editor/useMonaco';
import { EDITOR_GIT_KEYBINDINGS, type EditorGitKey, type ShellPlatform } from '../../preload/shell-channels';

// The editor-scoped git keys are Monaco keybindings, since Electron accelerators cannot express chords (plan slice 12,
// Keyboard); EDITOR_GIT_KEYBINDINGS is the one table, which the palette shows too.

// One accelerator ("CmdOrCtrl+Alt+S") as a Monaco key code with its modifiers.
function keyOf(monaco: Monaco, accelerator: string): number {
  const { KeyMod, KeyCode } = monaco;
  const modifiers: Readonly<Record<string, number>> = { CmdOrCtrl: KeyMod.CtrlCmd, Alt: KeyMod.Alt, Shift: KeyMod.Shift };
  const parts = accelerator.split('+');
  const key = parts.pop()!;
  const code = /^F\d+$/.test(key) ? KeyCode[key as 'F5'] : KeyCode[`Key${key}` as 'KeyK'];
  return parts.reduce((sum, part) => sum | modifiers[part]!, code);
}

/**
 * Adds the git keys as actions of this editor alone: Monaco scopes an action's keybindings by the editor's id, and the
 * returned handle removes them, so a remounted editor never stacks bindings and another editor's keys never reach run.
 */
export function addEditorGitKeybindings(
  editor: Pick<MonacoEditor.IStandaloneCodeEditor, 'addAction'>,
  monaco: Monaco,
  labels: Readonly<Record<EditorGitKey, string>>,
  run: (command: EditorGitKey) => void,
): IDisposable {
  const actions = (Object.keys(EDITOR_GIT_KEYBINDINGS) as EditorGitKey[]).map((command) => {
    const [first, second] = EDITOR_GIT_KEYBINDINGS[command].map((accelerator) => keyOf(monaco, accelerator));
    return editor.addAction({
      id: `damocles.git.${command}`,
      label: labels[command],
      keybindings: [second === undefined ? first! : monaco.KeyMod.chord(first!, second)],
      run: () => run(command),
    });
  });
  return { dispose: () => actions.forEach((action) => action.dispose()) };
}

/** The actions' names, which Monaco's own command list shows. */
export function gitKeyLabels(t: (key: string) => string): Record<EditorGitKey, string> {
  return {
    nextChange: t('quickDiff.nextChange'),
    previousChange: t('quickDiff.previousChange'),
    stageSelectedRanges: t('quickDiff.stageSelectedRanges'),
    unstageSelectedRanges: t('quickDiff.unstageSelectedRanges'),
    revertSelectedRanges: t('quickDiff.revertSelectedRanges'),
  };
}

/** The peek's Next and Previous Change keys as the platform writes them. */
export function editorChordLabels(platform: ShellPlatform): { readonly next: string; readonly previous: string } {
  const label = (accelerator: string): string =>
    platform === 'darwin' ? accelerator.replace('Shift+', '⇧').replace('Alt+', '⌥').replace('CmdOrCtrl+', '⌘') : accelerator.replace('CmdOrCtrl', 'Ctrl');
  return { next: label(EDITOR_GIT_KEYBINDINGS.nextChange[0]!), previous: label(EDITOR_GIT_KEYBINDINGS.previousChange[0]!) };
}
