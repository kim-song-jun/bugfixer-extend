import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";

const execFileAsync = promisify(execFile);

const temporaryRoots = [];

const nativeTest = process.platform === "darwin";

after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("a registered root path replacement cannot redirect read or git execution", { skip: !nativeTest }, async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "bound-checkout-test-"));
  temporaryRoots.push(temporaryRoot);
  const helper = path.join(temporaryRoot, "bound-checkout");
  const source = new URL("./bound-checkout.c", import.meta.url);
  await execFileAsync("clang", [
    "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2",
    "-DREVIEW_BOUND_CHECKOUT_TESTING", source.pathname, "-o", helper,
  ]);

  await replacementRace({
    temporaryRoot,
    helper,
    caseName: "read",
    async prepare(root, rogue) {
      await writeFile(path.join(root, "payload.txt"), "original bytes\n");
      await writeFile(path.join(rogue, "payload.txt"), "rogue bytes\n");
    },
    command(root, identity) {
      return ["--root", root, "--dev", identity.dev, "--ino", identity.ino, "read", "payload.txt"];
    },
    async verify(result) {
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, "original bytes\n");
      assert.notEqual(result.stdout, "rogue bytes\n");
    },
  });

  await replacementRace({
    temporaryRoot,
    helper,
    caseName: "exec",
    async prepare(root, rogue) {
      await createRepository(root, "original head");
      await createRepository(rogue, "rogue head");
    },
    command(root, identity) {
      return ["--root", root, "--dev", identity.dev, "--ino", identity.ino, "exec", "git", "rev-parse", "HEAD"];
    },
    environment(root, rogue) {
      return {
        GIT_DIR: path.join(rogue, ".git"),
        GIT_WORK_TREE: rogue,
        GIT_COMMON_DIR: path.join(rogue, ".git"),
      };
    },
    async verify(result, identity, originalHead) {
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout.trim(), originalHead);
      assert.notEqual(result.stdout.trim(), identity.rogueHead);
    },
  });

  await replacementRace({
    temporaryRoot,
    helper,
    caseName: "gitdir",
    async prepare(root, rogue) {
      await createRepository(root, "original metadata head");
      await createRepository(rogue, "rogue metadata head");
    },
    command(root, identity) {
      return ["--root", root, "--dev", identity.dev, "--ino", identity.ino, "exec", "git", "rev-parse", "HEAD"];
    },
    environment(root, rogue) {
      return {
        GIT_DIR: path.join(rogue, ".git"),
        GIT_WORK_TREE: rogue,
        GIT_COMMON_DIR: path.join(rogue, ".git"),
      };
    },
    async verify(result, identity, originalHead) {
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout.trim(), originalHead);
      assert.notEqual(result.stdout.trim(), identity.rogueHead);
    },
  });
});

test("inventory hashes files, records symlinks without following them, and rejects a changed root identity", { skip: !nativeTest }, async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "bound-checkout-inventory-test-"));
  temporaryRoots.push(temporaryRoot);
  const canonicalTemporaryRoot = await realpath(temporaryRoot);
  const root = path.join(canonicalTemporaryRoot, "root");
  const outside = path.join(canonicalTemporaryRoot, "outside.txt");
  const helper = path.join(temporaryRoot, "bound-checkout");
  await mkdir(root);
  await writeFile(path.join(root, "existing.txt"), "before\n");
  await writeFile(path.join(root, "deleted.txt"), "will be removed\n");
  await writeFile(outside, "must not be inventoried\n");
  await symlink(outside, path.join(root, "outside-link"));
  const rootStat = await stat(root, { bigint: true });
  const source = new URL("./bound-checkout.c", import.meta.url);
  await execFileAsync("clang", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", source.pathname, "-o", helper]);
  const args = ["--root", root, "--dev", rootStat.dev.toString(), "--ino", rootStat.ino.toString(), "inventory"];
  const beforeResult = await runHelper(helper, args);
  assert.equal(beforeResult.code, 0, beforeResult.stderr);
  const before = JSON.parse(beforeResult.stdout);
  const existing = before.entries.find((entry) => entry.path === "existing.txt");
  assert.equal(existing.kind, "file");
  assert.match(existing.sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(before.entries.find((entry) => entry.path === "outside-link"), { path: "outside-link", kind: "symlink", target: outside });
  assert.equal(before.entries.some((entry) => entry.path === "outside.txt"), false);

  await writeFile(path.join(root, "existing.txt"), "after\n");
  await writeFile(path.join(root, "created.txt"), "new\n");
  await rm(path.join(root, "outside-link"));
  await rm(path.join(root, "deleted.txt"));
  const after = JSON.parse((await runHelper(helper, args)).stdout);
  assert.notEqual(after.entries.find((entry) => entry.path === "existing.txt").sha256, existing.sha256);
  assert.equal(after.entries.some((entry) => entry.path === "created.txt"), true);
  assert.equal(after.entries.some((entry) => entry.path === "deleted.txt"), false);
  await rm(root, { recursive: true });
  await mkdir(root);
  const identityFailure = await runHelper(helper, args);
  assert.notEqual(identityFailure.code, 0);
  assert.match(identityFailure.stderr, /root identity mismatch/u);
});

test("provider execution preserves the bound cwd and stdio and rejects unsafe executables", { skip: !nativeTest }, async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "bound-checkout-provider-test-"));
  temporaryRoots.push(temporaryRoot);
  const realpathNodeExecutable = await realpath(process.execPath);
  const helper = path.join(temporaryRoot, "bound-checkout");
  const executableDirectory = path.join(temporaryRoot, "provider-bin");
  await mkdir(executableDirectory);
  const canonicalExecutableDirectory = await realpath(executableDirectory);
  const providerExecutable = path.join(canonicalExecutableDirectory, "codex");
  const providerSource = path.join(executableDirectory, "provider-fixture.c");
  await writeFile(providerSource, [
    "#include <limits.h>",
    "#include <stdio.h>",
    "#include <unistd.h>",
    "int main(void) { char cwd[PATH_MAX]; if (!getcwd(cwd, sizeof(cwd))) return 9;",
    "printf(\"cwd=%s\\n\", cwd); fflush(stdout); fprintf(stderr, \"fixture-stderr\\n\");",
    "char buffer[128]; ssize_t count; while ((count = read(STDIN_FILENO, buffer, sizeof(buffer))) > 0) write(STDOUT_FILENO, buffer, (size_t)count); return 23; }",
  ].join("\n"));
  const source = new URL("./bound-checkout.c", import.meta.url);
  await execFileAsync("clang", [
    "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2",
    "-DREVIEW_BOUND_CHECKOUT_TESTING", source.pathname, "-o", helper,
  ]);
  await execFileAsync("clang", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", providerSource, "-o", providerExecutable]);

  await replacementRace({
    temporaryRoot,
    helper,
    caseName: "provider",
    stdin: "provider stdin preserved\n",
    async prepare(root, rogue) {
      await writeFile(path.join(root, "original-marker"), "original\n");
      await writeFile(path.join(rogue, "rogue-marker"), "rogue\n");
    },
    command(root, identity) {
      return ["--root", root, "--dev", identity.dev, "--ino", identity.ino, "provider", "codex", providerExecutable, "--fixture-arg"];
    },
    async verify(result, identity, _originalHead, originalRoot) {
      assert.equal(result.code, 23);
      assert.equal(result.stdout, `cwd=${originalRoot}\nprovider stdin preserved\n`);
      assert.equal(result.stderr, "fixture-stderr\n");
      assert.notEqual(result.stdout, `cwd=${identity.rogueRoot}\nprovider stdin preserved\n`);
    },
  });

  const codexNodeDirectory = path.join(temporaryRoot, "codex-node-bin");
  await mkdir(codexNodeDirectory);
  const canonicalCodexNodeDirectory = await realpath(codexNodeDirectory);
  const codexScript = path.join(canonicalCodexNodeDirectory, "codex.js");
  await writeFile(path.join(canonicalCodexNodeDirectory, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(path.join(canonicalCodexNodeDirectory, "fixture-dep.mjs"), "export const fixtureValue = 'dependency loaded';\n");
  await writeFile(codexScript, [
    "#!/usr/bin/env node",
    "import { fixtureValue } from './fixture-dep.mjs';",
    "let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;",
    "process.stdout.write(`cwd=${process.cwd()}\\n${fixtureValue}\\nstdin=${stdin}`);",
    "process.stderr.write('codex-node-stderr\\n'); process.exitCode = 29;",
  ].join("\n"), { mode: 0o755 });
  await replacementRace({
    temporaryRoot,
    helper,
    caseName: "codexnode",
    stdin: "codex stdin preserved\n",
    async prepare(root, rogue) {
      await writeFile(path.join(root, "original-marker"), "original\n");
      await writeFile(path.join(rogue, "rogue-marker"), "rogue\n");
    },
    command(root, identity) {
      return ["--root", root, "--dev", identity.dev, "--ino", identity.ino,
        "provider", "codex-node", realpathNodeExecutable, codexScript, "--fixture-arg"];
    },
    async verify(result, _identity, _originalHead, originalRoot) {
      assert.equal(result.code, 29);
      assert.equal(result.stdout, `cwd=${originalRoot}\ndependency loaded\nstdin=codex stdin preserved\n`);
      assert.equal(result.stderr, "codex-node-stderr\n");
    },
  });

  const scriptRaceDirectory = path.join(temporaryRoot, "codex-script-race");
  await mkdir(scriptRaceDirectory);
  const canonicalScriptRaceDirectory = await realpath(scriptRaceDirectory);
  const raceScript = path.join(canonicalScriptRaceDirectory, "codex.js");
  const renamedScript = path.join(canonicalScriptRaceDirectory, "codex-original.js");
  await writeFile(raceScript, "#!/usr/bin/env node\nprocess.stdout.write('original script ran\\n');\n", { mode: 0o755 });
  const raceRoot = path.join(await realpath(temporaryRoot), "codex-script-race-root");
  await mkdir(raceRoot);
  const raceRootStat = await stat(raceRoot, { bigint: true });
  const barrierReady = path.join(await realpath(temporaryRoot), "codex-script-barrier-ready");
  const barrierRelease = path.join(await realpath(temporaryRoot), "codex-script-barrier-release");

  const racingChild = spawn(helper, [
    "--root", raceRoot, "--dev", raceRootStat.dev.toString(), "--ino", raceRootStat.ino.toString(),
    "provider", "codex-node", realpathNodeExecutable, raceScript,
  ], {
    env: { ...process.env, REVIEW_BOUND_CHECKOUT_BARRIER_READY: barrierReady, REVIEW_BOUND_CHECKOUT_BARRIER_RELEASE: barrierRelease },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const raceOutput = [];
  const raceErrors = [];
  racingChild.stdout.on("data", (chunk) => raceOutput.push(chunk));
  racingChild.stderr.on("data", (chunk) => raceErrors.push(chunk));

  const raceCompleted = new Promise((resolve, reject) => {
    racingChild.once("error", reject);
    racingChild.once("close", (code) => resolve({ code, stdout: Buffer.concat(raceOutput).toString(), stderr: Buffer.concat(raceErrors).toString() }));
  });

  try {
    await waitForFile(barrierReady, racingChild);
    await rename(raceScript, renamedScript);
    await writeFile(raceScript, "#!/usr/bin/env node\nprocess.stdout.write('rogue script ran\\n');\n", { mode: 0o755 });
    await writeFile(barrierRelease, "release\n");
    const result = await raceCompleted;
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Codex runtime or script path changed before launch/u);
  } finally {
    if (racingChild.exitCode === null) racingChild.kill("SIGTERM");
    await writeFile(barrierRelease, "release\n").catch(() => {});
  }

  const shellDirectory = path.join(temporaryRoot, "shell-bin");
  await mkdir(shellDirectory);
  const rejected = path.join(await realpath(shellDirectory), "codex");
  await writeFile(rejected, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const root = path.join(await realpath(temporaryRoot), "reject-root");
  await createRepository(root, "root for executable validation");
  const rootStat = await stat(root, { bigint: true });
  const common = ["--root", root, "--dev", rootStat.dev.toString(), "--ino", rootStat.ino.toString()];
  const result = await runHelper(helper, [...common, "provider", "codex", rejected]);
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /shell wrapper executables are not allowed/u);

  const relativeResult = await runHelper(helper, [...common, "provider", "codex", "codex"]);
  assert.notEqual(relativeResult.code, 0);
  assert.match(relativeResult.stderr, /paths must be absolute/u);

  const wrongProvider = path.join(canonicalExecutableDirectory, "claude");
  await copyFile(providerExecutable, wrongProvider);
  const basenameResult = await runHelper(helper, [...common, "provider", "codex", wrongProvider]);
  assert.notEqual(basenameResult.code, 0);
  assert.match(basenameResult.stderr, /basename does not match/u);

  const nonExecutableDirectory = path.join(temporaryRoot, "non-executable-bin");
  await mkdir(nonExecutableDirectory);
  const nonExecutable = path.join(await realpath(nonExecutableDirectory), "codex");
  await writeFile(nonExecutable, "not executable\n", { mode: 0o644 });
  const modeResult = await runHelper(helper, [...common, "provider", "codex", nonExecutable]);
  assert.notEqual(modeResult.code, 0);
  assert.match(modeResult.stderr, /regular executable file/u);

  const symlinkDirectory = path.join(temporaryRoot, "symlink-bin");
  await mkdir(symlinkDirectory);
  const symlinkPath = path.join(await realpath(symlinkDirectory), "codex");
  await symlink(providerExecutable, symlinkPath);
  const symlinkResult = await runHelper(helper, [...common, "provider", "codex", symlinkPath]);
  assert.equal(symlinkResult.code, 23);
  assert.equal(symlinkResult.stdout, `cwd=${root}\n`);
  assert.equal(symlinkResult.stderr, "fixture-stderr\n");

  const overrideArgs = [
    ["-C", temporaryRoot, "rev-parse", "HEAD"],
    ["--git-dir", path.join(temporaryRoot, "rogue.git"), "rev-parse", "HEAD"],
    ["--work-tree", temporaryRoot, "rev-parse", "HEAD"],
    ["-c", `core.worktree=${temporaryRoot}`, "rev-parse", "HEAD"],
  ];

  for (const gitArgs of overrideArgs) {
    const overrideResult = await runHelper(helper, [...common, "exec", "git", ...gitArgs]);
    assert.notEqual(overrideResult.code, 0);
    assert.match(overrideResult.stderr, /git repository\/path override options are not allowed/u);
  }

  const jjOverride = await runHelper(helper, [...common, "exec", "jj", "-R", temporaryRoot, "status"]);
  assert.notEqual(jjOverride.code, 0);
  assert.match(jjOverride.stderr, /jj repository override options are not allowed/u);

  const linkedWorktreeRoot = path.join(await realpath(temporaryRoot), "linked-worktree");
  await mkdir(linkedWorktreeRoot);
  await writeFile(path.join(linkedWorktreeRoot, ".git"), `gitdir: ${temporaryRoot}/.git/worktrees/linked\n`);
  const linkedStat = await stat(linkedWorktreeRoot, { bigint: true });

  const linkedResult = await runHelper(helper, [
    "--root", linkedWorktreeRoot, "--dev", linkedStat.dev.toString(), "--ino", linkedStat.ino.toString(),
    "exec", "git", "status",
  ]);

  assert.notEqual(linkedResult.code, 0);
  assert.match(linkedResult.stderr, /linked worktrees and external metadata are unavailable/u);

  await writeFile(path.join(root, ".git", "commondir"), "../../common\n");
  const commonDirResult = await runHelper(helper, [...common, "exec", "git", "status"]);
  assert.notEqual(commonDirResult.code, 0);
  assert.match(commonDirResult.stderr, /linked worktree Git metadata is unavailable/u);
  await rm(path.join(root, ".git", "commondir"));

  const alternatesDirectory = path.join(root, ".git", "objects", "info");
  await mkdir(alternatesDirectory, { recursive: true });
  await writeFile(path.join(alternatesDirectory, "alternates"), `${temporaryRoot}/external-objects\n`);
  const alternatesResult = await runHelper(helper, [...common, "exec", "git", "status"]);
  assert.notEqual(alternatesResult.code, 0);
  assert.match(alternatesResult.stderr, /external Git object metadata is unavailable/u);

  await rm(path.join(alternatesDirectory, "alternates"));
  const gitConfigPath = path.join(root, ".git", "config");
  const gitConfig = await readFile(gitConfigPath, "utf8");
  await writeFile(gitConfigPath, `${gitConfig}\n[core]\n\tworktree = ${temporaryRoot}\n`);
  const coreWorktreeResult = await runHelper(helper, [...common, "exec", "git", "status"]);
  assert.notEqual(coreWorktreeResult.code, 0);
  assert.match(coreWorktreeResult.stderr, /external Git config metadata is unavailable/u);
  await writeFile(gitConfigPath, `${gitConfig}\n[include]\n\tpath = ${temporaryRoot}/outside-config\n`);
  const configIncludeResult = await runHelper(helper, [...common, "exec", "git", "status"]);
  assert.notEqual(configIncludeResult.code, 0);
  assert.match(configIncludeResult.stderr, /external Git config metadata is unavailable/u);
  await writeFile(gitConfigPath, gitConfig);
  await writeFile(path.join(root, ".git", "config.worktree"), "[core]\n\tworktree = /outside\n");
  const worktreeConfigResult = await runHelper(helper, [...common, "exec", "git", "status"]);
  assert.notEqual(worktreeConfigResult.code, 0);
  assert.match(worktreeConfigResult.stderr, /linked worktree configuration is unavailable/u);
});

async function replacementRace({ temporaryRoot, helper, caseName, prepare, command, verify, stdin, environment }) {
  const canonicalTemporaryRoot = await realpath(temporaryRoot);
  const root = path.join(canonicalTemporaryRoot, `${caseName}-registered-root`);
  const rogue = path.join(canonicalTemporaryRoot, `${caseName}-rogue-root`);
  const original = path.join(canonicalTemporaryRoot, `${caseName}-original-root`);
  const barrierReady = path.join(canonicalTemporaryRoot, `${caseName}-barrier-ready`);
  const barrierRelease = path.join(canonicalTemporaryRoot, `${caseName}-barrier-release`);
  await Promise.all([mkdir(root), mkdir(rogue)]);
  await prepare(root, rogue);
  const rootStat = await stat(root, { bigint: true });

  const identity = {
    dev: rootStat.dev.toString(),
    ino: rootStat.ino.toString(),
  };

  let originalHead;

  if (caseName === "exec" || caseName === "gitdir") {
    originalHead = (await execFileAsync("/usr/bin/git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    identity.rogueHead = (await execFileAsync("/usr/bin/git", ["-C", rogue, "rev-parse", "HEAD"])).stdout.trim();
  }

  const child = spawn(helper, command(root, identity), {
    env: {
      ...process.env,
      ...(environment?.(root, rogue) ?? {}),
      REVIEW_BOUND_CHECKOUT_BARRIER_READY: barrierReady,
      REVIEW_BOUND_CHECKOUT_BARRIER_RELEASE: barrierRelease,
    },
    stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });

  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdoutChunks).toString(),
      stderr: Buffer.concat(stderrChunks).toString(),
    }));
  });

  if (stdin !== undefined) child.stdin.end(stdin);

  try {
    await waitForFile(barrierReady, child);

    if (caseName === "gitdir") {
      await rename(path.join(root, ".git"), path.join(root, ".git-original"));
      await rename(path.join(rogue, ".git"), path.join(root, ".git"));
    } else {
      await rename(root, original);
      identity.rogueRoot = root;
      await mkdir(root);

      if (caseName === "read") await writeFile(path.join(root, "payload.txt"), "rogue replacement\n");
      else await createRepository(root, "rogue replacement head");
    }

    await writeFile(barrierRelease, "release\n");
    const result = await completed;
    await verify(result, identity, originalHead, original);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await writeFile(barrierRelease, "release\n").catch(() => {});
  }
}

async function runHelper(helper, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(helper, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString(),
      stderr: Buffer.concat(stderr).toString(),
    }));
  });
}

async function waitForFile(file, child) {
  const started = Date.now();

  while (Date.now() - started < 5000) {
    try {
      await readFile(file);

      return;
    } catch {
      if (child.exitCode !== null) throw new Error(`Helper exited before barrier (status ${child.exitCode}).`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw new Error("Timed out waiting for helper test barrier.");
}

async function createRepository(directory, contents) {
  await execFileAsync("/usr/bin/git", ["init", "-q", directory]);
  await writeFile(path.join(directory, "head.txt"), contents);
  await execFileAsync("/usr/bin/git", ["-C", directory, "-c", "user.name=Review Test", "-c", "user.email=review@example.invalid", "add", "head.txt"]);
  await execFileAsync("/usr/bin/git", ["-C", directory, "-c", "user.name=Review Test", "-c", "user.email=review@example.invalid", "commit", "-qm", contents]);
}
