import React from "react";
import { LoaderCircle, LocateFixed } from "lucide-react";
import { Button } from "@/components/ui/button";

interface DeviceLocationControlProps {
  locating: boolean;
  disabled: boolean;
  error: string | null;
  onLocate: () => void;
  onCancel: () => void;
}

export function DeviceLocationControl({
  locating,
  disabled,
  error,
  onLocate,
  onCancel,
}: DeviceLocationControlProps) {
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      onClick={locating ? onCancel : onLocate}
      disabled={!locating && disabled}
      aria-describedby={error ? "device-location-error" : locating ? "device-location-status" : undefined}
      aria-label={
        locating
          ? "Standortsuche abbrechen"
          : "Aktuellen Standort verwenden"
      }
      title={
        locating
          ? "Standortsuche abbrechen"
          : "Aktuellen Standort verwenden"
      }
      data-testid="button-location"
      className="h-11 w-11 min-h-11 min-w-11 shrink-0"
    >
      {locating ? (
        <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        <LocateFixed className="h-4 w-4" aria-hidden="true" />
      )}
    </Button>
  );
}

interface DeviceLocationFeedbackProps {
  locating: boolean;
  error: string | null;
}

export function DeviceLocationFeedback({
  locating,
  error,
}: DeviceLocationFeedbackProps) {
  if (locating) {
    return (
      <p id="device-location-status" role="status" className="text-sm text-muted-foreground">
        Standort wird ermittelt…
      </p>
    );
  }

  if (error) {
    return (
      <p id="device-location-error" role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  }

  return null;
}