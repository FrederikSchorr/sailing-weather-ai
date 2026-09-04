---
name: Weekdays in wind normalization
description: Prevent German weekday abbreviations in multi-day wind bullets from being mistaken for compass directions.
---

Treat forecast date prefixes and case-sensitive weekday tokens as structure, not wind prose, before applying case-insensitive direction normalization.

**Why:** A multi-day phrase such as “So S 5–16 kt” can otherwise be parsed as the composite directions “SO S”, silently deleting the Sunday association while still producing syntactically valid wind text.

**How to apply:** Isolate canonical forecast prefixes and protect weekday-plus-direction/value tokens before normalizing 8- or 16-point compass directions. Test the full production normalization path with combinations such as Sunday/South and Monday/East.