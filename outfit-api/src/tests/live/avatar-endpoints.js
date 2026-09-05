'use strict';

// SONDA MANUAL DE ENDPOINTS DE AVATAR — SI golpea la API real de Roblox.
// Nunca se ejecuta con `npm test`: el runner solo recorre src/tests/*.test.js y
// no entra en live/. Se lanza a mano:
//
//   cd outfit-api && node src/tests/live/avatar-endpoints.js [userId]
//
// PARA QUE SIRVE, y sobre todo para que NO sirve.
//
// La documentacion de Roblox confirma que NINGUN endpoint de avatar acepta mas
// de un usuario por llamada: no hay equivalente al POST /v1/batch de
// thumbnails. Cambiar de v1 a v2 o a v4 no reduce el numero de llamadas, y por
// eso el indice persistente no depende de esta medicion: se hace igual.
//
// Lo unico que esta sonda puede descubrir es si esas versiones viven en BUCKETS
// DE CUOTA DISTINTOS. Si al llamar a v2 baja tambien el `x-ratelimit-remaining`
// de v1, comparten cuota y no hay nada que ganar. Si son independientes, el
// worker podria repartirse entre ellos y avanzar mas rapido — pero eso seria un
// ajuste de RITMO, no un cambio de arquitectura.
//
// NO SE SUPONE NADA: se llama, se leen las cabeceras y se mira si los
// contadores se mueven juntos. Cuesta cuatro llamadas.

process.env.OUTFIT_API_KEY = process.env.OUTFIT_API_KEY || 'clave-de-verificacion-local';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const axios = require('axios');

const USER_ID = process.argv[2] || '1';   // ROBLOX, el usuario 1: siempre existe

// Los cuatro caminos que hoy existen para saber que lleva puesto alguien.
const ENDPOINTS = [
    {
        nombre: 'v1 avatar',
        url: id => `https://avatar.roblox.com/v1/users/${id}/avatar`,
        nota: 'el que usa el servicio hoy; trae assetType anidado',
    },
    {
        nombre: 'v2 avatar',
        url: id => `https://avatar.roblox.com/v2/avatar/users/${id}/avatar`,
        nota: 'equivalente v2',
    },
    {
        nombre: 'v4 avatar',
        url: id => `https://avatar.roblox.com/v4/avatar/users/${id}`,
        nota: 'equivalente v4',
    },
    {
        nombre: 'v1 currently-wearing',
        url: id => `https://avatar.roblox.com/v1/users/${id}/currently-wearing`,
        nota: 'solo assetIds, SIN tipos: no vale para la regla de accesorios',
    },
];

const CABECERAS = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after'];

function leerCuota(headers = {}) {
    const salida = {};
    for (const clave of CABECERAS) {
        const valor = headers[clave] ?? headers[clave.toLowerCase()];
        if (valor !== undefined) salida[clave] = String(valor);
    }
    return salida;
}

// ¿Trae el tipo de cada asset? Es lo que decide si un endpoint puede sustituir
// al actual: sin `assetType.id` la regla de mas de tres accesorios no se puede
// aplicar antes de gastar catalogo.
function traeTipos(data) {
    const assets = Array.isArray(data?.assets) ? data.assets : null;
    if (!assets) return null;
    if (assets.length === 0) return 'sin assets para saberlo';
    return assets.some(a => a?.assetType?.id != null) ? 'SI' : 'NO';
}

async function sondear(endpoint, id) {
    const url = endpoint.url(id);
    const t0 = Date.now();
    try {
        const res = await axios.get(url, { timeout: 15_000, validateStatus: () => true });
        const cuerpo = JSON.stringify(res.data ?? '');
        return {
            nombre: endpoint.nombre,
            nota: endpoint.nota,
            url,
            status: res.status,
            ms: Date.now() - t0,
            bytes: Buffer.byteLength(cuerpo),
            cuota: leerCuota(res.headers),
            tipos: traeTipos(res.data),
        };
    } catch (err) {
        return {
            nombre: endpoint.nombre, nota: endpoint.nota, url,
            status: 'ERROR', ms: Date.now() - t0, error: err?.message ?? String(err),
        };
    }
}

(async () => {
    console.log(`\nSonda de endpoints de avatar — usuario ${USER_ID}`);
    console.log('Mide CABECERAS DE CUOTA. No cambia nada del servicio.\n');

    const resultados = [];
    for (const endpoint of ENDPOINTS) {
        const r = await sondear(endpoint, USER_ID);
        resultados.push(r);

        console.log(`── ${r.nombre} ${'─'.repeat(Math.max(0, 40 - r.nombre.length))}`);
        console.log(`   ${r.url}`);
        console.log(`   ${r.nota}`);
        if (r.status === 'ERROR') {
            console.log(`   FALLO: ${r.error}\n`);
            continue;
        }
        console.log(`   status ${r.status} · ${r.ms} ms · ${r.bytes} bytes · tipos de asset: ${r.tipos ?? 'n/a'}`);
        const cuota = Object.entries(r.cuota);
        console.log(cuota.length > 0
            ? `   cuota: ${cuota.map(([k, v]) => `${k}=${v}`).join(' · ')}`
            : '   cuota: Roblox NO mando cabeceras x-ratelimit en esta llamada');
        console.log();
    }

    // ── La unica conclusion que esta sonda puede sacar ──────────────────────
    const conCuota = resultados.filter(r => r.cuota && r.cuota['x-ratelimit-remaining'] !== undefined);
    console.log('─'.repeat(56));
    if (conCuota.length < 2) {
        console.log('SIN CONCLUSION: Roblox no mando cabeceras de cuota suficientes.');
        console.log('Repetir mas tarde o con mas llamadas: sin cabeceras no se puede');
        console.log('decir si las versiones comparten bucket, y suponerlo seria el');
        console.log('error que esta sonda existe para evitar.');
    } else {
        const restantes = conCuota.map(r => `${r.nombre}=${r.cuota['x-ratelimit-remaining']}`);
        console.log(`remaining por endpoint: ${restantes.join(' · ')}`);
        console.log('Si esos contadores bajan JUNTOS al repetir la sonda, comparten');
        console.log('bucket y no hay nada que ganar cambiando de version. Si son');
        console.log('independientes, el worker podria repartirse entre ellos: seria');
        console.log('un ajuste de ritmo, nunca un cambio de arquitectura.');
    }
    console.log();

    // Ningun endpoint acepta varios usuarios: lo dice la documentacion oficial
    // y esta sonda no lo desmiente ni lo pretende.
    console.log('RECORDATORIO: ninguno de estos endpoints acepta mas de un usuario');
    console.log('por llamada. El indice persistente no se justifica en esta medida.');
    process.exit(0);
})().catch(err => {
    console.error('LA SONDA SE ROMPIO:', err?.message ?? err);
    process.exit(1);
});
