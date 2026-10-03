import { createReleaseTag } from "./release-tag";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--dry-run")) {
  console.error("Aufruf: npm run release:tag -- [--dry-run]");
  process.exitCode = 1;
} else {
  try {
    const result = createReleaseTag(process.cwd(), args[0] === "--dry-run");
    console.log(`${result.dryRun ? "Geprüft, nicht erstellt" : "Lokal erstellt"}: ${result.tag} → ${result.commit}`);
    console.log("Kein Push, keine Veröffentlichung. Remote und vorhandene Remote-Tags vor einem bestätigten Push prüfen (docs/releases.md).");
  } catch (error) {
    console.error("Release-Tag fehlgeschlagen:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}