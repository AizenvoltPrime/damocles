import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateHolGuardToolCall } from './hol-guard-pretool.mjs';

const payload = { event: 'tool_call', tool_name: 'Bash', input: { command: 'git status' } };
const result = (stdout, status = 0, error = undefined) => ({ stdout, status, error });
const verdict = (minimum_action, explicitly_benign) => JSON.stringify({
  minimum_action,
  classification: { explicitly_benign },
});

test('explicit_allow', () => {
  assert.deepEqual(
    evaluateHolGuardToolCall(payload, () => result(verdict('allow', true))),
    { decision: 'ask' },
  );
});

test('implicit_allow', () => {
  assert.deepEqual(
    evaluateHolGuardToolCall(payload, () => result(verdict('allow', false))),
    { decision: 'deny', reason: 'HOL_GUARD_NOT_EXPLICITLY_BENIGN' },
  );
});

test('review', () => {
  assert.deepEqual(
    evaluateHolGuardToolCall(payload, () => result(verdict('review', false))),
    { decision: 'deny', reason: 'HOL_GUARD_NOT_EXPLICITLY_BENIGN' },
  );
});

test('invalid_json', () => {
  assert.deepEqual(
    evaluateHolGuardToolCall(payload, () => result('{')),
    { decision: 'deny', reason: 'HOL_GUARD_INVALID_JSON' },
  );
});

test('process_failure', () => {
  assert.deepEqual(
    evaluateHolGuardToolCall(payload, () => result('', 1)),
    { decision: 'deny', reason: 'HOL_GUARD_INSPECTION_FAILED' },
  );
});

test('spawn_failure', () => {
  assert.deepEqual(
    evaluateHolGuardToolCall(payload, () => result('', null, new Error('ENOENT'))),
    { decision: 'deny', reason: 'HOL_GUARD_INSPECTION_FAILED' },
  );
});

test('empty_command', () => {
  assert.deepEqual(
    evaluateHolGuardToolCall({ event: 'tool_call', tool_name: 'Bash', input: {} }),
    { decision: 'deny', reason: 'HOL_GUARD_EMPTY_COMMAND' },
  );
});

test('non_bash', () => {
  assert.deepEqual(
    evaluateHolGuardToolCall({ event: 'tool_call', tool_name: 'Read', input: {} }),
    { decision: 'ask' },
  );
});
