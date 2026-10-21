import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeAsar } from '../../scripts/asar-archive.mjs';
import { appHolders } from './support/app';
import { ARCHIVE } from './support/asar';
import { expect, test } from './support/fixtures';
import { seedStubModel } from './support/hermetic';
import { lastToolResultRequest, startOpenAIStub } from './support/openai-stub';
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
