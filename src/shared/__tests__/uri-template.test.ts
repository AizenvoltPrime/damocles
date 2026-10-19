import { describe, expect, it } from 'vitest';
import { parseUriTemplate, resolveUriTemplate, uriTemplateVariables, type UriTemplateValue } from '../uri-template';

// The variables and expected expansions of RFC 6570 section 3.2.
const VARS: Record<string, UriTemplateValue> = {
  count: ['one', 'two', 'three'],
  dom: ['example', 'com'],
  dub: 'me/too',
  hello: 'Hello World!',
  half: '50%',
  var: 'value',
  who: 'fred',
  base: 'http://example.com/home/',
  path: '/foo/bar',
  list: ['red', 'green', 'blue'],
  v: '6',
  x: '1024',
  y: '768',
  empty: '',
  empty_list: [],
};

const expand = (template: string): string => resolveUriTemplate(parseUriTemplate(template), VARS);

describe('resolveUriTemplate', () => {
  it('expands every operator as RFC 6570 section 3.2 does', () => {
    const cases: Array<[string, string]> = [
      ['{var}', 'value'],
      ['{hello}', 'Hello%20World%21'],
      ['{half}', '50%25'],
      ['O{empty}X', 'OX'],
      ['O{undef}X', 'OX'],
      ['{x,y}', '1024,768'],
      ['{x,hello,y}', '1024,Hello%20World%21,768'],
      ['?{x,empty}', '?1024,'],
      ['?{x,undef}', '?1024'],
      ['{var:3}', 'val'],
      ['{var:30}', 'value'],
      ['{list}', 'red,green,blue'],
      ['{list*}', 'red,green,blue'],
      ['{+var}', 'value'],
      ['{+hello}', 'Hello%20World!'],
      ['{+half}', '50%25'],
      ['{base}index', 'http%3A%2F%2Fexample.com%2Fhome%2Findex'],
      ['{+base}index', 'http://example.com/home/index'],
      ['{+path}/here', '/foo/bar/here'],
      ['here?ref={+path}', 'here?ref=/foo/bar'],
      ['{+path:6}/here', '/foo/b/here'],
      ['{#var}', '#value'],
      ['{#hello}', '#Hello%20World!'],
      ['{#path:6}/here', '#/foo/b/here'],
      ['{#list*}', '#red,green,blue'],
      ['X{.var}', 'X.value'],
      ['X{.x,y}', 'X.1024.768'],
      ['www{.dom*}', 'www.example.com'],
      ['X{.list*}', 'X.red.green.blue'],
      ['X{.empty_list}', 'X'],
      ['{/who}', '/fred'],
      ['{/who,who}', '/fred/fred'],
      ['{/half,who}', '/50%25/fred'],
      ['{/who,dub}', '/fred/me%2Ftoo'],
      ['{/var,x}/here', '/value/1024/here'],
      ['{/list*}', '/red/green/blue'],
      ['{/list*,path:4}', '/red/green/blue/%2Ffoo'],
      ['{;who}', ';who=fred'],
      ['{;half}', ';half=50%25'],
      ['{;empty}', ';empty'],
      ['{;v,empty,who}', ';v=6;empty;who=fred'],
      ['{;v,bar,who}', ';v=6;who=fred'],
      ['{;x,y,empty}', ';x=1024;y=768;empty'],
      ['{;list*}', ';list=red;list=green;list=blue'],
      ['{?who}', '?who=fred'],
      ['{?half}', '?half=50%25'],
      ['{?x,y,empty}', '?x=1024&y=768&empty='],
      ['{?x,y,undef}', '?x=1024&y=768'],
      ['{?var:3}', '?var=val'],
      ['{?list}', '?list=red,green,blue'],
      ['{?list*}', '?list=red&list=green&list=blue'],
      ['?fixed=yes{&x}', '?fixed=yes&x=1024'],
      ['{&x,y,empty}', '&x=1024&y=768&empty='],
      ['{&var:3}', '&var=val'],
    ];
    for (const [template, expected] of cases) expect(expand(template), template).toBe(expected);
  });

  it('encodes as UTF-8, and keeps a pct-encoded triplet only in reserved expansion', () => {
    const template = (text: string) => parseUriTemplate(text);
    expect(resolveUriTemplate(template('x://{id}'), { id: 'é 🙂' })).toBe('x://%C3%A9%20%F0%9F%99%82');
    expect(resolveUriTemplate(template('x://{+id}'), { id: 'a%20b%zz' })).toBe('x://a%20b%25zz');
    expect(resolveUriTemplate(template('x://{id}'), { id: 'a%20b' })).toBe('x://a%2520b');
  });

  it('encodes a lone surrogate, which has no UTF-8 form, as U+FFFD, and a prefix keeps a surrogate pair whole', () => {
    const resolve = (text: string, id: string) => resolveUriTemplate(parseUriTemplate(text), { id });
    expect(resolve('x://{id}', 'a\uD800b')).toBe('x://a%EF%BF%BDb');
    expect(resolve('x://{+id}', '\uDC00')).toBe('x://%EF%BF%BD');
    expect(resolve('x://{#id}', '\uDC00\uD800')).toBe('x://#%EF%BF%BD%EF%BF%BD');
    expect(resolve('x://{id:1}', '\uD83D\uDE42z')).toBe('x://%F0%9F%99%82');
    expect(resolve('x://{id:1}', '\uD800z')).toBe('x://%EF%BF%BD');
  });

  it('expands an exploded named list with an empty item as RFC 6570 appendix A does', () => {
    const resolve = (text: string) => resolveUriTemplate(parseUriTemplate(text), { list: ['a', ''], only: [''] });
    expect(resolve('{?list*}')).toBe('?list=a&list=');
    expect(resolve('{&list*}')).toBe('&list=a&list=');
    expect(resolve('{;list*}')).toBe(';list=a;list');
    expect(resolve('{;only*}')).toBe(';only');
    expect(resolve('{?only*}')).toBe('?only=');
    expect(resolve('{/list*}')).toBe('/a/');
    expect(resolve('{?list}')).toBe('?list=a,');
  });

  it('passes an expression RFC 6570 section 3 finds invalid through unexpanded: a brace inside it, or an empty variable name', () => {
    const resolve = (text: string) => resolveUriTemplate(parseUriTemplate(text), { id: 'x', a: 'y' });
    expect(resolve('{{id}}')).toBe('{{id}}');
    expect(resolve('a{{id}/b')).toBe('a{{id}/b');
    expect(resolve('a{b{id}')).toBe('a{b{id}');
    expect(resolve('{id}}')).toBe('x}');
    expect(resolve('a{{b')).toBe('a{{b');
    expect(resolve('a}}b{id}')).toBe('a}}bx');
    expect(resolve('x{+}y')).toBe('x{+}y');
    expect(resolve('{a,}{id}')).toBe('{a,}x');
    expect(resolve('{,a}')).toBe('{,a}');
    expect(resolve('{:3}')).toBe('{:3}');
    expect(resolve('{}')).toBe('{}');
  });
});

describe('uriTemplateVariables', () => {
  it('lists each variable once in template order with its modifiers', () => {
    expect(uriTemplateVariables(parseUriTemplate('file:///{+root}/{name}{?q,name}{/path*}{v:3}'))).toEqual([
      { name: 'root', explode: false, named: false },
      { name: 'name', explode: false, named: false },
      { name: 'q', explode: false, named: true },
      { name: 'path', explode: true, named: false },
      { name: 'v', explode: false, named: false, prefixLength: 3 },
    ]);
  });

  it('lists no variable of an expression passed through unexpanded', () => {
    expect(uriTemplateVariables(parseUriTemplate('x{+}{a,}{{b}}{c}'))).toEqual([{ name: 'c', explode: false, named: false }]);
  });
});
