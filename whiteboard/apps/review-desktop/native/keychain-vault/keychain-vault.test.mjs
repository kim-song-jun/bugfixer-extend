import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = fileURLToPath(new URL("./keychain-vault.c", import.meta.url));

const account = "00000000-0000-4000-8000-000000000042";

const fixture = Buffer.from("synthetic-slack-token-fixture-2026");

function run(binary, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      pid: child.pid,
    }));

    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

test("synthetic Keychain item round trips and is deleted", { skip: process.platform !== "darwin" }, async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "review-keychain-vault-test-"));
  const binary = path.join(temporaryRoot, "keychain-vault");
  const pids = new Set();

  const invoke = async (...args) => {
    const result = await run(binary, args);

    if (result.pid) pids.add(result.pid);

    return result;
  };

  try {
    execFileSync("clang", [
      "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", source, "-o", binary,
      "-framework", "CoreFoundation", "-framework", "Security",
    ], { stdio: "inherit" });

    const stale = await invoke("delete", "slack", account);
    assert.ok(stale.code === 0 || stale.code === 3, stale.stderr.toString());

    const put = await run(binary, ["put", "slack", account], fixture);

    if (put.pid) pids.add(put.pid);
    assert.equal(put.code, 0, put.stderr.toString());
    assert.deepEqual(put.stdout, Buffer.alloc(0));
    assert.deepEqual(put.stderr, Buffer.alloc(0));

    const get = await invoke("get", "slack", account);
    assert.equal(get.code, 0, get.stderr.toString());
    assert.deepEqual(get.stdout, fixture);
    assert.deepEqual(get.stderr, Buffer.alloc(0));

    const deleted = await invoke("delete", "slack", account);
    assert.equal(deleted.code, 0, deleted.stderr.toString());
    assert.deepEqual(deleted.stdout, Buffer.alloc(0));
    assert.deepEqual(deleted.stderr, Buffer.alloc(0));

    const missing = await invoke("get", "slack", account);
    assert.equal(missing.code, 3);
    assert.deepEqual(missing.stdout, Buffer.alloc(0));
    assert.match(missing.stderr.toString(), /credential was not found/);

    const connectorPut = await run(binary, ["put", "declarative-package", account], fixture);

    if (connectorPut.pid) pids.add(connectorPut.pid);
    assert.equal(connectorPut.code, 0, connectorPut.stderr.toString());
    const connectorGet = await invoke("get", "declarative-package", account);
    assert.equal(connectorGet.code, 0, connectorGet.stderr.toString());
    assert.deepEqual(connectorGet.stdout, fixture);
    const slackStillMissing = await invoke("get", "slack", account);
    assert.equal(slackStillMissing.code, 3, slackStillMissing.stderr.toString());
    const connectorDeleted = await invoke("delete", "declarative-package", account);
    assert.equal(connectorDeleted.code, 0, connectorDeleted.stderr.toString());
    console.log("Synthetic Keychain item deleted; subsequent get returned not found.");
  } finally {
    const cleanup = await invoke("delete", "slack", account);
    assert.ok(cleanup.code === 0 || cleanup.code === 3, cleanup.stderr.toString());
    const connectorCleanup = await invoke("delete", "declarative-package", account);
    assert.ok(connectorCleanup.code === 0 || connectorCleanup.code === 3, connectorCleanup.stderr.toString());
    const proof = await invoke("get", "slack", account);
    assert.equal(proof.code, 3, proof.stderr.toString());
    const connectorProof = await invoke("get", "declarative-package", account);
    assert.equal(connectorProof.code, 3, connectorProof.stderr.toString());
    await rm(temporaryRoot, { recursive: true, force: true });
    // Every spawned child is awaited by run()'s close event; retain the set as
    // explicit ownership evidence for this focused test's process lifecycle.
    assert.ok(pids.size > 0);
  }
});
