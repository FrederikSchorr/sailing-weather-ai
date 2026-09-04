import Anthropic from "@anthropic-ai/sdk";
import windSystemsJson from "../data/windsystems.json" with { type: "json" };
import type { AnalysisJson } from "./analysis-store.js";
import {
  buildSection4WeatherContext,
  getOpenMeteoTimezone,
} from "./weather-open-meteo.js";

// ── Wind systems ──────────────────────────────────────────────────────────────

type WindSystem = { country: string; winds: Record<string, unknown>[] };

function loadWindsystems(): WindSystem[] {
  return windSystemsJson as unknown as WindSystem[];
}

function getWindsystemsForCountry(country: string): string {
  const entry = loadWindsystems().find(e => e.country === country);
  if (!entry) return "";
  return JSON.stringify(entry.winds, null, 2);
}

const SHORT_DAY_NAMES = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const WIND_DIRECTIONS_16 = ["N", "NNO", "NO", "ONO", "O", "OSO", "SO", "SSO", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"] as const;
const WIND_DIRECTIONS_8 = ["N", "NO", "O", "SO", "S", "SW", "W", "NW"] as const;
const WIND_DIRECTION_TOKEN = WIND_DIRECTIONS_16.slice().sort((a, b) => b.length - a.length).join("|");

function normalizeWindDirection(direction: string): typeof WIND_DIRECTIONS_8[number] {
  const index = WIND_DIRECTIONS_16.indexOf(direction.toUpperCase() as typeof WIND_DIRECTIONS_16[number]);
  return index === -1
    ? "N"
    : WIND_DIRECTIONS_8[Math.round(index / 2) % WIND_DIRECTIONS_8.length];
}

export function normalizeWindDirectionMentions(text: string): string {
  const pairPattern = new RegExp(
    `\\b(${WIND_DIRECTION_TOKEN})(?:\\s*(?:/|[–—-])\\s*|\\s+bis\\s+|\\s+)(${WIND_DIRECTION_TOKEN})\\b`,
    "gi",
  );
  const normalizeSegment = (segment: string): string => {
    const protectedDays: string[] = [];
    const protectedSegment = segment.replace(
      /\b(So|Mo|Di|Mi|Do|Fr|Sa)\s+(?=(?:N|NO|O|SO|S|SW|W|NW)\s+\d)/g,
      (match) => {
        const marker = `__WEEKDAY_${protectedDays.length}__`;
        protectedDays.push(match);
        return `${marker} `;
      },
    );
    const localized = protectedSegment
      .replace(/\bNE\b/g, "NO")
      .replace(/\bSE\b/g, "SO");
    const normalized = localized.replace(pairPattern, (_match, first: string, second: string) => {
      const normalizedFirst = normalizeWindDirection(first);
      const normalizedSecond = normalizeWindDirection(second);
      const firstIndex = WIND_DIRECTIONS_8.indexOf(normalizedFirst);
      const secondIndex = WIND_DIRECTIONS_8.indexOf(normalizedSecond);
      const shortestDelta = ((secondIndex - firstIndex + 4) % 8) - 4;
      if (Math.abs(shortestDelta) === 4) return normalizedFirst;
      const midpoint = (firstIndex + shortestDelta / 2 + 8) % 8;
      return WIND_DIRECTIONS_8[Math.round(midpoint) % WIND_DIRECTIONS_8.length];
    }).replace(new RegExp(`\\b(${WIND_DIRECTION_TOKEN})\\b`, "gi"), (_match, direction: string) =>
      normalizeWindDirection(direction),
    );
    return normalized.replace(/__WEEKDAY_(\d+)__\s*/g, (_match, index) => protectedDays[Number(index)]);
  };
  return text.split(/\r?\n/).map(line => {
    const separator = line.indexOf(":");
    if (separator === -1) return normalizeSegment(line);
    return `${line.slice(0, separator + 1)}${normalizeSegment(line.slice(separator + 1))}`;
  }).join("\n");
}

function addCalendarDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function formatCalendarDate(date: Date): string {
  return `${SHORT_DAY_NAMES[date.getUTCDay()]} ${String(date.getUTCDate()).padStart(2, "0")}.${String(date.getUTCMonth() + 1).padStart(2, "0")}.`;
}

function formatCalendarRange(start: Date, end: Date): string {
  const dayRange = `${SHORT_DAY_NAMES[start.getUTCDay()]}–${SHORT_DAY_NAMES[end.getUTCDay()]}`;
  const startDay = String(start.getUTCDate()).padStart(2, "0");
  const endDay = String(end.getUTCDate()).padStart(2, "0");
  const startMonth = String(start.getUTCMonth() + 1).padStart(2, "0");
  const endMonth = String(end.getUTCMonth() + 1).padStart(2, "0");

  if (start.getUTCFullYear() === end.getUTCFullYear() && startMonth === endMonth) {
    return `${dayRange} ${startDay}.–${endDay}.${endMonth}.`;
  }
  return `${dayRange} ${startDay}.${startMonth}.–${endDay}.${endMonth}.`;
}

function localClock(
  requestDate: string,
  timeZone: string,
): { label: string; hour: number; minute: number } {
  const instant = new Date(requestDate);
  const parts = new Intl.DateTimeFormat("de-DE", {
    timeZone,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(part => part.type === type)?.value ?? "";
  return {
    label: `${value("weekday").replace(/\.$/, "")}, ${value("day")}.${value("month")}., ${value("hour")}:${value("minute")} Uhr`,
    hour: Number(value("hour")),
    minute: Number(value("minute")),
  };
}

export function buildForecastDateLabels(
  requestDate: string,
  timeZone: string,
): {
  todayLabel: string;
  tomorrowLabel: string;
  dayAfterTomorrowLabel: string;
  forecastEndLabel: string;
  forecastTailLabel: string;
  forecastOverviewLabel: string;
  overviewStartDay: number;
  forecastEndDay: number;
} {
  const instant = new Date(requestDate);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`Invalid analysis request date: ${requestDate}`);
  }

  const dateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(dateParts.find((item) => item.type === type)?.value);
  const localDate = new Date(Date.UTC(part("year"), part("month") - 1, part("day")));
  const tomorrowDate = addCalendarDays(localDate, 1);
  const overviewStartDate = addCalendarDays(localDate, 2);
  const tailStartDate = addCalendarDays(localDate, 3);
  const endDate = addCalendarDays(localDate, 5);

  return {
    todayLabel: formatCalendarDate(localDate),
    tomorrowLabel: formatCalendarDate(tomorrowDate),
    dayAfterTomorrowLabel: formatCalendarDate(overviewStartDate),
    forecastEndLabel: formatCalendarDate(endDate),
    forecastTailLabel: formatCalendarRange(tailStartDate, endDate),
    forecastOverviewLabel: formatCalendarRange(overviewStartDate, endDate),
    overviewStartDay: overviewStartDate.getUTCDate(),
    forecastEndDay: endDate.getUTCDate(),
  };
}

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Du bist Meteorologe und Segelexperte.
Schreibe auf Deutsch, sachlich-professionell, kurz und als Bullet-Points.
Verwende nur die bereitgestellten Daten; erfinde keine Werte, Quellen oder Entwicklungen.
Halte den untenstehenden Ausgabeumfang und die Abschnittsmarker exakt ein.
Keine Begrüßung, keine Floskeln, keine zusätzlichen Überschriften, kein Fettdruck.`;

const GLOBAL_OUTPUT_RULES = `=== PRIORITÄTEN UND AUSGABEVERTRAG ===
1. Konkrete lokale Daten haben Vorrang. Nationale Warnungen und konkrete nationale Ortsinformationen dürfen lokale Daten ergänzen, aber nicht stillschweigend ersetzen.
2. Keine Zahl, Uhrzeit, Windrichtung, Welle, Front oder Wetterentwicklung erfinden. Wenn Daten fehlen, transparent bleiben.
3. Erzeuge exakt diese vier Marker in dieser Reihenfolge:
===airPressureMasses===
===weatherFront===
===windWaves===
===cloudsRain===
Danach exakt ===END===. Keine Erklärung außerhalb dieser Marker.
4. Abschnitt 1 enthält genau 2 Bullets, Abschnitt 2 genau 2 und Abschnitt 4 genau 3. Abschnitt 3 enthält immer vier inhaltliche Prognosebullets plus die Warnzeile, wenn eine Warnquelle angebunden ist; insgesamt höchstens 5. Keine dieser vier Prognosezeilen weglassen.
5. Bullet-Text bleibt kurz. Emojis stehen in Abschnitt 1 und 2 passend am Bullet-Anfang; in Abschnitt 3 und 4 direkt vor dem jeweiligen Inhalt.`;

const SECTION_1_RULES = `=== ABSCHNITT 1: airPressureMasses — Druck & Luftmassen ===
Input: Bilder, Meteonews und nationale Synopsis; lokale Wetterdaten nicht verwenden.
- Genau 2 Bullets, maximal 20 Wörter je Bullet.
- Bullet 1 beginnt mit 🌀 und beschreibt dominante Drucksysteme über Europa und ihre Bewegungsrichtung. Keine farbigen Kreise (🔵, 🟠, 🔴).
- Bullet 2 beginnt mit 🌡️ und beschreibt großräumige Luftmassen: kalt/warm, feucht/trocken, Luftmassengrenzen oder Gradienten.
- Keine lokalen Windströmungen oder Windstärken, keine Niederschlagserwähnung.
- Keine Temperaturangaben in °C oder Grad.`;

function buildSection2Rules(locationLabel: string): string {
  return `=== ABSCHNITT 2: weatherFront — Fronten ===
Input: Bilder, Meteonews und nationale Synopsis.
- Genau 2 Bullets, maximal 20 Wörter je Bullet.
- Bullet 1 beginnt mit 🌍 und beschreibt ausschließlich die großräumige Frontenlage über Europa: aktive Kalt- oder Warmfronten, Position und Bewegung. Keine lokale Bewertung des Zielorts.
- Bullet 2 beginnt mit 📍 und beschreibt ausschließlich die lokale Frontenlage für "${locationLabel}": nächste relevante Kalt- oder Warmfront und deren Position/Bewegung. "${locationLabel}" muss genannt werden; keinen anderen Zielort nennen. Wenn keine lokale Front vorliegt, dies ausdrücklich sagen.
- Großräumige und lokale Frontenlage niemals vertauschen. Okklusionen weglassen.
- Keine Frontwirkungen, kein Regen und kein Wind; nur Fronttyp, Position und Bewegungsrichtung.`;
}

const WIND_PEAK_TIMING_RULE = `=== WINDDATEN ===
Der kanonische Block LOKALER STÜNDLICHER WIND enthält pro Zeile Datum, Uhrzeit, Richtung, Wind_kt und Böe_kt.
Wind_kt und Böe_kt derselben Zeile bilden immer ein untrennbares Paar.
Die stärkste Böe darf ausschließlich ihrer tatsächlichen Tagesphase zugeordnet werden.`;

const WIND_DIRECTION_RULE = `Windrichtungen im Nutzertext werden auf acht Richtungen reduziert: N, NO, O, SO, S, SW, W und NW.`;

function buildSection3Rules(
  locationLabel: string,
  todayLabel: string,
  tomorrowLabel: string,
  dayAfterTomorrowLabel: string,
  forecastTailLabel: string,
  currentLocalTimeLabel: string,
): string {
  return `=== ABSCHNITT 3: windWaves — Wind & Welle ===
Inputs: der kanonische Block LOKALER STÜNDLICHER WIND, preprocessed.local.wave und geprüfte Warnungen. Europäische und nationale Texte liefern nur ergänzenden Kontext.
- Genau 4 Prognosebullets: Heute (${todayLabel}), Morgen (${tomorrowLabel}), Übermorgen (${dayAfterTomorrowLabel}) und ${forecastTailLabel}. Bei angebundener Warnquelle steht davor genau eine Warnzeile; insgesamt höchstens 5 Bullets.
- Analysezeitpunkt ist ${currentLocalTimeLabel}. Der Heute-Bullet blickt ausschließlich ab diesem Zeitpunkt in die Zukunft. Bereits vergangene Uhrzeiten und abgeschlossene Tagesphasen niemals erwähnen oder zusammenfassen.
- Diese vier Prognosebullets sind Pflicht und werden als vier eigene Zeilen ausgegeben, auch wenn einzelne Werte fehlen. Bei fehlenden Werten transparent "Windprognose nicht verfügbar." schreiben, niemals den Bullet weglassen oder nur den Mehrtagesausblick ausgeben.
- Bei angebundener Warnquelle die geprüfte Warnung aus preprocessed.local.warnings vollständig und unverändert übernehmen. "Keine Sturmwarnung" ohne ⚠️ ausgeben; aktive Warnungen oder Abruffehler dürfen ⚠️ erhalten. Bei nicht angebundener Quelle keine Warnzeile erzeugen.
- Prognosebullets 2–5 beginnen jeweils mit ihrem Zeit-/Datumspräfix, niemals mit einem Emoji. Heute und Morgen enthalten Wind und nur bei vorhandenen preprocessed.local.wave.text_de die passende Seegangsstärke im selben Bullet; Wellendaten als Douglas-Skala, ohne Richtung, Periode oder Dünung. Wenn preprocessed.local.wave.text_de fehlt, Wellendaten und Seegang vollständig ignorieren und keinerlei Hinweis auf fehlende Wellendaten ausgeben.
- Die Tabelle ist für konkrete Werte maßgeblich: Wind_kt und Böe_kt derselben Zeile gehören zusammen. Ein konkreter Wert wird immer als Bereich ausgegeben, z.B. "Meltemi NW 23–32 kt"; niemals nur den Windwert nennen und niemals "Wind 3 kt, Böen 6 kt".
- JEDE numerische Windstärke hat ausnahmslos genau zwei Werte im Format "Wind–Böe kt", z.B. "8–16 kt". Einzelwerte wie "8 kt", "bis 17 kt" oder "auf 10 kt" sind verboten. Auch jede Verstärkung, Abschwächung und jeder Mehrtageswert muss als solches Paar erscheinen.
- Schreibe eine seglerische Interpretation, keine Nacherzählung des Prognosecharts. Beginne jeden Bullet mit der Kernaussage: nutzbares Windfenster, problematische Phase, markanter Dreher, Flaute, stabiler Charakter oder lokales Windsystem. Konkrete Werte belegen diese Aussage nur.
- Der wichtigste Zusatznutzen sind lokale Windmechanismen: benannte regionale Windsysteme, thermische Verstärkung oder Zusammenbruch, Düsen-/Kanalisierungseffekt, Fallwind, Lee-Effekt oder Küstenkonvergenz. Ordne daraus Böigkeit, räumliche Ungleichmäßigkeit und Verlässlichkeit des Segelfensters ein.
- Nenne einen solchen lokalen Effekt nur, wenn er zum Zielrevier und zum sichtbaren Verlauf passt oder im nationalen/lokalen Windkontext ausdrücklich gestützt ist. Bei plausibler, aber nicht ausdrücklich bestätigter Zuordnung vorsichtig "spricht für …" schreiben; niemals eine lokale Ursache erfinden. Die lokalen Tabellenwerte bleiben maßgeblich.
- Heute und morgen enthalten in der Regel höchstens zwei Wind–Böe-Paare, Übermorgen höchstens eines. Ein zusätzlicher Wert ist nur zulässig, wenn er einen eigenen, seglerisch relevanten Übergang durch einen konkret erklärten lokalen Windmechanismus oder Frontdurchgang belegt. Im Mehrtagesausblick höchstens ein Paar pro Tag. Gleichförmige Stunden zusammenfassen; keine Folge aus morgens/mittags/nachmittags/abends mit jeweils neuem Wert.
- Heute sind konkrete Uhrzeiten nur für Beginn oder Ende eines wirklich markanten Windfensters erlaubt, morgen nur grobe Tageszeiten. Keine Formulierungen wie "Spitze um …", keine bloße Aufzählung von Maxima.
- "böig" höchstens einmal und nur, wenn der jeweilige Tagesblock dies ausdrücklich stützt. Niemals "ungewöhnlich böig". Keine separate Böen-Spitze, kein "Böen bis …" und keine redundante Wiederholung desselben oberen Windwerts.
- Übermorgen nur die wichtigste Tendenz ohne Stundenwerte. Der letzte Bullet beginnt exakt mit "${forecastTailLabel}:" und fasst die weiteren Tage großflächig zusammen; pro Tag höchstens eine Windstärkekategorie.
- Richtungsangaben ausschließlich als genau eines dieser acht Kürzel schreiben: N, NO, O, SO, S, SW, W oder NW. Niemals Zwischenrichtungen wie NNW, WNW oder SSO und niemals zusammengesetzte Kürzel wie NW-W, NW/W oder SO-NW verwenden. Bei Windstärken ab 40 kt ⚠️ ergänzen. Wenn Winddaten fehlen, transparent "Windprognose aus regionalem Wetterbericht nicht verfügbar." ausgeben.
- Für ${locationLabel} soll bei klarer Evidenz der passende lokale Mechanismus erklärt werden, statt nur dessen Namen anzuhängen. Beschreibe knapp, wodurch er verstärkt, kanalisiert oder abgebaut wird und welche seglerische Konsequenz daraus folgt; er ersetzt niemals die lokalen Tabellenwerte.`;
}

function buildSection4Rules(
  todayLabel: string,
  tomorrowLabel: string,
  forecastOverviewLabel: string,
  currentLocalTimeLabel: string,
): string {
  return `=== ABSCHNITT 4: cloudsRain — Wetter & Regen ===
Input: ENTWICKLUNGS- UND LAGEKONTEXT FÜR ABSCHNITT 4 und KNMI-Frontkarten; Wind- und Wellendaten nicht verwenden.
- Genau 3 Bullets in dieser Reihenfolge: Heute (${todayLabel}), Morgen (${tomorrowLabel}), ${forecastOverviewLabel}. Jeder Bullet beginnt mit seinem Zeit-/Datumspräfix, niemals mit einem Emoji.
- Analysezeitpunkt ist ${currentLocalTimeLabel}. Der Heute-Bullet enthält ausschließlich noch bevorstehendes Wetter ab diesem Zeitpunkt; keine bereits vergangenen Uhrzeiten oder abgeschlossenen Tagesphasen.
- INTERPRETIERE Auffälligkeiten und Veränderungen, statt Meteogrammwerte aufzuzählen. Priorität: markanter Drucktrend, Niederschlagsfenster/-spitze, rascher Temperaturwechsel, belastbares Gewittersignal und deutlicher Wetterumschwung. Bewölkung nur bei relevantem Wechsel.
- Heute granular, aber kompakt: höchstens 2–3 wichtigste Entwicklungen in zeitlicher Reihenfolge. Wenn mehrere lokale Signale vorhanden sind, nicht nur einen Einzelwert oder eine einzige Wetterbeschreibung nennen; niemals mit erfundenen Details auffüllen. Regen als qualitative zusammengefasste Phase; konkrete Uhrzeit nur für markanten Beginn oder Höhepunkt. Temperaturen auf ganze °C runden; Temperaturänderungen nur mit groben Tagesphasen. Einen normalen abendlichen Rückgang und kleine Stundenänderungen bis 3°C nicht erwähnen.
- Morgen weniger granular: nur nachts, morgens, mittags, nachmittags oder abends, keine Ziffer-Uhrzeiten. ${forecastOverviewLabel} ausschließlich als High-Level-Trend der folgenden vier Tage, ohne Uhrzeiten oder Tagesphasen.
- Bei fehlender Auffälligkeit den stabilen Charakter inhaltlich beschreiben, nicht nur "Keine markante Wetterentwicklung erkennbar." Eine gestützte Hochdrucklage mit Wärme, Sonnenschein, Trockenheit oder Stabilität darf genannt werden.
- Lokale und nationale Informationen haben Vorrang; europäische Lage und Frontkarten liefern nur den Zusammenhang. Einen lokalen Druckfall nur mit passender Front oder Synopsis als Frontdurchgang bezeichnen, sonst als Wetterwechsel oder zunehmenden Tiefdruckeinfluss.
- Druck nur bei localForecast.summary.pressure.significant=true erwähnen; unter 4 hPa pro Tag weglassen. Druckänderung ist kein Gewitterindikator.
- Gewitter ausschließlich bei localForecast.summary.thunderstorm.signal=true oder konkreter nationaler Gewitterinformation für Ort und Zeitraum. CAPE allein reicht nicht.
- Regen ausschließlich qualitativ beschreiben. Keine Niederschlagsmengen, "mm", Wolkenprozente, WMO-Codes oder routinemäßige Aufzählungen von Einzelwerten. Passende Icons direkt vor der jeweiligen Entwicklung.
- Falls localForecast fehlt, trotzdem alle 3 Bullets mit korrekten Präfixen und transparenter Nichtverfügbarkeit erzeugen.`;
}

// ── Image helper ──────────────────────────────────────────────────────────────

function detectMediaType(base64: string): "image/png" | "image/gif" | "image/jpeg" | "image/webp" {
  const header = Buffer.from(base64.slice(0, 12), "base64");
  if (header[0] === 0x89 && header[1] === 0x50) return "image/png";
  if (header[0] === 0x47 && header[1] === 0x49) return "image/gif";
  if (header[0] === 0xff && header[1] === 0xd8) return "image/jpeg";
  return "image/png";
}

function imageBlock(base64: string | null | undefined): Anthropic.Messages.ImageBlockParam | null {
  if (!base64) return null;
  return {
    type: "image",
    source: { type: "base64", media_type: detectMediaType(base64), data: base64 },
  };
}

export function normalizeSection1Icons(text: string | null): string | null {
  if (!text) return text;
  const leadingIcon = /^(?:🔵|🟠|🔴|🟢|🟡|🟣|⚪|⚫|🌀|🧭|🌡️)\s*/u;
  let bulletIndex = 0;
  return text.split("\n").map(line => line.trim()).filter(Boolean).map((line) => {
    if (bulletIndex >= 2) return line.startsWith("- ") ? line : `- ${line.replace(/^•\s*/, "")}`;
    const content = line.replace(/^(?:-\s*|•\s*)/, "");
    const icon = bulletIndex++ === 0 ? "🌀" : "🌡️";
    return `- ${icon} ${content.replace(leadingIcon, "")}`;
  }).join("\n");
}

function section2MentionsTarget(text: string, locationLabel: string): boolean {
  const locationTokens = locationLabel
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(token => token.length >= 5 && !["offshore", "griechenland", "osterreich"].includes(token))
    .map(token => token.slice(0, 6));
  const normalizedText = text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  return locationTokens.some(token => normalizedText.includes(token));
}

export function normalizeSection2Icons(
  text: string | null,
  locationLabel?: string,
): string | null {
  if (!text) return text;
  const leadingIcon = /^(?:🌍|📍|🌀|🧭|⛵|🚢|✅|⚠️|🔵|🟠|🔴|🟢|🟡|🟣|⚪|⚫)\s*/u;
  let bulletIndex = 0;
  return text.split("\n").map(line => line.trim()).filter(Boolean).map((line) => {
    if (bulletIndex >= 2) return line.startsWith("- ") ? line : `- ${line.replace(/^•\s*/, "")}`;
    const currentIndex = bulletIndex++;
    const icon = currentIndex === 0 ? "🌍" : "📍";
    let content = line
      .replace(/^(?:-\s*|•\s*)/, "")
      .replace(/\s+(?:und|sowie)\s+Okklusion\w*/gi, "")
      .replace(/Okklusion\w*\s+(?:und|sowie)\s+/gi, "")
      .replace(leadingIcon, "");
    const clauses = content
      .split(/(?<=[.;])/)
      .map(clause => clause.trim())
      .filter(clause => clause && !/\bOkklusion\w*\b/i.test(clause));
    content = clauses.join(" ").trim();
    if (currentIndex === 1 && locationLabel && !section2MentionsTarget(content, locationLabel)) {
      const withCorrectedSubject = content.replace(
        /^.+?\s+\b(liegt|befindet\s+sich)\b/i,
        `${locationLabel} $1`,
      );
      content = withCorrectedSubject === content
        ? `${locationLabel}: ${content}`
        : withCorrectedSubject;
    }
    return `- ${icon} ${content}`;
  }).join("\n");
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateWeatherOutput(
  analysis: AnalysisJson,
  anthropic: Anthropic,
  signal?: AbortSignal,
  onRetry?: (attempt: 2 | 3) => void,
): Promise<Record<string, unknown>> {
  const { position, weatherPreprocessed } = analysis;
  const europe = weatherPreprocessed.europe as Record<string, any>;
  const national = weatherPreprocessed.national as Record<string, any>;
  const local = weatherPreprocessed.local as Record<string, any>;

  const windsystems = getWindsystemsForCountry(position.country);
  const locationLabel = position.sailingArea?.name_de ?? position.city?.name_de ?? position.userInput;
  const cityLabel = position.city?.name_de ?? position.userInput;
  const timezone = getOpenMeteoTimezone(position.countryCode);
  const currentLocal = localClock(analysis.meta.requestDate, timezone);

  const {
    todayLabel,
    tomorrowLabel,
    dayAfterTomorrowLabel,
    forecastEndLabel,
    forecastTailLabel,
    forecastOverviewLabel,
    overviewStartDay,
    forecastEndDay,
  } = buildForecastDateLabels(
    analysis.meta.requestDate,
    timezone,
  );

  // ── Build message content ─────────────────────────────────────────────────

  const content: Anthropic.Messages.ContentBlockParam[] = [];

  // Europe images (for #1 Druck & #2 Fronten)
  const wz850CurrentEntry = europe["temp850hpaCurrent"] as any;
  const wz850ForecastEntry = europe["temp850hpaForecast"] as any;
  const knmiCurrentEntry = europe["frontCurrent"] as any;
  const knmiForecastEntry = europe["frontForecast"] as any;

  const wz850Current = imageBlock(wz850CurrentEntry?.imageBase64);
  const wz850Forecast = imageBlock(wz850ForecastEntry?.imageBase64);
  const knmiCurrent = imageBlock(knmiCurrentEntry?.imageBase64);
  const knmiForecast = imageBlock(knmiForecastEntry?.imageBase64);

  const imageLabels: string[] = [];
  if (wz850Current) { imageLabels.push(`Bild 1: 850hPa-Temperaturkarte — ${wz850CurrentEntry?.timestamp ?? "Aktuell"}`); content.push(wz850Current); }
  if (wz850Forecast) { imageLabels.push(`Bild 2: 850hPa-Temperaturkarte — ${wz850ForecastEntry?.timestamp ?? "Forecast"}`); content.push(wz850Forecast); }
  if (knmiCurrent) { imageLabels.push(`Bild 3: KNMI Frontenkarte — ${knmiCurrentEntry?.timestamp ?? "Aktuell"}`); content.push(knmiCurrent); }
  if (knmiForecast) { imageLabels.push(`Bild 4: KNMI Frontenkarte — ${knmiForecastEntry?.timestamp ?? "Forecast"}`); content.push(knmiForecast); }

  const imageLabelsText = imageLabels.length > 0 ? `\n=== BILDER-ZUORDNUNG ===\n${imageLabels.join("\n")}\n` : "";

  // Text context
  const generalWeather = (europe["generalWeather"] as any)?.text_de ?? null;
  const nationalSynopsis = (national["synopsis"] as any)?.text_de ?? null;
  const section4LocalForecast = buildSection4WeatherContext(
    analysis.weatherRaw,
    timezone,
    new Date(analysis.meta.requestDate),
  );
  const section4Context = {
    targetCity: cityLabel,
    localForecast: section4LocalForecast,
    nationalLocalWeather: local["nationalCloudRain"] ?? null,
    nationalWarning: local["warnings"] ?? null,
    nationalSynopsis,
    europeanOverview: generalWeather,
    frontCharts: {
      current: knmiCurrentEntry ? {
        timestamp: knmiCurrentEntry.timestamp ?? null,
        available: Boolean(knmiCurrentEntry.imageBase64),
      } : null,
      forecast: knmiForecastEntry ? {
        timestamp: knmiForecastEntry.timestamp ?? null,
        available: Boolean(knmiForecastEntry.imageBase64),
      } : null,
    },
  };
  const section3WindContext = (local["wind"] as Record<string, unknown> | undefined) ?? {};
  const section3WindHourlyInput = typeof section3WindContext.hourlyText_de === "string"
    ? section3WindContext.hourlyText_de
    : "(nicht verfügbar)";
  const section3WindScaffold = buildWindScaffold(section3WindHourlyInput, {
    todayLabel,
    tomorrowLabel,
    dayAfterTomorrowLabel,
    forecastTailLabel,
  });
  const section3LocalContext = Object.fromEntries(
    Object.entries(local).filter(([key]) => ![
      "wind",
      "cloudRainThunderstorm",
      "nationalWind",
      "nationalCloudRain",
      "temperature",
      "nationalTemperature",
    ].includes(key)),
  );
  const section4Days = Array.isArray((section4LocalForecast as any)?.days)
    ? (section4LocalForecast as any).days as any[]
    : [];
  const nationalThunderstormEvidence = /\b(?:Gewitter|thunderstorm)\b/i.test(
    JSON.stringify({
      nationalLocalWeather: section4Context.nationalLocalWeather,
      nationalWarning: section4Context.nationalWarning,
    }),
  );
  const section4OutputConstraints = {
    pressureSignificant: [
      section4Days[0]?.summary?.pressure?.significant === true,
      section4Days[1]?.summary?.pressure?.significant === true,
      section4Days.slice(2).some(day => day?.summary?.pressure?.significant === true),
    ],
    thunderstormAllowed: [
      nationalThunderstormEvidence || section4Days[0]?.summary?.thunderstorm?.signal === true,
      nationalThunderstormEvidence || section4Days[1]?.summary?.thunderstorm?.signal === true,
      nationalThunderstormEvidence || section4Days.slice(2).some(day => day?.summary?.thunderstorm?.signal === true),
    ],
  };
  content.push({
    type: "text",
    text: `
=== KONTEXT ===
Ort/Segelrevier: ${locationLabel}
Land: ${position.country}
${position.sailingArea ? `Segelrevier: ${position.sailingArea.name_de}` : `Ort: ${position.city?.name_de ?? position.userInput}`}
Heute: ${todayLabel}
Analysezeitpunkt: ${currentLocal.label}
${imageLabelsText}
=== EUROPÄISCHE WETTERLAGE (Meteonews) ===
${generalWeather ?? "(nicht verfügbar)"}

=== NATIONALE SYNOPSIS ===
${nationalSynopsis ?? "(nicht verfügbar)"}

=== LOKALE WETTERDATEN FÜR ABSCHNITT 3 (weatherPreprocessed.local) ===
${JSON.stringify(section3LocalContext, null, 2)}

=== LOKALER STÜNDLICHER WIND ===
Datum | Uhrzeit | Richtung | Wind_kt | Böe_kt
${section3WindHourlyInput}

=== VERBINDLICHES WIND-GERÜST FÜR ABSCHNITT 3 ===
${section3WindScaffold}
- Verwende pro Prognosezeile numerisch nur die dort vorgeschlagenen Wind–Böe-Paare.
- Beschreibe weitere Übergänge qualitativ ohne zusätzliche Windwerte.
- Das Gerüst begrenzt nur die Zahlen; lokale Mechanismen, Segelfenster, Dreher, Böigkeit und Seegang bleiben interpretativ zu erklären.

=== OPTIONALER GROSSWETTERLAGEN-KONTEXT FÜR ABSCHNITT 3 ===
Europäische Wetterlage: ${generalWeather ?? "(nicht verfügbar)"}
Nationale Synopsis: ${nationalSynopsis ?? "(nicht verfügbar)"}

=== ENTWICKLUNGS- UND LAGEKONTEXT FÜR ABSCHNITT 4 ===
${JSON.stringify(section4Context, null, 2)}

=== DATENQUELLEN UND VORRANG ===
- Für Abschnitt 1 und 2 sind Bilder, Meteonews und nationale Synopsis maßgeblich.
- Für Abschnitt 3 ist LOKALER STÜNDLICHER WIND die maßgebliche Quelle für konkrete Windwerte; wave liefert die optionale Seegangsstärke. sailingareaForecast ergänzt den lokalen Windkontext.
- Für Abschnitt 4 ist localForecast mit Stadtwerten maßgeblich; nationalLocalWeather, nationalSynopsis, europeanOverview und KNMI-Frontkarten liefern Ergänzungen und großräumigen Zusammenhang.
- warnings ist ein separat geprüftes nationales Warnzentrum und wird, wenn vorhanden, in Abschnitt 3 unverändert übernommen.

=== WINDSYSTEME für ${position.country} ===
${windsystems || "(keine Daten)"}

${GLOBAL_OUTPUT_RULES}

${SECTION_1_RULES}

${buildSection2Rules(locationLabel)}

${WIND_PEAK_TIMING_RULE}
${WIND_DIRECTION_RULE}
${buildSection3Rules(locationLabel, todayLabel, tomorrowLabel, dayAfterTomorrowLabel, forecastTailLabel, currentLocal.label)}

${buildSection4Rules(todayLabel, tomorrowLabel, forecastOverviewLabel, currentLocal.label)}
`,
  });

  // ── LLM call ──────────────────────────────────────────────────────────────

  try {
    let raw = "";
    let parsed: Record<string, string> | null = null;
    let cloudsRainText: string | null = null;
    let windWavesText: string | null = null;
    const warningCenter = analysis.sources.nationalWarningCenter;
    const warning = analysis.weatherPreprocessed.local.warnings as {
      checked?: unknown;
      text_de?: unknown;
    } | undefined;
    const expectedWarningLineCount = (
      warningCenter
      && warningCenter.status !== "unsupported"
    )
      ? (
        warning?.checked === true
        && typeof warning.text_de === "string"
        && warning.text_de.trim()
          ? warning.text_de.trim().split(/\r?\n/).filter(Boolean).length
          : 1
      )
      : 0;
    const finalizeWindText = (text: string | undefined): string | null => {
      if (!text) return null;
      const generatedWindText = softenGustyDescriptions(
        stripRedundantWindRangeMentions(
          stripRedundantGustMentions(
            normalizeCalmThresholdMentions(
              combineWindAndGustMentions(normalizeWindPairSeparators(normalizeWindUnits(
                restoreWindGustRanges(
                  stripStrongestGustMentions(normalizeWindDirectionMentions(text)),
                  local["wind"]?.text_de,
                ),
              ))),
            ),
          ),
        ),
      );
      const windWithDatePrefixes = enforceWindForecastDatePrefixes(
        ensureWarningFirst(analysis, generatedWindText),
        { todayLabel, tomorrowLabel, dayAfterTomorrowLabel, forecastTailLabel },
      );
      return ensureWindForecastIcons(
        normalizeCurrentHourTodayStart(
          windWithDatePrefixes,
          currentLocal.hour,
          currentLocal.minute,
        ),
        { todayLabel, tomorrowLabel, dayAfterTomorrowLabel, forecastTailLabel },
        typeof local["wave"]?.text_de === "string" && Boolean(local["wave"].text_de.trim()),
      );
    };
    let retryFeedback = "";
    let sectionsToCorrect = [...SECTION_KEYS];
    let windLineIndexesToCorrect: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) onRetry?.((attempt + 1) as 2 | 3);
      const messages: Anthropic.Messages.MessageParam[] = attempt === 0
        ? [{ role: "user", content }]
        : [
          { role: "user", content },
          { role: "assistant", content: formatSectionMarkers(parsed ?? {}) },
          {
            role: "user",
            content: `Korrigiere ausschließlich diese Abschnitte: ${sectionsToCorrect.join(", ")}.
Beim vorigen Output schlugen genau diese Prüfungen fehl: ${retryFeedback}.
Gib nur die Marker der genannten Abschnitte mit ihrem korrigierten Inhalt aus, danach ===END===.
Gib keinen anderen Abschnitt erneut aus; dessen bereits gültiger Inhalt wird unverändert bewahrt.
${sectionsToCorrect.includes("windWaves") && windLineIndexesToCorrect.length > 0
  ? `In Abschnitt 3 ändere ausschließlich ${windLineIndexesToCorrect.map(windForecastLineName).join(", ")}. Gib zur sicheren Zuordnung trotzdem Warnzeile und alle vier Prognosezeilen aus; kopiere die übrigen Prognosezeilen inhaltlich unverändert.`
  : ""}
Abschnitt 3 muss zusätzlich zur optionalen Warnzeile exakt vier eigene Prognosezeilen enthalten:
Heute (${todayLabel}), Morgen (${tomorrowLabel}), Übermorgen (${dayAfterTomorrowLabel}) und ${forecastTailLabel}.
Jede dieser vier Zeilen muss nach Präfix und Symbol einen inhaltlich vollständigen Prognosesatz enthalten; eine leere Zeile oder nur "💨" ist unzulässig.
Abschnitt 4 muss exakt drei eigene Prognosezeilen enthalten:
Heute (${todayLabel}), Morgen (${tomorrowLabel}) und ${forecastOverviewLabel}.
Abschnitt 4 darf keinerlei Wind-, Böen-, Wellen- oder Seegangsinformation enthalten.
Die Heute-Bullets dürfen nur die Zukunft ab ${currentLocal.label} beschreiben; entferne vergangene Uhrzeiten und abgeschlossene Tagesphasen.
Liegt der Analysezeitpunkt nach der vollen Stunde, schreibe für einen Beginn in derselben laufenden Stunde "ab jetzt" statt "ab HH Uhr".
Abschnitt 1 und Abschnitt 2 müssen jeweils exakt zwei inhaltlich vollständige Bullets enthalten; ein Bullet nur mit Symbol ist unzulässig.
Abschnitt 3: Jede numerische Windstärke muss genau als Wind–Böe-Paar wie "8–16 kt" erscheinen, niemals als Einzelwert. Jede Richtung muss genau eines der Kürzel N, NO, O, SO, S, SW, W oder NW sein; keine Zwischen- oder Kombinationsrichtung.
Abschnitt 3 muss interpretieren statt das Chart nachzuerzählen: Beginne jeden Prognosebullet mit Windfenster, lokalem Windmechanismus, markantem Dreher, Flaute oder seglerischer Konsequenz. Werte dienen nur als Beleg.
Heute und morgen in der Regel höchstens zwei Wind–Böe-Paare, Übermorgen höchstens eines. Ein zusätzlicher Übergangswert ist nur mit konkret erklärtem lokalem Effekt oder Frontdurchgang erlaubt.
Im letzten Mehrtagesbullet pro Tag ausnahmslos höchstens ein Wind–Böe-Paar; keine getrennte Morgen-/Nachmittags-/Abendfolge desselben Tages und insgesamt höchstens drei Paare.
Keine Peak-Transkription wie "Spitze um 09 Uhr". Gleichförmige Stunden zu einer Tendenz zusammenfassen.
Jede Prognosezeile beginnt mit "- ". Keine vorgeschriebene Prognosezeile des zu korrigierenden Abschnitts weglassen.`,
          },
        ];
      const msg = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1800,
        system: SYSTEM_PROMPT,
        messages,
      }, { signal });
      raw = msg.content[0]?.type === "text" ? msg.content[0].text.trim() : "";
      const correction = parseSectionMarkers(raw);
      if (attempt === 0) {
        parsed = correction;
      } else if (correction) {
        parsed ??= {};
        for (const section of sectionsToCorrect) {
          if (
            section === "windWaves"
            && correction.windWaves !== undefined
            && parsed.windWaves !== undefined
            && windLineIndexesToCorrect.length > 0
          ) {
            const previousWind = finalizeWindText(parsed.windWaves);
            const correctedWind = finalizeWindText(correction.windWaves);
            parsed.windWaves = mergeWindForecastLines(
              previousWind,
              correctedWind,
              expectedWarningLineCount,
              windLineIndexesToCorrect,
            ) ?? parsed.windWaves;
          } else if (correction[section] !== undefined) {
            parsed[section] = correction[section];
          }
        }
      }
      cloudsRainText = parsed
        ? normalizeCurrentHourTodayStart(
          enforceSection4Output(
            parsed.cloudsRain ?? null,
            { todayLabel, tomorrowLabel, forecastOverviewLabel },
            section4OutputConstraints,
          ),
          currentLocal.hour,
          currentLocal.minute,
        )
        : null;
      windWavesText = parsed ? finalizeWindText(parsed.windWaves) : null;
      const failedChecks = {
        parsed: !parsed,
        completeSection1: !hasTwoSubstantiveBullets(
          normalizeSection1Icons(parsed?.airPressureMasses ?? null),
        ),
        completeSection2: !hasTwoSubstantiveBullets(
          normalizeSection2Icons(parsed?.weatherFront ?? null, locationLabel),
        ),
        canonicalWind: !hasCanonicalWindForecast(
          windWavesText ?? undefined,
          { todayLabel, tomorrowLabel, dayAfterTomorrowLabel, forecastTailLabel },
          expectedWarningLineCount,
        ),
        windValueFormat: !hasValidWindValueFormat(windWavesText ?? undefined),
        conciseWindInterpretation: !hasConciseWindInterpretation(
          windWavesText ?? undefined,
          expectedWarningLineCount,
        ),
        pastWindToday: containsPastTodayContent(
          windWavesText ?? undefined,
          currentLocal.hour,
          currentLocal.minute,
        ),
        completeCloud: !cloudsRainText || !hasCompleteCloudForecast(cloudsRainText),
        forbiddenCloudContent: hasForbiddenSection4Content(cloudsRainText ?? undefined),
        pastCloudToday: containsPastTodayContent(
          cloudsRainText ?? undefined,
          currentLocal.hour,
          currentLocal.minute,
        ),
      };
      if (Object.values(failedChecks).every(failed => !failed)) break;

      const failedNames = Object.entries(failedChecks)
        .filter(([, failed]) => failed)
        .map(([name]) => name);
      retryFeedback = failedNames.join(", ");
      sectionsToCorrect = failedSections(failedChecks);
      const windDiagnostics = diagnoseWindForecast(
        windWavesText ?? undefined,
        expectedWarningLineCount,
      );
      windLineIndexesToCorrect = failedChecks.canonicalWind
        ? [0, 1, 2, 3]
        : [
          ...new Set([
            ...windDiagnostics.map(diagnostic => diagnostic.lineIndex),
            ...(failedChecks.pastWindToday ? [0] : []),
          ]),
        ].sort((a, b) => a - b);
      if (windDiagnostics.length > 0) {
        retryFeedback += `. Konkrete Windfehler: ${windDiagnostics
          .map(diagnostic => diagnostic.message)
          .join(" | ")}`;
      }
      if (failedChecks.conciseWindInterpretation) {
        retryFeedback += ". Zähle die Wind–Böe-Paare in jeder Abschnitt-3-Zeile: "
          + "Heute maximal 2, Morgen maximal 2, Übermorgen maximal 1 und im Mehrtagesausblick "
          + "maximal 1 je Tag sowie 3 insgesamt. Nur bei einem in derselben Zeile konkret erklärten "
          + "lokalen Effekt oder Frontdurchgang darf Heute/Morgen ein drittes und Übermorgen ein zweites Paar enthalten";
      }
      if (attempt < 2) {
        console.warn("generateWeatherOutput: retrying incomplete forecast sections", {
          attempt: attempt + 1,
          failedChecks,
        });
      }
    }
    if (
      !parsed
      || !hasTwoSubstantiveBullets(normalizeSection1Icons(parsed.airPressureMasses ?? null))
      || !hasTwoSubstantiveBullets(normalizeSection2Icons(parsed.weatherFront ?? null, locationLabel))
      || !hasCanonicalWindForecast(
        windWavesText ?? undefined,
        { todayLabel, tomorrowLabel, dayAfterTomorrowLabel, forecastTailLabel },
        expectedWarningLineCount,
      )
      || !hasValidWindValueFormat(windWavesText ?? undefined)
      || !hasConciseWindInterpretation(windWavesText ?? undefined, expectedWarningLineCount)
      || containsPastTodayContent(windWavesText ?? undefined, currentLocal.hour, currentLocal.minute)
      || !cloudsRainText
      || !hasCompleteCloudForecast(cloudsRainText)
      || hasForbiddenSection4Content(cloudsRainText)
      || containsPastTodayContent(cloudsRainText, currentLocal.hour, currentLocal.minute)
    ) {
      console.error("generateWeatherOutput: incomplete LLM contract", {
        windLines: parsed?.windWaves?.split(/\r?\n/).map(line => line.trim()).filter(Boolean) ?? [],
        normalizedWindLines: windWavesText?.split(/\r?\n/).map(line => line.trim()).filter(Boolean) ?? [],
        cloudLines: parsed?.cloudsRain?.split(/\r?\n/).map(line => line.trim()).filter(Boolean) ?? [],
        normalizedCloudLines: cloudsRainText?.split(/\r?\n/).map(line => line.trim()).filter(Boolean) ?? [],
        failedChecks: {
          parsed: !parsed,
          completeSection1: !hasTwoSubstantiveBullets(
            normalizeSection1Icons(parsed?.airPressureMasses ?? null),
          ),
          completeSection2: !hasTwoSubstantiveBullets(
            normalizeSection2Icons(parsed?.weatherFront ?? null, locationLabel),
          ),
          canonicalWind: !hasCanonicalWindForecast(
            windWavesText ?? undefined,
            { todayLabel, tomorrowLabel, dayAfterTomorrowLabel, forecastTailLabel },
            expectedWarningLineCount,
          ),
          windValueFormat: !hasValidWindValueFormat(windWavesText ?? undefined),
          conciseWindInterpretation: !hasConciseWindInterpretation(
            windWavesText ?? undefined,
            expectedWarningLineCount,
          ),
          pastWindToday: containsPastTodayContent(
            windWavesText ?? undefined,
            currentLocal.hour,
            currentLocal.minute,
          ),
          completeCloud: !cloudsRainText || !hasCompleteCloudForecast(cloudsRainText),
          forbiddenCloudContent: hasForbiddenSection4Content(cloudsRainText ?? undefined),
          pastCloudToday: containsPastTodayContent(
            cloudsRainText ?? undefined,
            currentLocal.hour,
            currentLocal.minute,
          ),
        },
      });
      throw new Error("Die Wetterinterpretation war unvollständig. Bitte erneut versuchen.");
    }

    const source = "claude-sonnet-4-6";
    return {
      airPressureMasses: { source, text: normalizeSection1Icons(parsed.airPressureMasses ?? null) },
      weatherFront:      {
        source,
        text: normalizeSection2Icons(parsed.weatherFront ?? null, locationLabel),
      },
      windWaves:         { source, text: windWavesText },
      cloudsRain:        {
        source,
        text: cloudsRainText,
      },
    };
  } catch (e) {
    console.error("generateWeatherOutput error:", e instanceof Error ? e.message : e);
    throw e;
  }
}

const SECTION_KEYS = ["airPressureMasses", "weatherFront", "windWaves", "cloudsRain"] as const;
type SectionKey = typeof SECTION_KEYS[number];

function formatSectionMarkers(sections: Record<string, string>): string {
  const blocks = SECTION_KEYS
    .filter(key => sections[key] !== undefined)
    .map(key => `===${key}===\n${sections[key]}`);
  return `${blocks.join("\n")}\n===END===`;
}

type WindScaffoldLabels = {
  todayLabel: string;
  tomorrowLabel: string;
  dayAfterTomorrowLabel: string;
  forecastTailLabel: string;
};

type WindScaffoldRow = {
  date: string;
  time: string;
  direction: string;
  speed: number;
  gust: number;
};

function formatWindNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value).replace(".", ",");
}

function selectWindScaffoldRows(rows: WindScaffoldRow[], maximum: number): WindScaffoldRow[] {
  if (rows.length <= maximum) return rows;
  const strongest = rows.reduce((best, row) => row.gust > best.gust ? row : best);
  if (maximum === 1) return [strongest];
  const first = rows[0];
  return first === strongest ? [strongest] : [first, strongest];
}

export function buildWindScaffold(
  hourlyText: string,
  labels: WindScaffoldLabels,
): string {
  const rows = hourlyText.split(/\r?\n/).flatMap((line): WindScaffoldRow[] => {
    const [date, time, direction, speedText, gustText] = line.split("|").map(value => value.trim());
    const speed = Number(speedText?.replace(",", "."));
    const gust = Number(gustText?.replace(",", "."));
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")
      || !/^\d{2}:\d{2}$/.test(time ?? "")
      || !/^(?:N|NO|O|SO|S|SW|W|NW)$/.test(direction ?? "")
      || !speedText
      || !gustText
      || !Number.isFinite(speed)
      || !Number.isFinite(gust)
      || gust < speed
    ) return [];
    return [{ date, time, direction, speed, gust }];
  });
  const grouped = new Map<string, WindScaffoldRow[]>();
  for (const row of rows) {
    const dayRows = grouped.get(row.date) ?? [];
    dayRows.push(row);
    grouped.set(row.date, dayRows);
  }
  const days = [...grouped.values()];
  if (days.length === 0) return "(kein belastbares Wind-Gerüst verfügbar)";
  const renderRows = (dayRows: WindScaffoldRow[], maximum: number) =>
    selectWindScaffoldRows(dayRows, maximum)
      .map(row => `${row.direction} ${formatWindNumber(row.speed)}–${formatWindNumber(row.gust)} kt (${row.time})`)
      .join("; ");
  const scaffold = [
    `Heute (${labels.todayLabel}), maximal 2 Paare: ${days[0] ? renderRows(days[0], 2) : "keine Paare verfügbar"}`,
    `Morgen (${labels.tomorrowLabel}), maximal 2 Paare: ${days[1] ? renderRows(days[1], 2) : "keine Paare verfügbar"}`,
    `Übermorgen (${labels.dayAfterTomorrowLabel}), maximal 1 Paar: ${days[2] ? renderRows(days[2], 1) : "kein Paar verfügbar"}`,
  ];
  const tailDays = days.slice(3, 6);
  scaffold.push(
    `${labels.forecastTailLabel}, maximal 1 Paar je Tag und 3 insgesamt: ${
      tailDays.length > 0
        ? tailDays.map(dayRows => `${dayRows[0].date}: ${renderRows(dayRows, 1)}`).join("; ")
        : "keine Paare verfügbar"
    }`,
  );
  return scaffold.map(line => `- ${line}`).join("\n");
}

function failedSections(failedChecks: Record<string, boolean>): SectionKey[] {
  if (failedChecks.parsed) return [...SECTION_KEYS];
  const sections = new Set<SectionKey>();
  if (failedChecks.completeSection1) sections.add("airPressureMasses");
  if (failedChecks.completeSection2) sections.add("weatherFront");
  if (
    failedChecks.canonicalWind
    || failedChecks.windValueFormat
    || failedChecks.conciseWindInterpretation
    || failedChecks.pastWindToday
  ) sections.add("windWaves");
  if (
    failedChecks.completeCloud
    || failedChecks.forbiddenCloudContent
    || failedChecks.pastCloudToday
  ) sections.add("cloudsRain");
  return [...sections];
}

function windForecastLineName(index: number): string {
  return ["die Heute-Zeile", "die Morgen-Zeile", "die Übermorgen-Zeile", "die Mehrtages-Zeile"][index]
    ?? `Prognosezeile ${index + 1}`;
}

function mergeWindForecastLines(
  previous: string | null,
  correction: string | null,
  warningLineCount: number,
  lineIndexes: number[],
): string | null {
  if (!previous || !correction) return previous;
  const previousLines = previous.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const correctedLines = correction.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const previousForecasts = previousLines.slice(warningLineCount);
  const correctedForecasts = correctedLines.slice(warningLineCount);
  if (correctedForecasts.length !== 4) return previous;
  for (const index of lineIndexes) {
    if (hasSubstantiveWindForecastLine(correctedForecasts[index])) {
      previousForecasts[index] = correctedForecasts[index];
    }
  }
  if (previousForecasts.length !== 4 || previousForecasts.some(line => !line)) return previous;
  return [...previousLines.slice(0, warningLineCount), ...previousForecasts].join("\n");
}

function hasCompleteWindForecast(text: string | undefined): boolean {
  if (!text) return false;
  const lines = text.split(/\r?\n/);
  const forecastLines = lines.filter(line =>
    /^\s*(?:-\s*)?(?:Heute|Morgen|Übermorgen)\b/i.test(line)
    || /^\s*(?:-\s*)?(?:Mo|Di|Mi|Do|Fr|Sa|So)\s+\d{1,2}\.\d{1,2}\.?\s*:/i.test(line)
    || /^\s*(?:-\s*)?(?:So|Mo|Di|Mi|Do|Fr|Sa)[–-](?:So|Mo|Di|Mi|Do|Fr|Sa)\s+\d{1,2}\./i.test(line),
  );
  const hasTail = lines.some(line =>
    /^\s*(?:-\s*)?(?:So|Mo|Di|Mi|Do|Fr|Sa)[–-](?:So|Mo|Di|Mi|Do|Fr|Sa)\s+\d{1,2}\./i.test(line),
  );
  return forecastLines.length >= 4 && hasTail;
}

function hasCanonicalWindForecast(
  text: string | undefined,
  labels: {
    todayLabel: string;
    tomorrowLabel: string;
    dayAfterTomorrowLabel: string;
    forecastTailLabel: string;
  },
  warningLineCount: number,
): boolean {
  if (!text) return false;
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const forecasts = lines.slice(warningLineCount);
  const expectedPrefixes = [
    `- Heute (${labels.todayLabel}):`,
    `- Morgen (${labels.tomorrowLabel}):`,
    `- Übermorgen (${labels.dayAfterTomorrowLabel}):`,
    `- ${labels.forecastTailLabel}:`,
  ];
  return forecasts.length === expectedPrefixes.length
    && expectedPrefixes.every((prefix, index) =>
      forecasts[index]?.startsWith(prefix)
      && hasSubstantiveWindForecastLine(forecasts[index]));
}

function hasSubstantiveWindForecastLine(line: string | undefined): boolean {
  if (!line) return false;
  const body = forecastBodyAfterLabel(line)
    .replace(/^(?:💨|🌊)\s*/gu, "")
    .trim();
  return (body.match(/\p{L}/gu) ?? []).length >= 5
    || /\b\d+(?:[.,]\d+)?\s*[–-]\s*\d+(?:[.,]\d+)?\s*kt\b/i.test(body);
}

function hasCompleteCloudForecast(text: string | undefined): boolean {
  if (!text) return false;
  const lines = text.split(/\r?\n/);
  const forecastLines = lines.filter(line =>
    /^\s*(?:-\s*)?(?:Heute|Morgen)\b/i.test(line)
    || /^\s*(?:-\s*)?(?:Mo|Di|Mi|Do|Fr|Sa|So)\s+\d{1,2}\.\d{1,2}\.?\s*:/i.test(line)
    || /^\s*(?:-\s*)?(?:So|Mo|Di|Mi|Do|Fr|Sa)[–-](?:So|Mo|Di|Mi|Do|Fr|Sa)\s+\d{1,2}\./i.test(line),
  );
  const hasTail = lines.some(line =>
    /^\s*(?:-\s*)?(?:So|Mo|Di|Mi|Do|Fr|Sa)[–-](?:So|Mo|Di|Mi|Do|Fr|Sa)\s+\d{1,2}\./i.test(line),
  );
  const hasSubstantiveContent = forecastLines
    .slice(0, 3)
    .every(line => {
      const colon = line.indexOf(":");
      return colon !== -1 && line.slice(colon + 1).trim().length > 0;
    });
  return forecastLines.length >= 3 && hasTail && hasSubstantiveContent;
}

function hasForbiddenSection4Content(text: string | undefined): boolean {
  return Boolean(text && /\b(?:Wind|Böe|Welle|Seegang)\w*\b/i.test(text));
}

export function hasTwoSubstantiveBullets(text: string | null): boolean {
  if (!text) return false;
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length !== 2) return false;
  return lines.every(line => {
    if (!/^-\s+/.test(line)) return false;
    const body = line
      .replace(/^-\s+/, "")
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .trim();
    return (body.match(/\p{L}/gu) ?? []).length >= 8;
  });
}

export function containsPastTodayContent(
  text: string | undefined,
  currentHour: number,
  currentMinute: number,
): boolean {
  if (!text) return false;
  const todayLines = text.split(/\r?\n/).filter(line =>
    /^\s*(?:-\s*)?Heute\b/i.test(line),
  );
  if (!todayLines.length) return false;

  const completedPeriods: RegExp[] = [];
  if (currentHour >= 10) completedPeriods.push(/\b(?:morgens|am\s+(?:frühen\s+)?Morgen|in\s+den\s+Morgenstunden)\b/i);
  if (currentHour >= 12) completedPeriods.push(/\b(?:vormittags?|am\s+Vormittag)\b/i);
  if (currentHour >= 14) completedPeriods.push(/\b(?:mittags?|zur\s+Mittagszeit|am\s+Mittag)\b/i);
  if (currentHour >= 18) completedPeriods.push(/\b(?:nachmittags?|am\s+Nachmittag)\b/i);
  if (currentHour >= 22) completedPeriods.push(/\b(?:abends|am\s+Abend)\b/i);
  if (todayLines.some(line => completedPeriods.some(pattern => pattern.test(line)))) return true;

  const currentMinutes = currentHour * 60 + currentMinute;
  const exactTimes = todayLines.join("\n").matchAll(
    /\b([01]?\d|2[0-3])(?::([0-5]\d)(?:\s*Uhr)?|\s*Uhr)\b/gi,
  );
  return Array.from(exactTimes).some(match => {
    const referencedMinutes = Number(match[1]) * 60 + Number(match[2] ?? 0);
    return referencedMinutes < currentMinutes;
  });
}

export function normalizeCurrentHourTodayStart(
  text: string | null,
  currentHour: number,
  currentMinute: number,
): string | null {
  if (!text || currentMinute <= 0) return text;
  const currentHourPattern = new RegExp(
    `\\bab\\s+0?${currentHour}(?:\\s*Uhr|:00(?:\\s*Uhr)?)\\b`,
    "gi",
  );
  return text.split(/\r?\n/).map(line =>
    /^\s*-\s*Heute\b/i.test(line)
      ? line.replace(currentHourPattern, "ab jetzt")
      : line
  ).join("\n");
}

function parseSectionMarkers(raw: string): Record<string, string> | null {
  const result: Record<string, string> = {};
  let found = 0;
  for (const key of SECTION_KEYS) {
    const startMarker = `===${key}===`;
    const start = raw.indexOf(startMarker);
    if (start === -1) continue;
    const contentStart = start + startMarker.length;
    // Next marker or ===END=== closes this section
    const nextMarkerIdx = SECTION_KEYS
      .filter(k => k !== key)
      .map(k => raw.indexOf(`===${k}===`, contentStart))
      .filter(i => i !== -1)
      .concat([raw.indexOf("===END===", contentStart)].filter(i => i !== -1))
      .reduce((min, i) => (i < min ? i : min), raw.length);
    result[key] = raw.slice(contentStart, nextMarkerIdx).trim();
    found++;
  }
  return found > 0 ? result : null;
}

const DATE_RANGE_PREFIX =
  /^(\s*)(?:-\s*)?(?:So|Mo|Di|Mi|Do|Fr|Sa)[–-](?:So|Mo|Di|Mi|Do|Fr|Sa)\s+\d{1,2}\.(?:\d{1,2}\.)?[–-]\d{1,2}\.\d{1,2}\.?\s*:/i;

function forecastBodyAfterLabel(line: string): string {
  let body = line.trim().replace(/^-\s*/, "");
  const relativePrefix = /^(?:Heute|Morgen|Übermorgen)(?:\s*\([^)]*\)|\s+(?:Mo|Di|Mi|Do|Fr|Sa|So)\s+\d{1,2}\.\d{1,2}\.?)?\s*/i;
  const calendarPrefix = /^(?:Mo|Di|Mi|Do|Fr|Sa|So)\s+\d{1,2}\.\d{1,2}\.?\s*/i;
  const rangePrefix = /^(?:So|Mo|Di|Mi|Do|Fr|Sa)[–-](?:So|Mo|Di|Mi|Do|Fr|Sa)\s+\d{1,2}\.(?:\d{1,2}\.)?[–-]\d{1,2}\.\d{1,2}\.?\s*/i;
  body = body
    .replace(relativePrefix, "")
    .replace(rangePrefix, "")
    .replace(calendarPrefix, "")
    .replace(/^:\s*/, "")
    .trim();
  return body;
}

function replaceRelativeDatePrefix(
  line: string,
  relativeLabel: "Heute" | "Morgen" | "Übermorgen",
  dateLabel: string,
): string {
  const pattern = new RegExp(
    `^(\\s*)(?:-\\s*)?${relativeLabel}(?:\\s*\\([^)]*\\)|\\s+(?:Mo|Di|Mi|Do|Fr|Sa|So)\\s+\\d{1,2}\\.\\d{1,2}\\.?)?\\s*:`,
    "i",
  );
  return line.replace(pattern, `$1- ${relativeLabel} (${dateLabel}):`);
}

export function enforceWindForecastDatePrefixes(
  text: string | null,
  labels: {
    todayLabel: string;
    tomorrowLabel: string;
    dayAfterTomorrowLabel: string;
    forecastTailLabel: string;
  },
): string | null {
  if (!text) return text;
  const canonicalPrefixes = [
    `- Heute (${labels.todayLabel}):`,
    `- Morgen (${labels.tomorrowLabel}):`,
    `- Übermorgen (${labels.dayAfterTomorrowLabel}):`,
    `- ${labels.forecastTailLabel}:`,
  ];
  let forecastIndex = 0;
  return text
    .split("\n")
    .map((line) => {
      const isForecastLine = /^\s*(?:-\s*)?(?:Heute|Morgen|Übermorgen)\b/i.test(line)
        || /^\s*(?:-\s*)?(?:Mo|Di|Mi|Do|Fr|Sa|So)\s+\d{1,2}\.\d{1,2}\.?(?:\s*\([^)]*\))?(?:\s|:)/i.test(line)
        || DATE_RANGE_PREFIX.test(line);
      if (!isForecastLine || forecastIndex >= canonicalPrefixes.length) return line;

      const body = forecastBodyAfterLabel(line);
      if (!body) return line;
      const prefix = canonicalPrefixes[forecastIndex];
      forecastIndex += 1;
      return `${prefix} ${body}`;
    })
    .join("\n");
}

export function ensureWindForecastIcons(
  text: string | null,
  labels: {
    todayLabel: string;
    tomorrowLabel: string;
    dayAfterTomorrowLabel: string;
    forecastTailLabel: string;
  },
  waveAvailable: boolean,
): string | null {
  if (!text) return text;
  const normalizedText = waveAvailable ? text : removeUnavailableWaveMentions(text);
  const forecastPrefixes = [
    `Heute (${labels.todayLabel}):`,
    `Morgen (${labels.tomorrowLabel}):`,
    `Übermorgen (${labels.dayAfterTomorrowLabel}):`,
    `${labels.forecastTailLabel}:`,
  ];
  return normalizedText.split("\n").map(line => {
    const prefix = forecastPrefixes.find(candidate =>
      line.trimStart().startsWith(`- ${candidate}`),
    );
    if (!prefix) return line;
    const marker = line.indexOf(prefix);
    const before = line.slice(0, marker + prefix.length);
    let body = line.slice(marker + prefix.length).trim();
    body = body.replace(/^(?:💨|🌊)\s*/u, "");
    if (!waveAvailable) body = body.replace(/🌊\s*/gu, "");
    body = `💨 ${body}`;
    if (waveAvailable && !/🌊/u.test(body)) {
      body = body.replace(/\b(See|Seegang|Welle|Wellen)\b/i, "🌊 $1");
    }
    return `${before} ${body}`.trimEnd();
  }).join("\n");
}

function removeUnavailableWaveMentions(text: string): string {
  const waveTerms = /\b(?:See(?:gang)?|Wellen?|Wellendaten|Seegangsdaten)\b|🌊/iu;
  const unavailableTerms = /\b(?:keine[nr]?|nicht|fehlen|fehlt|unverfügbar|nicht vorhanden)\b/iu;
  return text.split(/\r?\n/).map(line => {
    const prefixEnd = line.indexOf(":");
    if (prefixEnd === -1) return line;
    const prefix = line.slice(0, prefixEnd + 1);
    const body = line.slice(prefixEnd + 1).trim();
    const clauses = body
      .split(/;\s*|\s+—\s+/)
      .filter(clause => !(waveTerms.test(clause) && unavailableTerms.test(clause)))
      .filter(clause => !waveTerms.test(clause));
    return `${prefix}${clauses.length ? ` ${clauses.join("; ")}` : ""}`.trimEnd();
  }).join("\n");
}

export function enforceCloudForecastDatePrefixes(
  text: string | null,
  labels: {
    todayLabel: string;
    tomorrowLabel: string;
    forecastOverviewLabel: string;
  },
): string | null {
  if (!text) return text;
  const canonicalPrefixes = [
    `- Heute (${labels.todayLabel}):`,
    `- Morgen (${labels.tomorrowLabel}):`,
    `- ${labels.forecastOverviewLabel}:`,
  ];
  let forecastIndex = 0;
  return text
    .split("\n")
    .map((line) => {
      const isForecastLine = /^\s*(?:-\s*)?(?:Heute|Morgen)\b/i.test(line)
        || /^\s*(?:-\s*)?(?:Mo|Di|Mi|Do|Fr|Sa|So)\s+\d{1,2}\.\d{1,2}\.?(?:\s|:)/i.test(line)
        || DATE_RANGE_PREFIX.test(line);
      if (!isForecastLine || forecastIndex >= canonicalPrefixes.length) return line;

      const body = forecastBodyAfterLabel(line);
      if (!body) return line;
      const prefix = canonicalPrefixes[forecastIndex];
      forecastIndex += 1;
      return `${prefix} ${body}`;
    })
    .join("\n");
}

function broadDayPeriod(hour: number): string {
  if (hour < 6 || hour >= 22) return "nachts";
  if (hour < 10) return "morgens";
  if (hour < 14) return "mittags";
  if (hour < 18) return "nachmittags";
  return "abends";
}

function replaceExactClockTimes(text: string): string {
  return text.replace(
    /\b(?:(?:ab|bis|gegen|um)\s+)?([01]?\d|2[0-3])(?::[0-5]\d)?\s*Uhr\b/gi,
    (_match, hour) => broadDayPeriod(Number(hour)),
  );
}

export function stripStrongestGustMentions(text: string): string {
  return text
    .replace(/\s*\([^()\n]*\b(?:stärkste|höchste)\s+Böe\b[^()\n]*\)/gi, "")
    .replace(
      /(?:[;,]\s*)?(?:die\s+)?(?:stärkste|höchste)\s+Böe\b[^.;\n]*(?:[.;]|$)/gi,
      "",
    )
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;)])/g, "$1")
    .trim();
}

export function stripRedundantGustMentions(text: string): string {
  return text
    .replace(
      /(?:[;,]\s*|\s+)(?:(?:N|NO|O|SO|S|SW|W|NW)-)?(?:mit\s+)?Böen\b[^,.;\n]*?\b(?:kn|kt|Knoten)\b/gi,
      "",
    )
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;)])/g, "$1")
    .trim();
}

export function combineWindAndGustMentions(text: string): string {
  return text
    .replace(
      /(\b(?:Wind\s+)?(\d+(?:[.,]\d+)?)\s*)(kn|kt|Knoten)\s*[,;]\s*(?:mit\s+)?Böen\s+(?:bis\s+zu\s+)?(\d+(?:[.,]\d+)?)\s*\3\b/gi,
      (_match, prefix, _speed, unit, gust) => `${prefix.trimEnd()}–${gust} ${unit}`,
    )
    .replace(
      /\b((?:N|NO|O|SO|S|SW|W|NW)\s+)(\d+(?:[.,]\d+)?)\s*(kn|kt|Knoten)\s*[,;]\s*(?:mit\s+)?Böen\s+(?:bis\s+zu\s+)?(\d+(?:[.,]\d+)?)\s*\3\b/gi,
      (_match, direction, speed, unit, gust) => `${direction}${speed}–${gust} ${unit}`,
    );
}

export function normalizeWindUnits(text: string): string {
  return text.replace(/\b(?:kn|Knoten)\b/gi, "kt");
}

export function normalizeWindPairSeparators(text: string): string {
  return text
    .replace(
      /\b(\d+(?:[.,]\d+)?)\s+(?:bis)\s+(\d+(?:[.,]\d+)?)\s*kt\b/gi,
      "$1–$2 kt",
    )
    .replace(
      /\b(\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)\s*kt\b/gi,
      "$1–$2 kt",
    );
}

export function normalizeCalmThresholdMentions(text: string): string {
  return text
    .replace(/\bauf\s+unter\s+[0-3](?:[.,]\d+)?\s*kt\b/gi, "bis zur Flaute")
    .replace(/\bunter\s+[0-3](?:[.,]\d+)?\s*kt\b/gi, "nahezu Flaute");
}

export function hasValidWindValueFormat(text: string | undefined): boolean {
  if (!text) return false;
  const forecasts = text
    .split(/\r?\n/)
    .filter(line => /^\s*-\s*(?:Heute|Morgen|Übermorgen|(?:Mo|Di|Mi|Do|Fr|Sa|So)[–-])/i.test(line))
    .join("\n");
  if (!forecasts) return false;

  const forbiddenIntermediateDirection = /\b(?:NNO|ONO|OSO|SSO|SSW|WSW|WNW|NNW)\b/i;
  const canonicalDirection = "(?:N|NO|O|SO|S|SW|W|NW)";
  const compositeDirection = new RegExp(
    `\\b${canonicalDirection}(?:\\s*(?:/|[–—-])\\s*|\\s+bis\\s+|\\s+)${canonicalDirection}\\b`,
    "i",
  );
  const directionValidationText = windDirectionValidationText(forecasts);
  if (
    forbiddenIntermediateDirection.test(directionValidationText)
    || compositeDirection.test(directionValidationText)
  ) {
    return false;
  }

  const withoutValidPairs = forecasts.replace(
    /\b\d+(?:[.,]\d+)?\s*[–-]\s*\d+(?:[.,]\d+)?\s*kt\b/gi,
    "",
  );
  return !/\b\d+(?:[.,]\d+)?\s*(?:kt|kn|Knoten)\b/i.test(withoutValidPairs)
    && !/\b(?:kn|Knoten)\b/i.test(forecasts);
}

function windDirectionValidationText(text: string): string {
  return text
    .split(/\r?\n/)
    .map(line => line
      .replace(/^.*?:\s*/, "")
      .replace(/\b(?:So|Mo|Di|Mi|Do|Fr|Sa)\s+(?=(?:N|NO|O|SO|S|SW|W|NW)\b)/g, ""))
    .join("\n");
}

export type WindForecastDiagnostic = {
  lineIndex: number;
  message: string;
};

export function diagnoseWindForecast(
  text: string | undefined,
  warningLineCount = 0,
): WindForecastDiagnostic[] {
  if (!text) return [{ lineIndex: 0, message: "Abschnitt 3 fehlt vollständig" }];
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(warningLineCount);
  if (lines.length !== 4) {
    return [{ lineIndex: 0, message: `Abschnitt 3 enthält ${lines.length} statt 4 Prognosezeilen` }];
  }
  const diagnostics: WindForecastDiagnostic[] = [];
  const pairPattern = /\b\d+(?:[.,]\d+)?\s*[–-]\s*\d+(?:[.,]\d+)?\s*kt\b/gi;
  const intermediate = /\b(?:NNO|ONO|OSO|SSO|SSW|WSW|WNW|NNW)\b/i;
  const canonicalDirection = "(?:N|NO|O|SO|S|SW|W|NW)";
  const composite = new RegExp(
    `\\b${canonicalDirection}(?:\\s*(?:/|[–—-])\\s*|\\s+bis\\s+|\\s+)${canonicalDirection}\\b`,
    "i",
  );
  const standardMaximumPairs = [2, 2, 1, 3];
  const absoluteMaximumPairs = [3, 3, 2, 3];
  const interpretiveSignal =
    /\b(?:Leitha|Meltemi|Bora|Maestral|therm\w*|Düsen?\w*|Kanalis\w*|Fallwind\w*|Lee(?:effekt)?|Konvergenz\w*|Druckgradient\w*|Kaltsektor\w*|Frontdurchgang\w*|Segelfenster\w*|räumlich\w*|böig)\b/i;
  lines.forEach((line, lineIndex) => {
    if (!hasSubstantiveWindForecastLine(line)) {
      diagnostics.push({
        lineIndex,
        message: `${windForecastLineName(lineIndex)} enthält keinen substanziellen Prognosetext: ${line}`,
      });
    }
    const pairCount = (line.match(pairPattern) ?? []).length;
    const allowed = interpretiveSignal.test(line)
      ? absoluteMaximumPairs[lineIndex]
      : standardMaximumPairs[lineIndex];
    if (pairCount > allowed) {
      diagnostics.push({
        lineIndex,
        message: `${windForecastLineName(lineIndex)} enthält ${pairCount} Wind–Böe-Paare, erlaubt sind ${allowed}: ${line}`,
      });
    }
    const withoutPairs = line.replace(pairPattern, "");
    if (/\b\d+(?:[.,]\d+)?\s*(?:kt|kn|Knoten)\b/i.test(withoutPairs)) {
      diagnostics.push({
        lineIndex,
        message: `${windForecastLineName(lineIndex)} enthält mindestens einen Wind-Einzelwert statt eines Paares: ${line}`,
      });
    }
    const directionText = windDirectionValidationText(line);
    if (intermediate.test(directionText) || composite.test(directionText)) {
      diagnostics.push({
        lineIndex,
        message: `${windForecastLineName(lineIndex)} enthält eine Zwischen- oder Kombinationsrichtung: ${line}`,
      });
    }
    if (/\b(?:Spitze|Maximum|Höchstwert)\s+(?:um|gegen)\s+\d{1,2}(?::\d{2})?\b/i.test(line)) {
      diagnostics.push({
        lineIndex,
        message: `${windForecastLineName(lineIndex)} transkribiert einen Peak-Zeitpunkt: ${line}`,
      });
    }
  });
  return diagnostics;
}

export function hasConciseWindInterpretation(
  text: string | undefined,
  warningLineCount = 0,
): boolean {
  if (!text) return false;
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const forecastLines = lines.slice(warningLineCount);
  if (forecastLines.length !== 4) return false;
  const pairPattern = /\b\d+(?:[.,]\d+)?\s*[–-]\s*\d+(?:[.,]\d+)?\s*kt\b/gi;
  const standardMaximumPairs = [2, 2, 1, 3];
  const absoluteMaximumPairs = [3, 3, 2, 3];
  const interpretiveSignal =
    /\b(?:Leitha|Meltemi|Bora|Maestral|therm\w*|Düsen?\w*|Kanalis\w*|Fallwind\w*|Lee(?:effekt)?|Konvergenz\w*|Druckgradient\w*|Kaltsektor\w*|Frontdurchgang\w*|Segelfenster\w*|räumlich\w*|böig)\b/i;
  if (forecastLines.some((line, index) => {
    const pairCount = (line.match(pairPattern) ?? []).length;
    return pairCount > absoluteMaximumPairs[index]
      || (pairCount > standardMaximumPairs[index] && !interpretiveSignal.test(line));
  })) return false;
  return !forecastLines.some(line =>
    /\b(?:Spitze|Maximum|Höchstwert)\s+(?:um|gegen)\s+\d{1,2}(?::\d{2})?\b/i.test(line)
  );
}

export function restoreWindGustRanges(text: string, localWindText: unknown): string {
  if (typeof localWindText !== "string" || !localWindText.trim()) return text;

  const rangesByDay = new Map<string, Map<number, number>>();
  for (const line of localWindText.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const dateLabel = line.slice(0, separator).trim();
    const ranges = rangesByDay.get(dateLabel) ?? new Map<number, number>();
    for (const match of line.matchAll(
      /\b\d{2}:00\s+(?:N|NO|O|SO|S|SW|W|NW)\s+Wind\s+(\d+)\s*[–-]\s*(\d+)\s*kt\b/gi,
    )) {
      ranges.set(Number(match[1]), Number(match[2]));
    }
    if (ranges.size > 0) rangesByDay.set(dateLabel, ranges);
  }

  return text.split(/\r?\n/).map(line => {
    const dateMatch = line.match(/^(?:-\s*)?(?:Heute|Morgen|Übermorgen)\s*\(([^)]+)\)/i);
    const ranges = dateMatch ? rangesByDay.get(dateMatch[1].trim()) : undefined;
    if (!ranges) return line;

    const addRange = (match: string, direction: string, speedText: string, unit: string) => {
      const gust = ranges.get(Number(speedText.replace(",", ".")));
      return typeof gust === "number"
        ? `${direction}${speedText}–${gust} ${unit}`
        : match;
    };

    return line
      .replace(
        /\b((?:N|NO|O|SO|S|SW|W|NW)\s+(?:Wind\s+)?)(\d+(?:[.,]\d+)?)\s*(kt|kn)\b/gi,
        addRange,
      )
      .replace(
        /\b(Wind\s+)(\d+(?:[.,]\d+)?)\s*(kt|kn)\b/gi,
        addRange,
      )
      .replace(
        /\b(\d+(?:[.,]\d+)?)\s*(kt|kn)\b/gi,
        (match, speedText: string, unit: string) => {
          const gust = ranges.get(Number(speedText.replace(",", ".")));
          return typeof gust === "number"
            ? `${speedText}–${gust} ${unit}`
            : match;
        },
      );
  }).join("\n");
}

export function stripRedundantWindRangeMentions(text: string): string {
  return text
    .replace(
      /(\bWind\s+(\d+(?:[.,]\d+)?)\s*[–-]\s*(\d+(?:[.,]\d+)?)\s*kt)(,\s*[^,.;\n]*?\b(?:bis zu|bis)\s+(\d+(?:[.,]\d+)?)\s*kt)/gi,
      (match, windRange, _minimum, maximum, _repeatedClause, repeatedMaximum) =>
        Number(maximum.replace(",", ".")) === Number(repeatedMaximum.replace(",", "."))
          ? windRange
          : match,
    )
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;)])/g, "$1")
    .trim();
}

export function softenGustyDescriptions(text: string): string {
  return text
    .replace(
      /\bungewöhnlich(?:e|er|es|en)?\s+(böig(?:e|er|en|es)?)\b/gi,
      "$1",
    )
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function roundTemperatureMentions(text: string): string {
  return text.replace(
    /(-?\d+(?:[,.]\d+))\s*°\s*C/gi,
    (_match, value) => `${Math.round(Number(value.replace(",", ".")))}°C`,
  );
}

function stripCloudPercentages(text: string): string {
  return text
    .replace(
      /\bNiederschlagswahrscheinlichkeit\s+(?:steigt|erhöht\s+sich|nimmt\s+zu)?\s*(?:auf|bis)?\s*\d{1,3}\s*%/gi,
      "Niederschlagsneigung",
    )
    .replace(/\s*\(\s*(?:bis|ca\.?|circa|rund|etwa)?\s*\d{1,3}\s*%\s*\)/gi, "")
    .replace(/\s*\(?\d{1,3}\s*[–-]\s*\d{1,3}\s*%\)?/g, "")
    .replace(/\s*\(?\d{1,3}\s*%\)?/g, "")
    .replace(/\(\s*bis\s*(?=[,.;]|$)/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function stripTechnicalWeatherCodes(text: string): string {
  return text
    .replace(/\s*\(\s*WMO[-\s]?Code\s*[:#]?\s*\d{1,3}\s*\)/gi, "")
    .replace(/\bWMO[-\s]?Code\s*[:#]?\s*\d{1,3}\b/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function stripRoutineEveningCooling(text: string): string {
  return text
    .replace(
      /,\s*(?:abends|am Abend)\s+(?:(?:rasch|schnell|allmählich|normal)(?:e|er|es|en)?\s+)?(?:Temperatur(?:rückgang|abfall|abkühlung)|Rückgang|Abkühlung|kühler)[^.;,]*/gi,
      "",
    )
    .replace(
      /(?:abends|am Abend)\s+(?:(?:rasch|schnell|allmählich|normal)(?:e|er|es|en)?\s+)?(?:Temperatur(?:rückgang|abfall|abkühlung)|Rückgang|Abkühlung|kühler)[^.;,]*/gi,
      "",
    )
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,;])/g, "$1")
    .trim();
}

function stripRainAmounts(text: string): string {
  return text
    // Remove parenthetical amounts first so qualitative rain wording survives.
    .replace(/\s*\([^()]*\d+(?:[,.]\d+)?\s*mm[^()]*\)/gi, "")
    // A total amount adds no information beyond the chart and leaves awkward
    // fragments if only its number is removed.
    .replace(
      /\b(?:Tages(?:summe|menge)|Gesamtsumme|Niederschlagsmenge)\b[^.;]*\d+(?:[,.]\d+)?\s*mm[^.;]*[.;]?/gi,
      "",
    )
    .replace(/(?:~|ca\.?|circa|rund|etwa)?\s*\d+(?:[,.]\d+)?\s*mm\b/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;])/g, "$1")
    .replace(/;\s*([.;])/g, "$1")
    .trim();
}

function roundDecimalPressureMentions(text: string): string {
  return text.replace(
    /(-?\d+(?:[,.]\d+))\s*hPa\b/gi,
    (_match, value) => `${Math.round(Number(value.replace(",", ".")))} hPa`,
  );
}

function stripNegatedThunderstormMentions(text: string): string {
  return text
    .replace(
      /(?:,\s*|;\s*)?\b(?:kein(?:e[snr]?)?|ohne)\s+(?:lokales?\s+)?Gewitter\w*\b/gi,
      "",
    )
    .replace(/\s+([,.;])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function removeSection4Clauses(
  line: string,
  forbidden: RegExp,
): string {
  const prefixEnd = line.indexOf(":");
  if (prefixEnd === -1) return line;
  const prefix = line.slice(0, prefixEnd + 1);
  const body = line.slice(prefixEnd + 1).trim();
  const clauses = body
    .split(/;\s*|\s+—\s+/)
    .filter(clause => clause && !forbidden.test(clause));
  return clauses.length
    ? `${prefix} ${clauses.join("; ")}`
    : prefix;
}

function section4IconFor(body: string): string {
  const positiveWeather = body
    .replace(
      /\b(?:kein|keine|keinen|keinerlei|ohne)\s+(?:[\p{L}-]+\s+){0,2}(?:Regen|Niederschlag|Schauer|Gewitter|Schnee)\w*/giu,
      "",
    )
    .replace(/\b(?:trocken|niederschlagsfrei)\b/gi, "");
  if (/\b(?:Gewitter|Donner|Blitz)\w*\b/i.test(positiveWeather)) return "⛈️";
  if (/\b(?:Schnee|Schneefall|Schneeschauer)\w*\b/i.test(positiveWeather)) return "❄️";
  if (/\b(?:Regen|Niederschlag|Schauer|Niesel)\w*\b/i.test(positiveWeather)) return "🌧️";
  if (/\b(?:Nebel|Dunst)\w*\b/i.test(body)) return "🌫️";
  if (
    /\b(?:sonnig|Sonne|klar|wolkenlos|Aufheiterung|Auflockerung)\w*\b/i.test(body)
    && /\b(?:Wolke|Bewölkung|bewölkt|wolkig)\w*\b/i.test(body)
  ) return "🌤️";
  if (/\b(?:Wolke|Bewölkung|bewölkt|wolkig|bedeckt|Altostratus|Cumulus)\w*\b/i.test(body)) {
    return "☁️";
  }
  if (/\b(?:sonnig|Sonne|klar|wolkenlos|trocken|Hochdruck|stabil|warm)\w*\b/i.test(body)) {
    return "☀️";
  }
  return "🌤️";
}

export function ensureSection4Icons(text: string | null): string | null {
  if (!text) return text;
  const leadingWeatherIcon = /^(?:☀️|⛅|☁️|🌥️|🌤️|🌧️|🌦️|⛈️|❄️|🌫️)\s*/u;
  return text.split("\n").map((line) => {
    const match = line.match(/^(\s*-\s*[^:]+:\s*)(.*)$/);
    if (!match) return line;
    const body = match[2].trim();
    if (leadingWeatherIcon.test(body)) return line;
    return `${match[1]}${section4IconFor(body)} ${body}`;
  }).join("\n");
}

export function enforceSection4Output(
  text: string | null,
  labels: {
    todayLabel: string;
    tomorrowLabel: string;
    forecastOverviewLabel: string;
  },
  constraints?: {
    pressureSignificant?: boolean[];
    thunderstormAllowed?: boolean[];
  },
): string | null {
  const prefixed = enforceCloudForecastDatePrefixes(text, labels);
  if (!prefixed) return prefixed;

  const bullets = prefixed
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.startsWith("- ") ? line : `- ${line.replace(/^•\s*/, "")}`);
  if (bullets.length < 3) return null;

  const canonicalPrefixes = [
    `- Heute (${labels.todayLabel}):`,
    `- Morgen (${labels.tomorrowLabel}):`,
    `- ${labels.forecastOverviewLabel}:`,
  ];
  const exactlyThree = bullets.slice(0, 3).map((line, index) => {
    const body = forecastBodyAfterLabel(line);
    return body ? `${canonicalPrefixes[index]} ${body}` : line;
  });
  exactlyThree[1] = replaceExactClockTimes(exactlyThree[1]);
  const sanitizedOutput = exactlyThree
    .map((line, index) => {
      let sanitized = removeSection4Clauses(
        roundTemperatureMentions(line),
        /(?:\bTemperatur(?:rückgang|abfall|anstieg)\b[^;]*?\b(?:[0-3](?:[,.]\d+)?)\s*°\s*C\b)/i,
      );
      sanitized = removeSection4Clauses(
        sanitized,
        /(?:\bTemperatur(?:rückgang|abfall|anstieg)\b[^;]*?\b\d{1,2}(?::[0-5]\d)?\s*[–-]\s*\d{1,2}(?::[0-5]\d)?\s*Uhr\b)/i,
      );
      sanitized = stripCloudPercentages(sanitized);
      sanitized = stripRoutineEveningCooling(sanitized);
      sanitized = stripTechnicalWeatherCodes(sanitized);
      sanitized = stripRainAmounts(sanitized);
      sanitized = roundDecimalPressureMentions(sanitized);
      if (constraints?.pressureSignificant?.[index] === false) {
        sanitized = removeSection4Clauses(sanitized, /(?:\bDruck\b|\bhPa\b|📉|📈)/i);
      }
      if (constraints?.thunderstormAllowed?.[index] === false) {
        sanitized = stripNegatedThunderstormMentions(sanitized);
        sanitized = removeSection4Clauses(
          sanitized,
          /(?:\bGewitter\w*\b|\bCumulonimbus\b|\bCb-Signal\b|⛈️)/i,
        );
      }
      return sanitized;
    })
    .join("\n");
  if (sanitizedOutput.split("\n").some(line => line.trimEnd().endsWith(":"))) return null;
  return ensureSection4Icons(sanitizedOutput);
}

export function ensureWarningFirst(analysis: AnalysisJson, windWavesText: string | null): string | null {
  const warningCenter = analysis.sources.nationalWarningCenter;
  const output = typeof windWavesText === "string" ? windWavesText.trim() : "";
  if (!warningCenter) return removeNationalWarningLines(output) || null;

  if (warningCenter.status === "unsupported") {
    return removeNationalWarningLines(output) || null;
  }
  if (warningCenter.status !== "integrated" && warningCenter.status !== "unavailable") {
    return windWavesText;
  }

  const warning = (analysis.weatherPreprocessed.local.warnings as {
    text_de?: unknown;
    source?: unknown;
    checked?: unknown;
  } | undefined);
  const warningText = warning?.checked === true && typeof warning.text_de === "string" && warning.text_de.trim()
    ? warning.text_de.trim()
    : `Nationale Sturmwarnquelle ${warningCenter.label ?? "des Landes"} derzeit nicht erreichbar`;
  const isNoWarning = /\bkeine\s+(?:aktive\s+)?(?:sturmwarnung|warnung)\b/i.test(warningText);
  const warningPrefix = isNoWarning ? "" : "⚠️ ";
  const warningFirstLine = warningText.split("\n")[0];

  const remainingLines = removeNationalWarningLines(output, warningFirstLine)
    .split("\n")
    .filter((line) => !line.includes(warningFirstLine));
  return [`- ${warningPrefix}${warningText}`, ...remainingLines].filter(Boolean).join("\n");
}

function removeNationalWarningLines(text: string, authoritativeFirstLine?: string): string {
  if (!text) return "";
  const lines = text.split("\n");
  const remaining: string[] = [];
  let skippingContinuation = false;
  const warningMention =
    /\b(?:sturmwarnung|starkwindwarnung|unwetterwarnung|warnquelle|warnzentrum|keine\s+(?:aktive\s+)?warnung|warnung\s+von\s+(?:hnms|dhmz|lsz)|(?:hnms|dhmz|lsz)\s+warnt)\b/i;
  for (const line of lines) {
    const startsForecastLine = /^\s*(?:-\s*)?(?:Heute|Morgen|Übermorgen)\b/i.test(line)
      || /^\s*(?:-\s*)?(?:So|Mo|Di|Mi|Do|Fr|Sa)[–-](?:So|Mo|Di|Mi|Do|Fr|Sa)\b/i.test(line)
      || /^\s*(?:-\s*)?(?:Mo|Di|Mi|Do|Fr|Sa|So)\s+\d{1,2}\.\d{1,2}\.?(?:\s*\([^)]*\)|\s+ab\s+jetzt)?\s*:/i.test(line);
    const cleanedLine = startsForecastLine
      ? line
        .split(/;\s*/)
        .filter(clause => !warningMention.test(clause))
        .join("; ")
        .replace(/\s+([,.;])/g, "$1")
      : line;
    const isWarningLine = !startsForecastLine && (
      Boolean(authoritativeFirstLine && cleanedLine.includes(authoritativeFirstLine))
      || warningMention.test(cleanedLine)
      || Boolean(authoritativeFirstLine && !remaining.length)
    );
    if (isWarningLine) {
      skippingContinuation = true;
      continue;
    }
    if (skippingContinuation && !/^\s*-\s+/.test(line) && !startsForecastLine) continue;
    skippingContinuation = false;
    remaining.push(cleanedLine);
  }
  return remaining.join("\n").trim();
}
