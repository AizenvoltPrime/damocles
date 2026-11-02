import { describe, expect, it } from 'vitest';
import type { AddressResolver, ClientNetworkPolicy } from '../../../../../core/browser/client-network-policy';
import { checkClientNavigation } from '../client-network-guard';

const CLOSED: ClientNetworkPolicy = { allowedPorts: [], allowLocalNetwork: false };
const OPEN: ClientNetworkPolicy = { allowedPorts: [], allowLocalNetwork: true };

const answers: Record<string, string[]> = {
  localhost: ['::1', '127.0.0.1'],
  '127.0.0.1.nip.io': ['127.0.0.1'],
  'example.com': ['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'],
  'printer.lan': ['192.168.1.20'],
};
const resolver: AddressResolver = async (hostname) => {
  const found = answers[hostname];
  if (!found) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
  return found.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

const LOCAL_NETWORK_REASON = '{0} is on this computer or its local network. The browser of a chat on a remote host opens it only while "{1}" is on in the host\'s settings.';
const SWITCH = { message: 'Let the agent\'s browser reach this computer\'s local network' };

describe('checkClientNavigation', () => {
  it('refuses each address on this computer or its network, naming it and the host switch', async () => {
    const urls: Record<string, string> = {
      'http://localhost:3000/': 'localhost:3000',
      'http://127.0.0.1:3000/': '127.0.0.1:3000',
      'http://2130706433:3000/': '127.0.0.1:3000',
      'http://[::ffff:7f00:1]:3000/': '[::ffff:7f00:1]:3000',
      'http://0.0.0.0:3000/': '0.0.0.0:3000',
      'https://127.0.0.1.nip.io/': '127.0.0.1.nip.io',
      'http://printer.lan/': 'printer.lan',
      'http://169.254.169.254/latest/meta-data': '169.254.169.254',
      'http://[fe80::1]:8080/': '[fe80::1]:8080',
    };
    for (const [url, shown] of Object.entries(urls)) {
      expect(await checkClientNavigation(url, CLOSED, resolver), url).toEqual({ allowed: false, reason: { message: LOCAL_NETWORK_REASON, args: [shown, SWITCH] } });
    }
  });

  it('allows a forwarded port on loopback and nothing else of loopback', async () => {
    const policy: ClientNetworkPolicy = { allowedPorts: [5174], allowLocalNetwork: false };
    for (const url of ['http://localhost:5174/', 'http://127.0.0.1:5174/src', 'http://[::1]:5174/']) {
      expect(await checkClientNavigation(url, policy, resolver), url).toEqual({ allowed: true });
    }
    for (const url of ['http://localhost:5175/', 'http://0.0.0.0:5174/', 'http://printer.lan:5174/']) {
      expect((await checkClientNavigation(url, policy, resolver)).allowed, url).toBe(false);
    }
  });

  it('allows public addresses and names it cannot resolve, which reach nothing here', async () => {
    expect(await checkClientNavigation('https://example.com/a?b#c', CLOSED, resolver)).toEqual({ allowed: true });
    expect(await checkClientNavigation('http://8.8.8.8/', CLOSED, resolver)).toEqual({ allowed: true });
    expect(await checkClientNavigation('https://no-such-name.invalid/', CLOSED, resolver)).toEqual({ allowed: true });
  });

  it('refuses a name whose lookup failed for any reason but having no address, naming the error', async () => {
    const unanswered: AddressResolver = async (hostname) => {
      throw Object.assign(new Error(`getaddrinfo EAI_AGAIN ${hostname}`), { code: 'EAI_AGAIN' });
    };
    expect(await checkClientNavigation('https://example.com/', CLOSED, unanswered)).toEqual({
      allowed: false,
      reason: { message: '{0} could not be looked up on this computer ({1}), so the browser of a chat on a remote host does not open it.', args: ['example.com', 'EAI_AGAIN'] },
    });
  });

  it('allows every http address with the host switch on', async () => {
    for (const url of ['http://localhost:3000/', 'http://printer.lan/', 'http://[::ffff:7f00:1]/', 'http://10.0.0.1/']) {
      expect(await checkClientNavigation(url, OPEN, resolver), url).toEqual({ allowed: true });
    }
  });

  it('refuses what is not an http address, switch on or off', async () => {
    const reason = { message: 'The browser of a chat on a remote host opens only http and https addresses.' };
    for (const url of ['file:///C:/Users/me/.ssh/id_rsa', 'data:text/html,hi', 'javascript:alert(1)', 'chrome://settings', 'view-source:http://example.com', 'about:config', 'not a url']) {
      expect(await checkClientNavigation(url, CLOSED, resolver), url).toEqual({ allowed: false, reason });
      expect(await checkClientNavigation(url, OPEN, resolver), url).toEqual({ allowed: false, reason });
    }
    expect(await checkClientNavigation('about:blank', CLOSED, resolver)).toEqual({ allowed: true });
  });
});
