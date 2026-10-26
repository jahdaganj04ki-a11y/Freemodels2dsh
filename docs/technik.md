# Technische Notizen

Warum dieses Plugin so aussieht, welche Verträge geprüft wurden und wo die
Grenzen liegen.

## 1. Anbindung an Arena

Arena betreibt zwei getrennte Oberflächen:

| Oberfläche | Zweck | Für dieses Plugin relevant |
|---|---|---|
| `arena.ai` | Web-Chat, Modelle direkt ausprobieren | **nein** – kein automatisierter Zugriff, keine Session-/Cookie-Nutzung |
| `platform.arena.ai` + `api.arena.ai/v1` | offizieller API-Zugang mit API-Key | **ja** |

Für `api.arena.ai` dokumentiert Arena selbst eine OpenAI-kompatible Basis-URL
(`https://api.arena.ai/v1`, Beispielkonfiguration u. a. für OpenCode über
`@ai-sdk/openai-compatible`) sowie einen Anthropic-kompatiblen Gateway-Modus für
Claude Code. Genau diese OpenAI-Kompatibilität nutzt das Gateway: DSH spricht
`GET /v1/models` und `POST /v1/chat/completions` (streaming und nicht-streaming),
das sind die Schnittstellen, die jeder OpenAI-Provider in DSH erwartet.

Rechtlicher Rahmen: die Arena-Nutzungsbedingungen (Fassung 2026-02-23) verbieten
in §5 (vi)/(vii) den programmatischen/automatisierten Zugriff auf den Dienst sowie
Scraping und Crawling. Deshalb gibt es in diesem Repository **keine** Anbindung an
die Web-Oberfläche (Cookies, Session-Tokens, reCAPTCHA-Beschaffung, Browser-
Automatisierung). Beide Varianten sprechen ausschließlich `api.arena.ai` mit einem
eigenen Key an.

Konsequenzen, die bewusst so gewählt sind:

* Beim Weiterleiten wird **kein** Client-Header gefälscht (kein Claude-Code-
  User-Agent o. ä.). Der `user-agent` ist ehrlich
  `dsh-freemodels-arena/<version>`. Wenn Arena einen Client nicht zulässt,
  bekommt der Nutzer eine klare Fehlermeldung statt eines stillen Bypasses.
* Es gibt keinen Zugriff auf Arena-Websitzungen, keine Captcha-Token-Beschaffung,
  keine geteilten Accounts, keinen Token-Pool.
* Free-Router-Keys sind laut Arena-Doku für interaktive Claude-Code-Sessions,
  die Code-Ansicht von Claude Desktop und OpenCode gedacht; andere Harnesses können
  mit `403 organization_client_restricted` abgelehnt werden. Das Plugin macht
  das sichtbar (`hint` in der Fehlerantwort) statt es zu umgehen.

## 2. Warum ein lokales Gateway und nicht direkt `api.arena.ai`?

DSH kann einen OpenAI-kompatiblen Provider direkt ansprechen; man könnte also
die Base-URL `https://api.arena.ai/v1` und den Key direkt in den
Modell-Einstellungen eintragen. Das Gateway dazwischen bringt:

1. **Key-Isolation.** Der Key liegt nur im Gateway-Prozess (Umgebungsvariable
   bzw. Datei mit Benutzerrechten) und damit nicht in DSH-Profilen, Sessions,
   Transkripten oder Support-Bundles.
2. **Robuster Modellkatalog.** `/v1/models` wird normalisiert (Feldnamen
   variieren zwischen OpenAI, AI-SDK, LiteLLM und Arena) und über einen
   Datei-Cache plus eingebauten Fallback bedient. Eine kurze Netzstörung macht
   den Modellwähler nicht leer.
3. **Betriebsverhalten an einer Stelle.** Retry mit `Retry-After` für
   408/425/429/5xx, Gesamt-Timeout, Abbruch bei Client-Disconnect, Request-IDs und
   lesbare Fehler (`{error:{message,type,code,hint}}`) – geloggt im selben
   `harness.log` wie der Rest des Harness.
4. **Optionale Härtung.** Lokales Bearer-Token und Modell-Allowlist, ohne
   DSH-Konfiguration anzufassen.

## 3. Geprüfte DSH-Verträge

Recherchiert am 26.10.2026 gegen `dataelement/dsh-desktop@main` (v0.12.1,
Harness `0.2.1-rc.2`) und die npm-Pakete `@deepseek-ai/dsh-llm-pi-ai@0.2.1-rc.2`
sowie `@deepseek-ai/dsh-image-generation` als Referenz-Plugin.

**Plugin-Paketform** (aus `packages/dsh-image-generation/package.json`):
`type: module`, `main`, `exports` inkl. `./client` (nur bei eigener UI) und
`./cordis.patch.yml`, `files`, `peerDependencies` auf `@deepseek-ai/cordis` und
die genutzten Harness-Dienste, sowie:

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

**Patch-Datei** (`cordis.patch.yml`) ist eine Liste mit `- insert:` und Einträgen
aus `id`/`name` (optional `config`). Sie wird beim Install in die
Profil-Komposition übernommen.

**Host-Hälfte**: Cordis-Plugin mit benannten Exporten `name` / `apply(ctx)`
(optional `inject`, `Config`). Dieses Plugin nutzt nur `ctx.logger` und
`ctx.effect` und deklariert **keine** `inject`-Abhängigkeiten und **kein**
`Config`-Schema. Grund: Damit bleibt es unabhängig von Harness-internen Diensten
und von Schemaversionen; alle Einstellungen kommen aus Umgebungsvariablen.

**Modell-Provider**: DSH konfiguriert Modelle über das Paket
`@deepseek-ai/dsh-llm-pi-ai` (`providers`-Dict, pro Route u. a. `api`,
`baseURL`, `apiKeyEnv`, `models`, `compat`), das OpenAI-kompatible Endpunkte
über `api: openai-completions` bedient. Die optionalen Beispieldatei
`cordis.patch.arena-route.example.yml` nutzt exakt dieses Format.

**Wichtig**: Das Standard-Plugin schreibt **nicht** in die Modell-Einstellungen.
DSH Desktop führt dafür eigene, gepatchte Settings-Oberflächen und eine
Preflight-/Recovery-Logik; ein fremdes Plugin, das dort hineinschreibt, würde
gegen die „eine Autorität“-Regel der App verstoßen (siehe `docs/architecture.md`
im DSH-Repo). Deshalb: Provider einmalig in der UI anlegen – oder die
deklarative Variante bewusst selbst wählen.

## 4. Request-Fluss

```
POST /v1/chat/completions
  ├─ lokales Token prüfen (falls FREEMODELS_GATEWAY_TOKEN gesetzt)
  ├─ Body lesen (Limit 32 MiB), JSON prüfen, model prüfen (Allowlist)
  ├─ Upstream: POST {ARENA_API_BASE}/chat/completions
  │    Header: authorization: Bearer <arena-key>, content-type: application/json,
  │            accept: text/event-stream | application/json,
  │            user-agent: dsh-freemodels-arena/<version>
  │    Retry: 408/425/429/5xx, max. 2 Versuche, Retry-After beachtet
  ├─ streaming (text/event-stream): Bytes werden unverändert durchgereicht
  └─ nicht-streaming: JSON wird unverändert zurückgegeben (Limit 32 MiB)
```

Fehlerpfade:

| Fall | Antwort |
|---|---|
| kein Key | `503 arena_key_missing` + Hinweis, wo der Key hingehört |
| Arena nicht erreichbar | `502 upstream_unreachable` |
| Timeout (Standard 180 s) | `504 upstream_timeout` |
| Client trennt | Upstream-Abbruch, `499 client_closed_request` (nur Log) |
| Arena 401/403/404/429/5xx | Status wird übernommen, Body normalisiert, `hint` ergänzt |
| falsches Modell | `404 model_not_found` bzw. `400 model_required` |
| kaputtes JSON | `400 invalid_json` |

GET `/v1/models` liefert `{object:"list",data:[{id,object,created,owned_by,name,context_window,max_completion_tokens,input_modalities}]}`.
`?refresh=1` erzwingt einen Upstream-Abruf.

## 5. Sicherheitsmodell

* Bindung ausschließlich an `127.0.0.1`/`::1`; `createArenaGateway` wirft bei
  jedem anderen Host (auch wenn jemand `FREEMODELS_GATEWAY_HOST` manipuliert).
* Upstream muss `https:` sein; `http:` ist nur für Loopback-Ersatzserver
  (Tests, lokale Proxies) erlaubt.
* Key-Format wird geprüft (keine Whitespaces/Steuerzeichen), `Bearer `-Präfixe
  werden entfernt; in Logs und `/health` erscheint nur eine Maske (`abcd…wxyz`).
* Key-Datei: `0o600` bzw. `icacls`-Beschränkung auf den Benutzer (Installer).
* Request-Größenlimits und Fehlertext-Limits verhindern, dass eine kaputte
  Antwort den Harness-Speicher flutet.
* Der Statusseiten-HTML-Code setzt eine restriktive CSP und escapt alle Werte.

## 6. Bekannte Grenzen

* **Tool-Calls/Reasoning** werden durchgereicht, aber nicht umgeschrieben. Was
  Arena über `openai-completions` liefert, bekommt DSH unverändert; exotische
  Reasoning-Formate einzelner Modelle können im DSH-Picker als „ohne
  Reasoning“ erscheinen, bis Arena sie OpenAI-kompatibel ausliefert.
* **Kein Bild-Upload-Konvertieren**: `image_url`-Teile werden unverändert
  weitergegeben; ob ein Modell Bilder akzeptiert, sagt der Katalog
  (`input_modalities`), notfalls die Fehlermeldung von Arena.
* **Kein automatischer Modellkatalog in der deklarativen Route**: Die
  Beispieldatei enthält eine statische Liste; die UI-Variante nutzt Discovery.
* **Kein Support für `/v1/embeddings`, `/v1/responses` oder Anthropic
  `/v1/messages`**: DSH braucht für Chat nur `chat/completions`.
* **Windows-Skripte** sind ohne PowerShell-Laufzeit in dieser Umgebung
  entstanden; sie sind defensiv geschrieben (nur PS 5.1-Syntax), aber bitte
  Fehlermeldungen melden, falls ein Cmdlet bei dir anders heißt.

## 7. Variante B (native Route)

`variants/native-route/` ist ein eigenständiges Paket mit anderer Architektur:

* keine eigene HTTP-Schicht; die Route wird deklarativ über
  `@deepseek-ai/dsh-llm-pi-ai` (`api: openai-completions`,
  `baseURL: https://api.arena.ai/v1`, `apiKeyEnv: ARENA_API_KEY`) in
  `cordis.patch.yml` angelegt,
* das Setup-CLI (`bin/arena-setup.mjs`) holt den Katalog und **generiert** den
  Patch (`lib/patch.js` → `renderRoutePatch`), statt ihn von Hand zu pflegen,
* die Plugin-Hälfte injiziert den Key in die Prozessumgebung des Harness
  (nötig, weil ein Profil-Plugin nicht auf die Shell-Umgebung der App zählen
  kann) und protokolliert eine einmalige Erreichbarkeitsprüfung,
* Retry/Timeout/Kompression liegen beim Harness, nicht bei uns.

Damit entfallen Statusseite, lokales Token, Allowlist und Katalog-Cache; dafür
gibt es keinen zusätzlichen Port und keinen zweiten Netzwerkpfad. Die Modellliste
ist statisch und wird mit `--sync` aktualisiert. Beide Varianten melden dieselbe
Route `arena` an und sind daher nicht parallel installierbar.

## 8. Testabdeckung

`node --test "test/*.test.mjs"` (30 Tests) deckt ab: Modell-Normalisierung (mehrere
Feldnamen), Katalog-Reihenfolge Upstream → Cache (TTL, Ablauf) → Fallback,
Key-Auflösung (Env vor Datei, Fehlerfälle, Rechte), Chat-Weiterleitung inkl.
Key-Injektion und UA, Streaming-Passthrough, Retry bei 429, Auth-Fehler ohne
Key-Leak, lokales Token, Allowlist, Fehlerformen, Loopback-/HTTPS-Erzwingung und
Trailing-Slash-Toleranz.
