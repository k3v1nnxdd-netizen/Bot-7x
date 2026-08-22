'use strict';

const http = require('http');
const crypto = require('crypto');
const { createSuite, captureStdout } = require('./harness');
const { createApp } = require('../app');
const config = require('../config');
const ownRateLimit = require('../security/rateLimit');
const db = require('../db/pool');
const roblox = require('../roblox/client');
const cache = require('../cache/cacheStore');
const licenseToken = require('../security/licenseToken');

// Rotacion de la credencial: POST /admin/groups/:groupId/token.
//
// Es la unica operacion del sistema que INVALIDA algo que un cliente esta
// usando ahora mismo. Si se ejecuta sobre el grupo equivocado, alguien se queda
// fuera de su propio juego sin aviso y sin forma de saber por que. De ahi que
// exija confirmar los dos datos del comprador, y de ahi que estos tests miren
// sobre todo lo que NO debe pasar.
//
// Lo que se protege aqui:
//   1. El token anterior queda invalido EN EL ACTO, y el nuevo funciona.
//   2. Una confirmacion que no cuadra no toca la fila: ni el hash, ni nada.
//   3. La rotacion no reescribe la historia de la licencia (fechas, comprador,
//      quien la dio de alta).
//   4. Ningun secreto sale por respuesta, log o error.

const GROUP_ID = '35216530';
const DISCORD_ID = '996310284803248158';
const ROBLOX_USER = 'CompradorRblx';
const ADMIN_ID = '346085763638886400';
const CREATED_AT = new Date('2026-01-15T10:30:00.000Z');
const LINKED_AT = new Date('2026-02-01T09:00:00.000Z');

function request(port, method, path, { headers = {}, body, raw } = {}) {
    ownRateLimit.reset();
    const payload = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, method, headers }, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch { /* no-JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: data });
            });
        });
        req.on('error', reject);
        if (payload !== null) req.write(payload);
        req.end();
    });
}

module.exports = async function run() {
    const suite = createSuite('tokenRegeneration');
    const { test, assert } = suite;

    const ADMIN = config.adminApiKey;
    const OUTFIT = config.apiKey;
    const admin = { 'content-type': 'application/json', 'x-admin-key': ADMIN };
    const juego = { 'content-type': 'application/json', 'x-api-key': OUTFIT };

    // ── Base de datos de mentira, pero con estado REAL ───────────────────────
    // Aqui no vale un doble que devuelva filas fijas: media suite comprueba que
    // el hash cambia, que el anterior deja de existir y que el resto de columnas
    // NO se tocan. Eso exige una fila que de verdad se actualice.
    const queryOriginal = db.query;
    let fila = null;
    let consultas = [];

    db.query = async (text, params = []) => {
        const sql = text.replace(/\s+/g, ' ').trim();
        consultas.push({ text: sql, params });

        // UPDATE de rotacion: el WHERE lleva la confirmacion.
        if (/^UPDATE group_whitelist SET license_token_hash/i.test(sql)) {
            const [groupId, discordUserId, robloxUsername, nuevoHash] = params;
            if (!fila || fila.group_id !== groupId) return { rows: [], rowCount: 0 };
            if (fila.discord_user_id !== discordUserId || fila.roblox_username !== robloxUsername) {
                return { rows: [], rowCount: 0 };
            }
            fila.license_token_hash = nuevoHash;
            return { rows: [{ ...fila }], rowCount: 1 };
        }

        // Busqueda por hash (la que usa /v1/license/verify).
        if (sql.includes('WHERE license_token_hash =')) {
            const encontrada = fila && fila.license_token_hash === params[0] ? fila : null;
            return { rows: encontrada ? [{ ...encontrada }] : [], rowCount: encontrada ? 1 : 0 };
        }

        // Listado paginado (funcion de ventana).
        if (/count\(\*\) OVER/i.test(sql)) {
            const filas = fila ? [{ ...fila, total: 1 }] : [];
            return { rows: filas, rowCount: filas.length };
        }

        // SELECT por group_id (el que desempata el motivo del fallo).
        if (/^SELECT .* FROM group_whitelist WHERE group_id/i.test(sql)) {
            const encontrada = fila && fila.group_id === params[0] ? fila : null;
            return { rows: encontrada ? [{ ...encontrada }] : [], rowCount: encontrada ? 1 : 0 };
        }

        throw new Error(`consulta no contemplada: ${sql.slice(0, 70)}`);
    };

    let TOKEN_ORIGINAL;
    function montarLicencia(overrides = {}) {
        TOKEN_ORIGINAL = licenseToken.generateToken();
        consultas = [];
        cache.reset();
        fila = {
            group_id: GROUP_ID,
            active: true,
            created_at: CREATED_AT,
            linked_at: LINKED_AT,
            discord_user_id: DISCORD_ID,
            roblox_username: ROBLOX_USER,
            group_name: 'Mi Grupo',
            added_by: ADMIN_ID,
            deactivated_at: null,
            deactivated_by: null,
            deactivation_reason: null,
            license_token_hash: licenseToken.hashToken(TOKEN_ORIGINAL),
            ...overrides,
        };
    }

    // Roblox, para poder verificar con el token nuevo de punta a punta.
    const universoOriginal = roblox.getUniverseIdForPlace;
    const dueñoOriginal = roblox.getUniverseOwner;
    roblox.getUniverseIdForPlace = async () => '5432109876';
    roblox.getUniverseOwner = async universeId => ({
        universeId, rootPlaceId: '1234567890', name: 'Juego',
        creatorType: 'Group', creatorId: GROUP_ID, creatorName: 'x',
    });

    const rotar = (port, body, headers = admin) =>
        request(port, 'POST', `/admin/groups/${GROUP_ID}/token`, { headers, body });

    const confirmacion = (extra = {}) => ({
        discordUserId: DISCORD_ID, robloxUsername: ROBLOX_USER, ...extra,
    });

    const verificar = (port, token) => request(port, 'POST', '/v1/license/verify', {
        headers: juego,
        body: { token, gameId: '5432109876', placeId: '1234567890' },
    });

    const app = createApp();
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;

    // ═══ 1. El token nuevo vale y el anterior deja de valer ══════════════════

    test('el token ANTERIOR queda invalido en el acto', async () => {
        montarLicencia();

        // Antes de rotar, el original autoriza.
        const antes = await verificar(port, TOKEN_ORIGINAL);
        assert.strictEqual(antes.status, 200, 'el token original funcionaba');
        assert.strictEqual(antes.body.ok, true);

        const rotacion = await rotar(port, confirmacion());
        assert.strictEqual(rotacion.status, 200);

        // Y despues, ya no. No hace falta ninguna lista de revocacion: la
        // busqueda es por hash y ese hash ya no esta en ninguna fila.
        const despues = await verificar(port, TOKEN_ORIGINAL);
        assert.strictEqual(despues.status, 403, 'el token viejo tiene que morir en el acto');
        assert.deepStrictEqual(despues.body, { ok: false, motivo: 'token_invalido' });
    });

    test('el token NUEVO funciona', async () => {
        montarLicencia();
        const rotacion = await rotar(port, confirmacion());

        assert.match(rotacion.body.token, /^7xl_[A-Za-z0-9_-]{43}$/, 'es un token con la forma de siempre');
        assert.strictEqual(rotacion.body.tokenIssued, true);

        const res = await verificar(port, rotacion.body.token);
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body, { ok: true, groupId: GROUP_ID });
    });

    test('a la base va el SHA-256 del token nuevo, y sustituye al anterior', async () => {
        montarLicencia();
        const hashPrevio = fila.license_token_hash;

        const rotacion = await rotar(port, confirmacion());
        const update = consultas.find(c => /^UPDATE group_whitelist SET license_token_hash/i.test(c.text));

        assert.ok(update, 'la rotacion es un UPDATE');
        assert.strictEqual(update.params[3], crypto.createHash('sha256').update(rotacion.body.token).digest('hex'));
        assert.ok(!update.params.includes(rotacion.body.token), 'el token en claro no viaja a la base');
        assert.ok(!update.text.includes(rotacion.body.token), 'ni dentro del texto de la consulta');
        assert.notStrictEqual(fila.license_token_hash, hashPrevio, 'el hash guardado ha cambiado');
    });

    test('rotar dos veces seguidas da tokens distintos y solo vale el ultimo', async () => {
        montarLicencia();
        const primera = (await rotar(port, confirmacion())).body.token;
        const segunda = (await rotar(port, confirmacion())).body.token;

        assert.notStrictEqual(primera, segunda);
        assert.strictEqual((await verificar(port, primera)).status, 403, 'la credencial intermedia tambien muere');
        assert.strictEqual((await verificar(port, segunda)).status, 200);
    });

    // ═══ 2. La rotacion NO reescribe la licencia ═════════════════════════════

    test('la rotacion no toca fechas, comprador ni historial', async () => {
        montarLicencia();
        const antes = { ...fila };

        const res = await rotar(port, confirmacion());

        assert.strictEqual(res.body.createdAt, CREATED_AT.toISOString(), 'el alta original se conserva');
        assert.strictEqual(res.body.linkedAt, LINKED_AT.toISOString(), 'la fecha de enlace tampoco cambia');
        assert.strictEqual(res.body.discordUserId, DISCORD_ID);
        assert.strictEqual(res.body.robloxUsername, ROBLOX_USER);
        assert.strictEqual(res.body.groupName, 'Mi Grupo');
        assert.strictEqual(res.body.addedBy, ADMIN_ID);

        // Y en la fila, campo por campo: lo unico distinto es el hash.
        for (const columna of Object.keys(antes)) {
            if (columna === 'license_token_hash') continue;
            assert.deepStrictEqual(fila[columna], antes[columna], `la rotacion cambio ${columna}`);
        }

        // Solo el tramo ENTRE `SET` y `WHERE`: el RETURNING nombra casi todas
        // las columnas y haria pasar la comprobacion por cualquier cosa.
        const update = consultas.find(c => /^UPDATE group_whitelist SET/i.test(c.text));
        const asignaciones = update.text.slice(update.text.indexOf('SET') + 3, update.text.indexOf('WHERE'));
        assert.match(asignaciones.trim(), /^license_token_hash = \$4$/i,
            'el SET solo puede tocar license_token_hash');
    });

    test('los datos de confirmacion van en el WHERE, no en el SET', async () => {
        montarLicencia();
        await rotar(port, confirmacion());

        const update = consultas.find(c => /^UPDATE group_whitelist SET/i.test(c.text));
        assert.match(update.text, /WHERE group_id = \$1 AND discord_user_id = \$2 AND roblox_username = \$3/i);
        assert.deepStrictEqual(update.params.slice(0, 3), [GROUP_ID, DISCORD_ID, ROBLOX_USER]);
        assert.strictEqual(consultas.filter(c => /^UPDATE/i.test(c.text)).length, 1,
            'una sola sentencia: la comprobacion y la escritura son atomicas');
    });

    // ═══ 3. Confirmacion que no cuadra: no se toca NADA ══════════════════════

    test('Discord incorrecto -> 409 y el token anterior SIGUE valido', async () => {
        montarLicencia();
        const hashPrevio = fila.license_token_hash;

        const res = await rotar(port, confirmacion({ discordUserId: '111111111111111111' }));

        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.body.error.code, 'confirmation_mismatch');
        assert.deepStrictEqual(res.body.error.campos, ['discord']);
        assert.match(res.body.error.message, /Discord/);

        assert.strictEqual(fila.license_token_hash, hashPrevio, 'no se ha rotado nada');
        assert.strictEqual((await verificar(port, TOKEN_ORIGINAL)).status, 200,
            'el cliente sigue jugando con su token de siempre');
    });

    test('Roblox incorrecto -> 409 y el token anterior SIGUE valido', async () => {
        montarLicencia();
        const hashPrevio = fila.license_token_hash;

        const res = await rotar(port, confirmacion({ robloxUsername: 'OtroUsuario' }));

        assert.strictEqual(res.status, 409);
        assert.deepStrictEqual(res.body.error.campos, ['roblox']);
        assert.match(res.body.error.message, /Roblox/);
        assert.strictEqual(fila.license_token_hash, hashPrevio);
        assert.strictEqual((await verificar(port, TOKEN_ORIGINAL)).status, 200);
    });

    test('los dos incorrectos -> 409 diciendo que fallan los dos', async () => {
        montarLicencia();
        const res = await rotar(port, confirmacion({
            discordUserId: '111111111111111111', robloxUsername: 'OtroUsuario',
        }));

        assert.strictEqual(res.status, 409);
        assert.deepStrictEqual(res.body.error.campos.sort(), ['discord', 'roblox']);
    });

    test('el error de confirmacion NO revela los datos guardados', async () => {
        montarLicencia();
        const res = await rotar(port, confirmacion({ robloxUsername: 'OtroUsuario' }));

        // Quien llama ya tiene la clave de administracion y podria consultarlos,
        // asi que no es un agujero — pero un mensaje de error no es sitio para
        // sacar los datos de un cliente.
        assert.ok(!res.raw.includes(ROBLOX_USER), 'no se filtra el usuario de Roblox guardado');
        assert.ok(!res.raw.includes(DISCORD_ID), 'ni el id de Discord guardado');
    });

    test('una licencia sin comprador enlazado no se puede confirmar', async () => {
        // Las licencias anteriores al sistema de metadatos tienen NULL: no hay
        // nada contra lo que confirmar, asi que no se rota a ciegas.
        montarLicencia({ discord_user_id: null, roblox_username: null });
        const res = await rotar(port, confirmacion());

        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.body.error.code, 'confirmation_mismatch');
        assert.strictEqual(fila.license_token_hash, licenseToken.hashToken(TOKEN_ORIGINAL), 'sin tocar');
    });

    // ═══ 4. Grupo inexistente ═══════════════════════════════════════════════

    test('grupo que no esta en la whitelist -> 404 group_not_found', async () => {
        montarLicencia();
        const res = await request(port, 'POST', '/admin/groups/999000000000000001/token', {
            headers: admin, body: confirmacion(),
        });

        assert.strictEqual(res.status, 404);
        assert.strictEqual(res.body.error.code, 'group_not_found');
        // Importa distinguirlo del 409: manda a mirar a un sitio distinto.
        assert.notStrictEqual(res.body.error.code, 'confirmation_mismatch');
    });

    test('groupId invalido -> 400 sin tocar la base', async () => {
        for (const malo of ['abc', '0', '007']) {
            montarLicencia();
            const res = await request(port, 'POST', `/admin/groups/${malo}/token`, {
                headers: admin, body: confirmacion(),
            });
            assert.strictEqual(res.status, 400, `${malo} deberia dar 400`);
            assert.strictEqual(consultas.length, 0, 'ni una consulta con un id invalido');
        }
    });

    test('confirmacion ausente o mal formada -> 400 sin tocar la base', async () => {
        const casos = [
            { body: {}, motivo: 'cuerpo vacio' },
            { body: { robloxUsername: ROBLOX_USER }, motivo: 'sin discordUserId' },
            { body: { discordUserId: DISCORD_ID }, motivo: 'sin robloxUsername' },
            { body: confirmacion({ discordUserId: 'no-es-un-id' }), motivo: 'discord no numerico' },
            { body: confirmacion({ robloxUsername: 'ab' }), motivo: 'roblox demasiado corto' },
            { body: [], motivo: 'el cuerpo no es un objeto' },
        ];

        for (const { body, motivo } of casos) {
            montarLicencia();
            const res = await rotar(port, body);
            assert.strictEqual(res.status, 400, `deberia rechazar: ${motivo}`);
            assert.strictEqual(res.body.error.code, 'invalid_request');
            assert.strictEqual(consultas.length, 0, `sin tocar la base (${motivo})`);
        }
    });

    test('sin Content-Type json -> 400, no 500', async () => {
        montarLicencia();
        const res = await request(port, 'POST', `/admin/groups/${GROUP_ID}/token`, {
            headers: { 'x-admin-key': ADMIN }, raw: JSON.stringify(confirmacion()),
        });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(consultas.length, 0);
    });

    // ═══ 5. Solo la clave de administracion ═════════════════════════════════

    test('sin x-admin-key -> 401 y ni una consulta', async () => {
        montarLicencia();
        const res = await rotar(port, confirmacion(), { 'content-type': 'application/json' });

        assert.strictEqual(res.status, 401);
        assert.strictEqual(consultas.length, 0);
    });

    test('la clave del JUEGO no puede rotar credenciales', async () => {
        // Es la separacion que sostiene todo: OUTFIT_API_KEY viaja dentro del
        // .rbxl, asi que si abriera esto cualquiera con una copia podria
        // invalidarle la licencia a otro cliente.
        montarLicencia();
        const res = await rotar(port, confirmacion(), { 'content-type': 'application/json', 'x-api-key': OUTFIT });

        assert.strictEqual(res.status, 401);
        assert.strictEqual(consultas.length, 0);
    });

    // ═══ 6. Filtracion de secretos ══════════════════════════════════════════

    test('el token nuevo NO aparece en el log', async () => {
        const logger = require('../observability/logger');
        const originales = { info: logger.info, warn: logger.warn, error: logger.error };
        const registrado = [];
        logger.info = (m, d) => registrado.push({ m, d });
        logger.warn = (m, d) => registrado.push({ m, d });
        logger.error = (m, d) => registrado.push({ m, d });

        let res;
        try {
            montarLicencia();
            res = await rotar(port, confirmacion());
            await rotar(port, confirmacion({ robloxUsername: 'OtroUsuario' })); // camino de error
        } finally {
            Object.assign(logger, originales);
        }

        const volcado = JSON.stringify(registrado);
        assert.ok(!volcado.includes(res.body.token), 'EL TOKEN NUEVO NO PUEDE ACABAR EN EL LOG');
        assert.ok(!volcado.includes(crypto.createHash('sha256').update(res.body.token).digest('hex')),
            'ni su hash');
        assert.ok(!volcado.includes(ADMIN), 'ni la clave de administracion');
    });

    test('ni el token ni el hash salen por ninguna otra ruta', async () => {
        montarLicencia();
        const rotacion = await rotar(port, confirmacion());
        const nuevoToken = rotacion.body.token;
        const nuevoHash = crypto.createHash('sha256').update(nuevoToken).digest('hex');

        const otras = await Promise.all([
            request(port, 'GET', `/admin/groups/${GROUP_ID}`, { headers: admin }),
            request(port, 'GET', '/admin/groups?includeInactive=1', { headers: admin }),
            verificar(port, nuevoToken),
        ]);

        for (const res of otras) {
            assert.ok(!res.raw.includes(nuevoToken), 'el token solo existe en la respuesta de la rotacion');
            assert.ok(!res.raw.includes(nuevoHash), 'y su hash no sale nunca');
            assert.ok(!res.raw.includes('license_token_hash'), 'ni el nombre de la columna');
        }
    });

    test('la clave de administracion no aparece en ninguna respuesta', async () => {
        montarLicencia();
        const respuestas = [
            await rotar(port, confirmacion()),
            await rotar(port, confirmacion({ discordUserId: '111111111111111111' })),
            await rotar(port, confirmacion(), { 'content-type': 'application/json', 'x-admin-key': 'mala' }),
        ];
        for (const res of respuestas) {
            assert.ok(!(res.raw + JSON.stringify(res.headers)).includes(ADMIN));
        }
    });

    test('un fallo de la base sale como 503 y sin detalles internos', async () => {
        montarLicencia();
        const anterior = db.query;
        db.query = async () => { const e = new Error('fallo simulado'); e.code = 'ECONNREFUSED'; throw e; };

        let res;
        try {
            await captureStdout(async () => { res = await rotar(port, confirmacion()); });
        } finally {
            db.query = anterior;
        }

        assert.strictEqual(res.status, 503);
        assert.strictEqual(res.body.error.code, 'database_unavailable');
        assert.ok(!res.raw.includes('fallo simulado'));
    });

    const ok = await suite.run();

    db.query = queryOriginal;
    roblox.getUniverseIdForPlace = universoOriginal;
    roblox.getUniverseOwner = dueñoOriginal;
    cache.reset();
    ownRateLimit.reset();
    await new Promise(resolve => server.close(resolve));
    return ok;
};
