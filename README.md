# freemodels2dsh — Arena-Modelle in DSH Desktop (Windows)

Ein Plugin für **DSH Desktop** (`dataelement/dsh-desktop`, DeepSeek Harness) in der
aktuellen Windows-Version (getestet gegen **DSH Desktop 0.12.1 / Harness
`@deepseek-ai/dsh@0.2.1-rc.2`**). Es macht die Modelle deines Arena-Accounts im
Modellwähler von DSH Desktop nutzbar.

Dafür gibt es zwei Bauformen — gleiches Ziel, unterschiedliche Architektur:

| | **Variante A — Gateway** (dieser Ordner) | **Variante B — native Route** ([`variants/native-route`](variants/native-route)) |
|---|---|---|
| Weg | `DSH → 127.0.0.1:8787 → api.arena.ai` | `DSH → api.arena.ai` (direkt, `llm-pi-ai`) |
| Prozess | eigenes lokales Gateway im Harness | kein Server, kein Port |
| Modellkatalog | live, mit Cache und Fallback | vom Setup-CLI in den Patch geschrieben (`--sync`) |
| Key | bleibt im Gateway-Prozess | aus der Prozessumgebung (`apiKeyEnv`) |
| Extra | Retry/Timeout, Statusseite, optionales lokales Token, Allowlist | minimal, am Harness-Standardpfad |

Variante A ist im Folgenden beschrieben. Kurzfassung: Das Plugin startet im
Harness-Prozess ein **lokales, OpenAI-kompatibles Gateway** auf
`http://127.0.0.1:8787/v1`; DSH spricht es wie jeden anderen OpenAI-Provider an,
das Gateway hängt deinen **Arena-API-Key** an und leitet die Anfrage weiter.

```
DSH Desktop (Windows)
   └─ Harness  ── OpenAI-Protokoll ──▶  127.0.0.1:8787/v1   (dieses Plugin)
                                             │  Key-Injektion, Retry, Timeout,
                                             │  Modellkatalog, Fehlermeldungen
                                             ▼
                                        https://api.arena.ai/v1  (Arena)
```

## Was dieses Plugin *nicht* ist

* **Kein Scraping und kein Bypass.** Es benutzt ausschließlich den offiziellen,
  dokumentierten Arena-API-Zugang (`platform.arena.ai`, Gateway `api.arena.ai/v1`)
  mit **deinem eigenen API-Key**. Es werden keine Cookies, Sitzungen oder
  Web-Oberflächen von arena.ai nachgebaut, kein User-Agent gefälscht und keine
  Ratenbegrenzung umgehen.
  Grund: Die Arena-Nutzungsbedingungen (Stand 2026-02-23, §5) untersagen
  ausdrücklich, „auf die Dienste über programmatische oder automatisierte Mittel
  zuzugreifen oder die Dienste automatisch abzufragen“, ebenso Scraping und
  Crawling. Ein Cookie-/Session-Bridge zur Web-Oberfläche wäre also ein
  ToS-Verstoß (und würde Accounts gefährden) — deshalb gibt es so etwas hier
  bewusst **nicht**, in keiner Variante. Wer Arena-Modelle programmatisch nutzen
  will, braucht einen API-Key über `platform.arena.ai`.
* **Kein kostenloser Zugang ohne Account.** „Kostenlos“ heißt hier: du nutzt die
  Modelle, die dein Arena-Tarif bzw. dein Key freigibt, ohne zusätzliches
  DSH-Modell-Abo. Welche Modelle und Kontingente das sind, entscheidet Arena –
  die Free-Router-Keys sind laut Arena-Doku für interaktive Coding-Clients
  (Claude Code, Claude Desktop „Code“, OpenCode) vorgesehen; bei anderen
  Harnesses kann Arena mit `403` antworten. Dann brauchst du einen Key/Tarif mit
  API-Zugriff (siehe [Fehlerbehebung](#fehlerbehebung)).
* **Nicht offiziell.** Weder von Arena noch von Dataelem/DeepSeek. Marken- und
  Produktnamen gehören ihren Inhabern.

## Voraussetzungen

| Was | Details |
|---|---|
| Betriebssystem | Windows 10/11 (x64), DSH Desktop für Windows |
| DSH Desktop | 0.12.x (ältere Versionen mit Harness ≥ 0.1.7 sollten ebenfalls funktionieren) |
| Arena-Account | API-Key von <https://platform.arena.ai/dashboard/keys> |
| Node.js | **nur** für den Autostart-Modus nötig (≥ 20). Im Plugin-Modus läuft alles in DSH |
| Netzwerk | Ausgehend HTTPS zu `api.arena.ai`; das Gateway selbst lauscht nur auf Loopback |

Das Paket hat **null npm-Abhängigkeiten** – Installation und Update können nichts
„kaputt-auflösen“.

## Schnellstart (empfohlen: Plugin-Modus)

### 1. Key hinterlegen

PowerShell im Projektordner:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

Das Skript fragt den Key verdeckt ab und legt ihn ab als

* Benutzer-Umgebungsvariable `ARENA_API_KEY` (Registry, `HKCU\Environment`), und
* Key-Datei `%LOCALAPPDATA%\freemodels2dsh\arena.key` mit Zugriff nur für dich.

Danach prüft es den Key direkt gegen Arena (`--check`).

Nur den Key setzen (ohne weitere Einrichtung):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\set-arena-key.ps1
```

### 2. Plugin in DSH Desktop installieren

In DSH Desktop: **Einstellungen → Plugins** und dort dieses Paket installieren
(Plugin-Manager, „installieren aus“-Feld):

```
git+https://github.com/jahdaganj04ki-a11y/Freemodels2dsh
```

Alternativ über die Harness-CLI des Desktop-Profils, z. B.:

```
dsh plugin --profile web add git+https://github.com/jahdaganj04ki-a11y/Freemodels2dsh
```

oder aus einem lokalen Ordner:

```
dsh plugin --profile web add file:C:\Pfad\zu\Freemodels2dsh
```

Das Paket bringt `cordis.patch.yml` mit; der Installer trägt damit den Eintrag
`freemodels-arena` in das Profil ein. Nach dem Install **DSH Desktop komplett
beenden und neu starten**.

### 3. Provider in DSH eintragen (einmalig)

**Einstellungen → Modelle → Provider hinzufügen** (englisch: *Settings → Models*):

| Feld | Wert |
|---|---|
| Name / Anzeigename | `Arena` |
| Base-URL | `http://127.0.0.1:8787/v1` |
| API-Key | beliebig, z. B. `local` (das Gateway ignoriert ihn, solange kein lokales Token gesetzt ist) |
| Modelle | Liste laden (Discovery) und z. B. `coding-router-preview` auswählen |

> Warum nicht automatisch? Der Modellkatalog gehört in DSH zu den
> Modell-Einstellungen (eine Autorität, die Harness verwaltet). Das Plugin
> schreibt bewusst nicht in deine Profil-/Modell-Konfiguration hinein. Wer den
> Eintrag deklarativ haben will, findet in
> [`cordis.patch.arena-route.example.yml`](cordis.patch.arena-route.example.yml)
> eine Variante, die die Route direkt in der Profil-Komposition anlegt.

### 4. Prüfen

* Statusseite im Browser: <http://127.0.0.1:8787/> – zeigt Key-Status,
  Modellanzahl und die Basis-URL zum Kopieren.
* Health-Endpunkt: <http://127.0.0.1:8787/health>
* In DSH einen kurzen Prompt senden; bei Problemen steht die Ursache in
  `harness.log` (DSH Desktop: Hilfe/Logs bzw. `%APPDATA%\<DSH-Desktop>\logs\harness.log`).

## Alternative: Autostart-Modus (ohne Plugin)

Falls dein DSH-Build das Plugin nicht akzeptiert, kannst du das Gateway separat
laufen lassen. Es genügt ein beliebiger OpenAI-kompatibler Client.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -Autostart
```

Das legt die geplante Aufgabe **„freemodels2dsh Arena Gateway“** an (Start bei
Anmeldung, versteckt, ohne Adminrechte) und startet sie sofort. Danach wie oben
unter Schritt 3 die Base-URL `http://127.0.0.1:8787/v1` in DSH eintragen.

Manuell, z. B. zum Testen:

```powershell
node bin\arena-gateway.mjs --port 8787
```

Oder per Doppelklick auf `scripts\start-gateway.cmd` (öffnet ein eigenes Fenster).

## Konfiguration

Alles läuft über Umgebungsvariablen (bewusst: kein Key in Dateien, die DSH
versioniert, und kein Konfigurationsschema, das bei Harness-Updates bricht).

| Variable | Standard | Bedeutung |
|---|---|---|
| `ARENA_API_KEY` | – | Arena-Key (Alternative: Key-Datei) |
| `FREEMODELS_KEY_FILE` | s. o. | Pfad zur Key-Datei |
| `ARENA_API_BASE` | `https://api.arena.ai/v1` | Arena-Endpunkt (muss `https` sein; `http` nur für Loopback) |
| `FREEMODELS_GATEWAY_PORT` | `8787` | Loopback-Port; **Base-URL in DSH entsprechend anpassen** |
| `FREEMODELS_GATEWAY_TOKEN` | – | Wenn gesetzt: lokales Bearer-Token, das DSH als API-Key senden muss |
| `FREEMODELS_ARENA_MODELS` | – | Kommaseparierte Modell-Allowlist (z. B. nur bestimmte Modelle) |
| `FREEMODELS_CATALOG_FILE` | neben der Key-Datei | Cache für den Modellkatalog |
| `FREEMODELS_LOG` | `info` | `error`, `warn`, `info`, `debug` |
| `FREEMODELS_DISABLE` | – | `1` schaltet das Plugin im Harness ab, ohne es zu deinstallieren |

Der Key wird **nie** an DSH weitergereicht: DSH sieht nur das lokale Gateway, das
Gateway sieht den Key.

## CLI-Referenz

```text
node bin/arena-gateway.mjs [Optionen]

  --port <n>          Loopback-Port (Standard 8787)
  --api-base <url>    Arena-Base-URL
  --key-file <path>   Key-Datei
  --catalog-file <p>  Katalog-Cache
  --token <secret>    lokales Bearer-Token verlangen
  --models <ids>      Modell-Allowlist (Komma)
  --log-level <l>     error | warn | info | debug
  --check             Key gegen Arena prüfen und Modelle auflisten
  --set-key <key>     Key in die Key-Datei schreiben
  --print-config      Base-URL/Provider-Daten als JSON ausgeben
```

Beispiele:

```powershell
node bin\arena-gateway.mjs --check          # Welche Modelle gibt mein Key frei?
node bin\arena-gateway.mjs --print-config   # Werte für DSH
node bin\arena-gateway.mjs --port 8787 --log-level debug
```

## Fehlerbehebung

| Symptom | Ursache / Lösung |
|---|---|
| DSH: `arena_key_missing` (503) | Key fehlt. `scripts\set-arena-key.ps1` ausführen und **DSH Desktop neu starten** (Umgebungsvariablen werden beim Start gelesen). |
| DSH: 401/403 von Arena | Key ungültig oder darf diesen Client/dieses Modell nicht nutzen. Bei Free-Router-Keys liefert Arena für nicht vorgesehene Harnesses `403 organization_client_restricted` – dann Key/Tarif mit API-Zugriff verwenden. |
| DSH: `model_not_found` | Modell-ID falsch oder durch `FREEMODELS_ARENA_MODELS` gesperrt. `node bin\arena-gateway.mjs --check` zeigt die erlaubten IDs. |
| Modellliste bleibt leer | Kein Netz zu `api.arena.ai` oder Key ohne Modellzugriff. Das Gateway liefert dann den Fallback-Katalog (`coding-router-preview`); `http://127.0.0.1:8787/health` nennt den Grund. |
| `EADDRINUSE` / Port 8787 belegt | Andere Instanz oder fremdes Programm. Beende es oder setze `FREEMODELS_GATEWAY_PORT` **und** die Base-URL in DSH auf denselben Port. Ein zweites Gateway im selben Profil ist nicht nötig. |
| `Arena gateway failed to start` | Details im `harness.log`. Häufig: Port belegt (s. o.) oder Safe Mode aktiv (Plugin blockiert). |
| Plugin erscheint nicht in DSH | Nach dem Install DSH vollständig beenden (auch Tray-Icon) und neu starten. Prüfe **Einstellungen → Plugins**, ob `freemodels-arena` aktiviert ist; im Safe Mode sind Drittanbieter-Plugins absichtlich blockiert. |
| Antworten brechen ab | Timeouts/Abbruch durch Arena. `FREEMODELS_LOG=debug` zeigt Anfrage-IDs; das Gateway wiederholt 429/5xx zweimal. |
| Alles unklar | Statusseite <http://127.0.0.1:8787/> öffnen – sie zeigt Key-Status, Modellkatalog-Quelle und Fehlerzähler. |

## Sicherheit & Datenschutz

* Das Gateway bindet **ausschließlich** an `127.0.0.1` (andere Hosts werden
  abgelehnt, auch per Konfiguration) – kein LAN-, kein Internetzugriff.
* Der Key liegt in der Benutzerumgebung bzw. in einer Datei mit
  benutzerbeschränkten Rechten; er wird in Logs nur maskiert ausgegeben und
  niemals an DSH oder an Dritte weitergegeben.
* Upstream-Aufrufe gehen ausschließlich an die konfigurierte Arena-Base-URL
  (HTTPS erzwungen, außer Loopback).
* Optionales lokales Token (`FREEMODELS_GATEWAY_TOKEN`), falls andere
  Programme auf demselben Benutzerkonto das Gateway nicht mitbenutzen sollen.
* Prompts, Tool-Aufrufe und Antworten laufen wie bei jeder API-Nutzung über
  Arena; es gelten die Bedingungen und Datenrichtlinien von Arena.

## Deinstallation

1. DSH Desktop: **Einstellungen → Plugins** → `freemodels-arena` deinstallieren.
2. Provider `Arena` unter **Einstellungen → Modelle** entfernen.
3. Key und ggf. Autostart entfernen:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -Uninstall
```

4. Optional den Ordner `%LOCALAPPDATA%\freemodels2dsh` löschen.

## Entwicklung

```powershell
node --test "test/*.test.mjs"     # 30 Tests, keine Abhängigkeiten
node bin/arena-gateway.mjs --port 8788 --log-level debug
```

* `lib/gateway.js` – HTTP-Server, OpenAI-Routen, Retry/Timeout/Abbruch
* `lib/catalog.js` – Modellkatalog (Upstream → Cache → Fallback)
* `lib/key-store.js` – Key-Auflösung und -Ablage
* `index.js` – Cordis-Plugin-Hälfte für DSH (startet/stoppt das Gateway)
* `docs/technik.md` – Architektur, geprüfte Verträge, Grenzen
* `variants/native-route/` – Variante B, eigenständiges Paket mit eigenen Tests
  (`cd variants/native-route && node --test "test/*.test.mjs"`)

## Lizenz

MIT – siehe [LICENSE](LICENSE).
