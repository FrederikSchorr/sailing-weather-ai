import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appRelease, releaseMonth } from "../shared/app-release";
import { nextRelease, formatReleaseMonth, validateRelease } from "../shared/release-utils";
import { checkReleaseMetadata, prepareRelease } from "../script/release-metadata";
import { createAnalysis } from "../server/analysis-store";

const now = new Date("2026-10-03T06:00:00.000Z");
const baseline = { version: "2.0.0", preparedAt: null };
assert.equal(nextRelease(baseline, "patch", now).version, "2.0.1");
assert.equal(nextRelease({ ...baseline, version: "2.0.1" }, "patch", now).version, "2.0.2");
assert.equal(nextRelease({ ...baseline, version: "2.3.0" }, "patch", now).version, "2.3.1");
assert.equal(nextRelease({ ...baseline, version: "2.3.1" }, "patch", now).version, "2.3.2");
assert.equal(nextRelease({ ...baseline, version: "2.3.0" }, "minor", now).version, "2.4.0");
assert.equal(nextRelease({ ...baseline, version: "2.8.9" }, "minor", now).version, "2.9.0");
assert.equal(nextRelease({ ...baseline, version: "2.8.9" }, "major", now).version, "3.0.0");
assert.throws(() => validateRelease({ ...baseline, version: "2.0" }));
assert.throws(() => validateRelease({ ...baseline, version: "2.01.0" }));
assert.throws(() => validateRelease({ ...baseline, preparedAt: "invalid" }));
assert.equal(formatReleaseMonth("2026-09-30T21:59:59.000Z"), "Sep 2026");
assert.equal(formatReleaseMonth("2026-09-30T22:00:00.000Z"), "Okt 2026");
assert.equal(formatReleaseMonth("2026-12-31T23:00:00.000Z"), "Jän 2027");
for (let month = 0; month < 12; month++) {
  const label = formatReleaseMonth(new Date(Date.UTC(2026, month, 15)).toISOString());
  assert.match(label, /^\p{L}{3,4} 2026$/u);
  assert.equal(label.includes("."), false);
}
assert.equal(releaseMonth, formatReleaseMonth(appRelease.preparedAt));

const fixture = await mkdtemp(path.join(tmpdir(), "aiwindy-release-"));
try {
  await mkdir(path.join(fixture, "shared"));
  await writeFile(path.join(fixture, "shared/release.json"), JSON.stringify(baseline));
  await writeFile(path.join(fixture, "package.json"), JSON.stringify({ version: "2.0.0", scripts: { build: "untouched" } }));
  await writeFile(path.join(fixture, "package-lock.json"), JSON.stringify({
    version: "2.0.0", packages: { "": { version: "2.0.0" }, "node_modules/example": { version: "1.0.0" } },
  }));
  await assert.rejects(checkReleaseMetadata(fixture), /release:prepare/);
  const prepared = await prepareRelease(fixture, "patch", now);
  assert.deepEqual(prepared, { version: "2.0.1", preparedAt: now.toISOString() });
  const first = await readFile(path.join(fixture, "shared/release.json"), "utf8");
  // Builds read metadata; no runtime clock enters the metadata check.
  assert.deepEqual(await checkReleaseMetadata(fixture), prepared);
  assert.deepEqual(await checkReleaseMetadata(fixture), prepared);
  assert.equal(await readFile(path.join(fixture, "shared/release.json"), "utf8"), first);
  const pkg = JSON.parse(await readFile(path.join(fixture, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(path.join(fixture, "package-lock.json"), "utf8"));
  assert.equal(pkg.version, prepared.version);
  assert.equal(pkg.scripts.build, "untouched");
  assert.equal(lock.version, prepared.version);
  assert.equal(lock.packages[""].version, prepared.version);
  assert.equal(lock.packages["node_modules/example"].version, "1.0.0");
  assert.equal((await prepareRelease(fixture, "patch", now)).version, "2.0.2");
  assert.equal((await prepareRelease(fixture, "minor", now)).version, "2.1.0");
  assert.equal((await prepareRelease(fixture, "major", now)).version, "3.0.0");
  const beforeInvalid = await readFile(path.join(fixture, "shared/release.json"), "utf8");
  await assert.rejects(prepareRelease(fixture, "invalid" as "patch", now));
  assert.equal(await readFile(path.join(fixture, "shared/release.json"), "utf8"), beforeInvalid);
  await writeFile(path.join(fixture, "package.json"), JSON.stringify({ version: "9.0.0" }));
  await assert.rejects(checkReleaseMetadata(fixture), /nicht überein/);
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const analysis = createAnalysis({
  userInput: "Release regression", country: "Austria", countryCode: "AT",
  windyModel: "iconEu", sailingArea: null, city: null,
});
assert.equal(analysis.data.meta.version, appRelease.version);
assert.equal((analysis.getExportData().meta as { version: string }).version, appRelease.version);
assert.deepEqual(await checkReleaseMetadata(), appRelease);
console.log("Release regression tests passed (sequence, stability, Vienna dates, synchronization, export).");