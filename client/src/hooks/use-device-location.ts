import { useCallback, useEffect, useRef, useState } from "react";
import type { DeviceCoordinates } from "@shared/device-location";
import { requestDevicePosition } from "@/lib/device-location";

export function useDeviceLocation(
  disabled: boolean,
  onPosition: (coordinates: DeviceCoordinates) => void,
) {
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const latest = useRef({ disabled, onPosition });
  latest.current = { disabled, onPosition };
  const cancel = useCallback(() => {
    const request = pending.current;
    pending.current = null;
    request?.abort();
    setLocating(false);
    setError(null);
  }, []);

  useEffect(() => {
    if (disabled) cancel();
  }, [disabled, cancel]);
  useEffect(() => () => {
    const request = pending.current;
    pending.current = null;
    request?.abort();
  }, []);

  const locate = useCallback(async () => {
    if (latest.current.disabled || pending.current) return;
    const request = new AbortController();
    pending.current = request;
    setError(null);
    setLocating(true);
    try {
      const coordinates = await requestDevicePosition(request.signal, {
        secure: window.isSecureContext,
        geolocation: navigator.geolocation,
      });
      if (pending.current !== request || latest.current.disabled) return;
      pending.current = null;
      setLocating(false);
      latest.current.onPosition(coordinates);
    } catch (failure) {
      if (pending.current !== request) return;
      pending.current = null;
      setLocating(false);
      if (!request.signal.aborted) {
        setError(failure instanceof Error ? failure.message : "Standort nicht verfügbar. Bitte gib den Ort manuell ein.");
      }
    }
  }, []);
  return { locating, error, locate, cancel };
}