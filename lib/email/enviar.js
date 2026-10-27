// lib/email/enviar.js
// La única pieza que habla con Resend. Si algún día cambiamos de proveedor
// de email, solo se toca este archivo.

import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);
const REMITENTE = 'Savanamed <citas@savanamed.net>';

// idempotencyKey: si por un reintento mandamos el mismo email dos veces,
// Resend lo reconoce y lo envía una sola vez.
export async function enviarEmail({ para, subject, html, text, idempotencyKey }) {
  const { data, error } = await resend.emails.send(
    { from: REMITENTE, to: [para], subject, html, text },
    { idempotencyKey }
  );
  if (error) throw new Error(`Resend: ${error.name || ''} ${error.message || ''}`.trim());
  return data?.id || null;
}
