// ============================================================
// mambo · Pipeline — verificación de sesión (server-side)
//
// Los endpoints que la APP llama desde el navegador (crear negocios, leer
// catálogos) reciben el access_token de Supabase en el header Authorization.
// Aquí lo validamos DE VERDAD contra Supabase Auth (/auth/v1/user) y
// comprobamos que el correo pertenezca al dominio permitido. Así estos
// endpoints no quedan abiertos a cualquiera (a diferencia del piloto inicial).
//
// Los archivos con prefijo "_" NO son rutas en Vercel: es un módulo auxiliar.
//
// Variables de entorno usadas:
//   SUPABASE_URL, SUPABASE_ANON_KEY, ALLOWED_EMAIL_DOMAIN (opcional, default mambo.pe)
// ============================================================

function bearerFrom(req) {
  const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  return m ? m[1].trim() : "";
}

// Devuelve { ok:true, user:{ email } } si la sesión es válida y del dominio,
// o { ok:false, status, error } para responder directamente.
export async function verifyUser(req) {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) {
    return { ok: false, status: 500, error: "Faltan SUPABASE_URL / SUPABASE_ANON_KEY en el servidor." };
  }
  const token = bearerFrom(req);
  if (!token) {
    return { ok: false, status: 401, error: "Falta la sesión (token de Supabase)." };
  }

  let user;
  try {
    const r = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: anon, Authorization: `Bearer ${token}` },
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j || !j.email) {
      return { ok: false, status: 401, error: "Sesión inválida o expirada. Vuelve a iniciar sesión." };
    }
    user = j;
  } catch (e) {
    return { ok: false, status: 502, error: "No se pudo validar la sesión con Supabase." };
  }

  const email = String(user.email || "").toLowerCase().trim();
  const domain = String(process.env.ALLOWED_EMAIL_DOMAIN || "mambo.pe").toLowerCase().trim();
  if (!email.endsWith("@" + domain)) {
    return { ok: false, status: 403, error: `Acceso restringido: ${email} no pertenece a @${domain}.` };
  }
  return { ok: true, user: { email } };
}
