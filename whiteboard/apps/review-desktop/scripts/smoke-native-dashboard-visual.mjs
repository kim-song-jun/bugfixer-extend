/** Exercise the packaged native project dashboard with a service-created fixture. */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, opendir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
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
  console: [],
  consoleRecords: [],
  consoleCorrelations: [],
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
  },
};

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
  const port = await reservePort();

  const args = [
    '--disable-telemetry', '--skip-welcome', '--log', 'trace',
    `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`,
    `--remote-debugging-port=${port}`,
    ...(descriptor ? [descriptor] : []),
  ];

  const env = { ...process.env, DEV_REVIEW_HOME: reviewHome, DEV_REVIEW_IMPORT_FROM: 'none', ELECTRON_ENABLE_LOGGING: '1' };
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
          const renderedMessage = previews.every(value => value !== undefined) ? previews.join(' ') : null;
          const message = renderedMessage ?? event.args.map(arg => arg.description ?? String(arg.value ?? '')).join(' ');
          const entry = `PID ${child.pid}: ${message}`;
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

        const renderedMessage = message.text();
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

      fixture = { projectId: project.project.id, bindingId: project.binding.id, projectName: project.project.name, descriptorPath: project.descriptorPath, taskId: task.id, taskTitle: task.title, initialState: task.state };
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
    } finally {
      persistedDatabase.close();
    }

    assert.equal(fixture.finalState, 'inProgress', 'Keyboard state change must persist in workspace.db after the app exits');

    const logFixtureDatabase = WorkspaceDatabase.open(path.join(userData, 'workspace.db'));

    try {
      const seeded = await seedTranscriptHistory(logFixtureDatabase, fixture, projectFolder, tag);

      fixture.logHistory = seeded.receipt;

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

      await verifyAiSessionTranscriptLogs(session.page, fixture, tag, screenshots, viewports);
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

      for (const turn of turns) {
        const stored = verifiedHistoryDatabase.agentSessionTranscripts.readPage(fixture.projectId, fixture.logHistory.sessionId, turn.id, { limit: 100 });
        const next = verifiedHistoryDatabase.agentSessionTranscripts.readPage(fixture.projectId, fixture.logHistory.sessionId, turn.id, { afterSequence: stored.nextSequence, limit: 100 });

        assert.ok([...stored.entries, ...next.entries].every(entry => !entry.text.includes(transcriptFixtureSecret(tag))), 'The persisted history must not contain the unmasked fixture secret');
      }
    } finally {
      verifiedHistoryDatabase.close();
    }

    const mailboxFixtureDatabase = WorkspaceDatabase.open(path.join(userData, 'workspace.db'));

    try {
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

      const notifications = verifiedMailboxDatabase.agentSessions.listNotifications(fixture.projectId, { limit: 100 });

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

      assert.equal(targetMessage.readAt, null, 'Opening a human mailbox view must not acknowledge the message for the AI');

      assert.ok(targetNotification?.readAt, 'Opening the notification must mark only that notification as read');

      assert.deepEqual(notifications.filter(notification => notification.readAt).map(notification => notification.id), [fixture.mailbox.targetNotificationId], 'Only the clicked notification may be marked read');

      assert.equal(notificationStatus.unreadCount, fixture.mailbox.messageCount - 1, 'Only the opened notification must leave the project unread count');

      assert.equal(notificationStatus.latestSequence, fixture.mailbox.messageCount, 'The project notification high-water mark must remain persisted');

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

async function verifyAiSessionWorkspace(page, tag, screenshots, viewports) {
  await page.setViewportSize({ width: 1440, height: 900 });

  const sidebar = page.getByRole('navigation', { name: '프로젝트 탐색', exact: true });

  if (!(await sidebar.isVisible())) {
    await page.getByRole('button', { name: '프로젝트 메뉴', exact: true }).click();
  }

  await sidebar.getByRole('button', { name: 'AI 세션', exact: true }).click();

  const workspace = page.locator('.ai-session-workspace');

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

  await capturePage(page, selectedScreenshot);
  screenshots.push(selectedScreenshot);
  viewports.push({ theme: tag, state: 'ai-session-preview', width: 1440, height: 900, screenshot: selectedScreenshot });
  await page.setViewportSize({ width: 760, height: 820 });

  const compact = workspace.locator('.ai-session__narrow-toolbar');

  await compact.waitFor({ state: 'visible' });

  const create = compact.getByRole('button', { name: '새 AI 세션 만들기', exact: true });

  await create.focus();
  await page.keyboard.press('Enter');
  await workspace.getByRole('heading', { name: '새 AI 세션', exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute('name') === 'name');

  const scrollBounds = await workspace.evaluate(element => {
    element.scrollTop = element.scrollHeight;

    const action = element.querySelector('.ai-session__create-form button[type="submit"]');
    const bounds = action?.getBoundingClientRect();
    const viewport = element.getBoundingClientRect();

    return { actionBottom: bounds?.bottom, viewportBottom: viewport.bottom, overflow: element.scrollWidth > element.clientWidth + 1 };
  });

  assert.equal(scrollBounds.overflow, false, 'The narrow AI session workspace must not overflow horizontally');
  assert.ok(Number.isFinite(scrollBounds.actionBottom) && scrollBounds.actionBottom <= scrollBounds.viewportBottom + 1, 'The final create action must remain reachable at scroll end');

  const narrowScreenshot = path.join(output, `ai-sessions-${tag}-create-narrow-760.png`);

  await capturePage(page, narrowScreenshot);
  screenshots.push(narrowScreenshot);
  viewports.push({ theme: tag, state: 'ai-session-create-narrow', width: 760, height: 820, screenshot: narrowScreenshot, scrollBounds });
  await workspace.locator('.ai-session__create-form').getByRole('button', { name: '취소', exact: true }).click();
  await workspace.getByRole('tab', { name: '터미널', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.activeElement?.id === 'ai-session-tab-changes');

  assert.equal(await workspace.getByRole('tab', { name: '변경 내역', exact: true }).getAttribute('aria-selected'), 'true');

  return { name, model };
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
        const text = sequence === 2
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

  const running = database.agentSessionTurns.transitionTurn(
    fixture.projectId, sender.id, turn.id, turn.revision, sender.revision, { state: 'running' },
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

  const targetNotification = database.agentSessions.listNotifications(fixture.projectId, { limit: 100 })
    .find(notification => notification.messageId === targetMessageId);

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

  assert.ok(firstPageResponseBytes > 450 * 1024 && firstPageResponseBytes < 512 * 1024, 'The first mailbox page must exercise near-limit byte pagination while staying inside the response budget');

  return {
    receipt: {
      fixtureOnly: true,
      mailboxUiFixture: true,
      providerExecuted: false,
      ptyExecuted: false,
      source: 'Isolated CI-profile WorkspaceDatabase via AgentSessionCollaborationService and AgentSessionStore APIs',
      proofLimit: 'Synthetic SQLite mailbox records for packaged UI verification; not evidence of provider execution, real agent work, or PTY output.',
      projectId: fixture.projectId,
      senderSessionId: sender.id,
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
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => window.innerWidth === 1440);

  const sidebar = page.getByRole('navigation', { name: '프로젝트 탐색', exact: true });

  if (!(await sidebar.isVisible())) {
    await page.getByRole('button', { name: '프로젝트 메뉴', exact: true }).click();
  }

  await sidebar.getByRole('button', { name: 'AI 세션', exact: true }).click();

  const workspace = page.locator('.ai-session-workspace');
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
  const search = logs.getByRole('searchbox', { name: '불러온 기록에서 검색', exact: true });

  await kind.selectOption('log');

  assert.ok(await logs.locator('.ai-session-logs__entry--log').count() > 0, 'Kind filter must show structured log entries');
  assert.equal(await logs.locator('.ai-session-logs__entry--terminal').count(), 0, 'Kind filter must hide terminal output');
  await kind.selectOption('terminal');

  assert.ok(await logs.locator('.ai-session-logs__entry--terminal').count() > 0, 'Kind filter must show terminal output');
  assert.equal(await logs.locator('.ai-session-logs__entry--log').count(), 0, 'Terminal filter must hide structured logs');
  await kind.selectOption('all');
  await severity.selectOption('error');
  await source.selectOption('provider');

  assert.equal(await logs.locator('.ai-session-logs__entry').count(), 1, 'Severity and source filters must isolate the matching structured event');
  assert.equal(await logs.locator('.ai-session-logs__entry-text').innerText(), 'CI fixture provider error *** was masked before persistence');
  await severity.selectOption('all');
  await source.selectOption('all');
  await search.fill('fixture search anchor');

  assert.equal(await logs.locator('.ai-session-logs__entry').count(), 1, 'Search must find a loaded record');
  assert.ok((await logs.locator('.ai-session-logs__status').innerText()).includes('불러온'), 'Search status must explain it only covers loaded records');
  await search.fill('');

  const follow = logs.getByRole('button', { name: '따라가기 켜짐', exact: true });
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

  const originalSessionRow = workspace.locator('.ai-session__session-row').filter({ hasText: fixture.aiSession.name });
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

async function verifyAiSessionMailbox(page, fixture, tag, screenshots, viewports) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => window.innerWidth === 1440);

  const sidebar = page.getByRole('navigation', { name: '프로젝트 탐색', exact: true });

  if (!(await sidebar.isVisible())) {
    await page.getByRole('button', { name: '프로젝트 메뉴', exact: true }).click();
  }

  await sidebar.getByRole('button', { name: 'AI 세션', exact: true }).click();

  const workspace = page.locator('.ai-session-workspace');

  const notifications = workspace.locator('.ai-session__notifications-mount');

  const trigger = notifications.getByRole('button', { name: '알림, 전체 읽지 않은 60개', exact: true });

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

  await page.waitForFunction(() => document.querySelectorAll('.ai-session-notifications__item').length === 50);

  assert.ok((await loadedUnreadStatus.innerText()).includes('불러온 목록에서 50개'), 'The first notification page must report its bounded unread count separately');

  const showLatest = notifications.getByRole('button', { name: '새 알림 보기', exact: true });

  await showLatest.waitFor({ state: 'visible' });
  await showLatest.click();
  await page.waitForFunction(() => document.querySelectorAll('.ai-session-notifications__item').length === 1);

  const targetNotification = notificationList.locator(`[data-notification-id="${fixture.mailbox.targetNotificationId}"]`);

  await targetNotification.waitFor({ state: 'visible' });

  assert.equal(fixture.mailbox.messageIds.slice(0, fixture.mailbox.pageSize).includes(fixture.mailbox.targetMessageId), false, 'The exact notification target must be older than the first mailbox page');

  assert.ok((await targetNotification.innerText()).includes(fixture.mailbox.recipientName), 'The latest notification must name the actual recipient session');

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

  await page.getByRole('button', { name: '알림, 전체 읽지 않은 59개', exact: true }).waitFor({ state: 'visible' });

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

  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '처음 메시지 다시 읽기', 'Visible mailbox refresh must not steal focus after notification navigation');

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
}

async function verifyAiSessionWorkflow(page, fixture, tag, screenshots, viewports) {
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.waitForFunction(() => window.innerWidth === 1440);

  const workspace = page.locator('.ai-session-workspace');

  const workflowTab = workspace.getByRole('tab', { name: '위임', exact: true });

  await workflowTab.focus();

  await page.keyboard.press('Enter');

  await page.waitForFunction(() => document.querySelector('#ai-session-tab-workflow')?.getAttribute('aria-selected') === 'true');

  const panel = workspace.locator('.ai-session__workflow-panel');

  const rows = panel.locator('.ai-session-workflows__node-row');

  await page.waitForFunction(() => document.querySelectorAll('.ai-session-workflows__node-row').length >= 2);

  const senderRow = rows.filter({ hasText: fixture.mailbox.senderName });

  const recipientRow = rows.filter({ hasText: fixture.mailbox.recipientName });

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

  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '계획 저장', 'Saving a workflow by keyboard must keep focus on the stable save control');

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

  const start = panel.getByRole('button', { name: '실행 시작', exact: true });

  assert.equal(await approve.isDisabled(), true, 'Approval must be disabled while the visible plan draft is unsaved');

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
