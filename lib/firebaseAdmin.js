// lib/firebaseAdmin.js
// Conexión del servidor con Firebase usando la "service account" (llave maestra).
// Las credenciales vienen de las variables de entorno de Vercel: nunca del código.
//
// Se inicializa una sola vez por instancia (patrón singleton): Vercel reutiliza
// la misma instancia entre peticiones, y reconectar en cada una sería lento.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function leerCredenciales() {
  const projectId   = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey  = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Faltan variables de entorno de Firebase en Vercel');
  }

  // Al pegar la llave en Vercel, los saltos de línea quedan como el texto "\n".
  // Aquí los convertimos de vuelta en saltos de línea reales.
  return { projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') };
}

const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(leerCredenciales()) });

export const db = getFirestore(app);
