import { describe, expect, it } from 'vitest';
import { shellIntegrationInjection, type InjectionRequest } from '../terminal/shell-integration-injection';

const NONCE = 'ffeeddccbbaa99887766554433221100';
// An install path with a space, a quote, a dollar, a backtick and non-Latin letters: none of it may be parsed by a shell.
const WIN_DIR = "C:\\Program Files\\Dam'o $(x) `y` Δοκιμή\\resources\\app.asar.unpacked\\resources\\shell-integration";
const POSIX_DIR = "/opt/Dam o's $(x)/Δοκιμή/resources/shell-integration";
const ZSH_DIR = '/home/me/.config/Damocles/shell-integration/zsh';

function request(platform: NodeJS.Platform, file: string, args: readonly string[], env: Record<string, string> = {}): InjectionRequest {
  const windows = platform === 'win32';
  return { platform, file, args, scriptsDir: windows ? WIN_DIR : POSIX_DIR, zshDotDir: ZSH_DIR, nonce: NONCE, env, homedir: windows ? 'C:\\Users\\me' : '/home/me' };
}

describe('shellIntegrationInjection (VS Code getShellIntegrationInjection)', () => {
  it('dot-sources the PowerShell script from the environment, inside try on Windows, for pwsh and Windows PowerShell', () => {
    for (const file of ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\PowerShell.EXE']) {
      expect(shellIntegrationInjection(request('win32', file, []))).toEqual({
        args: ['-noexit', '-command', 'try { . $env:DAMOCLES_SHELL_INTEGRATION_SCRIPT } catch {}'],
        env: { DAMOCLES_INJECTION: '1', DAMOCLES_NONCE: NONCE, DAMOCLES_SHELL_INTEGRATION_SCRIPT: `${WIN_DIR}\\shellIntegration.ps1` },
      });
    }
    expect(shellIntegrationInjection(request('win32', 'C:\\pwsh.exe', ['-NoLogo']))?.args).toEqual(['-noexit', '-command', 'try { . $env:DAMOCLES_SHELL_INTEGRATION_SCRIPT } catch {}']);
    expect(shellIntegrationInjection(request('win32', 'C:\\pwsh.exe', ['-nol', '-Login']))?.args).toEqual(['-l', '-noexit', '-command', 'try { . $env:DAMOCLES_SHELL_INTEGRATION_SCRIPT } catch {}']);
    expect(shellIntegrationInjection(request('win32', 'C:\\pwsh.exe', ['-Command', 'x']))).toBeUndefined();
  });

  it('starts Git Bash with --init-file, imitating its login shell through DAMOCLES_SHELL_LOGIN', () => {
    expect(shellIntegrationInjection(request('win32', 'C:\\Program Files\\Git\\bin\\bash.exe', ['--login', '-i']))).toEqual({
      args: ['--init-file', `${WIN_DIR}\\shellIntegration-bash.sh`],
      env: { DAMOCLES_INJECTION: '1', DAMOCLES_NONCE: NONCE, DAMOCLES_SHELL_LOGIN: '1' },
    });
    expect(shellIntegrationInjection(request('win32', 'C:\\Git\\bin\\bash.exe', []))?.env).not.toHaveProperty('DAMOCLES_SHELL_LOGIN');
    expect(shellIntegrationInjection(request('win32', 'C:\\Git\\bin\\bash.exe', ['-c', 'ls']))).toBeUndefined();
  });

  it('injects nothing into cmd.exe, wsl.exe or any other Windows executable (VS Code\'s Windows branch)', () => {
    for (const [file, args] of [
      ['C:\\Windows\\System32\\cmd.exe', []],
      ['C:\\Windows\\System32\\wsl.exe', ['-d', 'Ubuntu']],
      ['C:\\Windows\\System32\\wsl.exe', []],
      ['C:\\msys64\\usr\\bin\\zsh.exe', []],
      ['C:\\fish\\fish.exe', []],
    ] as const) expect(shellIntegrationInjection(request('win32', file, args)), file).toBeUndefined();
  });

  it('starts bash with --init-file and a login bash with DAMOCLES_SHELL_LOGIN on macOS and Linux', () => {
    expect(shellIntegrationInjection(request('linux', '/usr/bin/bash', []))).toEqual({ args: ['--init-file', `${POSIX_DIR}/shellIntegration-bash.sh`], env: { DAMOCLES_INJECTION: '1', DAMOCLES_NONCE: NONCE } });
    expect(shellIntegrationInjection(request('darwin', '/bin/bash', ['-l']))?.env).toMatchObject({ DAMOCLES_SHELL_LOGIN: '1' });
    expect(shellIntegrationInjection(request('linux', '/bin/sh', []))).toBeUndefined();
    expect(shellIntegrationInjection(request('linux', '/usr/bin/Bash', []))).toBeUndefined();
  });

  it('points zsh at copies of its startup files in the user\'s app data and remembers the user\'s ZDOTDIR', () => {
    expect(shellIntegrationInjection(request('linux', '/usr/bin/zsh', []))).toEqual({
      args: ['-i'],
      env: { DAMOCLES_INJECTION: '1', DAMOCLES_NONCE: NONCE, ZDOTDIR: ZSH_DIR, DAMOCLES_USER_ZDOTDIR: '/home/me' },
      filesToCopy: [
        { source: `${POSIX_DIR}/shellIntegration-env.zsh`, dest: `${ZSH_DIR}/.zshenv` },
        { source: `${POSIX_DIR}/shellIntegration-profile.zsh`, dest: `${ZSH_DIR}/.zprofile` },
        { source: `${POSIX_DIR}/shellIntegration-rc.zsh`, dest: `${ZSH_DIR}/.zshrc` },
        { source: `${POSIX_DIR}/shellIntegration-login.zsh`, dest: `${ZSH_DIR}/.zlogin` },
      ],
    });
    expect(shellIntegrationInjection(request('darwin', '/bin/zsh', ['-l'], { ZDOTDIR: '/Users/me/.config/zsh' }))).toMatchObject({ args: ['-il'], env: { DAMOCLES_USER_ZDOTDIR: '/Users/me/.config/zsh' } });
    expect(shellIntegrationInjection(request('linux', '/usr/bin/zsh', ['-c', 'x']))).toBeUndefined();
  });

  it('sources the fish script from the environment, as a login shell when asked', () => {
    expect(shellIntegrationInjection(request('linux', '/usr/bin/fish', []))).toEqual({
      args: ['--init-command', 'source $DAMOCLES_SHELL_INTEGRATION_SCRIPT'],
      env: { DAMOCLES_INJECTION: '1', DAMOCLES_NONCE: NONCE, DAMOCLES_SHELL_INTEGRATION_SCRIPT: `${POSIX_DIR}/shellIntegration.fish` },
    });
    expect(shellIntegrationInjection(request('darwin', '/opt/homebrew/bin/fish', ['-l']))?.args).toEqual(['-l', '--init-command', 'source $DAMOCLES_SHELL_INTEGRATION_SCRIPT']);
  });

  it('starts pwsh on macOS and Linux without try, the script path again only in the environment', () => {
    expect(shellIntegrationInjection(request('darwin', '/usr/local/bin/pwsh', ['-l']))).toEqual({
      args: ['-l', '-noexit', '-command', '. $env:DAMOCLES_SHELL_INTEGRATION_SCRIPT'],
      env: { DAMOCLES_INJECTION: '1', DAMOCLES_NONCE: NONCE, DAMOCLES_SHELL_INTEGRATION_SCRIPT: `${POSIX_DIR}/shellIntegration.ps1` },
    });
  });

  it('never puts the scripts folder inside an argument a shell parses as source', () => {
    for (const [platform, file] of [['win32', 'C:\\pwsh.exe'], ['win32', 'C:\\Git\\bin\\bash.exe'], ['linux', '/usr/bin/fish'], ['linux', '/usr/bin/zsh'], ['darwin', '/bin/pwsh']] as const) {
      const injection = shellIntegrationInjection(request(platform, file, []))!;
      const parsedArgs = file.endsWith('bash.exe') ? injection.args.filter((arg) => arg !== injection.args[1]) : injection.args;
      for (const arg of parsedArgs) expect(arg, `${file} ${arg}`).not.toContain('Dam');
    }
  });
});
