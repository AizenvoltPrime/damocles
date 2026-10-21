import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

/** pi's definitions carry their own schema and render types; only the erased shape is assignable both ways. */
export type AnyToolDefinition = ToolDefinition<any, any, any>;
