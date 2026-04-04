import * as fs from 'fs';
import * as path from 'path';
import { getSessionDir } from '../session/paths';
import type { TeamPersistenceWriter } from './types';
import type { TeamState as WebviewTeamState, TeamAgent as WebviewTeamAgent, TeamMessage as WebviewTeamMessage, ScratchpadEntry as WebviewScratchpadEntry, TeamAgentContentBlock } from '../../shared/types/team';

export class TeamPersistence implements TeamPersistenceWriter {
  private readonly cwd: string;
  private readonly persistenceSessionId: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private sessionDir: string | null = null;
  private writeErrors: Error[] = [];

  constructor(cwd: string, persistenceSessionId: string) {
    this.cwd = cwd;
    this.persistenceSessionId = persistenceSessionId;
  }

  private async ensureDir(): Promise<string> {
    if (this.sessionDir) return this.sessionDir;
    this.sessionDir = await getSessionDir(this.cwd);
    return this.sessionDir;
  }

  private getTeamDir(sessionDir: string): string {
    return path.join(sessionDir, this.persistenceSessionId, 'teams');
  }

  private getTeamFilePath(sessionDir: string, teamId: string): string {
    return path.join(this.getTeamDir(sessionDir), `${teamId}.jsonl`);
  }

  private getAgentFilePath(sessionDir: string, _teamId: string, agentId: string): string {
    return path.join(this.getTeamDir(sessionDir), 'agents', `${agentId}.jsonl`);
  }

  async initTeamFile(teamId: string): Promise<void> {
    const sessionDir = await this.ensureDir();
    const teamDir = this.getTeamDir(sessionDir);
    const agentsDir = path.join(teamDir, 'agents');
    await fs.promises.mkdir(agentsDir, { recursive: true });

    const filePath = this.getTeamFilePath(sessionDir, teamId);
    const entry = {
      type: 'queue-operation',
      operation: 'dequeue',
      timestamp: new Date().toISOString(),
      teamId,
    };
    await fs.promises.writeFile(filePath, JSON.stringify(entry) + '\n');
  }

  async initAgentFile(teamId: string, agentId: string): Promise<void> {
    const sessionDir = await this.ensureDir();
    const filePath = this.getAgentFilePath(sessionDir, teamId, agentId);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const entry = {
      type: 'queue-operation',
      operation: 'dequeue',
      timestamp: new Date().toISOString(),
      agentId,
    };
    await fs.promises.writeFile(filePath, JSON.stringify(entry) + '\n');
  }

  appendTeamEntry(entry: Record<string, unknown>): void {
    const teamId = entry['teamId'] as string;
    if (!teamId) return;

    this.writeQueue = this.writeQueue.then(async () => {
      try {
        const sessionDir = await this.ensureDir();
        const filePath = this.getTeamFilePath(sessionDir, teamId);
        await fs.promises.appendFile(filePath, JSON.stringify(entry) + '\n');
      } catch (err) {
        this.writeErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  appendAgentEntry(teamId: string, agentId: string, entry: Record<string, unknown>): void {
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        const sessionDir = await this.ensureDir();
        const filePath = this.getAgentFilePath(sessionDir, teamId, agentId);
        await fs.promises.appendFile(filePath, JSON.stringify(entry) + '\n');
      } catch (err) {
        this.writeErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async writeTeamCorrelation(sessionId: string, toolUseId: string, teamId: string): Promise<void> {
    const sessionDir = await this.ensureDir();
    const filePath = path.join(sessionDir, `${sessionId}.jsonl`);

    const entry = {
      type: 'team-correlation',
      toolUseId,
      teamId,
      sessionId,
      timestamp: new Date().toISOString(),
    };

    await fs.promises.appendFile(filePath, JSON.stringify(entry) + '\n');
  }

  async flush(): Promise<void> {
    await this.writeQueue;
    if (this.writeErrors.length > 0) {
      const errors = this.writeErrors.splice(0);
      throw new AggregateError(errors, `${errors.length} persistence write(s) failed`);
    }
  }

  async loadTeamState(teamId: string): Promise<WebviewTeamState | null> {
    try {
      const sessionDir = await this.ensureDir();
      const filePath = this.getTeamFilePath(sessionDir, teamId);
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      const agents: WebviewTeamAgent[] = [];
      const messages: WebviewTeamMessage[] = [];
      const scratchpad: WebviewScratchpadEntry[] = [];
      let title = '';
      let toolUseId = '';
      let status: 'running' | 'completed' | 'failed' | 'cancelled' = 'completed';
      let result: string | null = null;
      let startTime = Date.now();
      let endTime: number | null = null;

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          const entryType = entry['type'] as string;

          if (entryType === 'team-created') {
            title = entry['title'] as string;
            toolUseId = (entry['toolUseId'] as string) ?? '';
            startTime = new Date(entry['timestamp'] as string).getTime();
            const specs = entry['agents'] as Array<{ name: string; role: string; model?: string }>;
            for (const spec of specs) {
              agents.push({
                agentId: '',
                name: spec.name,
                role: spec.role as 'lead' | 'specialist',
                specialization: '',
                model: spec.model ?? '',
                profileId: null,
                status: 'pending',
                startTime: null,
                endTime: null,
                toolCount: 0,
                lastToolName: null,
                progressSummary: null,
                result: null,
                logFilePath: null,
              });
            }
          } else if (entryType === 'agent-spawned') {
            const agent = agents.find(a => a.name === entry['name']);
            if (agent) {
              agent.agentId = entry['agentId'] as string;
              agent.specialization = (entry['specialization'] as string) ?? '';
              agent.model = (entry['model'] as string) ?? '';
              agent.profileId = (entry['profileId'] as string) ?? null;
              agent.status = 'running';
              agent.startTime = new Date(entry['timestamp'] as string).getTime();
              const sessionDir = await this.ensureDir();
              agent.logFilePath = this.getAgentFilePath(sessionDir, teamId, agent.agentId);
            }
          } else if (entryType === 'agent-message') {
            const senderAgent = agents.find(a => a.name === entry['from']);
            const recipientAgent = entry['to'] ? agents.find(a => a.name === entry['to']) : null;
            messages.push({
              messageId: entry['messageId'] as string,
              senderAgentId: senderAgent?.agentId ?? '',
              senderName: entry['from'] as string,
              recipientAgentId: recipientAgent?.agentId ?? null,
              recipientName: (entry['to'] as string) ?? null,
              content: entry['content'] as string,
              timestamp: new Date(entry['timestamp'] as string).getTime(),
            });
          } else if (entryType === 'scratchpad-update') {
            const authorAgent = agents.find(a => a.name === entry['author']);
            scratchpad.push({
              section: entry['section'] as string,
              content: entry['content'] as string,
              agentId: authorAgent?.agentId ?? '',
              agentName: entry['author'] as string,
              version: entry['version'] as number,
              timestamp: new Date(entry['timestamp'] as string).getTime(),
            });
          } else if (entryType === 'agent-completed') {
            const agent = agents.find(a => a.agentId === entry['agentId']);
            if (agent) {
              agent.status = entry['status'] as WebviewTeamAgent['status'];
              agent.endTime = new Date(entry['timestamp'] as string).getTime();
              agent.result = (entry['result'] as string) ?? null;
              if (typeof entry['toolCallCount'] === 'number') {
                agent.toolCount = entry['toolCallCount'];
              }
            }
          } else if (entryType === 'team-completed') {
            status = entry['status'] as typeof status;
            result = (entry['synthesizedResult'] as string) ?? null;
            endTime = new Date(entry['timestamp'] as string).getTime();
          }
        } catch {
          // skip malformed lines
        }
      }

      const totalToolCount = agents.reduce((sum, a) => sum + a.toolCount, 0);

      return {
        teamId,
        toolUseId,
        title,
        status,
        phase: 'complete',
        agents,
        messages,
        scratchpad,
        result,
        startTime,
        endTime,
        totalToolCount,
      };
    } catch {
      return null;
    }
  }

  async loadAgentConversation(teamId: string, agentId: string): Promise<TeamAgentContentBlock[][]> {
    try {
      const sessionDir = await this.ensureDir();
      const filePath = this.getAgentFilePath(sessionDir, teamId, agentId);
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      const turns: TeamAgentContentBlock[][] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          const entryType = entry['type'] as string;

          if (entryType === 'user') {
            const entryContent = entry['content'];
            if (typeof entryContent === 'string') {
              turns.push([{ type: 'text', text: entryContent }]);
            } else if (Array.isArray(entryContent)) {
              turns.push(entryContent as TeamAgentContentBlock[]);
            }
          } else if (entryType === 'assistant') {
            const entryContent = entry['content'];
            if (Array.isArray(entryContent)) {
              turns.push(entryContent as TeamAgentContentBlock[]);
            }
          }
        } catch {
          // skip malformed
        }
      }

      return turns;
    } catch {
      return [];
    }
  }
}
