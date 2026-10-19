/** Run real PTY contracts inside the packaged Electron runtime on the macOS CI runner. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants, existsSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'This resource-intensive probe runs only in GitHub CI');

assert.equal(process.platform, 'darwin');

assert.ok(process.versions.electron, 'Use the packaged Electron executable with ELECTRON_RUN_AS_NODE=1');

const [appPath, evidencePath] = process.argv.slice(2);

assert.ok(appPath && evidencePath, 'Pass the packaged app and evidence directory');

const resources = path.join(appPath, 'Contents', 'Resources', 'app');

const nodeExecutable = path.join(resources, 'review-runtime', 'bin', 'node');

const guardianScriptPath = path.join(resources, 'out', 'vs', 'workspace', 'electron-main', 'agentSessions', 'pty', 'agentPtyGuardian.mjs');

const hostModule = path.join(resources, 'out', 'vs', 'workspace', 'electron-main', 'agentSessions', 'agentSessionNativeRuntime.js');

const sessionModules = path.dirname(hostModule);

const probeGuardianScriptPath = path.join(sessionModules, 'agentCliProbeGuardian.mjs');

const identityHookScriptPath = path.join(sessionModules, 'agentProviderIdentityHook.mjs');

await mkdir(evidencePath, { recursive: true });

await access(nodeExecutable, constants.X_OK);

await access(guardianScriptPath, constants.R_OK);

await access(probeGuardianScriptPath, constants.R_OK);

await access(identityHookScriptPath, constants.R_OK);

const bootstrapForkPath = path.join(resources, 'out', 'bootstrap-fork.js');

await access(bootstrapForkPath, constants.R_OK);

const previousEntrypoint = process.env.VSCODE_ESM_ENTRYPOINT;

const previousHandlesUncaughtErrors = process.env.VSCODE_HANDLES_UNCAUGHT_ERRORS;

process.env.VSCODE_ESM_ENTRYPOINT = 'vs/workspace/electron-main/agentSessions/agentSessionNativeRuntime';

process.env.VSCODE_HANDLES_UNCAUGHT_ERRORS = 'true';

try {
  await import(pathToFileURL(bootstrapForkPath).href);
} finally {
  if (previousEntrypoint === undefined) {
    delete process.env.VSCODE_ESM_ENTRYPOINT;
  } else {
    process.env.VSCODE_ESM_ENTRYPOINT = previousEntrypoint;
  }

  if (previousHandlesUncaughtErrors === undefined) {
    delete process.env.VSCODE_HANDLES_UNCAUGHT_ERRORS;
  } else {
    process.env.VSCODE_HANDLES_UNCAUGHT_ERRORS = previousHandlesUncaughtErrors;
  }
}

const {
  AgentPtyHost, runBoundedAgentCliProcess, createAgentPtyOutputSanitizer, AgentSessionPtyRuntimeFactory,
  AgentSessionJournal, AgentSessionPreparationError, AGENT_CLI_COMMAND_SPEC_VERSION,
  AgentSessionService, AgentSessionRuntimeStartError, AgentSessionWorkspaceResolver,
  ManagedWorktreeService, TaskFolderWriterLock, WorkspaceDatabase,
} = await import(pathToFileURL(hostModule).href);

const root = await mkdtemp(path.join(os.tmpdir(), 'bfx-pty-probe-'));

const secret = 'bfx-public-fixture-sensitive-value';

const hosts = [];

let ownedAgentSessionService;

let ownedServiceDatabase;

const identities = [];

function hostState() {
  const commands = execFileSync('/bin/ps', ['-axo', 'comm='], { encoding: 'utf8', timeout: 2000 }).split('\n');
  let docker;

  try {
    const version = execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

    docker = { available: true, version };
  } catch (error) {
    docker = { available: false, reason: error.code ?? error.status ?? 'unavailable' };
  }

  return {
    load: os.loadavg(),
    cores: os.cpus().length,
    freeMemory: os.freemem(),
    totalMemory: os.totalmem(),
    swap: execFileSync('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8', timeout: 2000 }).trim(),
    nodeProcesses: commands.filter(command => /(^|\/)node$/.test(command.trim())).length,
    appProcesses: commands.filter(command => /Whiteboard|Electron/.test(command)).length,
    target: 'packaged PTY host with disposable Node fixtures',
    docker,
  };
}

const receipt = {
  commit: process.env.GITHUB_SHA,
  runtime: { node: process.versions.node, electron: process.versions.electron, modules: process.versions.modules },
  bootstrap: { entry: 'out/bootstrap-fork.js', loadedModule: 'vs/workspace/electron-main/agentSessions/agentSessionNativeRuntime' },
  baseline: hostState(),
  checks: [],
  cleanup: [],
  ownedProcesses: identities,
};

const abortController = new AbortController();

function requestAbort() {
  receipt.interrupted = true;
  abortController.abort();
}

process.once('SIGINT', requestAbort);

process.once('SIGTERM', requestAbort);

function createHost(createSanitizer = () => createAgentPtyOutputSanitizer({ knownSecrets: [secret] }), persistOutput, revokeAccess = () => {}) {
  const options = {
    guardianNodeExecutable: nodeExecutable,
    guardianScriptPath,
    createSanitizer,
    // The direct host contracts use a disposable fixture with no launch-scoped access.
    revokeAccess,
    maxOutputBytes: 4096,
    maxOutputChunks: 16,
  };

  if (persistOutput) options.persistOutput = persistOutput;

  const host = new AgentPtyHost(options);

  hosts.push(host);

  return host;
}

async function until(check, label, timeout = 15_000, ignoreAbort = false) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (!ignoreAbort && abortController.signal.aborted) throw new Error('The PTY probe was interrupted');

    const result = await check();

    if (result) return result;

    await new Promise(resolve => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out: ${label}`);
}

function readCompleteTranscript(readPage) {
  const entries = [];
  let afterSequence = 0;
  let highestSequence = 0;
  let pageCount = 0;
  let previousSequence = 0;

  while (pageCount < 400) {
    const page = readPage({ afterSequence, limit: 50 });
    assert.deepEqual(page.gaps, [], 'The small natural-exit fixture must retain every durable transcript entry.');

    for (const entry of page.entries) {
      assert.ok(entry.sequence > previousSequence, 'Durable transcript pages must preserve strict sequence order without duplicates.');
      previousSequence = entry.sequence;
    }

    pageCount++;
    entries.push(...page.entries);
    highestSequence = page.highestSequence;

    if (!page.hasMore) return { entries, pageCount, highestSequence, nextSequence: page.nextSequence };

    if (page.nextSequence <= afterSequence) throw new Error('Transcript pagination reported more entries without advancing its sequence cursor.');
    afterSequence = page.nextSequence;
  }

  throw new Error('Transcript pagination exceeded the turn retention bound.');
}

function alive(pid) {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;

    throw error;
  }
}

function processBirth(pid) {
  const output = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,pgid=,lstart=,command='], { encoding: 'utf8' }).trim();
  const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/.exec(output);

  if (!match) { throw new Error(`Unable to parse one-row process birth identity for PID ${pid}.`); }

  return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), started: match[4], command: match[5] };
}

function sameProcessBirth(current, record) {
  return current.pid === record.pid && current.pgid === record.pgid && current.started === record.started && current.command === record.command;
}

function processPidWasReused(current, record) {
  return current.pid === record.pid && current.started !== record.started;
}

function fixtureProcessAlive(record) {
  if (!alive(record.pid)) { return false; }

  let current;

  try { current = processBirth(record.pid); }
  catch (error) {
    if (!alive(record.pid)) { return false; }

    throw error;
  }

  if (sameProcessBirth(current, record)) { return true; }
  if (processPidWasReused(current, record)) { return false; }

  throw new Error(`Live PID ${record.pid} no longer matches its captured process identity.`);
}

function fixtureIdentityRecords(identity) {
  const roles = ['guardian', 'provider', 'descendant'];

  assert.deepEqual(Object.keys(identity).sort(), [...roles].sort(), 'The fixture identity must contain exactly the three owned process roles.');

  const records = roles.map(role => {
    const record = identity[role];

    assert.deepEqual(Object.keys(record ?? {}).sort(), ['command', 'pgid', 'pid', 'ppid', 'started'], `The ${role} record must have exactly the supported birth fields.`);
    assert.ok(record && Number.isSafeInteger(record.pid) && record.pid > 0, `The ${role} birth record must contain a valid PID.`);
    assert.ok(Number.isSafeInteger(record.ppid) && record.ppid > 0, `The ${role} birth record must contain a valid PPID.`);
    assert.ok(Number.isSafeInteger(record.pgid) && record.pgid > 0, `The ${role} birth record must contain a valid PGID.`);
    assert.ok(typeof record.started === 'string' && record.started.length > 0, `The ${role} birth record must contain a start identity.`);
    assert.ok(typeof record.command === 'string' && record.command.length > 0, `The ${role} birth record must contain a command identity.`);

    return { role, ...record };
  });

  const guardian = identity.guardian;
  const provider = identity.provider;
  const descendant = identity.descendant;

  assert.equal(guardian.pgid, guardian.pid, 'The guardian must own its process group.');
  assert.equal(provider.ppid, guardian.pid, 'The provider must be a child of the recorded guardian.');
  assert.equal(provider.pgid, guardian.pid, 'The provider must share the guardian-owned process group.');
  assert.equal(descendant.ppid, provider.pid, 'The descendant must be a child of the recorded provider.');
  assert.equal(descendant.pgid, guardian.pid, 'The descendant must share the guardian-owned process group.');

  const currentByRole = new Map();

  for (const record of records) {
    if (!alive(record.pid)) { continue; }

    let current;

    try { current = processBirth(record.pid); }
    catch (error) {
      if (!alive(record.pid)) { continue; }

      throw error;
    }

    if (sameProcessBirth(current, record)) {
      currentByRole.set(record.role, current);
    } else if (!processPidWasReused(current, record)) {
      throw new Error(`Live ${record.role} PID ${record.pid} no longer matches its captured process identity.`);
    }
  }

  for (const record of records) {
    const parentRole = record.role === 'provider' ? 'guardian' : record.role === 'descendant' ? 'provider' : undefined;
    const current = currentByRole.get(record.role);
    const currentParent = parentRole ? currentByRole.get(parentRole) : undefined;

    if (current && currentParent) {
      assert.equal(current.ppid, identity[parentRole].pid, `The live ${record.role} must retain its parent while that exact recorded parent is alive.`);
    }
  }

  return records;
}

function retained(host, handle) {
  return host.read(handle, 0, 500).chunks.map(chunk => chunk.text).join('');
}

const fixturePath = path.join(root, 'interactive-fixture.mjs');

const fixtureSource = `
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(31);
${processBirth.toString()}
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.resume();
process.on('SIGTERM', () => {
  if (process.argv[3] === 'verify-revoke') {
    writeFileSync(process.argv[5], process.argv[4] && existsSync(process.argv[4]) ? 'revoked-before-signal' : 'missing-revocation');
  }
});
const descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});process.send({ready:true});setInterval(()=>{},1000)'], { stdio:['ignore','ignore','ignore','ipc'], detached:false, env:{PATH:process.env.PATH} });
descendant.once('message',()=>{
  const identity = {provider:processBirth(process.pid),guardian:processBirth(process.ppid),descendant:processBirth(descendant.pid)};
  writeFileSync(process.argv[2], JSON.stringify(identity));
  if (process.argv[3]==='immediate') process.stdout.write('IMMEDIATE_WITHOUT_NEWLINE',()=>process.exit(0));
  else process.stdout.write('READY\\n');
});
process.on('SIGWINCH', () => process.stdout.write('SIZE:'+process.stdout.columns+':'+process.stdout.rows+'\\n'));
let pending='';
process.stdin.on('data', chunk => {
  pending += chunk;
  while (pending.includes('\\n')) {
    const end=pending.indexOf('\\n');
    const line=pending.slice(0,end).replace(/\\r$/, '');
    pending=pending.slice(end+1);
    if (line.startsWith('echo:')) process.stdout.write('ECHO:'+line.slice(5)+'\\n');
    if (line==='secret') {
      process.stdout.write(${JSON.stringify(secret.slice(0, 12))});
      setTimeout(()=>process.stdout.write(${JSON.stringify(secret.slice(12))}+'\\n'),25);
    }
    if (line==='flood') {
      for (let i=0;i<2000;i++) process.stdout.write('FLOOD:'+i+':'+'.'.repeat(64)+'\\n');
      process.stdout.write('FLOOD_DONE\\n');
    }
    if (line==='quit') process.stdout.write('FINAL_WITHOUT_NEWLINE',()=>process.exit(0));
  }
});
`;

await writeFile(fixturePath, fixtureSource, { mode: 0o600 });

async function launchFixture(host, label) {
  const identityFile = path.join(root, `${label}.json`);

  const handle = await host.start({
    executable: nodeExecutable,
    args: [fixturePath, identityFile],
    cwd: root,
    env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
    cols: 80,
    rows: 24,
  });

  await until(() => retained(host, handle).includes('READY'), `${label} real TTY ready`);

  const identity = JSON.parse(await readFile(identityFile, 'utf8'));

  for (const record of fixtureIdentityRecords(identity)) { identities.push({ label, ...record }); }

  return handle;
}

const deadline = setTimeout(() => {
  receipt.timeout = true;
  process.exitCode = 1;
  abortController.abort();
}, 90_000);

deadline.unref();

try {
  const cliProbe = await runBoundedAgentCliProcess(nodeExecutable, ['-e', 'process.stdout.write("PACKAGED_PROBE_FINAL")'], {
    env: { PATH: process.env.PATH ?? '' },
    timeoutMs: 5000,
    maxOutputBytes: 1024,
    guardianNodeExecutable: nodeExecutable,
    guardianScriptPath: probeGuardianScriptPath,
  });

  assert.equal(cliProbe.stdout, 'PACKAGED_PROBE_FINAL');
  assert.equal(cliProbe.stderr, '');
  receipt.checks.push('packaged CLI probe guardian and exact final output');

  const host = createHost();
  const a = await launchFixture(host, 'a');
  const b = await launchFixture(host, 'b');
  const liveOutput = [];

  for (let index = 0; index < 10; index++) {
    await assert.rejects(host.attach(a, () => undefined, Number.MAX_SAFE_INTEGER), /cursor/);
  }

  const attachment = await host.attach(a, chunk => liveOutput.push(chunk.text));

  const boundedAttachments = [];

  try {
    for (let index = 0; index < 7; index++) {
      boundedAttachments.push(await host.attach(a, () => undefined));
    }

    await assert.rejects(host.attach(a, () => undefined), /attachment limit/);
  } finally {
    for (const extra of boundedAttachments) extra.dispose();
  }

  receipt.checks.push('real PTY output attachment fanout is bounded and released slots are reusable');

  assert.throws(() => host.getSnapshot(Object.freeze({})), /not created by this host/);
  await host.write(a, 'echo:한글-A\n');
  await host.write(b, 'echo:B\n');
  await until(() => retained(host, a).includes('ECHO:한글-A') && retained(host, b).includes('ECHO:B'), 'independent duplex terminals');
  assert.ok(!retained(host, a).includes('ECHO:B'));
  attachment.dispose();
  await host.write(a, 'echo:detached\n');
  await until(() => retained(host, a).includes('ECHO:detached'), 'detached terminal remains alive');

  const reattached = await host.attach(a, chunk => liveOutput.push(chunk.text));

  await host.resize(a, 101, 33);
  await until(() => retained(host, a).includes('SIZE:101:33'), 'actual PTY dimensions');
  await host.write(a, 'secret\n');
  await until(() => retained(host, a).includes('***'), 'production cross-chunk sanitization');
  assert.ok(!retained(host, a).includes(secret) && !liveOutput.join('').includes(secret));
  await host.write(a, 'flood\n');
  await until(() => retained(host, a).includes('FLOOD_DONE'), 'bounded flood completes');

  const page = host.read(a, 0, 500);

  assert.equal(page.retentionGap, true);
  assert.ok(Buffer.byteLength(page.chunks.map(chunk => chunk.text).join('')) <= 4096);
  assert.ok(page.chunks.every((chunk, index) => index === 0 || chunk.sequence > page.chunks[index - 1].sequence));
  reattached.dispose();
  let providerExit;

  const exitObserver = host.watchExit(a, snapshot => {
    if (snapshot.state === 'exited') providerExit = snapshot;
  });

  try {
    await host.write(a, 'quit\n');
    await until(() => providerExit, 'out-of-band provider exit');
    assert.equal(providerExit.providerExitCode, 0);
  } finally {
    exitObserver.dispose();
  }

  assert.equal((await host.stop(a)).cleanupVerified, true);
  assert.ok(retained(host, a).endsWith('FINAL_WITHOUT_NEWLINE'), 'Verified exit must flush final sanitized output');
  assert.equal((await host.stop(b)).cleanupVerified, true);
  await host.release(a);
  await host.release(b);
  receipt.checks.push('two real TTYs', 'duplex Unicode input', 'detach and reattach', 'resize', 'sanitized pages and listeners', 'retention gap', 'natural exit and final flush', 'TERM-resistant descendant cleanup', 'opaque handles');

  const failureHost = createHost();

  await assert.rejects(failureHost.start({ executable: path.join(root, 'missing-provider'), args: [], cwd: root, env: {}, cols: 80, rows: 24 }), /failed to start/);
  receipt.checks.push('provider spawn failure rejects');

  let taintedRevokeAttempts = 0;
  let allowTaintedRevocation = false;

  const taintedHost = createHost(() => {
    let buffered = '';
    let readyEmitted = false;

    return {
      push(text) {
        buffered += text;

        if (buffered.includes(secret)) throw new Error('fixture sanitizer rejected sensitive data');

        if (!readyEmitted && buffered.includes('READY')) {
          readyEmitted = true;

          return 'READY\n';
        }

        return '';
      },
      flush() { return buffered; },
    };
  }, undefined, () => {
    taintedRevokeAttempts++;

    if (!allowTaintedRevocation) throw new Error('fixture access revocation failed');
  });

  const tainted = await launchFixture(taintedHost, 'tainted');
  const rejectedOutput = [];
  const taintedAttachment = await taintedHost.attach(tainted, chunk => rejectedOutput.push(chunk.text));

  await taintedHost.write(tainted, 'secret\n');
  await until(() => taintedHost.getSnapshot(tainted).outputSanitizerFailed, 'sanitizer failure');
  const firstTaintedStop = await taintedHost.stop(tainted);
  const firstTaintedSnapshot = taintedHost.getSnapshot(tainted);
  const firstTaintedPage = taintedHost.read(tainted, 0);
  receipt.taintedCleanup = {
    first: {
      state: firstTaintedStop.state,
      cleanupVerified: firstTaintedStop.cleanupVerified,
      error: firstTaintedStop.error,
      snapshot: {
        state: firstTaintedSnapshot.state,
        outputSanitizerFailed: firstTaintedSnapshot.outputSanitizerFailed,
        accessRevocationFailed: firstTaintedSnapshot.accessRevocationFailed,
        latestSequence: firstTaintedPage.latestSequence,
        cursor: firstTaintedPage.cursor,
        retentionGap: firstTaintedPage.retentionGap,
        gap: firstTaintedPage.chunks.some(chunk => chunk.gap),
      },
    },
  };
  assert.equal(firstTaintedStop.state, 'cleanupUnverified');
  assert.equal(firstTaintedStop.cleanupVerified, false);
  assert.ok(firstTaintedStop.error && !firstTaintedStop.error.includes(secret), 'Cleanup failure must report a static, non-sensitive host error.');
  assert.notEqual(firstTaintedSnapshot.state, 'stopped', 'Failed revocation must not publish a stopped state.');
  assert.equal(firstTaintedSnapshot.accessRevocationFailed, true);
  assert.ok(!retained(taintedHost, tainted).includes(secret) && !rejectedOutput.join('').includes(secret), 'Failed sanitizer must never flush buffered sensitive text');
  assert.ok(firstTaintedPage.chunks.some(chunk => chunk.gap));
  taintedAttachment.dispose();
  await assert.rejects(taintedHost.release(tainted), /verified stop/i, 'A handle with unverified access revocation must remain owned.');
  allowTaintedRevocation = true;
  receipt.taintedCleanup.retries = [];
  let retryTaintedStop;

  for (let attempt = 0; attempt < 2; attempt++) {
    retryTaintedStop = await taintedHost.stop(tainted);
    receipt.taintedCleanup.retries.push({ state: retryTaintedStop.state, cleanupVerified: retryTaintedStop.cleanupVerified, error: retryTaintedStop.error });

    if (retryTaintedStop.cleanupVerified) break;
  }

  assert.equal(retryTaintedStop.state, 'stopped');
  assert.equal(retryTaintedStop.cleanupVerified, true);
  assert.ok(taintedRevokeAttempts >= 2, 'The exact retained PTY must retry launch access revocation.');
  assert.ok(!retained(taintedHost, tainted).includes(secret) && !rejectedOutput.join('').includes(secret), 'Retry must not expose buffered sensitive data.');
  assert.ok(taintedHost.read(tainted, 0).chunks.some(chunk => chunk.gap));
  await taintedHost.release(tainted);
  receipt.checks.push('sanitizer failure cannot flush raw buffered text', 'failed access revocation blocks stopped publication and release until same-handle retry succeeds');

  const serviceDatabase = WorkspaceDatabase.open(path.join(root, 'agent-session-workspace.db'));

  const failedTranscriptDatabasePath = path.join(root, 'transcript-failure.db');
  const failedTranscriptProjectPath = path.join(root, 'transcript-failure-project');

  await mkdir(failedTranscriptProjectPath);

  let failedTranscriptDatabase = WorkspaceDatabase.open(failedTranscriptDatabasePath);

  const failedTranscriptProject = failedTranscriptDatabase.createProject('Transcript failure fixture');

  const failedTranscriptBinding = failedTranscriptDatabase.createFolderBinding({ projectId: failedTranscriptProject.id, path: failedTranscriptProjectPath });

  const failedTranscriptSession = failedTranscriptDatabase.agentSessions.createSession({
    projectId: failedTranscriptProject.id, bindingId: failedTranscriptBinding.id, name: 'Fail closed', provider: 'codex', model: 'fixture', workspaceMode: 'sharedFolder',
  });

  const failedTranscriptRoot = realpathSync(failedTranscriptProjectPath);

  const failedTranscriptStat = statSync(failedTranscriptRoot, { bigint: true });

  const failedTranscriptSnapshot = {
    schemaVersion: 1, projectId: failedTranscriptProject.id, sessionId: failedTranscriptSession.id,
    sessionRevision: failedTranscriptSession.revision, bindingId: failedTranscriptBinding.id, taskId: null,
    provider: failedTranscriptSession.provider, model: failedTranscriptSession.model, profileRef: null, cwd: failedTranscriptRoot,
    folderIdentity: { canonicalPath: failedTranscriptRoot, dev: failedTranscriptStat.dev.toString(), ino: failedTranscriptStat.ino.toString() },
    managedWorktreeOwnerId: null, permissionPolicy: { mode: 'mutating', approval: 'on-request' }, convention: null, references: [],
  };

  const failedTranscriptTurn = failedTranscriptDatabase.agentSessionTurns.createTurn({
    projectId: failedTranscriptProject.id, sessionId: failedTranscriptSession.id,
    expectedSessionRevision: failedTranscriptSession.revision, snapshot: failedTranscriptSnapshot,
  });

  const failedTranscriptJournal = new AgentSessionJournal(failedTranscriptDatabase.agentSessionTranscripts, failedTranscriptSnapshot, failedTranscriptTurn.id, [secret]);

  const failedTranscriptHost = createHost(undefined, (text, gap) => gap ? failedTranscriptJournal.appendGap() : failedTranscriptJournal.appendTerminal(text));
  const failedTranscriptHandle = await launchFixture(failedTranscriptHost, 'transcript-storage-failure');
  const failureCursorBeforeClose = failedTranscriptDatabase.agentSessionTranscripts.highestSequence(failedTranscriptProject.id, failedTranscriptSession.id, failedTranscriptTurn.id);
  const withheldOutput = [];
  const failedTranscriptAttachment = await failedTranscriptHost.attach(failedTranscriptHandle, chunk => withheldOutput.push(chunk.text));
  failedTranscriptDatabase.close();
  await failedTranscriptHost.write(failedTranscriptHandle, 'echo:must-not-publish\n');
  await until(() => failedTranscriptHost.getSnapshot(failedTranscriptHandle).transcriptPersistenceFailed, 'durable output failure blocks publication');
  let failedTranscriptStop = await failedTranscriptHost.stop(failedTranscriptHandle);
  receipt.transcriptFailureCleanup = [{ ...failedTranscriptStop, snapshot: failedTranscriptHost.getSnapshot(failedTranscriptHandle) }];
  assert.equal(withheldOutput.length, 0, 'Unpersisted terminal output must not reach attached renderers.');
  failedTranscriptAttachment.dispose();

  for (let attempt = 0; !failedTranscriptStop.cleanupVerified && attempt < 2; attempt++) {
    await assert.rejects(failedTranscriptHost.release(failedTranscriptHandle), /verified stop/i, 'Unverified transcript-failure cleanup must retain the exact owned handle');
    failedTranscriptStop = await failedTranscriptHost.stop(failedTranscriptHandle);
    receipt.transcriptFailureCleanup.push({ ...failedTranscriptStop, snapshot: failedTranscriptHost.getSnapshot(failedTranscriptHandle) });
  }

  assert.equal(failedTranscriptStop.state, 'stopped', 'Transcript write failure must stop the exact owned PTY before release.');
  assert.equal(failedTranscriptStop.cleanupVerified, true, 'Transcript write failure must still clean the exact owned PTY.');
  assert.equal(retained(failedTranscriptHost, failedTranscriptHandle).includes('must-not-publish'), false, 'Cleanup retries must not expose output that failed durable persistence.');
  await failedTranscriptHost.release(failedTranscriptHandle);
  failedTranscriptDatabase = WorkspaceDatabase.open(failedTranscriptDatabasePath);
  const failedTranscriptPage = failedTranscriptDatabase.agentSessionTranscripts.readPage(failedTranscriptProject.id, failedTranscriptSession.id, failedTranscriptTurn.id);
  assert.ok(failedTranscriptPage.entries.some(entry => entry.kind === 'terminal' && entry.text.includes('READY')));
  assert.equal(failedTranscriptPage.highestSequence, failureCursorBeforeClose, 'Failed SQLite writes must not advance the durable transcript cursor.');
  failedTranscriptDatabase.close();
  receipt.checks.push('real SQLite transcript failure withholds uncommitted output while verified PTY cleanup succeeds');

  ownedServiceDatabase = serviceDatabase;
  const serviceFolder = path.join(root, 'agent-session-folder');
  const profileRoot = path.join(root, 'agent-session-profile');
  await mkdir(serviceFolder);
  await mkdir(profileRoot);
  await writeFile(path.join(serviceFolder, 'README.md'), 'Native ordinary-folder service fixture\n');

  const project = serviceDatabase.createProject('Native PTY service fixture');
  const binding = serviceDatabase.createFolderBinding({ projectId: project.id, path: serviceFolder });
  serviceDatabase.enableOrdinaryFolderMutation(project.id, binding.id);
  const serviceWriterLock = new TaskFolderWriterLock();
  const worktrees = new ManagedWorktreeService(path.join(root, 'managed-worktrees'));
  const resolver = new AgentSessionWorkspaceResolver(serviceDatabase, worktrees, serviceWriterLock, () => recoveryReady);
  let recoveryReady = false;
  const launchModes = new Map();
  const verifiedPreparationFailureSessions = new Set();
  const turnIdentities = new Map();
  const resourceEvents = new Map();
  let blockedPreparationEntered;
  let notifyBlockedPreparationEntered;
  const blockedPreparation = new Promise(resolve => { notifyBlockedPreparationEntered = resolve; });

  const runtimeFactory = new AgentSessionPtyRuntimeFactory({
    guardianNodeExecutable: nodeExecutable,
    guardianScriptPath,
    createJournal: (snapshot, turnId, knownSecrets) => new AgentSessionJournal(serviceDatabase.agentSessionTranscripts, snapshot, turnId, knownSecrets),
    prepareLaunch: async (snapshot, turnId, signal) => {
      const mode = launchModes.get(snapshot.sessionId) ?? 'normal';

      if (mode === 'verified-preparation-failure' && !verifiedPreparationFailureSessions.has(snapshot.sessionId)) {
        verifiedPreparationFailureSessions.add(snapshot.sessionId);
        throw new AgentSessionPreparationError('Fixture provider CLI is unavailable.', true);
      }

      if (mode === 'hold-until-abort') {
        blockedPreparationEntered = true;
        notifyBlockedPreparationEntered();
        await new Promise((resolve, reject) => {
          if (signal.aborted) {
            reject(new Error('cancelled'));

            return;
          }

          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
      }

      const identityFile = path.join(root, `service-${turnId}.json`);
      turnIdentities.set(turnId, identityFile);
      resourceEvents.set(turnId, []);
      const revocationMarker = `${identityFile}.revoked`;
      const terminationEvidence = `${identityFile}.termination`;
      const fixtureMode = mode === 'immediate' ? 'immediate' : mode === 'verify-revoke' ? 'verify-revoke' : 'normal';
      const args = [fixturePath, identityFile, fixtureMode, revocationMarker, terminationEvidence];
      const environment = { CODEX_HOME: profileRoot };

      const launchEnvironment = {
        ...environment,
        PATH: '/usr/bin:/bin',
        HOME: os.homedir(),
        TMPDIR: os.tmpdir(),
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        USER: os.userInfo().username,
        LOGNAME: os.userInfo().username,
      };

      const launch = { executable: nodeExecutable, args, cwd: snapshot.cwd, env: launchEnvironment, cols: 80, rows: 24 };

      return {
        command: {
          commandSpecVersion: AGENT_CLI_COMMAND_SPEC_VERSION,
          provider: snapshot.provider,
          cliVersion: 'disposable-node-fixture',
          model: snapshot.model,
          profileRef: snapshot.profileRef,
          cwd: snapshot.cwd,
          executable: nodeExecutable,
          args,
          env: environment,
          forwardedMcpEnvironmentVariableNames: [],
        },
        permissionPolicy: snapshot.permissionPolicy,
        profileDirectory: profileRoot,
        launch,
        knownSecrets: [secret],
        revokeAccess: () => {
          if (mode === 'verify-revoke') { writeFileSync(revocationMarker, 'revoked'); }

          resourceEvents.get(turnId).push('access-revoked');
        },
        releasePrivateConfig: async () => {
          const events = resourceEvents.get(turnId);
          events.push('private-config-released');

          try {
            const identity = JSON.parse(await readFile(identityFile, 'utf8'));

            for (const { role, pid } of fixtureIdentityRecords(identity)) {
              assert.equal(fixtureProcessAlive({ pid, ...identity[role] }), false, `The ${role} process must be gone before private configuration release.`);
            }
          } catch (error) {
            if (error.code !== 'ENOENT') { throw error; }
          }
        },
      };
    },
  });

  const service = new AgentSessionService(serviceDatabase, resolver, runtimeFactory);

  ownedAgentSessionService = service;
  service.recoverStartup();
  recoveryReady = true;

  async function createSession(name) {
    return serviceDatabase.agentSessions.createSession({
      projectId: project.id,
      bindingId: binding.id,
      name,
      provider: 'codex',
      model: 'fixture-model',
      profileRef: 'fixture-profile',
      workspaceMode: 'sharedFolder',
    });
  }

  async function previewSession(session, mode = 'normal') {
    launchModes.set(session.id, mode);

    return service.preview({ projectId: project.id, sessionId: session.id, permissionPolicy: { mode: 'mutating', approval: 'on-request' } });
  }

  async function recordOwnedIdentity(turnId, label) {
    const identityFile = turnIdentities.get(turnId);

    const identity = await until(async () => {
      try { return JSON.parse(await readFile(identityFile, 'utf8')); }
      catch (error) {
        if (error.code === 'ENOENT') { return false; }

        throw error;
      }
    }, `${label} provider identity`);

    for (const record of fixtureIdentityRecords(identity)) { identities.push({ label, ...record }); }
  }

  const verifiedPreparationSession = await createSession('Verified provider preflight failure retry');
  const verifiedPreparationPreview = await previewSession(verifiedPreparationSession, 'verified-preparation-failure');
  await assert.rejects(
    service.start({ projectId: project.id, sessionId: verifiedPreparationSession.id, ticketId: verifiedPreparationPreview.ticketId }),
    /provider failed to start/i,
  );

  const verifiedPreparationFailedTurn = serviceDatabase.agentSessionTurns.listTurns(project.id, verifiedPreparationSession.id)[0];
  assert.equal(verifiedPreparationFailedTurn.state, 'failed');
  assert.equal(verifiedPreparationFailedTurn.cleanupVerified, true, 'A trusted pre-PTY rejection with no resources must release the workspace.');
  assert.equal(turnIdentities.has(verifiedPreparationFailedTurn.id), false, 'A verified preflight rejection must not create a PTY identity.');
  const verifiedPreparationRetryPreview = await previewSession(verifiedPreparationSession, 'normal');
  const verifiedPreparationRetryTurn = await service.start({ projectId: project.id, sessionId: verifiedPreparationSession.id, ticketId: verifiedPreparationRetryPreview.ticketId });
  const verifiedPreparationRetryStopped = await service.stop(project.id, verifiedPreparationSession.id, verifiedPreparationRetryTurn.id);
  assert.equal(verifiedPreparationRetryStopped.cleanupVerified, true, 'A verified pre-PTY failure must allow a later turn in the same workspace.');

  receipt.checks.push('verified pre-PTY provider failure records cleanly and allows a later turn in the same workspace');

  const unknownPreparationFactory = new AgentSessionPtyRuntimeFactory({
    guardianNodeExecutable: nodeExecutable,
    guardianScriptPath,
    prepareLaunch: async () => { throw new Error('Fixture unknown preparer failure.'); },
  });

  const unknownSnapshot = { provider: 'codex', sessionId: 'unknown-preparation-fixture' };
  let unknownPreparationHandle;

  await assert.rejects(
    unknownPreparationFactory.start(unknownSnapshot, 'unknown-preparation-turn', new AbortController().signal),
    error => {
      assert.ok(error instanceof AgentSessionRuntimeStartError);
      assert.equal(error.cleanupVerified, false, 'An unclassified preparer rejection must remain unverified.');
      unknownPreparationHandle = error.recoveryHandle;

      return Boolean(unknownPreparationHandle);
    },
  );
  assert.equal((await unknownPreparationFactory.stop(unknownPreparationHandle)).cleanupVerified, false, 'Unknown preparation failures must retain a blocking recovery handle.');
  receipt.checks.push('unknown preparation failure remains cleanup-unverified and retains its runtime handle');

  const naturalSession = await createSession('Service natural exit');
  const naturalPreview = await previewSession(naturalSession);
  const naturalTurn = await service.start({ projectId: project.id, sessionId: naturalSession.id, ticketId: naturalPreview.ticketId });

  const beforeAttachmentPage = await until(() => {
    const page = serviceDatabase.agentSessionTranscripts.readPage(project.id, naturalSession.id, naturalTurn.id);

    return page.entries.some(entry => entry.kind === 'terminal' && entry.text.includes('READY')) ? page : false;
  }, 'first PTY output durable before any renderer attaches');

  assert.ok(beforeAttachmentPage.entries.some(entry => entry.kind === 'terminal' && entry.text.includes('READY')),
    'The first PTY output must be durable before any renderer attaches.');
  await recordOwnedIdentity(naturalTurn.id, 'service-natural');
  const firstOutput = [];
  const firstAttachment = await service.attach(project.id, naturalSession.id, naturalTurn.id, chunk => firstOutput.push(chunk.text));
  await service.write(project.id, naturalSession.id, naturalTurn.id, 'secret\n');
  await until(() => serviceDatabase.agentSessionTranscripts.readPage(project.id, naturalSession.id, naturalTurn.id).entries
    .some(entry => entry.kind === 'terminal' && entry.text.includes('***')), 'cross-chunk secret redaction persisted');
  const redactedTranscript = serviceDatabase.agentSessionTranscripts.readPage(project.id, naturalSession.id, naturalTurn.id).entries;
  assert.ok(!redactedTranscript.some(entry => entry.text.includes(secret)), 'Known secrets must be redacted before durable publication.');
  assert.ok(!redactedTranscript.some(entry => entry.text === 'secret\n'), 'PTY input must never be stored in the transcript.');

  const boundedServiceAttachments = [];

  try {
    for (let index = 0; index < 7; index++) {
      boundedServiceAttachments.push(await service.attach(project.id, naturalSession.id, naturalTurn.id, () => undefined));
    }

    await assert.rejects(service.attach(project.id, naturalSession.id, naturalTurn.id, () => undefined), /attachment limit/);
  } finally {
    for (const extra of boundedServiceAttachments) service.detach(project.id, naturalSession.id, naturalTurn.id, extra.attachmentId);
  }

  await service.write(project.id, naturalSession.id, naturalTurn.id, 'echo:service-duplex\n');
  await until(() => firstOutput.join('').includes('ECHO:service-duplex'), 'service scoped duplex output');
  service.detach(project.id, naturalSession.id, naturalTurn.id, firstAttachment.attachmentId);
  assert.throws(() => service.read(project.id, naturalSession.id, naturalTurn.id, firstAttachment.attachmentId, 0), /not owned/i);
  const finalOutput = [];
  const finalAttachment = await service.attach(project.id, naturalSession.id, naturalTurn.id, chunk => finalOutput.push(chunk.text));
  await service.write(project.id, naturalSession.id, naturalTurn.id, 'quit\n');

  const naturalTerminal = await until(() => {
    const current = serviceDatabase.agentSessionTurns.getTurn(project.id, naturalSession.id, naturalTurn.id);

    return current?.state === 'exited' && current.cleanupVerified ? current : false;
  }, 'service natural exit and verified cleanup');

  assert.ok(finalOutput.join('').endsWith('FINAL_WITHOUT_NEWLINE'), 'Active service attachment must receive the final output without a newline');

  const finalTranscriptPage = readCompleteTranscript(options =>
    serviceDatabase.agentSessionTranscripts.readPage(project.id, naturalSession.id, naturalTurn.id, options));

  const finalTranscript = finalTranscriptPage.entries;
  const terminalEntries = finalTranscript.filter(entry => entry.kind === 'terminal');

  const durableTerminalOutput = terminalEntries
    .map(entry => entry.text)
    .join('');

  receipt.finalTranscript = {
    pageCount: finalTranscriptPage.pageCount,
    entryCount: finalTranscript.length,
    highestSequence: finalTranscriptPage.highestSequence,
    nextSequence: finalTranscriptPage.nextSequence,
    terminalEntryCount: terminalEntries.length,
    orderedTerminalSequences: terminalEntries.map(entry => entry.sequence),
    finalOutputSuffixDurable: durableTerminalOutput.endsWith('FINAL_WITHOUT_NEWLINE'),
  };
  assert.ok(durableTerminalOutput.endsWith('FINAL_WITHOUT_NEWLINE'),
    'The final sanitizer flush must be durable before the provider turn is finalized.');
  assert.equal(resourceEvents.get(naturalTurn.id).join(','), 'access-revoked,private-config-released');
  assert.equal(naturalTerminal.state, 'exited');
  assert.throws(() => service.read(project.id, naturalSession.id, naturalTurn.id, finalAttachment.attachmentId, 0), /not owned/i);
  receipt.checks.push('real SQLite/Git workspace resolver and service natural-exit lifecycle', 'scoped attach, duplex output, detach, and final no-newline delivery');

  const persistenceFailureSession = await createSession('SQLite transcript insertion failure');
  const persistenceFailurePreview = await previewSession(persistenceFailureSession);

  const persistenceFailureTurn = await service.start({ projectId: project.id, sessionId: persistenceFailureSession.id, ticketId: persistenceFailurePreview.ticketId });

  await recordOwnedIdentity(persistenceFailureTurn.id, 'service-transcript-failure');

  const sqlite = new DatabaseSync(path.join(root, 'agent-session-workspace.db'));

  sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  let triggerCreated = false;

  const terminalEntriesBeforeFailure = serviceDatabase.agentSessionTranscripts.readPage(project.id, persistenceFailureSession.id, persistenceFailureTurn.id).entries
    .filter(entry => entry.kind === 'terminal').length;

  try {
    sqlite.exec(`CREATE TRIGGER fail_selected_transcript_entry BEFORE INSERT ON agent_session_transcript_entries
      WHEN NEW.turn_id = '${persistenceFailureTurn.id}' AND NEW.kind = 'terminal'
      BEGIN SELECT RAISE(ABORT, 'fixture transcript write rejection'); END;`);
    triggerCreated = true;

    const failedOutput = [];

    const persistenceFailureAttachment = await service.attach(project.id, persistenceFailureSession.id, persistenceFailureTurn.id, chunk => failedOutput.push(chunk.text));

    await service.write(project.id, persistenceFailureSession.id, persistenceFailureTurn.id, 'echo:must-not-publish\n');

    const persistenceFailedTurn = await until(() => {
      const current = serviceDatabase.agentSessionTurns.getTurn(project.id, persistenceFailureSession.id, persistenceFailureTurn.id);

      return current?.state === 'failed' && current.cleanupVerified ? current : false;
    }, 'SQLite transcript failure summary with verified process cleanup');

    assert.match(persistenceFailedTurn.errorSummary, /transcript could not be written/i);
    assert.equal(failedOutput.length, 0, 'The next terminal write is withheld regardless of output chunk boundaries.');
    assert.equal(serviceDatabase.agentSessionTranscripts.readPage(project.id, persistenceFailureSession.id, persistenceFailureTurn.id).entries
      .filter(entry => entry.kind === 'terminal').length, terminalEntriesBeforeFailure, 'The scoped trigger must reject the next terminal write regardless of its chunk contents.');
    assert.throws(
      () => service.detach(project.id, persistenceFailureSession.id, persistenceFailureTurn.id, persistenceFailureAttachment.attachmentId),
      /not owned/i,
      'A verified failed-turn cleanup must revoke its output attachment before returning.',
    );
  } finally {
    try {
      if (triggerCreated) sqlite.exec('DROP TRIGGER fail_selected_transcript_entry;');
    } finally {
      sqlite.close();
    }
  }

  receipt.checks.push('SQLite insert rejection becomes a durable failed turn while renderer output is withheld and PTY cleanup remains verified');

  const stoppedSession = await createSession('Service explicit stop');
  const stoppedPreview = await previewSession(stoppedSession, 'verify-revoke');
  const stoppedTurn = await service.start({ projectId: project.id, sessionId: stoppedSession.id, ticketId: stoppedPreview.ticketId });
  await recordOwnedIdentity(stoppedTurn.id, 'service-explicit-stop');
  const stoppedAttachment = await service.attach(project.id, stoppedSession.id, stoppedTurn.id, () => undefined);
  const stopped = await service.stop(project.id, stoppedSession.id, stoppedTurn.id);
  assert.equal(stopped.state, 'exited');
  assert.equal(stopped.cleanupVerified, true);
  assert.throws(() => service.read(project.id, stoppedSession.id, stoppedTurn.id, stoppedAttachment.attachmentId, 0), /not owned/i);
  assert.equal(resourceEvents.get(stoppedTurn.id).join(','), 'access-revoked,private-config-released');
  const terminationEvidence = `${turnIdentities.get(stoppedTurn.id)}.termination`;
  assert.equal(await readFile(terminationEvidence, 'utf8'), 'revoked-before-signal', 'Synchronous access revocation must be visible before the PTY receives its stop signal.');
  const lockProbeSession = await createSession('Workspace release proof');
  const lockProbe = new AbortController();
  const lockProbeTimeout = setTimeout(() => lockProbe.abort(), 5000);

  try {
    const reacquired = await resolver.acquire({ projectId: project.id, sessionId: lockProbeSession.id, permissionPolicy: { mode: 'mutating', approval: 'on-request' }, signal: lockProbe.signal });
    resolver.release(reacquired);
  } finally { clearTimeout(lockProbeTimeout); }

  receipt.checks.push('explicit stop revokes access, cleans the real PTY, releases private config, then frees the workspace lock');

  const constructionCleanupEvents = [];
  let constructionIdentityFile;
  let revokeAttempts = 0;

  const constructionFailureFactory = new AgentSessionPtyRuntimeFactory({
    guardianNodeExecutable: 'relative-node-must-fail-host-construction',
    guardianScriptPath: 'relative-guardian-must-fail-host-construction',
    prepareLaunch: async (snapshot, turnId) => {
      constructionIdentityFile = path.join(root, `construction-failure-${turnId}.json`);
      const args = [fixturePath, constructionIdentityFile];
      const environment = { CODEX_HOME: profileRoot };

      return {
        command: {
          commandSpecVersion: AGENT_CLI_COMMAND_SPEC_VERSION,
          provider: snapshot.provider,
          cliVersion: 'disposable-node-fixture',
          model: snapshot.model,
          profileRef: snapshot.profileRef,
          cwd: snapshot.cwd,
          executable: nodeExecutable,
          args,
          env: environment,
          forwardedMcpEnvironmentVariableNames: [],
        },
        permissionPolicy: snapshot.permissionPolicy,
        profileDirectory: profileRoot,
        launch: { executable: nodeExecutable, args, cwd: snapshot.cwd, env: environment, cols: 80, rows: 24 },
        knownSecrets: [secret],
        revokeAccess: () => {
          revokeAttempts++;
          constructionCleanupEvents.push(`revoke-attempt-${revokeAttempts}`);

          if (revokeAttempts === 1) { throw new Error('Fixture revocation failure.'); }
        },
        releasePrivateConfig: async () => { constructionCleanupEvents.push('private-config-released'); },
      };
    },
  });

  const constructionFailureService = new AgentSessionService(serviceDatabase, resolver, constructionFailureFactory);
  constructionFailureService.recoverStartup();
  const constructionFailureSession = await createSession('Runtime construction cleanup retry');

  const constructionFailurePreview = await constructionFailureService.preview({
    projectId: project.id,
    sessionId: constructionFailureSession.id,
    permissionPolicy: { mode: 'mutating', approval: 'on-request' },
  });

  await assert.rejects(
    constructionFailureService.start({ projectId: project.id, sessionId: constructionFailureSession.id, ticketId: constructionFailurePreview.ticketId }),
    /failed to start/i,
  );
  const constructionFailureTurn = serviceDatabase.agentSessionTurns.listTurns(project.id, constructionFailureSession.id)[0];
  assert.equal(constructionFailureTurn.state, 'failed');
  assert.equal(constructionFailureTurn.cleanupVerified, true, 'Service startup cleanup must retry the factory-owned configuration cleanup handle.');
  const constructionCleanupRetry = await constructionFailureService.stop(project.id, constructionFailureSession.id, constructionFailureTurn.id);
  assert.equal(constructionCleanupRetry.cleanupVerified, true, 'The retained logical runtime handle must retry configuration-only cleanup.');
  assert.deepEqual(constructionCleanupEvents, ['revoke-attempt-1', 'revoke-attempt-2', 'private-config-released']);
  assert.equal(existsSync(constructionIdentityFile), false, 'Host construction failure must not create a PTY process.');
  receipt.checks.push('host-construction failure retains its logical runtime handle and retries failed revocation before private-config release');

  const immediateSession = await createSession('Service immediate exit');
  const immediatePreview = await previewSession(immediateSession, 'immediate');
  const immediateTurn = await service.start({ projectId: project.id, sessionId: immediateSession.id, ticketId: immediatePreview.ticketId });
  await recordOwnedIdentity(immediateTurn.id, 'service-immediate-exit');

  const immediateTerminal = await until(() => {
    const current = serviceDatabase.agentSessionTurns.getTurn(project.id, immediateSession.id, immediateTurn.id);

    return current?.state === 'exited' && current.cleanupVerified ? current : false;
  }, 'service immediate exit replay and cleanup');

  assert.equal(immediateTerminal.state, 'exited');
  assert.equal(resourceEvents.get(immediateTurn.id).join(','), 'access-revoked,private-config-released');
  receipt.checks.push('service immediate-exit replay without renderer polling or TTY inference');

  const startingSession = await createSession('Service stop during preparation');
  const startingPreview = await previewSession(startingSession, 'hold-until-abort');
  const startingPromise = service.start({ projectId: project.id, sessionId: startingSession.id, ticketId: startingPreview.ticketId });
  await blockedPreparation;
  assert.equal(blockedPreparationEntered, true);
  const startingTurn = serviceDatabase.agentSessionTurns.listTurns(project.id, startingSession.id)[0];
  assert.ok(startingTurn, 'The durable starting turn must exist before trusted runtime preparation.');
  const stoppedDuringStart = await service.stop(project.id, startingSession.id, startingTurn.id);
  assert.equal(stoppedDuringStart.cleanupVerified, true);
  await startingPromise;
  assert.deepEqual(resourceEvents.get(startingTurn.id), undefined, 'Cancellation before preparation returns no runtime resource callbacks or PTY handle.');
  receipt.checks.push('stop during trusted preparation aborts before PTY creation and records verified cleanup');

  const serviceReceipts = await service.shutdown();

  receipt.cleanup.push(...serviceReceipts);

  assert.ok(serviceReceipts.every(result => result.cleanupVerified), 'Every service-owned turn must report verified PTY cleanup.');

  serviceDatabase.close();

  ownedServiceDatabase = undefined;

  ownedAgentSessionService = undefined;
} catch (error) {
  receipt.failure = error instanceof Error ? error.message : 'Unknown PTY probe failure';
  process.exitCode = 1;
} finally {
  if (ownedAgentSessionService) {
    try { receipt.cleanup.push(...await ownedAgentSessionService.shutdown()); }
    catch (error) { receipt.cleanup.push({ cleanupVerified: false, error: error instanceof Error ? error.message : 'Unknown service cleanup failure' }); }
  }

  if (ownedServiceDatabase) {
    try { ownedServiceDatabase.close(); }
    catch (error) { receipt.cleanup.push({ cleanupVerified: false, error: error instanceof Error ? error.message : 'Unknown database cleanup failure' }); }
  }

  for (const host of hosts) {
    try {
      const results = await host.shutdown();

      receipt.cleanup.push(...results);
    } catch (error) {
      receipt.cleanup.push({ cleanupVerified: false, error: error instanceof Error ? error.message : 'Unknown cleanup failure' });
    }
  }

  try {
    await until(() => identities.every(identity => !fixtureProcessAlive(identity)), 'all recorded owned fixture process identities gone', 15_000, true);
    receipt.ownedProcessesGone = true;
  } catch {
    receipt.ownedProcessesGone = false;
  }

  const cleanupVerified = receipt.ownedProcessesGone && receipt.cleanup.every(result => result.cleanupVerified);

  receipt.cleanupVerified = cleanupVerified;
  receipt.finalHostState = hostState();

  if (!cleanupVerified) process.exitCode = 1;

  await writeFile(path.join(evidencePath, 'pty-receipt.json'), JSON.stringify(receipt, null, 2));
  clearTimeout(deadline);
  process.removeListener('SIGINT', requestAbort);
  process.removeListener('SIGTERM', requestAbort);

  if (cleanupVerified) {
    await rm(root, { recursive: true });
  } else {
    setTimeout(() => process.exit(1), 1000);
  }
}
