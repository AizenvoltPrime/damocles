import { describe, expect, it, vi } from 'vitest';
import { attachedTransport } from '../attached-transport';
import { createLoopback } from '../loopback';

describe('attachedTransport', () => {
  it('reads only its own generation and holds its posts until open', () => {
    const { main, core } = createLoopback();
    const onDaemon: unknown[] = [];
    core.onMessage((raw) => onDaemon.push(raw));
    const violation = vi.fn();
    main.onMessage(() => undefined);
    const transport = attachedTransport(main, 2, violation);
    const received: unknown[] = [];
    transport.onMessage((envelope) => received.push(envelope));
    transport.post({ kind: 'event' });
    expect(onDaemon).toEqual([]);
    transport.open();
    expect(onDaemon).toEqual([{ attach: 2, envelope: { kind: 'event' } }]);
    core.post({ attach: 1, envelope: 'old' });
    core.post({ attach: 2, envelope: 'mine' });
    core.post({ attach: 3, envelope: 'next' });
    expect(received).toEqual(['mine']);
    expect(violation).not.toHaveBeenCalled();
    core.post({ envelope: 'untagged' });
    expect(violation).toHaveBeenCalledTimes(1);
    transport.dispose();
    core.post({ attach: 2, envelope: 'after' });
    expect(received).toEqual(['mine']);
  });
});
