// lib/gestionPaciente.js
// Lo que el PACIENTE puede hacer con su cita desde el enlace del email:
// verla, cancelarla o cambiarla de fecha/hora.
//
// Reglas del negocio:
//  - Solo citas activas (pendiente, confirmada, urgente)
//  - Hasta 2 horas antes de la cita. Después, debe llamar al consultorio
//    (el doctor ya organizó su día; un cambio de última hora se habla).
//  - Máximo 3 cambios de fecha por cita (evita abuso del sistema)
//  - Al cambiar de fecha, la cita vuelve a "pendiente": el doctor la reconfirma

import { FieldValue } from 'firebase-admin/firestore';
import { db } from './firebaseAdmin.js';
import { leerHorario, validarSlot, ahoraVenezuela, aMinutos } from './agenda.js';
import { cambiarEstadoCita, ErrorCita } from './citas.js';

export const ANTICIPACION_MIN = 120;
export const MAX_REPROGRAMACIONES = 3;
const ACTIVAS = new Set(['pendiente', 'confirmada', 'urgente']);

const minutosDelDia = (fecha) => {
  const [a, m, d] = fecha.split('-').map(Number);
  return Date.UTC(a, m - 1, d) / 60000;
};

/** Minutos que faltan para la cita (hora de Venezuela). Negativo si ya pasó. */
export function minutosHasta(fechaHora, ahoraMs = Date.now()) {
  const ahora = ahoraVenezuela(ahoraMs);
  const [fecha, hora] = String(fechaHora).split('T');
  return (minutosDelDia(fecha) + aMinutos(hora)) - (minutosDelDia(ahora.fecha) + ahora.minutos);
}

/** ¿Puede el paciente modificar esta cita? Devuelve null si sí, o el motivo si no. */
export function motivoNoModificable(cita, ahoraMs = Date.now()) {
  const estado = cita.estado || 'pendiente';
  if (estado === 'cancelada') return 'Esta cita ya fue cancelada.';
  if (!ACTIVAS.has(estado)) return 'Esta cita ya no se puede modificar.';
  const faltan = minutosHasta(cita.fechaHora, ahoraMs);
  if (faltan <= 0) return 'Esta cita ya pasó.';
  if (faltan < ANTICIPACION_MIN) return 'Faltan menos de 2 horas para tu cita. Para cambios, comunícate directamente con el consultorio.';
  return null;
}

/** Lee la cita y el perfil público del doctor. */
export async function leerCitaPaciente({ uid, citaId }) {
  const citaSnap = await db.collection('doctores').doc(uid).collection('citas').doc(citaId).get();
  if (!citaSnap.exists) throw new ErrorCita(404, 'No encontramos esta cita');
  const doctorSnap = await db.collection('doctores').doc(uid).get();
  const doctor = doctorSnap.exists ? doctorSnap.data() : {};
  const perfilSnap = doctor.slug ? await db.collection('perfiles').doc(doctor.slug).get() : null;
  const perfil = perfilSnap?.exists ? perfilSnap.data() : {};
  return { cita: citaSnap.data(), doctor, perfil };
}

export async function cancelarPorPaciente({ uid, citaId, ahoraMs = Date.now() }) {
  const { cita } = await leerCitaPaciente({ uid, citaId });
  const motivo = motivoNoModificable(cita, ahoraMs);
  if (motivo) throw new ErrorCita(409, motivo);
  return cambiarEstadoCita({ uid, citaId, accion: 'cancelar', por: 'paciente', ahoraMs });
}

/**
 * Mueve la cita a otra fecha/hora en UNA transacción: ocupa el horario nuevo,
 * libera el viejo y actualiza la cita. Si dos personas eligen el mismo horario
 * al mismo tiempo, solo una lo consigue.
 */
export async function reprogramarCita({ uid, citaId, fecha, hora, ahoraMs = Date.now() }) {
  const { perfil, doctor } = await leerCitaPaciente({ uid, citaId });
  if (doctor.suspendido === true) throw new ErrorCita(403, 'Este consultorio no está recibiendo citas en este momento');

  const error = validarSlot(leerHorario(perfil), fecha, hora, ahoraVenezuela(ahoraMs));
  if (error) throw new ErrorCita(400, error);
  const nueva = `${fecha}T${hora}`;
  if (minutosHasta(nueva, ahoraMs) < ANTICIPACION_MIN) {
    throw new ErrorCita(400, 'Elige un horario con al menos 2 horas de anticipación');
  }

  const citaRef = db.collection('doctores').doc(uid).collection('citas').doc(citaId);
  const tablero = db.collection('disponibilidad').doc(uid).collection('ocupados');

  return db.runTransaction(async (tx) => {
    // 1. Leer todo primero
    const snap = await tx.get(citaRef);
    if (!snap.exists) throw new ErrorCita(404, 'No encontramos esta cita');
    const cita = snap.data();
    const motivo = motivoNoModificable(cita, ahoraMs);
    if (motivo) throw new ErrorCita(409, motivo);
    if (cita.fechaHora === nueva) throw new ErrorCita(400, 'Ese ya es el horario de tu cita');
    if ((cita.reprogramaciones || 0) >= MAX_REPROGRAMACIONES) {
      throw new ErrorCita(409, 'Ya cambiaste esta cita varias veces. Comunícate con el consultorio.');
    }

    const slotNuevoRef = tablero.doc(nueva);
    const slotViejoRef = tablero.doc(cita.fechaHora);
    const [slotNuevo, slotViejo] = await Promise.all([tx.get(slotNuevoRef), tx.get(slotViejoRef)]);
    if (slotNuevo.exists) throw new ErrorCita(409, 'Ese horario acaba de ser tomado. Elige otro, por favor.');

    // 2. Escribir
    const en = new Date().toISOString();
    const estadoNuevo = cita.estado === 'urgente' ? 'urgente' : 'pendiente';
    tx.create(slotNuevoRef, { fecha, hora, citaId });
    if (slotViejo.exists && slotViejo.data().citaId === citaId) tx.delete(slotViejoRef);
    tx.update(citaRef, {
      fechaHora: nueva,
      estado: estadoNuevo,
      reprogramaciones: FieldValue.increment(1),
      // La nueva fecha necesita su propio recordatorio y su propia confirmación
      'notificaciones.recordatorio': FieldValue.delete(),
      'notificaciones.confirmada': FieldValue.delete(),
      historial: FieldValue.arrayUnion({ estado: estadoNuevo, accion: 'reprogramada', de: cita.fechaHora, a: nueva, en, por: 'paciente' }),
    });

    return { anterior: cita.fechaHora, fechaHora: nueva, estado: estadoNuevo };
  });
}
