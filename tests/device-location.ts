import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { deviceCoordinatesSchema } from "../shared/device-location";
import { resolveDeviceLocation } from "../server/device-location";
import { requestDevicePosition } from "../client/src/lib/device-location";
import { DeviceLocationControl, DeviceLocationFeedback } from "../client/src/components/device-location-control";
import type { reverseGeocode, RevierResult } from "../server/location";
import sailingAreas from "../data/sailingareas.json";

for (const coordinates of [{ lat: 0, lon: 0 }, { lat: -90, lon: 180 }, { lat: 90, lon: -180 }]) {
  assert.ok(deviceCoordinatesSchema.safeParse(coordinates).success);
}
for (const value of [null, {}, { lat: "48", lon: 16 }, { lat: 91, lon: 16 },
  { lat: 48, lon: -181 }, { lat: NaN, lon: 16 }, { lat: 0, lon: Infinity },
  { lat: 0, lon: 0, unwanted: true }]) {
  assert.equal(deviceCoordinatesSchema.safeParse(value).success, false);
}

const exact = { lat: 48.201234567, lon: 16.378765432 };
const lookup: typeof reverseGeocode = async (lat, lon) => {
  assert.deepEqual({ lat, lon }, exact);
  return { lat: 48, lon: 16, cityName: "Wien", displayName: "Wien, Österreich",
    countryCode: "AT", regionalModel: "iconEu", regionalModelLabel: "ICON" };
};
const location = await resolveDeviceLocation(exact, undefined, lookup);
assert.deepEqual({ lat: location.lat, lon: location.lon }, exact);
assert.deepEqual({ lat: location.cityLat, lon: location.cityLon }, exact);
assert.equal(location.sailingArea, null);
assert.equal(location.source, "device");
assert.equal(location.cityName, "Wien");
const weidenPoint = { lat: 47.924567891, lon: 16.864567891 };
const lake: RevierResult = {
  kind: "revier", land: "Österreich", countryCode: "AT", city: "Neusiedl am See",
  revier: sailingAreas["Österreich"].reviere.find(r => r.deutsch === "Neusiedler See (Österreich)")! as RevierResult["revier"],
};
const weidenLookup: typeof reverseGeocode = async () => ({
  lat: 47.9, lon: 16.8, cityName: "Weiden am See", displayName: "Weiden am See, Österreich",
  countryCode: "AT", regionalModel: "iconEu", regionalModelLabel: "ICON",
});
const lakeLocation = await resolveDeviceLocation(weidenPoint, undefined, weidenLookup, async input => {
  assert.match(input, /Weiden am See/);
  assert.ok(input.includes(String(weidenPoint.lat)) && input.includes(String(weidenPoint.lon)));
  return lake;
});
assert.equal(lakeLocation.sailingArea, lake.revier.deutsch);
assert.equal(lakeLocation.type, "lake");
assert.equal(lakeLocation.regionalModel, "czeAladin");
assert.equal(lakeLocation.cityName, "Weiden am See", "detector must not replace the device town");
assert.deepEqual({ lat: lakeLocation.lat, lon: lakeLocation.lon }, { lat: lake.revier.lat, lon: lake.revier.lon });
assert.deepEqual({ lat: lakeLocation.cityLat, lon: lakeLocation.cityLon }, weidenPoint);
assert.notDeepEqual({ lat: lakeLocation.lat, lon: lakeLocation.lon }, weidenPoint,
  "recognising a sailing area must separate its wind point from the local GPS point");
const photoLocation = await resolveDeviceLocation(weidenPoint, undefined, weidenLookup, async () => lake, "photo");
assert.deepEqual({ lat: photoLocation.lat, lon: photoLocation.lon }, { lat: lake.revier.lat, lon: lake.revier.lon },
  "photo-derived locations use the same sailing-area point as device and text entry");
assert.deepEqual({ lat: photoLocation.cityLat, lon: photoLocation.cityLon }, weidenPoint,
  "the photo's local point must remain its exact original recording coordinates");
const cityOnly = await resolveDeviceLocation(exact, undefined, lookup, async () => ({ kind: "city", city: "Wien" }));
assert.equal(cityOnly.sailingArea, null, "a city outside an area remains a GPS forecast");
const detectionFailure = await resolveDeviceLocation(exact, undefined, lookup, async () => { throw new Error("unavailable"); });
assert.equal(detectionFailure.sailingArea, null);
assert.deepEqual({ lat: detectionFailure.lat, lon: detectionFailure.lon }, exact);
const sea = await resolveDeviceLocation(weidenPoint, undefined, async () => null, async () => ({
  ...lake, countryCode: "HR", land: "Kroatien", city: "Punat",
  revier: { ...lake.revier, deutsch: "Kvarner", typ: "meer", windyModel: "iconEu" },
}));
assert.equal(sea.type, "sea");
assert.equal(sea.countryCode, "HR");
assert.equal(sea.cityName, "Punat");
assert.deepEqual({ lat: sea.lat, lon: sea.lon }, { lat: lake.revier.lat, lon: lake.revier.lon });
assert.deepEqual({ lat: sea.cityLat, lon: sea.cityLon }, weidenPoint);
const offshore = await resolveDeviceLocation({ lat: 0, lon: 0 }, undefined, async () => null);
assert.equal(offshore.lat, 0);
assert.equal(offshore.lon, 0);
assert.match(offshore.cityName!, /Aktueller Standort/);
assert.equal(offshore.countryCode, "");
assert.equal(offshore.regionalModel, "gfs");
const stopped = new AbortController();
stopped.abort();
await assert.rejects(resolveDeviceLocation(exact, stopped.signal, lookup), { name: "AbortError" });
const stopDetection = new AbortController();
await assert.rejects(resolveDeviceLocation(exact, stopDetection.signal, lookup, async () => {
  stopDetection.abort();
  throw new DOMException("Abgebrochen", "AbortError");
}), { name: "AbortError" });

function fakeLocation() {
  let success: PositionCallback | undefined;
  let failure: PositionErrorCallback | undefined;
  let options: PositionOptions | undefined;
  let calls = 0;
  return {
    geolocation: { getCurrentPosition(ok: PositionCallback, fail?: PositionErrorCallback | null, config?: PositionOptions) {
      calls++; success = ok; failure = fail ?? undefined; options = config;
    } },
    get calls() { return calls; },
    get options() { return options; },
    succeed(lat = exact.lat, lon = exact.lon) {
      success!({ coords: { latitude: lat, longitude: lon } } as GeolocationPosition);
    },
    fail(code: number) { failure!({ code } as GeolocationPositionError); },
  };
}
{
  const fake = fakeLocation();
  const request = requestDevicePosition(new AbortController().signal, { secure: true, geolocation: fake.geolocation });
  assert.equal(fake.calls, 1);
  assert.deepEqual(fake.options, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  fake.succeed();
  assert.deepEqual(await request, exact);
  fake.succeed(0, 0); // Duplicate browser callback cannot settle a second time.
}
for (const [code, message] of [[1, /verweigert/], [2, /nicht verfügbar/], [3, /zu lange/]] as const) {
  const fake = fakeLocation();
  const request = requestDevicePosition(new AbortController().signal, { secure: true, geolocation: fake.geolocation });
  fake.fail(code);
  await assert.rejects(request, message);
}
{
  const fake = fakeLocation();
  const abort = new AbortController();
  const request = requestDevicePosition(abort.signal, { secure: true, geolocation: fake.geolocation });
  const rejection = assert.rejects(request, { name: "AbortError" });
  abort.abort();
  fake.succeed(); // Late device result after cancellation must be ignored.
  await rejection;
}
{
  const fake = fakeLocation();
  await assert.rejects(requestDevicePosition(new AbortController().signal, { secure: true, geolocation: fake.geolocation }, 5), /zu lange/);
  fake.succeed();
}
{
  const fake = fakeLocation();
  const request = requestDevicePosition(new AbortController().signal, { secure: true, geolocation: fake.geolocation });
  fake.succeed(NaN);
  await assert.rejects(request, /nicht verfügbar/);
}
await assert.rejects(requestDevicePosition(new AbortController().signal, { secure: false }), /HTTPS/);
await assert.rejects(requestDevicePosition(new AbortController().signal, { secure: true }), /unterstützt keine/);

const props = { locating: false, disabled: false, error: null, onLocate() {}, onCancel() {} };
const ready = renderToStaticMarkup(createElement(DeviceLocationControl, props));
assert.match(ready, /Aktuellen Standort verwenden/);
assert.match(ready, /button-location/);
assert.match(ready, /min-w-11/);
const busy = renderToStaticMarkup(createElement(DeviceLocationControl, { ...props, locating: true }));
assert.match(busy, /Standortsuche abbrechen/);
assert.doesNotMatch(busy, /disabled=""/);
assert.match(renderToStaticMarkup(createElement(DeviceLocationControl, { ...props, disabled: true })), /disabled=""/);
assert.match(renderToStaticMarkup(createElement(DeviceLocationFeedback, { locating: true, error: null })), /role="status"/);
assert.match(renderToStaticMarkup(createElement(DeviceLocationFeedback, { locating: false, error: "Fehler" })), /role="alert"/);
console.log("Device location tests passed (validation, exact position, zero/offshore fallback, browser errors, cancellation, timeout and controls).");