// Karelia Ship Check - core: file formats and the check runner.
// Copyright (c) 2026 Karelia Labs. Licensed under the marketplace EULA.
//
// Reads APK, AAB and IPA files entirely in the browser (or Node). Nothing is
// uploaded. Checks register themselves with ShipCheck.addCheck(); this file
// has the parsers, checks-lite.js / checks-pro.js have the rules.

(function (root, factory) {
	if (typeof module === "object" && module.exports) module.exports = factory();
	else root.ShipCheck = factory();
})(this, function () {
	"use strict";

	var VERSION = "1.0.0";
	var checks = [];

	// ------------------------------------------------------------ bytes

	function u16(b, o) { return b[o] | (b[o + 1] << 8); }
	function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
	function u64(b, o) { return u32(b, o) + u32(b, o + 4) * 4294967296; }
	function be16(b, o) { return (b[o] << 8) | b[o + 1]; }
	function be32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

	var dec8 = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8") : null;
	var dec16 = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-16le") : null;
	function utf8(b) { return dec8 ? dec8.decode(b) : Buffer.from(b).toString("utf8"); }
	function utf16(b) { return dec16 ? dec16.decode(b) : Buffer.from(b).toString("utf16le"); }
	function latin1(b, start, end) {
		var s = "", step = 8192;
		for (var i = start || 0, e = end === undefined ? b.length : end; i < e; i += step) {
			s += String.fromCharCode.apply(null, b.subarray(i, Math.min(i + step, e)));
		}
		return s;
	}

	// ------------------------------------------------------------ zip

	function readZip(b) {
		var eocd = -1;
		for (var i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
			if (u32(b, i) === 0x06054b50) { eocd = i; break; }
		}
		if (eocd < 0) throw new Error("This is not a zip-based file (APK, AAB and IPA are zip files).");
		var count = u16(b, eocd + 10), cd = u32(b, eocd + 16);
		if (count === 0xFFFF || cd === 0xFFFFFFFF) {
			// ZIP64: locator sits 20 bytes before the classic record.
			var loc = eocd - 20;
			if (loc >= 0 && u32(b, loc) === 0x07064b50) {
				var z64 = u64(b, loc + 8);
				count = u64(b, z64 + 32); cd = u64(b, z64 + 48);
			}
		}
		var out = [];
		for (var n = 0; n < count; n++) {
			if (u32(b, cd) !== 0x02014b50) throw new Error("Damaged zip directory.");
			var method = u16(b, cd + 10), crc = u32(b, cd + 16);
			var comp = u32(b, cd + 20), size = u32(b, cd + 24);
			var nl = u16(b, cd + 28), el = u16(b, cd + 30), cl = u16(b, cd + 32);
			var lho = u32(b, cd + 42);
			var name = utf8(b.subarray(cd + 46, cd + 46 + nl));
			if (comp === 0xFFFFFFFF || size === 0xFFFFFFFF || lho === 0xFFFFFFFF) {
				var x = cd + 46 + nl, xe = x + el;
				while (x + 4 <= xe) {
					var id = u16(b, x), len = u16(b, x + 2), p = x + 4;
					if (id === 1) {
						if (size === 0xFFFFFFFF) { size = u64(b, p); p += 8; }
						if (comp === 0xFFFFFFFF) { comp = u64(b, p); p += 8; }
						if (lho === 0xFFFFFFFF) { lho = u64(b, p); p += 8; }
					}
					x += 4 + len;
				}
			}
			out.push({ name: name, method: method, compSize: comp, size: size, offset: lho, crc: crc });
			cd += 46 + nl + el + cl;
		}
		return out;
	}

	function dataOffset(b, e) {
		return e.offset + 30 + u16(b, e.offset + 26) + u16(b, e.offset + 28);
	}

	function extract(b, e, inflateRaw) {
		if (u32(b, e.offset) !== 0x04034b50) return Promise.reject(new Error("Damaged zip entry " + e.name));
		var start = dataOffset(b, e);
		var raw = b.subarray(start, start + e.compSize);
		if (e.method === 0) return Promise.resolve(raw);
		if (e.method === 8) return inflateRaw(raw);
		return Promise.reject(new Error("Unsupported compression in " + e.name));
	}

	// ------------------------------------------------------------ ELF

	var MACHINES = { 3: "x86", 40: "armeabi-v7a", 62: "x86_64", 183: "arm64-v8a" };

	// Returns { bits, machine, abi, minLoadAlign, loads, note16k } or null.
	function parseElf(b) {
		if (b.length < 52 || b[0] !== 0x7f || b[1] !== 0x45 || b[2] !== 0x4c || b[3] !== 0x46) return null;
		var is64 = b[4] === 2, le = b[5] === 1;
		if (!le) return { bits: is64 ? 64 : 32, machine: 0, abi: "big-endian", minLoadAlign: 0, loads: 0 };
		var machine = u16(b, 18);
		var phoff = is64 ? u64(b, 32) : u32(b, 28);
		var phentsize = is64 ? u16(b, 54) : u16(b, 42);
		var phnum = is64 ? u16(b, 56) : u16(b, 44);
		var minAlign = Infinity, loads = 0;
		for (var i = 0; i < phnum; i++) {
			var o = phoff + i * phentsize;
			if (o + phentsize > b.length) break;
			if (u32(b, o) !== 1) continue; // PT_LOAD
			loads++;
			var align = is64 ? u64(b, o + 48) : u32(b, o + 28);
			if (align < minAlign) minAlign = align;
		}
		return { bits: is64 ? 64 : 32, machine: machine, abi: MACHINES[machine] || ("machine " + machine), minLoadAlign: loads ? minAlign : 0, loads: loads };
	}

	// ------------------------------------------------------------ Android binary XML (APK)

	var ANDROID_ATTR = {
		0x01010003: "name", 0x01010024: "value", 0x0101020c: "minSdkVersion", 0x01010270: "targetSdkVersion",
		0x0101000f: "debuggable", 0x010104ea: "extractNativeLibs", 0x0101021b: "versionCode", 0x0101021c: "versionName",
		0x01010001: "label", 0x01010271: "maxSdkVersion", 0x01010573: "isGame"
	};

	function axmlValue(type, data, raw, strings) {
		if (raw !== 0xFFFFFFFF && strings[raw] !== undefined) return strings[raw];
		switch (type) {
			case 0x03: return strings[data];                 // string
			case 0x10: return data | 0;                      // int dec
			case 0x11: return "0x" + (data >>> 0).toString(16); // int hex
			case 0x12: return data !== 0;                    // boolean
			case 0x01: return "@0x" + (data >>> 0).toString(16); // reference
			default: return data;
		}
	}

	// Returns a tree { tag, attrs: { name: value }, children: [] }.
	function parseAxml(b) {
		if (u16(b, 0) !== 0x0003) throw new Error("not binary XML");
		var strings = [], resMap = [];
		var root = { tag: "#root", attrs: {}, children: [] }, stack = [root];
		var off = u16(b, 2);
		while (off + 8 <= b.length) {
			var type = u16(b, off), hsize = u16(b, off + 2), size = u32(b, off + 4);
			if (size < 8) break;
			if (type === 0x0001) { // string pool
				var count = u32(b, off + 8), flags = u32(b, off + 16), strStart = u32(b, off + 20);
				var isUtf8 = (flags & 0x100) !== 0;
				for (var i = 0; i < count; i++) {
					var so = off + strStart + u32(b, off + 28 + i * 4);
					if (isUtf8) {
						var p = so;
						p += (b[p] & 0x80) ? 2 : 1;            // utf16 length
						var len = b[p]; if (len & 0x80) { len = ((len & 0x7f) << 8) | b[p + 1]; p += 2; } else p += 1;
						strings.push(utf8(b.subarray(p, p + len)));
					} else {
						var l16 = u16(b, so), q = so + 2;
						if (l16 & 0x8000) { l16 = ((l16 & 0x7fff) << 16) | u16(b, so + 2); q += 2; }
						strings.push(utf16(b.subarray(q, q + l16 * 2)));
					}
				}
			} else if (type === 0x0180) { // resource map
				for (var r = off + 8; r < off + size; r += 4) resMap.push(u32(b, r));
			} else if (type === 0x0102) { // start element
				var ext = off + hsize;
				var nameIdx = u32(b, ext + 4);
				var attrStart = u16(b, ext + 8), attrSize = u16(b, ext + 10), attrCount = u16(b, ext + 12);
				var el = { tag: strings[nameIdx], attrs: {}, children: [] };
				for (var a = 0; a < attrCount; a++) {
					var ao = ext + attrStart + a * attrSize;
					var an = u32(b, ao + 4), rawV = u32(b, ao + 8), dtype = b[ao + 15], dval = u32(b, ao + 16);
					var key = (an < resMap.length && ANDROID_ATTR[resMap[an]]) || strings[an] || ("attr" + an);
					el.attrs[key] = axmlValue(dtype, dval, rawV, strings);
				}
				stack[stack.length - 1].children.push(el);
				stack.push(el);
			} else if (type === 0x0103) { // end element
				if (stack.length > 1) stack.pop();
			}
			off += size;
		}
		return root.children[0] || null;
	}

	// ------------------------------------------------------------ protobuf XML (AAB)

	function readVarint(b, p) {
		var v = 0, mul = 1, byte;
		do { byte = b[p.i++]; v += (byte & 0x7f) * mul; mul *= 128; } while (byte & 0x80);
		return v;
	}

	// Generic protobuf decode: { field: [values] }, length-delimited as Uint8Array.
	function pbFields(b) {
		var p = { i: 0 }, out = {};
		while (p.i < b.length) {
			var key = readVarint(b, p), field = Math.floor(key / 8), wt = key & 7, v;
			if (wt === 0) v = readVarint(b, p);
			else if (wt === 2) { var len = readVarint(b, p); v = b.subarray(p.i, p.i + len); p.i += len; }
			else if (wt === 1) { v = b.subarray(p.i, p.i + 8); p.i += 8; }
			else if (wt === 5) { v = u32(b, p.i); p.i += 4; }
			else throw new Error("protobuf wire type " + wt);
			(out[field] = out[field] || []).push(v);
		}
		return out;
	}

	// aapt2 Resources.proto: XmlNode{1 element,2 text} XmlElement{3 name,4 attribute,5 child}
	// XmlAttribute{2 name,3 value,5 resource_id,6 compiled_item} Item{7 prim}
	// Primitive{6 int_decimal,7 int_hex,8 boolean}
	function parseProtoXml(b) {
		function node(nb) {
			var f = pbFields(nb);
			if (!f[1]) return null;
			var ef = pbFields(f[1][0]);
			var el = { tag: ef[3] ? utf8(ef[3][0]) : "", attrs: {}, children: [] };
			(ef[4] || []).forEach(function (ab) {
				var af = pbFields(ab);
				var rid = af[5] ? af[5][0] : 0;
				var name = (rid && ANDROID_ATTR[rid]) || (af[2] ? utf8(af[2][0]) : "");
				var value = af[3] ? utf8(af[3][0]) : undefined;
				if ((value === undefined || value === "") && af[6]) {
					var item = pbFields(af[6][0]);
					if (item[7]) {
						var prim = pbFields(item[7][0]);
						if (prim[6]) value = prim[6][0] | 0;
						else if (prim[7]) value = prim[7][0];
						else if (prim[8]) value = prim[8][0] !== 0;
					}
				}
				if (value === "true") value = true; else if (value === "false") value = false;
				el.attrs[name] = value;
			});
			(ef[5] || []).forEach(function (cb) { var c = node(cb); if (c) el.children.push(c); });
			return el;
		}
		return node(b);
	}

	function findAll(el, tag, out) {
		out = out || [];
		if (!el) return out;
		if (el.tag === tag) out.push(el);
		el.children.forEach(function (c) { findAll(c, tag, out); });
		return out;
	}

	// ------------------------------------------------------------ plist (XML and binary)

	function parseBplist(b) {
		if (latin1(b, 0, 8) !== "bplist00") throw new Error("not a binary plist");
		// Trailer: 6 unused, offset size, ref size, numObjects(8), topObject(8), offsetTable(8), big-endian.
		var t = b.length - 32;
		var offSize = b[t + 6], refSize = b[t + 7];
		var top = be32(b, t + 20);
		var offTable = be32(b, t + 28);
		function uint(o, n) { var v = 0; for (var i = 0; i < n; i++) v = v * 256 + b[o + i]; return v; }
		function offsetOf(i) { return uint(offTable + i * offSize, offSize); }
		function lenAt(o, info) {
			if (info !== 0xF) return { len: info, start: o + 1 };
			var m = b[o + 1], n = 1 << (m & 0xF);
			return { len: uint(o + 2, n), start: o + 2 + n };
		}
		function obj(i, depth) {
			if (depth > 40) throw new Error("plist too deep");
			var o = offsetOf(i), m = b[o], type = m >> 4, info = m & 0xF, l;
			switch (type) {
				case 0x0: return info === 0x8 ? false : info === 0x9 ? true : null;
				case 0x1: return uint(o + 1, 1 << info);
				case 0x2: { var dv = new DataView(b.buffer, b.byteOffset + o + 1, 1 << info); return info === 2 ? dv.getFloat32(0) : dv.getFloat64(0); }
				case 0x3: return "date";
				case 0x4: l = lenAt(o, info); return b.subarray(l.start, l.start + l.len);
				case 0x5: l = lenAt(o, info); return latin1(b, l.start, l.start + l.len);
				case 0x6: {
					l = lenAt(o, info);
					var s = "";
					for (var k = 0; k < l.len; k++) s += String.fromCharCode(be16(b, l.start + k * 2));
					return s;
				}
				case 0x8: return uint(o + 1, info + 1);
				case 0xA: { l = lenAt(o, info); var arr = []; for (var a = 0; a < l.len; a++) arr.push(obj(uint(l.start + a * refSize, refSize), depth + 1)); return arr; }
				case 0xD: {
					l = lenAt(o, info);
					var d = {};
					for (var e = 0; e < l.len; e++) {
						var kk = obj(uint(l.start + e * refSize, refSize), depth + 1);
						d[kk] = obj(uint(l.start + (l.len + e) * refSize, refSize), depth + 1);
					}
					return d;
				}
				default: return null;
			}
		}
		return obj(top, 0);
	}

	function parseXmlPlist(text) {
		var re = /<(\/?)(dict|array|key|string|integer|real|true|false|data|date)(\s*\/)?>([^<]*)/g;
		var stack = [], keys = [], key = null, rootV, m;
		function put(v) {
			var top = stack[stack.length - 1];
			if (!top) { rootV = v; return; }
			if (Array.isArray(top)) top.push(v); else { top[key] = v; key = null; }
		}
		var unesc = function (s) { return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"); };
		while ((m = re.exec(text))) {
			var close = m[1] === "/", tag = m[2], selfClose = !!m[3], body = m[4];
			if (tag === "dict" || tag === "array") {
				// The parent's pending key must survive the keys inside the child.
				if (close) { var v = stack.pop(); key = keys.pop(); put(v); }
				else if (selfClose) put(tag === "dict" ? {} : []);
				else { keys.push(key); key = null; stack.push(tag === "dict" ? {} : []); }
			} else if (!close) {
				if (tag === "key") key = unesc(body);
				else if (tag === "string") put(unesc(body));
				else if (tag === "integer") put(parseInt(body, 10));
				else if (tag === "real") put(parseFloat(body));
				else if (tag === "true") put(true);
				else if (tag === "false") put(false);
				else put(body.trim());
			}
		}
		return rootV;
	}

	function parsePlist(b) {
		if (b.length >= 8 && latin1(b, 0, 8) === "bplist00") return parseBplist(b);
		return parseXmlPlist(utf8(b));
	}

	// ------------------------------------------------------------ helpers for checks

	function indexOfAscii(b, needle, from) {
		var n = needle.length, first = needle.charCodeAt(0);
		outer: for (var i = from || 0; i <= b.length - n; i++) {
			if (b[i] !== first) continue;
			for (var j = 1; j < n; j++) if (b[i + j] !== needle.charCodeAt(j)) continue outer;
			return i;
		}
		return -1;
	}

	function compareVersions(a, b) {
		var pa = String(a).split(/[.\-]/), pb = String(b).split(/[.\-]/);
		for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
			var x = parseInt(pa[i] || "0", 10), y = parseInt(pb[i] || "0", 10);
			if (isNaN(x) || isNaN(y)) break;
			if (x !== y) return x < y ? -1 : 1;
		}
		return 0;
	}

	// ------------------------------------------------------------ analysis

	// Builds the context every check gets, then runs the checks.
	// file: Uint8Array, name: file name, env: { inflateRaw, now: Date }
	function analyze(file, name, env) {
		env = env || {};
		var now = env.now || new Date();
		var entries = readZip(file);
		var byName = {};
		entries.forEach(function (e) { byName[e.name] = e; });
		var lower = String(name || "").toLowerCase();
		var kind = byName["AndroidManifest.xml"] ? "apk"
			: byName["base/manifest/AndroidManifest.xml"] ? "aab"
			: entries.some(function (e) { return /^Payload\/[^/]+\.app\/Info\.plist$/.test(e.name); }) ? "ipa"
			: lower.endsWith(".ipa") ? "ipa" : lower.endsWith(".aab") ? "aab" : lower.endsWith(".apk") ? "apk" : "unknown";
		if (kind === "unknown") throw new Error("Could not tell what this is. Drop an .apk, .aab or .ipa file.");

		var cache = {};
		var ctx = {
			kind: kind, name: name, size: file.length, entries: entries, byName: byName, now: now, file: file,
			read: function (n) {
				var e = byName[n];
				if (!e) return Promise.resolve(null);
				if (!cache[n]) cache[n] = extract(file, e, env.inflateRaw);
				return cache[n];
			},
			dataOffset: function (e) { return dataOffset(file, e); },
			parseElf: parseElf, parseAxml: parseAxml, parseProtoXml: parseProtoXml, parsePlist: parsePlist,
			findAll: findAll, indexOfAscii: indexOfAscii, latin1: latin1, utf8: utf8, compareVersions: compareVersions,
			facts: {}
		};

		var prep = Promise.resolve();
		if (kind === "apk" || kind === "aab") {
			prep = prep.then(function () {
				var mpath = kind === "apk" ? "AndroidManifest.xml" : "base/manifest/AndroidManifest.xml";
				return ctx.read(mpath).then(function (mb) {
					try { ctx.manifest = kind === "apk" ? parseAxml(mb) : parseProtoXml(mb); }
					catch (e) { ctx.manifestError = e.message; ctx.manifest = null; }
				});
			}).then(function () {
				// META-INF/<group>_<artifact>.version files written by Gradle for AndroidX/Google libs.
				ctx.libVersions = {};
				var vfiles = entries.filter(function (e) { return /(^|\/)META-INF\/[^/]+\.version$/.test(e.name); });
				return Promise.all(vfiles.map(function (e) {
					return ctx.read(e.name).then(function (d) {
						var id = e.name.replace(/^.*META-INF\//, "").replace(/\.version$/, "");
						ctx.libVersions[id] = utf8(d).trim();
					});
				}));
			}).then(function () {
				var dex = entries.filter(function (e) { return /(^|\/)classes\d*\.dex$/.test(e.name); });
				ctx.dexSize = dex.reduce(function (s, e) { return s + e.size; }, 0);
				return Promise.all(dex.map(function (e) { return ctx.read(e.name); })).then(function (list) { ctx.dex = list.filter(Boolean); });
			}).then(function () {
				ctx.dexStr = ctx.dex.map(function (d) { return latin1(d); });
				ctx.dexHas = function (needle) { return ctx.dexStr.some(function (s) { return s.indexOf(needle) >= 0; }); };
				// Solar2D plugins ship a Java class plugin.<name>.LuaLoader.
				var plugins = {};
				var re = /Lplugin\/([A-Za-z0-9_\/]+)\/LuaLoader;/g;
				ctx.dexStr.forEach(function (s) {
					var m;
					while ((m = re.exec(s))) plugins["plugin." + m[1].replace(/\//g, ".")] = true;
				});
				ctx.solar2dPlugins = Object.keys(plugins).sort();
				ctx.libs = entries.filter(function (e) { return /(^|\/)lib\/[^/]+\/[^/]+\.so$/.test(e.name); }).map(function (e) {
					var m = /lib\/([^/]+)\/([^/]+\.so)$/.exec(e.name);
					return { entry: e, abi: m[1], file: m[2] };
				});
			});
		} else {
			prep = prep.then(function () {
				var info = entries.filter(function (e) { return /^Payload\/[^/]+\.app\/Info\.plist$/.test(e.name); })[0];
				ctx.appDir = info.name.replace(/Info\.plist$/, "");
				return ctx.read(info.name).then(function (pb) {
					try { ctx.plist = parsePlist(pb); } catch (e) { ctx.plistError = e.message; ctx.plist = {}; }
					var exe = ctx.plist.CFBundleExecutable;
					return exe ? ctx.read(ctx.appDir + exe).then(function (bin) { ctx.binary = bin; }) : null;
				});
			}).then(function () {
				ctx.binStr = ctx.binary ? latin1(ctx.binary) : "";
				ctx.binHas = function (needle) { return ctx.binStr.indexOf(needle) >= 0; };
				ctx.frameworks = {};
				entries.forEach(function (e) {
					var m = new RegExp("^" + ctx.appDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "Frameworks/([^/]+\\.framework)/").exec(e.name);
					if (m) {
						var fw = ctx.frameworks[m[1]] = ctx.frameworks[m[1]] || { privacy: false };
						if (/PrivacyInfo\.xcprivacy$/.test(e.name)) fw.privacy = true;
					}
				});
			});
		}

		return prep.then(function () {
			var results = [];
			var run = checks.filter(function (c) { return c.kinds.indexOf(kind) >= 0; });
			return run.reduce(function (p, c) {
				return p.then(function () {
					return Promise.resolve().then(function () { return c.run(ctx); }).then(function (r) {
						(Array.isArray(r) ? r : r ? [r] : []).forEach(function (x) { x.id = x.id || c.id; x.tier = c.tier; results.push(x); });
					}, function (err) {
						results.push({ id: c.id, tier: c.tier, status: "info", title: c.title, detail: "Check could not run: " + err.message });
					});
				});
			}, Promise.resolve()).then(function () {
				var order = { fail: 0, warn: 1, ok: 2, info: 3 };
				results.sort(function (a, b) { return order[a.status] - order[b.status]; });
				return {
					tool: "Karelia Ship Check " + VERSION, kind: kind, name: name, size: file.length,
					checked: now.toISOString().slice(0, 10), facts: ctx.facts, results: results,
					editions: checks.reduce(function (s, c) { s[c.tier] = true; return s; }, {})
				};
			});
		});
	}

	// Deadline helper: "fail" after the date, "warn" before it.
	function byDate(now, isoDate) { return now >= new Date(isoDate + "T00:00:00Z") ? "fail" : "warn"; }

	return {
		VERSION: VERSION,
		addCheck: function (c) { checks.push(c); },
		checks: checks,
		analyze: analyze, byDate: byDate,
		_internal: { readZip: readZip, extract: extract, parseElf: parseElf, parseAxml: parseAxml, parseProtoXml: parseProtoXml,
			pbFields: pbFields, parsePlist: parsePlist, parseBplist: parseBplist, parseXmlPlist: parseXmlPlist,
			compareVersions: compareVersions, indexOfAscii: indexOfAscii }
	};
});
