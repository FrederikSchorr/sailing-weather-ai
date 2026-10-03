import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { Messages } from "@anthropic-ai/sdk/resources/messages/messages";
import type { Express } from "express";
import { registerRoutes } from "../server/routes";
import { METEONEWS_URL } from "../server/weather-europe";

// Exercise the actual registered handlers, with no outbound AI/data requests.
const handlers = new Map<string, (req: any, res: any) => Promise<unknown> | unknown>();
const app = Object.fromEntries(["get", "post", "delete"].map(method => [
  method, (route: string, ...callbacks: any[]) => {
    handlers.set(`${method} ${route}`, callbacks.at(-1));
  },
])) as unknown as Express;
await registerRoutes(createServer(), app);
function request(body: unknown) {
  return Object.assign(new EventEmitter(), {
    body, socket: { setNoDelay() {} }, params: {} as Record<string, string>,
    get(_name: string) { return ""; },
  });
}
function response() {
  return {
    statusCode: 200, headersSent: false, writableEnded: false,
    body: null as any, events: [] as any[],
    status(code: number) { this.statusCode = code; return this; },
    json(value: unknown) { this.body = value; return this; },
    setHeader() {}, flushHeaders() { this.headersSent = true; },
    end() { this.writableEnded = true; return this; },
    write(chunk: string) {
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ")) this.events.push(JSON.parse(line.slice(6)));
      }
    },
  };
}
const chat = handlers.get("post /api/chat")!;
for (const invalid of [null, {}, { lat: 91, lon: 0 }, { lat: "0", lon: 0 }]) {
  const res = response();
  await chat(request({ message: "Standort", deviceCoordinates: invalid }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Gerätekoordinaten/);
  assert.equal(res.headersSent, false);
}

const originalFetch = globalThis.fetch;
const originalCreate = Messages.prototype.create;
let releaseWeather!: (value: Response) => void;
const weatherGate = new Promise<Response>(resolve => { releaseWeather = resolve; });
let classifierCalls = 0;
let detectorCalls = 0;
(Messages.prototype as any).create = async (payload: any, options: any) => {
  options?.signal?.throwIfAborted();
  if (payload.model.includes("haiku")) {
    classifierCalls++;
    return { content: [{ type: "text", text: "CHAT" }] };
  }
  if (String(payload.messages?.[0]?.content).startsWith("Ort:")) detectorCalls++;
  return { content: [{ type: "text", text: "Normale Chatantwort" }] };
};
globalThis.fetch = async input => {
  const url = String(input);
  if (url.includes("nominatim.openstreetmap.org/reverse")) {
    return new Response(JSON.stringify({ error: "Unable to geocode" }), { status: 200 });
  }
  if (url === METEONEWS_URL) return weatherGate;
  throw new Error(`Unexpected external call in route regression: ${new URL(url).host}`);
};
try {
  const res = response();
  await chat(request({
    message: "Wetteranalyse für meinen aktuellen Standort",
    deviceCoordinates: { lat: 0, lon: 0 },
    currentLocation: { displayName: "Vorheriger Ort", lat: 48, lon: 16 },
    latestWeatherAnalysis: { invalidOldContext: true },
  }), res);
  const initial = res.events.find(event => event.location);
  assert.ok(initial?.analysisJobId, "device entry must start the background job");
  assert.equal(initial.location.lat, 0);
  assert.equal(initial.location.lon, 0);
  assert.equal(initial.location.cityLat, 0);
  assert.equal(initial.location.regionalModel, "gfs");
  assert.equal(initial.location.source, "device");
  assert.equal(classifierCalls, 0);
  assert.equal(detectorCalls, 0);

  // Cancel before releasing the mocked weather provider.
  const cancelRequest = request({});
  cancelRequest.params.jobId = initial.analysisJobId;
  cancelRequest.get = () => initial.analysisToken;
  const cancellation = response();
  await handlers.get("delete /api/analysis/:jobId")!(cancelRequest, cancellation);
  assert.equal(cancellation.statusCode, 204);
  assert.ok(res.events.some(event => event.done));
  releaseWeather(new Response(`<div class="bulletin-wrap">${"Wetterlage ".repeat(70)}</div>`));
  await new Promise(resolve => setTimeout(resolve, 20));

  const text = response();
  await chat(request({ message: "Wie entsteht die Bora?", history: [] }), text);
  assert.equal(classifierCalls, 1, "normal text must still use message classification");
  assert.equal(text.events.find(event => event.content)?.content, "Normale Chatantwort");
  assert.ok(text.events.some(event => event.done));
} finally {
  releaseWeather(new Response(""));
  globalThis.fetch = originalFetch;
  Messages.prototype.create = originalCreate;
}
console.log("Device route tests passed (invalid requests, direct zero-coordinate job, no stale context/classification/detection, cancellation and ordinary text chat).");