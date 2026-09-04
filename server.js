/**
 * ====================================================================
 * AXA XYZ WHATSAPP FINANCIAL BOT MICROSERVICE ENGINE
 * Author      : Axa Xyz Engineering
 * Environment : Railway / Node.js 18+ / CommonJS
 * File        : server.js
 * ====================================================================
 * 
 * FITUR UTAMA:
 * - Anti-Loop Reconnect: Otomatis membersihkan auth_session jika belum registered
 * - Live QR Generation: QR Code siap dikonsumsi oleh web Vercel & Google Apps Script
 * - Auto Failover Versioning: Menggunakan fetchLatestWaWebVersion langsung dari WA Web
 * - Express REST API & Health Check Uptime Monitor
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

const PORT = process.env.PORT || 3000;
const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL || '';
const API_SECRET_TOKEN = process.env.API_SECRET_TOKEN || 'AXA_XYZ_SECRET_2026';
const AUTH_DIR = path.join(__dirname, 'auth_session');

const app = express();
const server = http.createServer(app);

// Konfigurasi Middleware Express dengan Batas Payload Longgar
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Global State Tracker
let waSocket = null;
let connectionStatus = 'Initializing'; // 'Initializing' | 'Scanning_QR' | 'Connected' | 'Disconnected'
let currentQRRaw = null;
let currentQRDataUrl = null;
let connectedUser = null;
const serverStartTime = Date.now();
let reconnectAttempts = 0;
let isStartingSocket = false;
let reconnectTimer = null;

function ensureAuthDir() {
  if (!fs.existsSync(AUTH_DIR)) {
    try {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    } catch (dirErr) {
      console.error('[AxaBOT Server] Gagal membuat direktori auth_session:', dirErr.message);
    }
  }
}

function wipeAuthDir() {
  console.warn('[AxaBOT Server] Membersihkan berkas auth_session untuk mengulang pairing...');
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
    console.error('[AxaBOT Server] Gagal membersihkan direktori auth_session:', err.message);
  }
}

ensureAuthDir();

async function resolveWaVersion() {
  let resolvedVersion = [2, 3000, 1042466098]; // Fallback aman jika network timeout
  try {
    if (typeof fetchLatestWaWebVersion === 'function') {
      const waWeb = await fetchLatestWaWebVersion();
      if (waWeb && waWeb.version) {
        resolvedVersion = waWeb.version;
        console.log(`[AxaBOT] Menggunakan WA Web Version: v${resolvedVersion.join('.')}`);
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
    console.warn('[AxaBOT] Gagal memeriksa versi WA Web terbaru, memakai fallback aman:', verErr.message);
  }
  return resolvedVersion;
}

async function startWASocket() {
  if (isStartingSocket) {
    console.log('[AxaBOT] Inisialisasi socket sedang berjalan, mengabaikan request duplikat...');
    return;
  }
  isStartingSocket = true;

  // Teardown socket lama secara bersih jika masih ada
  if (waSocket) {
    try {
      waSocket.ev.removeAllListeners('connection.update');
      waSocket.ev.removeAllListeners('creds.update');
      waSocket.ev.removeAllListeners('messages.upsert');
      waSocket.end(undefined);
    } catch (cleanErr) {
      console.warn('[AxaBOT] Peringatan saat teardown socket lama:', cleanErr.message);
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
      printQRInTerminal: true, // Tampilkan juga di logs Railway untuk kemudahan dev
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      retryRequestDelayMs: 2000
    });

    waSocket.ev.on('creds.update', saveCreds);

    waSocket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQRRaw = qr;
        connectionStatus = 'Scanning_QR';
        reconnectAttempts = 0; // Reset counter saat QR berhasil keluar
        try {
          currentQRDataUrl = await qrcode.toDataURL(qr, { margin: 2, scale: 7 });
          console.log('[AxaBOT] >>> KODE QR BARU BERHASIL DIGENERATE (SIAP DI-SCAN DI VERCEL) <<<');
        } catch (qrErr) {
          console.error('[AxaBOT] Gagal mengonversi QR ke DataURL:', qrErr.message);
        }
      }

      if (connection === 'open') {
        connectionStatus = 'Connected';
        currentQRRaw = null;
        currentQRDataUrl = null;
        reconnectAttempts = 0;
        connectedUser = waSocket.user || null;
        console.log(`[AxaBOT] ✅ WHATSAPP TERHUBUNG AKTIF! Nomor: ${connectedUser?.id || 'Unknown'}`);
      }

      if (connection === 'close') {
        connectionStatus = 'Disconnected';
        const error = lastDisconnect?.error;
        const statusCode = error?.output?.statusCode;
        const errorMessage = error?.message || 'Unknown Error';
        
        console.warn(`[AxaBOT] Koneksi terputus: "${errorMessage}" (HTTP Status: ${statusCode || 'Undefined'})`);

        // Skenario 1: User secara eksplisit melakukan Logout dari HP
        if (statusCode === DisconnectReason.loggedOut) {
          console.warn('[AxaBOT] Sesi telah logout dari perangkat WhatsApp.');
          wipeAuthDir();
          scheduleReconnect(3000);
          return;
        }

        // Skenario 2: Belum terhubung (masih scan QR) tapi putus berulang kali dengan status undefined
        // Ini pertanda session file corrupt / noise handshake gagal
        if (!isRegistered) {
          reconnectAttempts++;
          if (reconnectAttempts >= 3) {
            console.warn('[AxaBOT] Gagal membuat pairing QR 3 kali berturut-turut. Mereset folder auth_session agar QR segar...');
            wipeAuthDir();
            scheduleReconnect(2000);
            return;
          }
        }

        // Skenario 3: Bad session / Session corrupt setelah connected
        if (statusCode === DisconnectReason.badSession || statusCode === 405) {
          console.warn('[AxaBOT] Sesi tidak valid (badSession). Melakukan reset auth_session...');
          wipeAuthDir();
          scheduleReconnect(3000);
          return;
        }

        // Skenario 4: Reconnect normal sementara (jaringan lambat / restart server)
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
    version: '3.6.4',
    status: 'ONLINE',
    uptimeSeconds,
    connectionStatus,
    connectedNumber: connectedUser ? connectedUser.id.split(':')[0] : null,
    hasQR: Boolean(currentQRDataUrl),
    reconnectAttempts,
    timestamp: new Date().toISOString()
  });
});

/**
 * GET /status : Status Koneksi WhatsApp untuk Portal Admin Vercel / GAS
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
 * GET /qr : Ambil QR Code Sesi WhatsApp untuk Tampilan Modal di Vercel
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

  // Jika diminta format HTML langsung
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

server.listen(PORT, () => {
  console.log(`[AxaBOT Engine] Server berjalan aktif pada port ${PORT}`);
  console.log(`[AxaBOT Engine] Memulai inisialisasi sesi WhatsApp Baileys di: ${AUTH_DIR}`);
  startWASocket();
});
