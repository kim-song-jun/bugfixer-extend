import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../../scripts/provider-group-control.mjs', import.meta.url));

const nonce = 'a'.repeat(64);

const attemptId = 'attempt-test-1';

const graceMs = 350;

const liveGroups = new Set();

const liveSockets = new Set();

async function startHelper({ providerCode, closeResult = false, guardian = false, wrongGroup = false, ownerLifetime = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bfx-control-test-'));
  await (await import('node:fs/promises')).chmod(directory, 0o700);
  const socketPath = path.join(directory, 'attempt.sock');
  const helperPidPath = path.join(directory, 'helper.pid');

  const command = guardian
    ? `"$1" "$2" "$3" "$4" "$$" ${ownerLifetime ? '--owner-lifetime ' : ''}"$5" "$6" "$7" & echo $! > "$8"; wait`
    : `exec "$1" "$2" "$3" "$4" ${wrongGroup ? '1' : '"$$"'} ${ownerLifetime ? '--owner-lifetime ' : ''}"$5" "$6" "$7"`;

  const args = guardian
    ? ['-c', command, 'sh', process.execPath, scriptPath, socketPath, attemptId, process.execPath, '-e', providerCode, helperPidPath]
    : ['-c', command, 'sh', process.execPath, scriptPath, socketPath, attemptId, process.execPath, '-e', providerCode];

  const child = spawn('/bin/sh', args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'pipe', 'pipe', ...(ownerLifetime ? ['pipe'] : [])],
    env: { ...process.env, BFX_PROVIDER_CONTROL_GRACE_MS: String(graceMs), TEST_CONTROL_SOCKET: socketPath }
  });

  liveGroups.add(child.pid);
  liveSockets.add(socketPath);
  child.stdio[5].end(`${nonce}\n`);

  if (closeResult) child.stdio[4].destroy();
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });

  return { child, directory, socketPath, helperPidPath, ownerLifetimeInput: ownerLifetime ? child.stdio[6] : undefined, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

async function waitForSocket(socketPath, child, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`helper exited early (${child.exitCode}): ${child.stderr}`);

    try {
      const info = await stat(socketPath);

      if (info.isSocket()) return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    await delay(15);
  }

  throw new Error(`control socket did not become ready: ${child.stderr}`);
}

async function request(socketPath, payload) {
  const socket = net.createConnection(socketPath);
  socket.setTimeout(1500, () => socket.destroy(new Error('control request timed out')));
  await once(socket, 'connect');
  socket.write(`${JSON.stringify(payload)}\n`);
  let response = '';
  socket.setEncoding('utf8');

  for await (const chunk of socket) response += chunk;

  return response;
}

function probeProcessGroup(pgid) {
  try {
    process.kill(-pgid, 0);

    return { state: 'present' };
  } catch (error) {
    if (error.code === 'ESRCH') return { state: 'absent' };

    if (error.code === 'EPERM') return { state: 'unverifiable', error };

    throw error;
  }
}

function processGroupSnapshot(pgid) {
  try {
    // Darwin's `uid` ps keyword reports the effective UID. Do not request args or env.
    const output = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,uid=,state=,comm='], {
      encoding: 'utf8',
      timeout: 1000,
      maxBuffer: 256 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    });

    const members = output.split(/\r?\n/).flatMap(line => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);

      if (!match || Number(match[3]) !== pgid) return [];

      return [{
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        euid: Number(match[4]),
        state: match[5],
        comm: match[6]
      }];
    });

    return { members };
  } catch (error) {
    return { error: `${error.code ?? 'error'}: ${error.message}` };
  }
}

function describeProcessGroupSnapshot(snapshot) {
  if (snapshot.error) return `ps snapshot unavailable (${snapshot.error})`;

  if (snapshot.members.length === 0) return 'ps snapshot empty (not proof of process-group absence)';

  return snapshot.members.map(member => `pid=${member.pid} ppid=${member.ppid} pgid=${member.pgid} euid=${member.euid} state=${member.state} comm=${member.comm}`).join('; ');
}

function describePermissionError(error) {
  return `${error.message} (code=${error.code ?? 'unknown'}, errno=${error.errno ?? 'unknown'})`;
}

async function waitForGroupGone(pgid, timeoutMs = 2500, priorEPERM) {
  const deadline = Date.now() + timeoutMs;
  let firstEPERM = priorEPERM;
  let probe;

  do {
    probe = probeProcessGroup(pgid);

    if (probe.state === 'absent') return { state: 'absent', firstEPERM };

    if (probe.state === 'unverifiable' && !firstEPERM) firstEPERM = probe.error;

    if (Date.now() >= deadline) break;
    await delay(20);
  } while (Date.now() < deadline);

  probe = probeProcessGroup(pgid);

  if (probe.state === 'absent') return { state: 'absent', firstEPERM };

  if (probe.state === 'unverifiable' && !firstEPERM) firstEPERM = probe.error;

  return { state: probe.state, firstEPERM, snapshot: processGroupSnapshot(pgid) };
}

function verifyOwnedLiveGroup(child, snapshot) {
  if (snapshot.error) return 'process-group ownership snapshot failed';

  const members = snapshot.members;

  if (members.length === 0) return 'process-group snapshot contained no members';

  if (members.some(member => member.euid !== process.geteuid())) return 'process group contains a member with a different effective UID';

  const childMember = members.find(member => member.pid === child.pid && member.pgid === child.pid);

  if (!childMember || /^[ZX]/.test(childMember.state)) return 'spawned process-group leader is not verifiably live in its owned group';

  if (child.exitCode !== null || child.signalCode !== null) return 'spawned process-group leader has exited';

  const latestProbe = probeProcessGroup(child.pid);

  if (latestProbe.state !== 'present') {
    return latestProbe.state === 'unverifiable'
      ? `latest process-group probe is unverifiable (${describePermissionError(latestProbe.error)})`
      : 'latest process-group probe confirms absence';
  }

  if (child.exitCode !== null || child.signalCode !== null) return 'spawned process-group leader exited before escalation';

  return undefined;
}

function groupCleanupError(pgid, result, reason) {
  const permissionDetail = result.firstEPERM
    ? `; first EPERM: ${describePermissionError(result.firstEPERM)}`
    : '';

  const snapshotDetail = result.snapshot
    ? `; members: ${describeProcessGroupSnapshot(result.snapshot)}`
    : '';

  return new Error(`test-owned process group ${pgid} cleanup remains ${result.state}: ${reason}${permissionDetail}${snapshotDetail}`);
}

async function cleanup(run) {
  if (!run) return;
  const { child, directory, socketPath } = run;
  const initialProbe = probeProcessGroup(child.pid);

  if (initialProbe.state !== 'absent') {
    try {
      if ((await stat(socketPath)).isSocket()) await request(socketPath, { attemptId, nonce, command: 'cancel' });
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ECONNREFUSED') throw error;
    }
  }

  let groupResult = await waitForGroupGone(child.pid, 750, initialProbe.state === 'unverifiable' ? initialProbe.error : undefined);

  if (groupResult.state !== 'absent') {
    if (groupResult.state !== 'present') {
      throw groupCleanupError(child.pid, groupResult, 'ownership or liveness is unverifiable; refusing process-group SIGKILL');
    }

    const ownershipFailure = verifyOwnedLiveGroup(child, groupResult.snapshot);

    if (ownershipFailure) throw groupCleanupError(child.pid, groupResult, `${ownershipFailure}; refusing process-group SIGKILL`);

    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw groupCleanupError(child.pid, groupResult, `verified owned process-group SIGKILL failed (${describePermissionError(error)})`);
      }
    }

    groupResult = await waitForGroupGone(child.pid, 2500, groupResult.firstEPERM);
  }

  if (groupResult.state !== 'absent') {
    throw groupCleanupError(child.pid, groupResult, 'absence was not confirmed with ESRCH');
  }

  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([once(child, 'exit'), delay(1500)]);
  }

  liveGroups.delete(child.pid);
  liveSockets.delete(socketPath);
  await rm(directory, { recursive: true, force: true });
}

test('control socket is ready before provider starts and uses a private socket', async t => {
  const marker = path.join(os.tmpdir(), `bfx-provider-ready-${process.pid}`);
  await rm(marker, { force: true });
  const run = await startHelper({ providerCode: `const fs = require('node:fs'); const net = require('node:net'); const socket = net.createConnection(process.env.TEST_CONTROL_SOCKET); socket.once('connect', () => { fs.writeFileSync(${JSON.stringify(marker)}, 'ready'); socket.end(); }); socket.once('error', () => fs.writeFileSync(${JSON.stringify(marker)}, 'not-ready')); setInterval(() => {}, 1000);` });
  t.after(async () => { await rm(marker, { force: true }); await cleanup(run); });
  await waitForSocket(run.socketPath, run.child);

  for (let i = 0; i < 100; i++) { try { assert.equal(await readFile(marker, 'utf8'), 'ready'); break; } catch (error) { if (error.code !== 'ENOENT' || i === 99) throw error; await delay(10); } }

  assert.equal((await stat(run.directory)).mode & 0o777, 0o700);
  const socketInfo = await stat(run.socketPath);
  assert.equal(socketInfo.isSocket(), true);
  assert.equal(socketInfo.uid, process.getuid());
  assert.equal(socketInfo.mode & 0o777, 0o600);
});

test('wrong process group identity fails before socket bind or provider launch', async t => {
  const marker = path.join(os.tmpdir(), `bfx-provider-wrong-group-${process.pid}`);
  await rm(marker, { force: true });
  const run = await startHelper({ wrongGroup: true, providerCode: `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched');` });
  t.after(async () => { await rm(marker, { force: true }); await cleanup(run); });

  const [code] = run.child.exitCode === null && run.child.signalCode === null
    ? await once(run.child, 'exit')
    : [run.child.exitCode];

  assert.notEqual(code, 0);
  await assert.rejects(stat(run.socketPath), { code: 'ENOENT' });
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('wrong nonce is rejected without signalling the process group', async t => {
  const run = await startHelper({ providerCode: 'setInterval(() => {}, 1000);' });
  t.after(() => cleanup(run));
  await waitForSocket(run.socketPath, run.child);
  const response = await request(run.socketPath, { attemptId, nonce: 'b'.repeat(64), command: 'cancel' });
  assert.equal(response, 'rejected\n');
  assert.equal(run.child.exitCode, null);
  assert.equal(process.kill(-run.child.pid, 0), true);
});

test('a disconnected control client cannot stop later authenticated cancellation', async t => {
  const run = await startHelper({ providerCode: 'setInterval(() => {}, 1000);' });
  t.after(() => cleanup(run));
  await waitForSocket(run.socketPath, run.child);
  const disconnected = net.createConnection(run.socketPath);
  await once(disconnected, 'connect');
  disconnected.write(`${'x'.repeat(5000)}\n`);
  disconnected.destroy();
  await delay(50);
  assert.equal(run.child.exitCode, null);
  assert.equal(await request(run.socketPath, { attemptId, nonce, command: 'cancel' }), 'accepted\n');
  await once(run.child, 'exit');
});


test('helper remains cancellable after its shell group leader exits', async t => {
  const run = await startHelper({ guardian: true, providerCode: 'setInterval(() => {}, 1000);' });
  t.after(() => cleanup(run));
  await waitForSocket(run.socketPath, run.child);
  let helperPid;

  for (let i = 0; i < 100; i++) {
    try { helperPid = Number(await readFile(run.helperPidPath, 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT' || i === 99) throw error; await delay(10); }
  }

  assert.ok(helperPid > 0);
  process.kill(run.child.pid, 'SIGKILL');
  await once(run.child, 'exit');
  assert.equal(process.kill(helperPid, 0), true);
  assert.equal(await request(run.socketPath, { attemptId, nonce, command: 'cancel' }), 'accepted\n');

  for (let i = 0; i < 150; i++) {
    try { process.kill(helperPid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }

    await delay(20);
  }

  assert.fail(`surviving helper ${helperPid} did not exit after cancellation`);
});

test('helper remains available after fd4 is closed and acknowledges cancellation', async t => {
  const run = await startHelper({ closeResult: true, providerCode: 'setInterval(() => {}, 1000);' });
  t.after(() => cleanup(run));
  await waitForSocket(run.socketPath, run.child);
  const response = await request(run.socketPath, { attemptId, nonce, command: 'cancel' });
  assert.equal(response, 'accepted\n');
  await once(run.child, 'exit');
});

test('TERM-ignoring provider is killed after bounded grace period', async t => {
  const marker = path.join(os.tmpdir(), `bfx-provider-pid-${process.pid}`);
  await rm(marker, { force: true });
  const run = await startHelper({ providerCode: `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);` });
  t.after(async () => { await rm(marker, { force: true }); await cleanup(run); });
  await waitForSocket(run.socketPath, run.child);
  let providerPid;

  for (let i = 0; i < 100; i++) {
    try { providerPid = Number(await readFile(marker, 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT' || i === 99) throw error; await delay(10); }
  }

  const before = Date.now();
  assert.equal(await request(run.socketPath, { attemptId, nonce, command: 'cancel' }), 'accepted\n');
  await once(run.child, 'exit');
  assert.ok(Date.now() - before >= graceMs - 50);

  for (let i = 0; i < 100; i++) {
    try { process.kill(providerPid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }

    if (i === 99) assert.fail(`provider ${providerPid} still exists`);
    await delay(10);
  }
});

test('owner-lifetime EOF terminates the helper process group after bounded grace', async t => {
  const marker = path.join(os.tmpdir(), `bfx-provider-owner-lifetime-${process.pid}`);

  await rm(marker, { force: true });

  const run = await startHelper({ ownerLifetime: true, providerCode: `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' }); child.unref(); require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(child.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);` });

  t.after(async () => { await rm(marker, { force: true }); await cleanup(run); });
  await waitForSocket(run.socketPath, run.child);

  let descendantPid;

  for (let i = 0; i < 100; i++) {
    try { descendantPid = Number(await readFile(marker, 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT' || i === 99) throw error; await delay(10); }
  }

  assert.ok(descendantPid > 0);
  run.ownerLifetimeInput.destroy();
  await once(run.child, 'exit');
  const groupResult = await waitForGroupGone(run.child.pid);
  assert.equal(groupResult.state, 'absent', groupCleanupError(run.child.pid, groupResult, 'owner-lifetime cleanup did not confirm absence with ESRCH').message);

  for (let i = 0; i < 100; i++) {
    try { process.kill(descendantPid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }

    if (i === 99) assert.fail(`provider descendant ${descendantPid} still exists`);
    await delay(10);
  }

  assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' }, 'provider descendant must not survive owner-lifetime EOF');
});

test('provider exit code is written to fd4 while helper stays available', async t => {
  const run = await startHelper({ providerCode: 'process.exit(23);' });
  t.after(() => cleanup(run));
  await waitForSocket(run.socketPath, run.child);

  const result = await new Promise(resolve => {
    let value = '';
    const stream = run.child.stdio[4].setEncoding('utf8');
    stream.on('data', chunk => {
      value += chunk;

      if (value.includes('\n')) resolve(value);
    });
  });

  assert.equal(result.trim(), '23');
  assert.equal(run.child.exitCode, null);
  assert.equal(await request(run.socketPath, { attemptId, nonce, command: 'cancel' }), 'accepted\n');
  await once(run.child, 'exit');
});

test.after(() => {
  assert.equal(liveGroups.size, 0, `unreaped test groups: ${[...liveGroups].join(', ')}`);
  assert.equal(liveSockets.size, 0, `unremoved test sockets: ${[...liveSockets].join(', ')}`);
});
