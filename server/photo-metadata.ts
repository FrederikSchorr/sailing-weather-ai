import ExifReader from "exifreader";
import { deviceCoordinatesSchema, type DeviceCoordinates } from "@shared/device-location";

/** Read original bytes before conversion: JPEG conversion deliberately drops EXIF. */
export function readPhotoMetadata(buffer: Buffer): {
  gps: DeviceCoordinates | null;
  time: string | null;
} {
  try {
    const tags = ExifReader.load(buffer, { expanded: true });
    const coordinates = deviceCoordinatesSchema.safeParse({
      lat: tags.gps?.Latitude,
      lon: tags.gps?.Longitude,
    });
    const recordedAt = tags.exif?.DateTimeOriginal?.description;
    return {
      gps: coordinates.success ? coordinates.data : null,
      time: typeof recordedAt === "string" && /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}/.test(recordedAt)
        ? recordedAt : null,
    };
  } catch {
    // Missing or malformed optional metadata must never block image analysis.
    return { gps: null, time: null };
  }
}