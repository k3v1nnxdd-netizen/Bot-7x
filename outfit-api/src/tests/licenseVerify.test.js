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
const { UpstreamError, UpstreamRateLimitedError, NotFoundError } = require('../roblox/errors');

// Tests de POST /v1/license/verify por HTTP real, SIN base de datos y SIN
// Roblox: `db.query` y las dos llamadas de propiedad se sustituyen por dobles.
//
// EL TEST QUE JUSTIFICA ESTE ARCHIVO es el del cliente que miente. El comprador
// tiene el .rbxl y puede editar el script para mandar el `creatorId` que quiera;
// lo que se comprueba aqui es que dara igual, porque la propiedad de la
// experiencia no se lee del cuerpo de la peticion: se le pregunta a Roblox.
//
// Y el reverso, que es el que de verdad protege el negocio: un juego que NO es
// del grupo con licencia sigue siendo denegado aunque declare que si lo es.

const GROUP_ID = '35216530';        // el grupo con licencia
const OTRO_GRUPO = '77112233';      // un grupo cualquiera, sin licencia
const PLACE_ID = '1234567890';      // el place que dice el juego
const UNIVERSE_ID = '5432109876';   // el universo REAL de ese place, segun Roblox

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

module.exports = async function run() {
    const suite = createSuite('licenseVerify');
    const { test, assert } = suite;

    const OUTFIT = config.apiKey;
    const ADMIN = config.adminApiKey;
    // La UNICA credencial del juego es x-license-token, que añade verificar().
    // x-api-key ya no se manda: estas rutas no la miran.
    const juegoHeaders = { 'content-type': 'application/json' };

    const TOKEN = licenseToken.generateToken();
    const HASH = crypto.createHash('sha256').update(TOKEN, 'utf8').digest('hex');

    // ── Doble de la base ─────────────────────────────────────────────────────
    const queryOriginal = db.query;
    let calls = [];
    let responder = () => ({ rows: [], rowCount: 0 });

    db.query = async (text, params = []) => {
        calls.push({ text, params });
        return responder(text, params);
    };

    const licenciaEn = fila => {
        calls = [];
        responder = () => ({ rows: fila ? [fila] : [], rowCount: fila ? 1 : 0 });
    };

    const filaActiva = (overrides = {}) => ({
        group_id: GROUP_ID,
        active: true,
        license_token_hash: HASH,
        ...overrides,
    });

    // ── Doble de Roblox ──────────────────────────────────────────────────────
    // Sustituye las DOS llamadas reales. La cache se limpia en cada montaje:
    // la propiedad se cachea por placeId, y sin limpiarla un test se comeria
    // la respuesta del anterior.
    const universoOriginal = roblox.getUniverseIdForPlace;
    const dueñoOriginal = roblox.getUniverseOwner;
    let robloxCalls = [];

    // `duenio` = lo que Roblox dice que es la verdad. `fallo` = un error de la
    // capa saliente, para probar que un Roblox caido no deniega a nadie.
    function robloxDice({ universeId = UNIVERSE_ID, duenio = { type: 'Group', id: GROUP_ID }, fallo = null, falloEnDueño = null } = {}) {
        cache.reset();
        robloxCalls = [];

        roblox.getUniverseIdForPlace = async placeId => {
            robloxCalls.push({ llamada: 'place->universe', placeId });
            if (fallo) throw fallo;
            return universeId;
        };

        roblox.getUniverseOwner = async universoPedido => {
            robloxCalls.push({ llamada: 'universe->owner', universeId: universoPedido });
            if (falloEnDueño) throw falloEnDueño;
            return {
                universeId: universoPedido,
                rootPlaceId: PLACE_ID,
                name: 'Juego de prueba',
                creatorType: duenio.type,
                creatorId: duenio.id,
                creatorName: 'Nombre del dueño',
            };
        };
    }

    // Lo que manda el juego. `creatorType`/`creatorId` son justamente lo que un
    // .rbxl editado puede falsificar, asi que por defecto van con el valor
    // honesto y cada test los retuerce a placer.
    // El token YA NO va en el cuerpo: viaja por la cabecera x-license-token,
    // porque un Secret de Roblox no se puede serializar con JSONEncode.
    const cuerpo = (overrides = {}) => ({
        creatorType: 'Group',
        creatorId: Number(GROUP_ID),
        gameId: Number(UNIVERSE_ID),
        placeId: Number(PLACE_ID),
        ...overrides,
    });

    // `token: null` = no se manda la cabecera. Cualquier otro valor se manda
    // tal cual, para poder probar tokens viejos, inventados o mal formados.
    const verificar = (port, body, { headers = juegoHeaders, token = TOKEN } = {}) =>
        request(port, 'POST', '/v1/license/verify', {
            headers: token === null ? headers : { ...headers, 'x-license-token': token },
            body,
        });

    const app = createApp();
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;

    // ═══ LO QUE MOTIVO ESTA RUTA: EL CLIENTE NO DEMUESTRA NADA ═══════════════

    test('un creatorId FALSIFICADO no consigue autorizar un juego ajeno', async () => {
        // La licencia es del grupo 35216530. El juego que llama pertenece DE
        // VERDAD a otro grupo, pero su script declara ser del grupo con
        // licencia. Es exactamente el ataque: editar el .rbxl y mentir.
        licenciaEn(filaActiva());
        robloxDice({ duenio: { type: 'Group', id: OTRO_GRUPO } });

        const res = await verificar(port, cuerpo({ creatorId: Number(GROUP_ID), creatorType: 'Group' }));

        assert.strictEqual(res.status, 403, 'mentir sobre el creatorId no puede autorizar nada');
        assert.deepStrictEqual(res.body, { ok: false, motivo: 'grupo_no_coincide' });
        assert.strictEqual(
            robloxCalls.length, 2,
            'la propiedad se resuelve preguntandole a Roblox, no leyendo el cuerpo'
        );
    });

    test('un creatorId falso TAMPOCO estropea una licencia legitima', async () => {
        // El reverso: el juego SI es del grupo con licencia, pero su script
        // declara otra cosa (mal configurado, o probando). Como el dato
        // declarado no decide, se autoriza igual.
        licenciaEn(filaActiva());
        robloxDice({ duenio: { type: 'Group', id: GROUP_ID } });

        const res = await verificar(port, cuerpo({ creatorId: 999999999, creatorType: 'User' }));

        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body, { ok: true, groupId: GROUP_ID });
    });

    test('la decision usa el universo que resuelve Roblox, no el gameId declarado', async () => {
        licenciaEn(filaActiva());
        robloxDice({ universeId: UNIVERSE_ID, duenio: { type: 'Group', id: GROUP_ID } });

        await verificar(port, cuerpo());

        // El segundo salto se hace con el universo que devolvio Roblox a partir
        // del place, NO con el gameId que venia en el JSON.
        const segunda = robloxCalls.find(c => c.llamada === 'universe->owner');
        assert.strictEqual(segunda.universeId, UNIVERSE_ID);
        assert.strictEqual(robloxCalls[0].llamada, 'place->universe', 'se parte SIEMPRE del placeId');
    });

    test('el creatorId declarado no llega a la comparacion ni siquiera si falta', async () => {
        // Sin creatorType/creatorId en el cuerpo, la verificacion funciona
        // igual: son informativos desde que la propiedad se comprueba.
        licenciaEn(filaActiva());
        robloxDice({ duenio: { type: 'Group', id: GROUP_ID } });

        const res = await verificar(port, { gameId: Number(UNIVERSE_ID), placeId: Number(PLACE_ID) });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.ok, true);
    });

    test('una declaracion falsa se registra como aviso, aunque la decision no cambie', async () => {
        const logger = require('../observability/logger');
        const infoOriginal = logger.info;
        const warnOriginal = logger.warn;
        const registrado = [];
        logger.info = (mensaje, datos) => registrado.push({ nivel: 'info', mensaje, datos });
        logger.warn = (mensaje, datos) => registrado.push({ nivel: 'warn', mensaje, datos });

        try {
            licenciaEn(filaActiva());
            robloxDice({ duenio: { type: 'Group', id: GROUP_ID } });
            await verificar(port, cuerpo({ creatorId: 999999999 }));
        } finally {
            logger.info = infoOriginal;
            logger.warn = warnOriginal;
        }

        const linea = registrado.find(l => l.nivel === 'warn');
        assert.ok(linea, 'un cliente que declara un dueño distinto del real merece un aviso');
        assert.match(linea.mensaje, /declaracion falsa/i);
        assert.strictEqual(linea.datos.dueñoRealId, GROUP_ID, 'el log guarda lo REAL...');
        assert.strictEqual(linea.datos.creatorIdDeclarado, '999999999', '...junto a lo declarado');
        assert.ok(!JSON.stringify(linea).includes(TOKEN), 'y sigue sin registrar el token');
    });

    // ═══ Coherencia entre placeId y gameId ═══════════════════════════════════

    test('si el placeId no pertenece al gameId declarado -> juego_no_coincide', async () => {
        licenciaEn(filaActiva());
        // Roblox dice que ese place vive en OTRO universo del declarado.
        robloxDice({ universeId: '111111111', duenio: { type: 'Group', id: GROUP_ID } });

        const res = await verificar(port, cuerpo({ gameId: Number(UNIVERSE_ID) }));

        assert.strictEqual(res.status, 403);
        assert.deepStrictEqual(res.body, { ok: false, motivo: 'juego_no_coincide' });
    });

    test('un place que Roblox no reconoce -> juego_desconocido', async () => {
        licenciaEn(filaActiva());
        robloxDice({ fallo: new NotFoundError('place_not_found', 'no existe') });

        const res = await verificar(port, cuerpo());

        assert.strictEqual(res.status, 403);
        assert.deepStrictEqual(res.body, { ok: false, motivo: 'juego_desconocido' });
    });

    // ═══ Roblox caido: 503, NUNCA una denegacion ═════════════════════════════

    test('Roblox caido -> 503 con Retry-After, NO un 403', async () => {
        // Es la regla que impide que un mal rato de Roblox eche a todos los
        // clientes legitimos de sus propios juegos. "No lo se ahora mismo" no
        // es lo mismo que "no eres el dueño".
        for (const fallo of [
            new UpstreamError('Roblox no responde', new Error('ECONNRESET')),
            new UpstreamRateLimitedError('Roblox nos limito', 12),
        ]) {
            licenciaEn(filaActiva());
            robloxDice({ fallo });

            let res;
            await captureStdout(async () => { res = await verificar(port, cuerpo()); });

            assert.strictEqual(res.status, 503, `${fallo.name} deberia dar 503`);
            assert.strictEqual(res.body.error.code, 'verificacion_no_disponible');
            assert.ok(Number(res.headers['retry-after']) >= 1, 'y decir cuando reintentar');
            assert.ok(res.body.ok === undefined, 'no es una denegacion: no lleva ok:false');
        }
    });

    test('un fallo al resolver el DUEÑO tambien es 503, no una denegacion', async () => {
        licenciaEn(filaActiva());
        robloxDice({ falloEnDueño: new UpstreamError('games.roblox.com caido', new Error('ETIMEDOUT')) });

        let res;
        await captureStdout(async () => { res = await verificar(port, cuerpo()); });

        assert.strictEqual(res.status, 503);
        assert.strictEqual(res.body.error.code, 'verificacion_no_disponible');
    });

    test('con la propiedad ya cacheada, un Roblox caido NO impide verificar', async () => {
        // La cache no es solo velocidad: es lo que sostiene la verificacion
        // durante un bache de Roblox. Un juego ya visto se sigue verificando.
        licenciaEn(filaActiva());
        robloxDice({ duenio: { type: 'Group', id: GROUP_ID } });

        const primera = await verificar(port, cuerpo());
        assert.strictEqual(primera.status, 200);
        assert.strictEqual(robloxCalls.length, 2, 'la primera vez se pregunta a Roblox');

        // Ahora Roblox deja de responder — pero SIN limpiar la cache.
        roblox.getUniverseIdForPlace = async () => { throw new UpstreamError('caido', new Error('x')); };
        roblox.getUniverseOwner = async () => { throw new UpstreamError('caido', new Error('x')); };

        const segunda = await verificar(port, cuerpo());
        assert.strictEqual(segunda.status, 200, 'lo ya resuelto sigue sirviendo');
        assert.deepStrictEqual(segunda.body, { ok: true, groupId: GROUP_ID });
    });

    test('la propiedad se resuelve UNA vez por place, no en cada servidor que arranca', async () => {
        licenciaEn(filaActiva());
        robloxDice({ duenio: { type: 'Group', id: GROUP_ID } });

        for (let i = 0; i < 5; i++) await verificar(port, cuerpo());

        assert.strictEqual(robloxCalls.length, 2, 'cinco verificaciones, dos llamadas a Roblox');
    });

    // ═══ UNA sola credencial: el token de licencia ═══════════════════════════

    test('funciona SIN x-api-key: la unica credencial es el token', async () => {
        // `juegoHeaders` ya no lleva x-api-key. La clave compartida del .rbxl
        // no pinta nada aqui: no identifica a nadie y no se puede revocar sin
        // romperle el juego a todos los clientes a la vez.
        licenciaEn(filaActiva());
        robloxDice({ duenio: { type: 'Group', id: GROUP_ID } });

        assert.ok(!('x-api-key' in juegoHeaders), 'los tests no mandan la clave del juego');
        const res = await verificar(port, cuerpo());

        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body, { ok: true, groupId: GROUP_ID });
    });

    test('una x-api-key incorrecta da igual: ya no se mira', async () => {
        licenciaEn(filaActiva());
        robloxDice({ duenio: { type: 'Group', id: GROUP_ID } });
        const res = await verificar(port, cuerpo(), {
            headers: { 'content-type': 'application/json', 'x-api-key': 'una-clave-cualquiera' },
        });

        assert.strictEqual(res.status, 200, 'lo que decide es el token, no la clave compartida');
    });

    test('la ADMIN_API_KEY no sustituye al token de licencia', async () => {
        // Sin token, la clave de administracion no abre nada: se rechaza antes
        // de tocar la base o Roblox.
        licenciaEn(filaActiva());
        robloxDice({});
        const soloAdmin = await verificar(port, cuerpo(), {
            token: null,
            headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN },
        });

        assert.strictEqual(soloAdmin.status, 400, 'sin x-license-token no se pasa');
        assert.match(soloAdmin.body.error.message, /x-license-token/);
        assert.strictEqual(calls.length, 0, 'ni una consulta');
        assert.strictEqual(robloxCalls.length, 0, 'ni una llamada a Roblox');

        // Y usada COMO token tampoco: no es la credencial de ningun grupo.
        licenciaEn(filaActiva());
        robloxDice({});
        const comoToken = await verificar(port, cuerpo(), { token: ADMIN });
        assert.strictEqual(comoToken.status, 403);
        assert.strictEqual(comoToken.body.motivo, 'token_invalido');
    });

    test('el token de licencia NO abre /admin', async () => {
        // La separacion que si hay que sostener: quien tiene una licencia no
        // puede darse licencias a si mismo ni quitarselas a otro.
        const res = await request(port, 'GET', '/admin/groups', {
            headers: { 'x-admin-key': TOKEN },
        });
        assert.strictEqual(res.status, 401, 'un token de licencia no es la clave de administracion');
    });

    // ═══ Autorizacion concedida ══════════════════════════════════════════════

    test('token valido + activa + dueño real coincide -> 200 ok:true', async () => {
        licenciaEn(filaActiva());
        robloxDice({ duenio: { type: 'Group', id: GROUP_ID } });

        const res = await verificar(port, cuerpo());

        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body, { ok: true, groupId: GROUP_ID }, 'la respuesta es exactamente {ok, groupId}');
    });

    test('la consulta busca por HASH, parametrizada, y el token no aparece en ella', async () => {
        licenciaEn(filaActiva());
        robloxDice({});
        await verificar(port, cuerpo());

        assert.strictEqual(calls.length, 1, 'verificar es UNA consulta por clave unica');
        const { text, params } = calls[0];
        assert.match(text, /WHERE license_token_hash = \$1/i);
        assert.deepStrictEqual(params, [HASH], 'a la base va el hash, no el token');
        assert.ok(!text.includes(TOKEN) && !params.includes(TOKEN), 'el token JAMAS viaja a la base');
    });

    test('los ids llegan como numero o como cadena, indistintamente', async () => {
        for (const comoTexto of [false, true]) {
            licenciaEn(filaActiva());
            robloxDice({ duenio: { type: 'Group', id: GROUP_ID } });
            const res = await verificar(port, cuerpo(comoTexto
                ? { gameId: UNIVERSE_ID, placeId: PLACE_ID }
                : { gameId: Number(UNIVERSE_ID), placeId: Number(PLACE_ID) }));
            assert.strictEqual(res.status, 200, `deberia autorizar con ids ${comoTexto ? 'texto' : 'numero'}`);
        }
    });

    // ═══ Los motivos de denegacion ═══════════════════════════════════════════

    test('token desconocido -> 403 token_invalido, sin preguntar a Roblox', async () => {
        licenciaEn(null);
        robloxDice({});
        const res = await verificar(port, cuerpo(), { token: licenseToken.generateToken() });

        assert.strictEqual(res.status, 403);
        assert.deepStrictEqual(res.body, { ok: false, motivo: 'token_invalido' });
        assert.strictEqual(robloxCalls.length, 0, 'sin credencial no se gasta una llamada a Roblox');
    });

    test('token mal formado -> 403 token_invalido, IDENTICO y sin tocar nada', async () => {
        licenciaEn(null);
        robloxDice({});
        const conocido = await verificar(port, cuerpo(), { token: licenseToken.generateToken() });

        for (const malo of ['no-es-un-token', '7xl_corto', 'x'.repeat(200), '7xl_' + 'á'.repeat(43)]) {
            licenciaEn(filaActiva());
            robloxDice({});
            const res = await verificar(port, cuerpo(), { token: malo });

            assert.strictEqual(res.status, 403, `"${malo.slice(0, 12)}" deberia denegar`);
            assert.deepStrictEqual(
                res.body, conocido.body,
                'un token mal formado tiene que ser indistinguible de uno desconocido'
            );
            assert.strictEqual(calls.length, 0, 'y no llega a costar una consulta');
        }
    });

    test('licencia desactivada -> 403 licencia_inactiva, sin preguntar a Roblox', async () => {
        licenciaEn(filaActiva({ active: false }));
        robloxDice({});
        const res = await verificar(port, cuerpo());

        assert.strictEqual(res.status, 403);
        assert.deepStrictEqual(res.body, { ok: false, motivo: 'licencia_inactiva' });
        assert.strictEqual(robloxCalls.length, 0, 'una licencia retirada se corta antes de gastar red');
    });

    test('el dueño REAL es un usuario, no un grupo -> 403 no_es_grupo', async () => {
        // Y da igual lo que declare el cliente: aunque diga "Group", Roblox
        // dice "User" y es Roblox quien manda.
        licenciaEn(filaActiva());
        robloxDice({ duenio: { type: 'User', id: '1' } });

        const res = await verificar(port, cuerpo({ creatorType: 'Group' }));

        assert.strictEqual(res.status, 403);
        assert.deepStrictEqual(res.body, { ok: false, motivo: 'no_es_grupo' });
    });

    test('el juego es de OTRO grupo -> 403 grupo_no_coincide', async () => {
        licenciaEn(filaActiva());
        robloxDice({ duenio: { type: 'Group', id: OTRO_GRUPO } });

        const res = await verificar(port, cuerpo({ creatorId: Number(OTRO_GRUPO) }));

        assert.strictEqual(res.status, 403);
        assert.deepStrictEqual(res.body, { ok: false, motivo: 'grupo_no_coincide' });
    });

    test('el orden de la cadena es token -> licencia -> propiedad', async () => {
        // Una licencia inactiva Y un juego ajeno responden por lo que se
        // comprueba ANTES. Si el orden se invirtiera, el mensaje mandaria a
        // mirar al sitio equivocado — y ademas se gastaria una llamada a
        // Roblox para atender a alguien sin licencia.
        licenciaEn(filaActiva({ active: false }));
        robloxDice({ duenio: { type: 'Group', id: OTRO_GRUPO } });
        const inactiva = await verificar(port, cuerpo());
        assert.strictEqual(inactiva.body.motivo, 'licencia_inactiva');
        assert.strictEqual(robloxCalls.length, 0);

        licenciaEn(null);
        robloxDice({});
        const sinToken = await verificar(port, cuerpo({ creatorId: 1 }), { token: licenseToken.generateToken() });
        assert.strictEqual(sinToken.body.motivo, 'token_invalido');
    });

    // ═══ El transporte del token: cabecera x-license-token ═══════════════════
    //
    // El token viaja por cabecera y no en el cuerpo por una limitacion real de
    // Roblox: HttpService:GetSecret() devuelve un objeto Secret que no se puede
    // serializar con JSONEncode. Un secreto guardado donde debe estar —como
    // Secret— solo puede salir por cabecera.

    test('el token va por cabecera y autoriza sin aparecer en el cuerpo', async () => {
        licenciaEn(filaActiva());
        robloxDice({ duenio: { type: 'Group', id: GROUP_ID } });

        const res = await verificar(port, cuerpo());

        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body, { ok: true, groupId: GROUP_ID });
        assert.deepStrictEqual(
            Object.keys(cuerpo()).sort(),
            ['creatorId', 'creatorType', 'gameId', 'placeId'],
            'el cuerpo no lleva ni menciona el token'
        );
    });

    test('sin la cabecera x-license-token -> 400 que dice que falta', async () => {
        licenciaEn(filaActiva());
        robloxDice({});
        const res = await verificar(port, cuerpo(), { token: null });

        // 400 y no 403: falta una cabecera, que es un fallo del script que
        // llama. Un 403 mandaria a revisar la licencia, que esta perfecta.
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.error.code, 'invalid_request');
        assert.match(res.body.error.message, /x-license-token/);
        assert.strictEqual(calls.length, 0, 'no llega a costar una consulta');
        assert.strictEqual(robloxCalls.length, 0, 'ni una llamada a Roblox');
    });

    test('la cabecera vacia o repetida -> 400', async () => {
        for (const token of ['', '   ']) {
            licenciaEn(filaActiva());
            robloxDice({});
            const res = await verificar(port, cuerpo(), { token });
            assert.strictEqual(res.status, 400, `"${token}" deberia dar 400`);
            assert.strictEqual(calls.length, 0);
        }

        // Node entrega un array cuando la cabecera llega dos veces. Con dos
        // tokens distintos no hay forma honesta de elegir uno.
        licenciaEn(filaActiva());
        robloxDice({});
        const repetida = await request(port, 'POST', '/v1/license/verify', {
            headers: [
                ['content-type', 'application/json'],
                ['x-api-key', OUTFIT],
                ['x-license-token', TOKEN],
                ['x-license-token', licenseToken.generateToken()],
            ],
            body: cuerpo(),
        });
        assert.strictEqual(repetida.status, 400, 'dos tokens en la misma peticion se rechazan');
        assert.strictEqual(calls.length, 0);
    });

    test('el token en el CUERPO -> 400 que dice donde va, no un 403 confuso', async () => {
        licenciaEn(filaActiva());
        robloxDice({});
        const res = await verificar(port, cuerpo({ token: TOKEN }), { token: null });

        assert.strictEqual(res.status, 400);
        assert.match(res.body.error.message, /cabecera x-license-token/);
        // Ignorarlo en silencio acabaria en "token_invalido" y mandaria a
        // revisar la licencia cuando el token nunca llego a leerse.
        assert.notStrictEqual(res.body.error.code, 'token_invalido');
        assert.ok(!res.raw.includes(TOKEN), 'y el token que venia en el cuerpo no se refleja de vuelta');
    });

    test('un token viejo en la cabecera -> 403 token_invalido', async () => {
        // Simula una credencial rotada: el hash guardado ya es otro.
        const tokenViejo = licenseToken.generateToken();
        licenciaEn(filaActiva()); // la fila tiene el HASH del token actual
        robloxDice({});

        const res = await verificar(port, cuerpo(), { token: tokenViejo });

        assert.strictEqual(res.status, 403);
        assert.deepStrictEqual(res.body, { ok: false, motivo: 'token_invalido' });
        assert.strictEqual(robloxCalls.length, 0, 'sin credencial valida no se pregunta a Roblox');
    });

    test('la cabecera no acaba en la URL registrada', async () => {
        // Es media razon de mandar secretos por cabecera: requestLogger si
        // registra la URL, y un token en la query acabaria ahi y en el log de
        // acceso de cualquier proxy por medio.
        const logger = require('../observability/logger');
        const infoOriginal = logger.info;
        const registrado = [];
        logger.info = (mensaje, datos) => registrado.push({ mensaje, datos });

        try {
            licenciaEn(filaActiva());
            robloxDice({ duenio: { type: 'Group', id: GROUP_ID } });
            await verificar(port, cuerpo());
        } finally {
            logger.info = infoOriginal;
        }

        const volcado = JSON.stringify(registrado);
        assert.ok(!volcado.includes(TOKEN), 'EL TOKEN NO PUEDE ACABAR EN EL LOG');
        assert.ok(!volcado.includes(HASH), 'ni su hash');
    });

    test('el logger redacta la cabecera si alguien la pasa sin pensar', async () => {
        // Red de seguridad: hoy ningun modulo pasa la cabecera al logger, pero
        // el dia que alguien lo haga tiene que salir redactada.
        const logger = require('../observability/logger');
        const capturado = await captureStdout(async () => {
            logger.error('caso de prueba', { 'x-license-token': TOKEN, licenseToken: TOKEN, ruta: '/v1/license/verify' });
        });

        assert.ok(!capturado.includes(TOKEN), 'el logger redacta el token de licencia');
        assert.ok(capturado.includes('/v1/license/verify'), 'lo que no es secreto si se registra');
    });

    // ═══ Peticiones mal formadas: 400, no 403 ════════════════════════════════

    test('faltan campos obligatorios -> 400 invalid_request sin tocar nada', async () => {
        const casos = [
            { body: {}, motivo: 'cuerpo vacio' },
            { body: cuerpo({ gameId: undefined }), motivo: 'sin gameId' },
            { body: cuerpo({ placeId: undefined }), motivo: 'sin placeId' },
            { body: cuerpo({ placeId: 'abc' }), motivo: 'placeId no numerico' },
            { body: cuerpo({ placeId: 0 }), motivo: 'placeId cero' },
            { body: cuerpo({ gameId: -5 }), motivo: 'gameId negativo' },
            { body: cuerpo({ placeId: 1.5 }), motivo: 'placeId decimal' },
            { body: cuerpo({ creatorType: 7 }), motivo: 'creatorType que no es texto' },
            { body: cuerpo({ creatorId: 'abc' }), motivo: 'creatorId presente pero no numerico' },
            { body: [], motivo: 'el cuerpo no es un objeto' },
        ];

        for (const { body, motivo } of casos) {
            licenciaEn(filaActiva());
            robloxDice({});
            const res = await verificar(port, body);

            assert.strictEqual(res.status, 400, `deberia rechazar: ${motivo}`);
            assert.strictEqual(res.body.error.code, 'invalid_request');
            assert.strictEqual(calls.length, 0, `no puede consultar la base con entrada invalida (${motivo})`);
            assert.strictEqual(robloxCalls.length, 0, `ni llamar a Roblox (${motivo})`);
        }
    });

    test('sin Content-Type json -> 400; JSON roto -> 400; cuerpo enorme -> 413', async () => {
        licenciaEn(filaActiva());
        robloxDice({});

        const sinTipo = await request(port, 'POST', '/v1/license/verify', {
            headers: { 'x-api-key': OUTFIT }, raw: JSON.stringify(cuerpo()),
        });
        assert.strictEqual(sinTipo.status, 400);

        const roto = await request(port, 'POST', '/v1/license/verify', { headers: juegoHeaders, raw: '{"token":' });
        assert.strictEqual(roto.status, 400);
        assert.strictEqual(roto.body.error.code, 'invalid_request');

        const enorme = await request(port, 'POST', '/v1/license/verify', {
            headers: { ...juegoHeaders, 'x-license-token': TOKEN },
            raw: JSON.stringify(cuerpo({ relleno: 'x'.repeat(5_000) })),
        });
        assert.strictEqual(enorme.status, 413);

        // Y SIN credencial, ese mismo cuerpo enorme ni se lee: la cabecera se
        // comprueba antes del parser, asi que sale 400 sin gastar nada.
        const enormeSinToken = await request(port, 'POST', '/v1/license/verify', {
            headers: juegoHeaders,
            raw: JSON.stringify(cuerpo({ relleno: 'x'.repeat(5_000) })),
        });
        assert.strictEqual(enormeSinToken.status, 400, 'sin credencial no se llega ni a medir el cuerpo');
        assert.match(enormeSinToken.body.error.message, /x-license-token/);
        assert.strictEqual(calls.length, 0);
    });

    // ═══ El token no se filtra por ningun lado ═══════════════════════════════

    test('el token no aparece en NINGUNA respuesta', async () => {
        const respuestas = [];

        licenciaEn(filaActiva());
        robloxDice({ duenio: { type: 'Group', id: GROUP_ID } });
        respuestas.push(await verificar(port, cuerpo()));

        licenciaEn(filaActiva({ active: false }));
        robloxDice({});
        respuestas.push(await verificar(port, cuerpo()));

        licenciaEn(null);
        robloxDice({});
        respuestas.push(await verificar(port, cuerpo()));

        licenciaEn(filaActiva());
        robloxDice({ duenio: { type: 'Group', id: OTRO_GRUPO } });
        respuestas.push(await verificar(port, cuerpo()));

        for (const res of respuestas) {
            assert.ok(!res.raw.includes(TOKEN), 'ni concedida ni denegada puede devolver el token');
            assert.ok(!res.raw.includes(HASH), 'ni su hash');
        }
    });

    test('el log lleva lo real, lo declarado y el juego — y NUNCA el token', async () => {
        const logger = require('../observability/logger');
        const infoOriginal = logger.info;
        const registrado = [];
        logger.info = (mensaje, datos) => registrado.push({ mensaje, datos });

        try {
            licenciaEn(filaActiva());
            robloxDice({ duenio: { type: 'Group', id: OTRO_GRUPO } });
            await verificar(port, cuerpo({ creatorId: Number(OTRO_GRUPO) }));
        } finally {
            logger.info = infoOriginal;
        }

        const linea = registrado.find(l => l.mensaje === 'Verificacion de licencia');
        assert.ok(linea, 'toda verificacion tiene que dejar rastro');

        const volcado = JSON.stringify(linea);
        assert.ok(!volcado.includes(TOKEN), 'EL TOKEN NO PUEDE ACABAR EN EL LOG');
        assert.ok(!volcado.includes(HASH), 'ni su hash');

        assert.strictEqual(linea.datos.ok, false);
        assert.strictEqual(linea.datos.motivo, 'grupo_no_coincide');
        assert.strictEqual(linea.datos.gameId, UNIVERSE_ID, 'gameId existe justamente para esto');
        assert.strictEqual(linea.datos.placeId, PLACE_ID);
        assert.strictEqual(linea.datos.dueñoRealId, OTRO_GRUPO, 'y queda constancia del dueño real');
    });

    // ═══ Que nada de esto toca el resto de la API ════════════════════════════

    test('la ruta esta detras del limitador por IP', async () => {
        licenciaEn(filaActiva());
        robloxDice({ duenio: { type: 'Group', id: GROUP_ID } });
        ownRateLimit.reset();
        const { maxPerWindow } = ownRateLimit.getMetrics();

        for (let i = 0; i < maxPerWindow; i++) {
            const res = await request(port, 'POST', '/v1/license/verify', { headers: { ...juegoHeaders, 'x-license-token': TOKEN }, body: cuerpo(), sinReset: true });
            assert.strictEqual(res.status, 200, `la peticion ${i + 1} debia pasar`);
        }

        const res = await request(port, 'POST', '/v1/license/verify', { headers: { ...juegoHeaders, 'x-license-token': TOKEN }, body: cuerpo(), sinReset: true });
        assert.strictEqual(res.status, 429);
        ownRateLimit.reset();
    });

    test('las rutas de outfits siguen sin parser de body', async () => {
        licenciaEn(filaActiva());
        robloxDice({});
        // /v1/users tambien va con el token de licencia: sin cabecera, 400.
        const sinToken = await request(port, 'POST', '/v1/users', { headers: juegoHeaders, body: cuerpo() });
        assert.strictEqual(sinToken.status, 400, 'sin token no se entra a las rutas de datos');
        assert.match(sinToken.body.error.message, /x-license-token/);

        // Y con token, POST /v1/users sigue sin existir: la verificacion no le
        // ha dado superficie de escritura a la API de datos.
        licenciaEn(filaActiva());
        const escritura = await request(port, 'POST', '/v1/users', {
            headers: { ...juegoHeaders, 'x-license-token': TOKEN }, body: cuerpo(),
        });
        assert.strictEqual(escritura.status, 404, 'sigue sin superficie de escritura');
        assert.strictEqual(escritura.body.error.code, 'route_not_found');

        const metrics = await request(port, 'GET', '/v1/metrics', { headers: { 'x-api-key': OUTFIT } });
        assert.strictEqual(metrics.status, 200, '/v1 sigue funcionando igual');
        // Antes las rutas de datos no tocaban Postgres para nada. Ahora si:
        // UNA consulta, la del token de licencia, por clave unica indexada. Es
        // el precio de que el comprador configure un solo Secret, y conviene
        // tenerlo escrito porque acopla esas rutas a la base.
        assert.strictEqual(calls.length, 1, 'solo la consulta de la licencia, ni una mas');
        assert.match(calls[0].text, /license_token_hash/);
    });

    test('GET /v1/license/verify no existe: es POST o nada', async () => {
        licenciaEn(filaActiva());
        const res = await request(port, 'GET', '/v1/license/verify', {
            headers: { 'x-license-token': TOKEN },
        });
        assert.strictEqual(res.status, 404);
        assert.strictEqual(res.body.error.code, 'route_not_found');
    });

    test('base caida -> 503, NO un 403 que negaria una licencia valida', async () => {
        calls = [];
        robloxDice({});
        responder = () => {
            const err = new Error('fallo simulado (ECONNREFUSED)');
            err.code = 'ECONNREFUSED';
            throw err;
        };

        let res;
        await captureStdout(async () => { res = await verificar(port, cuerpo()); });

        assert.strictEqual(res.status, 503);
        assert.strictEqual(res.body.error.code, 'database_unavailable');
        assert.ok(!res.raw.includes(TOKEN));
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
