import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ utilityProcess: {} }));

import { langFromLocale, terminalEnvironment } from '../terminal/terminal-env';

const ZSH_DOT_DIR = '/Users/ada/Library/Application Support/Damocles/shell-integration/zsh';
const OPTIONS = { locale: 'en-US', zshDotDir: ZSH_DOT_DIR };

describe('terminal environment', () => {
  it('keeps the merged login environment and drops every ELECTRON_ variable, whatever its case', () => {
    const env = terminalEnvironment({
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/home/ada',
      NVM_DIR: '/home/ada/.nvm',
      LANG: 'el_GR.UTF-8',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ATTACH_CONSOLE: '1',
      ELECTRON_ENABLE_LOGGING: 'true',
      electron_no_asar: '1',
      NOT_ELECTRON_VAR: 'kept',
      EMPTY: '',
      UNSET: undefined,
    }, OPTIONS);
    expect(env).toEqual({
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/home/ada',
      NVM_DIR: '/home/ada/.nvm',
      LANG: 'el_GR.UTF-8',
      NOT_ELECTRON_VAR: 'kept',
      EMPTY: '',
      COLORTERM: 'truecolor',
    });
  });

  it('drops the integration scripts\' variables and a ZDOTDIR naming the app\'s own, which a Damocles started from its own terminal inherits', () => {
    const env = terminalEnvironment({
      LANG: 'en_US.UTF-8',
      DAMOCLES_NONCE: 'f'.repeat(32),
      DAMOCLES_INJECTION: '1',
      DAMOCLES_SHELL_INTEGRATION_SCRIPT: '/Applications/Damocles.app/shellIntegration.fish',
      DAMOCLES_SHELL_LOGIN: '1',
      DAMOCLES_USER_ZDOTDIR: '/Users/ada',
      DAMOCLES_ZDOTDIR: ZSH_DOT_DIR,
      DAMOCLES_PROFILE_INITIALIZED: '1',
      DAMOCLES_LOGIN_INITIALIZED: '1',
      DAMOCLES_SHELL_INTEGRATION: '1',
      ZDOTDIR: ZSH_DOT_DIR,
      DAMOCLES_E2E_HOOKS: '1',
      DAMOCLES_SCREENSHOT_DIR: '/tmp/shots',
    }, OPTIONS);
    expect(env).toEqual({ LANG: 'en_US.UTF-8', DAMOCLES_E2E_HOOKS: '1', DAMOCLES_SCREENSHOT_DIR: '/tmp/shots', COLORTERM: 'truecolor' });
  });

  it('keeps the user\'s own ZDOTDIR', () => {
    expect(terminalEnvironment({ LANG: 'en_US.UTF-8', ZDOTDIR: '/Users/ada/.config/zsh' }, OPTIONS)['ZDOTDIR']).toBe('/Users/ada/.config/zsh');
  });

  it('sets LANG from the app locale when it is missing or not UTF-8, and keeps a UTF-8, utf8 or EUC one', () => {
    const lang = (value: string | undefined, locale = 'el'): string | undefined => terminalEnvironment({ LANG: value }, { ...OPTIONS, locale })['LANG'];
    expect(lang(undefined)).toBe('el_GR.UTF-8');
    expect(lang('')).toBe('el_GR.UTF-8');
    expect(lang('C')).toBe('el_GR.UTF-8');
    expect(lang('en_US.ISO8859-1', 'pt-br')).toBe('pt_BR.UTF-8');
    expect(lang('de_DE.UTF-8')).toBe('de_DE.UTF-8');
    expect(lang('de_DE.utf8')).toBe('de_DE.utf8');
    expect(lang('ja_JP.eucJP')).toBe('ja_JP.eucJP');
  });

  it('builds LANG as VS Code\'s getLangEnvVariable does', () => {
    expect(langFromLocale('en-US')).toBe('en_US.UTF-8');
    expect(langFromLocale('en-gb')).toBe('en_GB.UTF-8');
    expect(langFromLocale('el')).toBe('el_GR.UTF-8');
    expect(langFromLocale('zh-CN')).toBe('zh_CN.UTF-8');
    expect(langFromLocale('ja')).toBe('ja_JP.UTF-8');
    expect(langFromLocale('xx')).toBe('xx.UTF-8');
    expect(langFromLocale('')).toBe('en_US.UTF-8');
  });
});
