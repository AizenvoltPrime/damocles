import type { EditorReadOnlyReason } from '../../preload/shell-channels';

// Each reason's shell locale key, typed so a new or renamed reason fails the typecheck until it has a key here; the key must
// exist in every shell locale.
export const readOnlyMessageKey: Record<EditorReadOnlyReason, string> = {
  encoding: 'editor.readOnly.encoding',
  log: 'editor.readOnly.log',
  snapshot: 'editor.readOnly.snapshot',
  tooLarge: 'editor.readOnly.tooLarge',
};
