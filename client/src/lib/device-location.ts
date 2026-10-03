import { deviceCoordinatesSchema, type DeviceCoordinates } from "@shared/device-location";

export const LOCATION_TIMEOUT_MS = 15000;

export function locationErrorMessage(code?: number): string {
  if (code === 1) return "Standortfreigabe verweigert. Erlaube den Standortzugriff in deinem Browser oder gib den Ort manuell ein.";
  if (code === 3) return "Die Standortsuche hat zu lange gedauert. Bitte versuche es erneut oder gib den Ort manuell ein.";
  return "Dein Standort ist derzeit nicht verfügbar. Bitte versuche es erneut oder gib den Ort manuell ein.";
}

/** An abort also invalidates late callbacks; browsers cannot cancel the GPS call. */
export function requestDevicePosition(
  signal: AbortSignal,
  environment: { secure: boolean; geolocation?: Pick<Geolocation, "getCurrentPosition"> },
  timeoutMs = LOCATION_TIMEOUT_MS,
): Promise<DeviceCoordinates> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Abgebrochen", "AbortError"));
    if (!environment.secure) return reject(new Error("Standortzugriff benötigt eine sichere HTTPS-Verbindung. Bitte öffne die App direkt über ihre HTTPS-Adresse oder gib den Ort manuell ein."));
    if (!environment.geolocation) return reject(new Error("Dein Browser unterstützt keine Standortabfrage. Bitte gib den Ort manuell ein."));
    let settled = false;
    const finish = (coordinates?: DeviceCoordinates, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(coordinates!);
    };
    const abort = () => finish(undefined, new DOMException("Abgebrochen", "AbortError"));
    const timer = setTimeout(() => finish(undefined, new Error(locationErrorMessage(3))), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    try {
      environment.geolocation.getCurrentPosition(
        position => {
          const parsed = deviceCoordinatesSchema.safeParse({
            lat: position.coords.latitude, lon: position.coords.longitude,
          });
          if (!parsed.success) finish(undefined, new Error(locationErrorMessage()));
          else finish(parsed.data);
        },
        error => finish(undefined, new Error(locationErrorMessage(error.code))),
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
      );
    } catch {
      finish(undefined, new Error(locationErrorMessage(1)));
    }
  });
}