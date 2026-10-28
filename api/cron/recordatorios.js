// api/cron/recordatorios.js
// Endpoint que dispara el cron de Vercel una vez al día (ver vercel.json).
//
// Seguridad: solo Vercel puede ejecutarlo. Vercel envía la variable secreta
// CRON_SECRET en el encabezado "Authorization: Bearer ...". Si alguien más
// llama a esta URL sin la clave, recibe 401 y no pasa nada.

import { timingSafeEqual } from 'node:crypto';
import { ejecutarRecordatorios } from '../../lib/recordatorios.js';

// Comparación en tiempo constante: evita adivinar la clave midiendo
// cuánto tarda el servidor en responder.
function claveValida(recibida, esperada) {
  if (!esperada || typeof recibida !== 'string') return false;
  const a = Buffer.from(recibida);
  const b = Buffer.from(`Bearer ${esperada}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (!claveValida(req.headers.authorization, process.env.CRON_SECRET)) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  try {
    const informe = await ejecutarRecordatorios();
    console.log('[recordatorios]', JSON.stringify(informe));
    return res.status(200).json({ ok: true, ...informe });
  } catch (err) {
    console.error('[recordatorios]', err);
    return res.status(500).json({ error: String(err.message || err).slice(0, 300) });
  }
}
