// ============================================================
// SOLO PARA DESARROLLO LOCAL (opcional).
//
// En producción NO se usa este archivo: la config viene de /api/config
// (variables de entorno en Vercel). Este template existe por si quieres
// probar contra Supabase en tu máquina.
//
// Uso local:
//   1) Copia este archivo como "config.js" (queda ignorado por git).
//   2) Pega tu URL y tu clave anónima de Supabase.
//   3) Agrega <script src="config.js"></script> en index.html ANTES de
//      supabase.js (solo en tu copia local; no lo subas).
//
// NUNCA pongas aquí la service_role key.
// ============================================================
window.__SUPABASE_CONFIG__ = {
  url: "https://TU-PROYECTO.supabase.co",
  anonKey: "TU_CLAVE_ANON_PUBLICA",
};
