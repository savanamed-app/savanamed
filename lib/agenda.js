// lib/agenda.js
// Reglas de agenda COMPARTIDAS entre la página del paciente (navegador) y el servidor.
// Usar el mismo archivo en ambos lados garantiza que lo que el paciente ve como
// disponible es exactamente lo que el servidor acepta. Sin secretos: es público.
//
// Convención de días: 1 = Lunes ... 7 = Domingo (igual que el panel del doctor).

export const HORARIO_DEFECTO = Object.freeze({
  diasLaborales: [1, 2, 3, 4, 5],
  horaInicio: '08:00',
  horaFin: '18:00',
  duracionCita: 30,
});

export const DIAS_MAX_ADELANTO = 90;        // no se agenda más allá de 90 días
export const MAX_BLOQUEOS = 100;            // bloqueos guardados por doctor
const MAX_DIAS_BLOQUEO = 366;               // un bloqueo dura como máximo un año
const OFFSET_VENEZUELA_MIN = -4 * 60;       // Venezuela: UTC-4, sin horario de verano

const RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const RE_FECHA = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export const aMinutos = (hora) => {
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
};
const aHora = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

const diasEntre = (desde, hasta) => {
  const f = (x) => { const [a, m, d] = x.split('-').map(Number); return Date.UTC(a, m - 1, d); };
  return (f(hasta) - f(desde)) / 86400000;
};

// Bloqueos de agenda: vacaciones, congresos, un día libre o unas horas.
//   { id, desde: 'AAAA-MM-DD', hasta: 'AAAA-MM-DD' }                     → días completos
//   { id, desde, hasta, horaInicio: 'HH:MM', horaFin: 'HH:MM' }          → solo esas horas
// Se guardan en el perfil público (solo fechas, nunca el motivo) para que
// la página del paciente y el servidor los lean sin consultas extra.
// Todo bloqueo mal formado se descarta: nunca rompe la agenda.
export function leerBloqueos(lista) {
  if (!Array.isArray(lista)) return [];
  const limpios = [];
  for (const b of lista.slice(0, MAX_BLOQUEOS)) {
    if (!b || !RE_FECHA.test(b.desde) || !RE_FECHA.test(b.hasta)) continue;
    if (b.hasta < b.desde || diasEntre(b.desde, b.hasta) > MAX_DIAS_BLOQUEO) continue;
    const bloqueo = { id: String(b.id || `${b.desde}_${b.hasta}`).slice(0, 40), desde: b.desde, hasta: b.hasta };
    const conHoras = b.horaInicio !== undefined || b.horaFin !== undefined;
    if (conHoras) {
      if (!RE_HORA.test(b.horaInicio) || !RE_HORA.test(b.horaFin) || b.horaFin <= b.horaInicio) continue;
      bloqueo.horaInicio = b.horaInicio;
      bloqueo.horaFin = b.horaFin;
    }
    limpios.push(bloqueo);
  }
  return limpios;
}

const cubre = (b, fecha) => b.desde <= fecha && fecha <= b.hasta;

// ¿El doctor bloqueó ese día completo?
export function diaBloqueado(horario, fecha) {
  return (horario.bloqueos || []).some((b) => !b.horaInicio && cubre(b, fecha));
}

// Lee el horario del perfil del doctor y lo sanea. Si algo está mal configurado,
// usa el horario por defecto en vez de romper la página.
export function leerHorario(perfil = {}) {
  const dias = Array.isArray(perfil.diasLaborales)
    ? [...new Set(perfil.diasLaborales.map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))]
    : [];
  const duracion = parseInt(perfil.duracionCita, 10);
  const horario = {
    diasLaborales: dias.length ? dias : [...HORARIO_DEFECTO.diasLaborales],
    horaInicio: RE_HORA.test(perfil.horaInicio) ? perfil.horaInicio : HORARIO_DEFECTO.horaInicio,
    horaFin: RE_HORA.test(perfil.horaFin) ? perfil.horaFin : HORARIO_DEFECTO.horaFin,
    duracionCita: duracion >= 10 && duracion <= 240 ? duracion : HORARIO_DEFECTO.duracionCita,
    bloqueos: leerBloqueos(perfil.bloqueos),
  };
  if (aMinutos(horario.horaFin) - aMinutos(horario.horaInicio) < horario.duracionCita) {
    horario.horaInicio = HORARIO_DEFECTO.horaInicio;
    horario.horaFin = HORARIO_DEFECTO.horaFin;
  }
  return horario;
}

// Día de la semana (1-7) de una fecha 'YYYY-MM-DD', sin depender de la zona horaria.
export function diaSemana(fecha) {
  const [a, m, d] = fecha.split('-').map(Number);
  const js = new Date(Date.UTC(a, m - 1, d)).getUTCDay(); // 0 = domingo
  return js === 0 ? 7 : js;
}

// Lista de horarios de inicio de cita: desde horaInicio, cada `duracionCita`
// minutos, siempre que la cita termine antes de horaFin.
export function generarSlots(horario) {
  const slots = [];
  const fin = aMinutos(horario.horaFin);
  for (let t = aMinutos(horario.horaInicio); t + horario.duracionCita <= fin; t += horario.duracionCita) {
    slots.push(aHora(t));
  }
  return slots;
}

// Horarios disponibles de UN día concreto: los del horario normal, sin los que
// caen dentro de un bloqueo. Una cita se descarta si se cruza con el bloqueo,
// aunque sea un poco (ej. bloqueo 12:00-14:00 quita la cita de 11:45 de 30 min).
export function slotsDelDia(horario, fecha) {
  if (diaBloqueado(horario, fecha)) return [];
  const parciales = (horario.bloqueos || []).filter((b) => b.horaInicio && cubre(b, fecha));
  return generarSlots(horario).filter((h) => {
    const ini = aMinutos(h);
    const fin = ini + horario.duracionCita;
    return !parciales.some((b) => ini < aMinutos(b.horaFin) && fin > aMinutos(b.horaInicio));
  });
}

// Fecha y minuto actuales en Venezuela, sin importar dónde corra el código.
export function ahoraVenezuela(ahoraMs = Date.now()) {
  const d = new Date(ahoraMs + OFFSET_VENEZUELA_MIN * 60000);
  return {
    fecha: d.toISOString().slice(0, 10),
    minutos: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

function sumarDias(fecha, dias) {
  const [a, m, d] = fecha.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
}

export function fechaMaxima(ahora = ahoraVenezuela()) {
  return sumarDias(ahora.fecha, DIAS_MAX_ADELANTO);
}

// ¿Este día se puede agendar? (laborable, no pasado, dentro de 90 días, no bloqueado)
export function diaDisponible(horario, fecha, ahora = ahoraVenezuela()) {
  if (!RE_FECHA.test(fecha)) return false;
  if (fecha < ahora.fecha || fecha > fechaMaxima(ahora)) return false;
  return horario.diasLaborales.includes(diaSemana(fecha)) && !diaBloqueado(horario, fecha);
}

// Valida un horario concreto. Devuelve null si es válido, o el motivo del rechazo.
export function validarSlot(horario, fecha, hora, ahora = ahoraVenezuela()) {
  if (!RE_FECHA.test(fecha) || !RE_HORA.test(hora)) return 'Fecha u hora inválida';
  if (!diaDisponible(horario, fecha, ahora)) return 'El doctor no atiende ese día';
  if (!generarSlots(horario).includes(hora)) return 'El doctor no atiende a esa hora';
  if (!slotsDelDia(horario, fecha).includes(hora)) return 'El doctor no atiende en ese horario';
  if (fecha === ahora.fecha && aMinutos(hora) <= ahora.minutos) return 'Ese horario ya pasó';
  return null;
}

// Normaliza un teléfono al formato internacional (E.164), listo para WhatsApp.
// Acepta: 0412 1234567 · 412-123-4567 · +58 412 1234567 · 584121234567
// También acepta números de otros países si empiezan con +.
// Devuelve null si no es un número válido.
export function normalizarTelefono(texto) {
  const limpio = String(texto || '').trim().replace(/[\s\-().]/g, '');
  if (/[^\d+]/.test(limpio)) return null; // letras u otros símbolos (ej: "29l492")

  const ve = (diez) => (/^[24]\d{9}$/.test(diez) ? `+58${diez}` : null);

  if (limpio.startsWith('+')) {
    const digitos = limpio.slice(1);
    if (!/^\d+$/.test(digitos)) return null;
    if (digitos.startsWith('58')) return ve(digitos.slice(2));
    return /^[1-9]\d{7,14}$/.test(digitos) ? `+${digitos}` : null;
  }
  if (/^58\d{10}$/.test(limpio)) return ve(limpio.slice(2));
  if (/^0\d{10}$/.test(limpio)) return ve(limpio.slice(1));
  if (/^\d{10}$/.test(limpio)) return ve(limpio);
  return null;
}

// Formato legible para mostrar: +58 412 1234567
export function formatearTelefono(e164) {
  const m = /^\+58(\d{3})(\d{7})$/.exec(e164 || '');
  return m ? `+58 ${m[1]} ${m[2]}` : e164 || '';
}
