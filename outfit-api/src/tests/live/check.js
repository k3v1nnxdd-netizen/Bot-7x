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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
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

// Pide un recurso tolerando que ROBLOX nos limite. No es indulgencia con
// nuestro codigo: avatar.roblox.com/v2/.../outfits limita por IP de forma
// muy agresiva (dos listados frios seguidos bastan para un 429, comprobado
// repetidamente), y en una prueba en frio como esta no hay cache que lo
// absorba. Un 503 upstream_rate_limited es la respuesta CORRECTA ante eso,
// asi que se espera el Retry-After que devolvemos y se reintenta una vez
// antes de darlo por no verificado.
async function requestTolerant(port, path) {
    let res = await request(port, path);
    if (res.status !== 503 || res.body?.error?.code !== 'upstream_rate_limited') return res;

    const espera = Math.min(res.body.error.retryAfterSeconds ?? 10, 60);
    console.log(`  ..   Roblox limito (503). Esperando el Retry-After de ${espera}s y reintentando una vez.`);
    await sleep(espera * 1000 + 500);

    res = await request(port, path);
    if (res.status === 503 && res.body?.error?.code === 'upstream_rate_limited') {
        res.limitadoPorRoblox = true;
    }
    return res;
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
    section('4. listado de outfits (con outfitType por outfit)');
    let outfitId = null;
    let outfitAvatarId = null;
    {
        const res = await requestTolerant(port, `/v1/users/${userId}/outfits?limit=10`);
        if (res.limitadoPorRoblox) {
            console.log('  --   Roblox sigue limitando el listado: seccion no verificada en esta pasada.');
        } else {
            check(`GET /v1/users/${userId}/outfits -> 200`, res.status === 200, `${res.ms}ms`);
            check('la respuesta trae la forma paginada esperada',
                Array.isArray(res.body?.outfits) && typeof res.body?.hasMore === 'boolean' && res.body?.limit === 10,
                `count=${res.body?.count} hasMore=${res.body?.hasMore}`);
            check('cada outfit trae su outfitType',
                (res.body?.outfits ?? []).length > 0 && (res.body?.outfits ?? []).every(o => typeof o.outfitType === 'string'),
                JSON.stringify((res.body?.outfits ?? []).slice(0, 3).map(o => `${o.name}:${o.outfitType}`)));

            outfitId = res.body?.outfits?.[0]?.id ?? null;
            outfitAvatarId = (res.body?.outfits ?? []).find(o => o.outfitType === 'Avatar')?.id ?? null;
        }
    }

    // ── 4b. Filtro por outfitType ────────────────────────────────────────────
    section('4b. filtro por outfitType');
    {
        // Pausa deliberada. avatar.roblox.com/v2/.../outfits limita MUY
        // agresivo: dos listados seguidos bastan para provocar un 429
        // (comprobado repetidamente al investigar). En produccion eso lo
        // absorbe la cache; aqui, que son dos listados distintos y frios a
        // proposito, hay que espaciarlos.
        await sleep(8000);

        const res = await requestTolerant(port, `/v1/users/${userId}/outfits?limit=10&outfitType=DynamicHead`);

        if (res.limitadoPorRoblox) {
            console.log('  --   Roblox sigue limitando: filtro no verificado en esta pasada.');
        } else {
            check('outfitType=DynamicHead -> 200', res.status === 200, `${res.ms}ms count=${res.body?.count}`);
            check('Roblox devuelve solo ese tipo',
                (res.body?.outfits ?? []).length > 0 && (res.body?.outfits ?? []).every(o => o.outfitType === 'DynamicHead'));
            check('el filtro se refleja en la respuesta', res.body?.outfitType === 'DynamicHead');
        }

        const malo = await request(port, `/v1/users/${userId}/outfits?outfitType=Basura`);
        check('un outfitType desconocido -> 400 sin llamar a Roblox',
            malo.status === 400 && malo.body?.error?.code === 'invalid_request');
    }

    // ── 5. Endpoint compuesto ────────────────────────────────────────────────
    section('5. endpoint compuesto (resolver + listar en una llamada)');
    {
        const res = await requestTolerant(port, `/v1/users/by-username/${USERNAME}/outfits?limit=10`);
        if (res.limitadoPorRoblox) {
            console.log('  --   Roblox sigue limitando: compuesto no verificado en esta pasada.');
        } else {
            check('GET /v1/users/by-username/:username/outfits -> 200', res.status === 200, `${res.ms}ms`);
            check('devuelve el listado ya resuelto',
                res.body?.userId === userId && Array.isArray(res.body?.outfits) && !!res.body?.username,
                `userId=${res.body?.userId} username=${res.body?.username}`);
        }
    }

    // Si el LISTADO quedo limitado, las secciones de detalle no tienen por que
    // perderse: usan otro endpoint (v3/outfits/.../details), mucho menos
    // limitado, y estos dos ids son reales y estables — el primero con ropa
    // por capas, el segundo con partes del cuerpo.
    if (outfitId == null) {
        outfitId = 555869704325162;
        outfitAvatarId = 131929576;
        console.log(`\n  ..   Listado no disponible: se continua con outfits reales conocidos (${outfitId}, ${outfitAvatarId}).`);
    }

    // ── 6. Detalles de un outfit: datos completos de reconstruccion ──────────
    section('6. detalles de un outfit (HumanoidDescription completo)');
    {
        const res = await request(port, `/v1/outfits/${outfitId}`);
        const hd = res.body?.humanoidDescription;

        check(`GET /v1/outfits/${outfitId} -> 200`, res.status === 200, `${res.ms}ms`);
        check('trae metadatos del outfit',
            res.body?.outfitType != null && res.body?.playerAvatarType != null,
            `tipo=${res.body?.outfitType} inventario=${res.body?.inventoryType} avatar=${res.body?.playerAvatarType}`);

        check('humanoidDescription tiene todas las secciones',
            hd && ['scale', 'bodyColors', 'bodyParts', 'clothing', 'accessories', 'layeredClothing', 'animations', 'emotes', 'other']
                .every(k => k in hd));
        check('las seis escalas',
            hd?.scale && ['height', 'width', 'depth', 'head', 'proportion', 'bodyType'].every(k => k in hd.scale),
            JSON.stringify(hd?.scale));
        check('los seis colores del cuerpo',
            hd?.bodyColors && ['head', 'torso', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg'].every(k => k in hd.bodyColors),
            `formato=${hd?.bodyColorFormat} ${JSON.stringify(hd?.bodyColors)}`);
        check('las ocho categorias de accesorios clasicos',
            hd?.accessories && ['hat', 'hair', 'face', 'neck', 'shoulder', 'front', 'back', 'waist'].every(k => Array.isArray(hd.accessories[k])));
        check('las diez ranuras de animacion',
            hd?.animations && ['climb', 'death', 'fall', 'idle', 'jump', 'run', 'swim', 'walk', 'pose', 'mood'].every(k => k in hd.animations));
        check('la lista plana de assets conserva nombre y tipo',
            (res.body?.assets ?? []).every(a => 'id' in a && 'name' in a && 'typeId' in a && 'typeName' in a),
            JSON.stringify(res.body?.assets?.[0] ?? null));

        if (hd?.layeredClothing?.length) {
            console.log(`       ropa por capas: ${JSON.stringify(hd.layeredClothing)}`);
        }
        console.log(`       tamaño de la respuesta: ${res.raw.length} bytes`);
    }

    // ── 6b. Un outfit de tipo Avatar (partes del cuerpo y ropa) ──────────────
    section('6b. outfit de tipo Avatar');
    if (outfitAvatarId == null) {
        console.log('  --   omitido: no habia ninguno de tipo Avatar en la primera pagina');
    } else {
        const res = await request(port, `/v1/outfits/${outfitAvatarId}`);
        const hd = res.body?.humanoidDescription;
        check(`GET /v1/outfits/${outfitAvatarId} -> 200`, res.status === 200, `${res.ms}ms`);
        check('las partes del cuerpo estan resueltas',
            hd?.bodyParts && Object.values(hd.bodyParts).some(v => v != null),
            JSON.stringify(hd?.bodyParts));
        check('ningun asset se quedo sin clasificar',
            (res.body?.assets ?? []).length > 0 && (hd?.other ?? []).length === 0,
            `assets=${res.body?.assets?.length} sinClasificar=${hd?.other?.length}`);
    }

    // ── 6c. Bundles opcionales ───────────────────────────────────────────────
    section('6c. ?bundles=1 (opcional, cuesta llamadas extra)');
    if (outfitId == null) {
        console.log('  --   omitido');
    } else {
        const antes = (await request(port, '/v1/metrics')).body.roblox.byRoute;
        const res = await request(port, `/v1/outfits/${outfitId}?bundles=1`);
        const despues = (await request(port, '/v1/metrics')).body.roblox.byRoute;

        check('GET ?bundles=1 -> 200', res.status === 200, `${res.ms}ms`);
        check('aparece la union de bundles y el detalle por asset',
            Array.isArray(res.body?.bundles) && (res.body?.assets ?? []).every(a => 'bundles' in a),
            `bundles=${JSON.stringify(res.body?.bundles)}`);
        check('usa su propio bucket, sin tocar el de los outfits',
            despues.assetBundles.calls > antes.assetBundles.calls
            && despues.outfitDetails.calls === antes.outfitDetails.calls,
            `assetBundles ${antes.assetBundles.calls} -> ${despues.assetBundles.calls}`);

        const sinBundles = await request(port, `/v1/outfits/${outfitId}`);
        check('sin la bandera, cero llamadas de bundles y respuesta sin ese campo',
            sinBundles.body?.bundles === undefined);
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
