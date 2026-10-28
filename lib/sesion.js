// lib/sesion.js
// ¿Quién está haciendo esta petición?
//
// Cuando el doctor inicia sesión, Firebase le da un "token": una credencial
// firmada por Google que dura 1 hora y que el navegador renueva solo. El panel
// la manda en cada petición (encabezado "Authorization: Bearer <token>").
// Aquí el servidor verifica la firma con Google: si alguien inventa o modifica
// un token, la verificación falla. Así sabemos con certeza qué doctor es,
// sin confiar en nada que diga el navegador.

import { auth } from './firebaseAdmin.js';

export const EMAIL_ADMIN = 'admin@savanamed.net';

export class ErrorSesion extends Error {
  constructor(mensaje = 'Tu sesión expiró. Vuelve a iniciar sesión.') {
    super(mensaje);
    this.status = 401;
  }
}

export async function verificarSesion(req) {
  const encabezado = String(req.headers.authorization || '');
  if (!encabezado.startsWith('Bearer ')) throw new ErrorSesion();
  try {
    const token = await auth.verifyIdToken(encabezado.slice(7));
    return { uid: token.uid, email: token.email || '', esAdmin: token.email === EMAIL_ADMIN };
  } catch {
    throw new ErrorSesion();
  }
}
