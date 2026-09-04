/**
 * ====================================================================
 * AXA XYZ WHATSAPP FINANCIAL BOT MICROSERVICE ENGINE
 * Author      : Axa Xyz Engineering
 * Environment : Railway / Node.js 18+ / CommonJS
 * File        : server.js
 * ====================================================================
 * 
 * KONFIGURASI ENVIRONMENT VARIABLES (ENV):
 * - PORT                  : Port listening server HTTP (default: 3000)
 * - GAS_WEBAPP_URL        : Endpoint Google Apps Script Web App Axa Xyz
 * - API_SECRET_TOKEN      : Secret token otorisasi API restart & internal sync
 * - GEMINI_API_KEY        : Google AI Studio API Key (format AQ.* atau AIza*)
 * - DEFAULT_GEMINI_MODEL  : Model AI utama (default: gemini-3.6-flash)
 * - FALLBACK_GEMINI_MODEL : Model AI cadangan cepat (default: gemini-3.1-flash-lite)
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

// Konfigurasi Middleware Express
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// State Global Koneksi WhatsApp
let waSocket = null;
let connectionStatus = 'Initializing'; // 'Initializing' | 'Scanning_QR' | 'Connected' | 'Disconnected'
let currentQRRaw = null;
let currentQRDataUrl = null;
let connectedUser = null;
const serverStartTime = Date.now();
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 15;

// Pastikan direktori sesi persisten di Railway Volume
if (!fs.existsSync(AUTH_DIR)) {
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  } catch (dirErr) {
    console.error('[AxaBOT Server] Gagal membuat direktori auth_session:', dirErr.message);
  }
}

/**
 * Inisialisasi Socket Baileys dengan MultiFileAuthState
 */
async function startWASocket() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[AxaBOT] Memulai Baileys v${version.join('.')} (Latest: ${isLatest})`);

    const logger = pino({ level: 'silent' });

    waSocket = makeWASocket({
      version,
      logger,
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000
    });

    waSocket.ev.on('creds.update', saveCreds);

    waSocket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQRRaw = qr;
        connectionStatus = 'Scanning_QR';
        try {
          currentQRDataUrl = await qrcode.toDataURL(qr, { margin: 2, scale: 7 });
          console.log('[AxaBOT] Kode QR baru berhasil digenerate untuk pairing.');
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
        console.log(`[AxaBOT] WhatsApp TERHUBUNG AKTIF sebagai: ${connectedUser?.id || 'Unknown'}`);
      }

      if (connection === 'close') {
        connectionStatus = 'Disconnected';
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.warn(`[AxaBOT] Koneksi terputus (Status: ${statusCode}). Reconnect: ${shouldReconnect}`);

        if (statusCode === DisconnectReason.loggedOut) {
          console.warn('[AxaBOT] Sesi telah logout. Membersihkan auth_session secara bersih...');
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
          } catch (wipeErr) {
            console.error('[AxaBOT] Gagal membersihkan folder sesi:', wipeErr.message);
          }
          currentQRRaw = null;
          currentQRDataUrl = null;
          connectedUser = null;
          setTimeout(startWASocket, 3000);
        } else if (shouldReconnect) {
          reconnectAttempts++;
          const backoffDelay = Math.min(reconnectAttempts * 2000, 30000);
          console.log(`[AxaBOT] Menjadwalkan reconnect #${reconnectAttempts} dalam ${backoffDelay}ms...`);
          setTimeout(startWASocket, backoffDelay);
        }
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
    setTimeout(startWASocket, 5000);
  }
}

/**
 * GET / : Health Check & Uptime Info
 */
app.get('/', (req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);
  res.json({
    engine: 'Axa Xyz WhatsApp Financial Microservice',
    version: '3.6.2',
    status: 'ONLINE',
    uptimeSeconds,
    connectionStatus,
    connectedNumber: connectedUser ? connectedUser.id.split(':')[0] : null,
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
      qrImage: null
    });
  }

  if (currentQRDataUrl) {
    const wantsHtml = req.query.view === 'html' || (req.headers.accept && req.headers.accept.includes('text/html'));
    if (wantsHtml) {
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

    return res.json({
      success: true,
      status: 'Scanning_QR',
      sessionStatus: 'Disconnected',
      qrImage: currentQRDataUrl,
      rawQR: currentQRRaw
    });
  }

  return res.json({
    success: false,
    status: connectionStatus,
    sessionStatus: connectionStatus,
    message: 'Kode QR belum siap atau sedang diinisialisasi. Silakan refresh beberapa detik lagi.',
    qrImage: null
  });
});

/**
 * POST /restart : Restart socket Baileys secara bersih (Terproteksi Token)
 */
app.post('/restart', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();

  if (token !== API_SECRET_TOKEN && req.body.token !== API_SECRET_TOKEN && req.query.token !== API_SECRET_TOKEN) {
    return res.status(403).json({ success: false, message: 'Unauthorized: Token API tidak valid.' });
  }

  console.log('[AxaBOT] Manual restart socket Baileys dipicu via API.');
  if (waSocket) {
    try {
      waSocket.end(new Error('Manual API restart'));
    } catch (e) {
      console.warn('[AxaBOT] Peringatan saat menutup socket:', e.message);
    }
  }

  setTimeout(startWASocket, 2000);
  return res.json({ success: true, message: 'Instance Baileys berhasil di-restart.' });
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
    console.warn('[AxaBOT CRON] GAS_WEBAPP_URL belum diatur. Gagal mengambil daftar klien aktif.');
    return;
  }

  try {
    const response = await axios.get(GAS_WEBAPP_URL, {
      params: { action: 'getReminderClients', token: API_SECRET_TOKEN },
      timeout: 10000
    });

    const clients = response.data?.clients || [];
    console.log(`[AxaBOT CRON] Menemukan ${clients.length} klien untuk pengingat kas harian.`);

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

      // Jeda acak anti-spam 3 hingga 5 detik per klien
      const randomJitter = Math.floor(Math.random() * 2000) + 3000;
      await delay(randomJitter);
    }
  } catch (cronErr) {
    console.error('[AxaBOT CRON] Kesalahan saat eksekusi cron pengingat harian:', cronErr.message);
  }
}, {
  timezone: 'Asia/Jakarta'
});

server.listen(PORT, () => {
  console.log(`[AxaBOT Engine] Server berjalan aktif pada port ${PORT}`);
  console.log(`[AxaBOT Engine] Inisialisasi sesi WhatsApp Baileys di direktori: ${AUTH_DIR}...`);
  startWASocket();
});