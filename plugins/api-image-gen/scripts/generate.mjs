#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const CONFIG_PATH = join(homedir(), ".codex", "api-image-gen-config.json");
const DEFAULT_API_CONFIG = {
  apiRoot: "https://api.openai.com",
  responsesPath: "/v1/responses",
  imageModel: "gpt-image-2",
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
const REQUEST_TIMEOUT_MS = 180_000;
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
const API_SIZE_LIMIT_NOTICE = "由于上游请求限制只能接收1K图像，详细计费以后台为准。";

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

function normalizeConfigBoolean(value) {
  if (value === true || value === false) return value;
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return null;
}

function stripTrailingSlashes(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function defaultResponsesUrl(apiRoot) {
  const base = stripTrailingSlashes(apiRoot || DEFAULT_API_CONFIG.apiRoot);
  const path = DEFAULT_API_CONFIG.responsesPath;
  for (const prefix of ["/api/v3", "/v1beta", "/v1", "/v2"]) {
    if (base.endsWith(prefix) && path.startsWith(`${prefix}/`)) return `${base}${path.slice(prefix.length)}`;
  }
  return `${base}${path}`;
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
  const selected = apiProfileSettings(resolveApiProfileSelection(flags, config).profile);
  const stored = config?.api || {};
  const apiRoot = normalizeConfigString(flags.apiRoot)
    || normalizeConfigString(selected.apiRoot)
    || normalizeConfigString(stored.apiRoot)
    || normalizeConfigString(config?.apiRoot)
    || DEFAULT_API_CONFIG.apiRoot;
  const textModel = normalizeConfigString(flags.textModel)
    || normalizeConfigString(selected.textModel)
    || normalizeConfigString(stored.textModel)
    || normalizeConfigString(config?.textModel);
  const imageModelAsTopLevel = normalizeConfigBoolean(flags.imageModelAsTopLevel)
    ?? normalizeConfigBoolean(selected.imageModelAsTopLevel)
    ?? normalizeConfigBoolean(stored.imageModelAsTopLevel)
    ?? normalizeConfigBoolean(config?.imageModelAsTopLevel)
    ?? false;
  return {
    profile: resolveApiProfileSelection(flags, config).name,
    apiRoot,
    responsesUrl: normalizeConfigString(flags.responsesUrl)
      || normalizeConfigString(selected.responsesUrl)
      || normalizeConfigString(stored.responsesUrl)
      || normalizeConfigString(config?.responsesUrl)
      || defaultResponsesUrl(apiRoot),
    ...(textModel ? { textModel } : {}),
    imageModelAsTopLevel,
    imageModel: normalizeConfigString(flags.imageModel)
      || normalizeConfigString(selected.imageModel)
      || normalizeConfigString(stored.imageModel)
      || normalizeConfigString(config?.imageModel)
      || DEFAULT_API_CONFIG.imageModel,
  };
}

function resolveApiKey(flags = {}, config = {}) {
  const selected = apiProfileSettings(resolveApiProfileSelection(flags, config).profile);
  return normalizeConfigString(selected.apiKey)
    || normalizeConfigString(selected.key)
    || normalizeConfigString(config?.apiKey);
}

function hasApiConfigFlag(flags = {}) {
  return ["apiRoot", "responsesUrl", "textModel", "imageModel", "imageModelAsTopLevel"].some((key) => flags[key] != null);
}

function applyApiConfigFlags(config, flags = {}) {
  const profileName = normalizeConfigString(flags.apiProfile);
  const source = profileName ? apiProfileSettings(apiProfiles(config)[profileName]) : config?.api;
  const next = { ...(source || {}) };
  delete next.api;
  delete next.apiKey;
  delete next.key;
  if (flags.apiRoot != null) {
    next.apiRoot = normalizeConfigString(flags.apiRoot);
    if (flags.responsesUrl == null) delete next.responsesUrl;
  }
  if (flags.responsesUrl != null) next.responsesUrl = normalizeConfigString(flags.responsesUrl);
  if (flags.textModel != null) next.textModel = normalizeConfigString(flags.textModel);
  if (flags.imageModel != null) next.imageModel = normalizeConfigString(flags.imageModel);
  if (flags.imageModelAsTopLevel != null) next.imageModelAsTopLevel = !!flags.imageModelAsTopLevel;
  for (const [key, value] of Object.entries(next)) {
    if (value == null || value === "") delete next[key];
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
      api: {
        apiRoot: profileConfig.apiRoot,
        responsesUrl: profileConfig.responsesUrl,
        ...(profileConfig.textModel ? { textModel: profileConfig.textModel } : {}),
        imageModelAsTopLevel: profileConfig.imageModelAsTopLevel,
        imageModel: profileConfig.imageModel,
      },
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error) {
  const text = String(error || "").toLowerCase();
  return [
    "http 429",
    "http 502",
    "http 503",
    "http 504",
    "http 524",
    "timeout",
    "rate limit",
    "too many requests",
    "no available account",
    "account pool busy",
    "please retry later",
    "temporarily unavailable",
    "overloaded",
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

function saveBase64Image(base64, outputDir, prefix, index = null, targetSize = null) {
  const clean = normalizeBase64Image(base64);
  if (!clean) return null;
  const buffer = Buffer.from(clean, "base64");
  const suffix = Math.random().toString(36).slice(2, 6);
  const numbered = index == null ? "" : `_${index}`;
  const baseName = `${prefix}_${timestamp()}${numbered}_${suffix}`;
  const originalPath = join(outputDir, `${baseName}.png`);
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
    action,
    size,
    quality: "auto",
    output_format: "png",
    moderation: "low",
    partial_images: parseSizeForAspect(size) ? 0 : 1,
  };
  if (!apiConfig.imageModelAsTopLevel) tool.model = apiConfig.imageModel;
  const body = {
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
  if (apiConfig.imageModelAsTopLevel) body.model = apiConfig.imageModel;
  else if (apiConfig.textModel) body.model = apiConfig.textModel;
  return body;
}

function buildResponsesGenerationBody(prompt, size, apiConfig = resolveApiConfig()) {
  return buildResponsesImageBody(prompt, size, "generate", [], apiConfig);
}

function buildResponsesEditBody(prompt, size, sourceDataURLs, apiConfig = resolveApiConfig()) {
  return buildResponsesImageBody(prompt, size, "edit", sourceDataURLs, apiConfig);
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
  return String(data?.status || "").toLowerCase();
}

function responseId(data) {
  return String(data?.id || "").trim();
}

function isResponsesProcessingStatus(status) {
  return ["queued", "in_progress", "processing", "pending", "running"].includes(status);
}

function isResponsesFailedStatus(status) {
  return ["failed", "cancelled", "canceled", "incomplete"].includes(status);
}

function responsesFailureMessage(data, prefix) {
  const message = data?.error?.message
    || data?.last_error?.message
    || data?.incomplete_details?.reason
    || data?.message
    || JSON.stringify(data || {}).slice(0, 500);
  return `${prefix}: ${message || "unknown error"}`;
}

async function pollOpenAIResponse(apiKey, responsesUrl, id) {
  const retrieveUrl = `${responsesUrl.replace(/\/+$/, "")}/${encodeURIComponent(id)}`;
  const deadline = Date.now() + RESPONSES_POLL_TIMEOUT_MS;
  let transientFailures = 0;

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
        return { ok: false, error: `Responses background poll failed: ${responseTextError(error)} (id=${id})` };
      }
      continue;
    }

    const raw = await res.text().catch(() => "");
    if (!res.ok) {
      transientFailures += 1;
      if (transientFailures > RESPONSES_POLL_MAX_TRANSIENT_FAILURES) {
        return { ok: false, error: `${formatErrorResponse(res.status, raw)} (id=${id})` };
      }
      continue;
    }

    transientFailures = 0;
    const data = parseJsonText(raw);
    const status = responseStatus(data);
    if (status === "completed") return { ok: true, raw, route: "background" };
    if (isResponsesFailedStatus(status)) return { ok: false, error: responsesFailureMessage(data, `Responses background task ${status}`) };
  }

  return { ok: false, error: `Responses background task timed out after ${Math.round(RESPONSES_POLL_TIMEOUT_MS / 1000)}s (id=${id})` };
}

async function postOpenAIResponsesBackground(apiKey, responsesUrl, body) {
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
    return { fallback: true, reason: responseTextError(error) };
  }

  if (RESPONSES_REJECT_STATUSES.has(res.status)) return { fallback: true, reason: `background rejected: HTTP ${res.status}` };
  const raw = await res.text().catch(() => "");
  if (!res.ok) return { ok: false, error: formatErrorResponse(res.status, raw) };

  const data = parseJsonText(raw);
  const status = responseStatus(data);
  if (status === "completed") return { ok: true, raw, route: "background" };
  if (isResponsesFailedStatus(status)) return { ok: false, error: responsesFailureMessage(data, `Responses background task ${status}`) };

  const id = responseId(data);
  if (id && isResponsesProcessingStatus(status)) return pollOpenAIResponse(apiKey, responsesUrl, id);
  return { ok: true, raw, route: "background" };
}

async function postOpenAIResponsesStream(apiKey, responsesUrl, body) {
  const streamBody = { ...cloneResponsesBody(body), stream: true };
  let res;
  try {
    res = await requestWithTimeout(responsesUrl, {
      method: "POST",
      headers: responsesHeaders(apiKey, "text/event-stream, application/json"),
      body: JSON.stringify(streamBody),
    }, REQUEST_TIMEOUT_MS);
  } catch (error) {
    return { fallback: true, reason: responseTextError(error) };
  }

  const raw = await res.text().catch(() => "");
  if (RESPONSES_REJECT_STATUSES.has(res.status)) return { fallback: true, reason: `stream rejected: HTTP ${res.status}` };
  if (!res.ok) return { ok: false, error: formatErrorResponse(res.status, raw) };
  return { ok: true, raw, route: "stream" };
}

async function postOpenAIResponsesPlain(apiKey, responsesUrl, body) {
  const plainBody = cloneResponsesBody(body);
  let res;
  try {
    res = await requestWithTimeout(responsesUrl, {
      method: "POST",
      headers: responsesHeaders(apiKey),
      body: JSON.stringify(plainBody),
    }, REQUEST_TIMEOUT_MS);
  } catch (error) {
    return { ok: false, error: responseTextError(error) };
  }

  const raw = await res.text().catch(() => "");
  if (!res.ok) return { ok: false, error: formatErrorResponse(res.status, raw) };
  return { ok: true, raw, route: "plain" };
}

async function postOpenAIResponses(apiKey, responsesUrl, body) {
  const background = await postOpenAIResponsesBackground(apiKey, responsesUrl, body);
  if (!background.fallback) return background;

  const stream = await postOpenAIResponsesStream(apiKey, responsesUrl, body);
  if (!stream.fallback) return stream;

  return postOpenAIResponsesPlain(apiKey, responsesUrl, body);
}

async function generateImage(apiKey, prompt, size, outputDir, options = {}) {
  const resize = options.resize !== false;
  const apiConfig = options.apiConfig || resolveApiConfig();
  const start = Date.now();
  try {
    const response = await postOpenAIResponses(apiKey, apiConfig.responsesUrl, buildResponsesGenerationBody(prompt, size, apiConfig));
    if (!response.ok) return { ok: false, elapsed: Date.now() - start, error: response.error };

    const raw = response.raw;
    const [base64] = extractImagesFromResponses(raw);
    const saved = saveBase64Image(base64, outputDir, "img", null, resize ? size : null);
    const elapsed = Date.now() - start;
    if (!saved) return { ok: false, elapsed, error: `No image_generation_call result in Responses ${response.route || "response"}` };
    return { ok: true, elapsed, ...saved };
  } catch (error) {
    return {
      ok: false,
      elapsed: Date.now() - start,
      error: responseTextError(error),
    };
  }
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
  const start = Date.now();
  const sourceDataURLs = sources.map((item) => item.dataURL).filter(Boolean);
  const sourceName = summarizeSources(sources);
  try {
    const response = await postOpenAIResponses(apiKey, apiConfig.responsesUrl, buildResponsesEditBody(prompt, size, sourceDataURLs, apiConfig));
    if (!response.ok) return { ok: false, elapsed: Date.now() - start, error: response.error, sourceName };

    const raw = response.raw;
    const [base64] = extractImagesFromResponses(raw);
    const saved = saveBase64Image(base64, outputDir, "edit", options.saveIndex ?? null, resize ? size : null);
    const elapsed = Date.now() - start;
    if (!saved) return { ok: false, elapsed, error: `No image_generation_call result in Responses ${response.route || "response"}`, sourceName };
    return { ok: true, elapsed, ...saved, sourceName };
  } catch (error) {
    return {
      ok: false,
      elapsed: Date.now() - start,
      error: responseTextError(error),
      sourceName,
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
  for (let index = 0; index < count; index += 1) {
    const result = await generateWithRetry(apiKey, prompt, size, outputDir, {
      index,
      total: count,
      maxRetries: options.maxRetries ?? MAX_RETRIES,
      retryDelayMs: options.retryDelayMs ?? RETRY_BACKOFF_MS,
      resize,
      generator: (_apiKey, _prompt, _size, _outputDir, context) => editImageViaResponsesOnce(apiKey, sources, prompt, size, outputDir, {
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

    const retryable = isRetryableError(result.error);
    const fatal = isFatalError(result.error);
    if (retryable && retries < maxRetries) {
      retries += 1;
      onRetryableFailure(result.error);
      console.log(`[${index + 1}/${total}] RETRY ${retries}/${maxRetries}: ${result.error}`);
      if (retryDelayMs > 0) await sleep(retryDelayMs);
      continue;
    }

    return { ...result, attempts, retries, retryable, fatal };
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
  }
  for (const result of failed) console.log(`FAILED ${result.sourceName}: ${result.error}`);
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
        return { ok: false, elapsed: 10, error: "HTTP 502: Cloudflare Bad Gateway" };
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

  if (!retryableOk || !fatalOk) {
    console.error("Adaptive self-test FAILED.");
    console.error(JSON.stringify({ retryableReport, fatalReport }, null, 2));
    return 1;
  }

  console.log("");
  console.log("Adaptive self-test OK.");
  return 0;
}

async function runEditResponsesSelfTest() {
  console.log("Edit Responses self-test: payload shape and SSE extraction.");
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
  const apiConfig = resolveApiConfig();
  const explicitSizeOk = normalizeSizeString("2048x1024") === "2048x1024"
    && normalizeSizeString("2048X1024") === "2048x1024"
    && normalizeSizeString("2048*1024") === "2048x1024"
    && normalizeSizeString("2048×1024") === "2048x1024"
    && resolveGenerationParams({ size: "2048*1024" }, null).size === "2048x1024";
  const payload = buildResponsesEditBody("mock edit prompt", "1152x2048", sources.map((item) => item.dataURL), apiConfig);
  const explicitModelPayload = buildResponsesEditBody(
    "mock edit prompt",
    "1152x2048",
    sources.map((item) => item.dataURL),
    { ...apiConfig, textModel: "mock-text-model" },
  );
  const topLevelImagePayload = buildResponsesEditBody(
    "mock edit prompt",
    "1152x2048",
    sources.map((item) => item.dataURL),
    { ...apiConfig, imageModelAsTopLevel: true },
  );
  const content = payload.input?.[0]?.content || [];
  const tool = payload.tools?.[0] || {};
  const modelOk = apiConfig.imageModelAsTopLevel
    ? payload.model === apiConfig.imageModel && !Object.prototype.hasOwnProperty.call(tool, "model")
    : tool.model === apiConfig.imageModel
      && (apiConfig.textModel
        ? payload.model === apiConfig.textModel
        : !Object.prototype.hasOwnProperty.call(payload, "model"));
  const topLevelImageOk = topLevelImagePayload.model === apiConfig.imageModel
    && !Object.prototype.hasOwnProperty.call(topLevelImagePayload.tools?.[0] || {}, "model");
  const cloneOk = !Object.prototype.hasOwnProperty.call(cloneResponsesBody({ ...payload, stream: true, background: true }), "stream")
    && !Object.prototype.hasOwnProperty.call(cloneResponsesBody({ ...payload, stream: true, background: true }), "background");
  const payloadOk = modelOk
    && topLevelImageOk
    && explicitModelPayload.model === (apiConfig.imageModelAsTopLevel ? apiConfig.imageModel : "mock-text-model")
    && !Object.prototype.hasOwnProperty.call(payload, "stream")
    && payload.store === false
    && content[0]?.type === "input_text"
    && content[1]?.type === "input_image"
    && content[1]?.image_url === sources[0].dataURL
    && content[2]?.type === "input_image"
    && content[2]?.image_url === sources[1].dataURL
    && tool.type === "image_generation"
    && tool.action === "edit"
    && tool.size === "1152x2048"
    && tool.output_format === "png"
    && tool.partial_images === 0
    && payload.tool_choice?.type === "image_generation";

  const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const raw = `data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"${pngB64}"}}\n`;
  const [base64] = extractImagesFromResponses(raw);
  const [jsonBase64] = extractImagesFromResponses(JSON.stringify({
    status: "completed",
    output: [{ type: "image_generation_call", result: pngB64 }],
  }));
  const [partialBase64] = extractImagesFromResponses(`data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"${pngB64}"}\n`);
  const originalFetch = globalThis.fetch;
  const fetchCalls = [];
  let fallbackOk = false;
  try {
    globalThis.fetch = async (_url, init = {}) => {
      const parsedBody = init.body ? JSON.parse(init.body) : null;
      fetchCalls.push({ method: init.method, body: parsedBody });
      if (fetchCalls.length === 1) {
        return new Response(JSON.stringify({ error: { message: "background unsupported" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(raw, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const fallbackResult = await postOpenAIResponses("mock-key", "https://example.com/v1/responses", payload);
    fallbackOk = fallbackResult.ok
      && fallbackResult.route === "stream"
      && fetchCalls.length === 2
      && fetchCalls[0].body?.background === true
      && !Object.prototype.hasOwnProperty.call(fetchCalls[0].body, "stream")
      && !Object.prototype.hasOwnProperty.call(fetchCalls[0].body, "store")
      && fetchCalls[1].body?.stream === true;
  } finally {
    globalThis.fetch = originalFetch;
  }
  const outputDir = resolveOutputDir(join(tmpdir(), "api-image-gen-self-test"));
  const saved = saveBase64Image(base64, outputDir, "self_test_edit");
  const savedOk = !!saved?.path
    && existsSync(saved.path)
    && saved.width === 1
    && saved.height === 1
    && jsonBase64 === pngB64
    && partialBase64 === pngB64;
  const resizedSaved = saveBase64Image(base64, outputDir, "self_test_resize", null, "2x2");
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

  if (!explicitSizeOk || !payloadOk || !cloneOk || !fallbackOk || !savedOk || !resizePreserveOk) {
    console.error("Edit Responses self-test FAILED.");
    console.error(JSON.stringify({
      explicitSizeOk,
      payloadOk,
      cloneOk,
      fallbackOk,
      fetchCalls,
      savedOk,
      resizePreserveOk,
      saved,
      resizedSaved,
    }, null, 2));
    return 1;
  }

  console.log("Edit Responses self-test OK.");
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
    else if (value === "--responses-url" && argv[i + 1]) args.flags.responsesUrl = argv[++i];
    else if (value === "--text-model" && i + 1 < argv.length) args.flags.textModel = argv[++i];
    else if (value === "--image-model" && argv[i + 1]) args.flags.imageModel = argv[++i];
    else if (value === "--image-model-as-top-level") args.flags.imageModelAsTopLevel = true;
    else if (value === "--no-image-model-as-top-level") args.flags.imageModelAsTopLevel = false;
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
      args.flags.unsupportedEditRoute = "legacy-edit";
    } else if (value === "--edit-api" && argv[i + 1]) {
      const route = String(argv[++i]).trim().toLowerCase();
      if (route && route !== "responses") args.flags.unsupportedEditRoute = `edit-api:${route}`;
    }
    else if (value === "--image" && argv[i + 1]) {
      if (!args.flags.images) args.flags.images = [];
      args.flags.images.push(argv[++i]);
    } else if (value === "--resolve-size") args.flags.resolveSize = true;
    else if (value === "--self-test-adaptive") args.flags.selfTestAdaptive = true;
    else if (value === "--self-test-edit-responses") args.flags.selfTestEditResponses = true;
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
  --set-api-config [--api-profile NAME] [--api-root URL] [--responses-url URL] [--text-model MODEL] [--image-model MODEL] [--image-model-as-top-level|--no-image-model-as-top-level]
  --set-quick-mode --ratio R --count 1..${MAX_GENERATION_COUNT}
  --set-batch-mode --ratio R --concurrency 1..${MAX_CONCURRENCY}

GENERATE
  --prompt "..." [--api-profile NAME] [--api-root URL|--responses-url URL] [--text-model MODEL] [--image-model MODEL] [--image-model-as-top-level] [--ratio R|--aspect R|--size WxH] [--count 1..${MAX_GENERATION_COUNT}] [--no-resize]
  --prompt "..." --repeat 1..${MAX_REPEAT} [--concurrency 1..${MAX_CONCURRENCY}] [--adaptive|--no-adaptive]
  --batch prompts.json [--ratio R|--aspect R|--size WxH] [--concurrency N] [--no-resize]
  --batch-inline "prompt 1" "prompt 2" ... [--ratio R|--aspect R|--size WxH] [--concurrency N] [--no-resize]

EDIT
  --edit --image path.png --prompt "..." [--ratio R|--aspect R|--size WxH] [--count 1..${MAX_EDIT_COUNT}] [--no-resize]
  --edit --image one.png --image two.png --prompt "..." [--ratio R|--aspect R|--size WxH] [--count 1..${MAX_EDIT_COUNT}] [--no-resize]    combine all sources in one Responses edit request
  --batch-edit --edit --image one.png --image two.png --prompt "..." [--ratio R|--aspect R|--size WxH] [--concurrency N] [--no-resize]
  image-to-image route is fixed to Responses API; --legacy-edit and --edit-api images are disabled

TOOLS
  --resolve-size --quality 2K --aspect 16:9
  --resolve-size --size 2048*1024
  --self-test-adaptive
  --self-test-edit-responses

DEFAULTS
  config: ${CONFIG_PATH} or API_IMAGE_GEN_CONFIG
  API root: ${DEFAULT_API_CONFIG.apiRoot}
  responses URL: ${defaultResponsesUrl(DEFAULT_API_CONFIG.apiRoot)}
  text model: not sent unless textModel is configured
  image model: ${DEFAULT_API_CONFIG.imageModel}
  image model as top-level: off
  edit API: responses only
  request quality: default ${DEFAULTS.quality}; supported ${Object.keys(sizeMatrix).join(", ")}
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
      api: apiConfig,
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
      console.error("ERROR: --set-api-config requires at least one of --api-root, --responses-url, --text-model, --image-model, --image-model-as-top-level, or --no-image-model-as-top-level.");
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

  if (flags.selfTestEditResponses) {
    process.exitCode = await runEditResponsesSelfTest();
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
      console.error("ERROR: Image-to-image is fixed to Responses API with input_image blocks. --legacy-edit and --edit-api images are disabled in this plugin.");
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
        }
      }
      console.error(`Edit failed: ${result.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Edit prompt: "${prompts[0]}"`);
    if (count > 1) {
      for (const [index, item] of result.results.entries()) {
        console.log(`${index + 1}. ${item.path} ${formatImageResult(item)}`);
      }
    } else {
      console.log(`Path: ${result.path}`);
      console.log(`Size: ${formatImageResult(result)}`);
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
    process.exit(1);
  }
  console.log(`Prompt: "${prompt}"`);
  console.log(`Path: ${result.path}`);
  console.log(`Size: ${formatImageResult(result)}`);
  console.log(`Time: ${(result.elapsed / 1000).toFixed(1)}s`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
