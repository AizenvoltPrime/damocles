import { describe, expect, it } from 'vitest';
import { asConfigArgs, asConfigPairs, asConfigParams, credentialHelperPath, managedEntries, managedUrls, sqQuote } from '../askpass/credential-config';

const HELPER = "/opt/Damocles O'Brien!/dist/git-credential/git-credential-relay.sh";

describe('the credential takeover config', () => {
  it('covers the web URL with its path prefix and each other git host, once', () => {
    expect(managedUrls({ webUrl: 'https://gitlab.example.com/gl', gitHosts: ['gitlab.example.com', 'git.example.com', 'git.example.com', 'ssh.example.com:2222'] }))
      .toEqual(['https://gitlab.example.com/gl', 'https://git.example.com', 'https://ssh.example.com:2222']);
    expect(managedUrls({ webUrl: 'https://github.com', gitHosts: ['github.com', 'ssh.github.com'] })).toEqual(['https://github.com', 'https://ssh.github.com']);
  });

  it('puts the reset, Damocles\' helper with the takeover flag and useHttpPath per URL, in that order', () => {
    const entries = managedEntries([{ webUrl: 'https://gitlab.com', gitHosts: ['gitlab.com'] }], HELPER);
    expect(entries).toEqual([
      ['credential.https://gitlab.com.helper', ''],
      ['credential.https://gitlab.com.helper', `!'/opt/Damocles O'\\''Brien!/dist/git-credential/git-credential-relay.sh' --takeover`],
      ['credential.https://gitlab.com.useHttpPath', 'true'],
    ]);
  });

  it('quotes each key=value as git sq_quote_buf does: quote and bang closed out and escaped, spaces kept inside', () => {
    expect(sqQuote("a b")).toBe("'a b'");
    expect(sqQuote("it's")).toBe("'it'\\''s'");
    expect(sqQuote('!x!')).toBe("''\\!'x'\\!''");
    const params = asConfigParams([['credential.https://gitlab.com.helper', "!'/a b/h.sh'"]], undefined);
    expect(params).toBe("'credential.https://gitlab.com.helper='\\!''\\''/a b/h.sh'\\'''");
  });

  it('appends to an inherited GIT_CONFIG_PARAMETERS and never makes an empty variable', () => {
    expect(asConfigParams([], undefined)).toBeUndefined();
    expect(asConfigParams([], '  ')).toBeUndefined();
    expect(asConfigParams([], "'core.x=1'")).toBe("'core.x=1'");
    expect(asConfigParams([['a.b', 'c']], "'core.x=1'")).toBe("'core.x=1' 'a.b=c'");
    expect(asConfigParams([['a.b', '']], undefined)).toBe("'a.b='");
  });

  it('refuses a line break, which would end git\'s parse of the variable', () => {
    expect(() => asConfigParams([['a.b', 'x\ny']], undefined)).toThrow(RangeError);
  });

  it('renders GIT_CONFIG_COUNT pairs from a start index and -c arguments', () => {
    expect(asConfigPairs([['a.b', '1'], ['c.d', '']], 2)).toEqual({ GIT_CONFIG_COUNT: '4', GIT_CONFIG_KEY_2: 'a.b', GIT_CONFIG_VALUE_2: '1', GIT_CONFIG_KEY_3: 'c.d', GIT_CONFIG_VALUE_3: '' });
    expect(asConfigArgs([['a.b', '1'], ['c.d', '']])).toEqual(['-c', 'a.b=1', '-c', 'c.d=']);
    expect(() => asConfigArgs([['a=b', '1']])).toThrow(RangeError);
  });

  it('names the helper the desktop build unpacks, .cmd on Windows', () => {
    expect(credentialHelperPath('/app/resources/app.asar.unpacked', 'linux')).toBe('/app/resources/app.asar.unpacked/dist/git-credential/git-credential-relay.sh');
    expect(credentialHelperPath('C:\\Damocles\\resources\\app.asar.unpacked', 'win32')).toBe('C:\\Damocles\\resources\\app.asar.unpacked\\dist\\git-credential\\git-credential-relay.cmd');
  });
});
