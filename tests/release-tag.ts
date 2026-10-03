import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createReleaseTag } from "../script/release-tag";

const root = await mkdtemp(path.join(tmpdir(), "release-tag-"));
const git = (...args: string[]) => execFileSync("git", args, {
  cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();
async function metadata(version = "2.3.0", preparedAt: string | null = "2026-10-03T06:00:00.000Z",
  packageVersion = version, lockVersion = version, rootVersion = version) {
  await writeFile(path.join(root, "shared/release.json"), JSON.stringify({ version, preparedAt }));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version: packageVersion }));
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify({
    version: lockVersion, packages: { "": { version: rootVersion } },
  }));
}
function commit() {
  git("add", ".");
  git("commit", "-m", "Release fixture");
}
try {
  assert.throws(() => createReleaseTag(root));
  git("init");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release-test@example.invalid");
  await mkdir(path.join(root, "shared"));
  await metadata();
  assert.throws(() => createReleaseTag(root)); // no commit yet
  commit();
  assert.throws(() => createReleaseTag(path.join(root, "shared")), /Hauptverzeichnis/);
  const first = git("rev-parse", "HEAD");
  assert.equal(createReleaseTag(root, true).commit, first);
  assert.equal(git("tag", "--list"), "");
  const result = createReleaseTag(root);
  assert.equal(result.tag, "v2.3.0");
  assert.equal(git("cat-file", "-t", result.tag), "tag");
  assert.equal(git("rev-parse", `${result.tag}^{commit}`), first);
  assert.match(git("cat-file", "-p", result.tag), /2026-10-03T06:00:00.000Z/);
  assert.throws(() => createReleaseTag(root), /existiert bereits/);
  assert.throws(() => createReleaseTag(root, true), /existiert bereits/);
  await writeFile(path.join(root, "untracked"), "new");
  assert.throws(() => createReleaseTag(root), /Uncommittete/);
  await rm(path.join(root, "untracked"));
  await metadata("2.3.1");
  assert.throws(() => createReleaseTag(root), /Uncommittete/);
  git("add", ".");
  assert.throws(() => createReleaseTag(root), /Uncommittete/); // staged
  commit();
  assert.equal(createReleaseTag(root).tag, "v2.3.1");
  assert.equal(git("rev-parse", "v2.3.0^{commit}"), first);
  for (const versions of [
    ["2.3.2", "2.3.1", "2.3.2", "2.3.2"],
    ["2.3.2", "2.3.2", "2.3.1", "2.3.2"],
    ["2.3.2", "2.3.2", "2.3.2", "2.3.1"],
  ]) {
    await metadata(versions[0], "2026-10-03T06:00:00.000Z", ...versions.slice(1) as [string, string, string]);
    commit();
    assert.throws(() => createReleaseTag(root), /nicht überein/);
  }
  for (const date of [null, "invalid"]) {
    await metadata("2.3.2", date);
    commit();
    assert.throws(() => createReleaseTag(root));
  }
  await metadata("2.03.2");
  commit();
  assert.throws(() => createReleaseTag(root), /Major.Minor.Patch/);
  await metadata("2.3.2");
  commit();
  git("tag", "v2.3.2"); // lightweight tags cannot be silently replaced either
  assert.throws(() => createReleaseTag(root), /existiert bereits/);
  assert.equal(git("cat-file", "-t", "v2.3.2"), "commit");
  assert.equal(git("remote"), ""); // local tagging needs no remote
  console.log("Release tag regressions passed.");
} finally {
  await rm(root, { recursive: true, force: true });
}