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

const { MessageType } = require('discord.js');
const { createSuite } = require('./testHarness');
const config = require('../../config');
const { handleBoost, handleBoostMessage, __test } = require('../../handlers/boost');

const AVATAR = 'https://cdn.discordapp.com/avatars/1/abc.png';

// El mensaje de sistema con el que Discord anuncia un boost: sin contenido, con
// el tipo puesto y con el booster de autor.
function mensajeSistema({ id = '300', tipo, guild = null, client = null } = {}) {
    return {
        type: tipo,
        guild: guild ?? servidor(),
        client: client ?? clienteFalso(),
        content: '',
        author: { id, displayAvatarURL: () => AVATAR },
        member: { displayAvatarURL: () => AVATAR },
    };
}

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
    // El avatar va en la línea de AUTOR, no de thumbnail. De thumbnail Discord
    // lo pinta grande arriba a la derecha y le roba el ancho a la descripción:
    // el texto queda estrecho y se lee pequeño al lado de la foto.
    assert(embed.author?.icon_url === AVATAR, 'el avatar va como icono del autor: pequeño y redondo, encima del texto');
    assert(embed.author?.name === __test.AUTOR, `la línea de autor dice "${__test.AUTOR}"`);
    assert(!embed.thumbnail, 'y NO hay thumbnail: la descripción se queda con todo el ancho');
    assert(embed.footer?.text === '7x Community • Sistema de boosts', 'y lleva el pie del sistema');
    assert(Boolean(embed.timestamp), 'con su hora, como la tarjeta de reseñas');

    // Los emojis del servidor sólo se pintan en la descripción: en un título o
    // en el footer se imprimirían crudos, como <a:boost:1547…>.
    assert(!(embed.title ?? '').includes('<a:'), 'ningún emoji del servidor en el título');
    assert(!(embed.footer?.text ?? '').includes('<a:'), 'ni en el footer');

    const sinAvatar = __test.buildBoostEmbed('555', 3, null).toJSON();
    assert(!sinAvatar.thumbnail, 'sin avatar la tarjeta sale igual, sin thumbnail vacío');
    assert(sinAvatar.author?.name === __test.AUTOR && !sinAvatar.author.icon_url, 'y la línea de autor sale sin icono, no con uno roto');

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

    // ── 7. El segundo detector: el mensaje de sistema de Discord ─────────────
    // Existe porque discord.js SÓLO emite GuildMemberUpdate si el miembro está
    // en la caché: con Partials.GuildMember desactivado, su handler hace
    // guild.members.cache.get(id) y, si no lo encuentra, emite
    // GuildMemberAvailable en su lugar. Discord manda al arrancar sólo los
    // miembros conectados de un servidor grande, así que sin este segundo
    // camino un booster que llevara callado desde el último reinicio no se
    // anunciaría NUNCA.
    for (const tipo of [MessageType.GuildBoost, MessageType.GuildBoostTier1, MessageType.GuildBoostTier2, MessageType.GuildBoostTier3]) {
        assert(__test.TIPOS_BOOST.has(tipo), `el tipo de mensaje ${tipo} cuenta como boost`);
    }
    for (const tipo of [MessageType.Default, MessageType.Reply, MessageType.UserJoin, MessageType.ChannelPinnedMessage]) {
        assert(!__test.TIPOS_BOOST.has(tipo), `el tipo de mensaje ${tipo} NO cuenta como boost`);
    }

    const c3 = clienteFalso();
    await handleBoostMessage(mensajeSistema({ id: '301', tipo: MessageType.GuildBoost, guild: servidor({ fresco: 8 }), client: c3 }));
    assert(c3.enviados.length === 1, 'un mensaje de sistema de boost publica el anuncio');
    assert(c3.enviados[0].embeds[0].toJSON().description.includes('<@301>'), 'menciona al autor del mensaje, que es quien boosteó');
    assert(c3.enviados[0].embeds[0].toJSON().description.includes('**8**'), 'y con el número fresco de mejoras');

    const c4 = clienteFalso();
    await handleBoostMessage(mensajeSistema({ id: '302', tipo: MessageType.Default, client: c4 }));
    await handleBoostMessage(mensajeSistema({ id: '303', tipo: MessageType.UserJoin, client: c4 }));
    assert(c4.enviados.length === 0, 'un mensaje normal o una bienvenida no anuncian nada');

    const c5 = clienteFalso();
    const sinGuild = mensajeSistema({ id: '304', tipo: MessageType.GuildBoost, client: c5 });
    sinGuild.guild = null;
    await handleBoostMessage(sinGuild);
    await handleBoostMessage(null);
    assert(c5.enviados.length === 0, 'un mensaje sin servidor (o sin mensaje) no rompe ni anuncia');

    // ── 8. Los dos detectores juntos anuncian UNA vez ────────────────────────
    // Lo normal es que un boost dispare los dos: el evento del miembro y el
    // mensaje de sistema. El candado por usuario es lo que lo deja en uno.
    const c6 = clienteFalso();
    const g6 = servidor({ fresco: 4 });
    await evento('305', { antes: { premium: null }, ahora: { premium: HOY }, guild: g6, client: c6 });
    await handleBoostMessage(mensajeSistema({ id: '305', tipo: MessageType.GuildBoost, guild: g6, client: c6 }));
    assert(c6.enviados.length === 1, 'el mismo boost visto por los dos detectores se anuncia UNA vez');

    // Y al revés: si llega antes el mensaje de sistema, tampoco se duplica.
    const c7 = clienteFalso();
    const g7 = servidor({ fresco: 4 });
    await handleBoostMessage(mensajeSistema({ id: '306', tipo: MessageType.GuildBoost, guild: g7, client: c7 }));
    await evento('306', { antes: { premium: null }, ahora: { premium: HOY }, guild: g7, client: c7 });
    assert(c7.enviados.length === 1, 'da igual cuál de los dos llegue primero');

    // Dos personas distintas sí son dos anuncios.
    const c8 = clienteFalso();
    await handleBoostMessage(mensajeSistema({ id: '307', tipo: MessageType.GuildBoost, client: c8 }));
    await handleBoostMessage(mensajeSistema({ id: '308', tipo: MessageType.GuildBoost, client: c8 }));
    assert(c8.enviados.length === 2, 'dos personas distintas son dos anuncios');

    // ── 9. Nada de esto puede lanzar ─────────────────────────────────────────
    let reventó = false;
    try {
        await evento('204', { antes: { premium: null }, ahora: { premium: HOY }, client: clienteFalso({ canalNulo: true }) });
        await evento('205', { antes: { premium: null }, ahora: { premium: HOY }, client: clienteFalso({ fallaSend: true }) });
        await evento('206', { antes: { premium: null }, ahora: { premium: HOY }, guild: servidor({ fallaFetch: true }) });
        await handleBoostMessage(mensajeSistema({ id: '309', tipo: MessageType.GuildBoost, client: clienteFalso({ fallaSend: true }) }));
        await handleBoostMessage(mensajeSistema({ id: '310', tipo: MessageType.GuildBoost, client: clienteFalso({ canalNulo: true }) }));
    } catch {
        reventó = true;
    }
    assert(!reventó, 'ni un canal que no existe, ni un send rechazado, ni un fetch caído lanzan');

    return finish();
};
