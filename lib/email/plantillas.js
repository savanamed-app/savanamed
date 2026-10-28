// lib/email/plantillas.js
// Plantillas de los emails. Solo construyen el contenido (asunto, HTML y texto plano);
// no envían nada. Separarlas así permite cambiar el diseño sin tocar la lógica.

const TIPOS = {
  consulta:      'Consulta general',
  revision:      'Revisión / control',
  procedimiento: 'Procedimiento',
  emergencia:    'Emergencia',
};

// Todo dato escrito por el paciente se "escapa" antes de meterlo en el HTML.
// Sin esto, alguien podría escribir HTML o enlaces falsos en su nombre y
// terminarían dentro de un email enviado desde savanamed.net.
export function escapar(texto = '') {
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// fechaHora viene como "2026-11-03T09:30" en hora de Venezuela, sin zona horaria.
// La formateamos tratándola como UTC para que el servidor (que vive en otra zona)
// no la mueva de hora.
export function formatearFecha(fechaHora) {
  const [fecha, hora] = String(fechaHora).split('T');
  const [a, m, d] = fecha.split('-').map(Number);
  const [h, min] = (hora || '00:00').split(':').map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d, h, min));
  const dia = new Intl.DateTimeFormat('es-VE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(dt);
  const horaTxt = new Intl.DateTimeFormat('es-VE', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC' }).format(dt);
  return { dia, hora: horaTxt };
}

function marco(contenido) {
  return `<!doctype html><html><body style="margin:0;background:#f7f4ef;font-family:Arial,Helvetica,sans-serif;color:#0f1f17;">
  <div style="max-width:520px;margin:0 auto;padding:24px 16px;">
    <div style="font-family:Georgia,serif;font-size:22px;color:#1a6b4a;margin-bottom:16px;">Sava<em>med</em></div>
    <div style="background:#ffffff;border-radius:14px;padding:24px;border:1px solid #e3ece6;">${contenido}</div>
    <p style="font-size:11px;color:#6b7c74;text-align:center;margin-top:16px;">Enviado automáticamente por Savanamed · savanamed.net</p>
  </div></body></html>`;
}

// Botón para que el paciente cancele o cambie su cita (enlace firmado).
// Si no hay enlace, no se muestra nada.
function botonGestion(enlace) {
  if (!enlace) return '';
  return `<div style="margin-top:20px;padding-top:16px;border-top:1px solid #e3ece6;">
    <p style="font-size:13px;color:#6b7c74;margin:0 0 10px;">¿No puedes asistir o necesitas otro horario?</p>
    <a href="${escapar(enlace)}" style="display:inline-block;background:#ffffff;color:#1a6b4a;border:1.5px solid #1a6b4a;text-decoration:none;padding:10px 20px;border-radius:100px;font-size:14px;font-weight:bold;">Cancelar o cambiar mi cita</a>
  </div>`;
}
const textoGestion = (enlace) => (enlace ? `\n¿No puedes asistir? Cancela o cambia tu cita aquí: ${enlace}` : '');

function filas(datos) {
  return datos.map(([k, v]) => `<tr>
    <td style="padding:8px 0;color:#6b7c74;font-size:14px;width:40%;">${k}</td>
    <td style="padding:8px 0;font-size:14px;font-weight:bold;">${v}</td></tr>`).join('');
}

// ── Email al PACIENTE: confirma que su solicitud llegó ──────────────
export function emailPaciente({ cita, perfil, enlaceGestion = '' }) {
  const { dia, hora } = formatearFecha(cita.fechaHora);
  const nombre = escapar(cita.pacienteNombre);
  const doctor = escapar(perfil.nombre);
  const tipo = TIPOS[cita.tipo] || escapar(cita.tipo);
  const direccion = [perfil.direccion, perfil.ciudad].filter(Boolean).map(escapar).join(', ');

  const html = marco(`
    <h1 style="font-size:20px;margin:0 0 8px;">¡Hola ${nombre}! Recibimos tu solicitud de cita</h1>
    <p style="font-size:14px;color:#6b7c74;margin:0 0 16px;">El consultorio la revisará y te confirmará.</p>
    <table style="width:100%;border-collapse:collapse;">${filas([
      ['Doctor', doctor],
      ['Tipo', tipo],
      ['Fecha', dia],
      ['Hora', hora],
      ...(direccion ? [['Dirección', direccion]] : []),
    ])}</table>
    ${enlaceGestion ? botonGestion(enlaceGestion) : '<p style="font-size:13px;color:#6b7c74;margin-top:16px;">Si no puedes asistir, avísale al consultorio con anticipación.</p>'}`);

  const text = `Hola ${cita.pacienteNombre}, recibimos tu solicitud de cita.
Doctor: ${perfil.nombre}
Tipo: ${TIPOS[cita.tipo] || cita.tipo}
Fecha: ${dia} a las ${hora}
${direccion ? 'Dirección: ' + [perfil.direccion, perfil.ciudad].filter(Boolean).join(', ') : ''}
El consultorio la revisará y te confirmará.${textoGestion(enlaceGestion)}`;

  return { subject: `Solicitud de cita recibida · ${perfil.nombre} · ${dia}`, html, text };
}

// ── Email al DOCTOR: aviso de nueva cita ────────────────────────────
export function emailDoctor({ cita }) {
  const { dia, hora } = formatearFecha(cita.fechaHora);
  const urgente = cita.estado === 'urgente' || cita.tipo === 'emergencia';
  const tipo = TIPOS[cita.tipo] || escapar(cita.tipo);

  const html = marco(`
    ${urgente ? '<div style="background:#fef2f2;color:#dc2626;padding:10px 14px;border-radius:8px;font-weight:bold;margin-bottom:16px;">🚨 EMERGENCIA: este paciente pidió atención urgente</div>' : ''}
    <h1 style="font-size:20px;margin:0 0 16px;">Nueva cita agendada</h1>
    <table style="width:100%;border-collapse:collapse;">${filas([
      ['Paciente', escapar(cita.pacienteNombre)],
      ['WhatsApp', escapar(cita.pacienteTel)],
      ...(cita.pacienteEmail ? [['Email', escapar(cita.pacienteEmail)]] : []),
      ['Tipo', tipo],
      ['Fecha', dia],
      ['Hora', hora],
      ...(cita.motivo ? [['Motivo', escapar(cita.motivo)]] : []),
    ])}</table>
    <a href="https://savanamed.net/panel.html" style="display:inline-block;margin-top:20px;background:#1a6b4a;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:100px;font-size:14px;font-weight:bold;">Abrir mi panel para confirmarla</a>`);

  const text = `${urgente ? '🚨 EMERGENCIA\n' : ''}Nueva cita agendada
Paciente: ${cita.pacienteNombre}
WhatsApp: ${cita.pacienteTel}
Tipo: ${TIPOS[cita.tipo] || cita.tipo}
Fecha: ${dia} a las ${hora}
${cita.motivo ? 'Motivo: ' + cita.motivo : ''}
Confírmala en https://savanamed.net/panel.html`;

  return { subject: `${urgente ? '🚨 URGENTE · ' : ''}Nueva cita: ${cita.pacienteNombre} · ${dia} ${hora}`, html, text };
}

// ── Recordatorio al PACIENTE (el día antes, o el mismo día si quedó pendiente) ──
// cuando: 'mañana' | 'hoy'
export function emailRecordatorio({ cita, perfil, cuando, enlaceGestion = '' }) {
  const { dia, hora } = formatearFecha(cita.fechaHora);
  const nombre = escapar(cita.pacienteNombre);
  const doctor = escapar(perfil.nombre);
  const tipo = TIPOS[cita.tipo] || escapar(cita.tipo);
  const direccion = [perfil.direccion, perfil.ciudad].filter(Boolean).map(escapar).join(', ');

  const html = marco(`
    <h1 style="font-size:20px;margin:0 0 8px;">Hola ${nombre}, tu cita es ${cuando}</h1>
    <p style="font-size:14px;color:#6b7c74;margin:0 0 16px;">Te esperamos.</p>
    <table style="width:100%;border-collapse:collapse;">${filas([
      ['Doctor', doctor],
      ['Tipo', tipo],
      ['Fecha', dia],
      ['Hora', hora],
      ...(direccion ? [['Dirección', direccion]] : []),
    ])}</table>
    ${enlaceGestion ? botonGestion(enlaceGestion) : '<p style="font-size:13px;color:#6b7c74;margin-top:16px;">Si no puedes asistir, avísale al consultorio lo antes posible para que otro paciente pueda usar ese horario.</p>'}`);

  const text = `Hola ${cita.pacienteNombre}, tu cita es ${cuando}.
Doctor: ${perfil.nombre}
Fecha: ${dia} a las ${hora}
${direccion ? 'Dirección: ' + [perfil.direccion, perfil.ciudad].filter(Boolean).join(', ') : ''}
${enlaceGestion ? textoGestion(enlaceGestion).trim() : 'Si no puedes asistir, avísale al consultorio.'}`;

  return { subject: `Recordatorio: tu cita ${cuando} a las ${hora} · ${perfil.nombre}`, html, text };
}

// ── Resumen al DOCTOR: su agenda del día siguiente, en un solo email ──
export function emailResumenDoctor({ citas, fecha }) {
  const { dia } = formatearFecha(`${fecha}T00:00`);
  const ordenadas = [...citas].sort((a, b) => a.fechaHora.localeCompare(b.fechaHora));
  const urgentes = ordenadas.filter((c) => c.estado === 'urgente' || c.tipo === 'emergencia').length;
  const pendientes = ordenadas.filter((c) => c.estado === 'pendiente').length;

  const filasCitas = ordenadas.map((c) => {
    const { hora } = formatearFecha(c.fechaHora);
    const urg = c.estado === 'urgente' || c.tipo === 'emergencia';
    return `<tr>
      <td style="padding:8px 0;font-size:14px;font-weight:bold;width:30%;">${hora}</td>
      <td style="padding:8px 0;font-size:14px;">${urg ? '🚨 ' : ''}${escapar(c.pacienteNombre)}<br>
        <span style="color:#6b7c74;font-size:12px;">${TIPOS[c.tipo] || escapar(c.tipo)}${c.estado === 'pendiente' ? ' · por confirmar' : ''}</span></td></tr>`;
  }).join('');

  const html = marco(`
    <h1 style="font-size:20px;margin:0 0 8px;">Tu agenda de mañana</h1>
    <p style="font-size:14px;color:#6b7c74;margin:0 0 16px;">${dia} · ${ordenadas.length} ${ordenadas.length === 1 ? 'cita' : 'citas'}${urgentes ? ` · ${urgentes} urgente${urgentes > 1 ? 's' : ''}` : ''}</p>
    ${pendientes ? `<div style="background:#fef9c3;color:#854d0e;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:16px;">Tienes ${pendientes} ${pendientes === 1 ? 'cita' : 'citas'} por confirmar.</div>` : ''}
    <table style="width:100%;border-collapse:collapse;">${filasCitas}</table>
    <a href="https://savanamed.net/panel.html" style="display:inline-block;margin-top:20px;background:#1a6b4a;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:100px;font-size:14px;font-weight:bold;">Abrir mi panel</a>`);

  const text = `Tu agenda de mañana (${dia}): ${ordenadas.length} citas\n` +
    ordenadas.map((c) => `${formatearFecha(c.fechaHora).hora} - ${c.pacienteNombre} (${TIPOS[c.tipo] || c.tipo})`).join('\n') +
    `\nhttps://savanamed.net/panel.html`;

  return { subject: `Tu agenda de mañana: ${ordenadas.length} ${ordenadas.length === 1 ? 'cita' : 'citas'}`, html, text };
}

// ── Avisos al PACIENTE cuando el doctor cambia el estado de su cita ──
function detalleCita({ cita, perfil }) {
  const { dia, hora } = formatearFecha(cita.fechaHora);
  const direccion = [perfil.direccion, perfil.ciudad].filter(Boolean).map(escapar).join(', ');
  return {
    dia, hora,
    tabla: `<table style="width:100%;border-collapse:collapse;">${filas([
      ['Doctor', escapar(perfil.nombre)],
      ['Tipo', TIPOS[cita.tipo] || escapar(cita.tipo)],
      ['Fecha', dia],
      ['Hora', hora],
      ...(direccion ? [['Dirección', direccion]] : []),
    ])}</table>`,
  };
}

export function emailCitaConfirmada({ cita, perfil, enlaceGestion = '' }) {
  const { dia, hora, tabla } = detalleCita({ cita, perfil });
  const html = marco(`
    <div style="background:#ecfdf5;color:#1a6b4a;padding:10px 14px;border-radius:8px;font-weight:bold;margin-bottom:16px;">✅ Tu cita está confirmada</div>
    <h1 style="font-size:20px;margin:0 0 16px;">Hola ${escapar(cita.pacienteNombre)}, te esperamos</h1>
    ${tabla}
    <p style="font-size:13px;color:#6b7c74;margin-top:16px;">Te enviaremos un recordatorio el día antes.</p>
    ${botonGestion(enlaceGestion)}`);
  const text = `Hola ${cita.pacienteNombre}, tu cita está confirmada.
Doctor: ${perfil.nombre}
Fecha: ${dia} a las ${hora}${textoGestion(enlaceGestion)}`;
  return { subject: `✅ Cita confirmada · ${perfil.nombre} · ${dia} ${hora}`, html, text };
}

// slug: para el botón "agendar otra fecha" (página pública del doctor)
export function emailCitaCancelada({ cita, perfil, slug }) {
  const { dia, hora, tabla } = detalleCita({ cita, perfil });
  const enlace = slug ? `https://savanamed.net/${encodeURIComponent(slug)}` : '';
  const html = marco(`
    <div style="background:#fef2f2;color:#b91c1c;padding:10px 14px;border-radius:8px;font-weight:bold;margin-bottom:16px;">Tu cita fue cancelada</div>
    <h1 style="font-size:20px;margin:0 0 8px;">Hola ${escapar(cita.pacienteNombre)}</h1>
    <p style="font-size:14px;color:#6b7c74;margin:0 0 16px;">El consultorio canceló esta cita. Lamentamos el inconveniente.</p>
    ${tabla}
    ${enlace ? `<a href="${enlace}" style="display:inline-block;margin-top:20px;background:#1a6b4a;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:100px;font-size:14px;font-weight:bold;">Agendar otra fecha</a>` : ''}`);
  const text = `Hola ${cita.pacienteNombre}, el consultorio canceló tu cita.
Doctor: ${perfil.nombre}
Fecha: ${dia} a las ${hora}
${enlace ? 'Agenda otra fecha: ' + enlace : ''}`;
  return { subject: `Cita cancelada · ${perfil.nombre} · ${dia} ${hora}`, html, text };
}

// ── Al PACIENTE: confirmación de que su cambio de fecha quedó registrado ──
export function emailCitaReprogramada({ cita, perfil, enlaceGestion = '' }) {
  const { dia, hora, tabla } = detalleCita({ cita, perfil });
  const html = marco(`
    <div style="background:#eff6ff;color:#1d4ed8;padding:10px 14px;border-radius:8px;font-weight:bold;margin-bottom:16px;">🔄 Cambiaste la fecha de tu cita</div>
    <h1 style="font-size:20px;margin:0 0 8px;">Hola ${escapar(cita.pacienteNombre)}, este es tu nuevo horario</h1>
    <p style="font-size:14px;color:#6b7c74;margin:0 0 16px;">El consultorio lo revisará y te confirmará.</p>
    ${tabla}
    ${botonGestion(enlaceGestion)}`);
  const text = `Hola ${cita.pacienteNombre}, tu cita cambió de fecha.
Doctor: ${perfil.nombre}
Nuevo horario: ${dia} a las ${hora}
El consultorio lo revisará y te confirmará.${textoGestion(enlaceGestion)}`;
  return { subject: `Nuevo horario de tu cita · ${perfil.nombre} · ${dia} ${hora}`, html, text };
}

// ── Al DOCTOR: el paciente canceló o cambió su cita desde su enlace ──
// tipo: 'cancelada' | 'reprogramada'. anterior: fechaHora anterior (si reprogramó)
export function emailDoctorAvisoPaciente({ cita, tipo, anterior }) {
  const actual = formatearFecha(cita.fechaHora);
  const antes = anterior ? formatearFecha(anterior) : null;
  const cancelo = tipo === 'cancelada';
  const titulo = cancelo ? 'Un paciente canceló su cita' : 'Un paciente cambió la fecha de su cita';

  const html = marco(`
    <div style="background:${cancelo ? '#fef2f2' : '#eff6ff'};color:${cancelo ? '#b91c1c' : '#1d4ed8'};padding:10px 14px;border-radius:8px;font-weight:bold;margin-bottom:16px;">${cancelo ? '❌ Cita cancelada por el paciente' : '🔄 Cita reprogramada por el paciente'}</div>
    <h1 style="font-size:20px;margin:0 0 16px;">${titulo}</h1>
    <table style="width:100%;border-collapse:collapse;">${filas([
      ['Paciente', escapar(cita.pacienteNombre)],
      ['WhatsApp', escapar(cita.pacienteTel)],
      ['Tipo', TIPOS[cita.tipo] || escapar(cita.tipo)],
      ...(cancelo
        ? [['Fecha', `${actual.dia}, ${actual.hora}`]]
        : [['Antes', `<span style="text-decoration:line-through;color:#6b7c74;">${antes.dia}, ${antes.hora}</span>`], ['Ahora', `${actual.dia}, ${actual.hora}`]]),
    ])}</table>
    <p style="font-size:13px;color:#6b7c74;margin-top:16px;">${cancelo ? 'Ese horario ya quedó libre para otro paciente.' : 'El horario anterior quedó libre. La cita quedó pendiente: confírmala en tu panel.'}</p>
    <a href="https://savanamed.net/panel.html" style="display:inline-block;margin-top:12px;background:#1a6b4a;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:100px;font-size:14px;font-weight:bold;">Abrir mi panel</a>`);

  const text = `${titulo}
Paciente: ${cita.pacienteNombre} (${cita.pacienteTel})
${cancelo ? `Fecha: ${actual.dia}, ${actual.hora}` : `Antes: ${antes.dia}, ${antes.hora}\nAhora: ${actual.dia}, ${actual.hora}`}
https://savanamed.net/panel.html`;

  const subject = cancelo
    ? `Cancelada: ${cita.pacienteNombre} · ${actual.dia} ${actual.hora}`
    : `Reprogramada: ${cita.pacienteNombre} → ${actual.dia} ${actual.hora}`;
  return { subject, html, text };
}
