import QtQuick
import Quickshell
import Quickshell.Io
import "UpdateChecker.js" as Checker

// Omarchy Plugin Updates - verified-only notifier.
// Trust model: marketplace metadata is a recommendation, never a cryptographic
// anchor. Only verificationStatus === "verified" produces notifications.
// Never runs git pull / --yes / modifies plugins. User confirms via
// Omarchy's native updater (git fetch + diff + validate + rollback).
Item {
    id: root

    // Injected by shell
    property var shell: null
    property var manifest: null
    property string omarchyPath: Quickshell.env("OMARCHY_PATH") || ""

    // Single config constant - switch to https://omarchyplugins.com/catalog.json later.
    property string catalogUrl: "https://raw.githubusercontent.com/HANCORE-linux/omarchy-plugin-marketplace/main/site/catalog.json"

    // Home/plugins dir for manifest fallback (fallback only, not authoritative)
    readonly property string home: Quickshell.env("HOME") || ""
    readonly property string userPluginsDir: home + "/.config/omarchy/plugins"

    // Persistent notification state: { "<plugin-id>": "<verifiedVersion>" }
    // Means we have already notified for that version. Replace object on write
    // so PersistentProperties binding sees a new reference (correction 5).
    PersistentProperties {
        id: persisted
        reloadableId: "oma-plugin-updates"
        property var notifiedVersions: ({})
        property double lastCheckMs: 0
    }

    // Backoff state (section 10)
    property int backoffIndex: 0
    readonly property var backoffMs: [5 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000]
    readonly property int periodicMs: 12 * 60 * 60 * 1000   // 12 hours
    readonly property int startupDelayMs: 60 * 1000         // 60 seconds
    // Poll handles wall-clock jumps (sleep/suspend). QML Timer pauses during
    // suspend, so a 12h single-shot would fire late. Polling Date.now() against
    // persisted lastCheckMs catches up within one interval after resume.
    readonly property int pollMs: 60 * 1000                 // 1 minute

    // Discovery + catalog staging
    property var installedIds: []
    property var installedPlugins: []
    property var catalogData: null
    property bool catalogFetchFailed: false
    property string lastError: ""
    // Exposed to bar widget via bar.shell.serviceFor("oma.plugin-updates")
    property var pendingUpdates: []
    property bool checking: false
    property bool manualCheckRequested: false

    function log(msg) {
        console.log("[omarchy.plugin-updates] " + msg)
    }

    function nextBackoffMs() {
        var idx = Math.max(0, Math.min(backoffIndex, root.backoffMs.length - 1))
        return root.backoffMs[idx]
    }

    function markNotified(id, version) {
        var prev = persisted.notifiedVersions && typeof persisted.notifiedVersions === "object" ? persisted.notifiedVersions : {}
        var next = {}
        for (var k in prev) {
            if (Object.prototype.hasOwnProperty.call(prev, k)) next[k] = String(prev[k])
        }
        next[String(id)] = String(version)
        persisted.notifiedVersions = next
    }

    function clearNotified(id) {
        var prev = persisted.notifiedVersions && typeof persisted.notifiedVersions === "object" ? persisted.notifiedVersions : {}
        if (!Object.prototype.hasOwnProperty.call(prev, String(id))) return
        var next = {}
        for (var k in prev) {
            if (Object.prototype.hasOwnProperty.call(prev, k)) next[k] = String(prev[k])
        }
        delete next[String(id)]
        persisted.notifiedVersions = next
    }

    function shouldNotifyFor(update) {
        var map = persisted.notifiedVersions && typeof persisted.notifiedVersions === "object" ? persisted.notifiedVersions : {}
        return String(map[update.id] || "") !== String(update.verifiedVersion)
    }

    // Notification via Omarchy's native mechanism.
    // Shows which plugin has an update and the exact command to run.
    // Single action "Review Update" still launches updater WITHOUT --yes.
    // Execution chain: notification click -> floating terminal -> omarchy plugin update <id>
    // -> Omarchy shows diff -> USER CONFIRMS -> plugin changed. No silent install.
    function notifyUpdate(update) {
        if (notifyProc.running) {
            // Queue is not needed for v1 - periodic check will retry. Drop to avoid overlap.
            log("notify busy, deferring " + update.id)
            return
        }
        var displayName = update.name && update.name !== update.id ? update.name + " (" + update.id + ")" : update.id
        var title = displayName + " has an update"
        var desc = "Run: omarchy plugin update " + update.id + "  (" + update.installedVersion + " → " + update.verifiedVersion + ")"
        // Use glyph from Omarchy notification set; fallback to generic if missing.
        var execCmd = "omarchy-launch-floating-terminal-with-presentation omarchy plugin update " + update.id
        // --exec is the single v1 action. View Plugin is deferred to v2 (multi-action support).
        notifyProc.command = [
            "omarchy", "notification", "send",
            "--exec", execCmd,
            "-g", "󰚰",
            "-u", "normal",
            title, desc
        ]
        notifyProc.running = true
        log("notify: " + update.id + " " + update.installedVersion + " -> " + update.verifiedVersion)
    }

    function notifyUpToDate() {
        if (notifyProc.running) {
            log("notify up-to-date busy, skipping")
            return
        }
        // Manual check feedback — background periodic checks stay silent
        notifyProc.command = [
            "omarchy", "notification", "send",
            "-g", "󰄬",
            "-u", "low",
            "No Updates Are Available.",
            "All verified plugins are up to date."
        ]
        notifyProc.running = true
        log("notify: up to date")
    }

    function schedulePeriodic() {
        checking = false
        backoffIndex = 0
        persisted.lastCheckMs = Date.now()
        periodicTimer.interval = root.periodicMs
        periodicTimer.restart()
        log("next check in " + (root.periodicMs / 3600000) + "h")
    }

    function scheduleBackoff() {
        checking = false
        manualCheckRequested = false
        var ms = nextBackoffMs()
        backoffIndex = Math.min(backoffIndex + 1, root.backoffMs.length - 1)
        backoffTimer.interval = ms
        backoffTimer.restart()
        log("catalog fetch failed, retry in " + (ms / 60000) + "m (attempt " + backoffIndex + ")")
    }

    function maybeCatchUpAfterResume() {
        if (listProc.running || manifestProc.running || catalogProc.running) return
        if (backoffTimer.running) return
        var last = Number(persisted.lastCheckMs || 0)
        if (last === 0) return // not yet checked once, let startupTimer handle it
        var elapsed = Date.now() - last
        if (elapsed >= root.periodicMs) {
            log("catch-up: " + Math.round(elapsed / 3600000 * 10) / 10 + "h since last check, running now (resume/lid-open)")
            startCheck()
        }
    }

    function handleCatalogSuccess() {
        catalogFetchFailed = false
        backoffIndex = 0
        checking = false
        var wasManual = manualCheckRequested
        manualCheckRequested = false
        log("handleCatalogSuccess wasManual=" + wasManual + " installed=" + installedPlugins.length)
        if (installedPlugins.length === 0 && installedIds.length === 0) {
            // No installed plugins to compare - just schedule next.
            pendingUpdates = []
            if (wasManual) notifyUpToDate()
            schedulePeriodic()
            return
        }
        var updates = []
        try {
            updates = Checker.findUpdates(installedPlugins, catalogData)
        } catch (e) {
            log("findUpdates error: " + e)
            pendingUpdates = []
            if (wasManual) notifyUpToDate()
            schedulePeriodic()
            return
        }
        // Expose to bar widget
        pendingUpdates = updates

        // Filter by already-notified + clear stale entries where installed==verified
        // (user updated via Omarchy's updater, which we don't claim succeeded).
        var notifiedMap = persisted.notifiedVersions && typeof persisted.notifiedVersions === "object" ? persisted.notifiedVersions : {}
        // Clear entries where installed now equals verified (user updated) or no longer needs update
        // This avoids re-notifying same version after update and allows future versions.
        var updatesById = {}
        for (var i = 0; i < updates.length; i++) updatesById[updates[i].id] = updates[i]
        for (var knownId in notifiedMap) {
            if (!Object.prototype.hasOwnProperty.call(notifiedMap, knownId)) continue
            // If this id is not in updates anymore, it means installed >= verified or missing - clear
            if (!updatesById[knownId]) {
                // Check if installed still exists but caught up, or plugin removed - clear to allow future
                // Only clear if we can confirm installed version equals notified version or plugin gone
                // Simpler: clear if not in updates (no longer needs notify). This matches spec:
                // 1.4.0->1.5.0 notified, after update 1.5.0==1.5.0 no update, so clear old state.
                clearNotified(knownId)
            }
        }

        var toNotify = []
        for (var j = 0; j < updates.length; j++) {
            if (shouldNotifyFor(updates[j])) toNotify.push(updates[j])
        }

        if (toNotify.length === 0) {
            log("no new verified updates wasManual=" + wasManual)
            if (wasManual) notifyUpToDate()
            schedulePeriodic()
            return
        }

        for (var k = 0; k < toNotify.length; k++) {
            notifyUpdate(toNotify[k])
            markNotified(toNotify[k].id, toNotify[k].verifiedVersion)
        }
        schedulePeriodic()
    }

    // IPC for bar widget manual check (waybar-style manual trigger)
    IpcHandler {
        target: "oma.plugin-updates"
        function check(payload: string): string {
            manualCheckRequested = true
            root.startCheck()
            return "ok"
        }
        function status(payload: string): string {
            return JSON.stringify({
                checking: root.checking,
                pending: root.pendingUpdates,
                lastCheckMs: persisted.lastCheckMs,
                notified: persisted.notifiedVersions
            })
        }
    }

    function startCheck() {
        if (listProc.running || manifestProc.running || catalogProc.running) {
            log("check already in flight, skipping")
            return
        }
        checking = true
        catalogData = null
        catalogFetchFailed = false
        installedIds = []
        installedPlugins = []
        lastError = ""
        log("checking for verified plugin updates...")

        // Authoritative discovery: use PluginRegistry/CLI as source of truth for ids.
        // Manifest read is fallback for version (not directory scan as enumeration).
        var listCmd = "omarchy-shell shell listPlugins 2>/dev/null || omarchy plugin list --json 2>/dev/null"
        listProc.command = ["bash", "-c", listCmd]
        listProc.running = true
    }

    // --- Timers ---

    Timer {
        id: startupTimer
        interval: root.startupDelayMs
        running: true
        repeat: false
        onTriggered: root.startCheck()
    }

    Timer {
        id: periodicTimer
        interval: root.periodicMs
        repeat: false
        onTriggered: root.startCheck()
    }

    Timer {
        id: backoffTimer
        interval: root.backoffMs[0]
        repeat: false
        onTriggered: root.startCheck()
    }

    // Wall-clock poll: handles sleep/lid-close where QML Timer is paused.
    // Cheap Date.now() check, no Process spawned unless overdue.
    Timer {
        id: pollTimer
        interval: root.pollMs
        running: true
        repeat: true
        onTriggered: root.maybeCatchUpAfterResume()
    }

    // --- Processes ---

    // 1. List installed plugins (authoritative ids)
    Process {
        id: listProc
        stdout: StdioCollector { id: listOut; waitForEnd: true }
        stderr: StdioCollector { id: listErr; waitForEnd: true }
        onExited: function(exitCode) {
            if (exitCode !== 0) {
                var err = String(listErr.text || "").trim()
                root.log("listPlugins failed: " + err)
                // Fallback: try direct filesystem enumeration as last resort, but prefer to backoff silently
                // For v1, treat list failure as transient - schedule backoff, do not notify user
                root.scheduleBackoff()
                return
            }
            var raw = String(listOut.text || "").trim()
            if (!raw) {
                root.log("listPlugins empty")
                root.installedIds = []
                root.installedPlugins = []
                // Still fetch catalog - will result in no updates
                catalogProc.command = ["curl", "-fsS", "--max-time", "10", root.catalogUrl]
                catalogProc.running = true
                return
            }
            try {
                var data = JSON.parse(raw)
                if (!Array.isArray(data)) data = []
                var ids = []
                for (var i = 0; i < data.length; i++) {
                    var pid = data[i] && data[i].id ? String(data[i].id).trim() : ""
                    if (pid) ids.push(pid)
                }
                root.installedIds = ids
                if (ids.length === 0) {
                    root.installedPlugins = []
                    catalogProc.command = ["curl", "-fsS", "--max-time", "10", root.catalogUrl]
                    catalogProc.running = true
                    return
                }
                // Use python directly to avoid bash quoting/escaping issues (previous bash loop had syntax errors).
                // Authoritative ids -> read manifest versions via python, no shell loop.
                var pyCode = "import json,sys,os; ids=sys.argv[1:]; out=[]; h=os.path.expanduser('~');\n"
                pyCode += "import json as _j\n"
                pyCode += "for i in ids:\n"
                pyCode += " p=os.path.join(h,'.config/omarchy/plugins',i,'manifest.json')\n"
                pyCode += " if os.path.exists(p):\n"
                pyCode += "  try:\n"
                pyCode += "   v=_j.load(open(p)).get('version','')\n"
                pyCode += "   out.append({'id':i,'version':str(v)})\n"
                pyCode += "  except: pass\n"
                pyCode += "print(_j.dumps(out))\n"
                var cmd = ["python3", "-c", pyCode, "--"]
                for (var k = 0; k < ids.length; k++) cmd.push(ids[k])
                log("manifest check for " + ids.length + " ids via python")
                manifestProc.command = cmd
                manifestProc.running = true
            } catch (e) {
                root.log("listPlugins parse failed: " + e + " raw: " + raw.slice(0, 200))
                root.scheduleBackoff()
            }
        }
    }

    // 2. Collect manifest versions for authoritative ids
    Process {
        id: manifestProc
        stdout: StdioCollector { id: manifestOut; waitForEnd: true }
        stderr: StdioCollector { id: manifestErr; waitForEnd: true }
        onExited: function(exitCode) {
            if (exitCode !== 0) {
                root.log("manifest read failed: " + String(manifestErr.text || "").trim().slice(0, 300))
                // Proceed with empty installedPlugins - will yield no updates, but still try catalog
                root.installedPlugins = []
            } else {
                var raw = String(manifestOut.text || "").trim()
                try {
                    var parsed = raw ? JSON.parse(raw) : []
                    if (!Array.isArray(parsed)) parsed = []
                    root.installedPlugins = parsed
                } catch (e) {
                    root.log("manifest parse failed: " + e)
                    root.installedPlugins = []
                }
            }
            // 3. Fetch catalog (Process + curl, section 3-4)
            catalogProc.command = ["curl", "-fsS", "--max-time", "10", root.catalogUrl]
            catalogProc.running = true
        }
    }

    // 3. Fetch marketplace catalog
    Process {
        id: catalogProc
        stdout: StdioCollector { id: catalogOut; waitForEnd: true }
        stderr: StdioCollector { id: catalogErr; waitForEnd: true }
        onExited: function(exitCode) {
            if (exitCode !== 0) {
                var err = String(catalogErr.text || "").trim().slice(0, 500)
                root.log("catalog fetch failed: " + err)
                // Network failure should never generate user notification, just retry with backoff
                root.scheduleBackoff()
                return
            }
            var raw = String(catalogOut.text || "").trim()
            if (!raw) {
                root.log("catalog empty")
                root.scheduleBackoff()
                return
            }
            try {
                var parsed = JSON.parse(raw)
                root.catalogData = parsed
                root.handleCatalogSuccess()
            } catch (e) {
                root.log("catalog JSON parse failed: " + e)
                root.scheduleBackoff()
            }
        }
    }

    // 4. Notification sender
    Process {
        id: notifyProc
    }
}
