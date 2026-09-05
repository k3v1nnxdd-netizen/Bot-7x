'use strict';

// SONDA DE CAPACIDAD REAL DE v2 — SI golpea la API real de Roblox.
// Nunca se ejecuta con `npm test`: el runner solo recorre src/tests/*.test.js.
//
//   npm run test:live:v2
//
// SE EJECUTA DENTRO DEL CONTENEDOR DE RAILWAY, no en local. Los limites de
// Roblox son POR IP: medirlos desde otra maquina da un numero que no sirve para
// decidir nada sobre el worker.
//
// QUE MIDE, y por que asi:
//
//   SOLO v2. Ni una llamada a v1 durante la prueba. v1 y v2 tienen cuotas
//   independientes, y mezclarlas haria imposible saber cual de las dos se
//   agoto.
//
//   SIN NUESTRO LIMITADOR NI NUESTRA CACHE. Se usa axios a pelo. Lo que se
//   quiere conocer es lo que aguanta ROBLOX, no lo que deja pasar nuestro
//   marcapasos: pasarlo por el limitador mediria nuestra propia configuracion.
//
//   USUARIOS DISTINTOS en cada llamada. Repetir el mismo id puede responderse
//   desde una cache intermedia y no consumir cuota, lo que daria una capacidad
//   inventada.
//
//   LAS CABECERAS TAL CUAL. No se interpretan ni se asume que `remaining` sea
//   un contador lineal: en produccion se vio dos veces el mismo valor
//   (59999 y 59999) en llamadas consecutivas. Se registra el texto crudo de
//   cada cabecera y se reporta si el contador llego a bajar alguna vez.

const axios = require('axios');

const FASE_1 = Number(process.env.V2_PROBE_CALLS ?? 50);
const FASE_2 = Number(process.env.V2_PROBE_CALLS_PACED ?? 200);
const PAUSA_POR_DEFECTO_MS = Number(process.env.V2_PROBE_PACE_MS ?? 1000);

// Ids de usuarios que existen de verdad. Se recorren en orden para no repetir
// ninguno dentro de una fase.
const PRIMER_ID = Number(process.env.V2_PROBE_FIRST_ID ?? 1);

const url = id => `https://avatar.roblox.com/v2/avatar/users/${id}/avatar`;
const dormir = ms => new Promise(r => setTimeout(r, ms));

const CABECERAS = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after'];

function leerCabeceras(headers = {}) {
    const salida = {};
    for (const clave of CABECERAS) {
        const valor = headers[clave] ?? headers[clave.toLowerCase()];
        if (valor !== undefined) salida[clave] = String(valor);
    }
    return salida;
}

// `remaining` puede venir como "59999" o dentro de una cabecera estructurada.
// Se extrae el primer entero y se deja constancia del texto original.
function numeroDe(texto) {
    if (texto === undefined || texto === null) return null;
    const m = String(texto).match(/-?\d+/);
    return m ? Number(m[0]) : null;
}

async function unaLlamada(id) {
    const t0 = Date.now();
    try {
        const res = await axios.get(url(id), { timeout: 15_000, validateStatus: () => true });
        return {
            id, status: res.status, ms: Date.now() - t0,
            cabeceras: leerCabeceras(res.headers),
            bytes: Buffer.byteLength(JSON.stringify(res.data ?? '')),
            assets: Array.isArray(res.data?.assets) ? res.data.assets.length : null,
        };
    } catch (err) {
        return { id, status: 'ERROR', ms: Date.now() - t0, error: err?.message ?? String(err), cabeceras: {} };
    }
}

function resumir(nombre, llamadas, duracionMs) {
    const ok = llamadas.filter(l => l.status === 200);
    const limitadas = llamadas.filter(l => l.status === 429);
    const otras = llamadas.filter(l => l.status !== 200 && l.status !== 429);

    const remaining = llamadas
        .map(l => numeroDe(l.cabeceras['x-ratelimit-remaining']))
        .filter(v => v !== null);
    const primerRemaining = remaining[0] ?? null;
    const ultimoRemaining = remaining[remaining.length - 1] ?? null;
    const menorRemaining = remaining.length > 0 ? Math.min(...remaining) : null;
    const distintos = [...new Set(remaining)];

    const resets = [...new Set(llamadas.map(l => l.cabeceras['x-ratelimit-reset']).filter(Boolean))];
    const limites = [...new Set(llamadas.map(l => l.cabeceras['x-ratelimit-limit']).filter(Boolean))];
    const retry = [...new Set(llamadas.map(l => l.cabeceras['retry-after']).filter(Boolean))];

    const latencias = llamadas.map(l => l.ms).sort((a, b) => a - b);
    const p = q => latencias[Math.min(latencias.length - 1, Math.floor((q / 100) * latencias.length))];

    const fila = (k, v) => console.log(`  ${k.padEnd(34)} ${v}`);
    console.log(`\n${'='.repeat(64)}`);
    console.log(nombre);
    console.log('='.repeat(64));
    fila('llamadas', llamadas.length);
    fila('200', ok.length);
    fila('429', limitadas.length);
    if (otras.length > 0) {
        fila('otros estados', otras.map(o => o.status).join(', '));
    }
    fila('latencia total', `${(duracionMs / 1000).toFixed(1)} s`);
    fila('ritmo efectivo', `${(llamadas.length / (duracionMs / 1000)).toFixed(2)} llamadas/s`);
    fila('latencia p50 / p95', `${p(50)} ms / ${p(95)} ms`);
    console.log();
    fila('x-ratelimit-limit (crudo)', limites.length > 0 ? limites.join(' | ') : 'no lo mando');
    fila('primer remaining', primerRemaining ?? 'no lo mando');
    fila('ultimo remaining', ultimoRemaining ?? 'no lo mando');
    fila('menor remaining observado', menorRemaining ?? 'no lo mando');
    fila('valores distintos de remaining', distintos.length);
    fila('x-ratelimit-reset (crudo)', resets.length > 0 ? resets.join(' | ') : 'no lo mando');
    fila('retry-after', retry.length > 0 ? retry.join(' | ') : 'no aparecio');

    // ¿Es `remaining` un contador que de verdad baja? En produccion se vio el
    // mismo valor dos veces seguidas, asi que no se da por hecho.
    if (remaining.length >= 2) {
        const bajo = remaining.some((v, i) => i > 0 && v < remaining[i - 1]);
        const consumido = primerRemaining !== null && ultimoRemaining !== null
            ? primerRemaining - ultimoRemaining : null;
        console.log();
        fila('¿remaining llego a bajar?', bajo ? 'si' : 'NO — no es un contador fiable');
        fila('consumido segun la cabecera', consumido === null ? 'n/a' : consumido);
        fila('llamadas realmente hechas', llamadas.length);
        if (consumido !== null && bajo && consumido !== llamadas.length) {
            fila('AVISO', `la cabecera dice ${consumido} y se hicieron ${llamadas.length}: no es lineal`);
        }
    }

    // El primer 429, que es donde de verdad esta el techo.
    const primerLimitado = llamadas.findIndex(l => l.status === 429);
    if (primerLimitado >= 0) {
        console.log();
        fila('PRIMER 429 en la llamada', primerLimitado + 1);
        fila('  sus cabeceras', JSON.stringify(llamadas[primerLimitado].cabeceras));
    }

    return { ok: ok.length, limitadas: limitadas.length, otras: otras.length };
}

(async () => {
    console.log('SONDA DE CAPACIDAD DE v2 — avatar.roblox.com/v2/avatar/users/{id}/avatar');
    console.log('Solo v2. Sin limitador propio, sin cache, usuarios distintos.\n');

    // ── FASE 1: en rafaga, para encontrar el techo ──────────────────────────
    console.log(`FASE 1 — ${FASE_1} llamadas SEGUIDAS, sin pausa entre ellas.`);
    const fase1 = [];
    const t1 = Date.now();
    for (let i = 0; i < FASE_1; i++) {
        const r = await unaLlamada(PRIMER_ID + i);
        fase1.push(r);
        const marca = r.status === 200 ? '.' : r.status === 429 ? '!' : '?';
        process.stdout.write(marca);
        // Un 429 no corta la fase: interesa ver si se recupera dentro de la
        // misma rafaga o si la ruta queda cerrada del todo.
    }
    const duracion1 = Date.now() - t1;
    console.log();
    const r1 = resumir('FASE 1 — rafaga', fase1, duracion1);

    if (r1.limitadas > 0 || r1.otras > 0) {
        console.log(`\n${'─'.repeat(64)}`);
        console.log('NO SE EJECUTA LA FASE 2: la rafaga ya encontro el techo.');
        console.log('El numero que importa es en que llamada llego el primer 429 y');
        console.log('que dijo retry-after: eso es la capacidad real de esta IP.');
        process.exit(0);
    }

    // ── FASE 2: ritmo sostenido ─────────────────────────────────────────────
    //
    // Las 50 pasaron. Ahora la pregunta es otra: cuanto se aguanta SOSTENIDO,
    // que es lo que necesita el worker para planificar. El ritmo sale de la
    // cabecera si se puede leer, y si no del valor por defecto.
    const limiteCrudo = fase1.find(l => l.cabeceras['x-ratelimit-limit'])?.cabeceras['x-ratelimit-limit'];
    const porVentana = numeroDe(limiteCrudo);
    const ventanaS = limiteCrudo && /w=(\d+)/.test(limiteCrudo) ? Number(limiteCrudo.match(/w=(\d+)/)[1]) : null;
    const pausaMs = porVentana && ventanaS
        ? Math.max(50, Math.round((ventanaS * 1000) / porVentana))
        : PAUSA_POR_DEFECTO_MS;

    console.log(`\n${'─'.repeat(64)}`);
    console.log(`Las ${FASE_1} respondieron 200. FASE 2 — ${FASE_2} llamadas a ritmo controlado.`);
    console.log(`Pausa entre llamadas: ${pausaMs} ms`
        + (porVentana && ventanaS ? ` (deducida de ${limiteCrudo})` : ' (por defecto)'));

    const fase2 = [];
    const t2 = Date.now();
    for (let i = 0; i < FASE_2; i++) {
        const r = await unaLlamada(PRIMER_ID + FASE_1 + i);
        fase2.push(r);
        process.stdout.write(r.status === 200 ? '.' : r.status === 429 ? '!' : '?');
        if ((i + 1) % 50 === 0) process.stdout.write(` ${i + 1}\n`);
        await dormir(pausaMs);
    }
    const duracion2 = Date.now() - t2;
    console.log();
    resumir(`FASE 2 — ritmo sostenido (${pausaMs} ms entre llamadas)`, fase2, duracion2);

    console.log(`\n${'─'.repeat(64)}`);
    console.log('COMO LEER ESTO PARA EL WORKER: el ritmo sostenido sin 429 es el');
    console.log('techo por instancia. Multiplicado por 60 da los usuarios por');
    console.log('minuto, y de ahi salen las horas que cuesta indexar la comunidad.');
    process.exit(0);
})().catch(err => {
    console.error('LA SONDA SE ROMPIO:', err?.message ?? err);
    process.exit(1);
});
