/**
 * ====================================================================
 * AXA XYZ MESSAGE HANDLER & FINANCIAL AI ENGINE
 * Author      : Axa Xyz Engineering (by Zettbos)
 * Environment : Railway / Node.js 18+ / CommonJS
 * File        : messageHandler.js
 * ====================================================================
 */

const { downloadMediaMessage, delay } = require('@whiskeysockets/baileys');
const axios = require('axios');

// Konfigurasi Model Google AI Studio (Model utama gemini-3.6-flash)
const DEFAULT_GEMINI_MODEL = process.env.DEFAULT_GEMINI_MODEL || 'gemini-3.6-flash';
const FALLBACK_GEMINI_MODEL = process.env.FALLBACK_GEMINI_MODEL || 'gemini-3.1-flash-lite';
let cachedApiKey = (process.env.GEMINI_API_KEY || '').trim();
const GAS_WEBAPP_URL = (process.env.GAS_WEBAPP_URL || '').trim();

// Urutan Cascade Model AI Studio: Otomatis failover jika 429 atau timeout
const GEMINI_MODELS_CASCADE = [
  DEFAULT_GEMINI_MODEL,
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.7-flash',
  'gemini-3-flash'
];

// In-Memory cache untuk Fitur Quick Undo Transaksi (Masa aktif: 5 menit)
const undoCache = new Map();
const UNDO_EXPIRATION_MS = 5 * 60 * 1000;

// Kamus Normalisasi Tag Dompet Multi-Payment
const WALLET_MAP = {
  'TUNAI': 'Tunai',
  'CASH': 'Tunai',
  'BCA': 'BCA',
  'MANDIRI': 'Mandiri',
  'BRI': 'BRI',
  'BNI': 'BNI',
  'BSI': 'BSI',
  'CIMB': 'CIMB',
  'JAGO': 'Bank Jago',
  'SEABANK': 'SeaBank',
  'GOPAY': 'GoPay',
  'OVO': 'OVO',
  'DANA': 'DANA',
  'SPAY': 'ShopeePay',
  'SHOPEEPAY': 'ShopeePay',
  'LINKAJA': 'LinkAja'
};

/**
 * Mengambil Kunci API Gemini Aktif (Environment Railway atau fallback ke Google Sheet GAS)
 */
async function getEffectiveApiKey() {
  if (cachedApiKey && cachedApiKey.length > 10) {
    return cachedApiKey;
  }

  // Fallback: Ambil API Key yang tersimpan di sheet Settings via endpoint GAS
  if (GAS_WEBAPP_URL) {
    try {
      const res = await axios.post(GAS_WEBAPP_URL, {
        action: 'getAllSettings',
        currentUser: { role: 'Admin', username: 'Bot_Sync' }
      }, {
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        timeout: 8000
      });

      if (res.data && res.data.settings) {
        for (const s of res.data.settings) {
          if (s.key === 'GEMINI_API_KEY' && s.value && !s.value.includes('SAMPLE_')) {
            cachedApiKey = s.value.trim();
            console.log('[AxaBOT] API Key Gemini berhasil disinkronkan dari Google Sheets.');
            return cachedApiKey;
          }
        }
      }
    } catch (e) {
      console.warn('[AxaBOT] Gagal mengambil fallback API Key dari GAS:', e.message);
    }
  }

  return cachedApiKey;
}

/**
 * Penanganan Pesan Masuk WhatsApp (Abaikan Grup Secara Mutlak)
 */
async function handleIncomingMessages(sock, chatUpdate) {
  if (chatUpdate.type !== 'notify') return;

  for (const msg of chatUpdate.messages) {
    if (!msg.message) continue;
    if (msg.key.fromMe) continue;

    const remoteJid = msg.key.remoteJid;

    // ====================================================================
    // FILTER ANTI-GRUP & BROADCAST MUTLAK:
    // Abaikan seluruh pesan grup (@g.us), pesan berstatus participant, story, & broadcast
    // ====================================================================
    if (
      !remoteJid ||
      remoteJid.endsWith('@g.us') ||
      remoteJid.endsWith('@broadcast') ||
      remoteJid.includes('status@broadcast') ||
      Boolean(msg.key.participant)
    ) {
      continue;
    }

    const pushName = msg.pushName || 'Pengguna';
    const messageType = Object.keys(msg.message)[0];
    let textContent = '';

    if (messageType === 'conversation') {
      textContent = msg.message.conversation;
    } else if (messageType === 'extendedTextMessage') {
      textContent = msg.message.extendedTextMessage.text;
    } else if (messageType === 'imageMessage') {
      textContent = msg.message.imageMessage.caption || '';
    }

    textContent = (textContent || '').trim();

    // Penanganan Pesan Berupa Media Gambar Struk Belanja (Khusus Chat Pribadi)
    if (messageType === 'imageMessage') {
      await simulateTyping(sock, remoteJid);
      await handleImageReceipt(sock, remoteJid, msg, textContent, pushName);
      continue;
    }

    if (!textContent) continue;

    const lowerText = textContent.toLowerCase();

    // Command: Bantuan / Menu
    if (lowerText === '!help' || lowerText === '!menu') {
      await simulateTyping(sock, remoteJid);
      await sendHelpMenu(sock, remoteJid);
      continue;
    }

    // Command: Diagnostic Test Gemini API
    if (lowerText === '!test' || lowerText === '!ping') {
      await simulateTyping(sock, remoteJid);
      await handleTestGeminiApi(sock, remoteJid);
      continue;
    }

    // Command: Tanya Gemini AI Lengkap (!tanya <pertanyaan> atau !ask <pertanyaan>)
    if (lowerText.startsWith('!tanya ') || lowerText.startsWith('!ask ')) {
      const userPrompt = textContent.replace(/^!(tanya|ask)\s+/i, '').trim();
      if (!userPrompt) {
        await sock.sendMessage(remoteJid, {
          text: '💡 *Format Perintah Tanya AI:*\nKetik *!tanya [pertanyaan Anda]*\n\n_Contoh:_ `!tanya Bagaimana cara membuat pencatatan arus kas harian toko agar rapi?`'
        });
        continue;
      }
      await simulateTyping(sock, remoteJid);
      await handleAiComprehensiveQuestion(sock, remoteJid, userPrompt);
      continue;
    }

    // Command: Cek Saldo Multi-Dompet
    if (lowerText === '!saldo') {
      await simulateTyping(sock, remoteJid);
      await handleCheckBalance(sock, remoteJid);
      continue;
    }

    // Command: Unduh Laporan PDF
    if (lowerText === '!rekap') {
      await simulateTyping(sock, remoteJid);
      await handleReportLink(sock, remoteJid);
      continue;
    }

    // Command: Batalkan Transaksi Terakhir (Quick Undo)
    if (lowerText === '!batal' || lowerText === '!undo') {
      await simulateTyping(sock, remoteJid);
      await handleQuickUndo(sock, remoteJid);
      continue;
    }

    // Parsing Format Transaksi Keuangan Teks
    const parsedTrx = parseFinancialText(textContent);
    if (parsedTrx) {
      await simulateTyping(sock, remoteJid);
      await handleSaveFinancialText(sock, remoteJid, parsedTrx, pushName);
      continue;
    }

    // Jika pesan merupakan pertanyaan umum seputar keuangan, arahkan ke Asisten AI
    if (isFinancialQuestion(textContent)) {
      await simulateTyping(sock, remoteJid);
      await handleAiFinancialAdvice(sock, remoteJid, textContent);
      continue;
    }
  }
}

async function simulateTyping(sock, jid) {
  try {
    await sock.sendPresenceUpdate('composing', jid);
    const jitter = Math.floor(Math.random() * 1500) + 1000;
    await delay(jitter);
    await sock.sendPresenceUpdate('paused', jid);
  } catch (presenceErr) {
    // Non-fatal
  }
}

/**
 * Uji Diagnostik Koneksi Google AI Studio (!test)
 */
async function handleTestGeminiApi(sock, remoteJid) {
  const startTime = Date.now();
  const apiKey = await getEffectiveApiKey();

  if (!apiKey) {
    return sock.sendMessage(remoteJid, {
      text:
        '❌ *Koneksi Gemini AI Gagal!*\n\n' +
        '• *Status:* `API Key Tidak Ditemukan`\n' +
        '• *Solusi:* Tambahkan variabel `GEMINI_API_KEY` di dashboard Railway atau masukkan di tab Settings Google Sheet.'
    });
  }

  const maskedKey = apiKey.length > 8 ? `${apiKey.substring(0, 6)}...${apiKey.substring(apiKey.length - 4)}` : 'Terdaftar';

  try {
    // URL REST API bersih tanpa tag Markdown
    const testEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(DEFAULT_GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const response = await axios.post(
      testEndpoint,
      {
        contents: [
          {
            parts: [
              { text: 'Ping test. Jawab tepat 3 kata: SISTEM AXA AKTIF' }
            ]
          }
        ]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        timeout: 15000
      }
    );

    const latencyMs = Date.now() - startTime;
    const botReply = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'OK';

    const testSummary =
      `🧪 *Hasil Uji Koneksi Google AI Studio*\n\n` +
      `• *Status:* *TERHUBUNG & ONLINE* ✅\n` +
      `• *Model AI Utama:* \`${DEFAULT_GEMINI_MODEL}\`\n` +
      `• *Respon Model:* "${botReply}"\n` +
      `• *Latensi API:* \`${latencyMs} ms\`\n` +
      `• *Kunci API:* \`${maskedKey}\`\n` +
      `• *Fitur OCR & Tanya AI:* *SIAP DIGUNAKAN* 🚀`;

    await sock.sendMessage(remoteJid, { text: testSummary });
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const errorDetails = err.response?.data?.error?.message || err.message;
    const httpStatus = err.response?.status || 'N/A';

    console.error('[AxaBOT Test API Error]', errorDetails);

    const failSummary =
      `❌ *Uji Koneksi Gemini API Gagal!*\n\n` +
      `• *Model Target:* \`${DEFAULT_GEMINI_MODEL}\`\n` +
      `• *HTTP Status:* \`${httpStatus}\`\n` +
      `• *Pesan Error:* \`${errorDetails}\`\n` +
      `• *Kunci API Terdeteksi:* \`${maskedKey}\`\n` +
      `• *Waktu Pengujian:* \`${latencyMs} ms\`\n\n` +
      `💡 _Pastikan kuota API Key aktif di Google AI Studio dan format model didukung._`;

    await sock.sendMessage(remoteJid, { text: failSummary });
  }
}

/**
 * Konsultasi Finansial & Tanya Jawab Komprehensif (!tanya <pertanyaan>)
 */
async function handleAiComprehensiveQuestion(sock, remoteJid, userQuestion) {
  const apiKey = await getEffectiveApiKey();

  if (!apiKey) {
    return sock.sendMessage(remoteJid, {
      text: '⚠️ *Kunci API Gemini belum dikonfigurasi di server.* Hubungi Administrator.'
    });
  }

  try {
    await sock.sendMessage(remoteJid, { text: '🧠 *AxaBOT sedang merumuskan analisa keuangan untuk Anda...*' });

    const prompt =
      'Kamu adalah AxaBOT, konsultan keuangan bisnis, kasir, dan akuntansi cerdas untuk UMKM Axa Xyz. ' +
      'Berikan penjelasan yang mendalam, terstruktur, berbasis angka/langkah konkret, ramah, dan mudah dipahami oleh pemilik usaha atas pertanyaan berikut:\n\n' +
      userQuestion;

    let responseText = null;
    let modelUsed = DEFAULT_GEMINI_MODEL;
    let lastError = null;

    for (const model of GEMINI_MODELS_CASCADE) {
      try {
        // Endpoint REST API murni tanpa formatting Markdown
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

        const response = await axios.post(
          endpoint,
          {
            contents: [{ parts: [{ text: prompt }] }]
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': apiKey
            },
            timeout: 25000
          }
        );

        if (response.status === 200 && response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
          responseText = response.data.candidates[0].content.parts[0].text;
          modelUsed = model;
          break;
        }
      } catch (err) {
        lastError = err;
        console.warn(`[AxaBOT Tanya AI] Model ${model} gagal: ${err.message}. Mencoba model berikutnya...`);
      }
    }

    if (!responseText) {
      throw new Error(lastError?.response?.data?.error?.message || lastError?.message || 'Gagal memproses jawaban AI');
    }

    const finalAnswer =
      `🤖 *Jawaban AxaBOT Financial AI:*\n\n` +
      `${responseText.trim()}\n\n` +
      `────────────────────────\n` +
      `💡 _Model Engine: \`${modelUsed}\`_`;

    await sock.sendMessage(remoteJid, { text: finalAnswer });
  } catch (err) {
    console.error('[AxaBOT Tanya AI Error]', err.message);
    await sock.sendMessage(remoteJid, {
      text: `❌ *Gagal menjawab pertanyaan:* ${err.message}\nSilakan coba beberapa saat lagi atau gunakan perintah *!test* untuk cek status server.`
    });
  }
}

function parseFinancialText(text) {
  if (!text || text.startsWith('!')) return null;

  let wallet = 'Tunai';
  const walletTagMatch = text.match(/#([a-zA-Z0-9_]+)/);
  if (walletTagMatch) {
    const rawTag = walletTagMatch[1].toUpperCase();
    wallet = WALLET_MAP[rawTag] || rawTag;
  }

  let workingText = text.replace(/#[a-zA-Z0-9_]+/g, '').trim();

  let type = 'Pengeluaran';
  const isIncomePrefix = workingText.startsWith('+');
  const lowerText = workingText.toLowerCase();

  const incomeKeywords = [
    'gaji', 'bonus', 'omset', 'terima', 'transfer dari', 'pelanggan',
    'pemasukan', 'laba', 'untung', 'piutang cair', 'penjualan'
  ];
  const hasIncomeKeyword = incomeKeywords.some((kw) => lowerText.includes(kw));

  if (isIncomePrefix || hasIncomeKeyword) {
    type = 'Pemasukan';
  }

  workingText = workingText.replace(/^[+\-]\s*/, '').trim();

  const amountRegex = /(\d+(?:[.,]\d+)?)\s*(k|rb|jt|ribu|juta)?/i;
  const match = workingText.match(amountRegex);

  if (!match) return null;

  const rawNumber = parseFloat(match[1].replace(',', '.'));
  const unit = (match[2] || '').toLowerCase();
  let multiplier = 1;

  if (unit === 'k' || unit === 'rb' || unit === 'ribu') {
    multiplier = 1000;
  } else if (unit === 'jt' || unit === 'juta') {
    multiplier = 1000000;
  }

  const amount = Math.round(rawNumber * multiplier);
  if (isNaN(amount) || amount <= 0) return null;

  let description = workingText.replace(match[0], '').trim();
  description = description.replace(/^(\s*untuk|\s*beli|\s*bayar|\s*dari)\s*/i, '').trim();
  if (!description) {
    description = type === 'Pemasukan' ? 'Pemasukan Kas' : 'Pengeluaran Umum';
  }

  let category = 'Operasional';
  const descLower = description.toLowerCase();
  if (type === 'Pemasukan') {
    category = 'Penjualan / Pendapatan';
  } else if (descLower.includes('kopi') || descLower.includes('makan') || descLower.includes('snack') || descLower.includes('beras') || descLower.includes('minum')) {
    category = 'Konsumsi';
  } else if (descLower.includes('bensin') || descLower.includes('tol') || descLower.includes('parkir') || descLower.includes('ojol') || descLower.includes('solar')) {
    category = 'Transportasi';
  } else if (descLower.includes('listrik') || descLower.includes('pdam') || descLower.includes('wifi') || descLower.includes('pulsa') || descLower.includes('internet')) {
    category = 'Utilitas';
  } else if (descLower.includes('stok') || descLower.includes('bahan') || descLower.includes('kulakan') || descLower.includes('suplai')) {
    category = 'Bahan Baku';
  } else if (descLower.includes('gaji') || descLower.includes('bonus') || descLower.includes('upah')) {
    category = 'Gaji & Karyawan';
  }

  return {
    type,
    amount,
    category,
    wallet,
    description: capitalizeFirst(description)
  };
}

async function handleSaveFinancialText(sock, remoteJid, parsedTrx, pushName) {
  const trxId = `TRX-${getFormattedDateId()}-${Math.floor(1000 + Math.random() * 9000)}`;
  const nowStr = formatFullDate(new Date());

  const payload = {
    action: 'recordTransaction',
    trxId,
    senderNumber: remoteJid.split('@')[0],
    senderName: pushName,
    date: nowStr.split(' ')[0],
    type: parsedTrx.type,
    category: parsedTrx.category,
    merchant: parsedTrx.description,
    amount: parsedTrx.amount,
    wallet: parsedTrx.wallet,
    note: `Input via WhatsApp Chat (#${parsedTrx.wallet})`
  };

  // Sinkronisasi data ke Google Sheets
  await syncToGAS(payload);

  // Daftarkan transaksi ke memori Undo (5 menit)
  undoCache.set(remoteJid, {
    trxId,
    amount: parsedTrx.amount,
    type: parsedTrx.type,
    category: parsedTrx.category,
    wallet: parsedTrx.wallet,
    description: parsedTrx.description,
    timestamp: Date.now()
  });

  const emoji = parsedTrx.type === 'Pemasukan' ? '📈' : '🧾';
  const replyMessage =
    `✅ *Transaksi Berhasil Dicatat!* ${emoji}\n\n` +
    `• *ID Trx:* \`${trxId}\`\n` +
    `• *Jenis:* ${parsedTrx.type}\n` +
    `• *Keterangan:* ${parsedTrx.description}\n` +
    `• *Nominal:* *Rp ${parsedTrx.amount.toLocaleString('id-ID')}*\n` +
    `• *Dompet:* *${parsedTrx.wallet}*\n` +
    `• *Kategori:* ${parsedTrx.category}\n` +
    `• *Waktu:* ${nowStr} WIB\n\n` +
    `💡 _Ketik *!batal* dalam 5 menit jika ada kesalahan input._`;

  await sock.sendMessage(remoteJid, { text: replyMessage });
}

async function handleImageReceipt(sock, remoteJid, msg, caption, pushName) {
  try {
    await sock.sendMessage(remoteJid, { text: '⏳ *Sedang memindai nota belanja dengan Gemini 3.6 Flash...*' });

    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    const base64Data = buffer.toString('base64');
    const mimeType = msg.message.imageMessage.mimetype || 'image/jpeg';

    let wallet = 'Tunai';
    const tagMatch = caption.match(/#([a-zA-Z0-9_]+)/);
    if (tagMatch) {
      const rawTag = tagMatch[1].toUpperCase();
      wallet = WALLET_MAP[rawTag] || rawTag;
    }

    const ocrResult = await callGeminiOCRWithFallback(base64Data, mimeType);

    const trxId = `TRX-${getFormattedDateId()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const nowStr = formatFullDate(new Date());

    const amount = Number(ocrResult.amount) || 0;
    const merchant = ocrResult.merchant || 'Struk Belanja Toko';
    const category = ocrResult.category || 'Operasional';
    const note = ocrResult.note || 'Struk hasil ekstraksi Gemini OCR';

    const payload = {
      action: 'recordTransaction',
      trxId,
      senderNumber: remoteJid.split('@')[0],
      senderName: pushName,
      date: ocrResult.date || nowStr.split(' ')[0],
      type: 'Pengeluaran',
      category,
      merchant,
      amount,
      wallet,
      note: `${note} (#${wallet})`,
      imageBase64: base64Data,
      mimeType
    };

    // Sinkronisasi data struk langsung ke Google Apps Script (Sheet Financial_Trx & Google Drive)
    await syncToGAS(payload);

    undoCache.set(remoteJid, {
      trxId,
      amount,
      type: 'Pengeluaran',
      category,
      wallet,
      description: merchant,
      timestamp: Date.now()
    });

    const replyMsg =
      `🧾 *Nota Belanja Berhasil Dipindai AI!*\n\n` +
      `• *ID Trx:* \`${trxId}\`\n` +
      `• *Merchant:* *${merchant}*\n` +
      `• *Tanggal Nota:* ${ocrResult.date || nowStr.split(' ')[0]}\n` +
      `• *Total Belanja:* *Rp ${amount.toLocaleString('id-ID')}*\n` +
      `• *Metode Bayar:* *${wallet}*\n` +
      `• *Kategori:* ${category}\n` +
      `• *Ringkasan:* ${note}\n` +
      `• *Engine AI:* \`${ocrResult.modelUsed}\`\n\n` +
      `💡 _Ketik *!batal* dalam 5 menit untuk membatalkan transaksi ini._`;

    await sock.sendMessage(remoteJid, { text: replyMsg });

  } catch (ocrErr) {
    console.error('[AxaBOT OCR Error]', ocrErr.message);
    await sock.sendMessage(remoteJid, {
      text: `❌ *Gagal memindai nota:* ${ocrErr.message}\nSilakan ketik *!test* untuk cek koneksi AI, atau input manual: _Beli barang 50k #tunai_`
    });
  }
}

async function callGeminiOCRWithFallback(base64Image, mimeType) {
  const apiKey = await getEffectiveApiKey();

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY belum dikonfigurasi pada environment Railway.');
  }

  const prompt =
    'Analisis foto bukti struk belanja ini secara presisi dan objektif. ' +
    'Balas HANYA dalam format JSON valid tanpa tanda pembungkus markdown: ' +
    '{"merchant": "nama toko", "date": "dd/MM/yyyy", "amount": 0, "category": "Kategori Pengeluaran (Bahan Baku/Operasional/Transport/Konsumsi/Lainnya)", "note": "ringkasan item singkat"}';

  let lastError = null;

  for (const model of GEMINI_MODELS_CASCADE) {
    try {
      console.log(`[AxaBOT] Mengirim request Gemini OCR menggunakan model: ${model}`);

      // URL murni tanpa karakter markdown link yang memicu "Invalid URL"
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

      const requestBody = {
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType,
                  data: base64Image
                }
              }
            ]
          }
        ],
        generationConfig: {
          responseMimeType: 'application/json'
        }
      };

      const response = await axios.post(endpoint, requestBody, {
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        timeout: 28000
      });

      if (response.status === 200 && response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        const textResp = response.data.candidates[0].content.parts[0].text;
        const cleanedJson = textResp.replace(/```json/gi, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleanedJson);
        parsed.modelUsed = model;
        return parsed;
      }
    } catch (err) {
      console.warn(`[AxaBOT Failover] Model ${model} gagal (${err.response?.status || err.message}). Mencoba model cadangan berikutnya...`);
      lastError = err;
    }
  }

  throw new Error(`Semua model Gemini gagal merespon: ${lastError?.response?.data?.error?.message || lastError?.message || 'Network Timeout'}`);
}

async function handleAiFinancialAdvice(sock, remoteJid, userQuestion) {
  const apiKey = await getEffectiveApiKey();
  if (!apiKey) return;

  try {
    const prompt =
      'Kamu adalah AxaBOT, konsultan finansial pintar untuk bisnis UMKM Axa Xyz. ' +
      'Berikan jawaban singkat, praktis, ramah, dan solutif (maksimal 3 paragraf) untuk pertanyaan pemilik toko berikut:\n\n' +
      userQuestion;

    // URL murni yang valid
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(DEFAULT_GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const response = await axios.post(endpoint, {
      contents: [{ parts: [{ text: prompt }] }]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      timeout: 15000
    });

    const reply = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (reply) {
      await sock.sendMessage(remoteJid, {
        text: `🤖 *AxaBOT Financial AI:*\n\n${reply.trim()}`
      });
    }
  } catch (aiErr) {
    // Non-blocking fallback
  }
}

function isFinancialQuestion(text) {
  const lower = text.toLowerCase();
  const qWords = ['tips', 'bagaimana cara', 'berapa rasio', 'saran keuangan', 'strategi kas', 'kelola omset'];
  return qWords.some((w) => lower.includes(w)) || (lower.endsWith('?') && lower.length > 15);
}

async function handleQuickUndo(sock, remoteJid) {
  const cached = undoCache.get(remoteJid);

  if (!cached) {
    return sock.sendMessage(remoteJid, {
      text: '⚠️ *Tidak ada transaksi yang dapat dibatalkan.* Transaksi mungkin sudah lewat dari 5 menit atau belum ada transaksi baru yang dicatat.'
    });
  }

  const elapsed = Date.now() - cached.timestamp;
  if (elapsed > UNDO_EXPIRATION_MS) {
    undoCache.delete(remoteJid);
    return sock.sendMessage(remoteJid, {
      text: '⌛ *Batas waktu pembatalan kilat (5 menit) telah kedaluwarsa.* Silakan kelola langsung melalui Dashboard Web Portal Axa Xyz.'
    });
  }

  undoCache.delete(remoteJid);

  await syncToGAS({
    action: 'cancelTransaction',
    trxId: cached.trxId
  });

  const replyText =
    `🗑️ *Transaksi Berhasil Dibatalkan! (Undo)*\n\n` +
    `• *ID Trx:* \`${cached.trxId}\`\n` +
    `• *Keterangan:* ${cached.description}\n` +
    `• *Nominal Dibatalkan:* Rp ${cached.amount.toLocaleString('id-ID')}\n` +
    `• *Dompet:* ${cached.wallet}\n` +
    `• *Status Sistem:* DIBATALKAN / VOID\n\n` +
    `Saldo buku kas Anda telah disesuaikan kembali.`;

  await sock.sendMessage(remoteJid, { text: replyText });
}

async function handleCheckBalance(sock, remoteJid) {
  try {
    if (!GAS_WEBAPP_URL) {
      return sock.sendMessage(remoteJid, { text: '⚠️ Endpoint Google Sheet belum dikonfigurasi di server Railway.' });
    }

    const response = await axios.get(GAS_WEBAPP_URL, {
      params: { action: 'getBalanceSummary', senderNumber: remoteJid.split('@')[0] },
      timeout: 10000
    });

    const data = response.data || {};
    const totalInflow = Number(data.totalInflow) || 0;
    const totalOutflow = Number(data.totalOutflow) || 0;
    const netBalance = totalInflow - totalOutflow;

    let walletDetails = '';
    if (data.wallets && typeof data.wallets === 'object') {
      walletDetails = '\n*Rincian Saldo Per Dompet:*\n';
      for (const [wName, wBal] of Object.entries(data.wallets)) {
        walletDetails += `• ${wName}: Rp ${Number(wBal).toLocaleString('id-ID')}\n`;
      }
    }

    const reply =
      `📊 *Ringkasan Saldo Buku Kas*\n\n` +
      `• *Total Pemasukan:* Rp ${totalInflow.toLocaleString('id-ID')}\n` +
      `• *Total Pengeluaran:* Rp ${totalOutflow.toLocaleString('id-ID')}\n` +
      `• -------------------------------\n` +
      `• *Saldo Kas Bersih:* *Rp ${netBalance.toLocaleString('id-ID')}*\n` +
      walletDetails +
      `\nKetik *!rekap* untuk mengunduh laporan PDF resmi.`;

    await sock.sendMessage(remoteJid, { text: reply });
  } catch (err) {
    await sock.sendMessage(remoteJid, {
      text: '⚠️ Gagal mengambil ringkasan saldo dari spreadsheet cloud. Silakan coba beberapa saat lagi.'
    });
  }
}

async function handleReportLink(sock, remoteJid) {
  try {
    if (!GAS_WEBAPP_URL) {
      return sock.sendMessage(remoteJid, { text: '⚠️ Endpoint Google Sheet belum dikonfigurasi di server.' });
    }

    const reportUrl = `${GAS_WEBAPP_URL}?action=viewReportPDF&senderNumber=${remoteJid.split('@')[0]}`;
    const reply =
      `📄 *Unduh Laporan Rekap Keuangan*\n\n` +
      `Silakan klik tautan berikut untuk mengunduh berkas laporan format PDF:\n` +
      `🔗 ${reportUrl}\n\n` +
      `_Tautan diterbitkan otomatis dan terintegrasi dengan Google Drive Axa Xyz._`;

    await sock.sendMessage(remoteJid, { text: reply });
  } catch (err) {
    await sock.sendMessage(remoteJid, { text: '⚠️ Gagal memproses tautan laporan.' });
  }
}

async function sendHelpMenu(sock, remoteJid) {
  const guide =
    `🤖 *Panduan Bot Keuangan Axa Xyz*\n\n` +
    `Catat arus kas instan langsung dari obrolan WhatsApp:\n\n` +
    `*1. Format Pengeluaran:*\n` +
    `• _Beli kopi 25k #bca_\n` +
    `• _Makan siang 35000 #tunai_\n` +
    `• _-50000 bensin #mandiri_\n\n` +
    `*2. Format Pemasukan:*\n` +
    `• _+500000 bonus project #jago_\n` +
    `• _Gaji 5000000 #bca_\n` +
    `• _Terima transfer 150000 #gopay_\n\n` +
    `*3. Foto Struk Belanja:*\n` +
    `• Kirim foto struk/nota dengan caption tag dompet (misal: _#bca_). AI Gemini 3.6 Flash akan membaca total dan nama toko otomatis!\n\n` +
    `*4. Perintah Cepat & AI:*\n` +
    `• *!test*   : Tes diagnostik koneksi Gemini AI & latensi\n` +
    `• *!tanya*  : Konsultasi finansial mendalam (*!tanya <soal>*)\n` +
    `• *!saldo*  : Cek ringkasan kas & rincian dompet\n` +
    `• *!rekap*  : Unduh berkas laporan PDF resmi\n` +
    `• *!batal*  : Batalkan transaksi terakhir (< 5 menit)\n` +
    `• *!menu*   : Tampilkan menu panduan ini`;

  await sock.sendMessage(remoteJid, { text: guide });
}

/**
 * Sinkronisasi HTTP ke Google Apps Script dengan Log Transparan
 */
async function syncToGAS(payload) {
  if (!GAS_WEBAPP_URL) {
    console.warn('[AxaBOT GAS Sync] Variable GAS_WEBAPP_URL belum dikonfigurasi di Railway.');
    return;
  }
  try {
    const res = await axios.post(GAS_WEBAPP_URL, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 20000
    });
    console.log(`[AxaBOT GAS Sync Success] Action: ${payload.action} | Status:`, res.data);
  } catch (syncErr) {
    console.error('[AxaBOT GAS Sync Error]', syncErr.response ? syncErr.response.data : syncErr.message);
  }
}

function getFormattedDateId() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function formatFullDate(d) {
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  return `${day}/${month}/${year} ${hours}:${mins}`;
}

function capitalizeFirst(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

module.exports = {
  handleIncomingMessages
};
