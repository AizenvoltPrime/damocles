// Rewrites auth.json through pi's own FileAuthStorageBackend.withLock until the parent sends 'stop'.
// argv: <auth.json path> <file URL of pi's dist/core/auth-storage.js>
const [authPath, authStorageUrl] = process.argv.slice(2);
const { FileAuthStorageBackend } = await import(authStorageUrl);
const backend = new FileAuthStorageBackend(authPath);

// Large enough that pi's truncate-then-write leaves an observable empty or partial file.
const filler = 'x'.repeat(512 * 1024);
const documents = ['a', 'b'].map((marker) => JSON.stringify({ marker, anthropic: { type: 'oauth', filler } }, null, 2));

let stopped = false;
process.on('message', (message) => {
  if (message === 'stop') stopped = true;
});

let writes = 0;
const pause = () => new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 4)));
process.send('ready');
// This process is the only writer, so any failure here was caused by the reader and fails the test.
while (!stopped) {
  backend.withLock(() => ({ result: undefined, next: documents[writes % 2] }));
  writes++;
  await pause();
}
process.send({ writes }, () => process.disconnect());
