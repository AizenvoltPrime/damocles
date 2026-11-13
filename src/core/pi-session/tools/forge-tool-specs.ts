import { Type, type TSchema } from 'typebox';
import type { ToolCatalogEntry } from '@shared/types/tools';
import {
  TOOL_FORGE_COMMENT,
  TOOL_FORGE_ISSUE,
  TOOL_FORGE_ISSUES,
  TOOL_FORGE_JOB_ACTION,
  TOOL_FORGE_JOB_LOG,
  TOOL_FORGE_JOBS,
  TOOL_FORGE_MERGE_REQUEST,
  TOOL_FORGE_MERGE_REQUESTS,
  TOOL_FORGE_OPEN_MERGE_REQUEST,
  TOOL_FORGE_PIPELINES,
} from '../../../shared/tool-names';

/**
 * The GitHub and GitLab tools' names, schemas, descriptions and Tools-panel rows, and nothing else: its runtime imports are
 * typebox and the leaf `tool-names`, so `tools/deferred-tools.ts` can compose the names (import discipline in
 * `tool-search.test.ts`). No input names a host or a URL: the server comes from the chat's own repository.
 */

/** Why a design chat, and every agent it starts, neither loads nor runs the tools: the gate's block and ToolSearch's answer. */
export const DESIGN_CHAT_FORGE_REFUSAL = 'A design chat cannot use the GitHub and GitLab tools.';

/** The ToolSearch group line's guidance, the only place the tools are explained to the model. */
export const FORGE_TOOL_GUIDANCE = 'GitHub and GitLab through your signed-in accounts: CI pipelines and job logs, merge and pull requests, issues for this project. Use these instead of gh, glab or curl with git credentials. Never run gh auth login or glab auth login.';

const remote = Type.Optional(Type.String({ maxLength: 100, description: "A git remote of this project's repository, such as origin or upstream. Default: the current branch's upstream remote, else origin." }));
const project = Type.Optional(Type.String({ maxLength: 512, description: "Another repository on the same server (group/project or owner/repo). Refused unless the user allows reading any repository." }));
const limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: 'How many to list (default 20).' }));
const strict = { additionalProperties: false } as const;

interface ForgeSpec {
  readonly name: string;
  readonly label: string;
  readonly blurb: string;
  readonly description: string;
  readonly parameters: TSchema;
}

const SPECS: readonly ForgeSpec[] = [
  {
    name: TOOL_FORGE_PIPELINES,
    label: 'Pipelines',
    blurb: 'List CI pipelines (GitHub workflow runs).',
    description: "List the newest CI pipelines (GitHub: workflow runs) of this project's repository, for the current branch unless branch is given.",
    parameters: Type.Object({ remote, project, branch: Type.Optional(Type.String({ maxLength: 255, description: 'The branch whose pipelines to list. Default: the current branch.' })), limit }, strict),
  },
  {
    name: TOOL_FORGE_JOBS,
    label: 'Jobs',
    blurb: "List a pipeline's jobs.",
    description: 'List the jobs of one pipeline (GitHub: workflow run) with their status, the latest attempt of each.',
    parameters: Type.Object({ remote, project, pipeline: Type.Integer({ minimum: 1, description: 'The pipeline id (GitHub: the run id), as the pipeline list shows it.' }) }, strict),
  },
  {
    name: TOOL_FORGE_JOB_LOG,
    label: 'Job log',
    blurb: "Read the end of a job's log.",
    description: "Read the last lines of one job's log (at most 200), with colours removed. section keeps only the log sections whose name contains it; the result lists the sections.",
    parameters: Type.Object({
      remote,
      project,
      job: Type.Integer({ minimum: 1, description: "The job id, as a pipeline's job list shows it." }),
      lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: 'How many lines from the end (default 200).' })),
      section: Type.Optional(Type.String({ maxLength: 200, description: 'Only lines in sections whose name contains this text.' })),
    }, strict),
  },
  {
    name: TOOL_FORGE_MERGE_REQUEST,
    label: 'Merge request',
    blurb: 'Read a merge or pull request.',
    description: 'Read one merge request (GitHub: pull request): its state, branches, description and latest comments.',
    parameters: Type.Object({ remote, project, number: Type.Integer({ minimum: 1, description: 'The merge request number (!45) or pull request number (#45).' }) }, strict),
  },
  {
    name: TOOL_FORGE_MERGE_REQUESTS,
    label: 'Merge requests',
    blurb: 'List merge or pull requests.',
    description: "List this project's merge requests (GitHub: pull requests), newest activity first.",
    parameters: Type.Object({ remote, project, state: Type.Optional(Type.Union([Type.Literal('open'), Type.Literal('closed'), Type.Literal('merged'), Type.Literal('all')], { description: 'Default: open.' })), limit }, strict),
  },
  {
    name: TOOL_FORGE_ISSUE,
    label: 'Issue',
    blurb: 'Read an issue.',
    description: 'Read one issue: its state, labels, description and latest comments.',
    parameters: Type.Object({ remote, project, number: Type.Integer({ minimum: 1, description: 'The issue number.' }) }, strict),
  },
  {
    name: TOOL_FORGE_ISSUES,
    label: 'Issues',
    blurb: 'List issues.',
    description: "List this project's issues, newest activity first.",
    parameters: Type.Object({ remote, project, state: Type.Optional(Type.Union([Type.Literal('open'), Type.Literal('closed'), Type.Literal('all')], { description: 'Default: open.' })), limit }, strict),
  },
  {
    name: TOOL_FORGE_JOB_ACTION,
    label: 'Retry or cancel a job',
    blurb: 'Retry or cancel a CI job (asks first).',
    description: 'Retry or cancel one CI job of this project as the user. On GitHub, cancel stops the whole workflow run. The user approves it first.',
    parameters: Type.Object({ remote, job: Type.Integer({ minimum: 1, description: "The job id, as a pipeline's job list shows it." }), action: Type.Union([Type.Literal('retry'), Type.Literal('cancel')]) }, strict),
  },
  {
    name: TOOL_FORGE_OPEN_MERGE_REQUEST,
    label: 'Open a merge request',
    blurb: 'Open a merge or pull request (asks first).',
    description: 'Open a merge request (GitHub: pull request) in this project as the user, from a pushed branch. The user approves the title and description first.',
    parameters: Type.Object({
      remote,
      sourceBranch: Type.Optional(Type.String({ maxLength: 255, description: 'The pushed branch to merge. Default: the current branch.' })),
      targetBranch: Type.Optional(Type.String({ maxLength: 255, description: "Default: the repository's default branch." })),
      title: Type.String({ minLength: 1, maxLength: 255 }),
      body: Type.Optional(Type.String({ maxLength: 60000, description: 'The description, in Markdown.' })),
      draft: Type.Optional(Type.Boolean()),
    }, strict),
  },
  {
    name: TOOL_FORGE_COMMENT,
    label: 'Comment',
    blurb: 'Comment on a merge request or issue (asks first).',
    description: 'Post a comment on a merge request (GitHub: pull request) or an issue of this project as the user. The user approves the text first.',
    parameters: Type.Object({
      remote,
      on: Type.Optional(Type.Union([Type.Literal('mergeRequest'), Type.Literal('issue')], { description: 'Default: mergeRequest.' })),
      number: Type.Integer({ minimum: 1 }),
      body: Type.String({ minLength: 1, maxLength: 60000, description: 'The comment, in Markdown.' }),
    }, strict),
  },
];

export const FORGE_PI_TOOL_NAMES: readonly string[] = SPECS.map((spec) => spec.name);

/** The tools as pi registers them, without an execute, which `forge-tools.ts` adds. */
export const FORGE_TOOL_SPECS: readonly Pick<ForgeSpec, 'name' | 'label' | 'description' | 'parameters'>[] = SPECS;

export const FORGE_TOOL_CATALOG: readonly ToolCatalogEntry[] = SPECS.map((spec) => ({ name: spec.name, label: spec.label, description: spec.blurb, group: 'forge', toggleable: true }));
