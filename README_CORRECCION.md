# Corrección principal Render/Railway/Gmail OAuth

## Error principal detectado

El proyecto original usaba estas variables en `server.js`:

```env
CLIENT_ID
CLIENT_SECRET
REDIRECT_URI
```

Pero en Render se estaban configurando estas otras:

```env
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI
```

Por eso Google OAuth podía usar `localhost` o un redirect incorrecto, provocando errores como `invalid_grant`.

También se estaba usando una ruta distinta:

- Proyecto original: `/auth/google/callback`
- Configuración anterior: `/api/oauth2/callback`

El nuevo `server.js` acepta ambos nombres de variables y también soporta ambos callbacks, pero debes usar uno solo en la configuración final.

## Configuración recomendada en Render

Root Directory: vacío

Build Command:

```bash
npm install
```

Start Command:

```bash
npm start
```

Environment Variables:

```env
NODE_ENV=production
GOOGLE_CLIENT_ID=tu_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=tu_client_secret
GOOGLE_REDIRECT_URI=https://code-ylhz.onrender.com/auth/google/callback
SESSION_SECRET=una_clave_larga_segura
```

No agregues `PORT=5174`. Render coloca el puerto automáticamente.

No dejes `GMAIL_TOKENS` viejo. Primero bórralo, guarda y redespliega.

## Configuración en Google Cloud Console

En OAuth Client ID, agrega exactamente:

```txt
https://code-ylhz.onrender.com/auth/google/callback
```

Debe coincidir exactamente con `GOOGLE_REDIRECT_URI`.

## Cómo generar GMAIL_TOKENS nuevo

1. En Render, borra `GMAIL_TOKENS` si existe.
2. Guarda y redespliega.
3. Abre:

```txt
https://code-ylhz.onrender.com/auth/google
```

4. Autoriza la cuenta Gmail.
5. Copia el JSON que aparece.
6. Pégalo en Render como nueva variable:

```env
GMAIL_TOKENS=JSON_COMPLETO_AQUI
```

7. Guarda con Save, rebuild, and deploy.

## Prueba rápida

Abre:

```txt
https://code-ylhz.onrender.com/health
```

Debe mostrar `ok: true` y confirmar si existen las variables necesarias.
