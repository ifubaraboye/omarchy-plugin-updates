import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// Bar widget for oma.plugin-updates
// Always visible - allows manual "check for updates" (waybar-style)
// Shows accent/urgent color when verified updates are pending, normal otherwise.
// Click: if updates pending -> review first pending; else -> trigger manual check.
// The service owns the catalog fetch; this widget is a view onto it plus a manual trigger.
BarWidget {
    id: root
    moduleName: "oma.plugin-updates"

    // Engine is the single service instance (see oma.nearby/Panel.qml pattern)
    readonly property var engine: bar && bar.shell && typeof bar.shell.serviceFor === "function"
        ? bar.shell.serviceFor("oma.plugin-updates")
        : null

    readonly property bool engineChecking: engine ? !!engine.checking : false
    readonly property var pending: engine && engine.pendingUpdates ? engine.pendingUpdates : []
    readonly property bool hasUpdates: pending.length > 0
    readonly property bool checking: engineChecking || checkProc.running
    readonly property int pendingCount: pending.length

    // Nice package-download icon (Nerd Font). Fallbacks:  (refresh) if glyph missing.
    // Primary: 󰚰 (package-down), alternative 󰏔 (sync) - using package-down for "updates"
    readonly property string idleGlyph: "󰚰"
    readonly property string checkingGlyph: "󰑐" // sync/refresh
    readonly property string hasUpdateGlyph: "󰚰"

    function displayNameFor(update) {
        return update.name && update.name !== update.id ? update.name : update.id
    }

    function tooltipForPending() {
        if (!hasUpdates) return "Plugin updates — up to date (click to check)"
        if (pendingCount === 1) {
            var u = pending[0]
            return displayNameFor(u) + " " + u.installedVersion + " → " + u.verifiedVersion + " — click to review"
        }
        return pendingCount + " plugin updates available — click to review"
    }

    function triggerManualCheck() {
        if (checking) return
        checkProc.running = true
    }

    function reviewFirstPending() {
        if (!hasUpdates) {
            triggerManualCheck()
            return
        }
        var first = pending[0]
        if (!first || !first.id) return
        if (root.bar && typeof root.bar.run === "function") {
            root.bar.run("omarchy-launch-floating-terminal-with-presentation omarchy plugin update " + first.id)
        }
    }

    // Always visible - manual check affordance
    visible: true
    implicitWidth: button.implicitWidth
    implicitHeight: button.implicitHeight

    // Allow IPC / bar.run to trigger refresh on all monitors
    IpcHandler {
        target: "oma.plugin-updates-widget"
        function refresh(): void { root.triggerManualCheck() }
    }

    Process {
        id: checkProc
        command: ["omarchy-shell", "oma.plugin-updates", "check", "{}"]
        onExited: function(exitCode) {
            // Service will broadcast new pendingUpdates; widget reacts via engine binding
            if (exitCode !== 0) {
                console.log("[oma.plugin-updates widget] manual check via IPC failed: " + exitCode)
            }
        }
    }

    BarIconButton {
        id: button
        anchors.fill: parent
        bar: root.bar
        // Hide glyph while checking — overlay shows the spinning arrow alone
        text: root.checking ? "" : (root.hasUpdates ? root.hasUpdateGlyph : root.idleGlyph)
        slotSize: Style.bar.statusSlot
        fontSize: Style.bar.iconFont
        tooltipText: root.tooltipForPending()
        active: root.hasUpdates
        useActiveColor: root.hasUpdates
        opacity: root.checking ? 0.0 : 1.0
        Behavior on opacity { NumberAnimation { duration: 180 } }

        // Dot indicator — non-interactive, doesn't affect hover
        Rectangle {
            visible: root.hasUpdates && !root.checking
            width: 6; height: 6; radius: 3
            color: "#ff5555"
            anchors.right: parent.right
            anchors.rightMargin: 3
            anchors.top: parent.top
            anchors.topMargin: 3
            border.width: 1
            border.color: root.bar ? root.bar.background : "transparent"
            enabled: false
        }

        onPressed: {
            if (root.hasUpdates) root.reviewFirstPending()
            else root.triggerManualCheck()
        }
    }

    // Clean spinning reverse arrow (no clock hands) — centered, rotates smoothly
    Item {
        anchors.centerIn: button
        width: Style.bar.statusSlot
        height: Style.bar.statusSlot
        visible: root.checking
        enabled: false
        Text {
            id: spinner
            anchors.centerIn: parent
            text: "󰑐"
            color: root.bar ? root.bar.foreground : "#fff"
            font.family: root.bar ? root.bar.fontFamily : Style.font.family
            font.pixelSize: Style.bar.iconFont
            opacity: 0.9
            // Rotate the glyph itself around its center
            transformOrigin: Item.Center
            RotationAnimator on rotation {
                running: root.checking
                from: 0; to: -360
                duration: 900
                loops: Animation.Infinite
            }
        }
    }
}
