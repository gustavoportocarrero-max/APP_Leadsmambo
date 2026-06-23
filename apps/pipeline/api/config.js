// ============================================================
// Serverless function (Vercel) — expone la config pública de Supabase
// al cliente SIN hardcodear claves en el repo. Lee las variables de
// entorno definidas en Vercel: SUPABASE_URL y SUPABASE_ANON_KEY.
//
// La clave "anon" es pública por diseño (la protección real es RLS),
// así que es seguro entregarla al cliente. Nunca expongas la
// service_role key aquí.
// ============================================================
export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    url: process.env.SUPABASE_URL || "",
    anonKey: process.env.SUPABASE_ANON_KEY || "",
  });
}
