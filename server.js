require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5174;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = `http://localhost:${PORT}/auth/google/callback`;
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'secreto-por-defecto',
  resave: false,
  saveUninitialized: true
}));

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

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
    asuntos: [
      'Tu código de verificación de Disney+',
      'Disney+ código de acceso'
    ]
  },
  primevideo: {
    nombre: 'Prime Video',
    icono: '📦',
    color: '#00A8E1',
    asuntos: [
      'Código de verificación Amazon Prime',
      'Prime Video: Código de acceso temporal'
    ]
  },
  hbomax: {
    nombre: 'HBO Max',
    icono: '🎬',
    color: '#6A1B9A',
    asuntos: [
      'Código de verificación HBO Max',
      'HBO Max código de acceso'
    ]
  },
  spotify: {
    nombre: 'Spotify',
    icono: '🎵',
    color: '#1DB954',
    asuntos: [
      'Código de verificación Spotify',
      'Spotify: Código de acceso temporal'
    ]
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

// EXTRAE EL CUERPO HTML DE FORMA ROBUSTA
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
  // Si encontramos HTML, lo devolvemos; si no, el texto plano
  return htmlBody || plainBody;
}

function getHeaders(payload) {
  const headers = {};
  for (const header of payload.headers || []) {
    headers[header.name.toLowerCase()] = header.value;
  }
  return headers;
}

async function searchEmailsByPlataforma(plataformaKey, destinatario = null) {
  try {
    if (!process.env.GMAIL_TOKENS) {
      throw new Error('No hay tokens');
    }
    oauth2Client.setCredentials(JSON.parse(process.env.GMAIL_TOKENS));
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const subjectQuery = buildSubjectQuery(plataformaKey);
    if (!subjectQuery) return [];

    let query = `(${subjectQuery})`;
    if (destinatario) {
      query = `(to:${destinatario} OR deliveredto:${destinatario}) AND (${subjectQuery})`;
    }
    console.log(`🔍 Consulta Gmail: ${query}`);

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
        body: body,
        snippet: fullMsg.data.snippet
      });
    }
    resultados.sort((a, b) => new Date(b.date) - new Date(a.date));
    return resultados;
  } catch (error) {
    console.error('Error en búsqueda:', error);
    throw error;
  }
}

// ========== RUTAS ==========
app.get('/', (req, res) => {
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
    if (!process.env.GMAIL_TOKENS) {
      return res.json({ error: 'Cuenta Gmail central no conectada' });
    }
    const correos = await searchEmailsByPlataforma(plataforma, correo);
    res.json({
      success: true,
      plataforma: PLATAFORMAS[plataforma],
      correos: correos,
      correoBuscado: correo
    });
  } catch (err) {
    console.error(err);
    res.json({ error: 'Error al buscar correos' });
  }
});

app.get('/auth/google', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('No se recibió código.');
  try {
    const { tokens } = await oauth2Client.getToken(code);
    const envPath = '.env';
    let envContent = fs.readFileSync(envPath, 'utf8');
    envContent = envContent.replace(/^GMAIL_TOKENS=.*$/gm, '');
    envContent += `\nGMAIL_TOKENS='${JSON.stringify(tokens)}'`;
    fs.writeFileSync(envPath, envContent);
    console.log('✅ Tokens guardados.');
    res.send('Cuenta autorizada. <a href="/">Volver</a>');
  } catch (error) {
    console.error(error);
    res.send('Error al autenticar.');
  }
});

app.listen(PORT, () => {
  console.log(`Servidor en http://localhost:${PORT}`);
  if (!process.env.GMAIL_TOKENS) {
    console.log(`⚠️ Autoriza tu cuenta Gmail: http://localhost:${PORT}/auth/google`);
  }
});