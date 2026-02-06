import type { ProcessorDependencies, ProcessorRegistry } from './types';
import { createAssistantProcessor } from './processors/assistant-processor';
import { createStreamEventProcessor } from './processors/stream-event-processor';
import { createSystemProcessor } from './processors/system-processor';
import { createUserProcessor } from './processors/user-processor';
import { createResultProcessor } from './processors/result-processor';

/**
 * Creates a registry of all message processors.
 *
 * Each processor is a factory function that receives dependencies and returns
 * a handler function. This pattern enables:
 * - Testability: processors can be tested with mock dependencies
 * - Separation of concerns: each processor handles one message type
 * - Dependency injection: dependencies are captured at creation time
 */
export function createProcessorRegistry(deps: ProcessorDependencies): ProcessorRegistry {
  return {
    assistant: createAssistantProcessor(deps),
    stream_event: createStreamEventProcessor(deps),
    system: createSystemProcessor(),
    user: createUserProcessor(deps),
    result: createResultProcessor(deps),
  };
}
