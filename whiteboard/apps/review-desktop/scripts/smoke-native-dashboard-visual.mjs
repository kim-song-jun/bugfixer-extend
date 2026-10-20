/** Exercise the packaged native project dashboard with a service-created fixture. */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, opendir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { chromium } from 'playwright';

const [appArgument, outputArgument] = process.argv.slice(2);

const execFileAsync = promisify(execFile);

assert.ok(appArgument, 'Pass the assembled Whiteboard.app path');

assert.ok(outputArgument, 'Pass the smoke output directory');

const appPath = path.resolve(appArgument);

const output = path.resolve(outputArgument);

await mkdir(output, { recursive: true });

const root = await mkdtemp('/tmp/wb-native-ui-');

const diagnostics = {
  apps: [],
  onboardingCliInspections: [],
  onboardingCliProfilePreflights: [],
  nativeAccessibilityProbe: null,
  console: [],
  consoleRecords: [],
  consoleCorrelations: [],
  extensionScanErrors: [],
  canceledThemeLoads: [],
  teardownCancellations: [],
  readinessMarks: [],
  pageErrors: [],
  failedRequests: [],
  themes: [],
  nativeLifecycleEvents: [],
  rendererClockSamples: [],
  isolatedAppLogs: [],
  processOutput: [],
  startupFailures: [],
  instrumentationDrops: {
    nativeLifecycleEvents: 0,
    rendererClockSamples: 0,
    isolatedAppLogs: 0,
    processOutput: 0,
    processOutputBytes: 0,
    startupFailures: 0,
    extensionScanErrors: 0,
  },
};

const scannerErrorClasses = new Set([
  'AbortError',
  'AggregateError',
  'Canceled',
  'CancellationError',
  'Error',
  'ErrorNoTelemetry',
  'FileOperationError',
  'FileSystemProviderError',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);

const scannerNodeErrorCodes = new Set([
  'EACCES',
  'EAGAIN',
  'EBADF',
  'EBUSY',
  'EEXIST',
  'EFAULT',
  'EIO',
  'EISDIR',
  'ELOOP',
  'EMFILE',
  'ENAMETOOLONG',
  'ENFILE',
  'ENOENT',
  'ENOTDIR',
  'ENOTEMPTY',
  'EPERM',
  'EROFS',
  'ESPIPE',
  'ETXTBSY',
  'EXDEV',
]);

const MAX_NATIVE_DIAGNOSTIC_RECORDS = 2048;

const MAX_CAPTURE_BYTES = 256 * 1024;

const MAX_CAPTURE_CHUNKS = 128;

const MAX_LOG_FILES = 24;

const MAX_LOG_DIRECTORY_ENTRIES = 512;

const MAX_LOG_FILE_BYTES = 64 * 1024;

const MAX_LOG_CAPTURE_BYTES = 512 * 1024;

const MAX_STARTUP_DIAGNOSTIC_RECORDS = 8;

const MAX_STARTUP_RESPONSE_BYTES = 8192;

const MAX_STARTUP_PROCESS_ROWS = 256;

const MAX_STARTUP_TARGETS = 256;

const REDACTED_STARTUP_BODY = '[redacted CDP response body]';

const MAX_STARTUP_SCREENSHOT_BYTES = 8 * 1024 * 1024;

const LOG_FILE_NAMES = /^(?:main|renderer(?:\d+)?|sharedprocess|ptyhost|exthost|window)\.log$/;

function appendBoundedRecord(destination, record, dropKey) {
  if (destination.length >= MAX_NATIVE_DIAGNOSTIC_RECORDS) {
    diagnostics.instrumentationDrops[dropKey]++;

    return;
  }

  destination.push(record);
}

function createTimedTextCapture() {
  const chunks = [];
  let retainedBytes = 0;
  let observedBytes = 0;

  return {
    append(chunk) {
      const buffer = Buffer.from(chunk);
      const timestampEpochMilliseconds = Date.now();
      observedBytes += buffer.length;

      if (buffer.length >= MAX_CAPTURE_BYTES) {
        const removedBytes = retainedBytes + buffer.length - MAX_CAPTURE_BYTES;

        diagnostics.instrumentationDrops.processOutputBytes += Math.max(0, removedBytes);
        chunks.length = 0;
        chunks.push({ timestampEpochMilliseconds, buffer: Buffer.from(buffer.subarray(buffer.length - MAX_CAPTURE_BYTES)) });
        retainedBytes = MAX_CAPTURE_BYTES;

        return;
      }

      chunks.push({ timestampEpochMilliseconds, buffer });
      retainedBytes += buffer.length;

      while (retainedBytes > MAX_CAPTURE_BYTES || chunks.length > MAX_CAPTURE_CHUNKS) {
        const removed = chunks.shift();

        retainedBytes -= removed.buffer.length;
        diagnostics.instrumentationDrops.processOutputBytes += removed.buffer.length;
      }

    },
    snapshot(pid, stream) {
      appendBoundedRecord(diagnostics.processOutput, {
        pid,
        stream,
        observedBytes,
        retainedBytes,
        truncatedBytes: Math.max(0, observedBytes - retainedBytes),
        truncated: observedBytes > retainedBytes,
        chunks: chunks.map(({ timestampEpochMilliseconds, buffer }) => ({ timestampEpochMilliseconds, text: buffer.toString('utf8') })),
      }, 'processOutput');
    },
    text() {
      return Buffer.concat(chunks.map(({ buffer }) => buffer)).toString('utf8');
    },
    observedBytes() {
      return observedBytes;
    },
    retainedBytes() {
      return retainedBytes;
    },
  };
}

async function awaitDiagnosticOperation(operation, timeoutMs) {
  let timeout;

  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error('Diagnostic operation timed out');
          error.name = 'DiagnosticTimeoutError';
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeStartupText(value) {
  return String(value)
    .replace(/(authorization|token|secret|password|nonce|api[-_]?key)(["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1$2[redacted]')
    .replace(/(?:\/Users\/|\/private\/var\/folders\/|\/tmp\/)[^\s"'<>]*/g, '[local-path]')
    .slice(0, MAX_STARTUP_RESPONSE_BYTES);
}

function sanitizeStartupEndpointBody(endpoint, body, port) {
  let parsed;

  try { parsed = JSON.parse(body); }
  catch { return { body: REDACTED_STARTUP_BODY, valid: false, reason: 'invalid-json' }; }

  try {

    if (endpoint === '/json/version') {
      const version = parseStartupVersion(parsed, port);
      const result = {};

      for (const [key, value] of Object.entries(version.fields)) {
        result[key] = sanitizeStartupText(value).slice(0, 512);
      }

      result.webSocketDebuggerUrl = `ws://127.0.0.1:${port}/devtools/browser/[redacted]`;

      return { body: JSON.stringify(result), valid: true };
    }

    if (endpoint === '/json/list') {
      const targets = parseStartupTargets(parsed, port);

      return {
        body: JSON.stringify({
          targetCount: targets.length,
          targets: targets.slice(0, 32).map(target => ({
            type: target.type.slice(0, 64),
            title: sanitizeStartupText(target.title).slice(0, 256),
            url: sanitizeStartupTargetUrl(target.url),
            hasWebSocketDebuggerUrl: true,
          })),
          truncated: targets.length > 32,
        }),
        valid: true,
      };
    }
  } catch {
    return { body: REDACTED_STARTUP_BODY, valid: false, reason: 'schema-mismatch' };
  }

  return { body: REDACTED_STARTUP_BODY, valid: false, reason: 'unsupported-endpoint' };
}

function parseStartupVersion(value, port) {
  const record = parseStartupRecord(value);
  const fields = {};

  for (const key of ['Browser', 'Protocol-Version']) {
    assert.ok(Object.hasOwn(record, key), `CDP version response is missing ${key}`);
    fields[key] = parseStartupString(record[key], 512, 1);
  }

  for (const key of ['User-Agent', 'V8-Version', 'WebKit-Version']) {
    if (Object.hasOwn(record, key)) fields[key] = parseStartupString(record[key], 512, 0);
  }

  assert.ok(Object.hasOwn(record, 'webSocketDebuggerUrl'), 'CDP version response is missing its browser WebSocket URL');
  const webSocketDebuggerUrl = parseStartupString(record.webSocketDebuggerUrl, 2048, 1);

  parseStartupWebSocketUrl(webSocketDebuggerUrl, port, 'browser');

  return { fields };
}

function parseStartupTargets(value, port) {
  assert.ok(Array.isArray(value), 'CDP target response must be an array');
  assert.ok(value.length <= MAX_STARTUP_TARGETS, 'CDP target response exceeds its record limit');

  return value.map(target => {
    const record = parseStartupRecord(target);
    const id = parseStartupString(record.id, 256, 1);
    const type = parseStartupString(record.type, 64, 1);
    const title = parseStartupString(record.title, 512, 0);
    const url = parseStartupString(record.url, 4096, 0);
    const webSocketDebuggerUrl = parseStartupString(record.webSocketDebuggerUrl, 2048, 1);

    parseStartupWebSocketUrl(webSocketDebuggerUrl, port, type, id);

    if (Object.hasOwn(record, 'devtoolsFrontendUrl')) {
      parseStartupString(record.devtoolsFrontendUrl, 2048, 0);
    }

    return { id, type, title, url, webSocketDebuggerUrl };
  });
}

function parseStartupRecord(value) {
  assert.ok(value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, 'CDP response must be an object');

  return value;
}

function parseStartupString(value, maxLength, minLength) {
  assert.match(value, /^[\s\S]*$/, 'CDP response fields must be strings');
  assert.ok(value.length >= minLength && value.length <= maxLength, 'CDP response string is outside its length limit');

  return value;
}

function parseStartupWebSocketUrl(value, port, targetKind, targetId) {
  const url = new URL(value);

  assert.equal(url.protocol, 'ws:', 'CDP WebSocket URL must use ws');
  assert.equal(url.hostname, '127.0.0.1', 'CDP WebSocket URL must use the loopback host');
  assert.equal(url.port, String(port), 'CDP WebSocket URL must use the inspected port');
  assert.equal(url.username, '', 'CDP WebSocket URL must not contain credentials');
  assert.equal(url.password, '', 'CDP WebSocket URL must not contain credentials');
  assert.equal(url.search, '', 'CDP WebSocket URL must not contain a query');
  assert.equal(url.hash, '', 'CDP WebSocket URL must not contain a fragment');
  const pathSegments = url.pathname.split('/');

  assert.equal(pathSegments.length, 4, 'CDP WebSocket URL must have a target path');
  assert.equal(pathSegments[1], 'devtools', 'CDP WebSocket URL must have a target path');
  assert.equal(pathSegments[2], targetKind, 'CDP WebSocket URL must match its target type');
  assert.match(pathSegments[3], /^[^/]{1,256}$/, 'CDP WebSocket URL must include a target ID');

  if (targetId !== undefined) assert.equal(pathSegments[3], targetId, 'CDP WebSocket URL must match its target ID');
}

function sanitizeStartupTargetUrl(value) {

  if (value === 'about:blank') return value;

  try {
    const url = new URL(value);

    return `${url.protocol}//${url.host}/[redacted]`;
  } catch {
    return '[invalid-url]';
  }
}

async function readBoundedStartupBody(response) {
  if (!response.body) return { body: '', bytesRead: 0, truncated: false, cancelFailed: false };

  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  let truncated = false;
  let cancelFailed = false;

  try {
    while (byteLength < MAX_STARTUP_RESPONSE_BYTES) {
      const { done, value } = await reader.read();

      if (done) break;
      const remaining = MAX_STARTUP_RESPONSE_BYTES - byteLength;
      const chunk = Buffer.from(value.subarray(0, remaining));
      chunks.push(chunk);
      byteLength += chunk.byteLength;

      if (value.byteLength > remaining) {
        truncated = true;
        break;
      }
    }

    if (byteLength >= MAX_STARTUP_RESPONSE_BYTES) truncated = true;
  } finally {
    try { await reader.cancel(); }
    catch { cancelFailed = true; }
  }

  return { body: Buffer.concat(chunks).toString('utf8'), bytesRead: byteLength, truncated, cancelFailed };
}

async function readStartupEndpoint(port, endpoint) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);

  try {
    const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { signal: controller.signal });
    const body = await readBoundedStartupBody(response);

    const sanitizedBody = body.truncated
      ? { body: REDACTED_STARTUP_BODY, valid: false, reason: 'response-truncated' }
      : sanitizeStartupEndpointBody(endpoint, body.body, port);

    return {
      endpoint,
      status: response.status,
      ok: response.ok,
      body: sanitizedBody.body,
      bodyValid: sanitizedBody.valid,
      bodyBytes: body.bytesRead,
      bodyInvalidReason: sanitizedBody.reason ?? null,
      bodyTruncated: body.truncated,
      bodyCancelFailed: body.cancelFailed,
    };
  } catch {
    return {
      endpoint,
      status: null,
      ok: false,
      body: REDACTED_STARTUP_BODY,
      bodyValid: false,
      bodyBytes: 0,
      bodyInvalidReason: 'request-failed',
      bodyTruncated: false,
      bodyCancelFailed: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readOwnedProcessTree(rootPid) {
  if (!Number.isInteger(rootPid) || rootPid < 1) return { status: 'root-pid-unavailable', processes: [], truncated: false };

  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-Ao', 'pid=,ppid=,pgid=,comm='], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024,
      timeout: 2_000,
    });

    const all = stdout.split('\n').flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);

      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: path.basename(match[4]).slice(0, 96) }] : [];
    });

    const included = new Set([rootPid]);

    let changed = true;

    while (changed && included.size < MAX_STARTUP_PROCESS_ROWS) {
      changed = false;

      for (const item of all) {

        if (included.has(item.pid) || !included.has(item.ppid)) continue;

        included.add(item.pid);
        changed = true;

        if (included.size >= MAX_STARTUP_PROCESS_ROWS) break;
      }
    }

    const processes = all.filter(item => included.has(item.pid)).slice(0, MAX_STARTUP_PROCESS_ROWS);

    return { status: 'captured', processes, truncated: processes.length < included.size || included.size >= MAX_STARTUP_PROCESS_ROWS };
  } catch (error) {
    return {
      status: 'collection-error',
      processes: [],
      truncated: false,
      error: sanitizeStartupText(`${error?.name ?? 'Error'}: ${error?.message ?? 'process query failed'}`).slice(0, 512),
    };
  }
}

async function readStartupLogDirectory(userData) {
  const logsRoot = path.join(userData, 'logs');

  try {
    const directoryStat = await stat(logsRoot);

    if (!directoryStat.isDirectory()) return { status: 'not-directory', matchingFiles: [] };

    const entries = await opendir(logsRoot);
    const matchingFiles = [];

    for await (const entry of entries) {
      if (entry.isFile() && LOG_FILE_NAMES.test(entry.name) && matchingFiles.length < 24) matchingFiles.push(entry.name);
    }

    return { status: 'present', matchingFiles, truncated: matchingFiles.length >= 24 };
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'not-found', matchingFiles: [] };

    return {
      status: 'read-error',
      matchingFiles: [],
      error: sanitizeStartupText(`${error?.name ?? 'Error'}: ${error?.message ?? 'log directory query failed'}`).slice(0, 512),
    };
  }
}

async function captureStartupFailureDiagnostics(port, userData, child, stdout, stderr, owned) {
  const [version, targets, processTree, logs] = await Promise.all([
    readStartupEndpoint(port, '/json/version'),
    readStartupEndpoint(port, '/json/list'),
    readOwnedProcessTree(child.pid),
    readStartupLogDirectory(userData),
  ]);

  appendBoundedRecord(diagnostics.startupFailures, {
    pid: child.pid ?? null,
    port,
    capturedAt: new Date().toISOString(),
    childExit: owned.exit ?? null,
    endpoints: [version, targets],
    processTree,
    logs,
    stdout: { observedBytes: stdout.observedBytes(), retainedBytes: stdout.retainedBytes(), tail: sanitizeStartupText(stdout.text().slice(-2048)) },
    stderr: { observedBytes: stderr.observedBytes(), retainedBytes: stderr.retainedBytes(), tail: sanitizeStartupText(stderr.text().slice(-2048)) },
  }, 'startupFailures');
}

async function captureStartupFailureScreenshot(child) {
  const relativePath = `startup-timeout-${child.pid ?? 'unknown'}.png`;

  if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'darwin') {
    return { relativePath, status: 'skipped', bytes: 0, reason: 'ci-macos-only' };
  }

  if (child.exitCode !== null || child.signalCode !== null) {
    return { relativePath, status: 'skipped', bytes: 0, reason: 'app-exited' };
  }

  const screenshotPath = path.join(output, relativePath);

  try {
    await execFileAsync('/usr/sbin/screencapture', ['-x', '-m', screenshotPath], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024,
      timeout: 2_000,
    });

    const screenshotStat = await stat(screenshotPath);

    if (!screenshotStat.isFile()) {
      return { relativePath, status: 'failed', bytes: 0, reason: 'capture-output-missing' };
    }

    if (screenshotStat.size > MAX_STARTUP_SCREENSHOT_BYTES) {
      await rm(screenshotPath, { force: true });

      return { relativePath, status: 'discarded', bytes: 0, reason: 'size-limit-exceeded' };
    }

    return { relativePath, status: 'captured', bytes: screenshotStat.size, reason: null };
  } catch {
    try { await rm(screenshotPath, { force: true }); }
    catch { return { relativePath, status: 'failed', bytes: 0, reason: 'capture-cleanup-failed' }; }

    return { relativePath, status: 'failed', bytes: 0, reason: 'capture-failed' };
  }
}

function recordNativeLifecycle(capture, event, details = {}) {
  appendBoundedRecord(diagnostics.nativeLifecycleEvents, {
    pid: capture.pid,
    targetIndex: capture.targetIndex,
    targetId: capture.targetId ?? null,
    frameId: details.frameId ?? null,
    parentFrameId: details.parentFrameId ?? null,
    isTopFrame: details.isTopFrame ?? null,
    event,
    hostEpochMilliseconds: Date.now(),
    hostMonotonicNanoseconds: process.hrtime.bigint().toString(),
    ...details,
  }, 'nativeLifecycleEvents');
}

async function captureIsolatedAppLogs(userData, pid) {
  const logsRoot = path.join(userData, 'logs');
  const candidates = [];
  let totalBytes = 0;
  let logsDirectoryMissing = false;
  let inspectedEntries = 0;

  async function collect(directory, depth) {
    if (depth > 2 || candidates.length >= MAX_LOG_FILES) return;

    let handle;

    try { handle = await opendir(directory); }
    catch (error) {
      if (error.code === 'ENOENT' && directory === logsRoot) logsDirectoryMissing = true;

      if (error.code !== 'ENOENT') appendBoundedRecord(diagnostics.isolatedAppLogs, { pid, relativePath: path.relative(userData, directory), status: 'directory-read-error', errorCode: error.code ?? 'unknown' }, 'isolatedAppLogs');

      return;
    }

    for await (const entry of handle) {

      if (candidates.length >= MAX_LOG_FILES || inspectedEntries >= MAX_LOG_DIRECTORY_ENTRIES) {
        diagnostics.instrumentationDrops.isolatedAppLogs++;

        break;
      }

      inspectedEntries++;

      const candidate = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await collect(candidate, depth + 1);
      } else if (entry.isFile() && LOG_FILE_NAMES.test(entry.name)) {
        candidates.push(candidate);
      }

    }
  }

  await collect(logsRoot, 0);

  if (logsDirectoryMissing) appendBoundedRecord(diagnostics.isolatedAppLogs, { pid, relativePath: 'logs', status: 'directory-not-found' }, 'isolatedAppLogs');

  candidates.sort();

  for (const candidate of candidates) {

    if (totalBytes >= MAX_LOG_CAPTURE_BYTES) {
      diagnostics.instrumentationDrops.isolatedAppLogs++;

      continue;
    }

    const relativePath = path.relative(userData, candidate);

    try {
      const fileStat = await stat(candidate);

      if (!fileStat.isFile()) continue;

      const bytesToRead = Math.min(fileStat.size, MAX_LOG_FILE_BYTES, MAX_LOG_CAPTURE_BYTES - totalBytes);
      const start = Math.max(0, fileStat.size - bytesToRead);
      const handle = await open(candidate, 'r');
      const buffer = Buffer.alloc(bytesToRead);

      let bytesRead;

      try { ({ bytesRead } = await handle.read(buffer, 0, bytesToRead, start)); }
      finally { await handle.close(); }

      totalBytes += bytesRead;

      appendBoundedRecord(diagnostics.isolatedAppLogs, {
        pid,
        relativePath,
        fileSizeBytes: fileStat.size,
        capturedBytes: bytesRead,
        truncatedBytes: Math.max(0, fileStat.size - bytesRead),
        readStartByte: start,
        truncated: start > 0 || bytesRead < fileStat.size,
        text: buffer.subarray(0, bytesRead).toString('utf8'),
      }, 'isolatedAppLogs');
    } catch (error) {
      appendBoundedRecord(diagnostics.isolatedAppLogs, { pid, relativePath, status: 'file-read-error', errorCode: error.code ?? 'unknown' }, 'isolatedAppLogs');
    }
  }
}

async function sampleRendererClock(capture, phase) {
  const hostBefore = { epochMilliseconds: Date.now(), monotonicNanoseconds: process.hrtime.bigint().toString() };

  try {
    const response = await awaitDiagnosticOperation(capture.cdp.send('Runtime.evaluate', {
      expression: '({ dateNow: Date.now(), performanceTimeOrigin: performance.timeOrigin, performanceNow: performance.now() })',
      returnByValue: true,
    }), 2_000);

    const hostAfter = { epochMilliseconds: Date.now(), monotonicNanoseconds: process.hrtime.bigint().toString() };
    appendBoundedRecord(diagnostics.rendererClockSamples, {
      pid: capture.pid,
      targetIndex: capture.targetIndex,
      targetId: capture.targetId ?? null,
      phase,
      hostBefore,
      hostAfter,
      renderer: response.result?.value ?? null,
      exception: response.exceptionDetails ? {
        text: response.exceptionDetails.text?.slice(0, 256) ?? 'renderer evaluation exception',
        exceptionClass: response.exceptionDetails.exception?.className?.slice(0, 128) ?? null,
      } : null,
    }, 'rendererClockSamples');
  } catch (error) {
    const hostAfter = { epochMilliseconds: Date.now(), monotonicNanoseconds: process.hrtime.bigint().toString() };
    appendBoundedRecord(diagnostics.rendererClockSamples, {
      pid: capture.pid,
      targetIndex: capture.targetIndex,
      targetId: capture.targetId ?? null,
      phase,
      hostBefore,
      hostAfter,
      renderer: null,
      instrumentationError: error?.name?.slice(0, 128) ?? 'Error',
    }, 'rendererClockSamples');
  }
}

class FatalWaitError extends Error {}

function renderCDPConsoleArgument(argument) {
  if (argument.type === 'undefined') return 'undefined';

  if (Object.hasOwn(argument, 'value')) return String(argument.value);

  if (argument.unserializableValue) return String(argument.unserializableValue);

  if (argument.description === 'Object' && argument.preview) {
    return `{${argument.preview.properties.map(({ name, value }) => `${name}: ${value}`).join(', ')}}`;
  }

  if (argument.subtype === 'array' && argument.preview) return undefined;

  return argument.description;
}

function normalizeExtensionScanErrorMessage(message) {
  if (!/^(?:%c\s+ERR(?:\s+color:\s*#f33)?\s+|ERR\s+)?Error scanning (?:system|user) extensions:(?:\s|$)/.test(message)) {
    return message;
  }

  return message.split(/\r?\n/, 1)[0];
}

function extensionScanErrorDiagnostic(args) {
  const labelArgument = args.find(argument => argument.type === 'string'
    && (argument.value === 'Error scanning system extensions:' || argument.value === 'Error scanning user extensions:'));

  if (!labelArgument) return undefined;

  const errorArgument = args.find(argument => argument.subtype === 'error');
  const description = errorArgument?.description?.slice(0, 8_192) ?? '';
  const descriptionLines = description.split(/\r?\n/);
  const descriptionClass = descriptionLines[0]?.match(/^([A-Za-z_$][A-Za-z0-9_$.-]{0,63})(?::|$)/)?.[1];
  const previewProperties = errorArgument?.preview?.properties ?? [];
  const previewName = previewProperties.find(property => property.name === 'name');
  const previewCode = previewProperties.find(property => property.name === 'code');
  const candidateClass = previewName?.type === 'string' ? previewName.value : descriptionClass;
  const errorClass = scannerErrorClasses.has(candidateClass) ? candidateClass : 'unavailable';
  const candidateCode = previewCode?.type === 'string' ? previewCode.value : undefined;
  const code = scannerNodeErrorCodes.has(candidateCode) ? candidateCode : null;
  const stackFrames = [];

  for (const line of descriptionLines.slice(1)) {
    const trimmed = line.trim();

    if (!trimmed.startsWith('at ')) continue;

    const location = trimmed.slice(3);
    const suffix = location.match(/:(\d+):(\d+)\)?$/);

    if (!suffix) continue;

    const withoutPosition = location.slice(0, -suffix[0].length);
    const openParenthesis = withoutPosition.lastIndexOf('(');
    const rawPath = openParenthesis >= 0 ? withoutPosition.slice(openParenthesis + 1) : withoutPosition;
    const basename = rawPath.split(/[\\/]/).pop() ?? '';
    const safeBasename = /^[A-Za-z0-9_.-]{1,120}$/.test(basename) ? basename : 'redacted';

    stackFrames.push({ file: safeBasename, line: Number(suffix[1]), column: Number(suffix[2]) });

    if (stackFrames.length === 5) break;
  }

  return {
    scanKind: labelArgument.value === 'Error scanning system extensions:' ? 'system' : 'user',
    remoteType: errorArgument?.type ?? 'unavailable',
    remoteSubtype: errorArgument?.subtype ?? 'unavailable',
    errorClass,
    code,
    codeUnavailable: code === null,
    stackFrames,
  };
}

function isCanceledExtensionScan(entry) {
  return /\(Canceled: Canceled\)/.test(entry)
    && (/Error scanning user extensions:/.test(entry)
      || /Contents\/Resources\/app\/extensions\/[^/]+\/package\.json/.test(entry));
}

function isCanceledThemeLoad(entry) {
  return /review-(?:light|dark)\.json/.test(entry) && /\(Canceled: Canceled\)/.test(entry);
}

function finalizeConsoleCaptures(captures, owned, cleanOwnedShutdown) {
  const pageErrorsByText = new Map();
  const cdpErrorsByText = new Map();
  const pageEvents = captures.flatMap(capture => capture.pageConsoleErrors);
  const cdpEvents = captures.flatMap(capture => capture.cdpConsoleErrors);

  for (const event of pageEvents) {
    const key = JSON.stringify([event.pid, event.renderedMessage]);

    if (!pageErrorsByText.has(key)) pageErrorsByText.set(key, []);

    pageErrorsByText.get(key).push(event);
  }

  for (const event of cdpEvents) {
    if (event.renderedMessage === null) continue;

    const key = JSON.stringify([event.pid, event.renderedMessage]);

    if (!cdpErrorsByText.has(key)) cdpErrorsByText.set(key, []);

    cdpErrorsByText.get(key).push(event);
  }

  const correlatedCDPEvents = new Set();

  for (const [key, matchingPageEvents] of pageErrorsByText) {
    const [pid, renderedMessage] = JSON.parse(key);

    const matchingCDPEvents = cdpErrorsByText.get(key) ?? [];

    const isOneToOne = matchingPageEvents.length === 1 && matchingCDPEvents.length === 1
      && matchingPageEvents[0].targetIndex === matchingCDPEvents[0].targetIndex;

    if (!isOneToOne) {
      for (const event of matchingPageEvents) {
        if (isCanceledThemeLoad(event.entry)) diagnostics.canceledThemeLoads.push(event);

        else diagnostics.console.push(event.entry);
      }

      diagnostics.consoleCorrelations.push({
        pid,
        renderedMessage,
        status: matchingCDPEvents.length ? 'ambiguous-counts-or-targets' : 'no-exact-cdp-match',
        pageRecordIds: matchingPageEvents.map(event => event.recordId),
        pageTargetIndexes: matchingPageEvents.map(event => event.targetIndex),
        cdpRecordIds: matchingCDPEvents.map(event => event.recordId),
        cdpTargetIndexes: matchingCDPEvents.map(event => event.targetIndex),
      });
      continue;
    }

    const pageEvent = matchingPageEvents[0];

    const cdpEvent = matchingCDPEvents[0];
    correlatedCDPEvents.add(cdpEvent);
    const isCanceledCandidate = isCanceledExtensionScan(pageEvent.entry);

    const originatedDuringShutdown = Number.isFinite(cdpEvent.originTimestampEpochMilliseconds)
      && Number.isFinite(owned.shutdownStartEpochMilliseconds)
      && cdpEvent.originTimestampEpochMilliseconds >= owned.shutdownStartEpochMilliseconds;

    const isTeardownCancellation = isCanceledCandidate && originatedDuringShutdown && cleanOwnedShutdown;

    diagnostics.consoleCorrelations.push({
      pid,
      targetIndex: pageEvent.targetIndex,
      renderedMessage,
      pageRecordId: pageEvent.recordId,
      cdpRecordId: cdpEvent.recordId,
      cdpOriginTimestampEpochMilliseconds: cdpEvent.originTimestampEpochMilliseconds,
      shutdownStartEpochMilliseconds: owned.shutdownStartEpochMilliseconds ?? null,
      cleanOwnedShutdown,
      decision: isCanceledThemeLoad(pageEvent.entry)
        ? 'known-theme-cancellation'
        : isTeardownCancellation ? 'teardown-cancellation' : 'fatal-console-error',
      status: 'exact-one-to-one',
    });

    if (isCanceledThemeLoad(pageEvent.entry)) {
      diagnostics.canceledThemeLoads.push(pageEvent);

    } else if (isTeardownCancellation) {
      diagnostics.teardownCancellations.push({
        ...pageEvent,
        cdpRecordId: cdpEvent.recordId,
        cdpOriginTimestampEpochMilliseconds: cdpEvent.originTimestampEpochMilliseconds,
        shutdownStartedAt: owned.shutdownStartedAt,
        termSentAt: owned.termSentAt ?? null,
        exitObservedAt: owned.exitObservedAt,
        exit: owned.exit,
        portClosedAt: owned.portClosedAt,
      });
    } else {
      diagnostics.console.push(pageEvent.entry);
    }
  }

  for (const event of cdpEvents) {
    if (correlatedCDPEvents.has(event)) continue;

    diagnostics.console.push(event.entry);
    diagnostics.consoleCorrelations.push({
      pid: event.pid,
      targetIndex: event.targetIndex,
      renderedMessage: event.renderedMessage,
      cdpRecordId: event.recordId,
      cdpOriginTimestampEpochMilliseconds: event.originTimestampEpochMilliseconds,
      status: event.renderedMessage === null ? 'unrenderable-cdp-message' : 'unmatched-cdp-error',
    });
  }

  diagnostics.consoleRecords.push(
    ...pageEvents.map(event => ({ source: 'playwright-console', ...event })),
    ...cdpEvents.map(event => ({ source: 'cdp-runtime', ...event })),
  );
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));

  return port;
}

async function waitFor(check, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;

  let lastError;

  while (Date.now() < deadline) {
    try {
      const value = await check();

      if (value) return value;
    } catch (error) {
      if (error instanceof FatalWaitError) throw error;

      lastError = error;
    }

    await new Promise(resolve => setTimeout(resolve, 200));
  }

  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

async function startPackaged({ executable, userData, extensions, reviewHome, descriptor }) {
  await assertAnonymousCliProfilesAbsent('before-packaged-app-launch');

  const port = await reservePort();

  const args = [
    '--disable-telemetry', '--skip-welcome', '--log', 'trace',
    `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`,
    `--remote-debugging-port=${port}`,
    ...(descriptor ? [descriptor] : []),
  ];

  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', DEV_REVIEW_HOME: reviewHome, DEV_REVIEW_IMPORT_FROM: 'none', ELECTRON_ENABLE_LOGGING: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VSCODE_DEV;
  delete env.VSCODE_CLI;
  const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });

  let spawnError;
  child.once('error', error => { spawnError = error; });
  const owned = { pid: child.pid, ppid: process.pid, command: executable, args, port, userData, startedAt: new Date().toISOString(), consoleCaptureBoundaries: [] };
  diagnostics.apps.push(owned);
  const stdout = createTimedTextCapture();
  const stderr = createTimedTextCapture();
  child.stdout.on('data', chunk => stdout.append(chunk));
  child.stderr.on('data', chunk => stderr.append(chunk));

  const exited = new Promise(resolve => child.once('close', (code, signal) => {
    owned.exitObservedAt = new Date().toISOString();
    owned.exit = { code, signal };
    resolve(owned.exit);
  }));

  let browser;

  try {
    const target = await waitFor(async () => {

      if (spawnError) throw new FatalWaitError(`Packaged app failed to start: ${spawnError.message}`);

      if (child.exitCode !== null || child.signalCode !== null) {
        throw new FatalWaitError(`Packaged app exited before startup completed: ${JSON.stringify({ code: child.exitCode, signal: child.signalCode })}\n${stderr.text().slice(-4000)}`);
      }

      const response = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => undefined);

      if (!response?.ok) return undefined;

      const targets = await response.json();

      return targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
    }, 'a native app CDP page', 90_000);

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);

    const watchedPages = new WeakMap();
    const consoleCaptures = [];

    const watchPage = page => {

      if (watchedPages.has(page)) return watchedPages.get(page);

      const capture = {
        targetIndex: consoleCaptures.length,
        targetId: consoleCaptures.length === 0 ? target.id : null,
        pid: child.pid,
        pageConsoleErrors: [],
        cdpConsoleErrors: [],
        cdpListeners: [],
        contextFrames: new Map(),
        frameParents: new Map(),
      };

      consoleCaptures.push(capture);

      const capturePromise = (async () => {
        capture.cdp = await page.context().newCDPSession(page);

        const listen = (name, listener) => {
          capture.cdp.on(name, listener);
          capture.cdpListeners.push([name, listener]);
        };

        listen('Runtime.consoleAPICalled', event => {
          if (event.type !== 'error') return;

          const previews = event.args.map(renderCDPConsoleArgument);
          const renderedMessage = previews.every(value => value !== undefined)
            ? normalizeExtensionScanErrorMessage(previews.join(' '))
            : null;
          const message = renderedMessage ?? normalizeExtensionScanErrorMessage(
            event.args.map(arg => arg.description ?? String(arg.value ?? '')).join(' '),
          );
          const entry = `PID ${child.pid}: ${message}`;
          const scanError = extensionScanErrorDiagnostic(event.args);

          if (scanError) {
            if (diagnostics.extensionScanErrors.length < 32) {
              diagnostics.extensionScanErrors.push({
                pid: child.pid,
                scanKind: scanError.scanKind,
                recordId: capture.cdpConsoleErrors.length,
                originTimestampEpochMilliseconds: event.timestamp ?? null,
                targetIndex: capture.targetIndex,
                remoteType: scanError.remoteType,
                remoteSubtype: scanError.remoteSubtype,
                errorClass: scanError.errorClass,
                code: scanError.code,
                codeUnavailable: scanError.codeUnavailable,
                stackFrames: scanError.stackFrames,
              });
            } else {
              diagnostics.instrumentationDrops.extensionScanErrors++;
            }
          }

          capture.cdpConsoleErrors.push({
            recordId: capture.cdpConsoleErrors.length,
            pid: child.pid,
            entry,
            renderedMessage,
            originTimestampEpochMilliseconds: event.timestamp ?? null,
            originClock: 'CDP Runtime.Timestamp epoch milliseconds',
            observedHostEpochMilliseconds: Date.now(),
            observedHostMonotonicNanoseconds: process.hrtime.bigint().toString(),
            targetIndex: capture.targetIndex,
          });
        });
        listen('Runtime.executionContextsCleared', () => {
          capture.contextFrames.clear();
          recordNativeLifecycle(capture, 'execution-contexts-cleared', { effect: 'renderer-context-reset' });
        });
        listen('Runtime.executionContextCreated', event => {
          const auxData = event.context?.auxData ?? {};
          const frameId = auxData.frameId ?? null;

          if (frameId && capture.contextFrames.size < 256) capture.contextFrames.set(event.context.id, frameId);

          recordNativeLifecycle(capture, 'execution-context-created', {
            executionContextId: event.context?.id ?? null,
            contextType: event.context?.type ?? null,
            frameId,
            isDefaultContext: auxData.isDefault ?? null,
            isTopFrame: frameId && capture.frameParents.has(frameId) ? capture.frameParents.get(frameId) === null : null,
          });
        });
        listen('Runtime.executionContextDestroyed', event => {
          recordNativeLifecycle(capture, 'execution-context-destroyed', {
            executionContextId: event.executionContextId ?? null,
            frameId: capture.contextFrames.get(event.executionContextId) ?? null,
          });
          capture.contextFrames.delete(event.executionContextId);
        });
        listen('Page.frameNavigated', event => {
          const frameId = event.frame?.id ?? null;
          const parentFrameId = event.frame?.parentId ?? null;

          if (frameId && capture.frameParents.size < 256) capture.frameParents.set(frameId, parentFrameId);

          recordNativeLifecycle(capture, 'cdp-frame-navigated', {
            frameId,
            parentFrameId,
            loaderId: event.frame?.loaderId ?? null,
            isTopFrame: !parentFrameId,
          });
        });
        listen('Page.frameDetached', event => {
          capture.frameParents.delete(event.frameId);
          recordNativeLifecycle(capture, 'cdp-frame-detached', {
            frameId: event.frameId ?? null,
            reason: event.reason?.slice(0, 128) ?? null,
          });
        });
        listen('Inspector.detached', event => recordNativeLifecycle(capture, 'inspector-detached', { reason: event.reason?.slice(0, 128) ?? null }));

        try {
          await awaitDiagnosticOperation(capture.cdp.send('Page.enable'), 2_000);
          const { frameTree } = await awaitDiagnosticOperation(capture.cdp.send('Page.getFrameTree'), 2_000);
          let remainingFrames = 256;
          let frameTreeTruncated = false;

          const recordFrameTree = (node, parentFrameId = null) => {

            if (!node?.frame) return;

            if (remainingFrames <= 0) {
              frameTreeTruncated = true;

              return;
            }

            remainingFrames--;
            const frameId = node.frame.id;
            const actualParentId = node.frame.parentId ?? parentFrameId;

            if (frameId) capture.frameParents.set(frameId, actualParentId);

            recordNativeLifecycle(capture, 'initial-frame-tree', {
              frameId: frameId ?? null,
              parentFrameId: actualParentId,
              loaderId: node.frame.loaderId ?? null,
              isTopFrame: !actualParentId,
            });

            for (const child of node.childFrames ?? []) recordFrameTree(child, frameId ?? null);
          };

          recordFrameTree(frameTree);

          if (frameTreeTruncated) diagnostics.instrumentationDrops.nativeLifecycleEvents++;
        } catch (error) {
          recordNativeLifecycle(capture, 'page-lifecycle-instrumentation-failed', { errorName: error?.name?.slice(0, 128) ?? 'Error' });
        }

        await capture.cdp.send('Runtime.enable');
        await sampleRendererClock(capture, 'attached-after-runtime-enable');
      })();

      watchedPages.set(page, capturePromise);
      page.on('console', message => {
        if (message.type() !== 'error') return;

        const renderedMessage = normalizeExtensionScanErrorMessage(message.text());
        const entry = `PID ${child.pid}: ${renderedMessage}`;
        capture.pageConsoleErrors.push({
          recordId: capture.pageConsoleErrors.length,
          pid: child.pid,
          entry,
          renderedMessage,
          observedHostEpochMilliseconds: Date.now(),
          observedHostMonotonicNanoseconds: process.hrtime.bigint().toString(),
          targetIndex: capture.targetIndex,
          worker: Boolean(message.worker()),
        });
      });
      page.on('framenavigated', frame => {
        const parent = frame.parentFrame();
        recordNativeLifecycle(capture, 'page-frame-navigated', {
          frameId: null,
          parentFrameId: null,
          isTopFrame: !parent,
          urlScheme: (() => { try { return new URL(frame.url()).protocol; } catch { return 'unknown:'; } })(),
        });
      });
      page.on('close', () => recordNativeLifecycle(capture, 'page-close'));
      page.on('pageerror', error => diagnostics.pageErrors.push(error.stack ?? error.message));
      page.on('requestfailed', request => {
        const failure = request.failure()?.errorText ?? 'unknown';

        if (failure !== 'net::ERR_ABORTED') diagnostics.failedRequests.push(`${request.url()} — ${failure}`);
      });

      return capturePromise;
    };

    browser.on('disconnected', () => {
      for (const capture of consoleCaptures) recordNativeLifecycle(capture, 'browser-disconnected');
    });

    for (const context of browser.contexts()) {
      context.on('page', page => {
        void watchPage(page).catch(error => diagnostics.pageErrors.push(`Unable to capture renderer console origin timestamps: ${error.stack ?? error.message}`));
      });

      for (const page of context.pages()) await watchPage(page);
    }

    const selector = descriptor ? '.project-dashboard #project-dashboard-title' : '.project-home__intro h1';

    const page = await waitFor(async () => {
      for (const candidate of browser.contexts().flatMap(context => context.pages())) {
        if (candidate.url() === 'about:blank') continue;

        if (await candidate.locator(selector).isVisible()) return candidate;
      }

      return undefined;
    }, `the packaged renderer with ${selector}`, 90_000);

    await watchPage(page);

    return { child, exited, browser, page, port, targetId: target.id, stdout, stderr, owned, consoleCaptures };
  } catch (error) {
    const cleanupFailures = [];
    const startupScreenshot = await captureStartupFailureScreenshot(child);

    appendBoundedRecord(diagnostics.startupFailures, {
      pid: child.pid ?? null,
      port,
      capturedAt: new Date().toISOString(),
      status: 'startup-screenshot',
      screenshot: startupScreenshot,
    }, 'startupFailures');

    if (!browser) {
      try { await captureStartupFailureDiagnostics(port, userData, child, stdout, stderr, owned); }
      catch (diagnosticError) {
        appendBoundedRecord(diagnostics.startupFailures, {
          pid: child.pid ?? null,
          port,
          capturedAt: new Date().toISOString(),
          status: 'collection-error',
          error: sanitizeStartupText(`${diagnosticError?.name ?? 'Error'}: ${diagnosticError?.message ?? 'startup diagnostic collection failed'}`).slice(0, 512),
        }, 'startupFailures');
      }
    }

    const browserClose = startBrowserClose(browser, owned);

    await collectBrowserClose(browserClose, owned, cleanupFailures);

    try {
      await stopOwned(child, exited, port, owned);
      owned.ownedProcessCleanupStatus = 'verified';
    }
    catch (cleanupError) {
      owned.ownedProcessCleanupStatus = 'unverified';
      cleanupFailures.push(cleanupError);
    }

    if (owned.ownedProcessCleanupStatus !== 'verified') {
      closeOwnedPipes(child, owned);
    }

    stdout.snapshot(child.pid, 'stdout');
    stderr.snapshot(child.pid, 'stderr');

    try {
      await captureIsolatedAppLogs(userData, child.pid);
      owned.logCaptureStatus = 'complete';
    }
    catch (captureError) {
      owned.logCaptureStatus = 'incomplete';
      cleanupFailures.push(captureError);
      appendBoundedRecord(diagnostics.isolatedAppLogs, { pid: child.pid, status: 'diagnostic-collection-error', errorName: captureError?.name?.slice(0, 128) ?? 'Error' }, 'isolatedAppLogs');
    }

    if (cleanupFailures.length > 0) {
      throw new AggregateError([error, ...cleanupFailures], 'Packaged app startup failed and cleanup was incomplete', { cause: error });
    }

    throw error;
  }
}

async function assertAnonymousCliProfilesAbsent(stage) {
  const home = userInfo().homedir || homedir();
  const profileStates = {};

  for (const provider of ['codex', 'claude']) {
    try {
      await lstat(path.join(home, `.${provider}`));
      profileStates[provider] = 'present';
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new Error(`Cannot verify the host ${provider} profile is absent; refusing anonymous CLI inspection.`);
      }

      profileStates[provider] = 'absent';
    }
  }

  if (profileStates.codex !== 'absent' || profileStates.claude !== 'absent') {
    throw new Error('A host Codex or Claude profile exists; refusing native onboarding CLI inspection.');
  }

  diagnostics.onboardingCliProfilePreflights.push({ stage, codexProfile: 'absent', claudeProfile: 'absent' });
}

function beginOwnedShutdown(owned) {
  if (owned.shutdownStartedAt) return;
  owned.shutdownStartedAt = new Date().toISOString();
  owned.shutdownStartEpochMilliseconds = Date.now();
  owned.shutdownStartMonotonicNs = process.hrtime.bigint().toString();
}

async function stopOwned(child, exited, port, owned) {

  beginOwnedShutdown(owned);

  if (child.pid && (child.exitCode === null && child.signalCode === null || !(await isPortClosed(port)))) {
    try {
      process.kill(-child.pid, 'SIGTERM');
      owned.termSentAt = new Date().toISOString();
    }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }

  let closed = await exitedWithin(exited, 5_000);

  if (child.pid && (!closed || !(await isPortClosed(port)))) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      owned.killSentAt = new Date().toISOString();
    }
    catch (error) { if (error.code !== 'ESRCH') throw error; }

    closed = await exitedWithin(exited, 5_000);
  }

  if (!closed) throw new Error(`Packaged app PID ${child.pid ?? 'unknown'} did not exit after SIGKILL`);
}

function startBrowserClose(browser, owned) {
  if (!browser) {
    owned.browserCloseStatus = 'not-started';

    return undefined;
  }

  return Promise.resolve()
    .then(() => browser.close())
    .then(() => ({ status: 'closed' }), error => ({ status: 'failed', error }));
}

async function collectBrowserClose(browserClose, owned, failures) {
  if (!browserClose) return;

  const outcome = await settleWithin(browserClose, 2_000);

  if (outcome.status === 'settled' && outcome.value.status === 'closed') {
    owned.browserCloseStatus = 'closed';

    return;
  }

  owned.browserCloseStatus = 'unverified';
  failures.push(outcome.status === 'settled' ? outcome.value.error : new Error('Browser close was not observed within the bounded cleanup period'));
}

function closeOwnedPipes(child, owned) {
  owned.outputDrainStatus = 'closed-after-bounded-cleanup';
  child.stdout?.destroy();
  child.stderr?.destroy();
}

async function settleWithin(promise, timeoutMs) {
  let timeout;

  try {
    const outcome = await Promise.race([
      promise.then(value => ({ status: 'settled', value })),
      new Promise(resolve => { timeout = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs); }),
    ]);

    return outcome;
  } finally {
    clearTimeout(timeout);
  }
}

async function exitedWithin(exited, timeoutMs) {

  let timeout;

  try {
    return await Promise.race([
      exited.then(() => true),
      new Promise(resolve => { timeout = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function runNativeAccessibilityProbe() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'The native accessibility probe is CI-only');
  assert.equal(process.platform, 'darwin', 'The native accessibility probe requires the hosted macOS runner');

  const executable = '/usr/bin/osascript';
  const script = fileURLToPath(new URL('./native-accessibility-probe.js', import.meta.url));
  const args = ['-l', 'JavaScript', script];
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const observation = {
    pid: child.pid ?? null,
    ppid: process.pid,
    command: executable,
    args,
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
    exitObservedAt: null,
    exit: null,
    cleanupStatus: 'pending',
    stdoutBytes: 0,
    stderrBytes: 0,
  };

  diagnostics.nativeAccessibilityProbe = observation;

  let stdout = '';
  let spawnError;
  child.once('error', error => { spawnError = error; });
  child.stdout.on('data', chunk => {
    observation.stdoutBytes += chunk.length;

    if (stdout.length < 4096) stdout += chunk.toString('utf8').slice(0, 4096 - stdout.length);
  });
  child.stderr.on('data', chunk => { observation.stderrBytes += chunk.length; });

  const exited = new Promise(resolve => child.once('close', (code, signal) => {
    observation.exitObservedAt = new Date().toISOString();
    observation.exit = { code, signal };
    resolve(observation.exit);
  }));

  try {
    const finished = await exitedWithin(exited, 5_000);

    if (!finished) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      let closed = await exitedWithin(exited, 1_000);

      if (!closed && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        closed = await exitedWithin(exited, 1_000);
      }

      if (!closed) throw new Error('Owned osascript AX probe did not exit after bounded cleanup');
      observation.cleanupStatus = 'terminated-after-timeout';
      throw new Error('Owned osascript AX probe exceeded its five-second bound');
    }

    if (spawnError) throw new Error('Owned osascript AX probe could not start');

    if (observation.exit?.code !== 0 || observation.exit.signal !== null) throw new Error('Owned osascript AX probe failed');

    if (observation.stdoutBytes > 4096 || observation.stderrBytes > 4096) throw new Error('Owned osascript AX probe exceeded its output bound');

    const result = JSON.parse(stdout.trim());

    if (Object.keys(result).length === 1 && Object.hasOwn(result, 'failurePhase')) {
      assert.ok(['IMPORT', 'OPTIONS', 'QUERY', 'VALUE', 'SERIALIZE'].includes(result.failurePhase), 'The JXA probe failure must identify an allowlisted phase');
      observation.failurePhase = result.failurePhase;
      observation.failureCode = 'jxa-phase-failed';
      throw new Error('Owned osascript AX probe failed during a recorded phase');
    }

    assert.deepEqual(Object.keys(result).sort(), [
      'currentClientTrusted', 'currentHelperPID', 'nativePickerFlowExercised', 'promptRequested',
    ].sort(), 'The JXA probe must emit only its allowlisted receipt fields');
    assert.equal(result.currentHelperPID, child.pid, 'AX trust must be reported for this exact owned osascript process');
    assert.ok([true, false].includes(result.currentClientTrusted), 'The current osascript process must report a boolean AX trust result');
    assert.equal(result.promptRequested, false);
    assert.equal(result.nativePickerFlowExercised, false);
    observation.currentClientTrusted = result.currentClientTrusted;
    observation.promptRequested = false;
    observation.nativePickerFlowExercised = false;
    observation.cleanupStatus = 'exit-observed';
  } catch (error) {
    if (observation.cleanupStatus === 'pending') observation.cleanupStatus = observation.exitObservedAt ? 'exit-observed' : 'exit-unverified';
    observation.failureCode ??= error?.message === 'Owned osascript AX probe exceeded its five-second bound'
      ? 'probe-timeout'
      : error?.message === 'Owned osascript AX probe did not exit after bounded cleanup'
        ? 'cleanup-unverified'
        : 'probe-failed';
    throw error;
  }
}

async function isPortClosed(port) {
  const socket = net.createConnection({ host: '127.0.0.1', port });

  return new Promise(resolve => {
    let settled = false;

    const finish = closed => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(closed);
    };

    socket.setTimeout(1_000, () => finish(false));
    socket.once('connect', () => finish(false));
    socket.once('error', error => finish(error.code === 'ECONNREFUSED'));
  });
}

async function closeApp(session) {
  const cleanupFailures = [];
  let browserClose;

  try {

    for (const capture of session.consoleCaptures) {
      if (capture.cdp) await sampleRendererClock(capture, 'before-owned-shutdown');
    }

    beginOwnedShutdown(session.owned);

    for (const capture of session.consoleCaptures) {
      if (!capture.cdp) continue;
      session.owned.consoleCaptureBoundaries.push({
        targetIndex: capture.targetIndex,
        shutdownStartEpochMilliseconds: session.owned.shutdownStartEpochMilliseconds,
        clock: 'CDP Runtime.Timestamp epoch milliseconds / host Date.now epoch milliseconds',
      });
    }

  } catch (error) {
    cleanupFailures.push(error);
  }

  browserClose = startBrowserClose(session.browser, session.owned);

  await collectBrowserClose(browserClose, session.owned, cleanupFailures);

  try {
    await stopOwned(session.child, session.exited, session.port, session.owned);
    session.owned.ownedProcessCleanupStatus = 'verified';
  } catch (error) {
    cleanupFailures.push(error);
    session.owned.ownedProcessCleanupStatus = 'unverified';
  }

  try {
    await waitFor(() => isPortClosed(session.port), `owned CDP port ${session.port} to close`, 10_000);
    session.owned.portClosed = true;
    session.owned.portClosedAt = new Date().toISOString();
  } catch (error) {
    cleanupFailures.push(error);
    session.owned.portClosed = false;
    session.owned.portCloseError = error?.name?.slice(0, 128) ?? 'Error';
  }

  try {
    for (const capture of session.consoleCaptures) {
      for (const [name, listener] of capture.cdpListeners) capture.cdp?.off(name, listener);
      capture.cdpListeners.length = 0;

      if (capture.cdp) {
        try {
          await awaitDiagnosticOperation(capture.cdp.detach(), 2_000);
          recordNativeLifecycle(capture, 'cdp-session-disposed');
        } catch (error) {
          recordNativeLifecycle(capture, 'cdp-session-disposal-failed', { errorName: error?.name?.slice(0, 128) ?? 'Error' });
        }
      }
    }

    await captureIsolatedAppLogs(session.owned.userData, session.child.pid);
  } catch (error) {
    cleanupFailures.push(error);
    appendBoundedRecord(diagnostics.isolatedAppLogs, { pid: session.child.pid, status: 'diagnostic-collection-error', errorName: error?.name?.slice(0, 128) ?? 'Error' }, 'isolatedAppLogs');
  }

  if (session.owned.exitObservedAt && session.owned.exit) {
    session.owned.closedAt = new Date().toISOString();
    session.owned.exitObservationStatus = 'verified';
  } else {
    session.owned.exitObservationStatus = 'unverified';
    session.owned.outputDrainStatus = 'closed-after-bounded-cleanup';
    session.child.stdout?.destroy();
    session.child.stderr?.destroy();
    appendBoundedRecord(diagnostics.processOutput, {
      pid: session.child.pid,
      stream: 'owned-pipes',
      status: 'closed-after-bounded-cleanup',
      reason: 'child-close-event-unobserved',
    }, 'processOutput');
    cleanupFailures.push(new Error('Owned app close event was not observed after bounded cleanup'));
  }

  session.stdout.snapshot(session.child.pid, 'stdout');
  session.stderr.snapshot(session.child.pid, 'stderr');

  const cleanOwnedShutdown = Boolean(session.owned.exitObservedAt && session.owned.exit
    && session.owned.exit.code === 0 && session.owned.exit.signal === null && session.owned.portClosed);

  finalizeConsoleCaptures(session.consoleCaptures, session.owned, cleanOwnedShutdown);

  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, 'Owned app shutdown or diagnostic collection was not fully verified', { cause: cleanupFailures[0] });
  }
}

async function waitForExtensionReadiness(session, phase) {
  const requiredMarks = ['code/didLoadExtensions', 'code/didInitializeLocalExtensionHost'];

  const marks = await waitFor(
    () => session.page.evaluate(names => {
      const entries = performance.getEntriesByType('mark');

      if (!names.every(name => entries.some(entry => entry.name === name))) return undefined;

      return names.map(name => {
        const entry = entries.find(candidate => candidate.name === name);

        return { name: entry.name, startTime: entry.startTime };
      });
    }, requiredMarks),
    `${phase} extension scan and local host handshake`,
    90_000,
  );

  diagnostics.readinessMarks.push({ pid: session.child.pid, phase, marks });
}

try {

  const product = JSON.parse(await readFile(path.join(appPath, 'Contents/Resources/app/product.json'), 'utf8'));

  const executable = path.join(appPath, 'Contents/MacOS', product.nameShort);

  const outRoot = fileURLToPath(new URL('../code-oss/out/vs/workspace/electron-main/', import.meta.url));

  const { WorkspaceDatabase } = await import(pathToFileURL(path.join(outRoot, 'workspaceDatabase.js')).href);

  const { ProjectWorkspaceService } = await import(pathToFileURL(path.join(outRoot, 'projectWorkspaceService.js')).href);

  const { AgentSessionCollaborationService } = await import(pathToFileURL(path.join(outRoot, 'agentSessions/agentSessionCollaborationService.js')).href);

  const { computeAgentSessionChangeHunks } = await import(pathToFileURL(path.join(outRoot, 'agentSessions/agentSessionChangeHunks.js')).href);

  const { ManagedWorktreeService } = await import(pathToFileURL(path.join(outRoot, 'agentSessions/managedWorktrees.js')).href);

  await runNativeAccessibilityProbe();

  const screenshots = [];

  const viewports = [];

  for (const [theme, tag] of [['Review Light', 'light'], ['Review Dark', 'dark']]) {
    const profileRoot = path.join(root, tag);

    const userData = path.join(profileRoot, 'user-data');

    const extensions = path.join(profileRoot, 'extensions');

    const reviewHome = path.join(profileRoot, 'review-home');

    const projectFolder = path.join(profileRoot, 'project-folder');

    await mkdir(path.join(userData, 'User'), { recursive: true });

    await mkdir(extensions, { recursive: true });

    await mkdir(projectFolder, { recursive: true });

    await writeFile(path.join(userData, 'User/settings.json'), JSON.stringify({
      'window.autoDetectColorScheme': false,
      'workbench.colorTheme': theme,
      'telemetry.telemetryLevel': 'off',
      'review.telemetry.enabled': false,
      'update.mode': 'none',
      'security.workspace.trust.enabled': false,
    }));

    // Capture first-run onboarding before populating the isolated workspace DB.
    let session = await startPackaged({ executable, userData, extensions, reviewHome });

    try {

      const projectHomeHeading = session.page.locator('.project-home__intro h1');

      await projectHomeHeading.waitFor({ timeout: 90_000 });

      await dismissStartupInvitations(session.page);

      await waitForExtensionReadiness(session, `onboarding-${tag}`);

      assert.equal(await projectHomeHeading.innerText(), '어떤 프로젝트를 열까요?', 'Fresh profile must show the Korean project picker');

      await verifyTheme(session.page, tag === 'dark', `onboarding-${tag}`);

      assert.ok((await session.page.locator('main').innerText()).trim().length > 0, 'Onboarding must render visible content');

      const onboardingShot = path.join(output, `onboarding-${tag}.png`);

      await capturePage(session.page, onboardingShot);

      screenshots.push(onboardingShot);
    } catch (error) {

      await captureFailure(session.page, path.join(output, `onboarding-${tag}-failure.png`), diagnostics);

      throw error;
    } finally {
      await closeApp(session);
    }

    const database = WorkspaceDatabase.open(path.join(userData, 'workspace.db'));

    let fixture;

    try {

      const service = new ProjectWorkspaceService(database, userData);

      const project = service.createProject('CI 대시보드 프로젝트', projectFolder);

      const task = database.createTask({
        projectId: project.project.id,
        bindingId: project.binding.id,
        title: '키보드 상태 변경 확인',
        description: '패키지 앱의 task 상태 버튼과 포커스를 확인합니다.',
      });

      fixture = { projectId: project.project.id, bindingId: project.binding.id, projectName: project.project.name, projectFolder: project.binding.path, descriptorPath: project.descriptorPath, taskId: task.id, taskTitle: task.title, initialState: task.state };
    } finally {
      database.close();
    }

    assert.equal(fixture.initialState, 'ready', 'The service fixture must start in the ready column');

    session = await startPackaged({ executable, userData, extensions, reviewHome, descriptor: fixture.descriptorPath });

    try {

      const page = session.page;

      await waitForExtensionReadiness(session, `dashboard-${tag}`);

      await page.setViewportSize({ width: 1440, height: 900 });

      await page.waitForFunction(() => window.innerWidth === 1440);

      await page.locator('.project-dashboard').waitFor();

      await page.getByRole('heading', { name: fixture.projectName, exact: true }).waitFor();

      const navigationButton = page.getByRole('button', { name: '프로젝트 메뉴', exact: true });

      await navigationButton.waitFor({ state: 'visible', timeout: 90_000 });

      await navigationButton.click();

      const sidebar = page.getByRole('navigation', { name: '프로젝트 탐색', exact: true });

      await sidebar.waitFor({ timeout: 90_000 });

      for (const label of ['대시보드', '레퍼런스', '프로젝트 규칙']) {
        await sidebar.getByRole('button', { name: label, exact: true }).waitFor();
      }

      assert.equal(await sidebar.locator('.project-sidebar__item[aria-current="page"]').innerText(), '대시보드');

      await page.locator('.project-dashboard').waitFor();

      await verifyTheme(page, tag === 'dark', `dashboard-${tag}`);

      await page.getByRole('heading', { name: fixture.projectName, exact: true }).waitFor();

      const taskButton = page.locator(`.project-dashboard__task[data-focus-key="task:${fixture.taskId}"]`);

      assert.equal(await taskButton.locator('.project-dashboard__task-title').innerText(), fixture.taskTitle, 'Dashboard must display the seeded task title');

      await taskButton.waitFor();

      const desktopShot = path.join(output, `dashboard-${tag}-desktop.png`);

      const desktop = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));

      assert.deepEqual(desktop, { width: 1440, height: 900 }, 'Desktop capture must use the requested 1440 × 900 viewport');

      await capturePage(page, desktopShot);

      screenshots.push(desktopShot);

      viewports.push({ theme: tag, state: 'desktop', ...desktop, screenshot: desktopShot });

      if (tag === 'light') {

        await page.setViewportSize({ width: 760, height: 820 });

        await page.waitForFunction(() => window.innerWidth === 760);

        await navigationButton.waitFor({ state: 'visible' });

        await sidebar.waitFor({ state: 'hidden' });

        const narrow = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));

        assert.equal(narrow.width, 760, 'Narrow dashboard viewport must measure 760 CSS pixels');

        assert.ok(narrow.height > 0, 'Narrow dashboard viewport height must be measurable');

        const narrowShot = path.join(output, 'dashboard-light-narrow-760.png');

        await capturePage(page, narrowShot);

        screenshots.push(narrowShot);

        viewports.push({ theme: tag, state: 'narrow', ...narrow, screenshot: narrowShot });
      }

      await taskButton.focus();

      await page.keyboard.press('Enter');

      await page.locator('.project-dashboard__task-card button[aria-pressed="true"]').waitFor();

      const stateHeading = page.locator('#project-task-state-heading');

      await stateHeading.waitFor();

      const inProgress = page.locator('[data-focus-key="task-state:inProgress"]');

      await inProgress.focus();

      await page.keyboard.press('Enter');

      await page.waitForFunction(() => document.querySelector('[data-focus-key="task-state:inProgress"]')?.getAttribute('aria-pressed') === 'true', undefined, { timeout: 20_000 });

      await page.waitForFunction(() => document.activeElement?.id === 'project-task-state-heading', undefined, { timeout: 20_000 });

      assert.equal(await page.locator('[data-focus-key="task-state:inProgress"]').getAttribute('aria-pressed'), 'true', 'Keyboard action must persist the selected task state');

      assert.equal(await page.evaluate(() => document.activeElement?.id), 'project-task-state-heading', 'Task state mutation must return focus to its heading');

      await verifySessionOnboardingFirstRun(page, fixture, tag, screenshots, viewports);

      fixture.aiSession = await verifyAiSessionWorkspace(page, tag, screenshots, viewports);
    } catch (error) {

      await captureFailure(session.page, path.join(output, `dashboard-${tag}-failure.png`), diagnostics);

      throw error;
    } finally {
      await closeApp(session);
    }

    const persistedDatabase = WorkspaceDatabase.open(path.join(userData, 'workspace.db'));

    try {

      fixture.finalState = persistedDatabase.getTask(fixture.taskId)?.state;

      const aiSession = persistedDatabase.agentSessions.listSessions(fixture.projectId).find(item => item.name === fixture.aiSession.name);

      assert.ok(aiSession, 'The UI-created AI session must persist in workspace.db');
      assert.equal(aiSession.model, fixture.aiSession.model);
      assert.equal(aiSession.state, 'created', 'Preparing a session must not launch a provider');
      assert.equal(persistedDatabase.agentSessionTurns.listTurns(fixture.projectId, aiSession.id).length, 0, 'Visual QA must not create a paid provider turn');
      fixture.aiSession.id = aiSession.id;
      fixture.controlRequest = await seedSessionControlRequest(persistedDatabase, fixture, projectFolder, aiSession);
    } finally {
      persistedDatabase.close();
    }

    assert.equal(fixture.finalState, 'inProgress', 'Keyboard state change must persist in workspace.db after the app exits');

    const logFixtureDatabase = WorkspaceDatabase.open(path.join(userData, 'workspace.db'));

    try {
      const seeded = await seedTranscriptHistory(logFixtureDatabase, fixture, projectFolder, tag);

      fixture.logHistory = seeded.receipt;

      const changeEvidence = await seedChangeEvidence(logFixtureDatabase, fixture, projectFolder, tag, computeAgentSessionChangeHunks);

      fixture.changeEvidence = changeEvidence.receipt;

      fixture.reviewedCommit = await seedReviewedCommit(logFixtureDatabase, fixture, projectFolder, userData, tag, ManagedWorktreeService);

      fixture.reviewedConflictCommit = await seedReviewedCommit(logFixtureDatabase, fixture, projectFolder, userData, `${tag}-conflict`, ManagedWorktreeService, {
        repository: fixture.reviewedCommit.repository,
        bindingId: fixture.reviewedCommit.bindingId,
        retainedAfter: `conflicting second session ${tag}\n`,
      });

      assert.equal(seeded.receipt.turnIds.length, 2, 'The isolated history fixture must contain two real persisted turns');

      for (const turnId of seeded.receipt.turnIds) {
        const stored = logFixtureDatabase.agentSessionTranscripts.readPage(fixture.projectId, seeded.receipt.sessionId, turnId, { limit: 100 });
        const next = logFixtureDatabase.agentSessionTranscripts.readPage(fixture.projectId, seeded.receipt.sessionId, turnId, { afterSequence: stored.nextSequence, limit: 100 });

        assert.equal(stored.entries.length, 100, 'The history fixture must fill the first UI page');
        assert.equal(stored.hasMore, true, 'The history fixture must expose another page');
        assert.equal(stored.entries.length + next.entries.length, seeded.receipt.entryCountPerTurn, 'The stored history must contain more than one UI page of unique entries');

        assert.ok([...stored.entries, ...next.entries].every(entry => !entry.text.includes(transcriptFixtureSecret(tag))), 'Known fixture secrets must be masked before they reach SQLite');
      }
    } finally {
      logFixtureDatabase.close();
    }

    session = await startPackaged({ executable, userData, extensions, reviewHome, descriptor: fixture.descriptorPath });

    try {
      await waitForExtensionReadiness(session, `transcript-logs-${tag}`);

      await verifySessionOnboardingAfterRestart(session.page, fixture, tag, screenshots, viewports);

      await verifySessionControlRequest(session.page, fixture, tag, screenshots, viewports);

      await verifyAiSessionTranscriptLogs(session.page, fixture, tag, screenshots, viewports);

      await verifyAiSessionChangeEvidence(session.page, fixture, tag, screenshots, viewports);

      await verifyReviewedCommitProposal(session.page, fixture, tag, screenshots, viewports);
    } catch (error) {
      await captureFailure(session.page, path.join(output, `ai-session-logs-${tag}-failure.png`), diagnostics);

      throw error;
    } finally {
      await closeApp(session);
    }

    const verifiedHistoryDatabase = WorkspaceDatabase.open(path.join(userData, 'workspace.db'));

    try {
      const turns = verifiedHistoryDatabase.agentSessionTurns.listTurns(fixture.projectId, fixture.logHistory.sessionId);

      assert.deepEqual(turns.map(turn => turn.id), fixture.logHistory.turnIds, 'Both CI history turns must persist after the packaged-app journey');

      const controlRequest = verifiedHistoryDatabase.agentSessionControlRequests.get(fixture.projectId, fixture.controlRequest.requestId);
      assert.equal(controlRequest?.state, 'rejected', 'The native UI rejection must persist as a durable request outcome');
      assert.equal(verifiedHistoryDatabase.agentSessionTurns.listTurns(fixture.projectId, fixture.controlRequest.targetSessionId).length, 0,
        'Reviewing and rejecting a start request must not create a target provider turn');
      const recoveredCallerTurn = verifiedHistoryDatabase.agentSessionTurns.getTurn(fixture.projectId, fixture.controlRequest.callerSessionId, fixture.controlRequest.callerTurnId);
      assert.equal(recoveredCallerTurn?.state, 'interrupted', 'App startup must reconcile the provider-free active caller fixture before the pending request is reviewed');
      assert.equal(recoveredCallerTurn?.cleanupVerified, false, 'Startup reconciliation must not claim cleanup for a provider process that was never launched');

      assert.equal(fixture.onboarding.completed, true, 'The explicit final guide action must be exercised before task-state verification');
      assert.equal(verifiedHistoryDatabase.getTask(fixture.taskId)?.state, 'inProgress', 'Finishing onboarding must not mark the actual project task complete');
      assert.equal(verifiedHistoryDatabase.getTask(fixture.taskId)?.state, fixture.finalState, 'Explanation review must not change the dashboard task state');

      assert.equal(verifiedHistoryDatabase.getTask(fixture.taskId)?.state, fixture.changeEvidence.seededTaskState, 'The review journey must leave the task at its seeded state');

      const reviewTarget = fixture.changeEvidence.reviewTarget;

      assert.equal(verifiedHistoryDatabase.agentWorkflows.listWorkflows(fixture.projectId).workflows.length, fixture.changeEvidence.workflowCountBefore, 'Explanation review must not create workflow approval or execution records');

      const explanationHistory = verifiedHistoryDatabase.agentSessionReviews.listRevisions({ target: reviewTarget, limit: 100 });

      assert.equal(explanationHistory.revisions.length, fixture.changeEvidence.seededExplanationRevisions + 2, 'The human draft and explanation-only confirmation must append to persisted fixture history');

      assert.equal(explanationHistory.revisions.at(-1)?.actor, 'human');

      assert.equal(explanationHistory.revisions.at(-1)?.status, 'confirmed');

      assert.equal(explanationHistory.revisions.at(-1)?.verification, 'unverified');

      const commitFixture = fixture.reviewedCommit;

      const proposals = verifiedHistoryDatabase.agentSessionIntegrations.listProposals(fixture.projectId, commitFixture.sessionId, commitFixture.turnId, { limit: 2 });

      assert.equal(proposals.proposals.length, 1, 'The real UI must persist exactly one explicit commit proposal');

      const proposal = proposals.proposals[0];

      assert.equal(proposal.approval, null, 'Creating and reviewing a proposal must not approve it');
      assert.equal(proposal.state, 'pending');
      assert.equal(proposal.commitMessage, commitFixture.commitMessage);
      assert.equal(proposal.sourceHead, commitFixture.sourceHead);
      assert.deepEqual(proposal.paths.map(item => item.path), ['selected.txt']);
      assert.equal(proposal.paths[0].explanations[0].revision, commitFixture.explanationRevision);
      commitFixture.proposalId = proposal.id;
      commitFixture.proposalFingerprint = proposal.fingerprint;
      verifiedHistoryDatabase.agentSessionIntegrations.recordTrustedHumanApproval(proposal.id, proposal.revision);
      commitFixture.approvalSource = 'Synthetic test-host approval in isolated CI SQLite; the native human confirmation dialog was not exercised.';

      for (const turn of turns) {
        const stored = verifiedHistoryDatabase.agentSessionTranscripts.readPage(fixture.projectId, fixture.logHistory.sessionId, turn.id, { limit: 100 });
        const next = verifiedHistoryDatabase.agentSessionTranscripts.readPage(fixture.projectId, fixture.logHistory.sessionId, turn.id, { afterSequence: stored.nextSequence, limit: 100 });

        assert.ok([...stored.entries, ...next.entries].every(entry => !entry.text.includes(transcriptFixtureSecret(tag))), 'The persisted history must not contain the unmasked fixture secret');
      }
    } finally {
      verifiedHistoryDatabase.close();
    }

    session = await startPackaged({ executable, userData, extensions, reviewHome, descriptor: fixture.descriptorPath });

    try {
      await waitForExtensionReadiness(session, `reviewed-commit-${tag}`);
      await verifyCompletedSessionOnboardingAfterRestart(session.page, fixture, tag, screenshots, viewports);
      await verifyReviewedCommitApply(session.page, fixture, tag, screenshots, viewports);
      await verifyReviewedMergeProposal(session.page, fixture, tag, screenshots, viewports);
    } catch (error) {
      await captureFailure(session.page, path.join(output, `reviewed-commit-${tag}-failure.png`), diagnostics);

      throw error;
    } finally {
      await closeApp(session);
    }

    const commitDatabase = WorkspaceDatabase.open(path.join(userData, 'workspace.db'));

    try {
      await verifyReviewedCommitResult(commitDatabase, fixture);

      const commitFixture = fixture.reviewedCommit;

      const mergePage = commitDatabase.agentSessionMerges.listProposals(fixture.projectId, commitFixture.sessionId, commitFixture.turnId, { limit: 2 });

      assert.equal(mergePage.proposals.length, 1, 'The real UI must create one explicit merge proposal');

      const merge = mergePage.proposals[0];

      assert.equal(merge.state, 'pending');
      assert.equal(merge.approval, null, 'A merge review must not grant approval');
      assert.equal(merge.commitProposalId, commitFixture.proposalId);
      assert.equal(merge.sourceHead, commitFixture.resultingHead);
      assert.equal(merge.targetHead, commitFixture.sourceHead);
      assert.deepEqual(merge.paths.map(item => item.path), ['selected.txt']);
      assert.equal(merge.paths[0].explanationState, 'linked');
      assert.equal(createHash('sha256').update(merge.diffText).digest('hex'), merge.diffFingerprint);
      fixture.reviewedMerge = {
        proposalId: merge.id, fingerprint: merge.fingerprint, sourceHead: merge.sourceHead, targetHead: merge.targetHead,
        integrationOwnerId: merge.integrationOwnerId, commitMessage: merge.commitMessage, author: merge.author, committer: merge.committer,
        nativeHumanApprovalExercised: false,
        approvalSource: 'Synthetic test-host approval in isolated CI SQLite; the native human confirmation dialog was not exercised.',
      };
      commitDatabase.agentSessionMerges.recordTrustedHumanApproval(merge.id, merge.revision, merge.fingerprint);
    } finally {
      commitDatabase.close();
    }

    session = await startPackaged({ executable, userData, extensions, reviewHome, descriptor: fixture.descriptorPath });

    try {
      await waitForExtensionReadiness(session, `reviewed-merge-${tag}`);
      await verifyReviewedMergeApply(session.page, fixture, tag, screenshots, viewports);
    } catch (error) {
      await captureFailure(session.page, path.join(output, `reviewed-merge-${tag}-failure.png`), diagnostics);

      throw error;
    } finally {
      await closeApp(session);
    }

    const mergeDatabase = WorkspaceDatabase.open(path.join(userData, 'workspace.db'));

    try {
      await verifyReviewedMergeResult(mergeDatabase, fixture);
      fixture.reviewedPublication = await seedReviewedPublication(mergeDatabase, fixture);
    } finally {
      mergeDatabase.close();
    }

    const publicationReadbackDatabase = WorkspaceDatabase.open(path.join(userData, 'workspace.db'));

    try {
      const { proposalId, operationId } = fixture.reviewedPublication;
      const proposal = publicationReadbackDatabase.agentSessionPublications.getProposal(proposalId);
      const operation = publicationReadbackDatabase.agentSessionPublications.getOperationForProposal(proposalId);
      assert.equal(proposal?.fingerprint, fixture.reviewedPublication.proposalFingerprint, 'The synthetic publication proposal must survive database reopen');
      assert.equal(operation?.id, operationId, 'A read-only Store lookup must retrieve the exact recovery operation after normal database reopen');
      assert.equal(operation?.state, 'recoveryRequired');
      assert.equal(operation?.events.at(-1)?.event.type, 'recoveryRequired');
    } finally {
      publicationReadbackDatabase.close();
    }

    session = await startPackaged({ executable, userData, extensions, reviewHome, descriptor: fixture.descriptorPath });

    try {
      await waitForExtensionReadiness(session, `reviewed-conflict-commit-${tag}`);
      await verifyPublicationReview(session.page, fixture, tag, screenshots, viewports);
      await verifyReviewedCommitProposal(session.page, fixture, `${tag}-conflict`, screenshots, viewports, fixture.reviewedConflictCommit);
    } catch (error) {
      await captureFailure(session.page, path.join(output, `reviewed-conflict-commit-${tag}-failure.png`), diagnostics);

      throw error;
    } finally {
      await closeApp(session);
    }

    const conflictCommitDatabase = WorkspaceDatabase.open(path.join(userData, 'workspace.db'));

    try {
      const commitFixture = fixture.reviewedConflictCommit;
      const proposals = conflictCommitDatabase.agentSessionIntegrations.listProposals(fixture.projectId, commitFixture.sessionId, commitFixture.turnId, { limit: 2 });

      assert.equal(proposals.proposals.length, 1, 'The second real UI must persist one source commit proposal');
      const proposal = proposals.proposals[0];

      assert.equal(proposal.state, 'pending');
      assert.equal(proposal.approval, null);
      assert.equal(proposal.commitMessage, commitFixture.commitMessage);
      assert.equal(proposal.sourceHead, commitFixture.sourceHead);
      assert.deepEqual(proposal.paths.map(item => item.path), ['selected.txt']);
      assert.equal(proposal.paths[0].explanations[0].revision, commitFixture.explanationRevision);
      commitFixture.proposalId = proposal.id;
      commitFixture.proposalFingerprint = proposal.fingerprint;
      conflictCommitDatabase.agentSessionIntegrations.recordTrustedHumanApproval(proposal.id, proposal.revision);
      commitFixture.approvalSource = 'Synthetic test-host approval in isolated CI SQLite; native confirmation was not exercised.';
    } finally {
      conflictCommitDatabase.close();
    }

    session = await startPackaged({ executable, userData, extensions, reviewHome, descriptor: fixture.descriptorPath });

    try {
      await waitForExtensionReadiness(session, `reviewed-conflict-commit-apply-${tag}`);
      await verifyReviewedCommitApply(session.page, fixture, `${tag}-conflict`, screenshots, viewports, fixture.reviewedConflictCommit);
    } catch (error) {
      await captureFailure(session.page, path.join(output, `reviewed-conflict-commit-apply-${tag}-failure.png`), diagnostics);

      throw error;
    } finally {
      await closeApp(session);
    }

    const conflictSourceDatabase = WorkspaceDatabase.open(path.join(userData, 'workspace.db'));

    try {
      await verifyReviewedCommitResult(conflictSourceDatabase, fixture, fixture.reviewedConflictCommit);
    } finally {
      conflictSourceDatabase.close();
    }

    session = await startPackaged({ executable, userData, extensions, reviewHome, descriptor: fixture.descriptorPath });

    try {
      await waitForExtensionReadiness(session, `reviewed-conflict-merge-${tag}`);
      await verifyReviewedMergeProposal(session.page, fixture, `${tag}-conflict`, screenshots, viewports, fixture.reviewedConflictCommit);
    } catch (error) {
      await captureFailure(session.page, path.join(output, `reviewed-conflict-merge-${tag}-failure.png`), diagnostics);

      throw error;
    } finally {
      await closeApp(session);
    }

    const conflictMergeDatabase = WorkspaceDatabase.open(path.join(userData, 'workspace.db'));

    try {
      const commitFixture = fixture.reviewedConflictCommit;
      const mergePage = conflictMergeDatabase.agentSessionMerges.listProposals(fixture.projectId, commitFixture.sessionId, commitFixture.turnId, { limit: 2 });

      assert.equal(mergePage.proposals.length, 1, 'The second source must have one durable conflict candidate proposal');
      const merge = mergePage.proposals[0];

      assert.equal(merge.state, 'pending');
      assert.equal(merge.approval, null);
      assert.equal(merge.sourceHead, commitFixture.resultingHead);
      assert.equal(merge.targetHead, fixture.reviewedMerge.resultingHead);
      assert.deepEqual(merge.paths.map(item => item.path), ['selected.txt']);
      fixture.reviewedConflictMerge = {
        proposalId: merge.id, fingerprint: merge.fingerprint, sourceHead: merge.sourceHead, targetHead: merge.targetHead,
        integrationOwnerId: merge.integrationOwnerId, commitMessage: merge.commitMessage, author: merge.author, committer: merge.committer,
        nativeHumanApprovalExercised: false,
        approvalSource: 'Synthetic test-host approval in isolated CI SQLite; the native confirmation was not exercised.',
      };
      conflictMergeDatabase.agentSessionMerges.recordTrustedHumanApproval(merge.id, merge.revision, merge.fingerprint);
    } finally {
      conflictMergeDatabase.close();
    }

    session = await startPackaged({ executable, userData, extensions, reviewHome, descriptor: fixture.descriptorPath });

    try {
      await waitForExtensionReadiness(session, `reviewed-conflict-merge-apply-${tag}`);
      await verifyReviewedConflictMergeApply(session.page, fixture, tag, screenshots, viewports);
    } catch (error) {
      await captureFailure(session.page, path.join(output, `reviewed-conflict-merge-apply-${tag}-failure.png`), diagnostics);

      throw error;
    } finally {
      await closeApp(session);
    }

    const conflictResultDatabase = WorkspaceDatabase.open(path.join(userData, 'workspace.db'));

    try {
      await verifyReviewedConflictResult(conflictResultDatabase, fixture);
    } finally {
      conflictResultDatabase.close();
    }

    await prepareReviewedConflictResolution(fixture);

    session = await startPackaged({ executable, userData, extensions, reviewHome, descriptor: fixture.descriptorPath });

    try {
      await waitForExtensionReadiness(session, `reviewed-conflict-resolution-${tag}`);
      await verifyReviewedResolutionProposal(session.page, fixture, tag, screenshots, viewports);
    } catch (error) {
      await captureFailure(session.page, path.join(output, `reviewed-conflict-resolution-${tag}-failure.png`), diagnostics);

      throw error;
    } finally {
      await closeApp(session);
    }

    const resolutionProposalDatabase = WorkspaceDatabase.open(path.join(userData, 'workspace.db'));

    try {
      const commit = fixture.reviewedConflictCommit;
      const proposals = resolutionProposalDatabase.agentSessionMerges.listProposals(fixture.projectId, commit.sessionId, commit.turnId, { limit: 5 });

      assert.equal(proposals.proposals.length, 2, 'Conflict resolution must append a second independently reviewable proposal');
      const oldConflict = proposals.proposals.find(item => item.id === fixture.reviewedConflictMerge.proposalId);

      assert.equal(oldConflict?.state, 'conflict');
      assert.equal(oldConflict?.approval?.actor, 'human', 'The original synthetic approval remains bound only to the conflict proposal');
      assert.equal(oldConflict?.approval?.proposalFingerprint, oldConflict?.fingerprint);
      const proposal = proposals.proposals.find(item => item.resolution?.proposalId === fixture.reviewedConflictMerge.proposalId);

      assert.ok(proposal, 'The new proposal must bind the exact previous conflict');
      assert.equal(proposal.revision, 2);
      assert.equal(proposal.state, 'pending');
      assert.equal(proposal.approval, null, 'The old conflict approval must not approve the resolution proposal');
      assert.equal(proposal.resolution.operationId, fixture.reviewedConflictMerge.operationId);
      assert.equal(proposal.resolution.generationId, fixture.reviewedConflictMerge.generationId);
      assert.equal(proposal.resolution.registrationId, fixture.reviewedConflictMerge.registrationId);
      assert.equal(proposal.resolution.treeOid, fixture.reviewedConflictMerge.manualResolution.stagedTree);
      assert.equal(proposal.resolution.indexFileDigest, fixture.reviewedConflictMerge.manualResolution.stagedIndexSha256);
      assert.equal(proposal.resolution.indexDigest, fixture.reviewedConflictMerge.manualResolution.indexDigest);
      assert.equal(proposal.resolution.treeDigest, fixture.reviewedConflictMerge.manualResolution.treeDigest);
      assert.equal(proposal.diffText, fixture.reviewedConflictMerge.manualResolution.fullDiff, 'The stored review must preserve the exact complete target-to-resolution Git diff');
      assert.equal(proposal.diffFingerprint, fixture.reviewedConflictMerge.manualResolution.fullDiffFingerprint);
      fixture.reviewedResolutionMerge = {
        proposalId: proposal.id, fingerprint: proposal.fingerprint, revision: proposal.revision,
        sourceHead: proposal.sourceHead, targetHead: proposal.targetHead, commitMessage: proposal.commitMessage,
        integrationOwnerId: proposal.integrationOwnerId, author: proposal.author, committer: proposal.committer, resolution: proposal.resolution,
        nativeHumanApprovalExercised: false,
        approvalSource: 'Synthetic test-host approval in isolated CI SQLite; the native confirmation was not exercised.',
      };
      resolutionProposalDatabase.agentSessionMerges.recordTrustedHumanApproval(proposal.id, proposal.revision, proposal.fingerprint);
    } finally {
      resolutionProposalDatabase.close();
    }

    session = await startPackaged({ executable, userData, extensions, reviewHome, descriptor: fixture.descriptorPath });

    try {
      await waitForExtensionReadiness(session, `reviewed-resolution-merge-apply-${tag}`);
      await verifyReviewedResolutionApply(session.page, fixture, tag, screenshots, viewports);
    } catch (error) {
      await captureFailure(session.page, path.join(output, `reviewed-resolution-merge-apply-${tag}-failure.png`), diagnostics);

      throw error;
    } finally {
      await closeApp(session);
    }

    const resolutionResultDatabase = WorkspaceDatabase.open(path.join(userData, 'workspace.db'));

    try {
      await verifyReviewedResolutionResult(resolutionResultDatabase, fixture);
    } finally {
      resolutionResultDatabase.close();
    }

    const mailboxFixtureDatabase = WorkspaceDatabase.open(path.join(userData, 'workspace.db'));

    try {
      fixture.historicalProposalAlerts = seedHistoricalProposalAlertFixtures(mailboxFixtureDatabase, fixture);

      const seededMailbox = await seedMailboxNotificationHistory(mailboxFixtureDatabase, fixture, projectFolder, tag, AgentSessionCollaborationService);

      fixture.mailbox = seededMailbox.receipt;

      assert.equal(mailboxFixtureDatabase.agentWorkflows.listWorkflows(fixture.projectId).workflows.length, 0, 'The workflow journey must begin without a preseeded workflow');

      const visualSession = mailboxFixtureDatabase.agentSessions.listSessions(fixture.projectId).find(item => item.name === fixture.aiSession.name);

      assert.ok(visualSession, 'The UI-created session must remain available beside the mailbox fixture sessions');

      fixture.workflowTurnCountsBefore = Object.fromEntries([visualSession.id, seededMailbox.receipt.senderSessionId, seededMailbox.receipt.recipientSessionId]
        .map(sessionId => [sessionId, mailboxFixtureDatabase.agentSessionTurns.listTurns(fixture.projectId, sessionId).length]));
    } finally {
      mailboxFixtureDatabase.close();
    }

    session = await startPackaged({ executable, userData, extensions, reviewHome, descriptor: fixture.descriptorPath });

    try {
      await waitForExtensionReadiness(session, `mailbox-notifications-${tag}`);

      await verifyAiSessionMailbox(session.page, fixture, tag, screenshots, viewports);

      fixture.workflow = await verifyAiSessionWorkflow(session.page, fixture, tag, screenshots, viewports);
    } catch (error) {
      await captureFailure(session.page, path.join(output, `ai-session-mailbox-${tag}-failure.png`), diagnostics);

      throw error;
    } finally {
      await closeApp(session);
    }

    const verifiedMailboxDatabase = WorkspaceDatabase.open(path.join(userData, 'workspace.db'));

    try {
      const messages = verifiedMailboxDatabase.agentSessions.listInbox(fixture.projectId, fixture.mailbox.recipientSessionId, { limit: 100 });

      const notifications = listAllProjectNotifications(verifiedMailboxDatabase, fixture.projectId);

      const notificationStatus = verifiedMailboxDatabase.agentSessions.notificationStatus(fixture.projectId);

      const targetMessage = messages.find(message => message.id === fixture.mailbox.targetMessageId);

      const targetNotification = notifications.find(notification => notification.id === fixture.mailbox.targetNotificationId);

      const senderSession = verifiedMailboxDatabase.agentSessions.getSession(fixture.projectId, fixture.mailbox.senderSessionId);

      const recipientSession = verifiedMailboxDatabase.agentSessions.getSession(fixture.projectId, fixture.mailbox.recipientSessionId);

      assert.equal(messages.length, fixture.mailbox.messageCount, 'The mailbox fixture must persist through the packaged-app journey');

      assert.ok(senderSession && recipientSession, 'Both CI mailbox sessions must persist through the packaged-app journey');

      assert.equal(senderSession.bindingId, fixture.bindingId, 'The sender fixture must remain bound to the dashboard task scope');

      assert.equal(senderSession.taskId, fixture.taskId, 'The sender fixture must remain connected to the dashboard task');

      assert.equal(recipientSession.bindingId, fixture.bindingId, 'The recipient fixture must remain bound to the dashboard task scope');

      assert.equal(recipientSession.taskId, fixture.taskId, 'The recipient fixture must remain connected to the dashboard task');

      assert.ok(messages.every(message => !message.body.includes(mailboxFixtureSecret(tag))), 'The production sanitization boundary must mask the known mailbox secret before persistence');

      assert.ok(messages.every(message => message.readAt === null), 'Human UI navigation must not acknowledge any mailbox message for the AI');

      assert.ok(targetMessage, 'The notification target message must remain in the recipient mailbox');

      assert.equal(notifications.length, fixture.mailbox.notificationCount, 'The project alert history must retain every existing notification across the UI journey');

      assert.equal(targetMessage.readAt, null, 'Opening a human mailbox view must not acknowledge the message for the AI');

      const historicalAlerts = fixture.historicalProposalAlerts;
      const persistedSiblingIds = Object.values(historicalAlerts.newerSiblingIds);

      assert.ok(persistedSiblingIds.every(id => id), 'Each historical target must have a persisted newer same-turn sibling');
      assert.equal(verifiedMailboxDatabase.agentSessionIntegrations.getProposal(historicalAlerts.newerSiblingIds.integration)?.revision,
        historicalAlerts.newerSiblingRevisions.integration, 'The newer integration sibling must survive the native journey');
      assert.equal(verifiedMailboxDatabase.agentSessionMerges.getProposal(historicalAlerts.newerSiblingIds.merge)?.revision,
        historicalAlerts.newerSiblingRevisions.merge, 'The newer merge sibling must survive the native journey');
      assert.equal(verifiedMailboxDatabase.agentSessionPublications.getProposal(historicalAlerts.newerSiblingIds.publication)?.revision,
        historicalAlerts.newerSiblingRevisions.publication, 'The newer publication sibling must survive the native journey');

      const oldIntegrationTarget = verifiedMailboxDatabase.agentSessionIntegrations.getProposal(historicalAlerts.targets.integration.id);
      const oldMergeTarget = verifiedMailboxDatabase.agentSessionMerges.getProposal(historicalAlerts.targets.merge.id);
      const oldPublicationTarget = verifiedMailboxDatabase.agentSessionPublications.getProposal(historicalAlerts.targets.publication.id);
      const oldMergeCommitParent = verifiedMailboxDatabase.agentSessionIntegrations.getProposal(historicalAlerts.parentIds.mergeCommit);
      const oldPublicationMergeParent = verifiedMailboxDatabase.agentSessionMerges.getProposal(historicalAlerts.parentIds.publicationMerge);
      const oldPublicationCommitParent = verifiedMailboxDatabase.agentSessionIntegrations.getProposal(historicalAlerts.parentIds.publicationCommit);

      assert.equal(oldIntegrationTarget?.fingerprint, historicalAlerts.targetFingerprints.integration, 'The original integration target and evidence binding must survive exact navigation');
      assert.equal(oldIntegrationTarget?.sessionId, historicalAlerts.destinations.integration.sessionId);
      assert.equal(oldIntegrationTarget?.turnId, historicalAlerts.destinations.integration.turnId);
      assert.equal(oldIntegrationTarget?.evidenceVersion, historicalAlerts.evidenceVersions.integration);
      assert.equal(oldIntegrationTarget?.evidenceFingerprint, historicalAlerts.targetEvidenceFingerprints.integration);
      assert.equal(oldMergeTarget?.fingerprint, historicalAlerts.targetFingerprints.merge, 'The original merge target must survive exact navigation');
      assert.equal(oldMergeTarget?.sessionId, historicalAlerts.destinations.merge.sessionId);
      assert.equal(oldMergeTarget?.turnId, historicalAlerts.destinations.merge.turnId);
      assert.equal(oldMergeTarget?.commitProposalId, historicalAlerts.parentIds.mergeCommit);
      assert.equal(oldMergeTarget?.commitProposalRevision, historicalAlerts.parentRevisions.mergeCommit);
      assert.equal(oldMergeTarget?.commitProposalFingerprint, historicalAlerts.parentFingerprints.mergeCommit);
      assert.equal(oldMergeCommitParent?.revision, historicalAlerts.parentRevisions.mergeCommit);
      assert.equal(oldMergeCommitParent?.fingerprint, historicalAlerts.parentFingerprints.mergeCommit);
      assert.equal(oldMergeCommitParent?.evidenceVersion, historicalAlerts.evidenceVersions.merge);
      assert.equal(oldMergeCommitParent?.evidenceFingerprint, historicalAlerts.targetEvidenceFingerprints.merge);
      assert.equal(oldPublicationTarget?.fingerprint, historicalAlerts.targetFingerprints.publication, 'The original publication target and text pin must survive exact navigation');
      assert.equal(oldPublicationTarget?.sessionId, historicalAlerts.destinations.publication.sessionId);
      assert.equal(oldPublicationTarget?.turnId, historicalAlerts.destinations.publication.turnId);
      assert.deepEqual(oldPublicationTarget?.textRevision, historicalAlerts.publicationTextPins.original);
      assert.equal(oldPublicationTarget?.sourceMergeId, historicalAlerts.parentIds.publicationMerge);
      assert.equal(oldPublicationTarget?.sourceMergeRevision, historicalAlerts.parentRevisions.publicationMerge);
      assert.equal(oldPublicationTarget?.sourceMergeFingerprint, historicalAlerts.parentFingerprints.publicationMerge);
      assert.equal(oldPublicationTarget?.resultCommit, oldPublicationMergeParent?.outcomes.at(-1)?.receipt.resultingHead);
      assert.equal(oldPublicationMergeParent?.state, 'merged');
      assert.equal(oldPublicationMergeParent?.fingerprint, historicalAlerts.parentFingerprints.publicationMerge);
      assert.equal(oldPublicationCommitParent?.revision, historicalAlerts.parentRevisions.publicationCommit);
      assert.equal(oldPublicationCommitParent?.fingerprint, historicalAlerts.parentFingerprints.publicationCommit);
      assert.equal(oldPublicationCommitParent?.evidenceVersion, historicalAlerts.evidenceVersions.publication);
      assert.equal(oldPublicationCommitParent?.evidenceFingerprint, historicalAlerts.targetEvidenceFingerprints.publication);

      const originalTextPin = historicalAlerts.publicationTextPins.original;
      const siblingTextPin = historicalAlerts.publicationTextPins.sibling;

      assert.equal(verifiedMailboxDatabase.agentSessionPrTexts.getRevision(originalTextPin.scope, originalTextPin.revision)?.content.contentHash,
        originalTextPin.contentHash, 'The original publication target must retain its pinned generated PR text');
      assert.equal(verifiedMailboxDatabase.agentSessionPrTexts.getRevision(siblingTextPin.scope, siblingTextPin.revision)?.content.contentHash,
        siblingTextPin.contentHash, 'The newer publication sibling must retain its pinned generated PR text');

      const readNotificationIds = new Set(notifications.filter(notification => notification.readAt).map(notification => notification.id));

      const historicalProposalNotifications = fixture.historicalProposalAlerts.notificationIds;

      const expectedReadIds = new Set([...fixture.mailbox.initialReadIds, fixture.mailbox.completionNotificationId, fixture.mailbox.targetNotificationId,
        ...Object.values(historicalProposalNotifications)]);

      assert.ok(targetNotification?.readAt, 'Opening the message notification must mark that exact notification as read');

      assert.ok(notifications.find(notification => notification.id === fixture.mailbox.completionNotificationId)?.readAt, 'Opening the completion notification must mark that exact notification as read');

      for (const [kind, notificationId] of Object.entries(historicalProposalNotifications)) {
        assert.ok(notifications.find(notification => notification.id === notificationId)?.readAt, `Successful exact ${kind} proposal navigation must acknowledge only its own alert`);
      }

      assert.deepEqual([...readNotificationIds].sort(), [...expectedReadIds].sort(), 'Only the five successfully opened notifications may be added to the persisted read set');

      assert.equal(notificationStatus.unreadCount, fixture.mailbox.unreadCount - 5, 'Only the five successfully opened notifications must leave the project unread count');

      assert.equal(notificationStatus.latestSequence, fixture.mailbox.latestSequence, 'The project notification high-water mark must remain unchanged');

      const savedWorkflow = verifiedMailboxDatabase.agentWorkflows.getWorkflow(fixture.projectId, fixture.workflow.workflowId);

      assert.ok(savedWorkflow, 'The packaged UI must create a persisted workflow through the application IPC');

      assert.equal(savedWorkflow.state, 'waiting', 'Saving a plan must leave it waiting for native approval');

      assert.equal(savedWorkflow.planVersion, fixture.workflow.savedVersion, 'The workflow store must retain the saved edited plan version');

      const savedPlan = verifiedMailboxDatabase.agentWorkflows.getPlan(fixture.projectId, fixture.workflow.workflowId);

      assert.equal(savedPlan?.fingerprint, fixture.workflow.savedFingerprint, 'The persisted workflow fingerprint must match the rendered saved plan');

      assert.equal(savedPlan?.maxConcurrentNodes, fixture.workflow.expectedPlan.maxConcurrentNodes, 'The UI must persist the explicit finite concurrency limit');

      assert.equal(savedPlan?.maxTotalTurns, fixture.workflow.expectedPlan.maxTotalTurns, 'The UI must persist the explicit finite turn limit');

      assert.equal(savedPlan?.maxDurationMs, fixture.workflow.expectedPlan.maxDurationMs, 'The UI must persist the explicit finite duration limit');

      const persistedNodes = savedPlan?.nodes.map(node => ({
        sessionId: node.sessionId,
        role: node.role,
        permissionPolicy: node.permissionPolicy,
        dependsOn: node.dependsOn.map(dependency => {
          const dependencyNode = savedPlan.nodes.find(candidate => candidate.nodeId === dependency);

          assert.ok(dependencyNode, 'Every persisted workflow dependency must resolve to a selected session');

          return dependencyNode.sessionId;
        }).sort(),
      })).sort((left, right) => left.sessionId.localeCompare(right.sessionId));

      assert.deepEqual(persistedNodes, fixture.workflow.expectedPlan.nodes
        .map(node => ({ ...node })).sort((left, right) => left.sessionId.localeCompare(right.sessionId)), 'The persisted plan must retain its real session identities, supported policies, roles, and dependency');

      assert.equal(verifiedMailboxDatabase.agentWorkflows.getLatestRun(fixture.projectId, fixture.workflow.workflowId), undefined, 'Saving a workflow must not approve it or create a run');

      for (const [sessionId, count] of Object.entries(fixture.workflowTurnCountsBefore)) {
        assert.equal(verifiedMailboxDatabase.agentSessionTurns.listTurns(fixture.projectId, sessionId).length, count, 'Saving a workflow must not create provider turns for its sessions');
      }
    } finally {
      verifiedMailboxDatabase.close();
    }

    await writeFile(path.join(output, `fixture-${tag}.json`), JSON.stringify(fixture, null, 2));
  }

  await writeFile(path.join(output, 'screenshots.json'), JSON.stringify(screenshots, null, 2));

  await writeFile(path.join(output, 'viewports.json'), JSON.stringify(viewports, null, 2));
} catch (error) {

  diagnostics.pageErrors.push(error.stack ?? error.message);

  throw error;
} finally {

  await writeFile(path.join(output, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2));

  await rm(root, { recursive: true, force: true });
}

assert.deepEqual(diagnostics.pageErrors, [], 'Unexpected renderer/runtime errors');

assert.deepEqual(diagnostics.console, [], 'Unexpected renderer console errors');

assert.deepEqual(diagnostics.failedRequests, [], 'Unexpected failed network requests');

console.log(`Native dashboard smoke captured ${diagnostics.pageErrors.length} runtime errors, ${diagnostics.console.length} console errors, ${diagnostics.canceledThemeLoads.length} recovered theme cancellations, and ${diagnostics.failedRequests.length} failed requests.`);

async function verifySessionOnboardingFirstRun(page, fixture, tag, screenshots, viewports) {
  const workspace = await openSessionWorkspace(page);
  const guide = workspace.locator('.ai-session-onboarding');

  await guide.waitFor({ state: 'visible' });
  await guide.getByRole('heading', { name: 'AI 세션 시작 안내', exact: true }).waitFor();
  await guide.getByRole('heading', { name: '현재 프로젝트', exact: true }).waitFor();
  await guide.getByText(fixture.projectName, { exact: true }).waitFor();
  await guide.getByText(fixture.projectFolder, { exact: true }).waitFor();
  await guide.getByText('이 안내는 이 프로젝트의 세션과 작업 상태를 사용합니다. 예시 데이터는 만들지 않습니다.', { exact: true }).waitFor();
  await guide.getByText('Slack, Notion 등 외부 연결은 선택 사항이며 나중에 프로젝트 대시보드에서 설정할 수 있습니다. 연결하지 않아도 CLI 세션을 시작할 수 있습니다.', { exact: true }).waitFor();
  await guide.locator('.ai-session-onboarding__status').getByText('진행 단계 1/5 · 프로젝트', { exact: true }).waitFor();

  await captureOnboardingViewport(page, guide, tag, 'project-first-run', screenshots, viewports);

  await guide.getByRole('button', { name: '건너뛰기', exact: true }).focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-onboarding-focus')), 'next', 'Keyboard tab order must reach the next onboarding step');
  await page.keyboard.press('Enter');
  await guide.getByRole('heading', { name: '설치된 CLI와 로컬 프로필 확인', exact: true }).waitFor();
  await guide.locator('.ai-session-onboarding__status').getByText('진행 단계 2/5 · CLI와 계정', { exact: true }).waitFor();
  assert.equal(await guide.locator('.ai-session-onboarding__inspection').innerText(), '확인을 누르면 설치 상태와 버전을 조회합니다. 이 조회는 로그인이나 모델 실행을 검증하지 않습니다.', 'The CLI step must state that it has not been inspected');
  assert.equal(await guide.locator('.ai-session-onboarding__inspection').locator('button').count(), 0, 'No inspection result or provider action may appear before a deliberate inspection');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-onboarding-focus')), 'next', 'Keyboard navigation must preserve focus on the next step control');

  await captureOnboardingViewport(page, guide, tag, 'cli-uninspected', screenshots, viewports);

  await guide.getByRole('button', { name: '건너뛰기', exact: true }).click();

  const toggle = workspace.locator('[data-onboarding-toggle="true"]');

  await page.waitForFunction(() => document.activeElement?.getAttribute('data-onboarding-toggle') === 'true');
  assert.equal(await toggle.innerText(), '이어서 안내 보기', 'Skipping must focus the project guide toggle and preserve resumable progress');
  await guide.waitFor({ state: 'hidden' });
  await toggle.click();
  await guide.locator('.ai-session-onboarding__status').getByText('진행 단계 2/5 · CLI와 계정', { exact: true }).waitFor();
  assert.equal(await guide.locator('.ai-session-onboarding__inspection').innerText(), '확인을 누르면 설치 상태와 버전을 조회합니다. 이 조회는 로그인이나 모델 실행을 검증하지 않습니다.', 'Resuming must return to the same uninspected step');

  for (const provider of ['codex', 'claude']) {
    await assertAnonymousCliProfilesAbsent(`before-${provider}-inspection`);

    await guide.getByLabel('확인할 CLI').selectOption(provider);

    const inspectControl = guide.locator(`[data-onboarding-focus="inspect-${provider}"]`);

    assert.equal(await inspectControl.isEnabled(), true, 'The current provider inspection control must remain keyboard reachable');

    await inspectControl.focus();

    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-onboarding-focus')), `inspect-${provider}`, 'The selected provider inspection control must receive keyboard focus');

    await page.keyboard.press('Enter');

    // Codex can perform three sequential probes, each bounded at 5 seconds plus both 2.5-second cleanup waits.
    await page.waitForFunction(() => {
      const result = document.querySelector('.ai-session-onboarding__inspection');

      return result?.getAttribute('role') === 'alert' || result?.textContent?.includes('계정 ·');
    }, undefined, { timeout: 35_000 });

    await assertAnonymousCliProfilesAbsent(`after-${provider}-inspection`);

    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-onboarding-focus')), `inspect-${provider}`, 'The inspection result must restore focus to the selected provider control');

    const inspection = guide.locator('.ai-session-onboarding__inspection');
    const inspectionText = await inspection.innerText();
    const inspectionError = (await inspection.getAttribute('role')) === 'alert';
    let installationOutcome = 'inspection-error';

    if (inspectionError) {
      assert.equal(inspectionText, 'CLI 상태를 확인하지 못했습니다. 다시 시도해 주세요.', 'Inspection errors must use the product error guidance');
    } else {
      assert.match(inspectionText, /계정 · 로그인 필요/, 'An absent host profile must be reported as signed out without claiming authentication validity');

      const installationLine = inspectionText.split('\n', 1)[0];

      if (installationLine.includes('CLI · 설치됨 ·')) { installationOutcome = 'available'; }
      else if (installationLine.includes('CLI · 설치되지 않음')) { installationOutcome = 'missing'; }
      else if (installationLine.includes('CLI · 지원하지 않는 CLI 상태')) { installationOutcome = 'unsupported'; }
      else if (installationLine.includes('CLI · 설치 상태를 확인할 수 없음')) { installationOutcome = 'unavailable'; }
      else { assert.fail('The native inspection returned an unrecognized installation state'); }
    }

    diagnostics.onboardingCliInspections.push({
      theme: tag,
      provider,
      installationOutcome,
      authenticationOutcome: inspectionError ? 'inspection-error' : 'signed-out-profile-absent',
      hostProfiles: 'both-absent-before-and-after',
      sourceExpectedProfileStatusBranch: 'unreachable-with-absent-profile',
      runtimeCommandTraceCaptured: false,
      modelExecutionRequested: false,
      anonymousCapabilityArgsMayRun: provider === 'codex' ? [['--version'], ['--help'], ['resume', '--help']] : [['--version'], ['--help']],
    });

    await captureOnboardingViewport(page, guide, tag, `cli-${provider}-inspected`, screenshots, viewports);

    assert.equal(inspectionError, false, 'Anonymous onboarding inspection must return an actual installation result; error guidance alone does not prove CLI availability');
  }

  // Both inspection passes leave Claude selected; restore the Codex provider expected by this fixture's task action.
  await guide.getByLabel('확인할 CLI').selectOption('codex');

  await guide.getByRole('button', { name: '다음 단계', exact: true }).click();
  await guide.locator('.ai-session-onboarding__status').getByText('진행 단계 3/5 · 세션·모델', { exact: true }).waitFor();
  await guide.getByRole('button', { name: `“${fixture.taskTitle}” 작업으로 Codex 세션 만들기`, exact: true }).waitFor();
  await guide.getByText('이 프로젝트에는 아직 저장된 AI 세션이 없습니다.', { exact: true }).waitFor();
  await captureOnboardingViewport(page, guide, tag, 'no-saved-session', screenshots, viewports);

  await guide.getByRole('button', { name: '다음 단계', exact: true }).click();
  await guide.locator('.ai-session-onboarding__status').getByText('진행 단계 4/5 · 작업 범위', { exact: true }).waitFor();
  await guide.getByText('실제 세션을 선택하거나 기존 작업으로 세션을 만든 뒤 범위를 확인할 수 있습니다.', { exact: true }).waitFor();
  await captureOnboardingViewport(page, guide, tag, 'session-not-selected', screenshots, viewports);

  await guide.getByRole('button', { name: '다음 단계', exact: true }).click();
  await guide.locator('.ai-session-onboarding__status').getByText('진행 단계 5/5 · 첫 작업', { exact: true }).waitFor();
  await guide.getByText('아직 선택된 실제 실행 기록이 없습니다. 실행 미리보기에서 범위를 확인한 뒤 직접 시작해야 합니다.', { exact: true }).waitFor();

  for (const guidance of [
    '공유 범위 · 세션은 프로젝트 안에서 저장됩니다. MCP 도구의 제공자별 범위도 미리보기 문구로 확인하세요.',
    '로그 · 터미널 출력과 구조화 로그를 구분해 볼 수 있습니다. 로그 마스킹은 모든 민감 정보를 완벽히 제거한다고 보장하지 않으므로 공유 전 직접 확인하세요.',
    '알림 · 앱 안의 프로젝트 알림을 확인할 수 있습니다. 운영 체제 알림 권한은 선택 사항이며, 권한이 없어도 저장된 알림 목록을 열 수 있습니다.',
    '중단과 복구 · 현재 실행한 정확한 세션과 실행만 중단하세요. 종료 정리가 확인되지 않거나 복구가 필요하면 상태와 근거를 확인한 뒤 다시 시도하세요.',
    '검토와 PR · 변경을 검토하고 별도 승인 후 통합하세요. PR 게시도 별도 승인이 필요합니다.',
  ]) {
    await guide.getByText(guidance, { exact: true }).waitFor();
  }

  await captureOnboardingViewport(page, guide, tag, 'no-selected-turn', screenshots, viewports);

  await guide.getByRole('button', { name: '이전 단계', exact: true }).click();
  await guide.getByRole('button', { name: '이전 단계', exact: true }).click();
  await guide.getByRole('button', { name: '이전 단계', exact: true }).click();
  await guide.locator('.ai-session-onboarding__status').getByText('진행 단계 2/5 · CLI와 계정', { exact: true }).waitFor();
  await guide.getByRole('button', { name: '건너뛰기', exact: true }).click();
  await guide.waitFor({ state: 'hidden' });

  fixture.onboarding = { initialStep: 0, skippedAtStep: 1, cliInspected: false, resumedAtStep: 1, providerStarted: false };
}

async function verifySessionOnboardingAfterRestart(page, fixture, tag, screenshots, viewports) {
  const changes = await openReviewedCommitChanges(page, fixture);
  const workspace = page.locator('.ai-session-workspace');
  const toggle = workspace.locator('[data-onboarding-toggle="true"]');

  assert.equal(await toggle.innerText(), '이어서 안내 보기', 'A normal app restart must preserve this project’s skipped guide state');
  await changes.getByText(`v${fixture.reviewedCommit.evidenceVersion} · ${fixture.reviewedCommit.fingerprint}`, { exact: true }).waitFor();
  await toggle.click();

  const guide = workspace.locator('.ai-session-onboarding');

  await guide.locator('.ai-session-onboarding__status').getByText('진행 단계 2/5 · CLI와 계정', { exact: true }).waitFor();
  await workspace.getByRole('heading', { name: fixture.reviewedCommit.name, exact: true }).waitFor();
  await guide.getByRole('button', { name: '다음 단계', exact: true }).click();
  await guide.locator('.ai-session-onboarding__status').getByText('진행 단계 3/5 · 세션·모델', { exact: true }).waitFor();
  await guide.getByRole('heading', { name: '기존 작업이나 세션·모델 선택', exact: true }).waitFor();
  await guide.getByRole('button', { name: `“${fixture.taskTitle}” 작업으로 Codex 세션 만들기`, exact: true }).waitFor();
  await guide.getByRole('button', { name: `${fixture.reviewedCommit.name} · ${fixture.reviewedCommit.provider === 'codex' ? 'Codex' : 'Claude'} · ${fixture.reviewedCommit.model} · 유휴`, exact: true }).waitFor();

  await captureOnboardingViewport(page, guide, tag, 'actual-project-task-session', screenshots, viewports);

  await guide.getByRole('button', { name: '다음 단계', exact: true }).click();
  await guide.getByRole('heading', { name: '폴더와 규칙을 실행 전에 확인', exact: true }).waitFor();
  const workspaceModeLabel = fixture.reviewedCommit.workspaceMode === 'gitWorktree' ? '세션 전용 Git worktree' : '기존 폴더의 단일 수정자 정책';

  await guide.getByText(`${fixture.reviewedCommit.provider === 'codex' ? 'Codex' : 'Claude'} · ${fixture.reviewedCommit.model} · ${workspaceModeLabel}`, { exact: true }).waitFor();
  await guide.getByRole('button', { name: '다음 단계', exact: true }).click();
  await guide.getByRole('heading', { name: '첫 실제 작업에서 확인할 항목', exact: true }).waitFor();
  await guide.getByText(/실제 실행 상태 · exited · 종료 코드 0 · 정리 확인됨/).waitFor();

  const finish = guide.getByRole('button', { name: '안내 마치기', exact: true });

  await finish.focus();
  await page.keyboard.press('Enter');
  await guide.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-onboarding-toggle') === 'true');
  assert.equal(await toggle.innerText(), '안내 다시 열기', 'Finishing the guide must be distinct from completing the real task');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => window.innerWidth === 1440 && window.innerHeight === 900);
  await verifyTheme(page, tag === 'dark', `onboarding-${tag}-completed`);

  const completedHeading = await workspace.getByRole('heading', { name: fixture.reviewedCommit.name, exact: true }).boundingBox();

  const projectHeader = await workspace.locator('.ai-session__project-header').boundingBox();

  const scrollTop = await workspace.evaluate(element => element.scrollTop);

  assert.ok(completedHeading && projectHeader, 'The selected session title and project header must remain measurable after finishing the guide');
  assert.equal(scrollTop, 0, 'Finishing the guide must restore the session workspace scroll position');

  const headingGap = completedHeading.y - projectHeader.y - projectHeader.height;

  assert.ok(headingGap >= 16, 'Finishing the guide must leave the selected session title below the fixed project header with visible spacing');

  const completedScreenshot = path.join(output, `ai-session-onboarding-completed-${tag}-1440.png`);

  await capturePage(page, completedScreenshot);
  screenshots.push(completedScreenshot);
  viewports.push({ theme: tag, state: 'onboarding-explicitly-finished-task-still-in-progress', width: 1440, height: 900, screenshot: completedScreenshot, layout: { scrollTop, headingGap } });
  fixture.onboarding.completed = true;
  fixture.onboarding.actualSession = fixture.reviewedCommit.name;
  fixture.onboarding.actualTurn = fixture.reviewedCommit.turnId;
}

async function verifyCompletedSessionOnboardingAfterRestart(page, fixture, tag, screenshots, viewports) {
  await openReviewedCommitChanges(page, fixture);

  const workspace = page.locator('.ai-session-workspace');
  const toggle = workspace.locator('[data-onboarding-toggle="true"]');

  assert.equal(await toggle.innerText(), '안내 다시 열기', 'The completed guide state must survive a normal app restart');

  await page.keyboard.press('Meta+,');

  const settings = page.locator('.review-home-content.review-settings-page');

  await settings.waitFor({ state: 'visible' });

  const nativeNotificationRow = settings.getByRole('region', { name: 'AI 세션', exact: true })
    .getByText('운영체제 알림', { exact: true }).locator('..');

  const nativeNotificationToggle = settings.getByRole('checkbox', { name: 'AI 세션 운영체제 알림', exact: true });

  await nativeNotificationToggle.waitFor({ state: 'visible' });
  assert.equal(await nativeNotificationToggle.isChecked(), false, 'Native session notifications must remain opt-in by default');
  await nativeNotificationRow.getByText(/기본으로 꺼져 있습니다\./).waitFor();

  const settingsScreenshot = path.join(output, `ai-session-notification-settings-default-off-${tag}.png`);

  await capturePage(page, settingsScreenshot);
  screenshots.push(settingsScreenshot);
  viewports.push({ theme: tag, state: 'native-session-notifications-default-off', width: 1440, height: 900, screenshot: settingsScreenshot });

  await settings.getByRole('button', { name: '안내 다시 보기', exact: true }).click();

  const guide = workspace.locator('.ai-session-onboarding');

  await workspace.getByRole('heading', { name: fixture.reviewedCommit.name, exact: true }).waitFor();
  await guide.locator('.ai-session-onboarding__status').getByText('진행 단계 5/5 · 첫 작업', { exact: true }).waitFor();
  await guide.getByRole('heading', { name: '첫 실제 작업에서 확인할 항목', exact: true }).waitFor();
  await guide.getByText(/실제 실행 상태 · exited · 종료 코드 0 · 정리 확인됨/).waitFor();

  for (const viewport of [{ width: 1440, height: 760 }, { width: 760, height: 820 }]) {
    await page.setViewportSize(viewport);
    await page.waitForFunction(width => window.innerWidth === width, viewport.width);
    await verifyTheme(page, tag === 'dark', `onboarding-settings-reopen-${tag}-${viewport.width}`);
    await guide.scrollIntoViewIfNeeded();
    await guide.getByRole('button', { name: '안내 마치기', exact: true }).scrollIntoViewIfNeeded();

    const layout = await guide.evaluate(element => {
      const navigation = element.querySelector('.ai-session-onboarding__footer');
      const bounds = navigation?.getBoundingClientRect();

      return {
        documentOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        guideOverflow: element.scrollWidth > element.clientWidth + 1,
        navigationReachable: !!bounds && bounds.width > 0 && bounds.left >= -1 && bounds.right <= window.innerWidth + 1
          && bounds.top >= -1 && bounds.bottom <= window.innerHeight + 1,
      };

    });

    assert.equal(layout.documentOverflow, false, `Reopened onboarding document must not overflow at ${tag}/${viewport.width}`);
    assert.equal(layout.guideOverflow, false, `Reopened onboarding must not overflow at ${tag}/${viewport.width}`);
    assert.equal(layout.navigationReachable, true, `Reopened guide finish action must be reachable at ${tag}/${viewport.width}`);

    const screenshot = path.join(output, `ai-session-onboarding-reopened-${tag}-${viewport.width}.png`);

    await capturePage(page, screenshot);
    screenshots.push(screenshot);
    viewports.push({ theme: tag, state: 'onboarding-completed-state-reopened-from-settings-button', ...viewport, screenshot, layout });
  }

  const finish = guide.getByRole('button', { name: '안내 마치기', exact: true });

  await finish.focus();
  await page.keyboard.press('Enter');
  await guide.waitFor({ state: 'hidden' });
  assert.equal(await toggle.innerText(), '안내 다시 열기', 'Closing the reopened guide must preserve its completed state');
  fixture.onboarding.reopenedAfterRestart = true;
}

async function openSessionWorkspace(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => window.innerWidth === 1440);

  const editorTab = page.getByRole('tab', { name: /^AI 세션(?:,|$)/ });
  const tabCount = await editorTab.count();

  assert.ok(tabCount <= 1, 'Each project window must have at most one AI session editor tab');

  if (tabCount === 1) {
    await editorTab.click();
  } else {
    const sidebar = page.getByRole('navigation', { name: '프로젝트 탐색', exact: true });

    if (!(await sidebar.isVisible())) {
      await page.getByRole('button', { name: '프로젝트 메뉴', exact: true }).click();
    }

    await sidebar.getByRole('button', { name: 'AI 세션', exact: true }).click();
  }

  const workspace = page.locator('.ai-session-workspace');

  await workspace.waitFor({ state: 'visible' });

  return workspace;
}

async function captureOnboardingViewport(page, guide, tag, state, screenshots, viewports) {
  for (const viewport of [{ width: 1440, height: 760 }, { width: 760, height: 820 }]) {
    await page.setViewportSize(viewport);
    await page.waitForFunction(width => window.innerWidth === width, viewport.width);
    await verifyTheme(page, tag === 'dark', `onboarding-${state}-${tag}-${viewport.width}`);
    await guide.scrollIntoViewIfNeeded();

    const layout = await guide.evaluate(element => {
      const navigation = element.querySelector('.ai-session-onboarding__footer');
      navigation?.scrollIntoView({ block: 'end' });
      const bounds = navigation?.getBoundingClientRect();

      return {
        documentOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        guideOverflow: element.scrollWidth > element.clientWidth + 1,
        navigationReachable: !!bounds && bounds.width > 0 && bounds.left >= -1 && bounds.right <= window.innerWidth + 1
          && bounds.top >= -1 && bounds.bottom <= window.innerHeight + 1,
      };

    });

    assert.equal(layout.documentOverflow, false, `Onboarding document must not overflow at ${tag}/${viewport.width}`);
    assert.equal(layout.guideOverflow, false, `Onboarding content must not overflow at ${tag}/${viewport.width}`);
    assert.equal(layout.navigationReachable, true, `Onboarding navigation must be reachable at scroll end at ${tag}/${viewport.width}`);

    const screenshot = path.join(output, `ai-session-onboarding-${state}-${tag}-${viewport.width}.png`);

    await capturePage(page, screenshot);
    screenshots.push(screenshot);
    viewports.push({ theme: tag, state: `onboarding-${state}`, ...viewport, screenshot, layout });
  }
}

async function verifyAiSessionWorkspace(page, tag, screenshots, viewports) {
  const workspace = await openSessionWorkspace(page);

  await workspace.getByRole('heading', { name: '프로젝트 첫 AI 세션', exact: true }).waitFor();

  const emptyScreenshot = path.join(output, `ai-sessions-${tag}-empty-desktop.png`);

  await capturePage(page, emptyScreenshot);
  screenshots.push(emptyScreenshot);
  viewports.push({ theme: tag, state: 'ai-session-empty', width: 1440, height: 900, screenshot: emptyScreenshot });

  const name = `검수용 ${tag} Codex 세션`;
  const model = 'ci-fixture-not-executed';

  await workspace.getByRole('textbox', { name: '세션 이름', exact: true }).fill(name);
  await workspace.getByRole('textbox', { name: '모델 ID', exact: true }).fill(model);
  await workspace.getByRole('button', { name: '세션 만들고 실행 미리보기', exact: true }).click();
  await workspace.locator('.ai-session__preview').waitFor();
  await workspace.getByRole('heading', { name, exact: true }).waitFor();

  assert.ok((await workspace.locator('.ai-session__preview').innerText()).includes(model), 'The preview must show the exact selected model ID');

  const selectedScreenshot = path.join(output, `ai-sessions-${tag}-selected-desktop.png`);

  const measureLayout = () => workspace.evaluate(element => {
    const bounds = target => {
      const rect = target?.getBoundingClientRect();

      return rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } : null;
    };

    const main = element.querySelector('.ai-session__main');
    const mainStyle = main ? getComputedStyle(main) : null;
    const nameInput = element.querySelector('.ai-session__create-form [name="name"]');

    return {
      scrollTop: element.scrollTop,
      projectHeader: bounds(element.querySelector('.ai-session__project-header')),
      compactToolbar: bounds(element.querySelector('.ai-session__narrow-toolbar')),
      main: main ? { ...bounds(main), paddingLeft: mainStyle.paddingLeft, boxSizing: mainStyle.boxSizing } : null,
      heading: bounds(element.querySelector('.ai-session__detail-copy h1, .ai-session__create h1')),
      nameInput: bounds(nameInput),
      nameInputFocused: !!nameInput && document.activeElement === nameInput,
      horizontalOverflow: element.scrollWidth > element.clientWidth + 1,
    };
  });

  const selectedLayout = await measureLayout();
  await capturePage(page, selectedScreenshot);
  screenshots.push(selectedScreenshot);
  viewports.push({ theme: tag, state: 'ai-session-preview', width: 1440, height: 900, screenshot: selectedScreenshot, layout: selectedLayout });
  assert.ok(Number.parseFloat(selectedLayout.main?.paddingLeft ?? '0') >= 16, `The desktop session main must retain its horizontal inset at ${tag}`);
  assert.ok(selectedLayout.heading && selectedLayout.main && selectedLayout.heading.left >= selectedLayout.main.left + Number.parseFloat(selectedLayout.main.paddingLeft) - 1,
    `The desktop session heading must respect the main inset at ${tag}`);
  await page.setViewportSize({ width: 760, height: 820 });

  const compact = workspace.locator('.ai-session__narrow-toolbar');

  await compact.waitFor({ state: 'visible' });

  const create = compact.getByRole('button', { name: '새 AI 세션 만들기', exact: true });

  await create.focus();
  await page.keyboard.press('Enter');
  await workspace.getByRole('heading', { name: '새 AI 세션', exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute('name') === 'name');
  const createStartLayout = await measureLayout();
  assert.equal(createStartLayout.scrollTop, 0, 'Opening the create form must reset the workspace scroll position');
  assert.equal(createStartLayout.nameInputFocused, true, 'The new session name field must receive focus');
  assert.ok(createStartLayout.projectHeader && createStartLayout.nameInput && createStartLayout.nameInput.top >= createStartLayout.projectHeader.bottom,
    'The focused create field must remain below the sticky project header');

  const scrollBounds = await workspace.evaluate(element => {
    element.scrollTop = element.scrollHeight;

    const action = element.querySelector('.ai-session__create-form button[type="submit"]');
    const bounds = action?.getBoundingClientRect();
    const viewport = element.getBoundingClientRect();

    return { actionBottom: bounds?.bottom, viewportBottom: viewport.bottom, overflow: element.scrollWidth > element.clientWidth + 1 };
  });

  assert.equal(scrollBounds.overflow, false, 'The narrow AI session workspace must not overflow horizontally');
  assert.ok(Number.isFinite(scrollBounds.actionBottom) && scrollBounds.actionBottom <= scrollBounds.viewportBottom + 1, 'The final create action must remain reachable at scroll end');
  await workspace.evaluate(element => { element.scrollTop = 0; });
  const narrowLayout = await measureLayout();
  assert.equal(narrowLayout.scrollTop, 0, 'The narrow create screenshot must begin at the workspace top');
  assert.ok(narrowLayout.projectHeader && narrowLayout.compactToolbar && narrowLayout.compactToolbar.top >= narrowLayout.projectHeader.bottom,
    'The narrow session selector must remain below the sticky project header');
  assert.ok(narrowLayout.nameInput && narrowLayout.projectHeader && narrowLayout.nameInput.top >= narrowLayout.projectHeader.bottom,
    'The narrow create field must remain below the sticky project header');
  assert.equal(narrowLayout.horizontalOverflow, false, 'The narrow create layout must not overflow horizontally');

  const narrowScreenshot = path.join(output, `ai-sessions-${tag}-create-narrow-760.png`);

  await capturePage(page, narrowScreenshot);
  screenshots.push(narrowScreenshot);
  viewports.push({ theme: tag, state: 'ai-session-create-narrow', width: 760, height: 820, screenshot: narrowScreenshot, layout: narrowLayout, scrollBounds });
  await workspace.locator('.ai-session__create-form').getByRole('button', { name: '취소', exact: true }).click();
  await workspace.getByRole('tab', { name: '터미널', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.activeElement?.id === 'ai-session-tab-changes');

  assert.equal(await workspace.getByRole('tab', { name: '변경', exact: true }).getAttribute('aria-selected'), 'true');

  return { name, model };
}

async function seedSessionControlRequest(database, fixture, projectFolder, targetSession) {
  const callerFolder = path.join(path.dirname(projectFolder), 'control-caller-folder');

  await mkdir(callerFolder, { recursive: true });

  const callerBinding = database.createFolderBinding({ projectId: fixture.projectId, path: callerFolder });

  const caller = database.agentSessions.createSession({
    projectId: fixture.projectId,
    bindingId: callerBinding.id,
    name: `CI 요청 호출자 ${targetSession.name}`,
    provider: 'codex',
    model: 'ci-control-fixture-not-executed',
    profileRef: 'ci-control-fixture-only',
    workspaceMode: 'sharedFolder',
  });

  const folder = await statFolder(callerFolder);
  const current = database.agentSessions.getSession(fixture.projectId, caller.id);

  const snapshot = {
    schemaVersion: 1,
    projectId: fixture.projectId,
    sessionId: caller.id,
    sessionRevision: current.revision,
    bindingId: caller.bindingId,
    taskId: caller.taskId,
    provider: 'codex',
    model: caller.model,
    profileRef: caller.profileRef,
    cwd: folder.canonicalPath,
    folderIdentity: folder,
    managedWorktreeOwnerId: null,
    permissionPolicy: { mode: 'read-only', approval: 'never' },
    convention: null,
    references: [],
  };

  const turn = database.agentSessionTurns.createTurn({ projectId: fixture.projectId, sessionId: caller.id, expectedSessionRevision: current.revision, snapshot });
  const starting = database.agentSessions.getSession(fixture.projectId, caller.id);
  const running = database.agentSessionTurns.transitionTurn(fixture.projectId, caller.id, turn.id, turn.revision, starting.revision, { state: 'running' });
  assert.equal(running.turn.state, 'running', 'The request caller fixture must be a real active persisted turn');

  const target = database.agentSessions.getSession(fixture.projectId, targetSession.id);
  assert.ok(target, 'The UI-created target session must exist before the request is inserted');

  const request = database.agentSessionControlRequests.createStartRequest({
    projectId: fixture.projectId,
    callerSessionId: caller.id,
    callerTurnId: turn.id,
    targetSessionId: target.id,
    expectedSessionRevision: target.revision,
    permissionPolicy: { mode: 'read-only', approval: 'never' },
    reason: 'CI fixture request for native review and rejection.',
    idempotencyKey: `native-dashboard-control-${target.id}`,
  });

  assert.equal(request.state, 'pendingReview');
  assert.equal(database.agentSessionTurns.listTurns(fixture.projectId, target.id).length, 0, 'Persisting a request must not create a target turn');

  return { requestId: request.id, targetSessionId: target.id, callerSessionId: caller.id, callerTurnId: turn.id, callerName: caller.name };
}

async function verifySessionControlRequest(page, fixture, tag, screenshots, viewports) {
  const workspace = await openSessionWorkspace(page);
  const request = fixture.controlRequest;
  const toggle = workspace.locator('[data-control-action="toggle"]');
  await toggle.click();
  const panel = workspace.locator('.ai-session-control');
  await panel.getByRole('heading', { name: 'AI 제어 요청', exact: true }).waitFor();
  const row = panel.locator(`[data-control-request="${request.requestId}"]`);
  await row.waitFor();
  assert.ok((await row.innerText()).includes('CI fixture request for native review and rejection.'), 'The pending request row must show its persisted reason');
  await row.locator(`[data-control-action="${request.requestId}:preview"]`).click();

  const preview = workspace.locator('.ai-session__preview');
  await preview.waitFor();
  await preview.getByRole('heading', { name: '실행 범위를 확인해 주세요', exact: true }).waitFor();
  assert.ok((await preview.innerText()).includes(fixture.aiSession.model), 'The pending request preview must show the target session model');
  assert.ok((await preview.innerText()).includes('CLI 승인 요청 없음'), 'The request preview must show its supported read-only CLI policy independently of app approval');
  assert.equal(await workspace.locator('#ai-session-preview-start').innerText(), 'macOS 확인 창에서 승인', 'A reviewed request must still require the native human approval step');
  assert.equal(await preview.locator('button').count(), 2, 'Review preview exposes only approval and cancellation; it does not launch automatically');

  await workspace.locator('#ai-session-preview-start').scrollIntoViewIfNeeded();

  const previewScreenshot = path.join(output, `ai-session-control-request-preview-${tag}-1440.png`);
  await capturePage(page, previewScreenshot);
  screenshots.push(previewScreenshot);
  viewports.push({ theme: tag, state: 'control-request-preview-pending', width: 1440, height: 900, screenshot: previewScreenshot });

  await row.locator(`[data-control-action="${request.requestId}:reject"]`).click();
  await panel.getByText('검토를 기다리는 시작 요청이 없습니다.', { exact: true }).waitFor();
  await panel.getByRole('button', { name: '모든 요청 기록', exact: true }).click();
  const rejectedRow = panel.locator(`[data-control-request="${request.requestId}"]`);
  await rejectedRow.getByText(/요청 거절/).waitFor();
  assert.equal(await rejectedRow.getAttribute('data-control-target'), request.targetSessionId, 'The durable rejected row must remain bound to the exact target session');

  const rejectedScreenshot = path.join(output, `ai-session-control-request-rejected-${tag}-1440.png`);
  await capturePage(page, rejectedScreenshot);
  screenshots.push(rejectedScreenshot);
  viewports.push({ theme: tag, state: 'control-request-rejected', width: 1440, height: 900, screenshot: rejectedScreenshot });
  await panel.getByRole('button', { name: '요청 닫기', exact: true }).click();
}

function transcriptFixtureSecret(tag) {
  return `WB_CI_TRANSCRIPT_SECRET_${tag.toUpperCase()}_DO_NOT_PERSIST`;
}

async function seedTranscriptHistory(database, fixture, projectFolder, tag) {
  const name = `CI 로그 히스토리 fixture ${tag}`;
  const model = 'ci-fixture-not-executed';

  const session = database.agentSessions.createSession({
    projectId: fixture.projectId,
    bindingId: fixture.bindingId,
    taskId: fixture.taskId,
    name,
    provider: 'codex',
    model,
    profileRef: 'ci-transcript-fixture-only',
    workspaceMode: 'sharedFolder',
  });

  const directoryStats = await statFolder(projectFolder);
  const turnIds = [];
  const entryCountPerTurn = 124;
  const sequenceHole = 17;
  const secret = transcriptFixtureSecret(tag);

  for (let ordinal = 1; ordinal <= 2; ordinal++) {
    const currentSession = database.agentSessions.getSession(fixture.projectId, session.id);

    const snapshot = {
      schemaVersion: 1,
      projectId: fixture.projectId,
      sessionId: session.id,
      sessionRevision: currentSession.revision,
      bindingId: fixture.bindingId,
      taskId: fixture.taskId,
      provider: 'codex',
      model,
      profileRef: session.profileRef,
      cwd: directoryStats.canonicalPath,
      folderIdentity: { canonicalPath: directoryStats.canonicalPath, dev: directoryStats.dev, ino: directoryStats.ino },
      managedWorktreeOwnerId: null,
      permissionPolicy: { mode: 'read-only', approval: 'never' },
      convention: null,
      references: [],
    };

    const turn = database.agentSessionTurns.createTurn({
      projectId: fixture.projectId,
      sessionId: session.id,
      expectedSessionRevision: currentSession.revision,
      snapshot,
    });

    const startingSession = database.agentSessions.getSession(fixture.projectId, session.id);

    const running = database.agentSessionTurns.transitionTurn(
      fixture.projectId, session.id, turn.id, turn.revision, startingSession.revision, { state: 'running' },
    );

    const exited = database.agentSessionTurns.transitionTurn(
      fixture.projectId, session.id, turn.id, running.turn.revision, running.session.revision,
      { state: 'exited', exitCode: 0, cleanupVerified: true },
    );

    assert.equal(exited.turn.state, 'exited');

    turnIds.push(turn.id);

    for (let sequence = 1; sequence <= entryCountPerTurn + 1; sequence++) {
      if (sequence === sequenceHole) continue;

      if (sequence % 2 === 1) {
        database.agentSessionTranscripts.appendSanitizedTerminalChunk({
          projectId: fixture.projectId,
          sessionId: session.id,
          turnId: turn.id,
          sequence,
          sanitizedTextFromTrustedPtyHost: `CI fixture terminal ${tag} run ${ordinal} entry ${sequence}\n`,
        });
      } else {
        const text = sequence === 122
          ? `CI fixture structured ${tag} run ${ordinal}: fixture search anchor`
          : sequence === 4
            ? `CI fixture provider error ${secret} was masked before persistence`
            : `CI fixture structured ${tag} run ${ordinal} entry ${sequence}`;

        database.agentSessionTranscripts.appendStructuredLog({
          projectId: fixture.projectId,
          sessionId: session.id,
          turnId: turn.id,
          sequence,
          text,
          severity: sequence === 4 ? 'error' : sequence % 6 === 0 ? 'warning' : 'info',
          source: sequence === 4 ? 'provider' : sequence % 4 === 0 ? 'host' : 'workspace',
          trustedKnownSecrets: sequence === 4 ? [secret] : [],
        });
      }
    }
  }

  return {
    secret,
    receipt: {
      fixtureOnly: true,
      historyUiFixture: true,
      providerExecuted: false,
      ptyExecuted: false,
      source: 'Isolated CI-profile SQLite transcript-store fixture',
      proofLimit: 'Persisted synthetic history for UI verification; not evidence of provider execution or a real PTY session.',
      projectId: fixture.projectId,
      sessionId: session.id,
      name,
      model,
      turnIds,
      entryCountPerTurn,
      pageSize: 100,
      explicitSequenceHole: { missingSequence: sequenceHole, afterSequence: sequenceHole - 1, beforeSequence: sequenceHole + 1 },
      secretMaskedBeforeDisk: true,
      copyExport: 'Not exercised by native smoke; clipboard and save-dialog transfer remain unverified here.',
    },
  };
}

async function seedChangeEvidence(database, fixture, projectFolder, tag, computeChangeHunks) {
  const name = `CI 변경 evidence fixture ${tag}`;
  const folderPath = path.join(projectFolder, `ci-change-evidence-${tag}`);
  await mkdir(folderPath, { recursive: true });

  const binding = database.createFolderBinding({ projectId: fixture.projectId, path: folderPath });

  const session = database.agentSessions.createSession({
    projectId: fixture.projectId,
    bindingId: binding.id,
    name,
    provider: 'codex',
    model: 'ci-fixture-not-executed',
    profileRef: 'ci-change-evidence-fixture-only',
    workspaceMode: 'sharedFolder',
  });

  const folder = await statFolder(folderPath);

  const conventionMarkdown = `# CI fixture rule ${tag}\n\nThis fixture-only rule is pinned to the synthetic turn. No provider was run.\n`;

  const convention = database.knowledge.createConventionVersion({
    projectId: fixture.projectId,
    markdown: conventionMarkdown,
    sourceSnapshotIds: [],
    authoredBy: 'person',
  });

  const conventionCitation = {
    kind: 'convention',
    id: convention.id,
    version: convention.version,
    sha256: createHash('sha256').update(conventionMarkdown, 'utf8').digest('hex'),
  };

  const scope = { projectId: fixture.projectId, sessionId: session.id };

  const workflowCountBefore = database.agentWorkflows.listWorkflows(fixture.projectId).workflows.length;

  const currentSession = database.agentSessions.getSession(fixture.projectId, session.id);

  const turnSnapshot = {
    schemaVersion: 1,
    projectId: fixture.projectId,
    sessionId: session.id,
    sessionRevision: currentSession.revision,
    bindingId: binding.id,
    taskId: null,
    provider: 'codex',
    model: session.model,
    profileRef: session.profileRef,
    cwd: folder.canonicalPath,
    folderIdentity: { canonicalPath: folder.canonicalPath, dev: folder.dev, ino: folder.ino },
    managedWorktreeOwnerId: null,
    permissionPolicy: { mode: 'read-only', approval: 'never' },
    convention: { id: convention.id, version: convention.version, sha256: conventionCitation.sha256 },
    references: [],
  };

  const turn = database.agentSessionTurns.createTurn({
    projectId: fixture.projectId,
    sessionId: session.id,
    expectedSessionRevision: currentSession.revision,
    snapshot: turnSnapshot,
  });

  const turnScope = { ...scope, turnId: turn.id };

  await writeFile(path.join(folderPath, 'edited.txt'), `before ${tag}\n`, 'utf8');
  await writeFile(path.join(folderPath, 'deleted.txt'), `remove ${tag}\n`, 'utf8');
  await writeFile(path.join(folderPath, 'binary.dat'), Buffer.from([0, 1, 2, 255]));

  const before = await readChangeEvidenceSnapshot(folderPath, folder);

  database.agentSessionContents.recordBaseline({ scope: turnScope, snapshot: before, revision: null });

  const startingSession = database.agentSessions.getSession(fixture.projectId, session.id);

  const running = database.agentSessionTurns.transitionTurn(
    fixture.projectId, session.id, turn.id, turn.revision, startingSession.revision, { state: 'running' },
  );

  await writeFile(path.join(folderPath, 'edited.txt'), `after ${tag}\n`, 'utf8');
  await rm(path.join(folderPath, 'deleted.txt'));
  await writeFile(path.join(folderPath, 'created-empty.txt'), '', 'utf8');
  await writeFile(path.join(folderPath, 'binary.dat'), Buffer.from([0, 9, 8, 255]));

  const after = await readChangeEvidenceSnapshot(folderPath, folder);

  const final = database.agentSessionContents.recordAfter({
    scope: turnScope,
    snapshot: after,
    expectedLatestVersion: 0,
    revision: null,
    cleanupVerified: true,
  });

  const exited = database.agentSessionTurns.transitionTurn(
    fixture.projectId, session.id, turn.id, running.turn.revision, running.session.revision,
    { state: 'exited', exitCode: 0, cleanupVerified: true },
  );

  assert.equal(exited.turn.state, 'exited');

  const retainedEdit = database.agentSessionContents.getFile({ scope: turnScope, evidenceVersion: final.evidenceVersion, path: 'edited.txt' });
  assert.equal(retainedEdit?.before.state, 'text');
  assert.equal(retainedEdit?.after.state, 'text');
  assert.equal(retainedEdit.before.file.content, `before ${tag}\n`);
  assert.equal(retainedEdit.after.file.content, `after ${tag}\n`);
  await writeFile(path.join(folderPath, 'edited.txt'), `later filesystem value ${tag}\n`, 'utf8');

  const reopenedEdit = database.agentSessionContents.getFile({ scope: turnScope, evidenceVersion: final.evidenceVersion, path: 'edited.txt' });
  assert.equal(reopenedEdit?.after.state, 'text');
  assert.equal(reopenedEdit.after.file.content, `after ${tag}\n`, 'The persisted diff must not reread the changed fixture folder');

  const immutableEvidence = database.agentSessionChangeEvidence.getLatest(fixture.projectId, session.id, turn.id);

  assert.ok(immutableEvidence, 'The content-store capture must produce its immutable change-evidence record');

  assert.equal(immutableEvidence.version, final.evidenceVersion, 'The immutable change evidence must match the content capture version');

  assert.equal(reopenedEdit.evidenceFingerprint, immutableEvidence.fingerprint, 'The retained file metadata must bind to the immutable change-evidence fingerprint');

  const retainedEmptyFile = database.agentSessionContents.getFile({ scope: turnScope, evidenceVersion: final.evidenceVersion, path: 'created-empty.txt' });
  assert.equal(retainedEmptyFile?.before.state, 'absent');
  assert.equal(retainedEmptyFile?.after.state, 'text');
  assert.equal(retainedEmptyFile.after.file.content, '', 'A created zero-byte file must remain distinguishable from unavailable content');

  const retainedDeletedFile = database.agentSessionContents.getFile({ scope: turnScope, evidenceVersion: final.evidenceVersion, path: 'deleted.txt' });
  assert.equal(retainedDeletedFile?.before.state, 'text');
  assert.equal(retainedDeletedFile.before.file.content, `remove ${tag}\n`);
  assert.equal(retainedDeletedFile?.after.state, 'absent');

  const hunkFile = file => ({
    ...file,
    before: file.before.state === 'text'
      ? { state: 'text', file: (({ path, kind, size, sha256, content }) => ({ path, kind, size, sha256, content }))(file.before.file) }
      : file.before,
    after: file.after.state === 'text'
      ? { state: 'text', file: (({ path, kind, size, sha256, content }) => ({ path, kind, size, sha256, content }))(file.after.file) }
      : file.after,
  });

  const editedHunks = computeChangeHunks(hunkFile(retainedEdit));

  assert.equal(editedHunks.status, 'hunks', 'The retained real-file modification must produce a selectable change hunk');

  assert.equal(editedHunks.hunks.length, 1, 'The focused fixture edit must produce one stable hunk');

  const reviewTarget = {
    ...turnScope,
    evidenceVersion: final.evidenceVersion,
    evidenceFingerprint: immutableEvidence.fingerprint,
    path: 'edited.txt',
    hunkId: editedHunks.hunks[0].id,
  };

  const seededExplanationRevisions = 51;

  for (let revision = 0; revision < seededExplanationRevisions; revision++) {
    database.agentSessionReviews.recordAgentExplanation({
      target: reviewTarget,
      authorTurnId: turn.id,
      expectedLatestRevision: revision,
      what: `Fixture explanation ${revision + 1}: the retained text changed.`,
      why: 'Synthetic native UI history only; no model or provider was executed.',
      citations: [conventionCitation],
      checkClaims: [{ label: 'CI fixture command', outcome: 'notRun', detail: 'No command was executed for this reported fixture claim.' }],
    });
  }

  return {
    receipt: {
      fixtureOnly: true,
      providerExecuted: false,
      ptyExecuted: false,
      source: 'Isolated CI-profile SQLite content-store fixture built from real disposable files',
      proofLimit: 'Verifies retained before/after file evidence and the native UI only; it does not prove provider execution or authorship.',
      projectId: fixture.projectId,
      sessionId: session.id,
      turnId: turn.id,
      name,
      folderPath,
      evidenceVersion: final.evidenceVersion,
      fingerprint: immutableEvidence.fingerprint,
      changedPaths: ['binary.dat', 'created-empty.txt', 'deleted.txt', 'edited.txt'],
      editedBefore: `before ${tag}\n`,
      editedAfter: `after ${tag}\n`,
      postCaptureMutation: `later filesystem value ${tag}\n`,
      conventionCitation,
      reviewTarget,
      seededExplanationRevisions,
      seededTaskState: database.getTask(fixture.taskId)?.state,
      workflowCountBefore,
    },
  };
}

async function readChangeEvidenceSnapshot(folderPath, folderIdentity) {
  const names = (await Array.fromAsync(await opendir(folderPath), entry => entry.name)).filter(name => name !== '.git').sort(compareCodeUnits);

  const entries = [];
  let fileBytes = 0;
  let retainedTextBytes = 0;
  let retainedBinaryBytes = 0;
  let contentReadCount = 0;
  let hasUnavailableContent = false;

  for (const name of names) {
    const filePath = path.join(folderPath, name);
    const bytes = await readFile(filePath);

    const info = await stat(filePath);
    assert.ok(info.isFile(), 'The evidence fixture contains only regular files');
    fileBytes += bytes.byteLength;
    contentReadCount++;
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    if (bytes.includes(0)) {
      entries.push({ path: name, kind: 'file', size: bytes.byteLength, sha256, executable: Boolean(info.mode & 0o111), rawBytesBase64: bytes.toString('base64'), contentUnavailableReason: 'binary' });
      retainedBinaryBytes += bytes.byteLength;
      hasUnavailableContent = true;
    } else {
      const content = bytes.toString('utf8');
      entries.push({ path: name, kind: 'file', size: bytes.byteLength, sha256, executable: Boolean(info.mode & 0o111), content });
      retainedTextBytes += bytes.byteLength;
    }
  }

  return {
    schemaVersion: 2,
    folderIdentity: { canonicalPath: folderIdentity.canonicalPath, dev: folderIdentity.dev, ino: folderIdentity.ino },
    capturedAt: new Date().toISOString(),
    inventoryCoverage: 'complete',
    contentCoverage: hasUnavailableContent ? 'partial' : 'complete',
    entryCount: entries.length,
    fileBytes,
    retainedTextBytes,
    retainedBinaryBytes,
    contentReadCount,
    entries,
  };
}

async function seedReviewedCommit(database, fixture, projectFolder, userData, tag, WorktreeService, options = {}) {
  const repository = options.repository ?? path.join(projectFolder, `ci-reviewed-commit-${tag}`);

  await mkdir(repository, { recursive: true });

  const git = async (...args) => (await execFileAsync('git', ['-C', repository, ...args], { maxBuffer: 1024 * 1024 })).stdout.trim();

  if (!options.repository) {
    await git('init', '-q', '-b', 'user-work');
    await git('config', 'user.name', 'CI reviewed commit fixture');
    await git('config', 'user.email', 'reviewed-commit@example.invalid');
    await writeFile(path.join(repository, 'selected.txt'), `before ${tag}\n`);
    await writeFile(path.join(repository, 'unselected.txt'), `unselected base ${tag}\n`);
    await git('add', '--', 'selected.txt', 'unselected.txt');
    await git('commit', '-qm', 'CI fixture source');
  }

  const sourceHead = await git('rev-parse', 'HEAD');

  const originalIndexSha256 = createHash('sha256').update(await readFile(path.join(repository, '.git', 'index'))).digest('hex');

  const originalSelected = await readFile(path.join(repository, 'selected.txt'), 'utf8');

  const originalUnselected = await readFile(path.join(repository, 'unselected.txt'), 'utf8');

  const bindingId = options.bindingId ?? database.createFolderBinding({ projectId: fixture.projectId, path: repository, vcsKind: 'git', vcsRoot: repository }).id;

  const session = database.agentSessions.createSession({
    projectId: fixture.projectId, bindingId, name: `CI 커밋 검수 fixture ${tag}`,
    provider: 'codex', model: 'ci-fixture-not-executed', profileRef: 'ci-commit-fixture-only', workspaceMode: 'gitWorktree',
  });

  const worktrees = new WorktreeService(path.join(userData, 'agent-sessions'));

  const managedRoot = path.join(await realpath(path.join(userData, 'agent-sessions')), 'managed-worktrees');

  const managed = await worktrees.create({ repositoryPath: repository, ownerId: session.id, kind: 'session', baseRef: 'HEAD' });

  const folder = await statFolder(managed.worktreePath);

  const folderIdentity = { canonicalPath: folder.canonicalPath, dev: folder.dev, ino: folder.ino };

  const turn = database.agentSessionTurns.createTurn({
    projectId: fixture.projectId, sessionId: session.id, expectedSessionRevision: session.revision,
    snapshot: {
      schemaVersion: 1, projectId: fixture.projectId, sessionId: session.id, sessionRevision: session.revision,
      bindingId, taskId: null, provider: session.provider, model: session.model, profileRef: session.profileRef,
      cwd: managed.worktreePath, folderIdentity, managedWorktreeOwnerId: session.id,
      permissionPolicy: { mode: 'read-only', approval: 'never' }, convention: null, references: [],
    },
  });

  const scope = { projectId: fixture.projectId, sessionId: session.id, turnId: turn.id };

  const before = await readChangeEvidenceSnapshot(managed.worktreePath, folder);

  database.agentSessionContents.recordBaseline({ scope, snapshot: before, revision: sourceHead });

  const startingSession = database.agentSessions.getSession(fixture.projectId, session.id);

  const running = database.agentSessionTurns.transitionTurn(fixture.projectId, session.id, turn.id, turn.revision, startingSession.revision, { state: 'running' });

  const retainedAfter = options.retainedAfter ?? `reviewed after ${tag}\n`;

  await writeFile(path.join(managed.worktreePath, 'selected.txt'), retainedAfter);
  await writeFile(path.join(managed.worktreePath, 'unselected.txt'), `unselected observed ${tag}\n`);

  const after = await readChangeEvidenceSnapshot(managed.worktreePath, folder);

  const finalContent = database.agentSessionContents.recordAfter({ scope, snapshot: after, expectedLatestVersion: 0, revision: sourceHead, cleanupVerified: true });

  const immutableEvidence = database.agentSessionChangeEvidence.getLatest(fixture.projectId, session.id, turn.id);

  assert.ok(immutableEvidence, 'The retained reviewed commit content must produce its immutable change-evidence record');

  assert.equal(immutableEvidence.version, finalContent.evidenceVersion, 'The reviewed commit evidence must match its content capture version');

  database.agentSessionTurns.transitionTurn(fixture.projectId, session.id, turn.id, running.turn.revision, running.session.revision, { state: 'exited', exitCode: 0, cleanupVerified: true });

  const completedSession = database.agentSessions.getSession(fixture.projectId, session.id);

  assert.ok(completedSession, 'The successful fixture turn must retain its project session.');

  assert.equal(completedSession.state, 'idle', 'The session returns to idle after its successful turn exits; exited is the turn state.');

  const explanation = database.agentSessionReviews.recordHumanExplanation({
    target: { ...scope, evidenceVersion: finalContent.evidenceVersion, evidenceFingerprint: immutableEvidence.fingerprint, path: 'selected.txt', hunkId: null },
    expectedLatestRevision: 0, what: '검수용 파일의 보존된 내용을 변경합니다.', why: '선택한 파일만 커밋하는 실제 앱 경로를 확인하는 CI 자료입니다.',
    citations: [], checkClaims: [{ label: '제공자 실행', outcome: 'notRun', detail: '이 fixture는 AI 제공자를 실행하지 않습니다.' }], status: 'confirmed',
  });

  const laterSelected = `later selected filesystem edit ${tag}\n`;

  const laterUnselected = `later unselected filesystem edit ${tag}\n`;

  await writeFile(path.join(managed.worktreePath, 'selected.txt'), laterSelected);
  await writeFile(path.join(managed.worktreePath, 'unselected.txt'), laterUnselected);

  return {
    fixtureOnly: true, providerExecuted: false, ptyExecuted: false, nativeHumanApprovalExercised: false,
    proofLimit: 'Actual disposable Git and retained-file application path; any approval seeded by this fixture is synthetic and does not prove native human confirmation.',
    ...scope, name: session.name, provider: session.provider, model: session.model, workspaceMode: session.workspaceMode,
    repository, bindingId, worktreePath: managed.worktreePath, managedRoot, sourceHead, originalIndexSha256, originalSelected, originalUnselected,
    evidenceVersion: immutableEvidence.version, fingerprint: immutableEvidence.fingerprint, explanationRevision: explanation.revision,
    retainedAfter, laterSelected, laterUnselected, unselectedBase: originalUnselected, commitMessage: `CI reviewed selected content ${tag}`,
  };
}

async function openReviewedCommitChanges(page, fixture, reviewedCommit = fixture.reviewedCommit) {
  const workspace = await openSessionWorkspace(page);

  await workspace.locator('.ai-session__session-row').getByText(reviewedCommit.name, { exact: true }).click();
  await workspace.getByRole('heading', { name: reviewedCommit.name, exact: true }).waitFor();
  await workspace.getByRole('tab', { name: '변경', exact: true }).click();

  const panel = workspace.locator('.ai-session__changes-panel');

  assert.equal(await panel.getByRole('combobox', { name: '변경을 확인할 실행 기록', exact: true }).inputValue(), reviewedCommit.turnId);

  const changes = panel.locator('.ai-session-changes');

  await changes.getByText(`v${reviewedCommit.evidenceVersion} · ${reviewedCommit.fingerprint}`, { exact: true }).waitFor();

  return changes;
}

async function verifyReviewedCommitProposal(page, fixture, tag, screenshots, viewports, reviewedCommit = fixture.reviewedCommit) {
  const changes = await openReviewedCommitChanges(page, fixture, reviewedCommit);

  const selected = changes.getByRole('checkbox', { name: 'selected.txt 커밋 검토에 포함', exact: true });

  const unselected = changes.getByRole('checkbox', { name: 'unselected.txt 커밋 검토에 포함', exact: true });

  assert.equal(await selected.isChecked(), false, 'Commit file selection must be explicit');
  assert.equal(await unselected.isChecked(), false);
  await selected.check();

  const explanations = changes.getByRole('combobox', { name: 'selected.txt에 연결할 파일 설명 기록', exact: true });

  await explanations.waitFor();
  await explanations.selectOption(String(reviewedCommit.explanationRevision));
  await changes.getByRole('textbox', { name: '커밋 메시지', exact: true }).fill(reviewedCommit.commitMessage);
  await changes.getByRole('button', { name: '커밋 제안 만들기', exact: true }).click();
  await changes.getByRole('heading', { name: '제안 v1 검토', exact: true }).waitFor();

  const pinned = changes.getByRole('list', { name: '제안에 고정된 파일과 설명', exact: true });

  assert.ok((await pinned.innerText()).includes('selected.txt'));
  assert.ok(!(await pinned.innerText()).includes('unselected.txt'), 'The proposal must include only the explicitly selected path');
  assert.equal(await changes.getByRole('button', { name: '승인한 커밋 적용', exact: true }).isDisabled(), true, 'Reviewing a proposal must not grant approval');
  await changes.getByRole('button', { name: '커밋 제안 승인', exact: true }).scrollIntoViewIfNeeded();

  const screenshot = path.join(output, `ai-session-commit-proposal-${tag}-1440.png`);

  await capturePage(page, screenshot);
  screenshots.push(screenshot);
  viewports.push({ theme: tag, state: 'commit-proposal-before-approval', width: 1440, height: 900, screenshot });
  reviewedCommit.proposalCreatedThroughUi = true;
}

async function verifyReviewedCommitApply(page, fixture, tag, screenshots, viewports, reviewedCommit = fixture.reviewedCommit) {
  const changes = await openReviewedCommitChanges(page, fixture, reviewedCommit);

  await changes.getByRole('heading', { name: '제안 v1 검토', exact: true }).waitFor();
  await changes.getByText(`제안 ID ${reviewedCommit.proposalId} · 지문 ${reviewedCommit.proposalFingerprint}`, { exact: true }).waitFor();

  const apply = changes.getByRole('button', { name: '승인한 커밋 적용', exact: true });

  assert.equal(await apply.isDisabled(), false, 'The restarted app must load the isolated fixture approval');
  await apply.click();
  await changes.getByText('보관된 제안이 적용되었습니다. 병합이나 PR은 생성되지 않았습니다.', { exact: true }).waitFor();
  assert.equal(await apply.isDisabled(), true, 'A successful proposal must not offer another apply');
  await apply.scrollIntoViewIfNeeded();

  const screenshot = path.join(output, `ai-session-commit-applied-${tag}-1440.png`);

  await capturePage(page, screenshot);
  screenshots.push(screenshot);
  viewports.push({ theme: tag, state: 'commit-applied-with-fixture-only-approval', width: 1440, height: 900, screenshot });
  await page.setViewportSize({ width: 760, height: 820 });
  await page.waitForFunction(() => window.innerWidth === 760);
  await apply.scrollIntoViewIfNeeded();

  const layout = await changes.evaluate(element => {
    const action = [...element.querySelectorAll('button')].find(button => button.textContent?.trim() === '승인한 커밋 적용');
    const bounds = action?.getBoundingClientRect();
    const container = element.getBoundingClientRect();

    const overflowingElements = [...element.querySelectorAll('*')].flatMap(child => {
      if (child.getClientRects().length === 0) return [];

      const rect = child.getBoundingClientRect();

      if (rect.left >= container.left - 1 && rect.right <= container.right + 1) return [];

      const style = getComputedStyle(child);

      return [{ tag: child.tagName, className: String(child.className), left: rect.left, right: rect.right, width: rect.width,
        clientWidth: child.clientWidth, scrollWidth: child.scrollWidth, boxSizing: style.boxSizing, minWidth: style.minWidth, whiteSpace: style.whiteSpace }];
    }).slice(0, 20);

    return {
      overflow: element.scrollWidth > element.clientWidth + 1,
      clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, overflowingElements,
      actionReachable: !!bounds && bounds.width > 0 && bounds.left >= -1 && bounds.right <= window.innerWidth + 1
        && bounds.top >= -1 && bounds.bottom <= window.innerHeight + 1,
    };
  });

  viewports.push({ theme: tag, state: 'commit-review-layout', width: 760, height: 820, layout });
  assert.equal(layout.overflow, false, `Commit review must not overflow horizontally at ${tag}/760: ${JSON.stringify(layout)}`);
  assert.equal(layout.actionReachable, true, `The commit action must remain reachable at ${tag}/760`);

  const narrow = path.join(output, `ai-session-commit-applied-${tag}-760.png`);

  await capturePage(page, narrow);
  screenshots.push(narrow);
  viewports.push({ theme: tag, state: 'commit-applied-narrow', width: 760, height: 820, screenshot: narrow, layout });
}

async function verifyReviewedCommitResult(database, fixture, receipt = fixture.reviewedCommit) {

  const proposal = database.agentSessionIntegrations.getProposal(receipt.proposalId);

  assert.equal(proposal.state, 'succeeded', 'The actual app apply must persist successful Git receipt');
  assert.equal(proposal.fingerprint, receipt.proposalFingerprint);

  const outcome = proposal.outcomes.at(-1);

  assert.equal(outcome.state, 'succeeded');
  assert.equal(outcome.receipt.resultingHead, outcome.receipt.candidateHead);
  assert.deepEqual(outcome.receipt.changedPaths, ['selected.txt']);

  const git = async (cwd, ...args) => (await execFileAsync('git', ['-C', cwd, ...args], { maxBuffer: 1024 * 1024 })).stdout;

  const candidate = outcome.receipt.candidateHead;

  assert.equal((await git(receipt.worktreePath, 'rev-parse', 'HEAD')).trim(), candidate);
  assert.equal((await git(receipt.worktreePath, 'rev-parse', `${candidate}^`)).trim(), receipt.sourceHead);
  assert.equal(await git(receipt.worktreePath, 'show', `${candidate}:selected.txt`), receipt.retainedAfter, 'The commit must use retained bytes, never later filesystem bytes');
  assert.equal(await git(receipt.worktreePath, 'show', `${candidate}:unselected.txt`), receipt.unselectedBase);
  assert.equal(await readFile(path.join(receipt.worktreePath, 'selected.txt'), 'utf8'), receipt.laterSelected);
  assert.equal(await readFile(path.join(receipt.worktreePath, 'unselected.txt'), 'utf8'), receipt.laterUnselected);
  assert.equal((await git(receipt.repository, 'rev-parse', 'HEAD')).trim(), receipt.sourceHead);
  assert.equal((await git(receipt.repository, 'rev-parse', `refs/heads/bugfixer/session/${receipt.sessionId}`)).trim(), candidate, 'The committed source branch must advance without moving the user checkout');
  assert.equal(createHash('sha256').update(await readFile(path.join(receipt.repository, '.git', 'index'))).digest('hex'), receipt.originalIndexSha256);
  receipt.resultingHead = candidate;
  receipt.appliedThroughUi = true;
}

async function verifyReviewedMergeProposal(page, fixture, tag, screenshots, viewports, reviewedCommit = fixture.reviewedCommit) {
  const changes = await openReviewedCommitChanges(page, fixture, reviewedCommit);

  const review = changes.getByRole('region', { name: '로컬 병합 검토', exact: true });

  const prepare = review.getByRole('button', { name: '병합 제안 준비', exact: true });

  await prepare.waitFor();
  assert.equal(await prepare.isDisabled(), false);
  await prepare.click();
  await review.getByRole('heading', { name: '병합 제안 v1 검토', exact: true }).waitFor();

  const diff = review.getByLabel('보관된 전체 병합 diff', { exact: true });

  assert.ok((await diff.innerText()).includes(reviewedCommit.retainedAfter.trim()));
  assert.ok(!(await diff.innerText()).includes(reviewedCommit.laterSelected.trim()), 'Merge review must use the committed retained content');
  assert.equal(await review.getByRole('button', { name: '승인한 병합 적용', exact: true }).isDisabled(), true, 'A merge proposal never grants implicit approval');
  await diff.scrollIntoViewIfNeeded();

  const screenshot = path.join(output, `ai-session-merge-before-approval-${tag}-1440.png`);

  await capturePage(page, screenshot);
  screenshots.push(screenshot);
  viewports.push({ theme: tag, state: 'merge-proposal-before-approval', width: 1440, height: 900, screenshot });
}

async function verifyReviewedMergeApply(page, fixture, tag, screenshots, viewports) {
  const changes = await openReviewedCommitChanges(page, fixture);

  const review = changes.getByRole('region', { name: '로컬 병합 검토', exact: true });

  await review.getByText(`제안 ID ${fixture.reviewedMerge.proposalId} · 지문 ${fixture.reviewedMerge.fingerprint}`, { exact: true }).waitFor();

  const apply = review.getByRole('button', { name: '승인한 병합 적용', exact: true });

  assert.equal(await apply.isDisabled(), false, 'The restarted app must load the exact isolated merge approval');
  await apply.click();
  await review.getByText('병합 적용 상태: 병합 완료.', { exact: true }).waitFor();
  assert.equal(await apply.isDisabled(), true, 'A completed merge cannot be applied again');
  assert.ok((await review.innerText()).includes('이번 병합 작업 폴더'), 'The actual integration generation must be visible');
  await apply.scrollIntoViewIfNeeded();

  const screenshot = path.join(output, `ai-session-merge-applied-${tag}-1440.png`);

  await capturePage(page, screenshot);
  screenshots.push(screenshot);
  viewports.push({ theme: tag, state: 'merge-applied-with-fixture-only-approval', width: 1440, height: 900, screenshot });
  await page.setViewportSize({ width: 760, height: 820 });
  await page.waitForFunction(() => window.innerWidth === 760);
  await apply.scrollIntoViewIfNeeded();

  const layout = await review.evaluate(element => {
    const action = [...element.querySelectorAll('button')].find(button => button.textContent?.trim() === '승인한 병합 적용');
    const bounds = action?.getBoundingClientRect();

    return {
      overflow: element.scrollWidth > element.clientWidth + 1,
      actionReachable: !!bounds && bounds.width > 0 && bounds.left >= -1 && bounds.right <= window.innerWidth + 1
        && bounds.top >= -1 && bounds.bottom <= window.innerHeight + 1,
    };
  });

  assert.equal(layout.overflow, false, `Merge review must not overflow at ${tag}/760`);
  assert.equal(layout.actionReachable, true, `Merge apply must remain reachable at ${tag}/760`);

  const narrow = path.join(output, `ai-session-merge-applied-${tag}-760.png`);

  await capturePage(page, narrow);
  screenshots.push(narrow);
  viewports.push({ theme: tag, state: 'merge-applied-narrow', width: 760, height: 820, screenshot: narrow, layout });
}

async function verifyReviewedConflictMergeApply(page, fixture, tag, screenshots, viewports) {
  const commit = fixture.reviewedConflictCommit;
  const receipt = fixture.reviewedConflictMerge;
  const changes = await openReviewedCommitChanges(page, fixture, commit);
  const review = changes.getByRole('region', { name: '로컬 병합 검토', exact: true });

  await review.getByText(`제안 ID ${receipt.proposalId} · 지문 ${receipt.fingerprint}`, { exact: true }).waitFor();
  const apply = review.getByRole('button', { name: '승인한 병합 적용', exact: true });

  assert.equal(await apply.isDisabled(), false, 'The isolated fixture approval must authorize only this exact conflict proposal');
  await apply.click();
  await review.getByText('충돌 작업 폴더의 파일을 수정하고 Git에 스테이징한 뒤 새 제안을 준비하세요. 수정 결과 전체를 다시 검토하고 승인해야 적용됩니다.', { exact: true }).waitFor();
  assert.equal(await apply.isDisabled(), true, 'A conflict is terminal and cannot be applied again');
  assert.ok((await review.innerText()).includes('충돌 경로: selected.txt.'), 'The actual merge conflict must be visible');
  await review.scrollIntoViewIfNeeded();

  const screenshot = path.join(output, `ai-session-merge-conflict-${tag}-1440.png`);

  await capturePage(page, screenshot);
  screenshots.push(screenshot);
  viewports.push({ theme: tag, state: 'actual-merge-conflict-with-fixture-only-approval', width: 1440, height: 900, screenshot });
}

async function verifyReviewedConflictResult(database, fixture) {
  const receipt = fixture.reviewedConflictMerge;
  const proposal = database.agentSessionMerges.getProposal(receipt.proposalId);

  assert.equal(proposal.state, 'conflict');
  assert.equal(proposal.fingerprint, receipt.fingerprint);
  assert.equal(proposal.approval.actor, 'human');
  assert.equal(proposal.outcomes.at(-1).state, 'conflict');
  assert.deepEqual(proposal.outcomes.at(-1).receipt.conflictedPaths, ['selected.txt']);
  assert.equal(proposal.approval.proposalFingerprint, proposal.fingerprint);

  const intent = proposal.artifacts.find(item => item.event.phase === 'intent')?.event;
  const candidate = proposal.artifacts.find(item => item.event.phase === 'candidatePrepared')?.event;
  const registered = proposal.artifacts.find(item => item.event.phase === 'generationRegistered')?.event;
  const materialized = proposal.artifacts.find(item => item.event.phase === 'generationMaterialized')?.event;

  assert.ok(intent && candidate && registered && materialized, 'Conflict recovery requires the complete durable generation record');
  assert.equal(candidate.outcome, 'conflict');
  assert.equal(candidate.candidateCommitOid, null);
  assert.deepEqual(candidate.conflicts.map(item => item.path), ['selected.txt']);
  assert.equal(materialized.head, receipt.targetHead);
  assert.equal(materialized.conflictDigest, createHash('sha256').update(JSON.stringify(candidate.conflicts)).digest('hex'));
  assert.equal(proposal.artifacts.some(item => item.event.phase === 'published'), false, 'A conflict must not publish an integration ref');

  const relative = `integration-generations/${receipt.integrationOwnerId}/${intent.generationId}`;
  const generationDirectory = path.resolve(fixture.reviewedCommit.managedRoot, intent.generationPath);

  assert.equal(intent.generationPath, relative);
  assert.equal(path.relative(fixture.reviewedCommit.managedRoot, generationDirectory).split(path.sep).join('/'), relative);
  assert.equal(await realpath(generationDirectory), generationDirectory);
  assert.equal(registered.generationPath, intent.generationPath);
  assert.equal(registered.registrationId, intent.registrationId);

  const git = async (cwd, ...args) => (await execFileAsync('git', ['-C', cwd, ...args], { maxBuffer: 1024 * 1024 })).stdout;

  assert.equal((await git(generationDirectory, 'rev-parse', 'HEAD')).trim(), receipt.targetHead);
  assert.match(await git(generationDirectory, 'status', '--porcelain', '--untracked-files=all'), /^UU selected\.txt\n$/);
  assert.equal((await git(generationDirectory, 'ls-files', '-u', '--', 'selected.txt')).trim().split('\n').length, 3, 'The conflict generation must retain all three real index stages');
  const conflictText = await readFile(path.join(generationDirectory, 'selected.txt'), 'utf8');

  assert.ok(conflictText.includes('<<<<<<<'), 'The actual conflict worktree must be preserved for human resolution');
  const conflictUnselected = await readFile(path.join(generationDirectory, 'unselected.txt'), 'utf8');

  const originalGeneration = fixture.reviewedMerge.generationPath;

  assert.equal(await readFile(path.join(originalGeneration, 'selected.txt'), 'utf8'), fixture.reviewedCommit.retainedAfter, 'The earlier published generation must remain unchanged');
  const originalGitDirectory = (await git(originalGeneration, 'rev-parse', '--absolute-git-dir')).trim();
  assert.equal(createHash('sha256').update(await readFile(path.join(originalGitDirectory, 'index'))).digest('hex'), fixture.reviewedMerge.indexSha256);
  assert.equal((await git(fixture.reviewedCommit.repository, 'rev-parse', 'HEAD')).trim(), fixture.reviewedCommit.sourceHead, 'The user checkout HEAD must remain unchanged');
  assert.equal(createHash('sha256').update(await readFile(path.join(fixture.reviewedCommit.repository, '.git', 'index'))).digest('hex'), fixture.reviewedCommit.originalIndexSha256);
  assert.equal(await readFile(path.join(fixture.reviewedConflictCommit.worktreePath, 'selected.txt'), 'utf8'), fixture.reviewedConflictCommit.laterSelected, 'The dirty source worktree must remain unchanged');

  receipt.generationId = intent.generationId;
  receipt.operationId = proposal.outcomes.at(-1).receipt.operationId;
  receipt.registrationId = intent.registrationId;
  receipt.generationPath = generationDirectory;
  receipt.conflictUnselected = conflictUnselected;
  receipt.appliedThroughUi = true;
}

async function prepareReviewedConflictResolution(fixture) {
  const receipt = fixture.reviewedConflictMerge;
  const generationDirectory = receipt.generationPath;
  const git = async (...args) => (await execFileAsync('git', ['-C', generationDirectory, ...args], { maxBuffer: 1024 * 1024 })).stdout;
  const resolvedText = `human fixture resolution ${fixture.reviewedConflictCommit.sourceHead}\n`;

  await writeFile(path.join(generationDirectory, 'selected.txt'), resolvedText);
  await git('add', '--', 'selected.txt');

  const stagedPaths = (await git('diff', '--cached', '--name-only', '--')).trim().split('\n');

  assert.deepEqual(stagedPaths, ['selected.txt'], 'The human fixture must stage only the selected conflict path');
  assert.equal((await git('ls-files', '-u', '--', 'selected.txt')).trim(), '', 'The selected conflict must be resolved in the index');

  const gitDirectory = (await git('rev-parse', '--absolute-git-dir')).trim();
  const stagedTree = (await git('write-tree')).trim();
  const fullDiff = await git('diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', receipt.targetHead, stagedTree);
  const indexDigest = createHash('sha256').update(await git('ls-files', '--stage', '-z')).digest('hex');
  const treeDigest = createHash('sha256').update(await git('ls-tree', '-r', '-z', '--full-tree', stagedTree)).digest('hex');

  assert.equal((await git('rev-parse', 'HEAD')).trim(), receipt.targetHead, 'Manual staging must not advance the detached generation HEAD');
  assert.ok(fullDiff.includes(resolvedText.trim()));
  assert.equal((await git('status', '--porcelain', '--untracked-files=all')).trim(), 'M  selected.txt');

  const indexBytes = await readFile(path.join(gitDirectory, 'index'));

  const resolution = {
    actor: 'CI fixture human-resolution simulation; no AI provider was executed.',
    text: resolvedText,
    stagedIndexSha256: createHash('sha256').update(indexBytes).digest('hex'),
    stagedTree,
    fullDiff,
    fullDiffFingerprint: createHash('sha256').update(fullDiff).digest('hex'),
    indexDigest,
    treeDigest,
  };

  receipt.manualResolution = resolution;
}

async function verifyReviewedResolutionProposal(page, fixture, tag, screenshots, viewports) {
  const commit = fixture.reviewedConflictCommit;
  const resolution = fixture.reviewedConflictMerge.manualResolution;
  const changes = await openReviewedCommitChanges(page, fixture, commit);
  const review = changes.getByRole('region', { name: '로컬 병합 검토', exact: true });
  const prepare = review.getByRole('button', { name: '수정한 충돌 결과로 새 제안 준비', exact: true });

  await prepare.waitFor();
  assert.equal(await prepare.isDisabled(), false);
  await prepare.click();
  await review.getByRole('heading', { name: '충돌 해결 제안 v2 검토', exact: true }).waitFor();
  const diff = review.getByLabel('보관된 전체 충돌 해결 diff', { exact: true });
  const diffText = await diff.innerText();

  assert.ok(diffText.includes(fixture.reviewedCommit.retainedAfter.trim()), 'The resolution diff must include the current integration target content');
  assert.ok(diffText.includes(resolution.text.trim()), 'The resolution diff must include the retained human-staged resolution');
  assert.ok(!(diffText.includes(commit.laterSelected.trim())), 'The resolution proposal must use committed source bytes, not later worktree bytes');
  assert.equal(await review.getByRole('button', { name: '승인한 병합 적용', exact: true }).isDisabled(), true, 'The resolution proposal requires its own approval');
  assert.ok((await review.innerText()).includes(fixture.reviewedConflictMerge.proposalId), 'The resolution proposal must link its exact prior conflict');
  await diff.scrollIntoViewIfNeeded();

  const screenshot = path.join(output, `ai-session-merge-resolution-proposal-${tag}-1440.png`);

  await capturePage(page, screenshot);
  screenshots.push(screenshot);
  viewports.push({ theme: tag, state: 'resolution-proposal-before-fresh-approval', width: 1440, height: 900, screenshot });
  await page.setViewportSize({ width: 760, height: 820 });
  await page.waitForFunction(() => window.innerWidth === 760);
  await diff.scrollIntoViewIfNeeded();

  const narrowLayout = await review.evaluate(element => {
    const action = [...element.querySelectorAll('button')].find(button => button.textContent?.trim() === '승인한 병합 적용');
    const bounds = action?.getBoundingClientRect();

    return {
      overflow: element.scrollWidth > element.clientWidth + 1,
      actionReachable: !!bounds && bounds.width > 0 && bounds.left >= -1 && bounds.right <= window.innerWidth + 1
        && bounds.top >= -1 && bounds.bottom <= window.innerHeight + 1,
    };
  });

  assert.equal(narrowLayout.overflow, false, `Resolution proposal must not overflow at ${tag}/760`);
  assert.equal(narrowLayout.actionReachable, true, `Resolution apply action must remain visible at ${tag}/760`);
  const narrow = path.join(output, `ai-session-merge-resolution-proposal-${tag}-760.png`);

  await capturePage(page, narrow);
  screenshots.push(narrow);
  viewports.push({ theme: tag, state: 'resolution-proposal-before-fresh-approval-narrow', width: 760, height: 820, screenshot: narrow, layout: narrowLayout });
}

async function verifyReviewedResolutionApply(page, fixture, tag, screenshots, viewports) {
  const commit = fixture.reviewedConflictCommit;
  const receipt = fixture.reviewedResolutionMerge;
  const changes = await openReviewedCommitChanges(page, fixture, commit);
  const review = changes.getByRole('region', { name: '로컬 병합 검토', exact: true });

  await review.getByRole('heading', { name: '충돌 해결 제안 v2 검토', exact: true }).waitFor();
  await review.getByText(`제안 ID ${receipt.proposalId} · 지문 ${receipt.fingerprint}`, { exact: true }).waitFor();
  const apply = review.getByRole('button', { name: '승인한 병합 적용', exact: true });

  assert.equal(await apply.isDisabled(), false, 'The restarted app must load the exact new approval');
  await apply.click();
  await review.getByText('병합 적용 상태: 병합 완료.', { exact: true }).waitFor();
  assert.equal(await apply.isDisabled(), true);
  assert.ok((await review.innerText()).includes('충돌 해결 제안 v2 검토'));
  await apply.scrollIntoViewIfNeeded();

  const screenshot = path.join(output, `ai-session-merge-resolution-applied-${tag}-1440.png`);

  await capturePage(page, screenshot);
  screenshots.push(screenshot);
  viewports.push({ theme: tag, state: 'resolution-merge-applied-with-fresh-fixture-approval', width: 1440, height: 900, screenshot });
  await page.setViewportSize({ width: 760, height: 820 });
  await page.waitForFunction(() => window.innerWidth === 760);
  await apply.scrollIntoViewIfNeeded();

  const layout = await review.evaluate(element => {
    const action = [...element.querySelectorAll('button')].find(button => button.textContent?.trim() === '승인한 병합 적용');
    const bounds = action?.getBoundingClientRect();

    return {
      overflow: element.scrollWidth > element.clientWidth + 1,
      actionReachable: !!bounds && bounds.width > 0 && bounds.left >= -1 && bounds.right <= window.innerWidth + 1
        && bounds.top >= -1 && bounds.bottom <= window.innerHeight + 1,
    };
  });

  assert.equal(layout.overflow, false, `Applied resolution must not overflow at ${tag}/760`);
  assert.equal(layout.actionReachable, true, `Applied resolution action must remain reachable at ${tag}/760`);
  const narrow = path.join(output, `ai-session-merge-resolution-applied-${tag}-760.png`);

  await capturePage(page, narrow);
  screenshots.push(narrow);
  viewports.push({ theme: tag, state: 'resolution-merge-applied-narrow', width: 760, height: 820, screenshot: narrow, layout });
}

async function verifyReviewedMergeResult(database, fixture) {
  const receipt = fixture.reviewedMerge;

  const proposal = database.agentSessionMerges.getProposal(receipt.proposalId);

  assert.equal(proposal.state, 'merged');
  assert.equal(proposal.fingerprint, receipt.fingerprint);
  assert.deepEqual(proposal.author, receipt.author, 'The approved author date must survive restart');
  assert.deepEqual(proposal.committer, receipt.committer, 'The approved committer date must survive restart');

  const outcome = proposal.outcomes.at(-1);

  assert.equal(outcome.state, 'merged');
  assert.deepEqual(outcome.receipt.changedPaths, ['selected.txt']);
  assert.deepEqual(outcome.receipt.conflictedPaths, []);

  const intent = proposal.artifacts.find(item => item.event.phase === 'intent')?.event;

  const published = proposal.artifacts.find(item => item.event.phase === 'published')?.event;

  assert.ok(intent && published, 'Success requires durable generation and publication artifacts');
  assert.equal(published.resultingHead, outcome.receipt.resultingHead);
  assert.equal(published.currentGenerationId, intent.generationId);

  const expectedRelative = `integration-generations/${receipt.integrationOwnerId}/${intent.generationId}`;

  assert.equal(intent.generationPath, expectedRelative, 'The signed generation path must be scoped to this integration owner');

  const generationDirectory = path.resolve(fixture.reviewedCommit.managedRoot, intent.generationPath);

  assert.equal(path.relative(fixture.reviewedCommit.managedRoot, generationDirectory).split(path.sep).join('/'), expectedRelative);
  assert.equal(await realpath(generationDirectory), generationDirectory, 'The fixture must inspect the canonical owned generation');

  const git = async (cwd, ...args) => (await execFileAsync('git', ['-C', cwd, ...args], { maxBuffer: 1024 * 1024 })).stdout;

  const candidate = outcome.receipt.resultingHead;

  assert.equal((await git(generationDirectory, 'rev-parse', 'HEAD')).trim(), candidate);
  assert.equal((await git(generationDirectory, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), 'HEAD', 'Integration generations must remain detached');
  assert.equal((await git(generationDirectory, 'show', '-s', '--format=%P', candidate)).trim(), `${receipt.targetHead} ${receipt.sourceHead}`);
  assert.equal((await git(fixture.reviewedCommit.repository, 'rev-parse', `refs/heads/bugfixer/integration/${receipt.integrationOwnerId}`)).trim(), candidate);
  assert.equal(await readFile(path.join(generationDirectory, 'selected.txt'), 'utf8'), fixture.reviewedCommit.retainedAfter);
  assert.equal(await readFile(path.join(generationDirectory, 'unselected.txt'), 'utf8'), fixture.reviewedCommit.unselectedBase);
  assert.equal((await git(generationDirectory, 'status', '--porcelain', '--untracked-files=all')).trim(), '', 'The published generation files and index must match its candidate');
  const gitDirectory = (await git(generationDirectory, 'rev-parse', '--absolute-git-dir')).trim();
  receipt.indexSha256 = createHash('sha256').update(await readFile(path.join(gitDirectory, 'index'))).digest('hex');

  const commit = await git(generationDirectory, 'cat-file', 'commit', candidate);

  assert.ok(commit.includes(`\nauthor ${receipt.author.name} <${receipt.author.email}> ${receipt.author.date}\n`));
  assert.ok(commit.includes(`\ncommitter ${receipt.committer.name} <${receipt.committer.email}> ${receipt.committer.date}\n`));
  assert.ok(commit.endsWith(`\n\n${receipt.commitMessage}\n`));
  await verifyReviewedCommitResult(database, fixture);
  receipt.resultingHead = candidate;
  receipt.generationPath = generationDirectory;
  receipt.appliedThroughUi = true;
}

async function verifyReviewedResolutionResult(database, fixture) {
  const receipt = fixture.reviewedResolutionMerge;
  const proposal = database.agentSessionMerges.getProposal(receipt.proposalId);

  assert.equal(proposal.state, 'merged');
  assert.equal(proposal.fingerprint, receipt.fingerprint);
  assert.deepEqual(proposal.author, receipt.author);
  assert.deepEqual(proposal.committer, receipt.committer);
  assert.equal(proposal.approval?.actor, 'human');
  assert.equal(proposal.approval?.proposalFingerprint, receipt.fingerprint);
  assert.equal(proposal.resolution.proposalId, fixture.reviewedConflictMerge.proposalId);
  assert.equal(proposal.resolution.operationId, fixture.reviewedConflictMerge.operationId);
  assert.equal(proposal.resolution.generationId, fixture.reviewedConflictMerge.generationId);
  assert.equal(proposal.resolution.registrationId, fixture.reviewedConflictMerge.registrationId);
  assert.equal(proposal.resolution.treeOid, fixture.reviewedConflictMerge.manualResolution.stagedTree);
  assert.equal(proposal.resolution.indexFileDigest, fixture.reviewedConflictMerge.manualResolution.stagedIndexSha256);
  assert.equal(proposal.resolution.indexDigest, fixture.reviewedConflictMerge.manualResolution.indexDigest);
  assert.equal(proposal.resolution.treeDigest, fixture.reviewedConflictMerge.manualResolution.treeDigest);
  const priorConflict = database.agentSessionMerges.getProposal(fixture.reviewedConflictMerge.proposalId);

  assert.equal(priorConflict.state, 'conflict');
  assert.equal(priorConflict.approval?.actor, 'human');
  assert.equal(priorConflict.approval?.proposalFingerprint, priorConflict.fingerprint, 'The old approval must remain scoped to its original conflict');

  const outcome = proposal.outcomes.at(-1);
  const intent = proposal.artifacts.find(item => item.event.phase === 'intent')?.event;
  const published = proposal.artifacts.find(item => item.event.phase === 'published')?.event;

  assert.equal(outcome.state, 'merged');
  assert.deepEqual(outcome.receipt.changedPaths, ['selected.txt']);
  assert.deepEqual(outcome.receipt.conflictedPaths, []);
  assert.ok(intent && published);
  assert.equal(published.resultingHead, outcome.receipt.resultingHead);
  assert.equal(published.currentGenerationId, intent.generationId);
  assert.equal(published.priorGenerationId, fixture.reviewedConflictMerge.generationId);
  const relative = `integration-generations/${receipt.integrationOwnerId}/${intent.generationId}`;
  const generationDirectory = path.resolve(fixture.reviewedCommit.managedRoot, intent.generationPath);

  assert.equal(intent.generationPath, relative);
  assert.equal(path.relative(fixture.reviewedCommit.managedRoot, generationDirectory).split(path.sep).join('/'), relative);
  assert.equal(await realpath(generationDirectory), generationDirectory);
  assert.notEqual(generationDirectory, fixture.reviewedConflictMerge.generationPath, 'Resolution must publish a new detached generation');

  const git = async (cwd, ...args) => (await execFileAsync('git', ['-C', cwd, ...args], { maxBuffer: 1024 * 1024 })).stdout;
  const candidate = outcome.receipt.resultingHead;

  assert.equal((await git(generationDirectory, 'rev-parse', 'HEAD')).trim(), candidate);
  assert.equal((await git(generationDirectory, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), 'HEAD');
  assert.equal((await git(generationDirectory, 'show', '-s', '--format=%P', candidate)).trim(), `${receipt.targetHead} ${receipt.sourceHead}`);
  assert.equal((await git(fixture.reviewedCommit.repository, 'rev-parse', `refs/heads/bugfixer/integration/${receipt.integrationOwnerId}`)).trim(), candidate);
  assert.equal(await readFile(path.join(generationDirectory, 'selected.txt'), 'utf8'), fixture.reviewedConflictMerge.manualResolution.text);
  assert.equal(await readFile(path.join(generationDirectory, 'unselected.txt'), 'utf8'), fixture.reviewedCommit.unselectedBase);
  assert.equal((await git(generationDirectory, 'status', '--porcelain', '--untracked-files=all')).trim(), '', 'Published generation index and files must be clean');

  const oldConflictGitDir = (await git(fixture.reviewedConflictMerge.generationPath, 'rev-parse', '--absolute-git-dir')).trim();

  assert.equal(await readFile(path.join(fixture.reviewedConflictMerge.generationPath, 'selected.txt'), 'utf8'), fixture.reviewedConflictMerge.manualResolution.text, 'The resolved conflict file must remain byte-for-byte unchanged after publication');
  assert.equal(await readFile(path.join(fixture.reviewedConflictMerge.generationPath, 'unselected.txt'), 'utf8'), fixture.reviewedConflictMerge.conflictUnselected);
  assert.equal(createHash('sha256').update(await readFile(path.join(oldConflictGitDir, 'index'))).digest('hex'), fixture.reviewedConflictMerge.manualResolution.stagedIndexSha256);
  assert.equal(createHash('sha256').update(await readFile(path.join(fixture.reviewedCommit.repository, '.git', 'index'))).digest('hex'), fixture.reviewedCommit.originalIndexSha256);
  assert.equal((await git(fixture.reviewedCommit.repository, 'rev-parse', 'HEAD')).trim(), fixture.reviewedCommit.sourceHead);
  assert.equal(await readFile(path.join(fixture.reviewedConflictCommit.worktreePath, 'selected.txt'), 'utf8'), fixture.reviewedConflictCommit.laterSelected);
  assert.equal(await readFile(path.join(fixture.reviewedConflictCommit.worktreePath, 'unselected.txt'), 'utf8'), fixture.reviewedConflictCommit.laterUnselected);

  const commit = await git(generationDirectory, 'cat-file', 'commit', candidate);

  assert.ok(commit.includes(`\nauthor ${receipt.author.name} <${receipt.author.email}> ${receipt.author.date}\n`));
  assert.ok(commit.includes(`\ncommitter ${receipt.committer.name} <${receipt.committer.email}> ${receipt.committer.date}\n`));
  assert.ok(commit.endsWith(`\n\n${receipt.commitMessage}\n`));
  receipt.resultingHead = candidate;
  receipt.generationId = intent.generationId;
  receipt.generationPath = generationDirectory;
  receipt.appliedThroughUi = true;
}

async function seedReviewedPublication(database, fixture) {
  const merge = database.agentSessionMerges.getProposal(fixture.reviewedMerge.proposalId);
  assert.ok(merge && merge.state === 'merged', 'Publication fixture must use the successful persisted local merge');
  assert.equal(merge.fingerprint, fixture.reviewedMerge.fingerprint);
  const outcome = merge.outcomes.at(-1);
  const intent = merge.artifacts.find(item => item.event.phase === 'intent')?.event;
  assert.ok(outcome?.state === 'merged' && intent, 'Publication fixture requires the exact successful merge operation and generation');
  const sourceCommit = outcome.receipt.resultingHead;
  const baseCommit = merge.targetHead;
  const generationDirectory = path.resolve(fixture.reviewedCommit.managedRoot, intent.generationPath);
  assert.equal(await realpath(generationDirectory), generationDirectory, 'Publication diff reads only the canonical owned merge generation');

  const gitBuffer = async (...args) => {
    const { stdout } = await execFileAsync('git', ['-C', generationDirectory, ...args], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 });

    return Buffer.from(stdout);
  };

  const diffBytes = await gitBuffer('diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', baseCommit, sourceCommit, '--');
  const diffText = diffBytes.toString('utf8');
  assert.equal(Buffer.from(diffText, 'utf8').equals(diffBytes), true, 'The locally computed full diff must be canonical UTF-8');
  assert.equal(diffText.includes('\0'), false, 'The locally computed full diff must be NUL-free');
  const nameBytes = await gitBuffer('diff', '--name-status', '-z', '--no-ext-diff', '--no-textconv', '--no-renames', baseCommit, sourceCommit, '--');
  const nameFields = nameBytes.toString('utf8').split('\0');
  assert.equal(nameFields.pop(), '', 'The local diff path list must be NUL terminated');
  const pathStatuses = { A: 'added', M: 'modified', D: 'deleted', T: 'modified' };
  const paths = [];

  for (let index = 0; index < nameFields.length; index += 2) {
    const status = nameFields[index];
    const filePath = nameFields[index + 1];
    assert.ok(pathStatuses[status] && filePath, 'Publication diff path metadata must be complete and supported');
    paths.push({
      path: filePath,
      status: pathStatuses[status],
      previousPath: null,
      explanationReferences: [],
      checkReferences: [],
      unknowns: ['CI fixture에는 파일별 검토 근거와 검사 결과가 연결되지 않았습니다.'],
    });
  }

  assert.ok(paths.length > 0, 'A publication review fixture must show the actual merged Git changes');

  const remoteName = 'origin';
  const accountRef = 'ci-fixture-account-ref';
  const baseRef = 'refs/heads/main';
  const title = '[CI 전용] 로컬 병합 결과 검토 (외부 게시 없음)';
  const body = '격리된 CI SQLite의 표시용 fixture입니다. 문구는 합성된 에이전트 초안이며 실제 모델은 실행하지 않았습니다. GitHub 계정 조회, 네트워크 게시, 사람의 네이티브 승인은 수행하지 않았습니다.';
  const prTextScope = { projectId: merge.projectId, sessionId: merge.sessionId, targetTurnId: merge.turnId };

  const prTextRevision = database.agentSessionPrTexts.appendGeneratedRevision({
    scope: prTextScope,
    expectedRevision: 0,
    idempotencyKey: `ci-publication-text-${fixture.reviewedCommit.sessionId}`,
    source: { kind: 'liveAgentTurn', turnId: merge.turnId },
    sanitizedCompleteAgentText: { title, body },
    knownSecrets: [],
  });

  const textRevision = {
    scope: prTextScope,
    revision: prTextRevision.revision,
    contentHash: prTextRevision.content.contentHash,
  };

  const proposal = database.agentSessionPublications.createProposal({
    projectId: merge.projectId, sessionId: merge.sessionId, turnId: merge.turnId, sourceMergeId: merge.id,
    remoteName, baseRef, accountRef, title, body, expectedRevision: 0, textRevision,
    sourceMerge: { projectId: merge.projectId, bindingId: merge.bindingId, sessionId: merge.sessionId, turnId: merge.turnId,
      mergeProposalId: merge.id, mergeRevision: merge.revision, mergeFingerprint: merge.fingerprint,
      mergeOperationId: outcome.receipt.operationId, integrationOwnerId: merge.integrationOwnerId, resultCommit: sourceCommit },
    remote: { name: remoteName, canonicalUrl: 'https://github.com/ci-fixture/publication-preview.git', host: 'github.com',
      repositoryId: 'ci-fixture-repository-id', owner: 'ci-fixture', repository: 'publication-preview', visibility: 'private', writable: true },
    account: { accountRef, stableId: 'ci-fixture-account-id', login: 'ci-fixture-reviewer', host: 'github.com' },
    base: { ref: baseRef, oid: baseCommit },
    diff: { baseCommit, headCommit: sourceCommit, text: diffText, fingerprint: createHash('sha256').update(diffBytes).digest('hex'), paths },
  });

  database.agentSessionPublications.recordTrustedHumanApproval(proposal.id, proposal.revision, proposal.fingerprint);
  let operation = database.agentSessionPublications.startOperation(proposal.id, proposal.fingerprint);

  operation = database.agentSessionPublications.appendEvent(operation.id, operation.revision, { type: 'branchWriteStarted', expectedOldRemoteOid: null });
  operation = database.agentSessionPublications.appendEvent(operation.id, operation.revision, { type: 'branchObserved', oid: sourceCommit, outcome: 'created', errorCode: 'none' });
  operation = database.agentSessionPublications.appendEvent(operation.id, operation.revision, { type: 'pullRequestWriteStarted', headOid: sourceCommit });
  operation = database.agentSessionPublications.appendEvent(operation.id, operation.revision, { type: 'pullRequestObserved', id: null, url: null,
    repositoryId: proposal.remote.repositoryId, headRef: proposal.publicationRef, headOid: sourceCommit, baseRef, baseOid: baseCommit,
    title, body, draft: true, outcome: 'unknown', errorCode: 'networkUncertain' });
  operation = database.agentSessionPublications.appendEvent(operation.id, operation.revision, {
    type: 'recoveryRequired', reason: 'uncertainWrite', pullRequestId: null, branchOid: sourceCommit,
  });

  assert.equal(operation.state, 'recoveryRequired');
  assert.deepEqual(proposal.textRevision, textRevision, 'The synthetic publication proposal must pin the exact stored PR text revision');

  const originalGit = async (...args) => (await execFileAsync('git', ['-C', fixture.reviewedCommit.repository, ...args])).stdout.trim();

  assert.equal(await originalGit('rev-parse', 'HEAD'), fixture.reviewedCommit.sourceHead, 'Publication preview must not move the original checkout HEAD');
  assert.equal(await originalGit('rev-parse', `refs/heads/bugfixer/session/${fixture.reviewedCommit.sessionId}`), fixture.reviewedCommit.resultingHead,
    'Publication preview must preserve the already committed session ref');
  assert.equal(createHash('sha256').update(await readFile(path.join(fixture.reviewedCommit.repository, '.git', 'index'))).digest('hex'), fixture.reviewedCommit.originalIndexSha256,
    'Publication diff preparation must preserve the original Git index');
  assert.equal(await readFile(path.join(fixture.reviewedCommit.repository, 'selected.txt'), 'utf8'), fixture.reviewedCommit.originalSelected,
    'Publication diff preparation must preserve the original checkout file');
  assert.equal(await readFile(path.join(fixture.reviewedCommit.repository, 'unselected.txt'), 'utf8'), fixture.reviewedCommit.originalUnselected,
    'Publication diff preparation must preserve unrelated original checkout files');
  assert.equal(await readFile(path.join(fixture.reviewedCommit.worktreePath, 'selected.txt'), 'utf8'), fixture.reviewedCommit.laterSelected,
    'Publication diff preparation must preserve the post-commit working file');
  assert.equal(await readFile(path.join(fixture.reviewedCommit.worktreePath, 'unselected.txt'), 'utf8'), fixture.reviewedCommit.laterUnselected,
    'Publication diff preparation must preserve unrelated post-commit working files');

  return {
    fixtureOnly: true,
    providerExecuted: false,
    accountDiscoveryExecuted: false,
    networkWritesExecuted: false,
    nativeHumanApprovalExercised: false,
    approvalSource: 'Synthetic isolated SQLite approval receipt; native approval dialog was not exercised.',
    proposalId: proposal.id,
    proposalFingerprint: proposal.fingerprint,
    operationId: operation.id,
    operationRevision: operation.revision,
    operationState: operation.state,
    prText: { scope: prTextScope, revision: prTextRevision.revision, contentHash: prTextRevision.content.contentHash, title, body,
      fixtureOnly: true, providerExecuted: false, source: 'liveAgentTurn CI fixture; no provider was invoked' },
    accountRef,
    syntheticAccountId: proposal.account.stableId,
    syntheticRepositoryId: proposal.remote.repositoryId,
    remoteName,
    baseRef,
    baseOid: baseCommit,
    resultCommit: sourceCommit,
    diffText,
    diffFingerprint: proposal.diff.fingerprint,
    changedPaths: paths.map(item => item.path),
    partialPrState: 'Unknown PR-write outcome persisted for read-only recovery review; no provider request was issued.',
  };
}

function seedHistoricalProposalAlertFixtures(database, fixture) {
  const oldCommit = database.agentSessionIntegrations.getProposal(fixture.reviewedCommit.proposalId);

  assert.ok(oldCommit, 'The historical integration target must be a persisted proposal');
  const commitPage = database.agentSessionIntegrations.listProposals(oldCommit.projectId, oldCommit.sessionId, oldCommit.turnId, { limit: 2 });
  assert.equal(commitPage.proposals.at(-1)?.id, oldCommit.id, 'The original commit proposal must be the current same-turn tip before adding its sibling');

  const newerCommit = database.agentSessionIntegrations.createProposal({
    projectId: oldCommit.projectId,
    sessionId: oldCommit.sessionId,
    turnId: oldCommit.turnId,
    evidenceVersion: oldCommit.evidenceVersion,
    evidenceFingerprint: oldCommit.evidenceFingerprint,
    sourceHead: oldCommit.sourceHead,
    proposedGitTreeHash: oldCommit.proposedGitTreeHash,
    diffFingerprint: oldCommit.diffFingerprint,
    commitMessage: `${oldCommit.commitMessage} (CI newer sibling)`,
    author: oldCommit.author,
    committer: oldCommit.committer,
    paths: oldCommit.paths.map(item => ({ path: item.path, explanationTargets: item.explanations.map(({ path, hunkId, revision }) => ({ path, hunkId, revision })) })),
    expectedLatestRevision: commitPage.nextRevision,
  });

  assert.equal(newerCommit.revision, oldCommit.revision + 1, 'The integration sibling must advance the actual same-turn store revision');
  assert.equal(newerCommit.evidenceVersion, oldCommit.evidenceVersion, 'The sibling must remain bound to the real observed evidence');
  assert.notEqual(newerCommit.id, oldCommit.id, 'The newer integration sibling must have its own persisted identity');
  assert.equal(newerCommit.approval, null, 'The historical fixture must not synthesize approval for the newer proposal');

  const oldMerge = database.agentSessionMerges.getProposal(fixture.reviewedConflictMerge.proposalId);
  const newerMerge = database.agentSessionMerges.getProposal(fixture.reviewedResolutionMerge.proposalId);

  assert.ok(oldMerge && newerMerge, 'Both merge targets must exist in the durable merge store');
  const mergeCommit = database.agentSessionIntegrations.getProposal(oldMerge.commitProposalId);

  assert.ok(mergeCommit, 'The historical merge target must retain its exact persisted commit proposal');
  assert.equal(newerMerge.projectId, oldMerge.projectId, 'The newer merge sibling must remain in the same project');
  assert.equal(newerMerge.sessionId, oldMerge.sessionId, 'The newer merge sibling must remain in the same session');
  assert.equal(newerMerge.turnId, oldMerge.turnId, 'The newer merge sibling must remain in the same turn');
  assert.equal(newerMerge.revision, oldMerge.revision + 1, 'The real conflict resolution must be a newer sibling in the same turn');
  assert.equal(newerMerge.resolution?.proposalId, oldMerge.id, 'The newer merge sibling must preserve its actual conflict parent');
  assert.equal(newerMerge.commitProposalId, oldMerge.commitProposalId, 'Both merge proposals must retain the exact persisted source commit proposal');
  assert.equal(newerMerge.commitProposalRevision, mergeCommit.revision, 'Both merge proposals must pin the exact same source commit revision');
  assert.equal(newerMerge.commitProposalFingerprint, mergeCommit.fingerprint, 'Both merge proposals must pin the exact same source commit fingerprint');

  const oldPublication = database.agentSessionPublications.getProposal(fixture.reviewedPublication.proposalId);

  assert.ok(oldPublication, 'The historical publication target must be a persisted proposal');
  const publicationMerge = database.agentSessionMerges.getProposal(oldPublication.sourceMergeId);

  assert.ok(publicationMerge && publicationMerge.state === 'merged', 'The historical publication target must retain its exact successful merge parent');
  assert.equal(publicationMerge.turnId, oldPublication.turnId, 'The publication merge parent must remain in the exact target turn');
  const publicationCommit = database.agentSessionIntegrations.getProposal(publicationMerge.commitProposalId);

  assert.ok(publicationCommit, 'The historical publication target must retain its exact persisted commit proposal');
  const publicationPage = database.agentSessionPublications.listProposals(oldPublication.projectId, oldPublication.sessionId, oldPublication.turnId, { limit: 2 });
  assert.equal(publicationPage.proposals.at(-1)?.id, oldPublication.id, 'The original publication proposal must be the same-turn tip before adding its sibling');
  const siblingTitle = `${oldPublication.title} (CI newer sibling)`;
  const siblingBody = `${oldPublication.body}\n\nCI fixture: newer same-turn sibling proposal.`;
  const publicationTextScope = { projectId: oldPublication.projectId, sessionId: oldPublication.sessionId, targetTurnId: oldPublication.turnId };
  const currentPublicationTextHead = database.agentSessionPrTexts.getHead(publicationTextScope);

  assert.ok(currentPublicationTextHead && oldPublication.textRevision && currentPublicationTextHead.revision >= oldPublication.textRevision.revision,
    'The historical publication sibling must append after the durable current PR-text head while preserving its original pin');

  const publicationTextRevision = database.agentSessionPrTexts.appendGeneratedRevision({
    scope: publicationTextScope,
    expectedRevision: currentPublicationTextHead.revision,
    idempotencyKey: `ci-publication-text-sibling-${oldPublication.sessionId}`,
    source: { kind: 'liveAgentTurn', turnId: oldPublication.turnId },
    sanitizedCompleteAgentText: { title: siblingTitle, body: siblingBody },
    knownSecrets: [],
  });

  const siblingTextPin = { scope: publicationTextScope, revision: publicationTextRevision.revision, contentHash: publicationTextRevision.content.contentHash };

  const newerPublication = database.agentSessionPublications.createProposal({
    projectId: oldPublication.projectId,
    sessionId: oldPublication.sessionId,
    turnId: oldPublication.turnId,
    sourceMergeId: oldPublication.sourceMergeId,
    remoteName: oldPublication.remote.name,
    baseRef: oldPublication.baseRef,
    accountRef: oldPublication.account.accountRef,
    title: siblingTitle,
    body: siblingBody,
    expectedRevision: publicationPage.nextRevision,
    textRevision: siblingTextPin,
    sourceMerge: {
      projectId: oldPublication.projectId,
      bindingId: oldPublication.bindingId,
      sessionId: oldPublication.sessionId,
      turnId: oldPublication.turnId,
      mergeProposalId: oldPublication.sourceMergeId,
      mergeRevision: oldPublication.sourceMergeRevision,
      mergeFingerprint: oldPublication.sourceMergeFingerprint,
      mergeOperationId: oldPublication.sourceMergeOperationId,
      integrationOwnerId: oldPublication.integrationOwnerId,
      resultCommit: oldPublication.resultCommit,
    },
    remote: oldPublication.remote,
    account: oldPublication.account,
    base: { ref: oldPublication.baseRef, oid: oldPublication.baseOid },
    diff: oldPublication.diff,
  });

  assert.equal(newerPublication.revision, oldPublication.revision + 1, 'The publication sibling must advance the actual same-turn store revision');
  assert.equal(newerPublication.sourceMergeId, oldPublication.sourceMergeId, 'The publication sibling must retain the exact successful merge parent');
  assert.equal(newerPublication.resultCommit, oldPublication.resultCommit, 'The publication sibling must retain the exact persisted merge result');
  assert.deepEqual(newerPublication.textRevision, siblingTextPin, 'The newer publication sibling must pin its exact durable PR-text revision');
  assert.equal(database.agentSessionPrTexts.getRevision(publicationTextScope, siblingTextPin.revision)?.content.contentHash, siblingTextPin.contentHash,
    'The newer publication sibling must reference the durable generated text revision and content hash');
  assert.equal(newerPublication.approval, null, 'The historical fixture must not synthesize approval for the newer publication');
  assert.deepEqual(oldPublication.textRevision, fixture.reviewedPublication.prText && {
    scope: fixture.reviewedPublication.prText.scope,
    revision: fixture.reviewedPublication.prText.revision,
    contentHash: fixture.reviewedPublication.prText.contentHash,
  }, 'Adding a newer sibling must preserve the original publication text pin');

  const notifications = listAllProjectNotifications(database, fixture.projectId);
  const notificationFor = (kind, id) => notifications.find(item => item.target.kind === kind && item.target.id === id);

  const targets = {
    integration: { kind: 'integrationProposal', id: oldCommit.id, turnId: oldCommit.turnId },
    merge: { kind: 'mergeProposal', id: oldMerge.id, turnId: oldMerge.turnId },
    publication: { kind: 'publicationProposal', id: oldPublication.id, turnId: oldPublication.turnId },
  };

  const notificationIds = {
    integration: notificationFor(targets.integration.kind, targets.integration.id)?.id,
    merge: notificationFor(targets.merge.kind, targets.merge.id)?.id,
    publication: notificationFor(targets.publication.kind, targets.publication.id)?.id,
  };

  for (const kind of Object.keys(targets)) {
    assert.ok(notificationIds[kind], `The historical ${kind} target must have its original durable notification`);
    const notification = notifications.find(item => item.id === notificationIds[kind]);

    const targetSessionId = kind === 'integration' ? oldCommit.sessionId : kind === 'merge' ? oldMerge.sessionId : oldPublication.sessionId;

    assert.equal(notification.sessionId, targetSessionId, `The historical ${kind} alert must retain its target session`);
    assert.equal(notification.target.turnId, targets[kind].turnId, `The historical ${kind} alert must retain its exact parent turn`);
    assert.equal(notification.readAt, null, `The historical ${kind} target alert must start unread`);
  }

  return {
    fixtureOnly: true,
    source: 'Persisted proposal and notification stores; no raw SQLite rows, provider, or external writes.',
    targets,
    notificationIds,
    targetFingerprints: { integration: oldCommit.fingerprint, merge: oldMerge.fingerprint, publication: oldPublication.fingerprint },
    targetEvidenceFingerprints: { integration: oldCommit.evidenceFingerprint, merge: mergeCommit.evidenceFingerprint, publication: publicationCommit.evidenceFingerprint },
    evidenceVersions: {
      integration: oldCommit.evidenceVersion,
      merge: mergeCommit.evidenceVersion,
      publication: publicationCommit.evidenceVersion,
    },
    parentIds: { mergeCommit: oldMerge.commitProposalId, publicationMerge: publicationMerge.id, publicationCommit: publicationMerge.commitProposalId },
    parentRevisions: { mergeCommit: mergeCommit.revision, publicationMerge: publicationMerge.revision, publicationCommit: publicationCommit.revision },
    parentFingerprints: { mergeCommit: mergeCommit.fingerprint, publicationMerge: publicationMerge.fingerprint, publicationCommit: publicationCommit.fingerprint },
    destinations: {
      integration: { sessionId: oldCommit.sessionId, sessionName: fixture.reviewedCommit.name, turnId: oldCommit.turnId },
      merge: { sessionId: oldMerge.sessionId, sessionName: fixture.reviewedConflictCommit.name, turnId: oldMerge.turnId },
      publication: { sessionId: oldPublication.sessionId, sessionName: fixture.reviewedCommit.name, turnId: oldPublication.turnId },
    },
    newerSiblingIds: { integration: newerCommit.id, merge: newerMerge.id, publication: newerPublication.id },
    newerSiblingRevisions: { integration: newerCommit.revision, merge: newerMerge.revision, publication: newerPublication.revision },
    publicationTextPins: { original: oldPublication.textRevision, sibling: newerPublication.textRevision },
  };
}

async function verifyPublicationReview(page, fixture, tag, screenshots, viewports) {
  const changes = await openReviewedCommitChanges(page, fixture);
  const prText = changes.getByRole('region', { name: 'GitHub PR 제목과 설명', exact: true });
  const titleInput = prText.getByRole('textbox', { name: 'PR 제목', exact: true });
  const bodyInput = prText.getByRole('textbox', { name: 'PR 설명', exact: true });
  const textReceipt = fixture.reviewedPublication.prText;
  await titleInput.waitFor();
  await bodyInput.waitFor();
  assert.equal(await titleInput.inputValue(), textReceipt.title, 'The native text editor must load the synthetic AI-authored head from durable storage');
  assert.equal(await bodyInput.inputValue(), textReceipt.body);
  assert.equal(textReceipt.fixtureOnly, true);
  assert.equal(textReceipt.providerExecuted, false);
  assert.ok((await prText.locator('.ai-session-pr-text__head').innerText()).includes('저장된 최신 문구 v1 · 에이전트 작성'));
  assert.ok((await bodyInput.inputValue()).includes('실제 모델은 실행하지 않았습니다'), 'The fixture content must disclose that no actual provider/model ran');
  assert.ok((await prText.innerText()).includes('AI 요청 기록이 없습니다.'),
    'The synthetic initial revision must not imply that an AI provider request occurred');
  assert.equal(await prText.getByRole('button', { name: '이 제공자로 AI 작성 실행', exact: true }).count(), 0,
    'The smoke flow must not invoke a provider or expose a prepared paid run');

  const editedTitle = `${textReceipt.title} · 수동 수정`;
  const editedBody = `${textReceipt.body}\n\nCI 검증: 수동 편집을 네이티브 저장 API로 기록했습니다.`;
  await titleInput.fill(editedTitle);
  await bodyInput.fill(editedBody);
  await prText.getByRole('button', { name: '새 문구 버전 저장', exact: true }).click();
  await prText.getByRole('status').filter({ hasText: 'PR 문구를 v2으로 저장했습니다.' }).waitFor();
  const revisionHistory = prText.getByRole('list', { name: '저장된 PR 문구 버전', exact: true });
  await revisionHistory.getByRole('button').filter({ hasText: `v1 · 에이전트 작성 · ${textReceipt.title}` }).waitFor();
  await revisionHistory.getByRole('button').filter({ hasText: `v2 · 사람 수정 · ${editedTitle}` }).waitFor();
  assert.equal(await titleInput.inputValue(), editedTitle);
  assert.equal(await bodyInput.inputValue(), editedBody);

  const unsavedTitle = `${editedTitle} · 미저장`;
  const unsavedBody = `${editedBody}\n미저장 편집은 새로고침과 탭 재열기 뒤에도 유지되어야 합니다.`;
  await titleInput.fill(unsavedTitle);
  await bodyInput.fill(unsavedBody);
  await prText.getByRole('button', { name: '최신 저장 기록 확인', exact: true }).click();
  await prText.getByRole('status').filter({ hasText: '저장된 PR 문구 v2을 불러왔습니다.' }).waitFor();
  assert.equal(await titleInput.inputValue(), unsavedTitle, 'Refreshing persisted history must not replace dirty title input');
  assert.equal(await bodyInput.inputValue(), unsavedBody, 'Refreshing persisted history must not replace dirty body input');

  const workspace = page.locator('.ai-session-workspace');
  await workspace.getByRole('tab', { name: '터미널', exact: true }).click();
  await workspace.getByRole('tab', { name: '변경', exact: true }).click();
  await prText.getByRole('status').filter({ hasText: '저장된 PR 문구 v2을 불러왔습니다.' }).waitFor();
  assert.equal(await titleInput.inputValue(), unsavedTitle, 'Hiding and reopening the same session must preserve dirty title input');
  assert.equal(await bodyInput.inputValue(), unsavedBody, 'Hiding and reopening the same session must preserve dirty body input');
  await revisionHistory.getByRole('button').filter({ hasText: `v1 · 에이전트 작성 · ${textReceipt.title}` }).waitFor();
  await revisionHistory.getByRole('button').filter({ hasText: `v2 · 사람 수정 · ${editedTitle}` }).waitFor();
  assert.equal(await revisionHistory.getByRole('button').filter({ hasText: unsavedTitle }).count(), 0,
    'Unsaved edits must not appear in persisted revision history');

  await titleInput.focus();
  await titleInput.press('Tab');

  const textKeyboardFocus = await prText.evaluate(element => {
    const active = document.activeElement;

    return {
      inside: !!active && element.contains(active),
      bodyFocused: active?.getAttribute('aria-label') === 'PR 설명',
      visible: !!active && active.matches(':focus-visible'),
      label: active?.getAttribute('aria-label') ?? '',
    };
  });

  assert.equal(textKeyboardFocus.inside, true, 'Keyboard navigation must remain within the PR text editor');
  assert.equal(textKeyboardFocus.bodyFocused, true, 'Tab from the title must move focus to the PR description');
  assert.equal(textKeyboardFocus.visible, true, 'Keyboard focus must remain visibly indicated in the editor');

  const disclosures = prText.locator('details.ai-session-pr-text__details');

  assert.ok(await disclosures.count() > 0, 'Execution details must be available in a native disclosure');
  assert.equal(await disclosures.evaluateAll(items => items.every(item => !item.open)), true, 'Technical execution details must remain folded by default');

  const capturePrTextAtViewport = async (width, height) => {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(({ expectedWidth, expectedHeight }) => window.innerWidth === expectedWidth && window.innerHeight === expectedHeight,
      { expectedWidth: width, expectedHeight: height });
    await verifyTheme(page, tag === 'dark', `pr-text-${tag}-${width}`);
    await prText.evaluate(element => element.scrollIntoView({ block: 'end' }));

    const textLayout = await prText.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const title = element.querySelector('[aria-label="PR 제목"]');
      const body = element.querySelector('[aria-label="PR 설명"]');
      const parent = element.closest('.ai-session-changes');
      const statusBar = document.querySelector('.part.statusbar')?.getBoundingClientRect();
      const visibleBottom = statusBar && statusBar.height > 0 ? Math.min(window.innerHeight, statusBar.top) : window.innerHeight;

      return {
        horizontalOverflow: element.scrollWidth > element.clientWidth + 1,
        changesHorizontalOverflow: !!parent && parent.scrollWidth > parent.clientWidth + 1,
        documentHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        titleWidth: title?.getBoundingClientRect().width ?? 0,
        bodyWidth: body?.getBoundingClientRect().width ?? 0,
        endReachable: bounds.width > 0 && bounds.bottom <= visibleBottom + 1,
        sectionTop: bounds.top,
        sectionBottom: bounds.bottom,
      };
    });

    assert.equal(textLayout.horizontalOverflow, false, `PR text editor must not overflow at ${tag}/${width}`);
    assert.equal(textLayout.changesHorizontalOverflow, false, `PR text panel must not overflow at ${tag}/${width}`);
    assert.equal(textLayout.documentHorizontalOverflow, false, `The native window must not overflow at ${tag}/${width}`);
    assert.ok(textLayout.titleWidth > 0 && textLayout.bodyWidth > 0, `Both editable fields must have visible width at ${tag}/${width}`);
    assert.equal(textLayout.endReachable, true, `The end of the PR text editor must scroll into view at ${tag}/${width}`);
    await prText.evaluate(element => element.scrollIntoView({ block: 'start' }));

    const screenshot = path.join(output, `ai-session-pr-text-${tag}-${width}x${height}.png`);

    await capturePage(page, screenshot);
    screenshots.push(screenshot);
    viewports.push({ theme: tag, state: 'pr-text-editor-flat-layout', width, height, screenshot,
      layout: textLayout, focus: textKeyboardFocus, detailsFolded: true, fixtureOnly: true, providerExecuted: false,
      accountDiscoveryExecuted: false, networkWritesExecuted: false, nativeHumanApprovalExercised: false });
  };

  await capturePrTextAtViewport(1440, 760);
  await capturePrTextAtViewport(760, 820);

  const publication = changes.getByRole('region', { name: 'GitHub 초안 PR', exact: true });
  await publication.locator('.ai-session-publication__detail').waitFor();
  const provenance = publication.locator('details.ai-session-publication__provenance');
  await provenance.locator('summary').click();
  await page.waitForFunction(() => document.querySelector('details.ai-session-publication__provenance')?.open === true);
  const receipt = fixture.reviewedPublication;
  const detail = publication.locator('.ai-session-publication__detail');
  const detailText = await detail.innerText();
  assert.ok(detailText.includes(receipt.proposalId), 'The selected merged source must show its real persisted publication proposal');
  assert.ok(detailText.includes(receipt.prText.title) && detailText.includes(receipt.prText.body),
    'Manual text revisions must not change the already pinned publication proposal');
  assert.ok(detailText.includes(receipt.syntheticAccountId) && detailText.includes(receipt.syntheticRepositoryId), 'Synthetic account and repository identities must be visible');
  assert.ok(detailText.includes(receipt.diffFingerprint) && detailText.includes(receipt.resultCommit), 'The full pinned diff and exact merged result must be visible');
  assert.ok(detailText.includes('[CI 전용]') && detailText.includes('네이티브 승인은 수행하지 않았습니다'), 'The fixture must visibly identify its synthetic approval boundary');
  const paths = publication.getByRole('list', { name: '고정된 변경 경로와 검토 근거', exact: true });
  await paths.waitFor();
  assert.ok((await paths.innerText()).includes('확인되지 않음:'), 'The proposal must disclose that file-specific evidence was not supplied');
  const fullDiff = publication.getByLabel('고정된 전체 base부터 결과까지 diff', { exact: true });

  assert.equal(await fullDiff.textContent(), receipt.diffText, 'The renderer must retain the exact complete locally computed Git diff');

  const operation = publication.getByRole('list', { name: '초안 PR 게시 단계 기록', exact: true });
  await operation.waitFor();
  const operationText = await operation.innerText();
  assert.ok(operationText.includes('PR 결과 관찰') && operationText.includes('networkUncertain') && operationText.includes(receipt.resultCommit),
    'The read-only persisted timeline must show the exact uncertain PR observation and branch head');
  assert.ok(operationText.includes('복구 필요'), 'The persisted operation must render as recovery-required');

  assert.equal(await publication.getByRole('link', { name: 'GitHub PR 열기', exact: true }).count(), 0, 'An unknown PR ID must not produce an external URL');

  const selectedProposal = publication.locator('.ai-session-publication__history button[aria-pressed="true"]');
  await selectedProposal.waitFor();
  await selectedProposal.focus();
  await selectedProposal.press('Tab');

  const keyboardFocus = await publication.evaluate(element => {
    const active = document.activeElement;

    return {
      inside: !!active && element.contains(active),
      visible: !!active && active.matches(':focus-visible'),
      label: active?.getAttribute('aria-label') ?? active?.textContent?.trim() ?? '',
    };
  });

  assert.equal(keyboardFocus.inside, true, 'Keyboard Tab from proposal history must retain focus within the review region');
  assert.equal(keyboardFocus.visible, true, 'The review action following proposal history must show keyboard focus');

  await page.setViewportSize({ width: 1440, height: 760 });
  await page.waitForFunction(() => window.innerWidth === 1440 && window.innerHeight === 760);
  await verifyTheme(page, tag === 'dark', `publication-${tag}-keyboard-focus`);
  await selectedProposal.scrollIntoViewIfNeeded();
  const focusScreenshot = path.join(output, `ai-session-publication-${tag}-1440-keyboard-focus.png`);
  await capturePage(page, focusScreenshot);
  screenshots.push(focusScreenshot);

  viewports.push({ theme: tag, state: 'publication-review-keyboard-focus-1440', width: 1440, height: 760,
    screenshot: focusScreenshot, focus: keyboardFocus, fixtureOnly: true, providerExecuted: false,
    accountDiscoveryExecuted: false, networkWritesExecuted: false, nativeHumanApprovalExercised: false });

  const captureAtViewport = async (width, height, suffix, scrollToEnd) => {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(({ expectedWidth, expectedHeight }) => window.innerWidth === expectedWidth && window.innerHeight === expectedHeight,
      { expectedWidth: width, expectedHeight: height });
    await verifyTheme(page, tag === 'dark', `publication-${tag}-${width}`);
    await publication.evaluate(element => element.scrollIntoView({ block: 'end' }));

    const layout = await publication.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const timeline = element.querySelector('.ai-session-publication__events');
      const timelineBounds = timeline?.getBoundingClientRect();
      const changes = element.closest('.ai-session-changes');
      const statusBar = document.querySelector('.part.statusbar')?.getBoundingClientRect();
      const visibleBottom = statusBar && statusBar.height > 0 ? Math.min(window.innerHeight, statusBar.top) : window.innerHeight;

      return {
        horizontalOverflow: element.scrollWidth > element.clientWidth + 1,
        changesHorizontalOverflow: !!changes && changes.scrollWidth > changes.clientWidth + 1,
        timelineReachable: !!timelineBounds && timelineBounds.width > 0 && timelineBounds.bottom <= visibleBottom + 1,
        sectionBottomReachable: bounds.width > 0 && bounds.bottom <= visibleBottom + 1,
        sectionTop: bounds.top,
        sectionBottom: bounds.bottom,
      };
    });

    assert.equal(layout.horizontalOverflow, false, `Publication review must not overflow horizontally at ${tag}/${width}`);
    assert.equal(layout.changesHorizontalOverflow, false, `The containing review panel must not overflow horizontally at ${tag}/${width}`);
    assert.equal(layout.timelineReachable, true, `The persisted operation timeline must be reachable at ${tag}/${width}`);
    assert.equal(layout.sectionBottomReachable, true, `The publication section must scroll to its end at ${tag}/${width}`);

    if (!scrollToEnd) {
      await fullDiff.scrollIntoViewIfNeeded();
    }

    const screenshot = path.join(output, `ai-session-publication-${tag}-${suffix}.png`);
    await capturePage(page, screenshot);
    screenshots.push(screenshot);

    viewports.push({ theme: tag, state: `publication-readonly-recovery-${suffix}`, width, height, screenshot, layout,
      screenshotContent: scrollToEnd ? 'persisted-operation-receipt-at-scroll-end' : 'pinned-proposal-and-full-diff',
      fixtureOnly: true, providerExecuted: false, accountDiscoveryExecuted: false, networkWritesExecuted: false, nativeHumanApprovalExercised: false });
  };

  await captureAtViewport(1440, 760, '1440', false);
  await captureAtViewport(760, 820, '760', true);
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mailboxFixtureSecret(tag) {
  return `WB_CI_MAILBOX_SECRET_${tag.toUpperCase()}_DO_NOT_PERSIST`;
}

function mailboxFixtureLiteralMarkup() {
  return '<b data-ci-injection="mailbox-fixture">literal text</b> & "quoted" \\';
}

function mailboxFixtureBody(tag, sequence, secret) {
  const prefix = `CI mailbox ${tag} message ${sequence} ${mailboxFixtureLiteralMarkup()} `;

  const isTarget = sequence === 60;

  const secretPart = isTarget ? secret : '';

  const desiredLength = isTarget ? 16_384 : 9_400;

  const fillLength = desiredLength - prefix.length - secretPart.length;

  assert.ok(fillLength >= 0, 'Mailbox fixture text must fit the SQLite message limit');

  return `${prefix}${secretPart}${'x'.repeat(fillLength)}`;
}

async function seedMailboxNotificationHistory(database, fixture, projectFolder, tag, CollaborationService) {
  const senderName = `CI mailbox fixture sender ${tag}`;

  const recipientName = `CI mailbox fixture recipient ${tag}`;

  const model = 'ci-fixture-not-executed';

  const secret = mailboxFixtureSecret(tag);

  const folderIdentity = await statFolder(projectFolder);

  const sender = database.agentSessions.createSession({
    projectId: fixture.projectId,
    bindingId: fixture.bindingId,
    taskId: fixture.taskId,
    name: senderName,
    provider: 'codex',
    model,
    profileRef: 'ci-mailbox-fixture-only',
    workspaceMode: 'sharedFolder',
  });

  const recipient = database.agentSessions.createSession({
    projectId: fixture.projectId,
    bindingId: fixture.bindingId,
    taskId: fixture.taskId,
    name: recipientName,
    provider: 'claude',
    model,
    profileRef: 'ci-mailbox-fixture-only',
    workspaceMode: 'sharedFolder',
  });

  assert.deepEqual([sender.projectId, sender.bindingId, sender.taskId], [fixture.projectId, fixture.bindingId, fixture.taskId], 'The sender fixture must use the exact project, binding, and task scope');

  assert.deepEqual([recipient.projectId, recipient.bindingId, recipient.taskId], [sender.projectId, sender.bindingId, sender.taskId], 'The recipient fixture must share the sender project, binding, and task scope for the two-node workflow');

  const permissionPolicy = { mode: 'read-only', approval: 'never' };

  const snapshot = {
    schemaVersion: 1,
    projectId: fixture.projectId,
    sessionId: sender.id,
    sessionRevision: sender.revision,
    bindingId: fixture.bindingId,
    taskId: fixture.taskId,
    provider: sender.provider,
    model,
    profileRef: sender.profileRef,
    cwd: folderIdentity.canonicalPath,
    folderIdentity,
    managedWorktreeOwnerId: null,
    permissionPolicy,
    convention: null,
    references: [],
  };

  const turn = database.agentSessionTurns.createTurn({
    projectId: fixture.projectId,
    sessionId: sender.id,
    expectedSessionRevision: sender.revision,
    snapshot,
  });

  const startingSession = database.agentSessions.getSession(fixture.projectId, sender.id);

  const running = database.agentSessionTurns.transitionTurn(
    fixture.projectId, sender.id, turn.id, turn.revision, startingSession.revision, { state: 'running' },
  );

  const collaboration = new CollaborationService(database);

  const grant = collaboration.authorizeTurn({
    projectId: fixture.projectId,
    sessionId: sender.id,
    turnId: turn.id,
    permissionPolicy,
    knownSecrets: [secret],
  });

  const messageIds = [];

  try {
    for (let sequence = 1; sequence <= 60; sequence++) {
      const message = collaboration.sendMessage(grant, {
        recipientSessionId: recipient.id,
        idempotencyKey: `ci-mailbox-${tag}-${sequence}`,
        body: mailboxFixtureBody(tag, sequence, secret),
      });

      messageIds.push(message.id);
    }
  } finally {
    try {
      database.agentSessionTurns.transitionTurn(
        fixture.projectId, sender.id, turn.id, running.turn.revision, running.session.revision,
        { state: 'exited', exitCode: 0, cleanupVerified: true },
      );
    } finally {
      collaboration.revoke(grant);
    }
  }

  const targetMessageId = messageIds.at(-1);

  const persistedNotifications = listAllProjectNotifications(database, fixture.projectId);

  const targetNotification = persistedNotifications.find(notification => notification.kind === 'message'
    && notification.target.kind === 'message' && notification.target.id === targetMessageId);

  const completionNotification = persistedNotifications.filter(notification => notification.kind === 'completion'
    && notification.sessionId === sender.id && notification.target.kind === 'turn' && notification.target.id === turn.id).at(-1);

  const initialReadIds = persistedNotifications.filter(notification => notification.readAt !== null).map(notification => notification.id);

  const notificationStatus = database.agentSessions.notificationStatus(fixture.projectId);

  const firstPageUnreadCount = persistedNotifications.slice(0, 50).filter(notification => notification.readAt === null).length;

  const firstPageMessages = database.agentSessions.listInbox(fixture.projectId, recipient.id, { limit: 50 });

  const firstPageResponseBytes = Buffer.byteLength(JSON.stringify({
    messages: firstPageMessages.map(message => ({
      id: message.id,
      senderSessionId: message.senderSessionId,
      recipientSessionId: message.recipientSessionId,
      sequence: message.sequence,
      body: message.body,
      createdAt: message.createdAt,
      readAt: message.readAt,
    })),
    nextCursor: 50,
    hasMore: true,
  }), 'utf8');

  assert.ok(targetMessageId, 'The mailbox fixture must create a target message');

  assert.ok(targetNotification, 'The mailbox fixture must create an associated notification');

  assert.ok(completionNotification, 'The successful fixture turn must persist its exact typed completion notification');

  assert.equal(completionNotification.target.kind, 'turn', 'The completion alert must target a turn');

  assert.equal(completionNotification.target.id, turn.id, 'The completion alert must target the exact fixture turn');

  assert.equal(messageIds.slice(0, 50).includes(targetMessageId), false, 'The target message must remain outside the first bounded mailbox page');

  assert.equal(persistedNotifications.at(-1)?.sequence ?? 0, notificationStatus.latestSequence, 'The bounded SQL store pages must reach the persisted project high-water mark without omitting later notification IDs');

  assert.ok(firstPageResponseBytes > 450 * 1024 && firstPageResponseBytes < 512 * 1024, 'The first mailbox page must exercise near-limit byte pagination while staying inside the response budget');

  return {
    receipt: {
      fixtureOnly: true,
      mailboxUiFixture: true,
      providerExecuted: false,
      ptyExecuted: false,
      source: 'Isolated CI-profile WorkspaceDatabase via AgentSessionCollaborationService and AgentSessionStore APIs',
      proofLimit: 'Typed SQLite mailbox and successful controlled-turn completion records for packaged UI verification; not evidence of provider execution, real agent work, or PTY output.',
      projectId: fixture.projectId,
      senderSessionId: sender.id,
      senderTurnId: turn.id,
      senderName,
      senderProvider: sender.provider,
      recipientSessionId: recipient.id,
      recipientName,
      recipientProvider: recipient.provider,
      model,
      messageCount: messageIds.length,
      messageIds,
      targetMessageId,
      targetNotificationId: targetNotification.id,
      completionNotificationId: completionNotification.id,
      notificationCount: persistedNotifications.length,
      unreadCount: notificationStatus.unreadCount,
      firstPageUnreadCount,
      latestSequence: notificationStatus.latestSequence,
      initialReadIds,
      pageSize: 50,
      oldTargetOutsideFirstMessagePage: true,
      targetBodyLength: mailboxFixtureBody(tag, 60, secret).length,
      ordinaryBodyLength: mailboxFixtureBody(tag, 1, secret).length,
      firstPageResponseBytes,
      secretMaskedBeforeDisk: true,
      markReadSemantics: 'The UI journey acknowledges the notification only; target message readAt must remain null.',
      clipboardAndFileExport: 'Not exercised by this native smoke.',
    },
  };
}

function listAllProjectNotifications(database, projectId) {
  const pageSize = 100;

  const notifications = [];

  let afterSequence = 0;

  while (true) {
    const page = database.agentSessions.listNotifications(projectId, { afterSequence, limit: pageSize });

    notifications.push(...page);

    if (page.length < pageSize) { break; }

    const nextSequence = page.at(-1).sequence;

    assert.ok(nextSequence > afterSequence, 'The notification SQL pagination cursor must advance');

    afterSequence = nextSequence;
  }

  return notifications;
}

async function statFolder(folderPath) {
  const [stats, canonicalPath] = await Promise.all([stat(folderPath, { bigint: true }), realpath(folderPath)]);

  assert.ok(stats.isDirectory(), 'The fixture binding must resolve to a directory');

  return {
    canonicalPath,
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
  };
}

async function verifyAiSessionTranscriptLogs(page, fixture, tag, screenshots, viewports) {
  const workspace = await openSessionWorkspace(page);
  const fixtureRow = workspace.locator('.ai-session__session-row').filter({ hasText: fixture.logHistory.name });

  await fixtureRow.waitFor({ state: 'visible' });
  await fixtureRow.click();
  await workspace.getByRole('heading', { name: fixture.logHistory.name, exact: true }).waitFor();
  await workspace.getByRole('tab', { name: '로그', exact: true }).click();

  const logPanel = workspace.locator('.ai-session__logs-panel');
  const turnSelector = logPanel.getByRole('combobox', { name: '로그를 볼 실행 선택', exact: true });
  const logs = logPanel.locator('.ai-session-logs');
  const entries = logs.locator('.ai-session-logs__entry');

  await turnSelector.waitFor({ state: 'visible' });

  assert.equal(await turnSelector.locator('option').count(), 2, 'The selector must expose both persisted CI fixture turns');
  assert.equal(await turnSelector.inputValue(), fixture.logHistory.turnIds[1], 'The latest turn must be selected by default');
  assert.match(await turnSelector.locator('option:checked').innerText(), /^실행 2 · 종료 · /, 'Retained turn status must be shown in Korean');
  await logs.getByText(`CI fixture terminal ${tag} run 2 entry 1`, { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.ai-session-logs__entry').length === 100);
  assert.ok((await logs.innerText()).includes('기록 누락: 순번 17–17'), 'The explicit sequence hole must be called out as missing history');
  assert.equal((await logs.innerText()).includes(transcriptFixtureSecret(tag)), false, 'Rendered history must not expose the known fixture secret');

  const exportButton = logs.getByRole('button', { name: '불러온 기록 내보내기', exact: true });
  await exportButton.scrollIntoViewIfNeeded();

  const beforePageShot = path.join(output, `ai-session-logs-${tag}-rows-before.png`);

  const desktopLayout = await workspace.evaluate(element => {
    const action = element.querySelector('.ai-session-logs__button:last-child');
    const bounds = action?.getBoundingClientRect();

    return {
      overflow: element.scrollWidth > element.clientWidth + 1,
      actionReachable: !!bounds && bounds.width > 0 && bounds.left >= -1 && bounds.right <= window.innerWidth + 1
        && bounds.top >= -1 && bounds.bottom <= window.innerHeight + 1,
    };
  });

  assert.equal(desktopLayout.overflow, false, `AI session log layout must not overflow horizontally at ${tag}/1440`);
  assert.equal(desktopLayout.actionReachable, true, `The final toolbar action must remain reachable at ${tag}/1440`);

  await capturePage(page, beforePageShot);
  screenshots.push(beforePageShot);
  viewports.push({ theme: tag, state: 'ai-session-logs-first-page', width: 1440, height: 900, screenshot: beforePageShot, layout: desktopLayout });

  const firstPageButton = logs.getByRole('button', { name: '처음 기록 다시 읽기', exact: true });
  await firstPageButton.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.ai-session-logs__entry').length === 100);

  const nextPage = logs.getByRole('button', { name: '다음 기록 불러오기', exact: true });
  await nextPage.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.ai-session-logs__entry').length > 100);

  assert.equal(await entries.count(), fixture.logHistory.entryCountPerTurn, 'Incremental pagination must load all retained fixture entries without duplicates');
  assert.equal((await logs.innerText()).includes(transcriptFixtureSecret(tag)), false, 'Paginated rendered history must remain masked');

  const afterPageShot = path.join(output, `ai-session-logs-${tag}-rows-after.png`);
  await capturePage(page, afterPageShot);
  screenshots.push(afterPageShot);
  viewports.push({ theme: tag, state: 'ai-session-logs-paginated-flat-rows', width: 1440, height: 900, screenshot: afterPageShot });

  const kind = logs.getByRole('combobox', { name: '기록 종류', exact: true });
  const severity = logs.getByRole('combobox', { name: '심각도', exact: true });
  const source = logs.getByRole('combobox', { name: '출처', exact: true });
  const search = logs.getByRole('searchbox', { name: '보존된 기록에서 검색', exact: true });

  await kind.selectOption('log');
  await page.waitForFunction(() => document.querySelectorAll('.ai-session-logs__entry--log').length > 0);

  assert.ok(await logs.locator('.ai-session-logs__entry--log').count() > 0, 'Kind filter must show structured log entries');
  assert.equal(await logs.locator('.ai-session-logs__entry--terminal').count(), 0, 'Kind filter must hide terminal output');
  await kind.selectOption('terminal');
  await page.waitForFunction(() => document.querySelectorAll('.ai-session-logs__entry--terminal').length > 0);

  assert.ok(await logs.locator('.ai-session-logs__entry--terminal').count() > 0, 'Kind filter must show terminal output');
  assert.equal(await logs.locator('.ai-session-logs__entry--log').count(), 0, 'Terminal filter must hide structured logs');
  await kind.selectOption('all');
  await severity.selectOption('error');
  await source.selectOption('provider');
  await page.waitForFunction(() => document.querySelectorAll('.ai-session-logs__entry').length === 1);

  assert.equal(await logs.locator('.ai-session-logs__entry').count(), 1, 'Severity and source filters must isolate the matching structured event');
  assert.equal(await logs.locator('.ai-session-logs__entry-text').innerText(), 'CI fixture provider error *** was masked before persistence');
  await severity.selectOption('all');
  await source.selectOption('all');
  await page.waitForFunction(() => document.querySelectorAll('.ai-session-logs__entry').length === 100);
  await search.fill('fixture search anchor');

  const retainedSearchResult = logs.locator('.ai-session-logs__entry').filter({ hasText: 'fixture search anchor' });

  await retainedSearchResult.waitFor({ state: 'visible' });

  assert.equal(await logs.locator('.ai-session-logs__entry').count(), 1, 'Retained search must find the fixture match beyond the first 100-row page');
  assert.ok((await retainedSearchResult.innerText()).includes('#122'), 'The retained search result must preserve its exact sequence metadata');
  assert.ok((await logs.locator('.ai-session-logs__status').innerText()).includes('보존된 기록을 검색합니다'), 'Search status must state that it queries retained history');
  assert.equal(fixture.logHistory.providerExecuted, false, 'Retained transcript search must not invoke an AI provider');
  assert.equal(fixture.logHistory.ptyExecuted, false, 'Retained transcript search must not start a terminal process');

  const searchShot = path.join(output, `ai-session-logs-${tag}-retained-search.png`);

  await capturePage(page, searchShot);
  screenshots.push(searchShot);
  viewports.push({ theme: tag, state: 'ai-session-logs-retained-search-result', width: 1440, height: 900, screenshot: searchShot });

  await search.fill('no-retained-match');
  await page.waitForFunction(() => {
    const status = document.querySelector('.ai-session-logs__status')?.textContent ?? '';

    return document.querySelectorAll('.ai-session-logs__entry').length === 0 && status.includes('조건에 맞는 보존 기록이 없습니다.');
  });

  assert.equal(await logs.locator('.ai-session-logs__entry').count(), 0, 'A query with no retained matches must finish with an empty result');
  assert.equal((await logs.locator('.ai-session-logs__status').innerText()).includes('다음 기록 불러오기로 계속 찾을 수 있습니다.'), false, 'An exhausted empty search must report no remaining scan pages');
  await search.fill('');

  const historyPausedFollow = logs.getByRole('button', { name: '따라가기 일시 정지', exact: true });
  await historyPausedFollow.waitFor();

  assert.equal(await historyPausedFollow.getAttribute('aria-pressed'), 'false', 'Reading the first history page must pause following until the user resumes it');
  await historyPausedFollow.focus();
  await page.keyboard.press('Space');

  const follow = logs.getByRole('button', { name: '따라가기 켜짐', exact: true });
  await follow.waitFor();

  assert.equal(await follow.getAttribute('aria-pressed'), 'true', 'Keyboard resume must enable following before the pause check');

  const initialCount = await entries.count();
  await follow.focus();
  await page.keyboard.press('Space');
  const pausedFollow = logs.getByRole('button', { name: '따라가기 일시 정지', exact: true });
  await pausedFollow.waitFor();

  assert.equal(await pausedFollow.getAttribute('aria-pressed'), 'false', 'Pause state must be keyboard reachable and announced');
  await page.waitForTimeout(3500);

  assert.equal(await entries.count(), initialCount, 'Paused following must retain the current loaded entry count');
  await pausedFollow.focus();
  await page.keyboard.press('Space');
  await logs.getByRole('button', { name: '따라가기 켜짐', exact: true }).waitFor();

  await turnSelector.selectOption(fixture.logHistory.turnIds[0]);
  await logs.getByText(`CI fixture terminal ${tag} run 1 entry 1`, { exact: true }).waitFor();

  const originalSessionRow = workspace.locator(`button[data-session-select="${fixture.aiSession.id}"]`);
  await originalSessionRow.click();
  await workspace.getByRole('heading', { name: fixture.aiSession.name, exact: true }).waitFor();

  assert.equal(await workspace.locator('.ai-session__logs-empty').innerText(), '이 세션에는 아직 실행 기록이 없습니다.', 'The UI-created session must continue to show the honest zero-turn state');
  await fixtureRow.click();
  await workspace.getByRole('heading', { name: fixture.logHistory.name, exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.ai-session__logs-panel select[aria-label="로그를 볼 실행 선택"]')?.value !== undefined);

  assert.equal(await turnSelector.inputValue(), fixture.logHistory.turnIds[0], 'Returning to the fixture session must restore its previously selected earlier turn');

  await turnSelector.selectOption(fixture.logHistory.turnIds[1]);
  await logs.getByText(`CI fixture terminal ${tag} run 2 entry 1`, { exact: true }).waitFor();

  await page.setViewportSize({ width: 760, height: 820 });
  await page.waitForFunction(() => window.innerWidth === 760);
  await logs.getByText(`CI fixture terminal ${tag} run 2 entry 1`, { exact: true }).waitFor();
  await exportButton.scrollIntoViewIfNeeded();

  const layout = await workspace.evaluate(element => {
    const action = element.querySelector('.ai-session-logs__button:last-child');
    const bounds = action?.getBoundingClientRect();

    return {
      overflow: element.scrollWidth > element.clientWidth + 1,
      actionReachable: !!bounds && bounds.width > 0 && bounds.left >= -1 && bounds.right <= window.innerWidth + 1
        && bounds.top >= -1 && bounds.bottom <= window.innerHeight + 1,
    };
  });

  assert.equal(layout.overflow, false, `AI session log layout must not overflow horizontally at ${tag}/760`);
  assert.equal(layout.actionReachable, true, `The final toolbar action must remain reachable at ${tag}/760`);
  assert.equal((await logs.innerText()).includes(transcriptFixtureSecret(tag)), false, 'Narrow rendered history must remain masked');

  const narrowShot = path.join(output, `ai-session-logs-${tag}-narrow-760.png`);
  await capturePage(page, narrowShot);
  screenshots.push(narrowShot);
  viewports.push({ theme: tag, state: 'ai-session-logs-narrow-760', width: 760, height: 820, screenshot: narrowShot, layout });
}

async function verifyAiSessionChangeEvidence(page, fixture, tag, screenshots, viewports) {
  const evidenceFixture = fixture.changeEvidence;

  const workspace = await openSessionWorkspace(page);
  const fixtureRow = workspace.locator('.ai-session__session-row').filter({ hasText: evidenceFixture.name });
  await fixtureRow.waitFor({ state: 'visible' });
  await fixtureRow.click();
  await workspace.getByRole('heading', { name: evidenceFixture.name, exact: true }).waitFor();
  await workspace.getByRole('tab', { name: '변경', exact: true }).click();

  const changesPanel = workspace.locator('.ai-session__changes-panel');
  const turnSelector = changesPanel.getByRole('combobox', { name: '변경을 확인할 실행 기록', exact: true });
  await turnSelector.waitFor({ state: 'visible' });
  assert.equal(await turnSelector.locator('option').count(), 1, 'The isolated change fixture must expose only its own turn');
  assert.equal(await turnSelector.inputValue(), evidenceFixture.turnId, 'The change evidence must stay scoped to the fixture turn');
  const changes = changesPanel.locator('.ai-session-changes');
  await changes.getByText(`v${evidenceFixture.evidenceVersion} · ${evidenceFixture.fingerprint}`, { exact: true }).waitFor();
  assert.ok((await changes.innerText()).includes('작성자 알 수 없음'), 'The UI must state that before/after evidence does not establish authorship');

  const prText = changesPanel.getByRole('region', { name: 'GitHub PR 제목과 설명', exact: true });
  const prTitle = prText.getByRole('textbox', { name: 'PR 제목', exact: true });
  const prBody = prText.getByRole('textbox', { name: 'PR 설명', exact: true });
  const instruction = prText.getByRole('textbox', { name: 'AI 수정 지시', exact: true });
  const preview = prText.getByRole('button', { name: 'AI 요청 미리보기', exact: true });
  const manualSave = prText.getByRole('button', { name: '새 문구 버전 저장', exact: true });

  await prText.getByText('저장된 PR 문구 없음', { exact: true }).waitFor();
  await prText.getByRole('status').filter({ hasText: '저장된 PR 문구가 없습니다.' }).waitFor();
  await preview.waitFor({ state: 'visible' });
  assert.equal(await prTitle.isEditable(), false, 'An initial draft must keep the PR title read-only until a saved AI head exists');
  assert.equal(await prBody.isEditable(), false, 'An initial draft must keep the PR description read-only until a saved AI head exists');
  assert.equal(await instruction.isEditable(), true, 'The AI instruction must remain writable before the first saved head');
  await instruction.focus();
  assert.equal(await instruction.evaluate(element => document.activeElement === element), true, 'The AI instruction must accept keyboard focus');
  assert.equal(await preview.isEnabled(), true, 'Preview must be available after the empty draft history finishes loading');
  assert.equal(await manualSave.isDisabled(), true, 'Manual save must remain disabled until an AI-created head exists');

  for (const filePath of evidenceFixture.changedPaths) {
    await changes.locator('.ai-session-changes__file').filter({ hasText: filePath }).waitFor();
  }

  await changes.locator('.ai-session-changes__file').filter({ hasText: 'created-empty.txt' }).getByText('추가됨', { exact: true }).waitFor();
  await changes.locator('.ai-session-changes__file').filter({ hasText: 'deleted.txt' }).getByText('삭제됨', { exact: true }).waitFor();

  const binaryRow = changes.locator('.ai-session-changes__file').filter({ hasText: 'binary.dat' });
  await binaryRow.getByRole('button', { name: '파일 설명', exact: true }).click();

  const binaryCompare = binaryRow.getByRole('button', { name: '비교 열기', exact: true });

  await binaryCompare.waitFor({ state: 'visible' });

  assert.equal(await binaryCompare.isDisabled(), true, 'Unavailable binary bytes must not open a misleading empty diff');

  await changes.getByText('변경 구간을 확인할 수 없습니다.', { exact: true }).waitFor();

  const binaryNote = changes.getByText(/비교 구간을 계산할 수 없습니다: .*binary/iu);

  await binaryNote.waitFor({ state: 'visible' });

  await workspace.getByRole('tab', { name: '터미널', exact: true }).click();
  await workspace.getByRole('tab', { name: '변경', exact: true }).click();
  assert.equal(await turnSelector.inputValue(), evidenceFixture.turnId, 'Switching tabs must preserve the exact selected turn');
  await changes.getByText(`v${evidenceFixture.evidenceVersion} · ${evidenceFixture.fingerprint}`, { exact: true }).waitFor();

  const editedRow = changes.locator('.ai-session-changes__file').filter({ hasText: 'edited.txt' });

  const fileExplanation = editedRow.getByRole('button', { name: '파일 설명', exact: true });

  if (await fileExplanation.isVisible()) { await fileExplanation.click(); }

  const hunkSelector = changes.getByRole('combobox', { name: '설명을 연결할 변경 구간', exact: true });

  await hunkSelector.waitFor({ state: 'visible' });

  await hunkSelector.selectOption(evidenceFixture.reviewTarget.hunkId);

  const whatInput = changes.locator('[placeholder="무엇이 바뀌었나요?"]');

  const whyInput = changes.locator('[placeholder="왜 바뀌었나요?"]');

  await whatInput.waitFor({ state: 'visible' });

  const seedExplanationFacts = changes.locator('.ai-session-changes__detail .ai-session-changes__facts').filter({ hasText: '설명 버전 51' });

  await seedExplanationFacts.waitFor({ state: 'visible' });

  assert.equal(await hunkSelector.inputValue(), evidenceFixture.reviewTarget.hunkId, 'The explanation must be linked to the exact retained hunk');

  assert.equal(await whatInput.inputValue(), 'Fixture explanation 51: the retained text changed.');

  assert.equal(await whyInput.inputValue(), 'Synthetic native UI history only; no model or provider was executed.');

  assert.ok((await changes.innerText()).includes('에이전트 작성 · 초안 · 실행 결과 미검증 · 설명 버전 51'), 'Synthetic agent text must remain a draft with unverified execution claims');

  await changes.getByRole('heading', { name: '설명 기록 2–51', exact: true }).waitFor();

  const revisionList = changes.locator('ol.ai-session-changes__revision-list');

  assert.equal(await revisionList.locator('li').count(), 50, 'The latest explanation-history window must stay bounded to 50 revisions');

  const citationLabel = changes.locator('.ai-session-changes__citation').filter({ hasText: evidenceFixture.conventionCitation.id });

  const citationCheckbox = citationLabel.locator('input[type="checkbox"]');

  assert.equal(await citationCheckbox.isChecked(), true, 'The pinned convention citation must be selected from the exact turn snapshot');

  await whatInput.fill('Human review: the retained file changes the fixture line.');

  await whyInput.fill('The stored before and after text show this one-line change; this review does not claim provider authorship.');

  await changes.getByRole('button', { name: '초안 저장', exact: true }).click();

  await changes.getByText('무엇: Human review: the retained file changes the fixture line.', { exact: true }).waitFor();

  await changes.getByText(/사람 작성 · 초안 · 실행 결과 미검증 · 설명 버전 52/u).waitFor();

  await whatInput.fill('Human confirmed explanation: the fixture line changed.');

  await whyInput.fill('I reviewed the retained hunk and its pinned convention citation.');

  const confirmExplanation = changes.getByRole('button', { name: '설명만 확인', exact: true });

  await confirmExplanation.click();

  await changes.getByText('무엇: Human confirmed explanation: the fixture line changed.', { exact: true }).waitFor();

  await changes.getByText(/사람 작성 · 설명만 확인됨 · 실행 결과 미검증 · 설명 버전 53/u).waitFor();

  await changes.getByRole('heading', { name: '설명 기록 4–53', exact: true }).waitFor();

  assert.equal(await revisionList.locator('li').count(), 50, 'Saving must keep the latest explanation-history window bounded');

  assert.ok((await changes.innerText()).includes(`고정 참고 규칙 · ${evidenceFixture.conventionCitation.id} · v${evidenceFixture.conventionCitation.version} · ${evidenceFixture.conventionCitation.sha256.slice(0, 12)}`), 'The persisted explanation must retain its exact pinned citation');

  const olderExplanations = changes.getByRole('button', { name: '이전 설명 더 보기', exact: true });

  await olderExplanations.scrollIntoViewIfNeeded();

  await olderExplanations.click();

  await changes.getByRole('heading', { name: '설명 기록 1–3', exact: true }).waitFor();

  assert.equal(await revisionList.locator('li').count(), 3, 'The older explanation-history window must contain only the three earlier revisions');

  await changes.getByText('Fixture explanation 1: the retained text changed. / 이유: Synthetic native UI history only; no model or provider was executed.', { exact: true }).waitFor();

  const latestExplanations = changes.getByRole('button', { name: '최근 설명 보기', exact: true });

  await latestExplanations.click();

  await changes.getByRole('heading', { name: '설명 기록 4–53', exact: true }).waitFor();

  assert.equal(await revisionList.locator('li').count(), 50, 'Returning to recent history must replace the older window without accumulating rows');

  await changes.getByText('Fixture explanation 51: the retained text changed. / 이유: Synthetic native UI history only; no model or provider was executed.', { exact: true }).waitFor();

  const explanationAction = changes.getByRole('button', { name: '설명만 확인', exact: true });

  await explanationAction.scrollIntoViewIfNeeded();

  const explanationLayout = await workspace.evaluate(element => {
    const action = [...element.querySelectorAll('button')].find(button => button.textContent?.trim() === '설명만 확인');
    const bounds = action?.getBoundingClientRect();

    return {
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      actionReachable: !!bounds && bounds.width > 0 && bounds.left >= 0 && bounds.right <= window.innerWidth + 1
        && bounds.top >= 0 && bounds.bottom <= window.innerHeight + 1,
    };
  });

  assert.equal(explanationLayout.overflow, false, `The explanation view must not overflow horizontally at ${tag}/1440`);

  assert.equal(explanationLayout.actionReachable, true, `The explanation-only confirmation action must remain reachable at ${tag}/1440`);

  const explanationScreenshot = path.join(output, `ai-session-change-explanation-${tag}-1440.png`);

  await capturePage(page, explanationScreenshot);
  screenshots.push(explanationScreenshot);
  viewports.push({ theme: tag, state: 'ai-session-change-human-confirmed-hunk-explanation', width: 1440, height: 900, screenshot: explanationScreenshot, layout: explanationLayout });

  await page.setViewportSize({ width: 760, height: 820 });

  await page.waitForFunction(() => window.innerWidth === 760);

  await explanationAction.scrollIntoViewIfNeeded();

  const narrowExplanationLayout = await workspace.evaluate(element => {
    const action = [...element.querySelectorAll('button')].find(button => button.textContent?.trim() === '설명만 확인');
    const bounds = action?.getBoundingClientRect();

    return {
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      actionReachable: !!bounds && bounds.width > 0 && bounds.left >= 0 && bounds.right <= window.innerWidth + 1
        && bounds.top >= 0 && bounds.bottom <= window.innerHeight + 1,
    };
  });

  assert.equal(narrowExplanationLayout.overflow, false, `The narrow explanation view must not overflow at ${tag}/760`);

  assert.equal(narrowExplanationLayout.actionReachable, true, `The explanation-only confirmation action must remain reachable at ${tag}/760`);

  assert.ok((await changes.innerText()).includes('사람 작성 · 설명만 확인됨 · 실행 결과 미검증 · 설명 버전 53'), 'The narrow view must retain the confirmed explanation and unverified status');

  const narrowExplanationScreenshot = path.join(output, `ai-session-change-explanation-${tag}-760.png`);

  await capturePage(page, narrowExplanationScreenshot);
  screenshots.push(narrowExplanationScreenshot);
  viewports.push({ theme: tag, state: 'ai-session-change-human-confirmed-hunk-explanation-narrow', width: 760, height: 820, screenshot: narrowExplanationScreenshot, layout: narrowExplanationLayout });

  await page.setViewportSize({ width: 1440, height: 900 });

  await page.waitForFunction(() => window.innerWidth === 1440);

  const desktopScreenshot = path.join(output, `ai-session-changes-${tag}-1440.png`);
  await capturePage(page, desktopScreenshot);
  screenshots.push(desktopScreenshot);
  viewports.push({ theme: tag, state: 'ai-session-changes-retained-evidence', width: 1440, height: 900, screenshot: desktopScreenshot });

  await page.setViewportSize({ width: 760, height: 820 });
  await page.waitForFunction(() => window.innerWidth === 760);

  const narrowLayout = await workspace.evaluate(element => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth,
    actionReachable: [...element.querySelectorAll('button')].filter(button => button.offsetParent !== null).every(button => {
      const rect = button.getBoundingClientRect();

      return rect.left >= 0 && rect.right <= window.innerWidth + 1;
    }),
  }));

  assert.equal(narrowLayout.overflow, false, 'The narrow retained-change view must not overflow horizontally');
  assert.equal(narrowLayout.actionReachable, true, 'Visible change actions must remain within the narrow viewport');
  const narrowScreenshot = path.join(output, `ai-session-changes-${tag}-760.png`);
  await capturePage(page, narrowScreenshot);
  screenshots.push(narrowScreenshot);
  viewports.push({ theme: tag, state: 'ai-session-changes-narrow-760', width: 760, height: 820, screenshot: narrowScreenshot, layout: narrowLayout });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => window.innerWidth === 1440);
  await changes.locator('.ai-session-changes__file').filter({ hasText: 'edited.txt' }).getByRole('button', { name: '비교 열기', exact: true }).click();
  const diffEditor = page.locator('.monaco-diff-editor');
  await diffEditor.waitFor({ state: 'visible' });
  const originalLines = diffEditor.locator('.original-in-monaco-diff-editor .view-lines');
  const modifiedLines = diffEditor.locator('.modified-in-monaco-diff-editor .view-lines');
  await originalLines.getByText(evidenceFixture.editedBefore.trim(), { exact: true }).waitFor();
  await modifiedLines.getByText(evidenceFixture.editedAfter.trim(), { exact: true }).waitFor();
  const modifiedContentBeforeAttempt = await modifiedLines.innerText();
  const modifiedEditor = diffEditor.locator('.modified-in-monaco-diff-editor');
  await modifiedEditor.locator('.view-lines').click();
  assert.equal(await modifiedEditor.evaluate(editor => {
    const focused = document.activeElement;

    return focused !== null && editor.contains(focused) && focused.matches('textarea.inputarea, .native-edit-context');
  }), true, 'The retained modified editor must own its actual keyboard input before the edit attempt');
  await page.keyboard.type(`CI_READONLY_EDIT_ATTEMPT_${tag}`);
  assert.equal(await modifiedLines.innerText(), modifiedContentBeforeAttempt, 'Typing into the retained modified side must not change its in-memory content');
  assert.equal((await diffEditor.innerText()).includes(`CI_READONLY_EDIT_ATTEMPT_${tag}`), false, 'The read-only diff must reject keyboard edits');
  assert.equal(await diffEditor.innerText().then(text => text.includes(evidenceFixture.postCaptureMutation)), false, 'The diff must show stored content rather than the later filesystem mutation');
  const diffScreenshot = path.join(output, `ai-session-change-diff-${tag}-1440.png`);
  await capturePage(page, diffScreenshot);
  screenshots.push(diffScreenshot);
  viewports.push({ theme: tag, state: 'ai-session-change-retained-readonly-diff', width: 1440, height: 900, screenshot: diffScreenshot });
}

async function verifyAiSessionMailbox(page, fixture, tag, screenshots, viewports) {
  const workspace = await openSessionWorkspace(page);

  const notifications = workspace.locator('.ai-session__notifications-mount');

  const trigger = notifications.getByRole('button', { name: `알림, 전체 읽지 않은 ${fixture.mailbox.unreadCount}개`, exact: true });

  const popover = notifications.locator('.ai-session-notifications__popover');

  await trigger.waitFor({ state: 'visible' });

  assert.equal(await popover.isVisible(), false, 'The exact project unread badge must be available while the alert popover is closed');

  await verifyTheme(page, tag === 'dark', `mailbox-${tag}`);

  const badgeShot = path.join(output, `ai-session-mailbox-${tag}-closed-badge.png`);

  await capturePage(page, badgeShot);
  screenshots.push(badgeShot);
  viewports.push({ theme: tag, state: 'ai-session-mailbox-unread-badge', width: 1440, height: 900, screenshot: badgeShot });

  await trigger.click();
  await popover.waitFor({ state: 'visible' });

  const notificationList = popover.locator('.ai-session-notifications__list');

  const loadedUnreadStatus = popover.locator('.ai-session-notifications__status');

  const firstNotificationPageCount = Math.min(50, fixture.mailbox.notificationCount);

  await page.waitForFunction(count => document.querySelectorAll('.ai-session-notifications__item').length === count, firstNotificationPageCount);

  assert.ok((await loadedUnreadStatus.innerText()).includes(`불러온 목록에서 ${fixture.mailbox.firstPageUnreadCount}개`), 'The first notification page must report its actual bounded unread count separately');

  const showLatest = notifications.getByRole('button', { name: '새 알림 보기', exact: true });

  await showLatest.waitFor({ state: 'visible' });
  await showLatest.click();
  await page.waitForFunction(() => document.querySelectorAll('.ai-session-notifications__item').length === 1);

  const completionNotification = notificationList.locator(`[data-notification-id="${fixture.mailbox.completionNotificationId}"]`);

  await completionNotification.waitFor({ state: 'visible' });

  assert.ok((await completionNotification.innerText()).includes('실행 종료'), 'The latest notification must be rendered as a typed completion alert');

  assert.ok((await completionNotification.innerText()).includes(fixture.mailbox.senderName), 'The completion alert must name the session whose turn completed');

  await completionNotification.click();

  const logsTab = workspace.getByRole('tab', { name: '로그', exact: true });

  await logsTab.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#ai-session-tab-logs')?.getAttribute('aria-selected') === 'true');
  await workspace.getByRole('heading', { name: fixture.mailbox.senderName, exact: true }).waitFor();

  const logPanel = workspace.locator('.ai-session__logs-panel');

  const turnSelector = logPanel.locator('select[aria-label="로그를 볼 실행 선택"]');

  await turnSelector.waitFor({ state: 'attached' });
  await page.waitForFunction(turnId => document.querySelector('.ai-session__logs-panel select[aria-label="로그를 볼 실행 선택"]')?.value === turnId, fixture.mailbox.senderTurnId);

  assert.equal(await turnSelector.inputValue(), fixture.mailbox.senderTurnId, 'The completion alert must select its exact sender turn in the logs panel');

  await page.waitForFunction(() => document.activeElement?.id === 'ai-session-tab-logs');

  assert.equal(await logsTab.evaluate(element => document.activeElement === element), true, 'The actual logs tab must receive focus after exact completion navigation settles');

  const completionShot = path.join(output, `ai-session-mailbox-${tag}-completion-destination.png`);

  await capturePage(page, completionShot);
  screenshots.push(completionShot);
  viewports.push({ theme: tag, state: 'ai-session-mailbox-exact-completion-destination', width: 1440, height: 900, screenshot: completionShot, destination: { sessionId: fixture.mailbox.senderSessionId, turnId: fixture.mailbox.senderTurnId, selectedTurnId: await turnSelector.inputValue() } });

  await page.getByRole('button', { name: `알림, 전체 읽지 않은 ${fixture.mailbox.unreadCount - 1}개`, exact: true }).waitFor({ state: 'visible' });

  const updatedTrigger = notifications.getByRole('button', { name: `알림, 전체 읽지 않은 ${fixture.mailbox.unreadCount - 1}개`, exact: true });

  await updatedTrigger.click();
  await popover.waitFor({ state: 'visible' });

  const firstNotificationPage = popover.getByRole('button', { name: '처음 알림 다시 읽기', exact: true });

  await firstNotificationPage.click();
  await page.waitForFunction(count => document.querySelectorAll('.ai-session-notifications__item').length === count, firstNotificationPageCount);

  const targetNotification = notificationList.locator(`[data-notification-id="${fixture.mailbox.targetNotificationId}"]`);

  const nextNotificationPage = popover.getByRole('button', { name: '다음 알림 불러오기', exact: true });

  let loadedNotificationCount = firstNotificationPageCount;

  while (!(await targetNotification.count())) {
    assert.ok(loadedNotificationCount < fixture.mailbox.notificationCount, 'The exact message notification must exist in the persisted notification history');
    assert.equal(await nextNotificationPage.isEnabled(), true, 'Notification history must expose another bounded page before the exact message notification');

    const expectedLoadedCount = Math.min(fixture.mailbox.notificationCount, loadedNotificationCount + 50);

    const firstLoadedNotificationId = await notificationList.locator('.ai-session-notifications__item').first().getAttribute('data-notification-id');

    await nextNotificationPage.click();
    await page.waitForFunction(({ count, notificationId, previousFirstId }) => {
      const items = [...document.querySelectorAll('.ai-session-notifications__item')];

      return items.some(item => item.dataset.notificationId === notificationId)
        || (items.length >= Math.min(200, count) && (items.length < 200 || items[0].dataset.notificationId !== previousFirstId));
    }, { count: expectedLoadedCount, notificationId: fixture.mailbox.targetNotificationId, previousFirstId: firstLoadedNotificationId });

    loadedNotificationCount = expectedLoadedCount;
  }

  assert.ok((await targetNotification.innerText()).includes('새 메시지'), 'The historical target must remain a typed message alert');

  assert.ok((await targetNotification.innerText()).includes(fixture.mailbox.recipientName), 'The message alert must name its recipient session');

  await targetNotification.click();

  const messageTab = workspace.getByRole('tab', { name: '메시지', exact: true });

  await messageTab.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#ai-session-tab-messages')?.getAttribute('aria-selected') === 'true');
  await workspace.getByRole('heading', { name: fixture.mailbox.recipientName, exact: true }).waitFor();

  const messagePanel = workspace.locator('.ai-session__messages-panel');

  const targetMessage = messagePanel.locator(`[data-message-id="${fixture.mailbox.targetMessageId}"]`);

  const targetBody = targetMessage.locator('.ai-session-messages__body');

  await targetMessage.waitFor({ state: 'visible' });
  await page.waitForFunction(messageId => document.querySelector(`[data-message-id="${messageId}"]`)?.getAttribute('aria-current') === 'true', fixture.mailbox.targetMessageId);

  const bodyText = await targetBody.textContent();

  assert.ok(bodyText?.startsWith(`CI mailbox ${tag} message 60 ${mailboxFixtureLiteralMarkup()}`), 'The exact old message body must display escaped text literally');

  assert.ok(bodyText?.includes('***'), 'The trusted fixture token must be masked by the production send path');

  assert.equal(bodyText?.includes(mailboxFixtureSecret(tag)), false, 'The rendered mailbox must not reveal the trusted fixture token');

  assert.ok((bodyText?.length ?? 0) > 15_000, 'The exact-target request must display the long body beyond the first mailbox page');

  assert.equal(await targetBody.locator('[data-ci-injection="mailbox-fixture"]').count(), 0, 'Markup-looking message content must remain text instead of becoming DOM');

  assert.ok((await targetMessage.locator('.ai-session-messages__meta').innerText()).includes(fixture.mailbox.senderSessionId), 'The sender metadata must expose the complete session ID');

  assert.ok((await targetMessage.locator('.ai-session-messages__read-state').innerText()).includes('우편함에 보관됨'), 'Opening a notification must leave the AI message unread');

  await page.getByRole('button', { name: `알림, 전체 읽지 않은 ${fixture.mailbox.unreadCount - 2}개`, exact: true }).waitFor({ state: 'visible' });

  const desktopShot = path.join(output, `ai-session-mailbox-${tag}-exact-message.png`);

  await capturePage(page, desktopShot);
  screenshots.push(desktopShot);
  viewports.push({ theme: tag, state: 'ai-session-mailbox-exact-message', width: 1440, height: 900, screenshot: desktopShot });

  const firstMessagePage = messagePanel.getByRole('button', { name: '처음 메시지 다시 읽기', exact: true });

  const nextMessagePage = messagePanel.getByRole('button', { name: '다음 메시지 불러오기', exact: true });

  const messages = messagePanel.locator('.ai-session-messages__message');

  await firstMessagePage.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.ai-session-messages__message').length === 50);

  assert.deepEqual(await messages.evaluateAll(elements => elements.map(element => element.dataset.messageId)), fixture.mailbox.messageIds.slice(0, 50), 'The mailbox first-page action must return the bounded first 50 messages');

  await nextMessagePage.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.ai-session-messages__message').length === 60);

  assert.deepEqual(await messages.evaluateAll(elements => elements.map(element => element.dataset.messageId)), fixture.mailbox.messageIds, 'The next-page action must load retained mailbox history without duplicate records');

  await firstMessagePage.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.ai-session-messages__message').length === 50);
  await firstMessagePage.focus();
  await page.waitForTimeout(4_000);

  const historyActionFocus = await firstMessagePage.evaluate(button => ({
    retained: button.ownerDocument.activeElement === button,
    activeTag: button.ownerDocument.activeElement?.tagName,
    activeId: button.ownerDocument.activeElement?.id,
  }));

  assert.equal(historyActionFocus.retained, true, `Visible mailbox refresh must not steal focus after notification navigation: ${JSON.stringify(historyActionFocus)}`);

  await page.setViewportSize({ width: 760, height: 820 });
  await page.waitForFunction(() => window.innerWidth === 760);
  await firstMessagePage.scrollIntoViewIfNeeded();

  const narrowLayout = await workspace.evaluate(element => ({
    overflow: element.scrollWidth > element.clientWidth + 1,
    firstHistoryActionReachable: (() => {
      const bounds = element.querySelector('.ai-session-messages__button:first-child')?.getBoundingClientRect();

      return !!bounds && bounds.width > 0 && bounds.left >= -1 && bounds.right <= window.innerWidth + 1
        && bounds.top >= -1 && bounds.bottom <= window.innerHeight + 1;
    })(),
  }));

  assert.equal(narrowLayout.overflow, false, `The mailbox must not overflow horizontally at ${tag}/760`);

  assert.equal(narrowLayout.firstHistoryActionReachable, true, `The mailbox history action must remain reachable at ${tag}/760`);

  const narrowBodies = await messagePanel.locator('.ai-session-messages__body').allTextContents();

  assert.ok(narrowBodies.every(body => !body.includes(mailboxFixtureSecret(tag))), 'Narrow rendered mailbox content must remain masked');

  const narrowShot = path.join(output, `ai-session-mailbox-${tag}-narrow-760.png`);

  await capturePage(page, narrowShot);
  screenshots.push(narrowShot);
  viewports.push({ theme: tag, state: 'ai-session-mailbox-narrow-760', width: 760, height: 820, screenshot: narrowShot, layout: narrowLayout });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => window.innerWidth === 1440 && window.innerHeight === 900);
  const historicalAlerts = fixture.historicalProposalAlerts;
  const historicalReadIds = [];

  for (const kind of ['integration', 'merge', 'publication']) {
    const unreadBeforeOpen = fixture.mailbox.unreadCount - 2 - historicalReadIds.length;
    const triggerForHistory = notifications.getByRole('button', { name: `알림, 전체 읽지 않은 ${unreadBeforeOpen}개`, exact: true });

    await triggerForHistory.waitFor({ state: 'visible' });
    await triggerForHistory.click();
    await popover.waitFor({ state: 'visible' });
    await firstNotificationPage.click();
    await page.waitForFunction(count => document.querySelectorAll('.ai-session-notifications__item').length === count, firstNotificationPageCount);

    const historicalNotificationId = historicalAlerts.notificationIds[kind];
    const historicalNotification = notificationList.locator(`[data-notification-id="${historicalNotificationId}"]`);
    let loadedCount = firstNotificationPageCount;

    while (!(await historicalNotification.count())) {
      assert.ok(loadedCount < fixture.mailbox.notificationCount, `The exact historical ${kind} alert must exist in persisted notification history`);
      assert.equal(await nextNotificationPage.isEnabled(), true, `The ${kind} alert must remain reachable through bounded notification paging`);
      const expectedLoadedCount = Math.min(fixture.mailbox.notificationCount, loadedCount + 50);
      const previousFirstId = await notificationList.locator('.ai-session-notifications__item').first().getAttribute('data-notification-id');

      await nextNotificationPage.click();
      await page.waitForFunction(({ notificationId, previousFirst, expectedCount }) => {
        const items = [...document.querySelectorAll('.ai-session-notifications__item')];

        return items.some(item => item.dataset.notificationId === notificationId)
          || (items.length >= Math.min(200, expectedCount) && (items.length < 200 || items[0]?.dataset.notificationId !== previousFirst));
      }, { notificationId: historicalNotificationId, previousFirst: previousFirstId, expectedCount: expectedLoadedCount });
      loadedCount = expectedLoadedCount;
    }

    const target = historicalAlerts.targets[kind];
    const destination = historicalAlerts.destinations[kind];

    assert.equal(await historicalNotification.getAttribute('data-notification-id'), historicalNotificationId, `The ${kind} alert control must carry its exact persisted notification ID`);
    assert.ok((await historicalNotification.innerText()).includes(destination.sessionName), `The ${kind} alert must name its exact destination session`);
    await historicalNotification.click();
    await workspace.getByRole('heading', { name: destination.sessionName, exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('#ai-session-tab-changes')?.getAttribute('aria-selected') === 'true');
    await page.waitForFunction(() => document.activeElement?.id === 'ai-session-tab-changes');
    await page.waitForFunction(turnId => document.querySelector('.ai-session__changes-panel select[aria-label="변경을 확인할 실행 기록"]')?.value === turnId, destination.turnId);

    const changes = workspace.locator('.ai-session__changes-panel .ai-session-changes');

    const exactSelector = kind === 'integration' ? `[data-focus-key="proposal:${target.id}"][aria-pressed="true"]`
      : kind === 'merge' ? `[data-focus-key="merge-proposal:${target.id}"][aria-pressed="true"]`
        : `[data-focus-key="publication-proposal:${target.id}"][aria-pressed="true"]`;

    const exactProposal = changes.locator(exactSelector);

    await exactProposal.waitFor({ state: 'visible' });
    const evidenceVersion = historicalAlerts.evidenceVersions[kind];
    const evidenceFingerprint = historicalAlerts.targetEvidenceFingerprints[kind];
    const exactEvidence = changes.locator('.ai-session-changes__fingerprint');

    await exactEvidence.waitFor({ state: 'visible' });
    const selectedEvidence = (await exactEvidence.innerText()).trim();
    assert.equal(selectedEvidence, `v${evidenceVersion} · ${evidenceFingerprint}`, `The ${kind} alert must select its exact stored evidence version and full fingerprint`);

    if (kind === 'merge') {
      await changes.locator(`[data-focus-key="proposal:${historicalAlerts.parentIds.mergeCommit}"][aria-pressed="true"]`).waitFor({ state: 'visible' });
    }

    if (kind === 'publication') {
      await changes.locator(`[data-focus-key="merge-proposal:${historicalAlerts.parentIds.publicationMerge}"][aria-pressed="true"]`).waitFor({ state: 'visible' });
      await changes.locator(`[data-focus-key="proposal:${historicalAlerts.parentIds.publicationCommit}"][aria-pressed="true"]`).waitFor({ state: 'visible' });
    }

    historicalReadIds.push(historicalNotificationId);
    const unreadAfterOpen = fixture.mailbox.unreadCount - 2 - historicalReadIds.length;

    await notifications.getByRole('button', { name: `알림, 전체 읽지 않은 ${unreadAfterOpen}개`, exact: true }).waitFor({ state: 'visible' });
    const screenshot = path.join(output, `ai-session-mailbox-${tag}-historical-${kind}-exact-target.png`);

    await capturePage(page, screenshot);
    screenshots.push(screenshot);
    viewports.push({ theme: tag, state: `historical-${kind}-proposal-exact-target`, width: 1440, height: 900, screenshot,
      destination: { ...destination, proposalId: target.id, evidenceVersion, parentIds: historicalAlerts.parentIds,
        selectedProposal: await exactProposal.getAttribute('data-focus-key'), selectedEvidence },
      fixtureOnly: true, providerExecuted: false, externalWritesExecuted: false });
  }

  fixture.mailbox.historicalProposalNotificationIds = historicalReadIds;
}

async function verifyAiSessionWorkflow(page, fixture, tag, screenshots, viewports) {
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.waitForFunction(() => window.innerWidth === 1440);

  const workspace = page.locator('.ai-session-workspace');

  const senderSessionRow = workspace.locator(`button[data-session-select="${fixture.mailbox.senderSessionId}"]`);

  await senderSessionRow.waitFor({ state: 'visible' });

  await senderSessionRow.click();

  await workspace.getByRole('heading', { name: fixture.mailbox.senderName, exact: true }).waitFor();

  assert.equal(await senderSessionRow.getAttribute('aria-current'), 'true', 'The workflow journey must explicitly select the mailbox sender session before entering its task-scoped plan');

  const workflowTab = workspace.getByRole('tab', { name: '위임', exact: true });

  await workflowTab.focus();

  await page.keyboard.press('Enter');

  await page.waitForFunction(() => document.querySelector('#ai-session-tab-workflow')?.getAttribute('aria-selected') === 'true');

  const panel = workspace.locator('.ai-session__workflow-panel');

  const workflowScope = panel.locator('.ai-session-workflows__editor > .ai-session-workflows__muted').first();

  await workflowScope.waitFor({ state: 'visible' });

  assert.equal(await workflowScope.innerText(), `작업 ID ${fixture.taskId} · 바인딩 ${fixture.bindingId} · 프로젝트 범위`, 'The workflow candidates must stay within the selected sender task and binding');

  const rows = panel.locator('.ai-session-workflows__node-row');

  await page.waitForFunction(() => document.querySelectorAll('.ai-session-workflows__node-row').length >= 2);

  const senderRow = panel.locator(`.ai-session-workflows__node-row:has(> input[data-control-key="include-${fixture.mailbox.senderSessionId}"])`);

  const recipientRow = panel.locator(`.ai-session-workflows__node-row:has(> input[data-control-key="include-${fixture.mailbox.recipientSessionId}"])`);

  await senderRow.getByRole('checkbox', { name: `${fixture.mailbox.senderName} 세션 포함`, exact: true }).check();

  await recipientRow.getByRole('checkbox', { name: `${fixture.mailbox.recipientName} 세션 포함`, exact: true }).check();

  assert.ok((await senderRow.locator('.ai-session-workflows__identity').innerText()).includes(`${fixture.mailbox.senderProvider} · ${fixture.mailbox.model}`), 'The sender row must show its persisted provider and model ID');

  assert.ok((await recipientRow.locator('.ai-session-workflows__identity').innerText()).includes(`${fixture.mailbox.recipientProvider} · ${fixture.mailbox.model}`), 'The recipient row must show its persisted provider and model ID');

  const policyOptions = await panel.locator('select[data-field="policy"]').evaluateAll(elements => elements.map(element => Array.from(element.options, option => option.value)));

  assert.deepEqual(policyOptions, [['read-only', 'mutating'], ['read-only', 'mutating']], 'The plan editor must expose only the two runtime-supported permission policies');

  await senderRow.locator('select[data-field="role"]').selectOption('researcher');

  await recipientRow.locator('select[data-field="role"]').selectOption('implementer');

  await senderRow.locator('select[data-field="policy"]').selectOption('read-only');

  await recipientRow.locator('select[data-field="policy"]').selectOption('mutating');

  await recipientRow.locator('.ai-session-workflows__dependencies').getByRole('checkbox', { name: fixture.mailbox.senderName, exact: true }).check();

  assert.equal(await recipientRow.locator('.ai-session-workflows__dependencies').getByRole('checkbox', { name: fixture.mailbox.senderName, exact: true }).isChecked(), true, 'The selected recipient plan node must explicitly depend on the sender');

  const limits = panel.locator('.ai-session-workflows__limit-field input');

  await limits.nth(0).fill('2');

  await limits.nth(1).fill('4');

  await limits.nth(2).fill('30');

  const save = panel.getByRole('button', { name: '계획 저장', exact: true });

  await save.focus();

  await page.keyboard.press('Enter');

  await page.waitForFunction(() => document.querySelector('.ai-session-workflows__state')?.textContent?.includes('승인 대기'));

  const saveFocusDiagnostic = await page.evaluate(() => {
    const active = document.activeElement;

    return { tag: active?.tagName ?? 'none', key: active instanceof HTMLElement ? active.dataset.controlKey ?? active.id ?? '' : '' };
  });

  assert.equal(await save.evaluate(element => document.activeElement === element), true,
    `Saving a workflow by keyboard must keep focus on the stable save control (active=${saveFocusDiagnostic.tag}/${saveFocusDiagnostic.key})`);

  const workflowId = await panel.locator('.ai-session-workflows__select').first().getAttribute('data-workflow-id');

  assert.ok(workflowId, 'The saved workflow must appear in the project history list');

  const initialIdentity = panel.locator('.ai-session-workflows__editor p').filter({ hasText: '저장된 계획 · v1 · 지문' });

  const initialIdentityText = await initialIdentity.innerText();

  const initialFingerprint = initialIdentityText.match(/[0-9a-f]{64}/)?.[0];

  assert.ok(initialFingerprint, 'The saved plan version and fingerprint must be visible in its context');

  assert.ok((await panel.locator('.ai-session-workflows__status').innerText()).includes('실행 기록 없음'), 'A saved waiting plan must not imply a workflow run exists');

  await limits.nth(1).fill('5');

  const draftWarning = panel.locator('.ai-session-workflows__editor p[role="status"]').filter({ hasText: '저장하지 않은 변경이 있습니다.' });

  await draftWarning.waitFor({ state: 'visible' });

  const approve = panel.getByRole('button', { name: '승인 요청', exact: true });

  const start = panel.getByText('실행 시작', { exact: true });

  assert.equal(await approve.isDisabled(), true, 'Approval must be disabled while the visible plan draft is unsaved');

  assert.equal(await start.innerText(), '실행 시작', 'The hidden start control must retain its exact action label in the DOM');

  assert.equal(await start.isVisible(), false, 'Start must remain hidden until the saved workflow is ready');

  assert.equal(await start.isDisabled(), true, 'Start must be disabled while the visible plan draft is unsaved');

  await save.focus();

  await page.keyboard.press('Enter');

  await page.waitForFunction(() => document.querySelector('.ai-session-workflows__state')?.textContent?.includes('승인 대기 · 계획 v2'));

  assert.equal(await draftWarning.isVisible(), false, 'Saving the edited plan must clear the unsaved warning');

  assert.equal(await approve.isDisabled(), false, 'The saved waiting plan may present its separate native-approval action');

  const savedIdentity = panel.locator('.ai-session-workflows__editor p').filter({ hasText: '저장된 계획 · v2 · 지문' });

  const savedIdentityText = await savedIdentity.innerText();

  const savedFingerprint = savedIdentityText.match(/[0-9a-f]{64}/)?.[0];

  assert.ok(savedFingerprint && savedFingerprint !== initialFingerprint, 'Editing and saving must produce a visible new version and fingerprint');

  assert.ok((await panel.locator('.ai-session-workflows__status').innerText()).includes('실행 기록 없음'), 'Editing a plan must not create a run');

  const screenshotLayout = async (width, state) => {
    const height = width === 760 ? 820 : 900;

    await page.setViewportSize({ width, height });

    await page.waitForFunction(expectedWidth => window.innerWidth === expectedWidth, width);

    const lastAction = panel.getByRole('button', { name: '상태·참조 다시 읽기', exact: true });

    await lastAction.scrollIntoViewIfNeeded();

    const layout = await panel.evaluate(element => {
      const action = element.querySelector('.ai-session-workflows__actions button:last-child');

      const bounds = action?.getBoundingClientRect();

      return {
        overflow: element.scrollWidth > element.clientWidth + 1,
        actionReachable: !!bounds && bounds.width > 0 && bounds.left >= -1 && bounds.right <= window.innerWidth + 1
          && bounds.top >= -1 && bounds.bottom <= window.innerHeight + 1,
      };
    });

    assert.equal(layout.overflow, false, `Workflow content must not overflow horizontally at ${tag}/${width}`);

    assert.equal(layout.actionReachable, true, `The last workflow action must remain reachable at ${tag}/${width}`);

    await verifyTheme(page, tag === 'dark', `workflow-${tag}-${width}`);

    const screenshot = path.join(output, `ai-session-workflow-${tag}-${width}-${state}.png`);

    await capturePage(page, screenshot);

    screenshots.push(screenshot);

    viewports.push({ theme: tag, state: `ai-session-workflow-${state}`, width, height, screenshot, layout });
  };

  await screenshotLayout(1440, 'desktop-saved');

  await screenshotLayout(760, 'narrow-saved');

  return {
    fixtureOnly: true,
    workflowUiFixture: true,
    providerExecuted: false,
    ptyExecuted: false,
    workflowId,
    sessionIds: [fixture.mailbox.senderSessionId, fixture.mailbox.recipientSessionId],
    savedVersion: 2,
    savedFingerprint,
    initialFingerprint,
    expectedPlan: {
      maxConcurrentNodes: 2,
      maxTotalTurns: 5,
      maxDurationMs: 30 * 60_000,
      nodes: [
        { sessionId: fixture.mailbox.senderSessionId, role: 'researcher', permissionPolicy: { mode: 'read-only', approval: 'never' }, dependsOn: [] },
        { sessionId: fixture.mailbox.recipientSessionId, role: 'implementer', permissionPolicy: { mode: 'mutating', approval: 'on-request' }, dependsOn: [fixture.mailbox.senderSessionId] },
      ],
    },
    expectedState: 'waiting-for-native-approval',
    actualProviderStart: false,
    actualTaskCompletion: false,
    proofLimit: 'The packaged UI created and revised a persisted workflow plan only. Native approval, provider launch, and agent task execution were not performed.',
  };
}

async function dismissStartupInvitations(page) {

  await page.getByRole('button', { name: 'Not now', exact: true })
    .or(page.locator('.project-home__intro h1')).first()
    .waitFor({ state: 'visible', timeout: 90_000 });

  for (let prompt = 0; prompt < 5; prompt++) {
    const notNow = page.getByRole('button', { name: 'Not now', exact: true });

    if (!(await notNow.isVisible())) return;

    await page.keyboard.press('F10');

    await page.getByRole('checkbox', { name: "Don't show again", exact: true }).check();

    await notNow.click();

    await page.locator('.monaco-dialog-modal-block').waitFor({ state: 'hidden' });
  }
}

async function captureFailure(page, file, diagnostics) {
  try {

    await capturePage(page, file);
  } catch (error) {

    diagnostics.pageErrors.push(`Failure screenshot capture failed: ${error.stack ?? error.message}`);
  }
}

async function capturePage(page, file) {
  const cdp = await page.context().newCDPSession(page);

  try {
    await page.waitForFunction(() => document.fonts.status === 'loaded', undefined, { timeout: 20_000 });

    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      fromSurface: true,
    });

    await writeFile(file, Buffer.from(shot.data, 'base64'));
  } finally {
    await cdp.detach();
  }
}

async function verifyTheme(page, expectedDark, phase) {
  const expectedColors = expectedDark
    ? { editor: '#17171c', activityBar: '#202426' }
    : { editor: '#ffffff', activityBar: '#f5f5f2' };

  await page.waitForFunction(({ dark, colors }) => {
    const workbench = document.querySelector('.monaco-workbench');

    if (!workbench || workbench.classList.contains('vs-dark') !== dark) return false;

    const style = getComputedStyle(workbench);

    return style.getPropertyValue('--vscode-editor-background').trim().toLowerCase() === colors.editor
      && style.getPropertyValue('--vscode-activityBar-background').trim().toLowerCase() === colors.activityBar;
  }, { dark: expectedDark, colors: expectedColors }, { timeout: 30_000 });

  const state = await page.locator('.monaco-workbench').evaluate(workbench => {
    const style = getComputedStyle(workbench);

    return {
      classes: workbench.className,
      editorBackground: style.getPropertyValue('--vscode-editor-background').trim(),
      activityBarBackground: style.getPropertyValue('--vscode-activityBar-background').trim(),
    };
  });

  diagnostics.themes.push({ phase, expectedDark, ...state });
}
