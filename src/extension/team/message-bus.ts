import * as crypto from 'crypto';
import type { TeamMessage } from './types';

const MAX_MESSAGES = 10_000;

export class MessageBus {
  private readonly teamId: string;
  private readonly messages: TeamMessage[] = [];
  private readonly subscribers: Array<(msg: TeamMessage) => void> = [];

  constructor(teamId: string) {
    this.teamId = teamId;
  }

  send(from: string, to: string, content: string): TeamMessage {
    const message: TeamMessage = {
      messageId: crypto.randomUUID(),
      teamId: this.teamId,
      timestamp: Date.now(),
      from,
      to,
      content,
    };
    this.appendMessage(message);
    this.notifySubscribers(message);
    return message;
  }

  broadcast(from: string, content: string): TeamMessage {
    const message: TeamMessage = {
      messageId: crypto.randomUUID(),
      teamId: this.teamId,
      timestamp: Date.now(),
      from,
      to: null,
      content,
    };
    this.appendMessage(message);
    this.notifySubscribers(message);
    return message;
  }

  private appendMessage(message: TeamMessage): void {
    this.messages.push(message);
    if (this.messages.length > MAX_MESSAGES) {
      this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    }
  }

  private notifySubscribers(message: TeamMessage): void {
    for (const cb of this.subscribers) {
      try {
        cb(message);
      } catch (err) {
        console.error('[MessageBus] Subscriber error:', err);
      }
    }
  }

  getInbox(agentName: string, since?: number): TeamMessage[] {
    return this.messages.filter(m => {
      if (m.from === agentName) return false;
      if (m.to !== null && m.to !== agentName) return false;
      if (since !== undefined && m.timestamp <= since) return false;
      return true;
    });
  }

  getAllMessages(): TeamMessage[] {
    return [...this.messages];
  }

  subscribe(callback: (msg: TeamMessage) => void): () => void {
    this.subscribers.push(callback);
    return () => {
      const idx = this.subscribers.indexOf(callback);
      if (idx >= 0) this.subscribers.splice(idx, 1);
    };
  }
}
