/**
 * Deterministic regression coverage for the local sailing forecast pipeline.
 *
 * Run with: npm run test:weather
 */

import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  fetchNationalWeather,
  preprocessLocalWeather,
} from "../server/weather-national.js";
import {
  buildSection4WeatherContext,
  preprocessOpenMeteoLocal,
  classifyCloudType,
  estimateCloudBaseM,
} from "../server/weather-open-meteo.js";
import {
  enforceSection4Output,
  enforceWindForecastDatePrefixes,
  ensureSection4Icons,
  ensureWarningFirst,
  ensureWindForecastIcons,
  generateWeatherOutput,
  buildWindScaffold,
  combineWindAndGustMentions,
  containsPastTodayContent,
  diagnoseWindForecast,
  hasValidWindValueFormat,
  hasForbiddenSection4Content,
  hasTwoSubstantiveBullets,
  hasConciseWindInterpretation,
  normalizeCurrentHourTodayStart,
  normalizeCalmThresholdMentions,
  normalizeWindDirectionMentions,
  normalizeWindPairSeparators,
  normalizeWindUnits,
  normalizeSection1Icons,
  normalizeSection2Icons,
  restoreWindGustRanges,
  stripRedundantGustMentions,
  stripRedundantWindRangeMentions,
  stripStrongestGustMentions,
  softenGustyDescriptions,
} from "../server/weather-output.js";
import {
  getSanitizedAnalysisExport,
  type AnalysisJson,
} from "../server/analysis-store.js";
import {
  classifyStandaloneSeaArea,
  resolveSailingAreaAlias,
} from "../server/location.js";
import {
  HNMS_BULLETIN_URL,
  isValidGreeceWarningTranslation,
} from "../server/weather-national-greece.js";
import { extractDhmzWarning } from "../server/weather-national-croatia.js";
import { resolveLocalForecast } from "../server/weather-local-forecast.js";
import CityMeteogram, { cloudBaseTone, cloudTypeColor, extractCityMeteogram, formatCloudBase, temperatureColor } from "../client/src/components/city-meteogram";
import SeaWindForecast, { extractSeaWindForecast } from "../client/src/components/sea-wind-forecast";

const REAL_DATE = globalThis.Date;
const FIXED_NOW = "2026-08-22T09:00:00.000Z";
const AREA = {
  name_de: "Testrevier",
  type: "lake" as const,
  coordinates: { lat: 47.8, lon: 16.75 },
};
const CITY = {
  name_de: "Teststadt",
  coordinates: { lat: 47.95, lon: 16.84 },
};

type MockResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<Record<string, unknown>>;
};

function response(body: unknown, status = 200): MockResponse {
  const isText = typeof body === "string";
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => isText ? body as string : JSON.stringify(body),
    json: async () => isText ? JSON.parse(body as string) : body as Record<string, unknown>,
  };
}

function withFixedDate<T>(callback: () => Promise<T>): Promise<T> {
  const DateConstructor = REAL_DATE;
  class FixedDate extends DateConstructor {
    constructor(...args: any[]) {
      super(...(args.length ? args : [FIXED_NOW]) as [any]);
    }

    static now(): number {
      return DateConstructor.parse(FIXED_NOW);
    }
  }
  globalThis.Date = FixedDate as unknown as DateConstructor;
  return callback().finally(() => {
    globalThis.Date = DateConstructor;
  });
}

function hourlyPayload(
  coordinates: { lat: number; lon: number },
  fields: "full" | "temperature" = "full",
): Record<string, unknown> {
  const start = new REAL_DATE(FIXED_NOW);
  const timestamps = Array.from({ length: 144 }, (_, index) =>
    new REAL_DATE(start.getTime() + index * 60 * 60 * 1000).toISOString(),
  );
  const hourly: Record<string, unknown[]> = {
    time: timestamps,
    temperature_2m: timestamps.map((_, index) => 18 + (index % 12)),
  };
  if (fields === "full") {
    hourly.is_day = timestamps.map((_, index) => index % 2);
    hourly.precipitation_probability = timestamps.map(() => 10);
    hourly.rain = timestamps.map(() => 0);
    hourly.weather_code = timestamps.map(() => 1);
    hourly.cloud_cover = timestamps.map((_, index) => index % 2 ? 35 : 25);
    hourly.wind_speed_10m = timestamps.map((_, index) => 8 + (index % 4));
    hourly.wind_direction_10m = timestamps.map(() => 292);
    hourly.wind_gusts_10m = timestamps.map((_, index) => 12 + (index % 4));
    hourly.cape = timestamps.map(() => 0);
  }
  return {
    timezone: "Europe/Vienna",
    latitude: coordinates.lat,
    longitude: coordinates.lon,
    hourly_units: {},
    hourly,
  };
}

function marinePayload(
  coordinates: { lat: number; lon: number },
  withWaves: boolean,
): Record<string, unknown> {
  const timestamps = Array.from({ length: 144 }, (_, index) =>
    new REAL_DATE(new REAL_DATE(FIXED_NOW).getTime() + index * 60 * 60 * 1000).toISOString(),
  );
  const waveValues = timestamps.map(() => withWaves ? 0.8 : null);
  return {
    timezone: "Europe/Vienna",
    latitude: coordinates.lat,
    longitude: coordinates.lon,
    hourly: {
      time: timestamps,
      wave_height: waveValues,
      wave_direction: timestamps.map(() => 270),
      wave_period: timestamps.map(() => 4),
      wind_wave_height: waveValues,
      wind_wave_direction: timestamps.map(() => 270),
      wind_wave_period: timestamps.map(() => 4),
      swell_wave_height: waveValues,
      swell_wave_direction: timestamps.map(() => 270),
      swell_wave_period: timestamps.map(() => 4),
    },
  };
}

function anthropicStub(): Anthropic {
  return {
    messages: {
      create: async (request: any) => {
        const prompt = String(request.messages?.[0]?.content ?? "");
        if (prompt.includes("Windverlauf")) return { content: [{ type: "text", text: "Nationale Winddetails" }] };
        if (prompt.includes("Bewölkung und Niederschlag")) return { content: [{ type: "text", text: "Nationale Wolken- und Regendetails" }] };
        if (prompt.includes("Windprognose für sechs Tage")) {
          return { content: [{ type: "text", text: sixDayText("Windtag") }] };
        }
        if (prompt.includes("Beschreibe NUR die vorherrschende Seegangsstärke")) {
          return { content: [{ type: "text", text: "Sa 22.08.: See 3 leicht bewegt\nSo 23.08.: See 3 leicht bewegt" }] };
        }
        if (prompt.includes("Bewölkung, Niederschlag und Gewitterrisiko")) {
          return { content: [{ type: "text", text: sixDayText("Wettertag") }] };
        }
        return { content: [{ type: "text", text: "NONE" }] };
      },
    },
  } as unknown as Anthropic;
}

function sixDayText(prefix: string): string {
  return [
    "Sa 22.08.: " + prefix + " 1",
    "So 23.08.: " + prefix + " 2",
    "Mo 24.08.: " + prefix + " 3",
    "Di 25.08.: " + prefix + " 4",
    "Mi 26.08.: " + prefix + " 5",
    "Do 27.08.: " + prefix + " 6",
  ].join("\n");
}

function installFetch(
  resolver: (url: string) => MockResponse,
): { calls: string[]; restore: () => void } {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return resolver(url) as unknown as Response;
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function openMeteoResponse(url: string, withWaves = false): MockResponse {
  const parsed = new URL(url);
  const coordinates = {
    lat: Number(parsed.searchParams.get("latitude")),
    lon: Number(parsed.searchParams.get("longitude")),
  };
  if (url.startsWith("https://marine-api.open-meteo.com")) {
    return response(marinePayload(coordinates, withWaves));
  }
  const fields = parsed.searchParams.get("hourly") === "temperature_2m"
    ? "temperature"
    : "full";
  return response(hourlyPayload(coordinates, fields));
}

async function testNationalCoverageAndPrecedence(): Promise<void> {
  const mock = installFetch((url) => {
    if (url === HNMS_BULLETIN_URL) return response("", 404);
    if (url.includes("austrocontrol.at")) {
      return response("<html>FXOS1 WETTERLAGE: sonnig. WETTERABLAUF FXOS2 WETTERLAGE: trocken. WETTERABLAUF</html>");
    }
    if (url.includes("geosphere.at") && url.includes("parameters=t2m")) {
      return response({
        timestamps: Array.from({ length: 48 }, (_, index) => new REAL_DATE(new REAL_DATE(FIXED_NOW).getTime() + index * 3600000).toISOString()),
        features: [{ properties: { parameters: { t2m: { data: Array.from({ length: 48 }, () => 22) } } } }],
      });
    }
    if (url.includes("geosphere.at")) {
      return response({
        timestamps: Array.from({ length: 48 }, (_, index) => new REAL_DATE(new REAL_DATE(FIXED_NOW).getTime() + index * 3600000).toISOString()),
        features: [{ properties: { parameters: {
          u10m: { data: Array.from({ length: 48 }, () => -4) },
          v10m: { data: Array.from({ length: 48 }, () => -4) },
          ugust: { data: Array.from({ length: 48 }, () => -7) },
          vgust: { data: Array.from({ length: 48 }, () => -7) },
          tcc: { data: Array.from({ length: 48 }, () => 0.4) },
          rr_acc: { data: Array.from({ length: 48 }, () => 0) },
        } } }],
      });
    }
    if (url.includes("lsz-b.at")) return response("<title>Windwarnung<br />Böen am See</title>");
    return openMeteoResponse(url, false);
  });

  try {
    const national = await fetchNationalWeather(
      "AT",
      AREA.coordinates,
      "Neusiedler See (Österreich)",
      { ...AREA, name_de: "Neusiedler See (Österreich)" },
      CITY,
    );
    const forecastSources = national.sourceUrls.filter((source) => source.includes("Open-Meteo Forecast API"));
    assert.equal(forecastSources.length, 2, "Open-Meteo Forecast must be attributed once for area wind and once for city temperature/pressure/clouds/rain");
    assert.equal(national.sourceUrls.some((source) => source.includes("Marine API")), false, "inland marine data must not be cited");
    assert.equal(national.warningCenter.status, "integrated");
    assert.equal(national.warningCenter.label, "LSZ Burgenland");
    assert.ok(national.sourceUrls.some((source) => source.includes("GeoSphere Austria")));
    assert.ok(national.sourceUrls.some((source) => source.includes("LSZ Burgenland")));
    assert.deepEqual(
      (national.data.openMeteoForecast as any).city.hourly.isDay.slice(0, 4),
      [0, 1, 0, 1],
      "Open-Meteo is_day values must reach the city meteogram unchanged",
    );

    const local = await preprocessLocalWeather(
      national.data,
      { userInput: "Neusiedler See", city: CITY.name_de, sailingArea: "Neusiedler See (Österreich)" },
      anthropicStub(),
      "AT",
    );
    assert.match((local.wind as any).source, /GeoSphere Austria.*Open-Meteo Forecast API/);
    assert.equal("nationalWind" in local, false, "resolved structured wind should replace the parallel national wind summary");
    assert.equal((local.nationalCloudRain as any).text_de, "Nationale Wolken- und Regendetails");
    assert.deepEqual(
      (local.nationalCloudRain as any).coordinates,
      CITY.coordinates,
      "national cloud/rain data must use city coordinates",
    );
    const geoSphereCalls = mock.calls.filter((url) => url.includes("geosphere.at"));
    assert.ok(
      geoSphereCalls.some((url) => url.includes(`lat_lon=${AREA.coordinates.lat},${AREA.coordinates.lon}`)),
      "national wind must stay on sailing-area coordinates",
    );
    assert.ok(
      geoSphereCalls.some((url) => url.includes(`lat_lon=${CITY.coordinates.lat},${CITY.coordinates.lon}`)),
      "national cloud/rain must be fetched on city coordinates",
    );
    assert.match((local.warnings as any).text_de, /Starkwindwarnung/);
    assert.equal((local.wave as any).text_de, null, "absent lake waves must stay silent");
    assert.equal((local.wind as any).text_de.split("\n").length, 6, "national areas keep all six baseline days");
    assert.equal(mock.calls.filter((url) => url.startsWith("https://api.open-meteo.com/v1/forecast")).length, 2);
    const cityForecastCall = mock.calls.find((url) =>
      url.startsWith("https://api.open-meteo.com/v1/forecast")
      && url.includes(`latitude=${CITY.coordinates.lat}`),
    );
    assert.ok(cityForecastCall?.includes("cloud_cover_low"), "city forecast must request aggregate low cloud cover");
    assert.ok(cityForecastCall?.includes("cloud_cover_mid"), "city forecast must request aggregate middle cloud cover");
    assert.ok(cityForecastCall?.includes("cloud_cover_high"), "city forecast must request aggregate high cloud cover");
    assert.ok(!cityForecastCall?.includes("cloud_cover_550hPa"), "city forecast must not request unused pressure-level cloud data");
    assert.ok(!cityForecastCall?.includes("geopotential_height_"), "city forecast must not request unused geopotential-height data");
  } finally {
    mock.restore();
  }
}

async function testUnsupportedAreaCoverage(): Promise<void> {
  const mock = installFetch((url) => openMeteoResponse(url, false));
  try {
    const national = await fetchNationalWeather(
      "IT",
      { lat: 42.0, lon: 12.0 },
      null,
      null,
      { name_de: "Rom", coordinates: { lat: 41.9, lon: 12.5 } },
    );
    assert.deepEqual(national.warningCenter, { status: "unsupported", label: "Italien" });
    assert.equal(national.sourceUrls.filter((source) => source.includes("Open-Meteo Forecast API")).length, 2);
    assert.equal(national.sourceUrls.some((source) => source.includes("Marine API")), false);
    const local = preprocessOpenMeteoLocal(national.data, "Europe/Rome");
    assert.equal((local.wind as any).text_de.split("\n").length, 6);
    assert.equal((local.cloudRainThunderstorm as any).text_de.split("\n").length, 6);
    assert.deepEqual(
      (local.cloudRainThunderstorm as any).coordinates,
      { lat: 41.9, lon: 12.5 },
      "cloud/rain summary must carry city coordinates, never sailing-area coordinates",
    );
    assert.equal((local.cloudRainThunderstorm as any).city, "Rom");
    assert.equal((local.wave as any).text_de, null);
  } finally {
    mock.restore();
  }
}

async function testFailedNationalProvidersStayTransparent(): Promise<void> {
  const mock = installFetch((url) => {
    if (url.includes("austrocontrol.at") || url.includes("geosphere.at") || url.includes("lsz-b.at")) {
      return response("", 503);
    }
    return openMeteoResponse(url, false);
  });
  try {
    const national = await fetchNationalWeather(
      "AT",
      AREA.coordinates,
      "Neusiedler See (Österreich)",
      { ...AREA, name_de: "Neusiedler See (Österreich)" },
      CITY,
    );
    assert.equal(national.warningCenter.status, "unavailable");
    assert.equal(national.sourceUrls.some((source) => source.includes("Austrocontrol")), false);
    assert.equal(national.sourceUrls.some((source) => source.includes("GeoSphere Austria")), false);
    assert.equal(national.sourceUrls.some((source) => source.includes("LSZ Burgenland")), false);
    assert.equal(national.sourceUrls.filter((source) => source.includes("Open-Meteo Forecast API")).length, 2);

    const local = await preprocessLocalWeather(
      national.data,
      { userInput: "Neusiedler See", city: CITY.name_de, sailingArea: "Neusiedler See (Österreich)" },
      anthropicStub(),
      "AT",
    );
    assert.equal((local.warnings as any).text_de, null);
    assert.equal((local.wind as any).text_de.split("\n").length, 6);
  } finally {
    mock.restore();
  }
}

function testIonianOffshoreAliases(): void {
  for (const input of ["Ionisches Meer", "Ionisches Meer Nord"]) {
    const resolved = resolveSailingAreaAlias(input);
    assert.equal(resolved?.kind, "revier");
    if (resolved?.kind !== "revier") continue;
    assert.equal(resolved.revier.deutsch, "Ionisches Meer Nord Offshore (Griechenland)");
    assert.equal(resolved.revier.lat, 38.8);
    assert.equal(resolved.revier.lon, 19.252);
    assert.equal(resolved.city, "Lefkada");
    const westwardDistanceNm =
      (20 - resolved.revier.lon) * 60 * Math.cos(resolved.revier.lat * Math.PI / 180);
    assert.ok(
      Math.abs(westwardDistanceNm - 35) < 0.05,
      `${input} must resolve about 35 nm west of the former longitude`,
    );
  }
}

function testStandaloneSeaAreaClassification(): void {
  for (const input of [
    "Ionisches Meer",
    "Ionisches Meer Nord",
    "Ionisches Meer Nord Offshore (Griechenland)",
    "Adria Mitte",
  ]) {
    assert.equal(
      classifyStandaloneSeaArea(input)?.type,
      "ANALYSE",
      `standalone sea area "${input}" must start a weather analysis`,
    );
  }
  for (const input of [
    "Typische Windsysteme im Ionischen Meer",
    "Welche Windsysteme gibt es im Ionischen Meer?",
    "Ionisches Meer typische Windsysteme",
  ]) {
    assert.equal(
      classifyStandaloneSeaArea(input),
      null,
      `sea-area question "${input}" must remain available to chat classification`,
    );
  }
}

async function testHnmsFailureIsNotAllClear(): Promise<void> {
  const mock = installFetch((url) => {
    if (url === HNMS_BULLETIN_URL) return response("", 503);
    return openMeteoResponse(url, true);
  });
  try {
    const national = await fetchNationalWeather(
      "GR",
      { lat: 38.8, lon: 20 },
      "Ionisches Meer Nord (Griechenland)",
      { name_de: "Ionisches Meer Nord (Griechenland)", type: "sea", coordinates: { lat: 38.8, lon: 20 } },
      { name_de: "Lefkada", coordinates: { lat: 38.83, lon: 20.71 } },
    );
    assert.equal(national.warningCenter.status, "unavailable");
    assert.equal(national.sourceUrls.some((source) => source.includes("HNMS")), false);
    assert.equal(national.sourceUrls.filter((source) => source.includes("Open-Meteo Forecast API")).length, 2);
    assert.equal(national.sourceUrls.filter((source) => source.includes("Open-Meteo Marine API")).length, 1);

    const local = await preprocessLocalWeather(
      national.data,
      { userInput: "Lefkada", city: "Lefkada", sailingArea: "Ionisches Meer Nord (Griechenland)" },
      anthropicStub(),
      "GR",
    );
    assert.equal((local.warnings as any).text_de, null);
    assert.doesNotMatch(JSON.stringify(local.warnings), /Keine Sturmwarnung/);
    assert.match((local.wind as any).text_de, /Do 27\.08\./);
    assert.match(
      (local.wind as any).hourlyText_de,
      /(?:Mo|Di|Mi|Do|Fr|Sa|So) \d{1,2}\.\d{2} \| \d{2}:00 \| (?:N|NO|O|SO|S|SW|W|NW) \| \d+ \| \d+/,
      "Greek preprocessing must preserve the canonical hourly wind/gust table",
    );
    assert.equal((local.wave as any).text_de, "Sa 22.08.: See 3 leicht bewegt\nSo 23.08.: See 3 leicht bewegt");

    let interpretationPrompt = "";
    const outputAnthropic = {
      messages: {
        create: async (request: any) => {
          interpretationPrompt = (request.messages?.[0]?.content ?? [])
            .filter((block: any) => block.type === "text")
            .map((block: any) => block.text)
            .join("\n");
          return {
            content: [{
              type: "text",
              text: [
                "===airPressureMasses===",
                "- 🌀 Hochdruck.",
                "- 🧭 Warme Luft.",
                "===weatherFront===",
                "- 🔵 Keine aktive Kalt- oder Warmfront.",
                "- 🧭 Keine relevante Front.",
                "===windWaves===",
                "- Heute: 💨 NW 10–15 kt.",
                "- Morgen: 💨 NW 10–15 kt.",
                "- Übermorgen: 💨 Mäßiger NW-Wind.",
                "- Di–Do 25.–27.08.: 💨 Mäßiger Wind.",
                "===cloudsRain===",
                "- Heute: ☀️ Stabil.",
                "- Morgen: ☀️ Trocken.",
                "- Mo–Do 24.–27.08.: ☀️ Ruhig.",
                "===END===",
              ].join("\n"),
            }],
          };
        },
      },
    } as unknown as Anthropic;
    await generateWeatherOutput({
      meta: {
        app: "aiWindy",
        version: "test",
        website: "",
        github: "",
        copyright: "",
        requestDate: FIXED_NOW,
      },
      position: {
        userInput: "Lefkada",
        country: "Griechenland",
        countryCode: "GR",
        windyModel: "ECMWF",
        sailingArea: {
          name_de: "Ionisches Meer Nord (Griechenland)",
          type: "sea",
          coordinates: { lat: 38.8, lon: 20 },
        },
        city: {
          name_de: "Lefkada",
          coordinates: { lat: 38.83, lon: 20.71 },
        },
      },
      sources: {
        windy: [],
        national: [],
        europe: [],
        nationalWarningCenter: national.warningCenter,
      },
      weatherRaw: national.data,
      weatherPreprocessed: { europe: {}, national: {}, local },
      weatherOutput: {},
    }, outputAnthropic);
    assert.match(
      interpretationPrompt,
      /=== LOKALER STÜNDLICHER WIND ===\nDatum \| Uhrzeit \| Richtung \| Wind_kt \| Böe_kt\n(?:Mo|Di|Mi|Do|Fr|Sa|So) \d{1,2}\.\d{2}/,
      "the Greek interpretation prompt must receive the canonical hourly table",
    );
  } finally {
    mock.restore();
  }
}

async function testCroatiaEmptyAndFallbackWarnings(): Promise<void> {
  let warningTranslationCalls = 0;
  const anthropic = {
    messages: {
      create: async (request: any) => {
        const prompt = String(request.messages?.[0]?.content ?? "");
        if (prompt.includes("Translate the following Croatian maritime warning")) {
          warningTranslationCalls++;
          return { content: [{ type: "text", text: "Auf der nördlichen Adria Bora-Böen 35–45 kt." }] };
        }
        if (prompt.includes("extract only the forecast section")) {
          return { content: [{ type: "text", text: "Lokaler Seewetterbericht." }] };
        }
        return { content: [{ type: "text", text: "NONE" }] };
      },
    },
  } as unknown as Anthropic;

  const emptyRegional = [
    "<Prognoza_pomorci>",
    "<Naslov>VREMENSKO IZVJEŠĆE, dan 30.08.2026 u 12:00 sati</Naslov>",
    "<Upozorenje>   </Upozorenje>",
    "</Prognoza_pomorci>",
  ].join("");
  const noWarningAdria = "<Upozorenje><Upozorenje_tekst>Nema.</Upozorenje_tekst></Upozorenje>";
  assert.equal(
    await extractDhmzWarning(emptyRegional, "Adria Nord (Kroatien)", anthropic),
    null,
    "an empty DHMZ warning element must not be sent to the translator",
  );
  const clearLocal = await preprocessLocalWeather(
    {
      croatiaAdriaRegional: { xml: emptyRegional },
      croatiaAdriaForecast: { xml: noWarningAdria },
    },
    { userInput: "Punat", city: "Punat", sailingArea: "Adria Nord (Kroatien)" },
    anthropic,
    "HR",
  );
  assert.equal((clearLocal.warnings as any).checked, true);
  assert.equal((clearLocal.warnings as any).text_de, "Aktuell: Keine Sturmwarnung von DHMZ");
  assert.equal(warningTranslationCalls, 0, "explicit DHMZ all-clear fields must not invoke warning translation");

  const activeAdria = "<Upozorenje><Upozorenje_tekst>Na sjevernom Jadranu udari bure 35-45 čvorova.</Upozorenje_tekst></Upozorenje>";
  const activeLocal = await preprocessLocalWeather(
    {
      croatiaAdriaRegional: { xml: emptyRegional },
      croatiaAdriaForecast: { xml: activeAdria },
    },
    { userInput: "Punat", city: "Punat", sailingArea: "Adria Nord (Kroatien)" },
    anthropic,
    "HR",
  );
  assert.equal((activeLocal.warnings as any).checked, true);
  assert.match((activeLocal.warnings as any).text_de, /Bora-Böen 35–45 kt/);
  assert.equal(warningTranslationCalls, 1, "an active warning in the alternate DHMZ feed must be preserved");
}

function testCloudTypeClassification(): void {
  const base = {
    totalPct: 0, lowPct: 0, midPct: 0, highPct: 0,
    capeJkg: 0, weatherCode: 1, rainMm: 0,
  };
  assert.equal(classifyCloudType({ ...base, totalPct: 5 }), "clear", "near-zero cover reads as clear");
  assert.equal(
    classifyCloudType({ ...base, weatherCode: 95, totalPct: 80, lowPct: 50, highPct: 50 }),
    "cumulonimbus",
    "explicit thunderstorm code always wins",
  );
  assert.equal(
    classifyCloudType({ ...base, totalPct: 70, lowPct: 40, highPct: 40, capeJkg: 1200 }),
    "cumulonimbus",
    "tall convective column (low+high cover, high CAPE) without a weather code",
  );
  assert.equal(
    classifyCloudType({ ...base, totalPct: 30, lowPct: 30, midPct: 10, capeJkg: 700 }),
    "cumulus",
    "growing convective cloud with real CAPE but not yet a full storm",
  );
  assert.equal(
    classifyCloudType({ ...base, totalPct: 90, lowPct: 80, capeJkg: 50, rainMm: 2 }),
    "stratus",
    "widespread low deck with steady rain and little instability",
  );
  assert.equal(
    classifyCloudType({ ...base, totalPct: 30, lowPct: 30, capeJkg: 100 }),
    "cumulus",
    "fair-weather cumulus: modest low cover, clear aloft, no rain",
  );
  assert.equal(
    classifyCloudType({ ...base, totalPct: 60, midPct: 60 }),
    "altostratus",
    "mid-level-dominant deck",
  );
  assert.equal(
    classifyCloudType({ ...base, totalPct: 30, highPct: 30 }),
    "cirrus",
    "high-only thin cover",
  );
  assert.equal(
    classifyCloudType({ ...base, totalPct: 50, lowPct: 25, midPct: 25, highPct: 25 }),
    "mixed",
    "cover spread across levels without a clear dominant pattern falls back to mixed",
  );
}

function testSection4DevelopmentSignals(): void {
  const timestamps = [
    "2026-08-22T09:00:00",
    "2026-08-22T12:00:00",
    "2026-08-22T15:00:00",
    "2026-08-22T18:00:00",
    "2026-08-23T06:00:00",
    "2026-08-23T12:00:00",
    "2026-08-23T18:00:00",
    "2026-08-24T12:00:00",
    "2026-08-25T12:00:00",
    "2026-08-26T12:00:00",
    "2026-08-27T12:00:00",
  ];
  const rawData = {
    openMeteoForecast: {
      city: {
        name: "Teststadt",
        coordinates: { lat: 47.95, lon: 16.84 },
        hourly: {
          timestamps,
          temp2mC: [30, 29, 24, 22, 20, 25, 21, 23, 24, 22, 21],
          pressureMslHPa: [1018, 1014, 1011, 1010, 1011, 1014, 1016, 1017, 1018, 1019, 1020],
          rainMm: [0, 5, 1, 0, 0, 0.2, 0, 0, 0, 0, 0],
          precipProbabilityPct: [10, 90, 70, 20, 10, 30, 10, 5, 5, 5, 5],
          cloudCoverPct: [20, 90, 80, 40, 20, 50, 30, 20, 10, 20, 10],
          weatherCode: [1, 63, 95, 2, 1, 51, 1, 1, 0, 1, 0],
          cloudType: [
            "cumulus",
            "stratus",
            "mixed",
            "cumulus",
            "clear",
            "stratus",
            "cumulus",
            "cumulus",
            "clear",
            "cumulus",
            "clear",
          ],
          capeJkg: new Array(timestamps.length).fill(5000),
        },
      },
    },
  };

  const context = buildSection4WeatherContext(
    rawData,
    "Europe/Vienna",
    new REAL_DATE("2026-08-22T07:00:00.000Z"),
  ) as any;
  assert.ok(context, "structured section-4 context should be available");
  assert.equal(context.days.length, 6, "section 4 should cover all six forecast days");

  const today = context.days[0];
  assert.equal(today.detailLevel, "granular");
  assert.equal(today.summary.pressure.changeHPa, -8);
  assert.equal(today.summary.pressure.significant, true);
  assert.deepEqual(today.summary.pressure.steepestDrop, {
    from: "09:00",
    to: "12:00",
    change: -4,
  });
  assert.equal(today.summary.rain.totalMm, 6);
  assert.deepEqual(today.summary.rain.periods, [{
    period: "12:00–15:00",
    totalMm: 6,
    peakMm: 5,
  }]);
  assert.deepEqual(today.summary.temperature.steepestDrop, {
    from: "12:00",
    to: "15:00",
    change: -5,
  });
  assert.deepEqual(today.summary.thunderstorm, {
    signal: true,
    times: ["15:00"],
  });
  assert.ok(Array.isArray(today.timeline), "today should retain the granular timeline");
  assert.ok(Array.isArray(context.days[1].timeline), "tomorrow should retain a reduced timeline");
  assert.equal(context.days[2].timeline, undefined, "later days should only expose trend summaries");
  assert.doesNotMatch(
    JSON.stringify(context),
    /cape/i,
    "raw CAPE must not reach the section-4 interpretation context",
  );
  assert.doesNotMatch(
    JSON.stringify(context),
    /cloudCover/i,
    "cloud-cover percentages must not reach the section-4 interpretation context",
  );

  const capeOnlyRaw = structuredClone(rawData) as any;
  capeOnlyRaw.openMeteoForecast.city.hourly.weatherCode.fill(1);
  capeOnlyRaw.openMeteoForecast.city.hourly.cloudType.fill("cumulus");
  const capeOnly = buildSection4WeatherContext(
    capeOnlyRaw,
    "Europe/Vienna",
    new REAL_DATE("2026-08-22T07:00:00.000Z"),
  ) as any;
  assert.equal(
    capeOnly.days[0].summary.thunderstorm.signal,
    false,
    "high CAPE without a weather-code or cumulonimbus signal must not create thunderstorm risk",
  );

  const minorPressureRaw = structuredClone(capeOnlyRaw) as any;
  minorPressureRaw.openMeteoForecast.city.hourly.pressureMslHPa.splice(
    0,
    4,
    1016,
    1015,
    1014,
    1015,
  );
  const minorPressure = buildSection4WeatherContext(
    minorPressureRaw,
    "Europe/Vienna",
    new REAL_DATE("2026-08-22T07:00:00.000Z"),
  ) as any;
  assert.equal(
    minorPressure.days[0].summary.pressure.significant,
    false,
    "a two-hectopascal daily fluctuation must not be treated as a notable pressure signal",
  );

  const local = preprocessOpenMeteoLocal(capeOnlyRaw, "Europe/Vienna") as any;
  assert.match(
    local.cloudRainThunderstorm.text_de,
    /kein Gewitterrisiko/,
    "the generic local summary must use the same evidence rule as the meteogram",
  );
}

function testWindPeakTimingContext(): void {
  const timestamps = Array.from({ length: 24 }, (_, hour) =>
    `2026-08-23T${String(hour).padStart(2, "0")}:00`,
  );
  const gustKt = Array.from({ length: 24 }, () => 8);
  gustKt[12] = 27;
  gustKt[20] = 12;
  const local = preprocessOpenMeteoLocal({
    resolvedLocalForecast: {
      sailingArea: {
        name: "Testrevier",
        source: "Lokaler Anbieter",
        hourly: {
          timestamps,
          windSpeedKt: timestamps.map((_, hour) => hour === 12 ? 20 : 5),
          gustKt,
          windDirDeg: timestamps.map(() => 337.5),
        },
      },
    },
  }, "Europe/Vienna") as any;

  assert.match(
    local.wind.text_de,
    /12:00 N Wind 20-27 kt/,
    "the strongest gust hour must be included among the daily wind samples",
  );
  assert.match(
    local.wind.text_de,
    /Wind 5–20 kt/,
    "the section 3 context should expose the sustained wind range",
  );
  assert.doesNotMatch(local.wind.text_de, /Böen\s+\d/);
  assert.doesNotMatch(
    local.wind.text_de,
    /stärkste Böe|exakt um 12:00|mittags/,
    "the section 3 context should not repeat the exact strongest-gust time",
  );
  assert.equal(
    stripStrongestGustMentions("- Heute: Böen 12–25 kt (stärkste Böe 25 kt nachts um 23:00 aus SW)."),
    "- Heute: Böen 12–25 kt.",
    "generated wind text should keep the gust range without repeating the peak time",
  );
  assert.equal(
    stripRedundantGustMentions("- Heute: NO Wind 12–25 kt; Böen 4–25 kt."),
    "- Heute: NO Wind 12–25 kt.",
    "generated wind text should not repeat ordinary gusts separately",
  );
  assert.equal(
    combineWindAndGustMentions("- Heute: S 3 kn, Böen 6 kn."),
    "- Heute: S 3–6 kn.",
    "separate wind and gust values should be combined",
  );
  assert.equal(
    restoreWindGustRanges(
      "- Heute (Mo 31.08.): 💨 Meltemi NW 23 kt.",
      "Mo 31.08.: 18:00 NW Wind 23-32 kt; Wind 23–25 kt.",
    ),
    "- Heute (Mo 31.08.): 💨 Meltemi NW 23–32 kt.",
    "a missing gust should be restored from the matching local wind pair",
  );
  assert.equal(
    stripRedundantGustMentions("- Heute: S 3 kn, Böen 6 kn."),
    "- Heute: S 3 kn.",
    "an unpaired gust mention in knots should be removed",
  );
  assert.equal(
    stripRedundantGustMentions("- Morgen: kräftige Westströmung; NW-Böen nachmittags bis 22 kt."),
    "- Morgen: kräftige Westströmung.",
    "direction-prefixed gust clauses should also be removed",
  );
  assert.equal(
    stripRedundantWindRangeMentions("- Morgen: W Wind 6–21 kt, tagsüber nachmittags bis zu 21 kt."),
    "- Morgen: W Wind 6–21 kt.",
    "a repeated maximum wind clause should be removed",
  );
  assert.equal(
    stripRedundantWindRangeMentions("- Morgen: W Wind 6–21 kt, abends bis zu 24 kt."),
    "- Morgen: W Wind 6–21 kt, abends bis zu 24 kt.",
    "a changed later maximum should be retained",
  );
  assert.equal(
    softenGustyDescriptions("- Heute: ungewöhnlich böig; Morgen: ungewöhnlich böige Entwicklung."),
    "- Heute: böig; Morgen: böige Entwicklung.",
    "overstated gust wording should be softened",
  );

  const twoGustyDays = preprocessOpenMeteoLocal({
    resolvedLocalForecast: {
      sailingArea: {
        name: "Testrevier",
        source: "Lokaler Anbieter",
        hourly: {
          timestamps: Array.from({ length: 48 }, (_, index) => {
            const day = index < 24 ? "23" : "24";
            const hour = index % 24;
            return `2026-08-${day}T${String(hour).padStart(2, "0")}:00`;
          }),
          windSpeedKt: Array.from({ length: 48 }, () => 6),
          gustKt: Array.from({ length: 48 }, () => 20),
          windDirDeg: Array.from({ length: 48 }, () => 270),
        },
      },
    },
  }, "Europe/Vienna") as any;
  assert.equal(
    (twoGustyDays.wind.text_de.match(/; böig/g) ?? []).length,
    1,
    "at most one clearly gusty day should be highlighted in the wind context",
  );
  assert.doesNotMatch(twoGustyDays.wind.text_de, /ungewöhnlich böig/i);
}

async function testInterpretationPromptContract(): Promise<void> {
  let capturedRequest: any = null;
  let callCount = 0;
  const anthropic = {
    messages: {
      create: async (request: any) => {
        callCount++;
        capturedRequest = request;
        return {
          content: [{
            type: "text",
            text: [
              "===airPressureMasses===",
              "- 🌀 Hochdruck über Mitteleuropa.",
              "- 🧭 Warme, trockene Luftmasse.",
              "===weatherFront===",
              "- 🔵 Keine aktive Kalt- oder Warmfront.",
              "- 🧭 Nächste Front westlich des Zielorts.",
              "===windWaves===",
              "- Heute: 💨 NW 23–32 kt.",
              "- Morgen: 💨 NW 18–26 kt.",
              "- Übermorgen: 💨 Nachlassender NW-Wind.",
              "- Di–Do 25.–27.08.: 💨 Überwiegend mäßiger Wind.",
              "===cloudsRain===",
              "- Heute: ☀️ Stabil.",
              "- Morgen: ☀️ Trocken.",
              "- Mo–Do 24.–27.08.: ☀️ Ruhiges Wetter.",
              "===END===",
            ].join("\n"),
          }],
        };
      },
    },
  } as unknown as Anthropic;
  const analysis = {
    meta: {
      app: "aiWindy",
      version: "test",
      website: "",
      github: "",
      copyright: "",
      requestDate: FIXED_NOW,
    },
    position: {
      userInput: "Testrevier",
      country: "Kroatien",
      countryCode: "HR",
      windyModel: "ECMWF",
      sailingArea: {
        name_de: "Testrevier",
        type: "sea",
        coordinates: { lat: 44, lon: 15 },
      },
      city: {
        name_de: "Teststadt",
        coordinates: { lat: 44, lon: 15 },
      },
    },
    sources: {
      windy: [],
      national: [],
      europe: [],
      nationalWarningCenter: { status: "unsupported" },
    },
    weatherRaw: {},
    weatherPreprocessed: {
      europe: { generalWeather: { text_de: "Hochdruck über Mitteleuropa." } },
      national: { synopsis: { text_de: "Stabile Wetterlage." } },
      local: {
        wind: {
          text_de: "Sa 22.08.: 12:00 NW Wind 23-32 kt.",
          hourlyText_de: "2026-08-22 | 12:00 | NW | 23 | 32",
        },
        wave: { text_de: "Sa 22.08.: See 2 schwach bewegt." },
      },
    },
    weatherOutput: {},
  } as AnalysisJson;

  const output = await generateWeatherOutput(analysis, anthropic);

  assert.equal(callCount, 1, "all four interpretation sections must use one LLM call");
  assert.equal(
    (output.airPressureMasses as any).text,
    "- 🌀 Hochdruck über Mitteleuropa.\n- 🌡️ Warme, trockene Luftmasse.",
    "section 1 should use understandable semantic icons instead of colored status circles",
  );
  assert.match(
    (output.weatherFront as any).text,
    /^- 🌍 .+\n- 📍 .+$/,
    "section 2 should distinguish large-scale and local fronts with semantic icons",
  );
  const prompt = (capturedRequest?.messages?.[0]?.content ?? [])
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("\n");
  assert.match(prompt, /Datum \| Uhrzeit \| Richtung \| Wind_kt \| Böe_kt/);
  assert.match(prompt, /2026-08-22 \| 12:00 \| NW \| 23 \| 32/);
  assert.match(prompt, /VERBINDLICHES WIND-GERÜST/);
  assert.match(prompt, /Heute \(Sa 22\.08\.\), maximal 2 Paare: NW 23–32 kt \(12:00\)/);
  assert.match(prompt, /numerisch nur die dort vorgeschlagenen Wind–Böe-Paare/);
  assert.match(
    prompt,
    /Richtungsangaben ausschließlich als genau eines dieser acht Kürzel schreiben: N, NO, O, SO, S, SW, W oder NW/,
  );
  assert.match(prompt, /Niemals Zwischenrichtungen wie NNW, WNW oder SSO/);
  assert.match(prompt, /jede numerische Windstärke hat ausnahmslos genau zwei Werte/i);
  for (const section of [
    "ABSCHNITT 1: airPressureMasses",
    "ABSCHNITT 2: weatherFront",
    "ABSCHNITT 3: windWaves",
    "ABSCHNITT 4: cloudsRain",
  ]) {
    assert.equal(
      (prompt.match(new RegExp(section, "g")) ?? []).length,
      1,
      `${section} should have exactly one consolidated rule block`,
    );
  }
  assert.match(prompt, /Abschnitt 1 enthält genau 2 Bullets/);
  assert.match(prompt, /Bullet 1 beginnt mit 🌀/);
  assert.match(prompt, /Bullet 2 beginnt mit 🌡️/);
  assert.match(prompt, /Keine farbigen Kreise \(🔵, 🟠, 🔴\)/);
  assert.match(prompt, /Abschnitt 2 genau 2/);
  assert.match(prompt, /muss genannt werden; keinen anderen Zielort nennen/);
  assert.match(prompt, /Abschnitt 4 genau 3/);
  assert.match(prompt, /Genau 4 Prognosebullets/);
  assert.match(prompt, /insgesamt höchstens 5 Bullets/);

  const retryRequests: any[] = [];
  const retryResponses = [
    [
      "===airPressureMasses===",
      "- 🌀 Unverändertes Hochdruckgebiet.",
      "- 🌡️ Unveränderte warme Luftmasse.",
      "===weatherFront===",
      "- 🌍 Unveränderte Kaltfront über Europa.",
      "- 📍 Testrevier bleibt frontfrei.",
      "===windWaves===",
      "- Heute: Bestes Windfenster mit NW 23–32 kt.",
      "- Morgen: Nutzbares Windfenster mit NW 18–26 kt.",
      "- Übermorgen: Flaute, Windprognose nicht verfügbar.",
      "- Di–Do 25.–27.08.: Ruhiger Trend ohne verfügbare Windprognose.",
      "===cloudsRain===",
      "- Heute: NW 10–20 kt.",
      "===END===",
    ].join("\n"),
    [
      "===airPressureMasses===",
      "- 🌀 Dieser gültige Abschnitt darf nicht überschrieben werden.",
      "- 🌡️ Auch dann nicht, wenn das Modell ihn ungefragt mitsendet.",
      "===cloudsRain===",
      "- Heute: ☀️ Stabil und trocken.",
      "- Morgen: ☀️ Weiterhin trocken.",
      "- Mo–Do 24.–27.08.: ☀️ Ruhiges Hochdruckwetter.",
      "===END===",
    ].join("\n"),
  ];
  const retryAnthropic = {
    messages: {
      create: async (request: any) => {
        retryRequests.push(request);
        return { content: [{ type: "text", text: retryResponses[retryRequests.length - 1] }] };
      },
    },
  } as unknown as Anthropic;
  const correctedOutput = await generateWeatherOutput(analysis, retryAnthropic);
  assert.equal(retryRequests.length, 2, "one failed section should require one targeted correction");
  const correctionPrompt = retryRequests[1].messages[2].content as string;
  assert.match(correctionPrompt, /ausschließlich diese Abschnitte: cloudsRain/);
  assert.doesNotMatch(correctionPrompt, /ausschließlich diese Abschnitte:.*windWaves/);
  assert.equal(
    (correctedOutput.airPressureMasses as any).text,
    "- 🌀 Unverändertes Hochdruckgebiet.\n- 🌡️ Unveränderte warme Luftmasse.",
    "valid sections must survive a targeted correction unchanged",
  );

  const lineRetryRequests: any[] = [];
  const lineRetryResponses = [
    [
      "===airPressureMasses===",
      "- 🌀 Stabiles Hochdruckgebiet.",
      "- 🌡️ Warme, trockene Luftmasse.",
      "===weatherFront===",
      "- 🌍 Kaltfront weit nördlich.",
      "- 📍 Testrevier bleibt frontfrei.",
      "===windWaves===",
      "- Heute: Bestes Fenster mit NW 23–32 kt.",
      "- Morgen: Ruhiger Segeltag mit NW 18–26 kt.",
      "- Übermorgen: Erst NW 8–14 kt, dann W 12–20 kt, später SW 6–11 kt.",
      "- Di–Do 25.–27.08.: Di NW 8–14 kt; Mi W 7–12 kt; Do SW 6–11 kt.",
      "===cloudsRain===",
      "- Heute: ☀️ Stabil und trocken.",
      "- Morgen: ☀️ Weiterhin trocken.",
      "- Mo–Do 24.–27.08.: ☀️ Ruhiges Hochdruckwetter.",
      "===END===",
    ].join("\n"),
    [
      "===windWaves===",
      "- Heute: Dieser gültige Text darf nicht übernommen werden, NW 20–30 kt.",
      "- Morgen: Auch dieser gültige Text bleibt unverändert, NW 20–30 kt.",
      "- Übermorgen: Markanter Dreher mit kurzem Segelfenster; repräsentativ W 12–20 kt.",
      "- Di–Do 25.–27.08.: Dieser gültige Ausblick bleibt unverändert; Di N 9–15 kt.",
      "===END===",
    ].join("\n"),
  ];
  const lineRetryAnthropic = {
    messages: {
      create: async (request: any) => {
        lineRetryRequests.push(request);
        return { content: [{ type: "text", text: lineRetryResponses[lineRetryRequests.length - 1] }] };
      },
    },
  } as unknown as Anthropic;
  const lineCorrectedOutput = await generateWeatherOutput(analysis, lineRetryAnthropic);
  assert.equal(lineRetryRequests.length, 2);
  const lineCorrectionPrompt = lineRetryRequests[1].messages[2].content as string;
  assert.match(lineCorrectionPrompt, /Übermorgen-Zeile enthält 3 Wind–Böe-Paare, erlaubt sind 1/);
  assert.match(lineCorrectionPrompt, /ändere ausschließlich die Übermorgen-Zeile/);
  const lineCorrectedWind = (lineCorrectedOutput.windWaves as any).text as string;
  assert.match(lineCorrectedWind, /Heute \(Sa 22\.08\.\): 💨 Bestes Fenster mit NW 23–32 kt/);
  assert.match(lineCorrectedWind, /Morgen \(So 23\.08\.\): 💨 Ruhiger Segeltag mit NW 18–26 kt/);
  assert.match(lineCorrectedWind, /Übermorgen \(Mo 24\.08\.\): 💨 Markanter Dreher/);
  assert.match(lineCorrectedWind, /Di–Do 25\.–27\.08\.: 💨 Di NW 8–14 kt; Mi W 7–12 kt; Do SW 6–11 kt/);
  assert.doesNotMatch(lineCorrectedWind, /Dieser gültige Text|Auch dieser gültige Text|Dieser gültige Ausblick/);

  const structuralRetryResponses = [
    [
      "===airPressureMasses===",
      "- 🌀 Stabiles Hochdruckgebiet.",
      "- 🌡️ Warme, trockene Luftmasse.",
      "===weatherFront===",
      "- 🌍 Kaltfront weit nördlich.",
      "- 📍 Testrevier bleibt frontfrei.",
      "===windWaves===",
      "- Heute: Bestes Fenster mit NW 23–32 kt.",
      "- Morgen: Ruhiger Segeltag mit NW 18–26 kt.",
      "- Übermorgen: Diese Zeile enthält irrtümlich bereits den Mehrtagesausblick.",
      "===cloudsRain===",
      "- Heute: ☀️ Stabil und trocken.",
      "- Morgen: ☀️ Weiterhin trocken.",
      "- Mo–Do 24.–27.08.: ☀️ Ruhiges Hochdruckwetter.",
      "===END===",
    ].join("\n"),
    [
      "===windWaves===",
      "- Heute: Bestes Fenster mit NW 23–32 kt.",
      "- Morgen: 💨",
      "- Übermorgen: Markanter Dreher mit W 12–20 kt.",
      "- Di–Do 25.–27.08.: Di NW 8–14 kt; Mi W 7–12 kt; Do SW 6–11 kt.",
      "===END===",
    ].join("\n"),
  ];
  const structuralRetryRequests: any[] = [];
  const structuralRetryAnthropic = {
    messages: {
      create: async (request: any) => {
        structuralRetryRequests.push(request);
        return {
          content: [{
            type: "text",
            text: structuralRetryResponses[structuralRetryRequests.length - 1],
          }],
        };
      },
    },
  } as unknown as Anthropic;
  const structuralOutput = await generateWeatherOutput(analysis, structuralRetryAnthropic);
  assert.equal(structuralRetryRequests.length, 2);
  assert.match(
    structuralRetryRequests[1].messages[2].content as string,
    /ändere ausschließlich die Heute-Zeile, die Morgen-Zeile, die Übermorgen-Zeile, die Mehrtages-Zeile/,
    "an incomplete wind structure must request all four forecast lines",
  );
  assert.match(
    (structuralOutput.windWaves as any).text,
    /Di–Do 25\.–27\.08\.: 💨 Di NW 8–14 kt; Mi W 7–12 kt; Do SW 6–11 kt/,
  );
  assert.match(
    (structuralOutput.windWaves as any).text,
    /Morgen \(So 23\.08\.\): 💨 Ruhiger Segeltag mit NW 18–26 kt/,
    "an empty correction line must not overwrite a substantive previous forecast line",
  );

  const windLabels = {
    todayLabel: "Sa 22.08.",
    tomorrowLabel: "So 23.08.",
    dayAfterTomorrowLabel: "Mo 24.08.",
    forecastTailLabel: "Di–Do 25.–27.08.",
  };
  const iconizedWind = ensureWindForecastIcons(
    enforceWindForecastDatePrefixes(
      [
        "- Heute Sa 22.08.: NW 10–15 kt; See 2 schwach bewegt.",
        "- Morgen So 23.08.: NW 10–15 kt; See 2 schwach bewegt.",
        "- Übermorgen Mo 24.08.: Nachlassender NW-Wind.",
        "- Di–Do 25.–27.08.: Überwiegend mäßiger Wind.",
      ].join("\n"),
      windLabels,
    ),
    windLabels,
    true,
  ) ?? "";
  assert.match(iconizedWind, /Heute \(Sa 22\.08\.\): 💨 NW 10–15 kt; 🌊 See 2/);
  assert.match(iconizedWind, /Morgen \(So 23\.08\.\): 💨 NW 10–15 kt; 🌊 See 2/);
  assert.match(iconizedWind, /Übermorgen \(Mo 24\.08\.\): 💨/);
  assert.match(iconizedWind, /Di–Do 25\.–27\.08\.: 💨/);

  const windWithoutWaveData = ensureWindForecastIcons(
    enforceWindForecastDatePrefixes(
      [
        "- Heute Sa 22.08.: NW 10–15 kt; für Seegangsdaten liegen keine lokalen Wellendaten vor.",
        "- Morgen So 23.08.: NW 10–15 kt; See 2 schwach bewegt.",
        "- Übermorgen Mo 24.08.: Nachlassender NW-Wind.",
        "- Di–Do 25.–27.08.: Überwiegend mäßiger Wind.",
      ].join("\n"),
      windLabels,
    ),
    windLabels,
    false,
  ) ?? "";
  assert.doesNotMatch(
    windWithoutWaveData,
    /🌊|See(?:gang)?|Wellen?|Wellendaten|Seegangsdaten/i,
    "missing wave data must be ignored instead of shown as a warning or placeholder",
  );
  assert.match(windWithoutWaveData, /Heute \(Sa 22\.08\.\): 💨 NW 10–15 kt/);
  assert.match(windWithoutWaveData, /Morgen \(So 23\.08\.\): 💨 NW 10–15 kt/);

  const calendarPrefixedWind = enforceWindForecastDatePrefixes(
    [
      "Sa 22.08.: NW 10–15 kt.",
      "So 23.08.: W 8–12 kt.",
      "Mo 24.08.: W 6–9 kt.",
      "Di–Do 25.–27.08.: SW 12–18 kt.",
    ].join("\n"),
    windLabels,
  ) ?? "";
  assert.match(calendarPrefixedWind, /^- Heute \(Sa 22\.08\.\): NW 10–15 kt\.$/m);
  assert.match(calendarPrefixedWind, /^- Morgen \(So 23\.08\.\): W 8–12 kt\.$/m);
  assert.match(calendarPrefixedWind, /^- Übermorgen \(Mo 24\.08\.\): W 6–9 kt\.$/m);
  assert.match(calendarPrefixedWind, /^- Di–Do 25\.–27\.08\.: SW 12–18 kt\.$/m);

  const mixedRelativeAndCalendarWind = enforceWindForecastDatePrefixes(
    [
      "- Heute (Do 03.09.): Ab 20:00 Uhr SW 6–14 kt.",
      "- Fr 04.09.: O 9–13 kt.",
      "- Sa 05.09.: W 10–17 kt.",
      "- So–Di 06.–08.09.: Wechselnde Richtungen.",
    ].join("\n"),
    {
      todayLabel: "Do 03.09.",
      tomorrowLabel: "Fr 04.09.",
      dayAfterTomorrowLabel: "Sa 05.09.",
      forecastTailLabel: "So–Di 06.–08.09.",
    },
  ) ?? "";
  assert.match(mixedRelativeAndCalendarWind, /^- Heute \(Do 03\.09\.\): Ab 20:00 Uhr/m);
  assert.match(mixedRelativeAndCalendarWind, /^- Morgen \(Fr 04\.09\.\): O 9–13 kt\.$/m);
  assert.match(mixedRelativeAndCalendarWind, /^- Übermorgen \(Sa 05\.09\.\): W 10–17 kt\.$/m);
  assert.match(mixedRelativeAndCalendarWind, /^- So–Di 06\.–08\.09\.: Wechselnde Richtungen\.$/m);
  assert.equal(
    (mixedRelativeAndCalendarWind.match(/\bHeute\b/g) ?? []).length,
    1,
    "a relative Today line must advance the fallback calendar prefix index",
  );

  const parentheticalTodayWind = enforceWindForecastDatePrefixes(
    [
      "- Do 03.09. (ab jetzt): NW 14–20 kt.",
      "- Fr 04.09.: N 4–9 kt.",
      "- Sa 05.09.: S 4–12 kt.",
      "- So–Di 06.–08.09.: W 3–7 kt.",
    ].join("\n"),
    {
      todayLabel: "Do 03.09.",
      tomorrowLabel: "Fr 04.09.",
      dayAfterTomorrowLabel: "Sa 05.09.",
      forecastTailLabel: "So–Di 06.–08.09.",
    },
  ) ?? "";
  assert.match(parentheticalTodayWind, /^- Heute \(Do 03\.09\.\): \(ab jetzt\): NW 14–20 kt\.$/m);
  assert.match(parentheticalTodayWind, /^- So–Di 06\.–08\.09\.: W 3–7 kt\.$/m);

  assert.equal(
    containsPastTodayContent(
      "- Heute (Do 03.09.): Nachmittags W 8–12 kt; ab 20:00 Uhr SW 6–14 kt.",
      19,
      38,
    ),
    true,
    "an evening forecast must reject already completed afternoon content",
  );
  assert.equal(
    containsPastTodayContent(
      "- Heute (Do 03.09.): Ab 20:00 Uhr SW 6–14 kt; nachts auf NO drehend.",
      19,
      38,
    ),
    false,
    "an evening forecast may contain only upcoming hours and the coming night",
  );
  assert.equal(
    containsPastTodayContent(
      "- Heute (Do 03.09.): Ab 19:00 Uhr SW 6–14 kt.",
      19,
      38,
    ),
    true,
    "an exact time earlier than the analysis instant must be rejected",
  );

}

function testSection4OutputContract(): void {
  const output = enforceSection4Output(
    [
      "- Heute: 🌧️ gegen 12:00 Uhr kräftiger Regen.",
      "- Morgen: ⛈️ Gewittersignal gegen 23:00 Uhr.",
      "- Di–Fr 24.–27.08.: ☀️ Stabilisierung.",
      "- Zusätzlicher unerlaubter Bullet.",
    ].join("\n"),
    {
      todayLabel: "Sa 22.08.",
      tomorrowLabel: "So 23.08.",
      forecastOverviewLabel: "Mo–Do 24.–27.08.",
    },
  );
  assert.ok(output);
  const bullets = output.split("\n");
  assert.equal(bullets.length, 3, "section 4 must contain exactly three bullets");
  assert.match(bullets[0], /^- Heute \(Sa 22\.08\.\):/);
  assert.match(bullets[0], /: 🌧️ /);
  assert.match(bullets[1], /^- Morgen \(So 23\.08\.\):/);
  assert.match(bullets[1], /: ⛈️ /);
  assert.match(bullets[1], /nachts/, "tomorrow's exact clock time should become a broad day period");
  assert.doesNotMatch(bullets[1], /\d{1,2}:\d{2}\s*Uhr/, "tomorrow must not contain exact clock times");
  assert.match(bullets[2], /^- Mo–Do 24\.–27\.08\.:/);
  assert.match(bullets[2], /: ☀️ /);

  const eveningOutput = enforceSection4Output(
    [
      "- Do 03.09. ab 20:50 Uhr: 🌤️ Wolken lockern rasch auf.",
      "- Fr 04.09.: ☀️ Sonnig und trocken.",
      "- Sa–Di 05.–08.09.: ☀️ Stabiles Hochdruckwetter.",
    ].join("\n"),
    {
      todayLabel: "Do 03.09.",
      tomorrowLabel: "Fr 04.09.",
      forecastOverviewLabel: "Sa–Di 05.–08.09.",
    },
  ) ?? "";
  assert.match(eveningOutput, /^- Heute \(Do 03\.09\.\): .*ab 20:50 Uhr:/m);
  assert.doesNotMatch(
    eveningOutput,
    /^- Heute \([^)]*\):\s*(?:(?:☀️|⛅|☁️|🌥️|🌤️|🌧️|🌦️|⛈️|❄️|🌫️)\s*)?50 Uhr:/mu,
    "clock colons must not truncate the Today prefix",
  );

  const calendarOnlyOutput = enforceSection4Output(
    [
      "- Fr 04.09.: ☀️ Ab jetzt heiter und trocken.",
      "- Sa 05.09.: ☀️ Durchgehend klar und trocken.",
      "- So–Mi 06.–09.09.: ☀️ Sonnig und trocken.",
    ].join("\n"),
    {
      todayLabel: "Fr 04.09.",
      tomorrowLabel: "Sa 05.09.",
      forecastOverviewLabel: "So–Mi 06.–09.09.",
    },
  ) ?? "";
  assert.match(calendarOnlyOutput, /^- Heute \(Fr 04\.09\.\): ☀️ Ab jetzt heiter und trocken\.$/m);
  assert.match(calendarOnlyOutput, /^- Morgen \(Sa 05\.09\.\): ☀️ Durchgehend klar und trocken\.$/m);
  assert.match(calendarOnlyOutput, /^- So–Mi 06\.–09\.09\.: ☀️ Sonnig und trocken\.$/m);

  assert.equal(
    normalizeSection1Icons(
      "🌀 Hochdruckrücken breitet sich ostwärts aus.\n"
      + "🌡️ Warme, trockene Luftmasse dominiert.",
    ),
    "- 🌀 Hochdruckrücken breitet sich ostwärts aus.\n"
      + "- 🌡️ Warme, trockene Luftmasse dominiert.",
    "section 1 must canonicalize unbulleted LLM lines",
  );

  assert.equal(
    normalizeSection2Icons(
      "- ⛵ Kaltfront über Nordeuropa zieht ostwärts.\n- 🚢 Keine Front nahe dem Ionischen Meer.",
      "Ionisches Meer Meganisi",
    ),
    "- 🌍 Kaltfront über Nordeuropa zieht ostwärts.\n- 📍 Keine Front nahe dem Ionischen Meer.",
  );
  assert.equal(
    normalizeSection2Icons(
      "🌍 Okklusion über Skandinavien zieht nordostwärts; atlantische Kaltfront bleibt westlich der Britischen Inseln.\n"
      + "📍 Adria Nord (Kroatien): keine aktive Front in Reichweite.",
      "Adria Nord (Kroatien)",
    ),
    "- 🌍 atlantische Kaltfront bleibt westlich der Britischen Inseln.\n"
      + "- 📍 Adria Nord (Kroatien): keine aktive Front in Reichweite.",
    "section 2 must canonicalize unbulleted lines and remove standalone occlusion clauses",
  );
  assert.equal(
    normalizeSection2Icons(
      "- 🌍 Kaltfronten über Nordeuropa ziehen ostwärts.\n"
      + "- 📍 Neusiedler See (Österreich) liegt im frontfreien Bereich; nächste Kaltfront weit nördlich.",
      "Ionisches Meer Meganisi",
    ),
    "- 🌍 Kaltfronten über Nordeuropa ziehen ostwärts.\n"
      + "- 📍 Ionisches Meer Meganisi liegt im frontfreien Bereich; nächste Kaltfront weit nördlich.",
    "a stale local-area subject must be replaced by the actual target",
  );
  assert.equal(
    ensureSection4Icons(
      "- Heute (Sa 22.08.): Zunächst klar, später zunehmend bewölkt.\n"
      + "- Morgen (So 23.08.): Regen am Morgen, danach trocken.\n"
      + "- Mo–Do 24.–27.08.: Stabile Hochdrucklage.",
    ),
    "- Heute (Sa 22.08.): 🌤️ Zunächst klar, später zunehmend bewölkt.\n"
      + "- Morgen (So 23.08.): 🌧️ Regen am Morgen, danach trocken.\n"
      + "- Mo–Do 24.–27.08.: ☀️ Stabile Hochdrucklage.",
  );
  assert.match(
    ensureSection4Icons(
      "- Heute (Sa 22.08.): Morgens wolkenlos, später bewölkt; kein nennenswerter Niederschlag.",
    ) ?? "",
    /: 🌤️ /,
    "negated precipitation must not produce a rain icon",
  );

  const missingBullets = enforceSection4Output(
    "- Heute: Ruhiger Verlauf.",
    {
      todayLabel: "Sa 22.08.",
      tomorrowLabel: "So 23.08.",
      forecastOverviewLabel: "Mo–Do 24.–27.08.",
    },
  );
  assert.equal(missingBullets, null, "missing LLM bullets must not be replaced by deterministic content");

  const emptyForecastBodies = enforceSection4Output(
    [
      "- Heute:",
      "- Morgen:",
      "- Mo–Do 24.–27.08.:",
    ].join("\n"),
    {
      todayLabel: "Sa 22.08.",
      tomorrowLabel: "So 23.08.",
      forecastOverviewLabel: "Mo–Do 24.–27.08.",
    },
  );
  assert.equal(
    emptyForecastBodies,
    null,
    "three formal date prefixes without forecast content must not produce an empty section 4",
  );

  const sanitized = enforceSection4Output(
    [
      "- Heute: ☁️ Cumulus-Bewölkung 53–76 %; 📉 Druck fällt von 1016 auf 1014 hPa; 🌡️ Maximum 33,8°C, abends rascher Rückgang auf rund 26°C; 🌡️ rascher Temperaturrückgang um ca. 2°C zwischen 18:00 und 19:00 Uhr; 🌡️ rascher Temperaturabfall ab 18:00–19:00 Uhr.",
      "- Morgen: ⛅ Nebelfelder möglich (WMO-Code 45); ⛈️ Gewittersignal bei Cumulonimbus; 📉 Druck bleibt bei 1014 hPa.",
      "- Mo–Do 24.–27.08.: ☀️ Stabil; Di früh 7,2 mm Regen; kein Gewitterrisiko; 📈 Druck steigt auf 1018,4 hPa.",
    ].join("\n"),
    {
      todayLabel: "Sa 22.08.",
      tomorrowLabel: "So 23.08.",
      forecastOverviewLabel: "Mo–Do 24.–27.08.",
    },
    {
      pressureSignificant: [false, false, false],
      thunderstormAllowed: [false, false, false],
    },
  ) ?? "";
  assert.doesNotMatch(sanitized, /%|Druck|hPa|Gewitter|Cumulonimbus|⛈️|WMO[-\s]?Code/i);
  assert.match(sanitized, /Cumulus-Bewölkung/);
  assert.match(sanitized, /Nebelfelder möglich/);
  assert.match(sanitized, /Maximum 34°C/);
  assert.doesNotMatch(sanitized, /rascher Temperaturrückgang|abends rascher Rückgang|18:00|19:00/);
  assert.match(sanitized, /⛅ Nebelfelder möglich/);
  assert.match(sanitized, /Di früh Regen/);
  assert.doesNotMatch(sanitized, /\d+(?:[,.]\d+)?\s*mm\b/i);
  assert.doesNotMatch(sanitized, /Tagessumme|Tagesmenge|Niederschlagsmenge/i);
  assert.doesNotMatch(sanitized, /7[,.]2\s*mm|1018[,.]4 hPa/);
  assert.doesNotMatch(sanitized, /\d+[,.]\d+\s*(?:mm|hPa|°C)/i);

  const negatedThunderstormOutput = enforceSection4Output(
    [
      "- Heute: Klar, kein Niederschlag, kein Gewittersignal; Temperatur rund 30 °C.",
      "- Morgen: Wolkenlos und trocken; kein Gewitter.",
      "- Mo–Do 24.–27.08.: Stabil und sonnig; ohne Gewitterrisiko.",
    ].join("\n"),
    {
      todayLabel: "Sa 22.08.",
      tomorrowLabel: "So 23.08.",
      forecastOverviewLabel: "Mo–Do 24.–27.08.",
    },
    {
      thunderstormAllowed: [false, false, false],
    },
  ) ?? "";
  assert.match(negatedThunderstormOutput, /Klar, kein Niederschlag/);
  assert.match(negatedThunderstormOutput, /Wolkenlos und trocken/);
  assert.match(negatedThunderstormOutput, /Stabil und sonnig/);
  assert.doesNotMatch(negatedThunderstormOutput, /Gewitter/i);

  const strippedOutput = enforceSection4Output(
    [
      "- Heute: 📉 Druckschwankung von 1016 auf 1014 hPa; ⛈️ Gewitterrisiko.",
      "- Morgen: 📉 Druck bleibt bei 1014 hPa; ⛈️ Gewittersignal.",
      "- Mo–Do 24.–27.08.: 📈 Druck bleibt stabil.",
    ].join("\n"),
    {
      todayLabel: "Sa 22.08.",
      tomorrowLabel: "So 23.08.",
      forecastOverviewLabel: "Mo–Do 24.–27.08.",
    },
    {
      pressureSignificant: [false, false, false],
      thunderstormAllowed: [false, false, false],
    },
  );
  assert.equal(strippedOutput, null, "empty sanitized bullets must not be replaced by deterministic content");

  const expandedOverview = enforceSection4Output(
    [
      "- Heute: Ruhiger Verlauf.",
      "- Morgen: Wechselnd bewölkt.",
      "- Mo–Do 24.–27.08.: ☀️ Mittelmeerraum unter stabiler Hochdrucklage",
    ].join("\n"),
    {
      todayLabel: "Sa 22.08.",
      tomorrowLabel: "So 23.08.",
      forecastOverviewLabel: "Mo–Do 24.–27.08.",
    },
  ) ?? "";
  assert.match(expandedOverview, /Mittelmeerraum unter stabiler Hochdrucklage/);
  assert.doesNotMatch(expandedOverview, /Höchstwerte bis 34°C|bis zum Ende des Zeitraums/);
}

function testSubstantiveTwoBulletSections(): void {
  assert.equal(
    hasTwoSubstantiveBullets(
      "- 🌍 Kaltfront zieht von Frankreich ostwärts.\n"
      + "- 📍 Am Zielort liegt keine aktive Front.",
    ),
    true,
  );
  assert.equal(
    hasTwoSubstantiveBullets("- 🌍 \n- 📍 Am Zielort liegt keine aktive Front."),
    false,
    "an icon-only bullet must never satisfy a required two-bullet section",
  );
  assert.equal(
    hasTwoSubstantiveBullets("- 🌍 Europa-Lage."),
    false,
    "a required two-bullet section must contain exactly two bullets",
  );
}

function testCloudBaseEstimate(): void {
  assert.equal(estimateCloudBaseM(30.7, 21.2), 1188, "125m per °C dew point depression");
  assert.equal(estimateCloudBaseM(20, 20), 0, "saturated air has cloud base at the surface");
  assert.equal(estimateCloudBaseM(null, 20), null, "missing temperature yields no estimate");
  assert.equal(estimateCloudBaseM(20, null), null, "missing dew point yields no estimate");
}

function cityMeteogramAnalysis(
  dewPoints: Array<number | null>,
  clouds: { low?: Array<number | null>; mid?: Array<number | null>; high?: Array<number | null> } = {},
): Record<string, unknown> {
  const timestamps = dewPoints.map((_, index) => `2026-08-22T${String(9 + index).padStart(2, "0")}:00:00+02:00`);
  return {
    weatherRaw: {
      openMeteoForecast: {
        timezone: "Europe/Vienna",
        city: {
          name: "Teststadt",
          coordinates: { lat: 47.95, lon: 16.84 },
          url: "https://open-meteo.com/",
          hourly: {
            timestamps,
            temp2mC: timestamps.map((_, index) => 20 + index),
            dewPoint2mC: dewPoints,
            isDay: timestamps.map((_, index) => index % 2),
            pressureMslHPa: timestamps.map(() => 1013),
            rainMm: timestamps.map(() => 0),
            precipProbabilityPct: timestamps.map(() => 0),
            weatherCode: timestamps.map(() => 1),
            cloudBaseM: timestamps.map(() => null),
            cloudType: timestamps.map((_, index) => index % 2 === 0 ? "cumulus" : "cirrus"),
            cloudCoverLowPct: clouds.low ?? timestamps.map(() => null),
            cloudCoverMidPct: clouds.mid ?? timestamps.map(() => null),
            cloudCoverHighPct: clouds.high ?? timestamps.map(() => null),
          },
        },
      },
    },
  };
}

function testCityMeteogramCloudBands(): void {
  const data = extractCityMeteogram(cityMeteogramAnalysis([12], { low: [70], mid: [40], high: [10] }));
  assert.ok(data, "meteogram data should be extracted");
  const point = data.points[0];
  assert.deepEqual(
    point.cloudBands.map((band) => ({ key: band.key, label: band.label, pct: band.pct })),
    [
      { key: "high", label: "HOCH", pct: 10 },
      { key: "mid", label: "MITTEL", pct: 40 },
      { key: "low", label: "TIEF", pct: 70 },
    ],
    "the meteogram should expose exactly the three aggregate cloud bands",
  );
  assert.equal(data.bands.length, 3, "the chart must render only three cloud bands");
}

function seaWindAnalysis(): Record<string, unknown> {
  const timestamps = Array.from({ length: 144 }, (_, index) => {
    const day = 22 + Math.floor(index / 24);
    const hour = index % 24;
    return `2026-08-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00`;
  });
  return {
    weatherRaw: {
      openMeteoForecast: {
        timezone: "Europe/Vienna",
        sailingArea: {
          name: "Testrevier",
          coordinates: AREA.coordinates,
          hourly: {
            timestamps,
            windSpeedKt: timestamps.map((_, index) => index % 16),
            gustKt: timestamps.map((_, index) => 3 + (index % 16)),
            windDirDeg: timestamps.map(() => 292),
          },
        },
      },
    },
  };
}

function compactedSeaWindAnalysis(): Record<string, unknown> {
  const analysis = seaWindAnalysis();
  const hourly = (analysis.weatherRaw as any).openMeteoForecast.sailingArea.hourly;
  for (const key of ["timestamps", "windSpeedKt", "gustKt", "windDirDeg"]) {
    hourly[key] = hourly[key].filter((_: unknown, index: number) => index % 3 === 0);
  }
  return analysis;
}

function testSeaWindForecast(): void {
  const analysis = seaWindAnalysis();
  const data = extractSeaWindForecast(analysis);
  assert.ok(data, "seegebiet wind data should be extracted");
  assert.equal(data.points.length, 48, "the chart should sample exactly 48 three-hour points from six days");
  assert.equal(data.points[0].timestamp, "2026-08-22T00:00", "the first three-hour point should preserve its source timestamp");
  assert.equal(data.points[1].speed, 3, "three-hour sampling should retain aligned wind values");
  assert.equal(data.latitude, AREA.coordinates.lat, "the chart should retain sailing-area latitude");
  assert.equal(data.longitude, AREA.coordinates.lon, "the chart should retain sailing-area longitude");

  const markup = renderToStaticMarkup(createElement(SeaWindForecast, { analysisJson: analysis }));
  assert.match(markup, /data-testid="sea-wind-forecast"[^>]*data-forecast-status="ready"/, "available wind data should render the ready chart");
  assert.match(markup, /data-forecast-days="6"[^>]*data-forecast-points="48"/, "the chart should expose six days and 48 points");
  assert.match(markup, /data-sailing-area-lat="47\.8"[^>]*data-sailing-area-lon="16\.75"/, "the chart metadata must use sailing-area coordinates");
  assert.match(markup, /data-testid="sea-wind-forecast-scroll"/, "the chart should provide a horizontal scroll container");
  assert.match(markup, /role="region"/, "the horizontal forecast should be exposed as a named region");
  assert.match(markup, /tabindex="0"/, "keyboard users should be able to focus and scroll the timeline");
  assert.match(markup, /Wind/, "the chart should include the wind row");
  assert.match(markup, /Böen/, "the chart should include the gust row");
  assert.match(markup, /Windrichtung/, "the chart should include the direction row");
  assert.doesNotMatch(markup, /Temperatur|Regen|Druck|Wolken/, "the wind chart must not include unrelated weather rows");
  assert.match(markup, /Sonntag 23/, "day headings should use normal capitalization");
  assert.doesNotMatch(markup, /SONNTAG/, "day headings should not use all caps");
  assert.match(markup, /data-hour-label="3">3<\/div>/, "hour labels should not have a leading zero");
  assert.match(markup, /data-night-overlay-layer="true"/, "night shading should use the shared overlay treatment");
  assert.match(markup, /bg-\[#63709b\]\/\[\.075\]/, "night shading should match the city meteogram");
  assert.match(markup, /data-label-rail-width="108"/, "the fixed label rail should expose the shared width");
  assert.match(markup, /data-testid="forecast-clock-glyph"/, "the wind forecast should use the shared clock glyph");
  assert.match(markup, /data-testid="sea-wind-hours-row"[^>]*data-row-height="21"[^>]*data-font-size="13"/, "the wind forecast should expose the compact shared hour-row dimensions");
  const windLabelRail = markup.match(/<aside[^>]*data-testid="sea-wind-label-rail"[^>]*>(.*?)<\/aside>/)?.[1] ?? "";
  assert.equal((windLabelRail.match(/>kt</g) ?? []).length, 2, "wind and gust labels should show kt");
  assert.doesNotMatch(windLabelRail, /⚑/, "the wind direction label should not show a flag glyph");
  assert.match(markup, /data-testid="sea-wind-current-column"[^>]*border-dashed/, "the wind forecast should keep a dashed current-time line without a visible label");
  assert.match(markup, /background-color:#f1f2f2/, "zero-knot wind should use the lightest approved color");
  assert.match(markup, /src="\/assets\/wind-arrows\/wind-arrow-ESE-112\.svg"/, "a wind reported from NW should use an arrow pointing toward SE");
  assert.match(markup, /role="img" aria-label="Windrichtung 292°"/, "direction values should be available to assistive technology");

  const compacted = compactedSeaWindAnalysis();
  assert.equal(
    extractSeaWindForecast(compacted)?.points.length,
    48,
    "an already compacted three-hour frontend export must not be sampled a second time",
  );

  const invalidTimezone = seaWindAnalysis();
  const invalidTimezoneForecast = (invalidTimezone.weatherRaw as any).openMeteoForecast;
  invalidTimezoneForecast.timezone = "Not/A-Timezone";
  invalidTimezoneForecast.sailingArea.hourly.timestamps = invalidTimezoneForecast.sailingArea.hourly.timestamps.map(
    (timestamp: string) => `${timestamp}:00Z`,
  );
  assert.doesNotThrow(
    () => extractSeaWindForecast(invalidTimezone),
    "an invalid timezone must not crash timestamp parsing",
  );
  assert.equal(
    extractSeaWindForecast(invalidTimezone)?.points.length,
    48,
    "invalid timezone metadata should fall back safely while preserving a complete forecast",
  );

  const loadingMarkup = renderToStaticMarkup(
    createElement(SeaWindForecast, { analysisJson: null, isLoading: true }),
  );
  assert.match(loadingMarkup, /data-forecast-status="loading"/, "the chart should expose a loading state before analysis data arrives");
  const unavailableMarkup = renderToStaticMarkup(
    createElement(SeaWindForecast, { analysisJson: { weatherRaw: {} } }),
  );
  assert.match(unavailableMarkup, /data-forecast-status="unavailable"/, "missing wind data should render an explicit unavailable state");

  const malformed = seaWindAnalysis();
  const malformedHourly = (malformed.weatherRaw as any).openMeteoForecast.sailingArea.hourly;
  malformedHourly.timestamps[3] = null;
  const malformedData = extractSeaWindForecast(malformed);
  assert.equal(malformedData, null, "a missing three-hour slot should produce the explicit unavailable state instead of a shortened chart");
  const partial = seaWindAnalysis();
  const partialHourly = (partial.weatherRaw as any).openMeteoForecast.sailingArea.hourly;
  for (const key of ["timestamps", "windSpeedKt", "gustKt", "windDirDeg"]) {
    partialHourly[key] = partialHourly[key].slice(0, 72);
  }
  assert.equal(extractSeaWindForecast(partial), null, "a partial forecast must not render fewer than six days");

  for (const key of ["windSpeedKt", "gustKt", "windDirDeg"]) {
    const shortened = compactedSeaWindAnalysis();
    const shortenedHourly = (shortened.weatherRaw as any).openMeteoForecast.sailingArea.hourly;
    shortenedHourly[key] = shortenedHourly[key].slice(0, 47);
    assert.equal(extractSeaWindForecast(shortened), null, `a shortened ${key} series must render unavailable`);

    const withNull = compactedSeaWindAnalysis();
    const withNullHourly = (withNull.weatherRaw as any).openMeteoForecast.sailingArea.hourly;
    withNullHourly[key][10] = null;
    assert.equal(extractSeaWindForecast(withNull), null, `a null ${key} value must render unavailable`);
  }

  const duplicateTimestamp = compactedSeaWindAnalysis();
  const duplicateHourly = (duplicateTimestamp.weatherRaw as any).openMeteoForecast.sailingArea.hourly;
  duplicateHourly.timestamps[10] = duplicateHourly.timestamps[9];
  assert.equal(extractSeaWindForecast(duplicateTimestamp), null, "duplicate timestamps must render unavailable");

  const timestampGap = compactedSeaWindAnalysis();
  const timestampGapHourly = (timestampGap.weatherRaw as any).openMeteoForecast.sailingArea.hourly;
  timestampGapHourly.timestamps[10] = "2026-08-23T07:00";
  assert.equal(extractSeaWindForecast(timestampGap), null, "non-contiguous three-hour timestamps must render unavailable");
}

function testCityMeteogramDewPointVisibility(): void {
  const noDewPoint = cityMeteogramAnalysis([null, Number.NaN], []);
  const noDewPointMarkup = renderToStaticMarkup(
    createElement(CityMeteogram, { analysisJson: noDewPoint }),
  );
  assert.doesNotMatch(noDewPointMarkup, /Taupunkt/, "the complete Taupunkt legend, label and row should be absent");
  assert.doesNotMatch(noDewPointMarkup, /JETZT/, "the meteogram should use only the dashed current-time line");

  const partialDewPoint = cityMeteogramAnalysis([null, 12.4], []);
  const partialData = extractCityMeteogram(partialDewPoint);
  assert.ok(partialData, "partial dew point data should still produce a meteogram");
  assert.deepEqual(
    partialData.points.map((point) => point.dewPoint),
    [null, 12.4],
    "missing dew point values must stay missing instead of being estimated",
  );
  const partialMarkup = renderToStaticMarkup(
    createElement(CityMeteogram, { analysisJson: partialDewPoint }),
  );
  assert.equal((partialMarkup.match(/Taupunkt/g) ?? []).length, 2, "partial data should show the Taupunkt legend and row label");
  assert.match(partialMarkup, />12°<\/div>/, "the finite dew point should be rendered");
}

function testCityMeteogramLoadingState(): void {
  const markup = renderToStaticMarkup(
    createElement(CityMeteogram, { analysisJson: null, isLoading: true }),
  );
  assert.match(markup, /data-meteogram-status="loading"/, "loading state should be marked as loading");
  assert.doesNotMatch(markup, /bounce-loader|animate-bounce/, "the meteogram must not render animated dots");
  assert.doesNotMatch(markup, /Meteogramm wird vorbereitet …/, "the shared icon status remains outside the meteogram");
}

function testForecastExportPreservesRainTotals(): void {
  const timestamps = Array.from(
    { length: 24 },
    (_, hour) => `2026-09-01T${String(hour).padStart(2, "0")}:00`,
  );
  const rainMm = [3, 3.9, 0.3, ...Array.from({ length: 21 }, () => 0)];
  const analysis = {
    meta: {
      app: "aiWindy",
      version: "test",
      website: "",
      github: "",
      copyright: "",
      requestDate: FIXED_NOW,
    },
    position: {
      userInput: "Teststadt",
      country: "Österreich",
      countryCode: "AT",
      windyModel: "iconD2",
      sailingArea: null,
      city: CITY,
    },
    sources: { windy: [], national: [], europe: [] },
    weatherRaw: {
      openMeteoForecast: {
        sailingArea: {
          name: "Testrevier",
          coordinates: AREA.coordinates,
          hourly: {
            timestamps,
            windSpeedKt: Array.from({ length: 24 }, () => 10),
            gustKt: [12, 27, 18, ...Array.from({ length: 21 }, () => 14)],
            windDirDeg: Array.from({ length: 24 }, () => 225),
          },
        },
        city: {
          hourly: {
            timestamps,
            rainMm,
            temp2mC: Array.from({ length: 24 }, (_, index) => 20 + index),
            precipProbabilityPct: [10, 30, 80, ...Array.from({ length: 21 }, () => 5)],
            weatherCode: [1, 2, 95, ...Array.from({ length: 21 }, () => 1)],
            cloudType: ["cumulus", "mixed", "cumulonimbus", ...Array.from({ length: 21 }, () => "clear")],
            capeJkg: [100, 500, 900, ...Array.from({ length: 21 }, () => 0)],
          },
        },
      },
    },
    weatherPreprocessed: { europe: {}, national: {}, local: {} },
    weatherOutput: {},
  } satisfies AnalysisJson;

  const exported = getSanitizedAnalysisExport(analysis) as any;
  const exportedHourly = exported.weatherRaw.openMeteoForecast.city.hourly;
  assert.equal(exportedHourly.timestamps.length, 8, "the frontend export should retain its three-hour resolution");
  assert.equal(exportedHourly.rainMm[0], 7.2, "rain within each three-hour block must be summed, not sampled");
  assert.deepEqual(
    exportedHourly.rainMm3h[0],
    [3, 3.9, 0.3],
    "the frontend export must retain all three hourly rain bars inside each three-hour block",
  );
  assert.equal(
    exportedHourly.rainMm.reduce((sum: number, amount: number) => sum + amount, 0),
    7.2,
    "forecast export compaction must preserve the daily rain total shown to the LLM",
  );
  assert.deepEqual(
    exportedHourly.temp2mC.slice(0, 3),
    [20, 23, 26],
    "non-accumulating weather values should remain sampled at three-hour intervals",
  );
  assert.equal(
    exported.weatherRaw.openMeteoForecast.sailingArea.hourly.gustKt[0],
    27,
    "the three-hour export must retain the strongest gust inside the 00–02 block",
  );
  assert.equal(exportedHourly.precipProbabilityPct[0], 80, "the highest precipitation probability in a three-hour block must survive export");
  assert.equal(exportedHourly.weatherCode[0], 95, "a thunderstorm code anywhere in a three-hour block must survive export");
  assert.equal(exportedHourly.cloudType[0], "cumulonimbus", "a cumulonimbus signal anywhere in a three-hour block must survive export");
  assert.equal(exportedHourly.capeJkg[0], 900, "the highest CAPE value in a three-hour block must survive export");
  const meteogram = extractCityMeteogram(exported);
  assert.ok(meteogram, "the compacted frontend export should render as a meteogram");
  assert.deepEqual(
    meteogram.points[0].rainBars,
    [3, 3.9, 0.3],
    "the meteogram must receive the three hourly bars without collapsing them",
  );
  const markup = renderToStaticMarkup(
    createElement(CityMeteogram, { analysisJson: exported }),
  );
  assert.match(markup, /data-rain-bar-count="3"/, "the rainy three-hour column must declare three sub-bars");
  assert.equal(
    (markup.match(/data-rain-bar-amount=/g) ?? []).length,
    3,
    "all three non-zero hourly rain amounts must render as separate SVG bars",
  );
  assert.match(markup, /data-rain-amount="3\.9mm"/, "the hourly rain label must show the highest hourly value");
  assert.doesNotMatch(markup, /data-rain-amount="7\.2mm"/, "the daily total must not be used as the hourly bar label");
}

function testCityMeteogramVisualLayers(): void {
  const analysis = cityMeteogramAnalysis(
    [12, 13],
    { low: [65, 45], mid: [20, 55], high: [5, 70] },
  );
  const hourly = (analysis.weatherRaw as any).openMeteoForecast.city.hourly;
  hourly.cloudBaseM = [900, 1400];
  hourly.rainMm = [0.3, 2.2];
  hourly.pressureMslHPa = [1010.4, 1020.4];

  const data = extractCityMeteogram(analysis);
  assert.ok(data, "visual-layer fixture should produce a meteogram");
  assert.deepEqual(
    data.points.map((point) => point.isDay),
    [false, true],
    "numeric Open-Meteo is_day values must map to night/day booleans",
  );
  assert.deepEqual(
    data.points.map((point) => point.cloudType),
    ["cumulus", "cirrus"],
    "heuristic cloud types must stay aligned with their timestamps",
  );

  const markup = renderToStaticMarkup(
    createElement(CityMeteogram, { analysisJson: analysis }),
  );
  assert.match(
    markup,
    /data-chart-night-column="true"[^>]*data-night-shading="true"/,
    "nighttime must use the full-height chart background column",
  );
  assert.match(
    markup,
    /data-chart-night-column="true"[^>]*data-night-index="0"/,
    "night columns should retain their source index for visual regression tooling",
  );
  assert.match(
    markup,
    /data-testid="meteogram-temperature-area"[^>]*data-temperature-layer="behind-forecast-rows"/,
    "the filled temperature chart must be the background layer behind icons and temperature values",
  );
  assert.equal(
    (markup.match(/data-series="temperature"/g) ?? []).length,
    2,
    "the temperature chart must contain one filled area and one line",
  );
  assert.doesNotMatch(
    markup,
    /data-series="dew-point"/,
    "dew point must never be rendered as an SVG curve",
  );
  assert.ok(
    markup.indexOf('data-testid="meteogram-temperature-area"')
      < markup.indexOf('data-testid="meteogram-dew-point-row"'),
    "the overlaid temperature area must remain above the numeric dew-point row",
  );
  assert.match(markup, /data-testid="meteogram-cloud-field"/, "cloud field must remain testable");
  assert.equal((markup.match(/data-cloud-shape-band="(?:high|mid|low)"/g) ?? []).length, 6, "three cloud bands should render for each populated timestamp");
  assert.equal(
    (markup.match(/data-cloud-band-clip="(?:high|mid|low)"[^>]*clip-path="url\(#meteogram-cloud-band-(?:high|mid|low)\)"/g) ?? []).length,
    3,
    "each cloud texture must be clipped to its own altitude band",
  );
  assert.doesNotMatch(markup, /data-testid="meteogram-cloud-type-row"/, "the separate cloud type row should be removed");
  assert.equal((markup.match(/data-weather-cloud-type="/g) ?? []).length, 2, "each weather cell should carry the cloud type once");
  assert.equal((markup.match(/data-cloud-type-icon="/g) ?? []).length, 2, "each weather cell should render one integrated cloud-type icon");

  const dryRainCodeAnalysis = cityMeteogramAnalysis(
    [12],
    { low: [60], mid: [30], high: [10] },
  );
  const dryRainCodeHourly = (dryRainCodeAnalysis.weatherRaw as any).openMeteoForecast.city.hourly;
  dryRainCodeHourly.rainMm = [0.01];
  dryRainCodeHourly.weatherCode = [61];
  dryRainCodeHourly.cloudType = ["cumulus"];
  dryRainCodeHourly.cloudCoverPct = [60];
  dryRainCodeHourly.isDay = [1];
  const dryRainCodeMarkup = renderToStaticMarkup(
    createElement(CityMeteogram, { analysisJson: dryRainCodeAnalysis }),
  );
  assert.doesNotMatch(
    dryRainCodeMarkup,
    /data-weather-icon-kind="(?:light|heavy)-rain"/,
    "a precipitation trace below the visible bar threshold must not produce a rain icon",
  );
  assert.match(
    dryRainCodeMarkup,
    /data-weather-icon-kind="partly-cloudy-day"/,
    "a dry precipitation-code point should fall back to its actual cloud cover",
  );
  assert.equal((markup.match(/data-fixed-cloud-band="(?:high|mid|low)"/g) ?? []).length, 3, "all three cloud-band labels should remain in the fixed rail");
  assert.equal((markup.match(/data-weather-cloud-type="[^"]+"[^>]*role="img"[^>]*aria-label="/g) ?? []).length, 2, "each integrated weather icon should have an accessible description");
  assert.match(markup, /data-weather-cloud-type="cumulus"/, "weather icons should expose the heuristic classification");
  assert.match(markup, /data-weather-cloud-type="cirrus"/, "weather icons should retain neutral cloud types");
  assert.match(markup, /Cumulus.*tief.*mittel.*hoch.*CAPE.*Regen/, "cloud icon tooltips should include type and underlying model values");
  assert.match(markup, /#898781/, "non-warning cloud types should use the neutral axis gray");
  assert.equal(cloudTypeColor("stratus"), "#fab219", "stratus should use the reserved warning color");
  assert.equal(cloudTypeColor("cumulonimbus"), "#d03b3b", "cumulonimbus should use the reserved critical color");
  assert.equal(cloudTypeColor("cirrus"), "#898781", "non-warning cloud types should remain neutral");
  assert.match(markup, /data-rain-amount="0.3mm"/, "rain columns should show their measured amount");
  assert.match(markup, /data-rain-amount="2.2mm"/, "larger rain columns should show their measured amount");
  assert.match(markup, /data-testid="meteogram-daily-rain"[^>]*data-rain-total="2.5"[^>]*data-rain-pill-placement="cloud-chart"/, "the cloud chart should show the summed rain amount at the end of the day");
  assert.ok(
    markup.indexOf('data-testid="meteogram-daily-rain"') > markup.indexOf('data-testid="meteogram-cloud-field"'),
    "the daily rain pill should be positioned inside the cloud/rain chart, not in the day header",
  );
  assert.doesNotMatch(
    markup,
    /data-testid="meteogram-cloud-field"[^>]*bg-\[#/,
    "the cloud field must stay transparent so full-height night shading remains visible",
  );
  assert.doesNotMatch(markup, /data-testid="meteogram-lcl-line"/, "estimated LCL line must stay hidden");
  assert.doesNotMatch(markup, /key="lcl-/, "estimated LCL point markers must stay hidden");
  assert.match(markup, /linearGradient id="temperature-gradient"/, "temperature should use a stable horizontal SVG gradient");
  assert.match(markup, /gradientUnits="userSpaceOnUse"/, "temperature colors should follow the actual timeline");
  assert.match(markup, /data-temperature="20"/, "temperature gradient should include data-driven stops");
  assert.notEqual(temperatureColor(19), temperatureColor(33), "cool and hot temperatures should use visibly different colors");
  assert.match(temperatureColor(33), /^#(?:[a-f0-9]{6})$/i, "temperature colors should be valid SVG hex colors");
  assert.match(markup, /linearGradient id="temperature-fade"/, "temperature fill should fade vertically");
  assert.match(markup, /data-testid="meteogram-pressure-line"/, "pressure path should remain directly measurable");
  assert.match(markup, /data-testid="meteogram-pressure-line"[^>]*data-pressure-min="1010.4"[^>]*data-pressure-max="1020.4"[^>]*data-pressure-y-min="0"[^>]*data-pressure-y-max="85"[^>]*data-pressure-row-height="85"/, "pressure should preserve decimal precision across the full pressure/rain row height");
  assert.match(markup, /font-size="10"/, "pressure labels should be readable");
  assert.match(markup, /stroke="#587b90"/, "pressure should be blue-gray and distinct from cloud fill");
  assert.match(markup, /data-testid="meteogram-current-column"/, "the current forecast column should be highlighted");
  assert.match(
    markup,
    /data-testid="meteogram-current-column"[^>]*role="img"[^>]*aria-label="Aktueller Prognosezeitpunkt:/,
    "the current forecast column should expose its timestamp to assistive technology",
  );
  assert.match(markup, /border-l border-dashed/, "the current column should use a subtle Windy-like dashed marker");
  assert.match(markup, /data-night-overlay-layer="true"[^>]*z-\[15\]/, "night shading should overlay opaque chart rows");
  assert.match(markup, /data-testid="city-meteogram-hours-row"[^>]*data-row-height="21"[^>]*data-font-size="13"/, "the meteogram hour row should match the compact wind forecast");
  const cityLabelRail = markup.match(/<aside[^>]*data-testid="city-meteogram-label-rail"[^>]*>(.*?)<\/aside>/)?.[1] ?? "";
  assert.doesNotMatch(cityLabelRail, />kt<|>hPa<|>mm<|>°C</, "the meteogram label rail should not repeat measurement units");
  assert.match(cityLabelRail, /Bewölkung/, "the meteogram should label the icon row as Bewölkung");
  assert.match(cityLabelRail, /height:44px[^>]*>Bewölkung/, "Bewölkung should align with the icon row");
  assert.match(cityLabelRail, /height:42px[^>]*>Temperatur/, "Temperatur should align with its own row");
  assert.match(cityLabelRail, /height:16px[\s\S]*?data-testid="city-meteogram-dew-label"[\s\S]*>Taupunkt/, "Taupunkt should align with its compact row");
  assert.match(cityLabelRail, /Druck<br\/>Regen/, "Druck and Regen should share one neutral label treatment");
  assert.doesNotMatch(cityLabelRail, /text-\[#3275a0\]|text-\[#a85e42\]/, "temperature, pressure, and rain labels should use the same gray color");
  assert.match(markup, /data-testid="meteogram-dew-point-row"[\s\S]*?style="top:78px"/, "dew point values should keep their established chart position");
  assert.match(markup, /data-testid="city-meteogram-dew-label"[^>]*class="relative top-\[-8px\]"/, "the Taupunkt label should align with the unchanged chart values");
  assert.match(markup, /data-testid="meteogram-temperature-section"[^>]*data-section-height="102"/, "the temperature and dew point section should not reserve excess vertical space");
  assert.match(markup, /data-testid="meteogram-pressure-section"[^>]*data-section-height="85"/, "the pressure section should follow the compact temperature section");
  const decimalPressureAnalysis = cityMeteogramAnalysis([12, 13, 14]);
  (decimalPressureAnalysis.weatherRaw as any).openMeteoForecast.city.hourly.pressureMslHPa = [1012.4, 1023.4, 1018.7];
  const decimalPressureMarkup = renderToStaticMarkup(
    createElement(CityMeteogram, { analysisJson: decimalPressureAnalysis }),
  );
  assert.match(decimalPressureMarkup, /data-pressure-min="1012\.4"[^>]*data-pressure-max="1023\.4"/, "pressure scaling should retain raw decimal values");
  assert.match(decimalPressureMarkup, /data-pressure-label="true"[^>]*>1023 hPa</, "pressure labels should remain rounded to whole hPa");
  assert.doesNotMatch(decimalPressureMarkup, /data-pressure-label="true"[^>]*>1023\.4 hPa</, "pressure labels should not expose decimal places");
  assert.match(
    markup,
    /data-testid="meteogram-pressure-rain-overlay"/,
    "pressure and rain must share one overlaid plot",
  );
  assert.doesNotMatch(
    markup,
    /data-testid="meteogram-pressure-rain-overlay"[^>]*bg-\[#/,
    "the lower plot must stay transparent so full-height night shading remains visible",
  );
  assert.match(markup, /heuristisch aus Modelldaten/, "cloud types must be described as heuristic model output");
  assert.match(markup, /keine Beobachtung/, "the cloud-base estimate must not be presented as observed");

  const southernWesternAnalysis = cityMeteogramAnalysis([12]);
  const city = (southernWesternAnalysis.weatherRaw as any).openMeteoForecast.city;
  city.coordinates = { lat: -33.869, lon: -151.209 };
  const southernWesternMarkup = renderToStaticMarkup(
    createElement(CityMeteogram, { analysisJson: southernWesternAnalysis }),
  );
  assert.match(
    southernWesternMarkup,
    /33\.869° S · 151\.209° W/,
    "coordinate labels should derive hemispheres from latitude and longitude signs",
  );

  const capeOnlyAnalysis = cityMeteogramAnalysis([12]);
  const capeOnlyHourly = (capeOnlyAnalysis.weatherRaw as any).openMeteoForecast.city.hourly;
  capeOnlyHourly.capeJkg = [900];
  capeOnlyHourly.cloudType = ["cumulus"];
  const capeOnlyMarkup = renderToStaticMarkup(
    createElement(CityMeteogram, { analysisJson: capeOnlyAnalysis }),
  );
  assert.doesNotMatch(
    capeOnlyMarkup,
    /Gewitterrisiko/,
    "CAPE alone must not receive the warning-color treatment reserved for Cumulonimbus",
  );

  capeOnlyHourly.cloudType = ["cumulonimbus"];
  const cumulonimbusMarkup = renderToStaticMarkup(
    createElement(CityMeteogram, { analysisJson: capeOnlyAnalysis }),
  );
  assert.match(
    cumulonimbusMarkup,
    /Gewitterrisiko/,
    "Cumulonimbus should retain the critical warning treatment",
  );
}

function testMeteogramFormatting(): void {
  assert.equal(formatCloudBase(42), "50", "small bases should be rounded to useful 50 m increments");
  assert.equal(formatCloudBase(688), "700", "sub-kilometre bases should round to useful 50 m increments");
  assert.equal(formatCloudBase(1925), "1900", "higher bases should use compact hundreds");
  assert.equal(formatCloudBase(7600), "7500", "high bases should round to 500 m increments");
  assert.equal(formatCloudBase(12400), "12k", "very high bases should use compact kilometre notation");
  assert.match(cloudBaseTone(120), /bg-rose/, "very low bases should have a red cell background");
  assert.match(cloudBaseTone(500), /bg-orange/, "low bases should have an orange cell background");
  assert.match(cloudBaseTone(800), /bg-amber/, "caution bases should have an amber cell background");
  assert.match(cloudBaseTone(1200), /bg-lime/, "medium bases should have a yellow-green cell background");
  assert.match(cloudBaseTone(2400), /bg-emerald/, "high bases should have a green cell background");
}

function testCityMeteogramDoesNotInventCloudsInEmptyBands(): void {
  const analysis = cityMeteogramAnalysis(
    [12, 13],
    { low: [0, 0], mid: [0, 0], high: [70, 70] },
  );
  const hourly = (analysis.weatherRaw as any).openMeteoForecast.city.hourly;
  hourly.cloudType = ["cirrus", "cirrus"];

  const markup = renderToStaticMarkup(
    createElement(CityMeteogram, { analysisJson: analysis }),
  );
  assert.equal(
    (markup.match(/data-cloud-shape-band="high"/g) ?? []).length,
    2,
    "high-cloud texture should render only where its source band has coverage",
  );
  assert.doesNotMatch(
    markup,
    /data-cloud-shape-band="(?:mid|low)"/,
    "the hourly cloud type must not invent clouds in empty lower bands",
  );
}

function testCityMeteogramMalformedArrays(): void {
  const malformed = cityMeteogramAnalysis(
    [12, 13],
    { low: [20, 30], mid: [40, 50], high: [60, 70] },
  );
  const city = (malformed.weatherRaw as any).openMeteoForecast.city;
  city.hourly.timestamps = [
    "2026-08-22T09:00:00+02:00",
    null,
    "2026-08-22T11:00:00+02:00",
  ];
  city.hourly.temp2mC = [20, 21, 22];
  city.hourly.pressureMslHPa = [1013];
  city.hourly.cloudCoverHighPct = [60, "malformed", 80];

  let data: ReturnType<typeof extractCityMeteogram>;
  assert.doesNotThrow(() => {
    data = extractCityMeteogram(malformed);
  }, "mismatched timestamps and value arrays must not throw");
  assert.ok(data, "valid timestamp entries should still produce a meteogram");
  assert.deepEqual(
    data.points.map((point) => point.timestamp),
    ["2026-08-22T09:00:00+02:00", "2026-08-22T11:00:00+02:00"],
    "invalid timestamps should be skipped without shifting later array values",
  );
  assert.deepEqual(
    data.points.map((point) => point.temperature),
    [20, 22],
    "values should stay aligned with their original timestamp indexes",
  );
  assert.deepEqual(
    data.points.map((point) => point.pressure),
    [1013, null],
    "short value arrays should become missing values instead of throwing",
  );
  assert.deepEqual(
    data.points.map((point) => point.cloudBands.map((band) => band.pct)),
    [[60, 40, 20], [80, null, null]],
    "aggregate cloud bands should stay aligned and malformed values should remain missing",
  );

  const missingTimestamps = cityMeteogramAnalysis([12], []);
  const missingCity = (missingTimestamps.weatherRaw as any).openMeteoForecast.city;
  missingCity.hourly.timestamps = null;
  assert.equal(
    extractCityMeteogram(missingTimestamps),
    null,
    "missing core timestamp data should remain unavailable",
  );
  const unavailableMarkup = renderToStaticMarkup(
    createElement(CityMeteogram, { analysisJson: missingTimestamps }),
  );
  assert.match(
    unavailableMarkup,
    /data-meteogram-status="unavailable"/,
    "missing core timestamp data should render the existing unavailable state",
  );
}

function testResolvedLocalForecastPrecedence(): void {
  const localTimestamps = [
    "2026-08-30T00:00",
    "2026-08-30T01:00",
    "2026-08-30T02:00",
  ];
  const utcTimestamps = [
    "2026-08-29T22:00:00Z",
    "2026-08-29T23:00:00Z",
    "2026-08-30T00:00:00Z",
  ];
  const baseline = {
    source: "Open-Meteo Forecast API",
    timezone: "Europe/Vienna",
    sailingArea: {
      name: "Testrevier",
      coordinates: AREA.coordinates,
      hourly: {
        timestamps: localTimestamps,
        windSpeedKt: [10, 11, 12],
        gustKt: [14, 15, 16],
        windDirDeg: [90, 90, 90],
      },
    },
    city: {
      name: "Teststadt",
      coordinates: CITY.coordinates,
      hourly: {
        timestamps: localTimestamps,
        temp2mC: [20, 21, 22],
        cloudCoverPct: [20, 30, 40],
        rainMm: [0.1, 0.1, 0.1],
      },
    },
  };
  const resolved = resolveLocalForecast({
    openMeteoForecast: baseline,
    austriaWindCloudRain: {
      source: "GeoSphere Austria",
      timestamps: utcTimestamps,
      windSpeedKt: [25, null, 27],
      gustKt: [31, null, 35],
      windDir: ["SO", null, "SSO"],
    },
    austriaCityCloudRain: {
      source: "GeoSphere Austria",
      timestamps: utcTimestamps,
      cloudCover: [80, null, 60],
      rainKgm2: [0, 0.4, 1],
    },
    austriaTemperature: {
      source: "GeoSphere Austria",
      timestamps: utcTimestamps,
      temp2mC: [30, null, 32],
    },
  }, "AT") as any;

  assert.deepEqual(resolved.sailingArea.hourly.windSpeedKt, [25, 11, 27], "local wind values should override only matching valid timestamps");
  assert.deepEqual(resolved.sailingArea.hourly.gustKt, [31, 15, 35], "Open-Meteo gusts should remain as a field-level fallback");
  assert.deepEqual(resolved.sailingArea.hourly.windDirDeg, [135, 90, 157.5], "local compass directions should become chart-compatible degrees");
  assert.deepEqual(resolved.city.hourly.temp2mC, [30, 21, 32], "local temperatures should override only valid city values");
  assert.deepEqual(resolved.city.hourly.cloudCoverPct, [80, 30, 60], "local cloud values should retain Open-Meteo gaps");
  assert.deepEqual(resolved.city.hourly.rainMm, [0, 0.4, 0.6], "local cumulative rain should be converted to interval amounts");

  const genericResolved = resolveLocalForecast({
    openMeteoForecast: baseline,
    structuredLocalForecasts: [{
      target: "wind",
      source: "DHMZ strukturierte Lokalprognose",
      timestamps: localTimestamps,
      windSpeedKt: [18, 19, 20],
      gustKt: [24, 25, 26],
      windDirDeg: [315, 315, 292.5],
    }],
  }, "HR") as any;
  assert.deepEqual(genericResolved.sailingArea.hourly.windSpeedKt, [18, 19, 20], "structured local priority should not be country-specific");
  assert.match(genericResolved.sailingArea.source, /DHMZ strukturierte Lokalprognose.*Open-Meteo Forecast API/);

  const ambiguousResolved = resolveLocalForecast({
    openMeteoForecast: baseline,
    structuredLocalForecasts: [{
      target: "wind",
      source: "Lokaler Testanbieter",
      timestamps: [
        "2026-08-30T00:00",
        "2026-08-30T01:30",
        "2026-08-30T02:00",
        "2026-08-30T02:00",
      ],
      windSpeedKt: [18, 99, 30, 31],
    }],
  }, "HR") as any;
  assert.deepEqual(
    ambiguousResolved.sailingArea.hourly.windSpeedKt,
    [18, 11, 12],
    "non-aligned or duplicate local timestamps must fall back to Open-Meteo",
  );

  const strictTimestampResolved = resolveLocalForecast({
    openMeteoForecast: baseline,
    structuredLocalForecasts: [{
      target: "wind",
      source: "Lokaler Testanbieter",
      timestamps: [
        "2026-08-30T00:00:30",
        "2026-08-30T01:00invalid",
        "2026-08-30T02:00:00+02:00",
      ],
      windSpeedKt: [40, 41, 42],
    }],
  }, "HR") as any;
  assert.deepEqual(
    strictTimestampResolved.sailingArea.hourly.windSpeedKt,
    [10, 11, 42],
    "second-level mismatches and malformed suffixes must not overwrite exact baseline timestamps, while a valid offset may match",
  );

  const dstBaseline = structuredClone(baseline) as any;
  dstBaseline.sailingArea.hourly.timestamps = [
    "2026-10-25T02:00",
    "2026-10-25T02:00",
  ];
  dstBaseline.sailingArea.hourly.windSpeedKt = [10, 11];
  dstBaseline.sailingArea.hourly.gustKt = [14, 15];
  dstBaseline.sailingArea.hourly.windDirDeg = [90, 90];
  const dstResolved = resolveLocalForecast({
    openMeteoForecast: dstBaseline,
    structuredLocalForecasts: [{
      target: "wind",
      source: "Lokaler Testanbieter",
      timestamps: [
        "2026-10-25T00:00:00Z",
        "2026-10-25T01:00:00Z",
      ],
      windSpeedKt: [30, 31],
    }],
  }, "HR") as any;
  assert.deepEqual(
    dstResolved.sailingArea.hourly.windSpeedKt,
    [10, 11],
    "the repeated local hour during the DST fallback must remain ambiguous and use the baseline",
  );
}

function testWindDirectionNormalization(): void {
  const normalized = normalizeWindDirectionMentions(
    "- Heute: aus S/SSO, später SSW und NW/WNW, danach N/NO; Leitha NW-W und NNW; später SO NW sowie NW bis W.",
  );
  assert.equal(normalized, "- Heute: aus S, später SW und NW, danach NO; Leitha NW und N; später SO sowie NW.");
  assert.doesNotMatch(normalized, /\b(?:N|NNO|NO|ONO|O|OSO|SO|SSO|S|SSW|SW|WSW|W|WNW|NW|NNW)\s*\//);
  assert.doesNotMatch(normalized, /\b(?:NNO|NNW|ONO|OSO|SSO|SSW|WSW|WNW)\b/);
  assert.doesNotMatch(
    normalized,
    /\b(?:N|NO|O|SO|S|SW|W|NW)(?:\s*(?:\/|[–—-])\s*|\s+bis\s+|\s+)(?:N|NO|O|SO|S|SW|W|NW)\b/,
  );
  assert.equal(
    normalizeWindDirectionMentions("- Morgen: N/NE, danach SE."),
    "- Morgen: NO, danach SO.",
    "English compass abbreviations in generated forecast prose must be localized before eight-point normalization",
  );
  assert.equal(
    normalizeWindDirectionMentions(
      "- So–Di 06.–08.09.: So S 5–16 kt; Mo O 1–7 kt; Di S 11–19 kt.",
    ),
    "- So–Di 06.–08.09.: So S 5–16 kt; Mo O 1–7 kt; Di S 11–19 kt.",
    "weekday labels and their following direction must survive production normalization",
  );

  assert.equal(normalizeWindUnits("W 8–16 kn; später O 7–12 Knoten."), "W 8–16 kt; später O 7–12 kt.");
  assert.equal(
    normalizeWindPairSeparators("W 8 bis 16 kt; O 7/12 kt."),
    "W 8–16 kt; O 7–12 kt.",
  );
  assert.equal(
    combineWindAndGustMentions("NW Wind 8 kt; Böen 16 kt. Später O 7 kt, mit Böen bis zu 12 kt."),
    "NW Wind 8–16 kt. Später O 7–12 kt.",
  );
  assert.equal(
    normalizeCalmThresholdMentions("Der Wind bricht auf unter 3 kt zusammen; später unter 2 kt."),
    "Der Wind bricht bis zur Flaute zusammen; später nahezu Flaute.",
  );
  assert.equal(
    hasValidWindValueFormat(
      "- Heute (Do 03.09.): W 8–16 kt.\n- Morgen (Fr 04.09.): O 7–12 kt.\n- Übermorgen (Sa 05.09.): Windprognose nicht verfügbar.\n- So–Di 06.–08.09.: NW 5–9 kt.",
    ),
    true,
  );
  assert.equal(
    hasValidWindValueFormat(
      "- Heute (Do 03.09.): NW-W 13–17 kt.\n- Morgen (Fr 04.09.): NNW 8–16 kt.\n- Übermorgen (Sa 05.09.): N 17 kt.\n- So–Di 06.–08.09.: SO NW 5–9 kt; W bis 11 kt.",
    ),
    false,
    "composite/intermediate directions and every single kt value must invalidate the output",
  );
  assert.deepEqual(
    diagnoseWindForecast([
      "- Heute (Do 03.09.): NW 15–22 kt.",
      "- Morgen (Fr 04.09.): NW 6–21 kt.",
      "- Übermorgen (Sa 05.09.): N 24–35 kt, danach W 12–20 kt und SW 8–14 kt.",
      "- So–Di 06.–08.09.: So S 5–16 kt; Mo O 1–7 kt; Di S 11–19 kt.",
    ].join("\n")),
    [{
      lineIndex: 2,
      message: "die Übermorgen-Zeile enthält 3 Wind–Böe-Paare, erlaubt sind 1: - Übermorgen (Sa 05.09.): N 24–35 kt, danach W 12–20 kt und SW 8–14 kt.",
    }],
  );
  assert.equal(
    buildWindScaffold([
      "2026-09-03 | 12:00 | NW | 8 | 16",
      "2026-09-03 | 18:00 | W | 12 | 22",
      "2026-09-04 | 06:00 | O | 5 | 9",
      "2026-09-04 | 15:00 | SO | 14 | 24",
      "2026-09-05 | 12:00 | S | 10 | 18",
      "2026-09-06 | 12:00 | SW | 9 | 15",
    ].join("\n"), {
      todayLabel: "Do 03.09.",
      tomorrowLabel: "Fr 04.09.",
      dayAfterTomorrowLabel: "Sa 05.09.",
      forecastTailLabel: "So–Di 06.–08.09.",
    }),
    [
      "- Heute (Do 03.09.), maximal 2 Paare: NW 8–16 kt (12:00); W 12–22 kt (18:00)",
      "- Morgen (Fr 04.09.), maximal 2 Paare: O 5–9 kt (06:00); SO 14–24 kt (15:00)",
      "- Übermorgen (Sa 05.09.), maximal 1 Paar: S 10–18 kt (12:00)",
      "- So–Di 06.–08.09., maximal 1 Paar je Tag und 3 insgesamt: 2026-09-06: SW 9–15 kt (12:00)",
    ].join("\n"),
  );
  assert.equal(
    buildWindScaffold(
      "2026-09-03 | 12:00 | NW |  | \n2026-09-03 | 15:00 | NW | 8 | 7",
      {
        todayLabel: "Do 03.09.",
        tomorrowLabel: "Fr 04.09.",
        dayAfterTomorrowLabel: "Sa 05.09.",
        forecastTailLabel: "So–Di 06.–08.09.",
      },
    ),
    "(kein belastbares Wind-Gerüst verfügbar)",
    "blank numeric fields and gusts below sustained wind must not enter the scaffold",
  );
}

function testCurrentHourTodayNormalization(): void {
  assert.equal(
    normalizeCurrentHourTodayStart(
      "- Heute (Do 03.09.): ab 20 Uhr S 7–8 kt.\n- Morgen (Fr 04.09.): S 5–11 kt.",
      20,
      10,
    ),
    "- Heute (Do 03.09.): ab jetzt S 7–8 kt.\n- Morgen (Fr 04.09.): S 5–11 kt.",
  );
  assert.equal(
    containsPastTodayContent("- Heute (Do 03.09.): ab 20:00 bedeckt.", 20, 10),
    true,
    "clock times without the word Uhr must still be checked against the request time",
  );
  assert.equal(
    containsPastTodayContent("- Heute (Do 03.09.): ab jetzt bedeckt.", 20, 10),
    false,
  );
}

function testConciseWindInterpretationContract(): void {
  assert.equal(
    hasConciseWindInterpretation([
      "- Heute (Do 03.09.): Bestes Windfenster bis Mitternacht mit NW 15–22 kt; danach nachlassend auf NW 10–19 kt.",
      "- Morgen (Fr 04.09.): Vormittags böiger NW 6–21 kt als beste Segelphase; danach deutlich schwächer.",
      "- Übermorgen (Sa 05.09.): Markantes kurzes N-Fenster mit 24–35 kt, danach nachlassend.",
      "- So–Di 06.–08.09.: So S 5–16 kt; Mo O 1–7 kt; Di S 11–19 kt.",
    ].join("\n")),
    true,
  );
  assert.equal(
    hasConciseWindInterpretation([
      "- Heute (Do 03.09.): NW 15–22 kt, danach NW 10–19 kt.",
      "- Morgen (Fr 04.09.): morgens NW 6–21 kt, mittags W 8–19 kt, nachmittags S 9–15 kt.",
      "- Übermorgen (Sa 05.09.): N 24–35 kt.",
      "- So–Di 06.–08.09.: So S 5–16 kt; Mo O 1–7 kt; Di S 11–19 kt.",
    ].join("\n")),
    false,
    "three chart values in one daily bullet must be rejected as transcription",
  );
  assert.equal(
    hasConciseWindInterpretation([
      "- Heute (Do 03.09.): Der nachlassende Druckgradient baut den Leitha-Kanalisierungseffekt bei NW 7–14 kt ab.",
      "- Morgen (Fr 04.09.): Morgens Flaute SW 3–6 kt, danach Leitha NW 10–17 kt; der Frontdurchgang dreht den Wind auf S 5–14 kt.",
      "- Übermorgen (Sa 05.09.): Der Kaltsektor spricht für erneuten Leithaeinsatz von NW 5–8 kt auf N 10–22 kt.",
      "- So–Di 06.–08.09.: So NW 5–16 kt; Mo S 6–13 kt; Di S 10–19 kt.",
    ].join("\n")),
    true,
    "an extra value may support a distinct local mechanism instead of merely transcribing the chart",
  );
  assert.equal(
    hasConciseWindInterpretation([
      "- Heute (Do 03.09.): NW 15–22 kt.",
      "- Morgen (Fr 04.09.): Spitze um 09 Uhr mit NW 6–21 kt.",
      "- Übermorgen (Sa 05.09.): N 24–35 kt.",
      "- So–Di 06.–08.09.: So S 5–16 kt; Mo O 1–7 kt; Di S 11–19 kt.",
    ].join("\n")),
    false,
    "peak-time chart narration must not pass the interpretation contract",
  );
}

function testGreeceWarningTranslationValidation(): void {
  assert.equal(
    isValidGreeceWarningTranslation("Heute ab 20:44 Uhr: S/O 4–9 kt; See 2 schwach bewegt."),
    false,
    "normal HNMS forecast wind must never be accepted as a storm warning",
  );
  assert.equal(
    isValidGreeceWarningTranslation("Gewittermöglichkeit im westlichen Teil."),
    true,
  );
  assert.equal(
    isValidGreeceWarningTranslation("Böen aus NO mit 35–40 Knoten möglich."),
    true,
  );
}

function testOfficialWarningRestoration(): void {
  const officialWarning = [
    "Sturmwarnung der LSZ: Böen aus S/SSO.",
    "Gültig bis Montag 06:00 Uhr; amtlichen Wortlaut vollständig beachten.",
  ].join("\n");
  const restored = ensureWarningFirst({
    sources: {
      nationalWarningCenter: { status: "integrated", label: "LSZ Burgenland" },
    },
    weatherPreprocessed: {
      local: {
        warnings: {
          checked: true,
          text_de: officialWarning,
        },
      },
    },
  } as unknown as AnalysisJson, [
    "- ⚠️ Sturmwarnung der LSZ: Böen aus S.",
    "Vom Modell verkürzte oder veränderte Fortsetzung.",
    "- Heute: ⚠️ Sturmphase mit 42 kt.",
  ].join("\n"));

  assert.equal(
    restored,
    `- ⚠️ ${officialWarning}\n- Heute: ⚠️ Sturmphase mit 42 kt.`,
    "the official warning must replace the model candidate verbatim without deleting a legitimate severe-wind forecast bullet",
  );

  const unbulletedForecasts = ensureWarningFirst({
    sources: {
      nationalWarningCenter: { status: "integrated", label: "LSZ Burgenland" },
    },
    weatherPreprocessed: {
      local: {
        warnings: {
          checked: true,
          text_de: "Aktuell: Keine Sturmwarnung der LSZ Burgenland",
        },
      },
    },
  } as unknown as AnalysisJson, [
    "Aktuell: Keine Sturmwarnung der LSZ Burgenland",
    "Heute (Di 01.09.): W 10–15 kt.",
    "Morgen (Mi 02.09.): W 8–12 kt.",
    "Übermorgen (Do 03.09.): NW 6–9 kt.",
    "Fr–So 04.–06.09.: Schwacher W-Wind.",
  ].join("\n"));
  assert.equal(
    unbulletedForecasts?.split("\n").length,
    5,
    "warning restoration must preserve all four LLM forecast lines even when they omit markdown hyphens",
  );
  assert.match(unbulletedForecasts ?? "", /Heute \(Di 01\.09\.\)/);
  assert.match(unbulletedForecasts ?? "", /Fr–So 04\.–06\.09\./);

  const genericDuplicate = ensureWarningFirst({
    sources: {
      nationalWarningCenter: { status: "integrated", label: "DHMZ Kroatien" },
    },
    weatherPreprocessed: {
      local: {
        warnings: {
          checked: true,
          text_de: "Aktuell: Böen aus NO mit 35–40 Knoten möglich.",
        },
      },
    },
  } as unknown as AnalysisJson, [
    "⚠️ Aktuell (01.09.): Im Norden sind stellenweise möglich.",
    "- Heute (Di 01.09.): NO 10–15 kt.",
    "- Morgen (Mi 02.09.): NO 8–12 kt.",
    "- Übermorgen (Do 03.09.): NW 6–9 kt.",
    "- Fr–So 04.–06.09.: Schwacher W-Wind.",
  ].join("\n"));
  assert.equal(
    genericDuplicate,
    "- ⚠️ Aktuell: Böen aus NO mit 35–40 Knoten möglich.\n"
      + "- Heute (Di 01.09.): NO 10–15 kt.\n"
      + "- Morgen (Mi 02.09.): NO 8–12 kt.\n"
      + "- Übermorgen (Do 03.09.): NW 6–9 kt.\n"
      + "- Fr–So 04.–06.09.: Schwacher W-Wind.",
    "a generic model warning candidate must not remain below the authoritative warning",
  );

  const warningInsideCalendarForecast = ensureWarningFirst({
    sources: {
      nationalWarningCenter: { status: "integrated", label: "DHMZ Kroatien" },
    },
    weatherPreprocessed: {
      local: {
        warnings: {
          checked: true,
          text_de: "Aktuell: Böen aus NO mit 35–40 Knoten möglich.",
        },
      },
    },
  } as unknown as AnalysisJson, [
    "- ⚠️ DHMZ-Warnung: Böen aus NO mit 35–40 Knoten.",
    "- Do 03.09. ab jetzt: NW 14–20 kt; DHMZ warnt küstennah vor 35–40 Knoten ⚠️; See leicht bewegt.",
    "- Fr 04.09.: N 4–9 kt.",
    "- Sa 05.09.: S 4–12 kt.",
    "- So–Di 06.–08.09.: W 3–7 kt.",
  ].join("\n")) ?? "";
  assert.match(warningInsideCalendarForecast, /Do 03\.09\. ab jetzt: NW 14–20 kt; See leicht bewegt\./);
  assert.equal(
    (warningInsideCalendarForecast.match(/35–40 Knoten/g) ?? []).length,
    1,
    "an embedded duplicate warning clause must be removed without deleting its calendar forecast",
  );
}

function testResolvedForecastExportFeedsCharts(): void {
  const start = Date.UTC(2026, 7, 30);
  const timestamps = Array.from({ length: 144 }, (_, index) =>
    new Date(start + index * 60 * 60 * 1000).toISOString().slice(0, 16)
  );
  const baseline = {
    source: "Open-Meteo Forecast API",
    timezone: "Europe/Vienna",
    sailingArea: {
      name: "Testrevier",
      coordinates: AREA.coordinates,
      hourly: {
        timestamps,
        windSpeedKt: timestamps.map(() => 10),
        gustKt: timestamps.map(() => 14),
        windDirDeg: timestamps.map(() => 90),
      },
    },
    city: {
      name: "Teststadt",
      coordinates: CITY.coordinates,
      url: "https://open-meteo.com/",
      hourly: {
        timestamps,
        temp2mC: timestamps.map(() => 20),
        dewPoint2mC: timestamps.map(() => 12),
        isDay: timestamps.map((_, index) => index % 24 >= 7 && index % 24 < 21 ? 1 : 0),
        cloudBaseM: timestamps.map(() => 1200),
        pressureMslHPa: timestamps.map(() => 1015),
        cloudCoverPct: timestamps.map(() => 30),
        cloudCoverLowPct: timestamps.map(() => 20),
        cloudCoverMidPct: timestamps.map(() => 10),
        cloudCoverHighPct: timestamps.map(() => 5),
        capeJkg: timestamps.map(() => 0),
        rainMm: timestamps.map(() => 0),
        precipProbabilityPct: timestamps.map(() => 10),
        weatherCode: timestamps.map(() => 1),
        cloudType: timestamps.map(() => "cumulus"),
      },
    },
  };
  const resolved = resolveLocalForecast({
    openMeteoForecast: baseline,
    structuredLocalForecasts: [
      {
        target: "wind",
        source: "Lokaler strukturierter Anbieter",
        timestamps: timestamps.slice(0, 24),
        windSpeedKt: timestamps.slice(0, 24).map(() => 25),
        gustKt: timestamps.slice(0, 24).map(() => 32),
        windDirDeg: timestamps.slice(0, 24).map(() => 135),
      },
      {
        target: "city",
        source: "Lokaler strukturierter Anbieter",
        timestamps: timestamps.slice(0, 24),
        temp2mC: timestamps.slice(0, 24).map(() => 30),
      },
    ],
  }, "HR");
  const section4Context = buildSection4WeatherContext(
    { openMeteoForecast: baseline, resolvedLocalForecast: resolved },
    "Europe/Vienna",
    new Date(start),
  ) as any;
  assert.equal(
    section4Context.days[0].summary.temperature.maxC,
    30,
    "section 4 must interpret the resolved local city forecast rather than the Open-Meteo baseline",
  );
  assert.equal(
    section4Context.days[0].summary.nighttimeMoisture.relativeSignal,
    "trocken",
    "section 4 should expose a dry-night signal when nighttime temperature stays well above dew point",
  );
  assert.equal(
    section4Context.days[0].summary.nighttimeMoisture.absoluteSignal,
    "angenehm",
    "section 4 should distinguish an ordinary absolute dew point from muggy air",
  );
  assert.doesNotMatch(
    JSON.stringify(section4Context),
    /dewPoint|Taupunkt|Spread|minTemperatureDewPointSpreadC/i,
    "section 4 should pass only the finished moisture signal, not the technical dew-point calculation",
  );
  assert.equal(
    hasForbiddenSection4Content("Abends klar, die Nacht bleibt feucht."),
    false,
    "natural moisture wording should remain allowed",
  );
  assert.equal(
    hasForbiddenSection4Content("Die Luft bleibt feucht (Taupunkt-Spread unter 2 °C)."),
    true,
    "technical dew-point explanations must be rejected",
  );
  const exported = getSanitizedAnalysisExport({
    meta: { app: "aiWindy", version: "test", requestDate: new Date(start).toISOString() },
    position: { userInput: "Testrevier", country: "Kroatien", countryCode: "HR" },
    sources: { windy: [], national: [], europe: [] },
    weatherRaw: {
      openMeteoForecast: baseline,
      resolvedLocalForecast: resolved,
    },
    weatherPreprocessed: { europe: {}, national: {}, local: {} },
    weatherOutput: {},
  } as unknown as AnalysisJson);
  const wind = extractSeaWindForecast(exported);
  const city = extractCityMeteogram(exported);
  assert.ok(wind, "the resolved forecast should survive export as a complete wind chart");
  assert.ok(city, "the resolved forecast should survive export as a complete city meteogram");
  assert.equal(wind.points.length, 48, "the exported wind chart should retain six days at three-hour cadence");
  assert.equal(city.points.length, 48, "the exported city meteogram should retain six days at three-hour cadence");
  assert.equal(wind.points[0].speed, 25, "the wind chart should show the structured local source where available");
  assert.equal(wind.points[8].speed, 10, "the wind chart should fall back to Open-Meteo after local coverage ends");
  assert.equal(city.points[0].temperature, 30, "the city meteogram should show the structured local source where available");
}

async function main(): Promise<void> {
  testIonianOffshoreAliases();
  testStandaloneSeaAreaClassification();
  testCloudTypeClassification();
  testSection4OutputContract();
  testSubstantiveTwoBulletSections();
  testCloudBaseEstimate();
  testCityMeteogramCloudBands();
  testSeaWindForecast();
  testCityMeteogramDewPointVisibility();
  testForecastExportPreservesRainTotals();
  testCityMeteogramVisualLayers();
  testMeteogramFormatting();
  testCityMeteogramDoesNotInventCloudsInEmptyBands();
  testCityMeteogramMalformedArrays();
  testResolvedLocalForecastPrecedence();
  testWindDirectionNormalization();
  testCurrentHourTodayNormalization();
  testConciseWindInterpretationContract();
  testGreeceWarningTranslationValidation();
  testOfficialWarningRestoration();
  testResolvedForecastExportFeedsCharts();
  await withFixedDate(async () => {
    testSection4DevelopmentSignals();
    testWindPeakTimingContext();
    await testInterpretationPromptContract();
    await testNationalCoverageAndPrecedence();
    await testUnsupportedAreaCoverage();
    await testFailedNationalProvidersStayTransparent();
    await testHnmsFailureIsNotAllClear();
    await testCroatiaEmptyAndFallbackWarnings();
  });
  console.log("weather regressions: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});