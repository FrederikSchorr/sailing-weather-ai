import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readPhotoMetadata } from "../server/photo-metadata";
import { convertHeicToJpeg } from "../server/heic-image";
import { gpsHeic, gpsWebp } from "./fixtures/photo-images";

for (const makePhoto of [gpsHeic, gpsWebp]) {
  for (const point of [{ lat: 47.924567891, lon: 16.864567891 }, { lat: 0, lon: 0 }, { lat: -33.924, lon: -18.425 }]) {
    const metadata = readPhotoMetadata(makePhoto(point.lat, point.lon));
    assert.ok(metadata.gps);
    assert.ok(Math.abs(metadata.gps.lat - point.lat) < 1e-9);
    assert.ok(Math.abs(metadata.gps.lon - point.lon) < 1e-9);
  }
  assert.equal(readPhotoMetadata(makePhoto(91, 0)).gps, null);
  assert.equal(readPhotoMetadata(makePhoto(0, 181)).gps, null);
}
for (const file of ["no-metadata.heic", "no-metadata.webp"]) {
  assert.equal(readPhotoMetadata(readFileSync(new URL(`./fixtures/images/${file}`, import.meta.url))).gps, null);
}
assert.deepEqual(readPhotoMetadata(Buffer.from("malformed image")), { gps: null, time: null });
const heic = gpsHeic(47.924567891, 16.864567891);
const jpeg = await convertHeicToJpeg(heic);
assert.equal(jpeg.subarray(0, 3).toString("hex"), "ffd8ff");
assert.equal(readPhotoMetadata(jpeg).gps, null, "converted previews must not leak the recording GPS");
const canceled = new AbortController();
canceled.abort();
await assert.rejects(convertHeicToJpeg(heic, canceled.signal), { name: "AbortError" });
const stop = new AbortController();
const running = convertHeicToJpeg(heic, stop.signal);
const rejected = assert.rejects(running, { name: "AbortError" });
stop.abort();
await rejected;
await assert.rejects(convertHeicToJpeg(heic, undefined, 1), /zu lange/);
await assert.rejects(convertHeicToJpeg(Buffer.from("not HEIC")), /HEIC/);
console.log("HEIC/WebP metadata and real conversion tests passed (GPS, signed/zero/invalid coordinates, missing metadata, conversion, privacy, cancellation and timeout).");