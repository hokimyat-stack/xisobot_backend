require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));


// AI ovozli savollar uchun audio yuklash (xotirada, diskka yozilmaydi)
const aiAudioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^audio\//i.test(file.mimetype || '') || /\.(webm|wav|mp3|m4a|ogg|mp4)$/i.test(file.originalname || '');
    cb(ok ? null : new Error("Faqat audio fayl yuborish mumkin"), ok);
  }
});

// 1. BAZA VA XOTIRAGA ULANISH
// (Eslatma: Yangi mustaqil SaaS loyiha bo'lgani uchun eski legacy bazalardan foydalanilmaydi)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// 2. YORDAMCHI FUNKSIYALAR
// PAROL_SALT ning eski qiymati fallback sifatida SAQLANADI.
// Shu sabab bazadagi mavjud admin/xodim parollari buzilmaydi.
const PAROL_SALT = process.env.PAROL_SALT || 'meningMaxfiyTuzim2026Xzy';

// Backward compatibility: eski superadmin kaliti ham ishlashda davom etadi.
const LEGACY_SUPERADMIN_KEY = '9XvQ2pL8zR';
const SUPERADMIN_KEY = process.env.SUPERADMIN_KEY || LEGACY_SUPERADMIN_KEY;

function parolHash(parol) {
  return crypto.createHash('sha256').update(String(parol || '') + PAROL_SALT).digest('hex');
}

function genId(prefix) {
  return prefix + Date.now().toString().slice(-6) + Math.floor(Math.random() * 1000).toString().padStart(3, '0');
}

function tasodifiyKalit(prefix) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let res = prefix + '-';
  for (let i = 0; i < 16; i++) res += chars.charAt(Math.floor(Math.random() * chars.length));
  return res;
}

function ruxsatlarniParse(qiymat) {
  if (!qiymat) return [];
  if (Array.isArray(qiymat)) return qiymat.map(String).map(x => x.trim()).filter(Boolean);

  const text = String(qiymat).trim();
  if (!text) return [];

  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(String).map(x => x.trim()).filter(Boolean);
    } catch (_) {}
  }

  return text.split(',').map(x => x.trim()).filter(Boolean);
}

function ruxsatlarniSaqlashFormat(qiymat) {
  return ruxsatlarniParse(qiymat).join(',');
}

function tashkentBugun() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tashkent',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function sanaQosh(isoDate, days = 0) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
  return dt.toISOString().slice(0, 10);
}

function normalizeUzbek(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[ʻ‘’`´]/g, "'")
    .replace(/o'/g, 'o')
    .replace(/g'/g, 'g')
    .replace(/[^a-z0-9а-яёқғҳў\s-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


// ====================================================
// HISOBCHI AI — SOZLAMA, O'ZBEKCHA OVOZ MATNI VA AUDIO
// ====================================================
const AI_CONFIG_KEY = 'AI_ASSISTANT_CONFIG';
const AI_DEFAULT_CONFIG = Object.freeze({
  ism: 'Hisobchi',
  uygotishSozi: 'Hisobchi',
  uygotishFaol: true,
  ovoz: 'Kore',
  nutqTezligi: 1.08,
  avtomatikOvoz: true,
  ovozKutishSekund: 20,
  savollar: [
    "Bugungi holat qanday?",
    "Bugun nechta xodim hisobot topshirdi?",
    "Bugun nechta xodim hisobot topshirmadi?",
    "Bajarilish darajasi necha foiz?",
    "Qaysi tashkilotga birinchi navbatda e'tibor berish kerak?",
    "Bugun rahbar sifatida qaysi 3 ta amaliy ishni qilishim kerak?"
  ]
});

const AI_TTS_VOICES = new Set(['Zephyr','Puck','Charon','Kore','Fenrir','Leda','Orus','Aoede','Callirrhoe','Autonoe','Enceladus','Iapetus','Umbriel','Algieba','Despina','Erinome','Algenib','Rasalgethi','Laomedeia','Achernar','Alnilam','Schedar','Gacrux','Pulcherrima','Achird','Zubenelgenubi','Vindemiatrix','Sadachbia','Sadaltager','Sulafat']);

function aiConfigTozalash(raw = {}) {
  let savollar = raw.savollar;
  if (typeof savollar === 'string') {
    try { savollar = JSON.parse(savollar); } catch (_) { savollar = savollar.split(/\r?\n/); }
  }
  if (!Array.isArray(savollar)) savollar = AI_DEFAULT_CONFIG.savollar;
  savollar = savollar.map(x => String(x || '').trim()).filter(Boolean).slice(0, 30);

  const ism = String(raw.ism || AI_DEFAULT_CONFIG.ism).trim().slice(0, 40) || AI_DEFAULT_CONFIG.ism;
  const uygotishSozi = String(raw.uygotishSozi || ism).trim().slice(0, 40) || ism;
  const ovoz = AI_TTS_VOICES.has(String(raw.ovoz || '').trim()) ? String(raw.ovoz).trim() : AI_DEFAULT_CONFIG.ovoz;
  const avtomatikOvoz = raw.avtomatikOvoz === false || raw.avtomatikOvoz === 'false' ? false : true;
  const uygotishFaol = raw.uygotishFaol === false || raw.uygotishFaol === 'false' ? false : true;
  const nutqTezligiRaw = Number(raw.nutqTezligi ?? AI_DEFAULT_CONFIG.nutqTezligi);
  const nutqTezligi = Math.max(0.85, Math.min(1.30, Number.isFinite(nutqTezligiRaw) ? nutqTezligiRaw : 1.08));
  const timeoutRaw = Number(raw.ovozKutishSekund ?? AI_DEFAULT_CONFIG.ovozKutishSekund);
  const ovozKutishSekund = Math.max(5, Math.min(120, Number.isFinite(timeoutRaw) ? Math.round(timeoutRaw) : 20));
  return { ism, uygotishSozi, uygotishFaol, ovoz, nutqTezligi, avtomatikOvoz, ovozKutishSekund, savollar };
}

let aiConfigCache = { qiymat: null, vaqt: 0 };
function aiConfigCacheTozala() { aiConfigCache = { qiymat: null, vaqt: 0 }; }
async function aiConfigOl(force = false) {
  const now = Date.now();
  if (!force && aiConfigCache.qiymat && now - aiConfigCache.vaqt < 60_000) return aiConfigCache.qiymat;
  try {
    const { data, error } = await supabase.from('sozlamalar').select('qiymat').eq('kalit', AI_CONFIG_KEY).maybeSingle();
    if (error) throw error;
    let qiymat;
    if (!data?.qiymat) qiymat = aiConfigTozalash(AI_DEFAULT_CONFIG);
    else {
      const raw = typeof data.qiymat === 'string' ? JSON.parse(data.qiymat) : data.qiymat;
      qiymat = aiConfigTozalash(raw);
    }
    aiConfigCache = { qiymat, vaqt: now };
    return qiymat;
  } catch (err) {
    console.error('AI sozlama o\'qish xatosi:', err.message);
    const qiymat = aiConfigTozalash(AI_DEFAULT_CONFIG);
    aiConfigCache = { qiymat, vaqt: now };
    return qiymat;
  }
}

function uzBirlik(n) {
  return ['', 'bir', 'ikki', 'uch', "to'rt", 'besh', 'olti', 'yetti', 'sakkiz', "to'qqiz"][n] || '';
}
function uzOnlik(n) {
  return ['', "o'n", 'yigirma', "o'ttiz", 'qirq', 'ellik', 'oltmish', 'yetmish', 'sakson', "to'qson"][n] || '';
}
function uzUchXona(n) {
  n = Math.floor(Math.abs(Number(n) || 0));
  const parts = [];
  const yuz = Math.floor(n / 100);
  const qoldiq = n % 100;
  if (yuz) parts.push((yuz === 1 ? 'bir' : uzBirlik(yuz)) + ' yuz');
  const on = Math.floor(qoldiq / 10);
  const bir = qoldiq % 10;
  if (on) parts.push(uzOnlik(on));
  if (bir) parts.push(uzBirlik(bir));
  return parts.join(' ');
}
function uzRaqamSoz(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return String(n);
  if (!Number.isInteger(n)) {
    const [a,b=''] = String(n).split('.');
    return `${uzRaqamSoz(Number(a))} butun ${b.split('').map(d => uzBirlik(Number(d)) || 'nol').join(' ')}`;
  }
  if (n === 0) return 'nol';
  if (n < 0) return 'minus ' + uzRaqamSoz(-n);
  const birliklar = [
    [1_000_000_000, 'milliard'],
    [1_000_000, 'million'],
    [1_000, 'ming']
  ];
  const parts = [];
  let q = n;
  for (const [scale, nom] of birliklar) {
    if (q >= scale) {
      const miq = Math.floor(q / scale);
      parts.push(`${uzRaqamSoz(miq)} ${nom}`);
      q %= scale;
    }
  }
  if (q) parts.push(uzUchXona(q));
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
function uzTartibSoz(n) {
  const cardinal = uzRaqamSoz(n);
  const words = cardinal.split(' ');
  const last = words.pop() || '';
  const map = {
    'bir':'birinchi','ikki':'ikkinchi','uch':'uchinchi',"to'rt":"to'rtinchi",'besh':'beshinchi','olti':'oltinchi','yetti':'yettinchi','sakkiz':'sakkizinchi',"to'qqiz":"to'qqizinchi",
    "o'n":"o'ninchi",'yigirma':'yigirmanchi',"o'ttiz":"o'ttizinchi",'qirq':'qirqinchi','ellik':'elliginchi','oltmish':'oltmishinchi','yetmish':'yetmishinchi','sakson':'saksoninchi',"to'qson":"to'qsoninchi",
    'yuz':'yuzinchi','ming':'minginchi','million':'millioninchi','milliard':'milliardinchi'
  };
  words.push(map[last] || (last + 'inchi'));
  return words.join(' ');
}

function speechTextTayyorla(matn) {
  let t = String(matn || '').trim();
  if (!t) return '';
  const oylar = ['yanvar','fevral','mart','aprel','may','iyun','iyul','avgust','sentabr','oktabr','noyabr','dekabr'];

  // Markdown va ovoz uchun keraksiz belgilarni olib tashlaymiz.
  t = t.replace(/[*_#`~]/g, '').replace(/[•]/g, ', ');

  // Sana: 2026-08-17 -> ikki ming yigirma oltinchi yil, o'n yettinchi avgust
  t = t.replace(/\b(20\d{2})-(\d{2})-(\d{2})\b/g, (_m, y, mo, d) => {
    const oy = oylar[Math.max(0, Math.min(11, Number(mo) - 1))];
    return `${uzTartibSoz(Number(y))} yil, ${uzTartibSoz(Number(d))} ${oy}`;
  });
  // Soat: 09:30
  t = t.replace(/\b(?:soat\s*)?([01]?\d|2[0-3]):([0-5]\d)\b/gi, (_m, h, min) => {
    const mm = Number(min);
    return mm === 0 ? `soat ${uzRaqamSoz(Number(h))}` : `soat ${uzRaqamSoz(Number(h))}-u ${uzRaqamSoz(mm)}`;
  });
  // Foizni raqamdan oldin alohida qayta ishlaymiz.
  t = t.replace(/\b(\d+(?:[.,]\d+)?)\s*%/g, (_m, n) => `${uzRaqamSoz(Number(String(n).replace(',', '.')))} foiz`);

  // Tizimdagi ko'p ishlatiladigan qisqartmalar.
  t = t
    .replace(/\bJSHSHIR\b/gi, "jismoniy shaxsning shaxsiy identifikatsiya raqami")
    .replace(/\bPINFL\b/gi, "jismoniy shaxsning shaxsiy identifikatsiya raqami")
    .replace(/\bMFY\b/g, "mahalla fuqarolar yig'ini")
    .replace(/\bAI\b/gi, "sun'iy intellekt")
    .replace(/\bGPS\b/gi, "ji pi es")
    .replace(/\bkategoriya\b/gi, "toifa")
    .replace(/\bmonitoring\b/gi, "kuzatuv")
    .replace(/\bstatus\b/gi, "holat");

  // Qolgan butun raqamlar.
  t = t.replace(/\b\d+\b/g, m => uzRaqamSoz(Number(m)));
  return t.replace(/\s+/g, ' ').replace(/\s+([,.;!?])/g, '$1').trim();
}

function aiTTSInstructions(ism) {
  return [
    `Siz ${ism || 'Hisobchi'} nomli o'zbekcha sun'iy intellekt yordamchisining ovozisiz.`,
    "Matnni O'zbekiston adabiy o'zbek tilida, lotin yozuvidagi so'zlarni aniq va ravon talaffuz qiling.",
    "Ohang professional, xotirjam, ishonchli va tabiiy bo'lsin.",
    "Raqamlar, foizlar va sanalarni shoshmasdan, tushunarli ayting.",
    "Juda tez gapirmang; qisqa gaplar orasida tabiiy pauza qiling.",
    "Matnga yangi fakt qo'shmang va matn mazmunini o'zgartirmang."
  ].join(' ');
}

function tokenStem(token) {
  let t = normalizeUzbek(token);
  if (t.length > 6 && t.endsWith('lari')) t = t.slice(0, -4);
  else if (t.length > 5 && t.endsWith('lar')) t = t.slice(0, -3);
  if (t.length > 5 && t.endsWith('si')) t = t.slice(0, -2);
  if (t.length > 6 && t.endsWith('ning')) t = t.slice(0, -4);
  return t;
}

function entityMatch(savol, list) {
  const q = normalizeUzbek(savol);
  const qTokens = q.split(' ').map(tokenStem).filter(Boolean);
  let best = null;
  let bestScore = 0;

  for (const item of (list || [])) {
    const nom = normalizeUzbek(item?.nomi);
    if (!nom) continue;

    if (q.includes(nom)) {
      const score = 1000 + nom.length;
      if (score > bestScore) { bestScore = score; best = item; }
      continue;
    }

    const tokens = nom.split(' ').map(tokenStem).filter(t => t.length >= 2);
    if (!tokens.length) continue;

    let mos = 0;
    for (const token of tokens) {
      if (qTokens.some(qt => qt === token || (qt.length >= 4 && token.startsWith(qt)) || (token.length >= 4 && qt.startsWith(token)))) mos++;
    }

    const score = (mos / tokens.length) * 100;
    if (score > bestScore) { bestScore = score; best = item; }
  }

  return bestScore >= 55 ? best : null;
}

function savoldanSanaOl(savol) {
  const raw = String(savol || '');
  const q = normalizeUzbek(raw);

  if (q.includes('kecha')) return sanaQosh(tashkentBugun(), -1);

  let m = raw.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (m) return m[0];

  m = raw.match(/\b(\d{1,2})[.\/-](\d{1,2})[.\/-](20\d{2})\b/);
  if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;

  return tashkentBugun();
}

async function r2RasmYukla(base64Data, folder = 'reports') {
  if (!base64Data) return null;
  const buffer = Buffer.from(base64Data, 'base64');
  const fileName = `${folder}/${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;
  
  await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: fileName,
    Body: buffer,
    ContentType: 'image/jpeg',
  }));

  return `${process.env.R2_PUBLIC_URL}/${fileName}`;
}

async function checkAuth(req) {
  try {
    const kalit = req.method === 'GET' ? req.query?.kalit : req.body?.kalit;
    if (!kalit) return null;

    // Eski va yangi superadmin kaliti bir vaqtda qo'llanadi.
    if (kalit === LEGACY_SUPERADMIN_KEY || kalit === SUPERADMIN_KEY) {
      return {
        id: 'superadmin',
        rol: 'superadmin',
        fio: 'Superadmin',
        mfyId: '',
        ruxsatlar: [
          'xodim_qosh', 'xodim_tahrir', 'xodim_blok', 'eslatma_yuborish',
          'mfy_boshqar', 'kategoriya_boshqar', 'excel_export', 'sozlamalar'
        ]
      };
    }

    const { data, error } = await supabase
      .from('adminlar')
      .select('*')
      .eq('kalit', kalit)
      .maybeSingle();

    if (error) {
      console.error('AUTH SUPABASE XATOSI:', error.message);
      return null;
    }

    if (data && data.holat === 'faol') {
      return {
        id: data.id,
        rol: data.rol,
        fio: data.fio,
        mfyId: data.mfy_id,
        ruxsatlar: ruxsatlarniParse(data.ruxsatlar)
      };
    }

    return null;
  } catch (err) {
    console.error('checkAuth xatosi:', err);
    return null;
  }
}


async function auditLog(kim, amal, tafsilot = '') {
  try {
    await supabase.from('audit_log').insert([{ 
      vaqt: new Date().toISOString(), 
      kim: kim || 'Noma\'lum', 
      amal: amal, 
      tafsilot: String(tafsilot || '') 
    }]);
  } catch(e) {
    console.error('AuditLog xatosi:', e.message);
  }
}

// ----------------------------------------------------
// PUSH-BILDIRISHNOMA (EXPO PUSH API)
// ----------------------------------------------------
async function sendExpoPush(tokens, title, body, extraData = {}) {
  // Faqat yaroqli Expo tokenlarini ajratib olish
  const validTokens = (tokens || []).filter(t => t && String(t).startsWith('ExponentPushToken'));
  if (validTokens.length === 0) return 0;

  const messages = validTokens.map(token => ({
    to: token,
    sound: 'default',
    title: title,
    body: body,
    data: extraData,
  }));

  try {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });
    
    if(!response.ok) {
        console.error("Push API xatosi:", await response.text());
    }
    return validTokens.length;
  } catch (err) {
    console.error("Push jo'natish tarmog'ida xato:", err);
    return 0;
  }
}

// Bosh sahifa salomlashuv
app.get('/', (req, res) => {
  res.send('🚀 SysOne Kunlik Hisobot API Serveri muvaffaqiyatli ishlamoqda!');
});

// ====================================================
// 3. ADMIN PANEL API'LARI
// ====================================================
app.post('/api/admin-login', async (req, res) => {
  try {
    const { login, parol } = req.body;
    const { data: admin, error } = await supabase.from('adminlar').select('*').eq('login', login).single();

    if (error || !admin) return res.json({ ok: false, xato: "Login yoki parol noto'g'ri" });
    if (admin.holat !== 'faol') return res.json({ ok: false, xato: "Hisob bloklangan" });
    if (admin.parol_hash !== parolHash(parol)) return res.json({ ok: false, xato: "Login yoki parol noto'g'ri" });

    await auditLog(admin.fio, 'ADMIN_LOGIN', admin.rol);
    res.json({
      ok: true,
      admin: {
        fio: admin.fio,
        rol: admin.rol,
        mfyId: admin.mfy_id,
        ruxsatlar: ruxsatlarniParse(admin.ruxsatlar),
        kalit: admin.kalit
      }
    });
  } catch (err) {
    res.json({ ok: false, xato: err.message });
  }
});

app.get('/api/ping', async (req, res) => {
  const user = await checkAuth(req);
  if (!user) return res.json({ ok: false, xato: "Kalit xato" });
  res.json({ ok: true, rol: user.rol, fio: user.fio, mfyId: user.mfyId, ruxsatlar: user.ruxsatlar });
});

app.get('/api/mfylar', async (req, res) => {
  try {
    const { data, error } = await supabase.from('mfy').select('*').order('nomi', { ascending: true });
    if (error) return res.json({ ok: false, xato: error.message, mfylar: [] });
    const mfylar = (data || []).map(d => ({ id: d.id, nomi: d.nomi, rahbar: d.rahbar, tel: d.tel }));
    res.json({ ok: true, mfylar });
  } catch (err) {
    res.json({ ok: false, xato: err.message, mfylar: [] });
  }
});

app.get('/api/kategoriyalar', async (req, res) => {
  try {
    const { data, error } = await supabase.from('kategoriyalar').select('*').order('nomi', { ascending: true });
    if (error) return res.json({ ok: false, xato: error.message, kategoriyalar: [] });
    const kategoriyalar = (data || []).map(d => ({ id: d.id, nomi: d.nomi, tavsif: d.tavsif }));
    res.json({ ok: true, kategoriyalar });
  } catch (err) {
    res.json({ ok: false, xato: err.message, kategoriyalar: [] });
  }
});

app.get('/api/xodimlar', async (req, res) => {
  const user = await checkAuth(req);
  if (!user) return res.json({ ok: false, xato: "Ruxsat yo'q" });

  try {
    const [resXodim, resMfy, resKat] = await Promise.all([
      supabase.from('xodimlar').select('*').order('fio', { ascending: true }),
      supabase.from('mfy').select('id, nomi'),
      supabase.from('kategoriyalar').select('id, nomi')
    ]);

    let xodimlarList = resXodim.data || [];
    const mfyMap = (resMfy.data || []).reduce((acc, m) => ({ ...acc, [m.id]: m.nomi }), {});
    const katMap = (resKat.data || []).reduce((acc, k) => ({ ...acc, [k.id]: k.nomi }), {});

    const xodimlar = xodimlarList.map(x => ({
      id: x.id,
      fio: x.fio,
      pinfl: x.pinfl,
      tel: x.tel,
      mfyId: x.mfy_id,
      mfyNomi: mfyMap[x.mfy_id] || '',
      kategoriyaId: x.kategoriya_id,
      kategoriyaNomi: katMap[x.kategoriya_id] || '',
      holat: x.holat,
      ish_holati: x.ish_holati || 'ishda',
      deviceBor: !!x.device_id,
      unread: 0,
      soni: 0
    }));

    res.json({ ok: true, xodimlar });
  } catch (err) {
    res.json({ ok: false, xato: err.message });
  }
});

app.get('/api/adminlar', async (req, res) => {
  const user = await checkAuth(req);
  if (!user) return res.status(401).json({ ok: false, xato: "Ruxsat yo'q" });
  if (user.rol !== 'superadmin') return res.status(403).json({ ok: false, xato: "Adminlar ro'yxatini ko'rish uchun ruxsat yo'q" });
  const { data, error } = await supabase.from('adminlar').select('*');
  if (error) return res.json({ ok: false, xato: error.message });
  const adminlar = (data || []).map(a => ({
    id: a.id, fio: a.fio, login: a.login, rol: a.rol, mfyId: a.mfy_id, 
    ruxsatlar: ruxsatlarniParse(a.ruxsatlar), kalit: a.kalit, holat: a.holat
  }));
  res.json({ ok: true, adminlar });
});

app.get('/api/auditlar', async (req, res) => {
  const { data } = await supabase.from('audit_log').select('*').order('vaqt', { ascending: false }).limit(300);
  const audit = (data || []).map(a => ({
    vaqt: new Date(a.vaqt).toLocaleString('uz-UZ'), kim: a.kim, amal: a.amal, tafsilot: a.tafsilot
  }));
  res.json({ ok: true, audit });
});

// CRUD AMALLARI
app.post('/api/xodimQosh', async (req, res) => {
  const u = await checkAuth(req); if (!u) return res.json({ ok: false, xato: "Ruxsat yo'q" });
  const { fio, pinfl, parol, tel, mfyId, kategoriyaId, ishHolati } = req.body;
  const id = genId('X');
  const { error } = await supabase.from('xodimlar').insert([{
    id, fio, pinfl, parol_hash: parolHash(parol || '1234'), tel: tel || '', mfy_id: mfyId || null, 
    kategoriya_id: kategoriyaId || null, holat: 'faol', ish_holati: ishHolati || 'ishda'
  }]);
  if (error) return res.json({ ok: false, xato: error.message });
  await auditLog(u.fio, 'XODIM_QOSHILDI', `${id} - ${fio}`);
  dashboardFastCacheTozala();
  res.json({ ok: true, id });
});

app.post('/api/xodimTahrir', async (req, res) => {
  const u = await checkAuth(req); if (!u) return res.json({ ok: false, xato: "Ruxsat yo'q" });
  const { xodimId, fio, pinfl, parol, tel, mfyId, kategoriyaId, holat, ishHolati } = req.body;
  let updateData = {};
  if (fio) updateData.fio = fio;
  if (pinfl !== undefined) updateData.pinfl = pinfl;
  if (parol) updateData.parol_hash = parolHash(parol);
  if (tel !== undefined) updateData.tel = tel;
  if (mfyId !== undefined) updateData.mfy_id = mfyId || null;
  if (kategoriyaId !== undefined) updateData.kategoriya_id = kategoriyaId || null;
  if (holat) updateData.holat = holat;
  if (ishHolati) updateData.ish_holati = ishHolati;
  
  const { error } = await supabase.from('xodimlar').update(updateData).eq('id', xodimId);
  if (error) return res.json({ ok: false, xato: error.message });
  await auditLog(u.fio, 'XODIM_TAHRIR', xodimId);
  dashboardFastCacheTozala();
  res.json({ ok: true });
});

app.post('/api/deviceReset', async (req, res) => {
  const u = await checkAuth(req); if (!u) return res.json({ ok: false, xato: "Ruxsat yo'q" });
  await supabase.from('xodimlar').update({ device_id: null }).eq('id', req.body.xodimId);
  await auditLog(u.fio, 'DEVICE_RESET', req.body.xodimId);
  res.json({ ok: true });
});

app.post('/api/mfyQosh', async (req, res) => {
  const u = await checkAuth(req); if (!u) return res.json({ ok: false, xato: "Ruxsat yo'q" });
  const id = genId('M');
  const { error } = await supabase.from('mfy').insert([{ id, nomi: req.body.nomi, rahbar: req.body.rahbar || '', tel: req.body.tel || '' }]);
  if (error) return res.json({ ok: false, xato: error.message });
  await auditLog(u.fio, 'MFY_QOSHILDI', req.body.nomi);
  dashboardFastCacheTozala();
  aiDirectoryCache.vaqt = 0;
  res.json({ ok: true, id });
});

app.post('/api/mfyTahrir', async (req, res) => {
  const u = await checkAuth(req); if (!u) return res.json({ ok: false, xato: "Ruxsat yo'q" });
  const { error } = await supabase.from('mfy').update({ nomi: req.body.nomi, rahbar: req.body.rahbar, tel: req.body.tel }).eq('id', req.body.mfyId);
  if (error) return res.json({ ok: false, xato: error.message });
  await auditLog(u.fio, 'MFY_TAHRIR', req.body.mfyId);
  dashboardFastCacheTozala();
  aiDirectoryCache.vaqt = 0;
  res.json({ ok: true });
});

app.post('/api/mfyOchir', async (req, res) => {
  const u = await checkAuth(req); if (!u) return res.json({ ok: false, xato: "Ruxsat yo'q" });
  const { error } = await supabase.from('mfy').delete().eq('id', req.body.mfyId);
  if (error) return res.json({ ok: false, xato: error.message });
  await auditLog(u.fio, 'MFY_OCHIRILDI', req.body.mfyId);
  dashboardFastCacheTozala();
  aiDirectoryCache.vaqt = 0;
  res.json({ ok: true });
});

app.post('/api/kategoriyaQosh', async (req, res) => {
  const u = await checkAuth(req); if (!u) return res.json({ ok: false, xato: "Ruxsat yo'q" });
  const id = genId('K');
  const { error } = await supabase.from('kategoriyalar').insert([{ id, nomi: req.body.nomi, tavsif: req.body.tavsif || '' }]);
  if (error) return res.json({ ok: false, xato: error.message });
  await auditLog(u.fio, 'KATEGORIYA_QOSHILDI', req.body.nomi);
  dashboardFastCacheTozala();
  aiDirectoryCache.vaqt = 0;
  res.json({ ok: true, id });
});

app.post('/api/kategoriyaTahrir', async (req, res) => {
  const u = await checkAuth(req); if (!u) return res.json({ ok: false, xato: "Ruxsat yo'q" });
  const { error } = await supabase.from('kategoriyalar').update({ nomi: req.body.nomi, tavsif: req.body.tavsif }).eq('id', req.body.kategoriyaId);
  if (error) return res.json({ ok: false, xato: error.message });
  await auditLog(u.fio, 'KATEGORIYA_TAHRIR', req.body.kategoriyaId);
  dashboardFastCacheTozala();
  aiDirectoryCache.vaqt = 0;
  res.json({ ok: true });
});

app.post('/api/kategoriyaOchir', async (req, res) => {
  const u = await checkAuth(req); if (!u) return res.json({ ok: false, xato: "Ruxsat yo'q" });
  const { error } = await supabase.from('kategoriyalar').delete().eq('id', req.body.kategoriyaId);
  if (error) return res.json({ ok: false, xato: error.message });
  await auditLog(u.fio, 'KATEGORIYA_OCHIRILDI', req.body.kategoriyaId);
  dashboardFastCacheTozala();
  aiDirectoryCache.vaqt = 0;
  res.json({ ok: true });
});

app.post('/api/adminQosh', async (req, res) => {
  const u = await checkAuth(req); if (!u || u.rol !== 'superadmin') return res.json({ ok: false, xato: "Ruxsat yo'q" });
  const { fio, login, parol, rol, mfyId, ruxsatlar } = req.body;
  const id = genId('A');
  const kalit = tasodifiyKalit(rol === 'admin' ? 'ADM' : 'NZR');
  const { error } = await supabase.from('adminlar').insert([{
    id, fio, login, parol_hash: parolHash(parol), rol, mfy_id: mfyId || null,
    ruxsatlar: ruxsatlarniSaqlashFormat(ruxsatlar), kalit, holat: 'faol'
  }]);
  if (error) return res.json({ ok: false, xato: error.message });
  await auditLog(u.fio, 'ADMIN_QOSHILDI', login);
  res.json({ ok: true });
});

app.post('/api/adminTahrir', async (req, res) => {
  const u = await checkAuth(req); if (!u) return res.json({ ok: false, xato: "Ruxsat yo'q" });
  const { adminId, fio, login, rol, mfyId, holat, parol, ruxsatlar } = req.body;
  const updateData = {};
  if (fio !== undefined) updateData.fio = fio;
  if (login !== undefined) updateData.login = login;
  if (rol !== undefined) updateData.rol = rol;
  if (mfyId !== undefined) updateData.mfy_id = mfyId || null;
  if (holat !== undefined) updateData.holat = holat;
  if (parol) updateData.parol_hash = parolHash(parol);
  if (ruxsatlar !== undefined) updateData.ruxsatlar = ruxsatlarniSaqlashFormat(ruxsatlar);

  const { error } = await supabase.from('adminlar').update(updateData).eq('id', adminId);
  if (error) return res.json({ ok: false, xato: error.message });
  await auditLog(u.fio, 'ADMIN_TAHRIR', adminId);
  res.json({ ok: true });
});

app.post('/api/adminParolTiklash', async (req, res) => {
  const u = await checkAuth(req); if (!u) return res.json({ ok: false, xato: "Ruxsat yo'q" });
  const { error } = await supabase.from('adminlar').update({ parol_hash: parolHash(req.body.yangiParol) }).eq('id', req.body.adminId);
  if (error) return res.json({ ok: false, xato: error.message });
  await auditLog(u.fio, 'ADMIN_PAROL_TIKLASH', req.body.adminId);
  res.json({ ok: true });
});

app.post('/api/adminOchir', async (req, res) => {
  const u = await checkAuth(req); if (!u || u.rol !== 'superadmin') return res.json({ ok: false, xato: "Ruxsat yo'q" });
  const { error } = await supabase.from('adminlar').delete().eq('id', req.body.adminId);
  if (error) return res.json({ ok: false, xato: error.message });
  await auditLog(u.fio, 'ADMIN_OCHIRILDI', req.body.adminId);
  res.json({ ok: true });
});

// Eslatmani Haqiqiy Push qilib yuborish
app.post('/api/eslatmaYuborGuruh', async (req, res) => {
  const u = await checkAuth(req); if (!u) return res.json({ ok: false, xato: "Ruxsat yo'q" });
  
  try {
    const { xodimIdlar, matn } = req.body;
    if (!xodimIdlar || xodimIdlar.length === 0) return res.json({ ok: false, xato: "Xodimlar tanlanmadi" });

    // Bazadan tanlangan xodimlarning Push Token (device_id) larini olish
    const { data: xodimlar } = await supabase
      .from('xodimlar')
      .select('device_id')
      .in('id', xodimIdlar);

    const tokens = (xodimlar || []).map(x => x.device_id).filter(Boolean);
    const yuborildi = await sendExpoPush(tokens, 'SysOne: Yangi Eslatma', matn, { turi: 'eslatma' });

    await auditLog(u.fio, 'ESLATMA_GURUH', `${yuborildi} ta qurilmaga yuborildi. Matn: ${matn}`);
    res.json({ ok: true, yuborildi: yuborildi });
  } catch (err) {
    res.json({ ok: false, xato: err.message });
  }
});

// ====================================================
// 4. VAZIFALAR MODULI (TASK MANAGEMENT)
// ====================================================
app.post('/api/vazifaQosh', async (req, res) => {
  const u = await checkAuth(req); if (!u) return res.json({ ok: false, xato: "Ruxsat yo'q" });
  try {
    const { xodimId, matn, muddat } = req.body;
    const id = genId('V');
    const sana = tashkentBugun();
    
    // Xodim ma'lumotlarini olish
    const { data: x } = await supabase.from('xodimlar').select('fio, device_id').eq('id', xodimId).single();
    if(!x) return res.json({ok: false, xato: "Xodim topilmadi"});

    const { error } = await supabase.from('vazifalar').insert([{
      id, xodim_id: xodimId, xodim_fio: x.fio, matn, muddat: muddat || null, holat: 'kutilmoqda', sana
    }]);

    if (error) return res.json({ok: false, xato: error.message});

    // Yangi vazifa bo'yicha Xodimga PUSH jo'natish
    if (x.device_id) {
      await sendExpoPush([x.device_id], 'Yangi Vazifa Biriktirildi', matn, { turi: 'vazifa', id });
    }

    await auditLog(u.fio, 'VAZIFA_QOSHILDI', `${x.fio} ga: ${matn}`);
    res.json({ok: true, id});
  } catch (err) {
    res.json({ok: false, xato: err.message});
  }
});

app.get('/api/vazifalar', async (req, res) => {
  const u = await checkAuth(req); if (!u) return res.json({ ok: false, xato: "Ruxsat yo'q" });
  try {
    let query = supabase.from('vazifalar').select('*').order('sana', { ascending: false });
    // Nazoratchi faqat o'z MFYsidagi vazifalarni ko'rishi uchun filter qo'shish mumkin
    // Ammo hozircha bazaviy barcha vazifalarni qaytaramiz (frontenda filtr qilinadi)
    const { data, error } = await query;
    if (error) return res.json({ok: false, xato: error.message});
    res.json({ok: true, vazifalar: data});
  } catch (err) {
    res.json({ok: false, xato: err.message});
  }
});

app.post('/api/vazifaOchir', async (req, res) => {
  const u = await checkAuth(req); if (!u) return res.json({ ok: false, xato: "Ruxsat yo'q" });
  const { error } = await supabase.from('vazifalar').delete().eq('id', req.body.vazifaId);
  if (error) return res.json({ ok: false, xato: error.message });
  await auditLog(u.fio, 'VAZIFA_OCHIRILDI', req.body.vazifaId);
  res.json({ ok: true });
});


// SOZLAMALAR VA BILDIRISHNOMALAR
app.get('/api/sozlamaOl', async (req, res) => {
  const { data } = await supabase.from('sozlamalar').select('*').eq('kalit', 'INTERVAL_DAQIQA').single();
  res.json({ ok: true, interval: data ? data.qiymat : 1 });
});

app.post('/api/sozlamaSaqla', async (req, res) => {
  const u = await checkAuth(req); if (!u) return res.json({ ok: false, xato: "Ruxsat yo'q" });
  await supabase.from('sozlamalar').upsert([{ kalit: 'INTERVAL_DAQIQA', qiymat: req.body.interval }]);
  await auditLog(u.fio, 'SOZLAMA_O_ZGARTIRILDI', `Interval: ${req.body.interval}`);
  res.json({ ok: true });
});

app.get('/api/bildirishnomaSozlama', async (req, res) => {
  const { data } = await supabase.from('sozlamalar').select('*').eq('kalit', 'BILDIRISHNOMA').single();
  res.json({ ok: true, sozlama: data ? JSON.parse(data.qiymat) : { matn: 'Hisobotni yuklashni unutmang!', interval: 60 } });
});

app.post('/api/bildirishnomaSozla', async (req, res) => {
  const u = await checkAuth(req); if (!u) return res.json({ ok: false, xato: "Ruxsat yo'q" });
  await supabase.from('sozlamalar').upsert([{ kalit: 'BILDIRISHNOMA', qiymat: JSON.stringify(req.body) }]);
  await auditLog(u.fio, 'BILDIRISHNOMA_SOZLANDI', req.body.matn);
  res.json({ ok: true });
});

// ====================================================
// 5. MOBIL ILOVA VA HISOBOT API'LARI
// ====================================================
app.post('/api/xodim-login', async (req, res) => {
  try {
    const { pinfl, parol, deviceId } = req.body;
    const { data: xodim, error } = await supabase.from('xodimlar').select('*').eq('pinfl', pinfl).single();

    if (error || !xodim) return res.json({ ok: false, xato: "PINFL yoki parol noto'g'ri" });
    if (xodim.holat !== 'faol') return res.json({ ok: false, xato: "Hisob bloklangan" });
    if (xodim.parol_hash !== parolHash(parol)) return res.json({ ok: false, xato: "PINFL yoki parol noto'g'ri" });

    // Qurilma yangilanishi va Tokenni saqlash (Push yuborish uchun)
    if (xodim.device_id && xodim.device_id !== deviceId) {
      // return res.json({ ok: false, xato: "Bu hisob boshqa qurilmaga bog'langan!" });
      // Ruxsat berish yoki bloklash o'zgartirilishi mumkin. Hozircha token o'zgarsa saqlaymiz:
      await supabase.from('xodimlar').update({ device_id: deviceId }).eq('id', xodim.id);
    } else if (!xodim.device_id && deviceId) {
      await supabase.from('xodimlar').update({ device_id: deviceId }).eq('id', xodim.id);
    }

    res.json({ ok: true, xodim: { id: xodim.id, fio: xodim.fio, mfyId: xodim.mfy_id, kategoriyaId: xodim.kategoriya_id } });
  } catch (err) {
    res.json({ ok: false, xato: err.message });
  }
});

// Ilovaga vazifalarni yuborish
app.get('/api/vazifalarim', async (req, res) => {
  try {
    const { xodimId } = req.query;
    if (!xodimId) return res.json({ok: false, xato: "Xodim ID yo'q"});
    
    const { data, error } = await supabase
      .from('vazifalar')
      .select('*')
      .eq('xodim_id', xodimId)
      .order('sana', { ascending: false });

    if (error) return res.json({ok: false, xato: error.message});
    res.json({ok: true, vazifalar: data});
  } catch (err) {
    res.json({ok: false, xato: err.message});
  }
});

app.get('/api/hisobotlar', async (req, res) => {
  try {
    let query = supabase.from('hisobotlar').select('*').order('b_vaqt', { ascending: false });
    if (req.query.xodim) query = query.eq('xodim_id', req.query.xodim);
    if (req.query.dan) query = query.gte('sana', req.query.dan);
    if (req.query.gacha) query = query.lte('sana', req.query.gacha);

    const { data, error } = await query;
    if (error) return res.json({ ok: false, xato: error.message, hisobotlar: [] });

    const hisobotlar = (data || []).map(h => ({
      id: h.id, xodimId: h.xodim_id, xodimFio: h.xodim_fio,
      mfyId: h.mfy_id, mfyNomi: h.mfy_nomi,
      kategoriyaId: h.kategoriya_id, kategoriyaNomi: h.kategoriya_nomi,
      ishTuri: h.ish_turi, ishNomi: h.ish_nomi,
      b_vaqt: h.b_vaqt, b_tavsif: h.b_tavsif, b_lat: h.b_lat, b_lng: h.b_lng, 
      b_rasmlar: h.b_rasmlar ? h.b_rasmlar.split(',') : [],
      d_vaqt: h.d_vaqt, d_tavsif: h.d_tavsif, d_lat: h.d_lat, d_lng: h.d_lng, 
      d_rasmlar: h.d_rasmlar ? h.d_rasmlar.split(',') : [],
      y_vaqt: h.y_vaqt, y_tavsif: h.y_tavsif, y_lat: h.y_lat, y_lng: h.y_lng, 
      y_rasmlar: h.y_rasmlar ? h.y_rasmlar.split(',') : [],
      reyting: h.reyting, kechikkan: h.kechikkan, sana: h.sana, haftaKuni: h.hafta_kuni,
      flagSabab: h.flag_sabab, bosqich: h.bosqich || 'BOSHLANDI',
      vazifaId: h.vazifa_id // Agar u vazifa orqali qilingan bo'lsa
    }));

    res.json({ ok: true, hisobotlar });
  } catch (err) {
    res.json({ ok: false, xato: err.message, hisobotlar: [] });
  }
});

// HISOBOT BOSHLASH (1 va 3 bosqichli)
app.post('/api/hisobotBoshla', async (req, res) => {
  try {
    const { xodimId, ishTuri, ishNomi, tavsif, lat, lng, rasmlar, deviceVaqt, isBirBosqichli, vazifaId } = req.body;
    
    const { data: x } = await supabase.from('xodimlar').select('fio, mfy_id, kategoriya_id').eq('id', xodimId).single();
    const { data: m } = await supabase.from('mfy').select('nomi').eq('id', x?.mfy_id).single();
    const { data: k } = await supabase.from('kategoriyalar').select('nomi').eq('id', x?.kategoriya_id).single();

    let yuklanganRasmlar = [];
    for (let rB64 of (rasmlar || [])) {
      const url = await r2RasmYukla(rB64);
      if (url) yuklanganRasmlar.push(url);
    }

    const id = genId('H');
    const sana = tashkentBugun();
    const vaqt = deviceVaqt || new Date().toISOString();
    const rasmlarStr = yuklanganRasmlar.join(',');

    const bosqich = isBirBosqichli ? 'YAKUNLANDI' : 'BOSHLANDI';

    const insertData = {
      id, xodim_id: xodimId, xodim_fio: x?.fio || '',
      mfy_id: x?.mfy_id || null, mfy_nomi: m?.nomi || '',
      kategoriya_id: x?.kategoriya_id || null, kategoriya_nomi: k?.nomi || '',
      ish_turi: ishTuri, ish_nomi: ishNomi,
      b_vaqt: vaqt, b_tavsif: tavsif,
      b_lat: lat, b_lng: lng, b_rasmlar: rasmlarStr,
      bosqich: bosqich, sana, reyting: 'YASHIL',
      vazifa_id: vazifaId || null
    };

    if (isBirBosqichli) {
      insertData.y_vaqt = vaqt;
      insertData.y_tavsif = tavsif;
      insertData.y_lat = lat;
      insertData.y_lng = lng;
      insertData.y_rasmlar = rasmlarStr;
    }

    const { error } = await supabase.from('hisobotlar').insert([insertData]);
    if (error) return res.json({ ok: false, xato: error.message });

    // Agar hisobot bitta vazifaga ulangan bo'lsa va u YAKUNLANGAN bo'lsa, vazifani statusini o'zgartiramiz
    if (vazifaId && isBirBosqichli) {
      await supabase.from('vazifalar').update({ holat: 'bajarildi' }).eq('id', vazifaId);
    }

    dashboardFastCacheTozala();
    res.json({ ok: true, id });
  } catch (err) {
    res.json({ ok: false, xato: err.message });
  }
});

app.post('/api/hisobotDavom', async (req, res) => {
  try {
    const { hisobotId, tavsif, lat, lng, rasmlar, deviceVaqt } = req.body;
    let yuklanganRasmlar = [];
    for (let rB64 of (rasmlar || [])) {
      const url = await r2RasmYukla(rB64);
      if (url) yuklanganRasmlar.push(url);
    }

    const { error } = await supabase.from('hisobotlar').update({
      d_vaqt: deviceVaqt || new Date().toISOString(), d_tavsif: tavsif,
      d_lat: lat, d_lng: lng, d_rasmlar: yuklanganRasmlar.join(','),
      bosqich: 'DAVOM_ETMOQDA'
    }).eq('id', hisobotId);

    if (error) return res.json({ ok: false, xato: error.message });
    dashboardFastCacheTozala();
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, xato: err.message });
  }
});

app.post('/api/hisobotYakun', async (req, res) => {
  try {
    const { hisobotId, tavsif, lat, lng, rasmlar, deviceVaqt, vazifaId } = req.body;
    let yuklanganRasmlar = [];
    for (let rB64 of (rasmlar || [])) {
      const url = await r2RasmYukla(rB64);
      if (url) yuklanganRasmlar.push(url);
    }

    const { error } = await supabase.from('hisobotlar').update({
      y_vaqt: deviceVaqt || new Date().toISOString(), y_tavsif: tavsif,
      y_lat: lat, y_lng: lng, y_rasmlar: yuklanganRasmlar.join(','),
      bosqich: 'YAKUNLANDI'
    }).eq('id', hisobotId);

    if (error) return res.json({ ok: false, xato: error.message });

    // Agar hisobot vazifa asosida ochilgan bo'lsa, uni bajarildi deb belgilaymiz
    if (vazifaId) {
      await supabase.from('vazifalar').update({ holat: 'bajarildi' }).eq('id', vazifaId);
    }

    dashboardFastCacheTozala();
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, xato: err.message });
  }
});

app.post('/api/xodimParolAlmashtir', async (req, res) => {
  try {
    const { xodimId, eskiParol, yangiParol } = req.body;
    const { data: xodim, error } = await supabase.from('xodimlar').select('*').eq('id', xodimId).single();

    if (error || !xodim) return res.json({ ok: false, xato: "Xodim topilmadi" });
    if (xodim.parol_hash !== parolHash(eskiParol)) return res.json({ ok: false, xato: "Eski parol noto'g'ri" });

    await supabase.from('xodimlar').update({ parol_hash: parolHash(yangiParol) }).eq('id', xodimId);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, xato: err.message });
  }
});

app.post('/api/tahrirSora', async (req, res) => {
  try {
    const { hisobotId, xodimId, xodimFio, sabab } = req.body;
    const id = genId('T');
    const sana = tashkentBugun();

    const { error } = await supabase.from('tahrir_sorovlari').insert([{
      id, hisobot_id: hisobotId, xodim_id: xodimId, xodim_fio: xodimFio,
      sabab, status: 'KUTILMOQDA', sana
    }]);

    if (error) return res.json({ ok: false, xato: error.message });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, xato: err.message });
  }
});

app.get('/api/tahrirSorovlari', async (req, res) => {
  const { data, error } = await supabase.from('tahrir_sorovlari').select('*').order('sana', { ascending: false });
  if (error) return res.json({ ok: false, xato: error.message });
  const sorovlar = (data || []).map(s => ({
    id: s.id, hisobotId: s.hisobot_id, xodimFio: s.xodim_fio,
    sabab: s.sabab, status: s.status, ruxsatBeruvchi: s.ruxsat_beruvchi, sana: s.sana
  }));
  res.json({ ok: true, sorovlar });
});

app.post('/api/tahrirRuxsatBer', async (req, res) => {
  const u = await checkAuth(req); 
  if (!u) return res.json({ ok: false, xato: "Ruxsat yo'q" });

  try {
    const { sorovId } = req.body;
    const { data: s, error: sErr } = await supabase.from('tahrir_sorovlari').select('*').eq('id', sorovId).single();
    if (sErr || !s) return res.json({ ok: false, xato: "So'rov topilmadi" });

    await supabase.from('tahrir_sorovlari').update({
      status: 'RUXSAT_BERILDI',
      ruxsat_beruvchi: u.fio
    }).eq('id', sorovId);

    if (s.hisobot_id) {
      await supabase.from('hisobotlar').update({ bosqich: 'BOSHLANDI' }).eq('id', s.hisobot_id);
    }

    await auditLog(u.fio, 'TAHRIR_RUXSAT', `${s.xodim_fio} - ${s.hisobot_id}`);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, xato: err.message });
  }
});

app.post('/api/tahrirRad', async (req, res) => {
  const u = await checkAuth(req); 
  if (!u) return res.json({ ok: false, xato: "Ruxsat yo'q" });

  try {
    const { sorovId } = req.body;
    await supabase.from('tahrir_sorovlari').update({
      status: 'RAD_ETILDI',
      ruxsat_beruvchi: u.fio
    }).eq('id', sorovId);

    await auditLog(u.fio, 'TAHRIR_RAD', sorovId);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, xato: err.message });
  }
});

// ====================================================
// 6. DASHBOARD 4.0 + SYSONE AI ANALYST
// ====================================================
// Muhim prinsip: AI statistikani hisoblamaydi.
// Raqamlar Supabase ma'lumotlaridan serverda deterministik hisoblanadi,
// AI esa faqat shu aniq faktlarni ravon o'zbek tilida sharhlaydi.

const aiRateLimitMap = new Map();
const aiCache = new Map();

// FAST 2.0: dashboard va katalog ma'lumotlari qisqa muddat RAMda saqlanadi.
// Bu bir savol uchun Supabase'ga takroriy murojaatlarni keskin kamaytiradi.
const dashboardFastCache = new Map();
const AI_SNAPSHOT_CACHE_MS = Math.max(2000, Number(process.env.AI_SNAPSHOT_CACHE_MS || 10000));
let aiDirectoryCache = { vaqt: 0, kategoriyalar: [], tashkilotlar: [] };

function dashboardFastCacheKey(user, targetSana, kunlar, mfyId, kategoriyaId) {
  return [user?.id || user?.fio || 'u', user?.rol || '', targetSana, kunlar, mfyId || '', kategoriyaId || ''].join('|');
}
function dashboardFastCacheTozala() {
  dashboardFastCache.clear();
}
async function aiDirectoryOl(force = false) {
  const now = Date.now();
  if (!force && aiDirectoryCache.vaqt && now - aiDirectoryCache.vaqt < 60_000) return aiDirectoryCache;
  const [katRes, mfyRes] = await Promise.all([
    supabase.from('kategoriyalar').select('id,nomi'),
    supabase.from('mfy').select('id,nomi')
  ]);
  if (katRes.error) throw katRes.error;
  if (mfyRes.error) throw mfyRes.error;
  aiDirectoryCache = {
    vaqt: now,
    kategoriyalar: katRes.data || [],
    tashkilotlar: mfyRes.data || []
  };
  return aiDirectoryCache;
}

function aiRateRuxsat(userId) {
  const key = String(userId || 'unknown');
  const now = Date.now();
  const old = (aiRateLimitMap.get(key) || []).filter(t => now - t < 60_000);
  if (old.length >= 12) return false;
  old.push(now);
  aiRateLimitMap.set(key, old);
  return true;
}

async function dashboardSnapshotYarat(user, options = {}) {
  const targetSana = options.sana || tashkentBugun();
  const kunlar = Math.max(7, Math.min(30, Number(options.kunlar || 14)));
  const boshlanish = sanaQosh(targetSana, -(kunlar - 1));

  let mfyId = options.mfyId || '';
  const kategoriyaId = options.kategoriyaId || '';

  // Nazoratchi server darajasida faqat o'z tashkilotini ko'radi.
  if (user.rol === 'nazoratchi') mfyId = String(user.mfyId || '');

  const fastKey = dashboardFastCacheKey(user, targetSana, kunlar, mfyId, kategoriyaId);
  const fastHit = dashboardFastCache.get(fastKey);
  if (fastHit && Date.now() - fastHit.vaqt < AI_SNAPSHOT_CACHE_MS) return fastHit.snapshot;

  let xQuery = supabase
    .from('xodimlar')
    .select('id,fio,mfy_id,kategoriya_id,holat,ish_holati');

  if (mfyId) xQuery = xQuery.eq('mfy_id', mfyId);
  if (kategoriyaId) xQuery = xQuery.eq('kategoriya_id', kategoriyaId);

  let hQuery = supabase
    .from('hisobotlar')
    .select('id,xodim_id,xodim_fio,mfy_id,mfy_nomi,kategoriya_id,kategoriya_nomi,ish_turi,ish_nomi,reyting,kechikkan,sana,b_vaqt,bosqich')
    .gte('sana', boshlanish)
    .lte('sana', targetSana)
    .order('b_vaqt', { ascending: false });

  if (mfyId) hQuery = hQuery.eq('mfy_id', mfyId);
  if (kategoriyaId) hQuery = hQuery.eq('kategoriya_id', kategoriyaId);

  const [xRes, hRes, directory] = await Promise.all([
    xQuery,
    hQuery,
    aiDirectoryOl()
  ]);

  if (xRes.error) throw xRes.error;
  if (hRes.error) throw hRes.error;

  const mfyMap = Object.fromEntries((directory.tashkilotlar || []).map(x => [String(x.id), x.nomi]));
  const katMap = Object.fromEntries((directory.kategoriyalar || []).map(x => [String(x.id), x.nomi]));

  const xodimlar = (xRes.data || []).map(x => ({
    id: x.id,
    fio: x.fio,
    mfyId: x.mfy_id,
    mfyNomi: mfyMap[String(x.mfy_id)] || '',
    kategoriyaId: x.kategoriya_id,
    kategoriyaNomi: katMap[String(x.kategoriya_id)] || '',
    holat: x.holat,
    ishHolati: x.ish_holati || 'ishda'
  }));

  const faol = xodimlar.filter(x => x.holat === 'faol');
  const bloklangan = xodimlar.length - faol.length;
  const hisobotlar = hRes.data || [];
  const bugungiHisobotlar = hisobotlar.filter(h => h.sana === targetSana);
  const topshirganIds = new Set(bugungiHisobotlar.map(h => String(h.xodim_id)));

  const topshirgan = faol.filter(x => topshirganIds.has(String(x.id)));
  const qolgan = faol.filter(x => !topshirganIds.has(String(x.id)));
  const uzrli = qolgan.filter(x => x.ishHolati && x.ishHolati !== 'ishda');
  const topshirmagan = qolgan.filter(x => !x.ishHolati || x.ishHolati === 'ishda');

  const kutilgan = Math.max(0, faol.length - uzrli.length);
  const bajarilishFoizi = kutilgan > 0 ? Math.round((topshirgan.length / kutilgan) * 100) : 0;
  const flagSoni = bugungiHisobotlar.filter(h => h.reyting && h.reyting !== 'YASHIL').length;
  const kechikkan = bugungiHisobotlar.filter(h => !!h.kechikkan).length;
  const flagFoizi = bugungiHisobotlar.length ? Math.round((flagSoni / bugungiHisobotlar.length) * 100) : 0;

  const kecha = sanaQosh(targetSana, -1);
  const kechaIds = new Set(
    hisobotlar.filter(h => h.sana === kecha).map(h => String(h.xodim_id))
  );
  const kechagiTopshirgan = faol.filter(x => kechaIds.has(String(x.id))).length;
  const kechagiFoiz = kutilgan > 0 ? Math.round((kechagiTopshirgan / kutilgan) * 100) : 0;

  const trend = [];
  for (let i = kunlar - 1; i >= 0; i--) {
    const sana = sanaQosh(targetSana, -i);
    const kunHisobot = hisobotlar.filter(h => h.sana === sana);
    const uniq = new Set(kunHisobot.map(h => String(h.xodim_id)));
    const kunTopshirgan = faol.filter(x => uniq.has(String(x.id))).length;

    trend.push({
      sana,
      hisobotSoni: kunHisobot.length,
      topshirgan: kunTopshirgan,
      foiz: kutilgan > 0 ? Math.round((kunTopshirgan / kutilgan) * 100) : 0,
      flagSoni: kunHisobot.filter(h => h.reyting && h.reyting !== 'YASHIL').length,
      kechikkan: kunHisobot.filter(h => !!h.kechikkan).length
    });
  }

  const orgMap = {};

  for (const x of faol) {
    const id = String(x.mfyId || '');
    if (!id) continue;

    if (!orgMap[id]) {
      orgMap[id] = {
        id,
        nomi: x.mfyNomi || mfyMap[id] || 'Noma’lum',
        jami: 0,
        kutilgan: 0,
        uzrli: 0,
        topshirganSet: new Set(),
        hisobotSoni: 0,
        flagSoni: 0,
        kechikkan: 0
      };
    }

    const o = orgMap[id];
    o.jami++;

    if (topshirganIds.has(String(x.id))) {
      o.topshirganSet.add(String(x.id));
      o.kutilgan++;
    } else if (x.ishHolati && x.ishHolati !== 'ishda') {
      o.uzrli++;
    } else {
      o.kutilgan++;
    }
  }

  for (const h of bugungiHisobotlar) {
    const id = String(h.mfy_id || '');
    if (!id || !orgMap[id]) continue;

    orgMap[id].hisobotSoni++;
    if (h.reyting && h.reyting !== 'YASHIL') orgMap[id].flagSoni++;
    if (h.kechikkan) orgMap[id].kechikkan++;
  }

  const tashkilotlar = Object.values(orgMap)
    .map(o => {
      const submitted = o.topshirganSet.size;
      return {
        id: o.id,
        nomi: o.nomi,
        jami: o.jami,
        kutilgan: o.kutilgan,
        topshirgan: submitted,
        topshirmagan: Math.max(0, o.kutilgan - submitted),
        hisobotSoni: o.hisobotSoni,
        uzrli: o.uzrli,
        flagSoni: o.flagSoni,
        kechikkan: o.kechikkan,
        foiz: o.kutilgan > 0 ? Math.round((submitted / o.kutilgan) * 100) : 0
      };
    })
    .sort((a, b) => b.foiz - a.foiz || a.nomi.localeCompare(b.nomi, 'uz'));

  const snapshot = {
    sana: targetSana,
    davr: { dan: boshlanish, gacha: targetSana, kunlar },
    scope: {
      mfyId: mfyId || null,
      kategoriyaId: kategoriyaId || null,
      nomi: mfyId ? (mfyMap[String(mfyId)] || 'Tanlangan tashkilot') : 'Barcha tashkilotlar',
      kategoriyaNomi: kategoriyaId ? (katMap[String(kategoriyaId)] || '') : ''
    },
    metrics: {
      jamiXodim: faol.length,
      bloklangan,
      kutilgan,
      topshirgan: topshirgan.length,
      topshirmagan: topshirmagan.length,
      uzrli: uzrli.length,
      hisobotSoni: bugungiHisobotlar.length,
      bajarilishFoizi,
      flagSoni,
      flagFoizi,
      kechikkan,
      kechagiTopshirganFarqi: topshirgan.length - kechagiTopshirgan,
      kechagiBajarilishFarqi: bajarilishFoizi - kechagiFoiz
    },
    xodimlar: {
      topshirgan: topshirgan.map(x => ({
        id: x.id, fio: x.fio, mfyId: x.mfyId, mfyNomi: x.mfyNomi,
        kategoriyaId: x.kategoriyaId, kategoriyaNomi: x.kategoriyaNomi, ishHolati: x.ishHolati
      })),
      topshirmagan: topshirmagan.map(x => ({
        id: x.id, fio: x.fio, mfyId: x.mfyId, mfyNomi: x.mfyNomi,
        kategoriyaId: x.kategoriyaId, kategoriyaNomi: x.kategoriyaNomi, ishHolati: x.ishHolati
      })),
      uzrli: uzrli.map(x => ({
        id: x.id, fio: x.fio, mfyId: x.mfyId, mfyNomi: x.mfyNomi,
        kategoriyaId: x.kategoriyaId, kategoriyaNomi: x.kategoriyaNomi, ishHolati: x.ishHolati
      }))
    },
    trend,
    tashkilotlar
  };
  dashboardFastCache.set(fastKey, { vaqt: Date.now(), snapshot });
  if (dashboardFastCache.size > 80) {
    const birinchi = dashboardFastCache.keys().next().value;
    dashboardFastCache.delete(birinchi);
  }
  return snapshot;
}

// Dashboard frontendining yangi endpointi.
app.get('/api/dashboardSnapshot', async (req, res) => {
  const user = await checkAuth(req);
  if (!user) return res.status(401).json({ ok: false, xato: "Ruxsat yo'q" });

  try {
    const snapshot = await dashboardSnapshotYarat(user, {
      mfyId: req.query.mfyId,
      kategoriyaId: req.query.kategoriyaId,
      kunlar: req.query.kunlar,
      sana: req.query.sana
    });
    res.json({ ok: true, snapshot });
  } catch (err) {
    console.error('dashboardSnapshot xatosi:', err);
    res.status(500).json({ ok: false, xato: err.message });
  }
});

async function aiFaktlarYarat(user, savol, body = {}) {
  const directory = await aiDirectoryOl();
  const kategoriyalar = directory.kategoriyalar || [];
  const tashkilotlar = directory.tashkilotlar || [];

  let kategoriya = null;
  if (body.kategoriyaId) {
    kategoriya = kategoriyalar.find(x => String(x.id) === String(body.kategoriyaId)) || null;
  } else {
    kategoriya = entityMatch(savol, kategoriyalar);
  }

  let tashkilot = null;
  if (user.rol === 'nazoratchi') {
    tashkilot = tashkilotlar.find(x => String(x.id) === String(user.mfyId)) || null;
  } else if (body.mfyId) {
    tashkilot = tashkilotlar.find(x => String(x.id) === String(body.mfyId)) || null;
  } else {
    tashkilot = entityMatch(savol, tashkilotlar);
  }

  const sana = savoldanSanaOl(savol);
  const snapshot = await dashboardSnapshotYarat(user, {
    sana,
    kunlar: Number(body.kunlar || 14),
    kategoriyaId: kategoriya?.id || body.kategoriyaId || '',
    mfyId: tashkilot?.id || body.mfyId || ''
  });

  const q = normalizeUzbek(savol);
  const missingWords = ['yuklamagan', 'topshirmagan', 'yubormagan', 'bermagan', 'yuklamadi', 'topshirmadi', 'yubormadi'];
  const submittedWords = ['yuklagan', 'topshirgan', 'yuborgan', 'bergan', 'yuklashdi', 'topshirishdi', 'yuborishdi', 'yukladi', 'topshirdi', 'yubordi'];
  const wantsMissing = missingWords.some(w => q.includes(w));
  const wantsSubmitted = submittedWords.some(w => q.includes(w));

  let intent = 'daily_summary';
  if ((q.includes('eng past') || q.includes('eng yomon') || q.includes('past korsatkich')) && q.includes('tashkilot')) intent = 'lowest_org';
  else if ((q.includes('eng yaxshi') || q.includes('eng yuqori') || q.includes('yuqori korsatkich')) && q.includes('tashkilot')) intent = 'highest_org';
  else if (q.includes('birinchi navbat') || (q.includes('etibor') && q.includes('tashkilot'))) intent = 'priority_org';
  else if ((q.includes('3 ta') || q.includes('uchta') || q.includes('uch ta')) && (q.includes('amaliy') || q.includes('ish'))) intent = 'action_plan';
  else if (q.includes('bajarilish') && (q.includes('foiz') || q.includes('daraja') || q.includes('qancha') || q.includes('necha'))) intent = 'completion_rate';
  else if (q.includes('uzrli') || q.includes('sababli')) intent = 'excused_summary';
  else if ((q.includes('jami') || q.includes('faol')) && q.includes('xodim') && (q.includes('nech') || q.includes('qancha') || q.includes('son'))) intent = 'total_employees';
  else if (wantsMissing && kategoriya) intent = 'category_missing';
  else if (kategoriya) intent = 'category_summary';
  else if (wantsMissing) intent = 'missing_summary';
  else if (wantsSubmitted) intent = 'submitted_summary';
  else if (q.includes('hisobot') && (q.includes('nechta') || q.includes('qancha') || q.includes('jami') || q.includes('soni'))) intent = 'report_count';

  // AI ga xodim FIO, PINFL, telefon, GPS yoki rasm berilmaydi.
  const safeTashkilotlar = (snapshot.tashkilotlar || []).map(x => ({
    nomi: x.nomi,
    jami: x.jami,
    kutilgan: x.kutilgan,
    topshirgan: x.topshirgan,
    topshirmagan: x.topshirmagan,
    hisobotSoni: x.hisobotSoni,
    uzrli: x.uzrli,
    foiz: x.foiz,
    flagSoni: x.flagSoni,
    kechikkan: x.kechikkan
  }));

  return {
    intent,
    sana,
    kategoriya: kategoriya ? { id: kategoriya.id, nomi: kategoriya.nomi } : null,
    tashkilot: tashkilot ? { id: tashkilot.id, nomi: tashkilot.nomi } : null,
    metrics: snapshot.metrics,
    tashkilotlar: safeTashkilotlar,
    trend: snapshot.trend
  };
}

function sanaOvozMatni(sana) {
  if (sana === tashkentBugun()) return 'Bugun';
  if (sana === sanaQosh(tashkentBugun(), -1)) return 'Kecha';
  return sana;
}

function aiAniqJavob(facts) {
  const m = facts.metrics || {};
  const sanaSoz = sanaOvozMatni(facts.sana);
  const kategoriya = facts.kategoriya?.nomi || 'barcha toifalar';
  const scopeOrg = facts.tashkilot?.nomi ? ` ${facts.tashkilot.nomi} tashkilotida` : '';

  const muammoliOrg = (facts.tashkilotlar || [])
    .filter(x => Number(x.topshirmagan || 0) > 0)
    .sort((a, b) => Number(b.topshirmagan || 0) - Number(a.topshirmagan || 0));

  const topMissing = muammoliOrg.slice(0, 10);
  const reyting = (facts.tashkilotlar || []).slice().sort((a,b) => Number(b.foiz||0)-Number(a.foiz||0));
  const engYaxshi = reyting[0] || null;
  const engPast = reyting.length ? reyting[reyting.length - 1] : null;

  if (facts.intent === 'completion_rate') {
    return `${sanaSoz}${scopeOrg} bajarilish darajasi ${m.bajarilishFoizi || 0} foiz.`;
  }
  if (facts.intent === 'excused_summary') {
    return `${sanaSoz}${scopeOrg} ${m.uzrli || 0} nafar xodim sababli yoki uzrli holatda.`;
  }
  if (facts.intent === 'total_employees') {
    return `${sanaSoz}${scopeOrg} jami ${m.jamiXodim || 0} nafar faol xodim mavjud.`;
  }
  if (facts.intent === 'report_count') {
    return `${sanaSoz}${scopeOrg} jami ${m.hisobotSoni || 0} ta hisobot qabul qilindi. Hisobot topshirgan noyob xodimlar soni ${m.topshirgan || 0} nafar.`;
  }
  if (facts.intent === 'lowest_org') {
    return engPast ? `${sanaSoz} eng past bajarilish ko'rsatkichi ${engPast.nomi} tashkilotida: ${engPast.foiz || 0} foiz. ${engPast.topshirmagan || 0} nafar xodim hisobot topshirmagan.` : `${sanaSoz} tashkilotlar reytingi uchun ma'lumot yetarli emas.`;
  }
  if (facts.intent === 'highest_org') {
    return engYaxshi ? `${sanaSoz} eng yuqori bajarilish ko'rsatkichi ${engYaxshi.nomi} tashkilotida: ${engYaxshi.foiz || 0} foiz.` : `${sanaSoz} tashkilotlar reytingi uchun ma'lumot yetarli emas.`;
  }
  if (facts.intent === 'priority_org') {
    const p = topMissing[0] || engPast;
    return p ? `Birinchi navbatda ${p.nomi} tashkilotiga e'tibor berish tavsiya etiladi. U yerda ${p.topshirmagan || 0} nafar xodim hisobot topshirmagan, bajarilish darajasi ${p.foiz || 0} foiz.` : `Hozircha alohida tezkor e'tibor talab qiladigan tashkilot aniqlanmadi.`;
  }
  if (facts.intent === 'action_plan') {
    const p = topMissing[0] || engPast;
    const bir = p ? `${p.nomi} tashkilotidagi topshirmagan xodimlarga tezkor eslatma yuborish` : `joriy hisobot intizomini saqlash`;
    return `Bugun uchta amaliy ish tavsiya etiladi: birinchisi, ${bir}; ikkinchisi, kun davomida bajarilish darajasini qayta tekshirish; uchinchisi, hisobot sifati va kechikkan hisobotlarni nazorat qilish.`;
  }

  if (facts.intent === 'category_missing') {
    let text = `${sanaSoz}${scopeOrg} ${kategoriya} toifasi bo'yicha ${muammoliOrg.length} ta tashkilotda hisobot topshirmagan xodimlar mavjud. ` +
      `Jami ${m.topshirmagan || 0} nafar xodim hisobot topshirmagan.`;

    if (topMissing.length) {
      text += ' Tashkilotlar kesimida: ' + topMissing
        .map(x => `${x.nomi} — ${x.topshirmagan} ta`)
        .join('; ') + '.';
    }
    return text;
  }

  if (facts.intent === 'category_summary') {
    return `${sanaSoz}${scopeOrg} ${kategoriya} toifasida ${m.topshirgan || 0} nafar xodim kamida bitta hisobot topshirdi. ` +
      `Ular jami ${m.hisobotSoni || 0} ta hisobot yukladi. ${m.topshirmagan || 0} nafar xodim hisobot topshirmagan, ` +
      `${m.uzrli || 0} nafar xodim sababli holatda. Bajarilish darajasi ${m.bajarilishFoizi || 0} foiz.`;
  }

  if (facts.intent === 'missing_summary') {
    let text = `${sanaSoz}${scopeOrg} jami ${m.topshirmagan || 0} nafar faol xodim hisobot topshirmagan. ` +
      `Bu holat ${muammoliOrg.length} ta tashkilotda kuzatilmoqda.`;

    if (topMissing.length) {
      text += ' Eng ko\'p topshirmagan tashkilotlar: ' + topMissing.slice(0, 5)
        .map(x => `${x.nomi} — ${x.topshirmagan} ta`)
        .join('; ') + '.';
    }
    return text;
  }

  if (facts.intent === 'submitted_summary') {
    return `${sanaSoz}${scopeOrg} ${m.topshirgan || 0} nafar xodim hisobot topshirdi. ` +
      `Jami ${m.hisobotSoni || 0} ta hisobot qabul qilindi. Bajarilish darajasi ${m.bajarilishFoizi || 0} foiz. ` +
      `${m.topshirmagan || 0} nafar xodim hali hisobot topshirmagan.`;
  }

  return `${sanaSoz}${scopeOrg}gi kunlik nazorat hisoboti. Jami ${m.jamiXodim || 0} nafar faol xodim mavjud. ` +
    `${m.topshirgan || 0} nafari hisobot topshirdi va jami ${m.hisobotSoni || 0} ta hisobot qabul qilindi. ` +
    `${m.topshirmagan || 0} nafar xodim hisobot topshirmagan, ${m.uzrli || 0} nafar xodim sababli holatda. ` +
    `Bajarilish darajasi ${m.bajarilishFoizi || 0} foiz. ${m.kechikkan || 0} ta kechikkan hisobot mavjud.`;
}

function aiFastSavolmi(savol, facts) {
  const q = normalizeUzbek(savol);
  const fastIntents = new Set([
    'daily_summary','submitted_summary','missing_summary','category_summary','category_missing',
    'completion_rate','excused_summary','total_employees','report_count','lowest_org','highest_org','priority_org','action_plan'
  ]);
  if (!fastIntents.has(facts?.intent)) return false;
  // Chuqur tahlil, sabab yoki trend so'ralgan bo'lsa Gemini ishlaydi.
  const murakkab = ['nima uchun','nega','sababini tahlil','chuqur tahlil','tendensiya','trend','solishtir','taqqosla','xulosa chiqar'];
  if (murakkab.some(x => q.includes(normalizeUzbek(x)))) return false;
  if (facts?.intent === 'daily_summary') {
    const oddiy = ['bugungi holat','bugun holat','umumiy holat','kunlik holat','bugun qanday','hisobot holati','bugungi hisobot'];
    return oddiy.some(x => q.includes(normalizeUzbek(x))) || q === '';
  }
  return true;
}

function aiSpeechJavob(facts, exactAnswer) {
  const m = facts?.metrics || {};
  const intent = facts?.intent || '';
  const kat = facts?.kategoriya?.nomi ? `${facts.kategoriya.nomi} bo'yicha ` : '';
  // Ovoz uchun ekrandagi uzun tahlilni emas, qisqa va aniq xulosani o'qiymiz.
  // Bu Gemini TTS vaqtini va audio hajmini kamaytiradi.
  if (intent === 'daily_summary' || intent === 'submitted_summary') {
    return speechTextTayyorla(`Bugun ${m.topshirgan || 0} nafar xodim hisobot topshirdi, ${m.topshirmagan || 0} nafari topshirmadi. Bajarilish ${m.bajarilishFoizi || 0} foiz, sababli holatda ${m.uzrli || 0} nafar.`);
  }
  if (intent === 'category_summary' || intent === 'category_missing') {
    return speechTextTayyorla(`Bugun ${kat}${m.topshirgan || 0} nafar topshirdi, ${m.topshirmagan || 0} nafar topshirmadi. Bajarilish ${m.bajarilishFoizi || 0} foiz.`);
  }
  if (intent === 'missing_summary') {
    return speechTextTayyorla(`Bugun ${m.topshirmagan || 0} nafar xodim hisobot topshirmagan. Bajarilish ${m.bajarilishFoizi || 0} foiz.`);
  }
  if (intent === 'completion_rate') return speechTextTayyorla(`Bugungi bajarilish darajasi ${m.bajarilishFoizi || 0} foiz.`);
  if (intent === 'report_count') return speechTextTayyorla(`Bugun jami ${m.hisobotSoni || 0} ta hisobot qabul qilindi. ${m.topshirgan || 0} nafar xodim topshirdi.`);
  if (intent === 'total_employees') return speechTextTayyorla(`Jami ${m.jamiXodim || 0} nafar faol xodim mavjud.`);
  if (intent === 'excused_summary') return speechTextTayyorla(`Bugun ${m.uzrli || 0} nafar xodim sababli yoki uzrli holatda.`);
  return speechTextTayyorla(exactAnswer);
}

function lokalTahlil(facts, exactAnswer) {
  const m = facts.metrics || {};
  let holat = 'yaxshi';
  if (Number(m.bajarilishFoizi || 0) < 50) holat = 'xavf';
  else if (Number(m.bajarilishFoizi || 0) < 80 || Number(m.flagSoni || 0) > 0) holat = 'diqqat';

  const insights = [{
    sarlavha: 'Bajarilish',
    matn: `Joriy bajarilish darajasi ${m.bajarilishFoizi || 0} foiz.`,
    daraja: Number(m.bajarilishFoizi || 0) >= 80 ? 'past' : (Number(m.bajarilishFoizi || 0) >= 50 ? 'orta' : 'yuqori')
  }];

  if (Number(m.topshirmagan || 0) > 0) {
    insights.push({
      sarlavha: 'Topshirmaganlar',
      matn: `${m.topshirmagan} nafar xodim hisobot topshirmagan.`,
      daraja: 'orta'
    });
  }


  return {
    sarlavha: facts.kategoriya?.nomi ? `${facts.kategoriya.nomi} bo'yicha tahlil` : 'Kunlik nazorat tahlili',
    xulosa: exactAnswer,
    holat,
    insights,
    tavsiyalar: [
      Number(m.topshirmagan || 0) > 0 ? 'Hisobot topshirmagan tashkilotlarga tezkor eslatma yuborish.' : 'Joriy hisobot intizomini saqlab qolish.',
      'Hisobot sifatini muntazam nazorat qilish.',
      'Kun yakunida bajarilish ko\'rsatkichini qayta tekshirish.'
    ],
    savolJavobi: exactAnswer,
    speechText: aiSpeechJavob(facts, exactAnswer)
  };
}

function geminiMatnOl(payload) {
  const parts = [];
  for (const candidate of (payload?.candidates || [])) {
    for (const part of (candidate?.content?.parts || [])) {
      if (typeof part?.text === 'string' && part.text.trim()) parts.push(part.text.trim());
    }
  }
  return parts.join('\n').trim();
}

function geminiJsonMatnTozalash(text) {
  return String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

async function geminiGenerateContent(model, body) {
  if (!process.env.GEMINI_API_KEY) {
    const err = new Error('GEMINI_API_KEY serverda sozlanmagan');
    err.status = 503;
    throw err;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'x-goog-api-key': process.env.GEMINI_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  let payload = {};
  try { payload = await response.json(); } catch (_) {}
  if (!response.ok) {
    const err = new Error(payload?.error?.message || `Gemini API xatosi (${response.status})`);
    err.status = response.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

async function geminiTahlil(facts, savol, exactAnswer) {
  // API kaliti bo'lmasa deterministik lokal analitika ishlashda davom etadi.
  if (!process.env.GEMINI_API_KEY) return lokalTahlil(facts, exactAnswer);
  const aiCfg = await aiConfigOl();

  const schema = {
    type: 'object',
    properties: {
      sarlavha: { type: 'string' },
      xulosa: { type: 'string' },
      holat: { type: 'string', enum: ['yaxshi', 'diqqat', 'xavf'] },
      insights: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            sarlavha: { type: 'string' },
            matn: { type: 'string' },
            daraja: { type: 'string', enum: ['past', 'orta', 'yuqori'] }
          },
          required: ['sarlavha', 'matn', 'daraja']
        }
      },
      tavsiyalar: { type: 'array', items: { type: 'string' } },
      savolJavobi: { type: 'string' },
      speechText: { type: 'string' }
    },
    required: ['sarlavha', 'xulosa', 'holat', 'insights', 'tavsiyalar', 'savolJavobi', 'speechText']
  };

  const safeFacts = {
    sana: facts.sana,
    kategoriya: facts.kategoriya,
    tashkilot: facts.tashkilot,
    metrics: facts.metrics,
    tashkilotlar: facts.tashkilotlar,
    trend: facts.trend
  };

  const systemText = [
    `Siz SysOne Xisobot Nazorat platformasidagi ${aiCfg.ism} nomli professional sun'iy intellekt yordamchisiz.`,
    "Faqat server bergan JSON faktlardan foydalaning; raqamlarni o'ylab topmang va o'zgartirmang.",
    "Kategoriya so'ralgan bo'lsa faqat o'sha toifa bo'yicha gapiring.",
    "Hisobot topshirmaganlar haqida javobda xodim ism-familiyalarini aytmang; tashkilotlar kesimini ishlating.",
    "Hisobot topshirgan noyob xodimlar soni va jami hisobotlar soni boshqa-boshqa ko'rsatkich ekanini aniq ajrating.",
    "O'zbekiston adabiy o'zbek tilida ravon, sodda, rasmiy va qisqa yozing. Imlo qoidalariga qat'iy rioya qiling. Keraksiz ruscha va inglizcha aralashmalardan qoching; kategoriya o'rniga toifa, monitoring o'rniga kuzatuv, status o'rniga holat so'zlarini ishlating.",
    "speechText ovozda ravon o'qishga mos, markdownsiz va ortiqcha belgilarsiz bo'lsin.",
    "Muammoli hisobot yoki flag mavzusini foydalanuvchi aniq so'ramasa tilga olmang."
  ].join(' ');

  try {
    const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
    const payload = await geminiGenerateContent(model, {
      systemInstruction: { parts: [{ text: systemText }] },
      contents: [{
        role: 'user',
        parts: [{
          text: `FOYDALANUVCHI SAVOLI:\n${savol || 'Bugungi kunlik hisobotni tahlil qil.'}\n\nSERVER HISOBLAGAN ANIQ JAVOB:\n${exactAnswer}\n\nFAKTLAR:\n${JSON.stringify(safeFacts)}`
        }]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 650,
        responseMimeType: 'application/json',
        responseJsonSchema: schema
      }
    });

    const text = geminiJsonMatnTozalash(geminiMatnOl(payload));
    if (!text) return lokalTahlil(facts, exactAnswer);

    const parsed = JSON.parse(text);
    // Faktik savol javobi server hisoblagan qiymatdan olinadi — model uni o'zgartira olmaydi.
    parsed.savolJavobi = exactAnswer;
    parsed.speechText = aiSpeechJavob(facts, exactAnswer);
    if (!parsed.xulosa) parsed.xulosa = exactAnswer;
    return parsed;
  } catch (err) {
    console.error('Gemini tahlil xatosi:', err.message, err.payload || '');
    return lokalTahlil(facts, exactAnswer);
  }
}

app.post('/api/aiTahlil', async (req, res) => {
  const umumiyBoshlanish = Date.now();
  const user = await checkAuth(req);
  if (!user) return res.status(401).json({ ok: false, xato: "Ruxsat yo'q" });

  if (!aiRateRuxsat(user.id || user.fio)) {
    return res.status(429).json({ ok: false, xato: "AI so'rovlari juda ko'p. Bir daqiqadan so'ng qayta urinib ko'ring." });
  }

  try {
    const savol = String(req.body.savol || '').trim().slice(0, 1200);
    const faktBoshlanish = Date.now();
    const [facts, cfg] = await Promise.all([
      aiFaktlarYarat(user, savol, req.body || {}),
      aiConfigOl()
    ]);
    const faktMs = Date.now() - faktBoshlanish;
    const exactAnswer = aiAniqJavob(facts);
    const speechText = aiSpeechJavob(facts, exactAnswer);

    // FAST 2.0: tahlil davom etayotgan paytning o'zida ovozni tayyorlashni boshlaymiz.
    // Frontend /aiSpeech ni chaqirganda shu tayyorlanayotgan audio kutib olinadi.
    if (req.body.tezkor === true && process.env.GEMINI_API_KEY && cfg.avtomatikOvoz !== false) {
      aiOvozOldindanTayyorla(speechText, cfg.ovoz, cfg.ism).catch(() => {});
    }

    const cacheKey = JSON.stringify({
      user: user.id || user.fio,
      savol: normalizeUzbek(savol),
      sana: facts.sana,
      kategoriya: facts.kategoriya?.id || '',
      tashkilot: facts.tashkilot?.id || ''
    });

    const cached = aiCache.get(cacheKey);
    if (cached && Date.now() - cached.vaqt < 2 * 60_000) {
      return res.json({
        ok: true,
        tahlil: cached.tahlil,
        model: cached.model,
        cached: true,
        fastPath: cached.fastPath === true,
        tezlik: { faktMs, tahlilMs: 0, jamiMs: Date.now() - umumiyBoshlanish },
        facts: { sana: facts.sana, kategoriya: facts.kategoriya, tashkilot: facts.tashkilot }
      });
    }

    const tahlilBoshlanish = Date.now();
    const fastPath = aiFastSavolmi(savol, facts);
    let tahlil;
    let model;
    if (fastPath) {
      tahlil = lokalTahlil(facts, exactAnswer);
      tahlil.speechText = speechText;
      model = 'SysOne Fast 2.0';
    } else {
      tahlil = await geminiTahlil(facts, savol, exactAnswer);
      tahlil.speechText = speechText;
      model = process.env.GEMINI_API_KEY ? (process.env.GEMINI_MODEL || 'gemini-3.6-flash') : 'SysOne Local Analytics';
    }
    const tahlilMs = Date.now() - tahlilBoshlanish;

    aiCache.set(cacheKey, { vaqt: Date.now(), tahlil, model, fastPath });
    if (aiCache.size > 120) aiCache.delete(aiCache.keys().next().value);
    auditLog(user.fio, 'AI_TAHLIL', `${facts.sana} | ${facts.kategoriya?.nomi || 'barcha kategoriya'} | ${fastPath ? 'FAST' : 'GEMINI'}`).catch(() => {});

    res.json({
      ok: true,
      tahlil,
      model,
      cached: false,
      fastPath,
      tezlik: { faktMs, tahlilMs, jamiMs: Date.now() - umumiyBoshlanish },
      facts: { sana: facts.sana, kategoriya: facts.kategoriya, tashkilot: facts.tashkilot }
    });
  } catch (err) {
    console.error('aiTahlil xatosi:', err);
    res.status(500).json({ ok: false, xato: err.message });
  }
});


// ====================================================
// HISOBCHI AI — SOZLAMALAR, OVOZDAN MATNGA VA MATNDAN OVOZGA
// ====================================================
app.get('/api/aiSozlama', async (req, res) => {
  const user = await checkAuth(req);
  if (!user) return res.status(401).json({ ok: false, xato: "Ruxsat yo'q" });
  const sozlama = await aiConfigOl();
  res.json({ ok: true, sozlama, ttsBor: !!process.env.GEMINI_API_KEY, sttBor: !!process.env.GEMINI_API_KEY, provider: 'Google Gemini', fast2: true, model: process.env.GEMINI_MODEL || 'gemini-3.6-flash', liveModel: process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview' });
});

app.post('/api/aiSozlamaSaqla', async (req, res) => {
  const user = await checkAuth(req);
  if (!user) return res.status(401).json({ ok: false, xato: "Ruxsat yo'q" });
  if (user.rol !== 'superadmin' && !(user.ruxsatlar || []).includes('sozlamalar')) {
    return res.status(403).json({ ok: false, xato: "AI sozlamalarini o'zgartirish uchun ruxsat yo'q" });
  }
  try {
    const sozlama = aiConfigTozalash(req.body || {});
    const { error } = await supabase.from('sozlamalar').upsert([{ kalit: AI_CONFIG_KEY, qiymat: JSON.stringify(sozlama) }], { onConflict: 'kalit' });
    if (error) throw error;
    aiConfigCache = { qiymat: sozlama, vaqt: Date.now() };
    await auditLog(user.fio, 'AI_SOZLAMA_SAQLANDI', `Ism: ${sozlama.ism}; ovoz: ${sozlama.ovoz}; uyg'otish: ${sozlama.uygotishFaol ? 'yoqilgan' : 'o\'chirilgan'}`);
    res.json({ ok: true, sozlama });
  } catch (err) {
    console.error('aiSozlamaSaqla xatosi:', err);
    res.status(500).json({ ok: false, xato: err.message });
  }
});

app.post('/api/aiTranscribe', aiAudioUpload.single('audio'), async (req, res) => {
  const user = await checkAuth(req);
  if (!user) return res.status(401).json({ ok: false, xato: "Ruxsat yo'q" });
  if (!process.env.GEMINI_API_KEY) return res.status(503).json({ ok: false, xato: "GEMINI_API_KEY serverda sozlanmagan" });
  if (!req.file?.buffer?.length) return res.status(400).json({ ok: false, xato: "Audio topilmadi" });

  try {
    const cfg = await aiConfigOl();
    const mime = String(req.file.mimetype || 'audio/wav').split(';')[0].toLowerCase();
    const data = req.file.buffer.toString('base64');
    const model = process.env.GEMINI_TRANSCRIBE_MODEL || process.env.GEMINI_MODEL || 'gemini-3.6-flash';

    const payload = await geminiGenerateContent(model, {
      systemInstruction: {
        parts: [{
          text: `Siz o'zbekcha nutqni matnga ko'chiruvchi yordamchisiz. O'zbekiston adabiy o'zbek tilidagi talaffuzni aniq taning. Yordamchi nomi ${cfg.ism}, uyg'otish so'zi ${cfg.uygotishSozi}. Tashkilot, toifa, hisobot, xodim, bajarilish, foiz, MFY va JSHSHIR kabi tizim atamalarini to'g'ri yozing. Faqat eshitilgan gapning transkripsiyasini qaytaring; izoh, sarlavha yoki qo'shimcha javob yozmang.`
        }]
      },
      contents: [{
        role: 'user',
        parts: [
          { text: "Quyidagi audio yozuvdagi nutqni o'zbek lotin yozuvida aynan matnga ko'chiring." },
          { inlineData: { mimeType: mime, data } }
        ]
      }],
      generationConfig: { temperature: 0, maxOutputTokens: 180 }
    });

    let matn = geminiMatnOl(payload)
      .replace(/^```(?:text)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .replace(/^(transkripsiya|matn)\s*:\s*/i, '')
      .trim();

    if (!matn) return res.status(422).json({ ok: false, xato: "Ovozdan matn olinmadi" });
    await auditLog(user.fio, 'AI_OVOZLI_SAVOL', matn.slice(0, 250));
    res.json({ ok: true, matn, assistantName: cfg.ism, wakeWord: cfg.uygotishSozi, provider: 'Google Gemini', model });
  } catch (err) {
    console.error('Gemini transkripsiya xatosi:', err.message, err.payload || '');
    res.status(err.status || 500).json({ ok: false, xato: err.message || "Ovozni matnga aylantirib bo'lmadi" });
  }
});

function pcm16ToWav(pcmBuffer, sampleRate = 24000, channels = 1) {
  const pcm = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer || []);
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function websocketCtorOl() {
  if (typeof globalThis.WebSocket === 'function') return { Ctor: globalThis.WebSocket, turi: 'web' };
  try { return { Ctor: require('ws'), turi: 'ws' }; } catch (_) { return null; }
}

async function geminiLiveOvozYaratBirMartalik(matn, voice, assistantName) {
  const wsInfo = websocketCtorOl();
  if (!wsInfo || !process.env.GEMINI_API_KEY) return null;
  if (String(process.env.GEMINI_LIVE_TTS || 'true').toLowerCase() === 'false') return null;

  const model = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview';
  const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;

  return await new Promise((resolve, reject) => {
    let tugadi = false;
    let setupTayyor = false;
    const chunks = [];
    let ws;

    const yakunla = (err, value) => {
      if (tugadi) return;
      tugadi = true;
      clearTimeout(timer);
      try { ws?.close(); } catch (_) {}
      if (err) reject(err); else resolve(value);
    };

    const timer = setTimeout(() => yakunla(new Error('Gemini Live ovoz javobi vaqti tugadi')), 10000);

    const xabarniQaytaIshla = async raw => {
      try {
        let txt;
        if (typeof raw === 'string') txt = raw;
        else if (Buffer.isBuffer(raw)) txt = raw.toString('utf8');
        else if (raw instanceof ArrayBuffer) txt = Buffer.from(raw).toString('utf8');
        else if (raw?.arrayBuffer) txt = Buffer.from(await raw.arrayBuffer()).toString('utf8');
        else txt = String(raw || '');
        const msg = JSON.parse(txt);

        if (msg.setupComplete && !setupTayyor) {
          setupTayyor = true;
          ws.send(JSON.stringify({
            realtimeInput: {
              text: `Quyidagi matnni aynan o'qing. O'zbekiston adabiy o'zbek tilida ravon, xotirjam va professional talaffuz qiling. Hech qanday yangi gap qo'shmang. MATN: ${matn}`
            }
          }));
          return;
        }

        const sc = msg.serverContent;
        for (const part of (sc?.modelTurn?.parts || [])) {
          if (part?.inlineData?.data) chunks.push(Buffer.from(part.inlineData.data, 'base64'));
        }
        if (sc?.turnComplete) {
          if (!chunks.length) return yakunla(new Error('Gemini Live audio qaytarmadi'));
          return yakunla(null, pcm16ToWav(Buffer.concat(chunks), 24000, 1));
        }
      } catch (err) {
        yakunla(err);
      }
    };

    try {
      ws = new wsInfo.Ctor(url);
      const setup = () => ws.send(JSON.stringify({
        setup: {
          model: `models/${model}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
          },
          outputAudioTranscription: {},
          systemInstruction: {
            parts: [{
              text: `Siz ${assistantName || 'Hisobchi'} nomli o'zbekcha sun'iy intellekt yordamchisining ovozisiz. Faqat O'zbekiston adabiy o'zbek tilida gapiring. So'zlarni ravon va aniq talaffuz qiling. Raqamlar, sanalar va foizlarni shoshmasdan tushunarli ayting. Foydalanuvchiga berilgan matnni mazmunan o'zgartirmang.`
            }]
          }
        }
      }));

      if (wsInfo.turi === 'ws') {
        ws.on('open', setup);
        ws.on('message', data => xabarniQaytaIshla(data));
        ws.on('error', err => yakunla(err));
        ws.on('close', () => { if (!tugadi && !chunks.length) yakunla(new Error('Gemini Live ulanishi yopildi')); });
      } else {
        ws.addEventListener('open', setup);
        ws.addEventListener('message', e => xabarniQaytaIshla(e.data));
        ws.addEventListener('error', () => yakunla(new Error('Gemini Live WebSocket xatosi')));
        ws.addEventListener('close', () => { if (!tugadi && !chunks.length) yakunla(new Error('Gemini Live ulanishi yopildi')); });
      }
    } catch (err) {
      yakunla(err);
    }
  });
}


// ====================================================
// FAST 2.0 — doimiy Gemini Live sessiyasi + TTS prefetch/kesh
// ====================================================
const geminiLivePool = new Map();
const aiTtsCache = new Map();
const aiTtsInflight = new Map();
const AI_TTS_CACHE_MS = Math.max(30_000, Number(process.env.AI_TTS_CACHE_MS || 600_000));

function aiTtsKalit(text, voice) {
  return crypto.createHash('sha1').update(`${voice}|${String(text || '')}`).digest('hex');
}
function wsRawMatn(raw) {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  if (raw?.data && Buffer.isBuffer(raw.data)) return raw.data.toString('utf8');
  return String(raw || '');
}
function geminiLivePoolOchir(key, session) {
  if (geminiLivePool.get(key) === session) geminiLivePool.delete(key);
}
function geminiLiveSessiyaYarat(voice, assistantName) {
  const wsInfo = websocketCtorOl();
  if (!wsInfo || !process.env.GEMINI_API_KEY) throw new Error('Gemini Live WebSocket mavjud emas');
  const model = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview';
  const key = `${voice}|${assistantName || 'Hisobchi'}|${model}`;
  const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const ws = new wsInfo.Ctor(url);
  let readyResolve, readyReject;
  const session = {
    key, ws, wsInfo, voice, assistantName, model,
    ready: false, closed: false, current: null,
    chain: Promise.resolve(), lastUsed: Date.now(),
    readyPromise: new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; })
  };

  const failCurrent = err => {
    if (session.current) {
      clearTimeout(session.current.timer);
      const c = session.current; session.current = null;
      c.reject(err);
    }
  };
  const closeSession = err => {
    if (session.closed) return;
    session.closed = true;
    session.ready = false;
    geminiLivePoolOchir(key, session);
    if (!session.ready) try { readyReject(err || new Error('Gemini Live sessiyasi yopildi')); } catch (_) {}
    failCurrent(err || new Error('Gemini Live sessiyasi yopildi'));
  };
  const sendSetup = () => {
    ws.send(JSON.stringify({
      setup: {
        model: `models/${model}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
        },
        systemInstruction: {
          parts: [{ text: `Siz ${assistantName || 'Hisobchi'} nomli o'zbekcha sun'iy intellekt yordamchisining ovozisiz. Faqat adabiy o'zbek tilida, ravon, tabiiy va professional gapiring. Berilgan matnga yangi fakt qo'shmang.` }]
        }
      }
    }));
  };
  const onMessage = raw => {
    try {
      const msg = JSON.parse(wsRawMatn(raw?.data !== undefined ? raw.data : raw));
      if (msg.setupComplete && !session.ready) {
        session.ready = true;
        readyResolve(session);
        return;
      }
      const sc = msg.serverContent;
      const c = session.current;
      if (!c || !sc) return;
      for (const part of (sc?.modelTurn?.parts || [])) {
        if (part?.inlineData?.data) c.chunks.push(Buffer.from(part.inlineData.data, 'base64'));
      }
      if (sc.turnComplete) {
        clearTimeout(c.timer);
        session.current = null;
        if (!c.chunks.length) c.reject(new Error('Gemini Live audio qaytarmadi'));
        else c.resolve(pcm16ToWav(Buffer.concat(c.chunks), 24000, 1));
      }
    } catch (err) {
      failCurrent(err);
    }
  };

  if (wsInfo.turi === 'ws') {
    ws.on('open', sendSetup);
    ws.on('message', onMessage);
    ws.on('error', err => closeSession(err));
    ws.on('close', () => closeSession(new Error('Gemini Live ulanishi yopildi')));
  } else {
    ws.addEventListener('open', sendSetup);
    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', () => closeSession(new Error('Gemini Live WebSocket xatosi')));
    ws.addEventListener('close', () => closeSession(new Error('Gemini Live ulanishi yopildi')));
  }

  session.speak = text => {
    const run = async () => {
      await session.readyPromise;
      if (session.closed) throw new Error('Gemini Live sessiyasi yopilgan');
      session.lastUsed = Date.now();
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (session.current) session.current = null;
          reject(new Error('Gemini Live ovoz javobi vaqti tugadi'));
        }, 8_000);
        session.current = { resolve, reject, timer, chunks: [] };
        try {
          session.ws.send(JSON.stringify({
            realtimeInput: {
              text: `Quyidagi matnni aynan va ravon o'qing. Hech qanday yangi gap qo'shmang. MATN: ${text}`
            }
          }));
        } catch (err) {
          clearTimeout(timer); session.current = null; reject(err);
        }
      });
    };
    const p = session.chain.then(run, run);
    session.chain = p.catch(() => {});
    return p;
  };

  geminiLivePool.set(key, session);
  return session;
}

async function geminiLiveSessiyaOl(voice, assistantName) {
  if (String(process.env.GEMINI_LIVE_TTS || 'true').toLowerCase() === 'false') return null;
  const model = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview';
  const key = `${voice}|${assistantName || 'Hisobchi'}|${model}`;
  let s = geminiLivePool.get(key);
  if (!s || s.closed) s = geminiLiveSessiyaYarat(voice, assistantName);
  await s.readyPromise;
  return s;
}
async function geminiLiveSessiyaOldindanOch(voice, assistantName) {
  if (!process.env.GEMINI_API_KEY) return false;
  try { await geminiLiveSessiyaOl(voice, assistantName); return true; }
  catch (err) { console.warn('Gemini Live prewarm xatosi:', err.message); return false; }
}
async function geminiLiveOvozYarat(matn, voice, assistantName) {
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const s = await geminiLiveSessiyaOl(voice, assistantName);
    if (!s) return null;
    return await s.speak(matn);
  } catch (err) {
    console.warn("Doimiy Gemini Live sessiyasi xatosi, bir martalik ulanishga o'tildi:", err.message);
    return await geminiLiveOvozYaratBirMartalik(matn, voice, assistantName);
  }
}

function geminiAudioBlokOl(node, depth = 0) {
  if (!node || depth > 14) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = geminiAudioBlokOl(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node !== 'object') return null;

  const type = String(node.type || '').toLowerCase();
  const mimeType = String(node.mime_type || node.mimeType || '').toLowerCase();
  if ((type === 'audio' || mimeType.startsWith('audio/')) && typeof node.data === 'string' && node.data.length > 40) {
    return {
      data: node.data,
      mimeType: mimeType || 'audio/wav',
      sampleRate: Number(node.sample_rate || node.sampleRate || 24000),
      channels: Number(node.channels || 1)
    };
  }

  for (const value of Object.values(node)) {
    const hit = geminiAudioBlokOl(value, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// FAST 2.1: aniq matnni ovozga aylantirish uchun Live suhbat modelidan emas,
// Google'ning maxsus Gemini TTS modelidan foydalanamiz. Bu aynan matn o'qish uchun
// mo'ljallangan va brauzer speechSynthesis ovoziga tushib ketishni bartaraf etadi.
async function geminiTTSOvozYarat(matn, voice, assistantName) {
  if (!process.env.GEMINI_API_KEY) return null;
  const model = process.env.GEMINI_TTS_MODEL || 'gemini-3.1-flash-tts-preview';
  const input = [
    `Siz ${assistantName || 'Hisobchi'} nomli o'zbekcha sun'iy intellekt yordamchisining ovozisiz.`,
    "O'zbekiston adabiy o'zbek tilida ravon, tabiiy, aniq va professional gapiring.",
    "Raqamlar, foizlar, sanalar va tashkilot nomlarini tushunarli talaffuz qiling.",
    "Juda sekin gapirmang; tabiiy suhbat tezligida o'qing.",
    "Quyidagi MATNni aynan o'qing, yangi fakt yoki izoh qo'shmang.",
    `MATN: ${matn}`
  ].join(' ');

  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: {
      'x-goog-api-key': process.env.GEMINI_API_KEY,
      'Content-Type': 'application/json',
      'Api-Revision': '2026-05-20'
    },
    body: JSON.stringify({
      model,
      input,
      response_format: { type: 'audio' },
      generation_config: {
        speech_config: [{ voice }]
      }
    })
  });

  let payload = null;
  try { payload = await response.json(); }
  catch (_) { payload = null; }

  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || `Gemini TTS HTTP ${response.status}`;
    const err = new Error(detail);
    err.status = response.status;
    err.payload = payload;
    throw err;
  }

  // Interactions TTS `output_audio.data` orqali 24 kHz, mono, 16-bit PCM qaytaradi.
  // Google hujjatlaridagi JS/Python namunalari ham aynan shu xom PCM baytlarini WAV konteyneriga yozadi.
  const outputAudioData = payload?.output_audio?.data;
  if (typeof outputAudioData !== 'string' || outputAudioData.length < 40) {
    // Eski/alternativ javob shakllari uchun yordamchi parserni ham saqlab qolamiz.
    const audio = geminiAudioBlokOl(payload);
    if (!audio?.data) {
      const err = new Error("Gemini TTS output_audio.data qaytarmadi");
      err.payload = payload;
      throw err;
    }
    const alt = Buffer.from(audio.data, 'base64');
    if (!alt.length) throw new Error("Gemini TTS bo'sh audio qaytardi");
    if (audio.mimeType.includes('wav')) return { wav: alt, model, provider: 'gemini-tts' };
    return { wav: pcm16ToWav(alt, audio.sampleRate || 24000, audio.channels || 1), model, provider: 'gemini-tts' };
  }

  const pcm = Buffer.from(outputAudioData, 'base64');
  if (!pcm.length) throw new Error("Gemini TTS bo'sh audio qaytardi");
  return { wav: pcm16ToWav(pcm, 24000, 1), model, provider: 'gemini-tts' };
}

async function aiOvozOldindanTayyorla(speechText, voice, assistantName) {
  const text = String(speechText || '').trim();
  if (!text || !process.env.GEMINI_API_KEY) return null;
  const key = aiTtsKalit(text, voice);
  const hit = aiTtsCache.get(key);
  if (hit && Date.now() - hit.vaqt < AI_TTS_CACHE_MS) return hit.wav;
  if (aiTtsInflight.has(key)) return await aiTtsInflight.get(key);

  const p = (async () => {
    let result = null;
    try {
      result = await geminiTTSOvozYarat(text, voice, assistantName);
    } catch (ttsErr) {
      console.error('Gemini 3.1 TTS xatosi:', ttsErr.message, ttsErr.payload || '');
      // Fast 2.2: sekin Live fallbackga yashirin o'tmaymiz. Asl TTS xatosini yuqoriga uzatamiz.
      // Shu bilan 8-10 soniyalik qo'shimcha kutish yo'qoladi va muammo aniq ko'rinadi.
      throw ttsErr;
    }

    if (result?.wav) {
      aiTtsCache.set(key, { vaqt: Date.now(), wav: result.wav, provider: result.provider, model: result.model });
      if (aiTtsCache.size > 40) aiTtsCache.delete(aiTtsCache.keys().next().value);
      return result.wav;
    }
    return null;
  })().finally(() => aiTtsInflight.delete(key));

  aiTtsInflight.set(key, p);
  return await p;
}

setInterval(() => {
  const now = Date.now();
  for (const [k,v] of aiTtsCache) if (now - v.vaqt > AI_TTS_CACHE_MS) aiTtsCache.delete(k);
  for (const [k,sess] of geminiLivePool) {
    if (now - sess.lastUsed > 4 * 60_000) {
      try { sess.ws.close(); } catch (_) {}
      geminiLivePool.delete(k);
    }
  }
}, 60_000).unref?.();

app.post('/api/aiSpeech', async (req, res) => {
  const user = await checkAuth(req);
  if (!user) return res.status(401).json({ ok: false, xato: "Ruxsat yo'q" });
  if (!process.env.GEMINI_API_KEY) return res.status(503).json({ ok: false, xato: "GEMINI_API_KEY serverda sozlanmagan" });

  try {
    const cfg = await aiConfigOl();
    const rawText = String(req.body.text || '').trim().slice(0, 4096);
    if (!rawText) return res.status(400).json({ ok: false, xato: "Ovoz uchun matn bo'sh" });
    const speechText = req.body.normalized === true ? rawText : speechTextTayyorla(rawText);
    const requestedVoice = String(req.body.voice || '').trim();
    const voice = AI_TTS_VOICES.has(requestedVoice) ? requestedVoice : cfg.ovoz;

    const boshlandi = Date.now();
    const ttsKey = aiTtsKalit(speechText, voice);
    const oldHit = aiTtsCache.get(ttsKey);
    let wav = null;
    try {
      wav = await aiOvozOldindanTayyorla(speechText, voice, cfg.ism);
    } catch (voiceErr) {
      console.warn('Gemini ovoz xatosi:', voiceErr.message);
      return res.status(502).json({ ok: false, xato: `Gemini ovozini yaratib bo'lmadi: ${voiceErr.message}` });
    }
    if (!wav) return res.status(503).json({ ok: false, xato: "Gemini ovoz xizmati audio qaytarmadi" });

    const cacheEntry = aiTtsCache.get(ttsKey);
    const provider = cacheEntry?.provider || 'gemini-tts';
    const voiceModel = cacheEntry?.model || process.env.GEMINI_TTS_MODEL || 'gemini-3.1-flash-tts-preview';
    const elapsed = Date.now() - boshlandi;

    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-AI-Voice', provider === 'gemini-live' ? 'gemini-live-fast2.1' : 'gemini-tts-fast2.1');
    res.setHeader('X-AI-Provider', provider === 'gemini-live' ? 'Google-Gemini-Live' : 'Google-Gemini-TTS');
    res.setHeader('X-AI-Model', voiceModel);
    res.setHeader('X-AI-Voice-Name', voice);
    res.setHeader('X-AI-Cache', oldHit ? 'HIT' : 'MISS');
    res.setHeader('X-AI-Time-Ms', String(elapsed));
    console.log(`[AI VOICE] provider=${provider} model=${voiceModel} voice=${voice} cache=${oldHit ? 'HIT' : 'MISS'} ms=${elapsed}`);
    res.send(wav);
  } catch (err) {
    console.error('Gemini ovoz xatosi:', err.message, err.payload || '');
    res.status(err.status || 500).json({ ok: false, xato: err.message || "Sun'iy intellekt ovozini yaratib bo'lmadi" });
  }
});

// SERVERNI ISHGA TUSHIRISH
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SysOne Backend server ${PORT}-portda muvaffaqiyatli ishga tushdi!`);
});
