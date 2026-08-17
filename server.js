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
          'mfy_boshqar', 'kategoriya_boshqar', 'excel_export', 'sozlamalar',
          'vazifa_boshqar', 'ai_boshqar'
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


function userHasPermission(user, ...permissions) {
  if (!user) return false;
  if (user.rol === 'superadmin') return true;
  const mavjud = new Set(ruxsatlarniParse(user.ruxsatlar));
  return permissions.some(p => mavjud.has(p));
}

function userMfyScope(user) {
  if (!user || user.rol === 'superadmin') return '';
  // Nazoratchi doimo o'z tashkilotida. Admin uchun mfy_id berilgan bo'lsa, u ham shu scope bilan ishlaydi.
  if ((user.rol === 'nazoratchi' || user.rol === 'admin') && user.mfyId) return String(user.mfyId);
  return '';
}

function permissionDenied(res, matn = "Bu amal uchun ruxsat yo'q") {
  return res.status(403).json({ ok: false, xato: matn });
}

async function xodimScopeTekshir(user, xodimId) {
  const scope = userMfyScope(user);
  const { data, error } = await supabase.from('xodimlar').select('id,mfy_id').eq('id', xodimId).maybeSingle();
  if (error || !data) return { ok: false, xato: "Xodim topilmadi" };
  if (scope && String(data.mfy_id || '') !== scope) return { ok: false, xato: "Bu xodim sizning tashkilotingizga tegishli emas" };
  return { ok: true, xodim: data };
}

function expoTokenmi(token) {
  const t = String(token || '').trim();
  return /^(Expo|Exponent)PushToken\[[^\]]+\]$/.test(t);
}

async function sozlamaQiymatOl(kalit, fallback = null) {
  try {
    const { data, error } = await supabase.from('sozlamalar').select('qiymat').eq('kalit', kalit).maybeSingle();
    if (error || !data) return fallback;
    return data.qiymat ?? fallback;
  } catch (_) { return fallback; }
}

async function sozlamaQiymatSaqla(kalit, qiymat) {
  const { error } = await supabase.from('sozlamalar').upsert([{ kalit, qiymat }], { onConflict: 'kalit' });
  if (error) throw error;
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
  const validTokens = [...new Set((tokens || []).map(t => String(t || '').trim()).filter(expoTokenmi))];
  if (!validTokens.length) return { requested: 0, sent: 0, failed: 0, tickets: [], errors: ['Expo push token topilmadi'] };

  // Expo bir so'rovda ko'pi bilan 100 ta xabarni tavsiya qiladi; katta guruhlarni bo'lib yuboramiz.
  const chunks = [];
  for (let i = 0; i < validTokens.length; i += 100) chunks.push(validTokens.slice(i, i + 100));
  const allTickets = [], errors = [];
  let sent = 0, failed = 0;

  for (const chunk of chunks) {
    const messages = chunk.map(token => ({
      to: token,
      sound: 'default',
      title: String(title || 'Xisobot Nazorat'),
      body: String(body || ''),
      data: extraData || {},
      priority: 'high'
    }));

    try {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(messages)
      });
      const raw = await response.text();
      let payload = null;
      try { payload = raw ? JSON.parse(raw) : null; } catch (_) {}

      if (!response.ok) {
        console.error('Expo Push API xatosi:', response.status, raw);
        failed += chunk.length;
        errors.push(raw || `HTTP ${response.status}`);
        continue;
      }
      const tickets = Array.isArray(payload?.data) ? payload.data : [];
      allTickets.push(...tickets);
      const okCount = tickets.filter(t => t?.status === 'ok').length;
      sent += okCount;
      failed += Math.max(0, chunk.length - okCount);
      errors.push(...tickets.filter(t => t?.status === 'error').map(t => t?.message || t?.details?.error || 'Push xatosi'));
    } catch (err) {
      console.error("Push jo'natish tarmog'ida xato:", err);
      failed += chunk.length;
      errors.push(err.message);
    }
  }

  return { requested: validTokens.length, sent, failed, tickets: allTickets, errors };
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
  if (!user) return res.status(401).json({ ok: false, xato: "Ruxsat yo'q" });

  try {
    let xQuery = supabase.from('xodimlar').select('*').order('fio', { ascending: true });
    const scope = userMfyScope(user);
    if (scope) xQuery = xQuery.eq('mfy_id', scope);

    const [resXodim, resMfy, resKat] = await Promise.all([
      xQuery,
      supabase.from('mfy').select('id, nomi'),
      supabase.from('kategoriyalar').select('id, nomi')
    ]);
    if (resXodim.error) throw resXodim.error;

    const mfyMap = (resMfy.data || []).reduce((acc, m) => ({ ...acc, [m.id]: m.nomi }), {});
    const katMap = (resKat.data || []).reduce((acc, k) => ({ ...acc, [k.id]: k.nomi }), {});
    const xodimlar = (resXodim.data || []).map(x => ({
      id: x.id, fio: x.fio, pinfl: x.pinfl, tel: x.tel,
      mfyId: x.mfy_id, mfyNomi: mfyMap[x.mfy_id] || '',
      kategoriyaId: x.kategoriya_id, kategoriyaNomi: katMap[x.kategoriya_id] || '',
      holat: x.holat, ish_holati: x.ish_holati || 'ishda',
      deviceBor: expoTokenmi(x.device_id), deviceTokenHolati: x.device_id ? (expoTokenmi(x.device_id) ? 'push' : 'device-id') : 'yoq',
      unread: 0, soni: 0
    }));
    res.json({ ok: true, xodimlar });
  } catch (err) {
    res.json({ ok: false, xato: err.message });
  }
});

app.get('/api/adminlar', async (req, res) => {
  const u = await checkAuth(req);
  if (!u || u.rol !== 'superadmin') return permissionDenied(res);
  const { data, error } = await supabase.from('adminlar').select('*').order('fio', { ascending: true });
  if (error) return res.json({ ok: false, xato: error.message });
  const adminlar = (data || []).map(a => ({
    id: a.id, fio: a.fio, login: a.login, rol: a.rol, mfyId: a.mfy_id,
    ruxsatlar: ruxsatlarniParse(a.ruxsatlar), kalit: a.kalit, holat: a.holat
  }));
  res.json({ ok: true, adminlar });
});

app.get('/api/auditlar', async (req, res) => {
  const u = await checkAuth(req);
  if (!u || u.rol !== 'superadmin') return permissionDenied(res);
  const { data, error } = await supabase.from('audit_log').select('*').order('vaqt', { ascending: false }).limit(500);
  if (error) return res.json({ ok: false, xato: error.message });
  const audit = (data || []).map(a => ({ vaqt: new Date(a.vaqt).toLocaleString('uz-UZ'), kim: a.kim, amal: a.amal, tafsilot: a.tafsilot }));
  res.json({ ok: true, audit });
});

// CRUD AMALLARI
app.post('/api/xodimQosh', async (req, res) => {
  const u = await checkAuth(req);
  if (!u || !userHasPermission(u, 'xodim_qosh')) return permissionDenied(res);
  try {
    let { fio, pinfl, parol, tel, mfyId, kategoriyaId, ishHolati } = req.body;
    fio = String(fio || '').trim(); pinfl = String(pinfl || '').trim();
    if (!fio || !pinfl) return res.json({ ok: false, xato: "F.I.Sh. va JSHSHIR/PINFL majburiy" });
    if (!/^\d{14}$/.test(pinfl)) return res.json({ ok: false, xato: "JSHSHIR/PINFL 14 ta raqamdan iborat bo'lishi kerak" });
    const scope = userMfyScope(u);
    if (scope) {
      if (mfyId && String(mfyId) !== scope) return permissionDenied(res, "Boshqa tashkilotga xodim qo'sha olmaysiz");
      mfyId = scope;
    }
    const { data: old } = await supabase.from('xodimlar').select('id').eq('pinfl', pinfl).maybeSingle();
    if (old) return res.json({ ok: false, xato: "Bu JSHSHIR/PINFL bilan xodim allaqachon mavjud" });

    const id = genId('X');
    const { error } = await supabase.from('xodimlar').insert([{
      id, fio, pinfl, parol_hash: parolHash(parol || '1234'), tel: tel || '', mfy_id: mfyId || null,
      kategoriya_id: kategoriyaId || null, holat: 'faol', ish_holati: ishHolati || 'ishda'
    }]);
    if (error) return res.json({ ok: false, xato: error.message });
    await auditLog(u.fio, 'XODIM_QOSHILDI', `${id} - ${fio}`);
    res.json({ ok: true, id });
  } catch (err) { res.json({ ok: false, xato: err.message }); }
});

app.post('/api/xodimTahrir', async (req, res) => {
  const u = await checkAuth(req);
  if (!u) return res.status(401).json({ ok: false, xato: "Ruxsat yo'q" });
  const faqatHolat = Object.keys(req.body || {}).filter(k => !['kalit','xodimId'].includes(k)).every(k => k === 'holat');
  if (faqatHolat) {
    if (!userHasPermission(u, 'xodim_blok', 'xodim_tahrir')) return permissionDenied(res);
  } else if (!userHasPermission(u, 'xodim_tahrir')) return permissionDenied(res);

  try {
    const { xodimId, fio, pinfl, parol, tel, mfyId, kategoriyaId, holat, ishHolati } = req.body;
    const scopeTekshir = await xodimScopeTekshir(u, xodimId);
    if (!scopeTekshir.ok) return permissionDenied(res, scopeTekshir.xato);
    const scope = userMfyScope(u);
    if (scope && mfyId !== undefined && String(mfyId || '') !== scope) return permissionDenied(res, "Xodimni boshqa tashkilotga o'tkaza olmaysiz");

    const updateData = {};
    if (fio !== undefined && String(fio).trim()) updateData.fio = String(fio).trim();
    if (pinfl !== undefined) {
      const p = String(pinfl || '').trim();
      if (!/^\d{14}$/.test(p)) return res.json({ ok: false, xato: "JSHSHIR/PINFL 14 ta raqamdan iborat bo'lishi kerak" });
      const { data: old } = await supabase.from('xodimlar').select('id').eq('pinfl', p).neq('id', xodimId).maybeSingle();
      if (old) return res.json({ ok: false, xato: "Bu JSHSHIR/PINFL boshqa xodimga biriktirilgan" });
      updateData.pinfl = p;
    }
    if (parol) updateData.parol_hash = parolHash(parol);
    if (tel !== undefined) updateData.tel = tel;
    if (mfyId !== undefined) updateData.mfy_id = scope || mfyId || null;
    if (kategoriyaId !== undefined) updateData.kategoriya_id = kategoriyaId || null;
    if (holat !== undefined) updateData.holat = holat;
    if (ishHolati !== undefined) updateData.ish_holati = ishHolati || 'ishda';
    if (!Object.keys(updateData).length) return res.json({ ok: false, xato: "O'zgartiriladigan ma'lumot yo'q" });

    const { error } = await supabase.from('xodimlar').update(updateData).eq('id', xodimId);
    if (error) return res.json({ ok: false, xato: error.message });
    await auditLog(u.fio, 'XODIM_TAHRIR', `${xodimId} ${Object.keys(updateData).join(',')}`);
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false, xato: err.message }); }
});

app.post('/api/deviceReset', async (req, res) => {
  const u = await checkAuth(req);
  if (!u || !userHasPermission(u, 'xodim_tahrir')) return permissionDenied(res);
  const scopeTekshir = await xodimScopeTekshir(u, req.body.xodimId);
  if (!scopeTekshir.ok) return permissionDenied(res, scopeTekshir.xato);
  const { error } = await supabase.from('xodimlar').update({ device_id: null }).eq('id', req.body.xodimId);
  if (error) return res.json({ ok: false, xato: error.message });
  await auditLog(u.fio, 'DEVICE_RESET', req.body.xodimId);
  res.json({ ok: true });
});

app.post('/api/mfyQosh', async (req, res) => {
  const u = await checkAuth(req);
  if (!u || !userHasPermission(u, 'mfy_boshqar') || userMfyScope(u)) return permissionDenied(res);
  const id = genId('M');
  const { error } = await supabase.from('mfy').insert([{ id, nomi: String(req.body.nomi || '').trim(), rahbar: req.body.rahbar || '', tel: req.body.tel || '' }]);
  if (error) return res.json({ ok: false, xato: error.message });
  await auditLog(u.fio, 'MFY_QOSHILDI', req.body.nomi); res.json({ ok: true, id });
});

app.post('/api/mfyTahrir', async (req, res) => {
  const u = await checkAuth(req);
  if (!u || !userHasPermission(u, 'mfy_boshqar')) return permissionDenied(res);
  const scope = userMfyScope(u);
  if (scope && String(req.body.mfyId) !== scope) return permissionDenied(res);
  const { error } = await supabase.from('mfy').update({ nomi: req.body.nomi, rahbar: req.body.rahbar || '', tel: req.body.tel || '' }).eq('id', req.body.mfyId);
  if (error) return res.json({ ok: false, xato: error.message });
  await auditLog(u.fio, 'MFY_TAHRIR', req.body.mfyId); res.json({ ok: true });
});

app.post('/api/mfyOchir', async (req, res) => {
  const u = await checkAuth(req);
  if (!u || !userHasPermission(u, 'mfy_boshqar') || userMfyScope(u)) return permissionDenied(res);
  const { error } = await supabase.from('mfy').delete().eq('id', req.body.mfyId);
  if (error) return res.json({ ok: false, xato: error.message });
  await auditLog(u.fio, 'MFY_OCHIRILDI', req.body.mfyId); res.json({ ok: true });
});

app.post('/api/kategoriyaQosh', async (req, res) => {
  const u = await checkAuth(req); if (!u || !userHasPermission(u, 'kategoriya_boshqar')) return permissionDenied(res);
  const id = genId('K');
  const { error } = await supabase.from('kategoriyalar').insert([{ id, nomi: String(req.body.nomi || '').trim(), tavsif: req.body.tavsif || '' }]);
  if (error) return res.json({ ok: false, xato: error.message });
  await auditLog(u.fio, 'KATEGORIYA_QOSHILDI', req.body.nomi); res.json({ ok: true, id });
});

app.post('/api/kategoriyaTahrir', async (req, res) => {
  const u = await checkAuth(req); if (!u || !userHasPermission(u, 'kategoriya_boshqar')) return permissionDenied(res);
  const { error } = await supabase.from('kategoriyalar').update({ nomi: req.body.nomi, tavsif: req.body.tavsif || '' }).eq('id', req.body.kategoriyaId);
  if (error) return res.json({ ok: false, xato: error.message });
  await auditLog(u.fio, 'KATEGORIYA_TAHRIR', req.body.kategoriyaId); res.json({ ok: true });
});

app.post('/api/kategoriyaOchir', async (req, res) => {
  const u = await checkAuth(req); if (!u || !userHasPermission(u, 'kategoriya_boshqar')) return permissionDenied(res);
  const { error } = await supabase.from('kategoriyalar').delete().eq('id', req.body.kategoriyaId);
  if (error) return res.json({ ok: false, xato: error.message });
  await auditLog(u.fio, 'KATEGORIYA_OCHIRILDI', req.body.kategoriyaId); res.json({ ok: true });
});

app.post('/api/adminQosh', async (req, res) => {
  const u = await checkAuth(req); if (!u || u.rol !== 'superadmin') return permissionDenied(res);
  try {
    const { fio, login, parol, rol, mfyId, ruxsatlar } = req.body;
    if (!['admin','nazoratchi'].includes(rol)) return res.json({ ok: false, xato: "Rol noto'g'ri" });
    if (rol === 'nazoratchi' && !mfyId) return res.json({ ok: false, xato: "Nazoratchi uchun tashkilot majburiy" });
    if (!String(login || '').trim() || !String(fio || '').trim() || String(parol || '').length < 6) return res.json({ ok:false, xato:'F.I.Sh., login va kamida 6 belgili parol majburiy' });
    const { data: old } = await supabase.from('adminlar').select('id').eq('login', String(login).trim()).maybeSingle();
    if (old) return res.json({ ok:false, xato:'Bu login band' });
    const id = genId('A');
    const kalit = tasodifiyKalit(rol === 'admin' ? 'ADM' : 'NZR');
    const { error } = await supabase.from('adminlar').insert([{
      id, fio: String(fio).trim(), login: String(login).trim(), parol_hash: parolHash(parol), rol, mfy_id: mfyId || null,
      ruxsatlar: ruxsatlarniSaqlashFormat(ruxsatlar), kalit, holat: 'faol'
    }]);
    if (error) return res.json({ ok: false, xato: error.message });
    await auditLog(u.fio, 'ADMIN_QOSHILDI', `${login} (${rol})`); res.json({ ok: true });
  } catch (err) { res.json({ ok:false, xato:err.message }); }
});

app.post('/api/adminTahrir', async (req, res) => {
  const u = await checkAuth(req); if (!u || u.rol !== 'superadmin') return permissionDenied(res);
  try {
    const { adminId, fio, login, rol, mfyId, holat, parol, ruxsatlar } = req.body;
    if (rol !== undefined && !['admin','nazoratchi'].includes(rol)) return res.json({ ok:false, xato:"Rol noto'g'ri" });
    if (rol === 'nazoratchi' && !mfyId) return res.json({ ok:false, xato:'Nazoratchi uchun tashkilot majburiy' });
    if (login !== undefined) {
      const l = String(login).trim();
      const { data: old } = await supabase.from('adminlar').select('id').eq('login', l).neq('id', adminId).maybeSingle();
      if (old) return res.json({ ok:false, xato:'Bu login boshqa admin tomonidan ishlatilmoqda' });
    }
    const updateData = {};
    if (fio !== undefined) updateData.fio = String(fio).trim();
    if (login !== undefined) updateData.login = String(login).trim();
    if (rol !== undefined) updateData.rol = rol;
    if (mfyId !== undefined) updateData.mfy_id = mfyId || null;
    if (holat !== undefined) updateData.holat = holat;
    if (parol) updateData.parol_hash = parolHash(parol);
    if (ruxsatlar !== undefined) updateData.ruxsatlar = ruxsatlarniSaqlashFormat(ruxsatlar);
    const { error } = await supabase.from('adminlar').update(updateData).eq('id', adminId);
    if (error) return res.json({ ok:false, xato:error.message });
    await auditLog(u.fio, 'ADMIN_TAHRIR', `${adminId}: ${Object.keys(updateData).join(',')}`); res.json({ ok:true });
  } catch (err) { res.json({ ok:false, xato:err.message }); }
});

app.post('/api/adminParolTiklash', async (req, res) => {
  const u = await checkAuth(req); if (!u || u.rol !== 'superadmin') return permissionDenied(res);
  if (String(req.body.yangiParol || '').length < 6) return res.json({ok:false, xato:'Parol kamida 6 belgi'});
  const { error } = await supabase.from('adminlar').update({ parol_hash: parolHash(req.body.yangiParol) }).eq('id', req.body.adminId);
  if (error) return res.json({ ok:false, xato:error.message });
  await auditLog(u.fio, 'ADMIN_PAROL_TIKLASH', req.body.adminId); res.json({ ok:true });
});

app.post('/api/adminOchir', async (req, res) => {
  const u = await checkAuth(req); if (!u || u.rol !== 'superadmin') return permissionDenied(res);
  const { error } = await supabase.from('adminlar').delete().eq('id', req.body.adminId);
  if (error) return res.json({ ok:false, xato:error.message });
  await auditLog(u.fio, 'ADMIN_OCHIRILDI', req.body.adminId); res.json({ ok:true });
});

app.post('/api/eslatmaYuborGuruh', async (req, res) => {
  const u = await checkAuth(req); if (!u || !userHasPermission(u, 'eslatma_yuborish')) return permissionDenied(res);
  try {
    const xodimIdlar = Array.isArray(req.body.xodimIdlar) ? req.body.xodimIdlar.map(String) : [];
    const matn = String(req.body.matn || '').trim();
    if (!xodimIdlar.length || !matn) return res.json({ ok:false, xato:'Xodimlar va xabar matni majburiy' });
    let q = supabase.from('xodimlar').select('id,fio,mfy_id,device_id').in('id', xodimIdlar);
    const scope = userMfyScope(u); if (scope) q = q.eq('mfy_id', scope);
    const { data: xs, error } = await q; if (error) throw error;
    const tokens = (xs || []).map(x => x.device_id).filter(Boolean);
    const push = await sendExpoPush(tokens, 'SysOne: Yangi eslatma', matn, { turi:'eslatma' });
    await auditLog(u.fio, 'ESLATMA_GURUH', `${push.sent}/${push.requested} muvaffaqiyatli. Matn: ${matn}`);
    res.json({ ok:true, yuborildi:push.sent, urinish:push.requested, muvaffaqiyatsiz:push.failed, pushXatolar:push.errors });
  } catch (err) { res.json({ ok:false, xato:err.message }); }
});

// ====================================================
// 4. VAZIFALAR MODULI (TASK MANAGEMENT)
// ====================================================
app.post('/api/vazifaQosh', async (req, res) => {
  const u = await checkAuth(req); if (!u || !userHasPermission(u, 'vazifa_boshqar', 'xodim_tahrir')) return permissionDenied(res);
  try {
    const { xodimId, matn, muddat } = req.body;
    const scopeTekshir = await xodimScopeTekshir(u, xodimId);
    if (!scopeTekshir.ok) return permissionDenied(res, scopeTekshir.xato);
    const { data: x, error: xErr } = await supabase.from('xodimlar').select('fio,device_id').eq('id', xodimId).single();
    if (xErr || !x) return res.json({ok:false, xato:'Xodim topilmadi'});
    const id = genId('V');
    const { error } = await supabase.from('vazifalar').insert([{
      id, xodim_id:xodimId, xodim_fio:x.fio, matn:String(matn || '').trim(), muddat:muddat || null, holat:'kutilmoqda', sana:tashkentBugun()
    }]);
    if (error) return res.json({ok:false, xato:error.message});
    const push = x.device_id ? await sendExpoPush([x.device_id], 'Yangi vazifa biriktirildi', matn, { turi:'vazifa', id }) : {sent:0,requested:0,failed:0,errors:[]};
    await auditLog(u.fio, 'VAZIFA_QOSHILDI', `${x.fio} ga: ${matn}`);
    res.json({ok:true, id, push:{yuborildi:push.sent, urinish:push.requested, xatolar:push.errors}});
  } catch (err) { res.json({ok:false, xato:err.message}); }
});

app.get('/api/vazifalar', async (req, res) => {
  const u = await checkAuth(req); if (!u || !userHasPermission(u, 'vazifa_boshqar', 'xodim_tahrir', 'xodim_qosh')) return permissionDenied(res);
  try {
    let query = supabase.from('vazifalar').select('*').order('sana', { ascending:false });
    const scope = userMfyScope(u);
    if (scope) {
      const { data: xs, error:xErr } = await supabase.from('xodimlar').select('id').eq('mfy_id', scope);
      if (xErr) throw xErr;
      const ids=(xs || []).map(x=>x.id);
      if (!ids.length) return res.json({ok:true,vazifalar:[]});
      query=query.in('xodim_id', ids);
    }
    const { data, error } = await query; if (error) throw error;
    res.json({ok:true, vazifalar:data || []});
  } catch (err) { res.json({ok:false,xato:err.message}); }
});

app.post('/api/vazifaOchir', async (req, res) => {
  const u = await checkAuth(req); if (!u || !userHasPermission(u, 'vazifa_boshqar', 'xodim_tahrir')) return permissionDenied(res);
  const { data:v } = await supabase.from('vazifalar').select('xodim_id').eq('id', req.body.vazifaId).maybeSingle();
  if (!v) return res.json({ok:false,xato:'Vazifa topilmadi'});
  const scopeTekshir=await xodimScopeTekshir(u,v.xodim_id); if(!scopeTekshir.ok) return permissionDenied(res,scopeTekshir.xato);
  const { error } = await supabase.from('vazifalar').delete().eq('id', req.body.vazifaId);
  if (error) return res.json({ok:false,xato:error.message});
  await auditLog(u.fio,'VAZIFA_OCHIRILDI',req.body.vazifaId); res.json({ok:true});
});

// SOZLAMALAR VA BILDIRISHNOMALAR
app.get('/api/sozlamaOl', async (req, res) => {
  const u = await checkAuth(req); if (!u) return res.status(401).json({ok:false,xato:"Ruxsat yo'q"});
  const v = await sozlamaQiymatOl('INTERVAL_DAQIQA', 1);
  res.json({ ok:true, interval:Number(v || 1) });
});

app.post('/api/sozlamaSaqla', async (req, res) => {
  const u = await checkAuth(req); if (!u || !userHasPermission(u,'sozlamalar')) return permissionDenied(res);
  await sozlamaQiymatSaqla('INTERVAL_DAQIQA', Number(req.body.interval || 1));
  await auditLog(u.fio,'SOZLAMA_O_ZGARTIRILDI',`Interval: ${req.body.interval}`); res.json({ok:true});
});

app.get('/api/bildirishnomaSozlama', async (req, res) => {
  const u = await checkAuth(req); if (!u) return res.status(401).json({ok:false,xato:"Ruxsat yo'q"});
  const raw = await sozlamaQiymatOl('BILDIRISHNOMA', '');
  let sozlama={matn:'Hisobotni yuklashni unutmang!',interval:60};
  try { if(raw) sozlama={...sozlama,...JSON.parse(raw)}; } catch(_) {}
  res.json({ok:true,sozlama});
});

app.post('/api/bildirishnomaSozla', async (req, res) => {
  const u = await checkAuth(req); if (!u || !userHasPermission(u,'eslatma_yuborish','sozlamalar')) return permissionDenied(res);
  const sozlama={matn:String(req.body.matn || '').trim(),interval:Math.max(1,Number(req.body.interval || 60))};
  await sozlamaQiymatSaqla('BILDIRISHNOMA',JSON.stringify(sozlama));
  await auditLog(u.fio,'BILDIRISHNOMA_SOZLANDI',sozlama.matn); res.json({ok:true});
});

const DEFAULT_AI_CONFIG = { nomi:'Hisobchi', wakeWord:true, faqatIsmBilan:false, ovozliJavob:true, til:'uz-UZ' };
const DEFAULT_AI_SAVOLLAR = [
  {id:'Q1',matn:"Bugungi asosiy e'tibor talab qiladigan holatlarni qisqa aytib ber",faol:true,tartib:1},
  {id:'Q2',matn:"Qaysi tashkilotga birinchi navbatda e'tibor berish kerak?",faol:true,tartib:2},
  {id:'Q3',matn:"Bugun rahbar sifatida qaysi 3 ta amaliy ishni qilishim kerak?",faol:true,tartib:3}
];

async function aiSozlamalarOl() {
  let config={...DEFAULT_AI_CONFIG}, savollar=DEFAULT_AI_SAVOLLAR.map(x=>({...x}));
  try { const raw=await sozlamaQiymatOl('AI_CONFIG',''); if(raw) config={...config,...JSON.parse(raw)}; } catch(_) {}
  try { const raw=await sozlamaQiymatOl('AI_SAVOLLAR',''); if(raw){ const arr=JSON.parse(raw); if(Array.isArray(arr)) savollar=arr; } } catch(_) {}
  savollar=savollar.map((q,i)=>({id:String(q.id || genId('Q')),matn:String(q.matn || '').trim(),faol:q.faol!==false,tartib:Number(q.tartib || i+1)})).filter(q=>q.matn).sort((a,b)=>a.tartib-b.tartib);
  return {config,savollar};
}

app.get('/api/aiSozlamalar', async (req,res)=>{
  const u=await checkAuth(req); if(!u) return res.status(401).json({ok:false,xato:"Ruxsat yo'q"});
  const data=await aiSozlamalarOl(); res.json({ok:true,...data});
});
app.get('/api/aiSavollar', async (req,res)=>{
  const u=await checkAuth(req); if(!u) return res.status(401).json({ok:false,xato:"Ruxsat yo'q"});
  const data=await aiSozlamalarOl(); res.json({ok:true,savollar:data.savollar.filter(q=>q.faol)});
});
app.post('/api/aiSozlamaSaqla', async (req,res)=>{
  const u=await checkAuth(req); if(!u || !userHasPermission(u,'ai_boshqar','sozlamalar')) return permissionDenied(res);
  const old=(await aiSozlamalarOl()).config;
  const config={...old,
    nomi:String(req.body.nomi ?? old.nomi).trim().slice(0,40) || 'Hisobchi',
    wakeWord:req.body.wakeWord !== undefined ? !!req.body.wakeWord : old.wakeWord,
    faqatIsmBilan:req.body.faqatIsmBilan !== undefined ? !!req.body.faqatIsmBilan : old.faqatIsmBilan,
    ovozliJavob:req.body.ovozliJavob !== undefined ? !!req.body.ovozliJavob : old.ovozliJavob,
    til:String(req.body.til || old.til || 'uz-UZ').slice(0,16)
  };
  await sozlamaQiymatSaqla('AI_CONFIG',JSON.stringify(config)); await auditLog(u.fio,'AI_SOZLAMA',config.nomi); res.json({ok:true,config});
});
async function aiSavollarSaqla(savollar){ await sozlamaQiymatSaqla('AI_SAVOLLAR',JSON.stringify(savollar)); }
app.post('/api/aiSavolQosh', async (req,res)=>{
  const u=await checkAuth(req); if(!u || !userHasPermission(u,'ai_boshqar','sozlamalar')) return permissionDenied(res);
  const data=await aiSozlamalarOl(); const matn=String(req.body.matn || '').trim(); if(!matn) return res.json({ok:false,xato:'Savol matni majburiy'});
  const q={id:genId('Q'),matn:matn.slice(0,300),faol:true,tartib:data.savollar.length+1}; data.savollar.push(q); await aiSavollarSaqla(data.savollar); await auditLog(u.fio,'AI_SAVOL_QOSH',matn); res.json({ok:true,savol:q});
});
app.post('/api/aiSavolTahrir', async (req,res)=>{
  const u=await checkAuth(req); if(!u || !userHasPermission(u,'ai_boshqar','sozlamalar')) return permissionDenied(res);
  const data=await aiSozlamalarOl(); const q=data.savollar.find(x=>String(x.id)===String(req.body.id)); if(!q) return res.json({ok:false,xato:'Savol topilmadi'});
  if(req.body.matn!==undefined){ const m=String(req.body.matn).trim(); if(!m) return res.json({ok:false,xato:'Savol bo\'sh bo\'lmasin'}); q.matn=m.slice(0,300); }
  if(req.body.faol!==undefined) q.faol=!!req.body.faol; await aiSavollarSaqla(data.savollar); await auditLog(u.fio,'AI_SAVOL_TAHRIR',q.id); res.json({ok:true,savol:q});
});
app.post('/api/aiSavolHolat', async (req,res)=>{
  req.body.faol=!!req.body.faol;
  const u=await checkAuth(req); if(!u || !userHasPermission(u,'ai_boshqar','sozlamalar')) return permissionDenied(res);
  const data=await aiSozlamalarOl(); const q=data.savollar.find(x=>String(x.id)===String(req.body.id)); if(!q) return res.json({ok:false,xato:'Savol topilmadi'}); q.faol=req.body.faol; await aiSavollarSaqla(data.savollar); res.json({ok:true});
});
app.post('/api/aiSavolOchir', async (req,res)=>{
  const u=await checkAuth(req); if(!u || !userHasPermission(u,'ai_boshqar','sozlamalar')) return permissionDenied(res);
  const data=await aiSozlamalarOl(); const old=data.savollar.length; data.savollar=data.savollar.filter(x=>String(x.id)!==String(req.body.id)); if(data.savollar.length===old) return res.json({ok:false,xato:'Savol topilmadi'}); data.savollar.forEach((q,i)=>q.tartib=i+1); await aiSavollarSaqla(data.savollar); await auditLog(u.fio,'AI_SAVOL_OCHIR',req.body.id); res.json({ok:true});
});
app.post('/api/aiSavolTartib', async (req,res)=>{
  const u=await checkAuth(req); if(!u || !userHasPermission(u,'ai_boshqar','sozlamalar')) return permissionDenied(res);
  const ids=Array.isArray(req.body.idlar)?req.body.idlar.map(String):[]; const data=await aiSozlamalarOl(); const map=new Map(data.savollar.map(q=>[String(q.id),q])); const ordered=[]; ids.forEach(id=>{if(map.has(id)){ordered.push(map.get(id));map.delete(id)}}); ordered.push(...map.values()); ordered.forEach((q,i)=>q.tartib=i+1); await aiSavollarSaqla(ordered); res.json({ok:true,savollar:ordered});
});

// ====================================================
// 5. MOBIL ILOVA VA HISOBOT API'LARI
// ====================================================
app.post('/api/xodim-login', async (req, res) => {
  try {
    const { pinfl, parol, deviceId, pushToken, expoPushToken } = req.body;
    const { data:xodim, error } = await supabase.from('xodimlar').select('*').eq('pinfl', String(pinfl || '').trim()).single();
    if (error || !xodim) return res.json({ok:false,xato:"PINFL yoki parol noto'g'ri"});
    if (xodim.holat !== 'faol') return res.json({ok:false,xato:'Hisob bloklangan'});
    if (xodim.parol_hash !== parolHash(parol)) return res.json({ok:false,xato:"PINFL yoki parol noto'g'ri"});

    // device_id ustunida push yuborish uchun aynan Expo push token saqlanadi.
    // Eski mobil klient deviceId maydonida Expo token yuborgan bo'lsa ham backward-compatible.
    const candidate=[expoPushToken,pushToken,deviceId].find(expoTokenmi);
    if(candidate && candidate !== xodim.device_id){
      const {error:updateErr}=await supabase.from('xodimlar').update({device_id:candidate}).eq('id',xodim.id);
      if(updateErr) console.error('Push token saqlash xatosi:',updateErr.message);
    }
    res.json({ok:true,xodim:{id:xodim.id,fio:xodim.fio,mfyId:xodim.mfy_id,kategoriyaId:xodim.kategoriya_id},pushTokenQabulQilindi:!!candidate});
  } catch (err) { res.json({ok:false,xato:err.message}); }
});

app.post('/api/push-token', async (req,res)=>{
  try{
    const {xodimId,pushToken}=req.body;
    if(!xodimId || !expoTokenmi(pushToken)) return res.json({ok:false,xato:"Yaroqli Expo push token kerak"});
    const {error}=await supabase.from('xodimlar').update({device_id:String(pushToken).trim()}).eq('id',xodimId);
    if(error) return res.json({ok:false,xato:error.message});
    res.json({ok:true});
  }catch(err){res.json({ok:false,xato:err.message});}
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
    const user = req.query?.kalit ? await checkAuth(req) : null;
    if (req.query?.kalit && !user) return res.status(401).json({ok:false,xato:"Ruxsat yo'q",hisobotlar:[]});
    let query = supabase.from('hisobotlar').select('*').order('b_vaqt', { ascending:false });
    if (req.query.xodim) query=query.eq('xodim_id',req.query.xodim);
    if (req.query.dan) query=query.gte('sana',req.query.dan);
    if (req.query.gacha) query=query.lte('sana',req.query.gacha);
    if (user) { const scope=userMfyScope(user); if(scope) query=query.eq('mfy_id',scope); }
    const {data,error}=await query; if(error) return res.json({ok:false,xato:error.message,hisobotlar:[]});
    const hisobotlar=(data || []).map(h=>({
      id:h.id,xodimId:h.xodim_id,xodimFio:h.xodim_fio,mfyId:h.mfy_id,mfyNomi:h.mfy_nomi,
      kategoriyaId:h.kategoriya_id,kategoriyaNomi:h.kategoriya_nomi,ishTuri:h.ish_turi,ishNomi:h.ish_nomi,
      b_vaqt:h.b_vaqt,b_tavsif:h.b_tavsif,b_lat:h.b_lat,b_lng:h.b_lng,b_rasmlar:h.b_rasmlar?h.b_rasmlar.split(','):[],
      d_vaqt:h.d_vaqt,d_tavsif:h.d_tavsif,d_lat:h.d_lat,d_lng:h.d_lng,d_rasmlar:h.d_rasmlar?h.d_rasmlar.split(','):[],
      y_vaqt:h.y_vaqt,y_tavsif:h.y_tavsif,y_lat:h.y_lat,y_lng:h.y_lng,y_rasmlar:h.y_rasmlar?h.y_rasmlar.split(','):[],
      reyting:h.reyting,kechikkan:h.kechikkan,sana:h.sana,haftaKuni:h.hafta_kuni,flagSabab:h.flag_sabab,bosqich:h.bosqich||'BOSHLANDI',vazifaId:h.vazifa_id
    }));
    res.json({ok:true,hisobotlar});
  } catch(err){res.json({ok:false,xato:err.message,hisobotlar:[]});}
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
  const u = await checkAuth(req);
  if (!u || !userHasPermission(u, 'xodim_tahrir')) return permissionDenied(res);
  try {
    let query = supabase.from('tahrir_sorovlari').select('*').order('sana', { ascending: false });
    const scope = userMfyScope(u);
    if (scope) {
      const { data: xs, error: xErr } = await supabase.from('xodimlar').select('id').eq('mfy_id', scope);
      if (xErr) throw xErr;
      const ids = (xs || []).map(x => x.id);
      if (!ids.length) return res.json({ ok: true, sorovlar: [] });
      query = query.in('xodim_id', ids);
    }
    const { data, error } = await query;
    if (error) return res.json({ ok: false, xato: error.message });
    const sorovlar = (data || []).map(s => ({
      id: s.id, hisobotId: s.hisobot_id, xodimId: s.xodim_id, xodimFio: s.xodim_fio,
      sabab: s.sabab, status: s.status, ruxsatBeruvchi: s.ruxsat_beruvchi, sana: s.sana
    }));
    res.json({ ok: true, sorovlar });
  } catch (err) { res.json({ ok: false, xato: err.message }); }
});

app.post('/api/tahrirRuxsatBer', async (req, res) => {
  const u = await checkAuth(req);
  if (!u || !userHasPermission(u, 'xodim_tahrir')) return permissionDenied(res);
  try {
    const { sorovId } = req.body;
    const { data: s, error: sErr } = await supabase.from('tahrir_sorovlari').select('*').eq('id', sorovId).single();
    if (sErr || !s) return res.json({ ok: false, xato: "So'rov topilmadi" });
    const scopeTekshir = await xodimScopeTekshir(u, s.xodim_id);
    if (!scopeTekshir.ok) return permissionDenied(res, scopeTekshir.xato);
    const { error } = await supabase.from('tahrir_sorovlari').update({ status:'RUXSAT_BERILDI', ruxsat_beruvchi:u.fio }).eq('id', sorovId);
    if (error) return res.json({ ok:false, xato:error.message });
    if (s.hisobot_id) await supabase.from('hisobotlar').update({ bosqich:'BOSHLANDI' }).eq('id', s.hisobot_id);
    await auditLog(u.fio, 'TAHRIR_RUXSAT', `${s.xodim_fio} - ${s.hisobot_id}`); res.json({ ok:true });
  } catch (err) { res.json({ ok:false, xato:err.message }); }
});

app.post('/api/tahrirRad', async (req, res) => {
  const u = await checkAuth(req);
  if (!u || !userHasPermission(u, 'xodim_tahrir')) return permissionDenied(res);
  try {
    const { data:s, error:sErr } = await supabase.from('tahrir_sorovlari').select('id,xodim_id').eq('id', req.body.sorovId).single();
    if (sErr || !s) return res.json({ok:false,xato:"So'rov topilmadi"});
    const scopeTekshir=await xodimScopeTekshir(u,s.xodim_id);if(!scopeTekshir.ok)return permissionDenied(res,scopeTekshir.xato);
    const {error}=await supabase.from('tahrir_sorovlari').update({status:'RAD_ETILDI',ruxsat_beruvchi:u.fio}).eq('id',req.body.sorovId);
    if(error)return res.json({ok:false,xato:error.message});
    await auditLog(u.fio,'TAHRIR_RAD',req.body.sorovId);res.json({ok:true});
  } catch(err){res.json({ok:false,xato:err.message});}
});

// ====================================================
// 6. DASHBOARD 4.0 + SYSONE AI ANALYST
// ====================================================
// Muhim prinsip: AI statistikani hisoblamaydi.
// Raqamlar Supabase ma'lumotlaridan serverda deterministik hisoblanadi,
// AI esa faqat shu aniq faktlarni ravon o'zbek tilida sharhlaydi.

const aiRateLimitMap = new Map();
const aiCache = new Map();

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

  // Tashkilot biriktirilgan admin/nazoratchi server darajasida faqat o'z scope'ida ishlaydi.
  const scopeMfy = userMfyScope(user);
  if (scopeMfy) mfyId = scopeMfy;

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

  const [xRes, hRes, mRes, kRes] = await Promise.all([
    xQuery,
    hQuery,
    supabase.from('mfy').select('id,nomi'),
    supabase.from('kategoriyalar').select('id,nomi')
  ]);

  if (xRes.error) throw xRes.error;
  if (hRes.error) throw hRes.error;
  if (mRes.error) throw mRes.error;
  if (kRes.error) throw kRes.error;

  const mfyMap = Object.fromEntries((mRes.data || []).map(x => [String(x.id), x.nomi]));
  const katMap = Object.fromEntries((kRes.data || []).map(x => [String(x.id), x.nomi]));

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

  return {
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
  const [katRes, mfyRes] = await Promise.all([
    supabase.from('kategoriyalar').select('id,nomi'),
    supabase.from('mfy').select('id,nomi')
  ]);

  if (katRes.error) throw katRes.error;
  if (mfyRes.error) throw mfyRes.error;

  const kategoriyalar = katRes.data || [];
  const tashkilotlar = mfyRes.data || [];

  let kategoriya = null;
  if (body.kategoriyaId) {
    kategoriya = kategoriyalar.find(x => String(x.id) === String(body.kategoriyaId)) || null;
  } else {
    kategoriya = entityMatch(savol, kategoriyalar);
  }

  let tashkilot = null;
  const scopeMfy = userMfyScope(user);
  if (scopeMfy) {
    tashkilot = tashkilotlar.find(x => String(x.id) === String(scopeMfy)) || null;
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
  if (wantsMissing && kategoriya) intent = 'category_missing';
  else if (kategoriya) intent = 'category_summary';
  else if (wantsMissing) intent = 'missing_summary';
  else if (wantsSubmitted) intent = 'submitted_summary';

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
  const kategoriya = facts.kategoriya?.nomi || 'barcha kategoriyalar';
  const scopeOrg = facts.tashkilot?.nomi ? ` ${facts.tashkilot.nomi} tashkilotida` : '';

  const muammoliOrg = (facts.tashkilotlar || [])
    .filter(x => Number(x.topshirmagan || 0) > 0)
    .sort((a, b) => Number(b.topshirmagan || 0) - Number(a.topshirmagan || 0));

  const topMissing = muammoliOrg.slice(0, 10);

  if (facts.intent === 'category_missing') {
    let text = `${sanaSoz}${scopeOrg} ${kategoriya} kategoriyasi bo'yicha ${muammoliOrg.length} ta tashkilotda hisobot topshirmagan xodimlar mavjud. ` +
      `Jami ${m.topshirmagan || 0} nafar xodim hisobot topshirmagan.`;

    if (topMissing.length) {
      text += ' Tashkilotlar kesimida: ' + topMissing
        .map(x => `${x.nomi} — ${x.topshirmagan} ta`)
        .join('; ') + '.';
    }
    return text;
  }

  if (facts.intent === 'category_summary') {
    return `${sanaSoz}${scopeOrg} ${kategoriya} kategoriyasida ${m.topshirgan || 0} nafar xodim kamida bitta hisobot topshirdi. ` +
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
    `Bajarilish darajasi ${m.bajarilishFoizi || 0} foiz. ${m.flagSoni || 0} ta muammoli va ${m.kechikkan || 0} ta kechikkan hisobot mavjud.`;
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

  if (Number(m.flagSoni || 0) > 0) {
    insights.push({
      sarlavha: 'Muammoli hisobotlar',
      matn: `${m.flagSoni} ta hisobot muammoli holatda.`,
      daraja: 'yuqori'
    });
  }

  return {
    sarlavha: facts.kategoriya?.nomi ? `${facts.kategoriya.nomi} bo'yicha tahlil` : 'Kunlik nazorat tahlili',
    xulosa: exactAnswer,
    holat,
    insights,
    tavsiyalar: [
      Number(m.topshirmagan || 0) > 0 ? 'Hisobot topshirmagan tashkilotlarga tezkor eslatma yuborish.' : 'Joriy hisobot intizomini saqlab qolish.',
      Number(m.flagSoni || 0) > 0 ? 'Muammoli hisobotlarni alohida tekshirish.' : 'Hisobot sifatini muntazam nazorat qilish.',
      'Kun yakunida bajarilish ko\'rsatkichini qayta tekshirish.'
    ],
    savolJavobi: exactAnswer,
    speechText: exactAnswer
  };
}

function openAITextOl(payload) {
  if (payload && typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const parts = [];
  for (const item of (payload?.output || [])) {
    if (item.type !== 'message') continue;
    for (const c of (item.content || [])) {
      if (c.type === 'output_text' && c.text) parts.push(c.text);
    }
  }
  return parts.join('\n').trim();
}

async function openAITahlil(facts, savol, exactAnswer) {
  // API kaliti bo'lmasa ham deterministik lokal analitika ishlaydi.
  if (!process.env.OPENAI_API_KEY) return lokalTahlil(facts, exactAnswer);

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      sarlavha: { type: 'string' },
      xulosa: { type: 'string' },
      holat: { type: 'string', enum: ['yaxshi', 'diqqat', 'xavf'] },
      insights: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
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

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-5.6',
      store: false,
      instructions: [
        "Siz SysOne Xisobot Nazorat platformasining professional AI analitigisiz.",
        "Faqat server bergan JSON faktlardan foydalaning; raqamlarni o'ylab topmang va o'zgartirmang.",
        "Kategoriya so'ralgan bo'lsa faqat o'sha kategoriya bo'yicha gapiring.",
        "Hisobot topshirmaganlar haqida javobda xodim ism-familiyalarini aytmang; tashkilotlar kesimini ishlating.",
        "Hisobot topshirgan noyob xodimlar soni va jami hisobotlar soni boshqa-boshqa ko'rsatkich ekanini aniq ajrating.",
        "O'zbek lotin adabiy tilida ravon, sodda, rasmiy va qisqa yozing.",
        "speechText ovozda ravon o'qishga mos, keraksiz belgilar va markdownsiz bo'lsin."
      ].join(' '),
      input: `FOYDALANUVCHI SAVOLI:\n${savol || 'Bugungi kunlik hisobotni tahlil qil.'}\n\nSERVER HISOBLAGAN ANIQ JAVOB:\n${exactAnswer}\n\nFAKTLAR:\n${JSON.stringify(safeFacts)}`,
      max_output_tokens: 1200,
      text: {
        format: {
          type: 'json_schema',
          name: 'sysone_dashboard_analysis',
          strict: true,
          schema
        }
      }
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    console.error('OpenAI API xatosi:', payload);
    return lokalTahlil(facts, exactAnswer);
  }

  const text = openAITextOl(payload);
  if (!text) return lokalTahlil(facts, exactAnswer);

  try {
    const parsed = JSON.parse(text);
    // Faktik savol javobi va ovoz matni AI tomonidan o'zgartirilmasin.
    parsed.savolJavobi = exactAnswer;
    parsed.speechText = exactAnswer;
    if (!parsed.xulosa) parsed.xulosa = exactAnswer;
    return parsed;
  } catch (err) {
    console.error('AI JSON parse xatosi:', err.message, text);
    return lokalTahlil(facts, exactAnswer);
  }
}

app.post('/api/aiTahlil', async (req, res) => {
  const user = await checkAuth(req);
  if (!user) return res.status(401).json({ ok: false, xato: "Ruxsat yo'q" });

  if (!aiRateRuxsat(user.id || user.fio)) {
    return res.status(429).json({ ok: false, xato: "AI so'rovlari juda ko'p. Bir daqiqadan so'ng qayta urinib ko'ring." });
  }

  try {
    const savol = String(req.body.savol || '').trim().slice(0, 1200);
    const facts = await aiFaktlarYarat(user, savol, req.body || {});
    const exactAnswer = aiAniqJavob(facts);

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
        facts: { sana: facts.sana, kategoriya: facts.kategoriya, tashkilot: facts.tashkilot }
      });
    }

    const tahlil = await openAITahlil(facts, savol, exactAnswer);
    const model = process.env.OPENAI_API_KEY ? (process.env.OPENAI_MODEL || 'gpt-5.6') : 'SysOne Local Analytics';

    aiCache.set(cacheKey, { vaqt: Date.now(), tahlil, model });
    await auditLog(user.fio, 'AI_TAHLIL', `${facts.sana} | ${facts.kategoriya?.nomi || 'barcha kategoriya'}`);

    res.json({
      ok: true,
      tahlil,
      model,
      cached: false,
      facts: { sana: facts.sana, kategoriya: facts.kategoriya, tashkilot: facts.tashkilot }
    });
  } catch (err) {
    console.error('aiTahlil xatosi:', err);
    res.status(500).json({ ok: false, xato: err.message });
  }
});

// SERVERNI ISHGA TUSHIRISH
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SysOne Backend server ${PORT}-portda muvaffaqiyatli ishga tushdi!`);
});
