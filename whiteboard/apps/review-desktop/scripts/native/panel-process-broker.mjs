import { spawn } from 'node:child_process';

import {
  captureOwnedProcessTree,
  processAlive,
  processGroupAlive,
  processInventory,
  sameProcessIdentity,
  stopOwnedProcessTree,
  verifyLiveIdentity,
} from './app-process-cleanup.mjs';

const GUARD_TIMEOUT_MS = 14_000;
const MAX_GUARD_OUTPUT_BYTES = 4096;
const MAX_REQUESTS = 16;
const MAX_FRAME_BYTES = 1024;
const REQUEST_CONTEXTS = new Set([
  'discovery',
  'set-value',
  'press-open',
  'cancel',
]);
const GUARD_ERROR_CODES = new Set([
  'invalid-target-pid',
  'parent-handshake-invalid',
  'target-inspection-failed',
  'guest-attributes-unavailable',
  'guest-code-unavailable',
  'requirement-create-failed',
  'target-birth-changed',
  'target-path-mismatch',
  'apple-signature-rejected',
  'panel-signature-rejected',
]);

function waitFor(predicate, timeoutMs, label) {
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

function startGuard(guardPath, targetPid) {
  const child = spawn(guardPath, [String(targetPid)], {
    detached: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const record = {
    child,
    pid: child.pid,
    exitObserved: false,
    exitCode: null,
    signal: null,
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
  child.stdin.on('error', () => {
    record.stdinFailed = true;
  });
  child.stdout.on('data', chunk => {
    record.stdoutBytes += Buffer.byteLength(chunk);

    if (record.stdoutBytes > MAX_GUARD_OUTPUT_BYTES) {
      record.stdoutTooLarge = true;

      return;
    }

    record.stdout += chunk.toString('utf8');
  });

  return record;
}

async function captureGuardIdentity(record, guardPath) {
  if (!Number.isSafeInteger(record.pid) || record.pid < 1) {
    throw new Error('guard-pid-invalid');
  }

  await waitFor(() => {
    if (record.exitObserved || record.spawnFailed) return true;

    return processInventory().has(record.pid);
  }, 3000, 'guard-identity-timeout');

  if (record.exitObserved || record.spawnFailed) {
    throw new Error('guard-exited-before-identity');
  }

  const state = { captured: false, identities: new Map() };
  captureOwnedProcessTree({
    rootPid: record.pid,
    executablePath: guardPath,
    appExited: record.exitObserved,
    state,
  });

  if (!state.captured || !state.rootIdentity) {
    throw new Error('guard-identity-unavailable');
  }

  return state;
}

async function cleanupGuard(record, ownership) {
  let cleanupErrorCode = null;

  if (!ownership) {
    if (record?.child.stdin && !record.exitObserved) {
      try {
        record.child.stdin.end();
      } catch {
        cleanupErrorCode = 'guard-input-close-failed';
      }
    }

    if (record) {
      try {
        await waitFor(() => record.closeResult !== null, 2000, 'guard-unowned-close-timeout');
      } catch {
        cleanupErrorCode ??= 'guard-close-unverified';
      }
    }

    const absence = observeGuardAbsence(record);

    return {
      verified: false,
      exitObserved: record?.exitObserved === true,
      closed: record?.closeResult != null,
      pidAbsent: absence.pidAbsent,
      groupAbsent: absence.groupAbsent,
      errorCode: cleanupErrorCode ?? absence.errorCode ?? 'guard-identity-unavailable',
    };
  }

  const cleanup = [];

  try {
    await stopOwnedProcessTree({
      rootPid: record.pid,
      rootIdentity: ownership.rootIdentity,
      identities: [...ownership.identities.values()],
      captured: ownership.captured,
      isAppExited: () => record.closeResult !== null,
      cleanup,
      waitFor: (predicate, label, timeoutMs) => waitFor(predicate, timeoutMs, label),
      timeouts: {
        rootGraceMs: 1000,
        termGraceMs: 2000,
        killGraceMs: 1000,
        leaderCloseMs: 2000,
      },
    });
  } catch {
    cleanupErrorCode = 'guard-owned-stop-failed';
  }

  if (!record.closeResult) {
    try {
      await waitFor(() => record.closeResult !== null, 2000, 'guard-close-timeout');
    } catch {
      cleanupErrorCode ??= 'guard-close-unverified';
    }
  }

  const absence = observeGuardAbsence(record);

  return {
    verified: cleanupErrorCode === null && record.exitObserved && record.closeResult !== null &&
      absence.pidAbsent && absence.groupAbsent,
    exitObserved: record.exitObserved,
    closed: record.closeResult !== null,
    pidAbsent: absence.pidAbsent,
    groupAbsent: absence.groupAbsent,
    errorCode: cleanupErrorCode ?? absence.errorCode,
  };
}

function observeGuardAbsence(record) {
  if (!Number.isSafeInteger(record?.pid) || record.pid < 1) {
    return { pidAbsent: false, groupAbsent: false, errorCode: 'guard-pid-unavailable' };
  }

  let pidAbsent = false;
  let groupAbsent = false;
  let errorCode = null;

  try {
    pidAbsent = !processAlive(record.pid);
  } catch {
    errorCode = 'guard-pid-inspection-failed';
  }

  try {
    groupAbsent = !processGroupAlive(record.pid);
  } catch {
    errorCode ??= 'guard-group-inspection-failed';
  }

  if (!errorCode && (!pidAbsent || !groupAbsent)) {
    errorCode = !pidAbsent ? 'guard-process-remains' : 'guard-process-group-remains';
  }

  return { pidAbsent, groupAbsent, errorCode };
}

function parseGuardOutput(record) {
  if (record.stdoutTooLarge || record.stdoutBytes > MAX_GUARD_OUTPUT_BYTES ||
      !record.stdout.endsWith('\n') || record.stdout.split('\n').length !== 3) {
    throw new Error('guard-output-invalid');
  }

  const lines = record.stdout.split('\n');
  const ready = JSON.parse(lines[0]);
  const readyKeys = 'event,ownPID,targetPID,version';

  if (!ready || Array.isArray(ready) ||
      Object.getPrototypeOf(ready) !== Object.prototype ||
      Object.keys(ready).sort().join(',') !== readyKeys ||
      ready.event !== 'panel-process-guard-ready' || ready.version !== 1 ||
      ready.ownPID !== record.pid || ready.targetPID !== record.targetPid) {
    throw new Error('guard-ready-invalid');
  }

  const receipt = JSON.parse(lines[1]);
  const receiptKeys =
    'appleStatus,birthMicroseconds,birthSeconds,birthStable,errorCode,ownPID,panelRequirementStatus,pathMatchesSystemService,targetPID,verified,version';

  if (!receipt || Array.isArray(receipt) ||
      Object.getPrototypeOf(receipt) !== Object.prototype ||
      Object.keys(receipt).sort().join(',') !== receiptKeys) {
    throw new Error('guard-receipt-shape-invalid');
  }

  return receipt;
}

function validReceipt(receipt, guardPid, targetPid) {
  const validStatus = value => value === null ||
    (Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647);
  const validBirthSeconds = value => value === null ||
    (Number.isSafeInteger(value) && value > 0);
  const validBirthMicroseconds = value => value === null ||
    (Number.isInteger(value) && value >= 0 && value <= 999999);

  if (receipt.version !== 1 || receipt.ownPID !== guardPid ||
      receipt.targetPID !== targetPid || ![true, false].includes(receipt.verified) ||
      !validBirthSeconds(receipt.birthSeconds) ||
      !validBirthMicroseconds(receipt.birthMicroseconds) ||
      !validStatus(receipt.appleStatus) ||
      !validStatus(receipt.panelRequirementStatus) ||
      !(receipt.errorCode === null || GUARD_ERROR_CODES.has(receipt.errorCode))) {
    return false;
  }

  const validBirth = validBirthSeconds(receipt.birthSeconds) &&
    receipt.birthSeconds !== null && receipt.birthMicroseconds !== null;

  if (receipt.birthStable && !validBirth) return false;

  return receipt.verified
    ? validBirth && receipt.birthStable === true &&
      receipt.pathMatchesSystemService === true && receipt.appleStatus === 0 &&
      receipt.panelRequirementStatus === 0 && receipt.errorCode === null
    : [true, false].includes(receipt.birthStable) &&
      [true, false].includes(receipt.pathMatchesSystemService) &&
      receipt.errorCode !== null;
}

export async function runPanelProcessGuard({
  guardPath,
  targetPid,
  targetIdentity,
  expectedBirthSeconds = null,
  expectedBirthMicroseconds = null,
  signal,
}) {
  if (!guardPath?.startsWith('/') || !Number.isSafeInteger(targetPid) || targetPid < 1 ||
      !targetIdentity || targetIdentity.pid !== targetPid ||
      !((expectedBirthSeconds === null && expectedBirthMicroseconds === null) ||
        (Number.isSafeInteger(expectedBirthSeconds) && expectedBirthSeconds > 0 &&
         Number.isInteger(expectedBirthMicroseconds) && expectedBirthMicroseconds >= 0 &&
         expectedBirthMicroseconds <= 999999))) {
    throw new Error('guard-input-invalid');
  }

  const before = processInventory().get(targetPid);

  if (!before || !sameProcessIdentity(targetIdentity, before) ||
      !verifyLiveIdentity(targetIdentity, { rootPid: targetPid })) {
    throw new Error('target-identity-unverified');
  }

  const record = startGuard(guardPath, targetPid);
  record.targetPid = targetPid;
  let ownership;
  let receipt;
  let guardCleanup;
  let failureCode = null;
  const deadline = Date.now() + GUARD_TIMEOUT_MS;

  try {
    await waitFor(() => record.stdout.includes('\n') || record.stdoutTooLarge ||
      record.closeResult !== null || signal?.aborted === true,
    Math.max(1, Math.min(3000, deadline - Date.now())), 'guard-ready-timeout');

    if (signal?.aborted) throw new Error('guard-aborted');
    if (!record.stdout.includes('\n')) throw new Error('guard-ready-invalid');

    const readyLine = record.stdout.split('\n')[0];
    const ready = JSON.parse(readyLine);

    if (Object.keys(ready).sort().join(',') !== 'event,ownPID,targetPID,version' ||
        ready.event !== 'panel-process-guard-ready' || ready.version !== 1 ||
        ready.ownPID !== record.pid || ready.targetPID !== targetPid) {
      throw new Error('guard-ready-invalid');
    }

    ownership = await captureGuardIdentity(record, guardPath);
    if (signal?.aborted) throw new Error('guard-aborted');

    record.child.stdin.end('RUN\n');
    await waitFor(() => record.closeResult !== null || signal?.aborted === true,
      Math.max(1, deadline - Date.now()), 'guard-execution-timeout');

    if (signal?.aborted) throw new Error('guard-aborted');
    if (record.spawnFailed || record.stdinFailed || record.exitCode !== 0 ||
        record.signal !== null || record.closeResult?.code !== 0 ||
        record.closeResult?.signal !== null) {
      throw new Error('guard-process-result-invalid');
    }

    receipt = parseGuardOutput(record);

    if (!validReceipt(receipt, record.pid, targetPid)) {
      throw new Error('guard-receipt-invalid');
    }
  } catch {
    failureCode = 'guard-execution-unverified';
  } finally {
    guardCleanup = await cleanupGuard(record, ownership);
  }

  if (!guardCleanup?.verified) {
    const error = new Error('guard-cleanup-unverified');
    error.guardCleanup = { ...guardCleanup, pid: record.pid };

    throw error;
  }

  const after = processInventory().get(targetPid);
  const targetIdentityStable = !!after && sameProcessIdentity(targetIdentity, after) &&
    verifyLiveIdentity(targetIdentity, { rootPid: targetPid });

  if (!targetIdentityStable) throw new Error('target-identity-changed');

  const expectedBirthMatches = expectedBirthSeconds === null ||
    (receipt?.birthSeconds === expectedBirthSeconds &&
     receipt?.birthMicroseconds === expectedBirthMicroseconds);
  const verified = failureCode === null && receipt?.verified === true && expectedBirthMatches;
  const errorCode = verified
    ? null
    : expectedBirthMatches
      ? failureCode ?? receipt?.errorCode
      : 'target-birth-changed';

  return {
    requestVerified: verified,
    errorCode,
    receipt,
    guardCleanup: { ...guardCleanup, pid: record.pid },
  };
}

function exactRequest(value, requestId) {
  if (!value || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join(',') !==
        'context,expectedBirthSec,expectedBirthUsec,requestId,targetPid,version' ||
      value.version !== 1 || value.requestId !== requestId ||
      !Number.isSafeInteger(value.targetPid) || value.targetPid < 1 ||
      value.targetPid > 2_147_483_647 || !REQUEST_CONTEXTS.has(value.context)) {
    return false;
  }

  const noBirth = value.expectedBirthSec === null && value.expectedBirthUsec === null;

  if (value.context !== 'discovery' && noBirth) return false;

  return noBirth || (Number.isSafeInteger(value.expectedBirthSec) &&
    value.expectedBirthSec > 0 && Number.isInteger(value.expectedBirthUsec) &&
    value.expectedBirthUsec >= 0 && value.expectedBirthUsec <= 999999);
}

function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), 'ascii');

  if (body.length < 1 || body.length > MAX_FRAME_BYTES) {
    throw new Error('broker-response-frame-size-invalid');
  }

  return Buffer.concat([Buffer.from(String(body.length).padStart(4, '0'), 'ascii'), body]);
}

function decodeLength(header) {
  if (header.length !== 4 || header.some(byte => byte < 0x30 || byte > 0x39)) {
    throw new Error('broker-frame-header-invalid');
  }

  const length = Number(header.toString('ascii'));

  if (!Number.isInteger(length) || length < 1 || length > MAX_FRAME_BYTES) {
    throw new Error('broker-frame-size-invalid');
  }

  return length;
}

function writeResponse(stream, response) {
  const frame = encodeFrame(response);

  return new Promise((resolve, reject) => {
    stream.write(frame, error => {
      if (error) reject(new Error('broker-response-write-failed'));
      else resolve();
    });
  });
}

export function runPanelProcessBroker({
  actor,
  guardPath,
  appPid,
  appIdentity,
  allowEmptyRequests = false,
  signal,
}) {
  const requestStream = actor.stdio[3];
  const responseStream = actor.stdin;

  if (!requestStream || !responseStream || !guardPath?.startsWith('/') ||
      !Number.isSafeInteger(appPid) || appPid < 1 ||
      !appIdentity || appIdentity.pid !== appPid ||
      !verifyLiveIdentity(appIdentity, { rootPid: appPid })) {
    throw new Error('broker-channel-unavailable');
  }

  const records = [];
  let buffered = Buffer.alloc(0);
  let nextRequestId = 1;
  let pending = false;
  let requestEnded = false;
  let completed = false;
  let failed;
  let active = false;
  let inputBytes = 0;
  let pinnedTargetPid = null;
  let pinnedBirthSeconds = null;
  let pinnedBirthMicroseconds = null;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const controller = new AbortController();
  const settleFailure = () => {
    if (!failed || active || completed) return;
    completed = true;
    rejectDone(new Error(failed));
  };

  const fail = code => {
    if (!failed) {
      failed = code;
      controller.abort();

      if (!responseStream.destroyed && !responseStream.writableEnded) {
        responseStream.end();
      }
    }

    settleFailure();
  };

  const failActive = code => {
    pending = false;
    active = false;
    fail(code);
  };

  const finish = () => {
    if (failed || completed || !requestEnded || active) return;

    if (buffered.length !== 0 || pending ||
        (records.length === 0 && !allowEmptyRequests)) {
      fail(buffered.length ? 'broker-partial-frame' : 'broker-incomplete-session');

      return;
    }

    completed = true;
    responseStream.end();
    resolveDone(records);
  };

  const processFrames = async () => {
    if (pending || failed) return;

    while (buffered.length >= 4 && !pending && !failed) {
      let bodyLength;

      try {
        bodyLength = decodeLength(buffered.subarray(0, 4));
      } catch {
        fail('broker-frame-header-invalid');

        return;
      }

      if (buffered.length < bodyLength + 4) return;

      if (nextRequestId > MAX_REQUESTS) {
        fail('broker-request-limit-exceeded');

        return;
      }

      const body = buffered.subarray(4, bodyLength + 4);

      if (body.some(byte => byte > 0x7f)) {
        fail('broker-request-non-ascii');

        return;
      }

      let request;

      try {
        request = JSON.parse(body.toString('ascii'));
      } catch {
        fail('broker-request-json-invalid');

        return;
      }

      if (!exactRequest(request, nextRequestId)) {
        fail('broker-request-contract-invalid');

        return;
      }

      const initialRequest = nextRequestId === 1;
      const initialDiscovery = request.context === 'discovery' &&
        request.expectedBirthSec === null && request.expectedBirthUsec === null;
      const pinnedRequest = pinnedTargetPid !== null &&
        request.targetPid === pinnedTargetPid &&
        request.expectedBirthSec === pinnedBirthSeconds &&
        request.expectedBirthUsec === pinnedBirthMicroseconds;

      if ((initialRequest && !initialDiscovery) ||
          (!initialRequest && !pinnedRequest)) {
        fail('broker-target-attestation-sequence-invalid');

        return;
      }

      buffered = buffered.subarray(bodyLength + 4);

      if (buffered.length !== 0) {
        fail('broker-overlapping-request');

        return;
      }

      nextRequestId++;
      pending = true;
      active = true;

      try {
        if (!verifyLiveIdentity(appIdentity, { rootPid: appPid })) {
          throw new Error('broker-app-identity-unverified');
        }

        const targetIdentity = processInventory().get(request.targetPid);

        if (!targetIdentity || !verifyLiveIdentity(targetIdentity, {
          rootPid: request.targetPid,
        })) {
          throw new Error('broker-target-identity-unverified');
        }

        const result = await runPanelProcessGuard({
          guardPath,
          targetPid: request.targetPid,
          targetIdentity,
          expectedBirthSeconds: request.expectedBirthSec,
          expectedBirthMicroseconds: request.expectedBirthUsec,
          signal: controller.signal,
        });

        if (failed || controller.signal.aborted) {
          throw new Error('broker-aborted');
        }

        const receipt = result.receipt;

        if (!receipt?.birthStable || !Number.isSafeInteger(receipt.birthSeconds) ||
            receipt.birthSeconds < 1 || !Number.isInteger(receipt.birthMicroseconds) ||
            receipt.birthMicroseconds < 0 || receipt.birthMicroseconds > 999999 ||
            (pinnedTargetPid !== null &&
              (request.targetPid !== pinnedTargetPid ||
               receipt.birthSeconds !== pinnedBirthSeconds ||
               receipt.birthMicroseconds !== pinnedBirthMicroseconds))) {
          failActive('broker-target-attestation-sequence-invalid');

          return;
        }

        if (pinnedTargetPid === null && result.requestVerified === true) {
          pinnedTargetPid = request.targetPid;
          pinnedBirthSeconds = receipt.birthSeconds;
          pinnedBirthMicroseconds = receipt.birthMicroseconds;
        }

        const response = {
          version: 1,
          requestId: request.requestId,
          targetPid: request.targetPid,
          birthSeconds: receipt?.birthSeconds ?? null,
          birthMicroseconds: receipt?.birthMicroseconds ?? null,
          verified: result.requestVerified,
          errorCode: result.errorCode,
        };

        if (response.verified !== true && !GUARD_ERROR_CODES.has(response.errorCode)) {
          failActive('broker-result-contract-invalid');

          return;
        }

        if (!verifyLiveIdentity(appIdentity, { rootPid: appPid })) {
          failActive('broker-app-identity-changed');

          return;
        }

        await writeResponse(responseStream, response);
        records.push({
          requestId: request.requestId,
          context: request.context,
          targetPid: request.targetPid,
          verified: response.verified,
          errorCode: response.errorCode,
          guardCleanup: result.guardCleanup,
        });
        pending = false;
        active = false;
      } catch (error) {
        pending = false;
        active = false;

        if (error?.guardCleanup) {
          records.push({
            requestId: request.requestId,
            context: request.context,
            targetPid: request.targetPid,
            verified: false,
            errorCode: 'broker-guard-cleanup-unverified',
            guardCleanup: error.guardCleanup,
          });
        }

        fail('broker-guard-unverified');

        return;
      }

      settleFailure();
    }

    if (requestEnded) finish();
  };

  requestStream.on('data', chunk => {
    if (failed || completed || requestEnded) {
      if (chunk.length !== 0) fail('broker-trailing-request-data');

      return;
    }

    buffered = Buffer.concat([buffered, chunk]);
    inputBytes += chunk.length;

    if (buffered.length > (MAX_FRAME_BYTES + 4) * 2 ||
        inputBytes > (MAX_FRAME_BYTES + 4) * MAX_REQUESTS) {
      fail('broker-input-buffer-limit-exceeded');

      return;
    }

    if (pending) {
      fail('broker-overlapping-request');

      return;
    }

    void processFrames().catch(() => {
      pending = false;
      active = false;
      fail('broker-frame-processing-failed');
    });
  });
  requestStream.once('end', () => {
    requestEnded = true;

    finish();
  });
  requestStream.once('error', () => fail('broker-request-channel-error'));
  requestStream.once('close', () => {
    if (!requestEnded) {
      fail('broker-request-channel-closed-without-end');
    }
  });
  responseStream.once('error', () => fail('broker-response-channel-error'));

  if (signal) {
    signal.addEventListener('abort', () => fail('broker-aborted'), { once: true });
  }

  return { records, completion: done };
}
