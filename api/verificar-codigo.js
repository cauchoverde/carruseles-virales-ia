import { google } from 'googleapis';
import nodemailer from 'nodemailer';

// Misma hoja de Google Sheets que usaba el escenario de Make "VerificarCodigo":
// columnas A=Email, B=Código, C=Fecha_Pago, D=Estado, E=Plan.
const SPREADSHEET_ID = '1Ir-EsyK55NAuFjGtWf64ti3kmFIbkIfGYa9bXW96UG4';
const SHEET_NAME = 'Hoja 1';

function getSheetsClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').replace(/\\n/g, '\n');
  const auth = new google.auth.JWT(email, null, key, ['https://www.googleapis.com/auth/spreadsheets']);
  return google.sheets({ version: 'v4', auth });
}

function generarCodigo() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

async function enviarCorreoActivacion(destinatario, codigo) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });

  await transporter.sendMail({
    from: `CauchoVerde Digital <${process.env.GMAIL_USER}>`,
    to: destinatario,
    subject: '✅ Acceso PRO activado - CauchoVerde Digital',
    html: `Hola,<br><br>¡Tu suscripción PRO está activa!<br><br>Accede aquí con tu código:<br>https://cauchoverde-microactivos.vercel.app/?code=${codigo}<br><br>Tu código de acceso: ${codigo}<br><br>Ahora tienes acceso ilimitado a:<br>✅ Generación ilimitada de carruseles<br>✅ Generación ilimitada de contenido semanal<br>✅ Generación ilimitada de prompts<br><br>¿Dudas? Responde este correo.<br><br>Equipo CauchoVerde Digital<br><br><img src="https://cauchoverde-microactivos.vercel.app/logo.png" width="150">`
  });
}

export default async function handler(req, res) {
  // Se llama desde varios dominios distintos (las 3 herramientas + ePayco), así
  // que respondemos con CORS abierto, igual que hacía el webhook de Make.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const datos = { ...(req.query || {}), ...(req.body || {}) };

  try {
    // Caso 1: una de las 3 herramientas pregunta si un código PRO es válido.
    if (datos.codigo) {
      const sheets = getSheetsClient();
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A:E`
      });
      const filas = resp.data.values || [];
      const codigoBuscado = String(datos.codigo).trim().toUpperCase();
      // fila[1] = columna B = Código. Saltamos la fila 0 (encabezados).
      const encontrado = filas.some(
        (fila, i) => i > 0 && String(fila[1] || '').trim().toUpperCase() === codigoBuscado
      );
      return res.status(200).json({ valido: encontrado });
    }

    // Caso 2: ePayco confirma que un pago se aprobó (x_cod_response === '1').
    if (datos.x_cod_response === '1' && datos.x_customer_email) {
      const codigo = generarCodigo();
      const sheets = getSheetsClient();
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A:E`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[
            datos.x_customer_email,
            codigo,
            new Date().toISOString().slice(0, 19).replace('T', ' '),
            'activo',
            'PRO'
          ]]
        }
      });
      await enviarCorreoActivacion(datos.x_customer_email, codigo);
      return res.status(200).json({ ok: true });
    }

    // Ninguno de los dos casos — ePayco a veces llama con pagos rechazados o
    // pendientes (x_cod_response distinto de '1'); no hacemos nada, pero
    // respondemos 200 para que ePayco no lo marque como fallo de su lado.
    return res.status(200).json({ ok: false, mensaje: 'Sin acción — pago no aprobado o faltan datos' });
  } catch (err) {
    console.error('Error en verificar-codigo:', err);
    return res.status(500).json({ error: 'Error interno', detalle: String(err && err.message ? err.message : err) });
  }
}
