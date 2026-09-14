import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const deny = (reason) => ({ decision: 'deny', reason });
const ask = () => ({ decision: 'ask' });

export function evaluateHolGuardToolCall(payload, runner = spawnSync) {
  if (!payload || payload.event !== 'tool_call' || payload.tool_name !== 'Bash') return ask();

  const command = payload.input?.command;
  if (typeof command !== 'string' || command.trim().length === 0) return deny('HOL_GUARD_EMPTY_COMMAND');

  const result = runner(
    'hol-guard',
    ['command', 'test', command, '--json'],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 },
  );

  if (result.error || result.status !== 0) return deny('HOL_GUARD_INSPECTION_FAILED');

  let verdict;
  try {
    verdict = JSON.parse(result.stdout);
  } catch {
    return deny('HOL_GUARD_INVALID_JSON');
  }

  const explicitlyBenign = verdict?.classification?.explicitly_benign === true;
  const minimumAction = String(verdict?.minimum_action ?? '').toLowerCase();
  if (explicitlyBenign && minimumAction === 'allow') return ask();

  return deny('HOL_GUARD_NOT_EXPLICITLY_BENIGN');
}

async function readStdin() {
  return await new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    process.stdout.write(JSON.stringify(deny('HOL_GUARD_INVALID_HOOK_INPUT')));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify(evaluateHolGuardToolCall(payload)));
}
