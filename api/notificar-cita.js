// api/notificar-cita.js
// Endpoint: POST https://savanamed.net/api/notificar-cita
// Body: { "doctorUid": "...", "citaId": "..." }
//
// Lo llama la página de agendar justo después de guardar una cita.
// Regla de oro: NO confiamos en lo que manda el navegador. Solo recibimos
// dos IDs, y todos los datos (paciente, doctor, fecha) los leemos nosotros
// mismos de Firebase. Así nadie puede inventar el contenido de un email.

import { db } from '../lib/firebaseAdmin.js';
import { enviarEmail } from '../lib/email/enviar.js';
import { emailPaciente, emailDoctor } from '../lib/email/plantillas.js';
import { permitirEnvio } from '../lib/limiteEnvios.js';

const ORIGENES_PERMITIDOS = new Set([
  'https://savanamed.net',
  'https://www.savanamed.net',
  'https://savanamed.vercel.app',
]);
const ID_VALIDO = /^[A-Za-z0-9_-]{1,128}$/;
const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const VENTANA_NOTIFICACION_MS = 15 * 60 * 1000; // solo citas creadas hace < 15 min

export default async function handler(req, res) {
  // 1. Solo POST, y solo desde nuestras propias páginas
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (!ORIGENES_PERMITIDOS.has(req.headers.origin)) return res.status(403).json({ error: 'Origen no permitido' });

  // 2. Validar los IDs (formato estricto: nada de rutas raras ni textos largos)
  const { doctorUid, citaId } = req.body || {};
  if (!ID_VALIDO.test(doctorUid || '') || !ID_VALIDO.test(citaId || '')) {
    return res.status(400).json({ error: 'Datos inválidos' });
  }

  const citaRef = db.collection('doctores').doc(doctorUid).collection('citas').doc(citaId);

  try {
    // 3. "Reclamar" la cita dentro de una transacción.
    //    Si dos peticiones llegan para la misma cita, solo una gana:
    //    así nunca se envía la confirmación dos veces.
    const cita = await db.runTransaction(async (tx) => {
      const snap = await tx.get(citaRef);
      if (!snap.exists) return { motivo: 'no_existe' };

      const datos = snap.data();
      if (datos.notificaciones?.confirmacion) return { motivo: 'ya_notificada' };

      // createTime lo pone el servidor de Firebase: el navegador no puede falsearlo.
      // Evita que alguien reenvíe avisos de citas viejas.
      if (Date.now() - snap.createTime.toMillis() > VENTANA_NOTIFICACION_MS) return { motivo: 'cita_antigua' };

      tx.update(citaRef, { 'notificaciones.confirmacion': { estado: 'procesando', inicio: new Date().toISOString() } });
      return { datos };
    });

    if (!cita.datos) {
      const codigo = cita.motivo === 'no_existe' ? 404 : 200;
      return res.status(codigo).json({ ok: cita.motivo !== 'no_existe', omitido: cita.motivo });
    }

    // 4. Leer los datos del doctor desde Firebase (el email del doctor es privado
    //    y nunca pasó por el navegador del paciente)
    const doctorSnap = await db.collection('doctores').doc(doctorUid).get();
    const doctor = doctorSnap.data() || {};
    const perfilSnap = doctor.slug ? await db.collection('perfiles').doc(doctor.slug).get() : null;
    const perfil = perfilSnap?.exists ? perfilSnap.data() : { nombre: doctor.nombreCompleto || doctor.nombre || 'tu doctor' };

    // 5. Enviar los dos emails en paralelo. allSettled: si uno falla, el otro sigue.
    const datosCita = cita.datos;
    const tareas = {};

    if (EMAIL_VALIDO.test(doctor.email || '')) {
      const e = emailDoctor({ cita: datosCita });
      tareas.doctor = enviarEmail({ para: doctor.email, ...e, idempotencyKey: `cita-${citaId}-doctor` });
    }

    const emailPac = (datosCita.pacienteEmail || '').trim();
    if (EMAIL_VALIDO.test(emailPac)) {
      if (await permitirEnvio(emailPac)) {
        const e = emailPaciente({ cita: datosCita, perfil });
        tareas.paciente = enviarEmail({ para: emailPac, ...e, idempotencyKey: `cita-${citaId}-paciente` });
      } else {
        tareas.paciente = Promise.reject(new Error('limite_envios'));
      }
    }

    const nombres = Object.keys(tareas);
    const resultados = await Promise.allSettled(Object.values(tareas));
    const detalle = {};
    nombres.forEach((n, i) => {
      const r = resultados[i];
      detalle[n] = r.status === 'fulfilled' ? { enviado: true, id: r.value } : { enviado: false, error: String(r.reason?.message || r.reason).slice(0, 200) };
    });

    const exitos = Object.values(detalle).filter((d) => d.enviado).length;
    const estado = nombres.length === 0 ? 'sin_destinatarios' : exitos === nombres.length ? 'enviado' : exitos > 0 ? 'parcial' : 'error';

    // 6. Dejar registro en la propia cita: qué se envió y qué falló.
    //    Sirve para auditar y, más adelante, para reintentar fallos.
    await citaRef.update({ 'notificaciones.confirmacion': { estado, ...detalle, fin: new Date().toISOString() } });

    return res.status(200).json({ ok: estado !== 'error', estado });
  } catch (err) {
    console.error('[notificar-cita]', doctorUid, citaId, err);
    // Liberamos el "reclamo" para que un reintento pueda volver a intentarlo.
    await citaRef.update({ 'notificaciones.confirmacion': null }).catch(() => {});
    return res.status(500).json({ error: 'Error interno' });
  }
}
