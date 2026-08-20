# Oma Plugin Updates (`oma.plugin-updates`)

Standalone Omarchy `service` plugin that checks the Omarchy Plugin Marketplace for newer **verified** plugin versions and notifies the user. It **never silently installs an update**.

> **Note on id:** Spec proposes `omarchy.plugin-updates` but `omarchy.*` is reserved (`omarchy-plugin-validate: uses the reserved omarchy.* namespace`). V1 ships as `oma.plugin-updates` (`reloadableId` `oma-plugin-updates`). Rename requires Omarchy allowlisting.

## Architecture

```
Marketplace ──catalog.json──> UpdateChecker.js ──verified updates──> Service.qml
   (verificationStatus=verified, version, verificationCommit)          │
                                                              PersistentProperties
                                                                      │
                                                              Desktop Notification
                                                                      │
                                                              [ Review Update ] ──> omarchy plugin update <id>
                                                                                  (git fetch + diff + user confirm + validate/rollback)
```

## Trust Model

**DOES:**
- Use only `verificationStatus === "verified"` entries
- Normalize catalog via `normalizeCatalog()` to internal `{id,version,commit,repo,name}`
- Compare with strict SemVer (fixed regex, prerelease numeric ordering)
- Persist `notifiedVersions` map, notify once per `id@verifiedVersion`
- Defer install to Omarchy updater, no `--yes`, require human confirmation

**DOES NOT:**
- `git pull` / `checkout` / modify plugins
- Use `--yes` or trust `main` / HTTPS as signing
- Notify about unverified or newer-than-verified versions
- Auto-install

Future v2: `catalog.json.sig` + embedded public key.

## Plugin Discovery (Correction 2)

Authoritative ids via `omarchy-shell shell listPlugins` / `omarchy plugin list --json`. Manifest version is **fallback** (`~/.config/omarchy/plugins/<id>/manifest.json` + `$OMARCHY_PATH` fallbacks), not enumeration. Handles symlinked/bundled/first-party via same fallback.

Filtering in `findUpdates()` is explicit (Correction 3):
```
not in marketplace → ignore
unverified → ignore
verified → semver compare
```

## SemVer (Correction 1)

Regex: `/^v?(?:0|[1-9]\d*)\.\d+\.\d+(?:-...)?(?:\+...)?$/` (alternation grouped). `compareSemver` implements full ordering `1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-beta < 1.0.0` with numeric prerelease identifiers compared numerically.

## Notification (Correction 4)

Single action v1: `omarchy notification send --exec "omarchy-launch-floating-terminal-with-presentation omarchy plugin update <id>"`. Click executes **updater launch**, not silent install. Updater shows diff and asks confirmation.

## Persistence (Correction 5)

`PersistentProperties` replace-object, not mutate:
```js
const next = Object.assign({}, persisted.notifiedVersions)
next[id] = version
persisted.notifiedVersions = next
```

## Timings

- Startup: ~60s delay
- Periodic: 12h after success
- Backoff on catalog failure: 5m → 15m → 30m → 60m, reset on success. No error notification.

## Structure

```
oma.plugin-updates/
├── manifest.json
├── service/Service.qml
├── service/UpdateChecker.js  (.pragma library, pure, Node-testable)
├── tests/UpdateCheckerTest.js
└── tests/run.sh
```

## Install / Validate

```bash
omarchy plugin validate ./   # must pass
omarchy plugin add <repo-url>  # git checkout into ~/.config/omarchy/plugins/oma.plugin-updates
omarchy plugin enable oma.plugin-updates
omarchy-shell shell rescanPlugins
```

Catalog URL is fixed `property string catalogUrl` in `Service.qml` (GitHub raw v1, trivial switch to `https://omarchyplugins.com/catalog.json`).

## Tests

```bash
./tests/run.sh          # node --test
node --test tests/UpdateCheckerTest.js
```

Covers versions, catalog, notification dedup, backoff. 30 tests.

## Marketplace Schema

Lock confirmed via live `site/catalog.json` (694 entries, 359 verified):
- `id`, `version`, `verificationStatus`, `verificationCommit`, `repo`, `name`
- Normalized to internal `status/commit`. `verificationBaselineVersion` is schema version, not semver.

## Decisions

| Question | Decision |
|---|---|
| Plugin ID | `oma.plugin-updates` (spec `omarchy.plugin-updates` reserved) |
| Repo | `omarchy-plugin-updates` |
| Notification | Single Review Update v1 |
| Discovery | IPC authoritative + manifest fallback |
| Fetch | `Process` + `curl` |
| catalogUrl | Fixed property |
| Signed catalog | v2 |
