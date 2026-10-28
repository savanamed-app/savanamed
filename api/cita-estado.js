// api/cita-estado.js
// Endpoint: POST https://savanamed.net/api/cita-estado
// Body: { citaId, accion: 'confirmar' | 'cancelar' }
//
// El panel del doctor llama aquí para confirmar o cancelar una cita.
// El servidor:
//  1. Verifica QUIÉN es (token de sesión firmado por Google)
//  2. Solo deja tocar citas del propio doctor (el admin puede tocar cualquiera)
//  3. Cambia el estado con las reglas de lib/citas.js (atómico, con historial)
//  4. Avisa al paciente por email en segundo plano

import { waitUntil } from '@vercel/functions';
import { verificarSesion, ErrorSesion } from '../lib/sesion.js';
import { cambiarEstadoCita, ACCIONES, ErrorCita } from '../lib/citas.js';
import { notificarCambioEstado } from '../lib/notificaciones.js';
import { permitir, HORA } from '../lib/limiteEnvios.js';

const ORIGENES_PERMITIDOS = new Set([
  'https://savanamed.net',
  'https://www.savanamed.net',
  'https://savanamed.vercel.app',
]);
const RE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (!ORIGENES_PERMITIDOS.has(req.headers.origin)) return res.status(403).json({ error: 'Origen no permitido' });

  try {
    const sesion = await verificarSesion(req);

    const { citaId, accion } = req.body || {};
    if (!RE_ID.test(String(citaId || ''))) return res.status(400).json({ error: 'Cita inválida' });
    if (!ACCIONES.includes(accion)) return res.status(400).json({ error: 'Acción inválida' });

    // El doctor solo actúa sobre SU cuenta. El admin puede indicar otro doctor.
    let uid = sesion.uid;
    if (sesion.esAdmin && req.body.doctorUid) {
      if (!RE_ID.test(String(req.body.doctorUid))) return res.status(400).json({ error: 'Doctor inválido' });
      uid = req.body.doctorUid;
    }

    // Freno de seguridad: un doctor real no hace 300 cambios en una hora
    if (!(await permitir(`cita-estado:${sesion.uid}`, { max: 300, ventanaMs: HORA }))) {
      return res.status(429).json({ error: 'Demasiados cambios seguidos. Espera un momento.' });
    }

    const r = await cambiarEstadoCita({ uid, citaId, accion, por: sesion.esAdmin ? 'admin' : 'doctor' });

    // Solo se avisa si el estado realmente cambió (doble clic = un solo email)
    if (r.cambio) waitUntil(notificarCambioEstado(uid, citaId, r.estado));

    return res.status(200).json({ ok: true, estado: r.estado, cambio: r.cambio });
  } catch (err) {
    if (err instanceof ErrorSesion || err instanceof ErrorCita) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('[cita-estado]', err);
    return res.status(500).json({ error: 'No pudimos actualizar la cita. Intenta de nuevo.' });
  }
}
