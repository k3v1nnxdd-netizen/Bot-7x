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

    // ── 2b. Botones del aviso ────────────────────────────────────────────────
    // El fallo real en producción: "La aplicación no ha respondido". Lo que se
    // exige: confirmar (deferUpdate) ANTES de cualquier consulta lenta.
    const fs = require('fs');
    const { EmbedBuilder } = require('discord.js');
    const supMod = require('../../utils/suplantacion');
    const SOSPECHOSO = '1348083484974911651';
    const avisoEmbed = new EmbedBuilder().setTitle('Posible suplantación').setThumbnail('https://cdn/x.png')
        .addFields({ name: 'Cuenta creada', value: 'x' }).toJSON();
    // Como llega de Discord: con proxy_url, width y height.
    avisoEmbed.thumbnail = { ...avisoEmbed.thumbnail, proxy_url: 'https://media/x.png', width: 256, height: 256 };

    function clic(accion, { quien = config.OWNER_ID, lento = 0, falla = null, miembro: m } = {}) {
        const orden = [];
        const sospechoso = m ?? miembro(usuario({ id: SOSPECHOSO, username: 'kevvv7x2', globalName: 'Crizzzz' }), {
            timeout: async () => { orden.push('timeout'); if (falla) throw falla; },
            kick: async () => { orden.push('kick'); if (falla) throw falla; },
        });
        const it = {
            customId: `${accion}:${SOSPECHOSO}`, user: { id: quien, username: 'kev' },
            message: { embeds: [{ data: avisoEmbed }] },
            guild: { id: config.GUILD_ID, members: {
                cache: new Map(),
                fetch: async () => { orden.push('fetch'); await new Promise(r => setTimeout(r, lento)); return sospechoso; },
                ban: async () => { orden.push('ban'); if (falla) throw falla; },
            } },
            deferUpdate: async () => { orden.push('defer'); },
            editReply: async o => { orden.push('edit'); it.editado = o; },
            followUp: async o => { orden.push('followUp'); it.seguimiento = o; },
            reply: async o => { orden.push('reply'); it.respuesta = o; },
        };
        return { it, orden };
    }

    let c1 = clic('sup_ok', { lento: 50 });
    await supMod.alBoton(c1.it);
    assert(c1.orden[0] === 'defer', 'Es legítimo: confirma a Discord lo PRIMERO, antes de buscar al miembro');
    assert(c1.orden.includes('edit') && !c1.orden.includes('followUp'), 'y después edita el aviso');
    const ed = c1.it.editado.embeds[0].toJSON();
    assert(ed.fields.some(f => f.name === 'Resolución' && f.value.includes('legítimo')), 'el aviso muestra la resolución');
    assert(ed.thumbnail?.url === 'https://cdn/x.png', 'conserva la miniatura del aviso original');
    assert(c1.it.editado.components[0].toJSON().components.every(b => b.disabled), 'y deja los botones desactivados');
    assert(sup.load().legitimos[SOSPECHOSO] === sup.firma(miembro(usuario({ username: 'kevvv7x2', globalName: 'Crizzzz' }))), 'guarda que es legítimo con su nombre actual');

    // Legítimo de verdad: el mismo nombre ya no avisa; otro nombre, sí.
    const mismo = miembro(usuario({ id: SOSPECHOSO, username: 'kevvv7x2', globalName: 'Crizzzz' }), { guild: { id: config.GUILD_ID } });
    const enviados = [];
    const logC = require('../../utils/logCanales');
    const enviarOriginal = logC.enviar;
    logC.enviar = async (g, t, p) => { enviados.push(p); return {}; };
    supMod.__test.setProtegidos?.(prot);
    assert(await supMod.revisar(mismo, 'prueba', { aislar: false }) === null, 'legítimo con ese nombre: no vuelve a avisar');
    const otro = miembro(usuario({ id: SOSPECHOSO, username: 'kevvv7x2', globalName: 'kevshito' }), { guild: { id: config.GUILD_ID } });
    assert(Array.isArray(await supMod.revisar(otro, 'prueba', { aislar: false })) && enviados.length === 1, 'si se cambia a OTRO nombre sospechoso, avisa de nuevo');
    const tj = enviados[0].embeds[0].toJSON();
    assert(tj.description.includes(SOSPECHOSO), 'el ID va en la descripción, a todo el ancho (no partido en una columna)');
    assert(!tj.fields.some(f => f.inline && f.value.includes(SOSPECHOSO)), 'ningún campo estrecho lleva el ID');
    assert(tj.fields.some(f => f.name === 'En el servidor'), 'muestra cuándo entró');
    assert(tj.fields.some(f => f.value.includes('**kevshito**') && f.value.includes('nombre de usuario')), 'dice a quién se parece y de qué nombre');
    logC.enviar = enviarOriginal;

    let c2 = clic('sup_ais', { lento: 50 });
    await supMod.alBoton(c2.it);
    assert(c2.orden.join(',') === 'defer,fetch,timeout,edit', 'Aislar: confirma, busca, aísla y edita, en ese orden');

    let c3 = clic('sup_kick');
    await supMod.alBoton(c3.it);
    assert(c3.orden.includes('kick') && c3.orden[0] === 'defer', 'Expulsar funciona');

    let c4 = clic('sup_ban');
    await supMod.alBoton(c4.it);
    assert(c4.orden[0] === 'defer' && c4.orden.includes('ban'), 'Banear funciona');

    const sinPermiso = Object.assign(new Error('Missing Permissions'), { code: 50013 });
    let c5 = clic('sup_ban', { falla: sinPermiso });
    await supMod.alBoton(c5.it);
    assert(c5.orden[0] === 'defer' && c5.orden.includes('followUp') && !c5.orden.includes('edit'), 'si falla, avisa sólo a quien pulsó y no toca el aviso');
    assert(c5.it.seguimiento.content.includes('rol del bot') && (c5.it.seguimiento.flags & 64), 'con el motivo legible, en privado');

    let c6 = clic('sup_ban', { quien: '555555555555555555' });
    await supMod.alBoton(c6.it);
    assert(c6.orden.join(',') === 'reply' && (c6.it.respuesta.flags & 64), 'alguien que no es owner: se le responde en privado y no se hace nada');

    // Con la API de Discord lenta (2.5 s), la confirmación sigue siendo inmediata.
    let c7 = clic('sup_ok', { lento: 2500 });
    const t0 = Date.now();
    let confirmadoEn = null;
    const deferOriginal = c7.it.deferUpdate;
    c7.it.deferUpdate = async () => { confirmadoEn = Date.now() - t0; return deferOriginal(); };
    await supMod.alBoton(c7.it);
    assert(confirmadoEn !== null && confirmadoEn < 100, `con la API lenta, confirma en ${confirmadoEn} ms (límite de Discord: 3000)`);

    // Y por el router real de botones (handlers/buttons.js).
    const { handleButton } = require('../../handlers/buttons');
    let c8 = clic('sup_ok');
    c8.it.channelId = 'canal'; c8.it.replied = false; c8.it.deferred = false;
    await handleButton(c8.it);
    assert(c8.orden[0] === 'defer' && c8.orden.includes('edit'), 'el router de botones lleva sup_* al anti-suplantación');

    if (fs.existsSync(sup.FILE)) fs.unlinkSync(sup.FILE);

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

    // La ficha siempre es pública: el defer no es efímero.
    let diferido = null;
    const itPub = {
        user: { id: '555555555555555555' }, replied: false, deferred: false, client: { users: { fetch: async () => usuario() } },
        guild: null, options: { getUser: () => ({ id: '111111111111111111' }), getString: () => 'solo_yo' },
        deferReply: async o => { diferido = o ?? {}; itPub.deferred = true; }, editReply: async () => {},
    };
    await ui.handleUserinfo(itPub);
    assert(diferido && !efimera(diferido), 'la ficha de /userinfo siempre es visible para todos');

    const { infoBoost, construirUserinfo, confianza } = ui.__test;
    const b = infoBoost(AHORA - 200 * DIA, AHORA);
    assert(b.meses === 6 && b.actual === 6 && b.siguiente === 9, '200 días boosteando → insignia de 6 meses, siguiente 9');
    assert(infoBoost(AHORA - 10 * DIA, AHORA).actual === 1 && infoBoost(AHORA - 10 * DIA, AHORA).siguiente === 2, 'desde el primer día: insignia de 1 mes, siguiente 2');
    assert(infoBoost(AHORA - 800 * DIA, AHORA).siguiente === null, '24 meses o más: insignia máxima');

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
    assert(valor('Insignias').includes('avatar animado') && valor('Insignias').includes('banner'), 'Nitro con las señales que lo prueban');
    assert(valor('Insignias').includes('1 mes') && valor('Insignias').includes(':b_boost1:') && valor('Insignias').includes(':b_boost2:'), 'insignia de booster oficial, actual y siguiente');
    assert(!campos.some(f => f.name.includes('Mejoras del servidor')), 'ya no muestra las mejoras del servidor (no son de la persona)');

    // Boostea OTRO servidor del bot desde hace más: la insignia sale de ese boost.
    const otroBoost = construirUserinfo({
        user: nitroUser, member: miembro(nitroUser, { premiumSinceTimestamp: AHORA - 40 * DIA }), guild: { id: 'g', name: '7x' }, ahora: AHORA,
        boosts: [{ servidor: '7x', desde: AHORA - 40 * DIA, aqui: true }, { servidor: 'Otro', desde: AHORA - 400 * DIA, aqui: false }],
    }).embeds[0].toJSON().fields;
    const vb = otroBoost.find(f => f.name.includes('Insignias')).value;
    assert(vb.includes(':b_boost12:') && vb.includes('y 1 más'), 'boost más antiguo en otro servidor → insignia de 12 meses, como en su perfil');
    const soloFuera = construirUserinfo({ user: nitroUser, member: miembro(nitroUser), guild: { id: 'g' }, ahora: AHORA,
        boosts: [{ servidor: 'Otro', desde: AHORA - 100 * DIA, aqui: false }] }).embeds[0].toJSON().fields;
    assert(soloFuera.find(f => f.name.includes('Insignias')).value.includes('otro servidor'), 'detecta la insignia aunque no boostee este servidor');

    // Sin nada visible: ni campos vacíos ni "no se puede comprobar". No sale nada.
    const sinNada = construirUserinfo({ user: usuario(), member: miembro(usuario()), guild: { id: 'g' }, ahora: AHORA, boosts: [] }).embeds[0].toJSON().fields;
    assert(!sinNada.some(f => /Insignia|Nitro|booster/i.test(f.name)), 'sin insignias visibles: no aparece ninguna sección de insignias, Nitro ni booster');
    assert(!sinNada.some(f => /No se puede comprobar|No detectad|No tiene/i.test(f.value)), 'y nunca dice que no tiene algo');

    // El caso real de 29v56: placa de nombre + tag, avatar normal → Nitro no comprobable.
    const raw29 = {
        usuario: { display_name_styles: null, primary_guild: { identity_enabled: true, tag: 'vqz' } },
        miembro: { collectibles: { nameplate: { asset: 'nameplates/nameplates/cherry_blossoms/' } } },
    };
    const f29 = construirUserinfo({ user: usuario(), member: miembro(usuario()), guild: { id: 'g' }, ahora: AHORA, boosts: [], raw: raw29 }).embeds[0].toJSON().fields;
    const per = f29.find(f => f.name.includes('Personalización'))?.value ?? '';
    assert(per.includes('Cherry Blossoms') && per.includes('vqz'), 'muestra la placa de nombre y el tag de servidor');
    assert(!f29.some(f => f.value.includes('Nitro')), 'una placa de nombre (se compra sin Nitro) no se toma como prueba de Nitro');
    const fEstilo = construirUserinfo({ user: usuario(), member: miembro(usuario()), guild: { id: 'g' }, ahora: AHORA, boosts: [], raw: { usuario: { display_name_styles: { font_id: 3 } } } }).embeds[0].toJSON().fields;
    assert(fEstilo.find(f => f.name.includes('Insignias')).value.includes('estilo de nombre'), 'el estilo de nombre (exclusivo de Nitro) sí cuenta');

    // boostsEnComun: junta este servidor y los demás, y un servidor colgado no bloquea.
    const { boostsEnComun } = ui.__test;
    const g1 = { id: 'g1', name: '7x' };
    const cli = { guilds: { cache: new Map([
        ['g1', g1],
        ['g2', { id: 'g2', name: 'B', members: { fetch: async () => ({ premiumSinceTimestamp: AHORA - 300 * DIA }) } }],
        ['g3', { id: 'g3', name: 'C', members: { fetch: () => new Promise(() => {}) } }],
        ['g4', { id: 'g4', name: 'D', members: { fetch: async () => { throw new Error('Unknown Member'); } } }],
    ]) } };
    const t1 = Date.now();
    const bc = await boostsEnComun(cli, 'u', g1, { premiumSinceTimestamp: AHORA - 10 * DIA });
    assert(bc.boosts.length === 2 && bc.revisados === 4, 'junta el boost de aquí y el de otro servidor; revisa los 4');
    assert(Date.now() - t1 < 3500, 'un servidor que no responde no bloquea la ficha');
    assert(valor('Insignias').includes(':b_activedev:') && valor('Insignias').includes(':b_bravery:') && valor('Insignias').includes(':b_nitro:'), 'las insignias usan las imágenes oficiales');
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

    // ── 6. Registro de mensajes, de punta a punta (con Discord simulado) ─────
    const regMod = require('../../utils/registroMensajes');
    const logs2 = require('../../utils/logCanales');
    const envOrig = logs2.enviar;
    let registrados = [];
    logs2.enviar = async (g, tipo, p) => { registrados.push({ tipo, p }); return {}; };
    const autor = { id: '777', bot: false, username: 'cliente', tag: 'cliente', displayAvatarURL: () => 'https://a/b.png' };
    let auditoria = [];
    const guildFalso = { id: config.GUILD_ID, fetchAuditLogs: async () => ({ entries: new Map(auditoria.map(e => [e.id, e])) }) };
    const msg = extra => ({
        id: '1', guildId: config.GUILD_ID, guild: guildFalso, channelId: 'c', author: autor, content: 'pagué 100',
        createdTimestamp: AHORA, editedTimestamp: AHORA, url: 'https://discord.com/channels/g/c/1',
        attachments: new Map(), embeds: [], stickers: new Map(), partial: false, ...extra,
    });

    await regMod.alEditar(msg(), msg({ content: 'pagué 1000' }));
    let e1 = registrados.pop();
    const ef = e1?.p.embeds[0].toJSON().fields ?? [];
    assert(e1?.tipo === 'mensajes' && ef.find(f => f.name === 'Antes').value.includes('pagué 100') && ef.find(f => f.name === 'Después').value.includes('pagué 1000'), 'edición: registra antes y después');
    assert(e1.p.components[0].toJSON().components[0].url.includes('/channels/'), 'con botón al mensaje');

    await regMod.alEditar(msg(), msg());
    assert(registrados.length === 0, 'mismo texto (vista previa de un link) no es una edición');

    await regMod.alEditar(msg({ partial: true }), msg({ content: 'nuevo' }));
    assert(registrados.pop()?.p.embeds[0].toJSON().fields.find(f => f.name === 'Antes').value.includes('anterior al último reinicio'), 'edición de un mensaje viejo: dice que el "antes" no está disponible');

    await regMod.alEditar(msg(), msg({ content: 'x'.repeat(2000) }));
    assert(registrados.pop()?.p.files.length === 1, 'un texto muy largo va completo en un .txt');

    // Borrado por el propio autor: sin entrada de auditoría.
    auditoria = [];
    await regMod.alBorrar(msg());
    let b1 = registrados.pop()?.p.embeds[0].toJSON();
    assert(b1?.title.includes('Mensaje borrado') && b1.fields.find(f => f.name === 'Borrado por').value.includes('Su autor'), 'borrado por su autor');
    assert(b1.fields.find(f => f.name === 'Contenido').value.includes('pagué 100'), 'con el contenido');

    // Borrado por un moderador: entrada reciente.
    auditoria = [{ id: 'a1', createdTimestamp: Date.now(), target: { id: '777' }, extra: { channel: { id: 'c' }, count: 1 }, executor: { id: '888' } }];
    await regMod.alBorrar(msg({ id: '2' }));
    let b2 = registrados.pop()?.p.embeds[0].toJSON();
    assert(b2?.title.includes('moderador') && b2.fields.find(f => f.name === 'Borrado por').value.includes('<@888>'), 'borrado por un moderador: dice quién');

    // Discord AGRUPA: misma entrada vieja con el contador subido.
    auditoria = [{ id: 'a1', createdTimestamp: Date.now() - 5 * 60_000, target: { id: '777' }, extra: { channel: { id: 'c' }, count: 2 }, executor: { id: '888' } }];
    await regMod.alBorrar(msg({ id: '3' }));
    assert(registrados.pop()?.p.embeds[0].toJSON().fields.find(f => f.name === 'Borrado por').value.includes('<@888>'), 'entrada agrupada (contador sube): también detecta al moderador');

    // Misma entrada vieja sin cambios: fue el autor.
    await regMod.alBorrar(msg({ id: '4' }));
    assert(registrados.pop()?.p.embeds[0].toJSON().fields.find(f => f.name === 'Borrado por').value.includes('Su autor'), 'entrada vieja sin cambios: no se atribuye al moderador');

    await regMod.alBorrar({ id: '5', guild: guildFalso, guildId: config.GUILD_ID, channelId: 'c', partial: true });
    assert(registrados.pop()?.p.embeds[0].toJSON().title.includes('sin contenido'), 'mensaje anterior al reinicio: se registra igual, sin contenido');

    await regMod.alBorrar(msg({ author: { ...autor, bot: true } }));
    assert(registrados.length === 0, 'los mensajes de bots no se registran');
    logs2.enviar = envOrig;

    // ── 7. Anti-nuke ─────────────────────────────────────────────────────────
    const proteccionMod = require('../../utils/proteccion');
    const logs3 = require('../../utils/logCanales');
    const env3 = logs3.enviar;
    let avisos = [];
    logs3.enviar = async (g, t, p) => { avisos.push(p); return {}; };
    function guildNuke(manageable = true) {
        const roles = new Map([['g', { id: 'g', name: '@everyone' }], ['r1', { id: 'r1', name: 'Staff' }], ['r2', { id: 'r2', name: 'Admin' }]]);
        const m = { manageable, roles: { cache: { filter: f => ({ map: fn => [...roles.values()].filter(f).map(fn) }) }, set: async r => { m.rolesQuedan = r; } } };
        return { id: config.GUILD_ID, name: '7x', client: { users: { fetch: async () => null } }, members: { fetch: async () => m }, _m: m };
    }
    const canalFalso = { name: 'general' };
    proteccionMod.__test.borrados.clear();
    let gN = guildNuke();
    for (let i = 0; i < config.PROTECCION.ANTINUKE_CANALES - 1; i++) await proteccionMod.__test.antiNuke(gN, { id: '999', username: 'malo' }, canalFalso);
    assert(gN._m.rolesQuedan === undefined && avisos.length === 0, 'por debajo del umbral: nada');
    await proteccionMod.__test.antiNuke(gN, { id: '999', username: 'malo' }, canalFalso);
    assert(Array.isArray(gN._m.rolesQuedan) && gN._m.rolesQuedan.length === 0, `${config.PROTECCION.ANTINUKE_CANALES} canales en la ventana: se le quitan TODOS los roles`);
    assert(avisos.length === 1 && avisos[0].embeds[0].toJSON().fields.some(f => f.value.includes('Roles retirados') && f.value.includes('Staff')), 'y se avisa con los roles retirados');
    await proteccionMod.__test.antiNuke(gN, { id: '999', username: 'malo' }, canalFalso);
    assert(avisos.length === 1, 'un solo aviso por ráfaga');

    proteccionMod.__test.borrados.clear(); avisos = [];
    gN = guildNuke();
    for (let i = 0; i < config.PROTECCION.ANTINUKE_CANALES; i++) await proteccionMod.__test.antiNuke(gN, { id: config.OWNER_ID, username: 'owner' }, canalFalso);
    assert(gN._m.rolesQuedan === undefined && avisos[0]?.embeds[0].toJSON().fields.some(f => f.value.includes('owner')), 'a un owner sólo se le avisa, nunca se le quitan roles');

    proteccionMod.__test.borrados.clear(); avisos = [];
    gN = guildNuke(false);
    for (let i = 0; i < config.PROTECCION.ANTINUKE_CANALES; i++) await proteccionMod.__test.antiNuke(gN, { id: '998', username: 'alto' }, canalFalso);
    assert(avisos[0]?.embeds[0].toJSON().fields.some(f => f.value.includes('por encima del bot')), 'si su rol está por encima del bot, lo dice');

    // Los tickets no cuentan (ni se consulta la auditoría).
    let auditoriaConsultada = false;
    await proteccionMod.alBorrarCanal({ id: 't1', name: 'soporte-0001', parentId: config.CATEGORIES.TICKETS, guild: { fetchAuditLogs: async () => { auditoriaConsultada = true; return null; } } });
    assert(!auditoriaConsultada, 'borrar un ticket no cuenta para el anti-nuke');
    logs3.enviar = env3;

    // ── 7b. El bug de ACxQW: nada de esto actúa fuera de 7x ──────────────────
    const OTRO = '1111111111111111111';
    const logs4 = require('../../utils/logCanales');
    const env4 = logs4.enviar;
    let enviadosFuera = 0;
    logs4.enviar = async (g, ...r) => { if (g?.id !== config.GUILD_ID) enviadosFuera++; return env4(g, ...r); };
    // anti-nuke en otro servidor: no quita roles ni avisa
    proteccionMod.__test.borrados.clear(); avisos = [];
    const gOtro = guildNuke(); gOtro.id = OTRO;
    for (let i = 0; i < 5; i++) await proteccionMod.__test.antiNuke(gOtro, { id: '999', username: 'x' }, canalFalso);
    assert(gOtro._m.rolesQuedan === undefined, 'anti-nuke en OTRO servidor: no le quita roles a nadie');
    // borrar canales en otro servidor: ni auditoría ni nada
    let auditOtro = false;
    await proteccionMod.alBorrarCanal({ id: 'x', name: 'general', guild: { id: OTRO, fetchAuditLogs: async () => { auditOtro = true; return null; } } });
    assert(!auditOtro, 'un canal borrado en otro servidor se ignora por completo');
    // registro de mensajes y anti-suplantación en otro servidor
    await regMod.alBorrar(msg({ guildId: OTRO, guild: { ...guildFalso, id: OTRO } }));
    await regMod.alEditar(msg({ guildId: OTRO }), msg({ guildId: OTRO, content: 'otro' }));
    const deOtro = miembro(usuario({ username: 'kevvv7x' }), { guild: { id: OTRO } });
    assert(await supMod.revisar(deOtro, 'prueba', { aislar: false }) === null, 'anti-suplantación: un miembro de otro servidor no se revisa');
    assert(enviadosFuera === 0, 'ningún registro se intenta publicar en otro servidor');
    // logCanales: en otro servidor no crea NADA
    let creadosFuera = 0;
    const guildAjeno = { id: OTRO, channels: { cache: new Map(), fetch: async () => null, create: async () => { creadosFuera++; return { id: 'n' }; } } };
    assert(await logs4.asegurarTodos(guildAjeno) === null && await logs4.canal(guildAjeno, 'seguridad') === null && creadosFuera === 0, 'en otro servidor no se crea ninguna categoría ni canal');
    logs4.enviar = env4;

    // logCanales: con canales repetidos ADOPTA los más antiguos y no crea más.
    {
        const { ChannelType } = require('discord.js');
        const mk = (id, name, type, parentId = null) => ({ id, name, type, parentId, guildId: config.GUILD_ID,
            setParent: async p => { mk.movidos.push(id); }, permissionOverwrites: { set: async () => {} } });
        mk.movidos = [];
        const nombres = config.LOGS.CANALES;
        const canales = [
            mk('100', config.LOGS.CATEGORIA_NOMBRE, ChannelType.GuildCategory),
            mk('900', config.LOGS.CATEGORIA_NOMBRE, ChannelType.GuildCategory),
            mk('101', nombres.mensajes.nombre, ChannelType.GuildText, '100'),
            mk('102', nombres.transcripciones.nombre, ChannelType.GuildText, '100'),
            mk('103', nombres.seguridad.nombre, ChannelType.GuildText, '100'),
            mk('901', nombres.mensajes.nombre, ChannelType.GuildText, '900'),
            mk('902', nombres.transcripciones.nombre, ChannelType.GuildText, '900'),
            mk('903', nombres.seguridad.nombre, ChannelType.GuildText, '900'),
        ];
        let creadosAqui = 0;
        const g7 = { id: config.GUILD_ID, roles: { everyone: { id: config.GUILD_ID } }, client: { user: { id: 'bot' } }, channels: {
            cache: new Map(canales.map(c => [c.id, c])),
            fetch: async id => (id ? canales.find(c => c.id === id) ?? null : null),
            create: async () => { creadosAqui++; return mk('999', 'nuevo', 0, '100'); },
        } };
        const r = await logs4.asegurarTodos(g7);
        assert(r.categoria === '100' && r.mensajes === '101' && r.transcripciones === '102' && r.seguridad === '103', 'con duplicados, usa la categoría y los canales ORIGINALES (los más antiguos)');
        assert(creadosAqui === 0 && r.creados.length === 0, 'y no crea ninguno nuevo');
        assert(logs4.tipoDe('901') === null && logs4.tipoDe('101') === 'mensajes', 'los duplicados dejan de ser canales de registro');
        const fs2 = require('fs'); const f = require('../../utils/dataDir').dataPath('logCanales.json'); if (fs2.existsSync(f)) fs2.unlinkSync(f);
    }

    // ── 8. Archivo en disco ──────────────────────────────────────────────────
    const arch = require('../../utils/archivo');
    const { AttachmentBuilder } = require('discord.js');
    arch.__test.reset();
    const idA = arch.registrar('pruebatipo', { content: 'hola', embeds: [new EmbedBuilder().setTitle('T1')], files: [new AttachmentBuilder(Buffer.from('datos'), { name: 'a.txt' })] }, 'MSG1');
    assert(idA && arch.entradas('pruebatipo').length === 1, 'registrar guarda la entrada');
    const enc = arch.porMensaje('MSG1', ['pruebatipo']);
    assert(enc?.entrada.id === idA, 'se encuentra por el id del mensaje de Discord');
    const pl = arch.payloadDe('pruebatipo', enc.entrada, 'Restaurado');
    assert(pl.embeds[0].toJSON().footer.text.includes('Restaurado') && pl.files[0].attachment.toString() === 'datos', 'el payload restaurado lleva la nota y el archivo idéntico');
    arch.alias('pruebatipo', 'MSG2', idA);
    arch.__test.reset();
    assert(arch.porMensaje('MSG2', ['pruebatipo'])?.entrada.id === idA, 'un mensaje re-publicado apunta al mismo registro (también tras reiniciar)');
    // Limpieza de entradas de otros servidores.
    arch.registrar('pruebatipo', { embeds: [new EmbedBuilder().setTitle('de 7x')] }, 'MSG7', config.GUILD_ID);
    arch.registrar('pruebatipo', { embeds: [new EmbedBuilder().setTitle('de ACxQW')] }, 'MSGX', '1111111111111111111');
    arch.registrar('pruebatipo', { embeds: [new EmbedBuilder().setTitle('vieja ajena')] }, 'MSGVIEJA');
    const quitadas = arch.depurarAjenos(['pruebatipo'], config.GUILD_ID, new Set(['MSG1']));
    const titulos = arch.entradas('pruebatipo').map(e => e.embeds[0]?.title);
    assert(quitadas === 2 && titulos.includes('de 7x') && titulos.includes('T1') && !titulos.includes('de ACxQW') && !titulos.includes('vieja ajena'), 'depura: fuera lo de otros servidores y lo antiguo que no está en 7x');
    assert(arch.porMensaje('MSG2', ['pruebatipo'])?.entrada.id === idA, 'y conserva los alias de lo que se queda');
    assert(arch.depurarAjenos(['pruebatipo'], config.GUILD_ID, new Set()) === null, 'la limpieza sólo se hace una vez');
    fs.rmSync(require('path').join(arch.DIR), { recursive: true, force: true });

    return finish();
};
