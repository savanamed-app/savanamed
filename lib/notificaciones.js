// lib/notificaciones.js
// Envía los emails de una cita nueva (al doctor y al paciente).
// Lo llama el servidor justo después de crear la cita.
//
// Todos los datos se leen de Firebase: nunca del navegador.

import { db } from './firebaseAdmin.js';
import { enviarEmail } from './email/enviar.js';
import { emailPaciente, emailDoctor, emailCitaConfirmada, emailCitaCancelada, emailCitaReprogramada, emailDoctorAvisoPaciente } from './email/plantillas.js';
import { enlaceGestion } from './enlaces.js';
import { permitirEnvio } from './limiteEnvios.js';

const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function notificarCitaNueva(doctorUid, citaId) {
  const citaRef = db.collection('doctores').doc(doctorUid).collection('citas').doc(citaId);

  try {
    // 1. "Reclamar" la notificación en una transacción: si por algún motivo
    //    esto se ejecuta dos veces para la misma cita, solo una lo envía.
    const cita = await db.runTransaction(async (tx) => {
      const snap = await tx.get(citaRef);
      if (!snap.exists) return null;
      const datos = snap.data();
      if (datos.notificaciones?.confirmacion) return null;
      tx.update(citaRef, { 'notificaciones.confirmacion': { estado: 'procesando', inicio: new Date().toISOString() } });
      return datos;
    });
    if (!cita) return { estado: 'omitido' };

    // 2. Datos del doctor (su email es privado: nunca pasó por el navegador)
    const doctorSnap = await db.collection('doctores').doc(doctorUid).get();
    const doctor = doctorSnap.data() || {};
    const perfilSnap = doctor.slug ? await db.collection('perfiles').doc(doctor.slug).get() : null;
    const perfil = perfilSnap?.exists ? perfilSnap.data() : { nombre: doctor.nombreCompleto || doctor.nombre || 'tu doctor' };

    // 3. Enviar en paralelo. allSettled: si uno falla, el otro sigue.
    const tareas = {};
    if (EMAIL_VALIDO.test(doctor.email || '')) {
      tareas.doctor = enviarEmail({ para: doctor.email, ...emailDoctor({ cita }), idempotencyKey: `cita-${citaId}-doctor` });
    }
    const emailPac = (cita.pacienteEmail || '').trim();
    if (EMAIL_VALIDO.test(emailPac)) {
      tareas.paciente = (await permitirEnvio(emailPac))
        ? enviarEmail({ para: emailPac, ...emailPaciente({ cita, perfil, enlaceGestion: enlaceGestion(doctorUid, citaId) }), idempotencyKey: `cita-${citaId}-paciente` })
        : Promise.reject(new Error('limite_envios'));
    }

    const nombres = Object.keys(tareas);
    const resultados = await Promise.allSettled(Object.values(tareas));
    const detalle = {};
    nombres.forEach((n, i) => {
      const r = resultados[i];
      detalle[n] = r.status === 'fulfilled'
        ? { enviado: true, id: r.value }
        : { enviado: false, error: String(r.reason?.message || r.reason).slice(0, 200) };
    });

    const exitos = Object.values(detalle).filter((d) => d.enviado).length;
    const estado = nombres.length === 0 ? 'sin_destinatarios'
      : exitos === nombres.length ? 'enviado'
      : exitos > 0 ? 'parcial' : 'error';

    // 4. Registro en la propia cita: qué se envió y qué falló (auditoría y reintentos).
    await citaRef.update({ 'notificaciones.confirmacion': { estado, ...detalle, fin: new Date().toISOString() } });
    return { estado };
  } catch (err) {
    console.error('[notificaciones]', doctorUid, citaId, err);
    await citaRef.update({ 'notificaciones.confirmacion': { estado: 'error', error: String(err.message).slice(0, 200) } }).catch(() => {});
    return { estado: 'error' };
  }
}

// ── Aviso al paciente cuando el doctor confirma o cancela ───────────
// tipo: 'confirmada' | 'cancelada'. Idempotente: se registra en
// notificaciones.<tipo> y solo se envía una vez por cita.
const PLANTILLAS = { confirmada: emailCitaConfirmada, cancelada: emailCitaCancelada };

export async function notificarCambioEstado(doctorUid, citaId, tipo) {
  const plantilla = PLANTILLAS[tipo];
  if (!plantilla) throw new Error(`Tipo de aviso desconocido: ${tipo}`);
  const citaRef = db.collection('doctores').doc(doctorUid).collection('citas').doc(citaId);
  const campo = `notificaciones.${tipo}`;

  try {
    const cita = await db.runTransaction(async (tx) => {
      const snap = await tx.get(citaRef);
      if (!snap.exists) return null;
      const datos = snap.data();
      if (datos.notificaciones?.[tipo]) return null; // ya avisado
      const email = (datos.pacienteEmail || '').trim();
      tx.update(citaRef, { [campo]: EMAIL_VALIDO.test(email)
        ? { estado: 'procesando', inicio: new Date().toISOString() }
        : { estado: 'sin_email' } });
      return EMAIL_VALIDO.test(email) ? datos : null;
    });
    if (!cita) return { estado: 'omitido' };

    const email = cita.pacienteEmail.trim();
    if (!(await permitirEnvio(email))) {
      await citaRef.update({ [campo]: { estado: 'limite_envios' } });
      return { estado: 'limite_envios' };
    }

    const doctorSnap = await db.collection('doctores').doc(doctorUid).get();
    const doctor = doctorSnap.data() || {};
    const perfilSnap = doctor.slug ? await db.collection('perfiles').doc(doctor.slug).get() : null;
    const perfil = perfilSnap?.exists ? perfilSnap.data() : { nombre: doctor.nombreCompleto || doctor.nombre || 'tu doctor' };

    const id = await enviarEmail({
      para: email,
      ...plantilla({ cita, perfil, slug: doctor.slug, enlaceGestion: enlaceGestion(doctorUid, citaId) }),
      idempotencyKey: `${tipo}-${citaId}`,
    });
    await citaRef.update({ [campo]: { estado: 'enviado', id, fin: new Date().toISOString() } });
    return { estado: 'enviado' };
  } catch (err) {
    console.error('[notificaciones]', tipo, doctorUid, citaId, err);
    await citaRef.update({ [campo]: { estado: 'error', error: String(err.message).slice(0, 200) } }).catch(() => {});
    return { estado: 'error' };
  }
}

// ── Cuando el PACIENTE cancela o cambia su cita desde su enlace ─────
// Avisa al doctor siempre, y si reprogramó, le confirma al paciente su nuevo
// horario. idempotencyKey incluye la fecha: cada cambio es un aviso distinto,
// pero un reintento del mismo cambio nunca duplica el email.
export async function notificarCambioPaciente(doctorUid, citaId, { tipo, anterior = '' }) {
  try {
    const citaSnap = await db.collection('doctores').doc(doctorUid).collection('citas').doc(citaId).get();
    if (!citaSnap.exists) return { estado: 'omitido' };
    const cita = citaSnap.data();
    const doctorSnap = await db.collection('doctores').doc(doctorUid).get();
    const doctor = doctorSnap.data() || {};
    const clave = `${tipo}-paciente-${citaId}-${cita.fechaHora}`;

    const tareas = [];
    if (EMAIL_VALIDO.test(doctor.email || '')) {
      tareas.push(enviarEmail({
        para: doctor.email,
        ...emailDoctorAvisoPaciente({ cita, tipo, anterior }),
        idempotencyKey: `${clave}-doctor`,
      }));
    }
    const emailPac = (cita.pacienteEmail || '').trim();
    if (tipo === 'reprogramada' && EMAIL_VALIDO.test(emailPac) && (await permitirEnvio(emailPac))) {
      const perfilSnap = doctor.slug ? await db.collection('perfiles').doc(doctor.slug).get() : null;
      const perfil = perfilSnap?.exists ? perfilSnap.data() : { nombre: doctor.nombreCompleto || doctor.nombre || 'tu doctor' };
      tareas.push(enviarEmail({
        para: emailPac,
        ...emailCitaReprogramada({ cita, perfil, enlaceGestion: enlaceGestion(doctorUid, citaId) }),
        idempotencyKey: `${clave}-paciente`,
      }));
    }
    const r = await Promise.allSettled(tareas);
    r.filter((x) => x.status === 'rejected').forEach((x) => console.error('[notificaciones]', clave, x.reason));
    return { estado: r.every((x) => x.status === 'fulfilled') ? 'enviado' : 'parcial' };
  } catch (err) {
    console.error('[notificaciones]', tipo, doctorUid, citaId, err);
    return { estado: 'error' };
  }
}
