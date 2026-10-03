# aiWindy veröffentlichen

## Neuer Release

1. Genau einmal `npm run release:prepare` ausführen. Standardmäßig steigt die
   Korrekturversion: beispielsweise `2.3.0` → `2.3.1` → `2.3.2`.
2. `npm run test:release`, `npm run check` und `npm run build` ausführen.
3. Die vorbereiteten Änderungen einschließlich `shared/release.json`,
   `package.json` und `package-lock.json` zusammen behalten bzw. committen.
4. Über **Publish** veröffentlichen.

Für neue Funktionen kann bewusst `npm run release:prepare -- minor` verwendet
werden (`2.3.2` → `2.4.0`); für grundlegende Änderungen
`npm run release:prepare -- major` (`2.4.0` → `3.0.0`).

## Build oder Veröffentlichung wiederholen

Bei Fehlern oder Wiederholungen desselben Releases **nicht erneut
`release:prepare` ausführen**. Die Vorbereitung ist eine bewusste Release-Aktion,
kein Build-Hook. Jeder weitere Aufruf bereitet die nächste Version vor.
Build, Serverstart und Browseraufruf verändern Version und Datum nicht.
Der Produktionsbuild verweigert widersprüchliche oder unvorbereitete Metadaten.

## Anzeige und Analyseexport

`shared/release.json` enthält die gemeinsame Version und den gespeicherten
UTC-Zeitpunkt der Vorbereitung. Beide werden in Frontend und Backend eingebunden.
Das Info-Popover zeigt beispielsweise **v2.3.0 · Okt 2026**. Der Monat wird
auf Deutsch abgekürzt ohne abschließenden Punkt für **Europe/Vienna** formatiert; er bezeichnet die
Release-Vorbereitung, nicht den Zeitpunkt eines nachgewiesenen erfolgreichen
Publishs und nicht das aktuelle Browserdatum.

Neue Analyseexporte verwenden dieselbe Versionsnummer. Bestehende Analysen
werden nicht umgeschrieben.