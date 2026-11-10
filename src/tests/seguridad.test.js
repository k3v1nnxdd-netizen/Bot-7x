'use strict';

// /userinfo, anti-suplantación, transcripciones y registro de mensajes.
//
// Lo que protegen:
//   1. SUPLANTACIÓN: los trucos de letras (unicode, cirílico, leet, espacios,
//      repetidas) no esquivan el detector; los nombres normales no saltan.
//   2. Sólo copiar un NOMBRE DE USUARIO (único) es "grave"; staff exento.
//   3. /userinfo: nadie ve a un owner salvo él mismo; Nitro y boost se deducen
//      bien; la confianza sale de sus razones.
//   4. TRANSCRIPCIÓN: el contenido de un usuario nunca se convierte en HTML
//      (sin inyección) y el formato de Discord se respeta.

const { UserFlags, UserFlagsBitField, PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const { createSuite } = require('./testHarness');
const config = require('../../config');
const sup = require('../../utils/suplantacion').__test;
const ui = require('../../handlers/userinfo');
const tr = require('../../utils/transcripcion').__test;
const reg = require('../../utils/registroMensajes').__test;

const DIA = 86_400_000;
const AHORA = Date.parse('2026-11-10T12:00:00Z');

function usuario(extra = {}) {
    return {
        id: '111111111111111111', username: 'cliente', globalName: 'Cliente', bot: false,
        avatar: 'abc', banner: null, accentColor: null, createdTimestamp: AHORA - 400 * DIA,
        flags: new UserFlagsBitField(0),
        displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/1/abc.png',
        bannerURL() { return this.banner ? 'https://cdn.discordapp.com/banners/1/b.png' : null; },
        ...extra,
    };
}

function miembro(user, extra = {}) {
    return {
        id: user.id, user, nickname: null, avatar: null, banner: null, pending: false,
        joinedTimestamp: AHORA - 100 * DIA, premiumSinceTimestamp: null, displayColor: 0, displayName: user.globalName,
        permissions: new PermissionsBitField(0n),
        roles: { cache: new Map() },
        isCommunicationDisabled: () => false,
        displayAvatarURL: () => user.displayAvatarURL(),
        ...extra,
    };
}

module.exports = async function run() {
    const { assert, finish } = createSuite('seguridad');

    // ── 1. Normalización y comparación ───────────────────────────────────────
    const { normalizar, compararNombre } = sup;
    assert(normalizar('kevvv7x') === 'kev7x', 'letras repetidas colapsadas');
    assert(normalizar('ｋｅｖｖｖ７ｘ') === 'kev7x', 'ancho completo (fullwidth) → normal');
    assert(normalizar('𝐤𝐞𝐯𝐯𝐯𝟕𝐱') === 'kev7x', 'letras matemáticas en negrita → normal');
    assert(normalizar('kеvvv7x') === 'kev7x', 'e cirílica → e latina');
    assert(normalizar('K.E_V-V V 7 X') === 'kev7x', 'separadores fuera');
    assert(normalizar('kévvv7x') === 'kev7x', 'acentos fuera');
    assert(normalizar('k3vvv7x') === 'kev7x', 'leet: 3 → e');
    assert(normalizar('Kevshito') === normalizar('KevshIto') && normalizar('kevsh1to') === normalizar('kevshito'), 'I, l y 1 son la misma letra');

    const prot = [
        { norm: normalizar('kevvv7x'), original: 'kevvv7x', userId: '1', fuente: 'usuario' },
        { norm: normalizar('kevshito'), original: 'kevshito', userId: '2', fuente: 'usuario' },
        { norm: normalizar('nodms'), original: 'nodms', userId: '1', fuente: 'visible' },
    ];
    assert(compararNombre('kеvvv7x', prot)?.tipo === 'exacto', 'copia con cirílico = exacto');
    assert(compararNombre('kevshitoo', prot)?.tipo === 'exacto', 'letra repetida extra = exacto');
    assert(compararNombre('kevshiro', prot)?.tipo === 'parecido', 'una letra cambiada = parecido');
    assert(compararNombre('kev7x_support', prot)?.tipo === 'contiene', 'nombre dentro de otro = contiene');
    assert(compararNombre('7x Soporte', prot)?.tipo === 'marca', 'marca + staff = suplantación');
    assert(compararNombre('7X ADMIN', prot)?.tipo === 'marca', 'marca + admin = suplantación');
    for (const normal of ['pedro', 'kevin', 'Juan 7x fan', 'robloxgamer', 'kevvy', 'xx']) {
        assert(compararNombre(normal, prot) === null, `"${normal}" no salta`);
    }

    // ── 2. Gravedad y exentos ────────────────────────────────────────────────
    const u = usuario({ username: 'kevvv7x_', globalName: null });
    const ev = sup.evaluar(miembro(u), prot);
    assert(ev.length === 1 && ev[0].tipo === 'exacto' && ev[0].protegido.fuente === 'usuario', 'copiar el nombre de usuario de un owner = exacto contra "usuario"');
    const visible = sup.evaluar(miembro(usuario({ username: 'random123', globalName: 'nodms' })), prot);
    assert(visible[0]?.protegido.fuente === 'visible', 'copiar un nombre visible es aviso, no grave');

    const staff = miembro(usuario({ username: '7x soporte' }), { permissions: new PermissionsBitField(PermissionFlagsBits.ModerateMembers) });
    assert(sup.exento(staff), 'staff con permisos de moderación está exento');
    assert(sup.exento(miembro(usuario({ id: config.OWNER_ID }))), 'los owners están exentos');
    assert(sup.exento(miembro(usuario({ bot: true }))), 'los bots están exentos');
    assert(!sup.exento(miembro(usuario())), 'un miembro normal no está exento');

    // ── 3. /userinfo ─────────────────────────────────────────────────────────
    let respuestas = [];
    const it = (objetivoId, quien = '555555555555555555') => ({
        user: { id: quien }, replied: false, deferred: false,
        options: { getUser: () => ({ id: objetivoId }), getString: () => null },
        reply: async o => { respuestas.push(o); },
    });
    await ui.handleUserinfo(it(config.OWNER_ID));
    const efimera = r => r?.ephemeral === true || (Number(r?.flags) & 64) === 64;
    assert(respuestas[0]?.content?.includes('privada') && efimera(respuestas[0]), 'nadie puede ver la ficha de un owner');

    const { infoBoost, construirUserinfo, confianza } = ui.__test;
    const b = infoBoost(AHORA - 200 * DIA, AHORA);
    assert(b.meses === 6 && b.actual === 6 && b.siguiente === 9, '200 días boosteando → insignia de 6 meses, siguiente 9');
    assert(infoBoost(AHORA - 10 * DIA, AHORA).actual === 0, 'menos de un mes → sin insignia aún');

    const nitroUser = usuario({ avatar: 'a_anim', banner: 'b1', flags: new UserFlagsBitField(UserFlags.ActiveDeveloper | UserFlags.HypeSquadOnlineHouse1) });
    const p = construirUserinfo({
        user: nitroUser,
        member: miembro(nitroUser, { premiumSinceTimestamp: AHORA - 40 * DIA }),
        guild: { id: 'g', premiumTier: 2, premiumSubscriptionCount: 14 },
        datos7x: { compras: 6, robux: 12000, invitaciones: 3 },
        ahora: AHORA,
    });
    const campos = p.embeds[0].toJSON().fields;
    const valor = nombre => campos.find(f => f.name.includes(nombre))?.value ?? '';
    assert(valor('Insignias').includes('Desarrollador activo') && valor('Insignias').includes('HypeSquad Bravery'), 'muestra las insignias del perfil');
    assert(valor('Insignias').includes('Nitro') && valor('Insignias').includes('Server Booster'), 'y Nitro y booster');
    assert(valor('Nitro').includes('avatar animado') && valor('Nitro').includes('banner'), 'Nitro deducido con sus señales');
    assert(valor('Boost').includes('1 mes'), 'insignia de booster calculada');
    assert(valor('Mejoras').includes('14 mejoras') && valor('Mejoras').includes('Nivel **2**'), 'mejoras y nivel del servidor');
    assert(valor('Compras').includes('6 compras') && valor('Compras').includes('12,000'), 'compras en 7x');
    assert(p.embeds[0].toJSON().image?.url, 'el banner va como imagen');
    assert(p.confianza.nivel === 'Alta', 'cuenta vieja + compras + boost = confianza alta');

    const nueva = usuario({ avatar: null, createdTimestamp: AHORA - 2 * DIA });
    const c = confianza({ user: nueva, member: miembro(nueva, { joinedTimestamp: AHORA - 3_600_000 }), compras: 0, boostDesde: null, alertaSuplantacion: true, ahora: AHORA });
    assert(c.nivel === 'Baja' && c.razones.some(r => r.includes('7 días')) && c.razones.some(r => r.includes('suplantación')), 'cuenta nueva sin foto con aviso = baja, con razones');

    // ── 4. Transcripción ─────────────────────────────────────────────────────
    const md = tr.markdown('<script>alert(1)</script> **negrita** `x<y` <@1> https://roblox.com', { usuarios: new Map([['1', 'Kev']]) });
    assert(!md.includes('<script>') && md.includes('&lt;script&gt;'), 'el HTML de un usuario se escapa (sin inyección)');
    assert(md.includes('<strong>negrita</strong>'), 'negrita');
    assert(md.includes('<code>x&lt;y</code>'), 'código escapado');
    assert(md.includes('@Kev'), 'menciones con el nombre');
    assert(md.includes('<a href="https://roblox.com"'), 'enlaces');
    const md2 = tr.markdown('"><img src=x onerror=alert(1)>');
    assert(!md2.includes('<img src=x'), 'tampoco se cuela por comillas');

    const html = tr.construirHtml({
        meta: { canal: 'compra-001', servidor: '7x', filas: { Ticket: '#compra-001' }, parcial: null, generado: AHORA },
        mensajes: [{
            id: '9', createdTimestamp: AHORA, content: 'hola', author: usuario(), embeds: [], components: [],
            attachments: new Map([['a', { url: 'https://cdn/x.png', name: 'pago.png', size: 2048, contentType: 'image/png' }]]),
        }],
        ctx: { usuarios: new Map() },
        imagenes: new Map([['https://cdn/x.png', 'data:image/png;base64,AAAA']]),
    });
    assert(html.startsWith('<!doctype html>') && html.includes('compra-001'), 'HTML completo con el ticket');
    assert(html.includes('data:image/png;base64,AAAA'), 'las imágenes van incrustadas');

    // ── 5. Registro de mensajes ──────────────────────────────────────────────
    assert(reg.citado('a\nb') === '> a\n> b', 'el contenido va citado línea a línea');
    assert(reg.citado('x'.repeat(3000)).length <= 1024, 'y cabe en un campo de embed');
    assert(reg.debeIgnorarse({ guildId: 'g', author: { bot: true } }), 'los mensajes de bots no se registran');

    return finish();
};
