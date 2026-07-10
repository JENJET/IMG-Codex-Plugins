#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const CONFIG_PATH = join(homedir(), ".codex", "api-image-gen-config.json");
const DEFAULT_API_CONFIG = {
  apiRoot: "https://api.openai.com",
  imageRequestMode: "openai",
  responsesPath: "/v1/responses",
  imageGenerationPath: "/v1/images/generations",
  imageEditPath: "/v1/images/edits",
  textModel: "gpt-5.5",
  imageModel: "gpt-image-2",
  imageQuality: "auto",
};
const NO_PROMPT_REVISION_INSTRUCTIONS = "You are a tool runner. Pass the user prompt to image_generation VERBATIM. DO NOT rewrite, expand, polish, or revise it in any way. Use the exact text the user gave.";

const MAX_GENERATION_COUNT = 9;
const MAX_REPEAT = 50;
const MAX_CONCURRENCY = 9;
const MAX_EDIT_COUNT = 4;
const MAX_BATCH_PROMPTS = 20;
const MAX_EDIT_SOURCES = 10;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 15_000;
const REQUEST_TIMEOUT_MS = 300_000;
const RESPONSES_REJECT_STATUSES = new Set([400, 404, 405, 415, 422]);
const RESPONSES_POLL_INTERVAL_MS = 5_000;
const RESPONSES_POLL_TIMEOUT_MS = 1_500_000;
const RESPONSES_POLL_MAX_TRANSIENT_FAILURES = 5;
const SUPPORTED_RATIOS = [
  "1:1",
  "3:2",
  "2:3",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
  "2:1",
  "1:2",
  "7:4",
  "4:7",
];
const DISABLED_RATIOS = new Set(["5:4", "4:5", "3:1", "1:3"]);

const SIZE_MATRIX = {
  "1K": {
    "1:1": "1024x1024",
    "3:2": "1536x1024",
    "2:3": "1024x1536",
    "4:3": "1536x1152",
    "3:4": "1152x1536",
    "5:4": "1520x1216",
    "4:5": "1216x1520",
    "16:9": "1536x864",
    "9:16": "864x1536",
    "2:1": "1536x768",
    "1:2": "768x1536",
    "3:1": "1536x512",
    "1:3": "512x1536",
    "7:4": "1664x944",
    "4:7": "944x1664",
  },
  "2K": {
    "1:1": "2048x2048",
    "3:2": "2048x1360",
    "2:3": "1360x2048",
    "4:3": "2048x1536",
    "3:4": "1536x2048",
    "5:4": "2040x1632",
    "4:5": "1632x2040",
    "16:9": "2048x1152",
    "9:16": "1152x2048",
    "2:1": "2048x1024",
    "1:2": "1024x2048",
    "3:1": "2040x680",
    "1:3": "680x2040",
    "7:4": "2208x1264",
    "4:7": "1264x2208",
  },
  "4K": {
    "1:1": "2880x2880",
    "3:2": "3520x2352",
    "2:3": "2352x3520",
    "4:3": "3840x2880",
    "3:4": "2880x3840",
    "5:4": "3840x3072",
    "4:5": "3072x3840",
    "16:9": "3840x2160",
    "9:16": "2160x3840",
    "2:1": "3840x1920",
    "1:2": "1920x3840",
    "3:1": "3840x1280",
    "1:3": "1280x3840",
    "7:4": "3808x2176",
    "4:7": "2176x3808",
  },
};

const DEFAULTS = {
  quality: "2K",
  ratio: "1:1",
  count: 1,
  concurrency: 3,
};
const DEFAULT_ENABLED_QUALITIES = new Set(["1K", "2K"]);
const SUPPORTED_IMAGE_REQUEST_MODES = new Set(["openai", "openai-responses"]);
const SUPPORTED_IMAGE_QUALITIES = new Set(["auto", "low", "medium", "high"]);
const API_SIZE_LIMIT_NOTICE = "由于上游请求限制只能接收1K图像，详细计费以后台为准。";
const LOCKED_IMAGE_REQUEST_MODE_RULES = [
  {
    mode: "openai-responses",
    names: new Set(["fhl", "hfl"]),
    hosts: new Set(["www.fhl.mom"]),
    roots: new Set(["https://www.fhl.mom"]),
  },
];

const RATIO_ALIASES = {
  square: "1:1",
  landscape: "4:3",
  portrait: "3:4",
};

function loadConfig(configPath = CONFIG_PATH) {
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

function saveConfig(config, configPath = CONFIG_PATH) {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function getApiKey(config, flags = {}) {
  const apiKey = resolveApiKey(flags, config);
  if (!apiKey) {
    const selection = resolveApiProfileSelection(flags, config);
    const profileNames = Object.keys(apiProfiles(config));
    if (!selection.name && profileNames.length > 1) {
      console.error("ERROR: Multiple API profiles are configured. Set defaultApi in the config file or pass --api-profile <name>.");
      process.exit(1);
    }
    const profileText = selection.name ? ` for profile "${selection.name}"` : "";
    const commandHint = selection.name ? `Run --api-profile ${selection.name} --set-key <key> first.` : "Run --set-key <key> first.";
    console.error(`ERROR: API key is not configured${profileText}. ${commandHint}`);
    process.exit(1);
  }
  return apiKey;
}

function normalizeConfigString(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeImageRequestMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["responses", "rs", "openai-rs"].includes(normalized)) return "openai-responses";
  if (["images", "standard", "openai-standard"].includes(normalized)) return "openai";
  return SUPPORTED_IMAGE_REQUEST_MODES.has(normalized) ? normalized : null;
}

function normalizeImageQuality(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return SUPPORTED_IMAGE_QUALITIES.has(normalized) ? normalized : null;
}

function imageQualityForRequest(apiConfig = {}) {
  const quality = normalizeImageQuality(apiConfig.imageQuality);
  return quality && quality !== "auto" ? quality : null;
}

function stripTrailingSlashes(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function urlHostname(value) {
  try {
    return new URL(stripTrailingSlashes(value)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function lockedImageRequestMode(apiRoot = "", profileName = "") {
  const name = String(profileName || "").trim().toLowerCase();
  const root = stripTrailingSlashes(apiRoot).toLowerCase();
  const host = urlHostname(root);
  for (const rule of LOCKED_IMAGE_REQUEST_MODE_RULES) {
    if (rule.names.has(name) || rule.roots.has(root) || (host && rule.hosts.has(host))) return rule.mode;
  }
  return null;
}

function defaultApiPathUrl(apiRoot, path) {
  const base = stripTrailingSlashes(apiRoot || DEFAULT_API_CONFIG.apiRoot);
  for (const prefix of ["/api/v3", "/v1beta", "/v1", "/v2"]) {
    if (base.endsWith(prefix) && path.startsWith(`${prefix}/`)) return `${base}${path.slice(prefix.length)}`;
  }
  return `${base}${path}`;
}

function defaultResponsesUrl(apiRoot) {
  return defaultApiPathUrl(apiRoot, DEFAULT_API_CONFIG.responsesPath);
}

function defaultImageGenerationUrl(apiRoot) {
  return defaultApiPathUrl(apiRoot, DEFAULT_API_CONFIG.imageGenerationPath);
}

function defaultImageEditUrl(apiRoot) {
  return defaultApiPathUrl(apiRoot, DEFAULT_API_CONFIG.imageEditPath);
}

function resolveConfigPath(flags = {}) {
  return flags.configFile || process.env.API_IMAGE_GEN_CONFIG || CONFIG_PATH;
}

function apiProfiles(config = {}) {
  const profiles = config?.apis || config?.apiProfiles;
  return profiles && typeof profiles === "object" && !Array.isArray(profiles) ? profiles : {};
}

function apiProfileSettings(profile = {}) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return {};
  const nested = profile?.api && typeof profile.api === "object" ? profile.api : {};
  const merged = { ...nested, ...profile };
  delete merged.api;
  return merged;
}

function resolveApiProfileSelection(flags = {}, config = {}) {
  const profiles = apiProfiles(config);
  const names = Object.keys(profiles);
  const requested = normalizeConfigString(flags.apiProfile)
    || normalizeConfigString(config?.defaultApi)
    || normalizeConfigString(config?.defaultApiProfile);

  if (requested) {
    return { name: requested, profile: profiles[requested] || {}, exists: !!profiles[requested] };
  }
  if (names.length === 1) {
    return { name: names[0], profile: profiles[names[0]] || {}, exists: true };
  }
  return { name: null, profile: {}, exists: false };
}

function resolveApiConfig(flags = {}, config = {}) {
  const selection = resolveApiProfileSelection(flags, config);
  const selected = apiProfileSettings(selection.profile);
  const stored = config?.api || {};
  const apiRoot = normalizeConfigString(flags.apiRoot)
    || normalizeConfigString(selected.apiRoot)
    || normalizeConfigString(stored.apiRoot)
    || normalizeConfigString(config?.apiRoot)
    || DEFAULT_API_CONFIG.apiRoot;
  const imageRequestMode = normalizeImageRequestMode(flags.imageRequestMode)
    || lockedImageRequestMode(apiRoot, selection.name)
    || normalizeImageRequestMode(selected.imageRequestMode)
    || normalizeImageRequestMode(selected.image_request_mode)
    || normalizeImageRequestMode(stored.imageRequestMode)
    || normalizeImageRequestMode(stored.image_request_mode)
    || normalizeImageRequestMode(config?.imageRequestMode)
    || normalizeImageRequestMode(config?.image_request_mode)
    || DEFAULT_API_CONFIG.imageRequestMode;
  let textModel = DEFAULT_API_CONFIG.textModel;
  for (const source of [flags, selected, stored, config]) {
    if (!source || !Object.prototype.hasOwnProperty.call(source, "textModel")) continue;
    textModel = String(source.textModel ?? "").trim();
    break;
  }
  const imageModel = normalizeConfigString(flags.imageModel)
    || normalizeConfigString(selected.imageModel)
    || normalizeConfigString(stored.imageModel)
    || normalizeConfigString(config?.imageModel)
    || DEFAULT_API_CONFIG.imageModel;
  return {
    profile: selection.name,
    apiRoot,
    imageRequestMode,
    imageGenerationUrl: normalizeConfigString(flags.imageGenerationUrl)
      || normalizeConfigString(selected.imageGenerationUrl)
      || normalizeConfigString(selected.imagesGenerationUrl)
      || normalizeConfigString(selected.imageGenerationEndpoint)
      || normalizeConfigString(stored.imageGenerationUrl)
      || normalizeConfigString(stored.imagesGenerationUrl)
      || normalizeConfigString(stored.imageGenerationEndpoint)
      || normalizeConfigString(config?.imageGenerationUrl)
      || normalizeConfigString(config?.imagesGenerationUrl)
      || normalizeConfigString(config?.imageGenerationEndpoint)
      || defaultImageGenerationUrl(apiRoot),
    imageEditUrl: normalizeConfigString(flags.imageEditUrl)
      || normalizeConfigString(selected.imageEditUrl)
      || normalizeConfigString(selected.imagesEditUrl)
      || normalizeConfigString(selected.imageEditEndpoint)
      || normalizeConfigString(stored.imageEditUrl)
      || normalizeConfigString(stored.imagesEditUrl)
      || normalizeConfigString(stored.imageEditEndpoint)
      || normalizeConfigString(config?.imageEditUrl)
      || normalizeConfigString(config?.imagesEditUrl)
      || normalizeConfigString(config?.imageEditEndpoint)
      || defaultImageEditUrl(apiRoot),
    responsesUrl: normalizeConfigString(flags.responsesUrl)
      || normalizeConfigString(selected.responsesUrl)
      || normalizeConfigString(stored.responsesUrl)
      || normalizeConfigString(config?.responsesUrl)
      || defaultResponsesUrl(apiRoot),
    textModel,
    imageModel,
    imageQuality: normalizeImageQuality(flags.imageQuality)
      || normalizeImageQuality(selected.imageQuality)
      || normalizeImageQuality(selected.image_quality)
      || normalizeImageQuality(stored.imageQuality)
      || normalizeImageQuality(stored.image_quality)
      || normalizeImageQuality(config?.imageQuality)
      || normalizeImageQuality(config?.image_quality)
      || DEFAULT_API_CONFIG.imageQuality,
  };
}

function resolveApiKey(flags = {}, config = {}) {
  const selected = apiProfileSettings(resolveApiProfileSelection(flags, config).profile);
  return normalizeConfigString(selected.apiKey)
    || normalizeConfigString(selected.key)
    || normalizeConfigString(config?.apiKey);
}

function hasApiConfigFlag(flags = {}) {
  return ["apiRoot", "imageRequestMode", "imageGenerationUrl", "imageEditUrl", "responsesUrl", "textModel", "imageModel", "imageQuality"].some((key) => flags[key] != null);
}

function applyApiConfigFlags(config, flags = {}) {
  const profileName = normalizeConfigString(flags.apiProfile);
  const source = profileName ? apiProfileSettings(apiProfiles(config)[profileName]) : config?.api;
  const next = { ...(source || {}) };
  delete next.api;
  delete next.apiKey;
  delete next.key;
  delete next.imageModelAsTopLevel;
  if (flags.apiRoot != null) {
    next.apiRoot = normalizeConfigString(flags.apiRoot);
    if (flags.imageGenerationUrl == null) delete next.imageGenerationUrl;
    if (flags.imageEditUrl == null) delete next.imageEditUrl;
    if (flags.responsesUrl == null) delete next.responsesUrl;
  }
  if (flags.imageGenerationUrl != null) next.imageGenerationUrl = normalizeConfigString(flags.imageGenerationUrl);
  if (flags.imageEditUrl != null) next.imageEditUrl = normalizeConfigString(flags.imageEditUrl);
  if (flags.imageRequestMode != null) next.imageRequestMode = normalizeImageRequestMode(flags.imageRequestMode);
  if (flags.responsesUrl != null) next.responsesUrl = normalizeConfigString(flags.responsesUrl);
  if (Object.prototype.hasOwnProperty.call(flags, "textModel")) next.textModel = String(flags.textModel ?? "").trim();
  if (flags.imageModel != null) next.imageModel = normalizeConfigString(flags.imageModel);
  if (flags.imageQuality != null) next.imageQuality = normalizeImageQuality(flags.imageQuality);
  for (const [key, value] of Object.entries(next)) {
    if (value == null || (value === "" && key !== "textModel")) delete next[key];
  }
  if (profileName) {
    if (!config.apis || typeof config.apis !== "object" || Array.isArray(config.apis)) config.apis = {};
    config.apis[profileName] = { ...apiProfileSettings(apiProfiles(config)[profileName]), ...next };
    if (!normalizeConfigString(config.defaultApi)) config.defaultApi = profileName;
  } else {
    config.api = next;
  }
  return config;
}

function setApiProfileKey(config, profileName, apiKey) {
  if (!profileName) {
    config.apiKey = apiKey;
    return config;
  }
  if (!config.apis || typeof config.apis !== "object" || Array.isArray(config.apis)) config.apis = {};
  config.apis[profileName] = { ...apiProfileSettings(apiProfiles(config)[profileName]), apiKey };
  if (!normalizeConfigString(config.defaultApi)) config.defaultApi = profileName;
  return config;
}

function summarizeApiProfiles(config = {}) {
  const profiles = apiProfiles(config);
  if (Object.keys(profiles).length === 0) return null;
  return Object.fromEntries(Object.keys(profiles).map((name) => {
    const profileConfig = resolveApiConfig({ apiProfile: name }, config);
    const key = resolveApiKey({ apiProfile: name }, config);
    return [name, {
      hasKey: !!key,
      keyPreview: key ? previewKey(key) : null,
      apiRoot: profileConfig.apiRoot,
      imageRequestMode: profileConfig.imageRequestMode,
      imageGenerationUrl: profileConfig.imageGenerationUrl,
      imageEditUrl: profileConfig.imageEditUrl,
      responsesUrl: profileConfig.responsesUrl,
      textModel: profileConfig.textModel,
      imageModel: profileConfig.imageModel,
      imageQuality: profileConfig.imageQuality,
    }];
  }));
}

function previewKey(key) {
  if (!key) return null;
  if (key.length <= 12) return `${key.slice(0, 4)}...${key.slice(-2)}`;
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

function cloneSizeMatrix() {
  return Object.fromEntries(
    Object.entries(SIZE_MATRIX)
      .filter(([quality]) => DEFAULT_ENABLED_QUALITIES.has(quality))
      .map(([quality, sizes]) => [quality, { ...sizes }]),
  );
}

function normalizeQualityKey(quality) {
  const normalized = String(quality || "").trim().toUpperCase();
  return normalized || null;
}

function customSizeEntries(rawEntries) {
  if (!rawEntries) return [];
  if (Array.isArray(rawEntries)) {
    return rawEntries
      .map((entry) => {
        if (typeof entry === "string") return { label: entry, size: entry };
        if (!entry || typeof entry !== "object") return null;
        return {
          label: entry.label || entry.name || entry.aspect || entry.ratio || entry.size,
          size: entry.size || entry.value || entry.dimensions || entry.label || entry.name,
        };
      })
      .filter(Boolean);
  }
  if (typeof rawEntries === "object") {
    return Object.entries(rawEntries).map(([label, size]) => {
      if (!size || typeof size !== "object") return { label, size };
      return {
        label: size.label || size.name || size.aspect || size.ratio || label,
        size: size.size || size.value || size.dimensions || label,
      };
    });
  }
  return [];
}

function mergeCustomSizeMatrix(target, customSizes) {
  if (!customSizes || typeof customSizes !== "object") return target;

  if (Array.isArray(customSizes)) {
    for (const entry of customSizes) {
      if (!entry || typeof entry !== "object") continue;
      const quality = normalizeQualityKey(entry.quality || DEFAULTS.quality);
      if (!quality) continue;
      const size = normalizeSizeString(entry.size || entry.value || entry.dimensions || entry.label || entry.name);
      if (!size) continue;
      const label = normalizeSizeString(entry.label || entry.name || entry.aspect || entry.ratio || size)
        || normalizeRatio(entry.label || entry.name || entry.aspect || entry.ratio || size);
      if (!label) continue;
      if (!target[quality]) target[quality] = {};
      target[quality][label] = size;
    }
    return target;
  }

  for (const [qualityName, entries] of Object.entries(customSizes)) {
    const quality = normalizeQualityKey(qualityName);
    if (!quality) continue;
    if (!target[quality]) target[quality] = {};
    for (const { label, size } of customSizeEntries(entries)) {
      const normalizedSize = normalizeSizeString(size || label);
      if (!normalizedSize) continue;
      const normalizedLabel = normalizeSizeString(label) || normalizeRatio(label);
      if (!normalizedLabel) continue;
      target[quality][normalizedLabel] = normalizedSize;
    }
  }
  return target;
}

function resolveSizeMatrix(config = {}) {
  const matrix = cloneSizeMatrix();
  mergeCustomSizeMatrix(matrix, config.sizeMatrix);
  mergeCustomSizeMatrix(matrix, config.sizes);
  return matrix;
}

function normalizeQuality(quality, sizeMatrix = resolveSizeMatrix()) {
  const normalized = normalizeQualityKey(quality);
  return normalized && sizeMatrix[normalized] ? normalized : DEFAULTS.quality;
}

function shouldWarnUnsupportedQuality(quality, sizeMatrix = resolveSizeMatrix()) {
  const normalized = normalizeQualityKey(quality);
  return !!normalized && !sizeMatrix[normalized];
}

function normalizeRatio(ratio) {
  const normalized = String(ratio || "").trim().toLowerCase();
  return RATIO_ALIASES[normalized] || normalized;
}

function ratioLabel(ratio) {
  const canonical = normalizeRatio(ratio);
  const alias = Object.entries(RATIO_ALIASES).find(([, value]) => value === canonical)?.[0];
  return alias ? `${canonical} (${alias})` : canonical;
}

function supportedRatiosForQuality(quality, sizeMatrix = resolveSizeMatrix()) {
  return Object.keys(sizeMatrix[quality] || {}).filter((ratio) => !isDisabledRatio(ratio));
}

function supportedRatioText(quality = null, sizeMatrix = resolveSizeMatrix()) {
  const normalizedQuality = quality ? normalizeQuality(quality, sizeMatrix) : null;
  if (normalizedQuality) return supportedRatiosForQuality(normalizedQuality, sizeMatrix).join(", ");

  const ratios = [];
  for (const qualityName of Object.keys(sizeMatrix)) {
    for (const ratio of supportedRatiosForQuality(qualityName, sizeMatrix)) {
      if (!ratios.includes(ratio)) ratios.push(ratio);
    }
  }
  return ratios.join(", ");
}

function normalizeSizeString(size) {
  const parsed = parseSizeForAspect(size);
  if (!parsed) return null;
  return `${parsed.width}x${parsed.height}`;
}

function aspectRatioForSize(size) {
  const parsed = parseSizeForAspect(size);
  if (!parsed) return null;
  const divisor = gcd(parsed.width, parsed.height);
  if (!divisor) return null;
  return `${parsed.width / divisor}:${parsed.height / divisor}`;
}

function aspectLabelForSize(size) {
  const normalized = normalizeSizeString(size);
  return normalized || aspectRatioForSize(size);
}

function supportedAspectFromSize(size) {
  const aspect = aspectLabelForSize(size);
  return SUPPORTED_RATIOS.includes(aspect) ? aspect : null;
}

function isDisabledRatio(ratio) {
  return DISABLED_RATIOS.has(normalizeRatio(ratio));
}

function resolveSize(quality, ratio, explicitSize = null, sizeMatrix = resolveSizeMatrix()) {
  if (explicitSize) return normalizeSizeString(explicitSize);
  const normalizedQuality = normalizeQuality(quality, sizeMatrix);
  const normalizedRatio = normalizeRatio(ratio);
  if (!normalizedQuality) return null;
  return sizeMatrix[normalizedQuality]?.[normalizedRatio] || null;
}

function clampInteger(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(n, max));
}

function timestamp() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
    "_",
    String(d.getHours()).padStart(2, "0"),
    String(d.getMinutes()).padStart(2, "0"),
    String(d.getSeconds()).padStart(2, "0"),
  ].join("");
}

function resolveOutputDir(userDir) {
  const dir = userDir || join(homedir(), "Pictures", "api-image-gen");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function imageMimeTypeFromPath(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/png";
}

function imageExtensionForMimeType(mimeType) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

function imageDataURLFromBuffer(buffer, mimeType) {
  return `data:${mimeType || "image/png"};base64,${buffer.toString("base64")}`;
}

function normalizeBase64Image(value) {
  if (!value || typeof value !== "string") return "";
  const comma = value.indexOf(",");
  return comma >= 0 ? value.slice(comma + 1) : value;
}

function mimeTypeFromDataURL(value) {
  const match = /^data:([^;,]+)[;,]/i.exec(String(value || ""));
  return match ? match[1].toLowerCase() : "";
}

function formatErrorResponse(status, body) {
  if (!body) return `HTTP ${status}`;
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  if (parsed?.cloudflare_error || parsed?.error_code || parsed?.error_name) {
    const title = parsed.title || parsed.error_name || "Cloudflare error";
    const retryAfter = parsed.retry_after ? ` retry_after=${parsed.retry_after}s` : "";
    return `HTTP ${status}: ${title}${retryAfter}`;
  }
  const lower = body.toLowerCase();
  if (lower.includes("bad gateway") || lower.includes("error code 502")) return `HTTP ${status}: Cloudflare Bad Gateway`;
  if (lower.includes("gateway time-out") || lower.includes("error code 504")) return `HTTP ${status}: Cloudflare Gateway Timeout`;
  if (lower.includes("a timeout occurred") || lower.includes("error code 524")) return `HTTP ${status}: Cloudflare Timeout`;
  if (parsed) {
    const message = parsed?.error?.message || parsed?.message || body;
    return `HTTP ${status}: ${message}`;
  }
  return `HTTP ${status}: ${body}`;
}

async function requestWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function responsesHeaders(apiKey, accept = "application/json") {
  return {
    "Content-Type": "application/json",
    Accept: accept,
    Authorization: `Bearer ${apiKey}`,
  };
}

function responseTextError(error, timeoutMs = REQUEST_TIMEOUT_MS) {
  return error?.name === "AbortError" ? `Timeout (${timeoutMs / 1000}s)` : error?.message || String(error);
}

function imageExtensionFromContentType(contentType) {
  const type = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (type === "image/jpeg") return "jpg";
  if (type === "image/webp") return "webp";
  if (type === "image/gif") return "gif";
  return "png";
}

function imageExtensionFromUrl(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "jpg";
    if (path.endsWith(".webp")) return "webp";
    if (path.endsWith(".gif")) return "gif";
  } catch {
    // Use PNG as the safest default for image-generation APIs.
  }
  return "png";
}

async function downloadImageOutput(url) {
  let res;
  try {
    res = await requestWithTimeout(url, { method: "GET" }, REQUEST_TIMEOUT_MS);
  } catch (error) {
    return { ok: false, error: responseTextError(error) };
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    return { ok: false, error: formatErrorResponse(res.status, buffer.toString("utf8").slice(0, 1000)) };
  }
  const contentType = res.headers.get("content-type") || "";
  const extension = contentType.startsWith("image/")
    ? imageExtensionFromContentType(contentType)
    : imageExtensionFromUrl(url);
  return { ok: true, buffer, extension };
}

async function saveImageOutput(output, outputDir, prefix, index = null, targetSize = null) {
  if (!output) return null;
  if (typeof output === "string") return saveBase64Image(output, outputDir, prefix, index, targetSize);
  if (output.type === "base64" || output.type === "b64") {
    const extension = imageExtensionForMimeType(output.mimeType || output.mime_type || mimeTypeFromDataURL(output.value));
    return saveImageBuffer(Buffer.from(normalizeBase64Image(output.value), "base64"), outputDir, prefix, index, targetSize, extension);
  }
  if (output.type === "url") {
    if (String(output.value || "").startsWith("data:image/")) {
      return saveBase64Image(output.value, outputDir, prefix, index, targetSize);
    }
    const downloaded = await downloadImageOutput(output.value);
    if (!downloaded.ok) return { error: `Image URL download failed: ${downloaded.error}` };
    return saveImageBuffer(downloaded.buffer, outputDir, prefix, index, targetSize, downloaded.extension);
  }
  return null;
}

async function saveFirstImageOutput(outputs, outputDir, prefix, index = null, targetSize = null) {
  const candidates = Array.isArray(outputs) ? outputs : [outputs];
  let lastError = "";
  for (const output of candidates.filter(Boolean)) {
    const saved = await saveImageOutput(output, outputDir, prefix, index, targetSize);
    if (saved && !saved.error) return saved;
    if (saved?.error) lastError = saved.error;
  }
  return lastError ? { error: lastError } : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error) {
  const text = String(error || "").toLowerCase();
  return [
    "http 429",
    "rate limit",
    "too many requests",
    "no available account",
    "account pool busy",
    "please retry later",
  ].some((pattern) => text.includes(pattern));
}

function isAmbiguousSubmissionError(error) {
  const text = String(error || "").toLowerCase();
  return [
    "timeout",
    "http 502",
    "http 503",
    "http 504",
    "http 524",
    "bad gateway",
    "service unavailable",
    "gateway timeout",
    "cloudflare timeout",
    "fetch failed",
    "socket hang up",
    "econnreset",
    "terminated",
    "no image_generation_call result",
  ].some((pattern) => text.includes(pattern));
}

function isFatalError(error) {
  const text = String(error || "").toLowerCase();
  if (isRetryableError(text)) return false;
  return [
    "http 400",
    "http 401",
    "http 403",
    "http 404",
    "http 422",
    "unauthorized",
    "forbidden",
    "invalid api key",
    "incorrect api key",
    "missing api key",
    "invalid parameter",
    "invalid_request",
    "unsupported",
    "model not found",
    "content policy",
    "safety policy",
    "moderation",
  ].some((pattern) => text.includes(pattern));
}

function safeImageExtension(extension) {
  const normalized = String(extension || "png").toLowerCase().replace(/^\./, "");
  return ["png", "jpg", "jpeg", "webp", "gif"].includes(normalized) ? normalized : "png";
}

function saveImageBuffer(buffer, outputDir, prefix, index = null, targetSize = null, extension = "png") {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const suffix = Math.random().toString(36).slice(2, 6);
  const numbered = index == null ? "" : `_${index}`;
  const baseName = `${prefix}_${timestamp()}${numbered}_${suffix}`;
  const originalPath = join(outputDir, `${baseName}.${safeImageExtension(extension)}`);
  const resizedPath = join(outputDir, `${baseName}_resized.png`);
  writeFileSync(originalPath, buffer);
  const resizeInfo = ensurePngTargetSize(originalPath, targetSize, resizedPath);
  const finalPath = resizeInfo?.path || originalPath;
  const finalBuffer = resizeInfo?.resized ? readFileSync(finalPath) : buffer;
  const dimensions = readPngDimensions(finalBuffer);
  return {
    path: finalPath,
    fileSize: `${(finalBuffer.length / 1024 / 1024).toFixed(2)}MB`,
    width: dimensions?.width || resizeInfo?.width || null,
    height: dimensions?.height || resizeInfo?.height || null,
    dimensions: dimensions ? `${dimensions.width}x${dimensions.height}` : null,
    resized: !!resizeInfo?.resized,
    originalPath: resizeInfo?.originalPath || null,
    originalDimensions: resizeInfo?.originalWidth ? `${resizeInfo.originalWidth}x${resizeInfo.originalHeight}` : null,
    resizeError: resizeInfo?.error || null,
  };
}

function saveBase64Image(base64, outputDir, prefix, index = null, targetSize = null) {
  const clean = normalizeBase64Image(base64);
  if (!clean) return null;
  return saveImageBuffer(Buffer.from(clean, "base64"), outputDir, prefix, index, targetSize, "png");
}

function createResponseTrace(outputDir, prefix, meta = {}) {
  if (!outputDir) return null;
  const suffix = Math.random().toString(36).slice(2, 6);
  const baseName = `${prefix || "response"}_${timestamp()}_${suffix}`;
  return {
    outputDir,
    baseName,
    metadataPath: join(outputDir, `${baseName}_trace.json`),
    responseIds: [],
    files: [],
    errors: [],
    outputPrefix: meta.outputPrefix || null,
    targetSize: normalizeSizeString(meta.targetSize) || null,
  };
}

function hasResponseTraceData(trace) {
  return !!trace && (
    (Array.isArray(trace.responseIds) && trace.responseIds.length > 0)
    || (Array.isArray(trace.files) && trace.files.length > 0)
    || (Array.isArray(trace.errors) && trace.errors.length > 0)
  );
}

function hasRecoverableTraceData(trace) {
  return !!trace && (
    (Array.isArray(trace.responseIds) && trace.responseIds.length > 0)
    || (Array.isArray(trace.files) && trace.files.length > 0)
  );
}

function traceStageSlug(stage) {
  return String(stage || "response").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "response";
}

function addTraceResponseId(trace, id) {
  const clean = String(id || "").trim();
  if (!trace || !clean || trace.responseIds.includes(clean)) return;
  trace.responseIds.push(clean);
}

function collectResponseIds(value, ids = new Set(), isTopLevel = true, parentKey = "") {
  if (!value || typeof value !== "object") return ids;
  if (Array.isArray(value)) {
    for (const child of value) collectResponseIds(child, ids, false, parentKey);
    return ids;
  }
  for (const [key, child] of Object.entries(value)) {
    if (["id", "response_id", "responseId", "responseID", "task_id", "taskId"].includes(key) && typeof child === "string") {
      const clean = child.trim();
      const responseContainer = /response|task/i.test(parentKey);
      if (isTopLevel || clean.startsWith("resp_") || key !== "id" || responseContainer) ids.add(clean);
    } else if (child && typeof child === "object") {
      collectResponseIds(child, ids, false, key);
    }
  }
  return ids;
}

function responseIdsFromRaw(raw) {
  const ids = new Set();
  for (const line of String(raw || "").split(/\r?\n/)) {
    const event = parseSSEEventLine(line);
    if (event) collectResponseIds(event, ids, true);
  }
  const parsed = parseJsonText(raw);
  if (parsed) collectResponseIds(parsed, ids, true);
  return [...ids];
}

function writeResponseTraceMetadata(trace) {
  if (!trace) return false;
  if (!hasResponseTraceData(trace)) {
    if (trace.metadataPath) {
      try {
        unlinkSync(trace.metadataPath);
      } catch {
        // Unrecoverable trace metadata is optional; ignore if it was never written.
      }
    }
    return false;
  }
  const metadata = {
    responseIds: trace.responseIds,
    files: trace.files,
    errors: trace.errors || [],
  };
  if (trace.outputDir) metadata.outputDir = trace.outputDir;
  if (trace.outputPrefix) metadata.outputPrefix = trace.outputPrefix;
  if (trace.targetSize) metadata.targetSize = trace.targetSize;
  writeFileSync(trace.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return true;
}

function recordTraceError(trace, error) {
  if (!trace) return;
  if (!Array.isArray(trace.errors)) trace.errors = [];
  trace.errors.push({
    message: responseTextError(error),
    at: new Date().toISOString(),
  });
  writeResponseTraceMetadata(trace);
}

function recordRawResponse(trace, stage, raw, meta = {}) {
  if (!trace || raw == null) return null;
  const rawText = String(raw);
  for (const id of responseIdsFromRaw(rawText)) addTraceResponseId(trace, id);
  const imageOutputCount = extractImageOutputsFromResponses(rawText).length;
  if (!hasRecoverableTraceData(trace) && imageOutputCount === 0) return null;
  const replaceKey = meta.replaceKey || null;
  let entry = replaceKey ? trace.files.find((item) => item.replaceKey === replaceKey) : null;
  if (!entry) {
    const order = String(trace.files.length + 1).padStart(2, "0");
    entry = {
      stage,
      replaceKey,
      path: join(trace.outputDir, `${trace.baseName}_${order}_${traceStageSlug(stage)}.raw.txt`),
    };
    trace.files.push(entry);
  }
  writeFileSync(entry.path, rawText);
  entry.stage = stage;
  entry.route = meta.route || null;
  entry.httpStatus = meta.httpStatus || null;
  entry.bytes = Buffer.byteLength(rawText);
  entry.imageOutputCount = imageOutputCount;
  entry.updatedAt = new Date().toISOString();
  writeResponseTraceMetadata(trace);
  return entry.path;
}

function responseTraceInfo(trace) {
  if (!trace) return {};
  if (!hasResponseTraceData(trace)) {
    deleteResponseTrace(trace);
    return {};
  }
  if (!writeResponseTraceMetadata(trace)) return {};
  const rawFiles = trace.files.map((item) => item.path).filter(Boolean);
  return {
    responseId: trace.responseIds[0] || null,
    responseTracePath: trace.metadataPath,
    rawResponsePath: rawFiles[rawFiles.length - 1] || null,
  };
}

function deleteResponseTrace(trace) {
  if (!trace) return;
  for (const file of trace.files) {
    if (!file?.path) continue;
    try {
      unlinkSync(file.path);
    } catch {
      // Best-effort cleanup only; successful image generation should not fail on log deletion.
    }
  }
  if (trace.metadataPath) {
    try {
      unlinkSync(trace.metadataPath);
    } catch {
      // Best-effort cleanup only.
    }
  }
  trace.files = [];
}

function formatResponseTrace(result) {
  if (!result?.responseTracePath) return "";
  const id = result.responseId ? `id=${result.responseId}, ` : "";
  const raw = result.rawResponsePath ? `, raw=${result.rawResponsePath}` : "";
  return `${id}trace=${result.responseTracePath}${raw}`;
}

function cleanResponseIds(ids) {
  const seen = new Set();
  const cleaned = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const value = String(id || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    cleaned.push(value);
  }
  return cleaned;
}

function responseTraceBaseName(tracePath) {
  return basename(tracePath).replace(/_trace\.json$/i, "");
}

function outputPrefixForTrace(data, tracePath) {
  const configured = normalizeConfigString(data?.outputPrefix);
  if (configured) return configured;
  const name = responseTraceBaseName(tracePath).toLowerCase();
  if (name.includes("edit")) return "edit";
  if (name.includes("generate")) return "img";
  return "recovered";
}

function loadResponseTraceForRecovery(tracePath, options = {}) {
  if (!existsSync(tracePath)) return { ok: false, error: `Trace file does not exist: ${tracePath}` };
  let data;
  try {
    data = JSON.parse(readFileSync(tracePath, "utf8"));
  } catch (error) {
    return { ok: false, error: `Invalid trace JSON: ${responseTextError(error)}` };
  }

  const responseIds = cleanResponseIds(data?.responseIds);
  const files = Array.isArray(data?.files) ? data.files : [];
  if (responseIds.length === 0 && files.length === 0) {
    return { ok: false, skipped: true, error: `Trace has no responseIds or raw files: ${tracePath}` };
  }

  const outputDir = resolveOutputDir(options.outputDir || data?.outputDir || dirname(tracePath));
  const trace = {
    outputDir,
    baseName: responseTraceBaseName(tracePath),
    metadataPath: tracePath,
    responseIds,
    files,
    errors: Array.isArray(data?.errors) ? data.errors : [],
    outputPrefix: outputPrefixForTrace(data, tracePath),
    targetSize: options.resize === false ? null : normalizeSizeString(data?.targetSize),
  };
  return { ok: true, trace };
}

async function saveFromTraceRawFiles(trace) {
  const files = Array.isArray(trace?.files) ? trace.files : [];
  const errors = [];
  for (const file of files.slice().reverse()) {
    if (!file?.path || !existsSync(file.path)) continue;
    let raw;
    try {
      raw = readFileSync(file.path, "utf8");
    } catch (error) {
      errors.push(`Cannot read raw file ${file.path}: ${responseTextError(error)}`);
      continue;
    }

    const imageOutputs = extractImageOutputsFromResponses(raw);
    if (imageOutputs.length === 0) continue;
    const saved = await saveFirstImageOutput(imageOutputs, trace.outputDir, trace.outputPrefix || "recovered", null, trace.targetSize);
    if (saved?.error) {
      errors.push(`${saved.error} (raw=${file.path})`);
      continue;
    }
    if (saved) return { ok: true, rawResponsePath: file.path, ...saved };
  }
  return { ok: false, error: errors.filter(Boolean).join("; ") || "No image output found in trace raw files" };
}

async function retrieveOpenAIResponse(apiKey, responsesUrl, id, trace = null) {
  const retrieveUrl = `${responsesUrl.replace(/\/+$/, "")}/${encodeURIComponent(id)}`;
  let res;
  try {
    res = await requestWithTimeout(retrieveUrl, {
      method: "GET",
      headers: responsesHeaders(apiKey),
    }, REQUEST_TIMEOUT_MS);
  } catch (error) {
    recordTraceError(trace, error);
    return { ok: false, error: `Responses recover request failed: ${responseTextError(error)} (id=${id})`, responseId: id, route: "recover" };
  }

  const raw = await res.text().catch(() => "");
  recordRawResponse(trace, `recover-${id}`, raw, {
    route: "recover",
    httpStatus: res.status,
    replaceKey: `recover-${id}`,
  });
  if (!res.ok) return { ok: false, error: `${formatErrorResponse(res.status, raw)} (id=${id})`, raw, responseId: id, route: "recover" };

  const data = parseJsonText(raw);
  const status = responseStatus(data);
  if (status === "completed" || (!status && extractImageOutputsFromResponses(raw).length > 0)) {
    return { ok: true, raw, responseId: id, route: "recover" };
  }
  if (isResponsesFailedStatus(status)) {
    return { ok: false, error: `${responsesFailureMessage(data, `Responses task ${status}`)} (id=${id})`, raw, responseId: id, route: "recover" };
  }
  return { ok: false, pending: true, error: `Responses task ${status || "unknown"} is not completed (id=${id})`, raw, responseId: id, route: "recover" };
}

async function recoverResponseTrace(apiKey, responsesUrl, tracePath, options = {}) {
  const loaded = loadResponseTraceForRecovery(tracePath, options);
  if (!loaded.ok) return loaded;
  const { trace } = loaded;
  const errors = [];

  const rawSaved = await saveFromTraceRawFiles(trace);
  if (rawSaved.ok) {
    const recoveredTracePath = trace.metadataPath;
    deleteResponseTrace(trace);
    return { ok: true, recovered: true, recoveredFromRaw: true, recoveredTracePath, ...rawSaved };
  }
  errors.push(rawSaved.error);

  if (trace.responseIds.length > 0 && !apiKey) {
    return {
      ok: false,
      error: "API key is not configured; response-id recovery needs API access, while raw-only recovery did not find a usable image output",
      ...responseTraceInfo(trace),
    };
  }

  for (const id of trace.responseIds) {
    const response = await retrieveOpenAIResponse(apiKey, responsesUrl, id, trace);
    if (!response.ok) {
      errors.push(response.error);
      continue;
    }

    const imageOutputs = extractImageOutputsFromResponses(response.raw);
    const saved = await saveFirstImageOutput(imageOutputs, trace.outputDir, trace.outputPrefix || "recovered", null, trace.targetSize);
    if (saved?.error) {
      errors.push(`${saved.error} (id=${id})`);
      continue;
    }
    if (!saved) {
      errors.push(`No image result in recovered Responses response (id=${id})`);
      continue;
    }

    const recoveredTracePath = trace.metadataPath;
    deleteResponseTrace(trace);
    return { ok: true, recovered: true, responseId: id, recoveredTracePath, ...saved };
  }

  return {
    ok: false,
    error: errors.filter(Boolean).join("; ") || `No recoverable response ids in trace: ${tracePath}`,
    ...responseTraceInfo(trace),
  };
}

function listResponseTracePaths(outputDir) {
  try {
    return readdirSync(outputDir)
      .filter((name) => /_trace\.json$/i.test(name))
      .map((name) => join(outputDir, name));
  } catch {
    return [];
  }
}

async function runRecoverResponseTraces(apiKey, responsesUrl, tracePaths, options = {}) {
  const results = [];
  for (const tracePath of tracePaths) {
    const result = await recoverResponseTrace(apiKey, responsesUrl, tracePath, options);
    results.push({ tracePath, ...result });
  }
  return results;
}

function formatImageResult(result) {
  const parts = [result.fileSize].filter(Boolean);
  if (result.dimensions) parts.push(result.dimensions);
  if (result.resized && result.originalDimensions) parts.push(`resized from ${result.originalDimensions}`);
  if (result.resized && result.originalPath) parts.push(`original saved at ${result.originalPath}`);
  if (result.resizeError) parts.push(`resize warning: ${result.resizeError}`);
  return parts.join(", ");
}

function extractImagesFromResponse(data) {
  const items = Array.isArray(data?.data) ? data.data : [];
  return items
    .map((item) => item?.b64_json || item?.image?.b64_json || item?.base64)
    .filter((item) => typeof item === "string" && item.trim());
}

const IMAGE_OUTPUT_KEY_HINTS = [
  "url",
  "image_url",
  "imageUrl",
  "image",
  "output_url",
  "outputUrl",
  "result_url",
  "resultUrl",
  "download_url",
  "downloadUrl",
  "asset_url",
  "assetUrl",
];
const IMAGE_CONTAINER_KEY_HINTS = [
  "images",
  "image",
  "output",
  "outputs",
  "result",
  "results",
  "data",
  "items",
  "files",
  "content",
  "text",
  "output_text",
  "message",
  "response",
];
const IMAGE_BASE64_KEY_HINTS = ["b64_json", "base64", "image_base64", "imageBase64"];

function looksLikeGeneratedImageUrl(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (text.startsWith("data:image/")) return true;
  if (!/^https?:\/\//i.test(text)) return false;
  const clean = text.split("?", 1)[0].split("#", 1)[0].toLowerCase();
  return /\.(png|jpe?g|webp|gif|bmp|tiff?)$/.test(clean);
}

function imageOutputFromText(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (looksLikeGeneratedImageUrl(text)) return { type: "url", value: text };
  const markdown = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/i.exec(text);
  if (markdown && looksLikeGeneratedImageUrl(markdown[1])) return { type: "url", value: markdown[1] };
  const bare = /https?:\/\/[^\s)"'<>]+\.(?:png|jpe?g|webp|gif|bmp|tiff?)(?:\?[^\s)"'<>]*)?/i.exec(text);
  if (bare) return { type: "url", value: bare[0] };
  return null;
}

function addImageOutput(outputs, seen, output) {
  if (!output?.value) return;
  const type = output.type === "b64" ? "base64" : output.type;
  const item = { ...output, type };
  const key = `${item.type}:${item.value}`;
  if (seen.has(key)) return;
  seen.add(key);
  outputs.push(item);
}

function collectImageOutputs(value, outputs, seen, depth = 0) {
  if (depth > 8 || value == null) return;
  if (typeof value === "string") {
    const output = imageOutputFromText(value);
    if (output) addImageOutput(outputs, seen, output);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectImageOutputs(item, outputs, seen, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  const candidates = value.candidates;
  if (Array.isArray(candidates)) {
    for (const candidate of candidates) {
      const parts = candidate?.content?.parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        const inline = part?.inlineData || part?.inline_data;
        const data = inline?.data;
        if (typeof data === "string" && data.trim()) {
          addImageOutput(outputs, seen, {
            type: "base64",
            value: data.trim(),
            mimeType: inline?.mimeType || inline?.mime_type || "image/png",
          });
        }
      }
    }
  }

  if (value.type === "image_generation_call") {
    const result = value.result;
    if (typeof result === "string" && result.trim()) {
      addImageOutput(outputs, seen, {
        type: "base64",
        value: result.trim(),
        mimeType: value.mime_type || value.mimeType || "image/png",
      });
    } else {
      collectImageOutputs(result, outputs, seen, depth + 1);
    }
  }

  for (const key of IMAGE_BASE64_KEY_HINTS) {
    const item = value[key];
    if (typeof item === "string" && item.trim()) {
      addImageOutput(outputs, seen, {
        type: "base64",
        value: item.trim(),
        mimeType: value.mime_type || value.mimeType || "image/png",
      });
    }
  }
  for (const key of IMAGE_OUTPUT_KEY_HINTS) {
    collectImageOutputs(value[key], outputs, seen, depth + 1);
  }
  for (const key of IMAGE_CONTAINER_KEY_HINTS) {
    collectImageOutputs(value[key], outputs, seen, depth + 1);
  }
}

function extractImageOutputsFromImagesResponse(data) {
  const outputs = [];
  collectImageOutputs(data, outputs, new Set());
  return outputs;
}

function extractImageOutputsFromResponses(raw) {
  const outputs = [];
  const seen = new Set();
  for (const base64 of extractImagesFromResponses(raw)) {
    addImageOutput(outputs, seen, { type: "base64", value: base64 });
  }
  for (const line of String(raw || "").split(/\r?\n/)) {
    const event = parseSSEEventLine(line);
    if (event) collectImageOutputs(event, outputs, seen);
  }
  const parsed = parseJsonText(raw);
  if (parsed) collectImageOutputs(parsed, outputs, seen);
  return outputs;
}

function parseSSEEventLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data: ")) return null;
  const payload = trimmed.slice(6).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function walkForImageGenerationCall(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = walkForImageGenerationCall(child);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    if (value.type === "image_generation_call" && value.result) return value;
    for (const child of Object.values(value)) {
      const found = walkForImageGenerationCall(child);
      if (found) return found;
    }
  }
  return null;
}

function extractImagesFromResponses(raw) {
  const images = [];
  const partialImages = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    const event = parseSSEEventLine(line);
    if (!event) continue;
    if (event?.type === "response.output_item.done" && event?.item?.type === "image_generation_call" && event.item.result) {
      images.push(event.item.result);
      continue;
    }
    if (String(event?.type || "").endsWith("partial_image") && typeof event?.partial_image_b64 === "string" && event.partial_image_b64) {
      partialImages.push(event.partial_image_b64);
      continue;
    }
    const found = walkForImageGenerationCall(event);
    if (found?.result) images.push(found.result);
  }

  if (images.length > 0) return images;
  if (partialImages.length > 0) return [partialImages[partialImages.length - 1]];
  try {
    const parsed = JSON.parse(raw);
    const found = walkForImageGenerationCall(parsed);
    if (found?.result) return [found.result];
    const imageData = extractImagesFromResponse(parsed);
    if (imageData.length > 0) return imageData;
  } catch {
    // The normal Responses path is SSE, so raw JSON is only a fallback.
  }
  return [];
}

function parseSizeForAspect(size) {
  const match = /^(\d+)\s*(?:x|X|\*|×)\s*(\d+)$/.exec(String(size || "").trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function readPngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  const hasSignature = buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a;
  if (!hasSignature || buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function powershellSingleQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function resizePngWithPowerShell(path, width, height, outputPath = path) {
  const command = `
$ErrorActionPreference = 'Stop'
$Path = ${powershellSingleQuoted(path)}
$OutputPath = ${powershellSingleQuoted(outputPath)}
$TargetWidth = ${width}
$TargetHeight = ${height}
Add-Type -AssemblyName System.Drawing
$image = [System.Drawing.Image]::FromFile($Path)
$bitmap = $null
$graphics = $null
$tmp = "$OutputPath.tmp.png"
try {
  $sourceWidth = $image.Width
  $sourceHeight = $image.Height
  $targetRatio = $TargetWidth / $TargetHeight
  $sourceRatio = $sourceWidth / $sourceHeight
  if ($sourceRatio -gt $targetRatio) {
    $cropHeight = $sourceHeight
    $cropWidth = [int][Math]::Round($sourceHeight * $targetRatio)
    $cropX = [int][Math]::Floor(($sourceWidth - $cropWidth) / 2)
    $cropY = 0
  } else {
    $cropWidth = $sourceWidth
    $cropHeight = [int][Math]::Round($sourceWidth / $targetRatio)
    $cropX = 0
    $cropY = [int][Math]::Floor(($sourceHeight - $cropHeight) / 2)
  }
  $bitmap = New-Object System.Drawing.Bitmap $TargetWidth, $TargetHeight
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $dest = New-Object System.Drawing.Rectangle 0, 0, $TargetWidth, $TargetHeight
  $source = New-Object System.Drawing.Rectangle $cropX, $cropY, $cropWidth, $cropHeight
  $graphics.DrawImage($image, $dest, $source, [System.Drawing.GraphicsUnit]::Pixel)
  $graphics.Dispose(); $graphics = $null
  $image.Dispose(); $image = $null
  $bitmap.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose(); $bitmap = $null
  Move-Item -LiteralPath $tmp -Destination $OutputPath -Force
} finally {
  if ($graphics -ne $null) { $graphics.Dispose() }
  if ($bitmap -ne $null) { $bitmap.Dispose() }
  if ($image -ne $null) { $image.Dispose() }
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
}
`;
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command,
  ], { encoding: "utf8" });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    return { ok: false, error: details || `PowerShell exited with ${result.status}` };
  }
  return { ok: true };
}

function ensurePngTargetSize(path, targetSize, outputPath = path) {
  const target = parseSizeForAspect(targetSize);
  if (!target) return null;

  const beforeBuffer = readFileSync(path);
  const before = readPngDimensions(beforeBuffer);
  if (!before) return { resized: false, error: "Saved image is not a readable PNG" };
  if (before.width === target.width && before.height === target.height) {
    return { resized: false, width: before.width, height: before.height };
  }
  if (process.platform !== "win32") {
    return {
      resized: false,
      width: before.width,
      height: before.height,
      error: `Resize to ${targetSize} is only implemented on Windows`,
    };
  }

  const resized = resizePngWithPowerShell(path, target.width, target.height, outputPath);
  if (!resized.ok) {
    return {
      resized: false,
      width: before.width,
      height: before.height,
      error: `Resize to ${targetSize} failed: ${resized.error}`,
    };
  }
  const after = readPngDimensions(readFileSync(outputPath));
  return {
    path: outputPath,
    resized: true,
    width: after?.width || target.width,
    height: after?.height || target.height,
    originalPath: outputPath === path ? null : path,
    originalWidth: before.width,
    originalHeight: before.height,
  };
}

function gcd(left, right) {
  let a = Math.abs(Math.trunc(Number(left) || 0));
  let b = Math.abs(Math.trunc(Number(right) || 0));
  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}

function aspectInstructionForSize(size) {
  const parsed = parseSizeForAspect(size);
  if (!parsed) return "";
  const aspect = aspectLabelForSize(size);
  if (!aspect) return "";
  const orientation = parsed.width === parsed.height
    ? "square"
    : parsed.width > parsed.height
      ? "landscape"
      : "portrait";
  return `The selected output canvas is ${aspect} (${orientation}). The image_generation result MUST use a ${aspect} canvas and must not return any other aspect or size.`;
}

function aspectPromptSuffixForSize(size) {
  const parsed = parseSizeForAspect(size);
  if (!parsed) return "";
  const aspect = aspectLabelForSize(size);
  if (!aspect) return "";
  if (parsed.width === parsed.height) {
    return `请严格按照 ${aspect} 正方形画幅生成最终图片，整张图片必须为 ${aspect} 比例。`;
  }
  if (parsed.height > parsed.width) {
    return `请严格按照 ${aspect} 竖版画幅生成最终图片，整张图片必须为 ${aspect} 竖向构图，不要正方形，不要横版。`;
  }
  return `请严格按照 ${aspect} 横版画幅生成最终图片，整张图片必须为 ${aspect} 横向构图，不要正方形，不要竖版。`;
}

function buildResponsesImageBody(prompt, size, action, sourceDataURLs = [], apiConfig = resolveApiConfig()) {
  const aspectInstruction = aspectInstructionForSize(size);
  const aspectPromptSuffix = aspectPromptSuffixForSize(size);
  const promptText = aspectPromptSuffix ? `${prompt}\n\n${aspectPromptSuffix}` : prompt;
  const content = [{ type: "input_text", text: promptText }];
  for (const dataURL of sourceDataURLs) {
    if (dataURL) content.push({ type: "input_image", image_url: dataURL });
  }
  const tool = {
    type: "image_generation",
    model: apiConfig.imageModel,
    action,
    size,
    output_format: "png",
    moderation: "low",
    partial_images: parseSizeForAspect(size) ? 0 : 1,
  };
  const requestQuality = imageQualityForRequest(apiConfig);
  if (requestQuality) tool.quality = requestQuality;
  const body = {
    model: apiConfig.textModel || apiConfig.imageModel,
    input: [{
      role: "user",
      content,
    }],
    tools: [tool],
    tool_choice: { type: "image_generation" },
    reasoning: { effort: "xhigh" },
    store: false,
    instructions: [NO_PROMPT_REVISION_INSTRUCTIONS, aspectInstruction].filter(Boolean).join(" "),
  };
  return body;
}

function buildResponsesGenerationBody(prompt, size, apiConfig = resolveApiConfig()) {
  return buildResponsesImageBody(prompt, size, "generate", [], apiConfig);
}

function buildResponsesEditBody(prompt, size, sourceDataURLs, apiConfig = resolveApiConfig()) {
  return buildResponsesImageBody(prompt, size, "edit", sourceDataURLs, apiConfig);
}

function promptWithAspectSuffix(prompt, size) {
  const aspectPromptSuffix = aspectPromptSuffixForSize(size);
  return aspectPromptSuffix ? `${prompt}\n\n${aspectPromptSuffix}` : prompt;
}

function buildImagesGenerationBody(prompt, size, apiConfig = resolveApiConfig()) {
  const body = {
    model: apiConfig.imageModel,
    prompt: promptWithAspectSuffix(prompt, size),
    size,
  };
  const requestQuality = imageQualityForRequest(apiConfig);
  if (requestQuality) body.quality = requestQuality;
  return body;
}

function buildImagesEditFormData(prompt, size, sources, apiConfig = resolveApiConfig()) {
  const formData = new FormData();
  formData.append("model", apiConfig.imageModel);
  formData.append("prompt", promptWithAspectSuffix(prompt, size));
  formData.append("size", size);
  const requestQuality = imageQualityForRequest(apiConfig);
  if (requestQuality) formData.append("quality", requestQuality);
  for (const source of sources || []) {
    if (!source?.sourceBuffer) continue;
    formData.append("image", new Blob([source.sourceBuffer], { type: source.mimeType || "image/png" }), source.sourceName || "image.png");
  }
  return formData;
}

function cloneResponsesBody(body) {
  const next = { ...(body || {}) };
  delete next.background;
  delete next.stream;
  return next;
}

function parseJsonText(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function responseStatus(data) {
  return String(
    data?.status
    || data?.response?.status
    || data?.task?.status
    || data?.data?.status
    || data?.result?.status
    || "",
  ).toLowerCase();
}

function responseId(data) {
  const containers = [data, data?.response, data?.task, data?.data, data?.result];
  for (const item of containers) {
    const id = item?.id || item?.response_id || item?.responseId || item?.responseID || item?.task_id || item?.taskId;
    const clean = String(id || "").trim();
    if (clean) return clean;
  }
  return "";
}

function isResponsesProcessingStatus(status) {
  return ["queued", "in_progress", "processing", "pending", "running"].includes(status);
}

function isResponsesFailedStatus(status) {
  return ["failed", "cancelled", "canceled", "incomplete", "expired"].includes(status);
}

function isResponsesFallbackStatus(status) {
  return Number.isInteger(status) && status >= 400 && status < 600;
}

function isResponsesPollRetryableStatus(status) {
  return [408, 409, 425, 429].includes(status) || (Number.isInteger(status) && status >= 500 && status < 600);
}

function responsesFailureMessage(data, prefix) {
  const message = data?.error?.message
    || data?.last_error?.message
    || data?.incomplete_details?.reason
    || data?.message
    || JSON.stringify(data || {}).slice(0, 500);
  return `${prefix}: ${message || "unknown error"}`;
}

async function pollOpenAIResponse(apiKey, responsesUrl, id, trace = null) {
  const retrieveUrl = `${responsesUrl.replace(/\/+$/, "")}/${encodeURIComponent(id)}`;
  const deadline = Date.now() + RESPONSES_POLL_TIMEOUT_MS;
  let transientFailures = 0;
  addTraceResponseId(trace, id);

  while (Date.now() < deadline) {
    await sleep(RESPONSES_POLL_INTERVAL_MS);
    let res;
    try {
      res = await requestWithTimeout(retrieveUrl, {
        method: "GET",
        headers: responsesHeaders(apiKey),
      }, REQUEST_TIMEOUT_MS);
    } catch (error) {
      transientFailures += 1;
      if (transientFailures > RESPONSES_POLL_MAX_TRANSIENT_FAILURES) {
        recordTraceError(trace, error);
        return { ok: false, error: `Responses background poll failed: ${responseTextError(error)} (id=${id})` };
      }
      continue;
    }

    const raw = await res.text().catch(() => "");
    recordRawResponse(trace, "background-poll-latest", raw, {
      route: "background",
      httpStatus: res.status,
      replaceKey: "background-poll-latest",
    });
    if (!res.ok) {
      if (!isResponsesPollRetryableStatus(res.status)) {
        return { ok: false, error: `${formatErrorResponse(res.status, raw)} (id=${id})`, raw, route: "background", responseId: id };
      }
      transientFailures += 1;
      if (transientFailures > RESPONSES_POLL_MAX_TRANSIENT_FAILURES) {
        return { ok: false, error: `${formatErrorResponse(res.status, raw)} (id=${id})`, raw, route: "background", responseId: id };
      }
      continue;
    }

    transientFailures = 0;
    const data = parseJsonText(raw);
    const status = responseStatus(data);
    if (status === "completed") {
      recordRawResponse(trace, "background-completed", raw, { route: "background", httpStatus: res.status });
      return { ok: true, raw, route: "background", responseId: id };
    }
    if (isResponsesFailedStatus(status)) return { ok: false, error: `${responsesFailureMessage(data, `Responses background task ${status}`)} (id=${id})`, raw, route: "background", responseId: id };
  }

  return { ok: false, error: `Responses background task timed out after ${Math.round(RESPONSES_POLL_TIMEOUT_MS / 1000)}s (id=${id})`, responseId: id, route: "background" };
}

async function postOpenAIResponsesBackground(apiKey, responsesUrl, body, trace = null) {
  const backgroundBody = { ...cloneResponsesBody(body), background: true };
  delete backgroundBody.store;
  let res;
  try {
    res = await requestWithTimeout(responsesUrl, {
      method: "POST",
      headers: responsesHeaders(apiKey),
      body: JSON.stringify(backgroundBody),
    }, REQUEST_TIMEOUT_MS);
  } catch (error) {
    recordTraceError(trace, error);
    return {
      ok: false,
      error: `Responses background create failed before a response id was returned; this task cannot be recovered unless the upstream exposes the id elsewhere (${responseTextError(error)})`,
      route: "background",
    };
  }

  const raw = await res.text().catch(() => "");
  recordRawResponse(trace, "background-create", raw, { route: "background", httpStatus: res.status });
  if (isResponsesFallbackStatus(res.status)) {
    const data = parseJsonText(raw);
    const id = responseId(data);
    if (!id) {
      return {
        fallback: true,
        fallbackOnce: true,
        reason: formatErrorResponse(res.status, raw),
        raw,
        route: "background",
        responseId: null,
      };
    }
    addTraceResponseId(trace, id);
    const status = responseStatus(data);
    if (status === "completed") return { ok: true, raw, route: "background", responseId: id };
    if (isResponsesFailedStatus(status)) {
      return { ok: false, error: `${responsesFailureMessage(data, `Responses background task ${status}`)} (id=${id})`, raw, route: "background", responseId: id };
    }
    if (!status || isResponsesProcessingStatus(status)) return pollOpenAIResponse(apiKey, responsesUrl, id, trace);
    return { ok: false, error: `Responses background task returned non-processing status "${status}" (id=${id})`, raw, route: "background", responseId: id };
  }
  if (!res.ok) return { ok: false, error: formatErrorResponse(res.status, raw), raw, route: "background", responseId: responseId(parseJsonText(raw)) };

  const data = parseJsonText(raw);
  const status = responseStatus(data);
  const id = responseId(data);
  addTraceResponseId(trace, id);
  if (status === "completed") return { ok: true, raw, route: "background", responseId: id };
  if (isResponsesFailedStatus(status)) return { ok: false, error: responsesFailureMessage(data, `Responses background task ${status}`), raw, route: "background", responseId: id };

  if (id && (!status || isResponsesProcessingStatus(status))) return pollOpenAIResponse(apiKey, responsesUrl, id, trace);
  return { ok: true, raw, route: "background", responseId: id };
}

async function postOpenAIResponsesStream(apiKey, responsesUrl, body, trace = null) {
  const streamBody = { ...cloneResponsesBody(body), stream: true };
  let res;
  try {
    res = await requestWithTimeout(responsesUrl, {
      method: "POST",
      headers: responsesHeaders(apiKey, "text/event-stream, application/json"),
      body: JSON.stringify(streamBody),
    }, REQUEST_TIMEOUT_MS);
  } catch (error) {
    recordTraceError(trace, error);
    return { fallback: true, reason: responseTextError(error) };
  }

  const raw = await res.text().catch(() => "");
  recordRawResponse(trace, "stream", raw, { route: "stream", httpStatus: res.status });
  if (RESPONSES_REJECT_STATUSES.has(res.status)) return { fallback: true, reason: `stream rejected: HTTP ${res.status}` };
  if (!res.ok) return { ok: false, error: formatErrorResponse(res.status, raw), raw, route: "stream", responseId: responseIdsFromRaw(raw)[0] || null };
  return { ok: true, raw, route: "stream", responseId: responseIdsFromRaw(raw)[0] || null };
}

async function postOpenAIResponsesPlain(apiKey, responsesUrl, body, trace = null) {
  const plainBody = cloneResponsesBody(body);
  let res;
  try {
    res = await requestWithTimeout(responsesUrl, {
      method: "POST",
      headers: responsesHeaders(apiKey),
      body: JSON.stringify(plainBody),
    }, REQUEST_TIMEOUT_MS);
  } catch (error) {
    recordTraceError(trace, error);
    return { ok: false, error: responseTextError(error) };
  }

  const raw = await res.text().catch(() => "");
  recordRawResponse(trace, "plain", raw, { route: "plain", httpStatus: res.status });
  if (!res.ok) return { ok: false, error: formatErrorResponse(res.status, raw), raw, route: "plain", responseId: responseIdsFromRaw(raw)[0] || null };
  return { ok: true, raw, route: "plain", responseId: responseIdsFromRaw(raw)[0] || null };
}

async function postOpenAIResponses(apiKey, responsesUrl, body, trace = null) {
  const background = await postOpenAIResponsesBackground(apiKey, responsesUrl, body, trace);
  if (!background.fallback) return background;

  const stream = await postOpenAIResponsesStream(apiKey, responsesUrl, body, trace);
  if (!stream.fallback) return stream;
  if (background.fallbackOnce) return { ok: false, error: `Responses fallback failed: ${stream.reason}`, route: "stream" };

  return postOpenAIResponsesPlain(apiKey, responsesUrl, body, trace);
}

function imageJsonHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

function imageMultipartHeaders(apiKey) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

async function postOpenAIImagesJson(apiKey, url, body, trace = null) {
  let res;
  try {
    res = await requestWithTimeout(url, {
      method: "POST",
      headers: imageJsonHeaders(apiKey),
      body: JSON.stringify(body),
    }, REQUEST_TIMEOUT_MS);
  } catch (error) {
    recordTraceError(trace, error);
    return { ok: false, error: responseTextError(error) };
  }

  const raw = await res.text().catch(() => "");
  recordRawResponse(trace, "images-generations", raw, { route: "images", httpStatus: res.status });
  if (!res.ok) return { ok: false, error: formatErrorResponse(res.status, raw), raw, route: "images" };
  return { ok: true, raw, route: "images" };
}

async function postOpenAIImagesMultipart(apiKey, url, formData, trace = null) {
  let res;
  try {
    res = await requestWithTimeout(url, {
      method: "POST",
      headers: imageMultipartHeaders(apiKey),
      body: formData,
    }, REQUEST_TIMEOUT_MS);
  } catch (error) {
    recordTraceError(trace, error);
    return { ok: false, error: responseTextError(error) };
  }

  const raw = await res.text().catch(() => "");
  recordRawResponse(trace, "images-edits", raw, { route: "images", httpStatus: res.status });
  if (!res.ok) return { ok: false, error: formatErrorResponse(res.status, raw), raw, route: "images" };
  return { ok: true, raw, route: "images" };
}

async function generateImageViaResponses(apiKey, prompt, size, outputDir, options = {}) {
  const resize = options.resize !== false;
  const apiConfig = options.apiConfig || resolveApiConfig();
  const trace = createResponseTrace(outputDir, "response_generate", { outputPrefix: "img", targetSize: resize ? size : null });
  const start = Date.now();
  try {
    const response = await postOpenAIResponses(apiKey, apiConfig.responsesUrl, buildResponsesGenerationBody(prompt, size, apiConfig), trace);
    addTraceResponseId(trace, response.responseId);
    if (!response.ok) return { ok: false, elapsed: Date.now() - start, error: response.error, ...responseTraceInfo(trace) };

    const raw = response.raw;
    const imageOutputs = extractImageOutputsFromResponses(raw);
    const saved = await saveFirstImageOutput(imageOutputs, outputDir, "img", null, resize ? size : null);
    const elapsed = Date.now() - start;
    if (!saved) return { ok: false, elapsed, error: `No image_generation_call result in Responses ${response.route || "response"}`, ...responseTraceInfo(trace) };
    if (saved.error) return { ok: false, elapsed, error: saved.error, ...responseTraceInfo(trace) };
    const { responseId } = responseTraceInfo(trace);
    deleteResponseTrace(trace);
    return { ok: true, elapsed, ...saved, responseId };
  } catch (error) {
    recordTraceError(trace, error);
    return {
      ok: false,
      elapsed: Date.now() - start,
      error: responseTextError(error),
      ...responseTraceInfo(trace),
    };
  }
}

async function generateImageViaImages(apiKey, prompt, size, outputDir, options = {}) {
  const resize = options.resize !== false;
  const apiConfig = options.apiConfig || resolveApiConfig();
  const trace = createResponseTrace(outputDir, "images_generate", { outputPrefix: "img", targetSize: resize ? size : null });
  const start = Date.now();
  try {
    const response = await postOpenAIImagesJson(apiKey, apiConfig.imageGenerationUrl, buildImagesGenerationBody(prompt, size, apiConfig), trace);
    if (!response.ok) return { ok: false, elapsed: Date.now() - start, error: response.error, ...responseTraceInfo(trace) };

    const raw = parseJsonText(response.raw);
    const imageOutputs = extractImageOutputsFromImagesResponse(raw);
    const saved = await saveFirstImageOutput(imageOutputs, outputDir, "img", null, resize ? size : null);
    const elapsed = Date.now() - start;
    if (saved?.error) return { ok: false, elapsed, error: saved.error, ...responseTraceInfo(trace) };
    if (!saved) return { ok: false, elapsed, error: "No image result in Images response", ...responseTraceInfo(trace) };
    const { responseId } = responseTraceInfo(trace);
    deleteResponseTrace(trace);
    return { ok: true, elapsed, ...saved, responseId };
  } catch (error) {
    recordTraceError(trace, error);
    return {
      ok: false,
      elapsed: Date.now() - start,
      error: responseTextError(error),
      ...responseTraceInfo(trace),
    };
  }
}

async function generateImage(apiKey, prompt, size, outputDir, options = {}) {
  const apiConfig = options.apiConfig || resolveApiConfig();
  const nextOptions = { ...options, apiConfig };
  if (apiConfig.imageRequestMode === "openai-responses") {
    return generateImageViaResponses(apiKey, prompt, size, outputDir, nextOptions);
  }
  return generateImageViaImages(apiKey, prompt, size, outputDir, nextOptions);
}

function loadSourceImage(imagePath) {
  if (!existsSync(imagePath)) {
    return { ok: false, elapsed: 0, error: `File does not exist: ${imagePath}`, sourceName: basename(imagePath) };
  }

  const sourceName = basename(imagePath);
  const sourceBuffer = readFileSync(imagePath);
  const mimeType = imageMimeTypeFromPath(imagePath);
  const ext = imageExtensionForMimeType(mimeType);
  return {
    ok: true,
    imagePath,
    sourceName,
    sourceBuffer,
    mimeType,
    ext,
    dataURL: imageDataURLFromBuffer(sourceBuffer, mimeType),
  };
}

function summarizeSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return "unknown source";
  if (sources.length === 1) return sources[0].sourceName;
  return `${sources.length} refs: ${sources.map((item) => item.sourceName).join(", ")}`;
}

function loadSourceImages(imagePaths) {
  const sources = [];
  for (const imagePath of imagePaths) {
    const source = loadSourceImage(imagePath);
    if (!source.ok) return source;
    sources.push(source);
  }
  return {
    ok: true,
    sources,
    sourceName: summarizeSources(sources),
  };
}

async function editImageViaResponsesOnce(apiKey, sources, prompt, size, outputDir, options = {}) {
  const resize = options.resize !== false;
  const apiConfig = options.apiConfig || resolveApiConfig();
  const trace = createResponseTrace(outputDir, "response_edit", { outputPrefix: "edit", targetSize: resize ? size : null });
  const start = Date.now();
  const sourceDataURLs = sources.map((item) => item.dataURL).filter(Boolean);
  const sourceName = summarizeSources(sources);
  try {
    const response = await postOpenAIResponses(apiKey, apiConfig.responsesUrl, buildResponsesEditBody(prompt, size, sourceDataURLs, apiConfig), trace);
    addTraceResponseId(trace, response.responseId);
    if (!response.ok) return { ok: false, elapsed: Date.now() - start, error: response.error, sourceName, ...responseTraceInfo(trace) };

    const raw = response.raw;
    const imageOutputs = extractImageOutputsFromResponses(raw);
    const saved = await saveFirstImageOutput(imageOutputs, outputDir, "edit", options.saveIndex ?? null, resize ? size : null);
    const elapsed = Date.now() - start;
    if (!saved) return { ok: false, elapsed, error: `No image_generation_call result in Responses ${response.route || "response"}`, sourceName, ...responseTraceInfo(trace) };
    if (saved.error) return { ok: false, elapsed, error: saved.error, sourceName, ...responseTraceInfo(trace) };
    const { responseId } = responseTraceInfo(trace);
    deleteResponseTrace(trace);
    return { ok: true, elapsed, ...saved, sourceName, responseId };
  } catch (error) {
    recordTraceError(trace, error);
    return {
      ok: false,
      elapsed: Date.now() - start,
      error: responseTextError(error),
      sourceName,
      ...responseTraceInfo(trace),
    };
  }
}

async function editImageViaImagesOnce(apiKey, sources, prompt, size, outputDir, options = {}) {
  const resize = options.resize !== false;
  const apiConfig = options.apiConfig || resolveApiConfig();
  const trace = createResponseTrace(outputDir, "images_edit", { outputPrefix: "edit", targetSize: resize ? size : null });
  const start = Date.now();
  const sourceName = summarizeSources(sources);
  try {
    const response = await postOpenAIImagesMultipart(apiKey, apiConfig.imageEditUrl, buildImagesEditFormData(prompt, size, sources, apiConfig), trace);
    if (!response.ok) return { ok: false, elapsed: Date.now() - start, error: response.error, sourceName, ...responseTraceInfo(trace) };

    const raw = parseJsonText(response.raw);
    const imageOutputs = extractImageOutputsFromImagesResponse(raw);
    const saved = await saveFirstImageOutput(imageOutputs, outputDir, "edit", options.saveIndex ?? null, resize ? size : null);
    const elapsed = Date.now() - start;
    if (saved?.error) return { ok: false, elapsed, error: saved.error, sourceName, ...responseTraceInfo(trace) };
    if (!saved) return { ok: false, elapsed, error: "No image result in Images edit response", sourceName, ...responseTraceInfo(trace) };
    const { responseId } = responseTraceInfo(trace);
    deleteResponseTrace(trace);
    return { ok: true, elapsed, ...saved, sourceName, responseId };
  } catch (error) {
    recordTraceError(trace, error);
    return {
      ok: false,
      elapsed: Date.now() - start,
      error: responseTextError(error),
      sourceName,
      ...responseTraceInfo(trace),
    };
  }
}

async function editImage(apiKey, imagePaths, prompt, size, outputDir, count = 1, silent = false, options = {}) {
  const resize = options.resize !== false;
  const paths = Array.isArray(imagePaths) ? imagePaths : [imagePaths];
  const sourceGroup = loadSourceImages(paths);
  if (!sourceGroup.ok) return sourceGroup;
  const { sources, sourceName } = sourceGroup;

  if (!silent) {
    if (sources.length === 1) {
      console.log(`Loaded ${sources[0].sourceName} (${(sources[0].sourceBuffer.length / 1024 / 1024).toFixed(2)}MB)`);
    } else {
      const totalMb = sources.reduce((sum, item) => sum + item.sourceBuffer.length, 0) / 1024 / 1024;
      console.log(`Loaded ${sources.length} source images (${totalMb.toFixed(2)}MB total)`);
      for (const source of sources) {
        console.log(`- ${source.sourceName} (${(source.sourceBuffer.length / 1024 / 1024).toFixed(2)}MB)`);
      }
    }
  }

  const started = Date.now();
  const results = [];
  const failures = [];
  let retryCount = 0;
  const apiConfig = options.apiConfig || resolveApiConfig();
  const editOnce = apiConfig.imageRequestMode === "openai-responses"
    ? editImageViaResponsesOnce
    : editImageViaImagesOnce;
  for (let index = 0; index < count; index += 1) {
    const result = await generateWithRetry(apiKey, prompt, size, outputDir, {
      index,
      total: count,
      maxRetries: options.maxRetries ?? MAX_RETRIES,
      retryDelayMs: options.retryDelayMs ?? RETRY_BACKOFF_MS,
      resize,
      generator: (_apiKey, _prompt, _size, _outputDir, context) => editOnce(apiKey, sources, prompt, size, outputDir, {
        resize,
        saveIndex: count > 1 ? context.index + 1 : null,
        apiConfig,
      }),
      apiConfig,
    });
    retryCount += result.retries || 0;
    if (result.ok) {
      results.push(result);
    } else {
      failures.push(result);
      break;
    }
  }

  const elapsed = Date.now() - started;
  if (failures.length > 0) {
    return {
      ok: false,
      elapsed,
      sourceName,
      results,
      failures,
      retries: retryCount,
      error: failures[0]?.error || "Edit failed",
    };
  }
  if (count > 1) return { ok: true, elapsed, results, sourceName, retries: retryCount };
  return { ok: true, elapsed, ...results[0], sourceName, retries: retryCount };
}

async function generateWithRetry(apiKey, prompt, size, outputDir, options = {}) {
  const {
    index = 0,
    total = 1,
    maxRetries = MAX_RETRIES,
    retryDelayMs = RETRY_BACKOFF_MS,
    generator = generateImage,
    resize = true,
    apiConfig = resolveApiConfig(),
    onRetryableFailure = () => {},
  } = options;
  let retries = 0;
  let attempts = 0;

  while (true) {
    attempts += 1;
    const result = await generator(apiKey, prompt, size, outputDir, { index, total, attempt: attempts, resize, apiConfig });
    if (result.ok) return { ...result, attempts, retries };

    const ambiguousSubmission = isAmbiguousSubmissionError(result.error);
    const retryable = !ambiguousSubmission && isRetryableError(result.error);
    const fatal = isFatalError(result.error);
    if (retryable && retries < maxRetries) {
      retries += 1;
      onRetryableFailure(result.error);
      console.log(`[${index + 1}/${total}] RETRY ${retries}/${maxRetries}: ${result.error}`);
      if (retryDelayMs > 0) await sleep(retryDelayMs);
      continue;
    }

    return { ...result, attempts, retries, retryable, fatal, ambiguousSubmission };
  }
}

async function runBatch(apiKey, prompts, size, concurrency, outputDir, options = {}) {
  if (typeof options === "boolean") options = { isVariation: options };
  const {
    isVariation = false,
    adaptive = true,
    maxRetries = MAX_RETRIES,
    retryDelayMs = RETRY_BACKOFF_MS,
    generator = generateImage,
    resize = true,
    returnReport = false,
    apiConfig = resolveApiConfig(),
  } = options;
  const total = prompts.length;
  const results = new Array(total);
  let nextIndex = 0;
  let retryCount = 0;
  let downgraded = false;
  let fatalError = null;
  const started = Date.now();
  const initialConcurrency = Math.max(1, Math.min(Number(concurrency) || DEFAULTS.concurrency, total, MAX_CONCURRENCY));

  function triggerDowngrade(error) {
    if (!adaptive || downgraded) return;
    downgraded = true;
    console.log(`[adaptive] Retryable error detected; future queued requests will run with concurrency=1. Cause: ${error}`);
  }

  async function worker(workerId) {
    while (true) {
      if (fatalError) return;
      if (adaptive && downgraded && workerId > 0) return;
      if (nextIndex >= total) return;
      const index = nextIndex++;
      const prompt = prompts[index];
      if (!isVariation) {
        console.log(`[${index + 1}/${total}] Generating: "${prompt.slice(0, 60)}${prompt.length > 60 ? "..." : ""}"`);
      }
      const result = await generateWithRetry(apiKey, prompt, size, outputDir, {
        index,
        total,
        maxRetries,
        retryDelayMs,
        generator,
        resize,
        apiConfig,
        onRetryableFailure: triggerDowngrade,
      });
      retryCount += result.retries || 0;
      results[index] = { prompt, ...result };
      console.log(result.ok
        ? `[${index + 1}/${total}] OK ${(result.elapsed / 1000).toFixed(1)}s attempts=${result.attempts}`
        : `[${index + 1}/${total}] FAILED attempts=${result.attempts} ${result.error}`);
      if (result.fatal) {
        fatalError = result.error;
        console.log(`[fatal] ${result.error}. No more queued requests will be started.`);
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: initialConcurrency }, (_, workerId) => worker(workerId)));

  for (let index = 0; index < total; index += 1) {
    if (!results[index]) {
      results[index] = {
        prompt: prompts[index],
        ok: false,
        skipped: true,
        error: fatalError ? `Skipped after fatal error: ${fatalError}` : "Not started",
      };
    }
  }

  const ok = results.filter((item) => item?.ok);
  const failed = results.filter((item) => item && !item.ok);
  const elapsed = Date.now() - started;
  const finalConcurrency = downgraded ? 1 : initialConcurrency;

  console.log("");
  if (isVariation) {
    console.log(`Prompt: "${prompts[0]}" x ${total}`);
    for (const [index, result] of ok.entries()) {
      console.log(`${index + 1}. ${basename(result.path)} ${formatImageResult(result)}`);
    }
    for (const result of failed) console.log(`FAILED: ${result.error}`);
  } else {
    for (const result of results) {
      if (result.ok) {
        console.log(`Prompt: "${result.prompt}"`);
        console.log(`Path: ${result.path}`);
        console.log(`Time: ${(result.elapsed / 1000).toFixed(1)}s, ${formatImageResult(result)}`);
      } else {
        console.log(`Prompt: "${result.prompt}"`);
        console.log(`FAILED: ${result.error}`);
      }
      const traceText = formatResponseTrace(result);
      if (traceText) console.log(`Response trace: ${traceText}`);
      console.log("");
    }
  }
  console.log(`Total: ${total}`);
  console.log(`Success: ${ok.length}`);
  console.log(`Failed: ${failed.length}`);
  console.log(`Retries: ${retryCount}`);
  console.log(`Adaptive downgraded: ${downgraded ? "yes" : "no"}`);
  console.log(`Final concurrency: ${finalConcurrency}`);
  console.log(`Done: ${ok.length}/${total} in ${(elapsed / 1000).toFixed(1)}s`);
  console.log(`Output: ${outputDir}`);
  if (ok.length > 0) {
    console.log("Successful paths:");
    for (const result of ok) console.log(result.path);
  }
  const traced = results.filter((item) => item?.responseTracePath);
  if (traced.length > 0) {
    console.log("Response traces:");
    for (const result of traced) console.log(formatResponseTrace(result));
  }

  const report = {
    total,
    success: ok.length,
    failed: failed.length,
    retryCount,
    downgraded,
    initialConcurrency,
    finalConcurrency,
    outputDir,
    paths: ok.map((item) => item.path),
    fatalError,
    exitCode: failed.length > 0 ? 1 : 0,
  };
  return returnReport ? report : report.exitCode;
}

async function runBatchEdit(apiKey, imagePaths, prompt, size, concurrency, outputDir, options = {}) {
  const total = imagePaths.length;
  const results = new Array(total);
  let nextIndex = 0;
  const started = Date.now();

  async function worker() {
    while (nextIndex < total) {
      const index = nextIndex++;
      const imagePath = imagePaths[index];
      console.log(`[${index + 1}/${total}] Editing: ${basename(imagePath)}`);
      const result = await editImage(apiKey, imagePath, prompt, size, outputDir, 1, true, options);
      results[index] = result;
      console.log(result.ok
        ? `[${index + 1}/${total}] OK ${(result.elapsed / 1000).toFixed(1)}s`
        : `[${index + 1}/${total}] FAILED ${result.error}`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
  const ok = results.filter((item) => item?.ok);
  const failed = results.filter((item) => item && !item.ok);
  const elapsed = Date.now() - started;

  console.log("");
  console.log(`Edit prompt: "${prompt}"`);
  for (const result of ok) {
    console.log(`${basename(result.path)} <- ${result.sourceName} ${formatImageResult(result)}`);
    const traceText = formatResponseTrace(result);
    if (traceText) console.log(`Response trace: ${traceText}`);
  }
  for (const result of failed) {
    console.log(`FAILED ${result.sourceName}: ${result.error}`);
    const traceText = formatResponseTrace(result);
    if (traceText) console.log(`Response trace: ${traceText}`);
  }
  console.log(`Done: ${ok.length}/${total} in ${(elapsed / 1000).toFixed(1)}s`);
  console.log(`Output: ${outputDir}`);
  return failed.length > 0 ? 1 : 0;
}

async function runAdaptiveSelfTest() {
  console.log("Adaptive self-test: retryable error should retry and downgrade.");
  const retryCalls = new Map();
  const retryableReport = await runBatch("mock-key", [
    "mock retryable 1",
    "mock retryable 2",
    "mock retryable 3",
    "mock retryable 4",
    "mock retryable 5",
  ], "2048x1152", 3, "(mock-output)", {
    adaptive: true,
    isVariation: true,
    maxRetries: MAX_RETRIES,
    retryDelayMs: 0,
    returnReport: true,
    generator: async (_apiKey, _prompt, _size, _outputDir, context) => {
      const count = (retryCalls.get(context.index) || 0) + 1;
      retryCalls.set(context.index, count);
      await sleep(10);
      if (context.index === 1 && count === 1) {
        return { ok: false, elapsed: 10, error: "HTTP 429: Rate limit exceeded" };
      }
      return { ok: true, elapsed: 10, path: `mock://retryable-${context.index + 1}.png`, fileSize: "1.00KB" };
    },
  });

  const retryableOk = retryableReport.exitCode === 0
    && retryableReport.success === 5
    && retryableReport.retryCount === 1
    && retryableReport.downgraded
    && retryableReport.finalConcurrency === 1;

  console.log("");
  console.log("Adaptive self-test: fatal error should stop queued work.");
  const fatalReport = await runBatch("mock-key", [
    "mock fatal 1",
    "mock fatal 2",
    "mock fatal 3",
    "mock fatal 4",
  ], "2048x1152", 3, "(mock-output)", {
    adaptive: true,
    isVariation: true,
    retryDelayMs: 0,
    returnReport: true,
    generator: async (_apiKey, _prompt, _size, _outputDir, context) => {
      await sleep(context.index === 1 ? 5 : 20);
      if (context.index === 1) {
        return { ok: false, elapsed: 5, error: "HTTP 401: Invalid API key" };
      }
      return { ok: true, elapsed: 20, path: `mock://fatal-${context.index + 1}.png`, fileSize: "1.00KB" };
    },
  });

  const fatalOk = fatalReport.exitCode === 1
    && fatalReport.fatalError
    && fatalReport.failed >= 1;

  console.log("");
  console.log("Adaptive self-test: ambiguous timeout should not resubmit.");
  let timeoutCalls = 0;
  const timeoutResult = await generateWithRetry("mock-key", "mock timeout", "2048x1152", "(mock-output)", {
    maxRetries: MAX_RETRIES,
    retryDelayMs: 0,
    generator: async () => {
      timeoutCalls += 1;
      return { ok: false, elapsed: 10, error: "Timeout (300s)" };
    },
  });
  const timeoutOk = timeoutCalls === 1
    && timeoutResult.attempts === 1
    && timeoutResult.retries === 0
    && timeoutResult.ambiguousSubmission
    && !timeoutResult.retryable;

  let noImageCalls = 0;
  const noImageResult = await generateWithRetry("mock-key", "mock no image", "2048x1152", "(mock-output)", {
    maxRetries: MAX_RETRIES,
    retryDelayMs: 0,
    generator: async () => {
      noImageCalls += 1;
      return { ok: false, elapsed: 10, error: "No image_generation_call result in Responses background" };
    },
  });
  const noImageOk = noImageCalls === 1
    && noImageResult.attempts === 1
    && noImageResult.retries === 0
    && noImageResult.ambiguousSubmission
    && !noImageResult.retryable;

  if (!retryableOk || !fatalOk || !timeoutOk || !noImageOk) {
    console.error("Adaptive self-test FAILED.");
    console.error(JSON.stringify({ retryableReport, fatalReport, timeoutResult, timeoutCalls, noImageResult, noImageCalls }, null, 2));
    return 1;
  }

  console.log("");
  console.log("Adaptive self-test OK.");
  return 0;
}

async function runOpenAIStandardSelfTest() {
  console.log("OpenAI standard Images self-test: payload shape and result extraction.");
  const sources = [
    {
      sourceName: "mock-a.png",
      sourceBuffer: Buffer.from("mock-source-a"),
      mimeType: "image/png",
      ext: "png",
      dataURL: "data:image/png;base64,bW9jay1zb3VyY2UtYQ==",
    },
    {
      sourceName: "mock-b.jpg",
      sourceBuffer: Buffer.from("mock-source-b"),
      mimeType: "image/jpeg",
      ext: "jpg",
      dataURL: "data:image/jpeg;base64,bW9jay1zb3VyY2UtYg==",
    },
  ];
  const apiConfig = resolveApiConfig({ imageQuality: "high", textModel: "standard-mode-must-ignore-text-model" });
  const explicitSizeOk = normalizeSizeString("2048x1024") === "2048x1024"
    && normalizeSizeString("2048X1024") === "2048x1024"
    && normalizeSizeString("2048*1024") === "2048x1024"
    && normalizeSizeString("2048×1024") === "2048x1024"
    && resolveGenerationParams({ size: "2048*1024" }, null).size === "2048x1024";
  const generationBody = buildImagesGenerationBody("mock generate prompt", "2048x1024", apiConfig);
  const formData = buildImagesEditFormData("mock edit prompt", "1152x2048", sources, apiConfig);
  const payloadOk = defaultImageGenerationUrl("https://api.mikoto.vip") === "https://api.mikoto.vip/v1/images/generations"
    && defaultImageEditUrl("https://api.mikoto.vip/v1") === "https://api.mikoto.vip/v1/images/edits"
    && generationBody.model === apiConfig.imageModel
    && generationBody.quality === "high"
    && generationBody.prompt.includes("2048x1024")
    && formData.get("model") === apiConfig.imageModel
    && formData.get("quality") === "high"
    && String(formData.get("prompt") || "").includes("1152x2048")
    && formData.get("size") === "1152x2048"
    && formData.getAll("image").length === 2;

  const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const [imageOutput] = extractImageOutputsFromImagesResponse({ data: [{ b64_json: pngB64 }] });
  const flexibleOutputs = extractImageOutputsFromImagesResponse({
    result: { images: [{ url: ["https://example.com/result.png"] }] },
  });
  const flexibleOk = flexibleOutputs.some((item) => item.type === "url" && item.value === "https://example.com/result.png");
  const outputDir = resolveOutputDir(join(tmpdir(), "api-image-gen-self-test"));
  const originalFetch = globalThis.fetch;
  const fetchCalls = [];
  let requestOk = false;
  let generateResult = null;
  let editResult = null;
  const testApiConfig = {
    ...apiConfig,
    imageRequestMode: "openai",
    imageGenerationUrl: "https://example.com/v1/images/generations",
    imageEditUrl: "https://example.com/v1/images/edits",
    imageQuality: "medium",
  };
  try {
    globalThis.fetch = async (url, init = {}) => {
      let parsedBody = null;
      if (init.body instanceof FormData) {
        parsedBody = {
          model: init.body.get("model"),
          size: init.body.get("size"),
          quality: init.body.get("quality"),
          imageCount: init.body.getAll("image").length,
        };
      } else if (init.body) {
        parsedBody = JSON.parse(init.body);
      }
      fetchCalls.push({ url: String(url), method: init.method, body: parsedBody });
      return new Response(JSON.stringify({ data: [{ b64_json: pngB64 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    generateResult = await generateImage("mock-key", "mock generate prompt", "2048x1024", outputDir, {
      apiConfig: testApiConfig,
      resize: false,
    });
    editResult = await editImageViaImagesOnce("mock-key", sources, "mock edit prompt", "1152x2048", outputDir, {
      apiConfig: testApiConfig,
      resize: false,
    });
    requestOk = generateResult.ok
      && editResult.ok
      && fetchCalls.length === 2
      && fetchCalls[0].url.endsWith("/v1/images/generations")
      && fetchCalls[0].body?.model === apiConfig.imageModel
      && fetchCalls[0].body?.quality === "medium"
      && fetchCalls[1].url.endsWith("/v1/images/edits")
      && fetchCalls[1].body?.model === apiConfig.imageModel
      && fetchCalls[1].body?.quality === "medium"
      && fetchCalls[1].body?.imageCount === 2;
  } finally {
    globalThis.fetch = originalFetch;
  }
  const emptyTrace = createResponseTrace(outputDir, "self_test_empty_trace");
  const emptyTraceInfo = responseTraceInfo(emptyTrace);
  const rawOnlyTrace = createResponseTrace(outputDir, "self_test_raw_only", { outputPrefix: "raw_recover" });
  recordRawResponse(rawOnlyTrace, "images-generations", JSON.stringify({ data: [{ b64_json: pngB64 }] }), { route: "images", httpStatus: 200 });
  const rawOnlyRecover = await recoverResponseTrace(null, "https://example.com/v1/responses", rawOnlyTrace.metadataPath, { resize: false });
  let timeoutGenerateResult = null;
  try {
    globalThis.fetch = async () => {
      const error = new Error("mock abort");
      error.name = "AbortError";
      throw error;
    };
    timeoutGenerateResult = await generateImageViaImages("mock-key", "mock timeout prompt", "2048x1024", outputDir, {
      apiConfig: testApiConfig,
      resize: false,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const traceOk = !generateResult?.responseTracePath
    && !generateResult?.rawResponsePath
    && !editResult?.responseTracePath
    && !editResult?.rawResponsePath
    && !emptyTraceInfo.responseTracePath
    && !emptyTraceInfo.rawResponsePath
    && !existsSync(emptyTrace.metadataPath)
    && rawOnlyRecover?.ok
    && rawOnlyRecover.recoveredFromRaw
    && existsSync(rawOnlyRecover.path)
    && !existsSync(rawOnlyTrace.metadataPath)
    && !timeoutGenerateResult?.ok
    && !!timeoutGenerateResult?.responseTracePath
    && existsSync(timeoutGenerateResult.responseTracePath);
  const saved = await saveImageOutput(imageOutput, outputDir, "self_test_edit");
  const savedOk = !!saved?.path
    && existsSync(saved.path)
    && saved.width === 1
    && saved.height === 1;
  const resizedSaved = saveBase64Image(pngB64, outputDir, "self_test_resize", null, "2x2");
  const resizePreserveOk = process.platform === "win32"
    ? !!resizedSaved?.path
      && existsSync(resizedSaved.path)
      && !!resizedSaved.originalPath
      && existsSync(resizedSaved.originalPath)
      && resizedSaved.path !== resizedSaved.originalPath
      && resizedSaved.path.endsWith("_resized.png")
      && resizedSaved.width === 2
      && resizedSaved.height === 2
      && resizedSaved.originalDimensions === "1x1"
    : !!resizedSaved?.path
      && existsSync(resizedSaved.path)
      && resizedSaved.width === 1
      && resizedSaved.height === 1
      && !!resizedSaved.resizeError;

  if (!explicitSizeOk || !payloadOk || !flexibleOk || !requestOk || !traceOk || !savedOk || !resizePreserveOk) {
    console.error("OpenAI standard Images self-test FAILED.");
    console.error(JSON.stringify({
      explicitSizeOk,
      payloadOk,
      flexibleOk,
      requestOk,
      traceOk,
      emptyTraceInfo,
      emptyTracePath: emptyTrace.metadataPath,
      rawOnlyRecover,
      timeoutGenerateResult,
      fetchCalls,
      generateResult,
      editResult,
      savedOk,
      resizePreserveOk,
      saved,
      resizedSaved,
    }, null, 2));
    return 1;
  }

  console.log("OpenAI standard Images self-test OK.");
  console.log(`Saved: ${saved.path}`);
  return 0;
}

async function runResponsesSelfTest() {
  console.log("OpenAI Responses self-test: payload shape, background retry, and duplicate-submit guards.");
  const sources = [
    {
      sourceName: "mock-a.png",
      sourceBuffer: Buffer.from("mock-source-a"),
      mimeType: "image/png",
      ext: "png",
      dataURL: "data:image/png;base64,bW9jay1zb3VyY2UtYQ==",
    },
    {
      sourceName: "mock-b.jpg",
      sourceBuffer: Buffer.from("mock-source-b"),
      mimeType: "image/jpeg",
      ext: "jpg",
      dataURL: "data:image/jpeg;base64,bW9jay1zb3VyY2UtYg==",
    },
  ];
  const apiConfig = resolveApiConfig({ imageRequestMode: "openai-responses", imageQuality: "high" });
  const payload = buildResponsesEditBody("mock edit prompt", "1152x2048", sources.map((item) => item.dataURL), apiConfig);
  const configuredTextModel = "configured-text-model";
  const configuredPayload = buildResponsesEditBody(
    "mock edit prompt",
    "1152x2048",
    sources.map((item) => item.dataURL),
    resolveApiConfig({ imageRequestMode: "openai-responses" }, { api: { textModel: configuredTextModel } }),
  );
  const emptyTextModelApiConfig = resolveApiConfig(
    { imageRequestMode: "openai-responses" },
    { api: { textModel: "", imageModel: "configured-image-model" } },
  );
  const emptyTextModelPayload = buildResponsesEditBody(
    "mock edit prompt",
    "1152x2048",
    sources.map((item) => item.dataURL),
    emptyTextModelApiConfig,
  );
  const savedEmptyTextModelConfig = applyApiConfigFlags({}, { textModel: "" });
  const parsedEmptyTextModel = parseArgs(["--text-model", ""]);
  const content = payload.input?.[0]?.content || [];
  const tool = payload.tools?.[0] || {};
  const payloadOk = payload.model === DEFAULT_API_CONFIG.textModel
    && configuredPayload.model === configuredTextModel
    && emptyTextModelApiConfig.textModel === ""
    && emptyTextModelPayload.model === emptyTextModelApiConfig.imageModel
    && emptyTextModelPayload.tools?.[0]?.model === emptyTextModelApiConfig.imageModel
    && Object.prototype.hasOwnProperty.call(savedEmptyTextModelConfig.api, "textModel")
    && savedEmptyTextModelConfig.api.textModel === ""
    && parsedEmptyTextModel.flags.textModel === ""
    && tool.model === apiConfig.imageModel
    && !Object.prototype.hasOwnProperty.call(payload, "stream")
    && payload.store === false
    && content[0]?.type === "input_text"
    && content[1]?.type === "input_image"
    && content[2]?.type === "input_image"
    && tool.type === "image_generation"
    && tool.action === "edit"
    && tool.size === "1152x2048"
    && tool.quality === "high"
    && payload.tool_choice?.type === "image_generation";

  const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const raw = `data: {"type":"response.output_item.done","response":{"id":"resp_mock_trace"},"item":{"type":"image_generation_call","result":"${pngB64}"}}\n`;
  const [base64] = extractImagesFromResponses(raw);
  const [jsonBase64] = extractImagesFromResponses(JSON.stringify({
    id: "resp_mock_json",
    status: "completed",
    output: [{ type: "image_generation_call", result: pngB64 }],
  }));
  const [partialBase64] = extractImagesFromResponses(`data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"${pngB64}"}\n`);
  const [textUrlOutput] = extractImageOutputsFromResponses(JSON.stringify({
    output_text: "![result](https://example.com/result.png)",
  }));
  const textFallbackOk = textUrlOutput?.type === "url" && textUrlOutput.value === "https://example.com/result.png";
  const responseIdParsingOk = responseIdsFromRaw(JSON.stringify({
    responseId: "custom_response_id",
    response: { id: "custom_nested_response_id" },
    task_id: "custom_task_id",
  })).length === 3
    && responseId({ response: { id: "custom_nested_response_id" } }) === "custom_nested_response_id"
    && responseId({ task_id: "custom_task_id" }) === "custom_task_id"
    && responseStatus({ response: { status: "queued" } }) === "queued";
  const outputDir = resolveOutputDir(join(tmpdir(), "api-image-gen-self-test"));
  const trace = createResponseTrace(outputDir, "self_test_response");
  const originalFetch = globalThis.fetch;
  const backgroundRetryStatuses = [400, 404, 422, 499, 500, 502, 599];
  const backgroundRetryCalls = {};
  let backgroundRetryOk = isResponsesFallbackStatus(400)
    && isResponsesFallbackStatus(499)
    && isResponsesFallbackStatus(500)
    && isResponsesFallbackStatus(599)
    && !isResponsesFallbackStatus(399)
    && !isResponsesFallbackStatus(600);
  let fallbackStopsAfterOneOk = false;
  let responseIdPollsWithoutRetryOk = false;
  let failedResponseIdStopsPollingOk = false;
  const pollStatusPolicyOk = [408, 409, 425, 429, 500, 599].every(isResponsesPollRetryableStatus)
    && [400, 401, 403, 404, 422].every((status) => !isResponsesPollRetryableStatus(status));
  let otherStatusNoRetryOk = false;
  let backgroundTimeoutOk = false;
  try {
    for (const status of backgroundRetryStatuses) {
      const calls = [];
      backgroundRetryCalls[status] = calls;
      globalThis.fetch = async (_url, init = {}) => {
        const parsedBody = init.body ? JSON.parse(init.body) : null;
        calls.push({ method: init.method, body: parsedBody });
        if (calls.length === 1) {
          return new Response(JSON.stringify({ error: { message: "background unsupported" } }), {
            status,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(raw, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      };
      const retryResult = await postOpenAIResponses("mock-key", "https://example.com/v1/responses", payload);
      backgroundRetryOk = backgroundRetryOk
        && retryResult.ok
        && retryResult.route === "stream"
        && calls.length === 2
        && calls[0].body?.background === true
        && !Object.prototype.hasOwnProperty.call(calls[0].body, "stream")
        && !Object.prototype.hasOwnProperty.call(calls[0].body, "store")
        && !Object.prototype.hasOwnProperty.call(calls[1].body, "background")
        && calls[1].body?.stream === true
        && calls[1].body?.store === false;
    }
    const fallbackFailureCalls = [];
    globalThis.fetch = async (_url, init = {}) => {
      const parsedBody = init.body ? JSON.parse(init.body) : null;
      fallbackFailureCalls.push({ method: init.method, body: parsedBody });
      return new Response(JSON.stringify({ error: { message: "request rejected" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    };
    const fallbackFailureResult = await postOpenAIResponses("mock-key", "https://example.com/v1/responses", payload);
    fallbackStopsAfterOneOk = !fallbackFailureResult.ok
      && fallbackFailureResult.route === "stream"
      && fallbackFailureCalls.length === 2
      && fallbackFailureCalls[0].body?.background === true
      && fallbackFailureCalls[1].body?.stream === true
      && !Object.prototype.hasOwnProperty.call(fallbackFailureCalls[1].body, "background")
      && String(fallbackFailureResult.error || "").includes("fallback failed");
    const responseIdCalls = [];
    globalThis.fetch = async (_url, init = {}) => {
      const parsedBody = init.body ? JSON.parse(init.body) : null;
      responseIdCalls.push({ method: init.method, body: parsedBody });
      const isCreate = responseIdCalls.length === 1;
      return new Response(isCreate
        ? JSON.stringify({ id: "resp_existing", status: "queued" })
        : JSON.stringify({
          id: "resp_existing",
          status: "completed",
          output: [{ type: "image_generation_call", result: pngB64 }],
        }), {
        status: isCreate ? 500 : 200,
        headers: { "content-type": "application/json" },
      });
    };
    const responseIdResult = await postOpenAIResponses("mock-key", "https://example.com/v1/responses", payload);
    responseIdPollsWithoutRetryOk = responseIdResult.ok
      && responseIdResult.route === "background"
      && responseIdResult.responseId === "resp_existing"
      && responseIdCalls.length === 2
      && responseIdCalls[0].method === "POST"
      && responseIdCalls[0].body?.background === true
      && responseIdCalls[1].method === "GET"
      && responseIdCalls[1].body == null;
    const failedResponseIdCalls = [];
    globalThis.fetch = async (_url, init = {}) => {
      const parsedBody = init.body ? JSON.parse(init.body) : null;
      failedResponseIdCalls.push({ method: init.method, body: parsedBody });
      return new Response(JSON.stringify({
        id: "resp_failed",
        status: "failed",
        error: { message: "task failed" },
      }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    };
    const failedResponseIdResult = await postOpenAIResponses("mock-key", "https://example.com/v1/responses", payload);
    failedResponseIdStopsPollingOk = !failedResponseIdResult.ok
      && failedResponseIdResult.route === "background"
      && failedResponseIdResult.responseId === "resp_failed"
      && failedResponseIdCalls.length === 1
      && failedResponseIdCalls[0].method === "POST"
      && String(failedResponseIdResult.error || "").includes("task failed");
    const otherStatusCalls = [];
    globalThis.fetch = async (_url, init = {}) => {
      const parsedBody = init.body ? JSON.parse(init.body) : null;
      otherStatusCalls.push({ method: init.method, body: parsedBody });
      return new Response(JSON.stringify({ error: { message: "request rejected" } }), {
        status: 399,
        headers: { "content-type": "application/json" },
      });
    };
    const otherStatusResult = await postOpenAIResponses("mock-key", "https://example.com/v1/responses", payload);
    otherStatusNoRetryOk = !otherStatusResult.ok
      && otherStatusResult.route === "background"
      && otherStatusCalls.length === 1
      && otherStatusCalls[0].body?.background === true
      && String(otherStatusResult.error || "").includes("HTTP 399");
    globalThis.fetch = async () => {
      const error = new Error("mock abort");
      error.name = "AbortError";
      throw error;
    };
    const timeoutResult = await postOpenAIResponsesBackground("mock-key", "https://example.com/v1/responses", payload, createResponseTrace(outputDir, "self_test_timeout"));
    backgroundTimeoutOk = !timeoutResult.ok
      && !timeoutResult.fallback
      && String(timeoutResult.error || "").includes("cannot be recovered");
  } finally {
    globalThis.fetch = originalFetch;
  }
  recordRawResponse(trace, "stream", raw, { route: "stream", httpStatus: 200 });
  const traceOk = existsSync(trace.metadataPath)
    && trace.files.length === 1
    && trace.responseIds.includes("resp_mock_trace")
    && trace.files.every((item) => existsSync(item.path));
  const saved = saveBase64Image(base64, outputDir, "self_test_response");
  const savedOk = !!saved?.path
    && existsSync(saved.path)
    && saved.width === 1
    && saved.height === 1
    && jsonBase64 === pngB64
    && partialBase64 === pngB64;
  const recoverTrace = createResponseTrace(outputDir, "self_test_recover", { outputPrefix: "recovered" });
  addTraceResponseId(recoverTrace, "resp_mock_recover");
  writeResponseTraceMetadata(recoverTrace);
  let recoverResult = null;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      id: "resp_mock_recover",
      status: "completed",
      output: [{ type: "image_generation_call", result: pngB64 }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    recoverResult = await recoverResponseTrace("mock-key", "https://example.com/v1/responses", recoverTrace.metadataPath, { resize: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const recoverOk = recoverResult?.ok
    && recoverResult.responseId === "resp_mock_recover"
    && existsSync(recoverResult.path)
    && !existsSync(recoverTrace.metadataPath);

  if (!payloadOk || !textFallbackOk || !responseIdParsingOk || !backgroundRetryOk || !fallbackStopsAfterOneOk || !responseIdPollsWithoutRetryOk || !failedResponseIdStopsPollingOk || !pollStatusPolicyOk || !otherStatusNoRetryOk || !backgroundTimeoutOk || !traceOk || !savedOk || !recoverOk) {
    console.error("OpenAI Responses self-test FAILED.");
    console.error(JSON.stringify({
      payloadOk,
      textFallbackOk,
      responseIdParsingOk,
      backgroundRetryOk,
      backgroundRetryCalls,
      fallbackStopsAfterOneOk,
      responseIdPollsWithoutRetryOk,
      failedResponseIdStopsPollingOk,
      pollStatusPolicyOk,
      otherStatusNoRetryOk,
      backgroundTimeoutOk,
      traceOk,
      trace,
      savedOk,
      saved,
      recoverOk,
      recoverResult,
    }, null, 2));
    return 1;
  }

  console.log("OpenAI Responses self-test OK.");
  console.log(`Saved: ${saved.path}`);
  return 0;
}

function parseArgs(argv) {
  const args = { prompts: [], flags: {} };
  let i = 0;
  while (i < argv.length) {
    const value = argv[i];
    if (value === "--config" && argv[i + 1]) args.flags.configFile = argv[++i];
    else if (value === "--get-config") args.flags.getConfig = true;
    else if (value === "--set-key" && argv[i + 1]) args.flags.setKey = argv[++i];
    else if (value === "--api-profile" && argv[i + 1]) args.flags.apiProfile = argv[++i];
    else if (value === "--set-default-api" && argv[i + 1]) args.flags.setDefaultApi = argv[++i];
    else if (value === "--set-api-config") args.flags.setApiConfig = true;
    else if (value === "--api-root" && argv[i + 1]) args.flags.apiRoot = argv[++i];
    else if (value === "--image-request-mode" && argv[i + 1]) args.flags.imageRequestMode = argv[++i];
    else if (value === "--openai-standard") args.flags.imageRequestMode = "openai";
    else if (value === "--openai-responses") args.flags.imageRequestMode = "openai-responses";
    else if (value === "--image-generation-url" && argv[i + 1]) args.flags.imageGenerationUrl = argv[++i];
    else if (value === "--image-edit-url" && argv[i + 1]) args.flags.imageEditUrl = argv[++i];
    else if (value === "--responses-url" && argv[i + 1]) args.flags.responsesUrl = argv[++i];
    else if (value === "--text-model" && i + 1 < argv.length) args.flags.textModel = argv[++i];
    else if (value === "--image-model" && argv[i + 1]) args.flags.imageModel = argv[++i];
    else if (value === "--image-quality" && argv[i + 1]) args.flags.imageQuality = argv[++i];
    else if (value === "--set-quick-mode") args.flags.setQuickMode = true;
    else if (value === "--set-batch-mode") args.flags.setBatchMode = true;
    else if (value === "--prompt" && argv[i + 1]) args.prompts.push(argv[++i]);
    else if (value === "--quality" && argv[i + 1]) args.flags.quality = argv[++i];
    else if (value === "--ratio" && argv[i + 1]) args.flags.ratio = argv[++i];
    else if (value === "--aspect" && argv[i + 1]) args.flags.aspect = argv[++i];
    else if (value === "--size" && argv[i + 1]) args.flags.size = argv[++i];
    else if (value === "--count" && argv[i + 1]) args.flags.count = Number.parseInt(argv[++i], 10);
    else if (value === "--repeat" && argv[i + 1]) args.flags.repeat = Number.parseInt(argv[++i], 10);
    else if (value === "--output-dir" && argv[i + 1]) args.flags.outputDir = argv[++i];
    else if (value === "--concurrency" && argv[i + 1]) args.flags.concurrency = Number.parseInt(argv[++i], 10);
    else if (value === "--adaptive") args.flags.adaptive = true;
    else if (value === "--no-adaptive") args.flags.adaptive = false;
    else if (value === "--resize") args.flags.resize = true;
    else if (value === "--no-resize" || value === "--raw-output") args.flags.resize = false;
    else if (value === "--batch" && argv[i + 1]) args.flags.batchFile = argv[++i];
    else if (value === "--recover-trace" && argv[i + 1]) args.flags.recoverTrace = argv[++i];
    else if (value === "--recover-pending") args.flags.recoverPending = true;
    else if (value === "--batch-inline") {
      args.flags.batchInline = true;
      i++;
      while (i < argv.length && !argv[i].startsWith("--")) {
        args.prompts.push(argv[i++]);
      }
      continue;
    } else if (value === "--edit") args.flags.edit = true;
    else if (value === "--batch-edit") args.flags.batchEdit = true;
    else if (value === "--legacy-edit") {
      args.flags.edit = true;
      args.flags.imageRequestMode = "openai";
    } else if (value === "--edit-api" && argv[i + 1]) {
      const route = String(argv[++i]).trim().toLowerCase();
      const mode = normalizeImageRequestMode(route);
      if (mode) args.flags.imageRequestMode = mode;
      else args.flags.unsupportedEditRoute = `edit-api:${route}`;
    }
    else if (value === "--image" && argv[i + 1]) {
      if (!args.flags.images) args.flags.images = [];
      args.flags.images.push(argv[++i]);
    } else if (value === "--resolve-size") args.flags.resolveSize = true;
    else if (value === "--self-test-adaptive") args.flags.selfTestAdaptive = true;
    else if (value === "--self-test-openai-standard") args.flags.selfTestOpenAIStandard = true;
    else if (value === "--self-test-responses" || value === "--self-test-edit-responses") args.flags.selfTestResponses = true;
    else if (value === "--help" || value === "-h") args.flags.help = true;
    i++;
  }
  return args;
}

function printUsage(sizeMatrix = resolveSizeMatrix()) {
  console.log(`API Image Gen

CONFIG
  --config path.json
  --get-config
  --api-profile NAME
  --set-key <key>
  --set-default-api NAME
  --set-api-config [--api-profile NAME] [--api-root URL] [--image-request-mode openai|openai-responses] [--text-model MODEL] [--image-model MODEL] [--image-quality auto|low|medium|high]
  --set-api-config [--image-generation-url URL] [--image-edit-url URL] [--responses-url URL]
  --set-quick-mode --ratio R --count 1..${MAX_GENERATION_COUNT}
  --set-batch-mode --ratio R --concurrency 1..${MAX_CONCURRENCY}

GENERATE
  --prompt "..." [--api-profile NAME] [--api-root URL] [--image-request-mode openai|openai-responses] [--text-model MODEL] [--image-model MODEL] [--image-quality auto|low|medium|high] [--ratio R|--aspect R|--size WxH] [--count 1..${MAX_GENERATION_COUNT}] [--no-resize]
  --prompt "..." --repeat 1..${MAX_REPEAT} [--concurrency 1..${MAX_CONCURRENCY}] [--adaptive|--no-adaptive]
  --batch prompts.json [--ratio R|--aspect R|--size WxH] [--concurrency N] [--no-resize]
  --batch-inline "prompt 1" "prompt 2" ... [--ratio R|--aspect R|--size WxH] [--concurrency N] [--no-resize]

EDIT
  --edit --image path.png --prompt "..." [--image-request-mode openai|openai-responses] [--text-model MODEL] [--image-quality auto|low|medium|high] [--ratio R|--aspect R|--size WxH] [--count 1..${MAX_EDIT_COUNT}] [--no-resize]
  --edit --image one.png --image two.png --prompt "..." [--ratio R|--aspect R|--size WxH] [--count 1..${MAX_EDIT_COUNT}] [--no-resize]    combine all sources in one edit request
  --batch-edit --edit --image one.png --image two.png --prompt "..." [--ratio R|--aspect R|--size WxH] [--concurrency N] [--no-resize]
  default route is OpenAI standard Images API; use --edit-api responses for Responses/RS

RECOVER
  --recover-trace path_to_trace.json [--api-profile NAME] [--no-resize]
  --recover-pending [--output-dir DIR] [--api-profile NAME] [--no-resize]

TOOLS
  --resolve-size --quality 2K --aspect 16:9
  --resolve-size --size 2048*1024
  --self-test-adaptive
  --self-test-openai-standard
  --self-test-responses

DEFAULTS
  config: ${CONFIG_PATH} or API_IMAGE_GEN_CONFIG
  API root: ${DEFAULT_API_CONFIG.apiRoot}
  image request mode: ${DEFAULT_API_CONFIG.imageRequestMode}
  image generation URL: ${defaultImageGenerationUrl(DEFAULT_API_CONFIG.apiRoot)}
  image edit URL: ${defaultImageEditUrl(DEFAULT_API_CONFIG.apiRoot)}
  responses URL: ${defaultResponsesUrl(DEFAULT_API_CONFIG.apiRoot)}
  responses text model: ${DEFAULT_API_CONFIG.textModel} (openai-responses only; explicit empty string uses image model)
  image model: ${DEFAULT_API_CONFIG.imageModel}
  image API quality: ${DEFAULT_API_CONFIG.imageQuality} (auto is not sent; low/medium/high are sent)
  edit API: openai standard by default; openai-responses optional
  size preset: default ${DEFAULTS.quality}; supported ${Object.keys(sizeMatrix).join(", ")}
  output: ~/Pictures/api-image-gen
  adaptive: on, concurrency ${DEFAULTS.concurrency}, retries ${MAX_RETRIES}, retry backoff ${RETRY_BACKOFF_MS / 1000}s
  notice: ${API_SIZE_LIMIT_NOTICE}

RATIOS
  ${supportedRatioText(null, sizeMatrix)}
  aliases: square=1:1, landscape=4:3, portrait=3:4
  disabled after repeated upstream 502 tests: 5:4, 4:5, 3:1, 1:3

SIZE MATRIX
  1K: 1:1 1024x1024, 3:2 1536x1024, 2:3 1024x1536, 4:3 1536x1152, 3:4 1152x1536, 16:9 1536x864, 9:16 864x1536, 2:1 1536x768, 1:2 768x1536, 7:4 1664x944, 4:7 944x1664
  2K: 1:1 2048x2048, 3:2 2048x1360, 2:3 1360x2048, 4:3 2048x1536, 3:4 1536x2048, 16:9 2048x1152, 9:16 1152x2048, 2:1 2048x1024, 1:2 1024x2048, 7:4 2208x1264, 4:7 1264x2208
  custom sizes: add config.sizes. Example: { "1K": { "poster": "1024x1824" } }
  explicit size: --size 2048x1024, --size 2048X1024, --size 2048*1024, or --size 2048×1024`);
}

function resolveGenerationParams(flags, modeConfig, sizeMatrix = resolveSizeMatrix()) {
  const requestedQuality = flags.quality || modeConfig?.quality || DEFAULTS.quality;
  const quality = normalizeQuality(requestedQuality, sizeMatrix);
  if (shouldWarnUnsupportedQuality(requestedQuality, sizeMatrix)) {
    console.warn(`NOTICE: Unsupported quality="${requestedQuality}"; using ${DEFAULTS.quality}. ${API_SIZE_LIMIT_NOTICE}`);
  }

  if (flags.size) {
    const size = normalizeSizeString(flags.size);
    if (!size) {
      console.error(`ERROR: Invalid size="${flags.size}". Use WIDTHxHEIGHT, WIDTHXHEIGHT, WIDTH*HEIGHT, or WIDTH×HEIGHT, for example 2048x1024.`);
      process.exit(1);
    }
    return { quality, ratio: aspectRatioForSize(size), size, explicitSize: true, requestedSize: flags.size };
  }

  const requestedRatio = flags.aspect ?? flags.ratio ?? modeConfig?.ratio ?? DEFAULTS.ratio;
  let ratio = normalizeRatio(requestedRatio);
  if (isDisabledRatio(ratio)) {
    console.error(`ERROR: Ratio="${requestedRatio}" is disabled in this plugin because repeated upstream tests returned 502 for 5:4, 4:5, 3:1, and 1:3. Use one of: ${supportedRatioText(null, sizeMatrix)}.`);
    process.exit(1);
  }
  const size = resolveSize(quality, ratio, null, sizeMatrix);
  if (!size) {
    console.error(`ERROR: Invalid ratio="${requestedRatio}" for quality ${quality}. Supported ratios for ${quality}: ${supportedRatioText(quality, sizeMatrix)}. Aliases: square, landscape, portrait.`);
    process.exit(1);
  }
  return { quality, ratio, size, explicitSize: false, requestedSize: flags.size || null };
}

async function main() {
  const { prompts, flags } = parseArgs(process.argv.slice(2));
  const configPath = resolveConfigPath(flags);
  const config = loadConfig(configPath) || {};
  if (flags.imageRequestMode != null && !normalizeImageRequestMode(flags.imageRequestMode)) {
    console.error(`ERROR: Invalid image request mode="${flags.imageRequestMode}". Use openai or openai-responses.`);
    process.exit(1);
  }
  if (flags.imageQuality != null && !normalizeImageQuality(flags.imageQuality)) {
    console.error(`ERROR: Invalid image quality="${flags.imageQuality}". Use auto, low, medium, or high.`);
    process.exit(1);
  }
  const apiConfig = resolveApiConfig(flags, config);
  const sizeMatrix = resolveSizeMatrix(config);

  if (flags.getConfig) {
    const activeKey = resolveApiKey(flags, config);
    console.log(JSON.stringify({
      configPath,
      defaultApi: normalizeConfigString(config?.defaultApi) || null,
      apiProfile: apiConfig.profile || null,
      hasKey: !!activeKey,
      keyPreview: activeKey ? previewKey(activeKey) : null,
      activeApi: apiConfig,
      apis: summarizeApiProfiles(config),
      sizes: config?.sizes || config?.sizeMatrix || null,
      supportedQualities: Object.keys(sizeMatrix),
      quickMode: config?.quickMode || null,
      batchMode: config?.batchMode || null,
    }, null, 2));
    return;
  }

  if (flags.setKey) {
    setApiProfileKey(config, normalizeConfigString(flags.apiProfile), flags.setKey);
    saveConfig(config, configPath);
    const profileText = flags.apiProfile ? ` for profile "${flags.apiProfile}"` : "";
    console.log(`API key saved${profileText}: ${previewKey(flags.setKey)}`);
    return;
  }

  if (flags.setDefaultApi) {
    const profileName = normalizeConfigString(flags.setDefaultApi);
    if (!apiProfiles(config)[profileName]) {
      console.error(`ERROR: API profile "${profileName}" does not exist in config.apis.`);
      process.exit(1);
    }
    config.defaultApi = profileName;
    saveConfig(config, configPath);
    console.log(`Default API profile saved: ${profileName}`);
    return;
  }

  if (flags.setApiConfig) {
    if (!hasApiConfigFlag(flags)) {
      console.error("ERROR: --set-api-config requires at least one of --api-root, --image-request-mode, --image-generation-url, --image-edit-url, --responses-url, --text-model, --image-model, or --image-quality.");
      process.exit(1);
    }
    applyApiConfigFlags(config, flags);
    saveConfig(config, configPath);
    console.log("API config saved:");
    console.log(JSON.stringify(resolveApiConfig(flags, config), null, 2));
    return;
  }

  if (flags.setQuickMode) {
    const previous = config.quickMode || {};
    const requestedQuality = flags.quality || previous.quality || DEFAULTS.quality;
    const quality = normalizeQuality(requestedQuality, sizeMatrix);
    if (shouldWarnUnsupportedQuality(requestedQuality, sizeMatrix)) {
      console.warn(`NOTICE: Unsupported quick mode quality="${requestedQuality}"; using ${DEFAULTS.quality}. ${API_SIZE_LIMIT_NOTICE}`);
    }
    const ratio = normalizeRatio(flags.aspect ?? flags.ratio ?? previous.ratio ?? DEFAULTS.ratio);
    const count = clampInteger(flags.count ?? previous.count, 1, MAX_GENERATION_COUNT, DEFAULTS.count);
    const size = resolveSize(quality, ratio, null, sizeMatrix);
    if (!size) {
      console.error(`ERROR: Invalid ratio="${ratio}" for quality ${quality}. Supported ratios for ${quality}: ${supportedRatioText(quality, sizeMatrix)}.`);
      process.exit(1);
    }
    config.quickMode = { quality, ratio, count };
    saveConfig(config, configPath);
    console.log(`Quick mode saved: ${quality}, ${ratioLabel(ratio)} (${size}), count ${count}`);
    return;
  }

  if (flags.setBatchMode) {
    const previous = config.batchMode || {};
    const requestedQuality = flags.quality || previous.quality || DEFAULTS.quality;
    const quality = normalizeQuality(requestedQuality, sizeMatrix);
    if (shouldWarnUnsupportedQuality(requestedQuality, sizeMatrix)) {
      console.warn(`NOTICE: Unsupported batch mode quality="${requestedQuality}"; using ${DEFAULTS.quality}. ${API_SIZE_LIMIT_NOTICE}`);
    }
    const ratio = normalizeRatio(flags.aspect ?? flags.ratio ?? previous.ratio ?? DEFAULTS.ratio);
    const concurrency = clampInteger(flags.concurrency ?? previous.concurrency, 1, MAX_CONCURRENCY, DEFAULTS.concurrency);
    const size = resolveSize(quality, ratio, null, sizeMatrix);
    if (!size) {
      console.error(`ERROR: Invalid ratio="${ratio}" for quality ${quality}. Supported ratios for ${quality}: ${supportedRatioText(quality, sizeMatrix)}.`);
      process.exit(1);
    }
    config.batchMode = { quality, ratio, concurrency };
    saveConfig(config, configPath);
    console.log(`Batch mode saved: ${quality}, ${ratioLabel(ratio)} (${size}), concurrency ${concurrency}`);
    return;
  }

  if (flags.resolveSize) {
    const { quality, ratio, size, explicitSize } = resolveGenerationParams(flags, config.quickMode, sizeMatrix);
    console.log(JSON.stringify({ quality, ratio, size, explicitSize }, null, 2));
    return;
  }

  if (flags.selfTestAdaptive) {
    process.exitCode = await runAdaptiveSelfTest();
    return;
  }

  if (flags.selfTestOpenAIStandard) {
    process.exitCode = await runOpenAIStandardSelfTest();
    return;
  }

  if (flags.selfTestResponses) {
    process.exitCode = await runResponsesSelfTest();
    return;
  }

  if (flags.recoverTrace || flags.recoverPending) {
    const recoverDir = flags.recoverPending || flags.outputDir ? resolveOutputDir(flags.outputDir) : null;
    const tracePaths = flags.recoverTrace ? [flags.recoverTrace] : listResponseTracePaths(recoverDir);
    if (tracePaths.length === 0) {
      console.log(`No response traces found: ${recoverDir}`);
      return;
    }

    const apiKey = resolveApiKey(flags, config);
    const results = await runRecoverResponseTraces(apiKey, apiConfig.responsesUrl, tracePaths, {
      outputDir: flags.recoverTrace && flags.outputDir ? recoverDir : null,
      resize: flags.resize !== false,
    });
    const recovered = results.filter((item) => item.ok);
    const notRecovered = results.filter((item) => !item.ok && !item.skipped);
    const skipped = results.filter((item) => item.skipped);

    for (const result of results) {
      if (result.ok) {
        const idText = result.responseId ? ` id=${result.responseId}` : "";
        const sourceText = result.recoveredFromRaw ? " from=raw" : "";
        console.log(`Recovered: ${result.path} ${formatImageResult(result)}${idText}${sourceText}`);
      } else if (result.skipped) {
        console.log(`Skipped: ${result.tracePath} ${result.error}`);
      } else {
        console.error(`Not recovered: ${result.tracePath} ${result.error}`);
        const traceText = formatResponseTrace(result);
        if (traceText) console.error(`Response trace: ${traceText}`);
      }
    }
    console.log(`Total traces: ${results.length}`);
    console.log(`Recovered: ${recovered.length}`);
    console.log(`Not recovered: ${notRecovered.length}`);
    if (skipped.length > 0) console.log(`Skipped: ${skipped.length}`);
    process.exitCode = notRecovered.length > 0 ? 1 : 0;
    return;
  }

  if (flags.help || (prompts.length === 0 && !flags.batchFile && !flags.edit)) {
    printUsage(sizeMatrix);
    return;
  }

  const apiKey = getApiKey(config, flags);
  const outputDir = resolveOutputDir(flags.outputDir);

  if (flags.edit) {
    const images = flags.images || [];
    if (images.length === 0) {
      console.error("ERROR: --edit requires at least one --image <path>.");
      process.exit(1);
    }
    if (prompts.length === 0) {
      console.error("ERROR: --edit requires --prompt <text>.");
      process.exit(1);
    }
    if (images.length > MAX_EDIT_SOURCES) {
      console.error(`ERROR: Edit supports up to ${MAX_EDIT_SOURCES} source images.`);
      process.exit(1);
    }
    if (flags.unsupportedEditRoute) {
      console.error(`ERROR: Unsupported edit API route "${flags.unsupportedEditRoute}". Use --edit-api images or --edit-api responses.`);
      process.exit(1);
    }
    const { size } = resolveGenerationParams(flags, config.quickMode, sizeMatrix);
    if (images.length > 1 && flags.batchEdit) {
      const concurrency = clampInteger(flags.concurrency ?? config.batchMode?.concurrency, 1, MAX_CONCURRENCY, DEFAULTS.concurrency);
      process.exitCode = await runBatchEdit(apiKey, images, prompts[0], size, concurrency, outputDir, {
        resize: flags.resize !== false,
        apiConfig,
      });
      return;
    }
    const count = clampInteger(flags.count, 1, MAX_EDIT_COUNT, 1);
    const result = await editImage(apiKey, images, prompts[0], size, outputDir, count, false, {
      resize: flags.resize !== false,
      apiConfig,
    });
    if (!result.ok) {
      if (result.results?.length > 0) {
        console.error("Partial edit successes:");
        for (const [index, item] of result.results.entries()) {
          console.error(`${index + 1}. ${item.path} ${formatImageResult(item)}`);
          const traceText = formatResponseTrace(item);
          if (traceText) console.error(`Response trace: ${traceText}`);
        }
      }
      console.error(`Edit failed: ${result.error}`);
      const traceText = formatResponseTrace(result.failures?.[0] || result);
      if (traceText) console.error(`Response trace: ${traceText}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Edit prompt: "${prompts[0]}"`);
    if (count > 1) {
      for (const [index, item] of result.results.entries()) {
        console.log(`${index + 1}. ${item.path} ${formatImageResult(item)}`);
        const traceText = formatResponseTrace(item);
        if (traceText) console.log(`Response trace: ${traceText}`);
      }
    } else {
      console.log(`Path: ${result.path}`);
      console.log(`Size: ${formatImageResult(result)}`);
      const traceText = formatResponseTrace(result);
      if (traceText) console.log(`Response trace: ${traceText}`);
    }
    console.log(`Source: ${result.sourceName}`);
    console.log(`Time: ${(result.elapsed / 1000).toFixed(1)}s`);
    return;
  }

  const isBatch = !!flags.batchFile || !!flags.batchInline;
  const modeConfig = isBatch ? config.batchMode : config.quickMode;
  const { size } = resolveGenerationParams(flags, modeConfig, sizeMatrix);

  if (flags.batchFile) {
    const raw = readFileSync(flags.batchFile, "utf8");
    const parsed = JSON.parse(raw);
    const batchPrompts = Array.isArray(parsed) ? parsed : parsed?.prompts;
    if (!Array.isArray(batchPrompts) || batchPrompts.length === 0) {
      console.error("ERROR: Batch file must be a JSON array of prompt strings or { \"prompts\": [...] }.");
      process.exit(1);
    }
    if (batchPrompts.length > MAX_BATCH_PROMPTS) {
      console.error(`ERROR: Batch generation supports up to ${MAX_BATCH_PROMPTS} prompts.`);
      process.exit(1);
    }
    const concurrency = clampInteger(flags.concurrency ?? config.batchMode?.concurrency, 1, MAX_CONCURRENCY, DEFAULTS.concurrency);
    process.exit(await runBatch(apiKey, batchPrompts.map(String), size, concurrency, outputDir, {
      adaptive: flags.adaptive !== false,
      resize: flags.resize !== false,
      apiConfig,
    }));
  }

  if (flags.batchInline) {
    if (prompts.length > MAX_BATCH_PROMPTS) {
      console.error(`ERROR: Batch generation supports up to ${MAX_BATCH_PROMPTS} prompts.`);
      process.exit(1);
    }
    const concurrency = clampInteger(flags.concurrency ?? config.batchMode?.concurrency, 1, MAX_CONCURRENCY, DEFAULTS.concurrency);
    process.exit(await runBatch(apiKey, prompts, size, concurrency, outputDir, {
      adaptive: flags.adaptive !== false,
      resize: flags.resize !== false,
      apiConfig,
    }));
  }

  const prompt = prompts[0];
  const total = flags.repeat != null
    ? clampInteger(flags.repeat, 1, MAX_REPEAT, DEFAULTS.count)
    : clampInteger(flags.count ?? config.quickMode?.count, 1, MAX_GENERATION_COUNT, DEFAULTS.count);
  if (total > 1) {
    const concurrency = clampInteger(flags.concurrency ?? config.batchMode?.concurrency, 1, MAX_CONCURRENCY, DEFAULTS.concurrency);
    process.exit(await runBatch(apiKey, Array(total).fill(prompt), size, concurrency, outputDir, {
      adaptive: flags.adaptive !== false,
      isVariation: true,
      resize: flags.resize !== false,
      apiConfig,
    }));
  }

  console.log("Generating...");
  const result = await generateImage(apiKey, prompt, size, outputDir, {
    resize: flags.resize !== false,
    apiConfig,
  });
  if (!result.ok) {
    console.error(`Generation failed: ${result.error}`);
    const traceText = formatResponseTrace(result);
    if (traceText) console.error(`Response trace: ${traceText}`);
    process.exit(1);
  }
  console.log(`Prompt: "${prompt}"`);
  console.log(`Path: ${result.path}`);
  console.log(`Size: ${formatImageResult(result)}`);
  console.log(`Time: ${(result.elapsed / 1000).toFixed(1)}s`);
  const traceText = formatResponseTrace(result);
  if (traceText) console.log(`Response trace: ${traceText}`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
