export type ReleaseBump = "patch" | "minor" | "major";

export interface ReleaseMetadata {
  version: string;
  preparedAt: string | null;
}

export function validateRelease(metadata: ReleaseMetadata): void {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(metadata.version)) {
    throw new Error("Release-Version muss dem Format Major.Minor.Patch entsprechen.");
  }
  if (metadata.preparedAt !== null && (
    typeof metadata.preparedAt !== "string"
    || !Number.isFinite(Date.parse(metadata.preparedAt))
    || new Date(metadata.preparedAt).toISOString() !== metadata.preparedAt
  )) {
    throw new Error("Release-Datum muss ein gültiger ISO-UTC-Zeitpunkt sein.");
  }
}

export function nextRelease(
  current: ReleaseMetadata,
  bump: ReleaseBump = "patch",
  now = new Date(),
): ReleaseMetadata {
  validateRelease(current);
  const [major, minor, patch] = current.version.split(".").map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new Error("Release-Version überschreitet den sicheren Zahlenbereich.");
  }
  if (!["patch", "minor", "major"].includes(bump)) {
    throw new Error("Erlaubte Versionssprünge: patch, minor, major.");
  }
  const parts = bump === "major" ? [major + 1, 0, 0]
    : bump === "minor" ? [major, minor + 1, 0] : [major, minor, patch + 1];
  if (!parts.every(Number.isSafeInteger)) throw new Error("Release-Version zu groß.");
  return { version: parts.join("."), preparedAt: now.toISOString() };
}

export function formatReleaseMonth(preparedAt: string | null): string {
  if (preparedAt === null) return "Release nicht vorbereitet";
  validateRelease({ version: "0.0.0", preparedAt });
  return new Intl.DateTimeFormat("de-AT", {
    timeZone: "Europe/Vienna", month: "long", year: "numeric",
  }).format(new Date(preparedAt));
}