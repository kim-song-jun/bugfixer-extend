// Gate between a packaged, notarized build and the R2 upload: verify the
// artifacts really are the release we think they are, then emit the
// latest.json manifest the update Worker serves (see apps/update/src/types.ts
// for the schema). Run from the release workflow after app:package:macos.
// Curated extension checks also read code-oss/package.json from this checkout.
//
//   node scripts/validate-release-artifacts.mjs \
//     --version 1.2.3 --commit <tag sha> [--channel stable|preview]
//     [--artifact-dir dist]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { verifyCuratedExtensions } from "./curated-extensions.mjs";
import { bundledExtensions } from "./curated-extensions.manifest.mjs";
import {
  assertReleaseChannel,
  releaseIdentityFor,
  updateBundlesFor,
  updateZipName,
} from "./release-channel.mjs";
import { assertPackagedArtifacts } from "./stage-review-runtime.mjs";

const APP_DIR = path.resolve(import.meta.dirname, "..");

const UPDATE_URL = "https://update.dev.fast";

export { assertReleaseChannel };

const BUILTIN_EXTENSION_INVENTORY = JSON.parse(
  readFileSync(
    new URL("./packaged-builtin-extension-inventory.json", import.meta.url),
    "utf8",
  ),
);
const CURATED_EXTENSION_LEGAL_INVENTORY = JSON.parse(
  readFileSync(
    new URL("./packaged-curated-extension-legal-inventory.json", import.meta.url),
    "utf8",
  ),
);

const LEGAL_FILE_PATTERN = /^(license|licence|notice|copying|copyright|thirdpartynotices)([-_.]|$)/i;

function collectExtensionDirs(root) {
  const directories = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    const metadata = lstatSync(absolute);
    if (entry.name === "node_modules") {
      if (!metadata.isDirectory()) {
        throw new Error(`${absolute} must be a real shared node_modules directory`);
      }
      continue;
    }
    if (!metadata.isDirectory()) {
      throw new Error(`${absolute} is not a real packaged extension directory`);
    }

    const manifest = path.join(absolute, "package.json");
    let manifestMetadata;
    try {
      manifestMetadata = lstatSync(manifest);
    } catch {
      throw new Error(`${absolute} is an unexpected extension directory without package.json`);
    }
    if (!manifestMetadata.isFile()) {
      throw new Error(`${manifest} must be a regular, non-symlink file`);
    }
    directories.push(absolute);
  }
  return directories;
}

function collectLegalFiles(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile() && LEGAL_FILE_PATTERN.test(entry.name)) {
        files.push(path.relative(root, absolute).split(path.sep).join("/"));
      }
    }
  };
  walk(root);
  return files.sort();
}

function collectFiles(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        files.push(path.relative(root, absolute).split(path.sep).join("/"));
      }
    }
  };
  walk(root);
  return files.sort();
}

function containsRegularFile(directory) {
  return readdirSync(directory, { withFileTypes: true }).some((entry) => {
    if (entry.isFile()) return true;
    return entry.isDirectory() && containsRegularFile(path.join(directory, entry.name));
  });
}

function assertNoSymlinksRecursively(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const metadata = lstatSync(absolute);
    if (metadata.isSymbolicLink()) {
      throw new Error(`${absolute} is a symlink inside a packaged extension payload`);
    }
    if (metadata.isDirectory()) assertNoSymlinksRecursively(absolute);
    else if (!metadata.isFile()) {
      throw new Error(`${absolute} is not a regular file inside a packaged extension payload`);
    }
  }
}

function findPylancePath(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (/pylance/i.test(entry.name)) return absolute;
    if (entry.isDirectory()) {
      const nested = findPylancePath(absolute);
      if (nested) return nested;
    }
  }
  return undefined;
}

/** Checks the exact packaged extension set and retained license/notice closure. */
export function assertPackagedExtensionNoticeClosure(
  appResourcesApp,
  {
    curatedIds,
    builtinIds = BUILTIN_EXTENSION_INVENTORY,
    curatedLegalInventory = CURATED_EXTENSION_LEGAL_INVENTORY,
  },
) {
  const extensionsRoot = path.join(appResourcesApp, "extensions");
  if (!lstatSync(extensionsRoot).isDirectory()) {
    throw new Error(`${extensionsRoot} must be a real extension directory`);
  }
  const dirs = collectExtensionDirs(extensionsRoot);
  const actual = new Map();

  for (const directory of dirs) {
    const manifest = JSON.parse(
      readFileSync(path.join(directory, "package.json"), "utf8"),
    );
    const id = `${manifest.publisher}.${manifest.name}`.toLowerCase();
    if (actual.has(id)) throw new Error(`duplicate packaged extension id ${id}`);
    actual.set(id, directory);
  }

  const expected = new Set([...builtinIds, ...curatedIds].map((id) => id.toLowerCase()));
  const missing = [...expected].filter((id) => !actual.has(id)).sort();
  const extra = [...actual.keys()].filter((id) => !expected.has(id)).sort();
  if (missing.length || extra.length) {
    throw new Error(
      `packaged extension inventory mismatch${missing.length ? `; missing: ${missing.join(", ")}` : ""}${extra.length ? `; unexpected: ${extra.join(", ")}` : ""}`,
    );
  }

  const appLegalFiles = collectLegalFiles(appResourcesApp);
  const requiredAppFiles = ["LICENSE.txt", "ThirdPartyNotices.txt"];
  const invalidAppFiles = requiredAppFiles.filter((file) => {
    try {
      const metadata = lstatSync(path.join(appResourcesApp, file));
      return !metadata.isFile() || metadata.size === 0;
    } catch {
      return true;
    }
  });
  const licensesDir = path.join(appResourcesApp, "licenses");
  let hasLicenseDirectory = false;
  try {
    hasLicenseDirectory = lstatSync(licensesDir).isDirectory() && containsRegularFile(licensesDir);
  } catch {
    // Reported below as part of the package's legal closure.
  }
  if (invalidAppFiles.length || !hasLicenseDirectory) {
    throw new Error(
      `packaged app legal files are incomplete${invalidAppFiles.length ? `; missing, empty, or non-regular: ${invalidAppFiles.join(", ")}` : ""}${!hasLicenseDirectory ? "; missing non-empty licenses/ directory" : ""}`,
    );
  }

  const curatedIdSet = new Set(curatedIds.map((id) => id.toLowerCase()));
  for (const id of curatedIdSet) {
    if (!Array.isArray(curatedLegalInventory[id])) {
      throw new Error(`${id}: no pinned legal-file inventory is defined`);
    }
  }
  const sharedNodeModules = path.join(extensionsRoot, "node_modules");
  for (const directory of dirs) assertNoSymlinksRecursively(directory);
  assertNoSymlinksRecursively(sharedNodeModules);
  const pylancePath = findPylancePath(extensionsRoot);
  if (pylancePath) {
    throw new Error(
      `packaged extensions contain a Pylance path: ${path.relative(extensionsRoot, pylancePath)}`,
    );
  }

  const perExtension = [];
  for (const [id, directory] of [...actual].sort(([left], [right]) => left.localeCompare(right))) {
    const files = collectLegalFiles(directory);
    if (curatedIdSet.has(id)) {
      for (const relative of curatedLegalInventory[id]) {
        if (
          typeof relative !== "string" ||
          relative.length === 0 ||
          relative.includes("\\") ||
          relative.startsWith("/") ||
          relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
        ) {
          throw new Error(`${id}: unsafe relative legal-file path ${JSON.stringify(relative)}`);
        }
        let metadata;
        try {
          metadata = lstatSync(path.join(directory, relative));
        } catch {
          throw new Error(`${id}: required legal file is missing: ${relative}`);
        }
        if (!metadata.isFile() || metadata.size === 0) {
          throw new Error(`${id}: required legal file is empty or non-regular: ${relative}`);
        }
      }
    }
    perExtension.push({ id, files: files.map((file) => `extensions/${path.basename(directory)}/${file}`) });
  }

  return {
    format: 1,
    extensions: perExtension,
    sharedExtensionFiles: collectLegalFiles(sharedNodeModules).map(
      (file) => `extensions/node_modules/${file}`,
    ),
    appFiles: [
      ...new Set([
        ...appLegalFiles.filter((file) => !file.startsWith("extensions/")),
        ...collectFiles(licensesDir).map((file) => `licenses/${file}`),
      ]),
    ].sort(),
  };
}

// `payloads` is one entry per update zip, in updateBundlesFor() order: the
// first is the default for clients that do not name their bundle folder.
export function buildManifest({ version, commit, payloads, now = new Date() }) {
  const bundles = Object.fromEntries(
    payloads.map(({ bundle, artifact, sha256 }) => [
      bundle,
      {
        url: `${UPDATE_URL}/releases/${version}/darwin-arm64/${updateZipName(artifact, version)}`,
        sha256hash: sha256,
      },
    ]),
  );

  const [fallback] = Object.values(bundles);

  return {
    version,
    commit,
    ...fallback,
    name: version,
    pub_date: now.toISOString(),
    timestamp: now.getTime(),
    bundles,
  };
}

// Squirrel renames an install to the update's CFBundleExecutable, so a zip
// served to <bundle>.app installs must carry exactly that bundle with an
// executable of the same name; anything else renames the install.
export function assertZipBundle(zip, bundle) {
  const folder = `${bundle}.app`;

  const roots = new Set(
    execFileSync(
      "sh",
      ["-c", 'unzip -Z1 "$1" | cut -d/ -f1 | sort -u', "sh", zip],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean),
  );

  if (roots.size !== 1 || !roots.has(folder)) {
    throw new Error(
      `${zip} must contain only ${folder}/, found ${[...roots].join(", ") || "nothing"}`,
    );
  }

  const executable = execFileSync(
    "sh",
    [
      "-c",
      'unzip -p "$1" "$2/Contents/Info.plist" | plutil -extract CFBundleExecutable raw -o - -',
      "sh",
      zip,
      folder,
    ],
    { encoding: "utf8" },
  ).trim();

  if (executable !== bundle) {
    throw new Error(
      `${zip}: ${folder} runs ${JSON.stringify(executable)}, so Squirrel would rename installs to ${executable}.app; expected ${bundle}`,
    );
  }
}

export function assertPackagedProduct(product, { commit, channel = "stable" }) {
  assertReleaseChannel(channel);

  const expectations = {
    commit,
    quality: channel,
    ...releaseIdentityFor(channel),
  };

  for (const [key, expected] of Object.entries(expectations)) {
    if (product[key] !== expected) {
      throw new Error(
        `packaged product.json ${key} is ${JSON.stringify(product[key])}, expected ${JSON.stringify(expected)}`,
      );
    }
  }

  if (Object.hasOwn(product, "updateUrl")) {
    throw new Error(
      `packaged product.json must not configure an automatic update feed; found ${JSON.stringify(product.updateUrl)}`,
    );
  }
}

export function assertUpdaterCompatibleApp(app) {
  const unwritable = [];

  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }

      if (!entry.isFile()) continue;

      if ((lstatSync(absolute).mode & 0o200) === 0) {
        unwritable.push(path.relative(app, absolute));
      }
    }
  };

  walk(app);

  if (unwritable.length > 0) {
    const shown = unwritable.slice(0, 20).join("\n  ");
    const remaining = unwritable.length - Math.min(unwritable.length, 20);
    throw new Error(
      `packaged app contains files that the macOS updater cannot modify:\n  ${shown}${remaining > 0 ? `\n  ... and ${remaining} more` : ""}`,
    );
  }
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit" });
}

function writeFileAtomically(file, content) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: "wx" });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      commit: { type: "string" },
      channel: { type: "string", default: "stable" },
      "artifact-dir": { type: "string" },
    },
  });

  const { version, commit, channel } = values;

  if (!version || !commit) {
    console.error(
      "usage: validate-release-artifacts.mjs --version <semver> --commit <sha> [--channel stable|preview] [--artifact-dir <dir>]",
    );
    process.exit(2);
  }

  assertReleaseChannel(channel);

  const artifactDir = path.resolve(
    values["artifact-dir"] ?? path.join(APP_DIR, "dist"),
  );

  const sourceProduct = JSON.parse(
    readFileSync(path.join(APP_DIR, "code-oss", "product.json"), "utf8"),
  );

  const app = path.join(
    APP_DIR,
    "VSCode-darwin-arm64",
    `${sourceProduct.nameShort}.app`,
  );

  const zips = updateBundlesFor(channel).map(({ bundle, artifact }) => ({
    bundle,
    artifact,
    file: path.join(artifactDir, updateZipName(artifact, version)),
  }));

  const dmg = path.join(artifactDir, `Whiteboard-darwin-arm64-${version}.dmg`);

  await assertPackagedArtifacts(app);
  assertUpdaterCompatibleApp(app);

  const product = JSON.parse(
    readFileSync(
      path.join(app, "Contents", "Resources", "app", "product.json"),
      "utf8",
    ),
  );

  assertPackagedProduct(product, { commit, channel });
  verifyCuratedExtensions({
    root: path.join(app, "Contents", "Resources", "app", "extensions"),
    target: "darwin-arm64",
  });
  const appResourcesApp = path.join(app, "Contents", "Resources", "app");
  const noticeIndex = assertPackagedExtensionNoticeClosure(appResourcesApp, {
    curatedIds: bundledExtensions.map((extension) => extension.id),
  });
  const noticeIndexPath = path.join(artifactDir, "extension-notice-index.json");

  run("xcrun", ["stapler", "validate", app]);
  run("spctl", ["-a", "-vv", "--type", "exec", app]);
  run("xcrun", ["stapler", "validate", dmg]);

  for (const { bundle, file } of zips) {
    assertZipBundle(file, bundle);
  }

  const payloads = zips.map((zip) => ({ ...zip, sha256: sha256(zip.file) }));
  const manifest = buildManifest({ version, commit, payloads });
  writeFileAtomically(
    noticeIndexPath,
    `${JSON.stringify(noticeIndex, null, 2)}\n`,
  );
  const manifestPath = path.join(artifactDir, "latest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`Validated release artifacts for ${version} (${commit}):`);

  for (const { bundle, file, sha256 } of payloads) {
    console.log(`  ${file} (${bundle}.app) sha256=${sha256}`);
  }

  console.log(`  ${dmg} sha256=${sha256(dmg)}`);
  console.log(`  ${manifestPath}`);
  console.log(`  ${noticeIndexPath}`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await main();
}
