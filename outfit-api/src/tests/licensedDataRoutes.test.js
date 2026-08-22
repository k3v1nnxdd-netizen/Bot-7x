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

// LAS TRES RUTAS DE DATOS QUE CONSUME EL JUEGO, con UNA sola credencial:
//
//   GET /v1/users/by-username/{username}
//   GET /v1/users/{userId}/outfits
//   GET /v1/outfits/{outfitId}
//
// El comprador configura un unico Secret en su experiencia
// (`OutfitLicenseToken`) y con el llama a todo. Ya no hay `x-api-key` que
// repartir, que es media razon de este cambio: esa clave era la MISMA para
// todos los clientes, no identificaba a nadie y no se podia revocar sin
// romperle el juego a todos a la vez.
//
// Lo que se comprueba aqui es la PUERTA, no la validacion de parametros (que
// tiene su sitio en app.test.js) ni la cadena completa de autorizacion (que
// esta en licenseVerify.test.js). Concretamente: que las tres abren con un
// token vivo y sin la clave del juego, y que se cierran ante un token ausente,
// invalido, viejo o de una licencia desactivada — sin filtrar el secreto por
// ningun lado.

const GROUP_ID = '35216530';

const RUTAS = [
    ['/v1/users/by-username/builderman', 'username -> userId'],
    ['/v1/users/156/outfits', 'listado de outfits'],
    ['/v1/outfits/11685920016', 'detalle de outfit'],
];

function request(port, path, { headers = {}, sinReset = false } = {}) {
    if (!sinReset) ownRateLimit.reset();
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let body = null;
                try { body = JSON.parse(data); } catch { /* respuesta no-JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, body, raw: data });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

module.exports = async function run() {
    const suite = createSuite('licensedDataRoutes');
    const { test, assert } = suite;

    const OUTFIT = config.apiKey;
    const ADMIN = config.adminApiKey;

    const TOKEN = licenseToken.generateToken();
    const HASH = crypto.createHash('sha256').update(TOKEN, 'utf8').digest('hex');
    const TOKEN_VIEJO = licenseToken.generateToken();   // el de antes de una rotacion

    // ── Doble de la base ─────────────────────────────────────────────────────
    const queryOriginal = db.query;
    let calls = [];
    let fila = null;

    db.query = async (text, params = []) => {
        calls.push({ text, params });
        // Busqueda por hash: solo responde si el hash coincide, que es
        // exactamente lo que hace el indice unico en Postgres. Asi un token
        // viejo (cuyo hash ya no esta en la fila) no encuentra nada.
        const encontrada = fila && fila.license_token_hash === params[0] ? fila : null;
        return { rows: encontrada ? [encontrada] : [], rowCount: encontrada ? 1 : 0 };
    };

    const licenciaViva = (overrides = {}) => {
        calls = [];
        fila = { group_id: GROUP_ID, active: true, license_token_hash: HASH, ...overrides };
    };

    // ── Doble de Roblox ──────────────────────────────────────────────────────
    // Estas rutas SI llaman a Roblox cuando la peticion es valida, asi que se
    // sustituyen las tres llamadas. Lo que se mide aqui es la puerta; que
    // Roblox conteste bien ya lo cubren pagination.test.js y los suyos.
    const originales = {
        lookupUserByUsername: roblox.lookupUserByUsername,
        listOutfits: roblox.listOutfits,
        getOutfitDetailsRaw: roblox.getOutfitDetailsRaw,
    };
    let llamadasARoblox = 0;

    roblox.lookupUserByUsername = async () => {
        llamadasARoblox++;
        return { userId: 156, username: 'builderman', displayName: 'builderman' };
    };
    roblox.listOutfits = async () => {
        llamadasARoblox++;
        return { outfits: [], nextPageToken: null, hasMore: false };
    };
    roblox.getOutfitDetailsRaw = async () => {
        llamadasARoblox++;
        return { id: 11685920016, name: 'Check It', assets: [], playerAvatarType: 'R15' };
    };

    const conToken = (token = TOKEN) => ({ 'x-license-token': token });

    const app = createApp();
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;

    const limpio = () => { licenciaViva(); cache.reset(); llamadasARoblox = 0; };

    // ═══ 1. Las tres abren con el token y SIN x-api-key ══════════════════════

    test('las tres rutas funcionan con x-license-token y sin x-api-key', async () => {
        for (const [ruta, que] of RUTAS) {
            limpio();
            const res = await request(port, ruta, { headers: conToken() });

            assert.strictEqual(res.status, 200, `${que} deberia funcionar solo con el token`);
            assert.ok(res.body && typeof res.body === 'object', `${que} devuelve datos`);
        }
    });

    test('cada peticion cuesta UNA consulta de licencia, ni una mas', async () => {
        limpio();
        await request(port, RUTAS[0][0], { headers: conToken() });

        assert.strictEqual(calls.length, 1, 'una sola consulta: la del token');
        assert.match(calls[0].text, /WHERE license_token_hash = \$1/i);
        assert.deepStrictEqual(calls[0].params, [HASH], 'a la base va el hash, jamas el token');
        assert.ok(!calls[0].text.includes(TOKEN), 'ni dentro del texto de la consulta');
    });

    test('una x-api-key incorrecta da igual: esas rutas ya no la miran', async () => {
        limpio();
        const res = await request(port, RUTAS[0][0], {
            headers: { ...conToken(), 'x-api-key': 'una-clave-cualquiera' },
        });
        assert.strictEqual(res.status, 200);
    });

    // ═══ 2. Token ausente ═══════════════════════════════════════════════════

    test('sin x-license-token -> 400 y sin tocar la base ni Roblox', async () => {
        for (const [ruta, que] of RUTAS) {
            limpio();
            const res = await request(port, ruta);

            assert.strictEqual(res.status, 400, `${que} sin token debe rechazarse`);
            assert.match(res.body.error.message, /x-license-token/);
            assert.strictEqual(calls.length, 0, 'ni una consulta a la base');
            assert.strictEqual(llamadasARoblox, 0, 'ni una llamada a Roblox');
        }
    });

    test('la vieja x-api-key ya NO abre estas rutas', async () => {
        // Es la mitad del cambio: el comprador deja de necesitarla.
        for (const [ruta, que] of RUTAS) {
            limpio();
            const res = await request(port, ruta, { headers: { 'x-api-key': OUTFIT } });

            assert.strictEqual(res.status, 400, `${que} no puede abrirse con la clave compartida`);
            assert.strictEqual(llamadasARoblox, 0);
        }
    });

    // ═══ 3. Token invalido o viejo ══════════════════════════════════════════

    test('token inventado o mal formado -> 403 token_invalido', async () => {
        const malos = [licenseToken.generateToken(), 'no-es-un-token', '7xl_corto', 'x'.repeat(200)];

        for (const malo of malos) {
            limpio();
            const res = await request(port, RUTAS[0][0], { headers: conToken(malo) });

            assert.strictEqual(res.status, 403, `"${malo.slice(0, 12)}" deberia denegar`);
            assert.deepStrictEqual(res.body, { ok: false, motivo: 'token_invalido' });
            assert.strictEqual(llamadasARoblox, 0, 'sin credencial valida no se gasta cuota de Roblox');
        }
    });

    test('un token VIEJO (rotado) deja de abrir las tres rutas', async () => {
        // La fila tiene el hash del token NUEVO. El viejo ya no esta en ninguna
        // fila, asi que muere solo: no hace falta lista de revocacion.
        for (const [ruta, que] of RUTAS) {
            limpio();
            const res = await request(port, ruta, { headers: conToken(TOKEN_VIEJO) });

            assert.strictEqual(res.status, 403, `${que} debe cerrarse al token rotado`);
            assert.strictEqual(res.body.motivo, 'token_invalido');
        }

        // Y el nuevo sigue abriendo.
        limpio();
        assert.strictEqual((await request(port, RUTAS[0][0], { headers: conToken() })).status, 200);
    });

    // ═══ 4. Licencia desactivada ════════════════════════════════════════════

    test('licencia desactivada -> 403 licencia_inactiva en las tres', async () => {
        for (const [ruta, que] of RUTAS) {
            limpio();
            licenciaViva({ active: false });
            const res = await request(port, ruta, { headers: conToken() });

            assert.strictEqual(res.status, 403, `${que} debe cerrarse a una licencia retirada`);
            assert.deepStrictEqual(res.body, { ok: false, motivo: 'licencia_inactiva' });
            assert.strictEqual(llamadasARoblox, 0, 'una licencia retirada no gasta cuota de Roblox');
        }
    });

    test('la denegacion distingue token invalido de licencia inactiva', async () => {
        // Manda a mirar a sitios distintos: uno es "revisa tu token", el otro
        // "habla con nosotros, te la hemos retirado".
        limpio();
        const invalido = await request(port, RUTAS[0][0], { headers: conToken(TOKEN_VIEJO) });
        limpio(); licenciaViva({ active: false });
        const inactiva = await request(port, RUTAS[0][0], { headers: conToken() });

        assert.notStrictEqual(invalido.body.motivo, inactiva.body.motivo);
    });

    // ═══ 5. Ni el token ni su hash se filtran ═══════════════════════════════

    test('el token no aparece en ninguna respuesta, concedida o denegada', async () => {
        const respuestas = [];
        for (const [ruta] of RUTAS) {
            limpio();
            respuestas.push(await request(port, ruta, { headers: conToken() }));
            limpio();
            respuestas.push(await request(port, ruta, { headers: conToken(TOKEN_VIEJO) }));
            limpio();
            respuestas.push(await request(port, ruta));
        }

        for (const res of respuestas) {
            const todo = res.raw + JSON.stringify(res.headers);
            assert.ok(!todo.includes(TOKEN), 'el token no puede salir en cuerpo ni cabeceras');
            assert.ok(!todo.includes(HASH), 'ni su hash');
            assert.ok(!todo.includes(TOKEN_VIEJO), 'ni el que se mando y fue rechazado');
        }
    });

    test('el token no llega al log de la peticion', async () => {
        // El requestLogger si registra la URL y varios campos; el token viaja
        // por cabecera justamente para que no acabe en ninguno de los dos.
        const logger = require('../observability/logger');
        const originalesLog = { info: logger.info, warn: logger.warn, error: logger.error };
        const registrado = [];
        for (const nivel of ['info', 'warn', 'error']) {
            logger[nivel] = (mensaje, datos) => registrado.push({ nivel, mensaje, datos });
        }

        try {
            limpio();
            await request(port, RUTAS[0][0], { headers: conToken() });
            limpio();
            await request(port, RUTAS[1][0], { headers: conToken(TOKEN_VIEJO) });
        } finally {
            Object.assign(logger, originalesLog);
        }

        const volcado = JSON.stringify(registrado);
        assert.ok(registrado.length > 0, 'las peticiones dejan rastro (la comprobacion no es vacua)');
        assert.ok(!volcado.includes(TOKEN), 'EL TOKEN NO PUEDE ACABAR EN EL LOG');
        assert.ok(!volcado.includes(HASH), 'ni su hash');
        assert.ok(!volcado.includes(TOKEN_VIEJO));
    });

    // ═══ 6. /admin sigue intacto ════════════════════════════════════════════

    test('/admin NO acepta tokens de licencia', async () => {
        limpio();
        const comoAdminKey = await request(port, '/admin/groups', { headers: { 'x-admin-key': TOKEN } });
        assert.strictEqual(comoAdminKey.status, 401, 'un token de licencia no es la clave de administracion');

        const comoLicencia = await request(port, '/admin/groups', { headers: conToken() });
        assert.strictEqual(comoLicencia.status, 401, 'ni presentado en su propia cabecera');

        assert.strictEqual(calls.length, 0, 'y no llega a costar una consulta');
    });

    test('/admin sigue abriendose con su clave, y esta no abre las rutas de datos', async () => {
        limpio();
        const admin = await request(port, `/admin/groups/${GROUP_ID}`, { headers: { 'x-admin-key': ADMIN } });
        assert.strictEqual(admin.status, 200, '/admin funciona igual que siempre');

        limpio();
        const datos = await request(port, RUTAS[0][0], { headers: { 'x-admin-key': ADMIN } });
        assert.strictEqual(datos.status, 400, 'la clave de administracion no abre las rutas del juego');
    });

    // ═══ 7. Lo que no se toca ═══════════════════════════════════════════════

    test('/v1/metrics NO se migra: sigue con x-api-key', async () => {
        // Es observabilidad nuestra — percentiles, estado del breaker,
        // contadores de la base. Un cliente con licencia no tiene por que verla.
        limpio();
        const conLicencia = await request(port, '/v1/metrics', { headers: conToken() });
        assert.strictEqual(conLicencia.status, 401, 'un token de licencia no abre las metricas');

        const conKey = await request(port, '/v1/metrics', { headers: { 'x-api-key': OUTFIT } });
        assert.strictEqual(conKey.status, 200, 'y la clave del servicio si');
    });

    test('el limitador por IP sigue delante', async () => {
        limpio();
        ownRateLimit.reset();
        const { maxPerWindow } = ownRateLimit.getMetrics();

        for (let i = 0; i < maxPerWindow; i++) {
            const res = await request(port, RUTAS[0][0], { headers: conToken(), sinReset: true });
            assert.strictEqual(res.status, 200, `la peticion ${i + 1} debia pasar`);
        }

        const res = await request(port, RUTAS[0][0], { headers: conToken(), sinReset: true });
        assert.strictEqual(res.status, 429, 'el limitador no depende de la credencial');
        ownRateLimit.reset();
    });

    test('la cache sigue funcionando: el segundo jugador no gasta Roblox', async () => {
        limpio();
        await request(port, RUTAS[0][0], { headers: conToken() });
        const tras1 = llamadasARoblox;

        await request(port, RUTAS[0][0], { headers: conToken() });
        assert.strictEqual(tras1, 1, 'la primera resuelve contra Roblox');
        assert.strictEqual(llamadasARoblox, 1, 'la segunda sale de cache');

        // La licencia SI se comprueba en las dos: la cache es de datos de
        // Roblox, no de la autorizacion.
        assert.strictEqual(calls.length, 2, 'pero la licencia se comprueba en cada peticion');
    });

    test('la validacion de parametros sigue viva detras de la puerta', async () => {
        limpio();
        const res = await request(port, '/v1/users/abc/outfits', { headers: conToken() });

        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.error.code, 'invalid_request');
        assert.strictEqual(llamadasARoblox, 0, 'un parametro invalido no gasta cuota de Roblox');
    });

    test('base caida -> 503, no una denegacion', async () => {
        // Un fallo de Postgres no puede convertirse en "tu token no vale": eso
        // echaria a todos los clientes legitimos de golpe.
        const anterior = db.query;
        db.query = async () => { const e = new Error('fallo simulado'); e.code = 'ECONNREFUSED'; throw e; };

        let res;
        try {
            await captureStdout(async () => { res = await request(port, RUTAS[0][0], { headers: conToken() }); });
        } finally {
            db.query = anterior;
        }

        assert.strictEqual(res.status, 503);
        assert.strictEqual(res.body.error.code, 'database_unavailable');
        assert.ok(!res.raw.includes(TOKEN));
    });

    const ok = await suite.run();

    db.query = queryOriginal;
    Object.assign(roblox, originales);
    cache.reset();
    ownRateLimit.reset();
    await new Promise(resolve => server.close(resolve));
    return ok;
};
