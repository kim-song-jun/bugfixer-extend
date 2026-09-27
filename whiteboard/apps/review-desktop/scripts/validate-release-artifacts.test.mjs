import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { releaseIdentityFor } from "./release-channel.mjs";
import {
  assertPackagedProduct,
  assertReleaseChannel,
  assertUpdaterCompatibleApp,
  assertPackagedExtensionNoticeClosure,
  buildManifest,
} from "./validate-release-artifacts.mjs";

const temporaryRoots = [];

after(async () => {
  await Promise.all(
    temporaryRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

const PRODUCT = {
  ...releaseIdentityFor("stable"),
  commit: "abc123",
  quality: "stable",
};

test("buildManifest emits the schema the update Worker serves", () => {
  const now = new Date("2026-07-29T00:00:00.000Z");

  const manifest = buildManifest({
    version: "1.2.3",
    commit: "abc123",
    payloads: [
      { bundle: "Review", artifact: "Review", sha256: "cafe" },
      { bundle: "Whiteboard", artifact: "Whiteboard", sha256: "f00d" },
    ],
    now,
  });

  const review =
    "https://update.dev.fast/releases/1.2.3/darwin-arm64/Review-darwin-arm64-1.2.3.zip";

  assert.deepEqual(manifest, {
    version: "1.2.3",
    commit: "abc123",
    url: review,
    name: "1.2.3",
    pub_date: "2026-07-29T00:00:00.000Z",
    timestamp: now.getTime(),
    sha256hash: "cafe",
    bundles: {
      Review: { url: review, sha256hash: "cafe" },
      Whiteboard: {
        url: "https://update.dev.fast/releases/1.2.3/darwin-arm64/Whiteboard-darwin-arm64-1.2.3.zip",
        sha256hash: "f00d",
      },
    },
  });
});

test("assertPackagedProduct accepts a correctly stamped product", () => {
  assertPackagedProduct(PRODUCT, { commit: "abc123" });
});

test("assertPackagedProduct accepts a preview-stamped product", () => {
  assertPackagedProduct(
    {
      ...PRODUCT,
      ...releaseIdentityFor("preview"),
      quality: "preview",
    },
    { commit: "abc123", channel: "preview" },
  );
});

test("assertPackagedProduct rejects stable identity on a preview build", () => {
  assert.throws(
    () =>
      assertPackagedProduct(
        { ...PRODUCT, quality: "preview" },
        { commit: "abc123", channel: "preview" },
      ),
    /nameShort/,
  );
});

test("assertPackagedProduct rejects a cross-channel product", () => {
  assert.throws(
    () =>
      assertPackagedProduct(PRODUCT, {
        commit: "abc123",
        channel: "preview",
      }),
    /quality/,
  );
});

test("assertReleaseChannel rejects an unsupported channel", () => {
  assert.throws(() => assertReleaseChannel("nightly"), /stable or preview/);
});

test("assertPackagedProduct rejects a mismatched commit", () => {
  assert.throws(
    () => assertPackagedProduct(PRODUCT, { commit: "def456" }),
    /commit/,
  );
});

test("assertPackagedProduct rejects a build with an automatic update feed", () => {
  assert.throws(
    () =>
      assertPackagedProduct(
        { ...PRODUCT, updateUrl: "https://update.dev.fast" },
        { commit: "abc123" },
      ),
    /must not configure an automatic update feed/,
  );
});

test("assertUpdaterCompatibleApp rejects read-only package files", async () => {
  const app = await mkdtemp(path.join(os.tmpdir(), "review-update-app-"));
  temporaryRoots.push(app);
  const resources = path.join(app, "Contents", "Resources");
  await mkdir(resources, { recursive: true });
  const object = path.join(resources, "git-object");
  await writeFile(object, "object");
  await chmod(object, 0o444);

  assert.throws(() => assertUpdaterCompatibleApp(app), /git-object/);

  await chmod(object, 0o644);
  assert.doesNotThrow(() => assertUpdaterCompatibleApp(app));
});

async function makeNoticeFixture({
  includeBuiltin = true,
  includeLegal = true,
  includeAppLegal = true,
  curatedLegalPath = "LICENSE.txt",
  emptyThirdPartyNotice = false,
  includeSharedLegal = false,
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-extension-closure-"));
  temporaryRoots.push(root);
  const extensions = path.join(root, "extensions");
  await mkdir(extensions, { recursive: true });
  await mkdir(path.join(extensions, "node_modules"));
  const addExtension = async (folder, publisher, name, legalPath) => {
    const directory = path.join(extensions, folder);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ publisher, name }),
    );
    if (legalPath) {
      const legalFile = path.join(directory, legalPath);
      await mkdir(path.dirname(legalFile), { recursive: true });
      await writeFile(legalFile, "license");
    }
  };
  await addExtension("curated", "fixture", "curated", includeLegal ? curatedLegalPath : undefined);
  if (includeBuiltin) await addExtension("builtin", "fixture", "builtin", undefined);
  if (includeAppLegal) {
    await writeFile(path.join(root, "LICENSE.txt"), "app license");
    await writeFile(path.join(root, "ThirdPartyNotices.txt"), emptyThirdPartyNotice ? "" : "app notices");
    await mkdir(path.join(root, "licenses"));
    await writeFile(path.join(root, "licenses", "MIT.txt"), "MIT");
  }
  if (includeSharedLegal) {
    const sharedLegal = path.join(extensions, "node_modules", "@fixture", "support", "LICENSE.txt");
    await mkdir(path.dirname(sharedLegal), { recursive: true });
    await writeFile(sharedLegal, "shared extension dependency license");
  }
  return root;
}

const fixtureClosure = {
  builtinIds: ["fixture.builtin"],
  curatedIds: ["fixture.curated"],
  curatedLegalInventory: { "fixture.curated": ["LICENSE.txt"] },
};

test("packaged extension notice closure rejects missing and extra payloads", async (t) => {
  const missing = await makeNoticeFixture({ includeBuiltin: false });
  await t.test("missing expected payload", () => {
    assert.throws(
      () => assertPackagedExtensionNoticeClosure(missing, fixtureClosure),
      /missing: fixture\.builtin/,
    );
  });

  const extra = await makeNoticeFixture();
  const extraDir = path.join(extra, "extensions", "extra");
  await mkdir(extraDir);
  await writeFile(
    path.join(extraDir, "package.json"),
    JSON.stringify({ publisher: "fixture", name: "extra" }),
  );
  await t.test("unexpected payload", () => {
    assert.throws(
      () => assertPackagedExtensionNoticeClosure(extra, fixtureClosure),
      /unexpected: fixture\.extra/,
    );
  });

  const unmanifested = await makeNoticeFixture();
  await mkdir(path.join(unmanifested, "extensions", "extra-directory"));
  await t.test("unexpected directory without a manifest", () => {
    assert.throws(
      () => assertPackagedExtensionNoticeClosure(unmanifested, fixtureClosure),
      /unexpected extension directory without package\.json/,
    );
  });
});

test("packaged extension notice closure rejects missing legal files", async () => {
  const root = await makeNoticeFixture({ includeLegal: false });
  assert.throws(
    () => assertPackagedExtensionNoticeClosure(root, fixtureClosure),
    /fixture\.curated: required legal file is missing: LICENSE\.txt/,
  );
});

test("packaged extension notice closure requires secondary curated notices", async () => {
  const root = await makeNoticeFixture();
  const secondaryNotice = path.join(
    root,
    "extensions",
    "curated",
    "nested",
    "ThirdPartyNotices.txt",
  );
  await mkdir(path.dirname(secondaryNotice), { recursive: true });
  await writeFile(secondaryNotice, "secondary notice");
  await rm(secondaryNotice);
  assert.throws(
    () =>
      assertPackagedExtensionNoticeClosure(root, {
        ...fixtureClosure,
        curatedLegalInventory: {
          "fixture.curated": ["LICENSE.txt", "nested/ThirdPartyNotices.txt"],
        },
      }),
    /fixture\.curated: required legal file is missing: nested\/ThirdPartyNotices\.txt/,
  );
});

test("packaged extension notice closure rejects symlinked extension entries", async () => {
  const root = await makeNoticeFixture();
  await symlink(
    path.join(root, "extensions", "builtin"),
    path.join(root, "extensions", "linked-builtin"),
    "dir",
  );
  assert.throws(
    () => assertPackagedExtensionNoticeClosure(root, fixtureClosure),
    /not a real packaged extension directory/,
  );
});

test("packaged extension notice closure rejects nested curated symlinks", async () => {
  const root = await makeNoticeFixture();
  await symlink(
    path.join(root, "extensions", "builtin", "package.json"),
    path.join(root, "extensions", "curated", "linked-manifest.json"),
  );
  assert.throws(
    () => assertPackagedExtensionNoticeClosure(root, fixtureClosure),
    /symlink inside a packaged extension payload/,
  );
});

test("packaged extension notice closure rejects nested built-in symlinks", async () => {
  const root = await makeNoticeFixture();
  await symlink(
    path.join(root, "extensions", "curated", "LICENSE.txt"),
    path.join(root, "extensions", "builtin", "linked-license.txt"),
  );
  assert.throws(
    () => assertPackagedExtensionNoticeClosure(root, fixtureClosure),
    /symlink inside a packaged extension payload/,
  );
});

test("packaged extension notice closure rejects nested shared-module symlinks", async () => {
  const root = await makeNoticeFixture({ includeSharedLegal: true });
  await symlink(
    path.join(root, "extensions", "builtin"),
    path.join(root, "extensions", "node_modules", "@fixture", "support", "linked"),
    "dir",
  );
  assert.throws(
    () => assertPackagedExtensionNoticeClosure(root, fixtureClosure),
    /symlink inside a packaged extension payload/,
  );
});

test("packaged extension notice closure rejects Pylance anywhere under extensions", async () => {
  const root = await makeNoticeFixture({ includeSharedLegal: true });
  await writeFile(
    path.join(root, "extensions", "node_modules", "@fixture", "support", "pylance-server"),
    "binary",
  );
  assert.throws(
    () => assertPackagedExtensionNoticeClosure(root, fixtureClosure),
    /packaged extensions contain a Pylance path: node_modules\/@fixture\/support\/pylance-server/,
  );
});

test("packaged extension notice closure rejects unsafe pinned legal paths", async () => {
  const root = await makeNoticeFixture();
  assert.throws(
    () =>
      assertPackagedExtensionNoticeClosure(root, {
        ...fixtureClosure,
        curatedLegalInventory: { "fixture.curated": ["../LICENSE.txt"] },
      }),
    /unsafe relative legal-file path/,
  );
});

test("packaged extension notice closure rejects empty app notices", async () => {
  const root = await makeNoticeFixture({ emptyThirdPartyNotice: true });
  assert.throws(
    () => assertPackagedExtensionNoticeClosure(root, fixtureClosure),
    /ThirdPartyNotices\.txt/,
  );
});

test("packaged extension notice index includes nested and shared legal files", async () => {
  const root = await makeNoticeFixture({
    curatedLegalPath: "nested/licenses/NOTICE.txt",
    includeSharedLegal: true,
  });
  const index = assertPackagedExtensionNoticeClosure(root, {
    ...fixtureClosure,
    curatedLegalInventory: {
      "fixture.curated": ["nested/licenses/NOTICE.txt"],
    },
  });
  assert.deepEqual(index.extensions.find((extension) => extension.id === "fixture.curated").files, [
    "extensions/curated/nested/licenses/NOTICE.txt",
  ]);
  assert.deepEqual(index.sharedExtensionFiles, [
    "extensions/node_modules/@fixture/support/LICENSE.txt",
  ]);
});
