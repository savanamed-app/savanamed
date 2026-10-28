// api/agendar-cita.js
// Endpoint: POST https://savanamed.net/api/agendar-cita
//
// La ÚNICA forma en que un paciente puede crear una cita. El navegador ya no
// escribe en Firebase: le pide la cita a este servidor, que valida todo y la guarda.
//
// Qué garantiza:
//  - La cita respeta el horario real del doctor (días, horas, duración)
//  - El teléfono es válido y queda normalizado (+58...) para WhatsApp
//  - Dos pacientes nunca reservan el mismo horario (transacción atómica)
//  - Límite de reservas por IP y por teléfono (anti-spam)
//  - Un doctor suspendido no recibe citas
//  - Los datos del paciente quedan privados: solo el doctor los lee

import { waitUntil } from '@vercel/functions';
import { db } from '../lib/firebaseAdmin.js';
import { permitir, HORA, DIA } from '../lib/limiteEnvios.js';
import { notificarCitaNueva } from '../lib/notificaciones.js';
import { leerHorario, validarSlot, normalizarTelefono } from '../lib/agenda.js';

const ORIGENES_PERMITIDOS = new Set([
  'https://savanamed.net',
  'https://www.savanamed.net',
  'https://savanamed.vercel.app',
]);
const TIPOS = new Set(['consulta', 'revision', 'procedimiento', 'emergencia']);
const RE_SLUG = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
const RE_UID = /^[A-Za-z0-9_-]{1,128}$/;
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

class ErrorReserva extends Error {
  constructor(status, mensaje) { super(mensaje); this.status = status; }
}

const texto = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Valida y limpia lo que manda el navegador. Nada se usa sin pasar por aquí.
export function validarSolicitud(body = {}) {
  const slug = texto(body.slug, 50).toLowerCase();
  const tipo = texto(body.tipo, 20);
  const fecha = texto(body.fecha, 10);
  const hora = texto(body.hora, 5);
  const nombre = texto(body.nombre, 100);
  const telefono = normalizarTelefono(body.telefono);
  const email = texto(body.email, 254).toLowerCase();
  const motivo = texto(body.motivo, 500);

  if (!RE_SLUG.test(slug)) throw new ErrorReserva(400, 'Doctor inválido');
  if (!TIPOS.has(tipo)) throw new ErrorReserva(400, 'Tipo de cita inválido');
  if (nombre.length < 2) throw new ErrorReserva(400, 'Ingresa tu nombre completo');
  if (!telefono) throw new ErrorReserva(400, 'Ingresa un número de teléfono válido, por ejemplo 0412 1234567');
  if (email && !RE_EMAIL.test(email)) throw new ErrorReserva(400, 'El email no es válido');

  return { slug, tipo, fecha, hora, nombre, telefono, email, motivo };
}

function ipCliente(req) {
  return req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'desconocida';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (!ORIGENES_PERMITIDOS.has(req.headers.origin)) return res.status(403).json({ error: 'Origen no permitido' });

  try {
    // 1. Validar formato (barato, antes de tocar la base de datos)
    const s = validarSolicitud(req.body);

    // 2. Anti-spam por IP: máx. 10 reservas por hora desde una misma conexión
    if (!(await permitir(`reserva-ip:${ipCliente(req)}`, { max: 10, ventanaMs: HORA }))) {
      throw new ErrorReserva(429, 'Demasiadas solicitudes. Intenta de nuevo más tarde.');
    }

    // 3. Doctor: perfil público + cuenta privada (para saber si está suspendido)
    const perfilSnap = await db.collection('perfiles').doc(s.slug).get();
    const perfil = perfilSnap.exists ? perfilSnap.data() : null;
    if (!perfil || !RE_UID.test(perfil.uid || '')) throw new ErrorReserva(404, 'Doctor no encontrado');
    const uid = perfil.uid;

    const doctorSnap = await db.collection('doctores').doc(uid).get();
    if (!doctorSnap.exists || doctorSnap.data().suspendido === true) {
      throw new ErrorReserva(403, 'Este doctor no está recibiendo citas en este momento');
    }

    // 4. ¿El horario es válido según la agenda real del doctor?
    const motivoRechazo = validarSlot(leerHorario(perfil), s.fecha, s.hora);
    if (motivoRechazo) throw new ErrorReserva(400, motivoRechazo);

    // 5. Anti-spam por teléfono: máx. 3 reservas al día con un mismo número
    if (!(await permitir(`reserva-tel:${s.telefono}`, { max: 3, ventanaMs: DIA }))) {
      throw new ErrorReserva(429, 'Ya hiciste varias reservas hoy con este número. Contacta al consultorio.');
    }

    // 6. Crear la cita y marcar el horario como ocupado EN UNA SOLA TRANSACCIÓN.
    //    Si dos pacientes eligen el mismo horario al mismo tiempo, Firestore
    //    deja pasar solo a uno; el otro recibe "ese horario acaba de ser tomado".
    const slotRef = db.collection('disponibilidad').doc(uid).collection('ocupados').doc(`${s.fecha}T${s.hora}`);
    const citaRef = db.collection('doctores').doc(uid).collection('citas').doc();

    await db.runTransaction(async (tx) => {
      const slot = await tx.get(slotRef);
      if (slot.exists) throw new ErrorReserva(409, 'Ese horario acaba de ser tomado. Elige otro, por favor.');

      tx.create(citaRef, {
        pacienteNombre: s.nombre,
        pacienteTel: s.telefono,
        pacienteEmail: s.email,
        tipo: s.tipo,
        fechaHora: `${s.fecha}T${s.hora}`,
        motivo: s.motivo,
        estado: s.tipo === 'emergencia' ? 'urgente' : 'pendiente',
        creadoEn: new Date().toISOString(),
        origen: 'publico',
      });
      // El "tablero público": solo fecha y hora, ningún dato del paciente.
      tx.create(slotRef, { fecha: s.fecha, hora: s.hora, citaId: citaRef.id });
    });

    // 7. Responder ya al paciente; los emails siguen en segundo plano.
    //    waitUntil le pide a Vercel que no apague la función hasta que terminen.
    waitUntil(notificarCitaNueva(uid, citaRef.id));

    return res.status(201).json({ ok: true });
  } catch (err) {
    if (err instanceof ErrorReserva) return res.status(err.status).json({ error: err.message });
    console.error('[agendar-cita]', err);
    return res.status(500).json({ error: 'No pudimos guardar la cita. Intenta de nuevo.' });
  }
}
