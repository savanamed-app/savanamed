// lib/enlaces.js
// Enlace secreto para que el paciente gestione SU cita (cancelar o cambiar),
// sin cuenta ni contraseña.
//
// Cómo funciona: el enlace lleva el doctor, la cita y una FIRMA:
//     savanamed.net/mi-cita.html?t=<uid>.<citaId>.<firma>
// La firma es un HMAC-SHA256 calculado con una clave secreta que solo conoce
// el servidor (CITA_ENLACE_SECRET en Vercel). Sin esa clave es imposible
// fabricar la firma de otra cita, así que nadie puede adivinar enlaces ajenos.
//
// Ventajas de este diseño:
//  - No guarda nada en la base de datos (cero lecturas/escrituras extra)
//  - Funciona para TODAS las citas, incluso las creadas antes de esta función
//    y las que el doctor crea a mano en su panel

import { createHmac, timingSafeEqual } from 'node:crypto';

const RE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const BASE = 'https://savanamed.net/mi-cita.html?t=';

function clave() {
  const s = process.env.CITA_ENLACE_SECRET;
  return s && s.length >= 32 ? s : null;
}

function firmar(secreto, uid, citaId) {
  return createHmac('sha256', secreto).update(`cita:${uid}:${citaId}`).digest('base64url');
}

/** Devuelve el enlace de gestión, o '' si falta la clave (el email sale sin botón). */
export function enlaceGestion(uid, citaId) {
  const secreto = clave();
  if (!secreto || !RE_ID.test(uid) || !RE_ID.test(citaId)) return '';
  return `${BASE}${uid}.${citaId}.${firmar(secreto, uid, citaId)}`;
}

/** Valida un token del enlace. Devuelve { uid, citaId } o null si es falso. */
export function leerToken(token) {
  const secreto = clave();
  if (!secreto || typeof token !== 'string' || token.length > 400) return null;
  const partes = token.split('.');
  if (partes.length !== 3) return null;
  const [uid, citaId, firma] = partes;
  if (!RE_ID.test(uid) || !RE_ID.test(citaId)) return null;

  const esperada = Buffer.from(firmar(secreto, uid, citaId));
  const recibida = Buffer.from(firma);
  // Comparación en tiempo constante: no se puede adivinar la firma midiendo tiempos
  if (esperada.length !== recibida.length || !timingSafeEqual(esperada, recibida)) return null;
  return { uid, citaId };
}
