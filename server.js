require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5174;

// Render/Railway usan HTTPS detrás de un proxy. Esto ayuda a que las cookies seguras funcionen bien.
app.set('trust proxy', 1);

// Compatibilidad con los dos nombres de variables que estuviste usando.
// Antes el código solo leía CLIENT_ID / CLIENT_SECRET / REDIRECT_URI,
// pero en Render estabas usando GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI.
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || process.env.CLIENT_SECRET;
const REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ||
  process.env.REDIRECT_URI ||
  `http://localhost:${PORT}/auth/google/callback`;

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const isProduction = process.env.NODE_ENV === 'production';

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

app.use(session({
  secret: process.env.SESSION_SECRET || 'secreto-por-defecto-cambiar',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: isProduction ? 'none' : 'lax',
    secure: isProduction,
    maxAge: 1000 * 60 * 60 * 8
  }
}));

function createOAuthClient() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

function validateGoogleConfig() {
  const missing = [];
  if (!CLIENT_ID) missing.push('GOOGLE_CLIENT_ID');
  if (!CLIENT_SECRET) missing.push('GOOGLE_CLIENT_SECRET');
  if (!REDIRECT_URI) missing.push('GOOGLE_REDIRECT_URI');
  return missing;
}

const DEFAULT_PLATAFORMAS = {
  netflix: {
    nombre: 'Netflix',
    icono: '▦',
    color: '#E50914',
    asuntos: [
      'Tu código de acceso temporal de Netflix',
      'Importante: Cómo actualizar tu Hogar con Netflix',
      'Netflix: Tu código de inicio de sesión',
      'Tu verificación de inicio de sesión en Netflix'
    ]
  },
  disneyplus: {
    nombre: 'Disney+',
    icono: '✦',
    color: '#1677ff',
    asuntos: ['Tu código de acceso único para Disney+', 'Disney+ código de acceso']
  },
  primevideo: {
    nombre: 'Prime Video',
    icono: '▶',
    color: '#00A8E1',
    asuntos: ['Código de verificación Amazon Prime', 'Prime Video: Código de acceso temporal']
  },
  hbomax: {
    nombre: 'HBO Max',
    icono: '●',
    color: '#9b5cff',
    asuntos: ['Código de verificación HBO Max', 'HBO Max código de acceso']
  },
  spotify: {
    nombre: 'Spotify',
    icono: '♪',
    color: '#1DB954',
    asuntos: ['Código de verificación Spotify', 'Spotify: Código de acceso temporal']
  }
};

const RULES_FILE = process.env.ADMIN_RULES_FILE || path.join(__dirname, 'data', 'admin-rules.json');
let plataformasCache = null;

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function keyFromName(name = '') {
  return String(name)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '') || `servicio${Date.now()}`;
}

function shortFromName(name = '') {
  const clean = String(name).trim();
  if (!clean) return 'SV';
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.map(w => w[0]).join('').slice(0, 3).toUpperCase();
}

function uniqueSubjects(subjects) {
  const seen = new Set();
  const result = [];
  for (const subject of Array.isArray(subjects) ? subjects : []) {
    const clean = String(subject || '').trim();
    if (!clean || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    result.push(clean);
  }
  return result;
}

function normalizePlatformObject(input) {
  const normalized = {};
  const source = input && typeof input === 'object' ? input : {};

  for (const [key, value] of Object.entries(source)) {
    if (!value || typeof value !== 'object') continue;
    const cleanKey = keyFromName(key);
    normalized[cleanKey] = {
      nombre: String(value.nombre || value.name || key).trim(),
      icono: String(value.icono || value.icon || '✉').trim(),
      color: String(value.color || '#e50914').trim(),
      asuntos: uniqueSubjects(value.asuntos || value.subjects)
    };
  }

  return normalized;
}

function normalizeAdminArray(platforms) {
  const normalized = {};
  for (const item of Array.isArray(platforms) ? platforms : []) {
    if (!item || typeof item !== 'object') continue;
    const id = keyFromName(item.id || item.name || item.nombre);
    const name = String(item.name || item.nombre || id).trim();
    normalized[id] = {
      nombre: name,
      icono: String(item.icon || item.icono || '✉').trim(),
      color: String(item.color || '#e50914').trim(),
      asuntos: uniqueSubjects(item.subjects || item.asuntos)
    };
  }
  return normalized;
}

function mergeWithDefaults(custom = {}) {
  const base = cloneJson(DEFAULT_PLATAFORMAS);
  const merged = { ...base };

  for (const [key, value] of Object.entries(custom)) {
    merged[key] = {
      nombre: value.nombre || base[key]?.nombre || key,
      icono: value.icono || base[key]?.icono || '✉',
      color: value.color || base[key]?.color || '#e50914',
      asuntos: uniqueSubjects(value.asuntos || base[key]?.asuntos || [])
    };
  }

  return merged;
}

function loadPlataformas({ force = false } = {}) {
  if (plataformasCache && !force) return plataformasCache;

  let loaded = null;

  if (fs.existsSync(RULES_FILE)) {
    try {
      loaded = normalizePlatformObject(JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8')));
    } catch (error) {
      console.error('No se pudo leer ADMIN_RULES_FILE:', error.message);
    }
  }

  if (!loaded && process.env.ADMIN_RULES_JSON) {
    try {
      loaded = normalizePlatformObject(JSON.parse(process.env.ADMIN_RULES_JSON));
    } catch (error) {
      console.error('ADMIN_RULES_JSON no es válido:', error.message);
    }
  }

  plataformasCache = mergeWithDefaults(loaded || {});
  return plataformasCache;
}

function savePlataformasFromAdmin(platforms) {
  const normalized = mergeWithDefaults(normalizeAdminArray(platforms));
  fs.mkdirSync(path.dirname(RULES_FILE), { recursive: true });
  fs.writeFileSync(RULES_FILE, JSON.stringify(normalized, null, 2), 'utf-8');
  plataformasCache = normalized;
  return normalized;
}

function savePlataformasObject(plataformas) {
  const normalized = mergeWithDefaults(normalizePlatformObject(plataformas));
  fs.mkdirSync(path.dirname(RULES_FILE), { recursive: true });
  fs.writeFileSync(RULES_FILE, JSON.stringify(normalized, null, 2), 'utf-8');
  plataformasCache = normalized;
  return normalized;
}

function plataformasToAdminArray(plataformas = loadPlataformas()) {
  return Object.entries(plataformas).map(([id, platform]) => ({
    id,
    name: platform.nombre,
    short: shortFromName(platform.nombre),
    icon: platform.icono,
    color: platform.color,
    subjects: platform.asuntos || [],
    defaultSubjects: DEFAULT_PLATAFORMAS[id]?.asuntos || []
  }));
}

function getRulesSource() {
  if (fs.existsSync(RULES_FILE)) return 'archivo';
  if (process.env.ADMIN_RULES_JSON) return 'ADMIN_RULES_JSON';
  return 'default';
}

function buildSubjectQuery(plataformaKey) {
  const asuntos = loadPlataformas()[plataformaKey]?.asuntos || [];
  if (asuntos.length === 0) return '';
  return asuntos.map(asunto => `subject:"${asunto.replace(/"/g, '\\"')}"`).join(' OR ');
}


function decodeBase64(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function getEmailBody(payload) {
  let htmlBody = '';
  let plainBody = '';

  function traverse(part) {
    if (part.mimeType === 'text/html' && part.body && part.body.data) {
      htmlBody = decodeBase64(part.body.data);
      return true;
    }
    if (part.mimeType === 'text/plain' && part.body && part.body.data) {
      plainBody = decodeBase64(part.body.data);
    }
    if (part.parts) {
      for (const subPart of part.parts) {
        if (traverse(subPart)) return true;
      }
    }
    return false;
  }

  traverse(payload);
  return htmlBody || plainBody;
}

function getHeaders(payload) {
  const headers = {};
  for (const header of payload.headers || []) {
    headers[header.name.toLowerCase()] = header.value;
  }
  return headers;
}

function parseGmailTokens() {
  if (!process.env.GMAIL_TOKENS) {
    throw new Error('No hay tokens GMAIL_TOKENS en las variables de entorno. Entra a /auth/google para generar nuevos tokens.');
  }

  try {
    return JSON.parse(process.env.GMAIL_TOKENS);
  } catch (_error) {
    throw new Error('La variable GMAIL_TOKENS no es un JSON válido. Copia el JSON completo sin comillas extra al inicio o al final.');
  }
}

async function searchEmailsByPlataforma(plataformaKey, destinatario = null) {
  const missing = validateGoogleConfig();
  if (missing.length) {
    throw new Error(`Faltan variables de Google en Render/Railway: ${missing.join(', ')}`);
  }

  const tokens = parseGmailTokens();
  const oauth2Client = createOAuthClient();
  oauth2Client.setCredentials(tokens);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  const subjectQuery = buildSubjectQuery(plataformaKey);
  if (!subjectQuery) return [];

  let query = `(${subjectQuery})`;
  if (destinatario) {
    query = `(to:${destinatario} OR deliveredto:${destinatario}) AND (${subjectQuery})`;
  }
  // No se registra la búsqueda ni el correo consultado para evitar guardar historial.

  try {
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 5
    });

    const messages = response.data.messages || [];
    // Solo se procesan resultados en memoria; no se guarda historial.

    const resultados = [];
    for (const msg of messages) {
      const fullMsg = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full'
      });
      const payload = fullMsg.data.payload;
      const headers = getHeaders(payload);
      const body = getEmailBody(payload);
      resultados.push({
        id: msg.id,
        from: headers['from'] || 'Desconocido',
        date: headers['date'] || '',
        subject: headers['subject'] || '',
        body,
        snippet: fullMsg.data.snippet
      });
    }

    resultados.sort((a, b) => new Date(b.date) - new Date(a.date));
    return resultados;
  } catch (error) {
    const googleError = error?.response?.data?.error || error?.message || '';

    if (String(googleError).includes('invalid_grant')) {
      throw new Error('invalid_grant: el token de Gmail está vencido, revocado o fue generado con otro redirect URI. Borra GMAIL_TOKENS, redeploya y vuelve a autorizar en /auth/google.');
    }

    throw error;
  }
}

// ========== RUTAS ==========
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'buscador-gmail',
    nodeEnv: process.env.NODE_ENV || 'development',
    redirectUri: REDIRECT_URI,
    hasGoogleClientId: Boolean(CLIENT_ID),
    hasGoogleClientSecret: Boolean(CLIENT_SECRET),
    hasGmailTokens: Boolean(process.env.GMAIL_TOKENS),
    hasAdminPassword: Boolean(process.env.ADMIN_PASSWORD),
    rulesSource: getRulesSource()
  });
});

app.get('/', (_req, res) => {
  res.render('index', {
    plataformas: Object.keys(loadPlataformas()).map(key => ({
      key,
      nombre: loadPlataformas()[key].nombre,
      icono: loadPlataformas()[key].icono,
      color: loadPlataformas()[key].color
    })),
    error: null
  });
});

app.post('/buscar-json', async (req, res) => {
  const { correo, plataforma } = req.body;
  const plataformas = loadPlataformas();

  if (!correo || !correo.includes('@')) {
    return res.json({ error: 'Correo inválido' });
  }
  if (!plataforma || !plataformas[plataforma]) {
    return res.json({ error: 'Plataforma inválida' });
  }

  try {
    const correos = await searchEmailsByPlataforma(plataforma, correo);
    return res.json({
      success: true,
      plataforma: plataformas[plataforma],
      correos,
      correoBuscado: correo
    });
  } catch (err) {
    console.error('Error /buscar-json:', err);
    return res.json({ error: 'Error al buscar correos: ' + err.message });
  }
});


function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'No autorizado' });
}

app.post('/admin-api/login', (req, res) => {
  const configuredPassword = process.env.ADMIN_PASSWORD;
  if (!configuredPassword) {
    return res.status(500).json({ error: 'Falta configurar ADMIN_PASSWORD en Render.' });
  }

  const { password } = req.body || {};
  if (String(password || '') !== String(configuredPassword)) {
    return res.status(401).json({ error: 'Clave incorrecta' });
  }

  req.session.isAdmin = true;
  return res.json({ ok: true });
});

app.post('/admin-api/logout', (req, res) => {
  if (!req.session) return res.json({ ok: true });
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    return res.json({ ok: true });
  });
});

app.get('/admin-api/me', (req, res) => {
  return res.json({ ok: true, authenticated: Boolean(req.session && req.session.isAdmin) });
});

app.get('/admin-api/rules', requireAdmin, (_req, res) => {
  return res.json({
    ok: true,
    source: getRulesSource(),
    platforms: plataformasToAdminArray(loadPlataformas({ force: true }))
  });
});

app.put('/admin-api/rules', requireAdmin, (req, res) => {
  try {
    const { platforms } = req.body || {};
    if (!Array.isArray(platforms)) {
      return res.status(400).json({ error: 'Formato inválido. Se esperaba platforms como arreglo.' });
    }

    const saved = savePlataformasFromAdmin(platforms);
    return res.json({ ok: true, platforms: plataformasToAdminArray(saved) });
  } catch (error) {
    console.error('Error guardando reglas admin:', error);
    return res.status(500).json({ error: 'No se pudieron guardar las reglas: ' + error.message });
  }
});

app.post('/admin-api/rules/reset/:id', requireAdmin, (req, res) => {
  try {
    const id = keyFromName(req.params.id || '');
    const defaults = DEFAULT_PLATAFORMAS[id];

    if (!defaults) {
      return res.status(404).json({ error: 'No existe una base para esa plataforma.' });
    }

    const current = loadPlataformas({ force: true });
    current[id] = {
      nombre: defaults.nombre,
      icono: defaults.icono,
      color: defaults.color,
      asuntos: uniqueSubjects(defaults.asuntos)
    };

    const saved = savePlataformasObject(current);
    return res.json({ ok: true, platforms: plataformasToAdminArray(saved) });
  } catch (error) {
    console.error('Error restaurando asuntos base:', error);
    return res.status(500).json({ error: 'No se pudieron restaurar los asuntos base: ' + error.message });
  }
});

app.get('/auth/google', (req, res) => {
  const missing = validateGoogleConfig();
  if (missing.length) {
    return res.status(500).send(`Faltan variables en Render/Railway: ${missing.join(', ')}`);
  }

  const oauth2Client = createOAuthClient();
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });

  res.redirect(authUrl);
});

async function googleCallbackHandler(req, res) {
  const { code, error } = req.query;

  if (error) {
    return res.status(400).send('Google devolvió un error: ' + error);
  }
  if (!code) {
    return res.status(400).send('No se recibió código de Google.');
  }

  try {
    const oauth2Client = createOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);

    console.log('TOKENS:', JSON.stringify(tokens));

    res.send(`
      <h1>✅ Autenticación exitosa</h1>
      <p>Copia el siguiente texto y pégalo como valor de la variable <strong>GMAIL_TOKENS</strong> en Render.</p>
      <p><strong>Importante:</strong> borra cualquier GMAIL_TOKENS viejo antes de pegar este nuevo JSON.</p>
      <textarea rows="8" cols="100" style="width:100%; font-family:monospace;">${JSON.stringify(tokens)}</textarea>
      <br><br>
      <a href="/">Volver al inicio</a>
    `);
  } catch (err) {
    console.error('Error OAuth callback:', err?.response?.data || err);

    const googleError = err?.response?.data?.error || err?.message || '';
    if (String(googleError).includes('invalid_grant')) {
      return res.status(400).send(`
        <h1>❌ Error OAuth: invalid_grant</h1>
        <p>El código de Google no se pudo intercambiar por tokens.</p>
        <p>Revisa que <strong>GOOGLE_REDIRECT_URI</strong> en Render y el redirect autorizado en Google Cloud sean exactamente iguales.</p>
        <p>Redirect usado por esta app:</p>
        <pre>${REDIRECT_URI}</pre>
      `);
    }

    return res.status(500).send('Error al autenticar: ' + err.message);
  }
}

// Ruta original del proyecto.
app.get('/auth/google/callback', googleCallbackHandler);

// Alias útil si antes configuraste /api/oauth2/callback en Google Cloud.
// Si usas este alias, GOOGLE_REDIRECT_URI debe terminar exactamente en /api/oauth2/callback.
app.get('/api/oauth2/callback', googleCallbackHandler);

app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
  console.log(`Redirect URI configurado: ${REDIRECT_URI}`);
  console.log(`Google Client ID: ${CLIENT_ID ? 'configurado' : 'FALTA'}`);
  console.log(`Google Client Secret: ${CLIENT_SECRET ? 'configurado' : 'FALTA'}`);
  console.log(`GMAIL_TOKENS: ${process.env.GMAIL_TOKENS ? 'configurado' : 'FALTA'}`);
  console.log(`ADMIN_PASSWORD: ${process.env.ADMIN_PASSWORD ? 'configurado' : 'FALTA'}`);
  console.log(`Reglas admin: ${getRulesSource()}`);
});
