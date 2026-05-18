import { log } from '../logger';

export function convertAnthropicToGemini(body: Record<string, unknown>): Record<string, unknown> {
  const gemini: Record<string, unknown> = {};

  const system = body['system'];
  if (system) {
    const text = typeof system === 'string'
      ? system
      : Array.isArray(system)
        ? (system as Array<{ type?: string; text?: string }>)
            .filter(b => b.type === 'text' && b.text)
            .map(b => b.text)
            .join('\n')
        : '';
    if (text) gemini['systemInstruction'] = { parts: [{ text }] };
  }

  const messages = body['messages'] as Array<{ role: string; content: unknown }> | undefined;
  if (messages) {
    const toolNameMap = new Map<string, string>();
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (block['type'] === 'tool_use' && block['id'] && block['name']) {
          toolNameMap.set(block['id'] as string, block['name'] as string);
        }
      }
    }

    const contents: Array<{ role: string; parts: unknown[] }> = [];
    for (const msg of messages) {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      const parts: unknown[] = [];

      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content as Array<Record<string, unknown>>) {
          const blockType = block['type'] as string;
          if (blockType === 'text' && block['text']) {
            parts.push({ text: block['text'] });
          } else if (blockType === 'tool_use' && block['name']) {
            parts.push({
              functionCall: {
                name: block['name'],
                args: (block['input'] as Record<string, unknown>) || {},
              },
            });
          } else if (blockType === 'tool_result' && block['tool_use_id']) {
            const name = toolNameMap.get(block['tool_use_id'] as string) || 'unknown';
            let resultText: string;
            const content = block['content'];
            if (typeof content === 'string') {
              resultText = content;
            } else if (Array.isArray(content)) {
              resultText = (content as Array<{ type?: string; text?: string }>)
                .filter(b => b.type === 'text' && b.text)
                .map(b => b.text)
                .join('\n');
            } else {
              resultText = '';
            }
            parts.push({
              functionResponse: { name, response: { result: resultText } },
            });
          }
        }
      }

      if (parts.length === 0) continue;

      const last = contents[contents.length - 1];
      if (last && last.role === role) {
        last.parts.push(...parts);
      } else {
        contents.push({ role, parts });
      }
    }
    gemini['contents'] = contents;
  }

  const tools = body['tools'] as Array<Record<string, unknown>> | undefined;
  if (tools?.length) {
    const functionDeclarations = tools.map(tool => ({
      name: tool['name'],
      description: tool['description'],
      parametersJsonSchema: tool['input_schema'],
    }));
    gemini['tools'] = [{ functionDeclarations }];
  }

  const genConfig: Record<string, unknown> = {};
  if (body['max_tokens']) genConfig['maxOutputTokens'] = body['max_tokens'];
  if (body['temperature'] !== undefined) genConfig['temperature'] = body['temperature'];
  if (body['top_p'] !== undefined) genConfig['topP'] = body['top_p'];
  if (body['top_k'] !== undefined) genConfig['topK'] = body['top_k'];
  if (Object.keys(genConfig).length) gemini['generationConfig'] = genConfig;

  const toolChoice = body['tool_choice'];
  if (toolChoice) {
    const fc: Record<string, unknown> = {};
    if (toolChoice === 'auto') fc['mode'] = 'AUTO';
    else if (toolChoice === 'any') fc['mode'] = 'ANY';
    else if (toolChoice === 'none') fc['mode'] = 'NONE';
    else if (typeof toolChoice === 'object' && (toolChoice as Record<string, unknown>)['name']) {
      fc['mode'] = 'ANY';
      fc['allowedFunctionNames'] = [(toolChoice as Record<string, unknown>)['name']];
    }
    gemini['toolConfig'] = { functionCallingConfig: fc };
  }

  return gemini;
}

export function buildGeminiUrl(baseUrl: string, model: string, stream: boolean): string {
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  return new URL(`./${model}:${action}`, base).toString();
}

export class GeminiToAnthropicStream {
  private sdkModel: string;
  private blockIndex = -1;
  private openBlock: 'text' | null = null;
  private hasToolUse = false;
  private started = false;
  private finished = false;
  private responseId = '';
  private inputTokens = 0;
  private outputTokens = 0;
  private toolCounter = 0;

  constructor(sdkModel: string) {
    this.sdkModel = sdkModel;
  }

  processLine(data: string): string[] {
    if (this.finished) return [];

    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data);
    } catch {
      log('[GeminiTransform] Failed to parse chunk: %s', data.slice(0, 200));
      return [];
    }

    if (chunk['error']) {
      const err = chunk['error'] as Record<string, unknown>;
      return [this.sse('error', {
        type: 'error',
        error: { type: 'api_error', message: String(err['message'] || 'Gemini API error') },
      })];
    }

    const candidates = chunk['candidates'] as Array<Record<string, unknown>> | undefined;
    if (!candidates?.[0]) return [];

    const candidate = candidates[0];
    const content = candidate['content'] as { parts?: Array<Record<string, unknown>> } | undefined;
    const parts = content?.parts || [];
    const finishReason = candidate['finishReason'] as string | undefined;

    const usage = chunk['usageMetadata'] as Record<string, number> | undefined;
    if (usage) {
      this.inputTokens = usage['promptTokenCount'] || 0;
      this.outputTokens = usage['candidatesTokenCount'] || 0;
    }
    if (chunk['responseId']) this.responseId = chunk['responseId'] as string;

    const events: string[] = [];

    if (!this.started) {
      this.started = true;
      events.push(this.sse('message_start', {
        type: 'message_start',
        message: {
          id: this.responseId || `msg_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          content: [],
          model: this.sdkModel,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: this.inputTokens, output_tokens: 0 },
        },
      }));
    }

    for (const part of parts) {
      if (part['thought'] === true) continue;

      if (part['text'] && typeof part['text'] === 'string') {
        if (this.openBlock !== 'text') {
          if (this.openBlock) events.push(...this.closeBlock());
          this.blockIndex++;
          this.openBlock = 'text';
          events.push(this.sse('content_block_start', {
            type: 'content_block_start',
            index: this.blockIndex,
            content_block: { type: 'text', text: '' },
          }));
        }
        events.push(this.sse('content_block_delta', {
          type: 'content_block_delta',
          index: this.blockIndex,
          delta: { type: 'text_delta', text: part['text'] },
        }));
      }

      if (part['functionCall']) {
        const fc = part['functionCall'] as { name: string; args?: Record<string, unknown>; id?: string };
        if (this.openBlock) events.push(...this.closeBlock());
        this.blockIndex++;
        this.hasToolUse = true;
        this.toolCounter++;
        const toolId = fc.id || `toolu_gemini_${this.toolCounter}_${Date.now().toString(36)}`;

        events.push(this.sse('content_block_start', {
          type: 'content_block_start',
          index: this.blockIndex,
          content_block: { type: 'tool_use', id: toolId, name: fc.name, input: {} },
        }));
        events.push(this.sse('content_block_delta', {
          type: 'content_block_delta',
          index: this.blockIndex,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(fc.args || {}) },
        }));
        events.push(...this.closeBlock());
      }
    }

    if (finishReason) {
      if (this.openBlock) events.push(...this.closeBlock());
      const stopReason = this.hasToolUse ? 'tool_use' : finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn';
      events.push(this.sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: this.outputTokens },
      }));
      events.push(this.sse('message_stop', { type: 'message_stop' }));
      this.finished = true;
    }

    return events;
  }

  flush(): string[] {
    if (this.finished) return [];
    const events: string[] = [];
    if (this.openBlock) events.push(...this.closeBlock());
    if (this.started) {
      const stopReason = this.hasToolUse ? 'tool_use' : 'end_turn';
      events.push(this.sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: this.outputTokens },
      }));
      events.push(this.sse('message_stop', { type: 'message_stop' }));
    }
    this.finished = true;
    return events;
  }

  private closeBlock(): string[] {
    if (!this.openBlock) return [];
    const events = [this.sse('content_block_stop', {
      type: 'content_block_stop',
      index: this.blockIndex,
    })];
    this.openBlock = null;
    return events;
  }

  private sse(event: string, data: Record<string, unknown>): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }
}

export function convertGeminiResponse(response: Record<string, unknown>, sdkModel: string): Record<string, unknown> {
  const candidates = (response['candidates'] as Array<Record<string, unknown>>) || [];
  const candidate = candidates[0] || {};
  const content = candidate['content'] as { parts?: Array<Record<string, unknown>> } | undefined;
  const parts = content?.parts || [];
  const usage = response['usageMetadata'] as Record<string, number> | undefined;

  const blocks: unknown[] = [];
  let toolCounter = 0;
  let hasToolUse = false;

  for (const part of parts) {
    if (part['thought'] === true) continue;
    if (part['text'] && typeof part['text'] === 'string') {
      blocks.push({ type: 'text', text: part['text'] });
    }
    if (part['functionCall']) {
      const fc = part['functionCall'] as { name: string; args?: Record<string, unknown>; id?: string };
      toolCounter++;
      hasToolUse = true;
      blocks.push({
        type: 'tool_use',
        id: fc.id || `toolu_gemini_${toolCounter}_${Date.now().toString(36)}`,
        name: fc.name,
        input: fc.args || {},
      });
    }
  }

  const finishReason = candidate['finishReason'] as string | undefined;
  const stopReason = hasToolUse ? 'tool_use' : finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn';

  return {
    id: (response['responseId'] as string) || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: blocks,
    model: sdkModel,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage?.['promptTokenCount'] || 0,
      output_tokens: usage?.['candidatesTokenCount'] || 0,
    },
  };
}
