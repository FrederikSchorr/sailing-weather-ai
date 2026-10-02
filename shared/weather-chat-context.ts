import { z } from "zod";

export const MAX_WEATHER_CHAT_CONTEXT_LENGTH = 256_000;
const sectionNames = ["airPressureMasses", "weatherFront", "windWaves", "cloudsRain"] as const;
const section = z.object({ text: z.string().trim().min(1) }).passthrough();

const analysisSchema = z.object({
  meta: z.object({ requestDate: z.string().datetime() }).passthrough(),
  position: z.object({
    userInput: z.string(),
    country: z.string(),
  }).passthrough(),
  sources: z.record(z.unknown()),
  weatherRaw: z.record(z.unknown()),
  weatherPreprocessed: z.object({
    europe: z.record(z.unknown()),
    national: z.record(z.unknown()),
    local: z.record(z.unknown()),
  }).passthrough(),
  weatherOutput: z.object({
    airPressureMasses: section,
    weatherFront: section,
    windWaves: section,
    cloudsRain: section,
  }).passthrough(),
}).passthrough();

/** Keep all text and forecast data, but never send embedded image binaries to chat. */
export function withoutAnalysisImages(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value, (key, entry) =>
    /base64$/i.test(key) ? undefined : entry,
  ));
}

export function validateWeatherChatContext(value: unknown) {
  if (JSON.stringify(value)?.length > MAX_WEATHER_CHAT_CONTEXT_LENGTH) {
    throw new Error("Wetteranalyse für den Chat zu groß. Bitte eine neue Analyse erstellen.");
  }
  const result = analysisSchema.safeParse(value);
  if (!result.success) {
    throw new Error("Ungültiger Wetteranalyse-Kontext.");
  }
  return withoutAnalysisImages(result.data) as typeof result.data;
}

export function latestCompletedWeatherAnalysis(
  messages: ReadonlyArray<{ id: string; role: string }>,
  analyses: Record<string, Record<string, unknown>>,
  outputs: Record<string, unknown>,
): Record<string, unknown> | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const analysis = analyses[message.id];
    const output = outputs[message.id] as Record<string, { text?: unknown }> | undefined;
    if (!analysis || !output || !sectionNames.every(name =>
      typeof output[name]?.text === "string" && (output[name].text as string).trim(),
    )) continue;
    return withoutAnalysisImages({ ...analysis, weatherOutput: output });
  }
  return null;
}