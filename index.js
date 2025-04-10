const express = require("express");
const { Client, MessageMedia, LocalAuth } = require("whatsapp-web.js");
const { PDFDocument } = require("pdf-lib");
const { execSync } = require("child_process");
const http = require("http");
const socketIO = require("socket.io");
const axios = require("axios");
const path = require("path");
const qrcode = require("qrcode");
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "200mb" }));
const server = http.createServer(app);
const io = socketIO(server);
const phoneToClientMap = {};
const fs = require("fs");
const { phoneNumberFormatter } = require("./helpers/formatter");
function logToFile(content) {
  fs.appendFileSync("error.log", `[${new Date().toISOString()}] ${content}\n`);
}

function convertToWhatsappMarkdown(text) {
  return (
    text
      // Bold **text** → *text*
      .replace(/\*\*(.*?)\*\*/g, "*$1*")
      // Italic _text_ atau __text__ → _text_
      .replace(/__(.*?)__/g, "_$1_")
      .replace(/_(.*?)_/g, "_$1_")
      // Strikethrough ~~text~~ → ~text~
      .replace(/~~(.*?)~~/g, "~$1~")
      // Code block ``` → hilangkan
      .replace(/```/g, "")
      // Inline code `text` → `text` (biarin atau bisa diubah jadi monospace biasa)
      .replace(/`(.*?)`/g, "〘$1〙")
  ); // atau biarkan ` seperti aslinya
}

process.on("uncaughtException", (err) => {
  const msg = `🔥 Uncaught Exception: ${err.stack}`;
  console.error(msg);
  logToFile(msg);
});

process.on("unhandledRejection", (reason, promise) => {
  const msg = `⚠️ Unhandled Rejection: ${reason}`;
  console.error(msg);
  logToFile(msg);
});

io.on("connection", (socket) => {
  console.log("🔌 New socket connected");
  const clients = [];
  for (const [clientId, session] of Object.entries(phoneToClientMap)) {
    clients.push({
      clientId,
      isAuthenticated: session.isAuthenticated,
      isReady: session.isReady,
    });
  }
  socket.emit("clients", clients);
  for (const client of clients) {
    if (client.isAuthenticated) {
      socket.emit("authenticated", { clientId: client.clientId });
    } else if (client.isReady) {
      socket.emit("ready", { clientId: client.clientId });
    }
  }
});

const initClient = (clientId) => {
  if (phoneToClientMap[clientId]) {
    console.log(
      `⚠️ Client ${clientId} sudah aktif. Lewati inisialisasi ulang.`
    );
    return;
  }
  const client = new Client({
    restartOnAuthFail: true,
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-gpu",
      ],
    },
    authStrategy: new LocalAuth({
      clientId: clientId.toString(),
      dataPath: path.join(__dirname, "sessions"),
    }),
    webVersionCache: { type: "none" },
  });

  phoneToClientMap[clientId] = client;

  client.on("qr", (qr) => {
    console.log(`📱 QR untuk ${clientId}:`, qr);
    qrcode.toDataURL(qr, (err, url) => {
      let qr = url;
      io.emit("qr", { clientId, qr });
      io.emit("message", "QR Code received, scan please!");
      io.emit("status", client.getState());
    });
  });

  client.on("ready", () => {
    io.emit("ready", { clientId });
    console.log(`✅ ${clientId} ready`);
  });

  client.on("authenticated", () => {
    io.emit("authenticated", { clientId });
    console.log(`🔐 ${clientId} authenticated`);
  });

  client.on("auth_failure", function (session) {
    io.emit("message", "auth_failure, restarting...");
    io.emit("status", client.getState());
  });

  client.on("disconnected", async () => {
    io.emit("disconnected", { clientId });
    console.log(`❌ ${clientId} disconnected`);
    try {
      await client.destroy();
    } catch (e) {
      console.error(`Gagal destroy client ${clientId}:`, e.message);
    }
    delete phoneToClientMap[clientId];
    setTimeout(() => {
      console.log(`🔄 Restarting client ${clientId} after 5s...`);
      initClient(clientId);
    }, 5000);
  });

  client.on("message", async (msg) => {
    if (msg.body.toLowerCase() == "#cmdping") {
      msg.reply("pong");
    } else if (msg.body.toLowerCase() == "#cmdgroups") {
      client.getChats().then((chats) => {
        const groups = chats.filter((chat) => chat.isGroup);
        if (groups.length == 0) {
          msg.reply("You have no group yet.");
        } else {
          let replyMsg = "*YOUR GROUPS*\n\n";
          groups.forEach((group, i) => {
            replyMsg += `ID: ${group.id._serialized}\nName: ${group.name}\n\n`;
          });
          replyMsg +=
            "_You can use the group id to send a message to the group._";
          msg.reply(replyMsg);
        }
      });
    } else if (msg.body.startsWith("#tanya ")) {
      const clientId = client.options.authStrategy.clientId;
      const allowedClientIds = ["082130643853"];
      if (!allowedClientIds.includes(clientId)) {
        return;
      }
      const prompt = msg.body.slice(7).trim();
      console.log("🔍 Prompt:", prompt);
      const data = {
        contents: [{ parts: [{ text: prompt }] }],
      };
      try {
        const key = "AIzaSyCAx06DT7HFpgaixbKehTnx9hph_kSSpKg";
        const response = await axios.post(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" +
            key,
          data,
          { headers: { "Content-Type": "application/json" } }
        );
        let output =
          response.data.candidates?.[0]?.content?.parts?.[0]?.text ||
          "Tidak ada jawaban.";
        output = convertToWhatsappMarkdown(output);
        await msg.reply(output);
      } catch (error) {
        console.error(
          "❌ Error Gemini:",
          error.response?.data || error.message
        );
        await msg.reply("Maaf, terjadi error saat menghubungi AI.");
      }
    }
  });
  client.initialize().catch((err) => {
    console.error(`❌ Gagal initialize client ${clientId}:`, err.message);
  });
};

// 🚀 Load client dari API eksternal
const loadClientsFromAPI = async () => {
  try {
    const response = await axios.get(
      "http://192.168.3.232/amob/public_api/Wa_list"
    );
    const clientIds = response.data.data;
    // console.log("📦 Client IDs dari API:", clientIds);
    clientIds.forEach((clientId) => {
      console.log("📦 number:", clientId.no_kartu);
      initClient(clientId.no_kartu);
    });
  } catch (error) {
    console.error("❌ Gagal load clients dari API:", error.message);
  }
};

loadClientsFromAPI();

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "whatsapp.html"));
});

app.get("/status/:clientId", (req, res) => {
  const clientId = req.params.clientId;
  const client = phoneToClientMap[clientId];

  if (!client) {
    return res.status(404).json({ status: "not_initialized" });
  }

  const state = client.info?.wid?.user ? "ready" : "loading";
  return res.status(200).json({ status: state });
});

app.get("/clients", async (req, res) => {
  const clientIds = Object.keys(phoneToClientMap);
  const clients = await Promise.all(
    clientIds.map(async (clientId) => {
      const client = phoneToClientMap[clientId];
      let state = "not_initialized";
      try {
        state = await client.getState();
      } catch (e) {
        console.warn(
          `⚠️ Gagal ambil state untuk client ${clientId}: ${e.message}`
        );
      }

      return {
        clientId: clientId,
        isAuthenticated: client.isAuthenticated,
        isReady: client.isReady,
        state,
      };
    })
  );
  console.log("📦 Clients:", clients);

  res.status(200).json(clients);
});

app.get("/groups/:clientId", async (req, res) => {
  const clientId = req.params.clientId;
  const client = phoneToClientMap[clientId];
  if (!client) return res.status(404).json({ error: "Client not found" });

  try {
    const chats = await client.getChats();
    const groups = chats
      .filter((chat) => chat.isGroup)
      .map((group) => ({
        id: group.id._serialized,
        name: group.name,
      }));
    res.json(groups);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch groups" });
  }
});

app.post("/send-message", async (req, res) => {
  const { clientId, number, message } = req.body;
  const formattedNumber = phoneNumberFormatter(number);
  const client = phoneToClientMap[clientId];
  if (!client) return res.status(404).json({ error: "Client not found" });
  try {
    await client.sendMessage(formattedNumber, message);
    res.json({ success: true, message: "Message sent" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to send message" });
  }
});

app.post("/send-group-message", async (req, res) => {
  const { clientId, groupId, message } = req.body;
  const client = phoneToClientMap[clientId];
  if (!client) return res.status(404).json({ error: "Client not found" });
  try {
    await client.sendMessage(groupId, message);
    res.json({ success: true, message: "Message sent to group by ID" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to send message to group" });
  }
});

app.post("/send-media", async (req, res) => {
  const { clientId, number, caption, fileurl, filename } = req.body;
  if (!phoneToClientMap[clientId]) {
    return res.status(404).json({ status: false, message: "Client not found" });
  }
  const client = phoneToClientMap[clientId];
  const formattedNumber = phoneNumberFormatter(number);
  try {
    const response = await axios.get(fileurl, {
      responseType: "arraybuffer",
    });
    const mimetype = response.headers["content-type"];
    const base64 = Buffer.from(response.data, "binary").toString("base64");
    const media = new MessageMedia(mimetype, base64, filename);
    const sentMsg = await client.sendMessage(formattedNumber, media, {
      caption,
    });
    res.status(200).json({ status: true, response: sentMsg });
  } catch (err) {
    console.error("❌ Gagal kirim media:", err.message);
    res
      .status(500)
      .json({
        status: false,
        message: "Gagal mengirim media",
        error: err.message,
      });
  }
});

app.post("/send-media-lock", async (req, res) => {
  const { clientId, number, caption, fileurl, filename, password } = req.body;
  const client = phoneToClientMap[clientId];
  if (!client) {
    return res.status(404).json({ status: false, message: "Client not found" });
  }
  const formattedNumber = phoneNumberFormatter(number);
  const tempInputPath = `${Math.random().toString(36).substring(2)}-input.pdf`;
  const tempOutputPath = `${Math.random()
    .toString(36)
    .substring(2)}-output.pdf`;
  try {
    const response = await axios.get(fileurl, { responseType: "arraybuffer" });
    const pdfBytes = response.data;
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const reSavedBytes = await pdfDoc.save();
    fs.writeFileSync(tempInputPath, reSavedBytes);
    const encryptCmd = `qpdf --encrypt ${password} ${password} 256 -- ${tempInputPath} ${tempOutputPath}`;
    execSync(encryptCmd);
    const encryptedBuffer = fs.readFileSync(tempOutputPath);
    const base64 = encryptedBuffer.toString("base64");
    const mimetype = "application/pdf";
    const media = new MessageMedia(mimetype, base64, filename);
    const sentMsg = await client.sendMessage(formattedNumber, media, {
      caption,
    });
    res.status(200).json({ status: true, response: sentMsg });
  } catch (err) {
    console.error("❌ Gagal kirim PDF terenkripsi:", err.message);
    res
      .status(500)
      .json({
        status: false,
        message: "Gagal mengirim PDF",
        error: err.message,
      });
  } finally {
    [tempInputPath, tempOutputPath].forEach((path) => {
      if (fs.existsSync(path)) fs.unlinkSync(path);
    });
  }
});

app.post("/restart/:clientId", async (req, res) => {
  const clientId = req.params.clientId;
  const client = phoneToClientMap[clientId];
  if (!client) {
    return res
      .status(404)
      .json({ success: false, message: "Client not found." });
  }
  try {
    console.log(`🔄 Restarting client ${clientId}...`);
    await client.destroy();
    delete phoneToClientMap[clientId];
    setTimeout(() => {
      initClient(clientId);
      console.log(`✅ Client ${clientId} restarted.`);
    }, 1000);
    res.json({ success: true, message: `Client ${clientId} restarting...` });
  } catch (error) {
    console.error(`❌ Gagal restart client ${clientId}:`, error);
    res.status(500).json({ success: false, message: "Gagal restart client." });
  }
});

app.post("/logout/:clientId", async (req, res) => {
  const clientId = req.params.clientId;
  const client = phoneToClientMap[clientId];
  if (!client) {
    return res
      .status(404)
      .json({ success: false, message: "Client not found." });
  }
  try {
    console.log(`🚪 Logging out client ${clientId}...`);
    await client.logout();
    setTimeout(async () => {
      try {
        await client.destroy();
        delete phoneToClientMap[clientId];
        setTimeout(() => {
          initClient(clientId);
          console.log(`✅ Client ${clientId} logged out and destroyed.`);
        }, 1000);
      } catch (destroyError) {
        console.error(
          `❌ Error during destroy of client ${clientId}:`,
          destroyError
        );
      }
    }, 1000);
    res.json({ success: true, message: `Client ${clientId} logged out.` });
  } catch (error) {
    console.error(`❌ Logout error for client ${clientId}:`, error);
    res.status(500).json({ success: false, message: error.message });
  }
});

server.listen(3000, () => {
  console.log("🟢 Server berjalan di port 3000");
});
