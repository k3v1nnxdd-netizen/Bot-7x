'use strict';

const config = require('../config');

// Frontera donde se deja de confiar en el llamador. Validar aqui no es
// ceremonia: cada parametro que llega sin filtrar es a la vez una llamada
// potencial a Roblox (el recurso escaso) y una clave nueva en la cache (la
// memoria del proceso). Rechazar en el borde significa que una peticion
// absurda cuesta microsegundos y cero trafico saliente.

class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ValidationError';
        this.code = 'invalid_request';
    }
}

// Roblox acepta 3-20 caracteres alfanumericos y guion bajo. Se valida el
// juego de caracteres y la longitud, sin replicar reglas mas finas de
// creacion de cuentas (un solo guion bajo, no al principio ni al final):
// esas aplican a cuentas NUEVAS, y hay cuentas antiguas legitimas que no las
// cumplen. Rechazarlas seria inventar un 400 para un usuario que si existe.
const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;

function parseUsername(raw) {
    if (typeof raw !== 'string') {
        throw new ValidationError('El nombre de usuario es obligatorio');
    }
    const username = raw.trim();
    if (!USERNAME_PATTERN.test(username)) {
        throw new ValidationError('El nombre de usuario debe tener entre 3 y 20 caracteres alfanumericos o guion bajo');
    }
    return username;
}

// Los ids de Roblox son enteros positivos. Se exige la cadena de digitos
// completa (nada de parseInt, que aceptaria "123abc") y se acota a un entero
// seguro de JS, porque por encima de 2^53 el propio Number pierde precision y
// consultariamos un id distinto del pedido.
function parsePositiveId(raw, label) {
    if (typeof raw !== 'string' || !/^[0-9]{1,16}$/.test(raw)) {
        throw new ValidationError(`${label} debe ser un entero positivo`);
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new ValidationError(`${label} debe ser un entero positivo`);
    }
    return value;
}

function parseUserId(raw) {
    return parsePositiveId(raw, 'userId');
}

function parseOutfitId(raw) {
    return parsePositiveId(raw, 'outfitId');
}

// ── POST /v1/outfits/batch ──────────────────────────────────────────────────
//
// Los ids llegan en un cuerpo JSON, donde el tipo NUMERO existe de verdad, asi
// que se aceptan numero y cadena de digitos: `table.concat` de Lua produce
// numeros y un JSONEncode de una lista de OutfitIds tambien, pero un cliente
// que los tenga como texto no deberia romperse por eso. Lo que NO se acepta es
// nada que no sea un id: cada elemento pasa por el mismo `parseOutfitId` que
// usa la ruta individual, asi que el contrato es identico.
function parseOutfitBatchBody(body, { maxIds }) {
    if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new ValidationError(
            'Manda un cuerpo JSON con {"outfitIds": [123, 456]} y la cabecera Content-Type: application/json'
        );
    }

    const crudos = body.outfitIds;
    if (!Array.isArray(crudos)) {
        throw new ValidationError('outfitIds debe ser una lista de ids de outfit');
    }
    if (crudos.length === 0) {
        throw new ValidationError('outfitIds no puede estar vacia');
    }

    // El tope se comprueba ANTES de validar uno a uno: una lista de mil ids no
    // debe costar mil validaciones para acabar rechazada igual.
    if (crudos.length > maxIds) {
        throw new ValidationError(`outfitIds admite como maximo ${maxIds} ids por peticion (llegaron ${crudos.length})`);
    }

    // Se valida CADA uno aunque venga repetido: si el juego manda un id
    // invalido dos veces, tiene que enterarse igual. La deduplicacion es cosa
    // del servicio, despues de que todos sean validos.
    return {
        outfitIds: crudos.map((valor, i) => {
            const normalizado = typeof valor === 'number' ? String(valor) : valor;
            try {
                return parseOutfitId(normalizado);
            } catch {
                throw new ValidationError(`outfitIds[${i}] no es un id de outfit valido`);
            }
        }),
    };
}

// `limit` se restringe a un conjunto cerrado en lugar de a un rango. Un rango
// libre 1-50 permite a un llamador generar 50 variantes de clave por pagina y
// pulverizar el hit rate de la cache sin ganar nada; tres valores cubren
// cualquier interfaz real.
// Un cursor de Roblox es una cadena base64. Se valida la FORMA, no el
// contenido: solo Roblox sabe si un token concreto es valido, y adivinarlo no
// es asunto nuestro. Lo que si evita esta comprobacion es mandarle basura —
// comprobado en vivo que un token invalido le provoca un 500
// InternalServerError, que ademas nuestro limitador reintentaria dos veces
// antes de rendirse. Rechazar aqui la forma imposible ahorra esas tres
// llamadas y devuelve un 400 util en lugar de un 502 opaco.
const PAGE_TOKEN_PATTERN = /^[A-Za-z0-9+/=_-]{1,512}$/;

function parsePageToken(raw) {
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string' || raw === '') {
        throw new ValidationError('pageToken debe ser el nextPageToken devuelto por una consulta anterior');
    }

    // Un token base64 puede contener '+', y un '+' sin codificar dentro de una
    // query string se decodifica como ESPACIO. Como el espacio no existe en
    // base64, encontrarlo solo puede significar eso, asi que se restaura en
    // lugar de rechazar un token que en realidad estaba bien. (Aun asi, lo
    // correcto desde el juego es url-encodearlo.)
    const token = raw.replace(/ /g, '+');

    if (!PAGE_TOKEN_PATTERN.test(token)) {
        throw new ValidationError('pageToken tiene un formato invalido');
    }
    return token;
}

function parsePagination(query) {
    const { allowedLimits, defaultLimit } = config.pagination;

    // `page` se rechaza ACTIVAMENTE en lugar de ignorarse. Roblox lo acepta y
    // lo ignora en silencio: page=1, page=2 y page=3 devuelven exactamente los
    // mismos outfits (comprobado en vivo). Reenviarlo daria paginacion falsa,
    // e ignorarlo dejaria a quien lo mande convencido de estar paginando. Un
    // 400 que explica el mecanismo real es la unica opcion honesta.
    if (query.page !== undefined) {
        throw new ValidationError(
            'page no existe en esta API porque Roblox lo ignora (page=1 y page=2 devuelven lo mismo). ' +
            'Usa pageToken con el nextPageToken de la respuesta anterior.'
        );
    }

    const pageToken = parsePageToken(query.pageToken);

    let limit = defaultLimit;
    if (query.limit !== undefined) {
        // El typeof se comprueba antes de convertir porque Express entrega un
        // ARRAY cuando el parametro se repite (?limit=10&limit=25), y
        // Number(['10']) vale 10 — es decir, se colaria por la validacion.
        if (typeof query.limit !== 'string') {
            throw new ValidationError(`limit debe ser uno de: ${allowedLimits.join(', ')}`);
        }
        limit = Number(query.limit);
        if (!allowedLimits.includes(limit)) {
            throw new ValidationError(`limit debe ser uno de: ${allowedLimits.join(', ')}`);
        }
    }

    // Filtro por tipo de outfit. Se valida contra el conjunto de valores que
    // Roblox usa de verdad en lugar de reenviar cualquier cadena: asi un valor
    // mal escrito devuelve un 400 nuestro, explicito, en lugar de gastar una
    // llamada a Roblox para acabar traduciendo un error opaco suyo.
    let outfitType;
    if (query.outfitType !== undefined) {
        if (typeof query.outfitType !== 'string' || !config.outfitTypes.includes(query.outfitType)) {
            throw new ValidationError(`outfitType debe ser uno de: ${config.outfitTypes.join(', ')}`);
        }
        outfitType = query.outfitType;
    }

    return { limit, pageToken, outfitType };
}

// Bandera booleana de query. Solo se acepta la forma explicita "1" / "true" /
// "0" / "false": cualquier otra cosa es un error en vez de un silencioso
// "pues no". Para ?bundles=1 eso importa — activa un camino que cuesta
// llamadas extra a Roblox, y nadie deberia activarlo (ni creer que lo activo)
// por accidente.
function parseBooleanFlag(raw, label) {
    if (raw === undefined) return false;
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
    throw new ValidationError(`${label} debe ser 1 o 0`);
}

// ── Administracion de grupos autorizados ────────────────────────────────────

// El id de grupo se guarda como TEXT (ver src/db/schema.js): los ids de Roblox
// llegan como cadena y JavaScript no representa enteros grandes sin perder
// precision. Eso obliga a normalizar la FORMA aqui, porque en una clave
// primaria de texto "007" y "7" serian dos filas distintas para el mismo
// grupo — una autorizada y la otra no, segun como lo escribiera cada quien.
// Por eso se rechazan los ceros a la izquierda en vez de recortarlos en
// silencio: quien manda "007" probablemente tiene un bug, y devolverle un 400
// se lo enseña; recortarlo se lo esconde.
//
// La validacion NO es lo que protege de una inyeccion SQL — de eso se encargan
// las consultas parametrizadas, siempre, incluso con valores ya validados
// (ver src/db/pool.js). Esto es una frontera de coherencia de datos.
const GROUP_ID_PATTERN = /^[1-9][0-9]{0,19}$/;

function parseGroupId(raw, label = 'groupId') {
    if (typeof raw !== 'string' || raw.trim() === '') {
        throw new ValidationError(`${label} es obligatorio y debe ser el id numerico del grupo de Roblox, como texto`);
    }
    const groupId = raw.trim();
    if (!GROUP_ID_PATTERN.test(groupId)) {
        throw new ValidationError(
            `${label} debe ser un entero positivo sin ceros a la izquierda (hasta 20 digitos)`
        );
    }
    return groupId;
}

// Entero de query acotado, para `limit` y `offset` del listado. Aqui si es un
// rango y no un conjunto cerrado como en la paginacion de outfits: no hay
// cache que fragmentar detras, solo una consulta a nuestra propia base.
function parseBoundedInt(raw, label, { min, max, fallback }) {
    if (raw === undefined) return fallback;
    if (typeof raw !== 'string' || !/^[0-9]{1,9}$/.test(raw)) {
        throw new ValidationError(`${label} debe ser un entero entre ${min} y ${max}`);
    }
    const value = Number(raw);
    if (value < min || value > max) {
        throw new ValidationError(`${label} debe ser un entero entre ${min} y ${max}`);
    }
    return value;
}

// El listado se pagina SIEMPRE, aunque hoy la whitelist quepa en una pantalla:
// un SELECT sin LIMIT es una bomba de relojeria que solo explota el dia que la
// tabla ha crecido, y para entonces ya esta en produccion.
function parseGroupListQuery(query) {
    return {
        includeInactive: parseBooleanFlag(query.includeInactive, 'includeInactive'),
        limit: parseBoundedInt(query.limit, 'limit', { min: 1, max: 500, fallback: 100 }),
        offset: parseBoundedInt(query.offset, 'offset', { min: 0, max: 1_000_000, fallback: 0 }),
    };
}

// ── Datos de la licencia ────────────────────────────────────────────────────
//
// Todo lo que sigue es OPCIONAL: `undefined`, `null` y cadena vacia se
// traducen a `null` en vez de a un 400. Es deliberado y tiene dos motivos.
// Primero, las licencias dadas de alta antes de que existieran estos campos no
// los tienen y la API tiene que poder seguir hablando de ellas. Segundo, quien
// exige que el comprador venga completo es el BOT — que es quien conoce a los
// usuarios de Discord y valida el grupo contra Roblox antes de llamar —, y
// duplicar aqui esa regla como obligatoria dejaria la API inutilizable desde
// un curl para el caso legitimo de "autoriza este grupo y ya rellenare".

// Un id de Discord es un snowflake: entero de 64 bits en decimal. Se guarda
// como TEXT (misma razon que group_id: JavaScript no llega a 2^64 sin perder
// precision) y se valida la forma para que no acabe una mencion rota, un
// `<@123>` sin desenvolver o un nombre de usuario en la columna.
const DISCORD_ID_PATTERN = /^[0-9]{15,25}$/;

function parseDiscordId(raw, label) {
    if (raw === undefined || raw === null || raw === '') return null;
    const value = typeof raw === 'number' ? String(raw) : raw;
    if (typeof value !== 'string' || !DISCORD_ID_PATTERN.test(value.trim())) {
        throw new ValidationError(`${label} debe ser un id de Discord (solo digitos)`);
    }
    return value.trim();
}

function parseOptionalUsername(raw, label) {
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw !== 'string') {
        throw new ValidationError(`${label} debe ser el nombre de usuario de Roblox`);
    }
    try {
        return parseUsername(raw);
    } catch {
        // Se reemplaza el mensaje para que nombre el campo real: el de
        // parseUsername habla del "nombre de usuario" a secas, que en esta
        // ruta seria ambiguo (hay dos usuarios en juego, el de Roblox y el de
        // Discord).
        throw new ValidationError(`${label} debe tener entre 3 y 20 caracteres alfanumericos o guion bajo`);
    }
}

// Texto libre que ESCRIBE UNA PERSONA (el nombre del grupo tal como lo puso su
// dueño en Roblox, el motivo de una baja). Se acota la longitud y se eliminan
// los caracteres de control: van a acabar en un embed de Discord y en el log
// de acceso, y un salto de linea o un \r ahi permite falsificar la forma de
// una linea de log. El resto del texto se respeta tal cual — un nombre de
// grupo lleva espacios, acentos y emojis con todo el derecho.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

function parseFreeText(raw, label, maxLength) {
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw !== 'string') {
        throw new ValidationError(`${label} debe ser texto`);
    }
    const value = raw.replace(CONTROL_CHARS, ' ').trim();
    if (value === '') return null;
    if (value.length > maxLength) {
        throw new ValidationError(`${label} no puede pasar de ${maxLength} caracteres`);
    }
    return value;
}

// Metadatos del alta, tal como los manda el bot en el cuerpo del POST.
function parseGroupMeta(body) {
    return {
        discordUserId: parseDiscordId(body.discordUserId, 'discordUserId'),
        robloxUsername: parseOptionalUsername(body.robloxUsername, 'robloxUsername'),
        // 50 es el maximo de Roblox para el nombre de un grupo; el margen
        // cubre un cambio suyo sin que se caiga un alta por dos caracteres.
        groupName: parseFreeText(body.groupName, 'groupName', 64),
        addedBy: parseDiscordId(body.addedBy, 'addedBy'),
    };
}

// Confirmacion de identidad para rotar la credencial de una licencia.
//
// Los dos campos son OBLIGATORIOS, al contrario que en el alta. La diferencia
// no es capricho: en el alta son datos que se guardan y pueden faltar, aqui son
// una PRUEBA de que quien pide la rotacion sabe de que licencia habla. Rotar la
// credencial del grupo equivocado deja a un cliente fuera de su propio juego
// sin previo aviso, y entre dos ids de nueve cifras hay un dedo de distancia.
function parseTokenRegenerationBody(body) {
    if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new ValidationError(
            'Manda un cuerpo JSON con {"discordUserId":"...","robloxUsername":"..."} ' +
            'y la cabecera Content-Type: application/json'
        );
    }

    const discordUserId = parseDiscordId(body.discordUserId, 'discordUserId');
    if (discordUserId === null) {
        throw new ValidationError('discordUserId es obligatorio para confirmar la licencia');
    }

    const robloxUsername = parseOptionalUsername(body.robloxUsername, 'robloxUsername');
    if (robloxUsername === null) {
        throw new ValidationError('robloxUsername es obligatorio para confirmar la licencia');
    }

    return { discordUserId, robloxUsername };
}

// Motivo y autor de la baja. Van por QUERY y no en el cuerpo porque un DELETE
// con cuerpo es terreno resbaladizo: hay proxies y clientes HTTP que lo
// descartan en silencio, y perder el motivo de una baja sin enterarse es
// peor que escribirlo en la URL. Ninguno de los dos es un secreto.
function parseGroupRemovalQuery(query) {
    return {
        purge: parseBooleanFlag(query.purge, 'purge'),
        reason: parseFreeText(query.reason, 'reason', 300),
        actorId: parseDiscordId(query.actor, 'actor'),
    };
}

// ── Verificacion de licencia (POST /v1/license/verify) ──────────────────────

// EL TOKEN DE LICENCIA VIAJA POR CABECERA, `x-license-token`, y no en el
// cuerpo. El motivo es una limitacion real de Roblox, no una preferencia:
// `HttpService:GetSecret()` devuelve un objeto Secret que NO se puede
// serializar con `JSONEncode`. Un secreto guardado como Secret de Roblox
// —que es donde debe estar— simplemente no puede meterse en el body.
//
// Por cabecera si funciona, y ademas encaja con el resto del servicio: los
// otros dos secretos (`x-api-key`, `x-admin-key`) ya viajan asi, y las
// cabeceras no aparecen en la URL que si se registra (ver requestLogger.js).
//
// SON TRES CREDENCIALES DISTINTAS Y NO SE UNIFICAN:
//   x-api-key       -> "esto viene de un juego que usa el sistema". La misma
//                      para todos, vive dentro del .rbxl que se vende.
//   x-license-token -> "soy el grupo 35216530". Una por licencia, revocable
//                      de una en una.
//   x-admin-key     -> "puedo dar y quitar licencias". Solo /admin.
//
// Un token AUSENTE es 400 (falta una cabecera: fallo del script que llama).
// Un token PRESENTE que no autoriza es 403 con motivo. Esa distincion es la
// misma de antes y hay que conservarla: manda a mirar a sitios distintos.
function parseLicenseTokenHeader(headers) {
    const raw = headers?.['x-license-token'];

    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
        throw new ValidationError('Falta la cabecera x-license-token con el token de licencia');
    }
    // Node entrega un ARRAY si la cabecera llega repetida. Con dos tokens
    // distintos no hay forma honesta de elegir uno.
    if (typeof raw !== 'string') {
        throw new ValidationError('x-license-token debe enviarse una sola vez');
    }
    if (raw.length > 256) {
        throw new ValidationError('x-license-token no tiene un tamaño valido');
    }

    return raw.trim();
}

// ── Contexto de la EXPERIENCIA en las rutas de DATOS ────────────────────────
//
// Las tres rutas que consume el juego (GET /v1/users/..., GET /v1/outfits/...)
// no tienen cuerpo donde meter `gameId` y `placeId`, y los necesitan por el
// mismo motivo que /v1/license/verify: son el PUNTERO con el que se le
// pregunta a Roblox de quien es la experiencia. Asi que viajan por cabecera,
// igual que el token, en `x-game-id` y `x-place-id`.
//
// SON OBLIGATORIOS, y esa es la decision que sostiene todo lo demas. Si
// faltaran y la comprobacion se saltara sin ellos, quitar dos lineas del
// script bastaria para desactivar la verificacion de propiedad — que es
// exactamente lo que esa verificacion existe para impedir. No tener nada que
// comprobar no puede significar "adelante".
//
// Mismo reparto de codigos que en el resto del servicio: cabecera ausente o
// mal formada -> 400 (bug del script que llama, y decirselo claro es lo que le
// permite arreglarlo); propiedad que no cuadra -> 403 con motivo, y eso lo
// decide licenseService, no esto.
function parseSingleHeader(headers, name, maxLength = 64) {
    const raw = headers?.[name];

    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
        throw new ValidationError(`Falta la cabecera ${name} con el id de la experiencia`);
    }
    // Node entrega un ARRAY si la cabecera llega repetida. Con dos ids
    // distintos no hay forma honesta de elegir uno.
    if (typeof raw !== 'string') {
        throw new ValidationError(`${name} debe enviarse una sola vez`);
    }
    if (raw.length > maxLength) {
        throw new ValidationError(`${name} no tiene un tamaño valido`);
    }

    return raw.trim();
}

// Cabecera OPCIONAL de las que el juego DECLARA sobre si mismo. Ausente es
// ausente y no un error: son datos auxiliares que no deciden nada.
function parseOptionalHeader(headers, name, maxLength = 64) {
    const raw = headers?.[name];
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'string') {
        throw new ValidationError(`${name} debe enviarse una sola vez`);
    }
    const value = raw.trim();
    if (value === '') return null;
    if (value.length > maxLength) {
        throw new ValidationError(`${name} no tiene un tamaño valido`);
    }
    return value;
}

function parseLicenseContextHeaders(headers) {
    // `x-creator-type` y `x-creator-id` se aceptan y se REGISTRAN, pero no
    // entran en ninguna decision: son afirmaciones del .rbxl, que es un archivo
    // que esta en el ordenador del comprador. Sirven para que el log distinga
    // un script mal configurado de un intento deliberado de suplantacion — ver
    // detectarDeclaracionFalsa en licenseService.
    //
    // Se validan igual de estrictos que en el cuerpo de /v1/license/verify: un
    // valor mal escrito es un bug del script, y devolverle un 400 explicito se
    // lo enseña en vez de esconderselo.
    const creatorTypeRaw = parseOptionalHeader(headers, 'x-creator-type', 32);
    const creatorIdRaw = parseOptionalHeader(headers, 'x-creator-id');

    return {
        // Los dos que SI importan. `placeId` es a quien se le pregunta la
        // propiedad y `gameId` lo que se contrasta con el universo real.
        gameId: parseGroupId(parseSingleHeader(headers, 'x-game-id'), 'x-game-id'),
        placeId: parseGroupId(parseSingleHeader(headers, 'x-place-id'), 'x-place-id'),

        creatorType: creatorTypeRaw,
        creatorId: creatorIdRaw === null ? null : parseGroupId(creatorIdRaw, 'x-creator-id'),
    };
}

//
// Lo que manda el juego de Roblox. Se valida la FORMA aqui y se decide la
// AUTORIZACION en src/services/licenseService.js, y esa separacion importa:
//
//   - forma invalida (falta un campo, un id que no es un numero) -> 400
//     invalid_request. Es un fallo del script que llama, y decirselo claro es
//     lo que le permite arreglarlo.
//   - token que no autoriza -> 403 con motivo. Es una respuesta legitima a una
//     peticion bien hecha, no un error del cliente.
//
// El TOKEN se valida aqui solo como "es una cadena no vacia y de tamaño
// razonable". Que tenga la forma correcta NO se comprueba en esta capa a
// proposito: un token mal formado tiene que responder exactamente igual que
// uno desconocido (403 token_invalido), y un 400 lo delataria como distinto.
function parseLicenseVerifyBody(body) {
    if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new ValidationError(
            'Manda un cuerpo JSON con {"token","creatorType","creatorId","gameId","placeId"} ' +
            'y la cabecera Content-Type: application/json'
        );
    }

    // EL TOKEN YA NO VIAJA EN EL CUERPO. Si llega ahi, se rechaza con un
    // mensaje que dice donde va, en vez de ignorarlo en silencio: ignorarlo
    // acabaria en un 403 token_invalido y mandaria a revisar la licencia
    // cuando el problema es que el token nunca llego.
    if (body.token !== undefined) {
        throw new ValidationError(
            'El token de licencia va en la cabecera x-license-token, no en el cuerpo'
        );
    }

    // creatorType y creatorId son OPCIONALES desde que la propiedad se resuelve
    // contra Roblox. Y es coherente: son datos que el .rbxl puede falsificar,
    // asi que ya no deciden nada. Se aceptan si vienen — el script existente
    // los sigue mandando — para registrarlos y poder comparar lo declarado con
    // lo real, que es como se detecta un cliente manipulado.
    let creatorType = null;
    if (body.creatorType !== undefined && body.creatorType !== null) {
        if (typeof body.creatorType !== 'string' || body.creatorType.length > 32) {
            throw new ValidationError('creatorType debe ser texto ("Group" o "User")');
        }
        creatorType = body.creatorType.trim() || null;
    }

    return {
        creatorType,
        creatorId: body.creatorId === undefined || body.creatorId === null
            ? null
            : parseRobloxNumericId(body.creatorId, 'creatorId'),

        // Estos dos SI son obligatorios: `placeId` es el puntero con el que se
        // le pregunta a Roblox de quien es la experiencia, y `gameId` es lo que
        // se contrasta con el universo real de ese place. Sin ellos no hay
        // nada que comprobar.
        gameId: parseRobloxNumericId(body.gameId, 'gameId'),
        placeId: parseRobloxNumericId(body.placeId, 'placeId'),
    };
}

// Id numerico de Roblox tal como lo manda un script de Lua: normalmente un
// NUMERO (game.CreatorId), a veces ya una cadena. Se normaliza a texto porque
// asi esta guardado group_id — un id de Roblox moderno supera el entero seguro
// de JavaScript, y compararlos como numeros perderia precision justo en los
// ids mas nuevos.
function parseRobloxNumericId(raw, label) {
    if (typeof raw === 'number') {
        if (!Number.isSafeInteger(raw) || raw <= 0) {
            throw new ValidationError(`${label} debe ser un entero positivo`);
        }
        return String(raw);
    }
    return parseGroupId(raw, label);
}

// ── Catalogo por lotes (POST /v1/catalog/batch) ─────────────────────────────
//
// TODOS LOS IDS SALEN DE AQUI COMO TEXTO, aunque lleguen como numero. Un id de
// Roblox cabe hoy en un entero seguro de JavaScript, pero el margen se estrecha
// cada año y una comparacion que pierda precision es imposible de depurar
// despues. Se normalizan una vez, en la frontera, y de ahi para dentro todo el
// servicio habla de cadenas — igual que ya se hace con group_id.
function parseIdList(raw, label, max) {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
        throw new ValidationError(`${label} debe ser una lista de ids`);
    }
    if (raw.length > max) {
        throw new ValidationError(`${label} admite como maximo ${max} ids por peticion (llegaron ${raw.length})`);
    }

    // Se deduplica DESPUES de validar cada uno: si el juego manda un id
    // invalido repetido, tiene que enterarse igual.
    return [...new Set(raw.map((valor, i) => parseRobloxNumericId(valor, `${label}[${i}]`)))];
}

function parseCatalogBatchBody(body) {
    if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new ValidationError(
            'Manda un cuerpo JSON con {"token","gameId","placeId","assetIds":[...]} ' +
            'y la cabecera Content-Type: application/json'
        );
    }

    const { maxAssetIds, maxBundleIds, maxTotalIds } = config.catalogBatch;

    const assetIds = parseIdList(body.assetIds, 'assetIds', maxAssetIds);
    const bundleIds = parseIdList(body.bundleIds, 'bundleIds', maxBundleIds);

    if (assetIds.length === 0 && bundleIds.length === 0) {
        throw new ValidationError('Manda al menos un id en assetIds o en bundleIds');
    }
    if (assetIds.length + bundleIds.length > maxTotalIds) {
        throw new ValidationError(
            `assetIds + bundleIds no puede pasar de ${maxTotalIds} ids por peticion`
        );
    }

    // Booleano de verdad, no "1"/"true": esto viene en un cuerpo JSON, donde el
    // tipo existe. La forma laxa es para las query strings, que no lo tienen.
    let resolveBundles = true;
    if (body.resolveBundles !== undefined) {
        if (typeof body.resolveBundles !== 'boolean') {
            throw new ValidationError('resolveBundles debe ser true o false');
        }
        resolveBundles = body.resolveBundles;
    }

    return { assetIds, bundleIds, resolveBundles };
}

// ── Plugin privado de Roblox Studio (POST /plugin/outfits/search) ───────────
//
// Cliente: el plugin "7x Outfit Importer", que corre DENTRO de Roblox Studio
// y no dentro de un juego. Por eso no valida token de licencia ni ids de
// experiencia: no hay `game.GameId` real que comprobar en Studio, y esta
// primera version existe solo para verificar la conexion plugin -> API.
//
// Se valida aqui, en la frontera, y no en el handler, por lo mismo que el
// resto: cada unidad de `amount` es una llamada potencial a Roblox (el avatar
// de un candidato no admite lote), asi que un numero absurdo tiene que costar
// microsegundos en vez de trafico saliente.
const PLUGIN_SEARCH_MIN_AMOUNT = 1;
const PLUGIN_SEARCH_MAX_AMOUNT = 500;

// Entero JSON acotado por abajo y, opcionalmente, por arriba. Separado de
// parseBoundedInt, que resuelve el caso de las QUERY STRINGS y por eso espera
// una cadena de digitos: aqui los valores vienen de un cuerpo JSON, donde el
// tipo numero existe de verdad.
//
// NUMERO, NO CADENA. `JSONEncode({amount = 100})` en Lua produce un numero,
// asi que aceptar tambien "100" solo serviria para que un plugin que manda el
// texto de una caja sin convertirlo pareciera funcionar, y fallara mas tarde
// al usar el valor para contar o comparar precios.
function parsePluginInt(raw, label, { min, max = null }) {
    // Con un techo enorme (el entero seguro de JS, para los ids) el rango no
    // se imprime: "entre 1 y 9007199254740991" no ayuda a nadie. Se dice lo
    // que de verdad hay que corregir.
    const limite = max === null || max === Number.MAX_SAFE_INTEGER
        ? `mayor o igual que ${min}`
        : `entre ${min} y ${max}`;
    const invalido = () => new ValidationError(`${label} debe ser un numero entero ${limite}`);

    // `typeof NaN` e `Infinity` son 'number': la comprobacion de entero es la
    // que de verdad los para, asi que el orden importa.
    if (typeof raw !== 'number' || !Number.isInteger(raw)) throw invalido();
    if (raw < min) throw invalido();
    if (max !== null && raw > max) throw invalido();
    return raw;
}

function parsePluginSearchBody(body) {
    if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new ValidationError(
            'Manda un cuerpo JSON con {"amount": 100, "groupId": 59218460} ' +
            'y la cabecera Content-Type: application/json'
        );
    }

    const amount = parsePluginInt(body.amount, 'amount', {
        min: PLUGIN_SEARCH_MIN_AMOUNT, max: PLUGIN_SEARCH_MAX_AMOUNT,
    });

    // OBLIGATORIO: sin grupo no hay a quien buscar.
    //
    // ESTRICTAMENTE NUMERO JSON, y a proposito NO se usa aqui
    // parseRobloxNumericId (el parser compartido con creatorId / gameId /
    // placeId, que acepta tambien la cadena "59218460"). Esta ruta tiene un
    // solo cliente, el plugin, y su contrato es estricto: 59218460, no
    // "59218460". Un id que llega como texto es señal de que el plugin lo saco
    // de una caja sin convertirlo, y dejarlo pasar solo aplaza el problema.
    //
    // El techo de PLUGIN_MAX_GROUP_ID no es decorativo: por encima del entero
    // seguro de JavaScript, Number ya no distingue dos ids contiguos, y
    // consultariamos un grupo distinto del pedido sin enterarnos.
    const groupId = parsePluginInt(body.groupId, 'groupId', {
        min: 1, max: Number.MAX_SAFE_INTEGER,
    });

    // minPrice / maxPrice son OPCIONALES, al contrario que los dos anteriores.
    // Ausentes significan "sin suelo" y "sin techo", que es el comportamiento
    // util por defecto: quien no filtra por precio no deberia tener que
    // escribir 0 y un numero enorme para decirlo. Si vienen, se validan.
    const minPrice = body.minPrice === undefined || body.minPrice === null
        ? 0
        : parsePluginInt(body.minPrice, 'minPrice', { min: 0 });

    const maxPrice = body.maxPrice === undefined || body.maxPrice === null
        ? null
        : parsePluginInt(body.maxPrice, 'maxPrice', { min: 0 });

    // El rango se comprueba DESPUES de validar los dos por separado, para que
    // un maxPrice negativo se explique como negativo y no como "menor que
    // minPrice", que mandaria a mirar el campo equivocado.
    if (maxPrice !== null && maxPrice < minPrice) {
        throw new ValidationError(`maxPrice (${maxPrice}) no puede ser menor que minPrice (${minPrice})`);
    }

    // POLITICA DE VALORACION. Opcional, y por defecto ESTRICTA para no cambiarle
    // el significado a ningun cliente que ya llame sin mandarla.
    //
    //   true  (default) -> solo entran outfits que se pudieron valorar ENTEROS.
    //                      El totalPrice es exacto: no falta nada por contar.
    //   false           -> entran tambien los que llevan alguna pieza no
    //                      comprable (fuera de venta, limitada sin reventa,
    //                      retirada), siempre que algo se haya podido valorar.
    //                      El totalPrice es entonces el coste de lo comprable, y
    //                      cada outfit dice con priceComplete si esta entero.
    //
    const requireCompletePrice = parsePluginBool(body.requireCompletePrice, 'requireCompletePrice', true);

    // MODO ASINCRONO. Opcional y por defecto APAGADO, para que el plugin que ya
    // existe siga funcionando exactamente igual sin tocar una linea.
    //
    //   false (default) -> POST responde cuando la busqueda termina.
    //   true            -> POST responde con un searchId en cuanto arranca, y el
    //                      progreso se consulta con GET. Es lo unico que permite
    //                      enseñar una barra real: RequestAsync de Roblox no
    //                      devuelve nada hasta que el servidor acaba.
    const asincrono = parsePluginBool(body.async, 'async', false);

    return { amount, groupId, minPrice, maxPrice, requireCompletePrice, async: asincrono };
}

// Booleano de un cuerpo JSON. Estricto a proposito: aqui el tipo existe de
// verdad, y aceptar "1"/"true" solo serviria para que un cliente que manda el
// texto de una casilla pareciera funcionar. La forma laxa es para las query
// strings, que no tienen tipos (ver parseBooleanFlag).
function parsePluginBool(raw, label, porDefecto) {
    if (raw === undefined || raw === null) return porDefecto;
    if (typeof raw !== 'boolean') {
        throw new ValidationError(`${label} debe ser true o false`);
    }
    return raw;
}

// Identificador de una busqueda asincrona, tal como lo emite jobs.js: el
// prefijo "s_" y 32 hexadecimales (128 bits de aleatoriedad). Se valida la FORMA antes de ir al registro
// para que una ruta con basura no llegue siquiera a buscarse, y sobre todo para
// que nada raro acabe en el log de acceso a traves de la URL.
const SEARCH_ID_PATTERN = /^s_[0-9a-f]{32}$/;

function parseSearchId(raw) {
    if (typeof raw !== 'string' || !SEARCH_ID_PATTERN.test(raw)) {
        throw new ValidationError('searchId no tiene el formato de un identificador de busqueda');
    }
    return raw;
}

module.exports = {
    ValidationError,
    parseCatalogBatchBody,
    parsePluginSearchBody,
    parseSearchId,
    parseLicenseVerifyBody,
    parseLicenseTokenHeader,
    parseLicenseContextHeaders,
    parseRobloxNumericId,
    parseUsername,
    parseUserId,
    parseOutfitId,
    parseOutfitBatchBody,
    parsePagination,
    parsePageToken,
    parseBooleanFlag,
    parseGroupId,
    parseGroupListQuery,
    parseDiscordId,
    parseFreeText,
    parseGroupMeta,
    parseGroupRemovalQuery,
    parseTokenRegenerationBody,
};
