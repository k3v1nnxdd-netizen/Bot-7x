'use strict';

// VERIFICACION MANUAL DE PUNTA A PUNTA — SI golpea la API real de Roblox.
// Nunca se ejecuta con `npm test`: el runner solo recorre src/tests/*.test.js
// y no entra aqui. Se lanza a mano con `npm run test:live [username]`.
//
// Levanta la app en un puerto efimero y la recorre como lo haria el juego:
// resolver un nombre, listar outfits, pedir el detalle de uno, comprobar que
// la cache y el single-flight funcionan de verdad contra latencia real, y
// verificar que un usuario inexistente da 404.
//
// Gasta un puñado de llamadas reales a Roblox (media docena), a proposito:
// lo suficiente para demostrar que el camino completo funciona, lo bastante
// poco para no presionar los limites que todo el diseño existe para cuidar.

process.env.OUTFIT_API_KEY = process.env.OUTFIT_API_KEY || 'clave-de-verificacion-local';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const http = require('http');
const { createApp } = require('../../app');
const config = require('../../config');

const USERNAME = process.argv[2] || 'builderman';
const USERNAME_FRIO = process.argv[3] || 'Roblox';   // segundo nombre, sin cachear, para la prueba de estampida
const USERNAME_INEXISTENTE = 'zz_no_existe_9x7q';

function request(port, path) {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port, path, method: 'GET', headers: { 'x-api-key': config.apiKey } },
            res => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    let body = null;
                    try { body = JSON.parse(data); } catch { /* se deja en raw */ }
                    resolve({ status: res.statusCode, body, raw: data, ms: Date.now() - startedAt });
                });
            }
        );
        req.on('error', reject);
        req.end();
    });
}

let failures = 0;

function check(label, condition, detail) {
    if (condition) {
        console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`);
    } else {
        failures++;
        console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    }
}

function section(title) {
    console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

(async () => {
    const app = createApp();
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;
    console.log(`outfit-api levantada en el puerto ${port} para la verificacion en vivo\n`);

    // ── 1. Healthcheck ───────────────────────────────────────────────────────
    section('1. healthcheck');
    {
        const res = await request(port, '/health');
        check('GET /health -> 200', res.status === 200 && res.body?.status === 'ok', `${res.ms}ms`);
    }

    // ── 2. Resolucion de username ────────────────────────────────────────────
    section('2. resolucion username -> userId (Roblox real)');
    let userId = null;
    {
        const res = await request(port, `/v1/users/by-username/${USERNAME}`);
        check(`GET /v1/users/by-username/${USERNAME} -> 200`, res.status === 200, `${res.ms}ms`);
        check('trae userId, username y displayName',
            typeof res.body?.userId === 'number' && !!res.body?.username && !!res.body?.displayName,
            JSON.stringify(res.body));
        userId = res.body?.userId;
    }

    // ── 3. Cache ─────────────────────────────────────────────────────────────
    section('3. cache (la segunda llamada no debe tocar Roblox)');
    {
        const antes = (await request(port, '/v1/metrics')).body.roblox.byRoute.usernameLookup.calls;
        const res = await request(port, `/v1/users/by-username/${USERNAME}`);
        const despues = (await request(port, '/v1/metrics')).body.roblox.byRoute.usernameLookup.calls;

        check('la repeticion responde 200', res.status === 200, `${res.ms}ms`);
        check('cero llamadas nuevas a Roblox', antes === despues, `usernameLookup.calls ${antes} -> ${despues}`);
        check('y es mucho mas rapida', res.ms < 50, `${res.ms}ms desde cache`);
    }

    // ── 4. Listado de outfits ────────────────────────────────────────────────
    section('4. listado de outfits');
    let outfitId = null;
    {
        const res = await request(port, `/v1/users/${userId}/outfits?limit=10`);
        check(`GET /v1/users/${userId}/outfits -> 200`, res.status === 200, `${res.ms}ms`);
        check('la respuesta trae la forma paginada esperada',
            Array.isArray(res.body?.outfits) && typeof res.body?.hasMore === 'boolean' && res.body?.limit === 10,
            `count=${res.body?.count} hasMore=${res.body?.hasMore}`);
        outfitId = res.body?.outfits?.[0]?.id ?? null;
        if (res.body?.outfits?.length) {
            console.log(`       primeros outfits: ${res.body.outfits.slice(0, 3).map(o => `${o.id}:${o.name}`).join(', ')}`);
        }
    }

    // ── 5. Endpoint compuesto ────────────────────────────────────────────────
    section('5. endpoint compuesto (resolver + listar en una llamada)');
    {
        const res = await request(port, `/v1/users/by-username/${USERNAME}/outfits?limit=10`);
        check('GET /v1/users/by-username/:username/outfits -> 200', res.status === 200, `${res.ms}ms`);
        check('devuelve el listado ya resuelto',
            res.body?.userId === userId && Array.isArray(res.body?.outfits) && !!res.body?.username,
            `userId=${res.body?.userId} username=${res.body?.username}`);
    }

    // ── 6. Detalles de un outfit ─────────────────────────────────────────────
    section('6. detalles de un outfit');
    if (outfitId == null) {
        console.log('  --   omitido: este usuario no tiene outfits publicos que listar');
    } else {
        const res = await request(port, `/v1/outfits/${outfitId}`);
        check(`GET /v1/outfits/${outfitId} -> 200`, res.status === 200, `${res.ms}ms`);
        check('trae assets, escalas y colores normalizados',
            Array.isArray(res.body?.assets) && 'scale' in (res.body ?? {}) && 'bodyColorFormat' in (res.body ?? {}),
            `assets=${res.body?.assets?.length} tipo=${res.body?.playerAvatarType} colores=${res.body?.bodyColorFormat}`);
        check('cada asset viene compacto: solo id, name y typeId',
            (res.body?.assets ?? []).every(a => Object.keys(a).sort().join(',') === 'id,name,typeId'),
            JSON.stringify(res.body?.assets?.[0] ?? null));
    }

    // ── 7. Single-flight contra latencia real ────────────────────────────────
    section('7. single-flight (50 peticiones simultaneas sobre un nombre frio)');
    {
        const antes = (await request(port, '/v1/metrics')).body.roblox.byRoute.usernameLookup.calls;
        const startedAt = Date.now();
        const responses = await Promise.all(
            Array.from({ length: 50 }, () => request(port, `/v1/users/by-username/${USERNAME_FRIO}`))
        );
        const ms = Date.now() - startedAt;
        const despues = (await request(port, '/v1/metrics')).body.roblox.byRoute.usernameLookup.calls;

        check('las 50 responden 200', responses.every(r => r.status === 200), `${ms}ms en total`);
        check('las 50 devuelven exactamente el mismo dato',
            new Set(responses.map(r => r.raw)).size === 1);
        check('y colapsan en UNA sola llamada a Roblox',
            despues - antes === 1, `usernameLookup.calls ${antes} -> ${despues}`);
    }

    // ── 8. 404 y cache negativa ──────────────────────────────────────────────
    section('8. usuario inexistente -> 404 + cache negativa');
    {
        const primera = await request(port, `/v1/users/by-username/${USERNAME_INEXISTENTE}`);
        check('primer intento -> 404 user_not_found',
            primera.status === 404 && primera.body?.error?.code === 'user_not_found', `${primera.ms}ms`);

        const antes = (await request(port, '/v1/metrics')).body.roblox.byRoute.usernameLookup.calls;
        const segunda = await request(port, `/v1/users/by-username/${USERNAME_INEXISTENTE}`);
        const despues = (await request(port, '/v1/metrics')).body.roblox.byRoute.usernameLookup.calls;

        check('el segundo 404 sale de cache, sin volver a preguntar a Roblox',
            segunda.status === 404 && antes === despues, `usernameLookup.calls ${antes} -> ${despues}`);
    }

    // ── 9. Validacion y auth por HTTP real ───────────────────────────────────
    section('9. validacion y proteccion por API key');
    {
        const malUsuario = await request(port, '/v1/users/by-username/ab');
        check('username invalido -> 400', malUsuario.status === 400 && malUsuario.body?.error?.code === 'invalid_request');

        const malLimit = await request(port, `/v1/users/${userId}/outfits?limit=7`);
        check('limit fuera del conjunto -> 400', malLimit.status === 400);

        // Id con forma valida pero que Roblox no reconoce (confirmado en
        // vivo: responde 404 "The specified userOutfitId is invalid"). Ojo,
        // ids bajos como el 1 SI existen de verdad y devuelven 200.
        const outfitInexistente = await request(port, '/v1/outfits/999999999999999');
        check('outfit inexistente -> 404 outfit_not_found',
            outfitInexistente.status === 404 && outfitInexistente.body?.error?.code === 'outfit_not_found',
            `status=${outfitInexistente.status} code=${outfitInexistente.body?.error?.code}`);
    }

    // ── 10. Resumen de metricas ──────────────────────────────────────────────
    section('10. metricas finales');
    {
        const res = await request(port, '/v1/metrics');
        const { cache, roblox } = res.body;
        console.log(`  cache        entradas=${cache.entries} hits=${cache.hits} misses=${cache.misses} hitRate=${cache.hitRate}`);
        console.log(`  singleFlight iniciados=${cache.singleFlight.started} enganchados=${cache.singleFlight.joined}`);
        for (const [route, m] of Object.entries(roblox.byRoute)) {
            console.log(`  roblox.${route.padEnd(14)} calls=${m.calls} ok=${m.ok} 404=${m.notFound} 429=${m.rateLimited} 5xx=${m.serverErrors} circuito=${m.circuit.state}`);
        }
        const secreto = res.raw.includes(config.apiKey);
        check('la API key NO aparece en /v1/metrics', !secreto);
    }

    await new Promise(resolve => server.close(resolve));

    console.log();
    if (failures > 0) {
        console.error(`VERIFICACION EN VIVO: ${failures} comprobacion(es) fallaron`);
        process.exit(1);
    }
    console.log('VERIFICACION EN VIVO: todo correcto');
    process.exit(0);
})().catch(err => {
    console.error('LA VERIFICACION EN VIVO SE ROMPIO:', err);
    process.exit(1);
});
