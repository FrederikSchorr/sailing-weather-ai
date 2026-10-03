import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

const require = createRequire(import.meta.url);
export const HEIC_TIMEOUT_MS = 30000;
export const HEIC_MAX_PIXELS = 64_000_000;

// Keep CPU-heavy decoding/encoding off Express's event loop. The package is
// external to the server bundle so its WASM assets and dependency paths survive publishing.
const CONVERT_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { createRequire } = require("node:module");
const convert = require(workerData.converterPath);
const localRequire = createRequire(workerData.converterPath);
(async () => {
  const buffer = Buffer.from(workerData.buffer);
  const images = await localRequire("heic-decode").all({ buffer });
  try {
    if (!images.length || images[0].width <= 0 || images[0].height <= 0
      || images[0].width * images[0].height > workerData.maxPixels) {
      throw new Error("Das HEIC-Bild ist zu groß. Bitte wähle ein kleineres Bild (max. 64 Megapixel).");
    }
  } finally {
    images.dispose();
  }
  const jpeg = await convert({ buffer, format: "JPEG", quality: 0.85 });
  parentPort.postMessage({ jpeg });
})().catch(() => parentPort.postMessage({
  error: "Das HEIC-Bild konnte nicht verarbeitet werden. Bitte wähle ein gültiges Bild mit höchstens 64 Megapixeln oder exportiere es als JPEG."
}));
`;

export function convertHeicToJpeg(
  buffer: Buffer,
  signal?: AbortSignal,
  timeoutMs = HEIC_TIMEOUT_MS,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Abgebrochen", "AbortError"));
    const worker = new Worker(CONVERT_WORKER, {
      eval: true,
      workerData: { buffer, converterPath: require.resolve("heic-convert"), maxPixels: HEIC_MAX_PIXELS },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let settled = false;
    const finish = (image?: Buffer, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void worker.terminate();
      if (error) reject(error);
      else resolve(image!);
    };
    const abort = () => finish(undefined, new DOMException("Abgebrochen", "AbortError"));
    const timer = setTimeout(() => finish(undefined, new Error(
      "Die HEIC-Konvertierung hat zu lange gedauert. Bitte wähle ein kleineres Bild oder exportiere es als JPEG.",
    )), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (result: { jpeg?: Uint8Array; error?: string }) => {
      if (result.error) finish(undefined, new Error(result.error));
      else if (result.jpeg) finish(Buffer.from(result.jpeg));
      else finish(undefined, new Error("Das HEIC-Bild konnte nicht verarbeitet werden."));
    });
    worker.once("error", () => finish(undefined, new Error("Das HEIC-Bild konnte nicht verarbeitet werden.")));
    worker.once("exit", () => {
      if (!settled) finish(undefined, new Error("Die HEIC-Konvertierung wurde unerwartet beendet."));
    });
  });
}