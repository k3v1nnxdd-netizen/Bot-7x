'use strict';

// Tests del anuncio de mejoras (boosts). Sin red y sin Discord.
//
// Lo que protegen, que es justo lo que no se ve probando a mano (nadie va a
// boostear el servidor cinco veces para comprobar un plural):
//
//   1. SÓLO SE ANUNCIA UN BOOST QUE EMPIEZA. El evento llega para CUALQUIER
//      cambio de un miembro — un rol, un apodo, un timeout. Si se anunciara
//      cualquiera de ellos, cada vez que un booster cambiara de rol el canal
//      diría que acaba de boostear.
//   2. UN MIEMBRO SIN CACHEAR NO SE ANUNCIA. Si Discord no dice cómo estaba
//      antes, no se puede afirmar que ANTES no boosteaba. Ante la duda, callar:
//      un anuncio falso es peor que uno que falta.
//   3. EL CONTADOR SE PIDE FRESCO. El evento del miembro y el que actualiza el
//      número de mejoras del servidor son distintos y no hay orden garantizado,
//      así que la caché puede tener el número de ANTES del boost — el único que
//      no se puede anunciar.
//   4. EL PLURAL SE CALCULA. "ahora tenemos 1 mejoras" en el primer boost es el
//      detalle que delata un anuncio hecho a medias.
//   5. LA ANIMACIÓN SE ADJUNTA COMO .gif. El fichero del repo se llama .png
//      pero es un GIF; Discord decide por la extensión del ADJUNTO si lo anima,
//      así que con .png se publicaría congelado.
//   6. NADA DE ESTO LANZA. Un fallo publicando el anuncio no puede tumbar el
//      manejador de GuildMemberUpdate, por el que pasan todos los cambios de
//      todos los miembros.

const { createSuite } = require('./testHarness');
const config = require('../../config');
const { handleBoost, __test } = require('../../handlers/boost');

const AVATAR = 'https://cdn.discordapp.com/avatars/1/abc.png';

// Miembro falso. `partial: true` = Discord no dijo cómo estaba antes.
function miembro({ id = '100', premium = null, partial = false, guild = null, client = null } = {}) {
    return {
        id,
        partial,
        premiumSince: premium,
        user: { tag: `usuario-${id}` },
        guild,
        client,
        displayAvatarURL: () => AVATAR,
    };
}

// Servidor falso: `cacheado` es lo que hay en caché, `fresco` lo que devolvería
// la API. Distintos a propósito, para ver cuál de los dos se acaba anunciando.
function servidor({ cacheado = 1, fresco = 2, fallaFetch = false } = {}) {
    const g = {
        premiumSubscriptionCount: cacheado,
        fetch: async () => {
            if (fallaFetch) throw new Error('500 Internal Server Error');
            return { premiumSubscriptionCount: fresco };
        },
    };
    return g;
}

function clienteFalso({ canalNulo = false, fallaSend = false } = {}) {
    const enviados = [];
    const canal = {
        id: config.CHANNELS.BOOST,
        send: async payload => {
            if (fallaSend) throw new Error('50013: Missing Permissions');
            enviados.push(payload);
            return { id: 'm1' };
        },
    };
    return {
        enviados,
        channels: {
            cache: new Map(canalNulo ? [] : [[config.CHANNELS.BOOST, canal]]),
            fetch: async () => (canalNulo ? null : canal),
        },
    };
}

// Lanza el evento como lo haría main.js. Cada caso usa un id distinto porque el
// anti-duplicado es por usuario y dura un minuto.
async function evento(id, { antes, ahora, guild, client }) {
    const g = guild ?? servidor();
    const c = client ?? clienteFalso();
    await handleBoost(
        antes === undefined ? undefined : miembro({ id, premium: antes.premium, partial: antes.partial }),
        miembro({ id, premium: ahora.premium, guild: g, client: c })
    );
    return c;
}

const AYER = new Date(Date.now() - 86_400_000);
const HOY  = new Date();

module.exports = async function run() {
    const { assert, finish } = createSuite('boost');

    // ── 1. Qué cuenta como boost y qué no ────────────────────────────────────
    const casos = [
        ['sin boostear -> boosteando',       { premiumSince: null },      { premiumSince: HOY },  true,  'un boost que empieza SÍ se anuncia'],
        ['ya boosteaba, cambia otra cosa',   { premiumSince: AYER },      { premiumSince: AYER }, false, 'un cambio de rol de alguien que ya boosteaba NO se anuncia'],
        ['deja de boostear',                 { premiumSince: AYER },      { premiumSince: null }, false, 'dejar de boostear tampoco se anuncia'],
        ['nunca ha boosteado',               { premiumSince: null },      { premiumSince: null }, false, 'un cambio cualquiera de alguien que no boostea no se anuncia'],
    ];
    for (const [, antes, ahora, esperado, mensaje] of casos) {
        assert(__test.esBoostNuevo(antes, ahora) === esperado, mensaje);
    }

    assert(
        __test.esBoostNuevo({ partial: true }, { premiumSince: HOY }) === false,
        'un miembro que no estaba en caché no se anuncia: no se sabe cómo estaba antes'
    );
    assert(__test.esBoostNuevo(undefined, { premiumSince: HOY }) === false, 'sin miembro anterior, tampoco');
    assert(__test.esBoostNuevo({ premiumSince: null }, null) === false, 'y sin miembro nuevo no se rompe');

    // ── 2. El contador se pide fresco ────────────────────────────────────────
    assert(await __test.contarMejoras(servidor({ cacheado: 1, fresco: 7 })) === 7, 'se anuncia el número que da la API, no el de la caché');
    assert(
        await __test.contarMejoras(servidor({ cacheado: 4, fresco: 9, fallaFetch: true })) === 4,
        'y si la API falla se usa la caché en vez de no anunciar nada'
    );

    // ── 3. El plural ─────────────────────────────────────────────────────────
    assert(__test.frase('1', 1).includes('**1** mejora!'), 'con una sola mejora se dice "mejora"');
    assert(__test.frase('1', 2).includes('**2** mejoras!'), 'con dos, "mejoras"');
    assert(__test.frase('1', 0).includes('**0** mejoras!'), 'y con cero, "mejoras"');

    // ── 4. La tarjeta ────────────────────────────────────────────────────────
    const embed = __test.buildBoostEmbed('555', 3, AVATAR).toJSON();

    assert(embed.color === __test.COLOR, 'el embed es gris');
    assert(embed.description.includes('<@555>'), 'menciona a quien ha boosteado');
    assert(embed.description.startsWith(__test.E.boost), 'y el emoji de boost abre el mensaje');
    assert(embed.description.includes(__test.E.boosters), 'el emoji de boosters acompaña al número');
    assert(embed.thumbnail?.url === AVATAR, 'el avatar va de thumbnail: arriba a la derecha');
    assert(embed.footer?.text === '7x Community • Sistema de boosts', 'y lleva el pie del sistema');
    assert(Boolean(embed.timestamp), 'con su hora, como la tarjeta de reseñas');

    // Los emojis del servidor sólo se pintan en la descripción: en un título o
    // en el footer se imprimirían crudos, como <a:boost:1547…>.
    assert(!(embed.title ?? '').includes('<a:'), 'ningún emoji del servidor en el título');
    assert(!(embed.footer?.text ?? '').includes('<a:'), 'ni en el footer');

    const sinAvatar = __test.buildBoostEmbed('555', 3, null).toJSON();
    assert(!sinAvatar.thumbnail, 'sin avatar la tarjeta sale igual, sin thumbnail vacío');

    // ── 5. La animación, adjunta como .gif ───────────────────────────────────
    if (__test.IMAGEN.exists) {
        const payload = __test.buildBoostPayload('555', 3, AVATAR);
        assert(payload.files?.length === 1, 'la animación se adjunta al mensaje');
        assert(payload.files[0].name.endsWith('.gif'), `el adjunto va con extensión .gif o Discord lo congela (${payload.files[0].name})`);
        assert(
            payload.embeds[0].toJSON().image?.url === `attachment://${payload.files[0].name}`,
            'y el embed la enseña abajo del todo, referenciando ese adjunto'
        );
    }

    // ── 6. De punta a punta ──────────────────────────────────────────────────
    const c1 = await evento('201', { antes: { premium: null }, ahora: { premium: HOY }, guild: servidor({ cacheado: 1, fresco: 5 }) });
    assert(c1.enviados.length === 1, 'un boost publica exactamente un mensaje');
    assert(c1.enviados[0].embeds[0].toJSON().description.includes('**5**'), 'con el número fresco de mejoras');

    const c2 = await evento('202', { antes: { premium: AYER }, ahora: { premium: AYER } });
    assert(c2.enviados.length === 0, 'un cambio que no es un boost no publica nada');

    // El mismo evento repetido (reintento de la pasarela, dos shards) no puede
    // publicar dos veces.
    const cliente = clienteFalso();
    await evento('203', { antes: { premium: null }, ahora: { premium: HOY }, client: cliente });
    await evento('203', { antes: { premium: null }, ahora: { premium: HOY }, client: cliente });
    assert(cliente.enviados.length === 1, 'un evento repetido del mismo usuario no anuncia dos veces');

    // ── 7. Nada de esto puede lanzar ─────────────────────────────────────────
    let reventó = false;
    try {
        await evento('204', { antes: { premium: null }, ahora: { premium: HOY }, client: clienteFalso({ canalNulo: true }) });
        await evento('205', { antes: { premium: null }, ahora: { premium: HOY }, client: clienteFalso({ fallaSend: true }) });
        await evento('206', { antes: { premium: null }, ahora: { premium: HOY }, guild: servidor({ fallaFetch: true }) });
    } catch {
        reventó = true;
    }
    assert(!reventó, 'ni un canal que no existe, ni un send rechazado, ni un fetch caído lanzan');

    return finish();
};
