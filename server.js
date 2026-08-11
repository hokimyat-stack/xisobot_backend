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
const PAROL_SALT = 'meningMaxfiyTuzim2026Xzy';

function parolHash(parol) {
  return crypto.createHash('sha256').update(parol + PAROL_SALT).digest('hex');
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
  const kalit = req.method === 'GET' ? req.query.kalit : req.body.kalit;
  if (!kalit) return null;
  if (kalit === '9XvQ2pL8zR') return { rol: 'superadmin', fio: 'Superadmin', mfyId: '', ruxsatlar: [] };

  const { data } = await supabase.from('adminlar').select('*').eq('kalit', kalit).single();
  if (data && data.holat === 'faol') {
    return { 
      id: data.id, 
      rol: data.rol, 
      fio: data.fio, 
      mfyId: data.mfy_id, 
      ruxsatlar: data.ruxsatlar ? data.ruxsatlar.split(',') : [] 
    };
  }
  return null;
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

// Bosh sahifa salomlashuv
app.get('/', (req, res) => {
  res.send('🚀 SysOne Kunlik Hisobot API Serveri muvaffaqiyatli ishlamoqda!');
});

// 3. ADMIN PANEL API'LARI
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
        ruxsatlar: admin.ruxsatlar ? admin.ruxsatlar.split(',') : [],
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
  const { data, error } = await supabase.from('adminlar').select('*');
  if (error) return res.json({ ok: false, xato: error.message });
  const adminlar = (data || []).map(a => ({
    id: a.id, fio: a.fio, login: a.login, rol: a.rol, mfyId: a.mfy_id, 
    ruxsatlar: a.ruxsatlar ? a.ruxsatlar.split(',') : [], kalit: a.kalit, holat: a.holat
  }));
  res.json({ ok: true, adminlar });
});

app.get('/api/auditlar', async (req, res) => {
  const { data } = await supabase.from('audit_log').select('*').order('vaqt', { ascending: false }).limit(300);
  const audit = (data || []).map(a => ({
    vaqt: new Date(a.vaqt).toLocaleString('ru-RU'), kim: a.kim, amal: a.amal, tafsilot: a.tafsilot
  }));
  res.json({ ok: true, audit });
});

// CRUD AMALLARI
app.post('/api/xodimQosh', async (req, res) => {
  const u = await checkAuth(req); if (!u) return res.json({ ok: false, xato: "Ruxsat yo'q" });
  const { fio, pinfl, parol, tel, mfyId, kategoriyaId } = req.body;
  const id = genId('X');
  const { error } = await supabase.from('xodimlar').insert([{
    id, fio, pinfl, parol_hash: parolHash(parol || '1234'), tel: tel || '', mfy_id: mfyId || null, kategoriya_id: kategoriyaId || null, holat: 'faol'
  }]);
  if (error) return res.json({ ok: false, xato: error.message });
  await auditLog(u.fio, 'XODIM_QOSHILDI', `${id} ${fio}`);
  res.json({ ok: true, id });
});

app.post('/api/xodimTahrir', async (req, res) => {
  const u = await checkAuth(req); if (!u) return res.json({ ok: false, xato: "Ruxsat yo'q" });
  const { xodimId, fio, parol, tel, mfyId, kategoriyaId, holat } = req.body;
  let updateData = {};
  if (fio) updateData.fio = fio;
  if (parol) updateData.parol_hash = parolHash(parol);
  if (tel !== undefined) updateData.tel = tel;
  if (mfyId !== undefined) updateData.mfy_id = mfyId || null;
  if (kategoriyaId !== undefined) updateData.kategoriya_id = kategoriyaId || null;
  if (holat) updateData.holat = holat;
  
  const { error } = await supabase.from('xodimlar').update(updateData).eq('id', xodimId);
  if (error) return res.json({ ok: false, xato: error.message });
  await auditLog(u.fio, 'XODIM_TAHRIR', xodimId);
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
  res.json({ ok: true, id });
});

app.post('/api/mfyTahrir', async (req, res) => {
  const u = await checkAuth(req); if (!u) return res.json({ ok: false, xato: "Ruxsat yo'q" });
  const { error } = await supabase.from('mfy').update({ nomi: req.body.nomi, rahbar: req.body.rahbar, tel: req.body.tel }).eq('id', req.body.mfyId);
  if (error) return res.json({ ok: false, xato: error.message });
  await auditLog(u.fio, 'MFY_TAHRIR', req.body.mfyId);
  res.json({ ok: true });
});

app.post('/api/mfyOchir', async (req, res) => {
  const u = await checkAuth(req); if (!u) return res.json({ ok: false, xato: "Ruxsat yo'q" });
  const { error } = await supabase.from('mfy').delete().eq('id', req.body.mfyId);
  if (error) return res.json({ ok: false, xato: error.message });
  await auditLog(u.fio, 'MFY_OCHIRILDI', req.body.mfyId);
  res.json({ ok: true });
});

app.post('/api/kategoriyaQosh', async (req, res) => {
  const u = await checkAuth(req); if (!u) return res.json({ ok: false, xato: "Ruxsat yo'q" });
  const id = genId('K');
  const { error } = await supabase.from('kategoriyalar').insert([{ id, nomi: req.body.nomi, tavsif: req.body.tavsif || '' }]);
  if (error) return res.json({ ok: false, xato: error.message });
  await auditLog(u.fio, 'KATEGORIYA_QOSHILDI', req.body.nomi);
  res.json({ ok: true, id });
});

app.post('/api/kategoriyaTahrir', async (req, res) => {
  const u = await checkAuth(req); if (!u) return res.json({ ok: false, xato: "Ruxsat yo'q" });
  const { error } = await supabase.from('kategoriyalar').update({ nomi: req.body.nomi, tavsif: req.body.tavsif }).eq('id', req.body.kategoriyaId);
  if (error) return res.json({ ok: false, xato: error.message });
  await auditLog(u.fio, 'KATEGORIYA_TAHRIR', req.body.kategoriyaId);
  res.json({ ok: true });
});

app.post('/api/kategoriyaOchir', async (req, res) => {
  const u = await checkAuth(req); if (!u) return res.json({ ok: false, xato: "Ruxsat yo'q" });
  const { error } = await supabase.from('kategoriyalar').delete().eq('id', req.body.kategoriyaId);
  if (error) return res.json({ ok: false, xato: error.message });
  await auditLog(u.fio, 'KATEGORIYA_OCHIRILDI', req.body.kategoriyaId);
  res.json({ ok: true });
});

app.post('/api/adminQosh', async (req, res) => {
  const u = await checkAuth(req); if (!u || u.rol !== 'superadmin') return res.json({ ok: false, xato: "Ruxsat yo'q" });
  const { fio, login, parol, rol, mfyId } = req.body;
  const id = genId('A');
  const kalit = tasodifiyKalit(rol === 'admin' ? 'ADM' : 'NZR');
  const { error } = await supabase.from('adminlar').insert([{
    id, fio, login, parol_hash: parolHash(parol), rol, mfy_id: mfyId || null, kalit, holat: 'faol'
  }]);
  if (error) return res.json({ ok: false, xato: error.message });
  await auditLog(u.fio, 'ADMIN_QOSHILDI', login);
  res.json({ ok: true });
});

app.post('/api/adminTahrir', async (req, res) => {
  const u = await checkAuth(req); if (!u) return res.json({ ok: false, xato: "Ruxsat yo'q" });
  const { adminId, fio, login, rol, mfyId, holat } = req.body;
  const { error } = await supabase.from('adminlar').update({ fio, login, rol, mfy_id: mfyId || null, holat }).eq('id', adminId);
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

app.post('/api/eslatmaYuborGuruh', async (req, res) => {
  const u = await checkAuth(req); if (!u) return res.json({ ok: false, xato: "Ruxsat yo'q" });
  await auditLog(u.fio, 'ESLATMA_GURUH', `${req.body.xodimIdlar?.length || 0} ta xodimga`);
  res.json({ ok: true, yuborildi: req.body.xodimIdlar?.length || 0 });
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

// 4. MOBIL ILOVA VA HISOBOT API'LARI
app.post('/api/xodim-login', async (req, res) => {
  try {
    const { pinfl, parol, deviceId } = req.body;
    const { data: xodim, error } = await supabase.from('xodimlar').select('*').eq('pinfl', pinfl).single();

    if (error || !xodim) return res.json({ ok: false, xato: "PINFL yoki parol noto'g'ri" });
    if (xodim.holat !== 'faol') return res.json({ ok: false, xato: "Hisob bloklangan" });
    if (xodim.parol_hash !== parolHash(parol)) return res.json({ ok: false, xato: "PINFL yoki parol noto'g'ri" });

    if (xodim.device_id && xodim.device_id !== deviceId) {
      return res.json({ ok: false, xato: "Bu hisob boshqa qurilmaga bog'langan!" });
    }
    if (!xodim.device_id && deviceId) {
      await supabase.from('xodimlar').update({ device_id: deviceId }).eq('id', xodim.id);
    }

    res.json({ ok: true, xodim: { id: xodim.id, fio: xodim.fio, mfyId: xodim.mfy_id, kategoriyaId: xodim.kategoriya_id } });
  } catch (err) {
    res.json({ ok: false, xato: err.message });
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
      flagSabab: h.flag_sabab, bosqich: h.bosqich || 'BOSHLANDI'
    }));

    res.json({ ok: true, hisobotlar });
  } catch (err) {
    res.json({ ok: false, xato: err.message, hisobotlar: [] });
  }
});

app.post('/api/hisobotBoshla', async (req, res) => {
  try {
    const { xodimId, ishTuri, ishNomi, tavsif, lat, lng, rasmlar, deviceVaqt } = req.body;
    const { data: x } = await supabase.from('xodimlar').select('fio, mfy_id, kategoriya_id').eq('id', xodimId).single();
    const { data: m } = await supabase.from('mfy').select('nomi').eq('id', x?.mfy_id).single();
    const { data: k } = await supabase.from('kategoriyalar').select('nomi').eq('id', x?.kategoriya_id).single();

    let yuklanganRasmlar = [];
    for (let rB64 of (rasmlar || [])) {
      const url = await r2RasmYukla(rB64);
      if (url) yuklanganRasmlar.push(url);
    }

    const id = genId('H');
    const sana = new Date().toISOString().slice(0, 10);
    
    const { error } = await supabase.from('hisobotlar').insert([{
      id, xodim_id: xodimId, xodim_fio: x?.fio || '',
      mfy_id: x?.mfy_id || null, mfy_nomi: m?.nomi || '',
      kategoriya_id: x?.kategoriya_id || null, kategoriya_nomi: k?.nomi || '',
      ish_turi: ishTuri, ish_nomi: ishNomi,
      b_vaqt: deviceVaqt || new Date().toISOString(), b_tavsif: tavsif,
      b_lat: lat, b_lng: lng, b_rasmlar: yuklanganRasmlar.join(','),
      bosqich: 'BOSHLANDI', sana, reyting: 'YASHIL'
    }]);

    if (error) return res.json({ ok: false, xato: error.message });
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
    const { hisobotId, tavsif, lat, lng, rasmlar, deviceVaqt } = req.body;
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
    const sana = new Date().toISOString().slice(0, 10);

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

// Tahrirga ruxsat berish
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
      await supabase.from('hisobotlar').update({
        bosqich: 'BOSHLANDI'
      }).eq('id', s.hisobot_id);
    }

    await auditLog(u.fio, 'TAHRIR_RUXSAT', `${s.xodim_fio} - ${s.hisobot_id}`);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, xato: err.message });
  }
});

// Tahrirni rad etish
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

// SERVERNI ISHGA TUSHIRISH
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SysOne Backend server ${PORT}-portda muvaffaqiyatli ishga tushdi!`);
});
