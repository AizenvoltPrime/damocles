import { describe, expect, it } from 'vitest';
import { createTerminalBackend } from '../terminal/terminal-backend';
import { CLI_HOOK_ENV, cliTerminalEnvironment, langFromLocale, registryEnvironment, terminalEnvironment } from '../terminal/terminal-env';

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

  it('removes an inherited DAMOCLES_CLI_HOOK in any case, so no terminal names a socket that is not its own', () => {
    const env = terminalEnvironment({ LANG: 'en_US.UTF-8', DAMOCLES_CLI_HOOK: '/tmp/damocles-a/cli-1.sock', damocles_cli_hook: 'x', BROWSER: 'firefox' }, OPTIONS);
    expect(env).toEqual({ LANG: 'en_US.UTF-8', BROWSER: 'firefox', COLORTERM: 'truecolor' });
  });

  it('gives a target\'s user terminal its hook, bin/remote-cli first on PATH and the BROWSER helper', () => {
    const posix = cliTerminalEnvironment({ PATH: '/usr/bin:/bin', BROWSER: 'firefox', HOME: '/home/ada' }, { hook: '/tmp/damocles-a/cli-1.sock', remoteCliDir: '/home/ada/.damocles/server/1.0.0/bin/remote-cli', browser: '/home/ada/.damocles/server/1.0.0/bin/helpers/browser.sh', platform: 'linux' });
    expect(posix).toEqual({
      PATH: '/home/ada/.damocles/server/1.0.0/bin/remote-cli:/usr/bin:/bin',
      [CLI_HOOK_ENV]: '/tmp/damocles-a/cli-1.sock',
      BROWSER: '/home/ada/.damocles/server/1.0.0/bin/helpers/browser.sh',
      HOME: '/home/ada',
    });
    expect(cliTerminalEnvironment({}, { hook: 'h', remoteCliDir: '/r', browser: '/b', platform: 'darwin' })['PATH']).toBe('/r');
  });

  it('replaces Path, the hook and BROWSER in whatever case a Windows target names them, so the shell gets each once', () => {
    const env = cliTerminalEnvironment({ Path: 'C:\\Windows', browser: 'msedge', Damocles_Cli_Hook: 'old' }, { hook: '\\\\.\\pipe\\damocles-cli-1', remoteCliDir: 'C:\\srv\\bin\\remote-cli', browser: 'C:\\srv\\bin\\helpers\\browser.exe', platform: 'win32' });
    expect(env).toEqual({ Path: 'C:\\srv\\bin\\remote-cli;C:\\Windows', browser: 'C:\\srv\\bin\\helpers\\browser.exe', Damocles_Cli_Hook: '\\\\.\\pipe\\damocles-cli-1' });
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

describe('a Windows terminal\'s environment from the registry', () => {
  const base = { Path: 'C:\\old', USERPROFILE: 'C:\\Users\\ada', SystemRoot: 'C:\\Windows', TEMP: 'C:\\inherited', KEEP: 'kept' };

  it('lays the machine\'s values, then the user\'s, over what Damocles inherited, joining Path machine then user', () => {
    const env = registryEnvironment(base, [
      { name: 'Path', type: 'REG_EXPAND_SZ', data: '%SystemRoot%\\system32;%SystemRoot%' },
      { name: 'TEMP', type: 'REG_EXPAND_SZ', data: '%SystemRoot%\\TEMP' },
      { name: 'OS', type: 'REG_SZ', data: 'Windows_NT' },
    ], [
      { name: 'Path', type: 'REG_EXPAND_SZ', data: '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Damocles\\resources\\bin' },
      { name: 'TEMP', type: 'REG_EXPAND_SZ', data: '%USERPROFILE%\\AppData\\Local\\Temp' },
    ]);
    expect(env).toEqual({
      Path: 'C:\\Windows\\system32;C:\\Windows;C:\\Users\\ada\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Damocles\\resources\\bin',
      USERPROFILE: 'C:\\Users\\ada',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Users\\ada\\AppData\\Local\\Temp',
      OS: 'Windows_NT',
      KEEP: 'kept',
    });
  });

  it('expands REG_SZ values never and Path always, sets each key\'s REG_SZ values before its REG_EXPAND_SZ ones, and keeps an unknown %NAME%', () => {
    const env = registryEnvironment({ path: 'C:\\old' }, [
      { name: 'ROOT_X', type: 'REG_EXPAND_SZ', data: '%TOOLS%\\x;%NOPE%' },
      { name: 'TOOLS', type: 'REG_SZ', data: 'C:\\Tools' },
      { name: 'LITERAL', type: 'REG_SZ', data: '%TOOLS%' },
      { name: 'PATH', type: 'REG_SZ', data: '%TOOLS%;' },
    ], [{ name: 'Path', type: 'REG_SZ', data: '%tools%\\user' }]);
    // a variable takes its new value under the name it already has, whatever the case
    expect(env).toEqual({ path: 'C:\\Tools;C:\\Tools\\user', ROOT_X: 'C:\\Tools\\x;%NOPE%', TOOLS: 'C:\\Tools', LITERAL: '%TOOLS%' });
  });

  it('takes the user\'s Path alone when the machine names none', () => {
    expect(registryEnvironment({ PATH: 'C:\\old' }, [], [{ name: 'Path', type: 'REG_SZ', data: 'C:\\mine' }])).toEqual({ PATH: 'C:\\mine' });
  });

  it('is read again for each new terminal, under the terminal\'s own variables', async () => {
    let reads = 0;
    const backend = createTerminalBackend({
      starters: { startPtyHost: () => { throw new Error('no pty host in this test'); } },
      platform: 'win32',
      scriptsDir: '',
      zshDotDir: '',
      homedir: '',
      env: { Path: 'C:\\old', ELECTRON_RUN_AS_NODE: '1' },
      currentEnvironment: (env) => ({ ...env, Path: `C:\\read-${++reads}`, [CLI_HOOK_ENV]: 'from-the-registry' }),
      log: () => undefined,
    });
    expect(await backend.environment('en-US')).toEqual({ Path: 'C:\\read-1', LANG: 'en_US.UTF-8', COLORTERM: 'truecolor' });
    expect((await backend.environment('en-US'))['Path']).toBe('C:\\read-2');
  });
});
