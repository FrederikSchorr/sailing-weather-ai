import metadata from "./release.json";
import { formatReleaseMonth, validateRelease } from "./release-utils";

validateRelease(metadata);

// JSON is bundled into both outputs, never computed from the browser/server clock.
export const appRelease = Object.freeze(metadata);
export const releaseMonth = formatReleaseMonth(appRelease.preparedAt);