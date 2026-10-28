// lib/sesion.js
// ¿Quién está haciendo esta petición?
//
// Cuando el doctor inicia sesión, Firebase le da un "token": una credencial
// firmada por Google que dura 1 hora y que el navegador renueva solo. El panel
// la manda en cada petición (encabezado "Authorization: Bearer <token>").
// Aquí el servidor verifica la firma con las llaves públicas de Google: si
// alguien inventa o modifica un token, la verificación falla. Así sabemos con
// certeza qué doctor es, sin confiar en nada que diga el navegador.
//
// Por qué no usamos firebase-admin/auth: arrastra una librería antigua
// (jwks-rsa) que choca con el entorno de Vercel y tumba la función completa.
// Esta verificación es la que documenta Google para hacerla "a mano", con
// "jose", una librería estándar y liviana. Mismo nivel de seguridad.

import { createRemoteJWKSet, jwtVerify } from 'jose';

export const EMAIL_ADMIN = 'admin@savanamed.net';

// Llaves públicas con las que Google firma los tokens de Firebase.
// jose las descarga una vez y las guarda en memoria (no en cada petición).
const LLAVES_GOOGLE = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
);

export class ErrorSesion extends Error {
  constructor(mensaje = 'Tu sesión expiró. Vuelve a iniciar sesión.') {
    super(mensaje);
    this.status = 401;
  }
}

export async function verificarSesion(req, { llaves = LLAVES_GOOGLE } = {}) {
  const proyecto = process.env.FIREBASE_PROJECT_ID;
  const encabezado = String(req.headers.authorization || '');
  if (!proyecto || !encabezado.startsWith('Bearer ')) throw new ErrorSesion();

  try {
    const { payload } = await jwtVerify(encabezado.slice(7), llaves, {
      algorithms: ['RS256'],
      issuer: `https://securetoken.google.com/${proyecto}`, // emitido por Firebase…
      audience: proyecto,                                     // …para NUESTRO proyecto
    });
    if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('sin uid');
    const email = typeof payload.email === 'string' ? payload.email : '';
    return {
      uid: payload.sub,
      email,
      // El admin solo cuenta si Google verificó que ese email es suyo
      esAdmin: email === EMAIL_ADMIN && payload.email_verified === true,
    };
  } catch {
    throw new ErrorSesion();
  }
}
