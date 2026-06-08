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
      'Este código vence en 15 minutos',
      'Importante: Cómo actualizar tu Hogar con Netflix',
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

function escapeGmailQuery(value = '') {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .trim();
}

function sanitizeEmail(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

function canonicalGmailEmail(value = '') {
  const email = sanitizeEmail(value);
  const [local, domain] = email.split('@');
  if (!local || !domain) return email;

  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return `${local.split('+')[0].replace(/\./g, '')}@gmail.com`;
  }

  return email;
}

function emailVariants(value = '') {
  const exact = sanitizeEmail(value);
  const canonical = canonicalGmailEmail(value);
  return [...new Set([exact, canonical].filter(Boolean))];
}

function compactForEmailMatch(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '');
}

function canonicalizeGmailAddressesInText(text = '') {
  return String(text || '').replace(/[a-z0-9._%+-]+@(gmail|googlemail)\.com/gi, match => canonicalGmailEmail(match));
}

function messageMatchesRecipient(headers = {}, body = '', snippet = '', destinatario = '') {
  const variants = emailVariants(destinatario);
  if (!variants.length) return true;

  const headerFields = [
    headers['to'],
    headers['delivered-to'],
    headers['x-original-to'],
    headers['x-forwarded-to'],
    headers['cc'],
    headers['bcc'],
    headers['reply-to']
  ].filter(Boolean).join(' ');

  const exactHaystack = compactForEmailMatch(`${headerFields} ${body || ''} ${snippet || ''}`);
  const canonicalHaystack = canonicalizeGmailAddressesInText(exactHaystack);

  return variants.some(email => {
    const exact = compactForEmailMatch(email);
    const canonical = canonicalGmailEmail(email);
    return exactHaystack.includes(exact) || canonicalHaystack.includes(canonical);
  });
}

function buildSubjectQuery(plataformaKey) {
  const asuntos = loadPlataformas()[plataformaKey]?.asuntos || [];
  if (asuntos.length === 0) return '';
  return asuntos.map(asunto => `subject:"${escapeGmailQuery(asunto)}"`).join(' OR ');
}

function buildRecipientQuery(destinatario = '') {
  const email = sanitizeEmail(destinatario);
  if (!email) return '';

  const safe = escapeGmailQuery(email);
  return `{to:${safe} deliveredto:${safe} cc:${safe} bcc:${safe} "${safe}"}`;
}


function stripHtmlForCode(value = '') {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeForCode(value = '') {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExpServer(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scorePreviewCandidate(candidate, text, subjectHasCodeSignal = false) {
  const value = candidate.value;
  const raw = String(candidate.raw || value);
  const start = Math.max(0, candidate.index - 180);
  const end = Math.min(text.length, candidate.index + raw.length + 180);
  const context = text.slice(start, end).toLowerCase();
  const before = text.slice(Math.max(0, candidate.index - 180), candidate.index).toLowerCase();
  const after = text.slice(candidate.index + raw.length, Math.min(text.length, candidate.index + raw.length + 180)).toLowerCase();

  const codeWords = /(c[oó]digo|code|verification|verificaci[oó]n|acceso|access|login|iniciar|sesi[oó]n|temporal|one[- ]?time|otp|vence|expires|caduca|15 minutos|minutes)/i;
  const strongCodeWords = /(\bc[oó]digo\b|\bcode\b|\botp\b|verificaci[oó]n|verification|acceso|access|inicio de sesi[oó]n|login|vence|expires)/i;
  const footerWords = /(los gatos|albright|california|\bca\b|ee\.?\s*uu|united states|preguntas|questions|llama|call|address|direcci[oó]n|postal|zip|way|street|avenue|privacidad|privacy|t[eé]rminos|terms|centro de ayuda|help center|unsubscribe|cancelar suscripci[oó]n)/i;

  let score = 0;

  if (subjectHasCodeSignal) score += 70;
  if (codeWords.test(context)) score += 85;
  if (strongCodeWords.test(context)) score += 45;
  if (strongCodeWords.test(before)) score += 25;
  if (/(vence|expires|caduca|15 minutos|minutes)/i.test(after)) score += 28;

  if (candidate.source === 'snippet') score += 25;
  if (candidate.source === 'body' && candidate.index < 2500) score += 22;
  if (candidate.source === 'body' && candidate.index > 4500) score -= 45;

  if (value.length === 4) score += 24;
  if (value.length === 6) score += 22;
  if (value.length === 5) score += 8;
  if (value.length >= 7) score -= 8;

  // Bloqueos fuertes de falsos positivos.
  if (/^20\d{2}$/.test(value)) score -= 140;
  if (['95032', '0800', '121'].includes(value)) score -= 220;
  if (footerWords.test(context)) score -= 220;
  if (/[\/:.-]\s*$/.test(text.slice(Math.max(0, candidate.index - 2), candidate.index))) score -= 45;
  if (/(tel[eé]fono|phone|llama|call|\+\d|0800)/i.test(context)) score -= 140;

  if (!subjectHasCodeSignal && !codeWords.test(context)) score -= 75;

  const occurrences = (text.match(new RegExp(`\\b${escapeRegExpServer(value)}\\b`, 'g')) || []).length;
  if (occurrences > 3 && !strongCodeWords.test(context)) score -= 55;

  score -= candidate.index / 100000;

  return score;
}

function collectCodeCandidates(text = '', source = 'body') {
  const clean = normalizeForCode(text);
  const candidates = [];

  for (const match of clean.matchAll(/\b\d{4,8}\b/g)) {
    candidates.push({
      value: match[0],
      index: match.index || 0,
      raw: match[0],
      source
    });
  }

  for (const match of clean.matchAll(/(?:\b\d[\s\-]){3,7}\d\b/g)) {
    const value = match[0].replace(/\D/g, '');
    if (value.length >= 4 && value.length <= 8) {
      candidates.push({
        value,
        index: match.index || 0,
        raw: match[0],
        source
      });
    }
  }

  return candidates;
}


function isNetflixTemporaryButtonEmail({ subject = '', body = '' } = {}) {
  const text = `${subject} ${stripHtmlForCode(body)}`.toLowerCase();

  return /netflix/i.test(text) &&
    /(acceso temporal|obtener c[oó]digo|get code|view code|mostrar c[oó]digo|ver c[oó]digo)/i.test(text);
}

function extractPreviewCode({ subject = '', snippet = '', body = '' } = {}) {
  const subjectText = stripHtmlForCode(subject);
  const snippetText = stripHtmlForCode(snippet);
  const bodyText = stripHtmlForCode(body);

  const directCode =
    extractCodeNearVerificationLabel(bodyText) ||
    extractCodeNearVerificationLabel(snippetText);

  if (directCode) return directCode;

  // Importante:
  // Los correos "Tu código de acceso temporal de Netflix" tienen un botón "Obtener código".
  // El código NO está directamente en el correo. Si aquí intentamos adivinar, suele salir 95032
  // u otro número del pie de página. Por eso devolvemos vacío y no inventamos.
  if (isNetflixTemporaryButtonEmail({ subject, body })) {
    return '';
  }

  const subjectHasCodeSignal = /(c[oó]digo|code|acceso|access|login|sesi[oó]n|verification|verificaci[oó]n|vence|expires|otp)/i.test(subjectText);

  const candidates = [
    ...collectCodeCandidates(snippetText, 'snippet'),
    ...collectCodeCandidates(bodyText, 'body')
  ];

  if (!candidates.length) return '';

  const seen = new Set();
  const scored = candidates
    .filter(candidate => {
      const key = `${candidate.source}-${candidate.value}-${candidate.index}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(candidate => ({
      ...candidate,
      score: scorePreviewCandidate(
        candidate,
        candidate.source === 'snippet' ? snippetText : bodyText,
        subjectHasCodeSignal
      )
    }))
    .filter(candidate => candidate.score >= 55)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.value || '';
}

function extractCodeNearVerificationLabel(text = '') {
  const clean = normalizeForCode(text);
  if (!clean) return '';

  const patterns = [
    /c[oó]digo\s+de\s+verificaci[oó]n\s*:?\s*((?:\d[\s\-]?){4,8})/i,
    /verification\s+code\s*:?\s*((?:\d[\s\-]?){4,8})/i,
    /c[oó]digo\s*:?\s*((?:\d[\s\-]?){4,8})/i,
    /code\s*:?\s*((?:\d[\s\-]?){4,8})/i
  ];

  for (const pattern of patterns) {
    const match = clean.match(pattern);
    if (!match) continue;

    const code = String(match[1] || '').replace(/\D/g, '');
    if (isUsablePreviewCode(code)) return code;
  }

  // Caso Netflix: el texto puede venir como "Código de verificación:" y el número unos caracteres después.
  const labelMatch = clean.match(/c[oó]digo\s+de\s+verificaci[oó]n\s*:?/i);
  if (labelMatch) {
    const afterLabel = clean.slice(labelMatch.index + labelMatch[0].length, labelMatch.index + labelMatch[0].length + 160);
    const spaced = afterLabel.match(/(?:\b\d[\s\-]){3,7}\d\b/);
    if (spaced) {
      const code = spaced[0].replace(/\D/g, '');
      if (isUsablePreviewCode(code)) return code;
    }

    const compact = afterLabel.match(/\b\d{4,8}\b/);
    if (compact && isUsablePreviewCode(compact[0])) return compact[0];
  }

  return '';
}

function isUsablePreviewCode(code = '') {
  if (!/^\d{4,8}$/.test(code)) return false;
  if (/^20\d{2}$/.test(code)) return false;
  if (['95032', '0800', '121'].includes(code)) return false;
  return true;
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

async function fetchFullMessages(gmail, messages = [], destinatario = null) {
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
    const snippet = fullMsg.data.snippet || '';

    if (!messageMatchesRecipient(headers, body, snippet, destinatario)) {
      continue;
    }

    const subject = headers['subject'] || '';
    const previewCode = extractPreviewCode({ subject, snippet, body });

    resultados.push({
      id: msg.id,
      from: headers['from'] || 'Desconocido',
      date: headers['date'] || '',
      subject,
      body,
      snippet,
      previewCode,
      code: previewCode
    });
  }

  resultados.sort((a, b) => new Date(b.date) - new Date(a.date));
  return resultados;
}

async function gmailListMessages(gmail, query, maxResults = 20) {
  const response = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults
  });

  return response.data.messages || [];
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

  const cleanDestinatario = sanitizeEmail(destinatario);
  const recipientQuery = buildRecipientQuery(cleanDestinatario);

  const queries = [];
  if (recipientQuery) {
    queries.push(`(${subjectQuery}) ${recipientQuery}`);
    queries.push(`(${subjectQuery}) "${escapeGmailQuery(cleanDestinatario)}"`);
  }
  queries.push(`(${subjectQuery})`);

  try {
    const seenMessageIds = new Set();

    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];
      const maxResults = i === queries.length - 1 ? 50 : 20;
      const messages = await gmailListMessages(gmail, query, maxResults);
      const freshMessages = messages.filter(msg => {
        if (!msg.id || seenMessageIds.has(msg.id)) return false;
        seenMessageIds.add(msg.id);
        return true;
      });

      const resultados = await fetchFullMessages(gmail, freshMessages, cleanDestinatario);

      if (resultados.length) {
        return resultados.slice(0, 5);
      }

      if (!cleanDestinatario) {
        break;
      }
    }

    return [];
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
