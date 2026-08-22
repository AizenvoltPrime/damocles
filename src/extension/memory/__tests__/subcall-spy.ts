import { vi, type Mock } from 'vitest';
import type { MemorySubCallRequest, MemorySubCallResult } from '../subcall-runner';

export type SubCallImpl = <T>(req: MemorySubCallRequest) => Promise<MemorySubCallResult<T>>;

/** A vitest spy that also satisfies `MemorySubCallRunner['run']`. */
export type SubCallSpy = Mock<(req: MemorySubCallRequest) => Promise<MemorySubCallResult<unknown>>> & SubCallImpl;

// `Mock<T>` erases the call signature's own type parameter, so a vitest spy cannot BE a generic
// `run<T>`. The intersection keeps both the spy surface and the generic one the runner requires.
export const subCallSpy = (impl: SubCallImpl): SubCallSpy => vi.fn(impl) as SubCallSpy;
