// Phase 0 foundation smoke test (US-001 / blockers B2 + B3), run in real Node — the same
// runtime the VS Code extension host uses. No auth or network required.
//
//   B2 — every pi subpath the extension (and pi's own loader) resolves must be reachable from
//        the installed node_modules, including the `@earendil-works/pi-ai/oauth` subpath.
//   B3 — a Damocles-owned agent dir seeded with `compaction.enabled=false` must yield a session
//        whose auto-compaction is OFF, both from the seed and after the runtime toggle.
//
// Exits non-zero on any failure.

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
if (nodeMajor < 22) {
  console.error(
    `\npi-smoke: requires Node >=22 (pi's undici 8.3.0 dependency). Current Node ${process.versions.node}.\n` +
      `The VS Code extension host provides Node 22+ (e.g. Electron 42); run this smoke under a Node 22+ binary.\n`,
  );
  process.exit(2);
}

let failures = 0;
const ok = (msg) => console.log(`  PASS  ${msg}`);
const bad = (msg) => {
  failures++;
  console.error(`  FAIL  ${msg}`);
};
function assert(cond, msg) {
  if (cond) ok(msg);
  else bad(msg);
}

const SUBPATHS = [
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-ai/oauth',
  '@earendil-works/pi-tui',
  'jiti',
  'typebox',
];

console.log('\n== B2: subpath resolution (import.meta.resolve) ==');
for (const spec of SUBPATHS) {
  try {
    const resolved = import.meta.resolve(spec);
    assert(typeof resolved === 'string' && resolved.length > 0, `resolve ${spec}`);
  } catch (err) {
    bad(`resolve ${spec} — ${err?.message ?? err}`);
  }
}

console.log('\n== B2: dynamic import + expected exports ==');
let pi;
try {
  pi = await import('@earendil-works/pi-coding-agent');
  const expected = [
    'createAgentSessionServices',
    'createAgentSessionFromServices',
    'createAgentSession',
    'SessionManager',
    'SettingsManager',
    'ModelRuntime',
    'defineTool',
    'VERSION',
  ];
  for (const name of expected) {
    assert(pi[name] !== undefined, `pi exports ${name}`);
  }
  // Damocles's memory sub-calls run through ModelRuntime.completeSimple (pi-runtime.ts). Assert the
  // method exists on the prototype — this fails loudly the moment a future pi release renames or
  // removes it, the tripwire to re-map structured completions.
  assert(typeof pi.ModelRuntime?.prototype?.completeSimple === 'function', 'ModelRuntime.prototype.completeSimple (function)');
  console.log(`  info  pi-coding-agent VERSION = ${pi.VERSION}`);
} catch (err) {
  bad(`import @earendil-works/pi-coding-agent — ${err?.stack ?? err}`);
}

try {
  const ai = await import('@earendil-works/pi-ai');
  assert(typeof ai === 'object' && ai !== null, 'import @earendil-works/pi-ai');
  const oauth = await import('@earendil-works/pi-ai/oauth');
  assert(typeof oauth === 'object' && oauth !== null, 'import @earendil-works/pi-ai/oauth');
} catch (err) {
  bad(`import pi-ai / pi-ai/oauth — ${err?.stack ?? err}`);
}

console.log('\n== B3: Damocles-owned agent dir disables auto-compaction ==');
if (pi) {
  const agentDir = join(tmpdir(), `damocles-pi-smoke-${process.pid}`);
  const cwd = join(agentDir, 'workspace');
  try {
    mkdirSync(join(agentDir, 'extensions'), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      join(agentDir, 'settings.json'),
      JSON.stringify({ compaction: { enabled: false }, images: { blockImages: false } }, null, 2),
    );

    const services = await pi.createAgentSessionServices({ cwd, agentDir });
    assert(!!services?.settingsManager, 'createAgentSessionServices produced services');
    assert(
      services.settingsManager.getCompactionEnabled() === false,
      'seeded settings.json → getCompactionEnabled() === false',
    );

    const sessionManager = pi.SessionManager.inMemory();
    const { session } = await pi.createAgentSessionFromServices({ services, sessionManager });
    assert(session.autoCompactionEnabled === false, 'session.autoCompactionEnabled === false (from seed)');
    session.setAutoCompactionEnabled(false);
    assert(session.autoCompactionEnabled === false, 'session.autoCompactionEnabled === false (after toggle)');
    session.dispose();
  } catch (err) {
    bad(`B3 integration — ${err?.stack ?? err}`);
  } finally {
    try {
      rmSync(agentDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
} else {
  bad('B3 skipped — pi failed to import');
}

console.log(`\n${failures === 0 ? 'pi-smoke: ALL PASS' : `pi-smoke: ${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
