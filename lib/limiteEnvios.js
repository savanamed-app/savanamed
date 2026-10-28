// lib/limiteEnvios.js
// Limitador de frecuencia ("rate limit") genérico, guardado en Firestore.
//
// Uso: permitir('reserva-ip:1.2.3.4', { max: 10, ventanaMs: HORA })
//   → true si todavía hay cupo en la ventana, false si se pasó del límite.
//
// Por qué hace falta: cualquiera puede agendar sin cuenta (es el producto).
// Sin límites, alguien podría llenar la agenda de un doctor con citas falsas
// o usar Savanamed para inundar de emails a otra persona.
//
// Las claves se guardan como hash (no en texto) para no acumular datos personales
// como emails o IPs. Ninguna regla de Firestore abre la colección "limites":
// solo el servidor la toca.

import { createHash } from 'node:crypto';
import { db } from './firebaseAdmin.js';

export const HORA = 60 * 60 * 1000;
export const DIA = 24 * HORA;

export async function permitir(clave, { max, ventanaMs }) {
  const id = createHash('sha256').update(String(clave).trim().toLowerCase()).digest('hex');
  const ref = db.collection('limites').doc(id);

  // Transacción: si llegan dos peticiones a la vez, Firestore las ordena
  // para que el contador nunca se salte el límite.
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const ahora = Date.now();
    const datos = snap.exists ? snap.data() : null;

    if (!datos || ahora - datos.inicioVentana > ventanaMs) {
      tx.set(ref, { inicioVentana: ahora, cuenta: 1, expira: new Date(ahora + ventanaMs) });
      return true;
    }
    if (datos.cuenta >= max) return false;

    tx.update(ref, { cuenta: datos.cuenta + 1 });
    return true;
  });
}

// Máximo 5 emails por hora a una misma dirección.
export const permitirEnvio = (email) => permitir(`email:${email}`, { max: 5, ventanaMs: HORA });
