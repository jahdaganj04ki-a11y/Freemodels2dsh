# Variante B — native Route (ohne Gateway)

Zweite, bewusst andere Bauform desselben Ziels: **Arena-Modelle im Modellwähler
von DSH Desktop**, aber ohne lokalen Proxy-Prozess, ohne Port und ohne zweiten
HTTP-Client.

```
Variante A (Repo-Wurzel)          Variante B (dieser Ordner)
─────────────────────────         ────────────────────────────────────────
DSH → 127.0.0.1:8787 → Arena       DSH → api.arena.ai/v1 (llm-pi-ai direkt)
eigenes Plugin mit HTTP-Server    kein Server; nur Route + Credential-Injektion
Katalog-Cache, Retry, Token       Arena-Retry/Timeout kommt vom Harness
Key bleibt im Proxy-Prozess       Key kommt aus der Prozessumgebung (apiKeyEnv)
```

Beide Varianten sind eigenständige Pakete und können **nicht gleichzeitig**
installiert werden (beide melden die Route `arena` an; das Harness lehnt
kollidierende Routen ab).

## Wie es funktioniert

1. `cordis.patch.yml` deklariert eine Route `arena` mit dem Harness-eigenen
   Adapter `@deepseek-ai/dsh-llm-pi-ai`:
   `api: openai-completions`, `baseURL: https://api.arena.ai/v1`,
   `apiKeyEnv: ARENA_API_KEY` und einer Modellliste.
2. Das Plugin (`index.js`) hat genau eine Aufgabe: Es liest den Key aus
   `ARENA_API_KEY` oder der Key-Datei und setzt ihn **in die Prozessumgebung des
   Harness** (`process.env`), weil ein Profil-Plugin nicht darauf vertrauen kann,
   dass die Shell-Umgebungsvariablen der App sichtbar sind. Danach prüft es
   einmalig, ob Arena erreichbar ist, und schreibt das Ergebnis ins `harness.log`.
3. Der Key steht damit **nirgends** in einer Konfiguration: nicht im Patch, nicht
   in den Modell-Einstellungen, nicht in Sessions oder Transkripten.

Das Setup-CLI erzeugt den Patch aus deinem echten Arena-Katalog, damit die
Modellliste (inkl. Kontextfenster und Modalitäten) nicht geraten ist.

## Installation unter Windows

Voraussetzung: DSH Desktop 0.12.x (enthält `@deepseek-ai/dsh-llm-pi-ai`) und ein
Arena-API-Key von <https://platform.arena.ai/dashboard/keys>.

```powershell
cd variants\native-route

# 1. Key speichern, gegen Arena prüfen, Patch erzeugen (alles in einem Schritt)
node bin\arena-setup.mjs

# 2. DSH Desktop vollständig beenden und neu starten

# 3. Kontrolle
node bin\arena-setup.mjs --doctor
```

Ohne Node.js auf dem System: DSH Desktop bringt eine eigene Laufzeit mit, aber
das Setup-CLI ist der bequemste Weg. Alternativ Key per Skript aus Variante A
setzen (`scripts\set-arena-key.ps1`) und den mitgelieferten Patch verwenden — er
enthält bereits den Coding Router.

### Paket in DSH installieren

```
git+https://github.com/jahdaganj04ki-a11y/Freemodels2dsh#variants/native-route
```

bzw. im Plugin-Manager von DSH Desktop auf diesen Unterordner zeigen lassen.
Wichtig: **erst `--sync` laufen lassen, dann installieren** — der Patch, der
installiert wird, ist der, den `--sync` gerade geschrieben hat.

## Befehle

```text
node bin/arena-setup.mjs            interaktiv: Key speichern + prüfen + Patch
node bin/arena-setup.mjs --sync     Katalog neu holen, Patch neu schreiben
node bin/arena-setup.mjs --sync --dry-run   Patch nur anzeigen
node bin/arena-setup.mjs --check    Key prüfen, Modelle auflisten
node bin/arena-setup.mjs --doctor   Diagnose (Patch, Key, Env) ohne Änderungen
```

Weitere Optionen: `--key`, `--key-file`, `--api-base`, `--yes`.

`--sync` nach jedem Arena-Update wiederholen, wenn neue Modelle im Wähler
auftauchen sollen; die Liste ist statisch, weil Harness sie aus der Komposition
liest (keine Discovery im Hintergrund).

## Konfiguration

| Variable | Wirkung |
|---|---|
| `ARENA_API_KEY` | Key direkt (hat Vorrang vor der Key-Datei) |
| `FREEMODELS_KEY_FILE` | anderer Pfad für die Key-Datei |
| `ARENA_API_BASE` | anderer Arena-Endpunkt (nur https; http nur Loopback) |
| `FREEMODELS_DISABLE=1` | Plugin-Hälfte stilllegen (dann fehlt der Key → `MISSING_CREDENTIAL`) |

Fehlt der Key, antwortet die Route mit dem Harness-Fehler `MISSING_CREDENTIAL`;
`harness.log` enthält dann den Hinweis, wo der Key erwartet wird.

## Fehlerbehebung

| Symptom | Ursache / Lösung |
|---|---|
| `arena` fehlt im Modellwähler | Patch nicht installiert oder DSH nicht neu gestartet. `--doctor` prüfen, dann **Einstellungen → Plugins** kontrollieren. |
| `MISSING_CREDENTIAL` | Key fehlt in Umgebung *und* Key-Datei, oder `FREEMODELS_DISABLE=1`. `node bin\arena-setup.mjs` erneut ausführen. |
| 401/403 von Arena | Key ungültig oder Client nicht erlaubt. **Free-Router-Keys** sind laut Arena-Doku auf Claude Code, die Code-Ansicht von Claude Desktop und OpenCode beschränkt; andere Harnesses erhalten `403 free_router_harness_restricted`. Für DSH braucht es einen Key/Tarif mit API-Zugriff. |
| Neue Modelle fehlen | `node bin\arena-setup.mjs --sync`, DSH neu starten. |
| Routenkollision beim Start | Variante A ist noch installiert (oder eine andere `arena`-Route). Eine der beiden entfernen. |
| `llm-pi-ai` nicht gefunden | Älteres DSH/Harness ohne `@deepseek-ai/dsh-llm-pi-ai`. Dann Variante A (Gateway) verwenden. |

## Grenzen dieser Variante

* **Statische Modellliste** — kein Live-Katalog im Wähler; `--sync` ist der Preis
  für die Einfachheit.
* **Abhängig von `llm-pi-ai`** und dessen Konfigurationsschema (`providers`).
  Ändert Harness dieses Schema, muss der Patch angepasst werden — bei Variante A
  betrifft ein solches Update nur den Provider-Eintrag, den DSH selbst verwaltet.
* **Kein lokales Token, keine Allowlist, kein Cache, keine Gateway-Statusseite.**
  Wer das braucht (z. B. um den Key von anderen Programmen fernzuhalten), nimmt
  Variante A.
* **Key in der Prozessumgebung** des Harness: für andere Plugins im selben Profil
  technisch sichtbar. Variante A isoliert den Key besser.

## Tests

```powershell
node --test "test/*.test.mjs"     # 26 Tests, keine Abhängigkeiten
```

Abgedeckt: Key-Auflösung (Env/Datei/Fehlerfälle/Rechte), YAML-Generierung
(Quoting, Kapazitäten, Modalitäten, Ablehnung leerer Kataloge), Patch-Parsing,
Katalog-Normalisierung, `sync` (schreiben/dry-run/Ablehnung), `doctor`
(Zustände und Warnungen) sowie die Plugin-Hälfte (Key-Injektion, Maskierung,
Verhalten ohne Key, `FREEMODELS_DISABLE`, Probe-Warnung).
