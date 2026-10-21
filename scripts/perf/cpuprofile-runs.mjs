// Usage: node scripts/perf/cpuprofile-runs.mjs <file.cpuprofile> [function]
//
// Lists the contiguous runs of samples spent under <function> (default spawn), longest first, each with its start
// offset in the profile, its duration, its sample count and the stack that called it. It tells one slow call apart
// from many fast ones. A run is consecutive samples whose outermost <function> frame is the same profile node, so two
// back-to-back calls from one call site inside one sampling interval count as one run.
import * as fs from 'node:fs';

const [file, fn = 'spawn'] = process.argv.slice(2);
if (!file) {
  console.error('Usage: node scripts/perf/cpuprofile-runs.mjs <file.cpuprofile> [function]');
  process.exit(1);
}

const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const parents = new Map();
for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);

function label(node) {
  const { functionName, url, lineNumber } = node.callFrame;
  const where = url ? url.replace(/^file:\/\/\/?/, '').split(/[\\/]/).slice(-2).join('/') : '';
  return where ? `${functionName || '(anonymous)'} ${where}:${lineNumber + 1}` : functionName || '(anonymous)';
}

// the outermost frame named fn on a sample's stack, or undefined
function outermostMatch(leafId) {
  let found;
  for (let id = leafId; id !== undefined; id = parents.get(id)) if (nodes.get(id)?.callFrame.functionName === fn) found = id;
  return found;
}

function callers(id) {
  const frames = [];
  for (let at = parents.get(id); at !== undefined; at = parents.get(at)) {
    const node = nodes.get(at);
    if (!node || node.callFrame.functionName === '(root)') break;
    frames.push(label(node));
  }
  return frames;
}

const samples = profile.samples ?? [];
const deltas = profile.timeDeltas ?? [];
const times = [];
let at = profile.startTime;
for (let i = 0; i < samples.length; i++) times.push((at += deltas[i] ?? 0));
const sortedDeltas = deltas.slice(1).filter((d) => d > 0).sort((a, b) => a - b);
// a gap the profiler took no samples in (a sleep, a pause) counts for at most a few sampling intervals
const maxSampleUs = 4 * (sortedDeltas[Math.floor(sortedDeltas.length / 2)] ?? 1000);

const runs = [];
let current;
for (let i = 0; i < samples.length; i++) {
  const match = outermostMatch(samples[i]);
  const next = i + 1 < samples.length ? times[i + 1] : profile.endTime;
  const us = Math.min(next - times[i], maxSampleUs);
  if (match === undefined) {
    current = undefined;
    continue;
  }
  if (current?.node !== match) runs.push((current = { node: match, startUs: times[i], us: 0, samples: 0 }));
  current.us += us;
  current.samples++;
}

const ms = (us) => (us / 1000).toFixed(1);
runs.sort((a, b) => b.us - a.us);
const total = runs.reduce((sum, run) => sum + run.us, 0);
console.log(`${runs.length} runs under ${fn}, ${ms(total)} ms in all, longest ${ms(runs[0]?.us ?? 0)} ms (${file})`);
for (const run of runs) {
  console.log(`\n${ms(run.us).padStart(9)} ms  ${String(run.samples).padStart(5)} samples  at +${ms(run.startUs - profile.startTime)} ms`);
  for (const frame of callers(run.node)) console.log(`    < ${frame}`);
}
