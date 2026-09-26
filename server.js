const https = require("https");
const os = require("os");
const path = require("path");
const express = require("express");
const cors = require("cors");
const selfsigned = require("selfsigned");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT) || 3000;
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

function createSslOptions() {
  const altNames = [
    { type: 2, value: "localhost" },
    { type: 7, ip: "127.0.0.1" }
  ];

  const localIps = getLocalIPv4Addresses();
  for (let i = 0; i < localIps.length; i++) {
    altNames.push({ type: 7, ip: localIps[i].address });
  }

  const pems = selfsigned.generate(
    [{ name: "commonName", value: "localhost" }],
    {
      days: 365,
      keySize: 2048,
      algorithm: "sha256",
      extensions: [{ name: "subjectAltName", altNames: altNames }]
    }
  );

  return {
    key: pems.private,
    cert: pems.cert
  };
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", function (_req, res) {
  res.json({
    status: "ok",
    service: "sync-engine-server",
    events: ["send-clipboard", "receive-clipboard", "send-file", "receive-file"]
  });
});

const sslOptions = createSslOptions();
const server = https.createServer(sslOptions, app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 50e6
});

io.on("connection", function (socket) {
  console.log("[OK] Dispositivo conectado: " + socket.id);

  socket.on("send-clipboard", function (payload) {
    console.log("[SYNC] Portapapeles retransmitido");
    io.emit("receive-clipboard", payload);
  });

  socket.on("send-file", function (payload) {
    var fileName = "desconocido";
    if (payload && payload.name) {
      fileName = payload.name;
    }
    console.log("[FILE] Archivo retransmitido: " + fileName);
    io.emit("receive-file", payload);
  });

  socket.on("disconnect", function () {
    console.log("[OFF] Dispositivo desconectado: " + socket.id);
  });
});

server.listen(PORT, HOST, function () {
  const localIps = getLocalIPv4Addresses();
  console.log("\n==================================================");
  console.log("SYNC ENGINE Server Activo en https://" + HOST + ":" + PORT);
  console.log("Conecta tus dispositivos usando una de estas direcciones:");
  if (localIps.length === 0) {
    console.log("  (no se encontro una IPv4 de red local)");
  } else {
    for (let i = 0; i < localIps.length; i++) {
      console.log("  https://" + localIps[i].address + ":" + PORT);
    }
  }
  console.log("==================================================\n");
});
