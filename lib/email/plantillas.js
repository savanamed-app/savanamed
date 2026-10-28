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

function filas(datos) {
  return datos.map(([k, v]) => `<tr>
    <td style="padding:8px 0;color:#6b7c74;font-size:14px;width:40%;">${k}</td>
    <td style="padding:8px 0;font-size:14px;font-weight:bold;">${v}</td></tr>`).join('');
}

// ── Email al PACIENTE: confirma que su solicitud llegó ──────────────
export function emailPaciente({ cita, perfil }) {
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
    <p style="font-size:13px;color:#6b7c74;margin-top:16px;">Si no puedes asistir, avísale al consultorio con anticipación.</p>`);

  const text = `Hola ${cita.pacienteNombre}, recibimos tu solicitud de cita.
Doctor: ${perfil.nombre}
Tipo: ${TIPOS[cita.tipo] || cita.tipo}
Fecha: ${dia} a las ${hora}
${direccion ? 'Dirección: ' + [perfil.direccion, perfil.ciudad].filter(Boolean).join(', ') : ''}
El consultorio la revisará y te confirmará.`;

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
export function emailRecordatorio({ cita, perfil, cuando }) {
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
    <p style="font-size:13px;color:#6b7c74;margin-top:16px;">Si no puedes asistir, avísale al consultorio lo antes posible para que otro paciente pueda usar ese horario.</p>`);

  const text = `Hola ${cita.pacienteNombre}, tu cita es ${cuando}.
Doctor: ${perfil.nombre}
Fecha: ${dia} a las ${hora}
${direccion ? 'Dirección: ' + [perfil.direccion, perfil.ciudad].filter(Boolean).join(', ') : ''}
Si no puedes asistir, avísale al consultorio.`;

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
