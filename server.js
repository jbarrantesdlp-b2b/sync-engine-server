require('dotenv').config({ path: require('path').join(__dirname, '.env') });

// ==== Web Push Setup ====
const webPush = require('web-push');
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "BD7oG-w_r6z79_nS7N4K43m_B9k4vN5uP8q9l2m3n4o5p6q7r8s9t0u1v2w3x4y5z_SYNC_ENGINE_KEY";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "YOUR_PRIVATE_VAPID_KEY_PLACEHOLDER";
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'mailto:admin@syncengine.local';
let webPushConfigured = false;
try {
  webPush.setVapidDetails(
    VAPID_EMAIL,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
  webPushConfigured = true;
} catch (err) {
  const message = process.env.NODE_ENV === "production"
    ? "[Push] Web Push deshabilitado; el servidor continuará sin notificaciones push."
    : "[Push] Web Push deshabilitado: configure claves VAPID válidas.";
  console.warn(message, err.message);
}

// Helper to store subscription per syncId (multiple devices allowed)
function storeSubscription(syncId, subscription) {
  const dbData = db.readDb ? db.readDb() : db.readDb(); // Ensure db is loaded
  if (!dbData.subscriptions) dbData.subscriptions = {};
  if (!Array.isArray(dbData.subscriptions[syncId])) {
    dbData.subscriptions[syncId] = [];
  }
  // Avoid duplicates based on endpoint
  const exists = dbData.subscriptions[syncId].some(sub => sub.endpoint === subscription.endpoint);
  if (!exists) {
    dbData.subscriptions[syncId].push(subscription);
    db.writeDb(dbData);
  }
}

// Helper to send push notification to all stored subscriptions for a syncId
async function sendPushNotification(syncId, payload) {
  if (!webPushConfigured) {
    return;
  }
  const dbData = db.readDb();
  const subs = (dbData.subscriptions && dbData.subscriptions[syncId]) || [];
  const promises = subs.map(sub =>
    webPush.sendNotification(sub, JSON.stringify(payload)).catch(err => {
      // Remove invalid subscription
      if (err.statusCode === 410 || err.statusCode === 404) {
        const idx = subs.findIndex(s => s.endpoint === sub.endpoint);
        if (idx !== -1) subs.splice(idx, 1);
        db.writeDb(dbData);
      }
    })
  );
  await Promise.all(promises);
}

// Extend send-private-message logic for offline push notification
// (Insert after line 560 where message is emitted to target sockets)
// Note: The following code snippet will be inserted at the appropriate location in the existing function.
/*
if (!isTargetOnline) {
  // Prepare minimal push payload
  const pushPayload = {
    title: 'Nuevo mensaje de ' + sender.formattedName,
    body: text.length > 100 ? text.slice(0, 97) + '...' : text,
    icon: '/assets/logo.png',
    data: { syncId: targetSyncId, fromSyncId: sender.syncId, type: 'message' }
  };
  sendPushNotification(targetSyncId, pushPayload).catch(e => console.warn('[Push] envío fallido:', e.message));
}
*/

// ==== End of Web Push Additions ====
const fs = require("fs");
const dns = require("dns").promises;
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Server } = require("socket.io");
const selfsigned = require("selfsigned");
const db = require("./db");
const { safeUrl } = require("./public/safe-content");

const asyncHandler = (fn) => (req, res, next) => {
  fn(req, res, next).catch(next);
};

const PORT = (process.env.PORT && process.env.PORT !== "8080") ? process.env.PORT : 3000;
const HOST = "0.0.0.0";
const configuredCorsOrigins = new Set(String(process.env.CORS_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean));

function isAllowedCorsOrigin(origin) {
  if (!origin) return true;
  if (origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://")) return true;
  return configuredCorsOrigins.has(origin);
}

function isPrivateAddress(address) {
  const value = String(address || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!value) return true;
  if (value === "localhost" || value.endsWith(".localhost") || value.endsWith(".local") ||
      value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") ||
      value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") ||
      value.startsWith("feb") || value.startsWith("ff")) return true;
  if (value.startsWith("::ffff:")) return isPrivateAddress(value.slice(7));
  if (value.includes(":")) {
    // Reject IPv6 non-global special-use ranges not covered above.
    if (value.startsWith("2001:db8:") || value.startsWith("2001:10:") ||
        value.startsWith("2001:2:") || value.startsWith("2002:") ||
        value.startsWith("64:ff9b:") || value.startsWith("100:")) return true;
    return false;
  }
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  return octets[0] === 10 || octets[0] === 127 || octets[0] === 0 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
    (octets[0] === 192 && octets[1] === 0 && octets[2] === 0) ||
    (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19)) ||
    (octets[0] === 198 && octets[1] === 51 && octets[2] === 100) ||
    (octets[0] === 203 && octets[1] === 0 && octets[2] === 113) ||
    octets[0] >= 224;
}

async function assertPublicPreviewUrl(targetUrl) {
  const parsed = new URL(targetUrl);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname) {
    throw new Error("URL de vista previa no válida");
  }
  if (isPrivateAddress(parsed.hostname)) throw new Error("El destino de la vista previa no está permitido");
  const addresses = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("El destino de la vista previa no está permitido");
  }
}

function getLocalIPv4Addresses() {
  const nets = os.networkInterfaces();
  const addresses = [];

  for (const name of Object.keys(nets)) {
    const netList = nets[name] || [];
    for (let i = 0; i < netList.length; i++) {
      const net = netList[i];
      const isIPv4 = net.family === 4 || net.family === "IPv4";
      if (isIPv4 && !net.internal) {
        addresses.push({ name: name, address: net.address });
      }
    }
  }

  return addresses;
}

const app = express();
const authAttempts = new Map();
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 5;
const AUTH_MAX_TRACKED_IPS = 10000;

function authRateLimit(req, res, next) {
  const now = Date.now();
  // Expire stale keys and bound memory use when requests arrive from many IPs.
  for (const [ip, attempt] of authAttempts) {
    if (attempt.resetAt <= now) authAttempts.delete(ip);
  }
  const key = req.ip || req.socket?.remoteAddress || "unknown";
  const current = authAttempts.get(key);
  if (!current || current.resetAt <= now) {
    if (authAttempts.size >= AUTH_MAX_TRACKED_IPS) {
      const oldestKey = authAttempts.keys().next().value;
      if (oldestKey !== undefined) authAttempts.delete(oldestKey);
    }
    authAttempts.set(key, { count: 1, resetAt: now + AUTH_WINDOW_MS });
    return next();
  }
  if (current.count >= AUTH_MAX_ATTEMPTS) {
    res.setHeader("Retry-After", Math.ceil((current.resetAt - now) / 1000));
    return res.status(429).json({ error: "Demasiados intentos de autenticación; inténtalo en 15 minutos." });
  }
  current.count += 1;
  next();
}

const corsOptions = {
  origin: function (origin, callback) {
    return callback(null, isAllowedCorsOrigin(origin));
  },
  credentials: true
};
app.use(cors(corsOptions));

// Configuración de body-parser limitada a 1 MB para prevenir ataques DoS en memoria
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ limit: "1mb", extended: true }));
app.use(
  "/.well-known",
  express.static(path.join(__dirname, "public", ".well-known"), {
    dotfiles: "allow",
    setHeaders: (res) => res.setHeader("Content-Type", "application/json; charset=utf-8")
  })
);
// Intercept normalized/encoded upload paths BEFORE the public static middleware.
// No alternate static spelling may expose the physical file without authorization.
app.use((req, res, next) => {
  let pathname;
  try {
    pathname = path.posix.normalize(decodeURIComponent(req.path).replace(/\\/g, "/"));
  } catch (_) {
    return res.status(400).json({ error: "Ruta no válida" });
  }
  const parts = pathname.split("/").filter(Boolean);
  if (pathname.includes(":")) return res.status(400).json({ error: "Ruta no válida" });
  if ((parts[0] || "").replace(/[. ]+$/, "").toLowerCase() !== "uploads") return next();
  res.setHeader("Cache-Control", "private, no-store");
  requireFileAuth(req, res, () => {
    const file = parts.length === 2 ? db.getFileByFilename(parts[1]) : null;
    servePrivateFile(req, res, file);
  });
});

// Servir widget universal con cabeceras para iframe y paneles laterales de extensiones
app.get(["/widget", "/widget.html", "/public/widget.html"], (req, res) => {
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader(
    "Content-Security-Policy",
    "frame-ancestors 'self' chrome-extension:* moz-extension:*"
  );
  res.sendFile(path.join(__dirname, "public", "widget.html"));
});

app.use(express.static(path.join(__dirname, "public")));
app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/src/assets/images", express.static(path.join(__dirname, "src/assets/images")));
app.use((err, req, res, next) => {
  if (req.path === "/api/save-subscription" && err instanceof SyntaxError && err.status === 400) {
    return res.status(500).json({ ok: false, error: "Error al procesar el payload de suscripción" });
  }
  next(err);
});
// Directorio y almacenamiento Multer para documentos y archivos pesados (hasta 2 GB sin compresión)
const UPLOADS_DIR = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, UPLOADS_DIR);
  },
  filename: function (_req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_\-\.]/g, "_");
    cb(null, `${base}-${uniqueSuffix}${ext}`);
  }
});

const MAX_STANDARD_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_PREMIUM_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

function uploadSingleFileForPlan(req, res, next) {
  const plan = String(req.user?.plan || "free").trim().toLowerCase();
  const maxBytes = plan === "enterprise" || plan === "pro"
    ? MAX_PREMIUM_UPLOAD_BYTES
    : MAX_STANDARD_UPLOAD_BYTES;

  multer({
    storage: storage,
    limits: { fileSize: maxBytes }
  }).single("file")(req, res, (err) => {
    if (err && err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "El archivo supera el límite del plan" });
    }
    return next(err);
  });
}

// Middleware de Autenticación
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token de sesión requerido" });
  }

  const token = authHeader.slice(7).trim();
  const user = db.getUserByToken(token);
  if (!user) {
    return res.status(401).json({ error: "Sesión expirada o inválida" });
  }

  req.user = user;
  next();
}

const FILE_COOKIE = "sync_engine_file_auth";
const FILE_COOKIE_PATHS = ["/api/files", "/uploads"];

function fileCookieOptions(req, cookiePath) {
  return {
    path: cookiePath, httpOnly: true, sameSite: "strict",
    secure: req.secure || String(req.get("x-forwarded-proto") || "").split(",")[0].trim() === "https" ||
      /^https:\/\//i.test(req.get("origin") || "")
  };
}

// Only file routes accept this transport of an EXISTING session token.
// Login/session creation, expiration and other API authentication are unchanged.
function requireFileAuth(req, res, next) {
  res.setHeader("Cache-Control", "private, no-store");
  if (!req.headers.authorization) {
    const cookie = String(req.headers.cookie || "").split(";")
      .map((part) => part.trim()).find((part) => part.startsWith(FILE_COOKIE + "="));
    if (cookie) {
      try { req.headers.authorization = "Bearer " + decodeURIComponent(cookie.slice(FILE_COOKIE.length + 1)); }
      catch (_) { return res.status(401).json({ error: "Credencial de archivo inválida" }); }
    }
  }
  requireAuth(req, res, next);
}

app.post("/api/files/access", requireAuth, (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const token = req.headers.authorization.slice(7).trim();
  for (const cookiePath of FILE_COOKIE_PATHS) res.cookie(FILE_COOKIE, token, fileCookieOptions(req, cookiePath));
  res.json({ ok: true });
});

app.post("/api/files/access/clear", (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  for (const cookiePath of FILE_COOKIE_PATHS) res.clearCookie(FILE_COOKIE, fileCookieOptions(req, cookiePath));
  res.json({ ok: true });
});

function servePrivateFile(req, res, file) {
  if (!file) return res.status(404).json({ error: "Archivo no registrado" });
  if (!db.canReadFile(file.id, req.user.syncId)) return res.status(403).json({ error: "Sin acceso a este archivo" });
  if (!file.filename || /[/\\:\u0000]/.test(file.filename) || [".", ".."].includes(file.filename)) {
    return res.status(404).json({ error: "Archivo no disponible" });
  }
  // Preserve P0-01 protections, streaming and native byte-range handling.
  res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; script-src 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Vary", "Authorization, Cookie");
  const inlineMedia = /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|mp4|m4v|mov|webm|mp3|wav|ogg|oga|m4a|aac|flac|opus)$/i.test(file.filename);
  if (!inlineMedia || req.query.download === "1") res.attachment(file.name);
  res.sendFile(file.filename, { root: UPLOADS_DIR, cacheControl: false, acceptRanges: true, dotfiles: "deny" }, (err) => {
    if (!err || res.headersSent) return;
    res.status(err.statusCode || 500).json({ error: "No se pudo leer el archivo" });
  });
}

app.get("/api/files/:fileId", requireFileAuth, (req, res) => {
  servePrivateFile(req, res, db.getFileById(req.params.fileId));
});

function messageFileIds(senderId, references, serverHost) {
  const ids = new Set();
  const origin = new URL("http://" + serverHost);
  for (const reference of references) {
    if (typeof reference !== "string" || !reference) continue;
    const url = new URL(reference, origin);
    if (url.host !== origin.host || !["http:", "https:"].includes(url.protocol)) continue;
    const pathname = path.posix.normalize(decodeURIComponent(url.pathname).replace(/\\/g, "/"));
    const parts = pathname.split("/").filter(Boolean);
    let file;
    if ((parts[0] || "").replace(/[. ]+$/, "").toLowerCase() === "uploads") {
      file = parts.length === 2 ? db.getFileByFilename(parts[1]) : null;
    } else if (parts[0] === "api" && parts[1] === "files") {
      file = parts.length === 3 ? db.getFileById(parts[2]) : null;
    } else continue;
    if (!file || file.ownerId !== senderId) throw new Error("No puedes compartir este archivo");
    ids.add(file.id);
  }
  return [...ids];
}

// Endpoint to receive subscription from client
app.post('/api/notifications/subscribe', requireAuth, (req, res) => {
  const { syncId, subscription } = req.body || {};
  if (!syncId || !subscription) {
    return res.status(400).json({ error: 'syncId y subscription son requeridos' });
  }
  if (String(syncId).trim().toUpperCase() !== req.user.syncId) {
    return res.status(403).json({ error: 'No puedes registrar notificaciones para otro usuario' });
  }
  try {
    storeSubscription(syncId, subscription);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[Push] Error storing subscription:', err);
    return res.status(500).json({ error: 'Error interno al guardar suscripción' });
  }
});

// Extractor de Metadatos OpenGraph y Favicon para Rich Link Cards
async function fetchUrlMetadata(text) {
  if (!text || typeof text !== "string") return null;
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return null;

  const targetUrl = match[0];
  try {
    const parsed = new URL(targetUrl);
    await assertPublicPreviewUrl(targetUrl);
    const domain = parsed.hostname;
    const defaultFavicon = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    const response = await fetch(targetUrl, {
      signal: controller.signal,
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return {
        url: targetUrl,
        domain: domain,
        title: domain,
        description: null,
        image: defaultFavicon
      };
    }

    const html = await response.text();

    // og:title o <title>
    const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
                         html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);

    // og:description o description
    const ogDescMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
                        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i) ||
                        html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);

    // og:image
    const ogImgMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
                       html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);

    const title = ogTitleMatch ? ogTitleMatch[1] : (titleMatch ? titleMatch[1] : domain);
    let image = ogImgMatch ? ogImgMatch[1] : null;

    if (image && !image.startsWith("http://") && !image.startsWith("https://")) {
      image = new URL(image, targetUrl).href;
    }
    if (!image) {
      image = defaultFavicon;
    }

    const description = ogDescMatch ? ogDescMatch[1] : null;

    return {
      url: targetUrl,
      domain: domain,
      title: title ? title.trim() : domain,
      description: description ? description.trim() : null,
      image: image
    };
  } catch (err) {
    try {
      const parsed = new URL(targetUrl);
      return {
        url: targetUrl,
        domain: parsed.hostname,
        title: parsed.hostname,
        description: null,
        image: `https://www.google.com/s2/favicons?domain=${parsed.hostname}&sz=128`
      };
    } catch (e) {
      return null;
    }
  }
}

// Rutas de Autenticación
app.post("/api/auth/register", authRateLimit, (req, res) => {
  try {
    const { username, password, displayName } = req.body || {};
    const user = db.registerUser(username, password, displayName);
    const loginResult = db.loginUser(username, password);
    res.json({ ok: true, token: loginResult.token, user: loginResult.user });
  } catch (err) {
    res.status(400).json({ error: err.message || "Error al registrar usuario" });
  }
});

app.post("/api/auth/login", authRateLimit, (req, res) => {
  try {
    const { username, password } = req.body || {};
    const result = db.loginUser(username, password);
    res.json({ ok: true, token: result.token, user: result.user });
  } catch (err) {
    res.status(401).json({ error: err.message || "Error de credenciales" });
  }
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ ok: true, user: req.user });
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  const token = req.headers.authorization.slice(7).trim();
  db.revokeSession(token);
  res.json({ ok: true });
});

// Endpoint de Registro Web Push inyectado de forma segura
app.post("/api/save-subscription", requireAuth, asyncHandler(async (req, res) => {
  try {
    const subscription = req.body?.subscription || req.body;

    if (!subscription || typeof subscription !== "object" ||
        Array.isArray(subscription) || typeof subscription.endpoint !== "string") {
      return res.status(400).json({ ok: false, error: "Payload de suscripción inválido o ausente" });
    }

    const saved = await db.savePushSubscription(
      req.user.syncId,
      subscription,
      req.get("user-agent") || ""
    );

    if (!saved) {
      return res.status(400).json({ ok: false, error: "Payload de suscripción inválido o ausente" });
    }

    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error("[Push] Error al guardar suscripción:", err);
    return res.status(500).json({ ok: false, error: "Error interno al guardar la suscripción" });
  }
}));

// Rutas de Usuario y Perfil
app.post("/api/user/profile", requireAuth, asyncHandler(async (req, res) => {
  try {
    const { displayName, avatarUrl } = req.body || {};
    if (avatarUrl !== undefined && avatarUrl !== null && !safeUrl(avatarUrl, "avatar")) {
      return res.status(400).json({ error: "URL de avatar no válida" });
    }
    const updated = await db.updateUserProfile(req.user.syncId, displayName, avatarUrl);
    io.emit("user-profile-updated", updated);
    res.json({ ok: true, user: updated });
  } catch (err) {
    res.status(400).json({ error: err.message || "Error al actualizar perfil" });
  }
}));

// Endpoint de Subida de Documentos y Archivos Pesados (hasta 2 GB sin compresión)
app.post("/api/upload", requireAuth, uploadSingleFileForPlan, asyncHandler(async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No se proporcionó ningún archivo" });
    }

    const plan = String(req.user.plan || "free").trim().toLowerCase();
    const maxUploadBytes = plan === "enterprise" || plan === "pro"
      ? MAX_PREMIUM_UPLOAD_BYTES
      : MAX_STANDARD_UPLOAD_BYTES;
    if (req.file.size > maxUploadBytes) {
      try { await fs.promises.unlink(req.file.path); } catch (_) {}
      return res.status(413).json({ error: "El archivo supera el límite del plan" });
    }

    const registeredFile = await db.registerFile(req.user.syncId, req.file);
    const fileUrl = `/api/files/${registeredFile.id}`;
    const mime = (req.file.mimetype || "").toLowerCase();
    const orig = req.file.originalname || "";

    const isVideo = mime.startsWith("video/") || /\.(mp4|m4v|mov|webm)$/i.test(orig);
    const isAudio = mime.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|aac|webm)$/i.test(orig);
    const isImage = mime.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(orig);

    res.json({
      ok: true,
      file: {
        id: registeredFile.id,
        url: fileUrl,
        name: req.file.originalname,
        size: req.file.size,
        type: req.file.mimetype,
        filename: req.file.filename,
        isVideo: isVideo,
        isAudio: isAudio,
        isImage: isImage
      }
    });
  } catch (err) {
    res.status(500).json({ error: "Error al procesar subida de archivo: " + err.message });
  }
}));

// Rutas de Contactos
app.get("/api/contacts", requireAuth, (req, res) => {
  const onlineIds = new Set(onlineUsers.keys());
  const contacts = db.getUserContacts(req.user.syncId, onlineIds);
  res.json({ ok: true, contacts: contacts });
});

app.post("/api/contacts/add", requireAuth, (req, res) => {
  try {
    const { contactSyncId } = req.body || {};
    if (!contactSyncId) {
      return res.status(400).json({ error: "El código ID es requerido" });
    }
    const result = db.addContact(req.user.syncId, contactSyncId);
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err.message || "Contacto no encontrado" });
  }
});

// Rutas de Mensajería e Historial
app.get("/api/messages/:contactSyncId", requireAuth, (req, res) => {
  const { contactSyncId } = req.params;
  const targetSyncId = contactSyncId.toUpperCase();
  const messages = db.getMessagesBetween(req.user.syncId, targetSyncId);
  const pinnedMessage = db.getPinnedMessage(req.user.syncId, targetSyncId);
  res.json({ ok: true, messages: messages, pinnedMessage: pinnedMessage });
});

// Endpoint para vaciar historial completo con un contacto
app.delete("/api/messages/:contactSyncId", requireAuth, (req, res) => {
  const { contactSyncId } = req.params;
  const targetSyncId = contactSyncId.toUpperCase();
  const deletedCount = db.clearMessagesBetween(req.user.syncId, targetSyncId);

  const eventData = {
    fromSyncId: req.user.syncId,
    contactSyncId: targetSyncId
  };

  const userSockets = onlineUsers.get(req.user.syncId);
  if (userSockets) {
    userSockets.forEach((sockId) => io.to(sockId).emit("chat-history-cleared", eventData));
  }
  const targetSockets = onlineUsers.get(targetSyncId);
  if (targetSockets) {
    targetSockets.forEach((sockId) => io.to(sockId).emit("chat-history-cleared", eventData));
  }

  res.json({ ok: true, deletedCount: deletedCount });
});

// Endpoint auxiliar para vista previa de enlaces
app.get("/api/link-preview", requireAuth, asyncHandler(async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "URL requerida" });
  const preview = await fetchUrlMetadata(url);
  res.json({ ok: true, preview: preview });
}));

app.get('/api/status', function (_req, res) {
  res.json({
    status: 'ok',
    service: 'sync-engine-server',
    features: [
      'auth',
      'private-messaging',
      'voice-notes',
      'pwa',
      'double-check',
      'pinned-messages',
      'rich-links',
      'multimedia-2gb',
      'h264-video',
      'fluid-layout',
      'lightbox',
      'monetization-tiers',
      'encrypted-vault',
      'team-channels',
      'compliance-export'
    ],
    uploadLimitBytes: 2147483648,
    onlineUsersCount: onlineUsers.size
  });
});

// ==== Endpoints de Monetización, Facturación y Planes ====
app.get("/api/billing/plan", requireAuth, (req, res) => {
  const user = db.getUserBySyncId(req.user.syncId);
  if (!user) return res.status(404).json({ error: "Usuario no encontrado" });
  res.json({
    ok: true,
    plan: user.plan || "free",
    role: user.role || "member",
    planExpiresAt: user.planExpiresAt || null,
    features: {
      maxUploadBytes: user.plan === "enterprise" ? 2147483648 : (user.plan === "pro" ? 2147483648 : 52428800),
      maxVoiceSeconds: user.plan === "free" ? 60 : 600,
      encryptedVault: user.plan !== "free",
      teamChannels: user.plan === "enterprise" || user.plan === "pro",
      exportAudit: true,
      hdCalling: user.plan !== "free"
    }
  });
});

app.post("/api/billing/upgrade", requireAuth, (req, res) => {
  if (process.env.ALLOW_TEST_BILLING !== "true") {
    return res.status(403).json({ error: "La actualización de plan de prueba está deshabilitada. Contacte a ventas BARRANTES CO. para facturación B2B." });
  }
  const { plan, billingCycle, paymentDetails } = req.body || {};
  try {
    const result = db.upgradeUserPlan(req.user.syncId, plan, billingCycle, paymentDetails);
    res.json({ ok: true, user: result.user, invoice: result.invoice });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/billing/invoices", requireAuth, (req, res) => {
  const invoices = db.getUserInvoices(req.user.syncId);
  res.json({ ok: true, invoices: invoices });
});

app.post("/api/billing/apply-coupon", requireAuth, (req, res) => {
  const { code } = req.body || {};
  const cleanCode = String(code || "").trim().toUpperCase();
  const coupons = {
    "SYNC2026": 25,
    "LAUNCH50": 50,
    "BARRANTES": 30,
    "VIP": 20
  };
  if (coupons[cleanCode]) {
    res.json({ ok: true, valid: true, discountPercent: coupons[cleanCode], code: cleanCode });
  } else {
    res.status(400).json({ ok: false, valid: false, error: "Código promocional no válido o caducado" });
  }
});

// Webhook de pagos deshabilitado hasta implementar verificación criptográfica
// específica del proveedor sobre el cuerpo original de la solicitud.
app.post("/api/billing/webhook", (_req, res) => {
  return res.status(503).json({
    error: "Webhook de pagos no habilitado: falta verificación de firma del proveedor."
  });
});

// Endpoint de Eliminación de Cuenta (Cumplimiento Políticas Google Play & Apple App Store)
app.post("/api/user/delete-account", requireAuth, (req, res) => {
  try {
    const result = db.deleteUserAccount(req.user.syncId);
    res.json({ ok: true, message: "Cuenta y datos eliminados permanentemente", details: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Endpoint B2B para crear Organización
app.post("/api/org/create", requireAuth, (req, res) => {
  try {
    const { name } = req.body || {};
    const org = db.createOrganization(name, req.user.syncId);
    res.json({ ok: true, organization: org });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==== Endpoints de Bóveda Cifrada Privada ====
app.get("/api/vault", requireAuth, (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const items = db.getVaultItems(req.user.syncId);
  res.json({ ok: true, items: items });
});

app.post("/api/vault", requireAuth, (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const item = db.saveVaultItem(req.user.syncId, req.body);
    res.json({ ok: true, item: item });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/vault/:itemId", requireAuth, (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const success = db.deleteVaultItem(req.user.syncId, req.params.itemId);
  res.json({ ok: true, deleted: success });
});

// ==== Endpoints de Canales de Espacio de Trabajo ====
app.get("/api/channels", requireAuth, (req, res) => {
  const channels = db.getWorkspaceChannels(req.user.syncId);
  res.json({ ok: true, channels: channels });
});

app.post("/api/channels", requireAuth, (req, res) => {
  const { name, description } = req.body || {};
  try {
    const channel = db.createWorkspaceChannel(name, description, req.user.syncId);
    const creatorSockets = onlineUsers.get(req.user.syncId);
    if (creatorSockets) {
      creatorSockets.forEach((socketId) => io.to(socketId).emit("channel-created", channel));
    }
    res.json({ ok: true, channel: channel });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/channels/:channelId/messages", requireAuth, (req, res) => {
  try {
    const messages = db.getChannelMessages(req.params.channelId, req.user.syncId);
    res.json({ ok: true, messages: messages });
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

// ==== Endpoint de Exportación de Auditoría y Transcripción ====
app.get("/api/messages/:contactSyncId/export", requireAuth, (req, res) => {
  try {
    const data = db.exportConversation(req.user.syncId, req.params.contactSyncId);
    res.json({ ok: true, export: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Configuración de Certificados SSL Autofirmados para soporte HTTPS (Requerido para iOS WebRTC y Micrófono)
const SSL_DIR = path.join(__dirname, "data", "ssl");
if (!fs.existsSync(SSL_DIR)) {
  fs.mkdirSync(SSL_DIR, { recursive: true });
}
const CERT_FILE = path.join(SSL_DIR, "cert.pem");
const KEY_FILE = path.join(SSL_DIR, "key.pem");

let sslOptions = null;
try {
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
    sslOptions = {
      cert: fs.readFileSync(CERT_FILE),
      key: fs.readFileSync(KEY_FILE)
    };
  } else {
    const pemsOrPromise = selfsigned.generate(
      [{ name: "commonName", value: "sync-engine-server" }],
      { days: 365, keySize: 2048 }
    );
    if (pemsOrPromise && typeof pemsOrPromise.then === "function") {
      pemsOrPromise.then((pems) => {
        if (pems && pems.cert && pems.private) {
          try {
            fs.writeFileSync(CERT_FILE, pems.cert, "utf8");
            fs.writeFileSync(KEY_FILE, pems.private, "utf8");
          } catch (_) {}
        }
      }).catch(() => {});
    } else if (pemsOrPromise && pemsOrPromise.cert && pemsOrPromise.private) {
      fs.writeFileSync(CERT_FILE, pemsOrPromise.cert, "utf8");
      fs.writeFileSync(KEY_FILE, pemsOrPromise.private, "utf8");
      sslOptions = { cert: pemsOrPromise.cert, key: pemsOrPromise.private };
    }
  }
} catch (sslErr) {
  console.warn("[SSL] No se pudo inicializar certificado SSL:", sslErr.message);
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: function (origin, callback) {
      callback(null, isAllowedCorsOrigin(origin));
    },
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 50e6
});

function canReceivePubSubEvent(user, payload) {
  if (!user || !payload || typeof payload !== "object") return false;
  const directAudience = [payload.targetSyncId, payload.recipientSyncId, payload.userSyncId]
    .filter(Boolean)
    .map((value) => String(value).trim().toUpperCase());
  if (directAudience.length) return directAudience.includes(user.syncId);
  if (payload.channelId) return db.isChannelMember(payload.channelId, user.syncId);
  return false;
}

let httpsServer = null;
const HTTPS_PORT = process.env.HTTPS_PORT || (Number(PORT) + 443);
if (sslOptions) {
  try {
    httpsServer = https.createServer(sslOptions, app);
    io.attach(httpsServer);
  } catch (err) {
    console.warn("[HTTPS] Error al iniciar servidor HTTPS:", err.message);
  }
}

// Registro de Usuarios Online: Map<syncId, Set<socketId>>
const onlineUsers = new Map();
const socketToUser = new Map();

/**
 * Sends a structured channel authorization failure to a Socket.IO client.
 * @param {import("socket.io").Socket} socket
 * @param {string} code
 * @param {string} message
 */
function emitChannelAuthorizationError(socket, code, message) {
  socket.emit("authorization-error", { code: code, message: message });
}

io.on("connection", function (socket) {
  // Autenticación de Socket
  socket.on("authenticate", function (payload) {
    const token = payload && payload.token ? payload.token : null;
    const user = db.getUserByToken(token);
    if (!user) {
      socket.emit("auth-error", { message: "Token inválido" });
      return;
    }

    const syncId = user.syncId;
    socketToUser.set(socket.id, user);

    if (!onlineUsers.has(syncId)) {
      onlineUsers.set(syncId, new Set());
    }
    onlineUsers.get(syncId).add(socket.id);

    socket.emit("authenticated", { user: user });

    // Notificar a contactos sobre estado online
    broadcastUserStatus(syncId, true);
  });

  socket.on("clipboard-sync", function (payload) {
    const sender = socketToUser.get(socket.id);
    if (!sender || !payload || typeof payload.text !== "string") return;
    if (payload.text.length > 10000) {
      socket.emit("error-message", { message: "El contenido del portapapeles supera el límite permitido" });
      return;
    }

    const userSockets = onlineUsers.get(sender.syncId);
    if (!userSockets) return;
    userSockets.forEach((socketId) => {
      if (socketId !== socket.id) {
        io.to(socketId).emit("clipboard-sync", {
          text: payload.text,
          fromSyncId: sender.syncId,
          timestamp: Date.now()
        });
      }
    });
  });

  // ==== Gestión y Mensajería de Canales de Equipo ====
  socket.on("join-channel", function (payload) {
    const user = socketToUser.get(socket.id);
    if (!user) {
      emitChannelAuthorizationError(socket, "UNAUTHENTICATED", "Autenticación requerida");
      return;
    }

    const rawChannelId = payload && typeof payload.channelId === "string" ? payload.channelId.trim() : "";
    if (!rawChannelId) {
      emitChannelAuthorizationError(socket, "FORBIDDEN", "No tienes permisos para acceder a este canal");
      return;
    }

    const channel = db.findChannel ? db.findChannel(rawChannelId) : null;
    const channelId = channel ? channel.id : rawChannelId;

    if (!db.isChannelMember(channelId, user.syncId)) {
      emitChannelAuthorizationError(socket, "FORBIDDEN", "No tienes permisos para acceder a este canal");
      return;
    }

    socket.join("channel:" + channelId);
    if (rawChannelId !== channelId) {
      socket.join("channel:" + rawChannelId);
    }
  });

  socket.on("send-channel-message", async function (payload) {
    const sender = socketToUser.get(socket.id);
    if (!sender) {
      emitChannelAuthorizationError(socket, "UNAUTHENTICATED", "Autenticación requerida");
      return;
    }
    const { channelId: rawChannelId, text, type, fileData, audioData } = payload || {};
    if (!rawChannelId) return;

    const channel = db.findChannel ? db.findChannel(rawChannelId) : null;
    const channelId = channel ? channel.id : rawChannelId;

    if (!db.isChannelMember(channelId, sender.syncId)) {
      emitChannelAuthorizationError(socket, "FORBIDDEN", "No tienes permisos para enviar mensajes a este canal");
      return;
    }

    try {
      const msg = db.saveChannelMessage(channelId, sender.syncId, { text, type, fileData, audioData });
      io.to("channel:" + channelId).emit("channel-message-received", msg);
      if (rawChannelId !== channelId) {
        io.to("channel:" + rawChannelId).emit("channel-message-received", msg);
      }
    } catch (err) {
      socket.emit("error-message", { message: err.message });
    }
  });

  // Envío de Mensaje Privado (Texto, Audio de Voz o Archivo)
  socket.on("send-private-message", async function (payload) {
    const sender = socketToUser.get(socket.id);
    if (!sender) {
      socket.emit("error-message", { message: "No autenticado" });
      return;
    }

    const { toSyncId, text, type, fileData, audioData, clientMsgId, replyTo } = payload || {};
    if (!toSyncId) return;

    const targetSyncId = String(toSyncId).trim().toUpperCase();
    if (sender.syncId === targetSyncId) {
      return;
    }

    const msgType = type || "text";
    // Reject executable resource schemes before storing or broadcasting user-controlled data.
    if (fileData) {
      if (typeof fileData !== "object" || Array.isArray(fileData) ||
          ["url", "data"].some((key) => fileData[key] != null &&
            !safeUrl(fileData[key], "download") && !safeUrl(fileData[key], "image"))) {
        socket.emit("error-message", { message: "URL de archivo no válida" });
        return;
      }
    }
    if (audioData != null && !safeUrl(audioData, "audio")) {
      socket.emit("error-message", { message: "URL de audio no válida" });
      return;
    }
    let fileIds;
    try {
      fileIds = messageFileIds(sender.syncId, [fileData?.url, fileData?.data, audioData], socket.handshake.headers.host);
    } catch (err) {
      socket.emit("error-message", { message: err.message });
      return;
    }
    const targetSockets = onlineUsers.get(targetSyncId);
    const isTargetOnline = Boolean(targetSockets && targetSockets.size > 0);
    const initialStatus = isTargetOnline ? "delivered" : "sent";

    let messageObj = null;

    if (msgType === "text") {
      // If recipient is offline, send Web Push notification
      if (!isTargetOnline) {
        const pushPayload = {
          title: `Nuevo mensaje de ${sender.formattedName}`,
          body: (text && text.length > 100) ? text.slice(0, 97) + "..." : text,
          icon: '/assets/logo.png',
          data: { syncId: targetSyncId, fromSyncId: sender.syncId, type: 'message' }
        };
        sendPushNotification(targetSyncId, pushPayload).catch(e => console.warn('[Push] envío fallido:', e.message));
      }
      messageObj = db.saveTextMessage(
        sender.syncId,
        targetSyncId,
        text,
        clientMsgId || null,
        replyTo || null,
        null,
        initialStatus
      );
    } else {
      let finalAudioData = audioData || null;

      // Si es audio en Base64, persistirlo en disco en /uploads/ para soporte de streaming y Range requests en iOS
      if (msgType === "audio" && audioData && typeof audioData === "string" && audioData.startsWith("data:audio/")) {
        try {
          const matches = audioData.match(/^data:audio\/([a-zA-Z0-9_\-+.]+);base64,(.+)$/);
          if (matches) {
            const rawFormat = matches[1].toLowerCase();
            const ext = rawFormat.includes("mp4") || rawFormat.includes("m4a") || rawFormat.includes("aac") 
              ? "mp4" 
              : (rawFormat.includes("wav") ? "wav" : "webm");
            const buffer = Buffer.from(matches[2], "base64");
            const audioFileName = `voice-${Date.now()}-${Math.round(Math.random() * 1e9)}.${ext}`;
            const audioFilePath = path.join(UPLOADS_DIR, audioFileName);
            fs.writeFileSync(audioFilePath, buffer);
            const audioFile = await db.registerFile(sender.syncId, {
              filename: audioFileName, originalname: audioFileName, size: buffer.length,
              mimetype: "audio/" + rawFormat
            });
            finalAudioData = `/api/files/${audioFile.id}`;
            fileIds.push(audioFile.id);
          }
        } catch (err) {
          console.warn("[AUDIO] Error al persistir audio en disco:", err.message);
          socket.emit("error-message", { message: "No se pudo registrar el audio" });
          return;
        }
      }

      // If recipient is offline, send Web Push notification
      if (!isTargetOnline) {
        const pushPayload = {
          title: `Nuevo mensaje de ${sender.formattedName}`,
          body: (text && text.length > 100) ? text.slice(0, 97) + "..." : text,
          icon: '/assets/logo.png',
          data: { syncId: targetSyncId, type: 'message' }
        };
        sendPushNotification(targetSyncId, pushPayload).catch(e => console.warn('[Push] envío fallido:', e.message));
      }
      messageObj = db.saveMessage({
        id: clientMsgId || null,
        fromId: sender.syncId,
        toId: targetSyncId,
        type: msgType,
        text: text,
        audioData: finalAudioData,
        fileData: fileData,
        fileIds: fileIds,
        replyTo: replyTo || null,
        status: initialStatus
      });
    }

    if (sender) {
      messageObj.fromName = sender.formattedName || sender.displayName || "Usuario";
    } else {
      messageObj.fromName = "Usuario Desconocido";
      console.warn("[Chat Warning] Se intentó procesar un mensaje de un remitente inexistente en db.");
    }
    messageObj.toSyncId = targetSyncId;

    // Entregar a todos los sockets activos del destinatario
    if (targetSockets && targetSockets.size > 0) {
      targetSockets.forEach((sockId) => {
        io.to(sockId).emit("receive-private-message", messageObj);
      });
    }

    // Confirmación y sincronización a todos los sockets del emisor
    const senderSockets = onlineUsers.get(sender.syncId);
    if (senderSockets && senderSockets.size > 0) {
      senderSockets.forEach((sockId) => {
        io.to(sockId).emit("receive-private-message", messageObj);
      });
    }

    socket.emit("message-sent", { id: messageObj.id, status: messageObj.status, timestamp: messageObj.timestamp });

    // Extracción asíncrona desacoplada de metadatos Open Graph sin bloquear la entrega de mensajes
    if (msgType === "text" && text && /https?:\/\/[^\s]+/i.test(text)) {
      setImmediate(async () => {
        try {
          const preview = await fetchUrlMetadata(text);
          if (preview) {
            db.updateMessageLinkPreview(messageObj.id, preview);
            const previewEvent = {
              messageId: messageObj.id,
              fromSyncId: sender.syncId,
              toSyncId: targetSyncId,
              linkPreview: preview
            };

            const currentTargetSockets = onlineUsers.get(targetSyncId);
            if (currentTargetSockets && currentTargetSockets.size > 0) {
              currentTargetSockets.forEach((sockId) => {
                io.to(sockId).emit("message-preview-updated", previewEvent);
              });
            }

            const currentSenderSockets = onlineUsers.get(sender.syncId);
            if (currentSenderSockets && currentSenderSockets.size > 0) {
              currentSenderSockets.forEach((sockId) => {
                io.to(sockId).emit("message-preview-updated", previewEvent);
              });
            }
          }
        } catch (previewErr) {
          console.warn("[PREVIEW] Error en extracción asíncrona de metadatos Open Graph:", previewErr.message);
        }
      });
    }
  });

  // Marcado de Mensajes como Leídos (Read Receipt)
  socket.on("mark-messages-read", function (payload) {
    const reader = socketToUser.get(socket.id);
    if (!reader || !payload || !payload.contactSyncId) return;

    const contactSyncId = String(payload.contactSyncId).trim().toUpperCase();
    const updatedIds = db.markMessagesAsRead(contactSyncId, reader.syncId);

    if (updatedIds.length > 0) {
      const receiptData = {
        senderSyncId: contactSyncId,
        readerSyncId: reader.syncId,
        messageIds: updatedIds
      };

      // Notificar al autor de los mensajes
      const senderSockets = onlineUsers.get(contactSyncId);
      if (senderSockets && senderSockets.size > 0) {
        senderSockets.forEach((sockId) => {
          io.to(sockId).emit("messages-read-receipt", receiptData);
        });
      }

      // Sincronizar en otros dispositivos del lector
      const readerSockets = onlineUsers.get(reader.syncId);
      if (readerSockets && readerSockets.size > 0) {
        readerSockets.forEach((sockId) => {
          io.to(sockId).emit("messages-read-receipt", receiptData);
        });
      }
    }
  });

  // Eliminar Mensaje para Todos (Delete for Everyone)
  socket.on("delete-message-for-everyone", function (payload) {
    const sender = socketToUser.get(socket.id);
    if (!sender || !payload || !payload.messageId || !payload.toSyncId) return;

    const targetSyncId = String(payload.toSyncId).trim().toUpperCase();
    try {
      const updated = db.deleteMessageForEveryone(payload.messageId, sender.syncId);
      if (updated) {
        const eventData = {
          messageId: payload.messageId,
          fromSyncId: sender.syncId,
          toSyncId: targetSyncId
        };

        const targetSockets = onlineUsers.get(targetSyncId);
        if (targetSockets && targetSockets.size > 0) {
          targetSockets.forEach((sockId) => {
            io.to(sockId).emit("message-deleted-for-everyone", eventData);
          });
        }

        const senderSockets = onlineUsers.get(sender.syncId);
        if (senderSockets && senderSockets.size > 0) {
          senderSockets.forEach((sockId) => {
            io.to(sockId).emit("message-deleted-for-everyone", eventData);
          });
        }
      }
    } catch (err) {
      socket.emit("error-message", { message: err.message });
    }
  });

  // Fijar Mensaje Clave (Pin Message)
  socket.on("pin-message", function (payload) {
    const sender = socketToUser.get(socket.id);
    if (!sender || !payload || !payload.toSyncId || !payload.messageId) return;

    const targetSyncId = String(payload.toSyncId).trim().toUpperCase();
    try {
      const pinned = db.setPinnedMessage(sender.syncId, targetSyncId, payload.messageId);
      const eventData = {
        pinnedMessage: pinned,
        conversationWith: targetSyncId
      };

      const targetSockets = onlineUsers.get(targetSyncId);
      if (targetSockets && targetSockets.size > 0) {
        targetSockets.forEach((sockId) => {
          io.to(sockId).emit("message-pinned", {
            pinnedMessage: pinned,
            conversationWith: sender.syncId
          });
        });
      }

      const senderSockets = onlineUsers.get(sender.syncId);
      if (senderSockets && senderSockets.size > 0) {
        senderSockets.forEach((sockId) => {
          io.to(sockId).emit("message-pinned", eventData);
        });
      }
    } catch (err) {
      socket.emit("error-message", { message: err.message });
    }
  });

  // Desfijar Mensaje Clave (Unpin Message)
  socket.on("unpin-message", function (payload) {
    const sender = socketToUser.get(socket.id);
    if (!sender || !payload || !payload.toSyncId) return;

    const targetSyncId = String(payload.toSyncId).trim().toUpperCase();
    db.unpinMessage(sender.syncId, targetSyncId);

    const targetSockets = onlineUsers.get(targetSyncId);
    if (targetSockets && targetSockets.size > 0) {
      targetSockets.forEach((sockId) => {
        io.to(sockId).emit("message-unpinned", { conversationWith: sender.syncId });
      });
    }

    const senderSockets = onlineUsers.get(sender.syncId);
    if (senderSockets && senderSockets.size > 0) {
      senderSockets.forEach((sockId) => {
        io.to(sockId).emit("message-unpinned", { conversationWith: targetSyncId });
      });
    }
  });

  // Reacciones con Emojis a Mensajes ('message-reaction')
  socket.on("message-reaction", function (payload) {
    const sender = socketToUser.get(socket.id);
    if (!sender || !payload || !payload.messageId || !payload.toSyncId || !payload.emoji) return;

    const targetSyncId = String(payload.toSyncId).trim().toUpperCase();
    try {
      const updatedReactions = db.updateMessageReaction(payload.messageId, sender.syncId, payload.emoji, targetSyncId);
      const eventData = {
        messageId: payload.messageId,
        fromSyncId: sender.syncId,
        emoji: payload.emoji,
        reactions: updatedReactions
      };

      const targetSockets = onlineUsers.get(targetSyncId);
      if (targetSockets && targetSockets.size > 0) {
        targetSockets.forEach((sockId) => {
          io.to(sockId).emit("message-reaction-updated", eventData);
        });
      }

      const senderSockets = onlineUsers.get(sender.syncId);
      if (senderSockets && senderSockets.size > 0) {
        senderSockets.forEach((sockId) => {
          io.to(sockId).emit("message-reaction-updated", eventData);
        });
      }
    } catch (err) {
      socket.emit("error-message", { message: err.message });
    }
  });

  // SEÑALIZACIÓN WEBRTC (LLAMADAS DE VOZ P2P EN TIEMPO REAL)
  socket.on("call-user", function (data) {
    const sender = socketToUser.get(socket.id);
    if (!sender || !data || !data.toSyncId || !data.offer) return;

    const targetSyncId = String(data.toSyncId).trim().toUpperCase();
    const targetSockets = onlineUsers.get(targetSyncId);

    if (targetSockets && targetSockets.size > 0) {
      targetSockets.forEach((sockId) => {
        io.to(sockId).emit("call-made", {
          offer: data.offer,
          fromSyncId: sender.syncId,
          fromName: sender.formattedName
        });
      });
    } else {
      socket.emit("call-unavailable", {
        toSyncId: targetSyncId,
        message: "El contacto no se encuentra en línea para recibir llamadas"
      });
    }
  });

  socket.on("make-answer", function (data) {
    const sender = socketToUser.get(socket.id);
    if (!sender || !data || !data.toSyncId || !data.answer) return;

    const targetSyncId = String(data.toSyncId).trim().toUpperCase();
    const targetSockets = onlineUsers.get(targetSyncId);

    if (targetSockets && targetSockets.size > 0) {
      targetSockets.forEach((sockId) => {
        io.to(sockId).emit("answer-made", {
          answer: data.answer,
          fromSyncId: sender.syncId,
          fromName: sender.formattedName
        });
      });
    }
  });

  socket.on("ice-candidate", function (data) {
    const sender = socketToUser.get(socket.id);
    if (!sender || !data || !data.toSyncId || !data.candidate) return;

    const targetSyncId = String(data.toSyncId).trim().toUpperCase();
    const targetSockets = onlineUsers.get(targetSyncId);

    if (targetSockets && targetSockets.size > 0) {
      targetSockets.forEach((sockId) => {
        io.to(sockId).emit("ice-candidate", {
          candidate: data.candidate,
          fromSyncId: sender.syncId
        });
      });
    }
  });

  socket.on("reject-call", function (data) {
    const sender = socketToUser.get(socket.id);
    if (!sender || !data || !data.toSyncId) return;

    const targetSyncId = String(data.toSyncId).trim().toUpperCase();
    const targetSockets = onlineUsers.get(targetSyncId);

    if (targetSockets && targetSockets.size > 0) {
      targetSockets.forEach((sockId) => {
        io.to(sockId).emit("call-rejected", {
          fromSyncId: sender.syncId,
          fromName: sender.formattedName
        });
      });
    }
  });

  socket.on("end-call", function (data) {
    const sender = socketToUser.get(socket.id);
    if (!sender || !data || !data.toSyncId) return;

    const targetSyncId = String(data.toSyncId).trim().toUpperCase();
    const targetSockets = onlineUsers.get(targetSyncId);

    if (targetSockets && targetSockets.size > 0) {
      targetSockets.forEach((sockId) => {
        io.to(sockId).emit("call-ended", {
          fromSyncId: sender.syncId,
          fromName: sender.formattedName
        });
      });
    }
  });

  // Espejo de Notificaciones (Notification Mirroring)
  socket.on("mirror-notification", function (payload) {
    const sender = socketToUser.get(socket.id);
    if (!sender || !payload) return;

    const notifData = {
      id: payload.id || ("mirr_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6)),
      title: payload.title || "Notificación de Móvil",
      body: payload.body || "",
      icon: payload.icon || "📱",
      appName: payload.appName || "Móvil",
      fromSyncId: payload.fromSyncId || null,
      fromName: payload.fromName || null,
      timestamp: payload.timestamp || Date.now()
    };

    const userSockets = onlineUsers.get(sender.syncId);
    if (userSockets && userSockets.size > 0) {
      userSockets.forEach((sockId) => {
        if (sockId !== socket.id) {
          io.to(sockId).emit("notification-mirrored", notifData);
        }
      });
    }
  });

  socket.on("quick-reply", async function (payload) {
    const sender = socketToUser.get(socket.id);
    if (!sender || !payload || !payload.toSyncId || !payload.text) return;

    const targetSyncId = String(payload.toSyncId).trim().toUpperCase();
    const targetSockets = onlineUsers.get(targetSyncId);
    const initialStatus = Boolean(targetSockets && targetSockets.size > 0) ? "delivered" : "sent";

    const savedMsg = db.saveTextMessage(
      sender.syncId,
      targetSyncId,
      payload.text,
      null,
      payload.replyTo || null,
      null,
      initialStatus
    );
    savedMsg.fromName = sender.formattedName;
    savedMsg.toSyncId = targetSyncId;

    if (targetSockets && targetSockets.size > 0) {
      targetSockets.forEach((sockId) => {
        io.to(sockId).emit("receive-private-message", savedMsg);
      });
    }

    const senderSockets = onlineUsers.get(sender.syncId);
    if (senderSockets && senderSockets.size > 0) {
      senderSockets.forEach((sockId) => {
        io.to(sockId).emit("receive-private-message", savedMsg);
      });
    }

    socket.emit("quick-reply-sent", { ok: true, id: savedMsg.id });

    // Extracción asíncrona desacoplada de metadatos Open Graph
    if (payload.text && /https?:\/\/[^\s]+/i.test(payload.text)) {
      setImmediate(async () => {
        try {
          const preview = await fetchUrlMetadata(payload.text);
          if (preview) {
            db.updateMessageLinkPreview(savedMsg.id, preview);
            const previewEvent = {
              messageId: savedMsg.id,
              fromSyncId: sender.syncId,
              toSyncId: targetSyncId,
              linkPreview: preview
            };

            const curTargets = onlineUsers.get(targetSyncId);
            if (curTargets && curTargets.size > 0) {
              curTargets.forEach((sockId) => io.to(sockId).emit("message-preview-updated", previewEvent));
            }

            const curSenders = onlineUsers.get(sender.syncId);
            if (curSenders && curSenders.size > 0) {
              curSenders.forEach((sockId) => io.to(sockId).emit("message-preview-updated", previewEvent));
            }
          }
        } catch (previewErr) {
          console.warn("[PREVIEW] Error en quick-reply link preview:", previewErr.message);
        }
      });
    }
  });

  // Desconexión
  socket.on("disconnect", function () {
    const user = socketToUser.get(socket.id);
    if (user) {
      const syncId = user.syncId;
      socketToUser.delete(socket.id);

      const userSockets = onlineUsers.get(syncId);
      if (userSockets) {
        userSockets.delete(socket.id);
        if (userSockets.size === 0) {
          onlineUsers.delete(syncId);
          broadcastUserStatus(syncId, false);
        }
      }
    }
  });
});

function broadcastUserStatus(syncId, isOnline) {
  io.emit("contact-status-changed", {
    syncId: syncId,
    isOnline: isOnline
  });
}

server.listen(PORT, HOST, function () {
  const localIps = getLocalIPv4Addresses();
  console.log("\n==================================================");
  console.log("SYNC ENGINE Server Activo en http://" + HOST + ":" + PORT);
  console.log("Direcciones disponibles:");
  if (localIps.length === 0) {
    console.log("  (sin IPv4 detectada)");
  } else {
    for (let i = 0; i < localIps.length; i++) {
      console.log("  http://" + localIps[i].address + ":" + PORT);
    }
  }
  console.log("==================================================\n");

  // ==== Inicialización del listener de Cloud Pub/Sub ====
  // Se arranca después de que el servidor HTTP/Socket.IO ya está escuchando tráfico.
  // Los payloads recibidos desde la suscripción se emiten de forma transparente
  // a todos los clientes conectados (Electron, web, móvil).
  try {
    const { startChatSubscriptionListener } = require("./pubsub-service");
    startChatSubscriptionListener(function (pubsubPayload) {
      let delivered = 0;
      socketToUser.forEach((user, socketId) => {
        if (canReceivePubSubEvent(user, pubsubPayload)) {
          io.to(socketId).emit("pubsub-chat-event", pubsubPayload);
          delivered += 1;
        }
      });
      console.log("[Pub/Sub → Socket.IO] Evento autorizado para sockets:", delivered);
    });
  } catch (err) {
    console.error("[Pub/Sub] No se pudo iniciar la suscripción; HTTP seguirá disponible:", err.message);
  }
});

if (process.env.RENDER_EXTERNAL_URL) {
  const keepAliveUrl = new URL("/api/status", process.env.RENDER_EXTERNAL_URL);
  const keepAliveInterval = setInterval(async function () {
    try {
      const response = await fetch(keepAliveUrl, {
        signal: AbortSignal.timeout(30000)
      });
      await response.text();
      if (!response.ok) {
        console.warn("[Render Keep-Alive] Respuesta HTTP inesperada:", response.status);
      }
    } catch (err) {
      console.warn("[Render Keep-Alive] No se pudo consultar el estado:", err.message);
    }
  }, 5 * 60 * 1000);
  keepAliveInterval.unref();
}
