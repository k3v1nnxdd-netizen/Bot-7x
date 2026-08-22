'use strict';

// Tests for the group license system (/addgroup, /deletegroup, /checkgroup,
// /groups) — the bot half of it. NO network and NO Discord client: everything
// here is either a pure builder or the pure part of the outfit-api client.
//
// The two things these tests exist to protect are the two that would hurt
// most and that a manual smoke test would never catch:
//
//   1. THE ADMIN KEY NEVER ESCAPES. An axios error carries the request
//      headers — admin key included — so the failure path is exactly where a
//      secret leaks into a public embed or a Railway log. Every error shape
//      that can reach a user gets checked against the real secret value.
//   2. A LICENSE IS NEVER SILENTLY DROPPED FROM THE LISTING. The paging
//      arithmetic is the only place /groups can lose a paying customer, and
//      it would look completely normal on screen.

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

    // El mensaje del 404 de grupo SÍ se reenvía tal cual (lo escribimos
    // nosotros y solo contiene el id); el de un error desconocido NO.
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

    // ── Embed de /addgroup ──────────────────────────────────────────────────

    const alta = gl.buildAddedEmbed({
        licencia: licencia(),
        nombreGrupo: 'Mi Grupo',
        iconUrl: 'https://tr.rbxcdn.com/icono.png',
        actorId: ADMIN_ID,
    });
    const altaJson = alta.toJSON();

    assert(altaJson.color === 0x6FCF97, 'el embed de alta usa el verde suave de "completado" (#6FCF97)');
    assert(altaJson.title === 'Licencia agregada', 'el título es exactamente "Licencia agregada"');
    assert(altaJson.thumbnail?.url === 'https://tr.rbxcdn.com/icono.png', 'el icono real del grupo va como thumbnail (arriba a la derecha)');
    assert(campo(alta, 'Estado') === 'Activa ✅', 'muestra el estado como "Activa ✅"');
    assert(campo(alta, 'Group ID').includes(GROUP_ID), 'muestra el Group ID');
    assert(
        campo(alta, 'Usuario de Discord').includes(`<@${DISCORD_ID}>`) && campo(alta, 'Usuario de Discord').includes(DISCORD_ID),
        'muestra el usuario de Discord como mención Y como ID'
    );
    assert(campo(alta, 'Usuario de Roblox') === 'CompradorRblx', 'muestra el usuario de Roblox del comprador');
    assert(campo(alta, 'Agregado por') === `<@${ADMIN_ID}>`, 'muestra quién agregó la licencia');
    assert(
        campo(alta, 'Alta original').includes('<t:1768473000:F>') && campo(alta, 'Alta original').includes('<t:1768473000:R>'),
        'la fecha de alta usa timestamps de Discord: completa y relativa'
    );
    assert(
        campo(alta, 'Enlace actual').includes('<t:1769936400:F>'),
        'la fecha del enlace actual es distinta de la del alta y también es un timestamp de Discord'
    );
    assert(campo(alta, 'Tipo').includes('nueva'), 'una licencia recién creada se anuncia como nueva');

    const reactivada = gl.buildAddedEmbed({
        licencia: licencia({ created: false }),
        nombreGrupo: 'Mi Grupo',
        iconUrl: null,
        actorId: ADMIN_ID,
    });
    assert(campo(reactivada, 'Tipo').includes('reactivada'), 'una licencia que ya existía se anuncia como reactivada');
    assert(reactivada.toJSON().thumbnail === undefined, 'sin icono de Roblox el embed sigue construyéndose igual');

    // ── Ni secretos ni URLs internas en NINGÚN embed ────────────────────────

    const todosLosEmbeds = [
        alta,
        reactivada,
        gl.buildRemovedEmbed({
            licencia: licencia({ active: false, deactivatedAt: '2026-03-02T18:00:00.000Z', deactivatedBy: ADMIN_ID, deactivationReason: 'Reembolso' }),
            nombreGrupo: 'Mi Grupo', iconUrl: null, actorId: ADMIN_ID, motivo: 'Reembolso',
        }),
        gl.buildCheckEmbed({ estado: { ...licencia(), authorized: true, found: true }, groupId: GROUP_ID, nombreGrupo: 'Mi Grupo', iconUrl: null, miembros: 1234 }),
        gl.buildListEmbed({ groups: [licencia()], total: 1, pagina: 0, paginas: 1, truncado: false }),
    ];
    assert(
        todosLosEmbeds.every(e => !serializado(e).includes(SECRETO)),
        'ningún embed contiene la clave de administración'
    );
    assert(
        todosLosEmbeds.every(e => !serializado(e).includes('railway.internal') && !serializado(e).includes(URL_INTERNA)),
        'ningún embed contiene la URL interna de la API'
    );

    // ── Embed de /deletegroup ───────────────────────────────────────────────

    const baja = gl.buildRemovedEmbed({
        licencia: licencia({ active: false, deactivatedAt: '2026-03-02T18:00:00.000Z', deactivatedBy: ADMIN_ID, deactivationReason: 'Reembolso' }),
        nombreGrupo: 'Mi Grupo',
        iconUrl: 'https://tr.rbxcdn.com/icono.png',
        actorId: ADMIN_ID,
        motivo: 'Reembolso',
    });
    assert(baja.toJSON().color === 0xE57373, 'la baja usa un rojo suave, no un rojo chillón');
    assert(baja.toJSON().title === '⛔ Licencia desactivada', 'el título es "⛔ Licencia desactivada"');
    assert(campo(baja, 'Estado') === 'Inactiva', 'el estado que muestra es "Inactiva"');
    assert(campo(baja, 'Motivo') === 'Reembolso', 'muestra el motivo de la baja');
    assert(campo(baja, 'Desactivado por') === `<@${ADMIN_ID}>`, 'muestra quién la desactivó');
    assert(
        campo(baja, 'Alta original').includes('<t:1768473000:F>'),
        'la baja sigue mostrando la fecha de alta original: la fila no se borra'
    );

    const sinMotivo = gl.buildRemovedEmbed({
        licencia: licencia({ active: false }), nombreGrupo: null, iconUrl: null, actorId: ADMIN_ID, motivo: null,
    });
    assert(campo(sinMotivo, 'Motivo') === 'No especificado', 'sin motivo se dice "No especificado", nunca "undefined"');
    assert(campo(sinMotivo, 'Grupo') === '—', 'un grupo sin nombre guardado no imprime "null"');

    // ── Embed de /checkgroup: tres estados, tres colores ────────────────────

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
        groupId: GROUP_ID, nombreGrupo: null, iconUrl: null, miembros: null,
    });

    assert(activa.toJSON().color === 0x6FCF97, 'autorizado -> verde');
    assert(inactiva.toJSON().color === 0xF2994A, 'desactivado -> naranja');
    assert(nunca.toJSON().color === 0x9AA0A6, 'nunca existió -> gris');
    assert(
        campo(activa, 'Autorizado ahora') === 'Sí' && campo(inactiva, 'Autorizado ahora') === 'No' && campo(nunca, 'Autorizado ahora') === 'No',
        'los tres dicen explícitamente si el grupo está autorizado AHORA'
    );
    assert(campo(inactiva, 'Motivo') === 'Chargeback', 'una licencia retirada explica por qué se retiró');
    assert(campo(activa, 'Motivo') === undefined, 'una licencia activa no arrastra un campo "Motivo" vacío');
    assert(
        campo(nunca, 'Alta original') === '—' && campo(nunca, 'Usuario de Roblox') === '—',
        'un grupo sin licencia muestra guiones, no "null" ni "undefined"'
    );
    // El separador de miles depende del ICU del entorno (es-ES no agrupa los
    // numeros de 4 cifras), asi que se comprueba el COMPORTAMIENTO — hay
    // numero cuando Roblox lo da, guion cuando no — y no una cadena concreta.
    assert(
        campo(activa, 'Miembros').replace(/\D/g, '') === '1234',
        'el número de miembros que devuelve Roblox se muestra'
    );
    assert(campo(inactiva, 'Miembros') === '—', 'si Roblox no responde, el número de miembros es un guion y no "null"');

    // ── Embed de /groups ────────────────────────────────────────────────────

    const lista = [
        licencia({ groupId: '111', groupName: 'Grupo Uno', active: true, robloxUsername: 'UnoRblx' }),
        licencia({ groupId: '222', groupName: 'Grupo Dos', active: true, robloxUsername: 'DosRblx' }),
        licencia({ groupId: '333', groupName: 'Grupo Tres', active: false, robloxUsername: 'TresRblx' }),
    ];
    const listado = gl.buildListEmbed({ groups: lista, total: 3, pagina: 0, paginas: 1, truncado: false });
    const desc = listado.toJSON().description;

    assert(
        desc.includes('**Total:** 3') && desc.includes('**Activas:** 2') && desc.includes('**Inactivas:** 1'),
        'el listado muestra total, activas e inactivas'
    );
    assert(
        desc.includes('✅ **Grupo Uno** — `111`') && desc.includes('⛔ **Grupo Tres** — `333`'),
        'cada línea lleva el estado, el nombre y el Group ID en el formato pedido'
    );
    assert(
        desc.includes(`<@${DISCORD_ID}> • UnoRblx`),
        'cada licencia muestra el Discord enlazado y el usuario de Roblox'
    );
    assert(
        listado.toJSON().footer.text.startsWith('Página 1/1'),
        'el pie indica en qué página se está'
    );
    // El listado NO usa un color de estado (verde/rojo/naranja): mezclaría un
    // significado que no tiene, porque en la misma lista conviven activas e
    // inactivas. Usa el gris neutro que ya llevan el resto de paneles del bot.
    assert(listado.toJSON().color === 0x2B2D31, 'el listado usa el gris neutro del resto de paneles del bot');

    const vacio = gl.buildListEmbed({ groups: [], total: 0, pagina: 0, paginas: 1, truncado: false });
    assert(
        vacio.toJSON().description.includes('Total:** 0') && vacio.toJSON().description.includes('No hay ninguna licencia'),
        'sin licencias el listado lo dice en vez de mostrar un embed roto'
    );

    const truncado = gl.buildListEmbed({ groups: lista, total: 5000, pagina: 0, paginas: 1, truncado: true });
    assert(
        truncado.toJSON().fields.some(f => f.name.includes('incompleto')),
        'un listado que no cabe entero lo AVISA en vez de fingir que están todas'
    );

    // ── Límites de Discord con datos en el peor caso ────────────────────────
    // Un embed que pasa de 4096 caracteres de descripción o de 1024 en un
    // campo no se muestra: Discord rechaza el mensaje entero. Se comprueba
    // con el nombre de grupo más largo que la API acepta (64) y una página
    // completa.
    const largo = 'G'.repeat(64);
    const pagina = Array.from({ length: gl.GRUPOS_POR_PAGINA }, (_, i) =>
        licencia({ groupId: '9'.repeat(20), groupName: largo, robloxUsername: 'U'.repeat(20), discordUserId: DISCORD_ID, active: i % 2 === 0 })
    );
    const pesado = gl.buildListEmbed({ groups: pagina, total: 8, pagina: 0, paginas: 1, truncado: true });
    assert(pesado.toJSON().description.length <= 4096, 'una página llena de nombres larguísimos sigue cabiendo en la descripción');

    const embedsPesados = [
        pesado,
        gl.buildAddedEmbed({ licencia: licencia({ groupName: largo, robloxUsername: 'U'.repeat(20) }), nombreGrupo: largo, iconUrl: null, actorId: ADMIN_ID }),
        gl.buildCheckEmbed({
            estado: { ...licencia({ active: false, deactivationReason: 'M'.repeat(300), deactivatedAt: CREATED_AT, deactivatedBy: ADMIN_ID }), authorized: false, found: true },
            groupId: GROUP_ID, nombreGrupo: largo, iconUrl: null, miembros: 999999,
        }),
    ];
    assert(
        embedsPesados.every(e => {
            const json = e.toJSON();
            const fields = json.fields ?? [];
            return fields.length <= 25 &&
                fields.every(f => f.name.length <= 256 && f.value.length <= 1024) &&
                (json.description?.length ?? 0) <= 4096;
        }),
        'ningún embed supera los límites de Discord (25 campos, 256/1024, 4096)'
    );

    // ── Texto hostil ────────────────────────────────────────────────────────

    const hostil = gl.buildListEmbed({
        groups: [licencia({ groupId: '444', groupName: '**__Grupo__** `roto`', robloxUsername: 'Rblx' })],
        total: 1, pagina: 0, paginas: 1, truncado: false,
    });
    assert(
        !hostil.toJSON().description.includes('**__Grupo__**'),
        'un nombre de grupo con markdown se escapa: nadie puede deformar el embed nombrando así su grupo'
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
