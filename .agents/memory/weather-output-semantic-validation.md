---
name: Weather output semantic validation
description: Durable validation rules for target-specific bullets and semantic weather icons
---

# Weather Output Semantic Validation

Generated target-specific bullets must be checked against the current analysis location. If the model names a stale or unrelated target, bind the sentence subject to the actual location instead of trusting prompt compliance alone.

**Why:** Repeated fresh analyses showed that an otherwise correctly structured local-front bullet could name a location from another analysis even when the prompt explicitly required the current sailing area.

**How to apply:** For any location-specific generated section, validate the target reference after generation. Keep large-scale and local statements in their assigned bullet positions.

Weather icons must be selected from positive weather evidence after removing negated phrases such as “kein nennenswerter Niederschlag”.

**Why:** Keyword-only icon selection classified negated precipitation statements as rain.

**How to apply:** Strip or recognize negated phenomena before semantic icon classification, and cover adjective-bearing negations in regression tests.

Every section's completeness must be validated again after deterministic normalization and sanitization, not only on the raw model response.

**Why:** A formally complete weather section can become empty when clauses are removed by output constraints. Wind and warning cleanup can also delete a forecast tail that existed in the raw response.

**How to apply:** Validate required line counts and forbidden cross-section content on final normalized text inside the correction loop. Retry failures and never persist or render them as completed analyses.

Forecast dates must be canonicalized by sequence after the warning block, and “today” content must be evaluated against the immutable request timestamp.

**Why:** Mixed relative/calendar labels produced duplicate “Heute” lines and shifted later dates. Clock colons such as `20:50` were also mistaken for label delimiters, and completion-time checks falsely aged valid near-future text during long LLM calls.

**How to apply:** Map the four forecast rows positionally to Today, Tomorrow, Day After Tomorrow, and Tail; parse labels without splitting on clock colons; reject past Today content using the analysis request instant.

Every numeric forecast wind value is a sustained-wind/gust pair, and every direction token belongs to the eight-point compass.

**Why:** Single values and compound directions such as `NNW`, `NW-W`, or adjacent `SO NW` are ambiguous for sailors and violate the product's compact wind notation.

**How to apply:** Require `lower–upper kt` for every numeric wind mention; allow only N, NO, O, SO, S, SW, W, NW; normalize composites and reject any invalid final forecast before display.

National warning blocks may contain official continuation lines, but only their first bullet counts as the single warning status. A repeated warning clause inside a dated forecast must be removed without deleting that forecast row.

**Why:** Official multiline warnings were miscounted as duplicate statuses, while an embedded DHMZ clause caused an otherwise valid Today row to be discarded and shifted all later dates forward.

**How to apply:** Distinguish physical warning lines from warning bullets, recognize relative and calendar-prefixed forecast rows before cleanup, and strip only redundant warning clauses from those rows.

Required short sections must remain substantive after icon and clause normalization. A symbol-only bullet is incomplete even if the expected line count is present.

**Why:** A generated Europe-front bullet containing only its globe icon passed the former line-count checks and was persisted as a completed analysis.

**How to apply:** Validate both required bullets in sections 1 and 2 for meaningful letter content inside the same correction loop used for wind and weather sections.

When Today starts at the current full hour but the request was made later in that hour, rewrite that boundary to “ab jetzt”; do not weaken past-time checks.

**Why:** Hourly forecast data prompted phrases such as “ab 20 Uhr” at 20:10, which technically included elapsed time and repeatedly exhausted correction attempts.

**How to apply:** Normalize only an `ab` boundary in the current hour to “ab jetzt”; continue rejecting references to earlier hours and completed day periods.

Count rendered warning bullets, not lines in the original national bulletin. Preserve independently validated interpretations and authoritative warnings if other sections still fail after the correction limit; never present rejected model prose as valid.

**Why:** A multiline HNMS bulletin became one display bullet, but the validator still subtracted its original line count. A valid Athens forecast was repeatedly rejected; a truthy but empty output object then hid the terminal error.

**How to apply:** Keep formatting and validation consistent about warning cardinality. Deliver verified partial results with an explicit failure status and show the error even when charts, exports, or partial interpretations already exist.