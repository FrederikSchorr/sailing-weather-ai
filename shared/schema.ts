import { sql } from "drizzle-orm";
import { pgTable, text, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const geocodeRequestSchema = z.object({
  location: z.string().min(1, "Location is required"),
});

export type GeocodeRequest = z.infer<typeof geocodeRequestSchema>;

export interface GeocodeResult {
  lat: number;
  lon: number;
  displayName: string;
  regionalModel: string;
  regionalModelLabel: string;

  countryCode?: string;
  cityName?: string;
  cityLat?: number;
  cityLon?: number;
  sailingArea?: string | null;
  type?: "sea" | "lake" | null;
  country?: string;
  location?: string;
  userInput?: string;
  source?: "device";
}

export interface WeatherEuropeSSE {
  frontCurrentBase64: string | null;
  frontCurrentUrl: string | null;
  frontCurrentLocalTime: string;
}

export interface WeatherOutputSection {
  source: string;
  text: string | null;
}

export interface WeatherOutputData {
  airPressureMasses: WeatherOutputSection;
  weatherFront: WeatherOutputSection;
  windWaves: WeatherOutputSection;
  cloudsRain: WeatherOutputSection;
}

export type AnalysisJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export interface ForecastHour {
  time: string;
  temp: number;
  rain: number;
  windSpeed: number;
  windGusts: number;
  windDir: number;
  weatherCode: number;
}

export interface ForecastData {
  hours: ForecastHour[];
  timezone: string;
}

export * from "./models/chat";
