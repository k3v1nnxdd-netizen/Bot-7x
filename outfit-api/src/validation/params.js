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

module.exports = {
    ValidationError,
    parseUsername,
    parseUserId,
    parseOutfitId,
    parsePagination,
    parsePageToken,
    parseBooleanFlag,
    parseGroupId,
    parseGroupListQuery,
};
