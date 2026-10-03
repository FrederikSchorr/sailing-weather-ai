import type { GeocodeResult } from "@shared/schema";
import { deviceCoordinatesSchema, type DeviceCoordinates } from "@shared/device-location";
import { reverseGeocode, getRegionalModelFallback, LAND_TO_COUNTRY_CODE, resolveWindyModel, type DetectLocationResult } from "./location";

/** Device/photo GPS supplies the local point; a recognised area supplies its own wind point. */
export async function resolveDeviceLocation(
  coordinates: DeviceCoordinates,
  signal?: AbortSignal,
  lookup: typeof reverseGeocode = reverseGeocode,
  detect?: (input: string, signal?: AbortSignal) => Promise<DetectLocationResult>,
  source: "device" | "photo" = "device",
): Promise<GeocodeResult> {
  const { lat, lon } = deviceCoordinatesSchema.parse(coordinates);
  const resolved = await lookup(lat, lon, signal);
  signal?.throwIfAborted();
  let detected: DetectLocationResult = null;
  if (detect) {
    try {
      detected = await detect(
        `${source === "photo" ? "Foto-Aufnahmeort" : "Gerätestandort"} bei ${lat}° Breite, ${lon}° Länge. Ortsbezeichnung: ${resolved?.displayName || "unbekannt"}. ` +
        "Ordne nur ein geografisch passendes Segelrevier zu, auch bei Uferorten oder einem Standort auf dem Wasser. " +
        "Bei einem Ort fern eines Segelreviers sailingArea=null. Die GPS-Koordinaten sind maßgeblich, nicht der Mittelpunkt des nächstgelegenen Reviers.",
        signal,
      );
    } catch {
      signal?.throwIfAborted();
      console.warn("Segelrevier-Erkennung für Gerätestandort nicht verfügbar; nutze GPS-Prognose.");
    }
    signal?.throwIfAborted();
  }
  const area = detected?.kind === "revier" ? detected : null;
  const windPoint = area ? area.revier : { lat, lon };
  const regional = area ? resolveWindyModel(area.revier.windyModel) : getRegionalModelFallback(lat, lon);
  const coordinateLabel = `${lat.toFixed(5)}°, ${lon.toFixed(5)}°`;
  const cityName = resolved?.cityName || detected?.city || `${source === "photo" ? "Foto-Standort" : "Aktueller Standort"} (${coordinateLabel})`;
  const countryCode = resolved?.countryCode || area?.countryCode || "";
  return {
    lat: windPoint.lat, lon: windPoint.lon, cityLat: lat, cityLon: lon,
    displayName: resolved?.displayName || cityName,
    cityName,
    countryCode,
    country: Object.entries(LAND_TO_COUNTRY_CODE).find(([, code]) => code === countryCode)?.[0] ?? countryCode,
    regionalModel: area ? regional.model : resolved?.regionalModel ?? regional.model,
    regionalModelLabel: area ? regional.label : resolved?.regionalModelLabel ?? regional.label,
    sailingArea: area?.revier.deutsch ?? null,
    type: area ? area.revier.typ === "meer" ? "sea" : "lake" : null,
    source,
    userInput: source === "photo" ? "Foto-Aufnahmeort" : "Aktueller Gerätestandort",
  };
}