---
name: Universal local forecasts
description: Source-precedence and transparency rules for local sailing forecasts across countries.
---

Use Open-Meteo as the reliable six-day local baseline for wind, cloud, rain, thunderstorm risk and temperature. Treat marine wave data as optional: it may appear only when the provider returned real usable wave values. National adapters do not replace the baseline; their concrete local values take priority for the intervals they actually cover, while their warnings and synopses remain separate.

**Why:** National feeds differ substantially in coverage and availability. Replacing local coverage wholesale with a short or failed national bulletin creates dangerous forecast gaps and can falsely imply a warning all-clear.

**How to apply:** Keep section 6 limited to sources that supplied usable data. Show an explicit warning-center capability state separately: connected, temporarily unavailable, or not connected. An unavailable warning source must never be rendered as “no warning.”

Keep the meteogram tied to the representative city coordinate while the wind chart remains tied to the sailing-area coordinate. Do not force their event times to coincide.

**Why:** The city weather view and local sailing wind intentionally describe different locations; genuine timing differences are acceptable and more truthful than artificial alignment.

**How to apply:** Preserve exact timestamp matching and field-specific three-hour aggregation, but allow city thunderstorm signals and sailing-area gust peaks to occur in different displayed columns.

Standort- und Fotoanalysen behalten zwei getrennte Koordinaten: Geräte-/Foto-GPS setzt den Ort für lokales Wetter und Meteogramm; ein erkanntes Segelrevier setzt den hinterlegten Revierpunkt für Wind und Welle, genauso wie bei Texteingabe.

**Why:** Der Nutzer korrigierte ausdrücklich: „Wir haben doch immer 2 getrennte Koordinaten: Ort vs Segelrevier. Bei Standortanalyse soll diese den Ort setzen, aber Segelrevier so wie bei Texteingabe ermitteln.“ Er verlangte anschließend dieselbe Prüfung für Fotoupload. Beide Punkte auf GPS zu setzen war ein Fehler, keine gewünschte Ausnahme.

**How to apply:** Ortsname und Ortskoordinaten aus dem Standort beibehalten, Revieridentität und Revierkoordinaten unabhängig ermitteln. Ohne erkanntes Revier bleibt GPS auch der Windpunkt.

Photo/video GPS describes the recording location, not necessarily the user's current device location. Without recording GPS, retain an existing active sailing area as chat context but never present it as extracted recording metadata.

**Why:** Gallery uploads can be historical or taken elsewhere, and camera uploads can lose GPS metadata. The user explicitly requested verifying sailing-area recognition for both gallery and camera paths.

**How to apply:** Recognise sailing areas from genuine recording coordinates, distinguish them from a live device position, and keep cloud-image interpretation independent of external forecast context.

Read recording metadata before normalising HEIC to JPEG. The converted JPEG is only a compatibility image for vision and preview; it must not replace the original recording provenance.

**Why:** The vision interface does not accept HEIC, and conversion strips its GPS metadata. Using the converted bytes for location discovery would silently lose the sailing area again.

**How to apply:** Retain metadata from the original upload and keep CPU-heavy image conversion outside the shared request-handling thread, so other weather requests remain responsive.

For national warning feeds, an explicitly empty warning field or provider-specific “none” marker is a checked all-clear; missing/malformed fields remain unavailable. Never send empty warning text to an LLM or accept its meta-response as a warning.

**Why:** DHMZ returned an empty regional warning plus “Nema.” in its alternate feed; translating the empty field produced an English request for input that was then displayed as an official warning.

**How to apply:** Parse warning state before translation, let any active warning across equivalent official feeds override clear markers, reject translation meta-responses, and preserve unavailable status if active text cannot be processed.

In the sources view, a connected provider must be named as the concrete forecast or warning product it supplied (for example, a marine forecast including storm warnings), not as a generic live “connected” status. Capability status is reserved for unavailable or unsupported warning centers.

**Why:** A source list should explain the provenance of the displayed information. A bare connection status is redundant and can be mistaken for a weather observation or warning.

**How to apply:** Keep each connected national source once, with a descriptive label. Continue showing neutral warning-center text only when that source is unavailable or not integrated.

For section 3, show the current national or regional storm-warning result as the first bullet whenever that country has an integrated warning source. A confirmed all-clear is plain text without an alert icon; an unreachable integrated source receives an explicit alert status. Unsupported centers stay only in section 6.

**Why:** Sailors need a visible confirmation that the relevant warning source was checked, while an unavailable service must be unmistakable and never be mistaken for an all-clear.

**How to apply:** Insert this bullet deterministically ahead of the wind forecast after output generation. Use a checked flag to distinguish confirmed warnings/all-clears from an unreachable source; do not create it for unsupported countries.

Restore an integrated warning centre's complete authoritative text after model generation; never accept a model echo as the final warning. Identify warning candidates by warning-specific wording or the authoritative first line, not by the severity icon alone.

**Why:** The model can preserve only the first line while altering later warning lines, and the same severity icon is also valid on ordinary high-wind forecast bullets.

**How to apply:** Remove only the generated warning candidate and its continuation, prepend the authoritative text unchanged, and preserve separate severe-wind forecast bullets even when they use the warning icon.

In section 4, precipitation amounts and daily totals belong exclusively in the meteogram; prose describes only the qualitative rain development and must not contain `mm`.

**Why:** Textual amounts can diverge from chart intervals or rounded daily sums and merely duplicate information already visible in the meteogram. Listing every rain interval also obscures the main weather development.

**How to apply:** Summarize rain as one compact phase (or one standout onset/peak), never enumerate every shower, and strip generated amount or total mentions before display.