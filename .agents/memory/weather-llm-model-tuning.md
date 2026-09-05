---
name: Weather LLM model tuning
description: Empirical model and temperature choice for strict local weather output generation.
---

Use Claude Sonnet 4.6 with temperature 0.2 for the structured four-section weather output unless a future repeated benchmark demonstrates a clear improvement.

**Why:** Sonnet 4.6 at temperature 0 improved first-output retries but repeated one malformed correction deterministically, passing 23/24 cases across two runs. Temperature 0.2 passed 12/12 with nine first attempts, three second attempts, no third attempts, and 33.6 seconds average. Sonnet 5 requires omitting temperature and disabling its default adaptive thinking for this 1,800-token response; configured that way, it passed 12/12 but had only eight first attempts and one warning. Opus 4.6 at temperature 0 passed only 10/12, required four third attempts, and reached 130 seconds for one location.

**How to apply:** Compare model or sampling changes on the same 12-location matrix without changing prompts or validators simultaneously. Evaluate first-attempt rate, terminal failures, warnings, and latency together; do not assume the newer or stronger model follows strict formatting better. Sonnet 5 rejects non-default temperature and should use disabled thinking for short, bounded outputs.