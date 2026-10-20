import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import {
  captureOwnedProcessTree,
  processAlive,
  processGroupAlive,
  processInventory,
  stopOwnedProcessTree,
  verifyLiveIdentity,
} from './app-process-cleanup.mjs';

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitFor(check, description, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await check()) return true;
    await delay(10);
  }

  throw new Error(`Timed out waiting for ${description}`);
}

function collectFailureMessages(error, messages = []) {
  if (error instanceof AggregateError) {
    for (const nestedError of error.errors) collectFailureMessages(nestedError, messages);

    return messages;
  }

  if (error instanceof Error) {
    messages.push(error.message);

    return messages;
  }

  messages.push('A non-Error failure occurred.');

  return messages;
}

function writeFailureSummary(failures) {
  const allMessages = failures.flatMap(error => collectFailureMessages(error));
  const messageLimit = 16;
  const characterLimit = 512;

  const messages = allMessages.slice(0, messageLimit).map(message => {
    if (/(?:Command failed:|\bspawn\s)/u.test(message)) return 'A bounded child-process operation failed.';

    return message.replace(/[\r\n\t]/gu, ' ').slice(0, characterLimit);
  });

  const truncatedMessageCount = allMessages.slice(0, messageLimit)
    .filter(message => message.length > characterLimit).length;

  process.stderr.write(`${JSON.stringify({
    event: 'native-owned-process-cleanup-failure',
    messages,
    omittedMessageCount: Math.max(0, allMessages.length - messageLimit),
    truncatedMessageCount,
  })}\n`);
}

function createOutputLines(stream, child) {
  let buffer = '';
  const lines = [];
  const waiters = new Set();
  let streamFailure;

  const settleWaiters = () => {
    for (const waiter of waiters) {
      const index = lines.findIndex(waiter.matches);

      if (index < 0) continue;
      const [line] = lines.splice(index, 1);
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(line);
    }
  };

  const failWaiters = error => {
    streamFailure = error;

    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.reject(error);
    }
  };

  stream.on('data', chunk => {
    buffer += chunk.toString('utf8');
    const completeLines = buffer.split('\n');
    buffer = completeLines.pop();
    lines.push(...completeLines);
    settleWaiters();
  });
  stream.once('error', failWaiters);
  stream.once('end', () => failWaiters(new Error('Owned process fixture output closed before all readiness markers arrived.')));
  child.once('error', failWaiters);

  return {
    hasLine: line => lines.includes(line),
    waitForLine(matches, description, timeoutMs = 5_000) {
      const index = lines.findIndex(matches);

      if (index >= 0) return Promise.resolve(lines.splice(index, 1)[0]);

      if (streamFailure) return Promise.reject(streamFailure);

      return new Promise((resolve, reject) => {
        const waiter = {
          matches,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(`Timed out waiting for ${description}.`));
          }, timeoutMs),
        };

        waiters.add(waiter);
      });
    },
  };
}

test('cleanup quarantines only an identity-mismatched child and still escalates verified owned processes', {
  skip: process.platform !== 'darwin',
}, async () => {
  const quarantinedProgram = "process.on('SIGTERM', () => process.stdout.write('TERM:quarantined\\n')); process.stdout.write('READY:quarantined\\n'); setInterval(() => {}, 1000);";
  const verifiedProgram = "process.on('SIGTERM', () => {}); process.stdout.write('READY:verified\\n'); setInterval(() => {}, 1000);";

  const rootProgram = `import { spawn } from 'node:child_process';
const children = [];
let input = '';
let cleanupChildrenOnExit = true;
const stopChildren = () => {
  for (const child of children) {
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
};
process.on('exit', () => { if (cleanupChildrenOnExit) stopChildren(); });
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (!input.includes('\\n') || children.length > 0) return;
  let quarantined;
  let verified;
  try {
    quarantined = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(quarantinedProgram)}], { stdio: ['ignore', 1, 'ignore'] });
    children.push(quarantined);
    quarantined.on('error', () => process.stdout.write('SPAWN_FAILURE\\n'));
    verified = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(verifiedProgram)}], { stdio: ['ignore', 1, 'ignore'] });
    children.push(verified);
    verified.on('error', () => process.stdout.write('SPAWN_FAILURE\\n'));
  } catch {
    process.stdout.write('SPAWN_FAILURE\\n');
    return;
  }
  process.stdout.write('FIXTURE:' + JSON.stringify({ quarantinedPid: quarantined.pid, verifiedPid: verified.pid }) + '\\n');
});
process.stdin.on('end', async () => {
  process.stdout.write('EOF_RECEIVED\\n');
  stopChildren();

  const childrenClosed = await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);

      return;
    }

    const timer = setTimeout(() => {
      child.off('close', onClose);
      resolve(false);
    }, 2_000);
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };

    child.once('close', onClose);
  })));

  stopChildren();
  process.stdout.write(childrenClosed.every(Boolean) ? 'EOF_CHILDREN_CLOSED\\n' : 'EOF_CHILDREN_CLOSE_TIMEOUT\\n');
  process.exit(0);
});
process.stdin.resume();
process.on('SIGTERM', () => {
  cleanupChildrenOnExit = false;
  process.exit(0);
});
setInterval(() => {}, 1000);`;

  const root = spawn(process.execPath, ['--input-type=module', '-e', rootProgram], {
    detached: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });

  let rootInputError;

  root.stdin.on('error', error => { rootInputError = error; });

  const processState = { rootIdentity: undefined, identities: new Map(), captured: false };
  const fixtureIdentities = new Map();
  const outputLines = createOutputLines(root.stdout, root);
  let fixtureConstructionComplete = false;

  const rememberCapturedIdentities = () => {
    for (const identity of processState.identities.values()) fixtureIdentities.set(identity.pid, identity);
  };

  const writeRootInput = input => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out writing to the owned fixture root.')), 2_000);

    if (rootInputError) {
      clearTimeout(timer);
      reject(new Error('Owned fixture root input is unavailable.'));

      return;
    }

    try {
      root.stdin.write(input, error => {
        clearTimeout(timer);

        if (error || rootInputError) {
          reject(new Error('Unable to write to the owned fixture root input.'));

          return;
        }

        resolve();
      });
    } catch {
      clearTimeout(timer);
      reject(new Error('Unable to write to the owned fixture root input.'));
    }
  });

  const closeRootInput = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out closing owned fixture root input.')), 2_000);

    try {
      root.stdin.end(() => {
        clearTimeout(timer);

        if (rootInputError) {
          reject(new Error('Owned fixture root input closed with a stream error.'));

          return;
        }

        resolve();
      });
    } catch {
      clearTimeout(timer);
      reject(new Error('Unable to close owned fixture root input.'));
    }
  });

  const failures = [];

  try {
    await waitFor(() => processInventory().has(root.pid), 'the owned root identity to appear', 3_000);
    captureOwnedProcessTree({ rootPid: root.pid, state: processState });
    rememberCapturedIdentities();

    await writeRootInput('START\n');

    const fixtureLine = await outputLines.waitForLine(line => line.startsWith('FIXTURE:') || line === 'SPAWN_FAILURE', 'owned process fixture identities');

    assert.notEqual(fixtureLine, 'SPAWN_FAILURE', 'The owned root must report fixture child spawn failures.');

    fixtureConstructionComplete = true;

    const fixture = JSON.parse(fixtureLine.slice('FIXTURE:'.length));

    assert.ok(Number.isSafeInteger(fixture.quarantinedPid) && fixture.quarantinedPid > 1
      && Number.isSafeInteger(fixture.verifiedPid) && fixture.verifiedPid > 1, 'The actual owned child processes must spawn successfully.');

    await waitFor(() => {
      const inventory = processInventory();

      return inventory.has(fixture.quarantinedPid) && inventory.has(fixture.verifiedPid);
    }, 'both owned children to appear in the process inventory', 3_000);
    captureOwnedProcessTree({ rootPid: root.pid, state: processState });
    rememberCapturedIdentities();
    const quarantinedReady = await outputLines.waitForLine(line => line === 'READY:quarantined' || line === 'SPAWN_FAILURE', 'quarantined child signal handler readiness');
    const verifiedReady = await outputLines.waitForLine(line => line === 'READY:verified' || line === 'SPAWN_FAILURE', 'verified sibling signal handler readiness');

    assert.equal(quarantinedReady, 'READY:quarantined', 'The quarantined child must install its signal handler before teardown.');
    assert.equal(verifiedReady, 'READY:verified', 'The verified sibling must install its signal handler before teardown.');

    const quarantinedIdentity = processState.identities.get(fixture.quarantinedPid);
    const verifiedIdentity = processState.identities.get(fixture.verifiedPid);

    assert.ok(processState.rootIdentity);
    assert.ok(quarantinedIdentity);
    assert.ok(verifiedIdentity);
    assert.equal(processState.identities.size, 3);
    assert.ok([...processState.identities.values()].every(identity => identity.pgid === root.pid));

    const cleanup = [];

    const cleanupIdentities = [...processState.identities.values()].map(identity => identity.pid === fixture.quarantinedPid
      ? { ...identity, command: `${identity.command} deliberate test mismatch` }
      : identity);

    let rootExited = false;
    root.once('close', () => { rootExited = true; });

    await assert.rejects(stopOwnedProcessTree({
      rootPid: root.pid,
      rootIdentity: processState.rootIdentity,
      identities: cleanupIdentities,
      captured: processState.captured,
      isAppExited: () => rootExited,
      cleanup,
      waitFor,
      timeouts: { rootGraceMs: 250, termGraceMs: 150, killGraceMs: 1_000, leaderCloseMs: 1_000 },
    }), /cleanup remains unverified.*identity refusal.*timed out/iu);

    await waitFor(() => !processAlive(fixture.verifiedPid), 'the verified sibling to exit after SIGKILL', 3_000);
    await waitFor(() => !processAlive(root.pid), 'the owned root to exit after SIGTERM', 3_000);

    const signals = cleanup.filter(entry => entry.kind === 'app-process-signal');

    assert.ok(signals.some(entry => entry.pid === root.pid && entry.signal === 'SIGTERM' && entry.phase === 'root-first'));
    assert.ok(signals.some(entry => entry.pid === fixture.verifiedPid && entry.signal === 'SIGTERM'));
    assert.ok(signals.some(entry => entry.pid === fixture.verifiedPid && entry.signal === 'SIGKILL'));
    assert.equal(signals.some(entry => entry.pid === fixture.quarantinedPid), false);
    assert.equal(outputLines.hasLine('TERM:quarantined'), false, 'The identity-mismatched live child must receive no TERM.');
    assert.equal(cleanup.filter(entry => entry.kind === 'process-identity-mismatch').length, 1);
    assert.equal(processAlive(fixture.quarantinedPid), true);
    assert.equal(processAlive(fixture.verifiedPid), false);
    assert.equal(processAlive(root.pid), false);
    assert.equal(processGroupAlive(root.pid), true);
  } catch (error) {
    failures.push(error);
  } finally {
    const cleanupErrors = [];
    let finalTreeCaptured = false;
    let rootInputClosed = false;

    if (root.pid && root.stdin && !root.stdin.destroyed && root.exitCode === null && root.signalCode === null) {
      try {
        await closeRootInput();
        rootInputClosed = true;
      } catch (error) {
        cleanupErrors.push(error.message);
      }
    }

    if (root.pid && rootInputClosed && root.exitCode === null && root.signalCode === null) {
      try {
        await waitFor(() => root.exitCode !== null || root.signalCode !== null, 'owned root to close after stdin EOF', 3_000);
      } catch (error) {
        cleanupErrors.push(error.message);
      }
    }

    const rootConstructionFrozen = fixtureConstructionComplete || outputLines.hasLine('EOF_RECEIVED');

    if (root.pid && rootConstructionFrozen && processState.rootIdentity) {
      try {
        if (processAlive(root.pid)) {
          assert.equal(verifyLiveIdentity(processState.rootIdentity), true, 'The live root must still match its original captured identity before final descendant capture.');
          captureOwnedProcessTree({ rootPid: root.pid, state: processState });
          rememberCapturedIdentities();
          finalTreeCaptured = true;
        }
      } catch (error) {
        cleanupErrors.push(`Final exact-lineage capture failed: ${error.message}`);
      }
    }

    if (root.pid && !rootConstructionFrozen) {
      try {
        if (processAlive(root.pid)) cleanupErrors.push('Fixture construction could not be closed safely; refusing to signal a root with unknown pending children.');
      } catch (error) {
        cleanupErrors.push(`Cannot verify the fixture root while construction is unknown: ${error.message}`);
      }
    }

    for (const identity of [...fixtureIdentities.values()].reverse()) {
      if (identity.pid === root.pid && !finalTreeCaptured) continue;

      try {
        if (!processAlive(identity.pid)) continue;
        assert.equal(verifyLiveIdentity(identity), true, `Test-owned PID ${identity.pid} must still match its captured identity before exact cleanup.`);
        process.kill(identity.pid, 'SIGKILL');
      } catch (error) {
        if (error?.code !== 'ESRCH') cleanupErrors.push(`Exact test-owned PID ${identity.pid} cleanup failed: ${error.message}`);
      }
    }

    const capturedIdentities = [...fixtureIdentities.values()];

    if (root.pid && !finalTreeCaptured && root.exitCode === null && root.signalCode === null) {
      try {
        await waitFor(() => root.exitCode !== null || root.signalCode !== null, 'owned root to close after setup failure', 3_000);
      } catch (error) {
        cleanupErrors.push(error.message);
      }
    }

    try {
      await waitFor(() => capturedIdentities.every(identity => !processAlive(identity.pid)), 'all captured fixture PIDs to exit', 3_000);
    } catch (error) {
      cleanupErrors.push(error.message);
    }

    if (root.pid) {
      try {
        await waitFor(() => {
          const inventory = processInventory();

          return ![...inventory.values()].some(identity => identity.pgid === root.pid) && !processGroupAlive(root.pid);
        }, 'the exact fixture process group to disappear', 3_000);
      } catch (error) {
        cleanupErrors.push(error.message);
      }
    }

    let finalInventory;

    try {
      finalInventory = processInventory();
    } catch (error) {
      cleanupErrors.push(`Final owned process inventory failed: ${error.message}`);
    }

    for (const identity of capturedIdentities) {
      try {
        if (processAlive(identity.pid) || finalInventory?.has(identity.pid)) {
          cleanupErrors.push(`Captured test-owned PID ${identity.pid} remains present.`);
        }
      } catch (error) {
        cleanupErrors.push(`Captured test-owned PID ${identity.pid} final check failed: ${error.message}`);
      }
    }

    if (root.pid) {
      try {
        const memberRemains = [...(finalInventory?.values() ?? [])].some(identity => identity.pgid === root.pid);

        if (memberRemains || processGroupAlive(root.pid)) cleanupErrors.push(`Exact test process group ${root.pid} remains present.`);
      } catch (error) {
        cleanupErrors.push(`Exact test process group ${root.pid} final check failed: ${error.message}`);
      }
    }

    if (cleanupErrors.length > 0) {
      failures.push(new AggregateError(cleanupErrors.map(message => new Error(message)), 'Owned test fixture cleanup failed.'));
    }
  }

  if (failures.length > 0) {
    writeFailureSummary(failures);
    throw new AggregateError(failures, 'Native owned-process cleanup contract failed.');
  }
});
