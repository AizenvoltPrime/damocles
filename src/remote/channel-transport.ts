import { CodecError, decode, encode } from './codec';
import { listeners } from './listeners';
import type { MessageChannel } from './mux';
import type { Disposable } from './persistent-protocol';

/** A message channel as an ordered `{ post, onMessage }` transport, the shape core-protocol's createEndpoint runs over. */
export interface ChannelTransport {
  // throws CodecError for a value that is not data or that the peer's bounds would refuse
  post(message: unknown): void;
  onMessage(listener: (raw: unknown) => void): Disposable;
}

// maxBytes: the channel's message bound, the same on both sides; a message that does not decode is reported and never delivered
export function channelTransport(channel: MessageChannel, maxBytes: number, onViolation: (reason: string) => void): ChannelTransport {
  const delivered = listeners<[unknown]>();
  channel.onMessage((bytes) => {
    let value: unknown;
    try {
      value = decode(bytes, { maxBytes });
    } catch (err) {
      if (!(err instanceof CodecError)) throw err;
      onViolation(`channel ${channel.id}: ${err.message}`);
      return;
    }
    delivered.fire(value);
  });
  return {
    post: (message) => {
      const bytes = encode(message);
      if (bytes.length > maxBytes) throw new CodecError(`a message of ${bytes.length} bytes, over channel ${channel.id}'s ${maxBytes} byte bound`);
      channel.send(bytes);
    },
    onMessage: delivered.add,
  };
}
