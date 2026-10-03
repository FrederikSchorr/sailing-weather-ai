import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { saveAnalysis } from "./cache-db.js";
import { appRelease } from "../shared/app-release";

// ── Types ──────────────────────────────────────────────────────────────────

export interface AnalysisPosition {
  userInput: string;
  country: string;
  countryCode: string;
  windyModel: string;
  sailingArea: {
    name_de: string;                          // e.g. "Adria Mitte (Kroatien)"
    type: "sea" | "lake";
    coordinates: { lat: number; lon: number }; // from sailingareas.json
  } | null;
  city: {
    name_de: string;                          // e.g. "Split"
    coordinates: { lat: number; lon: number }; // from Nominatim
  } | null;
}

export interface AnalysisSources {
  windy: string[];
  national: string[];
  europe: string[];
  nationalWarningCenter?: {
    status: "integrated" | "unavailable" | "unsupported";
    label?: string;
    url?: string;
  };
}

export interface AnalysisMeta {
  app: string;
  version: string;
  website: string;
  github: string;
  copyright: string;
  requestDate: string;
  finalizedDate?: string;
  durationSec?: number;
}

export interface AnalysisJson {
  meta: AnalysisMeta;
  position: AnalysisPosition;
  sources: AnalysisSources;
  weatherRaw: Record<string, unknown>;
  weatherPreprocessed: {
    europe: Record<string, unknown>;
    national: Record<string, unknown>;
    local: Record<string, unknown>;
  };
  weatherOutput: Record<string, unknown>;
}

// ── Background job store ────────────────────────────────────────────────────

export type AnalysisJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface AnalysisJobEvent {
  id: number;
  data: Record<string, unknown>;
}

export interface AnalysisJobSnapshot {
  id: string;
  status: AnalysisJobStatus;
  progress: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AnalysisJobRecord {
  id: string;
  token: string;
  status: AnalysisJobStatus;
  progress: string | null;
  createdAt: number;
  updatedAt: number;
  nextEventId: number;
  events: AnalysisJobEvent[];
  subscribers: Set<(event: AnalysisJobEvent) => void>;
}

const ANALYSIS_JOB_TTL_MS = 30 * 60 * 1000;
const analysisJobs = new Map<string, AnalysisJobRecord>();

function cleanupAnalysisJobs(now = Date.now()): void {
  for (const [id, job] of Array.from(analysisJobs.entries())) {
    const terminal = job.status === "completed" || job.status === "failed" || job.status === "cancelled";
    // Active jobs are finalized by the owning worker's timeout. Removing them
    // here would strand a reconnecting client without a terminal SSE event.
    if (terminal && now - job.updatedAt > ANALYSIS_JOB_TTL_MS) {
      analysisJobs.delete(id);
    }
  }
}

const analysisCleanupTimer = setInterval(() => cleanupAnalysisJobs(), 5 * 60 * 1000);
analysisCleanupTimer.unref();

export function createAnalysisJob(): { id: string; token: string } {
  cleanupAnalysisJobs();
  const id = randomUUID();
  const token = randomUUID();
  const now = Date.now();
  analysisJobs.set(id, {
    id,
    token,
    status: "pending",
    progress: null,
    createdAt: now,
    updatedAt: now,
    nextEventId: 1,
    events: [],
    subscribers: new Set(),
  });
  return { id, token };
}

function getJobForToken(id: string, token: string): AnalysisJobRecord | null {
  cleanupAnalysisJobs();
  const job = analysisJobs.get(id);
  if (!job || !token || job.token !== token) return null;
  return job;
}

function isTerminal(job: AnalysisJobRecord): boolean {
  return job.status === "completed" || job.status === "failed" || job.status === "cancelled";
}

export function getAnalysisJobSnapshot(id: string, token: string): AnalysisJobSnapshot | null {
  const job = getJobForToken(id, token);
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
  };
}

export function publishAnalysisEvent(id: string, data: Record<string, unknown>): void {
  const job = analysisJobs.get(id);
  if (!job || isTerminal(job)) return;
  job.updatedAt = Date.now();
  if (typeof data.loadingStatus === "string") {
    job.progress = data.loadingStatus;
    if (job.status === "pending") job.status = "running";
  }
  const event: AnalysisJobEvent = {
    id: job.nextEventId++,
    data: { ...data, analysisEventId: job.nextEventId - 1 },
  };
  job.events.push(event);
  for (const subscriber of Array.from(job.subscribers)) subscriber(event);
}

export function completeAnalysisJob(id: string): void {
  const job = analysisJobs.get(id);
  if (!job || isTerminal(job)) return;
  publishAnalysisEvent(id, { done: true });
  job.status = "completed";
  job.progress = null;
  job.updatedAt = Date.now();
}

export function failAnalysisJob(id: string, error: string): void {
  const job = analysisJobs.get(id);
  if (!job || isTerminal(job)) return;
  publishAnalysisEvent(id, { error, done: true });
  job.status = "failed";
  job.progress = null;
  job.updatedAt = Date.now();
}

export function cancelAnalysisJob(id: string, token: string): boolean {
  const job = getJobForToken(id, token);
  if (!job || isTerminal(job)) return false;
  publishAnalysisEvent(id, { error: "Die Analyse wurde abgebrochen.", done: true });
  job.status = "cancelled";
  job.progress = null;
  job.updatedAt = Date.now();
  return true;
}

export function subscribeToAnalysisJob(
  id: string,
  token: string,
  subscriber: (event: AnalysisJobEvent) => void,
): (() => void) | null {
  const job = getJobForToken(id, token);
  if (!job) return null;
  for (const event of job.events) subscriber(event);
  if (isTerminal(job)) return () => {};
  job.subscribers.add(subscriber);
  return () => job.subscribers.delete(subscriber);
}

// ── Directory setup ────────────────────────────────────────────────────────

const ANALYSES_DIR = path.join(process.cwd(), "analyses");

function ensureDir() {
  if (!fs.existsSync(ANALYSES_DIR)) {
    fs.mkdirSync(ANALYSES_DIR, { recursive: true });
  }
}

function rainBuckets(value: unknown[]): number[][] {
  const buckets: number[][] = [];
  for (let index = 0; index < value.length; index += 3) {
    buckets.push(value.slice(index, index + 3).map((entry) =>
      typeof entry === "number" && Number.isFinite(entry) ? Math.max(0, Math.round(entry * 100) / 100) : 0,
    ));
  }
  return buckets;
}

function maxNumericBuckets(value: unknown[]): Array<number | null> {
  const buckets: Array<number | null> = [];
  for (let index = 0; index < value.length; index += 3) {
    const finite = value
      .slice(index, index + 3)
      .filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry));
    buckets.push(finite.length ? Math.max(...finite) : null);
  }
  return buckets;
}

function weatherCodeBuckets(value: unknown[]): unknown[] {
  const buckets: unknown[] = [];
  for (let index = 0; index < value.length; index += 3) {
    const bucket = value.slice(index, index + 3);
    const thunderstorm = bucket.find((entry) =>
      typeof entry === "number" && [95, 96, 99].includes(entry),
    );
    buckets.push(thunderstorm ?? bucket[0] ?? null);
  }
  return buckets;
}

function cloudTypeBuckets(value: unknown[]): unknown[] {
  const buckets: unknown[] = [];
  for (let index = 0; index < value.length; index += 3) {
    const bucket = value.slice(index, index + 3);
    buckets.push(bucket.includes("cumulonimbus") ? "cumulonimbus" : bucket[0] ?? null);
  }
  return buckets;
}

function compactForecastData(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) {
    if (value.length <= 20) return value.map(entry => compactForecastData(entry));
    if (key === "rainMm") {
      return rainBuckets(value).map(bucket =>
        Math.round(bucket.reduce((sum, amount) => sum + amount, 0) * 100) / 100,
      );
    }
    if (key === "gustKt" || key === "precipProbabilityPct" || key === "capeJkg") {
      return maxNumericBuckets(value);
    }
    if (key === "weatherCode") return weatherCodeBuckets(value);
    if (key === "cloudType") return cloudTypeBuckets(value);
    const sampled = value.filter((_, index) => index % 3 === 0);
    return sampled.map(entry => compactForecastData(entry));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const compacted = Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entry]) => [
        entryKey,
        compactForecastData(entry, entryKey),
      ]),
    );
    if (Array.isArray(record.rainMm) && record.rainMm.length > 20) {
      compacted.rainMm3h = rainBuckets(record.rainMm);
    }
    return compacted;
  }
  return value;
}

// ── Filename ───────────────────────────────────────────────────────────────

function buildFilename(userInput: string, date: Date): string {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Vienna",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).format(date);
  const [datePart, timePart] = fmt.split(" ");
  const [hh, mm, ss] = timePart.split(":");
  const safeName = userInput.replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 50);
  return `${datePart} ${hh}h${mm}m${ss}s ${safeName}.json`;
}

// ── Public API ─────────────────────────────────────────────────────────────

export function createAnalysis(position: AnalysisPosition): {
  data: AnalysisJson;
  save: () => void;
  filePath: string;
  getExportData: () => Record<string, unknown>;
} {
  const now = new Date();
  const data: AnalysisJson = {
    meta: {
      app: "aiWindy",
      version: appRelease.version,
      website: "https://aiwindy.schorr.wien",
      github: "https://github.com/FrederikSchorr/aiwindy",
      copyright: "© Frederik Schorr",
      requestDate: now.toISOString(),
    },
    position: { ...position },
    sources: { windy: [], national: [], europe: [] },
    weatherRaw: {},
    weatherPreprocessed: { europe: {}, national: {}, local: {} },
    weatherOutput: {},
  };

  ensureDir();
  const filePath = path.join(ANALYSES_DIR, buildFilename(position.userInput, now));

  const save = () => {
    try {
      const exportData = JSON.parse(JSON.stringify(data));
      const rawGw = exportData.weatherRaw?.["generalWeather"];
      if (rawGw && typeof rawGw.text_de === "string" && rawGw.text_de.length > 100) {
        rawGw.text_de = rawGw.text_de.slice(0, 100) + "...";
      }
      const replacer = (_key: string, value: unknown) => {
        if (_key.endsWith("Base64")) return undefined;
        if ((_key === "austriaWindCloudRain" || _key === "austriaCityCloudRain" || _key === "austriaTemperature" || _key === "openMeteoForecast" || _key === "resolvedLocalForecast" || _key === "openMeteoMarine") && value && typeof value === "object") {
          if (_key.startsWith("openMeteo") || _key === "resolvedLocalForecast") return compactForecastData(value);
          const obj = { ...(value as Record<string, unknown>) };
          for (const [k, v] of Object.entries(obj)) {
            if (Array.isArray(v) && v.length > 20) obj[k] = v.filter((_, i) => i % 3 === 0);
          }
          return obj;
        }
        if (_key === "xml" && typeof value === "string" && value.length > 2000) return value.slice(0, 2000) + "...";
        return value;
      };
      const jsonStr = JSON.stringify(exportData, replacer, 2);
      fs.writeFileSync(filePath, jsonStr, "utf-8");

      const hasWeatherOutput = exportData.weatherOutput && Object.keys(exportData.weatherOutput).length > 0;
      if (hasWeatherOutput) {
        const finalizedDate = new Date();
        const durationSec = Math.round((finalizedDate.getTime() - now.getTime()) / 1000);
        exportData.meta.finalizedDate = finalizedDate.toISOString();
        exportData.meta.durationSec = durationSec;
        data.meta.finalizedDate = finalizedDate.toISOString();
        data.meta.durationSec = durationSec;
        const finalJsonStr = JSON.stringify(getSanitizedAnalysisExport(data), null, 2);
        fs.writeFileSync(filePath, finalJsonStr, "utf-8");
        const dbData = JSON.parse(finalJsonStr);
        saveAnalysis(dbData).then(
          () => console.log(`[analysis-db] saved: ${position.userInput}`),
          (e) => console.error("[analysis-db] failed to save:", e),
        );
      }
    } catch (e) {
      console.error("Failed to save analysis JSON:", e);
    }
  };

  return {
    data,
    save,
    filePath,
    getExportData: () => getSanitizedAnalysisExport(data),
  };
}

/**
 * Mirrors the persisted analysis JSON while leaving out large chart images and
 * reducing long forecast arrays, so it can be included in feedback email text.
 */
export function getSanitizedAnalysisExport(data: AnalysisJson): Record<string, unknown> {
  const exportData = JSON.parse(JSON.stringify(data));
  const rawGw = exportData.weatherRaw?.["generalWeather"];
  if (rawGw && typeof rawGw.text_de === "string" && rawGw.text_de.length > 100) {
    rawGw.text_de = rawGw.text_de.slice(0, 100) + "...";
  }

  const replacer = (_key: string, value: unknown) => {
    if (_key.endsWith("Base64")) return undefined;
    if ((_key === "austriaWindCloudRain" || _key === "austriaCityCloudRain" || _key === "austriaTemperature" || _key === "openMeteoForecast" || _key === "resolvedLocalForecast" || _key === "openMeteoMarine") && value && typeof value === "object") {
      if (_key.startsWith("openMeteo") || _key === "resolvedLocalForecast") return compactForecastData(value);
      const obj = { ...(value as Record<string, unknown>) };
      for (const [key, entry] of Object.entries(obj)) {
        if (Array.isArray(entry) && entry.length > 20) obj[key] = entry.filter((_, index) => index % 3 === 0);
      }
      return obj;
    }
    if (_key === "xml" && typeof value === "string" && value.length > 2000) return value.slice(0, 2000) + "...";
    return value;
  };

  return JSON.parse(JSON.stringify(exportData, replacer));
}
