import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { deviceCoordinatesSchema } from "../shared/device-location";
import { resolveDeviceLocation } from "../server/device-location";
import { requestDevicePosition } from "../client/src/lib/device-location";
import { DeviceLocationControl, DeviceLocationFeedback } from "../client/src/components/device-location-control";
import type { reverseGeocode } from "../server/location";

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
const offshore = await resolveDeviceLocation({ lat: 0, lon: 0 }, undefined, async () => null);
assert.equal(offshore.lat, 0);
assert.equal(offshore.lon, 0);
assert.match(offshore.cityName!, /Aktueller Standort/);
assert.equal(offshore.countryCode, "");
assert.equal(offshore.regionalModel, "gfs");
const stopped = new AbortController();
stopped.abort();
await assert.rejects(resolveDeviceLocation(exact, stopped.signal, lookup), { name: "AbortError" });

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