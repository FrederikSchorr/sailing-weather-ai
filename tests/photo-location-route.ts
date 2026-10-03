import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Express } from "express";
import exifParser from "exif-parser";
import { Messages } from "@anthropic-ai/sdk/resources/messages/messages";
import { Completions } from "openai/resources/chat/completions/completions";
import { registerRoutes } from "../server/routes";
import { gpsHeic, gpsWebp } from "./fixtures/photo-images";
import { readPhotoMetadata } from "../server/photo-metadata";
import sailingAreas from "../data/sailingareas.json";

// A real EXIF GPS IFD, parsed by the production parser, not mocked metadata.
function gpsJpeg(lat: number, lon: number) {
  const tiff = Buffer.alloc(128);
  tiff.write("II"); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x8825, 10); tiff.writeUInt16LE(4, 12);
  tiff.writeUInt32LE(1, 14); tiff.writeUInt32LE(26, 18);
  tiff.writeUInt16LE(4, 26);
  for (const [offset, tag, type, count, value] of [
    [28, 1, 2, 2, lat < 0 ? 83 : 78], [40, 2, 5, 3, 80],
    [52, 3, 2, 2, lon < 0 ? 87 : 69], [64, 4, 5, 3, 104],
  ]) {
    tiff.writeUInt16LE(tag, offset); tiff.writeUInt16LE(type, offset + 2);
    tiff.writeUInt32LE(count, offset + 4); tiff.writeUInt32LE(value, offset + 8);
  }
  for (const [offset, coordinate] of [[80, lat], [104, lon]]) {
    const absolute = Math.abs(coordinate);
    const degrees = Math.floor(absolute);
    const minutes = Math.floor((absolute - degrees) * 60);
    const seconds = ((absolute - degrees) * 60 - minutes) * 60;
    for (const [index, numerator, denominator] of [[0, degrees, 1], [8, minutes, 1], [16, Math.round(seconds * 1e6), 1e6]]) {
      tiff.writeUInt32LE(numerator, offset + index); tiff.writeUInt32LE(denominator, offset + index + 4);
    }
  }
  const app1 = Buffer.concat([Buffer.from("Exif\0\0"), tiff]);
  const header = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(app1.length + 2, 4);
  return Buffer.concat([header, app1, Buffer.from([0xff, 0xd9])]);
}
const handlers = new Map<string, (req: any, res: any) => Promise<unknown>>();
const app = Object.fromEntries(["get", "post", "delete"].map(method => [
  method, (route: string, ...callbacks: any[]) => handlers.set(`${method} ${route}`, callbacks.at(-1)),
])) as unknown as Express;
await registerRoutes(createServer(), app);
const upload = handlers.get("post /api/upload")!;
const directory = await mkdtemp(path.join(tmpdir(), "photo-location-"));
const originalFetch = globalThis.fetch;
const originalDetect = Messages.prototype.create;
const originalVision = Completions.prototype.create;
let detectorCalls = 0;
let imageCalls = 0;
let lastImageUrl = "";
let failDetection = false;
globalThis.fetch = async input => {
  const url = new URL(String(input));
  assert.equal(url.host, "nominatim.openstreetmap.org");
  assert.equal(url.pathname, "/reverse");
  if (url.searchParams.get("lat") === "0") return new Response(JSON.stringify({ error: "Unable to geocode" }));
  return new Response(JSON.stringify({
    display_name: "Weiden am See, Österreich", address: { village: "Weiden am See", country_code: "at" },
  }));
};
(Messages.prototype as any).create = async (payload: any) => {
  detectorCalls++;
  assert.match(payload.messages[0].content, /Foto-Aufnahmeort/);
  if (failDetection) throw new Error("simulated area lookup outage");
  return { content: [{ type: "text", text: JSON.stringify({
    sailingArea: payload.messages[0].content.includes("Weiden") ? "Neusiedler See (Österreich)" : null,
    city: payload.messages[0].content.includes("Weiden") ? "Neusiedl am See" : null,
  }) }] };
};
(Completions.prototype as any).create = async (payload: any) => {
  imageCalls++;
  assert.equal(payload.messages[1].content[0].type, "image_url");
  lastImageUrl = payload.messages[1].content[0].image_url.url;
  assert.match(payload.messages[0].content, /ausschließlich das vorliegende Bild/);
  assert.doesNotMatch(payload.messages[0].content, /Vorheriges Revier|Kvarner/);
  return { choices: [{ message: { content: "## Aufnahme\nTest-Wolkenbild." } }] };
};
async function runPhoto(name: string, bytes: Buffer, currentLocation?: unknown, expectedError = false) {
  const filePath = path.join(directory, name);
  await writeFile(filePath, bytes);
  const req = Object.assign(new EventEmitter(), {
    body: currentLocation ? { currentLocation: JSON.stringify(currentLocation) } : {},
    file: { path: filePath, originalname: name, mimetype: "image/jpeg" },
    socket: { setNoDelay() {} },
  });
  const res = {
    headersSent: false, statusCode: 200, events: [] as any[],
    setHeader() {}, flushHeaders() { this.headersSent = true; },
    status(code: number) { this.statusCode = code; return this; },
    json() {}, end() {},
    write(chunk: string) {
      for (const line of chunk.split("\n")) if (line.startsWith("data: ")) this.events.push(JSON.parse(line.slice(6)));
    },
  };
  await upload(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.events.some(event => event.done));
  assert.equal(res.events.some(event => event.content), !expectedError);
  assert.equal(res.events.some(event => event.error), expectedError);
  await assert.rejects(access(filePath), { code: "ENOENT" });
  return res.events;
}
try {
  const jpeg = gpsJpeg(47.924567891, 16.864567891);
  const tags = exifParser.create(jpeg).parse().tags;
  const point = { lat: tags.GPSLatitude, lon: tags.GPSLongitude };
  const lake = sailingAreas["Österreich"].reviere.find(area => area.deutsch === "Neusiedler See (Österreich)")!;
  const windPoint = { lat: lake.lat, lon: lake.lon };
  const previous = { displayName: "Vorheriges Revier", sailingArea: "Kvarner", lat: 45, lon: 14 };
  for (const name of ["gallery-photo.jpg", "camera-photo.jpg"]) {
    const events = await runPhoto(name, jpeg, previous);
    const location = events.find(event => event.location).location;
    assert.equal(location.sailingArea, "Neusiedler See (Österreich)");
    assert.equal(location.cityName, "Weiden am See");
    assert.equal(location.type, "lake");
    assert.equal(location.source, "photo", "historic photo GPS must not become current device GPS");
    assert.equal(location.regionalModel, "czeAladin");
    assert.deepEqual({ lat: location.lat, lon: location.lon }, windPoint,
      "wind/waves use the catalogued sailing-area point, not recording GPS");
    assert.deepEqual({ lat: location.cityLat, lon: location.cityLon }, point);
    assert.equal(events.find(event => event.exifMeta).exifMeta.sailingArea, location.sailingArea);
  }
  const beforeNoGps = detectorCalls;
  const noGps = Buffer.from(jpeg);
  noGps.writeUInt16LE(0, 20); // Empty primary EXIF IFD, with no GPS pointer.
  noGps.writeUInt32LE(0, 22);
  assert.equal(exifParser.create(noGps).parse().tags.GPSLatitude, undefined);
  for (const active of [undefined, previous]) {
    const events = await runPhoto(`no-gps-${active ? "active" : "fresh"}.jpg`, noGps, active);
    assert.ok(!events.some(event => event.location), "no GPS must not replace an active location or invent an image location");
    assert.equal(events.find(event => event.exifMeta).exifMeta.locationName, null);
    assert.equal(events.find(event => event.exifMeta).exifMeta.sailingArea, null);
  }
  assert.equal(detectorCalls, beforeNoGps);
  const zero = await runPhoto("zero.jpg", gpsJpeg(0, 0));
  assert.equal(zero.find(event => event.location).location.lat, 0);
  assert.equal(zero.find(event => event.location).location.lon, 0);
  assert.equal(zero.find(event => event.location).location.sailingArea, null);
  assert.equal(zero.find(event => event.location).location.regionalModel, "gfs");
  const invalid = await runPhoto("invalid-gps.jpg", gpsJpeg(91, 16));
  assert.ok(!invalid.some(event => event.location));
  failDetection = true;
  const failedLookup = await runPhoto("failed-area.jpg", jpeg);
  assert.equal(failedLookup.find(event => event.location).location.sailingArea, null);
  assert.deepEqual({
    lat: failedLookup.find(event => event.location).location.lat,
    lon: failedLookup.find(event => event.location).location.lon,
  }, point);
  assert.equal(imageCalls, 7, "an area failure must not block the cloud-photo analysis");
  failDetection = false;
  for (const [name, bytes] of [
    ["gallery.webp", gpsWebp(47.924567891, 16.864567891)],
    ["camera.heic", gpsHeic(47.924567891, 16.864567891)],
  ] as const) {
    const expected = readPhotoMetadata(bytes).gps;
    assert.ok(expected, `${name} has real format-specific GPS metadata`);
    const events = await runPhoto(name, bytes, previous);
    const location = events.find(event => event.location).location;
    assert.equal(location.sailingArea, "Neusiedler See (Österreich)");
    assert.deepEqual({ lat: location.lat, lon: location.lon }, windPoint);
    assert.deepEqual({ lat: location.cityLat, lon: location.cityLon }, expected);
    assert.equal(location.source, "photo");
    assert.equal(events.find(event => event.exifMeta).exifMeta.sailingArea, location.sailingArea);
    if (name.endsWith(".heic")) {
      const preview = Buffer.from(events.find(event => event.exifMeta).exifMeta.thumbnailBase64, "base64");
      assert.equal(preview.subarray(0, 3).toString("hex"), "ffd8ff");
      assert.equal(lastImageUrl, `data:image/jpeg;base64,${preview.toString("base64")}`,
        "vision must receive converted JPEG, never unsupported HEIC bytes");
    } else {
      assert.equal(lastImageUrl, `data:image/webp;base64,${bytes.toString("base64")}`);
    }
  }
  const damaged = Buffer.from(gpsHeic(47.924567891, 16.864567891).subarray(0, 24));
  const callsBeforeDamaged = imageCalls;
  const damagedEvents = await runPhoto("damaged.heic", damaged, undefined, true);
  assert.match(damagedEvents.find(event => event.error).error, /HEIC/);
  assert.equal(imageCalls, callsBeforeDamaged, "unconvertible HEIC must not reach the image model");
} finally {
  globalThis.fetch = originalFetch;
  Messages.prototype.create = originalDetect;
  Completions.prototype.create = originalVision;
  await rm(directory, { recursive: true, force: true });
}
console.log("Photo location regressions passed (gallery/camera GPS, exact coordinates, active-location precedence, missing/invalid/zero GPS, failure fallback and file cleanup).");