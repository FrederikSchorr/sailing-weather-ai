import assert from "node:assert/strict";
import { fetchMeteonews } from "../server/weather-europe.js";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
let fetchCalls = 0;

globalThis.fetch = async () => {
  fetchCalls += 1;
  throw new Error("simulated upstream timeout");
};
globalThis.setTimeout = ((callback: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]) => {
  callback(...args);
  return 0 as unknown as NodeJS.Timeout;
}) as typeof setTimeout;

try {
  const [first, shared] = await Promise.all([
    fetchMeteonews(),
    fetchMeteonews(),
  ]);
  const repeatedStartedAt = Date.now();
  const repeated = await fetchMeteonews();
  const repeatedDurationMs = Date.now() - repeatedStartedAt;

  assert.equal(first, "");
  assert.equal(shared, "");
  assert.equal(repeated, "");
  assert.equal(fetchCalls, 3, "a failed Meteonews request must not be repeated in the same cache window");
  assert.ok(
    repeatedDurationMs < 50,
    `negative cache lookup should be immediate, took ${repeatedDurationMs} ms`,
  );
  console.log("weather europe failure cache: all checks passed");
} finally {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
}