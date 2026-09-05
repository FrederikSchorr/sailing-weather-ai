import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Send, Sailboat, Camera, MapPin, Image, Wind, Compass, Anchor, Waves, Sun, Cloud, CloudRain, Thermometer, Navigation, Flag, CloudSun, Droplets, Ship, Info, Mail, type LucideIcon } from "lucide-react";
import { SiGithub } from "react-icons/si";
import { FaLinkedin } from "react-icons/fa";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ChatMessage, GeocodeResult, WeatherEuropeSSE, WeatherOutputData } from "@shared/schema";
import CityMeteogram from "@/components/city-meteogram";
import SeaWindForecast from "@/components/sea-wind-forecast";

const KNMI_SOURCE_URL = "https://cdn.knmi.nl/knmi/map/page/weer/waarschuwingen_verwachtingen/weerkaarten";
const MAX_CHAT_HISTORY_CONTENT = 2000;

interface AnalysisSources {
  windy: string[];
  national: string[];
  europe: string[];
  nationalWarningCenter?: {
    status: "integrated" | "unavailable" | "unsupported";
    label?: string;
    url?: string;
  };
}

interface SSEPayload {
  location?: GeocodeResult;
  weatherEurope?: WeatherEuropeSSE;
  weatherOutput?: WeatherOutputData;
  analysisJson?: Record<string, unknown>;
  analysisFileName?: string;
  sources?: AnalysisSources;
  content?: string;
  error?: string;
  done?: boolean;
  loadingStatus?: string;
  analysisJobId?: string;
  analysisToken?: string;
  analysisEventId?: number;
}

interface AnalysisJobState {
  jobId: string;
  token: string;
  messageId: string;
  status: "pending" | "running" | "completed" | "failed";
}

interface UploadPreview {
  url: string;
  thumbnailUrl?: string;
  time?: string | null;
  locationName?: string | null;
  countryCode?: string | null;
  isVideo?: boolean;
}

const LAST_ANALYSIS_STORAGE_KEY = "aiwindy:last-completed-analysis";

interface PersistedAnalysisState {
  messages: ChatMessage[];
  activeLocation: GeocodeResult;
  assistantId: string;
  weatherEurope: WeatherEuropeSSE | null;
  weatherOutput: WeatherOutputData;
  analysisJson: Record<string, unknown>;
  analysisFileName: string | null;
  sources: AnalysisSources | null;
}

function loadPersistedAnalysis(): PersistedAnalysisState | null {
  if (typeof window === "undefined") return null;
  try {
    const historyAnalysis = (window.history.state as Record<string, unknown> | null)?.[
      LAST_ANALYSIS_STORAGE_KEY
    ];
    const raw = window.localStorage.getItem(LAST_ANALYSIS_STORAGE_KEY);
    const parsed = (
      historyAnalysis && typeof historyAnalysis === "object"
        ? historyAnalysis
        : raw
          ? JSON.parse(raw)
          : null
    ) as Partial<PersistedAnalysisState> | null;
    if (
      !parsed
      || !Array.isArray(parsed.messages)
      || !parsed.activeLocation
      || typeof parsed.assistantId !== "string"
      || !parsed.weatherOutput
      || !parsed.weatherOutput.cloudsRain?.text?.trim()
      || !parsed.analysisJson
    ) {
      window.localStorage.removeItem(LAST_ANALYSIS_STORAGE_KEY);
      return null;
    }
    return parsed as PersistedAnalysisState;
  } catch {
    window.localStorage.removeItem(LAST_ANALYSIS_STORAGE_KEY);
    return null;
  }
}

function persistAnalysis(state: PersistedAnalysisState): void {
  try {
    window.localStorage.setItem(LAST_ANALYSIS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // history.state below remains available when persistent storage is blocked.
  }
  try {
    window.history.replaceState(
      {
        ...(window.history.state && typeof window.history.state === "object"
          ? window.history.state
          : {}),
        [LAST_ANALYSIS_STORAGE_KEY]: state,
      },
      "",
    );
  } catch {
    // localStorage above remains available when the history entry is too large.
  }
}

function WindyEmbed({ lat, lon, overlay, product, level, zoom, forecast, marker }: {
  lat: number; lon: number; overlay: string; product: string; level: string; zoom: number; forecast?: boolean; marker?: boolean;
}) {
  const markerVal = marker ? "true" : "false";
  const src = forecast
    ? `https://embed.windy.com/embed2.html?type=forecast&location=coordinates&metricRain=mm&metricTemp=%C2%B0C&metricWind=kt&zoom=${zoom}&overlay=${overlay}&product=${product}&level=${level}&lat=${lat}&lon=${lon}&detailLat=${lat}&detailLon=${lon}&marker=${markerVal}&message=true&pressure=true&calendar=now`
    : `https://embed.windy.com/embed2.html?type=map&location=coordinates&metricRain=mm&metricTemp=%C2%B0C&metricWind=kt&zoom=${zoom}&overlay=${overlay}&product=${product}&level=${level}&lat=${lat}&lon=${lon}${marker ? `&detailLat=${lat}&detailLon=${lon}` : ""}&marker=${markerVal}&message=true&pressure=true&calendar=now`;

  return (
    <iframe
      title={`${overlay}-${product}`}
      src={src}
      className="block w-full border-0 rounded-lg"
      style={{ height: forecast ? "186px" : "300px" }}
      frameBorder="0"
    />
  );
}

function SourceLink({ label, provider, url }: { label: string; provider: string; url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-block text-sm text-muted-foreground hover:text-primary transition-colors mt-1 mb-0.5"
      data-testid="source-link"
    >
      {label} ↗ {provider}
    </a>
  );
}

function MarkdownContent({
  content,
  forceBullets = false,
}: {
  content: string;
  forceBullets?: boolean;
}) {
  const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  const sanitizeUrl = (url: string): string => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
      return parsed.href;
    } catch {
      return "";
    }
  };

  const links: string[] = [];
  const withPlaceholders = content.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, text, url) => {
    const safeUrl = sanitizeUrl(url);
    if (!safeUrl) return escapeHtml(text);
    const idx = links.length;
    links.push(`<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" class="text-primary underline hover:text-primary/80">${escapeHtml(text)}</a>`);
    return `%%LINK${idx}%%`;
  });

  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const escaped = escape(withPlaceholders);
  const lines = escaped.split("\n");
  const parts: string[] = [];
  let inList = false;
  let inSubList = false;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const hasBulletMarker = trimmed.startsWith("- ") || trimmed.startsWith("• ");
    const isBullet = hasBulletMarker || (forceBullets && trimmed.length > 0);
    const indent = line.length - line.trimStart().length;
    const isSubBullet = isBullet && indent >= 2;

    if (isBullet) {
      const text = hasBulletMarker ? trimmed.slice(2) : trimmed;
      if (isSubBullet) {
        if (!inSubList) {
          inSubList = true;
          parts.push('<ul class="ml-4 mt-0.5 mb-0.5 space-y-0">');
        }
        parts.push(`<li class="text-[15px] leading-snug text-muted-foreground pl-1" style="list-style:none">– ${text}</li>`);
      } else {
        if (inSubList) { inSubList = false; parts.push("</ul>"); }
        if (!inList) { inList = true; parts.push('<ul class="mt-0 mb-1.5 space-y-0.5">'); }
        parts.push(`<li class="text-[15px] leading-snug pl-1" style="list-style:disc;margin-left:1rem">${text}</li>`);
      }
    } else {
      if (inSubList) { inSubList = false; parts.push("</ul>"); }
      if (inList) { inList = false; parts.push("</ul>"); }

      let processed = trimmed
        .replace(/^### (.+)/, '<h3 class="text-sm font-semibold mt-2.5 mb-0.5">$1</h3>')
        .replace(/^## (.+)/, '<h2 class="text-base font-bold mt-3 mb-1">$1</h2>')
        .replace(/^# (.+)/, '<h1 class="text-lg font-bold mt-3 mb-1">$1</h1>');

      if (processed === trimmed && trimmed === "") {
        parts.push('<div class="h-1.5"></div>');
      } else if (processed === trimmed) {
        parts.push(`<p class="text-[15px] leading-snug">${processed}</p>`);
      } else {
        parts.push(processed);
      }
    }
  }
  if (inSubList) parts.push("</ul>");
  if (inList) parts.push("</ul>");

  let html = parts.join("")
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');

  links.forEach((link, i) => {
    html = html.replace(`%%LINK${i}%%`, link);
  });

  return <div className="text-[15px] leading-snug" dangerouslySetInnerHTML={{ __html: html }} />;
}

function BounceLoader() {
  return (
    <span className="inline-flex items-center gap-0.5 ml-1 mt-2 align-baseline" data-testid="bounce-loader">
      <span className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: "0ms" }} />
      <span className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: "150ms" }} />
      <span className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: "300ms" }} />
    </span>
  );
}

const STATUS_ICONS: LucideIcon[] = [
  Sailboat, Wind, Compass, Anchor, Waves, Sun, Cloud, CloudRain,
  Thermometer, Navigation, Flag, CloudSun, Droplets, Ship, MapPin,
];

function StatusLoader({ text }: { text: string }) {
  const [iconIndex, setIconIndex] = useState(0);
  useEffect(() => {
    setIconIndex(Math.floor(Math.random() * STATUS_ICONS.length));
    const interval = setInterval(() => {
      setIconIndex(prev => (prev + 1) % STATUS_ICONS.length);
    }, 1000);
    return () => clearInterval(interval);
  }, [text]);
  const Icon = STATUS_ICONS[iconIndex];
  return (
    <div className="flex items-center gap-2 mt-2 text-muted-foreground text-sm" data-testid="status-loader">
      <Icon className="w-4 h-4 text-primary/70 shrink-0 transition-all duration-300" />
      <span>{text}...</span>
    </div>
  );
}

function SectionTitle({ num, title }: { num: number; title: string }) {
  return (
    <h2 className="text-base font-bold mt-4 mb-1" data-testid={`section-title-${num}`}>
      {num}. {title}
    </h2>
  );
}

function CountryFlag({ countryCode }: { countryCode: string }) {
  return (
    <img
      src={`https://flagcdn.com/w20/${countryCode.toLowerCase()}.png`}
      width={20}
      height={14}
      alt={countryCode}
      className="inline-block rounded-[2px] shrink-0"
    />
  );
}

function AnalysisView({ location, weatherEurope, weatherOutput, analysisJson, analysisFileName, sources, isStreaming, hasError, loadingStatus }: {
  location: GeocodeResult;
  weatherEurope: WeatherEuropeSSE | null;
  weatherOutput: WeatherOutputData | null;
  analysisJson: Record<string, unknown> | null;
  analysisFileName: string | null;
  sources: AnalysisSources | null;
  isStreaming: boolean;
  hasError?: string | boolean;
  loadingStatus?: string | null;
}) {
  const saLat = location.lat;
  const saLon = location.lon;
  const model = location.regionalModel;
  const modelLabel = location.regionalModelLabel;
  const zoom = 7;
  const locationShort = location.cityName || location.displayName?.split(",")[0]?.trim() || "";
  const sailingAreaShort = location.sailingArea || locationShort;
  const cityLat = location.cityLat ?? location.lat;
  const cityLon = location.cityLon ?? location.lon;
  const mapZoom = Math.max(zoom - 2, 4);
  const windUrl = `https://www.windy.com/${saLat.toFixed(3)}/${saLon.toFixed(3)}/${model}?${model},wind,${saLat.toFixed(3)},${saLon.toFixed(3)},${mapZoom},i:pressure,p:favs`;
  const meteogramUrl = `https://www.windy.com/${cityLat.toFixed(3)}/${cityLon.toFixed(3)}/${model}/meteogram?${model},clouds,${cityLat.toFixed(3)},${cityLon.toFixed(3)},${mapZoom},i:pressure`;
  const jsonDownloadUrl = analysisJson
    ? `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(analysisJson, null, 2))}`
    : null;
  const embeddedWeatherOutput = (analysisJson as {
    weatherOutput?: WeatherOutputData;
  } | null)?.weatherOutput;
  const resolvedWeatherOutput = weatherOutput
    ?? (embeddedWeatherOutput && Object.keys(embeddedWeatherOutput).length > 0
      ? embeddedWeatherOutput
      : null);

  return (
    <div data-testid="analysis-view">
      <div className="mb-3 text-sm font-medium text-foreground/80" data-testid="analysis-header">
        {!location.sailingArea && !location.cityName ? (
          <span className="text-destructive">Weder Segelrevier noch Ort erkannt. Bitte versuche es mit einem konkreteren Ortsnamen.</span>
        ) : location.sailingArea ? (
          <span>Wetteranalyse für {location.cityName}, {location.sailingArea}{location.countryCode && <>{" "}<CountryFlag countryCode={location.countryCode} /></>}</span>
        ) : (
          <span>Kein Segelrevier erkannt. Wetteranalyse für {location.cityName}{location.countryCode && <>{" "}<CountryFlag countryCode={location.countryCode} /></>}</span>
        )}
      </div>

      {(location.sailingArea || location.cityName) && (
      <>
      <SectionTitle num={1} title="Druck & Luftmassen" />
      <div className="my-3" data-testid="section-card-1">
        <WindyEmbed lat={48} lon={5} overlay="temp" product="ecmwf" level="850h" zoom={3} />
        <SourceLink label="Bodendruck und Temperatur 1.500m Europa" provider="windy.com" url="https://www.windy.com/-Temperatur-temp?ecmwf,temp,850h,48.000,5.000,3" />
      </div>
      {resolvedWeatherOutput?.airPressureMasses?.text && (
        <MarkdownContent content={resolvedWeatherOutput.airPressureMasses.text} forceBullets />
      )}
      {isStreaming && !hasError && !resolvedWeatherOutput?.airPressureMasses?.text && weatherEurope && (
        <BounceLoader />
      )}

      {hasError && !resolvedWeatherOutput && (
        <p className="text-sm text-destructive mt-3" data-testid="text-analysis-error">
          {typeof hasError === "string" ? hasError : "Fehler bei der Datenabfrage. Die Analyse konnte nicht vollständig geladen werden."}
        </p>
      )}

      {!weatherEurope && isStreaming && !hasError && loadingStatus && <StatusLoader text={loadingStatus} />}

      {weatherEurope && (
        <>
          <SectionTitle num={2} title="Fronten" />
          <div className="my-3" data-testid="section-card-2">
            {weatherEurope.frontCurrentBase64 ? (
              <img
                src={`data:image/gif;base64,${weatherEurope.frontCurrentBase64}`}
                alt="KNMI Fronten-Analyse"
                className="w-full rounded-lg bg-white"
                data-testid="img-knmi-chart"
              />
            ) : (
              <div className="w-full h-48 bg-muted rounded-lg flex items-center justify-center">
                <span className="text-muted-foreground text-sm">KNMI Karte nicht verfügbar</span>
              </div>
            )}
            <SourceLink
              label={`Fronten Europa ${weatherEurope.frontCurrentLocalTime}`}
              provider="KNMI"
              url={weatherEurope.frontCurrentUrl || KNMI_SOURCE_URL}
            />
          </div>
          {resolvedWeatherOutput?.weatherFront?.text && (
            <MarkdownContent content={resolvedWeatherOutput.weatherFront.text} forceBullets />
          )}
          {isStreaming && !hasError && !resolvedWeatherOutput?.weatherFront?.text && (
            <BounceLoader />
          )}

          <SectionTitle num={3} title="Wind & Welle" />
          <div className="my-3" data-testid="section-card-3">
            <WindyEmbed lat={saLat} lon={saLon} overlay="wind" product={model} level="surface" zoom={mapZoom} marker />
            <SourceLink label={`Wind ${sailingAreaShort}`} provider="windy.com" url={windUrl} />
            <SeaWindForecast analysisJson={analysisJson} isLoading={isStreaming && !hasError} />
          </div>
          {resolvedWeatherOutput?.windWaves?.text && (
            <MarkdownContent content={resolvedWeatherOutput.windWaves.text} forceBullets />
          )}
          {isStreaming && !hasError && !resolvedWeatherOutput?.windWaves?.text && (
            <BounceLoader />
          )}

          {analysisJson && (
            <>
              <SectionTitle num={4} title="Wetter & Regen" />
              <div className="my-3" data-testid="section-card-4">
                <CityMeteogram
                  analysisJson={analysisJson}
                  cityName={locationShort}
                  isLoading={isStreaming && !hasError}
                />
                <SourceLink label={`Meteogramm ${locationShort}`} provider="windy.com" url={meteogramUrl} />
              </div>
              {resolvedWeatherOutput?.cloudsRain?.text && (
                <MarkdownContent content={resolvedWeatherOutput.cloudsRain.text} forceBullets />
              )}
            </>
          )}

          {isStreaming && !hasError && !resolvedWeatherOutput?.cloudsRain?.text && (
            <BounceLoader />
          )}
          {isStreaming && !hasError && !resolvedWeatherOutput?.cloudsRain?.text && loadingStatus && (
            <StatusLoader text={loadingStatus} />
          )}

          {resolvedWeatherOutput && sources && (
            <>
              <SectionTitle num={5} title="Quellen" />
              <ul className="mt-1 mb-2 space-y-0.5 list-disc pl-5" data-testid="section-sources">
                {sources.windy.map((md, i) => (
                  <li key={i} className="text-sm text-muted-foreground" dangerouslySetInnerHTML={{
                    __html: md.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
                      (_, text, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer" class="text-primary underline hover:text-primary/80">${text}</a>`)
                  }} />
                ))}
                {sources.nationalWarningCenter?.status === "unavailable" && (
                  <li className="text-sm text-muted-foreground" data-testid="national-warning-status">
                    Nationales Marine-Wetter-Warnzentrum für {sources.nationalWarningCenter.label ?? "dieses Land"} derzeit nicht verfügbar
                  </li>
                )}
                {sources.nationalWarningCenter?.status === "unsupported" && (
                  <li className="text-sm text-muted-foreground" data-testid="national-warning-status">
                    Nationales Marine-Wetter-Warnzentrum für {sources.nationalWarningCenter.label ?? "dieses Land"} nicht angebunden
                  </li>
                )}
                {[...sources.national, ...sources.europe].map((md, i) => (
                  <li key={`additional-source-${i}`} className="text-sm text-muted-foreground" dangerouslySetInnerHTML={{
                    __html: md.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
                      (_, text, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer" class="text-primary underline hover:text-primary/80">${text}</a>`)
                  }} />
                ))}
                {jsonDownloadUrl && (
                  <li className="text-sm text-muted-foreground" data-testid="source-json">
                    Daten als{" "}
                    <a
                      href={jsonDownloadUrl}
                      download={analysisFileName || "aiwindy-analyse.json"}
                      className="text-primary underline hover:text-primary/80"
                    >
                      JSON
                    </a>
                  </li>
                )}
              </ul>
            </>
          )}
        </>
      )}
      </>
      )}
    </div>
  );
}

export default function Home() {
  const [restoredAnalysis] = useState(loadPersistedAnalysis);
  const welcomeMessage: ChatMessage = {
    id: "welcome",
    role: "assistant",
    content: "welcome",
  };
  const [messages, setMessages] = useState<ChatMessage[]>(
    restoredAnalysis ? [welcomeMessage, ...restoredAnalysis.messages] : [welcomeMessage],
  );
  const [input, setInput] = useState("");
  const [activeLocation, setActiveLocation] = useState<GeocodeResult | null>(
    restoredAnalysis?.activeLocation ?? null,
  );
  const [isStreaming, setIsStreaming] = useState(false);
  const [uploadHintAfterMsgId, setUploadHintAfterMsgId] = useState<string | null>(null);
  const uploadHintShownRef = useRef(false);
  const hasUploadedRef = useRef(false);
  const [uploadPreviews, setUploadPreviews] = useState<Record<string, UploadPreview>>({});
  const [messageLocations, setMessageLocations] = useState<Record<string, GeocodeResult>>(
    restoredAnalysis ? { [restoredAnalysis.assistantId]: restoredAnalysis.activeLocation } : {},
  );
  const [messageWeatherEurope, setMessageWeatherEurope] = useState<Record<string, WeatherEuropeSSE>>(
    restoredAnalysis?.weatherEurope
      ? { [restoredAnalysis.assistantId]: restoredAnalysis.weatherEurope }
      : {},
  );
  const [messageWeatherOutput, setMessageWeatherOutput] = useState<Record<string, WeatherOutputData>>(
    restoredAnalysis
      ? { [restoredAnalysis.assistantId]: restoredAnalysis.weatherOutput }
      : {},
  );
  const [messageAnalysisJson, setMessageAnalysisJson] = useState<Record<string, Record<string, unknown>>>(
    restoredAnalysis
      ? { [restoredAnalysis.assistantId]: restoredAnalysis.analysisJson }
      : {},
  );
  const [messageAnalysisFileNames, setMessageAnalysisFileNames] = useState<Record<string, string>>(
    restoredAnalysis?.analysisFileName
      ? { [restoredAnalysis.assistantId]: restoredAnalysis.analysisFileName }
      : {},
  );
  const [messageSources, setMessageSources] = useState<Record<string, AnalysisSources>>(
    restoredAnalysis?.sources
      ? { [restoredAnalysis.assistantId]: restoredAnalysis.sources }
      : {},
  );
  const [analysisErrors, setAnalysisErrors] = useState<Record<string, string | boolean>>({});
  const [analysisJobs, setAnalysisJobs] = useState<Record<string, AnalysisJobState>>({});
  const [loadingStatus, setLoadingStatus] = useState<string | null>(null);
  const [photoLocationHints, setPhotoLocationHints] = useState<Record<string, { locationName: string; countryCode?: string | null }>>({});
  const lastAnalysisLocationRef = useRef<string | null>(
    restoredAnalysis?.activeLocation.displayName ?? null,
  );
  const lastAnalysisTimeRef = useRef<string | null>(null);
  const lastAnalysisOutputRef = useRef<WeatherOutputData | null>(
    restoredAnalysis?.weatherOutput ?? null,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const analysisSessionRef = useRef<{
    jobId: string | null;
    token: string | null;
    assistantId: string;
    xhr: XMLHttpRequest | null;
    done: boolean;
    failed: boolean;
    reconnectTimer: number | null;
    seenEventIds: Set<number>;
  } | null>(null);
  const analysisReconnectRef = useRef<(() => void) | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const captureInputRef = useRef<HTMLInputElement>(null);
  const uploadObjectUrlsRef = useRef(new Set<string>());

  useEffect(() => {
    const assistantIndex = messages.findLastIndex(message =>
      message.role === "assistant"
      && Boolean(messageLocations[message.id])
      && Boolean(messageWeatherOutput[message.id])
      && Boolean(messageAnalysisJson[message.id]),
    );
    if (assistantIndex === -1) return;
    const assistantMessage = messages[assistantIndex];
    const precedingUser = messages
      .slice(0, assistantIndex)
      .findLast(message => message.role === "user");
    const location = messageLocations[assistantMessage.id];
    const state: PersistedAnalysisState = {
      messages: [
        ...(precedingUser ? [precedingUser] : []),
        assistantMessage,
      ],
      activeLocation: location,
      assistantId: assistantMessage.id,
      weatherEurope: messageWeatherEurope[assistantMessage.id] ?? null,
      weatherOutput: messageWeatherOutput[assistantMessage.id],
      analysisJson: messageAnalysisJson[assistantMessage.id],
      analysisFileName: messageAnalysisFileNames[assistantMessage.id] ?? null,
      sources: messageSources[assistantMessage.id] ?? null,
    };
    persistAnalysis(state);
  }, [
    messages,
    messageLocations,
    messageWeatherEurope,
    messageWeatherOutput,
    messageAnalysisJson,
    messageAnalysisFileNames,
    messageSources,
  ]);

  const sendMessage = useCallback((userMessage: string) => {
    setIsStreaming(true);
    const assistantId = `assistant-${Date.now()}`;
    let processed = 0;
    let lineBuffer = "";
    let isAnalyse = false;
    let chatStreamContent = "";
    const session = {
      jobId: null as string | null,
      token: null as string | null,
      assistantId,
      xhr: null as XMLHttpRequest | null,
      done: false,
      failed: false,
      reconnectTimer: null as number | null,
      seenEventIds: new Set<number>(),
    };

    setMessages((prev) => [...prev, {
      id: assistantId,
      role: "assistant" as const,
      content: "",
    }]);

    const getChatStreamEl = () => document.getElementById(`stream-${assistantId}`);
    const clearReconnectTimer = () => {
      if (session.reconnectTimer !== null) {
        window.clearTimeout(session.reconnectTimer);
        session.reconnectTimer = null;
      }
    };
    const finishAnalysis = () => {
      if (session.done === false) return;
      clearReconnectTimer();
      setLoadingStatus(null);
      setIsStreaming(false);
      if (session.jobId) {
        setAnalysisJobs(prev => ({
          ...prev,
          [assistantId]: {
            jobId: session.jobId!,
            token: session.token!,
            messageId: assistantId,
            status: session.failed ? "failed" : "completed",
          },
        }));
      }
      if (!uploadHintShownRef.current && !hasUploadedRef.current) {
        uploadHintShownRef.current = true;
        setUploadHintAfterMsgId(assistantId);
      }
      if (analysisSessionRef.current === session) {
        analysisSessionRef.current = null;
        analysisReconnectRef.current = null;
      }
    };

    let connectResume: () => void;
    const scheduleResume = () => {
      if (session.done || !session.jobId || !session.token) return;
      clearReconnectTimer();
      session.reconnectTimer = window.setTimeout(() => {
        session.reconnectTimer = null;
        connectResume();
      }, 800);
    };

    const handleEvent = (data: SSEPayload) => {
      if (typeof data.analysisEventId === "number") {
        if (session.seenEventIds.has(data.analysisEventId)) return;
        session.seenEventIds.add(data.analysisEventId);
      }
      if (data.analysisJobId && data.analysisToken) {
        isAnalyse = true;
        session.jobId = data.analysisJobId;
        session.token = data.analysisToken;
        setAnalysisJobs(prev => ({
          ...prev,
          [assistantId]: {
            jobId: data.analysisJobId!,
            token: data.analysisToken!,
            messageId: assistantId,
            status: "running",
          },
        }));
      }
      if (data.loadingStatus) {
        setLoadingStatus(data.loadingStatus);
      }
      if (data.location) {
        isAnalyse = true;
        setActiveLocation(data.location);
        setMessageLocations(prev => ({ ...prev, [assistantId]: data.location! }));
        lastAnalysisLocationRef.current = data.location!.displayName.split(",")[0].trim();
        lastAnalysisTimeRef.current = new Date().toLocaleString("de-AT");
      }
      if (data.weatherEurope) {
        setMessageWeatherEurope(prev => ({ ...prev, [assistantId]: data.weatherEurope! }));
      }
      if (data.weatherOutput) {
        setMessageWeatherOutput(prev => ({ ...prev, [assistantId]: data.weatherOutput! }));
        lastAnalysisOutputRef.current = data.weatherOutput;
      }
      if (data.analysisJson) {
        setMessageAnalysisJson(prev => ({ ...prev, [assistantId]: data.analysisJson! }));
      }
      if (data.analysisFileName) {
        setMessageAnalysisFileNames(prev => ({ ...prev, [assistantId]: data.analysisFileName! }));
      }
      if (data.sources) {
        setMessageSources(prev => ({ ...prev, [assistantId]: data.sources! }));
      }
      if (data.error) {
        setLoadingStatus(null);
        if (isAnalyse) {
          session.failed = true;
          setAnalysisErrors(prev => ({ ...prev, [assistantId]: data.error! }));
        } else {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId && !m.content ? { ...m, content: "Fehler bei der Verarbeitung. Bitte versuche es erneut." } : m
            )
          );
        }
      }
      if (data.done) {
        setLoadingStatus(null);
        if (isAnalyse) {
          session.done = true;
          finishAnalysis();
        }
      }
    };

    const processSseText = (text: string, isInitialRequest: boolean) => {
      const previousProcessed = isInitialRequest ? processed : 0;
      const previousBuffer = isInitialRequest ? lineBuffer : "";
      const incoming = text.slice(previousProcessed);
      if (isInitialRequest) processed = text.length;
      const lines = (previousBuffer + incoming).split("\n");
      if (isInitialRequest) lineBuffer = lines.pop() || "";
      else lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const data = JSON.parse(line.slice(6)) as SSEPayload;
          if (data.content && !isAnalyse) {
            chatStreamContent += data.content;
            const el = getChatStreamEl();
            if (el) el.textContent = chatStreamContent;
          } else {
            handleEvent(data);
          }
        } catch {
          // A partial SSE line is retained by the streaming connection.
        }
      }
    };

    connectResume = () => {
      if (session.done || !session.jobId || !session.token) return;
      if (session.xhr && session.xhr.readyState !== XMLHttpRequest.DONE) return;
      const resumeXhr = new XMLHttpRequest();
      let resumeProcessed = 0;
      let resumeBuffer = "";
      session.xhr = resumeXhr;
      resumeXhr.open("GET", `/api/analysis/${encodeURIComponent(session.jobId)}/events`);
      resumeXhr.setRequestHeader("X-Analysis-Token", session.token);
      const processResume = () => {
        const incoming = resumeXhr.responseText.slice(resumeProcessed);
        resumeProcessed = resumeXhr.responseText.length;
        const lines = (resumeBuffer + incoming).split("\n");
        resumeBuffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            handleEvent(JSON.parse(line.slice(6)) as SSEPayload);
          } catch {
            // The next progress event will retry any incomplete payload.
          }
        }
      };
      resumeXhr.onprogress = processResume;
      resumeXhr.onloadend = () => {
        resumeBuffer += "\n";
        processResume();
        if (session.xhr === resumeXhr) session.xhr = null;
        if (!session.done) scheduleResume();
      };
      resumeXhr.onerror = () => {
        if (session.xhr === resumeXhr) session.xhr = null;
        scheduleResume();
      };
      resumeXhr.send();
    };

    analysisSessionRef.current = session;
    analysisReconnectRef.current = () => {
      if (session.done || !session.jobId) return;
      clearReconnectTimer();
      const activeXhr = session.xhr;
      session.xhr = null;
      if (activeXhr && activeXhr.readyState !== XMLHttpRequest.DONE) activeXhr.abort();
      window.setTimeout(connectResume, 0);
    };

    const xhr = new XMLHttpRequest();
    session.xhr = xhr;
    abortRef.current = { abort: () => xhr.abort() } as AbortController;
    xhr.open("POST", "/api/chat");
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onprogress = () => processSseText(xhr.responseText, true);
    xhr.onloadend = () => {
      if (xhr.status >= 400) {
        let errorMessage = "Die Anfrage konnte nicht verarbeitet werden. Bitte versuche es erneut.";
        try {
          const errorData = JSON.parse(xhr.responseText) as { error?: unknown };
          if (typeof errorData.error === "string" && errorData.error) {
            errorMessage = errorData.error;
          }
        } catch {}
        setMessages((prev) =>
          prev.map((m) => m.id === assistantId ? { ...m, content: errorMessage } : m)
        );
        setLoadingStatus(null);
        setIsStreaming(false);
        return;
      }
      lineBuffer += "\n";
      processSseText(xhr.responseText, true);
      if (session.xhr === xhr) session.xhr = null;
      if (isAnalyse) {
        if (!session.done) scheduleResume();
        return;
      }
      setMessages((prev) => {
        const msg = prev.find(m => m.id === assistantId);
        if (msg && !chatStreamContent) return prev.filter(m => m.id !== assistantId);
        return prev.map((m) => m.id === assistantId ? { ...m, content: chatStreamContent } : m);
      });
      setLoadingStatus(null);
      setIsStreaming(false);
    };
    xhr.onerror = () => {
      if (isAnalyse || session.jobId) {
        scheduleResume();
        return;
      }
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, content: "Verbindungsfehler. Bitte versuche es erneut." } : m
        )
      );
      setLoadingStatus(null);
      setIsStreaming(false);
    };

    const chatHistory = messages
      .filter((m) => m.id !== "welcome")
      .map((m) => {
        if (m.content.length <= MAX_CHAT_HISTORY_CONTENT) {
          return { role: m.role, content: m.content };
        }
        const suffix = "\n[… Verlauf gekürzt …]";
        return {
          role: m.role,
          content: `${m.content.slice(0, MAX_CHAT_HISTORY_CONTENT - suffix.length)}${suffix}`,
        };
      });

    xhr.send(JSON.stringify({
      message: userMessage,
      history: chatHistory,
      currentLocation: activeLocation,
    }));
  }, [messages, activeLocation]);

  useEffect(() => {
    const reconnectVisibleAnalysis = () => {
      if (document.visibilityState === "visible") {
        analysisReconnectRef.current?.();
      }
    };
    document.addEventListener("visibilitychange", reconnectVisibleAnalysis);
    window.addEventListener("online", reconnectVisibleAnalysis);
    return () => {
      document.removeEventListener("visibilitychange", reconnectVisibleAnalysis);
      window.removeEventListener("online", reconnectVisibleAnalysis);
    };
  }, []);

  useEffect(() => () => {
    for (const url of uploadObjectUrlsRef.current) {
      URL.revokeObjectURL(url);
    }
  }, []);

  const handleFileUpload = useCallback((file: File) => {
    if (isStreaming) return;
    setIsStreaming(true);
    const assistantId = `assistant-${Date.now()}`;
    const userId = `user-${Date.now()}`;
    const isVideo = file.type.startsWith("video/");
    let processed = 0;
    let lineBuffer = "";
    let uploadHadError = false;

    hasUploadedRef.current = true;

    let photoExifMeta: { locationName: string | null; countryCode: string | null } = { locationName: null, countryCode: null };

    const objectUrl = URL.createObjectURL(file);
    uploadObjectUrlsRef.current.add(objectUrl);
    if (!isVideo) {
      setUploadPreviews(prev => ({ ...prev, [userId]: { url: objectUrl } }));
    } else {
      setUploadPreviews(prev => ({ ...prev, [userId]: { url: objectUrl, isVideo: true } }));
    }

    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", content: isVideo ? "[Video]" : "[Foto]" },
      { id: assistantId, role: "assistant" as const, content: "" },
    ]);

    const formData = new FormData();
    formData.append("photo", file);
    if (activeLocation) {
      formData.append("currentLocation", JSON.stringify(activeLocation));
    }

    const xhr = new XMLHttpRequest();
    abortRef.current = { abort: () => xhr.abort() } as AbortController;
    xhr.open("POST", "/api/upload");

    let uploadStreamContent = "";
    let uploadFinished = false;
    const getUploadStreamEl = () => document.getElementById(`stream-${assistantId}`);

    const finishUpload = () => {
      if (uploadFinished) return;
      uploadFinished = true;
      setMessages((prev) => {
        if (!uploadStreamContent && !uploadHadError) return prev.filter(m => m.id !== assistantId);
        if (!uploadStreamContent) return prev;
        return prev.map((m) => m.id === assistantId ? { ...m, content: uploadStreamContent } : m);
      });
      if (photoExifMeta.locationName) {
        const lastAnalysis = lastAnalysisLocationRef.current;
        const isDifferentOrNone = !lastAnalysis || lastAnalysis !== photoExifMeta.locationName;
        if (isDifferentOrNone) {
          setPhotoLocationHints(prev => ({
            ...prev,
            [assistantId]: { locationName: photoExifMeta.locationName!, countryCode: photoExifMeta.countryCode }
          }));
        }
      }
      setIsStreaming(false);
    };

    const processChunk = () => {
      const text = xhr.responseText.slice(processed);
      processed = xhr.responseText.length;
      const combined = lineBuffer + text;
      const lines = combined.split("\n");
      lineBuffer = lines.pop() || "";
      let hasError = false;
      let hasDone = false;
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.location) {
              setActiveLocation(data.location as GeocodeResult);
            }
            if (data.exifMeta) {
              photoExifMeta = { locationName: data.exifMeta.locationName ?? null, countryCode: data.exifMeta.countryCode ?? null };
              setUploadPreviews(prev => ({
                ...prev,
                [userId]: { ...prev[userId], time: data.exifMeta.time, locationName: data.exifMeta.locationName, countryCode: data.exifMeta.countryCode }
              }));
            }
            if (data.videoMeta) {
              const thumbUrl = data.videoMeta.thumbnailBase64
                ? `data:image/jpeg;base64,${data.videoMeta.thumbnailBase64}`
                : "";
              photoExifMeta = { locationName: data.videoMeta.locationName ?? null, countryCode: data.videoMeta.countryCode ?? null };
              setUploadPreviews(prev => ({
                ...prev,
                [userId]: {
                  ...prev[userId],
                  thumbnailUrl: thumbUrl || prev[userId]?.thumbnailUrl,
                  isVideo: true,
                  time: data.videoMeta.time,
                  locationName: data.videoMeta.locationName,
                  countryCode: data.videoMeta.countryCode,
                }
              }));
            }
            if (data.content) {
              uploadStreamContent += data.content;
              const el = getUploadStreamEl();
              if (el) el.textContent = uploadStreamContent;
            }
            if (data.error) {
              hasError = true;
              uploadHadError = true;
            }
            if (data.done) {
              hasDone = true;
            }
          } catch {}
        }
      }
      if (hasError) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId && !m.content ? { ...m, content: "Fehler bei der Analyse. Bitte versuche es erneut." } : m
          )
        );
      }
      if (hasDone) {
        finishUpload();
      }
    };

    xhr.onprogress = processChunk;
    xhr.onloadend = () => {
      lineBuffer += "\n";
      processChunk();
      finishUpload();
    };
    xhr.onerror = () => {
      uploadHadError = true;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, content: "Verbindungsfehler. Bitte versuche es erneut." } : m
        )
      );
      finishUpload();
    };

    xhr.send(formData);
  }, [activeLocation, isStreaming]);

  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileUpload(file);
    }
    e.target.value = "";
  }, [handleFileUpload]);

  const lastSeenLengthRef = useRef(1);

  useEffect(() => {
    if (messages.length > lastSeenLengthRef.current) {
      lastSeenLengthRef.current = messages.length;
      const lastMsg = messages[messages.length - 1];
      if (lastMsg) {
        requestAnimationFrame(() => {
          const el = document.querySelector(`[data-message-id="${lastMsg.id}"]`);
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        });
      }
    }
  }, [messages.length]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;

    setMessages((prev) => [
      ...prev,
      { id: `user-${Date.now()}`, role: "user", content: trimmed },
    ]);
    setInput("");
    sendMessage(trimmed);
  };

  return (
    <div className="flex flex-col h-dvh bg-background">
      <header className="border-b border-border bg-card/50 backdrop-blur-sm shrink-0">
        <div className="max-w-2xl mx-auto px-4 py-2 flex items-center gap-2">
          <Sailboat className="w-5 h-5 text-primary shrink-0" />
          <h1 className="text-base font-semibold" data-testid="text-app-title">aiWindy</h1>
          <div className="ml-auto">
            <Popover>
              <PopoverTrigger asChild>
                <button className="p-1 text-muted-foreground hover:text-foreground transition-colors" aria-label="Info" data-testid="button-info">
                  <Info className="w-5 h-5" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-56 p-3 text-sm" data-testid="popover-info">
                <div className="space-y-2">
                  <p className="font-semibold">aiWindy <span className="font-normal text-muted-foreground">v2.0 · April 2025</span></p>
                  <div className="flex items-center gap-2 text-muted-foreground text-xs">
                    <span>© Frederik Schorr</span>
                    <a href="https://github.com/FrederikSchorr/aiwindy" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors" aria-label="GitHub" data-testid="link-github">
                      <SiGithub className="w-3.5 h-3.5" />
                    </a>
                    <a href="https://www.linkedin.com/in/frederik-schorr-69ba971/" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors" aria-label="LinkedIn" data-testid="link-linkedin">
                      <FaLinkedin className="w-3.5 h-3.5" />
                    </a>
                  </div>
                  <a
                    href={(() => {
                      const subject = encodeURIComponent("Feedback zu aiWindy");
                      let body = "";
                      if (activeLocation) {
                        const sectionLabels: Record<string, string> = {
                          airPressureMasses: "🌀 Druck & Luftmassen",
                          weatherFront: "🌊 Fronten",
                          windWaves: "💨 Wind & Welle",
                          cloudsRain: "☁️ Wetter & Regen",
                        };
                        const saCoords = activeLocation.lat != null && activeLocation.lon != null
                          ? ` (${activeLocation.lat.toFixed(4)}, ${activeLocation.lon.toFixed(4)})`
                          : "";
                        const cityCoords = activeLocation.cityLat != null && activeLocation.cityLon != null
                          ? ` (${activeLocation.cityLat.toFixed(4)}, ${activeLocation.cityLon.toFixed(4)})`
                          : "";
                        const parts = [
                          lastAnalysisTimeRef.current ? `📅 Analyse vom: ${lastAnalysisTimeRef.current}` : "",
                          activeLocation.country ? `🏳️ ${activeLocation.country}` : "",
                          activeLocation.sailingArea ? `⛵ ${activeLocation.sailingArea}${saCoords}` : "",
                          activeLocation.cityName ? `📍 ${activeLocation.cityName}${cityCoords}` : "",
                          activeLocation.regionalModelLabel ? `🔬 Windy Prognosemodell: ${activeLocation.regionalModelLabel}` : "",
                        ].filter(Boolean);
                        body = "\n\n---\nLetzte Analyse:\n" + parts.join("\n");
                        const wo = lastAnalysisOutputRef.current;
                        if (wo) {
                          for (const [key, label] of Object.entries(sectionLabels)) {
                            const section = wo[key as keyof typeof wo];
                            if (section?.text) {
                              body += `\n\n${label}\n${section.text}`;
                            }
                          }
                        }
                        body = encodeURIComponent(body);
                      }
                      return `mailto:frederik@schorr.wien?subject=${subject}&body=${body}`;
                    })()}
                    className="flex items-center gap-1.5 text-xs text-primary hover:underline"
                    data-testid="link-feedback"
                  >
                    <Mail className="w-3 h-3" />
                    Feedback senden
                  </a>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto" ref={scrollRef}>
        <div className="max-w-2xl mx-auto px-4 py-4 space-y-4">
          {messages.map((msg) => {
            const isUser = msg.role === "user";
            const loc = messageLocations[msg.id];
            const we = messageWeatherEurope[msg.id];
            const wo = messageWeatherOutput[msg.id];
            const srcs = messageSources[msg.id] ?? null;
            const hasAnalysisError = analysisErrors[msg.id] ?? false;
            const isAnalysis = !!loc;
            const isLast = msg.id === messages[messages.length - 1]?.id;
            const showUploadHint = msg.id === uploadHintAfterMsgId;

            if (isUser) {
              const preview = uploadPreviews[msg.id];
              const formatExifDate = (raw: string | null | undefined) => {
                if (!raw) return null;
                const m = raw.match(/^(\d{4}):(\d{2}):(\d{2})\s(\d{2}):(\d{2})/);
                if (!m) return raw;
                return `${m[3]}.${m[2]}.${m[1]}, ${m[4]}:${m[5]}`;
              };
              return (
                <div key={msg.id} className="flex justify-end" data-testid={`message-${msg.id}`} data-message-id={msg.id}>
                  <div className="max-w-[75%]">
                    {preview ? (
                      <div>
                        {preview.isVideo ? (
                          <div className="relative">
                            {preview.url.startsWith("blob:") ? (
                              <video
                                src={preview.url}
                                poster={preview.thumbnailUrl}
                                aria-label="Hochgeladenes Video"
                                className="rounded-2xl rounded-br-md max-w-full max-h-72 object-cover block"
                                controls
                                muted
                                playsInline
                                preload="metadata"
                              />
                            ) : preview.thumbnailUrl || preview.url ? (
                              <img
                                src={preview.thumbnailUrl || preview.url}
                                alt="Standbild aus Video"
                                className="rounded-2xl rounded-br-md max-w-full max-h-72 object-cover block"
                              />
                            ) : (
                              <div className="rounded-2xl rounded-br-md w-48 h-32 bg-muted flex items-center justify-center">
                                <span className="text-muted-foreground text-sm">Videovorschau nicht verfügbar</span>
                              </div>
                            )}
                            <div className="absolute top-2 left-2 bg-black/60 rounded-md px-2 py-0.5 flex items-center gap-1">
                              <span className="text-white text-xs font-medium">▶ Video</span>
                            </div>
                          </div>
                        ) : (
                          <img
                            src={preview.url}
                            alt="Hochgeladenes Foto"
                            className="rounded-2xl rounded-br-md max-w-full max-h-72 object-cover block"
                          />
                        )}
                        {(preview.locationName || preview.time) && (
                          <div className="flex flex-col items-end gap-0.5 mt-1">
                            {preview.locationName && (
                              <span className="text-xs text-muted-foreground flex items-center gap-1">
                                <MapPin className="w-3 h-3" /> {preview.locationName}
                                {preview.countryCode && (
                                  <CountryFlag countryCode={preview.countryCode} />
                                )}
                              </span>
                            )}
                            {preview.time && (
                              <span className="text-xs text-muted-foreground">
                                {formatExifDate(preview.time)}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    ) : msg.content ? (
                      <div className="rounded-2xl rounded-br-md px-4 py-2.5 text-[15px] leading-normal bg-primary text-primary-foreground">
                        {msg.content}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            }

            if (isAnalysis) {
              return (
                <div key={msg.id} data-testid={`message-${msg.id}`} data-message-id={msg.id}>
                  <AnalysisView
                    location={loc}
                    weatherEurope={we || null}
                    weatherOutput={wo || null}
                    analysisJson={messageAnalysisJson[msg.id] || null}
                    analysisFileName={messageAnalysisFileNames[msg.id] || null}
                    sources={srcs}
                    isStreaming={isStreaming && isLast}
                    hasError={hasAnalysisError}
                    loadingStatus={isStreaming && isLast ? loadingStatus : null}
                  />
                  {showUploadHint && !isStreaming && (
                    <div className="flex items-center gap-2 mt-3 text-[14px] text-muted-foreground italic" data-testid="text-upload-hint">
                      <Camera className="w-4 h-4 shrink-0" />
                      Du kannst mich zu Wetter und Winden fragen. Oder lade ein aktuelles Wolken-Foto oder Video hoch für meteorologische Analyse.
                    </div>
                  )}
                </div>
              );
            }

            const photoHint = photoLocationHints[msg.id];
            const isCurrentlyStreaming = isStreaming && isLast && msg.role === "assistant";
            return (
              <div key={msg.id} className="w-full" data-testid={`message-${msg.id}`} data-message-id={msg.id}>
                {isCurrentlyStreaming
                  ? <div id={`stream-${msg.id}`} className="text-[15px] leading-relaxed whitespace-pre-wrap text-foreground" />
                  : msg.id === "welcome" ? (
                    <div className="text-[15px] leading-relaxed text-foreground">
                      Ahoi! Sage mir wo Du segelst ⛵ in{" "}
                      <CountryFlag countryCode="HR" />,{" "}
                      <CountryFlag countryCode="GR" />,{" "}
                      <CountryFlag countryCode="AT" />,{" "}
                      oder lade ein Wolken-Foto ☁️ hoch.
                    </div>
                  ) : msg.content ? <MarkdownContent content={msg.content} /> : null}
                {isCurrentlyStreaming && (
                  <StatusLoader text={loadingStatus ?? "Verarbeite Anfrage"} />
                )}
                {photoHint && !isStreaming && (
                  <div className="mt-3 text-[14px]" data-testid="text-photo-location-hint">
                    <div className="flex items-center gap-2 flex-wrap text-muted-foreground italic">
                      <MapPin className="w-4 h-4 shrink-0" />
                      <span>
                        Wetteranalyse für{" "}
                        <strong className="not-italic text-foreground/80">
                          {photoHint.locationName}
                          {photoHint.countryCode && (
                            <>
                              {" "}
                              <CountryFlag countryCode={photoHint.countryCode} />
                            </>
                          )}
                        </strong>
                        {" "}durchführen?
                      </span>
                      <Button
                        size="sm"
                        data-testid="button-confirm-location-yes"
                        disabled={isStreaming}
                        onClick={() => {
                          if (isStreaming) return;
                          const locText = photoHint.countryCode
                            ? `${photoHint.locationName}, ${photoHint.countryCode}`
                            : photoHint.locationName;
                          setPhotoLocationHints(prev => {
                            const next = { ...prev };
                            delete next[msg.id];
                            return next;
                          });
                          setMessages((prev) => [
                            ...prev,
                            { id: `user-${Date.now()}`, role: "user" as const, content: locText },
                          ]);
                          sendMessage(locText);
                        }}
                      >
                        ja
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid="button-confirm-location-no"
                        className="not-italic"
                        onClick={() => {
                          setPhotoLocationHints(prev => {
                            const next = { ...prev };
                            delete next[msg.id];
                            return next;
                          });
                        }}
                      >
                        nein
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="border-t border-border bg-card/50 backdrop-blur-sm shrink-0 pb-[env(safe-area-inset-bottom)]">
        <div className="max-w-2xl mx-auto">
          <form onSubmit={handleSubmit} className="px-4 py-3 flex items-center gap-2">
            <input
              type="file"
              accept="image/*,video/*"
              ref={fileInputRef}
              onChange={onFileChange}
              className="hidden"
              data-testid="input-file"
            />
            <input
              type="file"
              accept="image/*"
              capture="environment"
              ref={captureInputRef}
              onChange={onFileChange}
              className="hidden"
              data-testid="input-capture"
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={() => captureInputRef.current?.click()}
              disabled={isStreaming}
              data-testid="button-capture"
              title="Foto aufnehmen"
              className="shrink-0"
            >
              <Camera className="w-4 h-4" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={() => fileInputRef.current?.click()}
              disabled={isStreaming}
              data-testid="button-upload"
              title="Foto/Video aus Galerie"
              className="shrink-0"
            >
              <Image className="w-4 h-4" />
            </Button>
            <div className="relative flex-1">
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ort, Foto oder Frage..."
                className="text-[15px]"
                disabled={isStreaming}
                data-testid="input-message"
              />
            </div>
            <Button type="submit" size="icon" disabled={!input.trim() || isStreaming} data-testid="button-send">
              <Send className="w-4 h-4" />
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
