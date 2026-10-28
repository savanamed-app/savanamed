// api/mi-cita.js
// La "ventanilla" del paciente. La usa la página mi-cita.html.
//
//   GET  /api/mi-cita?t=<token>                → ver mi cita
//   GET  /api/mi-cita?t=<token>&fecha=AAAA-MM-DD → horarios ocupados ese día
//   POST /api/mi-cita  { t, accion: 'cancelar' }
//   POST /api/mi-cita  { t, accion: 'reprogramar', fecha, hora }
//
// El token es el enlace firmado del email (lib/enlaces.js). Sin un token
// válido no se ve ni se toca nada. Al paciente solo se le devuelve lo mínimo:
// nunca el teléfono, el email ni el motivo (por si el enlace se reenvía).

import { waitUntil } from '@vercel/functions';
import { db } from '../lib/firebaseAdmin.js';
import { leerToken } from '../lib/enlaces.js';
import { leerHorario, diaDisponible } from '../lib/agenda.js';
import { ErrorCita } from '../lib/citas.js';
import { leerCitaPaciente, motivoNoModificable, cancelarPorPaciente, reprogramarCita } from '../lib/gestionPaciente.js';
import { notificarCambioPaciente } from '../lib/notificaciones.js';
import { permitir, HORA } from '../lib/limiteEnvios.js';

const ORIGENES_PERMITIDOS = new Set([
  'https://savanamed.net',
  'https://www.savanamed.net',
  'https://savanamed.vercel.app',
]);
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const RE_HORA = /^\d{2}:\d{2}$/;

function ipCliente(req) {
  return req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'desconocida';
}

const primerNombre = (n) => String(n || '').trim().split(/\s+/)[0] || '';

async function ver(req, res, ref) {
  const { fecha } = req.query || {};
  const { cita, perfil, doctor } = await leerCitaPaciente(ref);
  const horario = leerHorario(perfil);

  // Horarios ocupados de un día (para elegir nueva hora)
  if (fecha !== undefined) {
    if (!RE_FECHA.test(String(fecha)) || !diaDisponible(horario, fecha)) return res.status(200).json({ ocupados: [] });
    const snap = await db.collection('disponibilidad').doc(ref.uid).collection('ocupados').where('fecha', '==', fecha).get();
    return res.status(200).json({ ocupados: snap.docs.map((d) => d.data().hora) });
  }

  return res.status(200).json({
    cita: {
      nombre: primerNombre(cita.pacienteNombre),
      tipo: cita.tipo,
      fechaHora: cita.fechaHora,
      estado: cita.estado || 'pendiente',
    },
    doctor: {
      nombre: perfil.nombre || '',
      especialidad: perfil.especialidad || '',
      direccion: perfil.direccion || '',
      ciudad: perfil.ciudad || '',
      emoji: perfil.emoji || '',
      slug: doctor.slug || '',
    },
    horario,
    noModificable: motivoNoModificable(cita),
  });
}

async function actuar(req, res, ref) {
  const { accion, fecha, hora } = req.body || {};

  if (accion === 'cancelar') {
    const r = await cancelarPorPaciente(ref);
    if (r.cambio) waitUntil(notificarCambioPaciente(ref.uid, ref.citaId, { tipo: 'cancelada' }));
    return res.status(200).json({ ok: true, estado: r.estado });
  }

  if (accion === 'reprogramar') {
    if (!RE_FECHA.test(String(fecha)) || !RE_HORA.test(String(hora))) {
      return res.status(400).json({ error: 'Elige una fecha y hora válidas' });
    }
    const r = await reprogramarCita({ ...ref, fecha, hora });
    waitUntil(notificarCambioPaciente(ref.uid, ref.citaId, { tipo: 'reprogramada', anterior: r.anterior }));
    return res.status(200).json({ ok: true, fechaHora: r.fechaHora, estado: r.estado });
  }

  return res.status(400).json({ error: 'Acción inválida' });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (req.method === 'POST' && !ORIGENES_PERMITIDOS.has(req.headers.origin)) {
    return res.status(403).json({ error: 'Origen no permitido' });
  }

  try {
    // Anti-abuso: nadie legítimo abre su cita 60 veces en una hora
    const max = req.method === 'GET' ? 60 : 20;
    if (!(await permitir(`mi-cita-${req.method}:${ipCliente(req)}`, { max, ventanaMs: HORA }))) {
      return res.status(429).json({ error: 'Demasiadas solicitudes. Intenta de nuevo más tarde.' });
    }

    const token = req.method === 'GET' ? req.query?.t : req.body?.t;
    const ref = leerToken(token);
    if (!ref) return res.status(404).json({ error: 'Este enlace no es válido. Revisa que lo hayas copiado completo.' });

    return req.method === 'GET' ? await ver(req, res, ref) : await actuar(req, res, ref);
  } catch (err) {
    if (err instanceof ErrorCita) return res.status(err.status).json({ error: err.message });
    console.error('[mi-cita]', err);
    return res.status(500).json({ error: 'Algo falló de nuestro lado. Intenta de nuevo.' });
  }
}
