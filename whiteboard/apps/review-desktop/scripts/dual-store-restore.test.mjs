import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";

import "tsx/esm";

const { WorkspaceDatabase } = await import(
  "../code-oss/src/vs/workspace/electron-main/workspaceDatabase.ts"
);

const { ReviewStore } = await import(
  "../../../packages/review/src/review-api/store.ts"
);

const { createReviewApi } = await import(
  "../../../packages/review/src/review-api/http.ts"
);

const { WorkspaceDashboardChannel } = await import(
  "../code-oss/src/vs/workspace/electron-main/workspaceDashboardChannel.ts"
);

const { WorkspaceReviewBridgeChannel } = await import(
  "../code-oss/src/vs/workspace/electron-main/workspaceReviewBridgeChannel.ts"
);

function assertHealthyDatabase(file, requiredTable) {
  const db = new DatabaseSync(file, { readOnly: true });

  try {
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(
      db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(requiredTable)?.present,
      1,
    );
  } finally {
    db.close();
  }
}

async function backupOpenDatabase(source, destination) {
  const db = new DatabaseSync(source, { readOnly: true });

  try {
    assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    await backup(db, destination);
  } finally {
    db.close();
  }
}

function checkpointSchema(file) {
  const db = new DatabaseSync(file);

  try {
    assert.equal(db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get().busy, 0);
  } finally {
    db.close();
  }
}

function assertMainFileMissesWalRow(source, destination, table) {
  copyFileSync(source, destination);
  const db = new DatabaseSync(destination, { readOnly: true });

  try {
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
  } finally {
    db.close();
  }
}

function connectedBridge(workspace, review, projectId, descriptorUri) {
  const sender = {};

  const window = {
    config: { reviewWindowLaunch: { kind: "project", projectId } },
    openedWorkspace: { configPath: { toString: () => descriptorUri } },
  };

  const windows = { getWindowByWebContents: (candidate) => candidate === sender ? window : undefined };
  const dashboard = new WorkspaceDashboardChannel(workspace, windows);

  const api = createReviewApi(review, {
    register: async (root, identity) => review.registerRepository(root, identity),
  });

  const token = "isolated-profile-token";
  const host = { whenConnected: async () => ({ url: "http://127.0.0.1:43119", token }) };

  const fetchApi = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "http://127.0.0.1:43119");
    assert.equal(new Headers(init?.headers).get("x-review-token"), token);
    const route = url.pathname.replace(/^\/reviews-api/, "") || "/";

    return api.request(`${route}${url.search}`, init);
  };

  return { bridge: new WorkspaceReviewBridgeChannel(workspace, dashboard, host, fetchApi), sender, api };
}

test("SQLite-aware backup restores task links and Review receipts from two live WAL stores", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bugfixer-dual-store-"));
  let workspace;
  let review;

  try {
    const appDir = path.join(root, "app-profile");
    const reviewDir = path.join(root, "review-profile");
    const backupDir = path.join(root, "backup");
    const repository = path.join(root, "repository");

    for (const directory of [appDir, reviewDir, backupDir, repository]) {
      mkdirSync(directory);
    }

    const workspacePath = path.join(appDir, "workspace.db");
    const reviewPath = path.join(reviewDir, "review-api.db");
    const workspaceBackup = path.join(backupDir, "workspace.db");
    const reviewBackup = path.join(backupDir, "review-api.db");

    const providers = {
      resolveTarget: async (target) => ({
        target,
        pins: { repositoryId: target.repositoryId, base: "base", head: "head" },
      }),
      validatePins: async () => {},
      validateSource: async () => {},
      validateResource: async () => {},
    };

    workspace = WorkspaceDatabase.open(workspacePath);
    review = new ReviewStore(reviewPath, providers);
    checkpointSchema(workspacePath);
    checkpointSchema(reviewPath);
    const descriptorUri = pathToFileURL(path.join(appDir, "project.code-workspace")).toString();

    const project = workspace.createProjectWorkspace(
      "Backup project", repository, descriptorUri, undefined,
      { vcsKind: "git", vcsRoot: repository },
    );

    const task = workspace.createTask({ projectId: project.project.id, bindingId: project.binding.id, title: "Linked task" });
    let connection = connectedBridge(workspace, review, project.project.id, descriptorUri);
    const firstCommandId = randomUUID();

    const first = await connection.bridge.call(connection.sender, "createTaskReview", {
      projectId: project.project.id, taskId: task.id, commandId: firstCommandId,
    });

    const firstReviewId = first.command.reviewId;

    for (const livePath of [workspacePath, reviewPath]) {
      assert.ok(existsSync(`${livePath}-wal`));
      assert.ok(statSync(`${livePath}-wal`).size > 0);
    }

    assertMainFileMissesWalRow(workspacePath, path.join(backupDir, "raw-workspace.db"), "tasks");
    assertMainFileMissesWalRow(reviewPath, path.join(backupDir, "raw-review-api.db"), "reviews");
    await backupOpenDatabase(reviewPath, reviewBackup);

    // A Review created between the independent snapshots has a valid app receipt
    // but is absent from the restored Review store. The bridge must surface it.
    const secondCommandId = randomUUID();

    const second = await connection.bridge.call(connection.sender, "createTaskReview", {
      projectId: project.project.id, taskId: task.id, commandId: secondCommandId,
    });

    const secondReviewId = second.command.reviewId;
    await backupOpenDatabase(workspacePath, workspaceBackup);
    assertHealthyDatabase(workspaceBackup, "task_review_links");
    assertHealthyDatabase(reviewBackup, "receipts");

    const laterTask = workspace.createTask({ projectId: project.project.id, bindingId: project.binding.id, title: "After backup" });

    const third = await connection.bridge.call(connection.sender, "createTaskReview", {
      projectId: project.project.id, taskId: task.id, commandId: randomUUID(),
    });

    workspace.close();
    workspace = undefined;
    await review.close();
    review = undefined;

    // Both source handles are closed before replacing either live database.
    for (const [saved, live] of [[workspaceBackup, workspacePath], [reviewBackup, reviewPath]]) {
      assert.equal(existsSync(`${live}-wal`), false);
      copyFileSync(saved, live);
    }

    workspace = WorkspaceDatabase.open(workspacePath);
    review = new ReviewStore(reviewPath, providers);
    connection = connectedBridge(workspace, review, project.project.id, descriptorUri);
    assert.ok(workspace.getTask(task.id));
    assert.equal(workspace.getTask(laterTask.id), undefined);
    assert.equal(workspace.getReviewCommand(firstCommandId)?.reviewId, firstReviewId);
    assert.equal(workspace.getReviewCommand(secondCommandId)?.reviewId, secondReviewId);
    assert.equal(review.has(firstReviewId), true);
    assert.equal(review.has(secondReviewId), false);
    assert.equal(review.has(third.command.reviewId), false);
    assert.deepEqual(
      workspace.listTaskReviews(task.id).map(({ reviewId, state, isPrimary }) => [reviewId, state, isPrimary]),
      [[firstReviewId, "available", true], [secondReviewId, "available", false]],
    );

    const availability = await connection.bridge.call(connection.sender, "listTaskReviews", {
      projectId: project.project.id, taskId: task.id,
    });

    assert.equal(availability.state, "available");
    assert.deepEqual(
      availability.reviews.map(({ reviewId, state, isPrimary }) => [reviewId, state, isPrimary]),
      [[firstReviewId, "available", true], [secondReviewId, "unavailable", false]],
    );
    assert.equal(review.read(firstReviewId).title, "Linked task");

    const replay = await connection.api.request("/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: workspace.getReviewCommand(firstCommandId).body,
    });

    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).reviewId, firstReviewId);
    assert.equal(review.list().length, 1);
    assertHealthyDatabase(workspacePath, "task_review_links");
    assertHealthyDatabase(reviewPath, "receipts");
  } finally {
    try {
      workspace?.close();
    } finally {
      try {
        if (review) await review.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
});
