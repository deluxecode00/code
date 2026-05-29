require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');

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

const PLATAFORMAS = {
  netflix: {
    nombre: 'Netflix',
    icono: '📺',
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
    icono: '✨',
    color: '#1E3A8A',
    asuntos: ['Tu código de acceso único para Disney+', 'Disney+ código de acceso']
  },
  primevideo: {
    nombre: 'Prime Video',
    icono: '📦',
    color: '#00A8E1',
    asuntos: ['Código de verificación Amazon Prime', 'Prime Video: Código de acceso temporal']
  },
  hbomax: {
    nombre: 'HBO Max',
    icono: '🎬',
    color: '#6A1B9A',
    asuntos: ['Código de verificación HBO Max', 'HBO Max código de acceso']
  },
  spotify: {
    nombre: 'Spotify',
    icono: '🎵',
    color: '#1DB954',
    asuntos: ['Código de verificación Spotify', 'Spotify: Código de acceso temporal']
  }
};

function buildSubjectQuery(plataformaKey) {
  const asuntos = PLATAFORMAS[plataformaKey]?.asuntos || [];
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
  console.log(`🔍 Consulta Gmail: ${query}`);

  try {
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 5
    });

    const messages = response.data.messages || [];
    console.log(`📧 Encontrados ${messages.length} correos`);

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
    hasGmailTokens: Boolean(process.env.GMAIL_TOKENS)
  });
});

app.get('/', (_req, res) => {
  res.render('index', {
    plataformas: Object.keys(PLATAFORMAS).map(key => ({
      key,
      nombre: PLATAFORMAS[key].nombre,
      icono: PLATAFORMAS[key].icono,
      color: PLATAFORMAS[key].color
    })),
    error: null
  });
});

app.post('/buscar-json', async (req, res) => {
  const { correo, plataforma } = req.body;
  if (!correo || !correo.includes('@')) {
    return res.json({ error: 'Correo inválido' });
  }
  if (!plataforma || !PLATAFORMAS[plataforma]) {
    return res.json({ error: 'Plataforma inválida' });
  }

  try {
    const correos = await searchEmailsByPlataforma(plataforma, correo);
    return res.json({
      success: true,
      plataforma: PLATAFORMAS[plataforma],
      correos,
      correoBuscado: correo
    });
  } catch (err) {
    console.error('Error /buscar-json:', err);
    return res.json({ error: 'Error al buscar correos: ' + err.message });
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
});
