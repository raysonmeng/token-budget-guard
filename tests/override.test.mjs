/**
 * Regression tests for the manual hard-line skip (override) feature.
 *
 * The hard line denies by default. When the user EXPLICITLY authorizes a skip
 * (an override phrase — never plain "继续"), pre/stop stop enforcing the hard
 * line for a time-boxed, project-scoped window. The grant auto-expires.
 *
 * Covered surface (Node is the only guard now; the Bash guard was removed):
 *   - Node hook core: lib/guard/hook.mjs  (phasePrompt / phasePre / phasePost / phaseStop)
 *
 * Run: node --test tests/override.test.mjs
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  phasePost, phasePre, phasePrompt, phaseStop,
} from '../lib/guard/hook.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..');
const NOW = 1748850000; // fixed epoch
const TH = { warnOnce: 80, warnRepeat: 90, hard: 92 };

// ─── shared helpers ───────────────────────────────────────────────────────

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'budget-override-test-'));
}

async function withEnvAsync(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Reconstruct the Node skip-marker path (mirrors hook.mjs skipScope/skipMarkerPath:
// sha256(path.resolve(cwd)).slice(0,16)). cwd here is the BUDGET_CWD_OVERRIDE value.
function nodeSkipMarker(stateDir, agent, cwd) {
  const scope = createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 16);
  return join(stateDir, 'skip', `${agent}_${scope}.json`);
}

function makeClaudeHardFixture(dir, util) {
  const resetsAt = new Date((NOW + 3600) * 1000).toISOString();
  const obj = { five_hour: { utilization: util, resets_at: resetsAt } };
  const path = join(dir, `claude-hard-${util}.json`);
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

function makeCodexHardFixture(dir, usedPercent) {
  const obj = {
    rate_limit: {
      primary_window: { used_percent: usedPercent, reset_at: NOW + 3600, limit_window_seconds: 18000, reset_after_seconds: 3600 },
      secondary_window: { used_percent: 40, reset_at: NOW + 604800, limit_window_seconds: 604800, reset_after_seconds: 604800 },
    },
    additional_rate_limits: [],
  };
  const path = join(dir, `codex-hard-${usedPercent}.json`);
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

function writeActiveRateLimit(dir, agent, until = NOW + 300) {
  writeFileSync(join(dir, `ratelimit_${agent}.json`), JSON.stringify({
    rate_limited_until: until,
    recorded_at: NOW,
    source: 'http_429',
  }));
}

function writeStaleClaudeCache(dir, util = 95) {
  writeFileSync(join(dir, 'usage_claude.json'), JSON.stringify({
    fetched_at: NOW - 60,
    cap_util: util,
    raw: {
      five_hour: {
        utilization: util,
        resets_at: new Date((NOW + 3600) * 1000).toISOString(),
      },
    },
  }));
}

function readPendingPair(stateDir, agent) {
  const scopedName = readdirSync(join(stateDir, 'pending')).find((f) => new RegExp(`^${agent}_.*\\.json$`).test(f));
  assert.ok(scopedName, `scoped pending for ${agent} should exist`);
  const scoped = JSON.parse(readFileSync(join(stateDir, 'pending', scopedName), 'utf8'));
  const legacy = JSON.parse(readFileSync(join(stateDir, `pending_${agent}.json`), 'utf8'));
  return { scoped, legacy };
}

const BASH_INPUT = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } });

// ─── Node: phasePrompt grant semantics ────────────────────────────────────

test('Node phasePrompt: /budget-skip grants a scoped, time-boxed marker (claude additionalContext)', async () => {
  const dir = tempDir();
  try {
    const res = await withEnvAsync(
      { BUDGET_STATE_DIR: dir, BUDGET_CWD_OVERRIDE: dir, BUDGET_NOW_EPOCH: String(NOW) },
      () => phasePrompt('claude', { prompt: '/budget-skip 还差一点收尾' }, TH),
    );
    const ctx = res?.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx, /手动跳过授权/, 'grant emits a confirmation to the agent');
    assert.equal(res.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.ok(existsSync(nodeSkipMarker(dir, 'claude', dir)), 'marker file written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Node phasePrompt: plain "继续" does NOT grant (no marker, returns null)', async () => {
  const dir = tempDir();
  try {
    const res = await withEnvAsync(
      { BUDGET_STATE_DIR: dir, BUDGET_CWD_OVERRIDE: dir, BUDGET_NOW_EPOCH: String(NOW) },
      () => phasePrompt('claude', { prompt: '继续完成刚才的任务' }, TH),
    );
    assert.equal(res, null, 'plain 继续 is not an override phrase');
    assert.equal(existsSync(nodeSkipMarker(dir, 'claude', dir)), false, 'no marker written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Node phasePrompt: every documented override phrase grants', async () => {
  for (const phrase of ['/budget-skip', 'force-continue', '跳过硬线', '强制继续', 'FORCE-CONTINUE']) {
    const dir = tempDir();
    try {
      const res = await withEnvAsync(
        { BUDGET_STATE_DIR: dir, BUDGET_CWD_OVERRIDE: dir, BUDGET_NOW_EPOCH: String(NOW) },
        () => phasePrompt('claude', { prompt: `请 ${phrase} 把这步做完` }, TH),
      );
      const ctx = res?.hookSpecificOutput?.additionalContext || '';
      assert.match(ctx, /手动跳过授权/, `phrase should grant: ${phrase}`);
      assert.ok(existsSync(nodeSkipMarker(dir, 'claude', dir)), `marker written for: ${phrase}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('Node phasePrompt: codex override grant uses systemMessage', async () => {
  const dir = tempDir();
  try {
    const res = await withEnvAsync(
      { BUDGET_STATE_DIR: dir, BUDGET_CWD_OVERRIDE: dir, BUDGET_NOW_EPOCH: String(NOW) },
      () => phasePrompt('codex', { prompt: '强制继续' }, TH),
    );
    assert.match(res?.systemMessage || '', /手动跳过授权/);
    assert.ok(existsSync(nodeSkipMarker(dir, 'codex', dir)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Node phasePrompt: long prompt under a transient 429 (stale cache) → estimate on cached util + stale note, NO pending', async () => {
  // Was the bug: a probe 429 made the long-prompt path write a handoff pending +
  // a quota-exhaustion message. Now a transient 429 only gates probe freshness:
  // the estimate runs on the stale CACHED util (95%, not a fabricated 0%) and
  // carries a non-imperative note. No pending is written on a transient 429.
  const dir = tempDir();
  try {
    writeStaleClaudeCache(dir, 95);
    writeActiveRateLimit(dir, 'claude');
    const res = await withEnvAsync(
      {
        BUDGET_STATE_DIR: dir,
        BUDGET_CWD_OVERRIDE: dir,
        BUDGET_NOW_EPOCH: String(NOW),
        BUDGET_CACHE_TTL: '1',
        BUDGET_NO_TOKEN_DISCOVERY: '1',
      },
      () => phasePrompt('claude', { prompt: '/goal 长任务', session_id: 's-prompt-rate' }, TH),
    );

    const ctx = res?.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx, /额度预估/, 'long prompt still gives the budget estimate');
    assert.match(ctx, /95%/, 'estimate uses the stale cached util, not a fabricated 0%');
    assert.match(ctx, /探针暂被限流/, 'carries the non-imperative stale-probe note');
    assert.doesNotMatch(ctx, /写入待续 pending|额度恢复后由|强停/, 'no quota-exhaustion / handoff / stop language');
    assert.equal(existsSync(join(dir, 'pending')), false, 'a transient 429 must NOT write a scoped handoff pending');
    assert.equal(existsSync(join(dir, 'pending_claude.json')), false, 'no legacy pending on a transient 429');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Node phasePrompt: short prompt during active rate-limit stays silent and does not write pending', async () => {
  const dir = tempDir();
  try {
    writeActiveRateLimit(dir, 'claude');
    const res = await withEnvAsync(
      {
        BUDGET_STATE_DIR: dir,
        BUDGET_CWD_OVERRIDE: dir,
        BUDGET_NOW_EPOCH: String(NOW),
        BUDGET_NO_TOKEN_DISCOVERY: '1',
      },
      () => phasePrompt('claude', { prompt: '继续', session_id: 's-short-rate' }, TH),
    );
    assert.equal(res, null, 'non-long prompt should not surface rate-limit context');
    assert.equal(existsSync(join(dir, 'pending')), false, 'non-long prompt should not write pending');
    assert.equal(existsSync(join(dir, 'pending_claude.json')), false, 'non-long prompt should not write legacy pending');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Node: pre / stop honor an active skip; remind/force-stop without one ───

test('Node phasePre: active skip allows at hard line; absent skip reminds without deny', async () => {
  // with skip
  const dir = tempDir();
  try {
    const fx = makeClaudeHardFixture(dir, 95);
    const env = { BUDGET_STATE_DIR: dir, BUDGET_CWD_OVERRIDE: dir, BUDGET_NOW_EPOCH: String(NOW), BUDGET_USAGE_FIXTURE: fx };
    await withEnvAsync(env, () => phasePrompt('claude', { prompt: '/budget-skip' }, TH));
    const allowed = await withEnvAsync(env, () => phasePre('claude', JSON.parse(BASH_INPUT), TH));
    assert.equal(allowed, null, 'active skip → pre returns null (allow)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // without skip (fresh scope)
  const dir2 = tempDir();
  try {
    const fx2 = makeClaudeHardFixture(dir2, 95);
    const env2 = { BUDGET_STATE_DIR: dir2, BUDGET_CWD_OVERRIDE: dir2, BUDGET_NOW_EPOCH: String(NOW), BUDGET_USAGE_FIXTURE: fx2 };
    const reminded = await withEnvAsync(env2, () => phasePre('claude', JSON.parse(BASH_INPUT), TH));
    assert.equal(reminded?.hookSpecificOutput?.permissionDecision, undefined, 'no skip → pre does not deny');
    assert.equal(reminded?.hookSpecificOutput?.permissionDecisionReason, undefined, 'no skip → no deny reason');
    assert.match(reminded?.hookSpecificOutput?.additionalContext || '', /不会强制拦截/, 'no skip → pre reminds');
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
});

test('Node phaseStop: active skip does NOT force-stop; absent skip does', async () => {
  // claude, with skip → null (no continue:false), and no pending written
  const dir = tempDir();
  try {
    const fx = makeClaudeHardFixture(dir, 95);
    const env = { BUDGET_STATE_DIR: dir, BUDGET_CWD_OVERRIDE: dir, BUDGET_NOW_EPOCH: String(NOW), BUDGET_USAGE_FIXTURE: fx };
    await withEnvAsync(env, () => phasePrompt('claude', { prompt: '/budget-skip' }, TH));
    const res = await withEnvAsync(env, () => phaseStop('claude', { session_id: 's1' }, TH));
    assert.equal(res, null, 'claude + active skip → no continue:false at Stop');
    assert.equal(existsSync(join(dir, 'pending')), false, 'no pending queue written under skip');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // claude, without skip → continue:false + pending written
  const dir2 = tempDir();
  try {
    const fx2 = makeClaudeHardFixture(dir2, 95);
    const env2 = { BUDGET_STATE_DIR: dir2, BUDGET_CWD_OVERRIDE: dir2, BUDGET_NOW_EPOCH: String(NOW), BUDGET_USAGE_FIXTURE: fx2 };
    const res2 = await withEnvAsync(env2, () => phaseStop('claude', { session_id: 's1' }, TH));
    assert.ok(res2 && res2.continue === false, 'no skip → force-stop');
    assert.ok(existsSync(join(dir2, 'pending')), 'pending queue written when forcing stop');
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
});

test('Node phaseStop: codex + active skip surfaces a systemMessage, not continue:false', async () => {
  const dir = tempDir();
  try {
    const fx = makeCodexHardFixture(dir, 95);
    const env = { BUDGET_STATE_DIR: dir, BUDGET_CWD_OVERRIDE: dir, BUDGET_NOW_EPOCH: String(NOW), BUDGET_USAGE_FIXTURE: fx };
    await withEnvAsync(env, () => phasePrompt('codex', { prompt: '/budget-skip' }, TH));
    const res = await withEnvAsync(env, () => phaseStop('codex', { session_id: 's1' }, TH));
    assert.equal(res?.continue, undefined, 'codex + skip → no continue:false');
    assert.match(res?.systemMessage || '', /已手动跳过/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Node phasePost: skip-active T3 acknowledges once and does NOT swallow the post-expiry warning', async () => {
  // Regression guard: the skip-active message must use a separate fingerprint
  // namespace so it does not consume the real hard-crossing fingerprint. The
  // fp key is bucket+reset+threshold (not util), so a consumed real fp would
  // never re-arm — permanently suppressing the genuine "Stop 钩子将强停" warning
  // after the skip lapses.
  const dir = tempDir();
  try {
    const fx = makeClaudeHardFixture(dir, 95);
    const base = { BUDGET_STATE_DIR: dir, BUDGET_CWD_OVERRIDE: dir, BUDGET_USAGE_FIXTURE: fx };

    // grant a 60s skip at NOW
    await withEnvAsync(
      { ...base, BUDGET_NOW_EPOCH: String(NOW), BUDGET_SKIP_TTL: '60' },
      () => phasePrompt('claude', { prompt: '/budget-skip' }, TH),
    );

    // first post under skip → acknowledges the skip, never threatens force-stop
    const r1 = await withEnvAsync({ ...base, BUDGET_NOW_EPOCH: String(NOW) }, () => phasePost('claude', {}, TH));
    const c1 = r1?.hookSpecificOutput?.additionalContext || '';
    assert.match(c1, /手动跳过/, 'T3 post acknowledges the skip');
    assert.doesNotMatch(c1, /Stop 钩子将强停/, 'no false force-stop threat while skip is active');

    // second post under skip → silent (skip-ack fingerprint already fired)
    const r2 = await withEnvAsync({ ...base, BUDGET_NOW_EPOCH: String(NOW) }, () => phasePost('claude', {}, TH));
    assert.equal(r2, null, 'skip-ack fires once per window (silence-first)');

    // skip expired → the REAL T3 warning must still fire exactly once
    const r3 = await withEnvAsync({ ...base, BUDGET_NOW_EPOCH: String(NOW + 61) }, () => phasePost('claude', {}, TH));
    const c3 = r3?.hookSpecificOutput?.additionalContext || '';
    assert.match(c3, /Stop 钩子将强停/, 'post-expiry: real T3 warning fires (fp was not consumed by the skip)');

    // and only once
    const r4 = await withEnvAsync({ ...base, BUDGET_NOW_EPOCH: String(NOW + 62) }, () => phasePost('claude', {}, TH));
    assert.equal(r4, null, 'real T3 fingerprint then dedups');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Node phasePost: without a skip, T3 warns the Stop hook will force-stop', async () => {
  const dir = tempDir();
  try {
    const fx = makeClaudeHardFixture(dir, 95);
    const env = { BUDGET_STATE_DIR: dir, BUDGET_CWD_OVERRIDE: dir, BUDGET_NOW_EPOCH: String(NOW), BUDGET_USAGE_FIXTURE: fx };
    const res = await withEnvAsync(env, () => phasePost('claude', {}, TH));
    const ctx = res?.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx, /Stop 钩子将强停/, 'no skip → T3 warns Stop will force-stop');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Node: an expired skip re-enables the hard-line reminder and cleans the marker', async () => {
  const dir = tempDir();
  try {
    const fx = makeClaudeHardFixture(dir, 95);
    const grantEnv = { BUDGET_STATE_DIR: dir, BUDGET_CWD_OVERRIDE: dir, BUDGET_NOW_EPOCH: String(NOW), BUDGET_SKIP_TTL: '60' };
    await withEnvAsync(grantEnv, () => phasePrompt('claude', { prompt: '/budget-skip' }, TH));
    assert.ok(existsSync(nodeSkipMarker(dir, 'claude', dir)), 'marker present right after grant');

    // 61s later: marker expired → pre must remind again and remove the stale marker
    const lateEnv = { BUDGET_STATE_DIR: dir, BUDGET_CWD_OVERRIDE: dir, BUDGET_NOW_EPOCH: String(NOW + 61), BUDGET_USAGE_FIXTURE: fx };
    const reminded = await withEnvAsync(lateEnv, () => phasePre('claude', JSON.parse(BASH_INPUT), TH));
    assert.equal(reminded?.hookSpecificOutput?.permissionDecision, undefined, 'expired skip → no deny');
    assert.match(reminded?.hookSpecificOutput?.additionalContext || '', /不会强制拦截/, 'expired skip → reminder returns');
    assert.equal(existsSync(nodeSkipMarker(dir, 'claude', dir)), false, 'expired marker cleaned up');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── invariant: the shared Bash watchdog stays byte-identical across packages ─

test('watchdog.sh stays byte-identical across packages', async () => {
  const a = await readFile(join(rootDir, 'claude-budget-guard', 'watchdog.sh'));
  const b = await readFile(join(rootDir, 'codex-budget-guard', 'watchdog.sh'));
  assert.ok(a.equals(b), 'watchdog.sh must be byte-identical across packages');
});
