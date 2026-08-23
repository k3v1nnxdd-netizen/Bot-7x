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
const { NotFoundError, UpstreamError, UpstreamRateLimitedError } = require('../roblox/errors');

// LAS TRES RUTAS DE DATOS QUE CONSUME EL JUEGO, con UNA sola credencial:
//
//   GET /v1/users/by-username/{username}
//   GET /v1/users/{userId}/outfits
//   GET /v1/outfits/{outfitId}
//
// El comprador configura un unico Secret en su experiencia
// (`OutfitLicenseToken`) y con el llama a todo. Ya no hay `x-api-key` que
// repartir, que era media razon del cambio anterior: esa clave era la MISMA
// para todos los clientes, no identificaba a nadie y no se podia revocar sin
// romperle el juego a todos a la vez.
//
// LO QUE ESTE ARCHIVO PRUEBA AHORA, y es lo nuevo: estas tres rutas exigen la
// CADENA ENTERA, la misma que /v1/license/verify. No basta con presentar un
// token vivo — hay que presentarlo DESDE la experiencia del grupo que tiene la
// licencia, y quien dice de quien es esa experiencia es Roblox, no el script.
//
// El agujero que esto cierra es concreto y no era teorico: con solo "token
// vivo", cualquiera que copiara el token de un cliente podia leer outfits
// desde SU propio juego indefinidamente. La verificacion al arrancar el
// servidor no lo impedia, porque cada lectura posterior se conformaba con
// menos que la verificacion.
//
// Los dos ids de la experiencia viajan por cabecera (`x-game-id`,
// `x-place-id`) porque estas rutas son GET y no tienen cuerpo.

const GROUP_ID = '35216530';        // el grupo con licencia
const OTRO_GRUPO = '77112233';      // un grupo cualquiera, sin licencia
const USER_ID = '4242424242';       // el dueño de una experiencia personal
const PLACE_ID = '1234567890';      // el place que dice el juego
const UNIVERSE_ID = '5432109876';   // el universo REAL de ese place, segun Roblox
const OTRO_PLACE = '9999999999';    // otra experiencia distinta

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
    // Son CINCO llamadas las que hay que sustituir, y conviene ver por que se
    // cuentan en dos contadores separados:
    //
    //   propiedad  place -> universo -> dueño. Es la PUERTA. Se cachea 6 h por
    //              placeId, asi que su contador es el que dice si la cache
    //              esta haciendo su trabajo.
    //   datos      username / outfits / detalle. Es lo que hay DETRAS de la
    //              puerta. Su contador a cero es la prueba de que una peticion
    //              denegada no gasta cuota de Roblox.
    const originales = {
        lookupUserByUsername: roblox.lookupUserByUsername,
        listOutfits: roblox.listOutfits,
        getOutfitDetailsRaw: roblox.getOutfitDetailsRaw,
        getUniverseIdForPlace: roblox.getUniverseIdForPlace,
        getUniverseOwner: roblox.getUniverseOwner,
    };
    let llamadasARoblox = 0;      // solo los endpoints de DATOS
    let llamadasDePropiedad = 0;  // solo los dos de la puerta

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

    // Lo que Roblox dice que es la verdad sobre la experiencia. `dueno` es el
    // propietario REAL; `fallo` permite ensayar un Roblox caido, que tiene que
    // acabar en 503 y jamas en una denegacion.
    function robloxDice({
        universeId = UNIVERSE_ID,
        dueno = { type: 'Group', id: GROUP_ID },
        fallo = null,
        falloEnDueno = null,
        placeDesconocido = false,
        universoDesconocido = false,
    } = {}) {
        llamadasDePropiedad = 0;

        roblox.getUniverseIdForPlace = async () => {
            llamadasDePropiedad++;
            if (fallo) throw fallo;
            if (placeDesconocido) throw new NotFoundError('place_not_found', 'Roblox no reconoce ese placeId');
            return universeId;
        };

        roblox.getUniverseOwner = async universoPedido => {
            llamadasDePropiedad++;
            if (falloEnDueno) throw falloEnDueno;
            if (universoDesconocido) throw new NotFoundError('universe_not_found', 'Roblox no reconoce ese universo');
            return {
                universeId: universoPedido,
                rootPlaceId: PLACE_ID,
                name: 'Juego de prueba',
                creatorType: dueno.type,
                creatorId: dueno.id,
                creatorName: 'Nombre del dueño',
            };
        };
    }

    // Lo que manda el juego en cada peticion: el token y los dos ids de la
    // experiencia desde la que llama.
    const conToken = (token = TOKEN, extra = {}) => ({
        'x-license-token': token,
        'x-game-id': UNIVERSE_ID,
        'x-place-id': PLACE_ID,
        ...extra,
    });

    const app = createApp();
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;

    // Estado de partida de casi todos los casos: licencia viva, cache vacia,
    // Roblox diciendo que el place es del grupo con licencia y los contadores
    // a cero. La cache se limpia SIEMPRE salvo donde justamente se mide.
    const limpio = (opciones = {}) => {
        licenciaViva();
        cache.reset();
        robloxDice(opciones);
        llamadasARoblox = 0;
    };

    // ═══ 1. El camino feliz: token vivo + experiencia del grupo correcto ═════

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
            headers: conToken(TOKEN, { 'x-api-key': 'una-clave-cualquiera' }),
        });
        assert.strictEqual(res.status, 200);
    });

    // ═══ 2. LA PUERTA NUEVA: de quien es de VERDAD la experiencia ════════════
    //
    // Es lo que convierte la licencia en algo atado a un juego concreto en vez
    // de en una llave suelta que abre desde cualquier sitio.

    test('token valido pero experiencia de OTRO grupo -> 403 grupo_no_coincide', async () => {
        // El escenario real: alguien copia el token de un cliente y lo usa
        // desde su propio juego. El token es autentico y la licencia esta
        // viva; lo que no encaja es DESDE DONDE se llama.
        for (const [ruta, que] of RUTAS) {
            limpio({ dueno: { type: 'Group', id: OTRO_GRUPO } });
            const res = await captureStdout(async () => {
                const r = await request(port, ruta, { headers: conToken() });
                assert.strictEqual(r.status, 403, `${que} debe cerrarse a una experiencia ajena`);
                assert.deepStrictEqual(r.body, { ok: false, motivo: 'grupo_no_coincide' });
            });
            assert.ok(typeof res === 'string');
            assert.strictEqual(llamadasARoblox, 0, 'y no gasta cuota de datos de Roblox');
        }
    });

    test('experiencia PERSONAL (de un usuario, no de un grupo) -> 403 no_es_grupo', async () => {
        // Las licencias son de grupos. Un juego publicado en la cuenta
        // personal del comprador no esta cubierto, aunque el comprador sea el
        // mismo — y decirlo con un motivo propio le ahorra buscar el fallo en
        // el token.
        for (const [ruta, que] of RUTAS) {
            limpio({ dueno: { type: 'User', id: USER_ID } });
            await captureStdout(async () => {
                const res = await request(port, ruta, { headers: conToken() });
                assert.strictEqual(res.status, 403, `${que} debe cerrarse a una experiencia personal`);
                assert.deepStrictEqual(res.body, { ok: false, motivo: 'no_es_grupo' });
            });
            assert.strictEqual(llamadasARoblox, 0);
        }
    });

    test('experiencia personal DEL DUEÑO del grupo tambien se rechaza', async () => {
        // El caso confuso: el id del usuario coincide con el del grupo. Son
        // espacios de ids distintos en Roblox, asi que compararlos sin mirar el
        // tipo autorizaria a un juego personal por accidente.
        limpio({ dueno: { type: 'User', id: GROUP_ID } });
        await captureStdout(async () => {
            const res = await request(port, RUTAS[0][0], { headers: conToken() });
            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.motivo, 'no_es_grupo', 'el TIPO se mira antes que el id');
        });
    });

    test('placeId que Roblox no conoce -> 403 juego_desconocido (fail-closed)', async () => {
        for (const [ruta, que] of RUTAS) {
            limpio({ placeDesconocido: true });
            await captureStdout(async () => {
                const res = await request(port, ruta, { headers: conToken() });
                assert.strictEqual(res.status, 403, `${que} no puede abrirse con un place inexistente`);
                assert.deepStrictEqual(res.body, { ok: false, motivo: 'juego_desconocido' });
            });
            assert.strictEqual(llamadasARoblox, 0);
        }
    });

    test('universo que Roblox no conoce -> 403 juego_desconocido', async () => {
        limpio({ universoDesconocido: true });
        await captureStdout(async () => {
            const res = await request(port, RUTAS[0][0], { headers: conToken() });
            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.motivo, 'juego_desconocido');
        });
    });

    test('gameId que no es el universo real del place -> 403 juego_no_coincide', async () => {
        // Los dos ids los manda el mismo script. Que no cuadren entre si
        // significa o un script mal configurado o ids mezclados de dos sitios
        // distintos; en ninguno de los dos casos hay nada que autorizar.
        limpio({ universeId: '1111111111' });
        await captureStdout(async () => {
            const res = await request(port, RUTAS[0][0], { headers: conToken() });
            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.motivo, 'juego_no_coincide');
        });
    });

    test('x-creator-id NO es autoridad: mentir en la cabecera no abre nada', async () => {
        // El .rbxl esta en el ordenador del comprador y puede declarar lo que
        // quiera. Aqui declara ser el grupo con licencia mientras Roblox dice
        // que la experiencia es de otro. Gana Roblox.
        limpio({ dueno: { type: 'Group', id: OTRO_GRUPO } });
        await captureStdout(async () => {
            const res = await request(port, RUTAS[0][0], {
                headers: conToken(TOKEN, { 'x-creator-type': 'Group', 'x-creator-id': GROUP_ID }),
            });
            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.motivo, 'grupo_no_coincide');
        });
    });

    test('y el reverso: declarar mal el dueño REAL no cierra una peticion legitima', async () => {
        // La otra cara de "no es autoridad". Un script viejo o mal copiado que
        // declare un creatorId equivocado sigue entrando, porque la decision no
        // sale de lo declarado. Queda en el log, que es donde debe quedar.
        limpio();
        const res = await request(port, RUTAS[0][0], {
            headers: conToken(TOKEN, { 'x-creator-type': 'User', 'x-creator-id': OTRO_GRUPO }),
        });
        assert.strictEqual(res.status, 200, 'lo declarado no decide, ni para bien ni para mal');
    });

    test('sin x-game-id o sin x-place-id -> 400, y NUNCA un pase', async () => {
        // Si la ausencia de la cabecera saltara la comprobacion, desactivarla
        // seria tan facil como borrar una linea del script que se distribuye.
        const casos = [
            [{ 'x-license-token': TOKEN, 'x-place-id': PLACE_ID }, 'falta x-game-id'],
            [{ 'x-license-token': TOKEN, 'x-game-id': UNIVERSE_ID }, 'falta x-place-id'],
            [{ 'x-license-token': TOKEN }, 'faltan las dos'],
        ];

        for (const [headers, que] of casos) {
            limpio();
            const res = await request(port, RUTAS[0][0], { headers });

            assert.strictEqual(res.status, 400, `${que} tiene que ser un 400`);
            assert.strictEqual(res.body.error.code, 'invalid_request');
            assert.strictEqual(llamadasDePropiedad, 0, 'sin ids no se llama a Roblox');
            assert.strictEqual(llamadasARoblox, 0);
            assert.strictEqual(calls.length, 0, 'ni se consulta la base');
        }
    });

    test('ids con forma imposible -> 400 sin tocar la base ni Roblox', async () => {
        const malos = ['abc', '0', '007', '-5', '12.5', ' ', 'x'.repeat(100)];

        for (const malo of malos) {
            limpio();
            const res = await request(port, RUTAS[0][0], {
                headers: { 'x-license-token': TOKEN, 'x-game-id': malo, 'x-place-id': PLACE_ID },
            });

            assert.strictEqual(res.status, 400, `"${malo.slice(0, 10)}" deberia rechazarse`);
            assert.strictEqual(llamadasDePropiedad, 0);
            assert.strictEqual(calls.length, 0);
        }
    });

    test('la cabecera repetida no se resuelve a favor de nadie', async () => {
        // Mandar dos veces `x-game-id` con valores distintos es pedir que se
        // elija a ciegas entre dos experiencias. No se elige: Node une las
        // repeticiones en "a, b", eso deja de tener forma de id y el parser lo
        // rechaza. Lo que importa no es el mensaje sino que NINGUNO de los dos
        // valores llega a usarse.
        limpio();
        const res = await new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1', port, path: RUTAS[0][0], method: 'GET',
                headers: { 'x-license-token': TOKEN, 'x-place-id': PLACE_ID, 'x-game-id': [UNIVERSE_ID, '1111111111'] },
            }, r => {
                let data = '';
                r.on('data', c => { data += c; });
                r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(data) }));
            });
            req.on('error', reject);
            req.end();
        });

        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.error.code, 'invalid_request');
        assert.match(res.body.error.message, /x-game-id/, 'y dice cual de las dos cabeceras es');
        assert.strictEqual(calls.length, 0, 'no se consulta la licencia');
        assert.strictEqual(llamadasDePropiedad, 0, 'ni se le pregunta a Roblox por ninguno de los dos');
    });

    // ═══ 3. La puerta va DELANTE del trabajo caro ═══════════════════════════

    test('una experiencia ajena no llega a leer un solo outfit', async () => {
        // El orden importa mas que el codigo de respuesta: la denegacion tiene
        // que ocurrir ANTES de la peticion real a Roblox, no despues de
        // haberla hecho y descartado el resultado.
        for (const [ruta] of RUTAS) {
            limpio({ dueno: { type: 'Group', id: OTRO_GRUPO } });
            await captureStdout(async () => {
                await request(port, ruta, { headers: conToken() });
            });
            assert.strictEqual(llamadasARoblox, 0, 'ni una llamada a los endpoints de datos');
        }
    });

    test('el token se comprueba ANTES que la propiedad', async () => {
        // Al reves, cualquiera podria sondear de quien son juegos ajenos sin
        // presentar credencial alguna.
        limpio();
        await captureStdout(async () => {
            const res = await request(port, RUTAS[0][0], { headers: conToken(TOKEN_VIEJO) });
            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.motivo, 'token_invalido');
        });
        assert.strictEqual(llamadasDePropiedad, 0, 'sin token valido no se le pregunta nada a Roblox');
    });

    // ═══ 4. La cache de propiedad ═══════════════════════════════════════════

    test('peticiones repetidas de la misma experiencia salen de cache', async () => {
        limpio();

        // La primera resuelve: place -> universo -> dueño.
        await request(port, RUTAS[0][0], { headers: conToken() });
        assert.strictEqual(llamadasDePropiedad, 2, 'la primera pregunta a Roblox las dos cosas');

        // Las siguientes no vuelven a preguntar. Un juego con 200 servidores
        // arrancando no puede convertirse en 400 llamadas a Roblox.
        for (let i = 0; i < 5; i++) {
            const res = await request(port, RUTAS[i % RUTAS.length][0], { headers: conToken() });
            assert.strictEqual(res.status, 200);
        }
        assert.strictEqual(llamadasDePropiedad, 2, 'ni una llamada de propiedad mas');
    });

    test('la cache es POR EXPERIENCIA: otro place se resuelve aparte', async () => {
        // Si la cache fuera global o por token, un place ya visto autorizaria
        // a otro distinto — que es exactamente el agujero que se quiere cerrar.
        limpio();
        await request(port, RUTAS[0][0], { headers: conToken() });
        assert.strictEqual(llamadasDePropiedad, 2);

        await captureStdout(async () => {
            const res = await request(port, RUTAS[0][0], {
                headers: { 'x-license-token': TOKEN, 'x-game-id': UNIVERSE_ID, 'x-place-id': OTRO_PLACE },
            });
            // El doble responde lo mismo para cualquier place, asi que este
            // sale 200: lo que se mide es que VOLVIO a preguntar.
            assert.ok(res.status === 200 || res.status === 403);
        });
        assert.strictEqual(llamadasDePropiedad, 4, 'un place nuevo se resuelve desde cero');
    });

    test('LA LICENCIA NO SE CACHEA: se consulta en cada peticion', async () => {
        // Es la mitad del contrato de esta puerta. La propiedad se cachea 6 h
        // porque un juego no cambia de dueño; la licencia NO se cachea nunca,
        // para que /regeneratetoken, /deletegroup y desactivar una licencia
        // surtan efecto en la peticion siguiente y no cuando expire un TTL.
        limpio();
        for (let i = 0; i < 4; i++) {
            await request(port, RUTAS[0][0], { headers: conToken() });
        }
        assert.strictEqual(calls.length, 4, 'una consulta de licencia por peticion');
        assert.strictEqual(llamadasDePropiedad, 2, 'y la propiedad solo la primera vez');
    });

    test('desactivar la licencia cierra la puerta EN LA SIGUIENTE peticion', async () => {
        // Con la propiedad ya en cache, que es el caso que importa: si la
        // licencia se hubiera cacheado junto a ella, la baja tardaria 6 h en
        // notarse.
        limpio();
        assert.strictEqual((await request(port, RUTAS[0][0], { headers: conToken() })).status, 200);

        fila = { ...fila, active: false };   // sin tocar la cache de propiedad
        await captureStdout(async () => {
            const res = await request(port, RUTAS[0][0], { headers: conToken() });
            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.motivo, 'licencia_inactiva');
        });
    });

    test('regenerar el token cierra la puerta EN LA SIGUIENTE peticion', async () => {
        limpio();
        assert.strictEqual((await request(port, RUTAS[0][0], { headers: conToken() })).status, 200);

        // Rotacion: la fila pasa a tener el hash del token nuevo. El viejo no
        // esta ya en ninguna fila, asi que muere solo.
        const TOKEN_NUEVO = licenseToken.generateToken();
        fila = { ...fila, license_token_hash: licenseToken.hashToken(TOKEN_NUEVO) };

        await captureStdout(async () => {
            const res = await request(port, RUTAS[0][0], { headers: conToken() });
            assert.strictEqual(res.status, 403, 'el token de antes de la rotacion ya no abre');
            assert.strictEqual(res.body.motivo, 'token_invalido');
        });

        const conNuevo = await request(port, RUTAS[0][0], { headers: conToken(TOKEN_NUEVO) });
        assert.strictEqual(conNuevo.status, 200, 'y el nuevo si');
    });

    // ═══ 5. Roblox caido no deniega a nadie ═════════════════════════════════

    test('Roblox caido -> 503, JAMAS un 403', async () => {
        // La distincion que sostiene todo esto: "ahora mismo no lo se" no es
        // "no eres el dueño". Confundirlas echaria a todos los clientes
        // legitimos de su propio juego cada vez que Roblox tosa.
        const fallos = [
            new UpstreamError('5xx de Roblox', new Error('boom')),
            new UpstreamRateLimitedError('Roblox nos limito', 7),
        ];

        for (const fallo of fallos) {
            // El fallo puede caer en cualquiera de las dos llamadas: al
            // resolver el universo del place, o al preguntar quien es su dueño.
            // Las dos son "no lo se", no "no eres tu".
            for (const donde of ['fallo', 'falloEnDueno']) {
                limpio({ [donde]: fallo });
                await captureStdout(async () => {
                    const res = await request(port, RUTAS[0][0], { headers: conToken() });

                    assert.strictEqual(res.status, 503, `${fallo.name} en ${donde} debe ser 503`);
                    assert.notStrictEqual(res.body.ok, false, 'no puede parecer una denegacion');
                    assert.ok(res.headers['retry-after'], 'y debe decir cuando reintentar');
                });
            }
        }
    });

    test('un fallo de Roblox no se cachea como si fuera una respuesta', async () => {
        limpio({ fallo: new UpstreamError('caido', new Error('boom')) });
        await captureStdout(async () => {
            await request(port, RUTAS[0][0], { headers: conToken() });
        });

        // Roblox vuelve. La peticion siguiente tiene que resolver de verdad,
        // no arrastrar el fallo guardado.
        robloxDice({});
        const res = await request(port, RUTAS[0][0], { headers: conToken() });
        assert.strictEqual(res.status, 200, 'un bache momentaneo no puede dejar cerrada la puerta');
    });

    // ═══ 6. Token ausente ═══════════════════════════════════════════════════

    test('sin x-license-token -> 400 y sin tocar la base ni Roblox', async () => {
        for (const [ruta, que] of RUTAS) {
            limpio();
            const res = await request(port, ruta);

            assert.strictEqual(res.status, 400, `${que} sin token debe rechazarse`);
            assert.match(res.body.error.message, /x-license-token/);
            assert.strictEqual(calls.length, 0, 'ni una consulta a la base');
            assert.strictEqual(llamadasARoblox, 0, 'ni una llamada a Roblox');
            assert.strictEqual(llamadasDePropiedad, 0);
        }
    });

    test('la vieja x-api-key ya NO abre estas rutas', async () => {
        // Es la mitad del cambio anterior: el comprador deja de necesitarla.
        for (const [ruta, que] of RUTAS) {
            limpio();
            const res = await request(port, ruta, { headers: { 'x-api-key': OUTFIT } });

            assert.strictEqual(res.status, 400, `${que} no puede abrirse con la clave compartida`);
            assert.strictEqual(llamadasARoblox, 0);
        }
    });

    // ═══ 7. Token invalido o viejo ══════════════════════════════════════════

    test('token inventado o mal formado -> 403 token_invalido', async () => {
        const malos = [licenseToken.generateToken(), 'no-es-un-token', '7xl_corto', 'x'.repeat(200)];

        for (const malo of malos) {
            limpio();
            let res;
            await captureStdout(async () => {
                res = await request(port, RUTAS[0][0], { headers: conToken(malo) });
            });

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
            let res;
            await captureStdout(async () => {
                res = await request(port, ruta, { headers: conToken(TOKEN_VIEJO) });
            });

            assert.strictEqual(res.status, 403, `${que} debe cerrarse al token rotado`);
            assert.strictEqual(res.body.motivo, 'token_invalido');
        }

        // Y el nuevo sigue abriendo.
        limpio();
        assert.strictEqual((await request(port, RUTAS[0][0], { headers: conToken() })).status, 200);
    });

    // ═══ 8. Licencia desactivada ════════════════════════════════════════════

    test('licencia desactivada -> 403 licencia_inactiva en las tres', async () => {
        for (const [ruta, que] of RUTAS) {
            limpio();
            licenciaViva({ active: false });
            let res;
            await captureStdout(async () => {
                res = await request(port, ruta, { headers: conToken() });
            });

            assert.strictEqual(res.status, 403, `${que} debe cerrarse a una licencia retirada`);
            assert.deepStrictEqual(res.body, { ok: false, motivo: 'licencia_inactiva' });
            assert.strictEqual(llamadasARoblox, 0, 'una licencia retirada no gasta cuota de Roblox');
        }
    });

    test('cada denegacion manda a mirar a un sitio distinto', async () => {
        // Los motivos no son decorativos: uno dice "revisa tu token", otro
        // "habla con nosotros", otro "estas llamando desde el juego que no es".
        // Un motivo generico obligaria a adivinar en los tres casos.
        const motivos = new Set();

        await captureStdout(async () => {
            limpio();
            motivos.add((await request(port, RUTAS[0][0], { headers: conToken(TOKEN_VIEJO) })).body.motivo);

            limpio(); licenciaViva({ active: false });
            motivos.add((await request(port, RUTAS[0][0], { headers: conToken() })).body.motivo);

            limpio({ dueno: { type: 'Group', id: OTRO_GRUPO } });
            motivos.add((await request(port, RUTAS[0][0], { headers: conToken() })).body.motivo);

            limpio({ dueno: { type: 'User', id: USER_ID } });
            motivos.add((await request(port, RUTAS[0][0], { headers: conToken() })).body.motivo);

            limpio({ placeDesconocido: true });
            motivos.add((await request(port, RUTAS[0][0], { headers: conToken() })).body.motivo);
        });

        assert.deepStrictEqual(
            [...motivos].sort(),
            ['grupo_no_coincide', 'juego_desconocido', 'licencia_inactiva', 'no_es_grupo', 'token_invalido'],
            'cinco situaciones distintas, cinco motivos distintos'
        );
    });

    // ═══ 9. Ni el token ni su hash se filtran ═══════════════════════════════

    test('el token no aparece en ninguna respuesta, concedida o denegada', async () => {
        const respuestas = [];

        await captureStdout(async () => {
            for (const [ruta] of RUTAS) {
                limpio();
                respuestas.push(await request(port, ruta, { headers: conToken() }));
                limpio();
                respuestas.push(await request(port, ruta, { headers: conToken(TOKEN_VIEJO) }));
                limpio();
                respuestas.push(await request(port, ruta));
                // Y la denegacion nueva, que es la que trae datos de Roblox
                // pegados a la decision: tampoco puede arrastrar el token.
                limpio({ dueno: { type: 'Group', id: OTRO_GRUPO } });
                respuestas.push(await request(port, ruta, { headers: conToken() }));
            }
        });

        for (const res of respuestas) {
            const todo = res.raw + JSON.stringify(res.headers);
            assert.ok(!todo.includes(TOKEN), 'el token no puede salir en cuerpo ni cabeceras');
            assert.ok(!todo.includes(HASH), 'ni su hash');
            assert.ok(!todo.includes(TOKEN_VIEJO), 'ni el que se mando y fue rechazado');
        }
    });

    test('el token no llega al log de la peticion, ni al de auditoria', async () => {
        // El requestLogger registra la URL y varios campos, y la denegacion
        // deja ademas su propia linea con el juego y el dueño real. El token
        // viaja por cabecera justamente para no acabar en ninguna de las dos.
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
            limpio({ dueno: { type: 'Group', id: OTRO_GRUPO } });
            await request(port, RUTAS[2][0], { headers: conToken() });
            limpio({ dueno: { type: 'User', id: USER_ID } });
            await request(port, RUTAS[0][0], {
                headers: conToken(TOKEN, { 'x-creator-type': 'Group', 'x-creator-id': GROUP_ID }),
            });
        } finally {
            Object.assign(logger, originalesLog);
        }

        const volcado = JSON.stringify(registrado);
        assert.ok(registrado.length > 0, 'las peticiones dejan rastro (la comprobacion no es vacua)');
        assert.ok(!volcado.includes(TOKEN), 'EL TOKEN NO PUEDE ACABAR EN EL LOG');
        assert.ok(!volcado.includes(HASH), 'ni su hash');
        assert.ok(!volcado.includes(TOKEN_VIEJO));

        // Y lo que SI tiene que estar, porque es lo que sirve para investigar
        // una reclamacion: el juego desde el que se llamo y el dueño real.
        assert.ok(volcado.includes(PLACE_ID), 'el placeId si debe registrarse');
        assert.ok(volcado.includes(OTRO_GRUPO), 'y el dueño real de la experiencia');
        assert.ok(volcado.includes('declaracion falsa'), 'un creatorId declarado que no es el real se marca');
    });

    // ═══ 10. /admin sigue intacto ═══════════════════════════════════════════

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

    // ═══ 11. Lo que no se toca ══════════════════════════════════════════════

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

    test('la cache de datos sigue funcionando: el segundo jugador no gasta Roblox', async () => {
        limpio();
        await request(port, RUTAS[0][0], { headers: conToken() });
        const tras1 = llamadasARoblox;

        await request(port, RUTAS[0][0], { headers: conToken() });
        assert.strictEqual(tras1, 1, 'la primera resuelve contra Roblox');
        assert.strictEqual(llamadasARoblox, 1, 'la segunda sale de cache');

        // La licencia SI se comprueba en las dos: la cache es de datos de
        // Roblox y de propiedad de la experiencia, no de la autorizacion.
        assert.strictEqual(calls.length, 2, 'pero la licencia se comprueba en cada peticion');
    });

    test('la validacion de parametros sigue viva detras de la puerta', async () => {
        limpio();
        const res = await request(port, '/v1/users/abc/outfits', { headers: conToken() });

        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.error.code, 'invalid_request');
        assert.strictEqual(llamadasARoblox, 0, 'un parametro invalido no gasta cuota de datos');
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
