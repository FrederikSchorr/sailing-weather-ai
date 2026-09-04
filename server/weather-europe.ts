import Anthropic from "@anthropic-ai/sdk";
import type { AnalysisSources } from "./analysis-store.js";

// ── Image cache (URL-based, in-memory) ───────────────────────────────────────

const imageCache = new Map<string, { imageBase64: string; fetchedAt: number }>();
const IMAGE_CACHE_TTL = 3 * 3600 * 1000;
const METEONEWS_CACHE_TTL = 3 * 3600 * 1000;

interface MeteonewsCacheEntry {
  text: string;
  preprocessed?: string;
  fetchedAt: number;
}

let meteonewsCache: MeteonewsCacheEntry | null = null;

function logEuropeTiming(
  source: string,
  phase: string,
  startedAt: number,
  cacheHit: boolean,
): void {
  console.log("[weather-europe]", JSON.stringify({
    source,
    phase,
    durationMs: Date.now() - startedAt,
    cacheHit,
  }));
}

function getCachedImage(url: string): string | null {
  const entry = imageCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > IMAGE_CACHE_TTL) {
    imageCache.delete(url);
    return null;
  }
  return entry.imageBase64;
}

function setCachedImage(url: string, imageBase64: string): void {
  imageCache.set(url, { imageBase64, fetchedAt: Date.now() });
  for (const [key, val] of imageCache) {
    if (Date.now() - val.fetchedAt > IMAGE_CACHE_TTL) imageCache.delete(key);
  }
}

// ── HTML helper ───────────────────────────────────────────────────────────────

export function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Europe: meteonews.at ──────────────────────────────────────────────────────

export const METEONEWS_URL =
  "https://meteonews.at/de/Allgemeine_Lage/K33/Europa";

export async function fetchMeteonews(): Promise<string> {
  const startedAt = Date.now();
  if (
    meteonewsCache
    && Date.now() - meteonewsCache.fetchedAt <= METEONEWS_CACHE_TTL
  ) {
    logEuropeTiming("meteonews", "report", startedAt, true);
    return meteonewsCache.text;
  }
  meteonewsCache = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(METEONEWS_URL, {
        headers: { "User-Agent": "WindyWeatherApp/1.0", Accept: "text/html" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        console.warn(`Meteonews attempt ${attempt}: HTTP ${res.status}`);
      } else {
        const html = await res.text();

        const bulletinMatch =
          html.match(
            /class="[^"]*ModuleBulletinsGeneralSituation[^"]*"[^>]*>[\s\S]*?<div[^>]*class="[^"]*bulletin-wrap[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
          ) ||
          html.match(
            /<div[^>]*class="[^"]*bulletin-wrap[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
          );

        if (bulletinMatch) {
          const text = stripHtml(bulletinMatch[1]).trim();
          meteonewsCache = { text, fetchedAt: Date.now() };
          logEuropeTiming("meteonews", "report", startedAt, false);
          return text;
        }

        const plainText = stripHtml(html);
        const startIdx = plainText.indexOf("Europawetter");
        if (startIdx >= 0) {
          const text = plainText.slice(startIdx).trim();
          meteonewsCache = { text, fetchedAt: Date.now() };
          logEuropeTiming("meteonews", "report", startedAt, false);
          return text;
        }

        console.warn(
          `Meteonews attempt ${attempt}: no bulletin content found in response`,
        );
      }
    } catch (e) {
      console.warn(
        `Meteonews attempt ${attempt} failed:`,
        e instanceof Error ? e.message : e,
      );
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
  }
  console.error("Meteonews: all 3 attempts failed");
  logEuropeTiming("meteonews", "report", startedAt, false);
  return "";
}

// ── Shared time helpers ───────────────────────────────────────────────────────

/** Current ECMWF run: last elapsed 0/6/12/18 UTC slot */
export function currentRunHour(): number {
  return Math.floor(new Date().getUTCHours() / 6) * 6;
}

export function currentRunDate(): Date {
  const now = new Date();
  const run = currentRunHour();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), run));
}

/** Next 00 or 12 UTC that is at least 6 h in the future */
export function nextForecastTarget(): Date {
  const now = new Date();
  const minTime = now.getTime() + 6 * 60 * 60 * 1000;
  const y = now.getUTCFullYear(),
    mo = now.getUTCMonth(),
    d = now.getUTCDate();
  const candidates = [
    new Date(Date.UTC(y, mo, d, 12)),
    new Date(Date.UTC(y, mo, d + 1, 0)),
    new Date(Date.UTC(y, mo, d + 1, 12)),
  ];
  return candidates.find((c) => c.getTime() >= minTime) ?? candidates[2];
}

// ── Europe: KNMI Frontenkarte ─────────────────────────────────────────────────

export function buildKnmiChartUrl(): string {
  const now = new Date();
  const dayStr = now.getUTCDate().toString().padStart(2, "0");
  const chartHour = currentRunHour().toString().padStart(2, "0");
  return `https://cdn.knmi.nl/knmi/map/page/weer/waarschuwingen_verwachtingen/weerkaarten/AL${dayStr}${chartHour}_large.gif`;
}

export const KNMI_BASE_URL =
  "https://cdn.knmi.nl/knmi/map/page/weer/waarschuwingen_verwachtingen/weerkaarten";

export async function fetchKnmiChart(): Promise<{
  url: string;
  imageBase64: string;
} | null> {
  const startedAt = Date.now();
  const url = buildKnmiChartUrl();
  const dayStr = new Date().getUTCDate().toString().padStart(2, "0");
  const fallbackUrl = `${KNMI_BASE_URL}/AL${dayStr}00_large.gif`;
  try {
    const cached = getCachedImage(url);
    if (cached) {
      console.log(`[cache] KNMI chart hit: ${url}`);
      logEuropeTiming("knmi", "current-chart", startedAt, true);
      return { url, imageBase64: cached };
    }
    let res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });
    let usedUrl = url;
    if (!res.ok) {
      console.warn(
        `KNMI chart not found (${res.status}): ${url} → trying fallback`,
      );
      const cachedFb = getCachedImage(fallbackUrl);
      if (cachedFb) {
        console.log(`[cache] KNMI chart fallback hit: ${fallbackUrl}`);
        logEuropeTiming("knmi", "current-chart", startedAt, true);
        return { url: fallbackUrl, imageBase64: cachedFb };
      }
      res = await fetch(fallbackUrl, {
        signal: AbortSignal.timeout(10000),
        cache: "no-store",
      });
      usedUrl = fallbackUrl;
      if (!res.ok) {
        console.error(
          `KNMI chart fallback also failed (${res.status}): ${fallbackUrl}`,
        );
        return null;
      }
    }
    const imageBase64 = Buffer.from(await res.arrayBuffer()).toString("base64");
    setCachedImage(usedUrl, imageBase64);
    console.log(`[cache] KNMI chart stored: ${usedUrl}`);
    logEuropeTiming("knmi", "current-chart", startedAt, false);
    return { url: usedUrl, imageBase64 };
  } catch (e) {
    console.error(
      "KNMI chart fetch failed:",
      e instanceof Error ? e.message : e,
    );
    logEuropeTiming("knmi", "current-chart", startedAt, false);
    return null;
  }
}

// ── Europe: KNMI Frontenprognose ──────────────────────────────────────────────

export function buildKnmiForecastUrl(): string {
  const target = nextForecastTarget();
  const dd = target.getUTCDate().toString().padStart(2, "0");
  const hh = target.getUTCHours().toString().padStart(2, "0");
  return `${KNMI_BASE_URL}/PL${dd}${hh}_large.gif`;
}

export async function fetchKnmiForecast(): Promise<{
  url: string;
  imageBase64: string;
} | null> {
  const startedAt = Date.now();
  const url = buildKnmiForecastUrl();
  try {
    const cached = getCachedImage(url);
    if (cached) {
      console.log(`[cache] KNMI forecast hit: ${url}`);
      logEuropeTiming("knmi", "forecast-chart", startedAt, true);
      return { url, imageBase64: cached };
    }
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error(`KNMI forecast not found (${res.status}): ${url}`);
      return null;
    }
    const imageBase64 = Buffer.from(await res.arrayBuffer()).toString("base64");
    setCachedImage(url, imageBase64);
    console.log(`[cache] KNMI forecast stored: ${url}`);
    logEuropeTiming("knmi", "forecast-chart", startedAt, false);
    return { url, imageBase64 };
  } catch (e) {
    console.error(
      "KNMI forecast fetch failed:",
      e instanceof Error ? e.message : e,
    );
    logEuropeTiming("knmi", "forecast-chart", startedAt, false);
    return null;
  }
}

// ── Europe: Wetterzentrale 850 hPa ───────────────────────────────────────────

export const WETTERZENTRALE_BASE_URL =
  "https://www.wetterzentrale.de/de/topkarten.php?map=1&model=ecm&var=2&time=0&run=18&lid=OP&h=0&tr=6&mv=0";
const WZ_MAPS = "https://www.wetterzentrale.de/maps";

export function buildWetterzentraleCurrentUrl(): string {
  const run = currentRunHour().toString().padStart(2, "0");
  return `${WZ_MAPS}/ECMOPEU${run}_0_2.png`;
}

export function buildWetterzentraleForecastUrl(): string {
  const now = new Date();
  const run = currentRunHour();
  const runDate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), run),
  );
  const forecastTarget = nextForecastTarget();
  const offsetHours =
    (forecastTarget.getTime() - runDate.getTime()) / (3600 * 1000);
  const runStr = run.toString().padStart(2, "0");
  return `${WZ_MAPS}/ECMOPEU${runStr}_${offsetHours}_2.png`;
}

export async function fetchWetterzentraleChart(
  url: string,
): Promise<{ url: string; imageBase64: string } | null> {
  const startedAt = Date.now();
  const phase = url.includes("_0_2.png") ? "current-chart" : "forecast-chart";
  try {
    const cached = getCachedImage(url);
    if (cached) {
      console.log(`[cache] Wetterzentrale hit: ${url}`);
      logEuropeTiming("wetterzentrale", phase, startedAt, true);
      return { url, imageBase64: cached };
    }
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error(`Wetterzentrale chart not found (${res.status}): ${url}`);
      return null;
    }
    const imageBase64 = Buffer.from(await res.arrayBuffer()).toString("base64");
    setCachedImage(url, imageBase64);
    console.log(`[cache] Wetterzentrale stored: ${url}`);
    logEuropeTiming("wetterzentrale", phase, startedAt, false);
    return { url, imageBase64 };
  } catch (e) {
    console.error(
      "Wetterzentrale fetch failed:",
      e instanceof Error ? e.message : e,
    );
    logEuropeTiming("wetterzentrale", phase, startedAt, false);
    return null;
  }
}

// ── Preprocessing ─────────────────────────────────────────────────────────────

export async function preprocessMeteonews(
  text: string,
  anthropic: Anthropic,
  signal?: AbortSignal,
): Promise<string> {
  const startedAt = Date.now();
  if (
    meteonewsCache
    && meteonewsCache.text === text
    && meteonewsCache.preprocessed !== undefined
    && Date.now() - meteonewsCache.fetchedAt <= METEONEWS_CACHE_TTL
  ) {
    logEuropeTiming("meteonews", "interpretation", startedAt, true);
    return meteonewsCache.preprocessed;
  }
  const result = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: `Entferne aus diesem Europawetterbericht alle konkreten Temperaturangaben (z.B. "5 bis 14 Grad", "13 bis 20 Grad"). Behalte alle anderen Informationen über Drucklagen, Fronten, Niederschlag, Bewölkung und allgemeine Wettermuster unverändert. Gib nur den bereinigten Text zurück, ohne Kommentar.\n\n${text}`,
      },
    ],
  }, { signal });
  const preprocessed = result.content[0]?.type === "text"
    ? result.content[0].text.trim()
    : text;
  if (meteonewsCache?.text === text) {
    meteonewsCache.preprocessed = preprocessed;
  } else {
    meteonewsCache = { text, preprocessed, fetchedAt: Date.now() };
  }
  logEuropeTiming("meteonews", "interpretation", startedAt, false);
  return preprocessed;
}

// ── Europe sources ───────────────────────────────────────────────────────────

export function getEuropeSources(): AnalysisSources["europe"] {
  return [
    `Europawetter von [Meteonews](${METEONEWS_URL})`,
    `Bodendruck + 1.500m Luftmassen Karten von [Wetterzentrale](${WETTERZENTRALE_BASE_URL})`,
    `Wetterfronten Karten von [KNMI](https://www.knmi.nl/nederland-nu/weer/waarschuwingen-en-verwachtingen/weerkaarten)`,
  ];
}
