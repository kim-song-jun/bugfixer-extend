import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  captureOwnedProcessTree,
  processAlive,
  processGroupAlive,
  processInventory,
  stopOwnedProcessTree,
  verifyLiveIdentity,
} from './app-process-cleanup.mjs';

const actorPath = fileURLToPath(new URL('../native-project-picker-actor.js', import.meta.url));

const osascriptPath = '/usr/bin/osascript';

const allowedInputStages = new Set([
  'header-buffer-create',
  'header-ref-create',
  'header-read',
  'header-count',
  'header-append',
  'header-decode',
  'header-length',
  'payload-buffer-create',
  'payload-ref-create',
  'payload-read',
  'payload-count',
  'payload-append',
  'payload-decode',
  'payload-parse',
  'schema',
]);

const expectedFailureKeys = [
  'actionCount',
  'appPID',
  'arrayQueryDiagnostic',
  'cleanupStatus',
  'currentClientTrusted',
  'currentHelperPID',
  'defaultActionCount',
  'failureCode',
  'failurePhase',
  'guardTransportStage',
  'cancelCandidateCount',
  'cancelControlStage',
  'cancelReferenceDiagnostic',
  'inputPayloadByteCount',
  'inputTargetPathLength',
  'inputTransportStage',
  'panelPidMismatchDiagnostic',
  'pidMismatchDiagnostic',
  'pidQueryStatus',
  'promptRequested',
  'roleCounts',
  'semanticPathFieldCount',
  'settableTextFieldCount',
  'sheetPIDRelation',
  'sheetCount',
  'status',
  'textFieldCount',
  'typeIdDiagnostic',
  'windowCount',
  'windowRoleAXErrorStatus',
  'windowRoleFailureStage',
  'windowsAttributeAXErrorStatus',
].sort();

const cases = [];

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

async function captureIdentity(record) {
  await waitFor(() => record.spawnFailed || record.exitObserved || processInventory().has(record.pid),
    'actor-process-identity-timeout', 3_000);

  if (record.spawnFailed || record.exitObserved) {
    throw new Error('actor-exited-before-identity-capture');
  }

  const state = { captured: false, identities: new Map() };
  captureOwnedProcessTree({
    rootPid: record.pid,
    executablePath: osascriptPath,
    appExited: record.exitObserved,
    state,
  });

  if (!state.captured || !state.rootIdentity || !state.identities.has(record.pid) ||
      !verifyLiveIdentity(state.rootIdentity, { rootPid: record.pid })) {
    throw new Error('actor-ownership-capture-invalid');
  }

  return state;
}

function encodePayload(targetPath) {
  const body = Buffer.from(JSON.stringify({ targetPath }), 'utf8');

  if (body.length < 1 || body.length > 16_384) {
    throw new Error('payload-bound-invalid');
  }

  return {
    body,
    frame: Buffer.concat([
      Buffer.from(String(body.length).padStart(5, '0'), 'ascii'),
      body,
    ]),
  };
}

async function writeChunk(stream, chunk) {
  let timer;
  let result;

  try {
    result = await Promise.race([
      new Promise((resolve, reject) => {
        stream.write(chunk, error => error
          ? reject(new Error('actor-input-write-failed'))
          : resolve(true));
      }),
      new Promise(resolve => {
        timer = setTimeout(() => resolve(false), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }

  if (result !== true) throw new Error('actor-input-write-timeout');
}

async function writeSplitFrame(stream, frame, body) {

  for (let index = 0; index < 5; index++) {
    await writeChunk(stream, frame.subarray(index, index + 1));
  }

  const marker = Buffer.from('한', 'utf8');
  const markerOffset = body.indexOf(marker);

  if (markerOffset < 0) throw new Error('korean-marker-not-present');

  const splitOffset = 5 + markerOffset + 1;
  await writeChunk(stream, frame.subarray(5, splitOffset));
  await writeChunk(stream, frame.subarray(splitOffset));
}

function parseReceipt(stdout, stdoutBytes) {
  if (stdoutBytes < 1 || stdoutBytes > 4_096) {
    throw new Error('actor-output-bound-invalid');
  }

  let receipt;

  try {
    receipt = JSON.parse(stdout.trim());
  } catch {
    throw new Error('actor-receipt-invalid');
  }

  if (receipt === null || Array.isArray(receipt) ||
      Object.getPrototypeOf(receipt) !== Object.prototype ||
      JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(expectedFailureKeys)) {
    throw new Error('actor-failure-receipt-shape-invalid');
  }

  if (receipt.status !== 'failed' || receipt.appPID !== 0 ||
      receipt.currentHelperPID !== null || receipt.currentClientTrusted !== null ||
      receipt.promptRequested !== false || receipt.failurePhase !== 'INPUT' ||
      receipt.failureCode !== 'panel-guard-failed' || receipt.actionCount !== 0 ||
      receipt.windowCount !== 0 || receipt.cleanupStatus !== 'not-needed' ||
      receipt.guardTransportStage !== null || receipt.sheetPIDRelation !== null ||
      receipt.cancelCandidateCount !== null || receipt.cancelControlStage !== null ||
      receipt.cancelReferenceDiagnostic !== null ||
      receipt.panelPidMismatchDiagnostic !== null ||
      receipt.arrayQueryDiagnostic !== null ||
      receipt.pidQueryStatus !== null || receipt.pidMismatchDiagnostic !== null ||
      receipt.typeIdDiagnostic !== null || receipt.windowRoleFailureStage !== null ||
      receipt.windowRoleAXErrorStatus !== null ||
      receipt.windowsAttributeAXErrorStatus !== null || receipt.sheetCount !== 0 ||
      receipt.textFieldCount !== 0 || receipt.settableTextFieldCount !== 0 ||
      receipt.semanticPathFieldCount !== 0 || receipt.defaultActionCount !== 0 ||
      receipt.roleCounts === null || Array.isArray(receipt.roleCounts) ||
      Object.getPrototypeOf(receipt.roleCounts) !== Object.prototype ||
      Object.keys(receipt.roleCounts).length !== 0 ||
      !allowedInputStages.has(receipt.inputTransportStage) ||
      !(receipt.inputPayloadByteCount === null ||
        (Number.isSafeInteger(receipt.inputPayloadByteCount) &&
          receipt.inputPayloadByteCount >= 0 && receipt.inputPayloadByteCount <= 16_384)) ||
      !(receipt.inputTargetPathLength === null ||
        (Number.isSafeInteger(receipt.inputTargetPathLength) &&
          receipt.inputTargetPathLength >= 0 && receipt.inputTargetPathLength <= 4_096))) {
    throw new Error('actor-input-failure-contract-invalid');
  }

  return receipt;
}

async function settleOwned(record, ownership, label) {
  let cleanupError = null;

  if (record.child.stdin && !record.exitObserved) {
    try {
      record.child.stdin.end();
    } catch {
      cleanupError = 'actor-stdin-close-failed';
    }
  }

  if (ownership?.captured) {
    let processesRemain = !record.exitObserved;

    try {
      const inventory = processInventory();
      processesRemain ||= [...ownership.identities.keys()].some(pid =>
        inventory.has(pid) || processAlive(pid));
      processesRemain ||= [...inventory.values()].some(identity => identity.pgid === record.pid)
        || (Number.isSafeInteger(record.pid) && processGroupAlive(record.pid));
    } catch {
      cleanupError = 'actor-pre-stop-inspection-failed';
      processesRemain = true;
    }

    if (!record.exitObserved && processesRemain) {
      try {
        captureOwnedProcessTree({
          rootPid: record.pid,
          executablePath: osascriptPath,
          appExited: false,
          state: ownership,
        });
      } catch {
        cleanupError ??= 'actor-final-tree-capture-failed';
      }
    }

    if (processesRemain) {

      try {
        await stopOwnedProcessTree({
          rootPid: record.pid,
          rootIdentity: ownership.rootIdentity,
          identities: [...ownership.identities.values()],
          captured: ownership.captured,
          isAppExited: () => record.exitObserved,
          cleanup: [],
          waitFor,
          timeouts: {
            rootGraceMs: 500,
            termGraceMs: 1_000,
            killGraceMs: 1_000,
            leaderCloseMs: 2_000,
          },
        });
      } catch {
        cleanupError ??= 'actor-owned-stop-unverified';
      }
    }
  }

  try {
    await waitFor(() => record.closed, `${label}-close-timeout`, 3_000);
  } catch {
    cleanupError ??= 'actor-close-unverified';
  }

  if (!record.closed) {
    record.child.stdout.destroy();
    record.child.stderr.destroy();
    record.child.stdin.destroy();
    record.child.unref();

    try {
      await waitFor(() => record.closed, `${label}-final-close-timeout`, 1_000);
    } catch {
      cleanupError ??= 'actor-final-close-unverified';
    }
  }

  let pidAbsent = false;
  let groupAbsent = false;

  try {
    const inventory = processInventory();
    pidAbsent = ownership?.captured === true &&
      [...ownership.identities.keys()].every(pid => !inventory.has(pid) && !processAlive(pid));
    groupAbsent = ownership?.captured === true && Number.isSafeInteger(record.pid) &&
      ![...inventory.values()].some(identity => identity.pgid === record.pid) &&
      !processGroupAlive(record.pid);
  } catch {
    cleanupError ??= 'actor-absence-unverified';
  }

  const verified = cleanupError === null && record.exitObserved && record.closed &&
    record.exitCode === 0 && record.signal === null && pidAbsent && groupAbsent;

  return {
    verified,
    exitObserved: record.exitObserved,
    closed: record.closed,
    pidAbsent,
    groupAbsent,
    errorCode: cleanupError,
  };
}

async function runCase(spec) {
  const encoded = spec.targetPath === undefined ? null : encodePayload(spec.targetPath);

  const child = spawn(osascriptPath, [
    '-l',
    'JavaScript',
    actorPath,
    'select',
    '0',
  ], {
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const record = {
    child,
    pid: child.pid,
    exitObserved: false,
    closed: false,
    exitCode: null,
    signal: null,
    stdout: '',
    stdoutBytes: 0,
    stderrBytes: 0,
    outputTooLarge: false,
    spawnFailed: false,
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
    record.closed = true;
    record.exitCode = code;
    record.signal = signal;
  });
  child.stdout.on('data', chunk => {
    record.stdoutBytes += chunk.length;

    if (record.stdoutBytes <= 4_096) record.stdout += chunk.toString('utf8');
    else record.outputTooLarge = true;
  });
  child.stderr.on('data', chunk => {
    record.stderrBytes += chunk.length;
  });
  child.stdin.on('error', () => {
    record.stdinFailed = true;
  });

  let ownership;
  let receipt;
  let failureCode = null;

  try {
    ownership = await captureIdentity(record);

    if (spec.frameKind === 'malformed-header') {
      await writeChunk(child.stdin, Buffer.from('xxxxx', 'ascii'));
      child.stdin.end();
    } else if (spec.frameKind === 'invalid-json') {
      const body = Buffer.from('{bad', 'utf8');
      await writeChunk(child.stdin, Buffer.concat([
        Buffer.from(String(body.length).padStart(5, '0'), 'ascii'),
        body,
      ]));
      child.stdin.end();
    } else if (spec.frameKind === 'truncated-body') {
      const body = Buffer.from('{"targetPath":"/tmp/x"}', 'utf8');
      await writeChunk(child.stdin, Buffer.concat([
        Buffer.from(String(body.length + 4).padStart(5, '0'), 'ascii'),
        body,
      ]));
      child.stdin.end();
    } else if (spec.splitFrame) {
      await writeSplitFrame(child.stdin, encoded.frame, encoded.body);
    } else {
      await writeChunk(child.stdin, encoded.frame);
    }

    await waitFor(() => record.closed, `${spec.name}-actor-close-timeout`, 10_000);

    if (record.spawnFailed || record.stdinFailed || record.outputTooLarge ||
        record.stdoutBytes > 4_096 || record.stderrBytes > 4_096 ||
        record.exitCode !== 0 || record.signal !== null) {
      throw new Error('actor-process-contract-failed');
    }

    receipt = parseReceipt(record.stdout, record.stdoutBytes);

    if (encoded !== null) {
      if (spec.expectedStage) {
        assert.equal(receipt.inputTransportStage, spec.expectedStage);
      } else if (spec.expectedStages) {
        assert.ok(spec.expectedStages.includes(receipt.inputTransportStage));
      } else {
        assert.ok(receipt.inputTransportStage !== 'schema');
      }

      assert.equal(receipt.inputPayloadByteCount, encoded.body.length);
      assert.equal(receipt.inputTargetPathLength, spec.targetPath.length);
    } else {
      assert.equal(receipt.inputTargetPathLength, null);

      if (spec.expectedStage) {
        assert.equal(receipt.inputTransportStage, spec.expectedStage);
      } else if (spec.expectedStages) {
        assert.ok(spec.expectedStages.includes(receipt.inputTransportStage));
      } else {
        assert.ok(receipt.inputTransportStage !== 'schema');
      }

      if (spec.expectedPayloadBytes !== undefined) {
        assert.equal(receipt.inputPayloadByteCount, spec.expectedPayloadBytes);
      }
    }
  } catch {
    failureCode = 'actor-input-contract-failed';
  }

  const cleanup = await settleOwned(record, ownership, spec.name);
  const passed = failureCode === null && cleanup.verified;
  const identity = ownership?.rootIdentity;

  const result = {
    name: spec.name,
    actorPID: Number.isSafeInteger(record.pid) ? record.pid : null,
    actorParentPID: Number.isSafeInteger(identity?.ppid) ? identity.ppid : null,
    actorProcessGroupID: Number.isSafeInteger(identity?.pgid) ? identity.pgid : null,
    actorProcessStarted: identity?.started ?? null,
    actorCommandContract: 'osascript -l JavaScript native-project-picker-actor.js select 0',
    processIdentityCaptured: ownership?.captured === true,
    passed,
    stage: receipt?.inputTransportStage ?? null,
    payloadByteCount: receipt?.inputPayloadByteCount ?? null,
    targetPathLength: receipt?.inputTargetPathLength ?? null,
    currentHelperPIDNull: receipt?.currentHelperPID === null,
    currentClientTrustedNull: receipt?.currentClientTrusted === null,
    cleanup,
    failureCode: passed ? null : failureCode ?? 'actor-cleanup-unverified',
  };

  cases.push(result);
  process.stdout.write(`${JSON.stringify(result)}\n`);

  if (!passed) throw new Error(`${spec.name}-failed`);
}

const asciiPath = '/tmp/whiteboard-picker-input-contract';

const koreanPath = '/tmp/whiteboard-picker-input-한글';

const malformedPayloadBytes = Buffer.byteLength('{bad', 'utf8');

try {
  await runCase({
    name: 'ascii-framed-payload',
    targetPath: asciiPath,
    expectedStage: 'schema',
  });
  await runCase({
    name: 'korean-split-utf8-payload',
    targetPath: koreanPath,
    expectedStage: 'schema',
    splitFrame: true,
  });
  await runCase({
    name: 'malformed-header',
    frameKind: 'malformed-header',
    expectedStage: 'header-length',
    expectedPayloadBytes: null,
  });
  await runCase({
    name: 'invalid-json',
    frameKind: 'invalid-json',
    expectedStage: 'payload-parse',
    expectedPayloadBytes: malformedPayloadBytes,
  });
  await runCase({
    name: 'truncated-body-eof',
    frameKind: 'truncated-body',
    expectedStages: ['payload-read', 'payload-count'],
    expectedPayloadBytes: null,
  });
} catch {
  process.stdout.write(`${JSON.stringify({ event: 'picker-input-contracts', passed: false, completedCases: cases.length })}\n`);
  process.exitCode = 1;
}

if (cases.length === 5 && cases.every(result => result.passed)) {
  process.stdout.write(`${JSON.stringify({ event: 'picker-input-contracts', passed: true, caseCount: cases.length })}\n`);
}
