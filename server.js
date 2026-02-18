const crypto = require("crypto");
const http = require("http");
const fsSync = require("fs");
const fs = require("fs/promises");
const path = require("path");
const { Readable } = require("stream");
const express = require("express");
const { Server: SocketIOServer } = require("socket.io");

loadDotEnv(path.join(__dirname, ".env"));

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: true,
    credentials: true
  }
});

const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const CHANNELS_FILE = path.join(DATA_DIR, "channels.json");

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const ADMIN_PATH = normalizeAdminPath(process.env.ADMIN_PATH || "/control-room");
const SESSION_COOKIE = "admin_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const COMMENT_HISTORY_LIMIT = 120;
const COMMENT_RATE_LIMIT_MS = 900;
const COMMENT_NAME_MAX_LENGTH = 40;
const COMMENT_MESSAGE_MAX_LENGTH = 280;
const DEFAULT_CHAT_ROOM = "lobby";
const HLS_PROXY_REQUEST_TIMEOUT_MS = 1000 * 20;
const HLS_PROXY_SEGMENT_TTL_MS = 1000 * 60 * 2;
const HLS_PROXY_PLAYLIST_TTL_MS = 1000 * 60 * 4;
const HLS_PROXY_KEY_TTL_MS = 1000 * 60 * 10;
const HLS_PROXY_OTHER_TTL_MS = 1000 * 60 * 5;

const sessions = new Map();
const liveCommentsByRoom = new Map();
const socketRoomMap = new Map();
const socketLastCommentAt = new Map();
const hlsProxyTokens = new Map();
const hlsProxyUrlIndex = new Map();
const hlsChannelTokens = new Map();
const hlsChannelSegmentWindows = new Map();

app.use(express.json({ limit: "1mb" }));

function loadDotEnv(filePath) {
  let raw = "";
  try {
    raw = fsSync.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Failed to read .env file:", error.message);
    }
    return;
  }

  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }

    const key = match[1];
    let value = match[2] ?? "";
    const isDoubleQuoted = value.startsWith('"') && value.endsWith('"');
    const isSingleQuoted = value.startsWith("'") && value.endsWith("'");

    if (isDoubleQuoted || isSingleQuoted) {
      value = value.slice(1, -1);
      if (isDoubleQuoted) {
        value = value
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
      }
    } else {
      value = value.trim();
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function normalizeAdminPath(value) {
  let adminPath = String(value || "").trim();
  if (!adminPath) {
    adminPath = "/control-room";
  }
  if (!adminPath.startsWith("/")) {
    adminPath = `/${adminPath}`;
  }
  adminPath = adminPath.replace(/\/+/g, "/");
  if (adminPath.length > 1 && adminPath.endsWith("/")) {
    adminPath = adminPath.slice(0, -1);
  }
  if (adminPath === "/" || adminPath === "/admin" || adminPath === "/admin.html") {
    return "/control-room";
  }
  return adminPath;
}

function parseCookies(cookieHeader = "") {
  return cookieHeader.split(";").reduce((result, part) => {
    const [key, ...rawValue] = part.trim().split("=");
    if (!key) {
      return result;
    }
    result[key] = decodeURIComponent(rawValue.join("=") || "");
    return result;
  }, {});
}

function getSessionToken(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  return cookies[SESSION_COOKIE] || "";
}

function isSessionValid(token) {
  const expiresAt = sessions.get(token);
  if (!expiresAt) {
    return false;
  }
  if (Date.now() > expiresAt) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function createSession() {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function clearSession(token) {
  if (token) {
    sessions.delete(token);
  }
}

function requireAdmin(req, res, next) {
  const token = getSessionToken(req);
  if (!isSessionValid(token)) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return next();
}

function normalizeString(value) {
  return String(value || "").trim();
}

function getRequestBaseUrl(req) {
  const forwardedProto = normalizeString(req.headers["x-forwarded-proto"]).split(",")[0];
  const protocol = normalizeString(forwardedProto) || req.protocol || "http";
  const host = normalizeString(req.get("host"));
  if (!host) {
    return `${protocol}://localhost:${PORT}`;
  }
  return `${protocol}://${host}`;
}

function normalizeChatRoom(value) {
  const room = normalizeString(value).toLowerCase();
  if (!room) {
    return DEFAULT_CHAT_ROOM;
  }
  return room.replace(/[^a-z0-9-_]/g, "").slice(0, 80) || DEFAULT_CHAT_ROOM;
}

function sanitizeName(value) {
  const normalized = normalizeString(value).replace(/\s+/g, " ");
  return normalized.slice(0, COMMENT_NAME_MAX_LENGTH) || "Guest";
}

function sanitizeMessage(value) {
  const normalized = normalizeString(value).replace(/\s+/g, " ");
  return normalized.slice(0, COMMENT_MESSAGE_MAX_LENGTH);
}

function generateCommentId() {
  return crypto.randomBytes(10).toString("hex");
}

function getRoomComments(roomId) {
  if (!liveCommentsByRoom.has(roomId)) {
    liveCommentsByRoom.set(roomId, []);
  }
  return liveCommentsByRoom.get(roomId);
}

function getRoomViewerCount(roomId) {
  const room = io.sockets.adapter.rooms.get(roomId);
  return room ? room.size : 0;
}

function broadcastRoomViewerCount(roomId) {
  io.to(roomId).emit("comment:viewers", {
    roomId,
    count: getRoomViewerCount(roomId)
  });
}

function normalizePriority(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

function slugify(value) {
  const slug = normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "channel";
}

function ensureUniqueId(baseId, channels, ignoreId = "") {
  const taken = new Set(channels.map((channel) => channel.id).filter((id) => id !== ignoreId));
  if (!taken.has(baseId)) {
    return baseId;
  }
  let index = 2;
  let candidate = `${baseId}-${index}`;
  while (taken.has(candidate)) {
    index += 1;
    candidate = `${baseId}-${index}`;
  }
  return candidate;
}

function sortChannels(channels) {
  return [...channels].sort((a, b) => {
    const priorityA = normalizePriority(a.priority, Number.MAX_SAFE_INTEGER);
    const priorityB = normalizePriority(b.priority, Number.MAX_SAFE_INTEGER);
    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }
    return normalizeString(a.name).localeCompare(normalizeString(b.name));
  });
}

function reindexChannels(channels) {
  return sortChannels(channels).map((channel, index) => ({
    ...channel,
    priority: index + 1
  }));
}

function sanitizeChannels(rawChannels) {
  if (!Array.isArray(rawChannels)) {
    return [];
  }

  const cleaned = [];
  for (const [index, rawChannel] of rawChannels.entries()) {
    const name = normalizeString(rawChannel?.name);
    const category = normalizeString(rawChannel?.category) || "General";
    const country = normalizeString(rawChannel?.country);
    const thumbnail = normalizeString(rawChannel?.thumbnail);
    const streamUrl = normalizeString(rawChannel?.streamUrl);

    if (!name || !thumbnail || !streamUrl) {
      continue;
    }

    const requestedId = normalizeString(rawChannel?.id) || name || `channel-${index + 1}`;
    const baseId = slugify(requestedId);
    const id = ensureUniqueId(baseId, cleaned);

    cleaned.push({
      id,
      name,
      category,
      country,
      thumbnail,
      streamUrl,
      priority: normalizePriority(rawChannel?.priority, cleaned.length + 1)
    });
  }

  return reindexChannels(cleaned);
}

function validateChannel(payload) {
  const input = payload || {};
  const name = normalizeString(input.name);
  const category = normalizeString(input.category);
  const country = normalizeString(input.country);
  const thumbnail = normalizeString(input.thumbnail);
  const streamUrl = normalizeString(input.streamUrl);
  const requestedId = normalizeString(input.id);
  const priority = normalizePriority(input.priority, 0);

  if (!name || !category || !thumbnail || !streamUrl) {
    return { valid: false, message: "name, category, thumbnail, and streamUrl are required." };
  }

  if (!/^https?:\/\//i.test(streamUrl)) {
    return { valid: false, message: "streamUrl must be a valid http(s) URL." };
  }

  if (!/^https?:\/\//i.test(thumbnail)) {
    return { valid: false, message: "thumbnail must be a valid http(s) URL." };
  }

  return {
    valid: true,
    channel: {
      id: requestedId,
      name,
      category,
      country,
      thumbnail,
      streamUrl,
      priority
    }
  };
}

async function readChannels() {
  try {
    const raw = await fs.readFile(CHANNELS_FILE, "utf8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    return sanitizeChannels(parsed);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeChannels(channels) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const normalized = reindexChannels(channels);
  const json = `${JSON.stringify(normalized, null, 2)}\n`;
  await fs.writeFile(CHANNELS_FILE, json, "utf8");
}

function sessionCookie(token, maxAge) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function insertByPriority(channels, channel, priority) {
  const ordered = sortChannels(channels);
  const targetIndex = clamp(priority - 1, 0, ordered.length);
  ordered.splice(targetIndex, 0, channel);
  return ordered.map((item, index) => ({ ...item, priority: index + 1 }));
}

function buildPlaybackUrl(channelId) {
  return `/api/hls/${encodeURIComponent(channelId)}/master.m3u8`;
}

function toPublicChannel(channel) {
  const { streamUrl: _streamUrl, ...safeChannel } = channel;
  return {
    ...safeChannel,
    playbackUrl: buildPlaybackUrl(channel.id)
  };
}

function getHlsTokenTtlMs(resourceType) {
  if (resourceType === "segment") {
    return HLS_PROXY_SEGMENT_TTL_MS;
  }
  if (resourceType === "playlist") {
    return HLS_PROXY_PLAYLIST_TTL_MS;
  }
  if (resourceType === "key") {
    return HLS_PROXY_KEY_TTL_MS;
  }
  return HLS_PROXY_OTHER_TTL_MS;
}

function detectHlsResourceType(targetUrl, hint = "") {
  const normalizedHint = normalizeString(hint).toLowerCase();
  if (normalizedHint === "segment" || normalizedHint === "playlist" || normalizedHint === "key") {
    return normalizedHint;
  }

  try {
    const pathname = new URL(targetUrl).pathname.toLowerCase();
    if (pathname.endsWith(".m3u8") || pathname.endsWith(".m3u")) {
      return "playlist";
    }
    if (pathname.endsWith(".key")) {
      return "key";
    }
    if (
      pathname.endsWith(".ts") ||
      pathname.endsWith(".m4s") ||
      pathname.endsWith(".mp4") ||
      pathname.endsWith(".aac") ||
      pathname.endsWith(".vtt") ||
      pathname.endsWith(".webvtt")
    ) {
      return "segment";
    }
  } catch (_error) {
    return "other";
  }

  return "other";
}

function buildHlsTokenCacheKey(channelId, targetUrl, resourceType) {
  return `${channelId}|${resourceType}|${targetUrl}`;
}

function addChannelToken(channelId, token) {
  if (!hlsChannelTokens.has(channelId)) {
    hlsChannelTokens.set(channelId, new Set());
  }
  hlsChannelTokens.get(channelId).add(token);
}

function removeChannelToken(channelId, token) {
  const tokenSet = hlsChannelTokens.get(channelId);
  if (!tokenSet) {
    return;
  }
  tokenSet.delete(token);
  if (!tokenSet.size) {
    hlsChannelTokens.delete(channelId);
  }
}

function deleteHlsProxyToken(token) {
  const entry = hlsProxyTokens.get(token);
  if (!entry) {
    return;
  }
  hlsProxyTokens.delete(token);
  removeChannelToken(entry.channelId, token);
  if (entry.cacheKey && hlsProxyUrlIndex.get(entry.cacheKey) === token) {
    hlsProxyUrlIndex.delete(entry.cacheKey);
  }
}

function createHlsProxyToken(channelId, targetUrl, resourceHint = "") {
  const resourceType = detectHlsResourceType(targetUrl, resourceHint);
  const cacheKey = buildHlsTokenCacheKey(channelId, targetUrl, resourceType);
  const ttl = getHlsTokenTtlMs(resourceType);
  const now = Date.now();
  const existingToken = hlsProxyUrlIndex.get(cacheKey);

  if (existingToken) {
    const existingEntry = hlsProxyTokens.get(existingToken);
    if (existingEntry && existingEntry.expiresAt > now) {
      existingEntry.expiresAt = now + ttl;
      return {
        token: existingToken,
        cacheKey,
        resourceType
      };
    }
    deleteHlsProxyToken(existingToken);
  }

  const token = crypto.randomBytes(18).toString("hex");
  hlsProxyTokens.set(token, {
    channelId,
    targetUrl,
    cacheKey,
    resourceType,
    expiresAt: now + ttl
  });
  hlsProxyUrlIndex.set(cacheKey, token);
  addChannelToken(channelId, token);

  return {
    token,
    cacheKey,
    resourceType
  };
}

function getHlsProxyTarget(channelId, token) {
  const entry = hlsProxyTokens.get(token);
  if (!entry) {
    return "";
  }
  if (entry.channelId !== channelId) {
    return "";
  }
  if (entry.expiresAt <= Date.now()) {
    deleteHlsProxyToken(token);
    return "";
  }
  entry.expiresAt = Date.now() + getHlsTokenTtlMs(entry.resourceType);
  return entry.targetUrl;
}

function resolveHlsUri(baseUrl, rawUri) {
  const candidate = normalizeString(rawUri);
  if (!candidate) {
    return "";
  }

  try {
    const resolved = new URL(candidate, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return "";
    }
    return resolved.toString();
  } catch (_error) {
    return "";
  }
}

function createProxyAssetPath(channelId, targetUrl, resourceHint = "", currentSegmentKeys = null) {
  const tokenMeta = createHlsProxyToken(channelId, targetUrl, resourceHint);
  if (currentSegmentKeys && tokenMeta.resourceType === "segment") {
    currentSegmentKeys.add(tokenMeta.cacheKey);
  }
  return `/api/hls/${encodeURIComponent(channelId)}/asset/${tokenMeta.token}`;
}

function rewriteHlsTagUris(line, baseUrl, channelId, currentSegmentKeys = null) {
  const normalized = line.trim().toUpperCase();
  const hint = normalized.startsWith("#EXT-X-KEY") ? "key" : normalized.startsWith("#EXT-X-MAP") ? "segment" : "";
  return line
    .replace(/URI="([^"]+)"/g, (match, uri) => {
      const resolved = resolveHlsUri(baseUrl, uri);
      if (!resolved) {
        return match;
      }
      return `URI="${createProxyAssetPath(channelId, resolved, hint, currentSegmentKeys)}"`;
    })
    .replace(/URI='([^']+)'/g, (match, uri) => {
      const resolved = resolveHlsUri(baseUrl, uri);
      if (!resolved) {
        return match;
      }
      return `URI='${createProxyAssetPath(channelId, resolved, hint, currentSegmentKeys)}'`;
    });
}

function isLikelyMediaPlaylist(playlistText) {
  const normalized = String(playlistText || "").toUpperCase();
  return normalized.includes("#EXTINF:") || normalized.includes("#EXT-X-MEDIA-SEQUENCE");
}

function pruneChannelOldSegments(channelId, currentSegmentKeys) {
  const existing = hlsChannelSegmentWindows.get(channelId) || {
    current: new Set(),
    previous: new Set()
  };
  const staleKeys = [];

  for (const cacheKey of existing.previous) {
    if (!existing.current.has(cacheKey) && !currentSegmentKeys.has(cacheKey)) {
      staleKeys.push(cacheKey);
    }
  }

  for (const cacheKey of staleKeys) {
    const token = hlsProxyUrlIndex.get(cacheKey);
    if (token) {
      deleteHlsProxyToken(token);
    }
  }

  hlsChannelSegmentWindows.set(channelId, {
    previous: new Set(existing.current),
    current: new Set(currentSegmentKeys)
  });
}

function rewriteHlsPlaylist(playlistText, baseUrl, channelId) {
  const isMediaPlaylist = isLikelyMediaPlaylist(playlistText);
  const currentSegmentKeys = isMediaPlaylist ? new Set() : null;

  const rewritten = String(playlistText || "")
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return line;
      }
      if (trimmed.startsWith("#")) {
        return rewriteHlsTagUris(line, baseUrl, channelId, currentSegmentKeys);
      }
      const resolved = resolveHlsUri(baseUrl, trimmed);
      if (!resolved) {
        return line;
      }
      const hint = detectHlsResourceType(resolved);
      return createProxyAssetPath(channelId, resolved, hint, currentSegmentKeys);
    })
    .join("\n");

  if (isMediaPlaylist && currentSegmentKeys) {
    pruneChannelOldSegments(channelId, currentSegmentKeys);
  }

  return rewritten;
}

function isHlsPlaylistResponse(contentType, targetUrl) {
  const normalizedType = normalizeString(contentType).toLowerCase();
  if (
    normalizedType.includes("application/vnd.apple.mpegurl") ||
    normalizedType.includes("application/x-mpegurl") ||
    normalizedType.includes("audio/mpegurl")
  ) {
    return true;
  }

  try {
    const pathname = new URL(targetUrl).pathname.toLowerCase();
    return pathname.endsWith(".m3u8") || pathname.endsWith(".m3u");
  } catch (_error) {
    return false;
  }
}

async function proxyHlsRequest(req, res, channelId, targetUrl) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HLS_PROXY_REQUEST_TIMEOUT_MS);
  const requestHeaders = {};
  const range = normalizeString(req.headers.range);
  const userAgent = normalizeString(req.headers["user-agent"]);

  if (range) {
    requestHeaders.Range = range;
  }
  if (userAgent) {
    requestHeaders["User-Agent"] = userAgent;
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(targetUrl, {
      method: "GET",
      headers: requestHeaders,
      redirect: "follow",
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      res.status(504).send("Upstream stream request timed out.");
      return;
    }
    res.status(502).send("Unable to fetch upstream stream.");
    return;
  } finally {
    clearTimeout(timeoutId);
  }

  const finalUrl = normalizeString(upstreamResponse.url) || targetUrl;
  const contentType = normalizeString(upstreamResponse.headers.get("content-type"));
  const isPlaylist = isHlsPlaylistResponse(contentType, finalUrl);

  res.status(upstreamResponse.status);

  for (const headerName of ["cache-control", "etag", "last-modified", "accept-ranges", "content-range"]) {
    const value = upstreamResponse.headers.get(headerName);
    if (value) {
      res.setHeader(headerName, value);
    }
  }

  if (!upstreamResponse.ok) {
    const errorText = await upstreamResponse.text().catch(() => "");
    res.type("text/plain");
    res.send(errorText || "Upstream stream request failed.");
    return;
  }

  if (isPlaylist) {
    const playlistText = await upstreamResponse.text();
    const rewritten = rewriteHlsPlaylist(playlistText, finalUrl, channelId);
    res.type("application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.send(rewritten);
    return;
  }

  if (contentType) {
    res.setHeader("content-type", contentType);
  }
  const contentLength = upstreamResponse.headers.get("content-length");
  if (contentLength) {
    res.setHeader("content-length", contentLength);
  }

  if (!upstreamResponse.body) {
    res.end();
    return;
  }

  const stream = Readable.fromWeb(upstreamResponse.body);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.status(502).end();
      return;
    }
    res.end();
  });
  stream.pipe(res);
}

app.post("/api/admin/login", (req, res) => {
  const username = normalizeString(req.body?.username);
  const password = normalizeString(req.body?.password);

  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ message: "Invalid credentials" });
  }

  const token = createSession();
  res.setHeader("Set-Cookie", sessionCookie(token, SESSION_TTL_MS / 1000));
  return res.json({ message: "Login successful", username: ADMIN_USERNAME });
});

app.post("/api/admin/logout", (req, res) => {
  clearSession(getSessionToken(req));
  res.setHeader("Set-Cookie", sessionCookie("", 0));
  return res.json({ message: "Logged out" });
});

app.get("/api/admin/me", requireAdmin, (_req, res) => {
  return res.json({
    authenticated: true,
    username: ADMIN_USERNAME,
    adminPath: ADMIN_PATH
  });
});

app.get("/api/channels", async (_req, res) => {
  const channels = await readChannels();
  return res.json(sortChannels(channels).map(toPublicChannel));
});

app.get("/api/admin/channels", requireAdmin, async (_req, res) => {
  const channels = await readChannels();
  return res.json(sortChannels(channels));
});

app.get("/api/hls/:id/master.m3u8", async (req, res) => {
  const channelId = normalizeString(req.params.id);
  const channels = await readChannels();
  const channel = channels.find((item) => item.id === channelId);
  if (!channel) {
    return res.status(404).send("Channel not found.");
  }

  await proxyHlsRequest(req, res, channel.id, channel.streamUrl);
});

app.get("/api/hls/:id/asset/:token", async (req, res) => {
  const channelId = normalizeString(req.params.id);
  const token = normalizeString(req.params.token);
  if (!channelId || !token) {
    return res.status(400).send("Invalid stream asset request.");
  }

  const targetUrl = getHlsProxyTarget(channelId, token);
  if (!targetUrl) {
    return res.status(404).send("Stream asset expired or unavailable.");
  }

  await proxyHlsRequest(req, res, channelId, targetUrl);
});

app.post("/api/channels", requireAdmin, async (req, res) => {
  const validation = validateChannel(req.body);
  if (!validation.valid) {
    return res.status(400).json({ message: validation.message });
  }

  const channels = await readChannels();
  const baseId = slugify(validation.channel.id || validation.channel.name);
  const id = ensureUniqueId(baseId, channels);
  const desiredPriority = normalizePriority(validation.channel.priority, channels.length + 1);

  const newChannel = { ...validation.channel, id, priority: desiredPriority };
  const updatedChannels = insertByPriority(channels, newChannel, desiredPriority);
  await writeChannels(updatedChannels);

  const created = updatedChannels.find((channel) => channel.id === id);
  return res.status(201).json(created);
});

app.put("/api/channels/:id", requireAdmin, async (req, res) => {
  const channelId = normalizeString(req.params.id);
  const validation = validateChannel(req.body);
  if (!validation.valid) {
    return res.status(400).json({ message: validation.message });
  }

  const channels = await readChannels();
  const current = channels.find((channel) => channel.id === channelId);
  if (!current) {
    return res.status(404).json({ message: "Channel not found" });
  }

  const remaining = channels.filter((channel) => channel.id !== channelId);
  const baseId = slugify(validation.channel.id || validation.channel.name);
  const id = ensureUniqueId(baseId, remaining, channelId);
  const desiredPriority = normalizePriority(validation.channel.priority, current.priority || remaining.length + 1);

  const updatedChannel = {
    ...validation.channel,
    id,
    priority: desiredPriority
  };

  const updatedChannels = insertByPriority(remaining, updatedChannel, desiredPriority);
  await writeChannels(updatedChannels);
  const updated = updatedChannels.find((channel) => channel.id === id);
  return res.json(updated);
});

app.patch("/api/channels/:id/priority", requireAdmin, async (req, res) => {
  const channelId = normalizeString(req.params.id);
  const channels = await readChannels();
  const index = channels.findIndex((channel) => channel.id === channelId);
  if (index === -1) {
    return res.status(404).json({ message: "Channel not found" });
  }

  const requestedPriority = normalizePriority(req.body?.priority, 0);
  if (!requestedPriority) {
    return res.status(400).json({ message: "priority must be an integer greater than 0." });
  }

  const ordered = sortChannels(channels);
  const currentIndex = ordered.findIndex((channel) => channel.id === channelId);
  const [moved] = ordered.splice(currentIndex, 1);
  const targetIndex = clamp(requestedPriority - 1, 0, ordered.length);
  ordered.splice(targetIndex, 0, moved);
  const reordered = ordered.map((channel, orderIndex) => ({
    ...channel,
    priority: orderIndex + 1
  }));

  await writeChannels(reordered);
  return res.json({
    message: "Priority updated",
    channel: reordered.find((channel) => channel.id === channelId),
    channels: reordered
  });
});

app.delete("/api/channels/:id", requireAdmin, async (req, res) => {
  const channelId = normalizeString(req.params.id);
  const channels = await readChannels();
  const remaining = channels.filter((channel) => channel.id !== channelId);
  if (remaining.length === channels.length) {
    return res.status(404).json({ message: "Channel not found" });
  }

  await writeChannels(remaining);
  return res.json({ message: "Channel deleted" });
});

app.use((req, res, next) => {
  const blockedPaths = new Set(["/admin", "/admin/", "/admin.html"]);
  if (blockedPaths.has(req.path)) {
    return res.status(404).send("Not found");
  }
  return next();
});

app.get("/robots.txt", (req, res) => {
  const baseUrl = getRequestBaseUrl(req);
  const lines = [
    "User-agent: *",
    "Allow: /",
    `Disallow: ${ADMIN_PATH}`,
    `Disallow: ${ADMIN_PATH}/`,
    "Disallow: /admin",
    "Disallow: /admin/",
    "Disallow: /admin.html",
    "Disallow: /api/",
    `Sitemap: ${baseUrl}/sitemap.xml`
  ];

  res.type("text/plain");
  res.send(`${lines.join("\n")}\n`);
});

app.get("/sitemap.xml", (req, res) => {
  const baseUrl = getRequestBaseUrl(req);
  const today = new Date().toISOString().slice(0, 10);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>hourly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`;

  res.type("application/xml");
  res.send(xml);
});

app.use(express.static(PUBLIC_DIR, { index: false }));

app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get([ADMIN_PATH, `${ADMIN_PATH}/`], (_req, res) => {
  res.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
});

app.use("/api", (_req, res) => {
  res.status(404).json({ message: "API route not found" });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ message: "Server error" });
});

io.on("connection", (socket) => {
  let activeRoom = DEFAULT_CHAT_ROOM;

  socket.join(activeRoom);
  socketRoomMap.set(socket.id, activeRoom);
  socket.emit("comment:history", {
    roomId: activeRoom,
    comments: getRoomComments(activeRoom)
  });
  broadcastRoomViewerCount(activeRoom);

  socket.on("comment:join", (payload = {}) => {
    const nextRoom = normalizeChatRoom(payload.roomId);
    if (!nextRoom || nextRoom === activeRoom) {
      socket.emit("comment:history", {
        roomId: activeRoom,
        comments: getRoomComments(activeRoom)
      });
      socket.emit("comment:viewers", {
        roomId: activeRoom,
        count: getRoomViewerCount(activeRoom)
      });
      return;
    }

    const previousRoom = activeRoom;
    socket.leave(previousRoom);
    socket.join(nextRoom);
    activeRoom = nextRoom;
    socketRoomMap.set(socket.id, nextRoom);

    socket.emit("comment:history", {
      roomId: nextRoom,
      comments: getRoomComments(nextRoom)
    });
    broadcastRoomViewerCount(previousRoom);
    broadcastRoomViewerCount(nextRoom);
  });

  socket.on("comment:send", (payload = {}, ack) => {
    const now = Date.now();
    const lastCommentAt = socketLastCommentAt.get(socket.id) || 0;
    if (now - lastCommentAt < COMMENT_RATE_LIMIT_MS) {
      if (typeof ack === "function") {
        ack({ ok: false, message: "Please wait before sending another comment." });
      }
      return;
    }

    const name = sanitizeName(payload.name);
    const message = sanitizeMessage(payload.message);
    if (!message) {
      if (typeof ack === "function") {
        ack({ ok: false, message: "Comment message is required." });
      }
      return;
    }

    const roomId = socketRoomMap.get(socket.id) || activeRoom || DEFAULT_CHAT_ROOM;
    const comment = {
      id: generateCommentId(),
      roomId,
      name,
      message,
      createdAt: new Date().toISOString()
    };

    const roomComments = getRoomComments(roomId);
    roomComments.push(comment);
    if (roomComments.length > COMMENT_HISTORY_LIMIT) {
      roomComments.splice(0, roomComments.length - COMMENT_HISTORY_LIMIT);
    }

    socketLastCommentAt.set(socket.id, now);
    io.to(roomId).emit("comment:new", comment);

    if (typeof ack === "function") {
      ack({ ok: true, comment });
    }
  });

  socket.on("disconnect", () => {
    const roomId = socketRoomMap.get(socket.id) || activeRoom;
    socketRoomMap.delete(socket.id);
    socketLastCommentAt.delete(socket.id);
    if (roomId) {
      broadcastRoomViewerCount(roomId);
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [token, expiresAt] of sessions.entries()) {
    if (expiresAt <= now) {
      sessions.delete(token);
    }
  }
}, 15 * 60 * 1000);

setInterval(() => {
  const now = Date.now();
  for (const [token, meta] of hlsProxyTokens.entries()) {
    if (meta.expiresAt <= now) {
      deleteHlsProxyToken(token);
    }
  }

  for (const [channelId, windowState] of hlsChannelSegmentWindows.entries()) {
    const current = new Set([...windowState.current].filter((cacheKey) => hlsProxyUrlIndex.has(cacheKey)));
    const previous = new Set([...windowState.previous].filter((cacheKey) => hlsProxyUrlIndex.has(cacheKey)));
    if (!current.size && !previous.size) {
      hlsChannelSegmentWindows.delete(channelId);
      continue;
    }
    hlsChannelSegmentWindows.set(channelId, { current, previous });
  }
}, 60 * 1000);

server.listen(PORT, () => {
  console.log(`LiveTV server running on http://localhost:${PORT}`);
  console.log(`Hidden admin path configured: ${ADMIN_PATH}`);
});
