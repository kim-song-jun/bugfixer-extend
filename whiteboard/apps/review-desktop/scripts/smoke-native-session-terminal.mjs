/** Drive two real app-created Codex custom PTYs through the packaged native UI. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { lstatSync, readlinkSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

const [appArgument, outputArgument] = process.argv.slice(2);
assert.ok(appArgument, 'Pass the assembled Whiteboard.app path');
assert.ok(outputArgument, 'Pass the native session terminal evidence directory');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'This smoke runs only in GitHub Actions.');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'This smoke requires an ephemeral GitHub-hosted runner.');
assert.equal(process.platform, 'darwin', 'This smoke requires the packaged macOS app.');
assert.equal(process.env.WHITEBOARD_NATIVE_SESSION_TERMINAL_FIXTURE, '1', 'The workflow must explicitly opt into the provider-free CLI fixture.');

const authEnvironmentNames = [
  'OPENAI_API_KEY', 'OPENAI_ACCESS_TOKEN', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_AUTH_TOKEN',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_API_KEY',
];

const presentAuthEnvironmentNames = authEnvironmentNames.filter(name => Object.hasOwn(process.env, name));
assert.deepEqual(presentAuthEnvironmentNames, [], `Provider credential environment keys must be absent: ${presentAuthEnvironmentNames.join(', ')}`);

const appPath = path.resolve(appArgument);
const output = path.resolve(outputArgument);
const appRoot = fileURLToPath(new URL('../', import.meta.url));
const fixturePath = path.join(appRoot, 'native/session-terminal-fixture/codex.mjs');
const nativeOutputRoot = fileURLToPath(new URL('../code-oss/out/vs/workspace/electron-main/', import.meta.url));
const profileHome = os.userInfo().homedir;
const codexLink = path.join(profileHome, '.local/bin/codex');
const codexProfile = path.join(profileHome, '.codex');
const receipt = {
  schemaVersion: 1,
  fixtureOnly: true,
  providerExecuted: false,
  authenticated: false,
  providerIdentityCaptured: false,
  providerConversationId: null,
  modelClaimed: false,
  authEnvironmentKeysPresent: [],
  checks: [],
  sessions: [],
  ownedProcesses: [],
  processBaseline: { scriptPid: process.pid, scriptPpid: process.ppid, capturedAt: new Date().toISOString(), ownedChildrenBeforeLaunch: 0 },
  cleanup: [],
  cleanupVerified: false,
  failure: null,
};

let root;
let database;
let browser;
let appChild;
let appExit;
let appExited = false;
let appProcessIdentity;
let appProcessIdentities = new Map();
let appProcessTreeCaptured = false;
let appExecutablePath;
let fixtureLinkIdentity;
let fixtureProfileIdentity;
let fixtureLinkDirectoryIdentities = [];
let appPort;

async function waitFor(check, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function absent(filePath) {
  try { await lstat(filePath); return false; }
  catch (error) { if (error?.code === 'ENOENT') return true; throw error; }
}

function processInventory() {
  const output = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,command='], {
    encoding: 'utf8', timeout: 3_000, maxBuffer: 8 * 1024 * 1024,
  });
  const inventory = new Map();
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 9) continue;
    const pid = Number(fields[0]);
    const ppid = Number(fields[1]);
    const pgid = Number(fields[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid)) continue;
    inventory.set(pid, { pid, ppid, pgid, started: fields.slice(3, 8).join(' '), command: fields.slice(8).join(' ') });
  }
  return inventory;
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error?.code === 'ESRCH') return false; throw error; }
}

function processGroupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; }
  catch (error) { if (error?.code === 'ESRCH') return false; throw error; }
}

function sameProcessIdentity(expected, actual) {
  return !!actual && expected.pid === actual.pid && expected.pgid === actual.pgid
    && expected.started === actual.started && expected.command === actual.command;
}

function lineageToRoot(inventory, pid, rootPid) {
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

function captureAppProcessTree() {
  if (!appChild?.pid || appExited) return false;
  const inventory = processInventory();
  const rootIdentity = inventory.get(appChild.pid);
  if (!rootIdentity) throw new Error('The app PID disappeared before its final owned-process snapshot.');
  if (appExecutablePath && !rootIdentity.command.includes(appExecutablePath)) {
    throw new Error('The spawned app PID command does not match the exact packaged executable; refusing process ownership capture.');
  }
  if (appProcessIdentity && !sameProcessIdentity(appProcessIdentity, rootIdentity)) {
    throw new Error('The app PID no longer matches its captured process start, group, and command identity.');
  }
  appProcessIdentity ??= rootIdentity;
  const tree = [];
  for (const candidate of inventory.values()) {
    const lineage = lineageToRoot(inventory, candidate.pid, appChild.pid);
    if (lineage) tree.push(candidate);
  }
  const groupMembers = [...inventory.values()].filter(candidate => candidate.pgid === appChild.pid);
  for (const member of groupMembers) {
    if (!lineageToRoot(inventory, member.pid, appChild.pid)) {
      throw new Error(`App process group ${appChild.pid} contains an unowned member; teardown is unsafe.`);
    }
  }
  for (const candidate of tree) {
    const previous = appProcessIdentities.get(candidate.pid);
    if (previous && !sameProcessIdentity(previous, candidate)) {
      throw new Error(`App descendant PID ${candidate.pid} changed identity during the smoke.`);
    }
    appProcessIdentities.set(candidate.pid, candidate);
  }
  appProcessTreeCaptured = true;
  return true;
}

function captureFixtureIdentity(pid) {
  const inventory = processInventory();
  const identity = inventory.get(pid);
  if (!identity || (!identity.command.includes(fixturePath) && !identity.command.includes(codexLink))) {
    throw new Error(`READY PID ${pid} does not identify the executable CI fixture.`);
  }
  const linkIdentity = lstatSync(codexLink);
  if (!fixtureLinkIdentity || linkIdentity.dev !== fixtureLinkIdentity.dev || linkIdentity.ino !== fixtureLinkIdentity.ino
    || !linkIdentity.isSymbolicLink() || readlinkSync(codexLink) !== fixturePath) {
    throw new Error('The Codex CLI resolver link no longer matches the exclusively installed fixture; refusing process ownership capture.');
  }
  const lineage = lineageToRoot(inventory, pid, appChild.pid);
  if (!lineage || lineage[0].pid !== pid || lineage.at(-1).pid !== appChild.pid) {
    throw new Error(`Fixture PID ${pid} is not a descendant of the owned packaged app.`);
  }
  return { ...identity, originalLineage: lineage };
}

function verifyLiveIdentity(expected) {
  const alive = processAlive(expected.pid);
  if (!alive) return false;
  const inventory = processInventory();
  const current = inventory.get(expected.pid);
  if (!current) {
    if (!processAlive(expected.pid)) return false;
    throw new Error(`PID ${expected.pid} is live but absent from the process inventory; refusing to signal it.`);
  }
  if (!sameProcessIdentity(expected, current)) {
    throw new Error(`PID ${expected.pid} is live but its process start, group, or command identity changed; refusing to signal it.`);
  }
  if (expected.originalLineage) {
    const lineage = lineageToRoot(inventory, expected.pid, appChild.pid);
    if (!lineage || lineage.length !== expected.originalLineage.length
      || lineage.some((member, index) => !sameProcessIdentity(expected.originalLineage[index], member))) {
      throw new Error(`Fixture PID ${expected.pid} no longer has its captured app-owned process lineage; refusing to signal it.`);
    }
  }
  return true;
}

async function portClosed(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error(`Port ${port} did not close before timeout.`)); }, 1_000);
    socket.once('connect', () => { clearTimeout(timeout); socket.destroy(); resolve(false); });
    socket.once('error', error => {
      clearTimeout(timeout);
      if (error.code === 'ECONNREFUSED') resolve(true);
      else reject(error);
    });
  });
}

async function terminateOwnedFixture(session) {
  const { fixturePid: pid } = session;
  const expected = session?.processIdentity;
  if (!expected) throw new Error(`Fixture PID ${pid} has no captured command/start/lineage identity; refusing cleanup signal.`);
  if (!(verifyLiveIdentity(expected))) return;
  receipt.cleanup.push({ kind: 'fixture-process-signal', pid, signal: 'SIGTERM' });
  try { process.kill(pid, 'SIGTERM'); }
  catch (error) { if (error?.code !== 'ESRCH') throw error; }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && verifyLiveIdentity(expected)) await new Promise(resolve => setTimeout(resolve, 100));
  if (verifyLiveIdentity(expected)) {
    verifyLiveIdentity(expected);
    receipt.cleanup.push({ kind: 'fixture-process-signal', pid, signal: 'SIGKILL' });
    try { process.kill(pid, 'SIGKILL'); }
    catch (error) { if (error?.code !== 'ESRCH') throw error; }
    await waitFor(() => !verifyLiveIdentity(expected), `owned fixture process ${pid} after SIGKILL`, 5_000);
  }
}

async function stopOwnedApp() {
  if (!appChild?.pid) return;
  if (!appProcessTreeCaptured) throw new Error('No complete owned app process tree was captured; refusing broad teardown.');
  const identities = [...appProcessIdentities.values()].sort((a, b) => Number(a.pid === appChild.pid) - Number(b.pid === appChild.pid));
  for (const expected of identities) {
    if (!verifyLiveIdentity(expected)) continue;
    receipt.cleanup.push({ kind: 'app-process-signal', pid: expected.pid, signal: 'SIGTERM' });
    try { process.kill(expected.pid, 'SIGTERM'); }
    catch (error) { if (error?.code !== 'ESRCH') throw error; }
  }
  const identitiesGone = async () => identities.every(expected => !verifyLiveIdentity(expected));
  const groupGone = () => {
    const inventory = processInventory();
    if ([...inventory.values()].some(candidate => candidate.pgid === appChild.pid)) return false;
    return !processGroupAlive(appChild.pid);
  };
  let graceful = false;
  try {
    await waitFor(async () => (await identitiesGone()) && groupGone(), `owned app descendants and process group ${appChild.pid} after SIGTERM`, 12_000);
    graceful = true;
  } catch (gracefulError) {
    receipt.cleanup.push({ kind: 'app-graceful-shutdown-escalation', error: gracefulError.message });
    for (const expected of identities) {
      if (!verifyLiveIdentity(expected)) continue;
      receipt.cleanup.push({ kind: 'app-process-signal', pid: expected.pid, signal: 'SIGKILL' });
      try { process.kill(expected.pid, 'SIGKILL'); }
      catch (error) { if (error?.code !== 'ESRCH') throw error; }
    }
    await waitFor(async () => (await identitiesGone()) && groupGone(), `owned app descendants and process group ${appChild.pid} after SIGKILL`, 5_000);
  }
  if (!appExited) await waitFor(() => appExited, `owned app leader ${appChild.pid} close event`, 5_000);
  return graceful;
}

async function readTerminalText(page) {
  return page.locator('.ai-session__terminal .xterm-accessibility-tree').innerText();
}

async function waitTerminalText(page, text, label, timeout = 20_000) {
  await waitFor(async () => (await readTerminalText(page).catch(() => '')).includes(text), `${label} actual xterm accessibility output`, timeout);
}

async function terminalInstance(page) {
  const wrapper = page.locator('.ai-session__terminal .terminal-wrapper');
  await wrapper.waitFor({ state: 'visible' });
  return wrapper.elementHandle();
}

async function createAndStartSession(page, name, model) {
  await page.locator('.ai-session__list').getByRole('button', { name: '새 AI 세션 만들기', exact: true }).click();
  const form = page.locator('.ai-session__create-form');
  await form.waitFor({ state: 'visible' });
  await form.locator('[name="name"]').fill(name);
  await form.locator('[name="provider"]').selectOption('codex');
  await form.locator('[name="model"]').fill(model);
  await form.locator('[name="permission"]').selectOption('read-only');
  await form.getByRole('button', { name: '세션 만들고 실행 미리보기', exact: true }).click();
  const preview = page.locator('.ai-session__preview');
  await preview.waitFor({ state: 'visible', timeout: 30_000 });
  assert.ok((await preview.innerText()).includes(model), `Preview must show the explicit fixture model label ${model}.`);
  assert.ok((await preview.innerText()).includes('읽기 전용'), 'Launch preview must show read-only permission.');
  await preview.getByRole('button', { name: '확인하고 실행', exact: true }).click();
  await page.locator('.ai-session__terminal .xterm-accessibility-tree').waitFor({ state: 'visible', timeout: 30_000 });
  await waitTerminalText(page, 'READY pid=', `${name} launch`, 45_000);
  const text = await readTerminalText(page);
  const match = /READY pid=(\d+) fixtureOnly=true/.exec(text);
  assert.ok(match, `${name} terminal must expose the fixture PID through the actual xterm accessibility tree.`);
  const pid = Number(match[1]);
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  const session = { name, model, fixturePid: pid, observedAt: new Date().toISOString(), terminalInstanceRetained: false, resizeObserved: false, resizeDimensions: [], inputObserved: false, inputTagsObserved: [], stopped: false };
  receipt.sessions.push(session);
  Object.defineProperty(session, 'processIdentity', { value: captureFixtureIdentity(pid) });
  session.id = database.agentSessions.listSessions(receipt.project.projectId).find(candidate => candidate.name === name)?.id;
  assert.ok(session.id, `The real workspace database must contain UI-created session ${name}.`);
  receipt.ownedProcesses.push({ kind: 'codex-fixture', pid, owner: 'owned app session terminal', observedAt: session.observedAt });
  return session;
}

try {
  await mkdir(output, { recursive: true });
  assert.equal(await absent(codexLink), true, `Refusing to overwrite pre-existing CLI path: ${codexLink}`);
  assert.equal(await absent(codexProfile), true, `Refusing to overwrite pre-existing provider profile: ${codexProfile}`);
  const fixtureStat = await lstat(fixturePath);
  assert.ok(fixtureStat.isFile(), 'The fixture must be a regular tracked file.');
  assert.ok(fixtureStat.mode & 0o111, 'The tracked CLI fixture must be executable.');
  const linkDirectory = path.dirname(codexLink);
  const missingLinkDirectories = [];
  let parent = linkDirectory;
  while (await absent(parent)) {
    missingLinkDirectories.push(parent);
    parent = path.dirname(parent);
  }
  for (const directoryPath of missingLinkDirectories.reverse()) {
    try {
      await mkdir(directoryPath);
      const identity = await lstat(directoryPath);
      assert.ok(identity.isDirectory());
      fixtureLinkDirectoryIdentities.push({ path: directoryPath, dev: identity.dev, ino: identity.ino });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      assert.ok((await lstat(directoryPath)).isDirectory(), `CLI resolver parent must be a directory: ${directoryPath}`);
    }
  }
  await mkdir(codexProfile, { mode: 0o700 });
  fixtureProfileIdentity = await lstat(codexProfile);
  await symlink(fixturePath, codexLink);
  fixtureLinkIdentity = await lstat(codexLink);
  assert.ok(fixtureLinkIdentity.isSymbolicLink());
  assert.equal(await readlink(codexLink), fixturePath);
  assert.equal(await realpath(codexLink), await realpath(fixturePath));

  root = await mkdtemp(path.join(os.tmpdir(), 'wb-native-session-terminal-'));
  const userData = path.join(root, 'user-data');
  const extensions = path.join(root, 'extensions');
  const reviewHome = path.join(root, 'review-home');
  const projectFolder = path.join(root, 'ordinary-readonly-project');
  await mkdir(path.join(userData, 'User'), { recursive: true });
  await mkdir(extensions);
  await mkdir(projectFolder);
  await writeFile(path.join(userData, 'User/settings.json'), JSON.stringify({
    'window.autoDetectColorScheme': false,
    'telemetry.telemetryLevel': 'off',
    'review.telemetry.enabled': false,
    'update.mode': 'none',
    'security.workspace.trust.enabled': false,
    'editor.accessibilitySupport': 'on',
  }, null, 2));

  const { WorkspaceDatabase } = await import(pathToFileURL(path.join(nativeOutputRoot, 'workspaceDatabase.js')).href);
  const { ProjectWorkspaceService } = await import(pathToFileURL(path.join(nativeOutputRoot, 'projectWorkspaceService.js')).href);
  database = WorkspaceDatabase.open(path.join(userData, 'workspace.db'));
  const projectService = new ProjectWorkspaceService(database, userData);
  const project = projectService.createProject('CI terminal fixture project', projectFolder);
  const task = database.createTask({
    projectId: project.project.id,
    bindingId: project.binding.id,
    title: 'Read-only terminal transport fixture',
    description: 'Provider-free real app custom PTY transport test.',
  });
  assert.equal(project.view.descriptorUri, pathToFileURL(project.descriptorPath).toString(), 'The project workspace service must persist its own descriptor identity.');
  assert.equal(await realpath(project.descriptorPath), project.descriptorPath);
  receipt.project = { projectId: project.project.id, bindingId: project.binding.id, taskId: task.id, descriptorPath: project.descriptorPath };

  const product = JSON.parse(await readFile(path.join(appPath, 'Contents/Resources/app/product.json'), 'utf8'));
  const executable = path.join(appPath, 'Contents/MacOS', product.nameShort);
  appExecutablePath = executable;
  assert.ok((await lstat(executable)).isFile(), 'Packaged app executable must be present.');
  appPort = await reservePort();
  const args = [
    '--disable-telemetry', '--skip-welcome', '--log', 'trace',
    `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`, `--remote-debugging-port=${appPort}`,
    project.descriptorPath,
  ];
  const appEnv = { ...process.env, DEV_REVIEW_HOME: reviewHome, DEV_REVIEW_IMPORT_FROM: 'none', ELECTRON_ENABLE_LOGGING: '1' };
  delete appEnv.ELECTRON_RUN_AS_NODE;
  delete appEnv.VSCODE_DEV;
  delete appEnv.VSCODE_CLI;
  appChild = spawn(executable, args, { env: appEnv, stdio: ['ignore', 'ignore', 'ignore'], detached: true });
  appChild.once('error', error => { receipt.failure ??= `Packaged app spawn failed: ${error.message}`; });
  appExit = new Promise(resolve => appChild.once('close', (code, signal) => { appExited = true; resolve({ code, signal }); }));
  receipt.ownedProcesses.push({ kind: 'packaged-app-process-group', pid: appChild.pid, ppid: process.pid, port: appPort, command: executable, args, startedAt: new Date().toISOString() });
  await waitFor(() => captureAppProcessTree(), `owned packaged app root and process group ${appChild.pid} snapshot`, 10_000);
  await waitFor(async () => {
    if (appExited) throw new Error(`Packaged app exited before CDP was ready: ${JSON.stringify(await appExit)}`);
    const response = await fetch(`http://127.0.0.1:${appPort}/json/list`).catch(() => undefined);
    if (!response?.ok) return false;
    return (await response.json()).some(target => target.type === 'page' && target.webSocketDebuggerUrl);
  }, 'packaged app CDP target', 90_000);
  captureAppProcessTree();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${appPort}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0];
  assert.ok(page, 'Packaged native app must expose a renderer page through CDP.');
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitFor(() => page.evaluate(() => {
    const names = performance.getEntriesByType('mark').map(entry => entry.name);
    return names.includes('code/didLoadExtensions') && names.includes('code/didInitializeLocalExtensionHost');
  }), 'native extension host readiness', 90_000);
  const projectMenu = page.getByRole('button', { name: '프로젝트 메뉴', exact: true });
  await projectMenu.waitFor({ state: 'visible', timeout: 90_000 });
  await projectMenu.click();
  const sidebar = page.getByRole('navigation', { name: '프로젝트 탐색', exact: true });
  await sidebar.waitFor({ state: 'visible' });
  await sidebar.getByRole('button', { name: 'AI 세션', exact: true }).click();
  const workspace = page.locator('.ai-session-workspace');
  await workspace.waitFor({ state: 'visible', timeout: 30_000 });
  await workspace.getByRole('heading', { name: '프로젝트 첫 AI 세션', exact: true }).waitFor();

  const first = await createAndStartSession(page, 'CI terminal session A', 'ci-fixture-codex-session-a');
  captureAppProcessTree();
  const firstInstance = await terminalInstance(page);
  assert.ok(firstInstance);
  await page.locator('.ai-session__terminal .xterm-screen').click();
  await page.keyboard.type('FIXTURE_TAG_A\n');
  await waitTerminalText(page, 'ECHO FIXTURE_TAG_A', first.name);
  first.inputObserved = true;
  first.inputTagsObserved.push('FIXTURE_TAG_A');
  assert.equal((await readTerminalText(page)).includes('FIXTURE_TAG_B'), false, 'Session A cannot display the other terminal input tag.');

  await page.setViewportSize({ width: 900, height: 700 });
  first.resizeDimensions = await waitFor(async () => {
    const sizes = [...(await readTerminalText(page)).matchAll(/SIZE cols=(\d+) rows=(\d+)/g)].map(match => `${match[1]}x${match[2]}`);
    return sizes.length >= 2 && new Set(sizes).size >= 2 ? [...new Set(sizes)] : false;
  }, 'real PTY resize event with changed terminal dimensions');
  first.resizeObserved = true;
  assert.equal(processAlive(first.fixturePid), true, 'Session A fixture process must remain live after resize.');
  await page.screenshot({ path: path.join(output, 'session-a-terminal.png') });

  const second = await createAndStartSession(page, 'CI terminal session B', 'ci-fixture-codex-session-b');
  assert.equal(processAlive(first.fixturePid), true, 'Session A must remain live while session B starts.');
  assert.equal(processAlive(second.fixturePid), true, 'Session B must start as an independent live PTY process.');
  assert.notEqual(first.fixturePid, second.fixturePid, 'Concurrent sessions must have distinct real fixture process IDs.');
  const secondInstance = await terminalInstance(page);
  assert.equal(await secondInstance.evaluate((element, firstElement) => element !== firstElement, firstInstance), true,
    'Concurrent sessions must have distinct actual TerminalInstance DOM wrappers.');
  captureAppProcessTree();
  await page.locator('.ai-session__terminal .xterm-screen').click();
  await page.keyboard.type('FIXTURE_TAG_B\n');
  await waitTerminalText(page, 'ECHO FIXTURE_TAG_B', second.name);
  second.inputObserved = true;
  second.inputTagsObserved.push('FIXTURE_TAG_B');
  assert.equal((await readTerminalText(page)).includes('FIXTURE_TAG_A'), false, 'Session B cannot display the other terminal input tag.');

  const sessionA = workspace.locator('.ai-session__session-row').filter({ hasText: first.name });
  const sessionB = workspace.locator('.ai-session__session-row').filter({ hasText: second.name });
  await sessionA.click();
  await page.getByRole('tab', { name: '터미널', exact: true }).waitFor({ state: 'visible' });
  const firstReopenedInstance = await terminalInstance(page);
  assert.equal(await firstReopenedInstance.evaluate((element, retained) => element === retained, firstInstance), true,
    'Switching back to session A must reattach the same actual TerminalInstance DOM wrapper.');
  await waitTerminalText(page, `READY pid=${first.fixturePid}`, 'session A reopen');
  assert.equal((await readTerminalText(page)).match(/READY pid=/g)?.length, 1, 'Reopening A must not create another fixture process.');
  await page.locator('.ai-session__terminal .xterm-screen').click();
  await page.keyboard.type('FIXTURE_TAG_A_CONCURRENT\n');
  await waitTerminalText(page, 'ECHO FIXTURE_TAG_A_CONCURRENT', 'session A concurrent input');
  first.inputTagsObserved.push('FIXTURE_TAG_A_CONCURRENT');
  assert.equal((await readTerminalText(page)).includes('FIXTURE_TAG_B'), false, 'Session A must not receive session B input.');
  first.terminalInstanceRetained = true;
  await page.getByRole('tab', { name: '로그', exact: true }).click();
  await page.getByRole('tab', { name: '터미널', exact: true }).click();
  const firstAfterTabs = await terminalInstance(page);
  assert.equal(await firstAfterTabs.evaluate((element, retained) => element === retained, firstInstance), true,
    'Switching to logs and reopening terminal must keep A\'s actual terminal instance.');
  await waitTerminalText(page, `READY pid=${first.fixturePid}`, 'session A terminal tab reopen');
  assert.equal((await readTerminalText(page)).match(/READY pid=/g)?.length, 1);

  await sessionB.click();
  const secondReopenedInstance = await terminalInstance(page);
  assert.equal(await secondReopenedInstance.evaluate((element, retained) => element === retained, secondInstance), true,
    'Switching back to session B must reattach the same actual TerminalInstance DOM wrapper.');
  await waitTerminalText(page, `READY pid=${second.fixturePid}`, 'session B reopen');
  assert.equal((await readTerminalText(page)).match(/READY pid=/g)?.length, 1, 'Reopening B must not create another fixture process.');
  assert.equal((await readTerminalText(page)).includes('FIXTURE_TAG_A_CONCURRENT'), false, 'Session B must not receive session A input.');
  await page.locator('.ai-session__terminal .xterm-screen').click();
  await page.keyboard.type('FIXTURE_TAG_B_CONCURRENT\n');
  await waitTerminalText(page, 'ECHO FIXTURE_TAG_B_CONCURRENT', 'session B concurrent input');
  second.inputTagsObserved.push('FIXTURE_TAG_B_CONCURRENT');
  assert.equal((await readTerminalText(page)).includes('FIXTURE_TAG_A_CONCURRENT'), false, 'Session B output must remain scoped to its PTY.');
  await page.screenshot({ path: path.join(output, 'session-b-terminal.png') });
  await sessionA.click();
  await waitTerminalText(page, `READY pid=${first.fixturePid}`, 'session A after concurrent duplex input');
  assert.equal((await readTerminalText(page)).includes('FIXTURE_TAG_B_CONCURRENT'), false, 'Session A output must remain scoped to its PTY.');
  second.terminalInstanceRetained = true;

  for (const session of [second, first]) {
    await workspace.locator('.ai-session__session-row').filter({ hasText: session.name }).click();
    await waitTerminalText(page, `READY pid=${session.fixturePid}`, `${session.name} selected for UI stop`);
    const terminalText = await readTerminalText(page);
    assert.ok(terminalText.includes(`READY pid=${session.fixturePid}`));
    await page.locator('.ai-session__detail-header').getByRole('button', { name: '중단', exact: true }).click();
    await waitFor(() => !processAlive(session.fixturePid), `${session.name} fixture PID exit after UI stop`, 20_000);
    await waitFor(() => database.agentSessionTurns.listTurns(receipt.project.projectId, session.id)
      .some(turn => turn.state === 'exited' && turn.cleanupVerified === true && turn.providerConversationId === null),
    `${session.name} durable cleanupVerified turn after UI stop`, 10_000);
    session.stopped = true;
  }

  const turnsA = database.agentSessionTurns.listTurns(project.project.id, first.id);
  const turnsB = database.agentSessionTurns.listTurns(project.project.id, second.id);
  const persistedTurns = [...turnsA, ...turnsB];
  assert.equal(persistedTurns.length, 2, 'Both UI-created session turns must be persisted in the real app database.');
  assert.ok(persistedTurns.every(turn => turn.state === 'exited' && turn.cleanupVerified === true), 'Both UI-stopped turns must be durably exited with verified PTY cleanup.');
  assert.ok(persistedTurns.every(turn => turn.providerConversationId === null), 'Fixture turns must not acquire provider conversation identity.');
  receipt.turns = persistedTurns.map(turn => ({ id: turn.id, sessionId: turn.sessionId, state: turn.state, cleanupVerified: turn.cleanupVerified, providerConversationId: turn.providerConversationId }));
  receipt.checks.push('trusted UI create/preview/confirm/start reached actual custom PTY service for two concurrent fixture sessions');
  receipt.checks.push('both duplex inputs, xterm-observed resize, log/terminal tab reattach, session switching, and UI stop succeeded');
} catch (error) {
  receipt.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  process.exitCode = 1;
} finally {
  const cleanupErrors = [];
  if (appChild?.pid && !appExited) {
    try { captureAppProcessTree(); }
    catch (error) { cleanupErrors.push(`Final owned app process snapshot: ${error.message}`); }
  }
  if (browser) {
    try { await browser.close(); }
    catch (error) { cleanupErrors.push(`CDP disconnect: ${error.message}`); }
  }
  try { await stopOwnedApp(); }
  catch (error) { cleanupErrors.push(`Owned app shutdown: ${error.message}`); }
  if (database) {
    try {
      const sessionRows = receipt.project ? database.agentSessions.listSessions(receipt.project.projectId) : [];
      receipt.finalSessions = sessionRows.map(session => ({ id: session.id, name: session.name, state: session.state }));
      if (receipt.project) {
        receipt.finalTurns = receipt.sessions.map(session => ({
          sessionId: session.id,
          turns: database.agentSessionTurns.listTurns(receipt.project.projectId, session.id)
            .map(turn => ({ id: turn.id, state: turn.state, cleanupVerified: turn.cleanupVerified, providerConversationId: turn.providerConversationId })),
        }));
      }
      database.close();
      database = undefined;
    } catch (error) { cleanupErrors.push(`Database close/readback: ${error.message}`); }
  }
  for (const session of receipt.sessions) {
    try {
      await terminateOwnedFixture(session);
      const alive = processAlive(session.fixturePid);
      if (alive) cleanupErrors.push(`Owned fixture process ${session.fixturePid} is still alive after app shutdown.`);
      else receipt.cleanup.push({ kind: 'fixture-process', pid: session.fixturePid, cleanupVerified: true });
    } catch (error) { cleanupErrors.push(`Fixture PID ${session.fixturePid} check: ${error.message}`); }
  }
  if (appChild?.pid) {
    try {
      if (processAlive(appChild.pid)) cleanupErrors.push(`Owned app process ${appChild.pid} is still alive.`);
      else receipt.cleanup.push({ kind: 'app-process', pid: appChild.pid, cleanupVerified: true, exit: appExited ? await appExit : null });
    } catch (error) { cleanupErrors.push(`App PID ${appChild.pid} check: ${error.message}`); }
  }
  if (appPort) {
    try {
      const closed = await waitFor(() => portClosed(appPort).then(value => value), `owned app port ${appPort} closure`, 5_000);
      if (closed) receipt.cleanup.push({ kind: 'app-port', port: appPort, cleanupVerified: true });
      else cleanupErrors.push(`Owned app port ${appPort} accepted a connection after shutdown.`);
    } catch (error) { cleanupErrors.push(`Owned app port ${appPort} check: ${error.message}`); }
  }
  const noAppWasSpawned = !appChild?.pid;
  let capturedTreeGone = noAppWasSpawned;
  if (!noAppWasSpawned) {
    try {
      const inventory = processInventory();
      capturedTreeGone = [...appProcessIdentities.values()].every(identity => !processAlive(identity.pid) && !inventory.has(identity.pid));
    } catch (error) { cleanupErrors.push(`Owned app process inventory check: ${error.message}`); }
  }
  let appProcessGroupGone = noAppWasSpawned;
  if (appChild?.pid) {
    try {
      const inventory = processInventory();
      appProcessGroupGone = ![...inventory.values()].some(candidate => candidate.pgid === appChild.pid) && !processGroupAlive(appChild.pid);
    } catch (error) { cleanupErrors.push(`Owned app process group ${appChild.pid} check: ${error.message}`); }
  }
  const ownedProcessesGone = !cleanupErrors.some(error => /still alive|shutdown|PID .* check|inventory check|process group .* check/i.test(error))
    && (noAppWasSpawned || appProcessTreeCaptured)
    && capturedTreeGone
    && (!appChild?.pid || appProcessGroupGone)
    && receipt.sessions.every(session => receipt.cleanup.some(item => item.kind === 'fixture-process' && item.pid === session.fixturePid && item.cleanupVerified))
    && (!appChild?.pid || receipt.cleanup.some(item => item.kind === 'app-process' && item.pid === appChild.pid && item.cleanupVerified))
    && (!appPort || receipt.cleanup.some(item => item.kind === 'app-port' && item.port === appPort && item.cleanupVerified));
  if (ownedProcessesGone && fixtureLinkIdentity) {
    try {
      const current = await lstat(codexLink);
      assert.equal(current.dev, fixtureLinkIdentity.dev);
      assert.equal(current.ino, fixtureLinkIdentity.ino);
      assert.ok(current.isSymbolicLink());
      assert.equal(await readlink(codexLink), fixturePath);
      await unlink(codexLink);
      receipt.cleanup.push({ kind: 'owned-cli-symlink', cleanupVerified: true });
    } catch (error) { cleanupErrors.push(`Owned CLI symlink cleanup: ${error.message}`); }
  }
  if (ownedProcessesGone && fixtureProfileIdentity) {
    try {
      const current = await lstat(codexProfile);
      assert.equal(current.dev, fixtureProfileIdentity.dev);
      assert.equal(current.ino, fixtureProfileIdentity.ino);
      assert.ok(current.isDirectory());
      assert.deepEqual(await readdir(codexProfile), [], 'Only the empty fixture profile directory may be removed.');
      await rmdir(codexProfile);
      receipt.cleanup.push({ kind: 'owned-empty-profile-directory', cleanupVerified: true });
    } catch (error) { cleanupErrors.push(`Owned empty profile cleanup: ${error.message}`); }
  }
  if (ownedProcessesGone) {
    for (const identity of [...fixtureLinkDirectoryIdentities].reverse()) {
      try {
        const current = await lstat(identity.path);
        assert.equal(current.dev, identity.dev);
        assert.equal(current.ino, identity.ino);
        assert.ok(current.isDirectory());
        assert.deepEqual(await readdir(identity.path), [], `Only an empty fixture-created path component may be removed: ${identity.path}`);
        await rmdir(identity.path);
        receipt.cleanup.push({ kind: 'owned-empty-cli-parent-directory', path: identity.path, cleanupVerified: true });
      } catch (error) { cleanupErrors.push(`Owned CLI parent directory cleanup: ${error.message}`); }
    }
  }
  if (cleanupErrors.length) {
    receipt.cleanupErrors = cleanupErrors;
    receipt.failure ??= `Cleanup could not be verified: ${cleanupErrors.join(' | ')}`;
    process.exitCode = 1;
  }
  receipt.authEnvironmentKeysPresent = presentAuthEnvironmentNames;
  receipt.ownedProcessesGone = ownedProcessesGone;
  receipt.cleanupVerified = ownedProcessesGone && cleanupErrors.length === 0
    && receipt.cleanup.some(item => item.kind === 'owned-cli-symlink' && item.cleanupVerified)
    && receipt.cleanup.some(item => item.kind === 'owned-empty-profile-directory' && item.cleanupVerified);
  receipt.finalContract = { fixtureOnly: true, providerExecuted: false, authenticated: false, providerIdentityCaptured: false, providerConversationId: null, modelClaimed: false };
  try { await writeFile(path.join(output, 'session-terminal-receipt.json'), JSON.stringify(receipt, null, 2)); }
  catch (error) { process.stderr.write(`Failed to write terminal smoke receipt: ${error.message}\n`); process.exitCode = 1; }
  if (root && ownedProcessesGone) {
    try {
      assert.equal(await realpath(root), root);
      await (await import('node:fs/promises')).rm(root, { recursive: true, force: false });
    } catch (error) { process.stderr.write(`Owned temporary root cleanup failed: ${error.message}\n`); process.exitCode = 1; }
  }
}
