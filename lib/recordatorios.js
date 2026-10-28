// lib/recordatorios.js
// Tarea diaria: recordatorio a cada paciente con cita mañana, y un resumen
// de la agenda de mañana a cada doctor.
//
// La dispara el cron de Vercel una vez al día (ver vercel.json). Vercel avisa que
// un cron puede no llegar o llegar dos veces, así que esto está diseñado para ser:
//  - IDEMPOTENTE: cada cita se marca como "recordada" antes de enviar, y cada
//    resumen se registra por doctor y fecha. Correrlo dos veces no duplica nada.
//  - DE RECONCILIACIÓN: también revisa las citas que quedan HOY sin recordatorio,
//    por si el cron de ayer no corrió.

import { db } from './firebaseAdmin.js';
import { enviarEmail } from './email/enviar.js';
import { emailRecordatorio, emailResumenDoctor } from './email/plantillas.js';
import { ahoraVenezuela, aMinutos } from './agenda.js';
import { enlaceGestion } from './enlaces.js';

const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ESTADOS_ACTIVOS = new Set(['pendiente', 'confirmada', 'urgente']);
const LOTE = 10; // envíos en paralelo: rápido sin saturar a Resend

function sumarDias(fecha, dias) {
  const [a, m, d] = fecha.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
}

async function enLotes(items, fn) {
  const resultados = [];
  for (let i = 0; i < items.length; i += LOTE) {
    resultados.push(...(await Promise.allSettled(items.slice(i, i + LOTE).map(fn))));
  }
  return resultados;
}

export async function ejecutarRecordatorios(ahoraMs = Date.now()) {
  const ahora = ahoraVenezuela(ahoraMs);
  const hoy = ahora.fecha;
  const manana = sumarDias(hoy, 1);

  // Una sola consulta para TODOS los doctores ("collection group"): todas las
  // citas de hoy y mañana. Requiere un índice en Firestore (citas · fechaHora).
  const snap = await db.collectionGroup('citas')
    .where('fechaHora', '>=', `${hoy}T00:00`)
    .where('fechaHora', '<=', `${manana}T23:59`)
    .get();

  const citas = snap.docs
    .map((d) => ({ ref: d.ref, uid: d.ref.parent.parent.id, id: d.id, ...d.data() }))
    .filter((c) => ESTADOS_ACTIVOS.has(c.estado || 'pendiente'))
    // De hoy, solo las que todavía no pasaron
    .filter((c) => !c.fechaHora.startsWith(hoy) || aMinutos(c.fechaHora.slice(11, 16)) > ahora.minutos);

  // Datos de cada doctor, una sola lectura por doctor (no una por cita)
  const doctores = new Map();
  for (const uid of new Set(citas.map((c) => c.uid))) {
    const docSnap = await db.collection('doctores').doc(uid).get();
    const doctor = docSnap.exists ? docSnap.data() : {};
    const perfilSnap = doctor.slug ? await db.collection('perfiles').doc(doctor.slug).get() : null;
    doctores.set(uid, {
      doctor,
      perfil: perfilSnap?.exists ? perfilSnap.data() : { nombre: doctor.nombreCompleto || doctor.nombre || 'tu doctor' },
    });
  }

  const informe = { recordatorios: { enviados: 0, omitidos: 0, errores: 0 }, resumenes: { enviados: 0, omitidos: 0, errores: 0 } };

  // ── 1. Recordatorios a pacientes ──────────────────────────────────
  const conEmail = citas.filter((c) => EMAIL_VALIDO.test((c.pacienteEmail || '').trim()) && !c.notificaciones?.recordatorio);
  informe.recordatorios.omitidos = citas.length - conEmail.length;

  const resRec = await enLotes(conEmail, async (c) => {
    // Reclamar la cita: si otra ejecución ya la tomó, no se envía de nuevo
    const reclamada = await db.runTransaction(async (tx) => {
      const s = await tx.get(c.ref);
      if (!s.exists || s.data().notificaciones?.recordatorio) return false;
      tx.update(c.ref, { 'notificaciones.recordatorio': { estado: 'procesando', inicio: new Date().toISOString() } });
      return true;
    });
    if (!reclamada) return 'omitido';

    const { perfil, doctor } = doctores.get(c.uid);
    if (doctor.suspendido) {
      await c.ref.update({ 'notificaciones.recordatorio': { estado: 'omitido_suspendido' } });
      return 'omitido';
    }
    try {
      const cuando = c.fechaHora.startsWith(manana) ? 'mañana' : 'hoy';
      const id = await enviarEmail({
        para: c.pacienteEmail.trim(),
        ...emailRecordatorio({ cita: c, perfil, cuando, enlaceGestion: enlaceGestion(c.uid, c.id) }),
        idempotencyKey: `recordatorio-${c.id}`,
      });
      await c.ref.update({ 'notificaciones.recordatorio': { estado: 'enviado', id, fin: new Date().toISOString() } });
      return 'enviado';
    } catch (err) {
      await c.ref.update({ 'notificaciones.recordatorio': { estado: 'error', error: String(err.message).slice(0, 200) } });
      throw err;
    }
  });
  for (const r of resRec) {
    if (r.status === 'rejected') informe.recordatorios.errores++;
    else informe.recordatorios[r.value === 'enviado' ? 'enviados' : 'omitidos']++;
  }

  // ── 2. Resumen de mañana a cada doctor ────────────────────────────
  const porDoctor = new Map();
  for (const c of citas.filter((x) => x.fechaHora.startsWith(manana))) {
    if (!porDoctor.has(c.uid)) porDoctor.set(c.uid, []);
    porDoctor.get(c.uid).push(c);
  }

  const resRes = await enLotes([...porDoctor.entries()], async ([uid, lista]) => {
    const { doctor } = doctores.get(uid);
    if (doctor.suspendido || !EMAIL_VALIDO.test(doctor.email || '')) return 'omitido';

    // Registro por doctor y fecha: create() falla si ya existe → nunca se duplica
    const registro = db.collection('envios').doc(`resumen_${uid}_${manana}`);
    try {
      await registro.create({ estado: 'procesando', inicio: new Date().toISOString() });
    } catch {
      return 'omitido';
    }
    try {
      const id = await enviarEmail({
        para: doctor.email,
        ...emailResumenDoctor({ citas: lista, fecha: manana }),
        idempotencyKey: `resumen-${uid}-${manana}`,
      });
      await registro.update({ estado: 'enviado', id, citas: lista.length });
      return 'enviado';
    } catch (err) {
      await registro.delete().catch(() => {}); // liberar para que un reintento pueda enviarlo
      throw err;
    }
  });
  for (const r of resRes) {
    if (r.status === 'rejected') informe.resumenes.errores++;
    else informe.resumenes[r.value === 'enviado' ? 'enviados' : 'omitidos']++;
  }

  return { hoy, manana, citas: citas.length, ...informe };
}
