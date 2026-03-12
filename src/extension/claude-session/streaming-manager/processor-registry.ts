import type { ProcessorDependencies, ProcessorRegistry, MessageProcessor } from './types';
import { createAssistantProcessor } from './processors/assistant-processor';
import { createStreamEventProcessor } from './processors/stream-event-processor';
import { createSystemProcessors } from './processors/system-processor';
import { createUserProcessor } from './processors/user-processor';
import { createResultProcessor } from './processors/result-processor';
import { createStatusProcessor } from './processors/status-processor';
import { createTaskLifecycleProcessors } from './processors/task-lifecycle-processor';
import { createToolEventsProcessors } from './processors/tool-events-processor';
import { createSessionEventsProcessors } from './processors/session-events-processor';
import { createTaskProgressProcessor } from './processors/task-progress-processor';

function registerAll(target: ProcessorRegistry, entries: Record<string, MessageProcessor>): void {
  for (const [key, processor] of Object.entries(entries)) {
    target.set(key, processor);
  }
}

/**
 * Creates a map-based registry of all message processors.
 *
 * Each processor factory returns a Record<string, MessageProcessor> mapping
 * dispatch keys to handler functions. Top-level SDK message types use their
 * type directly (e.g., 'assistant'). System subtypes use composite keys
 * (e.g., 'system:init', 'system:status').
 *
 * Adding a new message type requires only:
 * 1. Creating a processor factory that returns { 'key': handler }
 * 2. Calling registerAll() here
 */
export function createProcessorRegistry(deps: ProcessorDependencies): ProcessorRegistry {
  const processors: ProcessorRegistry = new Map();

  registerAll(processors, createAssistantProcessor(deps));
  registerAll(processors, createStreamEventProcessor(deps));
  registerAll(processors, createSystemProcessors(deps));
  registerAll(processors, createUserProcessor(deps));
  registerAll(processors, createResultProcessor(deps));
  registerAll(processors, createStatusProcessor(deps));
  registerAll(processors, createTaskLifecycleProcessors(deps));
  registerAll(processors, createToolEventsProcessors(deps));
  registerAll(processors, createSessionEventsProcessors(deps));
  registerAll(processors, createTaskProgressProcessor(deps));

  return processors;
}
