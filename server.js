const http = require("http");
const os = require("os");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");
const db = require("./db");

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

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
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

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

// Extractor de Metadatos OpenGraph y Favicon para Rich Link Cards
async function fetchUrlMetadata(text) {
  if (!text || typeof text !== "string") return null;
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return null;

  const targetUrl = match[0];
  try {
    const parsed = new URL(targetUrl);
    const domain = parsed.hostname;
    const defaultFavicon = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    const response = await fetch(targetUrl, {
      signal: controller.signal,
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
app.post("/api/auth/register", (req, res) => {
  try {
    const { username, password, displayName } = req.body || {};
    const user = db.registerUser(username, password, displayName);
    const loginResult = db.loginUser(username, password);
    res.json({ ok: true, token: loginResult.token, user: loginResult.user });
  } catch (err) {
    res.status(400).json({ error: err.message || "Error al registrar usuario" });
  }
});

app.post("/api/auth/login", (req, res) => {
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

// Rutas de Usuario y Perfil
app.post("/api/user/profile", requireAuth, (req, res) => {
  try {
    const { displayName } = req.body || {};
    const updated = db.updateUserProfile(req.user.syncId, displayName);
    res.json({ ok: true, user: updated });
  } catch (err) {
    res.status(400).json({ error: err.message || "Error al actualizar perfil" });
  }
});

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

// Endpoint auxiliar para vista previa de enlaces
app.get("/api/link-preview", requireAuth, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "URL requerida" });
  const preview = await fetchUrlMetadata(url);
  res.json({ ok: true, preview: preview });
});

// Lista Blanca de Dominios Autorizados para Navegación Embebida
const ALLOWED_DOMAINS = [
  'google.com.pe',
  'www.google.com.pe',
  'xvideos.com',
  'www.xvideos.com'
];

// Endpoint Proxy con Lista Blanca de Navegación
async function handleWebProxy(req, res) {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: 'URL requerida' });
  }

  let hostname = '';
  let parsed;
  try {
    let target = String(targetUrl).trim();
    if (!/^https?:\/\//i.test(target)) {
      target = 'https://' + target;
    }
    parsed = new URL(target);
    hostname = new URL(target).hostname;
  } catch (err) {
    return res.status(400).json({ error: 'URL no válida' });
  }

  const hostLower = hostname.toLowerCase();
  const isAllowed = ALLOWED_DOMAINS.some(allowed => hostLower === allowed || hostLower.endsWith('.' + allowed));

  if (!isAllowed) {
    return res.status(403).json({ error: 'Dominio no autorizado' });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const response = await fetch(parsed.href, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'es-PE,es;q=0.9,en;q=0.8'
      },
      redirect: 'follow'
    });
    clearTimeout(timeout);

    const contentType = response.headers.get('content-type') || 'text/html';

    // Remover encabezados de restricción de iframe
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('Content-Security-Policy-Report-Only');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', contentType);

    if (contentType.includes('text/html')) {
      let html = await response.text();
      const finalUrl = response.url || parsed.href;
      const baseTag = `<base href="${finalUrl}">`;
      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/<head[^>]*>/i, (m) => `${m}\n  ${baseTag}`);
      } else {
        html = `${baseTag}\n${html}`;
      }
      return res.send(html);
    } else {
      const arrayBuffer = await response.arrayBuffer();
      return res.send(Buffer.from(arrayBuffer));
    }
  } catch (err) {
    return res.status(502).json({ error: 'Error al cargar la página a través del proxy: ' + err.message });
  }
}

app.get('/api/proxy-web', handleWebProxy);
app.get('/api/web-proxy', handleWebProxy);

app.get('/api/status', function (_req, res) {
  res.json({
    status: 'ok',
    service: 'sync-engine-server',
    features: ['auth', 'private-messaging', 'voice-notes', 'pwa', 'double-check', 'pinned-messages', 'rich-links', 'proxy-web'],
    allowedDomains: ALLOWED_DOMAINS,
    onlineUsersCount: onlineUsers.size
  });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 50e6
});

// Registro de Usuarios Online: Map<syncId, Set<socketId>>
const onlineUsers = new Map();
const socketToUser = new Map();

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
    const targetSockets = onlineUsers.get(targetSyncId);
    const isTargetOnline = Boolean(targetSockets && targetSockets.size > 0);
    const initialStatus = isTargetOnline ? "delivered" : "sent";

    let messageObj = null;

    if (msgType === "text") {
      let linkPreview = null;
      if (text && /https?:\/\/[^\s]+/i.test(text)) {
        linkPreview = await fetchUrlMetadata(text);
      }

      messageObj = db.saveTextMessage(
        sender.syncId,
        targetSyncId,
        text || "",
        clientMsgId || null,
        replyTo || null,
        linkPreview,
        initialStatus
      );
      messageObj.fromName = sender.formattedName;
      messageObj.toSyncId = targetSyncId;
    } else {
      // Transferencia Efímera (Archivos, Imágenes y Notas de Voz)
      messageObj = {
        id: clientMsgId || ("ephem_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7)),
        fromId: sender.syncId,
        fromName: sender.formattedName,
        toId: targetSyncId,
        type: msgType,
        text: text || (msgType === "audio" ? "Nota de voz" : "Archivo"),
        audioData: audioData || null,
        fileData: fileData || null,
        replyTo: replyTo || null,
        reactions: {},
        timestamp: Date.now(),
        status: initialStatus,
        read: false,
        deletedForEveryone: false
      };
    }

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
    const updatedReactions = db.updateMessageReaction(payload.messageId, sender.syncId, payload.emoji);

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

    let linkPreview = null;
    if (payload.text && /https?:\/\/[^\s]+/i.test(payload.text)) {
      linkPreview = await fetchUrlMetadata(payload.text);
    }

    const savedMsg = db.saveTextMessage(
      sender.syncId,
      targetSyncId,
      payload.text,
      null,
      payload.replyTo || null,
      linkPreview,
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
});
