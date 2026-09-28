import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

async function startHelper({ providerCode, closeResult = false, guardian = false, wrongGroup = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bfx-control-test-'));
  await (await import('node:fs/promises')).chmod(directory, 0o700);
  const socketPath = path.join(directory, 'attempt.sock');
  const helperPidPath = path.join(directory, 'helper.pid');

  const command = guardian
    ? '"$1" "$2" "$3" "$4" "$$" "$5" "$6" "$7" & echo $! > "$8"; wait'
    : `exec "$1" "$2" "$3" "$4" ${wrongGroup ? '1' : '"$$"'} "$5" "$6" "$7"`;

  const args = guardian
    ? ['-c', command, 'sh', process.execPath, scriptPath, socketPath, attemptId, process.execPath, '-e', providerCode, helperPidPath]
    : ['-c', command, 'sh', process.execPath, scriptPath, socketPath, attemptId, process.execPath, '-e', providerCode];

  const child = spawn('/bin/sh', args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'pipe', 'pipe'],
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

  return { child, directory, socketPath, helperPidPath, get stdout() { return stdout; }, get stderr() { return stderr; } };
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

function groupExists(pgid) {
  try {
    process.kill(-pgid, 0);

    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;

    throw error;
  }
}

async function waitForGroupGone(pgid, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!groupExists(pgid)) return true;
    await delay(20);
  }

  return !groupExists(pgid);
}

async function cleanup(run) {
  if (!run) return;
  const { child, directory, socketPath } = run;

  if (groupExists(child.pid)) {
    try {
      if ((await stat(socketPath)).isSocket()) await request(socketPath, { attemptId, nonce, command: 'cancel' });
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ECONNREFUSED') throw error;
    }
  }

  if (!(await waitForGroupGone(child.pid, 750)) && child.exitCode === null && child.signalCode === null) {
    process.kill(-child.pid, 'SIGKILL');
  }

  assert.ok(await waitForGroupGone(child.pid), `test-owned process group ${child.pid} still exists`);

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
