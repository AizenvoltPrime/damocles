import { describe, expect, it } from 'vitest';
import { cmdCommands, cmdSegments, cmdSwitches, cmdTokens, parseCmdLine, type CmdLine, type CmdVariable } from '../cmd-structure';
import { COMPUTED_TEXT } from '../readonly-shell';

const values: Readonly<Record<string, CmdVariable>> = {
  V: { value: 'hello' }, AMP: { value: 'a & git status' }, CR: { value: '\r' }, LF: { value: 'x\ny' }, PF: { value: 'C:\\Program Files (x86)\\Tools' },
  GROUP: { value: '(cd x)' }, BANG: { value: '!' }, C: 'computed', S: 'syntax',
};
const lookup = (name: string): CmdVariable => values[name.toUpperCase()] ?? 'unset';
const parse = (line: string): CmdLine | { readonly blocked: string } => {
  const start = cmdSwitches(line);
  return 'blocked' in start ? start : 'help' in start ? { blocked: 'help' } : parseCmdLine(start, lookup);
};
const readings = (line: string): CmdLine['readings'] => {
  const parsed = parse(line);
  if ('blocked' in parsed) throw new Error(parsed.blocked);
  return parsed.readings;
};
/** Each reading's segment texts. */
const texts = (line: string): string[][] => readings(line).map((segments) => segments.map((segment) => segment.text.trim()));
/** Each reading's commands, as the name and the text after it. */
const commands = (line: string): Array<Array<Array<[string | undefined, string]>>> =>
  readings(line).map((segments) => segments.map((segment) => segment.commands.map((command) => [command.name, command.rest])));
const blocked = (line: string): string | undefined => {
  const parsed = parse(line);
  return 'blocked' in parsed ? parsed.blocked : undefined;
};
const X = COMPUTED_TEXT;

describe('cmd structure', () => {
  it('reads the switches up to /c or /r, attached and quoted ones included', () => {
    expect(cmdSwitches('/d /s /c "x"')).toEqual({ switches: { noAutoRun: true, strip: true, extensions: true, delayed: undefined }, command: ' "x"' });
    expect(cmdSwitches('/d/s/c x')).toMatchObject({ switches: { noAutoRun: true, strip: true }, command: ' x' });
    expect(cmdSwitches('/cgit status')).toMatchObject({ switches: { noAutoRun: false }, command: 'git status' });
    expect(cmdSwitches('/rgit status')).toMatchObject({ command: 'git status' });
    expect(cmdSwitches('"/d" "/c" echo x')).toMatchObject({ switches: { noAutoRun: true }, command: '" echo x' });
    // The quote rule then strips the quote that closed `/c`, as real cmd does.
    expect(texts('"/d" "/c" echo x')).toEqual([['echo x']]);
    expect(cmdSwitches('/v:on /e:off /c x')).toMatchObject({ switches: { delayed: true, extensions: false } });
    expect(cmdSwitches('/V:OFF /q /c x')).toMatchObject({ switches: { delayed: false } });
    expect(cmdSwitches('/t:0a /a /u /f:on /c x')).toEqual({ switches: { noAutoRun: false, strip: false, extensions: true, delayed: undefined }, command: ' x' });
    expect(cmdSwitches('/T:F /F:OFF /U /c x')).toMatchObject({ command: ' x' });
    expect(cmdSwitches('/d\n/c x')).toMatchObject({ switches: { noAutoRun: true }, command: ' x' });
    expect(cmdSwitches('/d\u0085/c x')).toMatchObject({ switches: { noAutoRun: true }, command: ' x' });
    for (const line of ['', '/d', '/k dir', '/kgit status']) expect(cmdSwitches(line), line).toEqual({ blocked: expect.stringContaining('input') });
    // cmd prints its help for /? among its switches, and runs nothing; after /c it is the command's text.
    for (const line of ['/?', '/d /? /c git add .']) expect(cmdSwitches(line), line).toEqual({ help: true });
    expect(cmdSwitches('/c /?')).toMatchObject({ command: ' /?' });
    for (const line of ['/x /c dir', 'foo /c dir', '/dx /c dir', '//c dir', '/t:0g /c dir', '/t:abc /c dir', '/f:maybe /c dir', '/d\ufeff/c dir']) {
      expect(cmdSwitches(line), line).toEqual({ blocked: expect.stringContaining('switch') });
    }
  });

  it('applies the /c quote rule, giving both readings when only "names an executable" decides', () => {
    expect(texts('/c "a b"')).toEqual([['"a b"'], ['a b']]);
    expect(texts('/c "a b" c')).toEqual([['"a b" c'], ['a b c']]);
    expect(texts('/c "a & b"')).toEqual([['a', 'b']]);
    expect(texts('/s /c "a b"')).toEqual([['a b']]);
    expect(texts('/c "echo q"x"')).toEqual([['echo q"x']]);
    expect(texts('/c "echo %V%"')).toEqual([['echo hello']]);
    expect(texts('/c echo "x"')).toEqual([['echo "x"']]);
    // cmd tests the name before expanding it, so a `%` or `!` between the quotes always strips them.
    expect(texts('/c "a %V%"')).toEqual([['a hello']]);
    expect(texts('/c "a !x!"')).toEqual([['a !x!']]);
    // cmd skips its own whitespace, a line feed and U+0085 included, before the first quote; `,;=@` are not skipped.
    expect(texts('/c \n\u0085 "a & b"')).toEqual([['a', 'b']]);
    expect(texts('/c ,"a & b"')).toEqual([['"a & b"']]);
  });

  it('expands %NAME% before parsing: a value becomes syntax, an unset name stays, a computed one is a computed word', () => {
    expect(texts('/c echo %AMP%')).toEqual([['echo a', 'git status']]);
    expect(texts('/c echo [%NO_SUCH%]')).toEqual([['echo [%NO_SUCH%]']]);
    expect(texts('/c echo [%NO_SUCH%V%]')).toEqual([['echo [%NO_SUCHhello]']]);
    expect(texts('/c echo %%V%%')).toEqual([['echo %hello%']]);
    expect(texts('/c echo %C%')).toEqual([[`echo ${X}`]]);
    // Unset, a computed name's closing `%` would open the next name.
    expect(texts('/c echo %C% %V%')).toEqual([['echo %C% hello'], [`echo ${X} hello`]]);
    expect(blocked('/c echo %S%')).toContain('sets');
    expect(blocked('/c echo %V:l=x%')).toContain('replaces');
    expect(blocked('/c echo %AMP:~1%')).toContain('syntax');
    expect(texts('/c echo %V:~1%')).toEqual([[`echo ${X}`]]);
    expect(texts('/c echo %NO:~1%')).toEqual([['echo %NO:~1%']]);
  });

  it('reads at most 16 texts of one line', () => {
    // Each computed name before another `%` doubles the texts, one reading it unset.
    expect(readings(`/c echo ${'%C% '.repeat(5)}`)).toHaveLength(16);
    expect(blocked(`/c echo ${'%C% '.repeat(6)}`)).toContain('more variables');
    // Delayed expansion from the registry doubles each text holding `^` and `!`; BANG is `!`, so only some of them do.
    expect(readings('/c echo %C%C%BANG% %C%C%BANG%')).toHaveLength(9);
    expect(readings('/c echo ^^ %C% %C%C%C%BANG%')).toHaveLength(16);
    expect(blocked('/c echo ^^ %C%C%BANG% %C%C%BANG%')).toContain('more variables');
  });

  it('splits at separators, and removes carets, redirections and a leading @', () => {
    expect(texts('/c g^it status')).toEqual([['git status']]);
    expect(texts('/c echo "a & b" ^& c')).toEqual([['echo "a & b" & c']]);
    expect(texts('/c a && b || c & d')).toEqual([['a', 'b', 'c', 'd']]);
    expect(texts('/c npm ci > "x y.log" 2>&1 && @ echo DONE >> x.log')).toEqual([['npm ci', 'echo DONE']]);
    expect(texts('/c ;;echo x')).toEqual([['echo x']]);
    expect(texts('/c echo a^')).toEqual([['echo a']]);
    const parsed = parse('/c a | b && c') as CmdLine;
    expect(parsed.readings[0]!.map((segment) => segment.piped)).toEqual([true, true, false]);
    expect(blocked('/c :label & git status')).toContain('label');
  });

  it('ends a redirection target at a delimiter, a separator or another redirection, quotes and carets kept in it', () => {
    expect(texts('/c cd >nul,x')).toEqual([['cd  ,x']]);
    expect(commands('/c cd >nul;x')).toEqual([[[['cd', '  ;x']]]]);
    expect(commands('/c pushd >nul=x')).toEqual([[[['pushd', '  =x']]]]);
    // cmd skips delimiters before the target.
    expect(texts('/c cd >,nul x')).toEqual([['cd   x']]);
    expect(texts('/c cd > ;=nul x')).toEqual([['cd   x']]);
    expect(texts('/c cd >\u00a0nul x')).toEqual([['cd   x']]);
    expect(texts('/c node p.js a >"x,y"z,q')).toEqual([['node p.js a  ,q']]);
    expect(texts('/c node p.js a >x^,y b')).toEqual([['node p.js a   b']]);
    expect(texts('/c node p.js a <nul,b')).toEqual([['node p.js a  ,b']]);
    expect(texts('/c node p.js a 2>&1,b')).toEqual([['node p.js a ,b']]);
    // A parenthesis is part of the target outside a block.
    expect(texts('/c node p.js >x(y z)w')).toEqual([['node p.js   z)w']]);
    expect(texts('/c >nul(cd x) & cd')).toEqual([['x)', 'cd']]);
  });

  it('removes carriage returns after %NAME%, those from a value included', () => {
    expect(commands('/c c\rd x')).toEqual([[[['cd', ' x']]]]);
    expect(commands('/c c%CR%d x')).toEqual([[[['cd', ' x']]]]);
    expect(commands('/c git -C pro\rject')).toEqual([[[['git', ' -C project']]]]);
  });

  it('ignores the text after the first line feed, one from a value included, inside quotes and after a caret', () => {
    expect(texts('/c echo a&echo b\necho c')).toEqual([['echo a', 'echo b']]);
    expect(texts('/c cd ^\nx&cd')).toEqual([['cd']]);
    expect(texts('/c echo "a\nb" & echo c')).toEqual([['echo "a']]);
    expect(texts('/c echo a%LF% & echo c')).toEqual([['echo ax']]);
    expect(texts('/c \n\n echo a & echo b')).toEqual([['echo a', 'echo b']]);
    // After the quote rule strips, a leading line feed is not skipped.
    expect(texts('/c "\necho a & echo b"')).toEqual([[]]);
  });

  it('reads ! as computed unless delayed expansion is off', () => {
    expect(commands('/c echo !X!')).toEqual([[[['echo', ` ${X}X${X}`]]]]);
    expect(commands('/v:off /c echo !X!')).toEqual([[[['echo', ' !X!']]]]);
    expect(cmdSegments('echo "!X!"', true)).toMatchObject([[{ text: 'echo "!X!"', commands: [{ rest: ` "${X}X${X}"` }] }]]);
  });

  it('removes the carets left after phase 2 from each part of a command holding ! when delayed expansion may be on', () => {
    expect(commands('/v:on /c node p.js -C a^^b !x!')).toEqual([[[['node', ` p.js -C ab ${X}x${X}`]]]]);
    expect(commands('/v:on /c node p.js -C a^^b')).toEqual([[[['node', ' p.js -C a^b']]]]);
    expect(commands('/v:off /c node p.js -C a^^b !x!')).toEqual([[[['node', ' p.js -C a^b !x!']]]]);
    // With no /v switch the registry decides, so both readings.
    expect(commands('/c node p.js -C a^^b !x!')).toEqual([[[['node', ` p.js -C a^b ${X}x${X}`]]], [[['node', ` p.js -C ab ${X}x${X}`]]]]);
    // Inside quotes too, and the command token and each command on its own.
    expect(commands('/v:on /c node "c^d" !x!')).toEqual([[[['node', ` "cd" ${X}x${X}`]]]]);
    expect(commands('/v:on /c no^^de a^^b !x!')).toEqual([[[['no^de', ` ab ${X}x${X}`]]]]);
    expect(commands('/v:on /c no^^de!y! a')).toEqual([[[[undefined, ' a']]]]);
    expect(commands('/v:on /c node a^^b & node !x!')).toEqual([[[['node', ' a^b ']], [['node', ` ${X}x${X}`]]]]);
    expect(commands('/v:on /c cmd/c^^x !y!')).toEqual([[[['cmd/c^x', ` ${X}y${X}`], ['cmd', `/cx ${X}y${X}`]]]]);
    // A pipe's sides keep their text, which the child cmd reads with its own delayed expansion.
    expect(texts('/v:on /c a^^^^b !x! | more')).toEqual([['a^^b !x!', 'more']]);
  });

  it('reads a parenthesis as a block only where a command starts, and every other one as text', () => {
    expect(texts('/c echo a (b) c')).toEqual([['echo a (b) c']]);
    expect(texts('/c cd C:\\Program Files (x86) & cd')).toEqual([['cd C:\\Program Files (x86)', 'cd']]);
    expect(texts('/c echo a ) & echo next')).toEqual([['echo a )', 'echo next']]);
    expect(texts('/c ) & echo next')).toEqual([[')', 'echo next']]);
    expect(texts('/c ^(echo x) & echo after')).toEqual([['(echo x)', 'echo after']]);
    expect(texts('/c echo %PF%')).toEqual([['echo C:\\Program Files (x86)\\Tools']]);
    expect(texts('/c set X=a(b) & echo next')).toEqual([['set X=a(b)', 'echo next']]);
    for (const line of ['/c (cd x) & git status', '/c echo x & (echo y)', '/c echo x | (git status)', '/c echo x&&(echo y)', '/c @(echo y)', '/c @ (echo y)', '/c ;(echo y)', '/c >nul (cd x)', '/c echo a & >nul (cd x)', '/c %GROUP% & git status']) {
      expect(blocked(line), line).toContain('parentheses');
    }
  });

  it('ends an internal command name at a delimiter or a boundary character, and a program also before a / or (', () => {
    expect(cmdCommands('cd..\\x')).toEqual([{ name: 'cd', internal: true, rest: '..\\x' }]);
    expect(cmdCommands('cd\\')).toEqual([{ name: 'cd', internal: true, rest: '\\' }]);
    expect(cmdCommands('cd/d ..')).toEqual([{ name: 'cd', internal: true, rest: '/d ..' }]);
    expect(cmdCommands('CD;sub')).toEqual([{ name: 'cd', internal: true, rest: ';sub' }]);
    for (const boundary of ['+', '[', ']', ':', '(']) expect(cmdCommands(`cd${boundary}sub`), boundary).toEqual([{ name: 'cd', internal: true, rest: `${boundary}sub` }]);
    expect(cmdCommands('cd)sub')).toEqual([{ name: 'cd)sub', internal: false, rest: '' }]);
    expect(cmdCommands('echo(x')).toEqual([{ name: 'echo', internal: true, rest: '(x' }]);
    expect(cmdCommands('setlocal x')).toEqual([{ name: 'setlocal', internal: true, rest: ' x' }]);
    expect(cmdCommands('cd"x"')).toEqual([{ name: 'cdx', internal: false, rest: '' }]);
    expect(cmdCommands('"git" status')).toEqual([{ name: 'git', internal: false, rest: ' status' }]);
    expect(cmdCommands('cmd/c echo x')).toEqual([{ name: 'cmd/c', internal: false, rest: ' echo x' }, { name: 'cmd', internal: false, rest: '/c echo x' }]);
    expect(cmdCommands('"cmd"/c echo x')).toEqual([{ name: 'cmd/c', internal: false, rest: ' echo x' }, { name: 'cmd', internal: false, rest: '/c echo x' }]);
    expect(cmdCommands('.\\pr/c echo x')).toEqual([{ name: '.\\pr/c', internal: false, rest: ' echo x' }, { name: '.\\pr', internal: false, rest: '/c echo x' }]);
    expect(cmdCommands('sub\\"pr"/c x')).toEqual([{ name: 'sub\\pr/c', internal: false, rest: ' x' }, { name: 'sub\\pr', internal: false, rest: '/c x' }]);
    expect(cmdCommands('cmd(/d/c x')).toEqual([{ name: 'cmd(/d/c', internal: false, rest: ' x' }, { name: 'cmd', internal: false, rest: '(/d/c x' }]);
    expect(cmdCommands('p(r/c x')).toEqual([{ name: 'p(r/c', internal: false, rest: ' x' }, { name: 'p', internal: false, rest: '(r/c x' }]);
    // A / or ( inside quotes does not end the name.
    expect(cmdCommands('"pr/d" x')).toEqual([{ name: 'pr/d', internal: false, rest: ' x' }]);
    expect(cmdCommands('"pr(" x')).toEqual([{ name: 'pr(', internal: false, rest: ' x' }]);
    // cmd runs neither `C:` nor `C:/x/git.exe` for this token, but a drive before ( is a drive change.
    expect(cmdCommands('C:/x/git.exe -C y')).toEqual([{ name: 'C:/x/git.exe', internal: false, rest: ' -C y' }]);
    expect(cmdCommands('D:(x')).toEqual([{ name: 'D:(x', internal: false, rest: '' }, { name: 'D:', internal: false, rest: '(x' }]);
    expect(cmdCommands('C:\\x\\cmd.exe/c y')).toEqual([{ name: 'C:\\x\\cmd.exe/c', internal: false, rest: ' y' }, { name: 'C:\\x\\cmd.exe', internal: false, rest: '/c y' }]);
    expect(cmdCommands(`g${X} status`)).toEqual([{ name: undefined, internal: false, rest: ' status' }]);
  });

  it('reads cmd\'s own whitespace as a delimiter: U+00A0, U+0085 and U+180E are, U+00FF and U+FEFF are not', () => {
    for (const space of ['\u00a0', '\u0085', '\u180e', '\u2003', '\u3000', '\v', '\f']) expect(cmdCommands(`cd${space}sub`), JSON.stringify(space)).toEqual([{ name: 'cd', internal: true, rest: `${space}sub` }]);
    for (const other of ['\u00ff', '\ufeff', '\u200b']) expect(cmdCommands(`cd${other}sub`), JSON.stringify(other)).toEqual([{ name: `cd${other}sub`, internal: false, rest: '' }]);
    expect(texts('/c \u00a0@\u0085cd x')).toEqual([['cd x']]);
    expect(cmdTokens('a\u0085b\ufeffc')).toEqual([{ text: 'a', offset: 0 }, { text: 'b\ufeffc', offset: 2 }]);
  });

  it('splits an internal command\'s text into tokens with their offsets', () => {
    expect(cmdTokens(' "t" /d "a b" x,y')).toEqual([{ text: '"t"', offset: 1 }, { text: '/d', offset: 5 }, { text: '"a b"', offset: 8 }, { text: 'x', offset: 14 }, { text: 'y', offset: 16 }]);
  });
});
