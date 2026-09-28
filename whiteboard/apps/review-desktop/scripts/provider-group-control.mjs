import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:net';
import { chmodSync, closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, writeSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { dirname } from 'node:path';

const MAX_NONCE_BYTES = 66;
const MAX_REQUEST_BYTES = 4096;
const MAX_SOCKET_PATH_BYTES = process.platform === 'darwin' ? 103 : 107;
const DEFAULT_GRACE_MS = 5000;

function fail(message) {
  diagnostic(message);
  process.exitCode = 1;
}

function diagnostic(message) {
  try {
    writeSync(2, `provider-group-control: ${message}\n`);
  } catch (error) {
    if (error.code !== 'EPIPE' && error.code !== 'EBADF') process.exitCode = 1;
  }
}

function parseArguments(argv) {
  if (argv.length < 4) throw new Error('expected socket path, attempt id, process group id, executable, and optional arguments');
  const [socketPath, attemptId, pgidText, executable, ...args] = argv;
  if (!socketPath.startsWith('/') || Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) throw new Error('invalid socket path');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(attemptId)) throw new Error('invalid attempt id');
  if (!/^[1-9][0-9]*$/.test(pgidText)) throw new Error('invalid process group id');
  if (!Number.isSafeInteger(Number(pgidText))) throw new Error('invalid process group id');
  if (!executable || executable.includes('\0')) throw new Error('invalid provider executable');
  return { socketPath, attemptId, pgid: Number(pgidText), executable, args };
}

function readNonceFromFd5() {
  const fd = 5;
  let bytes = Buffer.alloc(0);
  const chunk = Buffer.alloc(128);
  try {
    while (bytes.length <= MAX_NONCE_BYTES) {
      let count;
      try {
        count = readSync(fd, chunk, 0, Math.min(chunk.length, MAX_NONCE_BYTES + 1 - bytes.length), null);
      } catch (error) {
        if (error.code === 'EINTR') continue;
        throw error;
      }
      if (count === 0) break;
      bytes = Buffer.concat([bytes, chunk.subarray(0, count)]);
      if (bytes.includes(0x0a)) break;
    }
  } finally {
    try { closeSync(fd); } catch (error) { if (error.code !== 'EBADF') throw error; }
  }
  const lineEnd = bytes.indexOf(0x0a);
  if (lineEnd < 0 || lineEnd !== bytes.length - 1) throw new Error('invalid nonce input');
  const nonce = bytes.subarray(0, lineEnd).toString('ascii');
  if (!/^[a-f0-9]{64}$/.test(nonce)) throw new Error('invalid nonce input');
  return nonce;
}

function validatePrivateDirectory(socketPath) {
  const parent = dirname(socketPath);
  const fd = openSync(parent, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(fd);
    if (info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) throw new Error('socket directory must be owned by the current user with mode 0700');
  } finally { closeSync(fd); }
}

function sendProviderExitCode(code) {
  if (!Number.isInteger(code)) return;
  const payload = Buffer.from(`${code}\n`, 'ascii');
  try {
    const fdInfo = fstatSync(4);
    if (!fdInfo.isFIFO() && !fdInfo.isSocket()) return;
    writeSync(4, payload);
  } catch (error) {
    if (error.code !== 'EPIPE' && error.code !== 'EBADF') diagnostic(`could not write provider exit status (${error.code ?? 'error'})`);
  }
}

function closeUnusedDescriptor(fd) {
  try { closeSync(fd); } catch (error) { if (error.code !== 'EBADF') throw error; }
}

function verifyOwnProcessGroup(pgid) {
  const output = execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)], {
    encoding: 'utf8',
    timeout: 1000,
    maxBuffer: 128,
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim();
  if (!/^[1-9][0-9]*$/.test(output) || Number(output) !== pgid) {
    throw new Error('process group identity does not match the launch group');
  }
}

async function main() {
  const config = parseArguments(process.argv.slice(2));
  const nonce = readNonceFromFd5();
  verifyOwnProcessGroup(config.pgid);
  validatePrivateDirectory(config.socketPath);
  closeUnusedDescriptor(3);

  try {
    lstatSync(config.socketPath);
    throw new Error('socket path already exists');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  let cancelStarted = false;
  let provider;
  let listeningServer;
  const graceEnv = Number(process.env.BFX_PROVIDER_CONTROL_GRACE_MS ?? DEFAULT_GRACE_MS);
  const graceMs = Number.isFinite(graceEnv) ? Math.max(100, Math.min(30000, Math.trunc(graceEnv))) : DEFAULT_GRACE_MS;

  const beginCancellation = () => {
    if (cancelStarted) return;
    cancelStarted = true;
    try {
      process.kill(-config.pgid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') diagnostic(`SIGTERM failed (${error.code ?? 'error'})`);
    }
    setTimeout(() => {
      try {
        process.kill(-config.pgid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') diagnostic(`SIGKILL failed (${error.code ?? 'error'})`);
      }
    }, graceMs).unref();
  };
  process.on('SIGTERM', beginCancellation);
  process.on('SIGINT', beginCancellation);

  listeningServer = createServer(socket => {
    let input = Buffer.alloc(0);
    let handled = false;
    socket.on('error', error => {
      handled = true;
      socket.destroy();
      if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE') diagnostic(`control client socket failed (${error.code ?? 'error'})`);
    });
    socket.setTimeout(1500, () => socket.destroy());
    socket.on('data', chunk => {
      if (handled) return;
      input = Buffer.concat([input, chunk]);
      if (input.length > MAX_REQUEST_BYTES) {
        handled = true;
        socket.setTimeout(0);
        socket.end('rejected\n');
        return;
      }
      const newline = input.indexOf(0x0a);
      if (newline < 0) return;
      handled = true;
      socket.setTimeout(0);
      if (newline !== input.length - 1) {
        socket.end('rejected\n');
        return;
      }
      let request;
      try { request = JSON.parse(input.subarray(0, newline).toString('utf8')); } catch {
        socket.end('rejected\n');
        return;
      }
      const requestNonce = typeof request?.nonce === 'string' ? Buffer.from(request.nonce, 'ascii') : Buffer.alloc(0);
      const expectedNonce = Buffer.from(nonce, 'ascii');
      const authenticated = request && Object.keys(request).length === 3
        && request.attemptId === config.attemptId
        && request.command === 'cancel'
        && requestNonce.length === expectedNonce.length
        && timingSafeEqual(requestNonce, expectedNonce);
      if (!authenticated) {
        socket.end('rejected\n');
        return;
      }
      socket.end('accepted\n', () => setImmediate(beginCancellation));
    });
  });
  listeningServer.on('error', error => {
    diagnostic(`control listener failed (${error.code ?? 'error'})`);
    beginCancellation();
  });

  await new Promise((resolve, reject) => {
    listeningServer.once('error', reject);
    listeningServer.listen(config.socketPath, resolve);
  });
  try {
    chmodSync(config.socketPath, 0o600);
    provider = spawn(config.executable, config.args, {
      stdio: ['inherit', 'inherit', 'inherit', 'ignore', 'ignore', 'ignore'],
      env: process.env
    });
  } catch (error) {
    beginCancellation();
    throw error;
  }
  provider.once('error', error => {
    diagnostic(`provider spawn failed (${error.code ?? 'error'})`);
    sendProviderExitCode(127);
  });
  provider.once('exit', code => sendProviderExitCode(code ?? 1));
}

main().catch(error => fail(error.message));
