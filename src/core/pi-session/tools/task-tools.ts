import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../pi-loader';
import { TOOL_TASK_CREATE, TOOL_TASK_UPDATE, TOOL_TASK_LIST, TOOL_TASK_GET } from '../../../shared/tool-names';

/**
 * The Damocles task-list tools, ported to the pi harness. pi has no native task/todo tool, so these
 * mirror the Claude-Code SDK `TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet` contract verbatim — the
 * names, input schemas, and JSON output shapes the webview already renders (`useTaskStore` +
 * `tool-handlers`). State lives in the per-session closure built by `createTaskTools`, so it resets
 * when `PiSession` rebuilds its tools on a new session (US-003).
 */

type TaskStatus = 'pending' | 'in_progress' | 'completed';

interface StoredTask {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  activeForm?: string;
  owner?: string;
  blocks: string[];
  blockedBy: string[];
  metadata?: Record<string, unknown>;
}

interface TaskCreateOutput {
  task: { id: string; subject: string };
}
interface TaskUpdateOutput {
  success: boolean;
  taskId: string;
  updatedFields: string[];
  error?: string;
  statusChange?: { from: string; to: string };
}
interface TaskListOutput {
  tasks: Array<{ id: string; subject: string; status: TaskStatus; owner?: string; blockedBy: string[] }>;
}
interface TaskGetOutput {
  task: { id: string; subject: string; description: string; status: TaskStatus; blocks: string[]; blockedBy: string[] } | null;
}

const metadataSchema = Type.Object({}, { additionalProperties: true });

const taskCreateSchema = Type.Object(
  {
    subject: Type.String({ description: 'A brief title for the task' }),
    description: Type.String({ description: 'What needs to be done' }),
    activeForm: Type.Optional(Type.String({ description: 'Present-continuous form shown in the spinner while in progress (e.g. "Running tests")' })),
    metadata: Type.Optional(metadataSchema),
  },
  { additionalProperties: false },
);

const taskUpdateSchema = Type.Object(
  {
    taskId: Type.String({ description: 'The ID of the task to update' }),
    subject: Type.Optional(Type.String({ description: 'New subject for the task' })),
    description: Type.Optional(Type.String({ description: 'New description for the task' })),
    activeForm: Type.Optional(Type.String({ description: 'Present-continuous form shown in the spinner while in progress' })),
    status: Type.Optional(
      Type.Union(
        [Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed'), Type.Literal('deleted')],
        { description: 'New status for the task' },
      ),
    ),
    addBlocks: Type.Optional(Type.Array(Type.String(), { description: 'Task IDs that this task blocks' })),
    addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: 'Task IDs that block this task' })),
    owner: Type.Optional(Type.String({ description: 'New owner for the task' })),
    metadata: Type.Optional(metadataSchema),
  },
  { additionalProperties: false },
);

const taskListSchema = Type.Object({}, { additionalProperties: false });
const taskGetSchema = Type.Object({ taskId: Type.String({ description: 'The ID of the task to retrieve' }) }, { additionalProperties: false });

function jsonResult(payload: unknown): { content: Array<{ type: 'text'; text: string }>; details: undefined } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], details: undefined };
}

export function createTaskTools(pi: PiCodingAgentModule): [ToolDefinition, ToolDefinition, ToolDefinition, ToolDefinition] {
  const tasks: StoredTask[] = [];
  let nextId = 1;

  const find = (id: string): StoredTask | undefined => tasks.find((t) => t.id === id);

  const addEdges = (task: StoredTask, ids: string[], field: 'blocks' | 'blockedBy'): void => {
    const reciprocal = field === 'blocks' ? 'blockedBy' : 'blocks';
    for (const otherId of ids) {
      if (!task[field].includes(otherId)) task[field].push(otherId);
      const other = find(otherId);
      if (other && !other[reciprocal].includes(task.id)) other[reciprocal].push(task.id);
    }
  };

  const removeTask = (task: StoredTask): void => {
    const idx = tasks.indexOf(task);
    if (idx >= 0) tasks.splice(idx, 1);
    for (const t of tasks) {
      t.blocks = t.blocks.filter((id) => id !== task.id);
      t.blockedBy = t.blockedBy.filter((id) => id !== task.id);
    }
  };

  const taskCreate = pi.defineTool<typeof taskCreateSchema, undefined>({
    name: TOOL_TASK_CREATE,
    label: 'TaskCreate',
    description: 'Create a task in the session task list.',
    parameters: taskCreateSchema,
    execute: async (_toolCallId, params) => {
      const task: StoredTask = {
        id: String(nextId++),
        subject: params.subject,
        description: params.description,
        status: 'pending',
        blocks: [],
        blockedBy: [],
        ...(params.activeForm !== undefined ? { activeForm: params.activeForm } : {}),
        ...(params.metadata !== undefined ? { metadata: params.metadata as Record<string, unknown> } : {}),
      };
      tasks.push(task);
      return jsonResult({ task: { id: task.id, subject: task.subject } } satisfies TaskCreateOutput);
    },
  });

  const taskUpdate = pi.defineTool<typeof taskUpdateSchema, undefined>({
    name: TOOL_TASK_UPDATE,
    label: 'TaskUpdate',
    description: 'Update a task: change its status or fields, add dependencies, or delete it.',
    parameters: taskUpdateSchema,
    execute: async (_toolCallId, params) => {
      const task = find(params.taskId);
      if (!task) {
        return jsonResult({ success: false, taskId: params.taskId, updatedFields: [], error: `No task with id ${params.taskId}` } satisfies TaskUpdateOutput);
      }

      const updatedFields: string[] = [];
      let statusChange: { from: string; to: string } | undefined;

      if (params.status && params.status !== task.status) {
        statusChange = { from: task.status, to: params.status };
        updatedFields.push('status');
        if (params.status === 'deleted') {
          removeTask(task);
          return jsonResult({ success: true, taskId: task.id, updatedFields, statusChange } satisfies TaskUpdateOutput);
        }
        task.status = params.status;
      }

      if (params.subject !== undefined) { task.subject = params.subject; updatedFields.push('subject'); }
      if (params.description !== undefined) { task.description = params.description; updatedFields.push('description'); }
      if (params.activeForm !== undefined) { task.activeForm = params.activeForm; updatedFields.push('activeForm'); }
      if (params.owner !== undefined) { task.owner = params.owner; updatedFields.push('owner'); }
      if (params.metadata) { task.metadata = { ...task.metadata, ...(params.metadata as Record<string, unknown>) }; updatedFields.push('metadata'); }
      if (params.addBlocks?.length) { addEdges(task, params.addBlocks, 'blocks'); updatedFields.push('addBlocks'); }
      if (params.addBlockedBy?.length) { addEdges(task, params.addBlockedBy, 'blockedBy'); updatedFields.push('addBlockedBy'); }

      return jsonResult({ success: true, taskId: task.id, updatedFields, ...(statusChange ? { statusChange } : {}) } satisfies TaskUpdateOutput);
    },
  });

  const taskList = pi.defineTool<typeof taskListSchema, undefined>({
    name: TOOL_TASK_LIST,
    label: 'TaskList',
    description: 'List all tasks in the session task list.',
    parameters: taskListSchema,
    execute: async () =>
      jsonResult({
        tasks: tasks.map((t) => ({ id: t.id, subject: t.subject, status: t.status, ...(t.owner ? { owner: t.owner } : {}), blockedBy: t.blockedBy })),
      } satisfies TaskListOutput),
  });

  const taskGet = pi.defineTool<typeof taskGetSchema, undefined>({
    name: TOOL_TASK_GET,
    label: 'TaskGet',
    description: 'Retrieve a single task by id, including its full description and dependencies.',
    parameters: taskGetSchema,
    execute: async (_toolCallId, params) => {
      const task = find(params.taskId);
      return jsonResult({
        task: task
          ? { id: task.id, subject: task.subject, description: task.description, status: task.status, blocks: task.blocks, blockedBy: task.blockedBy }
          : null,
      } satisfies TaskGetOutput);
    },
  });

  return [taskCreate, taskUpdate, taskList, taskGet];
}
