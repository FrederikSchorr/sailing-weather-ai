# aiWindy Mehrort-Outputvertrag

Diese Spezifikation fasst die verbindlichen Anforderungen für wiederholbare Inhaltsprüfungen der Wetteranalyse zusammen. Die UI ist nicht Teil dieses Tests.

## Gesamtziel

Die vier Textabschnitte sollen die sichtbaren Charts nicht abschreiben, sondern deren wichtigste Signale meteorologisch einordnen. Lokale Mess- und Prognosedaten sind maßgeblich; nationale Informationen, Warnungen, Europa-Karten und bekannte regionale Windsysteme liefern Kontext. Aussagen müssen durch die übergebenen Daten gestützt sein.

Für alle Abschnitte gilt:

- keine erfundenen Werte, Quellen oder Entwicklungen
- keine technischen Rohwerte wie WMO-Codes oder Wolkenprozente
- keine deterministischen Ersatzprognosen
- keine leeren oder rein formalen Bullets
- keine internen Fehler- oder Vertragstexte
- lokale und nationale Daten haben Vorrang vor großräumigem Kontext
- ein vollständiger Output wird erst akzeptiert, wenn auch die normalisierte Endfassung vollständig ist

## Abschnitt 1 – Druck & Luftmassen

- exakt zwei Bullets
- Bullet 1 beginnt mit `🌀` und interpretiert dominante Drucksysteme über Europa sowie deren Bewegung
- Bullet 2 beginnt mit `🌡️` und interpretiert Luftmassen, Feuchte-/Temperaturcharakter oder Luftmassengrenzen
- basiert auf 850-hPa-/Bodendruckkarten, Meteonews und nationaler Synopsis
- keine lokale Windprognose, kein lokaler Regen und keine Temperaturwerte in °C
- Mehrwert: Systementwicklung und Luftmassenbezug statt bloßer Kartenbeschreibung

## Abschnitt 2 – Fronten

- exakt zwei Bullets
- Bullet 1 beginnt mit `🌍` und beschreibt ausschließlich die großräumige Frontenlage über Europa
- Bullet 2 beginnt mit `📍`, nennt das tatsächliche Zielrevier und beschreibt dessen lokale Frontenlage
- keine Vertauschung von Europa- und Lokalbullet
- keine Okklusionen, Frontwirkungen, Regen- oder Windprognosen
- Mehrwert: Entfernung, Bewegungsrichtung und lokale Relevanz der nächsten Kalt-/Warmfront

## Abschnitt 3 – Wind & Welle

- bei angebundener Warnquelle zuerst genau ein unveränderter Warnstatus
- danach exakt vier Prognosebullets: Heute, Morgen, Übermorgen, Datumsbereich
- konkrete Windwerte erscheinen als verbundenes Wind-/Böen-Paar, z. B. `12–20 kt`
- nur `N, NO, O, SO, S, SW, W, NW`
- keine getrennten numerischen Böenspitzen und keine redundante Wiederholung des oberen Bereichswerts
- höchstens einmal `böig`, nur wenn gestützt
- interpretiert markante Verstärkung, Abschwächung, Drehung, Flaute, starke Phase oder passendes lokales Windsystem
- keine stündliche Transkription des Windcharts
- jeder Bullet beginnt mit der seglerischen Kernaussage; Werte dienen nur als Beleg
- heute und morgen in der Regel höchstens zwei Wind-/Böen-Paare, übermorgen höchstens eines, im Ausblick höchstens eines pro Tag
- ein zusätzlicher Tageswert ist nur erlaubt, wenn er einen eigenen lokal oder frontal verursachten Übergang belegt
- keine Peak-Transkriptionen wie `Spitze um 09 Uhr`
- lokale Windsysteme und thermische, Düsen-, Kanalisierungs-, Lee- oder Fallwindeffekte haben Vorrang, wenn Region und Verlauf sie stützen
- erklärt die seglerische Folge lokaler Effekte, etwa Böigkeit, räumliche Unterschiede oder Verlässlichkeit des Windfensters
- plausible, aber nicht ausdrücklich bestätigte lokale Mechanismen werden vorsichtig eingeordnet und niemals als sichere Ursache erfunden
- heute darf konkrete Zeiten nennen; morgen nur grobe Tagesphasen; Übermorgen und Ausblick bleiben zunehmend zusammenfassend
- Wellendaten nur nennen, wenn sie für die Zielkoordinaten tatsächlich vorhanden sind
- fehlen Wellendaten, werden Wellen, Seegang, Wellen-Icons und Verfügbarkeitshinweise vollständig ignoriert

## Abschnitt 4 – Wetter & Regen

- exakt drei Bullets: Heute, Morgen, Mehrtagesausblick
- jeder Bullet enthält substantielle Wetterinformation und ein semantisch passendes Wetter-Icon
- interpretiert Bewölkung, Temperaturtrend, qualitative Regenentwicklung und relevante Druckänderungen
- nutzt die Stadtkoordinate des Meteogramms; Wind- und Wellendaten gehören nicht in diesen Abschnitt
- keine Niederschlagsmengen in `mm`, keine Wolkenprozente, keine WMO-Codes
- Druckänderungen nur ab mindestens 4 hPa pro Tag
- Gewitter nur bei gestütztem lokalem Signal oder konkreter nationaler Ortsinformation
- keine normale abendliche Abkühlung oder kleine stündliche Schwankungen als markante Entwicklung darstellen
- Mehrwert: wichtigste Wetterphase und Übergänge statt Ablesen jeder Chartspalte
- ein aus nächtlichen Taupunkten berechnetes Feuchtigkeitssignal darf auffällig feuchte oder trockene Nächte stützen; Berechnung, Taupunktwerte und „Taupunkt-Spread“ bleiben unsichtbar und werden nicht täglich erwähnt

## Wiederholbare Ortsmatrix

| Land | Orte |
|---|---|
| Griechenland | Meganisi, Lefkada, Paros, Korfu, Kos, Rhodos |
| Österreich | Weiden am See, Gmunden, Klagenfurt |
| Kroatien | Punat, Split, Hvar |

Ausführung:

```bash
npm run test:sea-outputs
```

Der Test benötigt eine laufende Anwendung auf `http://127.0.0.1:5000` oder eine abweichende Basis-URL über `AIWINDY_TEST_BASE_URL`. Berichte werden unter `test-results/sea-output-latest.json` und `test-results/sea-output-latest.md` geschrieben.

Einzelne fehlgeschlagene Orte können gezielt wiederholt und in den letzten Gesamtbericht zurückgeführt werden:

```bash
AIWINDY_TEST_ONLY="Rust" AIWINDY_TEST_MERGE=true npm run test:sea-outputs
```