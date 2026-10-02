import assert from "node:assert/strict";
import {
  latestCompletedWeatherAnalysis,
  MAX_WEATHER_CHAT_CONTEXT_LENGTH,
  validateWeatherChatContext,
} from "../shared/weather-chat-context";
import { buildWeatherChatUserContent, WEATHER_CHAT_CONTEXT_RULES } from "../server/weather-chat-context";

function analysis(city: string) {
  return {
    meta: { requestDate: "2026-10-02T04:00:00.000Z" },
    position: { userInput: city, country: "Griechenland", countryCode: "GR" },
    sources: { national: ["HNMS"], windy: [], europe: [] },
    weatherRaw: {
      resolvedLocalForecast: {
        timezone: "Europe/Athens",
        sailingArea: {
          hourly: {
            timestamps: ["2026-10-02T09:00", "2026-10-02T12:00"],
            windSpeedKt: [24, 27],
            gustKt: [41, 43],
            windDirDeg: [45, 45],
          },
        },
      },
      chart: { imageBase64: "do-not-send-image-data" },
    },
    weatherPreprocessed: {
      europe: { synopsis: "Großwetterlage" },
      national: { synopsis: "Nationale Wetterlage" },
      local: { warnings: { checked: true, text_de: "Offizielle HNMS-Warnung" } },
    },
    weatherOutput: {
      airPressureMasses: { text: "Druck und Luftmassen" },
      weatherFront: { text: "Fronten" },
      windWaves: { text: "Wind und Welle 24–41 kt" },
      cloudsRain: { text: "Wetter und Regen" },
    },
  };
}

const older = analysis("Meganisi");
const latest = analysis("Skiathos");
const messages = [
  { id: "old", role: "assistant" },
  { id: "last", role: "assistant" },
  { id: "question", role: "user" },
  { id: "reply", role: "assistant" },
  { id: "pending", role: "assistant" },
];
const selected = latestCompletedWeatherAnalysis(
  messages,
  { old: older, last: latest, pending: analysis("Lefkada") },
  { old: older.weatherOutput, last: latest.weatherOutput },
);
assert.equal((selected?.position as any).userInput, "Skiathos");
assert.doesNotMatch(JSON.stringify(selected), /Base64|do-not-send-image-data/);
assert.deepEqual((selected?.weatherRaw as any).resolvedLocalForecast.sailingArea.hourly.gustKt, [41, 43]);
assert.deepEqual(selected?.weatherOutput, latest.weatherOutput);
assert.equal(latestCompletedWeatherAnalysis(messages, {}, {}), null);

const restored = JSON.parse(JSON.stringify(selected));
assert.deepEqual(
  latestCompletedWeatherAnalysis(
    [{ id: "restored", role: "assistant" }],
    { restored },
    { restored: restored.weatherOutput },
  ),
  selected,
  "restored analysis must retain the same complete chat context",
);
assert.equal(
  (latestCompletedWeatherAnalysis(
    [...messages, { id: "new", role: "assistant" }],
    { last: latest, new: older },
    { last: latest.weatherOutput, new: older.weatherOutput },
  )?.position as any).userInput,
  "Meganisi",
  "a new completed analysis replaces the previous chat context",
);

const content = buildWeatherChatUserContent("Wie stark ist der Wind?", selected);
assert.match(content, /Skiathos/);
assert.match(content, /24–41 kt/);
assert.match(content, /Offizielle HNMS-Warnung/);
assert.match(content, /windSpeedKt/);
assert.match(content, /Meltemi/);
assert.match(content, /regionalWindSystems/);
assert.doesNotMatch(content, /Base64|do-not-send-image-data|Meganisi/);
assert.ok(content.endsWith("Aktuelle Frage:\nWie stark ist der Wind?"));
assert.match(WEATHER_CHAT_CONTEXT_RULES, /keine Live-Messungen/);
assert.throws(() => validateWeatherChatContext({}), /Ungültiger/);
assert.throws(
  () => validateWeatherChatContext({ ...latest, weatherOutput: { windWaves: { text: "Nur Wind" } } }),
  /Ungültiger/,
);
assert.throws(
  () => validateWeatherChatContext({ ...latest, extra: "x".repeat(MAX_WEATHER_CHAT_CONTEXT_LENGTH) }),
  /zu groß/,
);
console.log("weather chat context: all checks passed");