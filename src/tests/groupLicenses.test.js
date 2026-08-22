'use strict';

// Tests for the group license system (/addgroup, /deletegroup, /checkgroup,
// /groups) — the bot half of it. NO network and NO Discord client: everything
// here is either a pure builder or the pure part of the outfit-api client.
//
// The things these tests exist to protect are the ones that would hurt most
// and that a manual smoke test would never catch:
//
//   1. THE ADMIN KEY NEVER ESCAPES. An axios error carries the request
//      headers — admin key included — so the failure path is exactly where a
//      secret leaks into a public embed or a Railway log. Every error shape
//      that can reach a user gets checked against the real secret value.
//   2. A LICENSE IS NEVER SILENTLY DROPPED FROM THE LISTING. The paging
//      arithmetic is the only place /groups can lose a paying customer, and
//      it would look completely normal on screen.
//   3. THE SERVER EMOJIS ONLY GO WHERE DISCORD RENDERS THEM. Custom emoji
//      work in a message's content, an embed's description and a field's
//      VALUE — and nowhere else. Put one in a title, a field NAME or the
//      footer and it prints as raw `<a:add:1540603311890104321>` in a public
//      message. Nothing in the code can warn about that, so a test does.

// Set BEFORE requiring the client: it reads process.env once, at load time,
// exactly like the rest of this project's config modules.
const SECRETO = 'clave-admin-de-prueba-nunca-debe-aparecer';
const URL_INTERNA = 'https://outfit-api-interna.railway.internal';
process.env.OUTFIT_ADMIN_API_KEY = SECRETO;
process.env.OUTFIT_API_URL = URL_INTERNA;

const { createSuite } = require('./testHarness');
const outfitApi = require('../../utils/outfitApi');
const { __test: gl } = require('../../handlers/groupLicenses');

const { normalizeBaseUrl, toSafeError } = outfitApi.__test;

const GROUP_ID = '35216530';
const DISCORD_ID = '996310284803248158';
const ADMIN_ID = '346085763638886400';
const CREATED_AT = '2026-01-15T10:30:00.000Z';
const LINKED_AT = '2026-02-01T09:00:00.000Z';

// Los cinco emojis del servidor, escritos aquí a mano a propósito: si alguien
// cambia un id en handlers/groupLicenses.js, este archivo tiene que discrepar.
const E = {
    grupo:   '<:followers7x:1525326777071960124>',
    roblox:  '<:roblox:1501213275482886205>',
    discord: '<a:dccc:1540604144325369907>',
    alta:    '<a:add:1540603311890104321>',
    baja:    '<a:remove:1540604743234228364>',
};

// Cualquier emoji unicode (✅, ⛔, 🆕, ⚠️...). `Extended_Pictographic` los
// cubre todos sin tener que enumerarlos.
const UNICODE_EMOJI = /\p{Extended_Pictographic}/u;
// La forma de un emoji del servidor: `<:nombre:id>` o `<a:nombre:id>`.
const EMOJI_SERVIDOR = /<a?:[a-zA-Z0-9_]+:\d+>/;

// A license exactly as outfit-api returns it.
const licencia = (overrides = {}) => ({
    groupId: GROUP_ID,
    active: true,
    createdAt: CREATED_AT,
    linkedAt: LINKED_AT,
    discordUserId: DISCORD_ID,
    robloxUsername: 'CompradorRblx',
    groupName: 'Mi Grupo',
    addedBy: ADMIN_ID,
    deactivatedAt: null,
    deactivatedBy: null,
    deactivationReason: null,
    created: true,
    ...overrides,
});

// An axios error with the shape the real one has, secret header included:
// that header is the whole reason toSafeError() exists.
function axiosError(status, body) {
    const err = new Error(`Request failed with status code ${status}`);
    err.response = { status, data: body, headers: {} };
    err.config = {
        url: `${URL_INTERNA}/admin/groups`,
        headers: { 'x-admin-key': SECRETO, 'Content-Type': 'application/json' },
    };
    return err;
}

function transportError(code) {
    const err = new Error(`connect ${code}`);
    err.code = code;
    err.config = { url: `${URL_INTERNA}/admin/groups`, headers: { 'x-admin-key': SECRETO } };
    return err;
}

const serializado = embed => JSON.stringify(embed.toJSON());
const campo = (embed, nombre) => embed.toJSON().fields?.find(f => f.name === nombre)?.value;
const desc = embed => embed.toJSON().description ?? '';

module.exports = async function run() {
    const suite = createSuite('groupLicenses');
    const { assert } = suite;

    // ── La URL de la API tolera como esté escrita en Railway ─────────────────

    assert(
        normalizeBaseUrl('https://api.example.com') === 'https://api.example.com' &&
        normalizeBaseUrl('https://api.example.com/') === 'https://api.example.com' &&
        normalizeBaseUrl('api.example.com') === 'https://api.example.com' &&
        normalizeBaseUrl('https://api.example.com/admin/groups') === 'https://api.example.com',
        'normalizeBaseUrl acepta la URL con o sin esquema, barra final o el endpoint completo pegado'
    );
    assert(
        normalizeBaseUrl('') === null && normalizeBaseUrl(undefined) === null && normalizeBaseUrl('   ') === null,
        'normalizeBaseUrl devuelve null cuando la variable no está puesta'
    );

    // ── El secreto no sale por ninguna vía de error ──────────────────────────

    const errores = [
        toSafeError(axiosError(401, { error: { code: 'unauthorized', message: 'Falta o es incorrecta la cabecera x-admin-key' } })),
        toSafeError(axiosError(503, { error: { code: 'database_unavailable', message: 'La base no responde' } })),
        toSafeError(axiosError(503, { error: { code: 'admin_disabled', message: 'falta ADMIN_API_KEY' } })),
        toSafeError(axiosError(429, { error: { code: 'rate_limited', message: 'demasiadas peticiones' } })),
        toSafeError(axiosError(404, { error: { code: 'route_not_found', message: 'no existe' } })),
        toSafeError(axiosError(404, { error: { code: 'group_not_found', message: `El grupo ${GROUP_ID} no esta en la whitelist` } })),
        toSafeError(axiosError(400, { error: { code: 'invalid_request', message: 'groupId debe ser un entero positivo' } })),
        toSafeError(axiosError(500, { error: { code: 'internal_error', message: 'Error interno del servidor' } })),
        toSafeError(axiosError(418, 'respuesta que no es JSON')),
        toSafeError(transportError('ECONNREFUSED')),
        toSafeError(transportError('ECONNABORTED')),
        toSafeError(new Error('algo raro sin forma de axios')),
    ];

    assert(
        errores.every(e => !e.message.includes(SECRETO) && !e.stack?.includes(SECRETO)),
        'ningún error mostrable contiene la clave de administración'
    );
    assert(
        errores.every(e => !e.message.includes(URL_INTERNA) && !e.message.includes('railway.internal')),
        'ningún error mostrable contiene la URL interna de la API'
    );
    assert(
        errores.every(e => e instanceof outfitApi.OutfitApiError && typeof e.code === 'string' && e.message.length > 0),
        'toSafeError siempre devuelve un OutfitApiError con código y mensaje'
    );

    assert(
        toSafeError(axiosError(401, {})).code === 'unauthorized' &&
        toSafeError(axiosError(503, { error: { code: 'database_unavailable' } })).code === 'database_unavailable' &&
        toSafeError(axiosError(404, { error: { code: 'group_not_found', message: 'x' } })).code === 'group_not_found' &&
        toSafeError(transportError('ECONNABORTED')).code === 'timeout' &&
        toSafeError(transportError('ECONNREFUSED')).code === 'unreachable',
        'cada fallo se clasifica con su propio código para que el handler pueda reaccionar'
    );

    assert(
        toSafeError(axiosError(404, { error: { code: 'group_not_found', message: 'El grupo 123 no esta en la whitelist' } }))
            .message.includes('123'),
        'el mensaje de "grupo no encontrado" se muestra tal cual: es nuestro y es útil'
    );
    assert(
        !toSafeError(axiosError(500, { error: { code: 'internal_error', message: 'ERROR: relation "x" does not exist at pg.js:44' } }))
            .message.includes('pg.js'),
        'un mensaje de error desconocido NO se reenvía: puede arrastrar detalles internos'
    );

    // ── Validación del Group ID antes de gastar una llamada ─────────────────

    assert(
        gl.validarGroupId('35216530') === '35216530' && gl.validarGroupId('  35216530  ') === '35216530',
        'validarGroupId acepta un id real y recorta espacios'
    );
    assert(
        ['', '0', '007', 'abc', '-5', '12 34', '1;DROP TABLE group_whitelist', null, undefined]
            .every(malo => gl.validarGroupId(malo) === null),
        'validarGroupId rechaza vacío, cero, ceros a la izquierda, texto y basura'
    );

    // ── Paginación: ninguna licencia puede perderse ─────────────────────────

    const muchas = Array.from({ length: 21 }, (_, i) => ({ groupId: String(i + 1), active: i < 15 }));
    const paginas = gl.paginar(muchas);
    assert(paginas.length === 3, 'paginar reparte 21 licencias en 3 páginas de 8');
    assert(
        paginas.flat().length === muchas.length &&
        paginas.flat().map(g => g.groupId).join(',') === muchas.map(g => g.groupId).join(','),
        'paginar no pierde ni reordena ninguna licencia'
    );
    assert(gl.paginar([]).length === 1 && gl.paginar([])[0].length === 0, 'una lista vacía sigue siendo una página (vacía)');

    // ── /addgroup ───────────────────────────────────────────────────────────

    const alta = gl.buildAddedEmbed({
        licencia: licencia(),
        nombreGrupo: 'Mi Grupo',
        iconUrl: 'https://tr.rbxcdn.com/icono.png',
        actorId: ADMIN_ID,
    });
    const altaJson = alta.toJSON();

    assert(altaJson.color === 0x2ECC71, 'el embed de alta usa el verde de "completado" (#2ECC71)');
    assert(altaJson.title === 'Licencia agregada', 'el título es exactamente "Licencia agregada"');
    assert(altaJson.thumbnail?.url === 'https://tr.rbxcdn.com/icono.png', 'el icono real del grupo va como thumbnail (arriba a la derecha)');
    assert(desc(alta).startsWith(`${E.alta} **Activa**`), 'la primera línea es el emoji de alta + el estado');
    assert(desc(alta).includes(`${E.grupo} **Mi Grupo**`), 'el nombre del grupo lleva el emoji de grupo del servidor');
    assert(desc(alta).includes(`\`${GROUP_ID}\``), 'el Group ID va en la misma línea que el nombre');
    assert(
        desc(alta).includes(`${E.discord} <@${DISCORD_ID}> · \`${DISCORD_ID}\``),
        'el usuario de Discord lleva su emoji, la mención Y el id en una sola línea'
    );
    assert(desc(alta).includes(`${E.roblox} \`CompradorRblx\``), 'el usuario de Roblox lleva el emoji de Roblox');
    assert(desc(alta).includes('Licencia nueva'), 'una licencia recién creada se anuncia como nueva');
    assert(campo(alta, 'Agregado por') === `<@${ADMIN_ID}>`, 'muestra quién agregó la licencia');
    assert(
        campo(alta, 'Alta original').includes('<t:1768473000:f>') && campo(alta, 'Alta original').includes('<t:1768473000:R>'),
        'la fecha de alta usa timestamps de Discord: completa y relativa'
    );
    assert(
        campo(alta, 'Enlace actual').includes('<t:1769936400:f>'),
        'la fecha del enlace actual es distinta de la del alta y también es un timestamp de Discord'
    );
    assert(
        altaJson.fields.length === 4,
        'el embed de alta es compacto: una fila de tres campos más el estado de la credencial'
    );

    const reactivada = gl.buildAddedEmbed({
        licencia: licencia({ created: false }), nombreGrupo: 'Mi Grupo', iconUrl: null, actorId: ADMIN_ID,
        credencial: gl.CREDENCIAL.conservada,
    });
    assert(desc(reactivada).includes('Licencia reactivada'), 'una licencia que ya existía se anuncia como reactivada');
    assert(reactivada.toJSON().thumbnail === undefined, 'sin icono de Roblox el embed sigue construyéndose igual');

    // ── La credencial: el token JAMÁS puede acabar en un embed público ──────

    const TOKEN = '7xl_' + 'A'.repeat(43);

    const conToken = gl.buildAddedEmbed({
        licencia: licencia({ token: TOKEN, tokenIssued: true }),
        nombreGrupo: 'Mi Grupo', iconUrl: null, actorId: ADMIN_ID,
        credencial: gl.CREDENCIAL.entregada,
    });

    // ESTA es la assert que más importa de todo el archivo: los embeds de
    // licencias son públicos, y publicar la credencial de un cliente en un
    // canal es entregársela a todo el que pase por ahí. Y no se puede
    // deshacer: lo que se publica en Discord ya se ha visto.
    assert(
        !serializado(conToken).includes(TOKEN) && !serializado(conToken).includes('7xl_'),
        'el token NO aparece en el embed público ni aunque venga en la licencia'
    );
    assert(
        campo(conToken, 'Credencial') === gl.CREDENCIAL.entregada,
        'el embed dice que se emitió y se entregó, sin decir el qué'
    );
    assert(
        campo(reactivada, 'Credencial') === gl.CREDENCIAL.conservada,
        'una reactivación deja claro que el grupo conserva su token de siempre'
    );
    assert(
        gl.CREDENCIAL.noEntregada.length > 0 &&
        campo(gl.buildAddedEmbed({
            licencia: licencia({ token: TOKEN, tokenIssued: true }),
            nombreGrupo: 'G', iconUrl: null, actorId: ADMIN_ID, credencial: gl.CREDENCIAL.noEntregada,
        }), 'Credencial') === gl.CREDENCIAL.noEntregada,
        'y si la entrega falla, el embed lo dice en vez de fingir que salió bien'
    );

    // El mensaje efímero: es el ÚNICO sitio donde el token puede aparecer.
    const privado = gl.mensajeDeToken({ token: TOKEN, groupId: GROUP_ID }, 'Mi Grupo');
    assert(privado.includes(TOKEN), 'el mensaje privado sí lleva el token: es su único momento');
    assert(privado.includes('```'), 'va en un bloque de código para poder copiarlo de una pieza');
    assert(
        privado.includes('una sola vez') && privado.toLowerCase().includes('hash'),
        'y explica que no se puede volver a consultar, porque la API solo guarda su hash'
    );
    assert(privado.length <= 2000, 'cabe en el límite de un mensaje de Discord');

    // ── /deletegroup ────────────────────────────────────────────────────────

    const baja = gl.buildRemovedEmbed({
        licencia: licencia({ active: false, deactivatedAt: '2026-03-02T18:00:00.000Z', deactivatedBy: ADMIN_ID, deactivationReason: 'Reembolso' }),
        nombreGrupo: 'Mi Grupo',
        iconUrl: 'https://tr.rbxcdn.com/icono.png',
        actorId: ADMIN_ID,
        motivo: 'Reembolso',
    });
    assert(baja.toJSON().color === 0xE74C3C, 'la baja usa un rojo contenido, no el rojo de alarma');
    assert(baja.toJSON().title === 'Licencia desactivada', 'el título es texto limpio, sin emoji que no renderizaría');
    assert(desc(baja).startsWith(`${E.baja} **Inactiva**`), 'la primera línea es el emoji de remover + el estado');
    assert(desc(baja).includes(`${E.grupo} **Mi Grupo**`) && desc(baja).includes(`${E.roblox}`), 'repite el mismo bloque de identidad que /addgroup');
    assert(campo(baja, 'Motivo') === 'Reembolso', 'muestra el motivo de la baja');
    assert(campo(baja, 'Desactivado por') === `<@${ADMIN_ID}>`, 'muestra quién la desactivó');
    assert(
        campo(baja, 'Alta original').includes('<t:1768473000:f>'),
        'la baja sigue mostrando la fecha de alta original: la fila no se borra'
    );
    assert(baja.toJSON().fields.length === 4, 'la baja son tres fechas/autor en fila más el motivo: nada más');

    const sinMotivo = gl.buildRemovedEmbed({
        licencia: licencia({ active: false }), nombreGrupo: null, iconUrl: null, actorId: ADMIN_ID, motivo: null,
    });
    assert(campo(sinMotivo, 'Motivo') === 'No especificado', 'sin motivo se dice "No especificado", nunca "undefined"');
    assert(desc(sinMotivo).includes('Grupo sin nombre'), 'un grupo sin nombre guardado no imprime "null"');

    // ── /checkgroup: tres estados, tres colores ─────────────────────────────

    const activa = gl.buildCheckEmbed({
        estado: { ...licencia(), authorized: true, found: true },
        groupId: GROUP_ID, nombreGrupo: 'Mi Grupo', iconUrl: null, miembros: 1234,
    });
    const inactiva = gl.buildCheckEmbed({
        estado: {
            ...licencia({ active: false, deactivatedAt: '2026-03-02T18:00:00.000Z', deactivatedBy: ADMIN_ID, deactivationReason: 'Chargeback' }),
            authorized: false, found: true,
        },
        groupId: GROUP_ID, nombreGrupo: 'Mi Grupo', iconUrl: null, miembros: null,
    });
    const nunca = gl.buildCheckEmbed({
        estado: {
            groupId: GROUP_ID, authorized: false, found: false, active: false, createdAt: null, linkedAt: null,
            discordUserId: null, robloxUsername: null, groupName: null, addedBy: null,
            deactivatedAt: null, deactivatedBy: null, deactivationReason: null,
        },
        groupId: GROUP_ID, nombreGrupo: 'Grupo Ajeno', iconUrl: null, miembros: 500,
    });

    assert(activa.toJSON().color === 0x2ECC71, 'autorizado -> verde');
    assert(inactiva.toJSON().color === 0xE67E22, 'desactivado -> naranja');
    assert(nunca.toJSON().color === 0x7F8C8D, 'nunca existió -> gris');
    assert(
        desc(activa).startsWith(`${E.alta} **Autorizado**`) &&
        desc(inactiva).startsWith(`${E.baja} **Licencia retirada**`) &&
        desc(nunca).startsWith('**Sin licencia**'),
        'los tres dicen en la primera línea si el grupo está autorizado AHORA'
    );
    assert(campo(inactiva, 'Motivo') === 'Chargeback', 'una licencia retirada explica por qué se retiró');
    assert(campo(activa, 'Motivo') === undefined && activa.toJSON().fields.length === 2,
        'una licencia activa no arrastra campos de baja vacíos');
    assert(
        (nunca.toJSON().fields ?? []).length === 0 && desc(nunca).includes(`${E.grupo} **Grupo Ajeno**`),
        'un grupo sin licencia no imprime una rejilla de guiones: solo lo que Roblox sí sabe de él'
    );
    assert(
        !desc(nunca).includes(E.discord) && !desc(nunca).includes(E.roblox),
        'sin licencia no hay comprador que enseñar, así que no se enseñan sus líneas'
    );
    assert(
        desc(activa).replace(/\D/g, '').includes('1234'),
        'el número de miembros que devuelve Roblox se muestra junto al grupo'
    );
    assert(
        !desc(inactiva).includes('miembros'),
        'si Roblox no responde, no se inventa un número de miembros'
    );

    // ── /groups ─────────────────────────────────────────────────────────────

    const lista = [
        licencia({ groupId: '111', groupName: 'Grupo Uno', active: true, robloxUsername: 'UnoRblx' }),
        licencia({ groupId: '222', groupName: 'Grupo Dos', active: true, robloxUsername: 'DosRblx' }),
        licencia({ groupId: '333', groupName: 'Grupo Tres', active: false, robloxUsername: 'TresRblx' }),
    ];
    const listado = gl.buildListEmbed({ groups: lista, total: 3, pagina: 0, paginas: 1, truncado: false });

    assert(
        desc(listado).startsWith('**3** licencias · **2** activas · **1** inactivas'),
        'el listado abre con total, activas e inactivas en una sola línea'
    );
    assert(
        desc(listado).includes(`${E.alta} **Grupo Uno** · \`111\``) &&
        desc(listado).includes(`${E.baja} **Grupo Tres** · \`333\``),
        'cada línea marca el estado con el emoji de alta o de remover, y lleva nombre e id'
    );
    assert(
        desc(listado).includes(`${E.discord} <@${DISCORD_ID}> · ${E.roblox} \`UnoRblx\``),
        'la segunda línea de cada licencia lleva Discord y Roblox con sus emojis'
    );
    assert(
        !desc(listado).includes(`\`${DISCORD_ID}\``),
        'el listado NO repite el id de Discord en crudo: ocho veces por página lo convierte en un muro'
    );
    assert(listado.toJSON().footer.text.startsWith('Página 1/1'), 'el pie indica en qué página se está');
    assert(listado.toJSON().color === 0x4F545C, 'el listado usa un gris pizarra neutro, no un color de estado');

    const vacio = gl.buildListEmbed({ groups: [], total: 0, pagina: 0, paginas: 1, truncado: false });
    assert(
        desc(vacio).includes('**0** licencias') && desc(vacio).includes('No hay ninguna licencia'),
        'sin licencias el listado lo dice en vez de mostrar un embed roto'
    );

    const truncado = gl.buildListEmbed({ groups: lista, total: 5000, pagina: 0, paginas: 1, truncado: true });
    assert(
        truncado.toJSON().fields.some(f => f.name === 'Listado incompleto'),
        'un listado que no cabe entero lo AVISA en vez de fingir que están todas'
    );

    const sinComprador = gl.buildListEmbed({
        groups: [licencia({ groupId: '555', groupName: 'Antigua', discordUserId: null, robloxUsername: null })],
        total: 1, pagina: 0, paginas: 1, truncado: false,
    });
    assert(
        desc(sinComprador).includes('Sin Discord') && desc(sinComprador).includes('Sin Roblox'),
        'una licencia antigua sin comprador guardado se lista igual, diciéndolo'
    );

    // ── Emojis: los del servidor, y solo donde Discord los pinta ────────────

    const todosLosEmbeds = [alta, reactivada, conToken, baja, sinMotivo, activa, inactiva, nunca, listado, vacio, truncado, sinComprador];

    assert(
        todosLosEmbeds.every(e => !UNICODE_EMOJI.test(serializado(e))),
        'ningún embed lleva emojis unicode: solo los del servidor'
    );
    assert(
        todosLosEmbeds.every(e => {
            const j = e.toJSON();
            return !EMOJI_SERVIDOR.test(j.title ?? '') &&
                !EMOJI_SERVIDOR.test(j.footer?.text ?? '') &&
                !EMOJI_SERVIDOR.test(j.author?.name ?? '') &&
                (j.fields ?? []).every(f => !EMOJI_SERVIDOR.test(f.name));
        }),
        'ningún emoji del servidor va en un título, un nombre de campo o un pie: ahí Discord los imprimiría en crudo'
    );
    assert(
        [E.grupo, E.roblox, E.discord, E.alta, E.baja].every(emoji =>
            todosLosEmbeds.some(e => serializado(e).includes(emoji))
        ),
        'los cinco emojis del servidor se usan de verdad, con sus ids exactos'
    );

    // ── Ni secretos ni URLs internas en NINGÚN embed ────────────────────────

    assert(
        todosLosEmbeds.every(e => !serializado(e).includes(SECRETO)),
        'ningún embed contiene la clave de administración'
    );
    assert(
        todosLosEmbeds.every(e => !/7xl_/.test(serializado(e))),
        'ningún embed contiene un token de licencia, venga de donde venga'
    );
    assert(
        todosLosEmbeds.every(e => !serializado(e).includes('railway.internal') && !serializado(e).includes(URL_INTERNA)),
        'ningún embed contiene la URL interna de la API'
    );

    // ── Límites de Discord con datos en el peor caso ────────────────────────
    // Un embed que pasa de 4096 caracteres de descripción o de 1024 en un
    // campo no se muestra: Discord rechaza el mensaje entero. Se comprueba con
    // el nombre de grupo más largo que la API acepta (64), una página completa
    // y el marcado de los emojis, que también ocupa.
    const largo = 'G'.repeat(64);
    const pagina = Array.from({ length: gl.GRUPOS_POR_PAGINA }, (_, i) =>
        licencia({ groupId: '9'.repeat(20), groupName: largo, robloxUsername: 'U'.repeat(20), discordUserId: DISCORD_ID, active: i % 2 === 0 })
    );
    const pesados = [
        gl.buildListEmbed({ groups: pagina, total: 8, pagina: 0, paginas: 1, truncado: true }),
        gl.buildAddedEmbed({ licencia: licencia({ groupName: largo, robloxUsername: 'U'.repeat(20) }), nombreGrupo: largo, iconUrl: null, actorId: ADMIN_ID }),
        gl.buildCheckEmbed({
            estado: { ...licencia({ active: false, deactivationReason: 'M'.repeat(300), deactivatedAt: CREATED_AT, deactivatedBy: ADMIN_ID }), authorized: false, found: true },
            groupId: GROUP_ID, nombreGrupo: largo, iconUrl: null, miembros: 999999,
        }),
    ];
    assert(
        pesados.every(e => {
            const j = e.toJSON();
            const fields = j.fields ?? [];
            return fields.length <= 25 &&
                fields.every(f => f.name.length <= 256 && f.value.length <= 1024) &&
                (j.description?.length ?? 0) <= 4096;
        }),
        'ningún embed supera los límites de Discord (25 campos, 256/1024, 4096) ni con los datos más largos posibles'
    );

    // ── Texto hostil ────────────────────────────────────────────────────────

    const hostil = gl.buildListEmbed({
        groups: [licencia({ groupId: '444', groupName: '**__Grupo__** `roto`', robloxUsername: 'Rblx' })],
        total: 1, pagina: 0, paginas: 1, truncado: false,
    });
    assert(
        !desc(hostil).includes('**__Grupo__**'),
        'un nombre de grupo con markdown se escapa: nadie puede deformar el embed nombrando así su grupo'
    );

    const conBackticks = gl.buildListEmbed({
        groups: [licencia({ groupId: '4`4`4', groupName: 'X', robloxUsername: 'a`b' })],
        total: 1, pagina: 0, paginas: 1, truncado: false,
    });
    assert(
        (desc(conBackticks).match(/`/g) || []).length % 2 === 0,
        'las comillas invertidas de un valor no pueden dejar un code span abierto'
    );

    // ── Botones de paginación ───────────────────────────────────────────────

    const primera = gl.buildListRow(0, 3).toJSON().components;
    const ultima = gl.buildListRow(2, 3).toJSON().components;
    assert(primera[0].disabled === true && primera[1].disabled === false, 'en la primera página "Anterior" está deshabilitado');
    assert(ultima[0].disabled === false && ultima[1].disabled === true, 'en la última página "Siguiente" está deshabilitado');
    assert(
        primera[1].custom_id === 'gl_groups:1' && ultima[0].custom_id === 'gl_groups:1',
        'el customId lleva la página destino, así que los botones siguen funcionando tras un reinicio'
    );

    return suite.finish();
};
