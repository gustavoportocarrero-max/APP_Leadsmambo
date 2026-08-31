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

export function makeTransport(user, appPassword) {
  const port = Number(process.env.SMTP_PORT || 465);
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port,
    secure: port === 465, // 465 → SSL; 587 → STARTTLS
    pool: true, maxConnections: 1, maxMessages: 50,
    auth: { user, pass: String(appPassword || "").replace(/\s+/g, "") },
  });
}

export const escHtml = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
