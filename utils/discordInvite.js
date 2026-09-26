'use strict';

// ── Comprobar la invitación de otro servidor ──────────────────────────────────
//
// Uno de los requisitos de una alianza son **1.000 miembros**, y eso no se
// comprueba mirando una captura: la API de Discord lo dice. Con
// `?with_counts=true`, una invitación devuelve el nombre del servidor y cuánta
// gente tiene, sin necesidad de que el bot esté dentro.
//
// Esto NO decide nada por su cuenta. Devuelve lo que sabe y ya está: quien
// acepta o rechaza una alianza es una persona. Un fallo de red, una invitación
// caducada o un límite de peticiones tienen que quedar en "no se pudo
// comprobar", nunca en un "no cumple" — decirle a alguien que su servidor es
// pequeño porque Discord tardó en contestar es negarle algo que sí tenía, y en
// pantalla se vería igual que un rechazo legítimo.

const TIMEOUT_MS = 8000;

// Acepta el enlace entero o el código a secas. Los códigos de invitación son
// alfanuméricos con guiones; las vanity URL también caben aquí.
const INVITE_RE = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([\w-]{2,64})/i;
const CODIGO_RE = /^[\w-]{2,64}$/;

function extraerCodigo(texto) {
    if (typeof texto !== 'string') return null;
    const limpio = texto.trim();
    if (!limpio) return null;

    const m = limpio.match(INVITE_RE);
    if (m) return m[1];

    // Un código pelado ("7xcommunity") también vale: es lo que mucha gente pega.
    return CODIGO_RE.test(limpio) ? limpio : null;
}

// { ok, codigo, nombre, miembros, enLinea, error }.
//
// `ok: false` con `error: 'invalida'` es la invitación que Discord no conoce
// (caducada, mal escrita o borrada) — eso sí es un dato firme. Cualquier otro
// error sale como 'desconocido': no se pudo comprobar, que no es lo mismo.
async function fetchInvite(entrada, { token = process.env.TOKEN } = {}) {
    const codigo = extraerCodigo(entrada);
    if (!codigo) return { ok: false, codigo: null, error: 'formato' };

    try {
        const res = await fetch(
            `https://discord.com/api/v10/invites/${encodeURIComponent(codigo)}?with_counts=true`,
            {
                headers: token ? { Authorization: `Bot ${token}` } : {},
                signal: AbortSignal.timeout(TIMEOUT_MS),
            }
        );

        if (res.status === 404) return { ok: false, codigo, error: 'invalida' };
        if (!res.ok) return { ok: false, codigo, error: 'desconocido' };

        const data = await res.json();
        const miembros = Number(data?.approximate_member_count);

        return {
            ok: true,
            codigo,
            nombre:   data?.guild?.name ?? null,
            guildId:  data?.guild?.id ?? null,
            // null y no 0 cuando Discord no lo manda: 0 miembros diría que el
            // servidor está vacío, que es una afirmación muy distinta.
            miembros: Number.isFinite(miembros) ? miembros : null,
            enLinea:  Number.isFinite(Number(data?.approximate_presence_count))
                ? Number(data.approximate_presence_count)
                : null,
        };
    } catch {
        return { ok: false, codigo, error: 'desconocido' };
    }
}

module.exports = { extraerCodigo, fetchInvite, INVITE_RE };
