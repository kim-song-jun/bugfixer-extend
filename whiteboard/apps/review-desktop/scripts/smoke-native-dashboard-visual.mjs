/** Exercise the packaged native project dashboard with a service-created fixture. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

const diagnostics = { apps: [], console: [], pageErrors: [], failedRequests: [] };

class FatalWaitError extends Error {}

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
    '--disable-telemetry', '--skip-welcome',
    `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`,
    `--remote-debugging-port=${port}`,
    ...(descriptor ? [descriptor] : []),
  ];

  const env = { ...process.env, DEV_REVIEW_HOME: reviewHome, DEV_REVIEW_IMPORT_FROM: 'none', ELECTRON_ENABLE_LOGGING: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VSCODE_DEV;
  delete env.VSCODE_CLI;
  const child = spawn(executable, args, { env, stdio: ['ignore', 'ignore', 'pipe'], detached: true });

  let spawnError;
  child.once('error', error => { spawnError = error; });
  const owned = { pid: child.pid, ppid: process.pid, command: executable, args, port, userData, startedAt: new Date().toISOString() };
  diagnostics.apps.push(owned);
  const stderr = [];
  child.stderr.on('data', chunk => stderr.push(chunk.toString()));
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));

  let browser;

  try {
    const target = await waitFor(async () => {

      if (spawnError) throw new FatalWaitError(`Packaged app failed to start: ${spawnError.message}`);

      if (child.exitCode !== null || child.signalCode !== null) throw new FatalWaitError(`Packaged app exited: ${JSON.stringify(await exited)}\n${stderr.join('').slice(-4000)}`);

      const response = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => undefined);

      if (!response?.ok) return undefined;

      const targets = await response.json();

      return targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
    }, 'a native app CDP page', 90_000);

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);

    const watchedPages = new WeakSet();

    const watchPage = page => {

      if (watchedPages.has(page)) return;

      watchedPages.add(page);
      page.on('console', message => { if (message.type() === 'error') diagnostics.console.push(message.text()); });
      page.on('pageerror', error => diagnostics.pageErrors.push(error.stack ?? error.message));
      page.on('requestfailed', request => {
        const failure = request.failure()?.errorText ?? 'unknown';

        if (failure !== 'net::ERR_ABORTED') diagnostics.failedRequests.push(`${request.url()} — ${failure}`);
      });
    };

    for (const context of browser.contexts()) {
      context.on('page', watchPage);

      for (const page of context.pages()) watchPage(page);
    }

    const selector = descriptor ? '.project-sidebar' : '.project-home__intro h1';

    const page = await waitFor(async () => {
      for (const candidate of browser.contexts().flatMap(context => context.pages())) {
        if (candidate.url() === 'about:blank') continue;

        if (await candidate.locator(selector).isVisible()) return candidate;
      }

      return undefined;
    }, `the packaged renderer with ${selector}`, 90_000);

    watchPage(page);

    return { child, exited, browser, page, port, targetId: target.id, stderr, owned };
  } catch (error) {
    try {

      if (browser) await browser.close();
    } finally {
      await stopOwned(child, exited, port);
    }

    throw error;
  }
}

async function stopOwned(child, exited, port) {

  if (child.pid && (child.exitCode === null && child.signalCode === null || !(await isPortClosed(port)))) {
    try { process.kill(-child.pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }

  let closed = await exitedWithin(exited, 5_000);

  if (child.pid && (!closed || !(await isPortClosed(port)))) {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }

    closed = await exitedWithin(exited, 5_000);
  }

  if (!closed) throw new Error(`Packaged app PID ${child.pid ?? 'unknown'} did not exit after SIGKILL`);
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
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', error => resolve(error.code === 'ECONNREFUSED'));
  });
}

async function closeApp(session) {
  try {

    await session.browser.close();
  } finally {
    await stopOwned(session.child, session.exited, session.port);
    await waitFor(() => isPortClosed(session.port), `owned CDP port ${session.port} to close`, 10_000);
    session.owned.closedAt = new Date().toISOString();
    session.owned.exit = await session.exited;
    session.owned.portClosed = true;
  }
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

      assert.equal(await projectHomeHeading.innerText(), '어떤 프로젝트를 열까요?', 'Fresh profile must show the Korean project picker');

      assert.ok((await session.page.locator('main').innerText()).trim().length > 0, 'Onboarding must render visible content');

      const onboardingShot = path.join(output, `onboarding-${tag}.png`);

      await session.page.screenshot({ path: onboardingShot });

      screenshots.push(onboardingShot);

      await dismissStartupInvitations(session.page);
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

      const sidebar = page.getByRole('navigation', { name: '프로젝트 탐색', exact: true });

      await sidebar.waitFor({ timeout: 90_000 });

      for (const label of ['대시보드', '레퍼런스', '프로젝트 규칙']) {
        await sidebar.getByRole('button', { name: label, exact: true }).waitFor();
      }

      assert.equal(await sidebar.locator('.project-sidebar__item[aria-current="page"]').innerText(), '대시보드');

      await page.locator('.project-dashboard').waitFor();

      await page.getByRole('heading', { name: fixture.projectName, exact: true }).waitFor();

      const taskButton = page.locator(`.project-dashboard__task[data-focus-key="task:${fixture.taskId}"]`);

      assert.equal(await taskButton.locator('.project-dashboard__task-title').innerText(), fixture.taskTitle, 'Dashboard must display the seeded task title');

      await taskButton.waitFor();

      const desktopShot = path.join(output, `dashboard-${tag}-desktop.png`);

      const desktop = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));

      assert.ok(desktop.width > 760 && desktop.height > 0, `Desktop viewport must be measured and wider than 760px: ${JSON.stringify(desktop)}`);

      await page.screenshot({ path: desktopShot, fullPage: false });

      screenshots.push(desktopShot);

      viewports.push({ theme: tag, state: 'desktop', ...desktop, screenshot: desktopShot });

      if (tag === 'light') {

        await page.setViewportSize({ width: 760, height: 820 });

        await page.waitForFunction(() => window.innerWidth === 760);

        const narrow = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));

        assert.equal(narrow.width, 760, 'Narrow dashboard viewport must measure 760 CSS pixels');

        assert.ok(narrow.height > 0, 'Narrow dashboard viewport height must be measurable');

        const narrowShot = path.join(output, 'dashboard-light-narrow-760.png');

        await page.screenshot({ path: narrowShot, fullPage: false });

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
    } catch (error) {

      await captureFailure(page, path.join(output, `dashboard-${tag}-failure.png`), diagnostics);

      throw error;
    } finally {
      await closeApp(session);
    }

    const persistedDatabase = WorkspaceDatabase.open(path.join(userData, 'workspace.db'));

    try {

      fixture.finalState = persistedDatabase.getTask(fixture.taskId)?.state;
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

console.log(`Native dashboard smoke captured ${diagnostics.pageErrors.length} runtime errors, ${diagnostics.console.length} console errors and ${diagnostics.failedRequests.length} failed requests.`);

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

    await page.screenshot({ path: file });
  } catch (error) {

    diagnostics.pageErrors.push(`Failure screenshot capture failed: ${error.stack ?? error.message}`);
  }
}
