import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeAsar } from '../../scripts/asar-archive.ts';
import { appHolders } from './support/app';
import { ARCHIVE } from './support/asar';
import { expect, test } from './support/fixtures';
import { seedStubModel, writeUserSettings } from './support/hermetic';
import { agentRequests, call, lastToolResultRequest, startOpenAIStub, type OpenAIStub } from './support/openai-stub';
import { openProjectChat } from './support/screenshots';
import { sendAndAwaitEcho } from './support/ui';

test('the agent\'s ls lists an .asar archive as a file and holds no handle to it', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const archives = path.join(home.project, 'archives');
    fs.mkdirSync(path.join(archives, 'sub'), { recursive: true });
    const archive = path.join(archives, 'app.asar');
    writeAsar(archive, ARCHIVE);
    fs.writeFileSync(path.join(archives, 'notes.txt'), 'notes\n');
    const desktop = await launch();
    const alpha = await openProjectChat(desktop.app, home.project);

    stub.replies.push({ chunks: [], toolCalls: [{ name: 'ls', arguments: { path: archives } }] });
    await sendAndAwaitEcho(alpha, 'list the archives');
    const messages = (JSON.parse(lastToolResultRequest(stub)) as { messages: Array<{ role: string; content: unknown }> }).messages;
    expect(messages.filter((message) => message.role === 'tool').at(-1)?.content).toBe('app.asar\nnotes.txt\nsub/');
    expect(await appHolders(desktop.app, [archive])).toEqual([]);
    fs.rmSync(archive);
  } finally {
    await stub.close();
  }
});

/** The text of every tool result the agent's last request carried, in order. */
function toolResults(stub: OpenAIStub): string[] {
  const messages = (agentRequests(stub).at(-1)?.body as { messages?: Array<{ role: string; content?: string | Array<{ text?: string }> }> } | undefined)?.messages ?? [];
  return messages.filter((message) => message.role === 'tool').map((message) => (typeof message.content === 'string' ? message.content : (message.content ?? []).map((part) => part.text ?? '').join('')));
}

test('the agent\'s read, Edit and write treat an .asar archive as a file and hold no handle to it', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    writeUserSettings(home, { 'damocles.dangerouslySkipPermissions': true });
    const archive = path.join(home.project, 'app.asar');
    writeAsar(archive, ARCHIVE);
    const desktop = await launch();
    const alpha = await openProjectChat(desktop.app, home.project);

    stub.replies.push(
      call('read', { path: archive }),
      call('Edit', { file_path: archive, old_string: 'e2e-archive', new_string: 'e2e-edited' }),
      call('Edit', { file_path: archive, old_string: 'module.exports', new_string: 'exports.value', replace_all: true }),
      call('write', { path: archive, content: 'replaced\n' }),
    );
    await sendAndAwaitEcho(alpha, 'change the archive');
    const [read, edit, editAll, write] = toolResults(stub);
    expect(read).toContain('{"name":"e2e-archive"}');
    expect(edit).toBe(`Successfully replaced 1 block(s) in ${archive}.`);
    expect(editAll).toBe(`Successfully replaced 1 block(s) in ${archive}.`);
    expect(write).toBe(`Successfully wrote to ${archive}`);
    expect(fs.readFileSync(archive, 'utf8')).toBe('replaced\n');
    expect(await appHolders(desktop.app, [archive])).toEqual([]);
    fs.rmSync(archive);
  } finally {
    await stub.close();
  }
});
