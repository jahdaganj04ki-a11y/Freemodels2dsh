# Installationsanleitung – Freemodels2dsh für DSH Desktop (Windows)

Diese Anleitung beschreibt die komplette Installation und Ersteinrichtung des
Plugins **Freemodels2dsh** unter Windows. Das Plugin bringt kostenlose
Cloud-LLM-Provider in DSH Desktop – ohne lokales Modell-Runtime und ohne
Zahlungsdaten. Alle Befehle sind gegen die aktuelle DSH-Desktop-Version
(v0.12.x mit Harness 0.2.1-rc.x) geprüft.

> Eine kurze englische Fassung steht im [README](./README.md). Diese Datei
> ist die ausführliche Schritt-für-Schritt-Variante inklusive Fehlersuche.

---

## 1. Voraussetzungen

| Voraussetzung | Hinweis |
| --- | --- |
| Windows 10/11 (64-Bit) mit aktuellem DSH Desktop | Getestet gegen DSH Desktop v0.12.x |
| DSH-CLI (`dsh`) | Wird zusammen mit DSH Desktop installiert |
| Node.js 18 oder neuer (nur zum Packen) | Empfohlen: 20/22 LTS, inkl. `npm` |
| Ein Terminal | Windows PowerShell oder das Terminal von DSH Desktop |
| API-Keys | Nur für die Provider, die du nutzen willst – für Kilo Gateway reicht komplett ohne Key |

Das Profil muss **`web`** sein. Das Profil `desktop` lehnt externe Plugins
ab.

---

## 2. Plugin-Paket erstellen

Klone das Repository und erzeuge das installierbare `.tgz`-Paket:

```powershell
git clone https://github.com/jahdaganj04ki-a11y/Freemodels2dsh.git
cd Freemodels2dsh
npm install
npm run pack:plugin
```

Daraufhin liegt im Projektordner eine Datei wie
`freemodels2dsh-1.2.0.tgz` (die Versionsnummer kann abweichen). Optional
vorab die Tests laufen lassen:

```powershell
npm test
```

Wer nicht selbst bauen will, verwendet ein fertiges
`freemodels2dsh-<version>.tgz` aus einem Release – die weiteren Schritte
sind identisch.

---

## 3. Installation über die DSH-CLI (empfohlener Weg)

1. Öffne **PowerShell** (oder das Terminal, das DSH Desktop mitbringt).
2. Installiere das Paket mit **absolutem Windows-Pfad** und dem festen
   Profil `web`:

```powershell
dsh plugin --profile web add C:\Users\<dein-name>\Freemodels2dsh\freemodels2dsh-1.2.0.tgz
```

- Pfade mit Leerzeichen in Anführungszeichen setzen:
  `"C:\Users\Anna Muster\Downloads\freemodels2dsh-1.2.0.tgz"`.
- Ein Ordnerpfad statt `.tgz` funktioniert in Entwicklungs-Setups
  ebenfalls.
- Unsicher, ob der lokale `.tgz`-Weg in deinem Build unterstützt wird?
  `dsh plugin add --help` zeigt die akzeptierten Eingaben.

3. Prüfe, ob das Plugin als Konfigurationsschicht geladen ist:

```powershell
dsh --profile web --dump-config
```

In der Ausgabe taucht eine Plugin-Schicht `freemodels2dsh` auf.

---

## 4. Alternative: Installation über die DSH-Desktop-Oberfläche

Falls dein Build im Bereich **Workbench management / Installed
workbenches** (zu Deutsch etwa „Workbench-Verwaltung / Installierte
Workbenches") eine lokale Paketinstallation anbietet:

1. Öffne die Workbench-/Plugin-Verwaltung in den DSH-Desktop-Einstellungen.
2. Wähle die lokale `.tgz`-Datei aus.
3. Bestätige die Installation.

Nur nutzen, wenn die Oberfläche die lokale `.tgz`-Eingabe tatsächlich
anzeigt – andernfalls den CLI-Weg aus Abschnitt 3 verwenden.

---

## 5. DSH Desktop vollständig neu starten

Die Plugin-UI wird erst nach einem echten Neustart geladen:

1. DSH Desktop **komplett beenden** – auch aus dem Infobereich (Tray),
   falls das Icon dort weiterläuft.
2. DSH Desktop neu starten.
3. Öffne **Settings → Plugins → Free Models**.

Der Tab **Free Models** mit allen 10 Providern ist jetzt sichtbar.

---

## 6. Ersteinrichtung: Accounts und Modelle

### 6.1 Provider öffnen

Klicke in der Liste auf eine Provider-Zeile. Es öffnet sich das
Provider-Fenster mit Accounts, Schaltungsmodus und Modellliste.

### 6.2 Account hinzufügen

1. Optional einen Label vergeben (z. B. `privat`).
2. Den API-Key des Providers einfügen.
3. **Ausnahme Cloudflare:** zusätzlich die 32-stellige hexadezimale
   **Account ID** eintragen.
4. **Ausnahme Kilo Gateway:** das Key-Feld darf leer bleiben. Ohne Key
   läuft der Zugriff anonym über das kostenlose Free-Pool
   (200 Anfragen/Stunde pro IP). Ein optionaler, kostenloser Kilo-Key
   (GitHub-Anmeldung, keine Zahlungsdaten) verschiebt das Limit auf den
   Account.
5. Auf **Add** klicken.

Pro Provider sind bis zu 20 Accounts möglich. Jeder Account lässt sich
per Schalter aktivieren/deaktivieren und über **Test connection** prüfen.

### 6.3 Schaltungsmodus (Account Switching) wählen

- **Manual** – nur der per Radiobutton gewählte Account wird verwendet.
- **On error / quota** – der aktive Account führt; bei ungültigem Key,
  Kontingentende, Rate-Limit oder Serverfehler wird automatisch auf den
  nächsten nutzbaren Account gewechselt (vor dem ersten Antwort-Token,
  damit keine Antwort doppelt erscheint).
- **Round robin** – jede Anfrage rotiert zum nächsten aktiven Account.

### 6.4 Modellliste laden

- Im Provider-Dialog: **Fetch available models** holt die aktuellen, für
  den Free-Tier gefilterten Modelle dieses Providers. **Reset to
  built-in list** stellt die mitgelieferte Standardliste wieder her.
- Im Tab-Kopf: **Update all free model lists** aktualisiert alle
  konfigurierten Provider in einem Rutsch. Teilerfolge bleiben erhalten,
  fehlgeschlagene Provider werden einzeln gemeldet.

### 6.5 Modell im Chat nutzen

Sobald mindestens ein Account aktiviert ist, erscheinen die Free-Modelle
des Providers im Modell-Picker von DSH Desktop (Route `fm-<provider>`,
z. B. `fm-kilo`). Vision-Modelle sind mit einem „vision"-Tag markiert und
akzeptieren Bildanhänge direkt im Chat.

---

## 7. Update auf eine neue Plugin-Version

```powershell
cd Freemodels2dsh
git pull
npm install
npm run pack:plugin
dsh plugin --profile web add C:\Users\<dein-name>\Freemodels2dsh\freemodels2dsh-<neue-version>.tgz
```

Anschließend DSH Desktop wieder vollständig neu starten (Abschnitt 5).
Die Accounts liegen im Credential-Store des Harness, nicht im
Plugin-Ordner, und bleiben bei einem In-place-Upgrade erhalten. Sollte ein
Build das Upgrade verweigern, erst das alte Paket per
`dsh plugin remove freemodels2dsh` entfernen – vorher sicherheitshalber
die API-Keys notieren, da dabei je nach Harness-Version auch die
Plugin-Daten gelöscht werden können.

---

## 8. Deinstallation

```powershell
dsh plugin remove freemodels2dsh
```

Danach DSH Desktop neu starten. Dadurch werden Plugin-Datei und – je nach
Harness-Version – die zugehörigen gespeicherten Accounts/Keys entfernt.

---

## 9. Fehlersuche

| Symptom | Ursache / Lösung |
| --- | --- |
| `dsh` wird nicht erkannt | Das Terminal von DSH Desktop verwenden oder prüfen, ob die DSH-CLI im `PATH` liegt. |
| Installation wird mit Profil-Fehler abgelehnt | Stets `--profile web` verwenden; `desktop` akzeptiert keine externen Plugins. |
| Plugin taucht nach Installation nicht auf | DSH Desktop auch aus dem Tray komplett beenden und neu starten; danach `dsh --profile web --dump-config` prüfen. |
| Keine Modelle im Modell-Picker | Mindestens einen Account **aktivieren**; danach „Fetch available models" bzw. „Update all free model lists" ausführen. |
| `INVALID_CREDENTIAL` (401/403) | API-Key ungültig oder vertippt. Account im Dialog deaktivieren, Key korrigieren und erneut „Test connection". |
| `RATE_LIMIT` (429) | Free-Tier-Limit erreicht. Der Account wird automatisch kurz gesperrt (Cooldown); im On-error-/Round-Robin-Modus übernimmt der nächste Account. |
| `CONFLICT` (409) in den Einstellungen | Ein zweites Fenster hat die Konfiguration geändert. Die Ansicht lädt automatisch neu; dann den Vorgang wiederholen. |
| Cloudflare: `BAD_ACCOUNT_ID` | Es sind genau 32 hexadezimale Zeichen (0–9, a–f) nötig, ohne Leerzeichen. |
| Kilo anonym meldet 429 | Das anonyme Limit (200/Stunde) gilt pro IP und wird in geteilten Netzen schnell erreicht. Kostenlosen Kilo-Key eintragen. |
| `NO_MODELS` beim Modell-Fetch | Der Provider hat seine Free-Aufstellung geändert. „Reset to built-in list" oder später erneut „Update all free model lists" versuchen. |
| Vision-Anfrage schlägt mit `UNSUPPORTED_CONTENT` fehl | Der Harness-Profil fehlt der Attachment-Service oder das Modell ist text-only. Nur mit „vision"-markierten Modellen nutzen. |
| Firewall/Antivirus blockiert Anfragen | Die Provider-Domains (z. B. `api.kilo.ai`, `api.groq.com`, `api.cloudflare.com`) in Firewall/Proxy freigeben. |
| Windows-Pfad mit Leerzeichen | Gesamten Pfad in doppelte Anführungszeichen setzen. |

Aktuelle Kontingente und Einschränkungen pro Provider stehen in den
Free-Tier-Hinweisen innerhalb jedes Provider-Dialogs und im
[README](./README.md#included-providers).

---

## 10. Installations-Checkliste

- [ ] `npm run pack:plugin` erzeugt `freemodels2dsh-<version>.tgz`
- [ ] `dsh plugin --profile web add <absoluter-pfad>.tgz` erfolgreich
- [ ] `dsh --profile web --dump-config` zeigt die `freemodels2dsh`-Schicht
- [ ] DSH Desktop komplett (inkl. Tray) neu gestartet
- [ ] Settings → Plugins → **Free Models** öffnet sich
- [ ] Mindestens ein Account pro gewünschtem Provider aktiviert
      (Kilo geht auch leer/anonym, Cloudflare braucht die Account ID)
- [ ] „Test connection" grün, Modellliste geladen
- [ ] Free-Modell im Chat ausgewählt und Antwort erhalten
