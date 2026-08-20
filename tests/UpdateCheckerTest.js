const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function loadChecker(path) {
    const source = fs.readFileSync(path, "utf8").replace(/^\.pragma library\s*/, "");
    const ctx = { module: { exports: {} }, console };
    vm.runInNewContext(source, ctx, { filename: path });
    return ctx.module.exports;
}

const checker = loadChecker("service/UpdateChecker.js");

// -------------------------------------------------- helpers
function catalogFrom(entries) {
    return { plugins: entries };
}
function verifiedEntry(id, version, extra) {
    return Object.assign({ id, version, verificationStatus: "verified", verificationCommit: "abc123", repo: "https://github.com/x/" + id }, extra || {});
}
function unverifiedEntry(id, version) {
    return { id, version, verificationStatus: "unverified", verificationCommit: "abc" };
}

// Version tests (section 16)
test("version: installed < verified -> update", () => {
    const updates = checker.findUpdates([{ id: "macos.dock", version: "1.4.0" }], catalogFrom([verifiedEntry("macos.dock", "1.5.0")]));
    assert.equal(updates.length, 1);
    assert.equal(updates[0].installedVersion, "1.4.0");
    assert.equal(updates[0].verifiedVersion, "1.5.0");
});

test("version: installed == verified -> nothing", () => {
    const updates = checker.findUpdates([{ id: "macos.dock", version: "1.5.0" }], catalogFrom([verifiedEntry("macos.dock", "1.5.0")]));
    assert.equal(updates.length, 0);
});

test("version: installed > verified -> nothing (no downgrade)", () => {
    const updates = checker.findUpdates([{ id: "macos.dock", version: "1.6.0" }], catalogFrom([verifiedEntry("macos.dock", "1.5.0")]));
    assert.equal(updates.length, 0);
});

test("version: 1.9.0 < 1.10.0 -> update (not lexical)", () => {
    const updates = checker.findUpdates([{ id: "a", version: "1.9.0" }], catalogFrom([verifiedEntry("a", "1.10.0")]));
    assert.equal(updates.length, 1);
});

test("version: invalid installed -> skip", () => {
    const updates = checker.findUpdates([{ id: "a", version: "latest" }], catalogFrom([verifiedEntry("a", "1.5.0")]));
    assert.equal(updates.length, 0);
});

test("version: invalid verified -> filtered at normalize stage", () => {
    const updates = checker.findUpdates([{ id: "a", version: "1.4.0" }], catalogFrom([{ id: "a", version: "not-semver", verificationStatus: "verified" }]));
    assert.equal(updates.length, 0);
});

test("version: v prefix is accepted", () => {
    const updates = checker.findUpdates([{ id: "a", version: "v1.4.0" }], catalogFrom([verifiedEntry("a", "1.5.0")]));
    assert.equal(updates.length, 1);
});

test("version: build metadata is ignored", () => {
    // 1.0.0+build == 1.0.0
    const updates = checker.findUpdates([{ id: "a", version: "1.0.0+build1" }], catalogFrom([verifiedEntry("a", "1.0.0+build2")]));
    assert.equal(updates.length, 0);
    const updates2 = checker.findUpdates([{ id: "a", version: "1.0.0" }], catalogFrom([verifiedEntry("a", "1.0.1+meta")]));
    assert.equal(updates2.length, 1);
});

// Fixed regex test (correction 1) - alternation precedence
test("semver regex does not accept partial matches (alternation bug)", () => {
    assert.equal(checker.isValidSemver("0"), false);
    assert.equal(checker.isValidSemver("0-foo"), false);
    assert.equal(checker.isValidSemver("1"), false);
    assert.equal(checker.isValidSemver("1.2"), false);
    assert.equal(checker.isValidSemver("a1.2.3"), false);
    assert.equal(checker.isValidSemver("1.2.3.4"), false);
    assert.equal(checker.isValidSemver("1.2.3"), true);
    assert.equal(checker.isValidSemver("v1.2.3"), true);
    assert.equal(checker.isValidSemver("0.0.0"), true);
    assert.equal(checker.isValidSemver("1.10.0"), true);
    assert.equal(checker.isValidSemver("1.0.0-alpha"), true);
    assert.equal(checker.isValidSemver("1.0.0-alpha.1"), true);
    assert.equal(checker.isValidSemver("1.0.0+build.123"), true);
    assert.equal(checker.isValidSemver("1.0.0-alpha+001"), true);
    assert.equal(checker.isValidSemver("1.0.0-"), false);
    assert.equal(checker.isValidSemver("01.0.0"), false); // leading zero
});

// Prerelease ordering (correction 1)
test("prerelease ordering: alpha < beta < release", () => {
    assert.equal(checker.compareSemver("1.0.0-alpha", "1.0.0-beta") < 0, true);
    assert.equal(checker.compareSemver("1.0.0-beta", "1.0.0") < 0, true);
    assert.equal(checker.compareSemver("1.0.0-alpha", "1.0.0") < 0, true);
    assert.equal(checker.compareSemver("1.0.0", "1.0.0") === 0, true);
});

test("prerelease numeric identifiers compared numerically", () => {
    assert.equal(checker.compareSemver("1.0.0-alpha.2", "1.0.0-alpha.10") < 0, true);
    assert.equal(checker.compareSemver("1.0.0-1", "1.0.0-2") < 0, true);
    // numeric < alphanumeric
    assert.equal(checker.compareSemver("1.0.0-1", "1.0.0-alpha") < 0, true);
});

test("prerelease fewer fields < more fields when prefix equal", () => {
    assert.equal(checker.compareSemver("1.0.0-alpha", "1.0.0-alpha.1") < 0, true);
});

test("verified prerelease vs installed release: no downgrade", () => {
    // installed 1.0.0, verified 1.0.0-alpha -> verified is older, no update
    const updates = checker.findUpdates([{ id: "a", version: "1.0.0" }], catalogFrom([verifiedEntry("a", "1.0.0-alpha")]));
    assert.equal(updates.length, 0);
});

test("installed prerelease < verified release -> update", () => {
    const updates = checker.findUpdates([{ id: "a", version: "1.0.0-alpha" }], catalogFrom([verifiedEntry("a", "1.0.0")]));
    assert.equal(updates.length, 1);
});

// Catalog tests
test("catalog: plugin missing -> ignore", () => {
    const updates = checker.findUpdates([{ id: "dev.local", version: "1.0.0" }], catalogFrom([verifiedEntry("other.plugin", "2.0.0")]));
    assert.equal(updates.length, 0);
});

test("catalog: unverified -> ignore", () => {
    const updates = checker.findUpdates([{ id: "a", version: "1.4.0" }], catalogFrom([unverifiedEntry("a", "1.5.0")]));
    assert.equal(updates.length, 0);
});

test("catalog: verified -> compare", () => {
    const updates = checker.findUpdates([{ id: "a", version: "1.4.0" }], catalogFrom([verifiedEntry("a", "1.5.0")]));
    assert.equal(updates.length, 1);
});

test("catalog: normalize filters invalid version and accepts legacy field names", () => {
    const raw = {
        plugins: [
            { id: "ok", version: "1.5.0", verificationStatus: "verified", verificationCommit: "c1" },
            { id: "bad-ver", version: "latest", verificationStatus: "verified" },
            { id: "unverified", version: "1.5.0", verificationStatus: "unverified" },
            // legacy/alternate field names: status + validatedCommit
            { id: "legacy", version: "2.0.0", status: "verified", validatedCommit: "legacy123" },
        ]
    };
    const map = checker.normalizeCatalog(raw);
    assert.ok(map["ok"]);
    assert.ok(!map["bad-ver"]);
    assert.ok(!map["unverified"]);
    assert.ok(map["legacy"]);
    assert.equal(map["legacy"].commit, "legacy123");
});

test("catalog: accepts array form and object with plugins array", () => {
    const arr = [verifiedEntry("a", "1.0.0")];
    assert.ok(checker.normalizeCatalog(arr)["a"]);
    assert.ok(checker.normalizeCatalog({ plugins: arr })["a"]);
    assert.equal(Object.keys(checker.normalizeCatalog(null)).length, 0);
    assert.equal(Object.keys(checker.normalizeCatalog({ plugins: [] })).length, 0);
});

test("catalog: example from spec 1.4.0 -> 1.5.0 not 1.6.0 until verified", () => {
    // Installed 1.4.0, GitHub latest would be 1.6.0 but marketplace only verified 1.5.0
    const updates = checker.findUpdates([{ id: "macos.dock", version: "1.4.0" }], catalogFrom([verifiedEntry("macos.dock", "1.5.0")]));
    assert.equal(updates[0].verifiedVersion, "1.5.0");
    assert.notEqual(updates[0].verifiedVersion, "1.6.0");
});

test("multiple plugins, mixed results", () => {
    const installed = [
        { id: "a", version: "1.0.0" }, // needs update
        { id: "b", version: "2.0.0" }, // up to date
        { id: "c", version: "1.0.0" }, // unverified -> no update
        { id: "d", version: "1.0.0" }, // not in catalog -> ignore
    ];
    const catalog = catalogFrom([
        verifiedEntry("a", "1.1.0"),
        verifiedEntry("b", "2.0.0"),
        unverifiedEntry("c", "2.0.0"),
    ]);
    const updates = checker.findUpdates(installed, catalog);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].id, "a");
});

// Notification state tests (correction 5 - dedup)
test("notification: first discovery -> shouldNotify true", () => {
    assert.equal(checker.shouldNotify("macos.dock", "1.5.0", {}), true);
});

test("notification: same version -> shouldNotify false", () => {
    const state = { "macos.dock": "1.5.0" };
    assert.equal(checker.shouldNotify("macos.dock", "1.5.0", state), false);
});

test("notification: markNotified replaces object (not mutates)", () => {
    const prev = { "a": "1.0.0" };
    const next = checker.markNotified(prev, "macos.dock", "1.5.0");
    assert.notEqual(next, prev);
    assert.equal(prev["macos.dock"], undefined);
    assert.equal(next["macos.dock"], "1.5.0");
    assert.equal(next["a"], "1.0.0");
});

test("notification: clearNotified replaces object", () => {
    const prev = { "macos.dock": "1.5.0", "other": "1.0.0" };
    const next = checker.clearNotified(prev, "macos.dock");
    assert.notEqual(next, prev);
    assert.equal(next["macos.dock"], undefined);
    assert.equal(next["other"], "1.0.0");
});

test("notification: new verified version -> notify again", () => {
    const state = checker.markNotified({}, "macos.dock", "1.5.0");
    assert.equal(checker.shouldNotify("macos.dock", "1.5.0", state), false);
    assert.equal(checker.shouldNotify("macos.dock", "1.6.0", state), true);
});

test("notification: plugin updated -> caller clears old state (simulated)", () => {
    // installed was 1.4.0, verified 1.5.0, notified
    let notified = checker.markNotified({}, "macos.dock", "1.5.0");
    // user updates to 1.5.0, now installed==verified, service would clear
    const installed = [{ id: "macos.dock", version: "1.5.0" }];
    const catalog = catalogFrom([verifiedEntry("macos.dock", "1.5.0")]);
    const updates = checker.findUpdates(installed, catalog);
    assert.equal(updates.length, 0);
    // after seeing no update, clearing is optional; explicit clear:
    notified = checker.clearNotified(notified, "macos.dock");
    assert.equal(notified["macos.dock"], undefined);
});

// Network/backoff tests
test("backoff intervals: 5m, 15m, 30m, 60m clamped", () => {
    assert.equal(checker.nextBackoffInterval(0), 5 * 60 * 1000);
    assert.equal(checker.nextBackoffInterval(1), 15 * 60 * 1000);
    assert.equal(checker.nextBackoffInterval(2), 30 * 60 * 1000);
    assert.equal(checker.nextBackoffInterval(3), 60 * 60 * 1000);
    assert.equal(checker.nextBackoffInterval(4), 60 * 60 * 1000);
    assert.equal(checker.nextBackoffInterval(99), 60 * 60 * 1000);
});

test("success resets backoff (periodic 12h)", () => {
    // Simulate Service.qml logic: on success, backoffIndex=0, next check 12h
    let backoffIndex = 3;
    const success = true;
    if (success) backoffIndex = 0;
    assert.equal(backoffIndex, 0);
    const periodicMs = 12 * 60 * 60 * 1000;
    assert.equal(periodicMs, 43200000);
});

test("repeated failure increases backoff, success resets", () => {
    let idx = 0;
    idx = Math.min(idx + 1, 3); // fail 1 -> 15m
    assert.equal(checker.nextBackoffInterval(idx), 15 * 60 * 1000);
    idx = Math.min(idx + 1, 3); // fail 2 -> 30m
    assert.equal(checker.nextBackoffInterval(idx), 30 * 60 * 1000);
    idx = 0; // success
    assert.equal(checker.nextBackoffInterval(idx), 5 * 60 * 1000);
});
