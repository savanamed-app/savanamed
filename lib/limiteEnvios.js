// lib/limiteEnvios.js
// Protección anti-spam: máximo N emails por destinatario por hora.
//
// Por qué hace falta: cualquiera puede agendar una cita sin cuenta (es el producto).
// Sin este límite, alguien podría crear muchas citas falsas con el correo de otra
// persona y usar Savanamed para inundarla de emails desde nuestro dominio,
// quemando la reputación de savanamed.net y nuestra cuota de Resend.
//
// Guardamos un contador por destinatario en la colección "limitesEnvio".
// El email se guarda como hash (no en texto) para no acumular datos personales.
// Ninguna regla de Firestore abre esta colección, así que solo el servidor la toca.

import { createHash } from 'node:crypto';
import { db } from './firebaseAdmin.js';

const VENTANA_MS = 60 * 60 * 1000; // 1 hora
const MAXIMO = 5;

export async function permitirEnvio(email) {
  const id = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  const ref = db.collection('limitesEnvio').doc(id);

  // Transacción: si llegan dos peticiones a la vez, Firestore las ordena
  // para que el contador nunca se salte el límite.
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const ahora = Date.now();
    const datos = snap.exists ? snap.data() : null;

    if (!datos || ahora - datos.inicioVentana > VENTANA_MS) {
      tx.set(ref, { inicioVentana: ahora, cuenta: 1 });
      return true;
    }
    if (datos.cuenta >= MAXIMO) return false;

    tx.update(ref, { cuenta: datos.cuenta + 1 });
    return true;
  });
}
