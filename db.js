const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "sync_db.json");

function ensureDbFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(DB_FILE)) {
    const initialData = {
      users: [],
      sessions: [],
      contacts: {},
      messages: []
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2), "utf8");
  }
}

function readDb() {
  ensureDbFile();
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const data = JSON.parse(raw);
    if (!data.users) data.users = [];
    if (!data.sessions) data.sessions = [];
    if (!data.contacts) data.contacts = {};
    if (!data.messages) data.messages = [];
    return data;
  } catch (err) {
    console.error("[DB] Error al leer base de datos, inicializando respaldo:", err.message);
    return { users: [], sessions: [], contacts: {}, messages: [] };
  }
}

function writeDb(data) {
  ensureDbFile();
  const tmpFile = DB_FILE + ".tmp." + Date.now();
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpFile, DB_FILE);
}

function removeEmojis(str) {
  if (!str) return "Usuario";
  const cleaned = str
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE00}-\u{FE0F}\u{1F004}\u{1F0CF}\u{E0020}-\u{E007F}]/gu, "")
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")
    .replace(/[^\w\s\u00C0-\u00FF\-_.]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "Usuario";
}

function formatFullName(syncId, cleanName) {
  return `${syncId} - ${cleanName}`;
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
}

function generateSyncId(users) {
  const existing = new Set(users.map((u) => u.syncId));
  for (let i = 0; i < 1000; i++) {
    const num = Math.floor(1000 + Math.random() * 9000);
    const candidate = `SYNC-${num}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
  return `SYNC-${Date.now().toString().slice(-4)}`;
}

function registerUser(username, password, rawDisplayName) {
  if (!username || !password) {
    throw new Error("Usuario y contraseña son obligatorios");
  }

  const cleanUsername = String(username).trim().toLowerCase();
  if (cleanUsername.length < 3) {
    throw new Error("El usuario debe tener al menos 3 caracteres");
  }
  if (String(password).length < 4) {
    throw new Error("La contraseña debe tener al menos 4 caracteres");
  }

  const db = readDb();
  const exists = db.users.find((u) => u.username === cleanUsername);
  if (exists) {
    throw new Error("El nombre de usuario ya está registrado");
  }

  const syncId = generateSyncId(db.users);
  const cleanDisplayName = removeEmojis(rawDisplayName || username);
  const formattedName = formatFullName(syncId, cleanDisplayName);
  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = hashPassword(password, salt);

  const newUser = {
    id: crypto.randomUUID ? crypto.randomUUID() : "usr_" + Date.now(),
    syncId: syncId,
    username: cleanUsername,
    cleanDisplayName: cleanDisplayName,
    formattedName: formattedName,
    salt: salt,
    passwordHash: passwordHash,
    createdAt: Date.now()
  };

  db.users.push(newUser);

  // Inicializar lista de contactos con auto-contacto (Mensajes Guardados)
  if (!db.contacts[syncId]) {
    db.contacts[syncId] = [syncId];
  }

  writeDb(db);

  return toPublicUser(newUser);
}

function loginUser(username, password) {
  if (!username || !password) {
    throw new Error("Usuario y contraseña requeridos");
  }

  const cleanUsername = String(username).trim().toLowerCase();
  const db = readDb();
  const user = db.users.find((u) => u.username === cleanUsername);
  if (!user) {
    throw new Error("Credenciales inválidas");
  }

  const hash = hashPassword(password, user.salt);
  if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.passwordHash))) {
    throw new Error("Credenciales inválidas");
  }

  // Generar sesión
  const token = crypto.randomBytes(32).toString("hex");
  db.sessions.push({
    token: token,
    syncId: user.syncId,
    createdAt: Date.now()
  });

  // Limpiar sesiones viejas (> 30 días)
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  db.sessions = db.sessions.filter((s) => s.createdAt > cutoff);

  writeDb(db);

  return { token: token, user: toPublicUser(user) };
}

function getUserByToken(token) {
  if (!token) return null;
  const db = readDb();
  const session = db.sessions.find((s) => s.token === token);
  if (!session) return null;

  const user = db.users.find((u) => u.syncId === session.syncId);
  return user ? toPublicUser(user) : null;
}

function getUserBySyncId(syncId) {
  if (!syncId) return null;
  const db = readDb();
  const user = db.users.find((u) => u.syncId === syncId.trim().toUpperCase());
  return user ? toPublicUser(user) : null;
}

function updateUserProfile(syncId, rawName) {
  const db = readDb();
  const user = db.users.find((u) => u.syncId === syncId);
  if (!user) throw new Error("Usuario no encontrado");

  const clean = removeEmojis(rawName);
  user.cleanDisplayName = clean;
  user.formattedName = formatFullName(user.syncId, clean);
  writeDb(db);

  return toPublicUser(user);
}

function addContact(userSyncId, targetSyncId) {
  const targetId = String(targetSyncId).trim().toUpperCase();
  if (userSyncId === targetId) {
    return { ok: true, alreadyExists: true, target: getUserBySyncId(userSyncId) };
  }

  const db = readDb();
  const targetUser = db.users.find((u) => u.syncId === targetId);
  if (!targetUser) {
    throw new Error("Código ID no encontrado");
  }

  if (!db.contacts[userSyncId]) {
    db.contacts[userSyncId] = [userSyncId];
  }

  if (!db.contacts[userSyncId].includes(targetId)) {
    db.contacts[userSyncId].push(targetId);
  }

  // Recíproco
  if (!db.contacts[targetId]) {
    db.contacts[targetId] = [targetId];
  }
  if (!db.contacts[targetId].includes(userSyncId)) {
    db.contacts[targetId].push(userSyncId);
  }

  writeDb(db);

  return { ok: true, target: toPublicUser(targetUser) };
}

function getUserContacts(userSyncId, onlineSyncIds = new Set()) {
  const db = readDb();
  if (!db.contacts[userSyncId]) {
    db.contacts[userSyncId] = [userSyncId];
    writeDb(db);
  }

  const list = db.contacts[userSyncId];
  const contactsList = [];

  for (const id of list) {
    const u = db.users.find((item) => item.syncId === id);
    if (u) {
      const pub = toPublicUser(u);
      pub.isSelf = (id === userSyncId);
      pub.isOnline = onlineSyncIds.has(id);
      
      // Obtener último mensaje para preview
      const lastMsg = db.messages
        .filter((m) => (m.fromId === userSyncId && m.toId === id) || (m.fromId === id && m.toId === userSyncId))
        .sort((a, b) => b.timestamp - a.timestamp)[0];
      
      pub.lastMessage = lastMsg ? {
        text: lastMsg.type === 'audio' ? '🎤 Nota de voz' : (lastMsg.type === 'file' ? '📎 ' + (lastMsg.fileName || 'Archivo') : lastMsg.text),
        timestamp: lastMsg.timestamp,
        fromId: lastMsg.fromId
      } : null;

      contactsList.push(pub);
    }
  }

  return contactsList;
}

function saveTextMessage(fromId, toId, text) {
  const db = readDb();
  const newMsg = {
    id: "msg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
    fromId: fromId,
    toId: toId,
    type: "text",
    text: text,
    timestamp: Date.now(),
    read: false
  };

  db.messages.push(newMsg);
  
  // Limitar historial a últimos 3000 mensajes globales para preservar almacenamiento
  if (db.messages.length > 3000) {
    db.messages = db.messages.slice(-3000);
  }

  writeDb(db);
  return newMsg;
}

function getMessagesBetween(user1Id, user2Id) {
  const db = readDb();
  return db.messages.filter((m) => {
    return (m.fromId === user1Id && m.toId === user2Id) || (m.fromId === user2Id && m.toId === user1Id);
  }).sort((a, b) => a.timestamp - b.timestamp);
}

function toPublicUser(user) {
  return {
    syncId: user.syncId,
    username: user.username,
    cleanDisplayName: user.cleanDisplayName,
    formattedName: user.formattedName || formatFullName(user.syncId, user.cleanDisplayName)
  };
}

module.exports = {
  removeEmojis,
  formatFullName,
  registerUser,
  loginUser,
  getUserByToken,
  getUserBySyncId,
  updateUserProfile,
  addContact,
  getUserContacts,
  saveTextMessage,
  getMessagesBetween
};
