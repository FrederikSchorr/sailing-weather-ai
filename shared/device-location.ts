import { z } from "zod";

export const deviceCoordinatesSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180),
}).strict();

export type DeviceCoordinates = z.infer<typeof deviceCoordinatesSchema>;