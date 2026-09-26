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
  const messages = db.getMessagesBetween(req.user.syncId, contactSyncId.toUpperCase());
  res.json({ ok: true, messages: messages });
});

app.get("/api/status", function (_req, res) {
  res.json({
    status: "ok",
    service: "sync-engine-server",
    features: ["auth", "private-messaging", "voice-notes", "pwa"],
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
  console.log("[SOCKET] Conexión abierta: " + socket.id);

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
    console.log(`[AUTH] Usuario ${user.formattedName} conectado (socket: ${socket.id})`);

    // Notificar a contactos sobre estado online
    broadcastUserStatus(syncId, true);
  });

  // Envío de Mensaje Privado (Texto, Audio de Voz o Archivo)
  socket.on("send-private-message", function (payload) {
    const sender = socketToUser.get(socket.id);
    if (!sender) {
      socket.emit("error-message", { message: "No autenticado" });
      return;
    }

    const { toSyncId, text, type, fileData, audioData, clientMsgId, replyTo } = payload || {};
    if (!toSyncId) return;

    const targetSyncId = String(toSyncId).trim().toUpperCase();
    if (sender.syncId === targetSyncId) {
      // Bloquear cualquier intento de enviarse a sí mismo
      return;
    }

    const msgType = type || "text";
    let messageObj = null;

    if (msgType === "text") {
      // Persistir historial de texto en DB con soporte para mensaje citado (replyTo)
      messageObj = db.saveTextMessage(sender.syncId, targetSyncId, text || "", clientMsgId || null, replyTo || null);
      messageObj.fromName = sender.formattedName;
      messageObj.toSyncId = targetSyncId;
    } else {
      // Transferencia Efímera (Archivos, Imágenes y Notas de Voz)
      // Se transmite en memoria sobre WebSocket y se libera inmediatamente sin retener archivos residuales en disco
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
        read: false
      };
    }

    // Entregar a todos los sockets activos del destinatario
    const targetSockets = onlineUsers.get(targetSyncId);
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

    socket.emit("message-sent", { id: messageObj.id, timestamp: messageObj.timestamp });
    console.log(`[MSG] De ${sender.syncId} para ${targetSyncId} (${msgType})`);
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

    // Emitir a sockets del destinatario
    const targetSockets = onlineUsers.get(targetSyncId);
    if (targetSockets && targetSockets.size > 0) {
      targetSockets.forEach((sockId) => {
        io.to(sockId).emit("message-reaction-updated", eventData);
      });
    }

    // Emitir a sockets del emisor (sincronización multi-dispositivo)
    const senderSockets = onlineUsers.get(sender.syncId);
    if (senderSockets && senderSockets.size > 0) {
      senderSockets.forEach((sockId) => {
        io.to(sockId).emit("message-reaction-updated", eventData);
      });
    }
    console.log(`[REACTION] ${sender.syncId} reaccionó con ${payload.emoji} al mensaje ${payload.messageId}`);
  });

  // Indicadores en Tiempo Real ("Escribiendo..." y "Grabando audio...")
  socket.on("typing-start", function (payload) {
    const sender = socketToUser.get(socket.id);
    if (!sender || !payload || !payload.toSyncId) return;
    const targetSockets = onlineUsers.get(payload.toSyncId.trim().toUpperCase());
    if (targetSockets) {
      targetSockets.forEach((s) => io.to(s).emit("contact-typing-start", { fromSyncId: sender.syncId, fromName: sender.formattedName }));
    }
  });

  socket.on("typing-stop", function (payload) {
    const sender = socketToUser.get(socket.id);
    if (!sender || !payload || !payload.toSyncId) return;
    const targetSockets = onlineUsers.get(payload.toSyncId.trim().toUpperCase());
    if (targetSockets) {
      targetSockets.forEach((s) => io.to(s).emit("contact-typing-stop", { fromSyncId: sender.syncId }));
    }
  });

  socket.on("recording-start", function (payload) {
    const sender = socketToUser.get(socket.id);
    if (!sender || !payload || !payload.toSyncId) return;
    const targetSockets = onlineUsers.get(payload.toSyncId.trim().toUpperCase());
    if (targetSockets) {
      targetSockets.forEach((s) => io.to(s).emit("contact-recording-start", { fromSyncId: sender.syncId, fromName: sender.formattedName }));
    }
  });

  socket.on("recording-stop", function (payload) {
    const sender = socketToUser.get(socket.id);
    if (!sender || !payload || !payload.toSyncId) return;
    const targetSockets = onlineUsers.get(payload.toSyncId.trim().toUpperCase());
    if (targetSockets) {
      targetSockets.forEach((s) => io.to(s).emit("contact-recording-stop", { fromSyncId: sender.syncId }));
    }
  });

  // Indicador de Escritura Legacy
  socket.on("typing", function (payload) {
    const sender = socketToUser.get(socket.id);
    if (!sender || !payload || !payload.toSyncId) return;

    const targetSockets = onlineUsers.get(payload.toSyncId.trim().toUpperCase());
    if (targetSockets) {
      targetSockets.forEach((sockId) => {
        io.to(sockId).emit("user-typing", {
          fromSyncId: sender.syncId,
          fromName: sender.formattedName,
          isTyping: !!payload.isTyping
        });
      });
    }
  });

  // SEÑALIZACIÓN WEBRTC (LLAMADAS DE VOZ P2P EN TIEMPO REAL)
  // 1. Iniciar llamada enviando oferta SDP
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
      console.log(`[CALL] Oferta de llamada de ${sender.syncId} para ${targetSyncId}`);
    } else {
      socket.emit("call-unavailable", {
        toSyncId: targetSyncId,
        message: "El contacto no se encuentra en línea para recibir llamadas"
      });
    }
  });

  // 2. Aceptar llamada enviando respuesta SDP
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
      console.log(`[CALL] Respuesta de llamada aceptada de ${sender.syncId} para ${targetSyncId}`);
    }
  });

  // 3. Intercambio de candidatos de red WebRTC (ICE Candidate)
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

  // 4. Rechazar llamada
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
      console.log(`[CALL] Llamada rechazada por ${sender.syncId} para ${targetSyncId}`);
    }
  });

  // 5. Finalizar o colgar llamada activa
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
      console.log(`[CALL] Llamada finalizada entre ${sender.syncId} y ${targetSyncId}`);
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
          console.log(`[AUTH] Usuario ${user.formattedName} totalmente desconectado.`);
          broadcastUserStatus(syncId, false);
        }
      }
    }
    console.log("[SOCKET] Desconectado: " + socket.id);
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
