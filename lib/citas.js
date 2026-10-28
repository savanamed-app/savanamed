// lib/citas.js
// Reglas del negocio para cambiar el estado de una cita.
//
// Todo cambio de estado pasa por aquí (servidor), no por el navegador. Así:
//  - Solo se permiten cambios que tienen sentido (no se "confirma" una cancelada)
//  - Cancelar libera el horario en el mismo instante, sin riesgo de quedar a medias
//  - Cada cambio queda registrado en el historial de la cita (auditoría)
//  - El aviso al paciente nunca se olvida: lo dispara el servidor

import { FieldValue } from 'firebase-admin/firestore';
import { db } from './firebaseAdmin.js';
import { ahoraVenezuela } from './agenda.js';

// Desde qué estados se puede llegar a cada uno.
const TRANSICIONES = {
  confirmar: { destino: 'confirmada', desde: ['pendiente', 'urgente'] },
  cancelar:  { destino: 'cancelada',  desde: ['pendiente', 'urgente', 'confirmada'] },
};
export const ACCIONES = Object.keys(TRANSICIONES);

export class ErrorCita extends Error {
  constructor(status, mensaje) { super(mensaje); this.status = status; }
}

function yaPaso(fechaHora, ahoraMs) {
  const { fecha, minutos } = ahoraVenezuela(ahoraMs);
  const hhmm = `${String(Math.floor(minutos / 60)).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}`;
  return String(fechaHora) < `${fecha}T${hhmm}`;
}

/**
 * Cambia el estado de una cita de forma atómica.
 * Devuelve { cambio: true|false, estado }. cambio=false significa que la cita
 * ya estaba en ese estado (pulsar dos veces el botón no hace nada dos veces).
 */
export async function cambiarEstadoCita({ uid, citaId, accion, por, ahoraMs = Date.now() }) {
  const regla = TRANSICIONES[accion];
  if (!regla) throw new ErrorCita(400, 'Acción inválida');

  const citaRef = db.collection('doctores').doc(uid).collection('citas').doc(citaId);

  return db.runTransaction(async (tx) => {
    // En una transacción, primero se lee todo y después se escribe.
    const snap = await tx.get(citaRef);
    if (!snap.exists) throw new ErrorCita(404, 'Esa cita no existe');
    const cita = snap.data();
    const actual = cita.estado || 'pendiente';

    if (actual === regla.destino) return { cambio: false, estado: actual };
    if (!regla.desde.includes(actual)) {
      throw new ErrorCita(409, `No se puede ${accion} una cita ${actual}`);
    }
    if (yaPaso(cita.fechaHora, ahoraMs)) throw new ErrorCita(409, 'Esa cita ya pasó');

    let slotRef = null;
    if (accion === 'cancelar' && cita.fechaHora) {
      const ref = db.collection('disponibilidad').doc(uid).collection('ocupados').doc(cita.fechaHora);
      const slot = await tx.get(ref);
      // Solo liberamos el horario si es de ESTA cita (no borrar el de otra)
      if (slot.exists && slot.data().citaId === citaId) slotRef = ref;
    }

    const en = new Date().toISOString();
    tx.update(citaRef, {
      estado: regla.destino,
      [`${regla.destino}En`]: en,
      historial: FieldValue.arrayUnion({ estado: regla.destino, de: actual, en, por }),
    });
    if (slotRef) tx.delete(slotRef);

    return { cambio: true, estado: regla.destino };
  });
}
