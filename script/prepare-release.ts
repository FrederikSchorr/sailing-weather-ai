import { prepareRelease } from "./release-metadata";
import { formatReleaseMonth, type ReleaseBump } from "../shared/release-utils";

const args = process.argv.slice(2);
const bump = args[0] ?? "patch";
if (args.length > 1 || !["patch", "minor", "major"].includes(bump)) {
  console.error("Aufruf: npm run release:prepare -- [patch|minor|major]");
  process.exitCode = 1;
} else {
  prepareRelease(process.cwd(), bump as ReleaseBump).then(release => {
    console.log(`Release vorbereitet: v${release.version} · ${formatReleaseMonth(release.preparedAt)}`);
    console.log("Für diesen Release nur einmal vorbereiten; bei Build-/Publish-Wiederholungen nicht erneut ausführen.");
    console.log("Jetzt prüfen und committen; optional mit npm run release:tag lokal kennzeichnen (docs/releases.md).");
    console.log("Tag-Push und Veröffentlichung sind separate, bewusst auszulösende Schritte.");
  }).catch(error => {
    console.error("Release-Vorbereitung fehlgeschlagen:", error.message);
    process.exitCode = 1;
  });
}