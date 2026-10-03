import Anthropic from "@anthropic-ai/sdk";
import sailingAreasJson from "../data/sailingareas.json" with { type: "json" };
import countriesJson from "../data/countries.json" with { type: "json" };
import windyModelsJson from "../data/windymodels.json" with { type: "json" };
import { cacheGet, cacheSet } from "./cache-db.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface SegelRevier {
  deutsch: string;
  typ: "meer" | "see";
  lat: number;
  lon: number;
  orte: string;
  windyModel: string;
  [key: string]: unknown;
}

export interface RevierResult {
  kind: "revier";
  revier: SegelRevier;
  land: string;
  countryCode: string;
  city: string;
}

export interface CityOnlyResult {
  kind: "city";
  city: string;
}

export type DetectLocationResult = RevierResult | CityOnlyResult | null;

/** @deprecated use DetectLocationResult */
export type DetectedRevier = RevierResult;

export interface LocationCacheEntry {
  sailingArea: string | null;
  city: string;
  cityLat: number;
  cityLon: number;
  displayName: string;
  countryCode: string;
}

function normalizeKey(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function getCachedLocation(userInput: string): Promise<LocationCacheEntry | undefined> {
  try {
    const raw = await cacheGet(`loc:${normalizeKey(userInput)}`);
    if (raw) {
      const entry = JSON.parse(raw) as LocationCacheEntry;
      console.log(`[location-cache] DB HIT "${userInput}" → ${entry.city} (${entry.cityLat.toFixed(4)}, ${entry.cityLon.toFixed(4)})`);
      return entry;
    }
  } catch (e) {
    console.warn("[location-cache] DB read error:", e);
  }
  return undefined;
}

export async function setCachedLocation(userInput: string, entry: LocationCacheEntry): Promise<void> {
  try {
    await cacheSet(`loc:${normalizeKey(userInput)}`, JSON.stringify(entry));
    console.log(`[location-cache] DB SAVED "${normalizeKey(userInput)}" → ${entry.city} (${entry.cityLat.toFixed(4)}, ${entry.cityLon.toFixed(4)})`);
  } catch (e) {
    console.warn("[location-cache] DB write error:", e);
  }
}

/** Shared geocode result — compatible with the existing geocodeLocation() shape */
export interface GeocodedLocation {
  lat: number;
  lon: number;
  displayName: string;
  countryCode: string;
  country: string; // German country name, e.g. "Kroatien"
  // Sailing-area fields (null when no revier found)
  sailingArea: string | null;
  type: "sea" | "lake" | null;
  // When no revier: Nominatim city name
  location: string | null;
  // For downstream model selection (filled later in routes.ts)
  regionalModel: string;
  regionalModelLabel: string;
  // Original user input
  userInput: string;
}

// ── Country mapping ────────────────────────────────────────────────────────

export const LAND_TO_COUNTRY_CODE: Record<string, string> = {
  Albanien: "AL",
  Belgien: "BE",
  Deutschland: "DE",
  Dänemark: "DK",
  Frankreich: "FR",
  Griechenland: "GR",
  Irland: "IE",
  Italien: "IT",
  Kroatien: "HR",
  Montenegro: "ME",
  Niederlande: "NL",
  Norwegen: "NO",
  Österreich: "AT",
  Portugal: "PT",
  Schweden: "SE",
  Schweiz: "CH",
  Slowenien: "SI",
  Spanien: "ES",
  Türkei: "TR",
  "Vereinigtes Königreich": "GB",
};

export const COUNTRY_CODE_TO_FLAG: Record<string, string> = {
  AL: "🇦🇱",
  BE: "🇧🇪",
  DE: "🇩🇪",
  DK: "🇩🇰",
  FR: "🇫🇷",
  GR: "🇬🇷",
  IE: "🇮🇪",
  IT: "🇮🇹",
  HR: "🇭🇷",
  ME: "🇲🇪",
  NL: "🇳🇱",
  NO: "🇳🇴",
  AT: "🇦🇹",
  PT: "🇵🇹",
  SE: "🇸🇪",
  CH: "🇨🇭",
  SI: "🇸🇮",
  ES: "🇪🇸",
  TR: "🇹🇷",
  GB: "🇬🇧",
};

// ── JSON loading ───────────────────────────────────────────────────────────

type SegelreviereData = Record<string, { reviere: SegelRevier[] }>;

function loadSegelreviere(): SegelreviereData {
  return sailingAreasJson as unknown as SegelreviereData;
}

const SAILING_AREA_ALIASES: Record<string, { sailingArea: string; city: string }> = {
  "ionisches meer": {
    sailingArea: "Ionisches Meer Nord Offshore (Griechenland)",
    city: "Lefkada",
  },
  "ionisches meer nord": {
    sailingArea: "Ionisches Meer Nord Offshore (Griechenland)",
    city: "Lefkada",
  },
};

export function resolveSailingAreaAlias(locationName: string): DetectLocationResult {
  const alias = SAILING_AREA_ALIASES[normalizeKey(locationName)];
  if (!alias) return null;
  const data = loadSegelreviere();
  const revier = data.Griechenland?.reviere.find(
    (candidate) => candidate.deutsch === alias.sailingArea,
  );
  if (!revier) return null;
  return {
    kind: "revier",
    revier,
    land: "Griechenland",
    countryCode: "GR",
    city: alias.city,
  };
}

export function classifyStandaloneSeaArea(
  message: string,
): { type: "ANALYSE"; location: string } | null {
  const normalizedMessage = normalizeKey(message);
  if (SAILING_AREA_ALIASES[normalizedMessage]) {
    return { type: "ANALYSE", location: message.trim() };
  }

  const data = loadSegelreviere();
  for (const { reviere } of Object.values(data)) {
    const revier = reviere.find((candidate) => {
      if (candidate.typ !== "meer") return false;
      const canonicalName = normalizeKey(candidate.deutsch);
      const nameWithoutCountry = normalizeKey(
        candidate.deutsch.replace(/\s*\([^)]*\)\s*$/, ""),
      );
      return normalizedMessage === canonicalName || normalizedMessage === nameWithoutCountry;
    });
    if (revier) return { type: "ANALYSE", location: revier.deutsch };
  }
  return null;
}

function buildRevierList(data: SegelreviereData): string {
  const lines: string[] = [];
  for (const [land, { reviere }] of Object.entries(data)) {
    for (const r of reviere) {
      lines.push(
        `"${r.deutsch}" [${land}, ${r.lat.toFixed(1)}°N ${r.lon.toFixed(1)}°E] — ${r.orte}`,
      );
    }
  }
  return lines.join("\n");
}

// ── Prompt Caching: statische System-Blöcke ───────────────────────────────

const DETECT_SYSTEM_PROMPT = `Du bist ein Experte für europäische Geografie und Segelreviere.

Gegeben einen Ort (Stadt, Hafen, Bucht, Resort, Campingplatz, See, allgemeine Bezeichnung):
1. Ordne ihn dem passendsten Segelrevier aus der Liste zu (wenn sinnvoll).
2. Nenne die nächstgelegene bedeutsame Stadt oder den repräsentativen Ort.

Wichtig:
- Die angegebenen Orte pro Revier sind nur Beispiele — nutze dein geografisches Wissen auch für nicht explizit gelistete Orte.
- Die Koordinaten (°N °E) jedes Reviers helfen bei der geografischen Einordnung.
- Wenn der Input selbst eine echte Stadt, ein Hafen oder ein bekannter Ort ist (z.B. "Punat", "Biograd", "Vodice", "Fažana"): gib GENAU diesen Ort als city zurück, NICHT eine größere Nachbarstadt.
- Für Seen und Gewässer (z.B. "Neusiedler See", "Bodensee", "Gardasee"): gib die wichtigste Stadt AM Ufer als city zurück (z.B. "Neusiedler See" → city: "Neusiedl am See", "Bodensee" → city: "Konstanz", "Gardasee" → city: "Riva del Garda"). NIEMALS den Seenamen als city verwenden!
- Für Inseln (z.B. "Brac", "Krk", "Korfu", "Lefkada", "Elba"): gib die wichtigste KÜSTENSTADT oder den Haupthafen der Insel als city zurück (z.B. "Brac" → city: "Bol", "Krk" → city: "Krk", "Korfu" → city: "Korfu", "Lefkada" → city: "Lefkada", "Elba" → city: "Portoferraio"). NIEMALS den Inselnamen als city verwenden, da Geocoding sonst den Bergmittelpunkt der Insel liefert!
- Für Resorts, Campingplätze, Buchten: gib die nächste echte Stadt an (z.B. "Seepark Weiden" → city: "Weiden am See").
- Für Segelrevier-Namen ohne Stadtbezug: gib die wichtigste Hafenstadt an (z.B. "Nordadria" → city: "Trieste").
- Bei allgemeinen Bezeichnungen wie "Adria": sailingArea: "Adria Mitte (Kroatien)", city: "Split".
- Falls kein Revier passt (Binnenstadt, Inland): sailingArea: null.
- Falls der Input komplett unverständlich ist: city: null.
- Ortsnamen IMMER in lateinischer Schrift angeben, auch für griechische, türkische etc. Orte (z.B. "Skiathos" statt "Σκιάθος", "Istanbul" statt "İstanbul").

Antworte NUR mit einem JSON-Objekt, z.B.:
{"sailingArea": "Adria Mitte (Kroatien)", "city": "Split"}
{"sailingArea": null, "city": "Zagreb"}
{"sailingArea": null, "city": null}`;

let _staticSystemBlocks: Anthropic.Messages.TextBlockParam[] | null = null;

function getStaticSystemBlocks(): Anthropic.Messages.TextBlockParam[] {
  if (_staticSystemBlocks) return _staticSystemBlocks;
  const data = loadSegelreviere();
  const revierList = buildRevierList(data);
  _staticSystemBlocks = [
    { type: "text", text: DETECT_SYSTEM_PROMPT },
    {
      type: "text",
      text: `Verfügbare Segelreviere:\n${revierList}`,
      cache_control: { type: "ephemeral" },
    },
  ];
  return _staticSystemBlocks;
}

// ── Core detection ─────────────────────────────────────────────────────────

export async function detectLocation(
  locationName: string,
  anthropic: Anthropic,
  signal?: AbortSignal,
): Promise<DetectLocationResult> {
  const aliasedResult = resolveSailingAreaAlias(locationName);
  if (aliasedResult) return aliasedResult;

  const result = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 100,
    temperature: 0,
    system: getStaticSystemBlocks(),
    messages: [{ role: "user", content: `Ort: "${locationName}"` }],
  }, { signal });

  const text =
    result.content[0]?.type === "text" ? result.content[0].text.trim() : "";
  console.log(`[DEBUG] detectLocation("${locationName}") → ${text}`);
  let parsed: { sailingArea: string | null; city: string | null } | null = null;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch {
    console.error("detectLocation: JSON parse failed for response:", text);
    return null;
  }

  const city = parsed?.city?.trim() || null;
  if (!city) return null; // unrecognisable input — caller will ask user again

  const sailingAreaName =
    typeof parsed?.sailingArea === "string" ? parsed.sailingArea.trim() : null;
  if (!sailingAreaName) return { kind: "city", city };

  const data = loadSegelreviere();
  for (const [land, { reviere }] of Object.entries(data)) {
    const revier = reviere.find((r) => r.deutsch === sailingAreaName);
    if (revier) {
      return {
        kind: "revier",
        revier,
        land,
        countryCode: LAND_TO_COUNTRY_CODE[land] ?? "",
        city,
      };
    }
  }
  console.warn(
    `detectLocation: unknown sailingArea "${sailingAreaName}", returning city-only`,
  );
  return { kind: "city", city };
}

// ── Flag helper ────────────────────────────────────────────────────────────

export function countryFlag(countryCode: string): string {
  return COUNTRY_CODE_TO_FLAG[countryCode] ?? "";
}

// ── Regional model selection ───────────────────────────────────────────────

const windyModels = windyModelsJson as Record<
  string,
  { model: string; label: string }
>;
const countries = countriesJson as Record<string, { windyModel: string }>;

export function resolveWindyModel(key: string): {
  model: string;
  label: string;
} {
  return windyModels[key] ?? windyModels["iconEu"];
}

export function getRegionalModelFallback(
  lat: number,
  lon: number,
): { model: string; label: string } {
  if (lat >= 42 && lat <= 51 && lon >= -5 && lon <= 8)
    return resolveWindyModel("aromeHd");
  if (lat >= 46 && lat <= 52 && lon >= 10 && lon <= 22)
    return resolveWindyModel("czeAladin");
  if (lat >= 51 && lat <= 58 && lon >= -8 && lon <= 0)
    return resolveWindyModel("ukv");
  if (lat >= 35 && lat <= 72 && lon >= -25 && lon <= 45)
    return resolveWindyModel("iconEu");
  return resolveWindyModel("gfs");
}

export function getModelForCountry(
  countryCode: string,
): { model: string; label: string } | null {
  const entry = countries[countryCode];
  if (!entry) return null;
  return resolveWindyModel(entry.windyModel);
}

// ── Windy sources ─────────────────────────────────────────────────────────

export function getWindySources(
  regional: { model: string; label: string },
  coords: { lat: number; lon: number },
  locationName: string,
): string[] {
  const url = `https://www.windy.com/-wind-${regional.model}?${regional.model},wind,${coords.lat.toFixed(3)},${coords.lon.toFixed(3)},9`;
  return [
    `Interaktive Windy Karten (eingebettet mit ECWMF Modell), empfohlenes Prognosemodell ${regional.label} in [windy.com](${url}) verfügbar`,
  ];
}

// ── Message classification ─────────────────────────────────────────────────

export async function classifyMessage(
  message: string,
  hasActiveLocation: boolean,
  anthropic: Anthropic,
  activeLocationName?: string,
  signal?: AbortSignal,
): Promise<{
  type: "ANALYSE" | "CHAT" | "UNCLEAR" | "OFFTOPIC";
  location?: string;
}> {
  const standaloneSeaArea = classifyStandaloneSeaArea(message);
  if (standaloneSeaArea) return standaloneSeaArea;

  try {
    const activeLocInfo =
      hasActiveLocation && activeLocationName
        ? `Es ist bereits ein Ort aktiv: "${activeLocationName}".`
        : "Es ist KEIN Ort aktiv.";

    const result = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 64,
      temperature: 0,
      system: `Klassifiziere die Benutzernachricht in eine von vier Kategorien:

ANALYSE <Ortsname> — NUR wenn:
(a) der Benutzer NUR einen Ortsnamen/See/Insel/Hafen/Küste eingibt (ohne sonstige Frage), ODER
(b) der Benutzer explizit nach einer NEUEN Wetter-Analyse/Segelwetterbericht für einen Ort fragt ("Wetter für...", "Analyse...", "Wie ist das Segelwetter in...").
Beispiele:
- "Punat" → ANALYSE Punat
- "Gardasee" → ANALYSE Gardasee
- "Wetter in Split" → ANALYSE Split
- "Analyse Rovinj" → ANALYSE Rovinj
- "Segelwetter Elba" → ANALYSE Elba
NICHT ANALYSE wenn:
- der Ort nur im Kontext einer Wissensfrage/Rückfrage erwähnt wird
- der Benutzer eine konkrete Detailfrage zum aktiven Ort stellt (Temperatur, Wind, Wellen, etc.)${hasActiveLocation ? `\n- "wieviel grad derzeit in ${activeLocationName}?" → CHAT (Rückfrage zum aktiven Ort)\n- "wie stark ist der Wind in ${activeLocationName}?" → CHAT (Rückfrage zum aktiven Ort)\n- "regnet es in ${activeLocationName}?" → CHAT (Rückfrage zum aktiven Ort)` : ""}
- "Wieviele Einwohner hat Neusiedl?" → OFFTOPIC
- "Liegt Illmitz südlich von Triest?" → CHAT (Geographie)
- "Wie tief ist der Gardasee?" → CHAT (Geographie/Marine)
- "Was für Winde gibt es in Kroatien?" → CHAT (Windsysteme)

CHAT — wenn der Benutzer eine Frage zu Wetter, Meteorologie, Segeln, Windsystemen, Marine, Geographie, Segelrevieren stellt${hasActiveLocation ? ", ODER eine Rückfrage/Detailfrage zum aktiven Ort oder zur laufenden Analyse stellt (z.B. Temperatur, Wind, Regen, Prognose)" : ""}. Beispiele:
- "Was sind Cumulonimbus-Wolken?" → CHAT
- "Wie entsteht die Bora?" → CHAT
- "Erkläre die Douglas-Skala" → CHAT
- "Welche Segelreviere gibt es in Griechenland?" → CHAT
- "Wie tief ist der Gardasee?" → CHAT
- "Liegt Split nördlich von Dubrovnik?" → CHAT
${hasActiveLocation ? `- "Wird der Wind stärker?" → CHAT (Rückfrage bei aktivem Ort)\n- "Wie sieht es morgen aus?" → CHAT (Rückfrage bei aktivem Ort)\n- "Erkläre mir die Analyse" → CHAT (Rückfrage zur Analyse)\n- "wieviel grad in ${activeLocationName}?" → CHAT (Detailfrage zum aktiven Ort)\n- "wie ist die Wellenhöhe?" → CHAT (Detailfrage zum aktiven Ort)` : '- "Wird der Wind stärker?" → UNCLEAR (kein aktiver Ort)\n- "Wie sieht es morgen aus?" → UNCLEAR (kein aktiver Ort)'}

OFFTOPIC — wenn die Frage NICHTS mit Segeln, Wetter, Meteorologie, Marine, Geographie zu tun hat. Beispiele:
- "Schreibe mir ein Gedicht" → OFFTOPIC
- "Was ist die Hauptstadt von Frankreich?" → OFFTOPIC
- "Wieviele Einwohner hat Neusiedl?" → OFFTOPIC
- "Wie koche ich Pasta?" → OFFTOPIC
- "Erkläre mir Quantenphysik" → OFFTOPIC

UNCLEAR — wenn nicht klar ist ob ein Ort gemeint ist${!hasActiveLocation ? ", oder eine ortsbezogene Frage ohne konkreten Ort gestellt wird" : ""}. Beispiele:
- "Wetter" → UNCLEAR
- "Wie ist es dort?" → UNCLEAR${!hasActiveLocation ? '\n- "Wird der Wind stärker?" → UNCLEAR (kein aktiver Ort)' : ""}

${activeLocInfo}

Antworte NUR mit der Kategorie (und bei ANALYSE dem Ortsnamen). Nichts anderes.`,
      messages: [{ role: "user", content: message }],
    }, { signal });
    const text =
      result.content[0]?.type === "text" ? result.content[0].text.trim() : "";
    if (text.startsWith("ANALYSE")) {
      const location = text.replace("ANALYSE", "").trim();
      return { type: "ANALYSE", location: location || undefined };
    }
    if (text === "UNCLEAR") return { type: "UNCLEAR" };
    if (text === "OFFTOPIC") return { type: "OFFTOPIC" };
    return { type: "CHAT" };
  } catch (e) {
    console.error(
      "Message classification failed:",
      e instanceof Error ? e.message : e,
    );
    return { type: "CHAT" };
  }
}

// ── Nominatim reverse geocoding ──────────────────────────────────────────────

export async function reverseGeocode(
  lat: number,
  lon: number,
  signal?: AbortSignal,
): Promise<{
  lat: number;
  lon: number;
  displayName: string;
  regionalModel: string;
  regionalModelLabel: string;
  countryCode?: string;
  cityName?: string;
} | null> {
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1&namedetails=1&accept-language=de,en`,
      {
        headers: { "User-Agent": "WindyWeatherApp/1.0" },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
          : AbortSignal.timeout(8000),
      },
    );
    if (!response.ok) return null;

    const result = (await response.json()) as {
      lat: string;
      lon: string;
      display_name: string;
      namedetails?: Record<string, string>;
      address?: {
        country_code?: string;
        city?: string;
        town?: string;
        village?: string;
      };
    };
    if (!result.display_name) return null;

    const nd = result.namedetails || {};
    const addr = result.address || {};
    const countryCode = addr.country_code?.toUpperCase();
    const cityName = nd["name:de"] || nd["name:en"] || nd["int_name"] || addr.city || addr.town || addr.village || result.display_name.split(",")[0].trim();

    const countryModel = countryCode ? getModelForCountry(countryCode) : null;
    const regional = countryModel ?? getRegionalModelFallback(lat, lon);

    return {
      lat,
      lon,
      displayName: result.display_name,
      regionalModel: regional.model,
      regionalModelLabel: regional.label,
      countryCode,
      cityName,
    };
  } catch {
    return null;
  }
}

// ── Nominatim geocoding ────────────────────────────────────────────────────

export async function geocodeLocation(
  locationName: string,
  hintCoords?: { lat: number; lon: number },
): Promise<{
  lat: number;
  lon: number;
  displayName: string;
  regionalModel: string;
  regionalModelLabel: string;
  countryCode?: string;
  cityName?: string;
} | null> {
  try {
    const viewbox = hintCoords
      ? `&viewbox=${hintCoords.lon - 0.5},${hintCoords.lat + 0.5},${hintCoords.lon + 0.5},${hintCoords.lat - 0.5}&bounded=0`
      : "";
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(locationName)}&limit=5&extratags=1&namedetails=1&addressdetails=1&accept-language=de,en${viewbox}`;
    let response: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetch(url, { headers: { "User-Agent": "WindyWeatherApp/1.0" } });
        if (response.ok) break;
        console.warn(`[geocode] Nominatim attempt ${attempt + 1} failed: ${response.status}`);
      } catch (e) {
        console.warn(`[geocode] Nominatim attempt ${attempt + 1} error:`, e);
      }
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
    if (!response || !response.ok) return null;

    const results = (await response.json()) as Array<{
      lat: string;
      lon: string;
      display_name: string;
      class: string;
      type: string;
      addresstype?: string;
      namedetails?: Record<string, string>;
      address?: {
        country_code?: string;
        city?: string;
        town?: string;
        village?: string;
      };
    }>;
    if (!results.length) return null;

    const placeTypes = new Set(["city", "town", "village", "hamlet", "suburb"]);
    const result = results.find(r => placeTypes.has(r.type) || placeTypes.has(r.addresstype ?? "")) ?? results[0];
    const lat = parseFloat(result.lat);
    const lon = parseFloat(result.lon);
    const nd = result.namedetails || {};
    const searchName = result.display_name.split(",")[0].trim();

    const countryCode = result.address?.country_code?.toUpperCase();
    const cityName = nd["name:de"] || nd["name:en"] || nd["int_name"] || searchName;

    const countryModel = countryCode ? getModelForCountry(countryCode) : null;
    const regional = countryModel ?? getRegionalModelFallback(lat, lon);

    return {
      lat,
      lon,
      displayName: result.display_name,
      regionalModel: regional.model,
      regionalModelLabel: regional.label,
      countryCode,
      cityName,
    };
  } catch {
    return null;
  }
}
