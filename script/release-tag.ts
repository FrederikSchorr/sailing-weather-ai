import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { validateReleaseFiles } from "./release-metadata";

// Local only: this module never contacts a remote or publishes a release.
export function createReleaseTag(root = process.cwd(), dryRun = false) {
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (realpathSync(git("rev-parse", "--show-toplevel")) !== realpathSync(root)) {
    throw new Error("release:tag muss im Repository-Hauptverzeichnis ausgeführt werden.");
  }
  const commit = git("rev-parse", "--verify", "HEAD^{commit}");
  if (git("status", "--porcelain", "--untracked-files=all")) {
    throw new Error("Uncommittete Änderungen vorhanden. Erst prüfen und committen, dann taggen.");
  }
  // Read the immutable commit, not merely files in the working directory.
  const files = ["shared/release.json", "package.json", "package-lock.json"]
    .map(file => JSON.parse(git("show", `${commit}:${file}`)));
  const release = validateReleaseFiles(files[0], files[1], files[2]);
  if (release.preparedAt === null) {
    throw new Error("Der Release-Commit enthält keine vorbereiteten Release-Metadaten.");
  }
  const tag = `v${release.version}`;
  if (git("tag", "--list", tag)) {
    throw new Error(`Tag ${tag} existiert bereits. Bestehende Tags werden nicht überschrieben.`);
  }
  if (!dryRun) {
    git("tag", "-a", tag, commit, "-m",
      `aiWindy ${tag}\n\nRelease vorbereitet: ${release.preparedAt}\nCommit: ${commit}`);
  }
  return { tag, commit, release, dryRun };
}