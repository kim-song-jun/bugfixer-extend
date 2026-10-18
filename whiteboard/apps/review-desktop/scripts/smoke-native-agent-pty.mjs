/** Run real PTY contracts inside the packaged Electron runtime on the macOS CI runner. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants, existsSync, writeFileSync } from 'node:fs';
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

const hostModule = path.join(resources, 'out', 'vs', 'workspace', 'electron-main', 'agentSessions', 'agentPtyHost.js');

const sessionModules = path.dirname(hostModule);

const probeGuardianScriptPath = path.join(sessionModules, 'agentCliProbeGuardian.mjs');

await mkdir(evidencePath, { recursive: true });

await access(nodeExecutable, constants.X_OK);

await access(guardianScriptPath, constants.R_OK);

await access(probeGuardianScriptPath, constants.R_OK);

const { AgentPtyHost } = await import(pathToFileURL(hostModule).href);

const { runBoundedAgentCliProcess } = await import(pathToFileURL(path.join(sessionModules, 'agentCliProcess.js')).href);

const { createAgentPtyOutputSanitizer } = await import(pathToFileURL(path.join(sessionModules, 'agentOutputRedactor.js')).href);

const { AgentSessionPtyRuntimeFactory } = await import(pathToFileURL(path.join(sessionModules, 'agentSessionPtyRuntime.js')).href);

const { AGENT_CLI_COMMAND_SPEC_VERSION } = await import(pathToFileURL(path.join(sessionModules, 'agentCliCapabilities.js')).href);

const { AgentSessionService } = await import(pathToFileURL(path.join(sessionModules, 'agentSessionService.js')).href);

const { AgentSessionWorkspaceResolver } = await import(pathToFileURL(path.join(sessionModules, 'agentSessionWorkspace.js')).href);

const { ManagedWorktreeService } = await import(pathToFileURL(path.join(sessionModules, 'managedWorktrees.js')).href);

const { TaskFolderWriterLock } = await import(pathToFileURL(path.join(resources, 'out', 'vs', 'workspace', 'electron-main', 'providerRuns', 'taskFolderWriterLock.js')).href);

const { WorkspaceDatabase } = await import(pathToFileURL(path.join(resources, 'out', 'vs', 'workspace', 'electron-main', 'workspaceDatabase.js')).href);

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

function createHost(createSanitizer = () => createAgentPtyOutputSanitizer({ knownSecrets: [secret] })) {
  const host = new AgentPtyHost({
    guardianNodeExecutable: nodeExecutable,
    guardianScriptPath,
    createSanitizer,
    // The direct host contracts use a disposable fixture with no launch-scoped access.
    revokeAccess: () => {},
    maxOutputBytes: 4096,
    maxOutputChunks: 16,
  });

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

function alive(pid) {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;

    throw error;
  }
}

function retained(host, handle) {
  return host.read(handle, 0, 500).chunks.map(chunk => chunk.text).join('');
}

const fixturePath = path.join(root, 'interactive-fixture.mjs');

const fixtureSource = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(31);
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
  writeFileSync(process.argv[2], JSON.stringify({provider:process.pid,guardian:process.ppid,descendant:descendant.pid}));
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

  for (const [role, pid] of Object.entries(identity)) {
    assert.ok(Number.isSafeInteger(pid) && pid > 0);

    const pgid = Number(execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf8' }).trim());

    assert.equal(pgid, identity.guardian, 'Provider and descendant must share the real guardian-owned process group');
    identities.push({ label, role, pid, pgid });
  }

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
  const attachment = await host.attach(a, chunk => liveOutput.push(chunk.text));

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
  await host.write(a, 'quit\n');
  await until(() => host.getSnapshot(a).state === 'exited', 'out-of-band provider exit');
  assert.equal(host.getSnapshot(a).providerExitCode, 0);
  assert.equal((await host.stop(a)).cleanupVerified, true);
  assert.ok(retained(host, a).endsWith('FINAL_WITHOUT_NEWLINE'), 'Verified exit must flush final sanitized output');
  assert.equal((await host.stop(b)).cleanupVerified, true);
  await host.release(a);
  await host.release(b);
  receipt.checks.push('two real TTYs', 'duplex Unicode input', 'detach and reattach', 'resize', 'sanitized pages and listeners', 'retention gap', 'natural exit and final flush', 'TERM-resistant descendant cleanup', 'opaque handles');

  const failureHost = createHost();

  await assert.rejects(failureHost.start({ executable: path.join(root, 'missing-provider'), args: [], cwd: root, env: {}, cols: 80, rows: 24 }), /failed to start/);
  receipt.checks.push('provider spawn failure rejects');

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
  });

  const tainted = await launchFixture(taintedHost, 'tainted');
  const rejectedOutput = [];
  const taintedAttachment = await taintedHost.attach(tainted, chunk => rejectedOutput.push(chunk.text));

  await taintedHost.write(tainted, 'secret\n');
  await until(() => taintedHost.getSnapshot(tainted).outputSanitizerFailed, 'sanitizer failure');
  assert.equal((await taintedHost.stop(tainted)).cleanupVerified, true);
  assert.ok(!retained(taintedHost, tainted).includes(secret) && !rejectedOutput.join('').includes(secret), 'Failed sanitizer must never flush buffered sensitive text');
  assert.ok(taintedHost.read(tainted, 0).chunks.some(chunk => chunk.gap));
  taintedAttachment.dispose();
  await taintedHost.release(tainted);
  receipt.checks.push('sanitizer failure cannot flush raw buffered text');

  const serviceDatabase = WorkspaceDatabase.open(path.join(root, 'agent-session-workspace.db'));

  ownedServiceDatabase = serviceDatabase;
  const gitRoot = path.join(root, 'agent-session-git');
  const profileRoot = path.join(root, 'agent-session-profile');
  await mkdir(gitRoot);
  await mkdir(profileRoot);
  execFileSync('git', ['-C', gitRoot, 'init', '-q', '-b', 'fixture'], { encoding: 'utf8' });
  execFileSync('git', ['-C', gitRoot, 'config', 'user.name', 'Native Session Fixture'], { encoding: 'utf8' });
  execFileSync('git', ['-C', gitRoot, 'config', 'user.email', 'native-session-fixture@example.invalid'], { encoding: 'utf8' });
  await writeFile(path.join(gitRoot, 'README.md'), 'Native service fixture\n');
  execFileSync('git', ['-C', gitRoot, 'add', 'README.md'], { encoding: 'utf8' });
  execFileSync('git', ['-C', gitRoot, 'commit', '-qm', 'native service fixture'], { encoding: 'utf8' });

  const project = serviceDatabase.createProject('Native PTY service fixture');
  const binding = serviceDatabase.createFolderBinding({ projectId: project.id, path: gitRoot, vcsKind: 'git', vcsRoot: gitRoot });
  serviceDatabase.enableOrdinaryFolderMutation(project.id, binding.id);
  const serviceWriterLock = new TaskFolderWriterLock();
  const worktrees = new ManagedWorktreeService(path.join(root, 'managed-worktrees'));
  const resolver = new AgentSessionWorkspaceResolver(serviceDatabase, worktrees, serviceWriterLock, () => recoveryReady);
  let recoveryReady = false;
  const launchModes = new Map();
  const turnIdentities = new Map();
  const resourceEvents = new Map();
  let blockedPreparationEntered;
  let notifyBlockedPreparationEntered;
  const blockedPreparation = new Promise(resolve => { notifyBlockedPreparationEntered = resolve; });

  const runtimeFactory = new AgentSessionPtyRuntimeFactory({
    guardianNodeExecutable: nodeExecutable,
    guardianScriptPath,
    prepareLaunch: async (snapshot, turnId, signal) => {
      const mode = launchModes.get(snapshot.sessionId) ?? 'normal';

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
      const launch = { executable: nodeExecutable, args, cwd: snapshot.cwd, env: environment, cols: 80, rows: 24 };

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

            for (const [role, pid] of Object.entries(identity)) {
              assert.equal(alive(pid), false, `The ${role} process must be gone before private configuration release.`);
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

    for (const [role, pid] of Object.entries(identity)) {
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      const pgid = Number(execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf8' }).trim());
      assert.equal(pgid, identity.guardian, 'Service provider and descendant must share the guardian-owned process group');
      identities.push({ label, role, pid, pgid });
    }
  }

  const naturalSession = await createSession('Service natural exit');
  const naturalPreview = await previewSession(naturalSession);
  const naturalTurn = await service.start({ projectId: project.id, sessionId: naturalSession.id, ticketId: naturalPreview.ticketId });
  await recordOwnedIdentity(naturalTurn.id, 'service-natural');
  const firstOutput = [];
  const firstAttachment = await service.attach(project.id, naturalSession.id, naturalTurn.id, chunk => firstOutput.push(chunk.text));
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
  assert.equal(resourceEvents.get(naturalTurn.id).join(','), 'access-revoked,private-config-released');
  assert.equal(naturalTerminal.state, 'exited');
  assert.throws(() => service.read(project.id, naturalSession.id, naturalTurn.id, finalAttachment.attachmentId, 0), /not owned/i);
  receipt.checks.push('real SQLite/Git workspace resolver and service natural-exit lifecycle', 'scoped attach, duplex output, detach, and final no-newline delivery');

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
    await until(() => identities.every(identity => !alive(identity.pid)), 'all recorded owned fixture processes gone', 15_000, true);
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
