'use strict';

const http = require('http');
const { createSuite, captureStdout } = require('./harness');
const { createApp } = require('../app');
const config = require('../config');
const logger = require('../observability/logger');
const ownRateLimit = require('../security/rateLimit');
const db = require('../db/pool');

// Tests de /admin/groups por HTTP real y SIN base de datos: `db.query` se
// sustituye por un doble que registra el SQL y los parametros y devuelve
// filas fabricadas. Eso permite verificar lo que de verdad importa de esta
// capa y que un Postgres real NO probaria mejor:
//
//   - que la key del juego no abre la administracion, ni al reves;
//   - que todo valor variable viaja como PARAMETRO y jamas dentro del SQL;
//   - que una entrada invalida se rechaza ANTES de tocar la base;
//   - que "base caida" sale como 503 y un bug nuestro como 500.
//
// La verificacion contra Postgres de verdad vive en src/tests/live/db-check.js.

const GROUP_ID = '35216530';
const CREATED_AT = new Date('2026-01-15T10:30:00.000Z');

// El limitador por IP tiene un tope de 25 en el runner (ver src/tests/run.js)
// y aqui se hacen bastantes mas peticiones desde 127.0.0.1, asi que se
// reinicia antes de cada una: este archivo prueba la administracion, no el
// limitador. `sinReset` existe para el unico test que si comprueba que
// /admin/groups esta detras de ese limitador.
function request(port, method, path, { headers = {}, body, raw, sinReset = false } = {}) {
    if (!sinReset) ownRateLimit.reset();
    const payload = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, method, headers }, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch { /* respuesta no-JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: data });
            });
        });
        req.on('error', reject);
        if (payload !== null) req.write(payload);
        req.end();
    });
}

const jsonHeaders = extra => ({ 'content-type': 'application/json', ...extra });

module.exports = async function run() {
    const suite = createSuite('adminGroups');
    const { test, assert } = suite;

    const ADMIN = config.adminApiKey;
    const OUTFIT = config.apiKey;
    const admin = { 'x-admin-key': ADMIN };

    // ── Doble de la base ─────────────────────────────────────────────────────
    const queryOriginal = db.query;
    let calls = [];
    let responder = () => { throw new Error('ningun test ha preparado una respuesta de la base'); };

    db.query = async (text, params = []) => {
        calls.push({ text, params });
        return responder(text, params);
    };

    // Responde siempre lo mismo, sea cual sea la consulta.
    const responde = rows => {
        calls = [];
        responder = () => ({ rows, rowCount: rows.length });
    };
    // Falla siempre con un error con la forma que produce `pg`.
    const falla = code => {
        calls = [];
        responder = () => {
            const err = new Error(`fallo simulado (${code})`);
            err.code = code;
            throw err;
        };
    };

    const fila = (overrides = {}) => ({
        group_id: GROUP_ID,
        active: true,
        created_at: CREATED_AT,
        ...overrides,
    });

    const app = createApp();
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;

    // ── Separacion de secretos ───────────────────────────────────────────────

    test('sin x-admin-key -> 401 y NI UNA consulta a la base', async () => {
        responde([]);
        const res = await request(port, 'GET', '/admin/groups');

        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body.error.code, 'unauthorized');
        assert.strictEqual(calls.length, 0, 'un no autorizado no puede llegar a costar una consulta');
    });

    test('la OUTFIT_API_KEY no sirve para administrar', async () => {
        responde([]);
        const comoAdmin = await request(port, 'GET', '/admin/groups', { headers: { 'x-admin-key': OUTFIT } });
        const comoJuego = await request(port, 'GET', '/admin/groups', { headers: { 'x-api-key': OUTFIT } });

        assert.strictEqual(comoAdmin.status, 401, 'la key del juego jamas puede dar licencias');
        assert.strictEqual(comoJuego.status, 401, '/admin no acepta la cabecera del juego');
        assert.strictEqual(calls.length, 0);
    });

    test('la ADMIN_API_KEY no sirve para leer outfits', async () => {
        const res = await request(port, 'GET', '/v1/metrics', { headers: { 'x-admin-key': ADMIN } });
        assert.strictEqual(res.status, 401, 'la separacion tiene que valer en los dos sentidos');
    });

    test('con x-admin-key incorrecta -> 401 identico al que falta la cabecera', async () => {
        responde([]);
        const sinKey = await request(port, 'GET', `/admin/groups/${GROUP_ID}`);
        const conKeyMala = await request(port, 'GET', `/admin/groups/${GROUP_ID}`, { headers: { 'x-admin-key': 'no-es' } });

        assert.strictEqual(conKeyMala.status, 401);
        assert.deepStrictEqual(conKeyMala.body, sinKey.body, 'las dos respuestas deben ser indistinguibles');
    });

    test('sin ADMIN_API_KEY configurada -> 503 admin_disabled (no 401)', async () => {
        responde([]);
        config.adminApiKey = null; // se restaura al salir del test
        try {
            let res;
            await captureStdout(async () => {
                res = await request(port, 'GET', '/admin/groups', { headers: admin });
            });
            assert.strictEqual(res.status, 503);
            assert.strictEqual(res.body.error.code, 'admin_disabled');
            assert.match(res.body.error.message, /ADMIN_API_KEY/, 'debe decir que falta configurarla en el servidor');
        } finally {
            config.adminApiKey = ADMIN;
        }
    });

    test('la clave de admin no aparece en ninguna respuesta', async () => {
        responde([fila()]);
        const respuestas = await Promise.all([
            request(port, 'GET', '/admin/groups', { headers: admin }),
            request(port, 'GET', `/admin/groups/${GROUP_ID}`, { headers: admin }),
            request(port, 'GET', '/admin/groups', { headers: { 'x-admin-key': 'incorrecta' } }),
        ]);
        for (const res of respuestas) {
            assert.ok(!(res.raw + JSON.stringify(res.headers)).includes(ADMIN), 'el secreto no puede salir');
        }
    });

    test('la clave de admin nunca llega al log', async () => {
        const captured = await captureStdout(async () => {
            logger.error('caso de prueba', { 'x-admin-key': ADMIN, adminApiKey: ADMIN, ruta: '/admin/groups' });
        });
        assert.ok(!captured.includes(ADMIN), 'el logger debe redactar tambien la key de administracion');
        assert.ok(captured.includes('/admin/groups'), 'lo que no es secreto si debe registrarse');
    });

    // ── Alta ─────────────────────────────────────────────────────────────────

    test('POST agrega un grupo nuevo -> 201 y SQL parametrizado', async () => {
        responde([{ ...fila(), inserted: true }]);
        const res = await request(port, 'POST', '/admin/groups', {
            headers: jsonHeaders(admin),
            body: { groupId: GROUP_ID },
        });

        assert.strictEqual(res.status, 201);
        assert.deepStrictEqual(res.body, {
            groupId: GROUP_ID,
            active: true,
            createdAt: CREATED_AT.toISOString(),
            created: true,
            authorized: true,
        });

        assert.strictEqual(calls.length, 1, 'un alta es UNA consulta, no un select + insert');
        const { text, params } = calls[0];
        assert.match(text, /INSERT INTO group_whitelist/i);
        assert.match(text, /ON CONFLICT \(group_id\) DO UPDATE SET active = true/i);
        assert.ok(text.includes('$1'), 'el valor debe ir como parametro');
        assert.deepStrictEqual(params, [GROUP_ID]);
        assert.ok(!text.includes(GROUP_ID), 'el id JAMAS puede aparecer dentro del texto de la consulta');
    });

    test('POST sobre un grupo que ya existe -> 200 created:false (idempotente)', async () => {
        responde([{ ...fila(), inserted: false }]);
        const res = await request(port, 'POST', '/admin/groups', {
            headers: jsonHeaders(admin),
            body: { groupId: GROUP_ID },
        });

        assert.strictEqual(res.status, 200, 'repetir el alta no es un error');
        assert.strictEqual(res.body.created, false);
        assert.strictEqual(res.body.authorized, true);
    });

    test('POST reactiva un grupo dado de baja conservando su alta original', async () => {
        // El UPSERT pone active = true y RETURNING devuelve el created_at
        // original: readmitir no reescribe la fecha en la que entro.
        responde([{ ...fila({ active: true }), inserted: false }]);
        const res = await request(port, 'POST', '/admin/groups', {
            headers: jsonHeaders(admin),
            body: { groupId: GROUP_ID },
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.active, true);
        assert.strictEqual(res.body.createdAt, CREATED_AT.toISOString());
    });

    test('POST acepta el groupId como numero y lo normaliza a texto', async () => {
        responde([{ ...fila(), inserted: true }]);
        const res = await request(port, 'POST', '/admin/groups', {
            headers: jsonHeaders(admin),
            body: { groupId: 35216530 },
        });

        assert.strictEqual(res.status, 201);
        assert.deepStrictEqual(calls[0].params, [GROUP_ID], 'a la base tiene que llegar SIEMPRE como texto');
    });

    test('POST con un groupId invalido -> 400 sin tocar la base', async () => {
        const casos = [
            { body: {}, motivo: 'sin groupId' },
            { body: { groupId: '' }, motivo: 'vacio' },
            { body: { groupId: 'abc' }, motivo: 'no numerico' },
            { body: { groupId: '0' }, motivo: 'cero' },
            { body: { groupId: '007' }, motivo: 'ceros a la izquierda: "007" y "7" serian dos filas del mismo grupo' },
            { body: { groupId: '-5' }, motivo: 'negativo' },
            { body: { groupId: '12 34' }, motivo: 'con espacio' },
            { body: { groupId: '123456789012345678901' }, motivo: 'demasiado largo' },
            { body: { groupId: ["123"] }, motivo: 'array en vez de cadena' },
            { body: { groupId: "1; DROP TABLE group_whitelist; --" }, motivo: 'intento de inyeccion' },
            { body: [], motivo: 'el cuerpo no es un objeto' },
        ];

        for (const { body, motivo } of casos) {
            responde([]);
            const res = await request(port, 'POST', '/admin/groups', { headers: jsonHeaders(admin), body });
            assert.strictEqual(res.status, 400, `deberia rechazar: ${motivo}`);
            assert.strictEqual(res.body.error.code, 'invalid_request');
            assert.strictEqual(calls.length, 0, `no puede consultar la base con entrada invalida (${motivo})`);
        }
    });

    test('POST sin Content-Type json -> 400 que explica exactamente que falta', async () => {
        responde([]);
        const res = await request(port, 'POST', '/admin/groups', {
            headers: admin,
            raw: JSON.stringify({ groupId: GROUP_ID }),
        });

        assert.strictEqual(res.status, 400);
        assert.match(res.body.error.message, /Content-Type: application\/json/);
        assert.strictEqual(calls.length, 0);
    });

    test('POST con JSON malformado -> 400 invalid_request, no 500', async () => {
        responde([]);
        const res = await request(port, 'POST', '/admin/groups', {
            headers: jsonHeaders(admin),
            raw: '{"groupId": ',
        });

        assert.strictEqual(res.status, 400, 'un JSON roto es culpa del cliente, no del servidor');
        assert.strictEqual(res.body.error.code, 'invalid_request');
        assert.strictEqual(calls.length, 0);
    });

    test('POST con un cuerpo enorme -> 413 y no se procesa', async () => {
        responde([]);
        const res = await request(port, 'POST', '/admin/groups', {
            headers: jsonHeaders(admin),
            raw: JSON.stringify({ groupId: GROUP_ID, relleno: 'x'.repeat(10_000) }),
        });

        assert.strictEqual(res.status, 413);
        assert.strictEqual(res.body.error.code, 'payload_too_large');
        assert.strictEqual(calls.length, 0);
    });

    // ── Consulta ─────────────────────────────────────────────────────────────

    test('GET de un grupo autorizado -> authorized:true', async () => {
        responde([fila()]);
        const res = await request(port, 'GET', `/admin/groups/${GROUP_ID}`, { headers: admin });

        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body, {
            groupId: GROUP_ID,
            authorized: true,
            found: true,
            active: true,
            createdAt: CREATED_AT.toISOString(),
        });

        const { text, params } = calls[0];
        assert.match(text, /SELECT .* FROM group_whitelist WHERE group_id = \$1/i);
        assert.deepStrictEqual(params, [GROUP_ID]);
    });

    test('GET de un grupo que no esta -> 200 authorized:false, NO 404', async () => {
        responde([]);
        const res = await request(port, 'GET', '/admin/groups/999999', { headers: admin });

        // "No esta autorizado" es una RESPUESTA, no un recurso ausente: quien
        // consulte esto necesita un booleano fiable, no tener que tratar un
        // codigo de error como si fuera un dato.
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.authorized, false);
        assert.strictEqual(res.body.found, false);
        assert.strictEqual(res.body.createdAt, null);
    });

    test('GET de un grupo dado de baja -> found:true pero authorized:false', async () => {
        responde([fila({ active: false })]);
        const res = await request(port, 'GET', `/admin/groups/${GROUP_ID}`, { headers: admin });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.found, true, 'hay que poder distinguir "nunca estuvo" de "se le retiro"');
        assert.strictEqual(res.body.active, false);
        assert.strictEqual(res.body.authorized, false);
    });

    test('GET con un groupId invalido -> 400 sin tocar la base', async () => {
        for (const malo of ['abc', '0', '007', '12345678901234567890123']) {
            responde([]);
            const res = await request(port, 'GET', `/admin/groups/${malo}`, { headers: admin });
            assert.strictEqual(res.status, 400, `${malo} deberia dar 400`);
            assert.strictEqual(calls.length, 0);
        }
    });

    // ── Listado ──────────────────────────────────────────────────────────────

    test('GET del listado devuelve solo los activos y el total', async () => {
        responde([
            { ...fila(), total: 2 },
            { group_id: '77', active: true, created_at: CREATED_AT, total: 2 },
        ]);
        const res = await request(port, 'GET', '/admin/groups', { headers: admin });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.total, 2);
        assert.strictEqual(res.body.count, 2);
        assert.strictEqual(res.body.hasMore, false);
        assert.strictEqual(res.body.includeInactive, false);
        assert.deepStrictEqual(res.body.groups.map(g => g.groupId), [GROUP_ID, '77']);
        assert.ok(!('total' in res.body.groups[0]), 'el total de la ventana no debe colarse en cada fila');

        const { text, params } = calls[0];
        assert.match(text, /LIMIT \$2 OFFSET \$3/i, 'el listado se pagina siempre');
        assert.deepStrictEqual(params, [false, 100, 0], 'hasta el filtro por activo va parametrizado');
    });

    test('el listado vacio no revienta al calcular el total', async () => {
        responde([]);
        const res = await request(port, 'GET', '/admin/groups', { headers: admin });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.total, 0);
        assert.deepStrictEqual(res.body.groups, []);
        assert.strictEqual(res.body.hasMore, false);
    });

    test('includeInactive, limit y offset llegan como parametros', async () => {
        responde([{ ...fila({ active: false }), total: 40 }]);
        const res = await request(port, 'GET', '/admin/groups?includeInactive=1&limit=10&offset=20', { headers: admin });

        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(calls[0].params, [true, 10, 20]);
        assert.strictEqual(res.body.hasMore, true, '20 + 1 < 40');
        assert.strictEqual(res.body.groups[0].active, false);
    });

    test('parametros de listado invalidos -> 400 sin tocar la base', async () => {
        for (const query of ['?limit=abc', '?limit=0', '?limit=501', '?offset=-1', '?includeInactive=quiza']) {
            responde([]);
            const res = await request(port, 'GET', `/admin/groups${query}`, { headers: admin });
            assert.strictEqual(res.status, 400, `${query} deberia dar 400`);
            assert.strictEqual(res.body.error.code, 'invalid_request');
            assert.strictEqual(calls.length, 0);
        }
    });

    // ── Baja ─────────────────────────────────────────────────────────────────

    test('DELETE desactiva por defecto y conserva la fila', async () => {
        responde([fila({ active: false })]);
        const res = await request(port, 'DELETE', `/admin/groups/${GROUP_ID}`, { headers: admin });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.authorized, false);
        assert.strictEqual(res.body.active, false);
        assert.strictEqual(res.body.purged, false);
        assert.strictEqual(res.body.createdAt, CREATED_AT.toISOString(), 'la fecha de alta se conserva');

        const { text, params } = calls[0];
        assert.match(text, /UPDATE group_whitelist\s+SET active = false\s+WHERE group_id = \$1/i);
        assert.ok(!/DELETE FROM/i.test(text), 'por defecto NO se borra: queda rastro de la licencia');
        assert.deepStrictEqual(params, [GROUP_ID]);
    });

    test('DELETE ?purge=1 borra la fila de verdad', async () => {
        responde([fila()]);
        const res = await request(port, 'DELETE', `/admin/groups/${GROUP_ID}?purge=1`, { headers: admin });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.purged, true);
        assert.strictEqual(res.body.active, false, 'una fila borrada no puede reportarse como activa');
        assert.match(calls[0].text, /DELETE FROM group_whitelist WHERE group_id = \$1/i);
        assert.deepStrictEqual(calls[0].params, [GROUP_ID]);
    });

    test('DELETE de un grupo que no esta -> 404 group_not_found', async () => {
        responde([]);
        const res = await request(port, 'DELETE', '/admin/groups/999999', { headers: admin });

        // Al reves que el GET: dar de baja algo que no esta en la lista no es
        // una operacion con resultado valido, es una equivocacion.
        assert.strictEqual(res.status, 404);
        assert.strictEqual(res.body.error.code, 'group_not_found');
    });

    test('DELETE con un purge ambiguo -> 400', async () => {
        responde([]);
        const res = await request(port, 'DELETE', `/admin/groups/${GROUP_ID}?purge=quiza`, { headers: admin });

        assert.strictEqual(res.status, 400, 'borrar de verdad no puede activarse por accidente');
        assert.strictEqual(calls.length, 0);
    });

    // ── Fallos de la base ────────────────────────────────────────────────────

    test('base caida -> 503 database_unavailable con Retry-After, no 500', async () => {
        // 5xx se registra a nivel error: se captura stdout para no ensuciar la
        // salida de los tests con fallos provocados a proposito.
        for (const code of ['ECONNREFUSED', '57P03', '53300', '08006', '57014']) {
            falla(code);
            let res;
            const log = await captureStdout(async () => {
                res = await request(port, 'GET', '/admin/groups', { headers: admin });
            });

            assert.strictEqual(res.status, 503, `${code} deberia salir como 503`);
            assert.strictEqual(res.body.error.code, 'database_unavailable');
            assert.ok(Number(res.headers['retry-after']) >= 1);
            assert.ok(log.includes(code), 'el codigo real si tiene que quedar en el log');
        }
    });

    test('sin DATABASE_URL las rutas /admin dan 503, no 500', async () => {
        calls = [];
        db.query = queryOriginal; // el pool real: sin DATABASE_URL en los tests
        try {
            let res;
            await captureStdout(async () => {
                res = await request(port, 'GET', '/admin/groups', { headers: admin });
            });
            assert.strictEqual(res.status, 503);
            assert.strictEqual(res.body.error.code, 'database_unavailable');
        } finally {
            db.query = async (text, params = []) => {
                calls.push({ text, params });
                return responder(text, params);
            };
        }
    });

    test('un error de SQL es 500 y su detalle NO sale en la respuesta', async () => {
        falla('42703'); // undefined_column: un bug nuestro, no un problema de Railway
        let res;
        await captureStdout(async () => {
            res = await request(port, 'GET', '/admin/groups', { headers: admin });
        });

        assert.strictEqual(res.status, 500);
        assert.strictEqual(res.body.error.code, 'internal_error');
        assert.ok(!res.raw.includes('42703'), 'el detalle interno se registra, no se devuelve');
        assert.ok(!res.raw.includes('fallo simulado'));
    });

    // ── Que nada de esto toca la API de outfits ──────────────────────────────

    test('las rutas de outfits siguen intactas y sin parser de body', async () => {
        responde([]);
        const outfitAuth = { 'x-api-key': OUTFIT };

        const metrics = await request(port, 'GET', '/v1/metrics', { headers: outfitAuth });
        assert.strictEqual(metrics.status, 200, '/v1 sigue funcionando con su propia key');

        const validacion = await request(port, 'GET', '/v1/users/abc/outfits', { headers: outfitAuth });
        assert.strictEqual(validacion.status, 400);
        assert.strictEqual(validacion.body.error.code, 'invalid_request');

        // Un POST con cuerpo contra /v1 no encuentra ruta: la administracion no
        // le ha añadido superficie de escritura a la API del juego.
        const escritura = await request(port, 'POST', '/v1/users', {
            headers: jsonHeaders(outfitAuth),
            body: { groupId: GROUP_ID },
        });
        assert.strictEqual(escritura.status, 404);
        assert.strictEqual(escritura.body.error.code, 'route_not_found');

        assert.strictEqual(calls.length, 0, 'la API de outfits no consulta la base para nada');
    });

    test('/admin tambien esta detras del limitador por IP', async () => {
        // Importa: es lo que impide que alguien pruebe claves de admin a
        // ritmo de miles por minuto contra este endpoint.
        responde([fila()]);
        ownRateLimit.reset();
        const { maxPerWindow } = ownRateLimit.getMetrics();

        for (let i = 0; i < maxPerWindow; i++) {
            const res = await request(port, 'GET', `/admin/groups/${GROUP_ID}`, { headers: admin, sinReset: true });
            assert.strictEqual(res.status, 200, `la peticion ${i + 1} debia pasar`);
        }

        const res = await request(port, 'GET', `/admin/groups/${GROUP_ID}`, { headers: admin, sinReset: true });
        assert.strictEqual(res.status, 429);
        assert.strictEqual(res.body.error.code, 'rate_limited');
        ownRateLimit.reset();
    });

    test('una ruta administrativa inexistente -> 404 route_not_found', async () => {
        responde([]);
        const res = await request(port, 'GET', '/admin/no-existe', { headers: admin });
        assert.strictEqual(res.status, 404);
        assert.strictEqual(res.body.error.code, 'route_not_found');
    });

    const ok = await suite.run();

    db.query = queryOriginal;
    // El limitador es por IP y todos los tests corren desde 127.0.0.1: sin
    // esto, las peticiones gastadas aqui contarian en el cubo de app.test.js.
    ownRateLimit.reset();
    await new Promise(resolve => server.close(resolve));
    return ok;
};
