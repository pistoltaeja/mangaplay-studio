#!/usr/bin/env bun
/**
 * gen-native-config.js — stage every runtime config the native iOS/Android
 * builds need into their source trees. Standalone build helper; also imported
 * by scripts/build-native.js (exports main()).
 *
 * Reads the same human-edited sources of truth the web build uses (repo-root
 * localisation/ + mangaplay-studio-configs/ + the already-generated
 * src-tauri/resources/boot-strings.json) and distributes them into:
 *   - native/ios/mangaplay/Resources/       (locales/, config/, boot-strings.json)
 *   - native/android/app/src/main/assets/   (locales/, config/, boot-strings.json)
 *   - native/ios/mangaplay/                  (GoogleService-Info.plist, MPSBuildConfig.h)
 *   - native/android/app/                    (google-services.json)
 *   - native/android/app/src/main/java/studio/mangaplay/app/MPSBuildConfig.java
 *
 * What it does:
 *   1. LOCALE → NATIVE: copy all 14 localisation/<lang>.json verbatim into both
 *      native locale dirs.
 *   2. PARITY: en.json is the reference; every other locale MUST contain every
 *      flattened dot-path key present in en.json. Missing keys → throw → non-zero
 *      exit. Runs BEFORE any locale file is written (fail before partial output).
 *   3. BOOT STRINGS: copy src-tauri/resources/boot-strings.json into both trees.
 *   4. UX-MODE + PLATFORM CONSTANTS: emit MPSBuildConfig.h (iOS) + MPSBuildConfig.java
 *      (Android), both pinned to ux-mode "mobile".
 *   5. FIREBASE: copy GoogleService-Info.plist + google-services.json into place.
 *   6. IAP / ADMOB / SKINS: copy the source JSON verbatim into both config/ dirs.
 *
 * Parity failure is a HARD error (throw → exit 1). Missing firebase / config /
 * boot-strings sources are warn+skip (non-fatal). Deterministic: same input →
 * byte-identical output.
 */

import { readFile, writeFile, copyFile, mkdir, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { flattenKeys, parityErrors as computeParityErrors } from "./lib/loc-keys.js";

const ROOT = join(import.meta.dirname, "..");                                     // = mangaplay-studio/
const REPO_ROOT = join(import.meta.dirname, "..", "..");                          // = repo root
const APP_METADATA_PATH = join(REPO_ROOT, "mangaplay-studio-configs", "app-metadata.json");

const LOCALES_DIR = join(REPO_ROOT, "localisation");
const CONFIGS_DIR = join(REPO_ROOT, "mangaplay-studio-configs");
const FIREBASE_DIR = join(CONFIGS_DIR, "firebase-configs");
const EDITOR_FEATURES_PATH = join(CONFIGS_DIR, "editor", "features.json");
const BOOT_STRINGS_SRC = join(ROOT, "src-tauri", "resources", "boot-strings.json");

// Native trees.
const IOS_APP_DIR = join(ROOT, "native", "ios", "mangaplay");
const IOS_RES_DIR = join(IOS_APP_DIR, "Resources");
const ANDROID_APP_DIR = join(ROOT, "native", "android", "app");
const ANDROID_ASSETS_DIR = join(ANDROID_APP_DIR, "src", "main", "assets");
const ANDROID_JAVA_PKG_DIR = join(ANDROID_APP_DIR, "src", "main", "java", "studio", "mangaplay", "app");

/**
 * Copy one source file to a destination, creating parent dirs as needed.
 * Returns the destination path.
 */
async function copyInto(src, dstDir, name)
{
    await mkdir(dstDir, { recursive: true });
    const dst = join(dstDir, name);
    await copyFile(src, dst);
    return dst;
}

async function main()
{
    /** @type {string[]} */
    const emitted = [];

    // ── Read version from app-metadata.json. ────────────────────────────────
    const meta = JSON.parse(await readFile(APP_METADATA_PATH, "utf8"));
    const common = meta.common ?? {};
    const ios = meta.ios ?? {};
    const android = meta.android ?? {};
    const versionIOS = ios.version;
    if (!versionIOS) { throw new Error(`app-metadata.json is missing "version" in the "ios" block.`); }
    const versionIOSBuild = ios.versionBuild ?? "1";
    const versionAndroid = android.version;
    if (!versionAndroid) { throw new Error(`app-metadata.json is missing "version" in the "android" block.`); }
    const versionAndroidCode = android.versionCode ?? 1;

    // ── Read editor feature flags. Mirrors src/js/boot/editor-features.js:
    //    easyEditorEnabled defaults to TRUE on missing/unparseable file; only an
    //    explicit `false` disables the Easy Editor. Baked into the native build
    //    config so iOS/Android honour the same flag the JS bundle bakes as
    //    __MPS_EASY_EDITOR_ENABLED__. ─────────────────────────────────────────
    let easyEditorEnabled = true;
    try
    {
        const features = JSON.parse(await readFile(EDITOR_FEATURES_PATH, "utf8"));
        easyEditorEnabled = features.easyEditorEnabled !== false;
    }
    catch (e)
    {
        console.warn(`[gen-native-config] editor/features.json unreadable — defaulting easyEditorEnabled=true (${e.message})`);
    }
    const analyticsApiKeyB64Ios = ios.analyticsApiKey ?? "";
    const analyticsApiKeyB64Android = android.analyticsApiKey ?? "";
    const appStoreId = ios.appStoreId ?? "";

    // ── Discover the 14 locale files. ───────────────────────────────────────
    const entries = await readdir(LOCALES_DIR);
    const locales = entries
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""))
        .sort();                                                                 // deterministic order

    // Parse every locale up-front (need en.json reference + parity + copy).
    /** @type {Record<string, object>} */
    const parsed = {};
    for (const lang of locales)
    {
        const text = await readFile(join(LOCALES_DIR, `${lang}.json`), "utf8");
        parsed[lang] = JSON.parse(text);
    }

    if (!parsed.en)
    {
        throw new Error("[gen-native-config] en.json missing — cannot run parity check");
    }

    // ── PARITY CHECK (before writing any output). ───────────────────────────
    const refKeys = flattenKeys(parsed.en);
    const parityErrorLines = computeParityErrors(parsed);

    if (parityErrorLines.length > 0)
    {
        throw new Error(
            `[gen-native-config] locale parity FAILED against en.json (${refKeys.size} keys):\n  ` +
            parityErrorLines.join("\n  ")
        );
    }
    console.log(`[gen-native-config] parity OK — ${locales.length} locales, ${refKeys.size} keys`);

    // ── 1. LOCALE → NATIVE (copy full file verbatim to both trees). ─────────
    const iosLocalesDir = join(IOS_RES_DIR, "locales");
    const androidLocalesDir = join(ANDROID_ASSETS_DIR, "locales");
    await mkdir(iosLocalesDir, { recursive: true });
    await mkdir(androidLocalesDir, { recursive: true });
    for (const lang of locales)
    {
        const src = join(LOCALES_DIR, `${lang}.json`);
        await copyFile(src, join(iosLocalesDir, `${lang}.json`));
        await copyFile(src, join(androidLocalesDir, `${lang}.json`));
    }
    emitted.push(`${iosLocalesDir}/<${locales.length} locales>.json`);
    emitted.push(`${androidLocalesDir}/<${locales.length} locales>.json`);
    console.log(`[gen-native-config] locales → ${locales.length} files × 2 trees`);

    // ── 3. BOOT STRINGS (warn+skip if missing). ─────────────────────────────
    if (existsSync(BOOT_STRINGS_SRC))
    {
        const a = await copyInto(BOOT_STRINGS_SRC, IOS_RES_DIR, "boot-strings.json");
        const b = await copyInto(BOOT_STRINGS_SRC, ANDROID_ASSETS_DIR, "boot-strings.json");
        emitted.push(a, b);
        console.log(`[gen-native-config] boot-strings.json → 2 trees`);
    }
    else
    {
        console.warn(`[gen-native-config] skip boot-strings: source missing (${BOOT_STRINGS_SRC}) — run extract-boot-strings.js first`);
    }

    // ── 1b. InfoPlist.strings — per-locale CFBundleDisplayName (iOS only). ────
    /**
     * Locale key → iOS .lproj region code.
     * All other locale keys map 1:1 to their own region code.
     * @type {Record<string, string>}
     */
    const LOCALE_TO_REGION = { "zh-CN": "zh-Hans", "zh-TW": "zh-Hant" };

    /**
     * Escape a value for use inside an InfoPlist.strings quoted string.
     * Escapes backslash then double-quote.
     * @param {string} value
     * @returns {string}
     */
    function escapePlistString(value)
    {
        return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    }

    const fallbackAppName = parsed.en.shared.ui.appName;
    for (const lang of locales)
    {
        const region = LOCALE_TO_REGION[lang] ?? lang;
        const appName = parsed[lang]?.shared?.ui?.appName ?? fallbackAppName;
        const lprojDir = join(IOS_APP_DIR, `${region}.lproj`);
        await mkdir(lprojDir, { recursive: true });
        const stringsPath = join(lprojDir, "InfoPlist.strings");
        await writeFile(stringsPath, `"CFBundleDisplayName" = "${escapePlistString(appName)}";\n`, "utf8");
        emitted.push(stringsPath);
    }
    console.log(`[gen-native-config] InfoPlist.strings → ${locales.length} .lproj dirs (iOS)`);

    // ── 2. VERSION → Info.plist + build.gradle. ─────────────────────────────
    const infoPlistPath = join(IOS_APP_DIR, "Info.plist");
    let infoPlist = await readFile(infoPlistPath, "utf8");
    infoPlist = infoPlist.replace(
        /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]*(<\/string>)/,
        `$1${versionIOS}$2`
    );
    infoPlist = infoPlist.replace(
        /(<key>CFBundleVersion<\/key>\s*<string>)[^<]*(<\/string>)/,
        `$1${versionIOSBuild}$2`
    );
    await writeFile(infoPlistPath, infoPlist);
    emitted.push(infoPlistPath);
    console.log(`[gen-native-config] iOS version → ${versionIOS} (build ${versionIOSBuild})`);

    const buildGradlePath = join(ANDROID_APP_DIR, "build.gradle");
    let buildGradle = await readFile(buildGradlePath, "utf8");
    buildGradle = buildGradle.replace(
        /(\bversionCode\s+)\d+/,
        `$1${versionAndroidCode}`
    );
    buildGradle = buildGradle.replace(
        /(\bversionName\s+")[^"]*(")/,
        `$1${versionAndroid}$2`
    );
    await writeFile(buildGradlePath, buildGradle);
    emitted.push(buildGradlePath);
    console.log(`[gen-native-config] Android version → ${versionAndroid} (code ${versionAndroidCode})`);

    // ── 4. UX-MODE + PLATFORM CONSTANTS. ────────────────────────────────────
    const iosHeader =
`/*
 * MPSBuildConfig.h — AUTO-GENERATED by scripts/gen-native-config.js — DO NOT EDIT BY HAND.
 * Compile-time UX-mode + platform constants for the native iOS build.
 */
#ifndef MPSBuildConfig_h
#define MPSBuildConfig_h

#define MPS_UX_MODE "mobile"
#define MPS_PLATFORM "ios"
#define MPS_APP_VERSION "${versionIOS}"
#define MPS_ANALYTICS_API_KEY "${analyticsApiKeyB64Ios}"
#define MPS_APPSTORE_ID "${appStoreId}"
#define MPS_EASY_EDITOR_ENABLED ${easyEditorEnabled ? 1 : 0}

#endif /* MPSBuildConfig_h */
`;
    const iosHeaderPath = join(IOS_APP_DIR, "MPSBuildConfig.h");
    await writeFile(iosHeaderPath, iosHeader);
    emitted.push(iosHeaderPath);

    const androidClass =
`package studio.mangaplay.app;

// AUTO-GENERATED by scripts/gen-native-config.js — DO NOT EDIT BY HAND.
// Compile-time UX-mode + platform constants for the native Android build.
public final class MPSBuildConfig
{
    private MPSBuildConfig() {}

    public static final String MPS_UX_MODE = "mobile";
    public static final String MPS_PLATFORM = "android";
    public static final String MPS_APP_VERSION = "${versionAndroid}";
    public static final String MPS_ANALYTICS_API_KEY = "${analyticsApiKeyB64Android}";
    public static final boolean MPS_EASY_EDITOR_ENABLED = ${easyEditorEnabled};
}
`;
    await mkdir(ANDROID_JAVA_PKG_DIR, { recursive: true });
    const androidClassPath = join(ANDROID_JAVA_PKG_DIR, "MPSBuildConfig.java");
    await writeFile(androidClassPath, androidClass);
    emitted.push(androidClassPath);
    console.log(`[gen-native-config] build config → MPSBuildConfig.h + MPSBuildConfig.java`);

    // ── 5. FIREBASE (warn+skip per file if missing). ────────────────────────
    const iosPlistSrc = join(FIREBASE_DIR, "GoogleService-Info.plist");
    if (existsSync(iosPlistSrc))
    {
        const dst = await copyInto(iosPlistSrc, IOS_APP_DIR, "GoogleService-Info.plist");
        emitted.push(dst);
        console.log(`[gen-native-config] firebase iOS → ${dst}`);
    }
    else
    {
        console.warn(`[gen-native-config] skip firebase iOS: source missing (${iosPlistSrc})`);
    }

    const androidGsSrc = join(FIREBASE_DIR, "google-services.json");
    if (existsSync(androidGsSrc))
    {
        const dst = await copyInto(androidGsSrc, ANDROID_APP_DIR, "google-services.json");
        emitted.push(dst);
        console.log(`[gen-native-config] firebase Android → ${dst}`);
    }
    else
    {
        console.warn(`[gen-native-config] skip firebase Android: source missing (${androidGsSrc})`);
    }

    // ── 6. IAP / ADMOB / SKINS source JSON → config/ in both trees. ─────────
    const configSources = [
        { src: join(CONFIGS_DIR, "iap", "products.json"), name: "products.json" },
        { src: join(CONFIGS_DIR, "admob", "admob.json"), name: "admob.json" },
        { src: join(CONFIGS_DIR, "skins", "skins.json"), name: "skins.json" }
    ];
    const iosConfigDir = join(IOS_RES_DIR, "config");
    const androidConfigDir = join(ANDROID_ASSETS_DIR, "config");
    for (const { src, name } of configSources)
    {
        if (!existsSync(src))
        {
            console.warn(`[gen-native-config] skip config ${name}: source missing (${src})`);
            continue;
        }
        const a = await copyInto(src, iosConfigDir, name);
        const b = await copyInto(src, androidConfigDir, name);
        emitted.push(a, b);
        console.log(`[gen-native-config] config ${name} → 2 trees`);
    }

    // ── Summary. ────────────────────────────────────────────────────────────
    console.log(`\n[gen-native-config] DONE — ${emitted.length} paths emitted:`);
    for (const p of emitted)
    {
        console.log(`  ${p}`);
    }
}

if (import.meta.main)
{
    main().catch((e) =>
    {
        console.error("[gen-native-config] failed:", e && e.message ? e.message : e);
        process.exit(1);
    });
}

export { main };
