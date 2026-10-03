import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { nextRelease, validateRelease, type ReleaseBump, type ReleaseMetadata } from "../shared/release-utils";

export function validateReleaseFiles(metadata: ReleaseMetadata, pkg: { version?: string },
  lock: { version?: string; packages?: Record<string, { version?: string }> }) {
  validateRelease(metadata);
  if (pkg.version !== metadata.version || lock.version !== metadata.version
    || lock.packages?.[""]?.version !== metadata.version) {
    throw new Error("Release-, Paket- und Lockfile-Version stimmen nicht überein.");
  }
  return metadata;
}

async function readReleaseFiles(root: string) {
  const paths = ["shared/release.json", "package.json", "package-lock.json"]
    .map(file => path.join(root, file));
  const originals = await Promise.all(paths.map(file => readFile(file, "utf8")));
  const [metadata, pkg, lock] = originals.map(text => JSON.parse(text));
  validateReleaseFiles(metadata, pkg, lock);
  return { paths, originals, metadata: metadata as ReleaseMetadata, pkg, lock };
}

export async function checkReleaseMetadata(root = process.cwd()) {
  const { metadata } = await readReleaseFiles(root);
  if (metadata.preparedAt === null) {
    throw new Error("Vor dem Produktionsbuild zuerst npm run release:prepare ausführen.");
  }
  return metadata;
}

export async function prepareRelease(
  root = process.cwd(),
  bump: ReleaseBump = "patch",
  now = new Date(),
) {
  const { paths, originals, metadata, pkg, lock } = await readReleaseFiles(root);
  const release = nextRelease(metadata, bump, now);
  pkg.version = release.version;
  lock.version = release.version;
  lock.packages[""].version = release.version;
  const contents = [release, pkg, lock].map(value => JSON.stringify(value, null, 2) + "\n");
  // Restore the originals on write errors instead of leaving conflicting versions.
  try {
    for (let i = 0; i < paths.length; i++) await writeFile(paths[i], contents[i]);
  } catch (error) {
    await Promise.all(paths.map((file, i) => writeFile(file, originals[i])));
    throw error;
  }
  return release;
}