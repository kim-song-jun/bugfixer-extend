/** Exercise the packaged native project dashboard with a service-created fixture. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, opendir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

const [appArgument, outputArgument] = process.argv.slice(2);

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
  instrumentationDrops: {
    nativeLifecycleEvents: 0,
    rendererClockSamples: 0,
    isolatedAppLogs: 0,
    processOutput: 0,
    processOutputBytes: 0,
  },
};

const MAX_NATIVE_DIAGNOSTIC_RECORDS = 2048;

const MAX_CAPTURE_BYTES = 256 * 1024;

const MAX_CAPTURE_CHUNKS = 128;

const MAX_LOG_FILES = 24;

const MAX_LOG_DIRECTORY_ENTRIES = 512;

const MAX_LOG_FILE_BYTES = 64 * 1024;

const MAX_LOG_CAPTURE_BYTES = 512 * 1024;

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

      fixture = { projectId: project.project.id, projectName: project.project.name, descriptorPath: project.descriptorPath, taskId: task.id, taskTitle: task.title, initialState: task.state };
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
