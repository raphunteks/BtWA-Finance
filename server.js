/**
 * ====================================================================
 * AXA XYZ WHATSAPP FINANCIAL BOT MICROSERVICE ENGINE
 * Author      : Axa Xyz Engineering (by Zettbos)
 * Environment : Railway / Node.js 18+ / CommonJS
 * File        : server.js
 * ====================================================================
 * 
 * FITUR UTAMA:
 * - Dual Realtime Transport: Socket.IO (/socket.io) & Plaintext WebSocket (/ws)
 * - Anti-Loop Spam Reconnect: Membersihkan session korup otomatis saat status undefined
 * - Live QR Code Broadcasting: Push QR Base64 Data URL realtime ke web Vercel
 * - Multi-File Auth State Baileys di direktori persisten ./auth_session
 * - Express REST API & Health Check Monitor
 * - Daily Push Reminder Cron Scheduler (20:00 WIB)
 */

const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');
const cron = require('node-cron');
const axios = require('axios');
const { Server: SocketIOServer } = require('socket.io');
const { WebSocketServer, WebSocket } = require('ws');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion,
  fetchLatestBaileysVersion,
  Browsers,
  delay
} = require('@whiskeysockets/baileys');
const pino = require('pino');

const messageHandler = require('./messageHandler');

// Konfigurasi Port & Variabel Lingkungan
const PORT = process.env.PORT || 3000;
const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL || '';
const API_SECRET_TOKEN = process.env.API_SECRET_TOKEN || 'AXA_XYZ_SECRET_2026';
const AUTH_DIR = path.join(__dirname, 'auth_session');

// Inisialisasi Express & HTTP Server
const app = express();
const server = http.createServer(app);

// Inisialisasi Socket.IO Server
const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true
});

// Inisialisasi Plaintext WebSocket Server (/ws)
const wss = new WebSocketServer({ noServer: true });

// Delegasi HTTP Upgrade untuk mendukung Socket.IO dan Plaintext WebSocket secara harmonis
server.on('upgrade', (request, socket, head) => {
  const pathname = request.url ? request.url.split('?')[0] : '';
  if (pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (wsClient) => {
      wss.emit('connection', wsClient, request);
    });
  }
  // Jalur '/socket.io' otomatis ditangani oleh Socket.IO server
});

// Middleware Express
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// State Tracker Global
let waSocket = null;
let connectionStatus = 'Initializing'; // 'Initializing' | 'Scanning_QR' | 'Connected' | 'Disconnected'
let currentQRRaw = null;
let currentQRDataUrl = null;
let connectedUser = null;
const serverStartTime = Date.now();
let reconnectAttempts = 0;
let isStartingSocket = false;
let reconnectTimer = null;

// Memastikan direktori auth_session siap digunakan
function ensureAuthDir() {
  if (!fs.existsSync(AUTH_DIR)) {
    try {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    } catch (dirErr) {
      console.error('[AxaBOT Server] Gagal membuat direktori auth_session:', dirErr.message);
    }
  }
}

// Membersihkan sesi korup agar Baileys membuat keypair pairing baru secara segar
function wipeAuthDir() {
  console.warn('[AxaBOT Server] 🧹 Membersihkan direktori auth_session untuk pairing ulang...');
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    currentQRRaw = null;
    currentQRDataUrl = null;
    connectedUser = null;
    connectionStatus = 'Disconnected';
    reconnectAttempts = 0;
  } catch (err) {
    console.error('[AxaBOT Server] Gagal membersihkan folder auth_session:', err.message);
  }
}

ensureAuthDir();

/**
 * Helper Broadcast: Mengirim payload event secara serentak ke Socket.IO & Plaintext WebSocket
 */
function broadcastRealtime(event, payload) {
  // 1. Kirim via Socket.IO
  try {
    io.emit(event, payload);
  } catch (ioErr) {
    console.warn('[AxaBOT Realtime] Gagal broadcast via Socket.IO:', ioErr.message);
  }

  // 2. Kirim via Plaintext WebSocket (/ws)
  try {
    const rawMessage = JSON.stringify({ event, data: payload, timestamp: new Date().toISOString() });
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(rawMessage);
      }
    });
  } catch (wsErr) {
    console.warn('[AxaBOT Realtime] Gagal broadcast via Plaintext WS:', wsErr.message);
  }
}

// Listener Koneksi Client Socket.IO
io.on('connection', (socket) => {
  console.log(`[AxaBOT Socket.IO] Client terhubung: ${socket.id}`);

  // Kirim status awal dan QR terkini ke client yang baru tersambung
  socket.emit('connection_status', {
    status: connectionStatus,
    connectedNumber: connectedUser ? connectedUser.id.split(':')[0] : null,
    hasQR: Boolean(currentQRDataUrl),
    reconnectAttempts
  });

  if (currentQRDataUrl) {
    socket.emit('qr_update', {
      qrImage: currentQRDataUrl,
      rawQR: currentQRRaw,
      sessionStatus: 'Scanning_QR'
    });
  }

  // Tangkap event permintaan QR manual dari client
  socket.on('request_qr', () => {
    if (currentQRDataUrl) {
      socket.emit('qr_update', {
        qrImage: currentQRDataUrl,
        rawQR: currentQRRaw,
        sessionStatus: 'Scanning_QR'
      });
    } else {
      socket.emit('connection_status', {
        status: connectionStatus,
        message: 'QR Code sedang diinisialisasi oleh Baileys...'
      });
    }
  });

  // Tangkap event force-reset sesi dari client
  socket.on('reset_session', () => {
    console.log(`[AxaBOT Socket.IO] Permintaan reset_session diterima dari client: ${socket.id}`);
    wipeAuthDir();
    scheduleReconnect(1000);
  });

  socket.on('disconnect', () => {
    // Client terputus secara normal
  });
});

// Listener Koneksi Client Plaintext WebSocket (/ws)
wss.on('connection', (wsClient, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`[AxaBOT Plaintext WS] Klien terhubung dari ${clientIp}`);

  // Kirim frame sambutan dalam format teks JSON
  const welcomePayload = {
    event: 'welcome',
    data: {
      engine: 'AxaBOT Realtime Engine',
      status: connectionStatus,
      connectedNumber: connectedUser ? connectedUser.id.split(':')[0] : null,
      hasQR: Boolean(currentQRDataUrl)
    }
  };
  wsClient.send(JSON.stringify(welcomePayload));

  if (currentQRDataUrl) {
    wsClient.send(JSON.stringify({
      event: 'qr_update',
      data: {
        qrImage: currentQRDataUrl,
        rawQR: currentQRRaw,
        sessionStatus: 'Scanning_QR'
      }
    }));
  }

  wsClient.on('message', (message) => {
    try {
      const parsed = JSON.parse(message.toString());
      if (parsed.action === 'ping') {
        wsClient.send(JSON.stringify({ event: 'pong', time: Date.now() }));
      } else if (parsed.action === 'reset_session') {
        wipeAuthDir();
        scheduleReconnect(1000);
      }
    } catch (e) {
      // Abaikan jika bukan pesan JSON
    }
  });
});

/**
 * Resolusi versi WhatsApp Web dinamis agar terhindar dari penolakan handshake 405
 */
async function resolveWaVersion() {
  let resolvedVersion = [2, 3000, 1042466098]; // Fallback aman
  try {
    if (typeof fetchLatestWaWebVersion === 'function') {
      const waWeb = await fetchLatestWaWebVersion();
      if (waWeb && waWeb.version) {
        resolvedVersion = waWeb.version;
        console.log(`[AxaBOT] Menggunakan WA Web Version Live: v${resolvedVersion.join('.')}`);
        return resolvedVersion;
      }
    }
    if (typeof fetchLatestBaileysVersion === 'function') {
      const baileysV = await fetchLatestBaileysVersion();
      if (baileysV && baileysV.version) {
        resolvedVersion = baileysV.version;
      }
    }
  } catch (verErr) {
    console.warn('[AxaBOT] Peringatan resolusi versi WA Web (menggunakan fallback aman):', verErr.message);
  }
  return resolvedVersion;
}

/**
 * Inisialisasi Socket Baileys dengan Teardown Bersih & Anti-Loop Reconnect
 */
async function startWASocket() {
  if (isStartingSocket) {
    console.log('[AxaBOT] Proses inisialisasi socket sedang berjalan, menunda permintaan baru...');
    return;
  }
  isStartingSocket = true;

  // Teardown socket lama secara tuntas untuk mencegah memory leak
  if (waSocket) {
    try {
      waSocket.ev.removeAllListeners('connection.update');
      waSocket.ev.removeAllListeners('creds.update');
      waSocket.ev.removeAllListeners('messages.upsert');
      waSocket.end(undefined);
    } catch (cleanErr) {
      console.warn('[AxaBOT] Peringatan teardown socket lama:', cleanErr.message);
    }
    waSocket = null;
  }

  try {
    ensureAuthDir();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const version = await resolveWaVersion();
    const isRegistered = Boolean(state?.creds?.registered);

    console.log(`[AxaBOT] Memulai Baileys Socket (Tersimpan: ${isRegistered ? 'Ya' : 'Belum'}, Percobaan: #${reconnectAttempts})`);

    const logger = pino({ level: 'silent' });

    waSocket = makeWASocket({
      version,
      logger,
      auth: state,
      printQRInTerminal: true, // Tampilkan di logs Railway untuk kemudahan scan langsung
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      retryRequestDelayMs: 2500
    });

    waSocket.ev.on('creds.update', saveCreds);

    waSocket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Skenario A: Kode QR Baru Dihasilkan oleh WhatsApp
      if (qr) {
        currentQRRaw = qr;
        connectionStatus = 'Scanning_QR';
        reconnectAttempts = 0; // Reset counter saat QR berhasil keluar
        try {
          currentQRDataUrl = await qrcode.toDataURL(qr, { margin: 2, scale: 7 });
          console.log('[AxaBOT] >>> KODE QR BARU BERHASIL DIGENERATE (SIAP DI-SCAN DI VERCEL) <<<');

          // Broadcast instan via Socket.IO & Plaintext WS
          broadcastRealtime('qr_update', {
            qrImage: currentQRDataUrl,
            rawQR: currentQRRaw,
            sessionStatus: 'Scanning_QR'
          });
          broadcastRealtime('connection_status', {
            status: 'Scanning_QR',
            hasQR: true
          });
        } catch (qrErr) {
          console.error('[AxaBOT] Gagal mengonversi QR ke DataURL:', qrErr.message);
        }
      }

      // Skenario B: WhatsApp Sukses Terhubung (Authenticated)
      if (connection === 'open') {
        connectionStatus = 'Connected';
        currentQRRaw = null;
        currentQRDataUrl = null;
        reconnectAttempts = 0;
        connectedUser = waSocket.user || null;
        console.log(`[AxaBOT] ✅ WHATSAPP TERHUBUNG AKTIF! Nomor: ${connectedUser?.id || 'Unknown'}`);

        broadcastRealtime('connection_status', {
          status: 'Connected',
          connectedNumber: connectedUser ? connectedUser.id.split(':')[0] : null,
          hasQR: false
        });
      }

      // Skenario C: Koneksi Terputus
      if (connection === 'close') {
        connectionStatus = 'Disconnected';
        const error = lastDisconnect?.error;
        const statusCode = error?.output?.statusCode;
        const errorMessage = error?.message || 'Unknown Network Drop';

        console.warn(`[AxaBOT] Koneksi terputus: "${errorMessage}" (Status: ${statusCode || 'Undefined'})`);

        broadcastRealtime('connection_status', {
          status: 'Disconnected',
          hasQR: false,
          reason: errorMessage
        });

        // 1. Kasus Logout Resmi dari HP
        if (statusCode === DisconnectReason.loggedOut) {
          console.warn('[AxaBOT] Sesi telah logout dari perangkat WhatsApp. Mereset sesi...');
          wipeAuthDir();
          scheduleReconnect(3000);
          return;
        }

        // 2. Kasus Sesi Belum Registered tapi Berulang Kali Putus dengan Status Undefined
        // (Inilah penyebab log spam #61, #62. Sesi korup wajib dibersihkan agar keluar QR baru!)
        if (!isRegistered) {
          reconnectAttempts++;
          if (reconnectAttempts >= 2) {
            console.warn('[AxaBOT] Terdeteksi berkas sesi korup/tidak lengkap pada auth_session. Membersihkan folder agar QR segar keluar...');
            wipeAuthDir();
            scheduleReconnect(2000);
            return;
          }
        }

        // 3. Kasus Bad Session (Status 405 atau 401)
        if (statusCode === DisconnectReason.badSession || statusCode === 405) {
          console.warn('[AxaBOT] Sesi tidak valid (badSession/405). Melakukan reset auth_session...');
          wipeAuthDir();
          scheduleReconnect(3000);
          return;
        }

        // 4. Reconnect Normal dengan Backoff Cerdas
        reconnectAttempts++;
        const backoffDelay = Math.min(reconnectAttempts * 3000, 20000);
        console.log(`[AxaBOT] Menjadwalkan reconnect #${reconnectAttempts} dalam ${backoffDelay}ms...`);
        scheduleReconnect(backoffDelay);
      }
    });

    waSocket.ev.on('messages.upsert', async (chatUpdate) => {
      try {
        await messageHandler.handleIncomingMessages(waSocket, chatUpdate);
      } catch (handlerErr) {
        console.error('[AxaBOT] Kesalahan saat memproses pesan masuk:', handlerErr.message);
      }
    });

  } catch (initErr) {
    console.error('[AxaBOT] Critical error in startWASocket:', initErr.message);
    scheduleReconnect(5000);
  } finally {
    isStartingSocket = false;
  }
}

function scheduleReconnect(delayMs) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    startWASocket();
  }, delayMs);
}

/**
 * GET / : Health Check & Uptime Info
 */
app.get('/', (req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);
  res.json({
    engine: 'Axa Xyz WhatsApp Financial Microservice',
    version: '3.6.5-SocketIO',
    status: 'ONLINE',
    uptimeSeconds,
    connectionStatus,
    connectedNumber: connectedUser ? connectedUser.id.split(':')[0] : null,
    hasQR: Boolean(currentQRDataUrl),
    reconnectAttempts,
    realtimeSupported: ['Socket.IO (/socket.io)', 'Plaintext WebSocket (/ws)'],
    timestamp: new Date().toISOString()
  });
});

/**
 * GET /status : Status Koneksi WhatsApp untuk Portal Admin
 */
app.get('/status', (req, res) => {
  res.json({
    success: true,
    status: connectionStatus,
    connectionStatus: connectionStatus,
    connectedNumber: connectedUser ? connectedUser.id.split(':')[0] : null,
    hasQR: Boolean(currentQRDataUrl),
    reconnectAttempts
  });
});

/**
 * GET /qr : Ambil QR Code Sesi WhatsApp
 */
app.get('/qr', (req, res) => {
  if (connectionStatus === 'Connected') {
    return res.json({
      success: true,
      status: 'Connected',
      sessionStatus: 'Connected',
      message: 'Sesi WhatsApp sudah terhubung aktif.',
      qrImage: null,
      rawQR: null
    });
  }

  // Jika diminta dalam format HTML view
  if (req.query.view === 'html' && currentQRDataUrl) {
    return res.send(`
      <!DOCTYPE html>
      <html lang="id">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Pairing Sesi WhatsApp - AxaBOT</title>
        <style>
          body { display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; font-family:system-ui,sans-serif; background:#E0F2FE; }
          .card { background:#fff; padding:28px; border:3px solid #000; box-shadow:6px 6px 0 #000; border-radius:12px; text-align:center; max-width:320px; }
          img { max-width:240px; border:2px solid #000; border-radius:8px; margin:12px 0; }
          .btn { display:inline-block; margin-top:10px; padding:8px 16px; background:#0284C7; color:#fff; font-weight:800; border:2px solid #000; box-shadow:3px 3px 0 #000; border-radius:6px; text-decoration:none; cursor:pointer; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2 style="margin:0 0 6px 0; font-weight:900;">Pairing WA AxaBOT</h2>
          <p style="font-size:0.85rem; color:#475569; margin:0;">Buka WhatsApp > Perangkat Tertaut > Tautkan Perangkat</p>
          <img src="${currentQRDataUrl}" alt="QR WhatsApp" />
          <div><button class="btn" onclick="location.reload()">🔄 Refresh QR</button></div>
        </div>
      </body>
      </html>
    `);
  }

  if (currentQRDataUrl) {
    return res.json({
      success: true,
      status: 'Scanning_QR',
      sessionStatus: 'Scanning_QR',
      qrImage: currentQRDataUrl,
      rawQR: currentQRRaw,
      checkedAt: new Date().toLocaleTimeString('id-ID')
    });
  }

  return res.json({
    success: false,
    status: connectionStatus,
    sessionStatus: connectionStatus,
    message: 'Kode QR sedang diinisialisasi oleh Baileys. Tunggu beberapa detik lalu refresh kembali.',
    qrImage: null,
    rawQR: null
  });
});

/**
 * GET /qr.png : Streaming buffer PNG langsung
 */
app.get('/qr.png', async (req, res) => {
  if (!currentQRRaw) {
    return res.status(404).send('Kode QR belum tersedia atau WhatsApp sudah terhubung.');
  }
  try {
    const pngBuffer = await qrcode.toBuffer(currentQRRaw, { margin: 2, scale: 7 });
    res.setHeader('Content-Type', 'image/png');
    res.send(pngBuffer);
  } catch (err) {
    res.status(500).send('Gagal membuat gambar QR: ' + err.message);
  }
});

/**
 * POST /restart : Restart instance socket Baileys secara bersih
 */
app.post('/restart', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();

  if (token !== API_SECRET_TOKEN && req.body.token !== API_SECRET_TOKEN && req.query.token !== API_SECRET_TOKEN) {
    return res.status(403).json({ success: false, message: 'Unauthorized: Token API tidak valid.' });
  }

  const shouldWipe = req.query.reset === 'true' || req.body.reset === true;
  console.log(`[AxaBOT] Manual restart socket Baileys dipicu via API (Wipe Session: ${shouldWipe}).`);

  if (shouldWipe) {
    wipeAuthDir();
  }

  scheduleReconnect(1000);
  return res.json({ success: true, message: 'Instance Baileys sedang di-restart.' });
});

/**
 * POST /reset-session : Paksa pembersihan sesi untuk membuat QR baru instan
 */
app.post('/reset-session', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();

  if (token !== API_SECRET_TOKEN && req.body.token !== API_SECRET_TOKEN && req.query.token !== API_SECRET_TOKEN) {
    return res.status(403).json({ success: false, message: 'Unauthorized: Token API tidak valid.' });
  }

  console.log('[AxaBOT] Force reset session dipicu.');
  wipeAuthDir();
  scheduleReconnect(1000);
  return res.json({ success: true, message: 'Sesi berhasil dibersihkan. QR baru sedang dibuat.' });
});

/**
 * Cron Job: Pengingat Rekap Harian Otomatis (Setiap Pukul 20:00 WIB)
 */
cron.schedule('0 20 * * *', async () => {
  console.log('[AxaBOT CRON] Mengeksekusi pengingat rekap keuangan harian pukul 20:00 WIB...');
  if (connectionStatus !== 'Connected' || !waSocket) {
    console.warn('[AxaBOT CRON] Jadwal dibatalkan: Socket WhatsApp tidak dalam status Connected.');
    return;
  }

  if (!GAS_WEBAPP_URL) {
    console.warn('[AxaBOT CRON] GAS_WEBAPP_URL belum diatur.');
    return;
  }

  try {
    const response = await axios.get(GAS_WEBAPP_URL, {
      params: { action: 'getReminderClients', token: API_SECRET_TOKEN },
      timeout: 10000
    });

    const clients = response.data?.clients || [];
    console.log(`[AxaBOT CRON] Menemukan ${clients.length} klien untuk pengingat kas.`);

    for (const client of clients) {
      const waNumber = client.waNumber ? client.waNumber.replace(/[^0-9]/g, '') : null;
      if (!waNumber) continue;

      const recipientJid = `${waNumber}@s.whatsapp.net`;
      const clientName = client.clientName || 'Juragan';

      const reminderText =
        `🌙 *Halo Kak ${clientName}! Pengingat Rekap Kas Malam*\n\n` +
        `Sudahkah mencatat seluruh arus kas tokomu hari ini? Yuk catat sebelum tutup buku agar pembukuan tetap tertib dan rapi!\n\n` +
        `💡 *Contoh Catat Instan:*\n` +
        `• _Beli stok bahan 150k #bca_\n` +
        `• _+250000 Penjualan paket hemat #tunai_\n` +
        `• Atau kirim foto nota/struk belanjamu di sini! 🧾\n\n` +
        `Ketik *!saldo* untuk cek kas dan *!menu* untuk panduan lengkap.`;

      try {
        await waSocket.sendMessage(recipientJid, { text: reminderText });
        console.log(`[AxaBOT CRON] Pengingat terkirim ke ${waNumber}`);
      } catch (sendErr) {
        console.error(`[AxaBOT CRON] Gagal mengirim pengingat ke ${waNumber}:`, sendErr.message);
      }

      const randomJitter = Math.floor(Math.random() * 2000) + 3000;
      await delay(randomJitter);
    }
  } catch (cronErr) {
    console.error('[AxaBOT CRON] Kesalahan saat eksekusi cron pengingat:', cronErr.message);
  }
}, {
  timezone: 'Asia/Jakarta'
});

// Menjalankan Server HTTP & WebSocket
server.listen(PORT, () => {
  console.log(`[AxaBOT Engine] Server berjalan aktif pada port ${PORT}`);
  console.log(`[AxaBOT Engine] Socket.IO siap di path /socket.io | Plaintext WS siap di /ws`);
  console.log(`[AxaBOT Engine] Memulai inisialisasi sesi WhatsApp Baileys di: ${AUTH_DIR}`);
  startWASocket();
});
