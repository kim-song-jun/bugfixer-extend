import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const DEFAULT_TIMEOUTS = {
  rootGraceMs: 2_000,
  termGraceMs: 10_000,
  killGraceMs: 5_000,
  leaderCloseMs: 5_000,
};

export class ProcessIdentityRefusal extends Error {
  constructor(expected, reason, observed) {
    super(reason);
    this.name = 'ProcessIdentityRefusal';
    this.diagnostic = {
      kind: 'process-identity-mismatch',
      pid: expected.pid,
      expected: describeIdentity(expected),
      observed: observed ? describeIdentity(observed) : null,
    };
  }
}

function describeIdentity(identity) {
  return {
    pgid: identity.pgid,
    started: identity.started,
    stat: identity.stat,
    commandSha256: createHash('sha256').update(identity.command).digest('hex'),
  };
}

export function processInventory() {
  const output = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart=,command='], {
    encoding: 'utf8', timeout: 3_000, maxBuffer: 8 * 1024 * 1024,
  });

  const inventory = new Map();

  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/);

    if (fields.length < 10) continue;
    const pid = Number(fields[0]);
    const ppid = Number(fields[1]);
    const pgid = Number(fields[2]);

    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid)) continue;
    inventory.set(pid, { pid, ppid, pgid, stat: fields[3], started: fields.slice(4, 9).join(' '), command: fields.slice(9).join(' ') });
  }

  return inventory;
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

export function processGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);

    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

export function sameProcessIdentity(expected, actual) {
  return !!actual && expected.pid === actual.pid && expected.pgid === actual.pgid
    && expected.started === actual.started && expected.command === actual.command;
}

export function lineageToRoot(inventory, pid, rootPid) {
  const lineage = [];
  const seen = new Set();
  let currentPid = pid;

  while (currentPid > 1 && !seen.has(currentPid)) {
    seen.add(currentPid);
    const current = inventory.get(currentPid);

    if (!current) return undefined;
    lineage.push(current);

    if (currentPid === rootPid) return lineage;
    currentPid = current.ppid;
  }

  return undefined;
}

export function captureOwnedProcessTree({ rootPid, executablePath, appExited, state, readInventory = processInventory }) {
  if (!rootPid || appExited) return false;
  const inventory = readInventory();
  const rootIdentity = inventory.get(rootPid);

  if (!rootIdentity) throw new Error('The app PID disappeared before its final owned-process snapshot.');

  if (executablePath && !rootIdentity.command.includes(executablePath)) {
    throw new Error('The spawned app PID command does not match the exact packaged executable; refusing process ownership capture.');
  }

  if (state.rootIdentity && !sameProcessIdentity(state.rootIdentity, rootIdentity)) {
    throw new Error('The app PID no longer matches its captured process start, group, and command identity.');
  }

  state.rootIdentity ??= rootIdentity;
  const tree = [];

  for (const candidate of inventory.values()) {
    const lineage = lineageToRoot(inventory, candidate.pid, rootPid);

    if (lineage) tree.push(candidate);
  }

  const groupMembers = [...inventory.values()].filter(candidate => candidate.pgid === rootPid);

  for (const member of groupMembers) {
    if (!lineageToRoot(inventory, member.pid, rootPid)) {
      throw new Error(`App process group ${rootPid} contains an unowned member; teardown is unsafe.`);
    }
  }

  for (const candidate of tree) {
    const previous = state.identities.get(candidate.pid);

    if (previous && !sameProcessIdentity(previous, candidate)) {
      throw new Error(`App descendant PID ${candidate.pid} changed identity during the smoke.`);
    }

    state.identities.set(candidate.pid, candidate);
  }

  state.captured = true;

  return true;
}

export function verifyLiveIdentity(expected, { rootPid, readInventory = processInventory, isAlive = processAlive }) {
  if (!isAlive(expected.pid)) return false;
  const inventory = readInventory();
  const current = inventory.get(expected.pid);

  if (!current) {
    if (!isAlive(expected.pid)) return false;
    throw new ProcessIdentityRefusal(expected, `PID ${expected.pid} is live but absent from the process inventory; refusing to signal it.`);
  }

  if (!sameProcessIdentity(expected, current)) {
    throw new ProcessIdentityRefusal(expected, `PID ${expected.pid} is live but its process start, group, or command identity changed; refusing to signal it.`, current);
  }

  if (expected.originalLineage) {
    const lineage = lineageToRoot(inventory, expected.pid, rootPid);

    if (!lineage || lineage.length !== expected.originalLineage.length
      || lineage.some((member, index) => !sameProcessIdentity(expected.originalLineage[index], member))) {
      throw new ProcessIdentityRefusal(expected, `Fixture PID ${expected.pid} no longer has its captured app-owned process lineage; refusing to signal it.`);
    }
  }

  return true;
}

export async function stopOwnedProcessTree({
  rootPid,
  rootIdentity,
  identities,
  captured,
  isAppExited,
  cleanup,
  waitFor,
  readInventory = processInventory,
  isAlive = processAlive,
  isGroupAlive = processGroupAlive,
  signalProcess = (pid, signal) => process.kill(pid, signal),
  timeouts = DEFAULT_TIMEOUTS,
}) {
  if (!rootPid) return true;

  if (!captured) throw new Error('No complete owned app process tree was captured; refusing broad teardown.');
  const orderedIdentities = [...identities].sort((a, b) => Number(b.pid === rootPid) - Number(a.pid === rootPid));
  const quarantined = new Map();
  let firstIdentityRefusal;
  let lastTimeout;

  const identitiesGone = () => orderedIdentities.every(expected => !isAlive(expected.pid));

  const groupGone = () => {
    const inventory = readInventory();

    if ([...inventory.values()].some(candidate => candidate.pgid === rootPid)) return false;

    return !isGroupAlive(rootPid);
  };

  if (!rootIdentity) throw new Error('No exact app root identity was captured; refusing shutdown.');

  const verifyForCleanup = expected => {
    if (quarantined.has(expected.pid)) return false;

    try {
      return verifyLiveIdentity(expected, { rootPid, readInventory, isAlive });
    } catch (error) {
      if (!(error instanceof ProcessIdentityRefusal)) throw error;
      quarantined.set(expected.pid, error);
      cleanup.push(error.diagnostic);

      if (!firstIdentityRefusal) {
        firstIdentityRefusal = error;
      }

      return false;
    }
  };

  const signalVerified = (expected, signal, phase) => {
    if (!verifyForCleanup(expected)) return;
    cleanup.push({ kind: 'app-process-signal', pid: expected.pid, signal, ...(phase ? { phase } : {}) });

    try {
      signalProcess(expected.pid, signal);
    } catch (error) {

      if (error?.code !== 'ESRCH') throw error;
    }
  };

  signalVerified(rootIdentity, 'SIGTERM', 'root-first');

  try {
    await waitFor(() => identitiesGone() && groupGone(), `app-owned graceful shutdown ${rootPid}`, timeouts.rootGraceMs);

    if (!isAppExited()) await waitFor(() => isAppExited(), `owned app leader ${rootPid} close event`, timeouts.leaderCloseMs);

    return true;
  } catch (error) {
    lastTimeout = error;
    cleanup.push({ kind: 'app-root-grace-expired', error: error.message });
  }

  for (const expected of orderedIdentities) signalVerified(expected, 'SIGTERM');

  let graceful = false;

  try {
    await waitFor(() => identitiesGone() && groupGone(), `owned app descendants and process group ${rootPid} after SIGTERM`, timeouts.termGraceMs);
    graceful = true;
  } catch (error) {
    lastTimeout = error;
    cleanup.push({ kind: 'app-graceful-shutdown-escalation', error: error.message });

    for (const expected of orderedIdentities) signalVerified(expected, 'SIGKILL');

    try {
      await waitFor(() => identitiesGone() && groupGone(), `owned app descendants and process group ${rootPid} after SIGKILL`, timeouts.killGraceMs);
    } catch (killTimeout) {
      lastTimeout = killTimeout;
    }
  }

  if (!identitiesGone() || !groupGone()) {
    const refusal = firstIdentityRefusal ? ` Original identity refusal: ${firstIdentityRefusal.message}` : '';
    const timeout = lastTimeout ? ` ${lastTimeout.message}` : '';

    throw new Error(`Owned app process cleanup remains unverified.${refusal}${timeout}`);
  }

  if (!isAppExited()) await waitFor(() => isAppExited(), `owned app leader ${rootPid} close event`, timeouts.leaderCloseMs);

  return graceful;
}
