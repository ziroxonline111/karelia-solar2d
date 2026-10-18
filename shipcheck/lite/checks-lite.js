// Karelia Ship Check - free checks (Android native libraries and engine).
// Copyright (c) 2026 Karelia Labs. Licensed under the marketplace EULA.

(function (SC) {
	"use strict";
	if (!SC && typeof require === "function") SC = require("./shipcheck-core.js");

	var SRC_16K = "https://developer.android.com/guide/practices/page-sizes";
	var SRC_64 = "https://developer.android.com/google/play/requirements/64-bit";

	// Native libraries of Solar2D itself (Corona.aar).
	var ENGINE_LIBS = ["libcorona.so", "liblua.so", "libjnlua5.1.so", "libalmixer.so", "libopenal.so", "libmpg123.so",
		"libads.so", "libanalytics.so", "libgameNetwork.so", "liblicensing.so"];

	// Which plugin or SDK ships a library. Plugin names come from a scan of
	// all 358 plugins in the Solar2D plugin directory (2026-10-18).
	var KNOWN = {
		"libEOSSDK.so": "plugin.eos (Epic Online Services)", "libnative-lib.so": "plugin.eos (Epic Online Services)",
		"libplugin.movie.so": "plugin.movie", "libplugin.pack.so": "plugin.pack",
		"libplugin.spine.so": "plugin.spine", "libplugin.spine42.so": "plugin.spine42", "libplugin.spine43.so": "plugin.spine43",
		"libapplovin-native-crash-reporter.so": "AppLovin SDK (applovinMax / Appodeal / mediation)",
		"libbugsnag-ndk.so": "Bugsnag NDK", "libbugsnag-plugin-android-anr.so": "Bugsnag ANR",
		"libsentry.so": "Sentry (pulled in by Appodeal)", "libsentry-android.so": "Sentry (pulled in by Appodeal)",
		"libtobEmbedPagEncrypt.so": "Pangle / ByteDance ads SDK (via mediation)",
		"libcrashlytics.so": "Firebase Crashlytics NDK", "libcrashlytics-common.so": "Firebase Crashlytics NDK",
		"libcrashlytics-handler.so": "Firebase Crashlytics NDK", "libcrashlytics-trampoline.so": "Firebase Crashlytics NDK",
		"libonnxruntime.so": "plugin.onnxruntime", "libc++_shared.so": "a plugin or SDK built with the shared C++ runtime"
	};

	function n(count, one, many) { return count + " " + (count === 1 ? one : many); }

	function owner(file) {
		if (ENGINE_LIBS.indexOf(file) >= 0) return "Solar2D engine";
		if (KNOWN[file]) return KNOWN[file];
		var m = /^libplugin\.(.+)\.so$/.exec(file);
		if (m) return "plugin." + m[1];
		return null;
	}

	function engineVersion(ctx) {
		var lib = ctx.libs.filter(function (l) { return l.file === "libcorona.so"; })[0];
		if (!lib) return Promise.resolve(null);
		return ctx.read(lib.entry.name).then(function (b) {
			var s = ctx.latin1(b), m = /(20[2-3]\d)\.(3[5-9]\d\d)/.exec(s);
			return m ? m[1] + "." + m[2] : null;
		});
	}

	SC.addCheck({
		id: "engine", tier: "lite", kinds: ["apk", "aab"], title: "Solar2D version",
		run: function (ctx) {
			return engineVersion(ctx).then(function (v) {
				ctx.facts.engine = v;
				if (!ctx.libs.some(function (l) { return l.file === "libcorona.so"; })) {
					return { status: "info", title: "Not a Solar2D build", detail: "libcorona.so is missing, so the Solar2D-specific advice may not apply. The Android checks still do." };
				}
				if (!v) return { status: "info", title: "Solar2D version not found", detail: "libcorona.so has no readable build number." };
				var build = parseInt(v.split(".")[1], 10);
				if (build < 3721) return { status: "fail", title: "Solar2D " + v + " is too old for Google Play",
					detail: "Builds before 2025.3721 have no 16 KB page support and target an API level Google Play no longer accepts.",
					fix: "Install the latest Solar2D release and rebuild.", source: "https://github.com/coronalabs/corona/releases" };
				if (build < 3731) return { status: "warn", title: "Solar2D " + v + " targets API 35",
					detail: "Google Play needs API 36 for updates from 2026-08-31 (extension until 2026-11-01). Solar2D 2026.3731 is the first release that targets API 36.",
					fix: "Update Solar2D to 2026.3731 or newer and rebuild.", source: "https://support.google.com/googleplay/android-developer/answer/11926878" };
				return { status: "ok", title: "Solar2D " + v, detail: "Recent enough for the 2026 Google Play requirements (16 KB pages, API 36)." };
			});
		}
	});

	SC.addCheck({
		id: "16kb", tier: "lite", kinds: ["apk", "aab"], title: "16 KB memory pages",
		run: function (ctx) {
			var libs = ctx.libs.filter(function (l) { return l.abi === "arm64-v8a" || l.abi === "x86_64"; });
			if (!libs.length) return { status: "ok", title: "16 KB pages: no 64-bit native libraries", detail: "Nothing to align." };
			return Promise.all(libs.map(function (l) {
				return ctx.read(l.entry.name).then(function (b) {
					var e = ctx.parseElf(b);
					return { lib: l, elf: e };
				});
			})).then(function (rows) {
				var bad = rows.filter(function (r) { return r.elf && r.elf.minLoadAlign < 16384; });
				ctx.facts.libs64 = rows.length;
				if (!bad.length) return { status: "ok", title: "16 KB pages: all " + rows.length + " 64-bit libraries aligned",
					detail: "Every LOAD segment is aligned to 16 KB or more.", source: SRC_16K };
				var groups = {};
				bad.forEach(function (r) {
					var who = owner(r.lib.file) || "unknown, see the library name";
					(groups[who] = groups[who] || []).push(r.lib.abi + "/" + r.lib.file + " (" + (r.elf.minLoadAlign / 1024) + " KB)");
				});
				var items = Object.keys(groups).sort().map(function (k) { return k + ": " + groups[k].join(", "); });
				var engineBad = groups["Solar2D engine"];
				return { status: "fail", title: "16 KB pages: " + bad.length + " of " + rows.length + (bad.length === 1 ? " libraries is" : " libraries are") + " 4 KB aligned",
					detail: "Google Play blocks updates without 16 KB support from 2027-02-01, and the app crashes on 16 KB devices. Libraries and where they come from:",
					items: items,
					fix: engineBad ? "Update Solar2D (2025.3721 or newer has 16 KB engine libraries), then rebuild."
						: "Update or remove the plugins listed. A plugin whose maintainer has not rebuilt it with NDK r28+ (or -Wl,-z,max-page-size=16384) cannot pass.",
					source: SRC_16K, deadline: "2027-02-01" };
			});
		}
	});

	SC.addCheck({
		id: "64bit", tier: "lite", kinds: ["apk", "aab"], title: "64-bit libraries",
		run: function (ctx) {
			var by = {};
			ctx.libs.forEach(function (l) { (by[l.abi] = by[l.abi] || {})[l.file] = true; });
			var v7 = Object.keys(by["armeabi-v7a"] || {}), a64 = by["arm64-v8a"] || {};
			var missing = v7.filter(function (f) { return !a64[f]; });
			if (!v7.length && !Object.keys(a64).length) return null;
			if (!missing.length) return { status: "ok", title: "64-bit: every 32-bit library has an arm64 version" };
			return { status: "fail", title: "64-bit: " + n(missing.length, "library exists", "libraries exist") + " only as 32-bit",
				detail: "Google Play requires a 64-bit version of every native library.",
				items: missing.map(function (f) { return f + (owner(f) ? " (" + owner(f) + ")" : ""); }),
				fix: "Update or remove the plugins that ship them.", source: SRC_64 };
		}
	});

	SC.addCheck({
		id: "zipalign", tier: "lite", kinds: ["apk"], title: "Uncompressed libraries in the APK",
		run: function (ctx) {
			var stored = ctx.libs.filter(function (l) { return l.entry.method === 0 && (l.abi === "arm64-v8a" || l.abi === "x86_64"); });
			if (!stored.length) return null;
			var bad = stored.filter(function (l) { return ctx.dataOffset(l.entry) % 16384 !== 0; });
			if (!bad.length) return { status: "ok", title: "APK zip alignment: uncompressed libraries start on 16 KB boundaries" };
			return { status: "fail", title: "APK zip alignment: " + n(bad.length, "uncompressed library is", "uncompressed libraries are") + " not 16 KB aligned",
				detail: "Uncompressed native libraries must start on a 16 KB boundary inside the APK.",
				items: bad.map(function (l) { return l.abi + "/" + l.file; }),
				fix: "Rebuild with a current Solar2D, or run: zipalign -P 16 -f -v 4 in.apk out.apk", source: SRC_16K };
		}
	});

	SC.addCheck({
		id: "iosLite", tier: "lite", kinds: ["ipa"], title: "iOS checks",
		run: function () {
			var pro = SC.checks.some(function (c) { return c.tier === "pro" && c.kinds.indexOf("ipa") >= 0; });
			if (pro) return null;
			return { status: "info", title: "iOS builds are checked by Ship Check Pro",
				detail: "Lite checks Android native libraries. Pro checks the iOS SDK, minimum iOS version, usage strings, ATT, AdMob setup and the privacy manifest." };
		}
	});

	SC.addCheck({
		id: "plugins", tier: "lite", kinds: ["apk", "aab"], title: "Plugins found",
		run: function (ctx) {
			if (!ctx.solar2dPlugins.length) return null;
			return { status: "info", title: "Solar2D plugins in this build: " + ctx.solar2dPlugins.length, items: ctx.solar2dPlugins };
		}
	});

	if (typeof module === "object" && module.exports) module.exports = SC;
})(typeof ShipCheck !== "undefined" ? ShipCheck : null);
