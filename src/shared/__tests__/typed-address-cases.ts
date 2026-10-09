// Chrome's typed navigations (AutocompleteInput::ShouldUpgradeToHttps), the one table every host's address bar is tested against.

export type TypedCase = readonly [kind: string, typed: string, url: string];

// Opened over https, and over http when the https load cannot connect.
export const UPGRADED: readonly TypedCase[] = [
  ['a public name', 'example.com', 'https://example.com/'],
  ['a public name with a path, query and fragment', '  example.com/a?b#c ', 'https://example.com/a?b#c'],
  ['a deeper public name, in any case', 'Docs.Example.CO.uk/x', 'https://docs.example.co.uk/x'],
  ['a public name on port 80, which is dropped', 'example.com:80/x', 'https://example.com/x'],
  // An unknown scheme not followed by // is a user name, as Chrome's omnibox reads it.
  ['a public name after a user name and password', 'user:pass@example.com', 'https://user:pass@example.com/'],
];

export const HTTP_AT_ONCE: readonly TypedCase[] = [
  ['an IPv4 address', '192.168.1.5:3000', 'http://192.168.1.5:3000/'],
  ['a public IPv4 address', '8.8.8.8', 'http://8.8.8.8/'],
  ['a loopback IPv4 address', '127.0.0.1:8080', 'http://127.0.0.1:8080/'],
  ['a shortened IPv4 address', '127.1', 'http://127.0.0.1/'],
  ['a bracketed IPv6 address', '[::1]:5173', 'http://[::1]:5173/'],
  ['a public bracketed IPv6 address', '[2001:db8::1]/x', 'http://[2001:db8::1]/x'],
  ['a single-label host', 'devbox', 'http://devbox/'],
  ['a single-label host with a port', 'devbox:8080/x', 'http://devbox:8080/x'],
  ['localhost', 'localhost:3000/docs', 'http://localhost:3000/docs'],
  ['a .localhost name', 'app.localhost', 'http://app.localhost/'],
  ['a .local name', 'MyHost.LOCAL', 'http://myhost.local/'],
  ['a .test name', 'site.test/x', 'http://site.test/x'],
  ['a .example name', 'www.example', 'http://www.example/'],
  ['an .invalid name', 'nothing.invalid', 'http://nothing.invalid/'],
  ['an .internal name', 'svc.internal', 'http://svc.internal/'],
  ['a .lan name', 'nas.lan', 'http://nas.lan/'],
  ['a .home name', 'printer.home', 'http://printer.home/'],
  ['a .corp name', 'wiki.corp', 'http://wiki.corp/'],
  ['an .intranet name', 'portal.intranet', 'http://portal.intranet/'],
  ['a .private name', 'git.private', 'http://git.private/'],
  ['a reserved name with a trailing dot', 'myhost.local.', 'http://myhost.local./'],
  ['a public name with a port', 'example.com:8443', 'http://example.com:8443/'],
];

// Typed with a scheme, and loaded as typed with the scheme in lower case.
export const AS_TYPED: readonly TypedCase[] = [
  ['an http address', 'http://example.com', 'http://example.com'],
  ['an https address with a port', 'https://devbox:8080', 'https://devbox:8080'],
  ['the blank page', 'about:blank', 'about:blank'],
  ['the blank page in capitals', 'ABOUT:BLANK', 'about:blank'],
  ['an https address with its scheme in capitals', 'HTTPS://example.com/x', 'https://example.com/x'],
];

// Refused by the rule or by isNavigableUrl, so no host navigates.
export const REFUSED: readonly string[] = ['mailto:a@example.com', 'file:///c:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,x', 'chrome://settings', 'JavaScript:alert(1)', 'site:example.com', '::1', 'two words', 'example.com:abc', '   '];
