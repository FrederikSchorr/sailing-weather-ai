import type { GeocodeResult } from "@shared/schema";
import { deviceCoordinatesSchema, type DeviceCoordinates } from "@shared/device-location";
import { reverseGeocode, getRegionalModelFallback, LAND_TO_COUNTRY_CODE } from "./location";

/** Reverse lookup supplies labels only; the requested point is never snapped. */
export async function resolveDeviceLocation(
  coordinates: DeviceCoordinates,
  signal?: AbortSignal,
  lookup: typeof reverseGeocode = reverseGeocode,
): Promise<GeocodeResult> {
  const { lat, lon } = deviceCoordinatesSchema.parse(coordinates);
  const resolved = await lookup(lat, lon, signal);
  signal?.throwIfAborted();
  const regional = getRegionalModelFallback(lat, lon);
  const coordinateLabel = `${lat.toFixed(5)}°, ${lon.toFixed(5)}°`;
  const cityName = resolved?.cityName || `Aktueller Standort (${coordinateLabel})`;
  const countryCode = resolved?.countryCode ?? "";
  return {
    lat, lon, cityLat: lat, cityLon: lon,
    displayName: resolved?.displayName || cityName,
    cityName,
    countryCode,
    country: Object.entries(LAND_TO_COUNTRY_CODE).find(([, code]) => code === countryCode)?.[0] ?? countryCode,
    regionalModel: resolved?.regionalModel ?? regional.model,
    regionalModelLabel: resolved?.regionalModelLabel ?? regional.label,
    sailingArea: null,
    type: null,
    source: "device",
    userInput: "Aktueller Gerätestandort",
  };
}