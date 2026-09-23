// ============================================================
// mambo · Pipeline — envío SMTP compartido (Gmail / Google Workspace)
//
// Módulo auxiliar ("_" → no es ruta). Transporter con pool (reutiliza conexión).
// La contraseña de aplicación puede venir con espacios (Google la muestra en
// bloques de 4); se limpian.
//
// Env: GMAIL_USER, GMAIL_APP_PASSWORD, SMTP_PORT (opc; 465 SSL por defecto o 587).
// ============================================================

import nodemailer from "nodemailer";

// Transporter con POOL y varias conexiones (para enviar en paralelo) + timeouts
// para que una conexión colgada no consuma todo el presupuesto de la función.
export function makeTransport(user, appPassword) {
  const port = Number(process.env.SMTP_PORT || 465);
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port,
    secure: port === 465, // 465 → SSL; 587 → STARTTLS
    pool: true,
    maxConnections: 5,        // hasta 5 conexiones simultáneas (cubre 3–5 correos)
    maxMessages: 100,
    connectionTimeout: 10000, // 10s para abrir la conexión TCP/TLS
    greetingTimeout: 10000,   // 10s para el saludo SMTP del servidor
    socketTimeout: 20000,     // 20s máx. de inactividad del socket
    auth: { user, pass: String(appPassword || "").replace(/\s+/g, "") },
  });
}

// Envía varios correos EN PARALELO reutilizando el pool. Cada uno es independiente:
// si uno falla, no tumba a los demás (Promise.allSettled). messages: [{ key, mail }].
// Devuelve [{ key, ok, info? , error? }] en el mismo orden.
export async function sendMany(transporter, messages) {
  const results = await Promise.allSettled(messages.map((m) => transporter.sendMail(m.mail)));
  return messages.map((m, i) => {
    const r = results[i];
    return r.status === "fulfilled"
      ? { key: m.key, ok: true, info: r.value }
      : { key: m.key, ok: false, error: String(r.reason && r.reason.message ? r.reason.message : r.reason) };
  });
}

export const escHtml = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
