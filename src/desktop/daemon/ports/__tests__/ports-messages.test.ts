import { describe, expect, it } from 'vitest';
import { channelTransport } from '../../../../remote/channel-transport';
import type { MessageChannel } from '../../../../remote/mux';
import { createEndpoint } from '../../../core-protocol/endpoint';
import { INVALID } from '../../../core-protocol/schema';
import {
  CLIENT_TO_PORTS,
  MAX_PORT_CANDIDATES,
  MAX_PORT_HOST_CHARS,
  MAX_PROCESS_COMMAND_CHARS,
  MAX_PROCESS_NAME_CHARS,
  PORTS_MAX_MESSAGE_BYTES,
  PORTS_TO_CLIENT,
  type ClientToPorts,
  type PortCandidate,
  type PortsToClient,
} from '../ports-messages';

describe('the ports channel\'s list', () => {
  it(`carries ${MAX_PORT_CANDIDATES} candidates within the channel's bound with every field at its largest`, () => {
    const sent: Uint8Array[] = [];
    const channel = { id: 4, send: (bytes: Uint8Array) => sent.push(bytes), onMessage: () => ({ dispose: () => undefined }), drained: async () => undefined } as MessageChannel;
    const endpoint = createEndpoint<PortsToClient, ClientToPorts>({ transport: channelTransport(channel, PORTS_MAX_MESSAGE_BYTES, () => undefined), outgoing: PORTS_TO_CLIENT, incoming: CLIENT_TO_PORTS, log: () => undefined });
    // U+0800 is the first character UTF-8 writes in 3 bytes
    const wide = (length: number): string => '\u0800'.repeat(length);
    const host = `${'a'.repeat(MAX_PORT_HOST_CHARS - 1)}b`;
    const candidates: PortCandidate[] = Array.from({ length: MAX_PORT_CANDIDATES }, (_, index) => ({
      port: 65535 - (index % 100),
      bindAddress: host,
      family: 6,
      host,
      pid: 2 ** 32,
      process: { name: wide(MAX_PROCESS_NAME_CHARS), command: wide(MAX_PROCESS_COMMAND_CHARS) },
    }));
    expect(PORTS_TO_CLIENT.events.list({ candidates })).not.toBe(INVALID);
    endpoint.emit('list', { candidates });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.length).toBeLessThanOrEqual(PORTS_MAX_MESSAGE_BYTES);
  });

  it('names a stream only by an id the mux opens', () => {
    const connect = CLIENT_TO_PORTS.requests.connect.params;
    expect(connect({ stream: 0, host: 'localhost', port: 80 })).toBe(INVALID);
    expect(connect({ stream: 15, host: 'localhost', port: 80 })).toBe(INVALID);
    expect(connect({ stream: 16, host: 'localhost', port: 80 })).toEqual({ stream: 16, host: 'localhost', port: 80 });
  });
});
