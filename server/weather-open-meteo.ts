export const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
export const OPEN_METEO_MARINE_URL = "https://marine-api.open-meteo.com/v1/marine";
export const OPEN_METEO_FORECAST_SOURCE_URL = "https://open-meteo.com/en/docs";
export const OPEN_METEO_MARINE_SOURCE_URL = "https://open-meteo.com/en/docs/marine-weather-api";

type Coordinates = { lat: number; lon: number };
export type OpenMeteoTarget = {
  name_de: string;
  coordinates: Coordinates;
};

// Sailing-area forecast covers wind only — wind is highly local (sheltered
// channels vs. open water can differ drastically), so it stays pinned to the
// precise sailing-area/sub-region coordinate. Everything else (temperature,
// pressure, clouds, rain, thunderstorm risk) is large-scale enough that the
// city coordinate is representative, and is fetched via CITY_HOURLY instead.
const FORECAST_HOURLY = [
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
];

const CITY_HOURLY = [
  "temperature_2m",
  "dew_point_2m",
  "is_day",
  "precipitation_probability",
  "rain",
  "weather_code",
  "cloud_cover",
  "cloud_cover_low",
  "cloud_cover_mid",
  "cloud_cover_high",
  "cape",
  "lifted_index",
  "freezing_level_height",
  "pressure_msl",
];

const MARINE_HOURLY = [
  "wave_height",
  "wave_direction",
  "wave_period",
  "wind_wave_height",
  "wind_wave_direction",
  "wind_wave_period",
  "swell_wave_height",
  "swell_wave_direction",
  "swell_wave_period",
];

const COUNTRY_TIMEZONES: Record<string, string> = {
  AL: "Europe/Tirane", AT: "Europe/Vienna", BE: "Europe/Brussels",
  CH: "Europe/Zurich", DE: "Europe/Berlin", DK: "Europe/Copenhagen",
  ES: "Europe/Madrid", FR: "Europe/Paris", GB: "Europe/London",
  GR: "Europe/Athens", HR: "Europe/Zagreb", IE: "Europe/Dublin",
  IT: "Europe/Rome", ME: "Europe/Podgorica", NL: "Europe/Amsterdam",
  NO: "Europe/Oslo", PL: "Europe/Warsaw", PT: "Europe/Lisbon",
  SE: "Europe/Stockholm", SI: "Europe/Ljubljana", TR: "Europe/Istanbul",
};

const DAY_NAMES = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

export function getOpenMeteoTimezone(countryCode: string): string {
  return COUNTRY_TIMEZONES[countryCode] ?? "Europe/Berlin";
}

function formatForecastSource(provided: string[]): string {
  const last = provided[provided.length - 1] ?? "Wetter";
  if (provided.length === 1) return `${last}vorhersage`;
  return `${provided.slice(0, -1).map(label => `${label}-`).join(", ")} und ${last}vorhersage`;
}

function buildUrl(
  endpoint: string,
  coordinates: Coordinates,
  timezone: string,
  hourly: string[],
  extras: Record<string, string> = {},
): string {
  const params = new URLSearchParams({
    latitude: String(coordinates.lat),
    longitude: String(coordinates.lon),
    timezone,
    forecast_days: "6",
    hourly: hourly.join(","),
    ...extras,
  });
  return `${endpoint}?${params.toString()}`;
}

async function fetchJson(url: string, label: string): Promise<Record<string, any> | null> {
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      console.error(`Open-Meteo ${label} failed (${response.status})`);
      return null;
    }
    const payload = await response.json() as Record<string, any>;
    if (!Array.isArray(payload.hourly?.time)) {
      console.error(`Open-Meteo ${label} returned no hourly data`);
      return null;
    }
    return payload;
  } catch (error) {
    console.error(`Open-Meteo ${label} error:`, error instanceof Error ? error.message : error);
    return null;
  }
}

function values(hourly: Record<string, any> | undefined, key: string): unknown[] | null {
  return Array.isArray(hourly?.[key]) ? hourly[key] : null;
}

// ── Cloud type classification ───────────────────────────────────────────────
//
// Open-Meteo has no direct cloud-genus field (confirmed against their docs).
// This derives a coarse type per hour from what we do have: the low/mid/high
// cloud-cover split, thunderstorm signals (weather_code, CAPE), and rain.
// Deliberately a deterministic rule table, not an LLM call — the underlying
// cloud_cover values are themselves approximated from relative humidity, so
// an LLM sees the same coarse numbers and would just add hallucination risk
// naming specific genera it can't actually verify. Any narrative text about
// sky conditions should be generated downstream from this label, the same
// way DOUGLAS_SCALE feeds the wave narrative.
export type CloudType =
  | "clear"
  | "cirrus"
  | "altostratus"
  | "cumulus"
  | "stratus"
  | "cumulonimbus"
  | "mixed";

const THUNDERSTORM_WEATHER_CODES = new Set([95, 96, 99]);

export function isThunderstormSignal(
  weatherCode: number | null,
  cloudType: CloudType | null,
): boolean {
  return cloudType === "cumulonimbus"
    || (weatherCode !== null && THUNDERSTORM_WEATHER_CODES.has(weatherCode));
}

export function classifyCloudType(input: {
  totalPct: number | null;
  lowPct: number | null;
  midPct: number | null;
  highPct: number | null;
  capeJkg: number | null;
  weatherCode: number | null;
  rainMm: number | null;
}): CloudType {
  const total = input.totalPct ?? 0;
  const low = input.lowPct ?? 0;
  const mid = input.midPct ?? 0;
  const high = input.highPct ?? 0;
  const cape = input.capeJkg ?? 0;
  const rain = input.rainMm ?? 0;

  if (total < 10) return "clear";

  // Cumulonimbus: an explicit thunderstorm code, or a convective column tall
  // enough to span low and high levels at once with strong instability.
  if (
    (input.weatherCode !== null && THUNDERSTORM_WEATHER_CODES.has(input.weatherCode))
    || (cape >= 1000 && low > 30 && high > 30)
  ) {
    return "cumulonimbus";
  }

  // Growing convective cloud that hasn't (yet) built into a full storm.
  if (cape >= 500 && low > 20 && mid < 40 && high < 20) {
    return "cumulus";
  }

  // Widespread single low layer with little instability and real rain —
  // typical frontal/layered rain rather than showers.
  if (low > 60 && mid < 30 && high < 20 && cape < 300 && rain > 0.2) {
    return "stratus";
  }

  // Fair-weather cumulus: modest low cover, clear aloft, no rain.
  if (low >= 10 && low <= 60 && mid < 15 && high < 15 && cape < 500) {
    return "cumulus";
  }

  // Mid-level-dominant deck (altocumulus/altostratus), little at other levels.
  if (mid > 40 && low < 20 && high < 20) {
    return "altostratus";
  }

  // High-only thin cover, nothing lower.
  if (high > 20 && low < 10 && mid < 10) {
    return "cirrus";
  }

  return "mixed";
}

function numberAt(arr: unknown[] | null, index: number): number | null {
  const value = arr?.[index];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Espy approximation for the lifting condensation level: the altitude at
// which a surface air parcel cools to its dew point and condenses. Standard
// meteorological estimate for convective cloud base, ~125m per °C of dew
// point depression (Fahrenheit/1000ft equivalent: 228ft per °F).
export function estimateCloudBaseM(tempC: number | null, dewPointC: number | null): number | null {
  if (tempC === null || dewPointC === null) return null;
  return Math.round(125 * (tempC - dewPointC));
}

function buildCloudBaseSeries(hourly: Record<string, any> | undefined): (number | null)[] | null {
  const timestamps = values(hourly, "time");
  if (!timestamps) return null;
  const temp = values(hourly, "temperature_2m");
  const dewPoint = values(hourly, "dew_point_2m");
  return timestamps.map((_, index) => estimateCloudBaseM(numberAt(temp, index), numberAt(dewPoint, index)));
}

function buildCloudTypeSeries(hourly: Record<string, any> | undefined): CloudType[] | null {
  const timestamps = values(hourly, "time");
  if (!timestamps) return null;
  const totalPct = values(hourly, "cloud_cover");
  const lowPct = values(hourly, "cloud_cover_low");
  const midPct = values(hourly, "cloud_cover_mid");
  const highPct = values(hourly, "cloud_cover_high");
  const capeJkg = values(hourly, "cape");
  const weatherCode = values(hourly, "weather_code");
  const rainMm = values(hourly, "rain");
  return timestamps.map((_, index) => classifyCloudType({
    totalPct: numberAt(totalPct, index),
    lowPct: numberAt(lowPct, index),
    midPct: numberAt(midPct, index),
    highPct: numberAt(highPct, index),
    capeJkg: numberAt(capeJkg, index),
    weatherCode: numberAt(weatherCode, index),
    rainMm: numberAt(rainMm, index),
  }));
}

function normalizeForecast(
  areaRaw: Record<string, any> | null,
  areaUrl: string,
  cityRaw: Record<string, any> | null,
  cityUrl: string,
  sailingArea: OpenMeteoTarget,
  city: OpenMeteoTarget,
  timezone: string,
): Record<string, unknown> {
  const areaHourly = areaRaw?.hourly;
  const cityHourly = cityRaw?.hourly;
  return {
    source: "Open-Meteo Forecast API",
    url: areaUrl,
    available: Boolean(areaRaw),
    fetchedAt: new Date().toISOString(),
    timezone: areaRaw?.timezone ?? timezone,
    latitude: areaRaw?.latitude ?? sailingArea.coordinates.lat,
    longitude: areaRaw?.longitude ?? sailingArea.coordinates.lon,
    hourlyUnits: areaRaw?.hourly_units ?? {},
    sailingArea: {
      name: sailingArea.name_de,
      coordinates: sailingArea.coordinates,
      hourly: areaRaw ? {
        timestamps: values(areaHourly, "time"),
        windSpeedKt: values(areaHourly, "wind_speed_10m"),
        windDirDeg: values(areaHourly, "wind_direction_10m"),
        gustKt: values(areaHourly, "wind_gusts_10m"),
      } : null,
    },
    city: {
      name: city.name_de,
      coordinates: city.coordinates,
      url: cityUrl,
      hourly: cityRaw ? {
        timestamps: values(cityHourly, "time"),
        temp2mC: values(cityHourly, "temperature_2m"),
        dewPoint2mC: values(cityHourly, "dew_point_2m"),
        isDay: values(cityHourly, "is_day"),
        cloudBaseM: buildCloudBaseSeries(cityHourly),
        pressureMslHPa: values(cityHourly, "pressure_msl"),
        cloudCoverPct: values(cityHourly, "cloud_cover"),
        cloudCoverLowPct: values(cityHourly, "cloud_cover_low"),
        cloudCoverMidPct: values(cityHourly, "cloud_cover_mid"),
        cloudCoverHighPct: values(cityHourly, "cloud_cover_high"),
        rainMm: values(cityHourly, "rain"),
        precipProbabilityPct: values(cityHourly, "precipitation_probability"),
        weatherCode: values(cityHourly, "weather_code"),
        capeJkg: values(cityHourly, "cape"),
        liftedIndex: values(cityHourly, "lifted_index"),
        freezingLevelM: values(cityHourly, "freezing_level_height"),
        cloudType: buildCloudTypeSeries(cityHourly),
      } : null,
    },
  };
}

function hasUsableWaves(raw: Record<string, any> | null): boolean {
  return Array.isArray(raw?.hourly?.wave_height)
    && raw.hourly.wave_height.some((value: unknown) =>
      typeof value === "number" && Number.isFinite(value),
    );
}

function hasUsableTemperature(raw: Record<string, any> | null): boolean {
  return Array.isArray(raw?.hourly?.temperature_2m)
    && raw.hourly.temperature_2m.some((value: unknown) =>
      typeof value === "number" && Number.isFinite(value),
    );
}

function normalizeMarine(
  raw: Record<string, any> | null,
  url: string,
  sailingArea: OpenMeteoTarget,
  timezone: string,
): Record<string, unknown> {
  const hourly = raw?.hourly;
  return {
    source: "Open-Meteo Marine API",
    url,
    available: hasUsableWaves(raw),
    fetchedAt: new Date().toISOString(),
    timezone: raw?.timezone ?? timezone,
    latitude: raw?.latitude ?? sailingArea.coordinates.lat,
    longitude: raw?.longitude ?? sailingArea.coordinates.lon,
    hourlyUnits: raw?.hourly_units ?? {},
    sailingArea: {
      name: sailingArea.name_de,
      coordinates: sailingArea.coordinates,
      hourly: hasUsableWaves(raw) ? {
        timestamps: values(hourly, "time"),
        waveHeightM: values(hourly, "wave_height"),
        waveDirDeg: values(hourly, "wave_direction"),
        wavePeriodS: values(hourly, "wave_period"),
        windWaveHeightM: values(hourly, "wind_wave_height"),
        windWaveDirDeg: values(hourly, "wind_wave_direction"),
        windWavePeriodS: values(hourly, "wind_wave_period"),
        swellHeightM: values(hourly, "swell_wave_height"),
        swellDirDeg: values(hourly, "swell_wave_direction"),
        swellPeriodS: values(hourly, "swell_wave_period"),
      } : null,
    },
  };
}

export async function fetchOpenMeteoWeather(
  sailingArea: OpenMeteoTarget,
  city: OpenMeteoTarget,
  timezone: string,
  onProgress?: (status: string) => void,
): Promise<{ data: Record<string, unknown>; sourceUrls: string[] }> {
  const forecastUrl = buildUrl(
    OPEN_METEO_FORECAST_URL,
    sailingArea.coordinates,
    timezone,
    FORECAST_HOURLY,
    { wind_speed_unit: "kn" },
  );
  const cityUrl = buildUrl(
    OPEN_METEO_FORECAST_URL,
    city.coordinates,
    timezone,
    CITY_HOURLY,
  );
  const marineUrl = buildUrl(
    OPEN_METEO_MARINE_URL,
    sailingArea.coordinates,
    timezone,
    MARINE_HOURLY,
  );

  onProgress?.("Lade lokale Sechs-Tage-Prognose von Open-Meteo");
  const [forecastRaw, cityRaw, marineRaw] = await Promise.all([
    fetchJson(forecastUrl, "Forecast"),
    fetchJson(cityUrl, "Temperatur"),
    fetchJson(marineUrl, "Marine"),
  ]);

  const sourceUrls: string[] = [];
  if (forecastRaw) {
    sourceUrls.push(
      `Lokale Windvorhersage von [Open-Meteo Forecast API](${OPEN_METEO_FORECAST_SOURCE_URL})`,
    );
  }
  if (hasUsableTemperature(cityRaw)) {
    const provided = ["Temperatur", "Taupunkt", "Druck", "Wolken", "Regen", "Gewitter"];
    sourceUrls.push(
      `Lokale ${formatForecastSource(provided)} für die Stadt von [Open-Meteo Forecast API](${OPEN_METEO_FORECAST_SOURCE_URL})`,
    );
  }
  if (hasUsableWaves(marineRaw)) {
    sourceUrls.push(
      `Lokale Wellen- und Dünungsvorhersage von [Open-Meteo Marine API](${OPEN_METEO_MARINE_SOURCE_URL})`,
    );
  }

  return {
    data: {
      openMeteoForecast: normalizeForecast(
        forecastRaw,
        forecastUrl,
        cityRaw,
        cityUrl,
        sailingArea,
        city,
        timezone,
      ),
      openMeteoMarine: normalizeMarine(marineRaw, marineUrl, sailingArea, timezone),
    },
    sourceUrls,
  };
}

function localDateHour(timestamp: string, timezone: string): {
  dateKey: string;
  label: string;
  hour: number;
} {
  const plain = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):/.exec(timestamp);
  if (plain && !/(Z|[+-]\d{2}:?\d{2})$/i.test(timestamp)) {
    const [, year, month, day, hour] = plain;
    const dateKey = `${year}-${month}-${day}`;
    const weekday = new Date(`${dateKey}T12:00:00Z`).getUTCDay();
    return { dateKey, label: `${DAY_NAMES[weekday]} ${day}.${month}`, hour: Number(hour) };
  }
  const date = new Date(timestamp);
  const dateKey = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone }).format(date);
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: timezone,
    }).format(date),
  ) % 24;
  const [year, month, day] = dateKey.split("-");
  const weekday = new Date(`${year}-${month}-${day}T12:00:00Z`).getUTCDay();
  return { dateKey, label: `${DAY_NAMES[weekday]} ${day}.${month}`, hour };
}

function currentLocalDateHour(timezone: string, now = new Date()): { dateKey: string; hour: number } {
  return {
    dateKey: new Intl.DateTimeFormat("sv-SE", { timeZone: timezone }).format(now),
    hour: Number(
      new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        hour12: false,
        timeZone: timezone,
      }).format(now),
    ) % 24,
  };
}

type Section4WeatherRow = {
  dateKey: string;
  label: string;
  hour: number;
  temperatureC: number | null;
  dewPointC: number | null;
  pressureHPa: number | null;
  rainMm: number | null;
  precipitationProbabilityPct: number | null;
  weatherCode: number | null;
  cloudType: CloudType | null;
  thunderstormSignal: boolean;
};

type TimedChange = {
  from: string;
  to: string;
  change: number;
};

function validCloudType(value: unknown): CloudType | null {
  return value === "clear"
    || value === "cirrus"
    || value === "altostratus"
    || value === "cumulus"
    || value === "stratus"
    || value === "cumulonimbus"
    || value === "mixed"
    ? value
    : null;
}

function roundTo(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function stepChange(
  rows: Section4WeatherRow[],
  select: (row: Section4WeatherRow) => number | null,
  direction: "drop" | "rise",
): TimedChange | null {
  let result: TimedChange | null = null;
  let previous: { hour: number; value: number } | null = null;
  for (const row of rows) {
    const value = select(row);
    if (value === null) continue;
    if (previous) {
      const change = value - previous.value;
      const isBetter = direction === "drop"
        ? change < (result?.change ?? 0)
        : change > (result?.change ?? 0);
      if (isBetter) {
        result = {
          from: formatHour(previous.hour),
          to: formatHour(row.hour),
          change: roundTo(change),
        };
      }
    }
    previous = { hour: row.hour, value };
  }
  return result;
}

function rainPeriods(rows: Section4WeatherRow[]): Array<{
  period: string;
  totalMm: number;
  peakMm: number;
}> {
  const periods: Array<{ period: string; totalMm: number; peakMm: number }> = [];
  let active: { start: number; end: number; total: number; peak: number } | null = null;
  const close = () => {
    if (!active) return;
    periods.push({
      period: active.start === active.end
        ? formatHour(active.start)
        : `${formatHour(active.start)}–${formatHour(active.end)}`,
      totalMm: roundTo(active.total),
      peakMm: roundTo(active.peak),
    });
    active = null;
  };

  for (const row of rows) {
    const rain = row.rainMm ?? 0;
    if (rain > 0.05) {
      if (!active) active = { start: row.hour, end: row.hour, total: 0, peak: 0 };
      active.end = row.hour;
      active.total += rain;
      active.peak = Math.max(active.peak, rain);
    } else {
      close();
    }
  }
  close();
  return periods;
}

function summarizeSection4Day(rows: Section4WeatherRow[]): Record<string, unknown> {
  const temperatures = rows
    .map(row => row.temperatureC)
    .filter((value): value is number => value !== null);
  const pressures = rows
    .map(row => row.pressureHPa)
    .filter((value): value is number => value !== null);
  const rain = rows
    .map(row => row.rainMm)
    .filter((value): value is number => value !== null);
  const thunderstormTimes = rows
    .filter(row => row.thunderstormSignal)
    .map(row => formatHour(row.hour));
  const cloudTypes = Array.from(new Set(
    rows
      .map(row => row.cloudType)
      .filter((value): value is CloudType => value !== null),
  ));
  const nighttimeDewPointSpreads = rows
    .filter(row => row.hour >= 21 || row.hour < 7)
    .map(row => row.temperatureC !== null && row.dewPointC !== null
      ? row.temperatureC - row.dewPointC
      : null)
    .filter((value): value is number => value !== null && value >= 0);

  const temperatureStart = temperatures[0] ?? null;
  const temperatureEnd = temperatures.at(-1) ?? null;
  const pressureStart = pressures[0] ?? null;
  const pressureEnd = pressures.at(-1) ?? null;

  return {
    temperature: temperatures.length ? {
      minC: roundTo(Math.min(...temperatures)),
      maxC: roundTo(Math.max(...temperatures)),
      startC: roundTo(temperatureStart!),
      endC: roundTo(temperatureEnd!),
      changeC: roundTo(temperatureEnd! - temperatureStart!),
      steepestDrop: stepChange(rows, row => row.temperatureC, "drop"),
      steepestRise: stepChange(rows, row => row.temperatureC, "rise"),
    } : null,
    nighttimeMoisture: nighttimeDewPointSpreads.length ? {
      signal: Math.min(...nighttimeDewPointSpreads) <= 2
        ? "feucht"
        : Math.min(...nighttimeDewPointSpreads) >= 5
          ? "trocken"
          : "neutral",
    } : null,
    pressure: pressures.length ? {
      minHPa: roundTo(Math.min(...pressures)),
      maxHPa: roundTo(Math.max(...pressures)),
      startHPa: roundTo(pressureStart!),
      endHPa: roundTo(pressureEnd!),
      changeHPa: roundTo(pressureEnd! - pressureStart!),
      significant: Math.max(...pressures) - Math.min(...pressures) >= 4,
      steepestDrop: stepChange(rows, row => row.pressureHPa, "drop"),
      steepestRise: stepChange(rows, row => row.pressureHPa, "rise"),
    } : null,
    rain: rain.length ? {
      totalMm: roundTo(rain.reduce((sum, value) => sum + value, 0)),
      peakIntervalMm: roundTo(Math.max(...rain)),
      periods: rainPeriods(rows),
    } : null,
    cloudTypes,
    thunderstorm: {
      signal: thunderstormTimes.length > 0,
      times: thunderstormTimes,
    },
  };
}

export function buildSection4WeatherContext(
  rawData: Record<string, unknown>,
  timezone: string,
  referenceTime = new Date(),
): Record<string, unknown> | null {
  const forecast = (rawData["resolvedLocalForecast"] ?? rawData["openMeteoForecast"]) as any;
  const city = forecast?.city;
  const hourly = city?.hourly;
  if (!Array.isArray(hourly?.timestamps)) return null;

  const reference = currentLocalDateHour(timezone, referenceTime);
  const byDate = new Map<string, Section4WeatherRow[]>();
  for (let index = 0; index < hourly.timestamps.length; index++) {
    const timestamp = hourly.timestamps[index];
    if (typeof timestamp !== "string") continue;
    const local = localDateHour(timestamp, timezone);
    if (local.dateKey < reference.dateKey) continue;
    const weatherCode = numberAt(hourly.weatherCode, index);
    const cloudType = validCloudType(hourly.cloudType?.[index]);
    const row: Section4WeatherRow = {
      dateKey: local.dateKey,
      label: local.label,
      hour: local.hour,
      temperatureC: numberAt(hourly.temp2mC, index),
      dewPointC: numberAt(hourly.dewPoint2mC, index),
      pressureHPa: numberAt(hourly.pressureMslHPa, index),
      rainMm: numberAt(hourly.rainMm, index),
      precipitationProbabilityPct: numberAt(hourly.precipProbabilityPct, index),
      weatherCode,
      cloudType,
      thunderstormSignal: isThunderstormSignal(weatherCode, cloudType),
    };
    const rows = byDate.get(local.dateKey) ?? [];
    rows.push(row);
    byDate.set(local.dateKey, rows);
  }

  const days = Array.from(byDate.values()).slice(0, 6).map((allRows, index) => {
    const futureRows = index === 0 && allRows[0]?.dateKey === reference.dateKey
      ? allRows.filter(row => row.hour >= reference.hour)
      : allRows;
    const rows = futureRows.length ? futureRows : allRows.slice(-1);
    return {
      label: allRows[0]?.label ?? "",
      date: allRows[0]?.dateKey ?? "",
      detailLevel: index === 0 ? "granular" : index === 1 ? "reduced" : "overview",
      summary: summarizeSection4Day(rows),
      timeline: index < 2
        ? rows.map(row => ({
          time: formatHour(row.hour),
          temperatureC: row.temperatureC,
          pressureHPa: row.pressureHPa,
          rainMm: row.rainMm,
          precipitationProbabilityPct: row.precipitationProbabilityPct,
          weatherCode: row.weatherCode,
          cloudType: row.cloudType,
          thunderstormSignal: row.thunderstormSignal,
        }))
        : undefined,
    };
  });

  if (!days.length) return null;
  return {
    source: "Open-Meteo Forecast API",
    city: city?.name ?? null,
    coordinates: city?.coordinates ?? null,
    timezone,
    referenceLocalTime: {
      date: reference.dateKey,
      hour: formatHour(reference.hour),
    },
    days,
  };
}

function compass(degrees: unknown): string {
  const directions = ["N", "NO", "O", "SO", "S", "SW", "W", "NW"];
  return typeof degrees === "number" && Number.isFinite(degrees)
    ? directions[Math.round(degrees / 45) % directions.length]
    : "?";
}

function finiteNumbers(values: unknown[]): number[] {
  return values.filter((value): value is number =>
    typeof value === "number" && Number.isFinite(value),
  );
}

function range(values: number[]): string | null {
  if (!values.length) return null;
  return `${Math.round(Math.min(...values))}–${Math.round(Math.max(...values))}`;
}

function mostFrequent(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "?";
}

function windDayPeriod(hour: number): string {
  if (hour < 6 || hour >= 22) return "nachts";
  if (hour < 10) return "morgens";
  if (hour < 14) return "mittags";
  if (hour < 18) return "nachmittags";
  return "abends";
}

const DOUGLAS_SCALE: Array<{ max: number; label: string }> = [
  { max: 0, label: "0 glatt" },
  { max: 0.1, label: "1 ruhig" },
  { max: 0.5, label: "2 schwach bewegt" },
  { max: 1.25, label: "3 leicht bewegt" },
  { max: 2.5, label: "4 mäßig bewegt" },
  { max: 4, label: "5 grob" },
  { max: 6, label: "6 sehr grob" },
  { max: 9, label: "7 hoch" },
  { max: 14, label: "8 sehr hoch" },
  { max: Infinity, label: "9 phänomenal" },
];

function douglas(height: number): string {
  return DOUGLAS_SCALE.find(entry => height <= entry.max)?.label ?? "9 phänomenal";
}

function cloudDescription(avgCloud: number): string {
  if (avgCloud < 20) return "klar bis sonnig";
  if (avgCloud < 50) return "leicht bis wechselnd bewölkt";
  if (avgCloud < 80) return "wechselnd bis stark bewölkt";
  return "meist stark bewölkt";
}

export function preprocessOpenMeteoLocal(
  rawData: Record<string, unknown>,
  timezone: string,
): Record<string, unknown> {
  const forecast = (rawData["resolvedLocalForecast"] ?? rawData["openMeteoForecast"]) as any;
  const marine = rawData["openMeteoMarine"] as any;
  const hourly = forecast?.sailingArea?.hourly;
  const cityHourly = forecast?.city?.hourly;
  const forecastUrl = forecast?.url ?? null;
  const cityForecastUrl = forecast?.city?.url ?? forecastUrl;
  const marineUrl = marine?.url ?? null;
  const sailingArea = forecast?.sailingArea?.name ?? null;
  const city = forecast?.city?.name ?? null;
  const cityCoordinates = forecast?.city?.coordinates ?? null;
  const empty = {
    wind: {
      source: forecast?.sailingArea?.source ?? "Open-Meteo Forecast API",
      url: forecastUrl,
      sailingArea,
      text_de: null,
      hourlyText_de: null,
    },
    wave: { source: "Open-Meteo Marine API", url: marineUrl, sailingArea, text_de: null },
    cloudRainThunderstorm: {
      source: forecast?.city?.source ?? "Open-Meteo Forecast API",
      url: cityForecastUrl,
      city,
      coordinates: cityCoordinates,
      text_de: null,
    },
    temperature: { source: "Open-Meteo Forecast API", url: forecastUrl, city, text_de: null },
  };
  if (!Array.isArray(hourly?.timestamps) && !Array.isArray(cityHourly?.timestamps)) return empty;

  const now = currentLocalDateHour(timezone);
  type WindRow = { label: string; dateKey: string; hour: number; speed: number; gust: number; direction: string };
  type WeatherRow = {
    label: string;
    dateKey: string;
    cloud: number;
    rain: number;
    weatherCode: number | null;
    cloudType: CloudType | null;
  };
  const windDays = new Map<string, WindRow[]>();
  const weatherDays = new Map<string, WeatherRow[]>();

  if (Array.isArray(hourly?.timestamps)) for (let index = 0; index < hourly.timestamps.length; index++) {
    const timestamp = hourly.timestamps[index];
    if (typeof timestamp !== "string") continue;
    const local = localDateHour(timestamp, timezone);
    const speed = hourly.windSpeedKt?.[index];
    if (typeof speed === "number" && Number.isFinite(speed)) {
      if (!(local.dateKey === now.dateKey && local.hour < now.hour)) {
        const rows = windDays.get(local.dateKey) ?? [];
        rows.push({
          label: local.label,
          dateKey: local.dateKey,
          hour: local.hour,
          speed,
          gust: typeof hourly.gustKt?.[index] === "number" ? hourly.gustKt[index] : speed,
          direction: compass(hourly.windDirDeg?.[index]),
        });
        windDays.set(local.dateKey, rows);
      }
    }
  }

  if (Array.isArray(cityHourly?.timestamps)) for (let index = 0; index < cityHourly.timestamps.length; index++) {
    const timestamp = cityHourly.timestamps[index];
    if (typeof timestamp !== "string") continue;
    const local = localDateHour(timestamp, timezone);
    const cloud = cityHourly.cloudCoverPct?.[index];
    const rain = cityHourly.rainMm?.[index];
    if (typeof cloud === "number" && typeof rain === "number") {
      const rows = weatherDays.get(local.dateKey) ?? [];
      const weatherCode = typeof cityHourly.weatherCode?.[index] === "number"
        ? cityHourly.weatherCode[index]
        : null;
      rows.push({
        label: local.label,
        dateKey: local.dateKey,
        cloud,
        rain,
        weatherCode,
        cloudType: validCloudType(cityHourly.cloudType?.[index]),
      });
      weatherDays.set(local.dateKey, rows);
    }
  }

  let gustySummaryUsed = false;
  const hourlyWindText = Array.from(windDays.values()).slice(0, 6).flatMap(rows =>
    rows.map(row =>
      `${row.label} | ${String(row.hour).padStart(2, "0")}:00 | ${row.direction} | ${Math.round(row.speed)} | ${Math.round(row.gust)}`,
    ),
  ).join("\n");
  const windText = Array.from(windDays.values()).slice(0, 6).map(rows => {
    const strongestGustIndex = rows.reduce(
      (strongestIndex, row, index) =>
        row.gust > rows[strongestIndex].gust ? index : strongestIndex,
      0,
    );
    const strongestWindIndex = rows.reduce(
      (strongestIndex, row, index) =>
        row.speed > rows[strongestIndex].speed ? index : strongestIndex,
      0,
    );
    const sampleIndexes = new Set([
      0,
      rows.length - 1,
      strongestGustIndex,
      strongestWindIndex,
    ]);
    const sampleStep = Math.max(1, Math.round(rows.length / 3));
    for (let index = sampleStep; index < rows.length - 1; index += sampleStep) {
      sampleIndexes.add(index);
    }
    const samples = rows.filter((_, index) => sampleIndexes.has(index)).slice(0, 6).map(row =>
      `${String(row.hour).padStart(2, "0")}:00 ${row.direction} Wind ${Math.round(row.speed)}-${Math.round(row.gust)} kt`,
    );
    const speeds = finiteNumbers(rows.map(row => row.speed));
    const gustSpreads = rows.map(row => row.gust - row.speed);
    const gusty = !gustySummaryUsed
      && gustSpreads.filter(spread => spread >= 10).length >= 3
      && Math.max(...gustSpreads) >= 12;
    if (gusty) gustySummaryUsed = true;
    return `${rows[0].label}: ${samples.join(", ")}; Wind ${range(speeds) ?? "?"} kt, vorherrschend ${mostFrequent(rows.map(row => row.direction))}${gusty ? "; böig" : ""}.`;
  }).join("\n");

  const cloudText = Array.from(weatherDays.values()).slice(0, 6).map(rows => {
    const avgCloud = rows.reduce((sum, row) => sum + row.cloud, 0) / rows.length;
    const rain = rows.reduce((sum, row) => sum + row.rain, 0);
    const thunderstorm = rows.some(row =>
      isThunderstormSignal(row.weatherCode, row.cloudType),
    );
    return `${rows[0].label}: ${cloudDescription(avgCloud)}, ${rain >= 0.2 ? `${rain.toFixed(1)} mm Regen` : "trocken"}${thunderstorm ? ", Gewitterrisiko" : ", kein Gewitterrisiko"}.`;
  }).join("\n");

  const marineHourly = marine?.sailingArea?.hourly;
  const waveDays = new Map<string, Array<{ label: string; dateKey: string; hour: number; height: number }>>();
  if (Array.isArray(marineHourly?.timestamps) && Array.isArray(marineHourly?.waveHeightM)) {
    for (let index = 0; index < marineHourly.timestamps.length; index++) {
      const timestamp = marineHourly.timestamps[index];
      const height = marineHourly.waveHeightM[index];
      if (typeof timestamp !== "string" || typeof height !== "number" || !Number.isFinite(height)) continue;
      const local = localDateHour(timestamp, timezone);
      if (local.dateKey === now.dateKey && local.hour < now.hour) continue;
      const rows = waveDays.get(local.dateKey) ?? [];
      rows.push({ label: local.label, dateKey: local.dateKey, hour: local.hour, height });
      waveDays.set(local.dateKey, rows);
    }
  }
  const waveText = Array.from(waveDays.values()).slice(0, 2).map(rows => {
    const representative = Math.max(...rows.map(row => row.height));
    return `${rows[0].label}: See ${douglas(representative)}.`;
  }).join("\n");

  const temperatureDays = new Map<string, { label: string; values: number[] }>();
  if (Array.isArray(cityHourly?.timestamps) && Array.isArray(cityHourly?.temp2mC)) {
    for (let index = 0; index < cityHourly.timestamps.length; index++) {
      const timestamp = cityHourly.timestamps[index];
      const temperature = cityHourly.temp2mC[index];
      if (typeof timestamp !== "string" || typeof temperature !== "number" || !Number.isFinite(temperature)) continue;
      const local = localDateHour(timestamp, timezone);
      const entry = temperatureDays.get(local.dateKey) ?? { label: local.label, values: [] };
      entry.values.push(temperature);
      temperatureDays.set(local.dateKey, entry);
    }
  }
  const temperatureText = Array.from(temperatureDays.values()).slice(0, 3).map(day =>
    `${day.label}: ${range(day.values)}°C`,
  ).join("\n");

  return {
    wind: {
      ...empty.wind,
      text_de: windText || null,
      hourlyText_de: hourlyWindText || null,
    },
    wave: { ...empty.wave, text_de: waveText || null },
    cloudRainThunderstorm: {
      ...empty.cloudRainThunderstorm,
      text_de: cloudText || null,
    },
    temperature: { ...empty.temperature, text_de: temperatureText || null },
  };
}