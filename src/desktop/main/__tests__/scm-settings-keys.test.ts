import { describe, expect, it } from 'vitest';
import { SCM_SETTING_KEYS } from '../../../core/scm/settings-keys';
import { DESKTOP_CONFIGURATION, isDesktopSettingValue } from '../desktop-configuration';

describe('source control setting keys', () => {
  it('equal the damocles.desktop.git.* keys desktop-configuration.ts declares', () => {
    const declared = Object.keys(DESKTOP_CONFIGURATION).filter((key) => key.startsWith('damocles.desktop.git.')).sort();
    expect(Object.values(SCM_SETTING_KEYS).sort()).toEqual(declared);
  });

  it('keep VS Code defaults, except autofetch, which is on', () => {
    const defaults = Object.fromEntries(Object.entries(SCM_SETTING_KEYS).map(([name, key]) => [name, DESKTOP_CONFIGURATION[key]!.default]));
    expect(defaults).toEqual({
      untrackedChanges: 'mixed',
      repositoryScanMaxDepth: 1,
      openRepositoryInParentFolders: 'prompt',
      inputValidation: false,
      inputValidationSubjectLength: 50,
      inputValidationLength: 72,
      allowNoVerifyCommit: false,
      confirmNoVerifyCommit: true,
      confirmEmptyCommits: true,
      enableSmartCommit: false,
      suggestSmartCommit: true,
      smartCommitChanges: 'all',
      postCommitCommand: 'none',
      branchProtection: [],
      branchProtectionPrompt: 'alwaysPrompt',
      promptToSaveFilesBeforeCommit: 'always',
      alwaysSignOff: false,
      enableCommitSigning: false,
      branchPrefix: '',
      // VS Code's git.autofetch is false; Damocles fetches the selected project by default (D10)
      autofetch: true,
      autofetchPeriod: 180,
      allowForcePush: false,
      rebaseWhenSync: false,
      followTagsWhenSync: false,
      autoStash: false,
      pruneOnFetch: false,
      confirmSync: true,
      defaultCloneDirectory: '',
      openAfterClone: 'prompt',
      pullBeforeCheckout: false,
      promptToSaveFilesBeforeStash: 'always',
      blameEditorDecoration: true,
    });
  });

  it('accepts a branchProtection list of strings only', () => {
    expect(isDesktopSettingValue(SCM_SETTING_KEYS.branchProtection, ['main', 'release/*'])).toBe(true);
    expect(isDesktopSettingValue(SCM_SETTING_KEYS.branchProtection, [])).toBe(true);
    expect(isDesktopSettingValue(SCM_SETTING_KEYS.branchProtection, 'main')).toBe(false);
    expect(isDesktopSettingValue(SCM_SETTING_KEYS.branchProtection, ['main', 1])).toBe(false);
    expect(isDesktopSettingValue(SCM_SETTING_KEYS.postCommitCommand, 'sync')).toBe(true);
    expect(isDesktopSettingValue(SCM_SETTING_KEYS.postCommitCommand, 'pull')).toBe(false);
  });
});
