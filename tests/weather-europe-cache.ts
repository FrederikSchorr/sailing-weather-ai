import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import {
  fetchMeteonews,
  preprocessMeteonews,
} from "../server/weather-europe.js";

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
let interpretationCalls = 0;

globalThis.fetch = async () => {
  fetchCalls += 1;
  return new Response(
    '<div class="bulletin-wrap">Europawetter mit Tiefdruck und Regen.</div>',
    { status: 200, headers: { "content-type": "text/html" } },
  );
};

const anthropic = {
  messages: {
    create: async () => {
      interpretationCalls += 1;
      return {
        content: [{ type: "text", text: "Europawetter mit Tiefdruck und Regen." }],
      };
    },
  },
} as unknown as Anthropic;

try {
  const firstReport = await fetchMeteonews();
  const firstInterpretation = await preprocessMeteonews(firstReport, anthropic);
  const repeatedReport = await fetchMeteonews();
  const repeatedInterpretation = await preprocessMeteonews(repeatedReport, anthropic);

  assert.equal(repeatedReport, firstReport);
  assert.equal(repeatedInterpretation, firstInterpretation);
  assert.equal(fetchCalls, 1, "Meteonews report should be fetched only once");
  assert.equal(
    interpretationCalls,
    1,
    "Meteonews report should be interpreted only once",
  );
  console.log("weather europe cache: all checks passed");
} finally {
  globalThis.fetch = originalFetch;
}