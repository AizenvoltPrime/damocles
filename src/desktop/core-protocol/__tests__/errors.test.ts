import { describe, expect, it } from 'vitest';
import { ERROR_CODEC } from '../errors';

describe('the error codec', () => {
  it('carries a system error\'s code, so the other side words a full disk or a permission problem itself', () => {
    const fault = ERROR_CODEC.encode(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }));
    expect(fault).toEqual({ name: 'Errno', data: { code: 'ENOSPC' } });
    const rebuilt = ERROR_CODEC.decode(fault!, 'ENOSPC: no space left on device, write') as NodeJS.ErrnoException;
    expect(rebuilt).toBeInstanceOf(Error);
    expect([rebuilt.message, rebuilt.code]).toEqual(['ENOSPC: no space left on device, write', 'ENOSPC']);
  });

  it('carries an error with no system code as its message only, and rebuilds no Errno whose code is not one', () => {
    expect(ERROR_CODEC.encode(new Error('plain'))).toBeUndefined();
    expect(ERROR_CODEC.encode(Object.assign(new Error('node'), { code: 'ERR_INVALID_ARG_VALUE' }))).toBeUndefined();
    expect(ERROR_CODEC.decode({ name: 'Errno', data: { code: 'not a code' } }, 'x')).toBeUndefined();
    expect(ERROR_CODEC.decode({ name: 'Errno', data: {} }, 'x')).toBeUndefined();
  });
});
