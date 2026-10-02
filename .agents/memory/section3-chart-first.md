---
name: Section 3 chart-first interpretation
description: The wind and wave LLM section should interpret the visible wind chart instead of transcribing every time slot.
---

# Section 3 chart-first interpretation

Section 3 should preserve the fixed order of warning, today, tomorrow, day after tomorrow, and the three-day outlook. The wind chart is the detailed timeline, so prose should focus on meaningful changes, named local wind systems, strong or stormy phases, and an optional supported synoptic pattern. Explicit wave data remains useful because the chart does not show wave state.

**Why:** Repeating every wind value and direction made the interpretation redundant with the visual forecast and obscured the important changes.

**How to apply:** Keep local wind and warning data authoritative. Mention only salient strengthening, weakening, shifts, lulls, peaks, or hazards; use broad synoptic context only when it clearly supports the local evolution.

Local wind mechanisms are the preferred interpretive value: named regional systems, thermal cycles, funneling/channeling, lee or downslope effects, and coastal convergence should explain sailing-window reliability, gustiness, or spatial unevenness when supported.

**Why:** A technically correct sequence of chart values remained uninteresting, while explanations such as Leitha channeling, pressure-gradient decay, frontal turning, and cold-sector roughness added actionable sailing context.

**How to apply:** Lead each daily bullet with the sailing implication or local mechanism and use values only as evidence. Phrase merely plausible mechanisms cautiously; never infer a cause from direction alone. Permit one extra transition value when it is necessary to explain a distinct supported mechanism, but continue rejecting value-only timelines.

Every new final-output constraint must also be stated explicitly in the correction prompt, including per-day value limits and interpretation requirements.

**Why:** The initial prompt and validator required concise interpretation, but correction attempts repeated only format and direction rules. Six diverse locations then exhausted all retries with the same over-detailed outlook shape.

**How to apply:** Keep initial generation rules, correction instructions, and final validators in lockstep. When a multi-location run fails the same check everywhere, inspect correction-prompt parity before weakening the validator.

Generated wind text must not use `SSW`; normalize that southwest sector to `SW`. Official warning text remains verbatim even if the warning centre itself uses finer direction wording.

**Why:** The requested user-facing granularity stops at `SW`, while official warnings must never be rewritten.

**How to apply:** Exclude `SSW` from generation prompts and normalize generated forecast text before the authoritative warning is restored.

Treat a combined value such as `NO Wind 12–25 kt` as sustained wind plus its associated gust; do not add a separate numeric gust clause. Use only the restrained word `böig`, if clearly warranted.

**Why:** The exact gust timeline is already visible in the chart, and the combined range already contains the gust value. Separate “Böen …” clauses or repeated maxima duplicate it; “ungewöhnlich böig” overstates common gust spreads.

**How to apply:** Every concrete wind strength must retain its exact sampled wind–gust pair, including named systems such as Meltemi. Restore omitted gusts from the matching local sample; never estimate them. Remove standalone gust clauses, peak-time prose, and repeated upper bounds. Never say “ungewöhnlich böig”; allow `böig` at most once and only for a clearly supported day.

User-facing wind text uses only the eight compass points N, NO, O, SO, S, SW, W, NW; finer 16-point source directions are reduced to their nearest 8-point direction.

**Why:** The forecast is intended to be quickly readable and must not leak source labels such as NNW or WNW.

**How to apply:** Keep numeric degrees for chart arrows and timestamp resolution, but normalize textual directions in provider summaries, prompts, and final generated output.

The single global interpretation call receives concrete section-3 values through one canonical hourly table whose rows pair timestamp, direction, wind, and gust. National text summaries may enrich that input but must not replace or hide the table.

**Why:** Provider-specific preprocessing can replace a generic wind object even when the generic object contains the only complete paired timeline; that makes valid local wind appear unavailable to the final interpreter.

**How to apply:** When adding or changing national wind preprocessing, merge its summary with the canonical hourly table and regression-test that the table reaches the final interpretation prompt.

No weather section may use deterministic replacement prose when generated bullets disappear. Preserve and repair the LLM output path instead; deterministic handling may restore formatting, ordering, icons, and validated wind–gust pairs only.

**Why:** The LLM forecast content was already useful. A warning-cleanup routine mistakenly treated unhyphenated forecast lines as warning continuation and deleted them.

**How to apply:** If bullets go missing, trace prompt output and postprocessing rather than generating replacement prose. Accept relative or calendar-only forecast prefixes, with or without Markdown hyphens, then normalize them; reject genuinely incomplete LLM contracts.

Official warnings must appear as one bullet containing the heading and the entire warning text, even when the source contains multiple lines.

**Why:** The user explicitly requested that the official warning and its content not be split into separate bullets.

**How to apply:** Preserve official wording, but join source line breaks with spaces before inserting the warning into section 3.