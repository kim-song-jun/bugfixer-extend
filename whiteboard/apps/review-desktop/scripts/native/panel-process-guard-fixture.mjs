import { spawn } from 'node:child_process';
import {
  captureOwnedProcessTree,
  processAlive,
  processGroupAlive,
  processInventory,
  stopOwnedProcessTree,
  verifyLiveIdentity,
} from './app-process-cleanup.mjs';
import { runPanelProcessGuard } from './panel-process-broker.mjs';

const guardPath = process.argv[2];
const failures = [];
const cleanupResults = [];
let sleepRecord;
let sleepOwnership;
let guardReceipt = null;
let guardCleanup;

function startChild(command, args, stdio) {
  const child = spawn(command, args, { detached: true, stdio });
  const record = {
    child,
    pid: child.pid,
    exitObserved: false,
    closeResult: null,
    spawnFailed: false,
    stdout: '',
    stdoutBytes: 0,
    stdoutTooLarge: false,
    stdinFailed: false,
  };

  child.once('error', () => {
    record.spawnFailed = true;
  });
  child.once('exit', (code, signal) => {
    record.exitObserved = true;
    record.exitCode = code;
    record.signal = signal;
  });
  child.once('close', (code, signal) => {
    record.closeResult = { code, signal };
  });

  if (child.stdout) {
    child.stdout.on('data', chunk => {
      record.stdoutBytes += Buffer.byteLength(chunk);

      if (record.stdoutBytes > 4096) {
        record.stdoutTooLarge = true;

        return;
      }

      record.stdout += chunk.toString('utf8');
    });
  }

  if (child.stdin) {
    child.stdin.on('error', () => {
      record.stdinFailed = true;
    });
  }

  return record;
}

function waitFor(predicate, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        if (predicate()) {
          resolve();

          return;
        }
      } catch {
        reject(new Error(label));

        return;
      }

      if (Date.now() >= deadline) {
        reject(new Error(label));

        return;
      }

      setTimeout(poll, 20);
    };

    poll();
  });
}

async function captureIdentity(record, executablePath) {
  if (!Number.isSafeInteger(record.pid) || record.pid < 1) {
    throw new Error('child-pid-invalid');
  }

  await waitFor(() => {
    if (record.exitObserved || record.spawnFailed) return true;

    return processInventory().has(record.pid);
  }, 'child-process-identity-timeout', 3_000);

  if (record.exitObserved || record.spawnFailed) {
    throw new Error('child-exited-before-identity-capture');
  }

  const state = { captured: false, identities: new Map() };
  captureOwnedProcessTree({
    rootPid: record.pid,
    executablePath,
    appExited: record.exitObserved,
    state,
  });

  if (!state.captured || !state.rootIdentity) {
    throw new Error('child-process-identity-unavailable');
  }

  return state;
}

async function cleanupChild(record, ownership, label) {
  if (!record) {
    cleanupResults.push({ label, pid: null, verified: true, reason: 'not-spawned' });

    return;
  }

  if (!ownership) {
    if (record.child.stdin && !record.exitObserved) {
      record.child.stdin.end();
    }

    const naturalExitBudgetMs = label === 'sleep' ? 47_000 : 2_000;

    try {
      await waitFor(() => record.closeResult !== null,
        `${label}-unowned-child-close-timeout`, naturalExitBudgetMs);
    } catch {
      cleanupResults.push({
        label,
        pid: record.pid,
        verified: false,
        reason: 'identity-unavailable',
      });

      return;
    }

    let pidAbsent = false;
    let groupAbsent = false;

    try {
      pidAbsent = !processAlive(record.pid);
      groupAbsent = !processGroupAlive(record.pid);
    } catch {
      cleanupResults.push({
        label,
        pid: record.pid,
        verified: false,
        reason: 'identity-unavailable',
      });

      return;
    }

    cleanupResults.push({
      label,
      pid: record.pid,
      verified: false,
      reason: pidAbsent && groupAbsent
        ? 'identity-unavailable'
        : 'process-still-present',
      exitObserved: record.exitObserved,
      closed: record.closeResult !== null,
      pidAbsent,
      groupAbsent,
    });

    return;
  }

  try {
    await stopOwnedProcessTree({
      rootPid: record.pid,
      rootIdentity: ownership.rootIdentity,
      identities: [...ownership.identities.values()],
      captured: ownership.captured,
      isAppExited: () => record.closeResult !== null,
      cleanup: [],
      waitFor,
      timeouts: {
        rootGraceMs: 1_000,
        termGraceMs: 2_000,
        killGraceMs: 1_000,
        leaderCloseMs: 2_000,
      },
    });
  } catch {
    cleanupResults.push({
      label,
      pid: record.pid,
      verified: false,
      reason: 'owned-stop-failed',
    });

    return;
  }

  if (!record.closeResult) {
    try {
      await waitFor(() => record.closeResult !== null, `${label}-close-timeout`, 2_000);
    } catch {
      cleanupResults.push({
        label,
        pid: record.pid,
        verified: false,
        reason: 'close-unverified',
      });

      return;
    }
  }

  let pidAbsent = false;
  let groupAbsent = false;

  try {
    pidAbsent = !processAlive(record.pid);
    groupAbsent = !processGroupAlive(record.pid);
  } catch {
    cleanupResults.push({
      label,
      pid: record.pid,
      verified: false,
      reason: 'absence-unverified',
    });

    return;
  }

  cleanupResults.push({
    label,
    pid: record.pid,
    verified: record.exitObserved && pidAbsent && groupAbsent,
    exitObserved: record.exitObserved,
    closed: record.closeResult !== null,
    pidAbsent,
    groupAbsent,
  });
}

async function run() {
  if (!guardPath || !guardPath.startsWith('/')) {
    throw new Error('guard-path-invalid');
  }

  sleepRecord = startChild('/bin/sleep', ['45'], 'ignore');
  sleepOwnership = await captureIdentity(sleepRecord, '/bin/sleep');
  const guardResult = await runPanelProcessGuard({
    guardPath,
    targetPid: sleepRecord.pid,
    targetIdentity: sleepOwnership.rootIdentity,
  });
  guardReceipt = guardResult.receipt;
  guardCleanup = guardResult.guardCleanup;

  const targetIdentityStillLive = verifyLiveIdentity(
    sleepOwnership.rootIdentity,
    { rootPid: sleepRecord.pid },
  );
  const sleepGroupStillLive = processGroupAlive(sleepRecord.pid);

  if (!targetIdentityStillLive || !sleepGroupStillLive ||
      guardReceipt.version !== 1 || guardReceipt.ownPID !== guardCleanup?.pid ||
      guardReceipt.targetPID !== sleepRecord.pid ||
      !Number.isSafeInteger(guardReceipt.birthSeconds) ||
      guardReceipt.birthSeconds < 1 ||
      !Number.isSafeInteger(guardReceipt.birthMicroseconds) ||
      guardReceipt.birthMicroseconds < 0 ||
      guardReceipt.birthMicroseconds > 999999 ||
      guardReceipt.birthStable !== true ||
      guardReceipt.pathMatchesSystemService !== false ||
      guardReceipt.appleStatus !== 0 ||
      guardReceipt.panelRequirementStatus !== -67050 ||
      guardReceipt.verified !== false ||
      guardReceipt.errorCode !== 'target-path-mismatch' ||
      guardResult.requestVerified !== false ||
      guardResult.errorCode !== 'target-path-mismatch' ||
      guardCleanup?.verified !== true) {
    throw new Error('guard-contract-result-invalid');
  }
}

try {
  await run();
} catch (error) {
  if (error?.guardCleanup) guardCleanup = error.guardCleanup;
  failures.push('panel-process-guard-contract-failed');
} finally {
  cleanupResults.push({
    label: 'guard',
    pid: guardCleanup?.pid ?? null,
    verified: guardCleanup?.verified === true,
    exitObserved: guardCleanup?.exitObserved === true,
    closed: guardCleanup?.closed === true,
    pidAbsent: guardCleanup?.pidAbsent === true,
    groupAbsent: guardCleanup?.groupAbsent === true,
  });
  await cleanupChild(sleepRecord, sleepOwnership, 'sleep');
}

if (cleanupResults.some(result => result.verified !== true)) {
  failures.push('owned-process-cleanup-unverified');
}

const passed = failures.length === 0;
process.stdout.write(`${JSON.stringify({
  event: 'panel-process-guard-fixture',
  passed,
  failures,
  guardReceipt,
  cleanupResults,
})}\n`);

if (!passed) process.exitCode = 1;
