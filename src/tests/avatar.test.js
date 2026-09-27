'use strict';

// Tests de /avatar: la ficha de un usuario de Roblox. Sin red.
//
// Lo que protegen:
//
//   1. PREMIUM SÓLO SE AFIRMA CON UN `true`. La API abierta de Roblox NO
//      publica el Premium de nadie: hace falta Open Cloud con el permiso
//      `user.advanced:read`, y si no lo hay el dato llega como null. null es
//      "no se sabe", y colgarle a alguien el cartel de no-Premium por un fallo
//      de permisos es afirmar algo que no se ha comprobado.
//   2. UN NÚMERO QUE NO SE PUDO CONSULTAR SALE COMO "—", NO COMO 0. Decir que
//      alguien tiene 0 amigos porque Roblox no contestó es inventar.
//   3. EL NOMBRE VA EN LA DESCRIPCIÓN, NO EN setTitle(). Discord no pinta los
//      emojis del servidor en el título de un embed: la insignia de Premium
//      saldría ahí como `<:premium:123>` en crudo.
//   4. LOS NÚMEROS VAN EN EL PIE. Es lo que ya se pinta pequeño, en gris y
//      debajo de la imagen — que es como se pidió.
//   5. SEGUIDORES Y SEGUIDOS SON ENDPOINTS DISTINTOS. Roblox los llama
//      "followers" y "followings": intercambiarlos deja los dos números
//      cambiados sin que nada falle.

const fs = require('fs');
const path = require('path');

const { createSuite } = require('./testHarness');
const config = require('../../config');
const roblox = require('../../src/roblox/client');
const { __test: cmd } = require('../../handlers/commands');

const RAIZ = path.join(__dirname, '..', '..');

const USUARIO = { id: 140258990, name: 'KreekCraft', displayName: 'Kreek', hasVerifiedBadge: false };

function ficha(extra = {}) {
    return cmd.buildAvatarEmbed({
        user: USUARIO,
        uid: USUARIO.id,
        avatarUrl: 'https://tr.rbxcdn.com/algo/420/420/Avatar/Png/noFilter',
        plus: null,
        seguidores: 2742038,
        amigos: 971,
        siguiendo: 82,
        ...extra,
    }).toJSON();
}

module.exports = async function run() {
    const { assert, finish } = createSuite('avatar');

    // ── 1. Registrado y enrutado ─────────────────────────────────────────────
    const MAIN = fs.readFileSync(path.join(RAIZ, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
    assert(/name: 'avatar',\n\s*description:/.test(MAIN), '/avatar está registrado');
    assert(/commandName === 'avatar'/.test(MAIN), 'y enrutado');

    // ── 2. Premium: sólo con un `true` explícito ─────────────────────────────
    const conPlus = ficha({ plus: true });
    const sinPlus  = ficha({ plus: false });
    const sinDato  = ficha({ plus: null });

    const marca = config.ROBLOX_PLUS_EMOJI ?? '`PLUS`';
    assert(conPlus.description.includes(marca), 'con Plus se enseña la insignia');
    assert(!sinPlus.description.includes(marca), 'sin Plus no aparece');
    assert(
        !sinDato.description.includes(marca) && !/\bplus\b/i.test(sinDato.description),
        'y si no se pudo comprobar, NO se dice nada: null no es "no tiene"'
    );
    // El caso que importa de verdad: sin el permiso de Open Cloud, la ficha
    // sale igual que la de alguien que no tiene Premium — pero sin afirmarlo.
    assert(
        sinDato.description === sinPlus.description,
        'la ficha de "no se sabe" no inventa una diferencia con la de "no tiene"'
    );

    // La insignia sale de config: quien tenga un emoji del logo lo pone ahí y
    // no hay que tocar el código. Se comprueba poniéndolo de verdad, no sólo
    // mirando que la clave exista — el handler podría ignorarla igual.
    assert('ROBLOX_PLUS_EMOJI' in config, 'el emoji de Plus está en config');
    const antes = config.ROBLOX_PLUS_EMOJI;
    try {
        config.ROBLOX_PLUS_EMOJI = '<:plusdeprueba:1553269490748366928>';
        const conEmoji = ficha({ plus: true });
        assert(
            conEmoji.description.includes('<:plusdeprueba:1553269490748366928>'),
            'y el handler lo usa: poner el emoji en config basta para que salga'
        );
        assert(!conEmoji.description.includes('`PLUS`'), 'y entonces ya no sale el texto de respaldo');
    } finally {
        config.ROBLOX_PLUS_EMOJI = antes;
    }

    // ── 3. El nombre, en la descripción ──────────────────────────────────────
    const base = ficha();
    assert(!base.title, 'el embed NO usa título: ahí Discord no pintaría los emojis del servidor');
    assert(base.description.startsWith('## '), 'el nombre va como encabezado de la descripción');
    assert(base.description.includes(USUARIO.displayName), 'con el nombre que se muestra');
    assert(base.description.includes(`@${USUARIO.name}`), 'y el usuario real debajo');
    assert(base.description.includes(String(USUARIO.id)), 'y su id');
    assert(
        base.description.includes(`https://www.roblox.com/users/${USUARIO.id}/profile`),
        'con enlace a su perfil'
    );

    // ── 4. Los números, en el pie (pequeño y gris, bajo la imagen) ───────────
    assert(Boolean(base.footer?.text), 'los números van en el pie del embed');
    assert(base.footer.text.includes('2,742,038 seguidores'), 'seguidores, con separador de miles');
    assert(base.footer.text.includes('971 amigos'), 'amigos');
    assert(base.footer.text.includes('82 siguiendo'), 'y seguidos');
    // Los tres en una línea, "al lado", como se pidió.
    assert(!base.footer.text.includes('\n'), 'los tres van en una sola línea');
    // Emojis del servidor NO: en el pie de un embed Discord los imprime crudos.
    assert(!/<a?:\w+:\d+>/.test(base.footer.text), 'y sin emojis del servidor, que en el pie saldrían en crudo');

    // ── 5. Un número que falta no se convierte en 0 ──────────────────────────
    const incompleta = ficha({ seguidores: null, amigos: 3, siguiendo: undefined });
    assert(incompleta.footer.text.includes('— seguidores'), 'lo que no se pudo consultar sale como "—"');
    assert(incompleta.footer.text.includes('— siguiendo'), 'también en seguidos');
    assert(incompleta.footer.text.includes('3 amigos'), 'y lo que sí se pudo, con su número');
    assert(!/\b0 (seguidores|siguiendo)\b/.test(incompleta.footer.text), 'y nunca como 0, que sería inventar');
    assert(cmd.buildAvatarPie({}).split('—').length === 4, 'sin ningún dato, los tres salen como "—"');

    // ── 6. La imagen ─────────────────────────────────────────────────────────
    assert(base.image?.url?.includes('rbxcdn'), 'el avatar va como imagen grande');
    assert(!base.thumbnail, 'y no como miniatura pequeña');
    const sinAvatar = ficha({ avatarUrl: null });
    assert(!sinAvatar.image, 'si Roblox no da imagen, la ficha sale sin ella en vez de romperse');
    assert(Boolean(sinAvatar.footer?.text), 'y conserva el resto');

    assert(base.color === 0x2B2D31, 'la ficha va en el gris del resto del bot');

    // ── 7. La insignia de verificado ─────────────────────────────────────────
    const verificado = cmd.buildAvatarEmbed({
        user: { ...USUARIO, hasVerifiedBadge: true },
        uid: USUARIO.id, avatarUrl: null, plus: null,
        seguidores: 1, amigos: 1, siguiendo: 1,
    }).toJSON();
    assert(/verificad/i.test(verificado.description), 'una cuenta verificada por Roblox lo dice');
    assert(!/verificad/i.test(base.description), 'y una normal no');

    // ── 8. Seguidores y seguidos son endpoints distintos ─────────────────────
    const CLIENTE = fs.readFileSync(path.join(RAIZ, 'src', 'roblox', 'client.js'), 'utf8');
    // Se corta en la llave a principio de línea, la que cierra la función: un
    // `\}` no-avaro cortaría en el `${userId}` de la plantilla y dejaría el
    // trozo tan corto que el test pasaría por vacío.
    const deFollowers = CLIENTE.match(/async function getFollowerCount[\s\S]*?\n\}/)?.[0] ?? '';
    const deFollowing = CLIENTE.match(/async function getFollowingCount[\s\S]*?\n\}/)?.[0] ?? '';
    assert(/\/followers\/count/.test(deFollowers), 'getFollowerCount pide /followers/count');
    assert(/\/followings\/count/.test(deFollowing), 'getFollowingCount pide /followings/count');
    assert(!/\/followers\/count/.test(deFollowing), 'y no el de seguidores, que dejaría los dos números iguales');
    assert(typeof roblox.getFollowingCount === 'function', 'getFollowingCount se exporta');

    // ── 9. El fondo de avatar ────────────────────────────────────────────────
    // Roblox devuelve el fondo equipado YA compuesto con el outfit y la pose,
    // pero sólo si se pide: `includeBackground` va en false por defecto en su
    // API. Sin pasarlo, la imagen vuelve transparente — que es justo lo que
    // pasaba antes de encontrar el parámetro.
    const deAvatar = CLIENTE.match(/async function getAvatarImage[\s\S]*?\n\}/)?.[0] ?? '';
    assert(/includeBackground=/.test(deAvatar), 'getAvatarImage sabe pedir el fondo');
    assert(/conFondo = false/.test(deAvatar), 'y por defecto NO lo pide, para no cambiar /outfit sin que nadie lo pida');

    const HANDLERS = fs.readFileSync(path.join(RAIZ, 'handlers', 'commands.js'), 'utf8');
    const deHandler = HANDLERS.match(/async function handleAvatar[\s\S]*?\n\}/)?.[0] ?? '';
    assert(/conFondo: true/.test(deHandler), '/avatar SÍ lo pide: el fondo es lo que se pidió enseñar');
    assert(/size: '720x720'/.test(deHandler), 'y a 720, el tamaño más grande que publica Roblox');

    const deOutfit = HANDLERS.match(/async function handleOutfit[\s\S]*?\n\}/)?.[0] ?? '';
    assert(!/conFondo/.test(deOutfit), '/outfit se queda como estaba, sin fondo');

    // ── 10. Premium: nunca revienta ni afirma sin dato ───────────────────────
    const deAvanzado = CLIENTE.match(/async function getUserAdvanced[\s\S]*?\n\}/)?.[0] ?? '';
    assert(/if \(!OPEN_CLOUD_KEY\) return null;/.test(deAvanzado), 'sin API key devuelve null, no false');
    assert(/catch[\s\S]*return null;/.test(deAvanzado), 'y un fallo de permisos también: null es "no se sabe"');
    assert(/user\.advanced:read/.test(deAvanzado), 'el comentario deja escrito qué permiso hace falta');
    assert(/cloud\/v2\/users\//.test(deAvanzado), 'usa el endpoint de Open Cloud que sí trae el dato');

    // Sin clave configurada en este entorno: tiene que devolver null sin lanzar.
    let exploto = false;
    let resultado;
    try { resultado = await roblox.getUserAdvanced(1); } catch { exploto = true; }
    assert(!exploto, 'getUserAdvanced no lanza');
    assert(
        resultado === null || (resultado && typeof resultado === 'object'),
        'y devuelve null o un objeto, nunca un booleano suelto'
    );

    return finish();
};
