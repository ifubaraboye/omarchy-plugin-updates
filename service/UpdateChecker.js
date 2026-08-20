.pragma library

// Corrected semver regex - alternation is grouped so | does not escape the anchor.
// Accepts optional leading "v", requires at least major.minor.patch.
var SEMVER_RE = /^v?(?:0|[1-9]\d*)\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function isValidSemver(value) {
    if (typeof value !== "string") return false;
    var s = value.trim();
    if (!s) return false;
    return SEMVER_RE.test(s);
}

function parseSemver(value) {
    var raw = String(value || "").trim();
    // strip leading v
    if (raw.charAt(0) === "v" || raw.charAt(0) === "V") raw = raw.slice(1);
    if (!SEMVER_RE.test((value.charAt(0) === "v" || value.charAt(0) === "V") ? value.trim() : "v" + raw) && !SEMVER_RE.test(raw) && !SEMVER_RE.test("v" + raw)) {
        // fallback: already validated via isValidSemver, but keep strict
    }
    // Remove build metadata (+...)
    var plusIdx = raw.indexOf("+");
    if (plusIdx !== -1) raw = raw.slice(0, plusIdx);

    var prerelease = null;
    var dashIdx = raw.indexOf("-");
    var core = raw;
    if (dashIdx !== -1) {
        core = raw.slice(0, dashIdx);
        prerelease = raw.slice(dashIdx + 1);
    }

    var parts = core.split(".");
    if (parts.length !== 3) return null;
    var major = Number(parts[0]);
    var minor = Number(parts[1]);
    var patch = Number(parts[2]);
    if (!isFinite(major) || !isFinite(minor) || !isFinite(patch)) return null;

    var preParts = null;
    if (prerelease !== null) {
        preParts = prerelease.split(".");
    }

    return {
        major: major,
        minor: minor,
        patch: patch,
        prerelease: preParts, // null means release version
        raw: String(value).trim()
    };
}

function compareIdentifiers(a, b) {
    var aNum = /^(?:0|[1-9]\d*)$/.test(a);
    var bNum = /^(?:0|[1-9]\d*)$/.test(b);
    if (aNum && bNum) {
        var an = Number(a);
        var bn = Number(b);
        if (an < bn) return -1;
        if (an > bn) return 1;
        return 0;
    }
    if (aNum && !bNum) return -1;
    if (!aNum && bNum) return 1;
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

function compareSemver(a, b) {
    var pa = parseSemver(a);
    var pb = parseSemver(b);
    if (!pa || !pb) return 0; // caller should have validated; treat invalid as equal (no update)

    if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
    if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
    if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;

    var aPre = pa.prerelease;
    var bPre = pb.prerelease;
    if (aPre === null && bPre === null) return 0;
    if (aPre === null) return 1; // release > prerelease
    if (bPre === null) return -1;

    var len = Math.max(aPre.length, bPre.length);
    for (var i = 0; i < len; i++) {
        if (i >= aPre.length) return -1; // a has fewer fields -> lower precedence
        if (i >= bPre.length) return 1;
        var c = compareIdentifiers(aPre[i], bPre[i]);
        if (c !== 0) return c;
    }
    return 0;
}

function normalizeCatalog(catalog) {
    // Returns Map id -> { id, version, commit, repo, name }
    var result = {};
    if (!catalog) return result;

    var plugins = null;
    if (Array.isArray(catalog)) plugins = catalog;
    else if (Array.isArray(catalog.plugins)) plugins = catalog.plugins;
    else return result;

    for (var i = 0; i < plugins.length; i++) {
        var entry = plugins[i];
        if (!entry || typeof entry !== "object") continue;
        var id = String(entry.id || "").trim();
        if (!id) continue;

        // Only verified releases generate notifications. verificationStatus is authoritative;
        // status is UI state (Available/Manual setup) and must not be used as fallback.
        var status = entry.verificationStatus !== undefined ? entry.verificationStatus : entry.status;
        if (String(status) !== "verified") continue;

        var version = entry.version !== undefined ? String(entry.version).trim() : "";
        if (!version || !isValidSemver(version)) continue;

        var commit = "";
        if (entry.commit !== undefined) commit = String(entry.commit);
        else if (entry.verificationCommit !== undefined) commit = String(entry.verificationCommit);
        else if (entry.validatedCommit !== undefined) commit = String(entry.validatedCommit);
        else if (entry.upstreamValidatedCommit !== undefined) commit = String(entry.upstreamValidatedCommit);

        var repo = entry.repo !== undefined ? String(entry.repo) : (entry.repository || "");
        var name = entry.name !== undefined ? String(entry.name) : id;

        result[id] = {
            id: id,
            version: version,
            commit: commit,
            repo: String(repo || ""),
            name: String(name || id)
        };
    }
    return result;
}

function findUpdates(installedPlugins, catalog) {
    var updates = [];
    if (!Array.isArray(installedPlugins) || installedPlugins.length === 0) return updates;

    var catalogMap = normalizeCatalog(catalog);
    // Quick check if map empty
    var hasVerified = false;
    for (var k in catalogMap) { hasVerified = true; break; }
    if (!hasVerified) return updates;

    for (var i = 0; i < installedPlugins.length; i++) {
        var inst = installedPlugins[i];
        if (!inst || typeof inst !== "object") continue;
        var id = String(inst.id || "").trim();
        var installedVersion = String(inst.version || inst.installedVersion || "").trim();
        if (!id || !installedVersion) continue;

        // If no marketplace entry exists -> ignore (dev/private/local)
        var verified = catalogMap[id];
        if (!verified) continue;

        if (!isValidSemver(installedVersion)) {
            // invalid/non-semver -> skip + log (caller may log)
            // console.warn("UpdateChecker: invalid installed version for " + id + ": " + installedVersion);
            continue;
        }
        // verified.version already validated in normalizeCatalog
        var cmp = compareSemver(installedVersion, verified.version);
        if (cmp < 0) {
            updates.push({
                id: id,
                installedVersion: installedVersion,
                verifiedVersion: verified.version,
                verifiedCommit: verified.commit,
                repo: verified.repo,
                name: verified.name
            });
        }
        // cmp === 0 -> no notification
        // cmp > 0  -> installed newer than verified -> no downgrade suggestion
    }
    return updates;
}

// Notification-state helpers (pure, testable, used by Service.qml's PersistentProperties logic)
function shouldNotify(id, verifiedVersion, notifiedVersions) {
    var key = String(id);
    var ver = String(verifiedVersion);
    if (!key || !ver) return false;
    var map = notifiedVersions && typeof notifiedVersions === "object" ? notifiedVersions : {};
    return String(map[key] || "") !== ver;
}

function markNotified(notifiedVersions, id, version) {
    var next = {};
    var src = notifiedVersions && typeof notifiedVersions === "object" ? notifiedVersions : {};
    for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k)) next[k] = String(src[k]);
    }
    next[String(id)] = String(version);
    return next;
}

function clearNotified(notifiedVersions, id) {
    var next = {};
    var src = notifiedVersions && typeof notifiedVersions === "object" ? notifiedVersions : {};
    for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k)) next[k] = String(src[k]);
    }
    delete next[String(id)];
    return next;
}

function nextBackoffInterval(attemptIndex) {
    var table = [5 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000];
    var idx = Math.max(0, Math.min(Math.floor(Number(attemptIndex) || 0), table.length - 1));
    return table[idx];
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        SEMVER_RE: SEMVER_RE,
        isValidSemver: isValidSemver,
        parseSemver: parseSemver,
        compareSemver: compareSemver,
        compareIdentifiers: compareIdentifiers,
        normalizeCatalog: normalizeCatalog,
        findUpdates: findUpdates,
        shouldNotify: shouldNotify,
        markNotified: markNotified,
        clearNotified: clearNotified,
        nextBackoffInterval: nextBackoffInterval
    };
}
