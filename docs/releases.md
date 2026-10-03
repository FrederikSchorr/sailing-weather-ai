# aiWindy veröffentlichen

## Neuer Release

1. Genau einmal `npm run release:prepare` ausführen. Standardmäßig steigt die
   Korrekturversion: beispielsweise `2.3.0` → `2.3.1` → `2.3.2`.
2. `npm run test:release`, `npm run check` und `npm run build` ausführen.
3. Die vorbereiteten Änderungen einschließlich `shared/release.json`,
   `package.json` und `package-lock.json` zusammen committen. Die Nachricht des
   manuellen Release-Commits enthält immer die Versionsnummer, beispielsweise:
   `release(v2.4.2): Orts- und Revierkoordinaten bei Standort- und Fotoanalyse trennen`.
   So ist die Version direkt in der Commit-Historie nachvollziehbar. Automatisch
   erzeugte Replit-Checkpoint-/Publish-Titel ersetzen diese Konvention nicht.
4. Optional den geprüften Commit mit `npm run release:tag` lokal kennzeichnen
   und den Tag nach bewusster Bestätigung übertragen (siehe unten).
5. Über **Publish** veröffentlichen. Ein Tag veröffentlicht die App nicht.

Für neue Funktionen kann bewusst `npm run release:prepare -- minor` verwendet
werden (`2.3.2` → `2.4.0`); für grundlegende Änderungen
`npm run release:prepare -- major` (`2.4.0` → `3.0.0`).

## Versionsnummern als Git-Tags (GitLab oder GitHub)

`npm run release:prepare` erstellt weiterhin **keinen** Tag. Nach erfolgreichen
Prüfungen und dem Commit ist `npm run release:tag` ein separater, bewusster
Schritt. Er erzeugt einen **annotierten lokalen Tag**, beispielsweise `v2.3.0`,
auf dem aktuellen `HEAD`-Commit. Die Annotation enthält Version,
Vorbereitungsdatum und Commit-ID. Das Skript prüft die Metadaten **aus diesem
Commit**: Release-, Paket- und beide Lockfile-Versionen müssen übereinstimmen,
und das Vorbereitungsdatum muss gesetzt und gültig sein.

Vorab kann `npm run release:tag -- --dry-run` dieselben Prüfungen ausführen,
ohne einen Tag anzulegen. Beide Aufrufe verweigern uncommittete Änderungen
(einschließlich nicht ignorierter neuer Dateien), unvorbereitete/widersprüchliche
Metadaten und bereits vorhandene lokale Versions-Tags. Vorhandene Tags werden
niemals ersetzt, auch nicht bei Wiederholungen. Bei einem erneuten Versuch
denselben Tag mit `git show v2.3.0` prüfen, nicht löschen oder erzwingen.
Die Prüfungen aus Schritt 2 müssen vor dem Taggen erfolgreich sein; das
Tag-Skript wiederholt Test, Typprüfung und Build nicht.

### Remote prüfen und den einzelnen Tag übertragen

Bei der Einrichtung war `origin` ein **GitHub**-Repository; ein GitLab-Remote
war nicht eingerichtet. Es gab weder lokale Tags noch Tags im geprüften
GitHub-Remote. Daraus folgt keine Aussage über ein separates GitLab-Projekt.
Der lokale Befehl funktioniert unabhängig vom Anbieter, macht den Tag aber
noch nicht in GitLab sichtbar.

1. Mit `git remote -v` das gewünschte Ziel prüfen. Ist GitLab das Ziel,
   zunächst dessen Projektadresse und Zugriff klären. Ein vorhandenes
   GitHub-Remote nicht ungefragt ersetzen. Falls erforderlich, GitLab bewusst
   als weiteres Remote mit dem Namen `gitlab` einrichten.
2. Vor dem Push mit `git ls-remote --tags gitlab` die vorhandenen Remote-Tags
   prüfen. Fehlender Zugriff ist ein Fehler, kein Nachweis für fehlende Tags.
3. Den lokalen Tag mit `git show v2.3.0` kontrollieren. Falls dieser Name im
   Remote bereits existiert, **nicht überschreiben**. Bei annotierten Tags muss
   auch die mit `^{}` angezeigte Commit-ID zum vorgesehenen Commit passen.
4. **Erst nach ausdrücklicher Bestätigung** den einzelnen Tag übertragen:
   `git push gitlab refs/tags/v2.3.0:refs/tags/v2.3.0`.
   Für GitHub stattdessen das geprüfte `origin` verwenden. Versionsnummer und
   Remote in diesen Beispielen an den tatsächlich geprüften Release anpassen.
   Kein `--force`, kein pauschales `--tags` und kein automatischer Push.

Danach erscheint die Version in GitLab unter **Code → Tags** (je nach
GitLab-Version auch **Repository → Tags**), mit Verweis auf den Release-Commit.
Ein GitLab-Release mit zusätzlichen Änderungsnotizen ist optional und wird
nicht automatisch erstellt.

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