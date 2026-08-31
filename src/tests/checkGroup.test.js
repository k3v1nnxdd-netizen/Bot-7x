'use strict';

// Tests para Check Group's: la parte que decide si alguien es elegible para
// recibir Robux desde una comunidad de Roblox, y la tarjeta que se publica en
// el canal de resultados. Sin red y sin cliente de Discord.
//
// Lo que protegen es exactamente lo que dolería y que un smoke test manual no
// vería:
//
//   1. UN FALLO DE LA API NUNCA ES "NO ELEGIBLE". Si Roblox no contesta, el
//      resultado tiene que ser "no se pudo comprobar" y seguir su camino a
//      revisión manual. Convertir un timeout en un veredicto negativo le
//      niega Robux a un cliente que sí los tenía ganados, y en pantalla se ve
//      idéntico a un "no" legítimo.
//   2. NO SE RECORRE LA COMUNIDAD. La consulta va filtrada por userId contra
//      Open Cloud: una petición, sin paginar miembros. Si alguien cambiara eso
//      por un listado, la factura de rate limit aparecería en producción.
//   3. LA API KEY NUNCA SALE DE client.js. Un error de axios lleva dentro
//      err.config.headers — la key incluida — así que la ruta de fallo es
//      justamente donde un secreto se cuela en un log de Railway.
//   4. EL MÍNIMO DE DÍAS SALE DE config.MIN_GROUP_DAYS. Es el número que el
//      dueño va a querer cambiar, y tiene que cambiar en un solo sitio.
//   5. LOS EMOJIS DEL SERVIDOR SOLO DONDE DISCORD LOS PINTA: content,
//      descripción del embed y value de un field. En un título o en el footer
//      se imprimen crudos.

// Se define ANTES de requerir el cliente: lee process.env una sola vez, al
// cargarse, igual que el resto de módulos de configuración del proyecto.
const SECRETO = 'clave-open-cloud-de-prueba-nunca-debe-aparecer';
process.env.ROBLOX_OPEN_CLOUD_KEY = SECRETO;

const { createSuite } = require('./testHarness');
const roblox = require('../roblox/client');
const { CircuitOpenError } = require('../roblox/rateLimiter');
const config = require('../../config');
const { checkMembership, isValidUsername, getGroup, getPlayerAvatar, getCommunityIcon, GroupCheckError } = require('../../utils/groupMembership');
const { __test: flow } = require('../../handlers/checkGroupFlow');

const GROUP_KEY = 'noctra';
const GROUP = config.CHECK_GROUPS[GROUP_KEY];
const USERNAME = 'Soykevinsitop';

const DIA_MS = 86_400_000;
const haceDias = dias => new Date(Date.now() - dias * DIA_MS).toISOString();

// Un username (y por tanto un userId) nuevo por caso. groupMembership cachea
// la identidad por username y la membresía por (grupo, userId), así que
// reutilizarlos haría que un test leyera la respuesta cacheada del anterior en
// vez de la suya — que es exactamente lo que la caché debe hacer en
// producción, y justo lo que arruinaría estas afirmaciones.
let contador = 0;
const usuarioNuevo = () => `Probador${String(contador++).padStart(3, '0')}`;
const idDe = nombre => 900_000 + Number(nombre.replace(/\D/g, '') || 0);

const EMOJI_SERVIDOR = /<a?:[a-zA-Z0-9_]+:\d+>/;

module.exports = async function run() {
    const { assert, finish } = createSuite('checkGroup');

    const originalGetUserByUsername = roblox.getUserByUsername;
    const originalGetGroupMembership = roblox.getGroupMembership;
    const originalGetHeadshot = roblox.getHeadshot;
    const originalGetGroupIcon = roblox.getGroupIcon;

    // Cada test declara qué contesta Roblox. `llamadas` es lo que permite
    // afirmar que se consultó UNA membresía filtrada, y no un listado.
    const llamadas = [];
    let respuestaMembresia = null; // valor, o una función que lanza

    roblox.getUserByUsername = async nombre => ({ id: idDe(nombre), name: nombre, displayName: `Display ${nombre}` });
    roblox.getGroupMembership = async (groupId, userId) => {
        llamadas.push({ groupId, userId });
        if (typeof respuestaMembresia === 'function') return respuestaMembresia();
        return respuestaMembresia;
    };

    try {
        // ── 1. Antigüedad y elegibilidad a partir de createTime ──────────────
        const min = config.MIN_GROUP_DAYS;

        respuestaMembresia = { createTime: haceDias(198), role: null, user: null };
        const veterano = await checkMembership(GROUP_KEY, usuarioNuevo());
        assert(veterano.isMember === true, 'una membresía con createTime cuenta como miembro');
        assert(veterano.days === 198, `los días salen de createTime (198, obtenidos ${veterano.days})`);
        assert(veterano.eligible === true, 'con 198 días es elegible');
        assert(veterano.groupId === GROUP.groupId, 'se consulta el groupId que dice config.CHECK_GROUPS');
        assert(veterano.robloxDisplayName === `Display ${veterano.robloxUsername}`, 'el display name viene en la misma respuesta que el UserId: sin petición extra');

        respuestaMembresia = { createTime: haceDias(min), role: null, user: null };
        const justo = await checkMembership(GROUP_KEY, usuarioNuevo());
        assert(justo.eligible === true, `justo con ${min} días (el mínimo) ya es elegible`);

        respuestaMembresia = { createTime: haceDias(min - 1), role: null, user: null };
        const casi = await checkMembership(GROUP_KEY, usuarioNuevo());
        assert(casi.days === min - 1, 'un día por debajo del mínimo se cuenta como tal');
        assert(casi.eligible === false, `con ${min - 1} días todavía NO es elegible`);

        respuestaMembresia = { createTime: new Date().toISOString(), role: null, user: null };
        const reciente = await checkMembership(GROUP_KEY, usuarioNuevo());
        assert(reciente.days === 0, 'quien acaba de entrar lleva 0 días, no 1');
        assert(reciente.eligible === (min === 0), 'quien acaba de entrar no es elegible');

        // ── 2. Una sola consulta, filtrada por userId ────────────────────────
        llamadas.length = 0;
        respuestaMembresia = { createTime: haceDias(30), role: null, user: null };
        const unaSola = await checkMembership(GROUP_KEY, usuarioNuevo());
        assert(llamadas.length === 1, `una única consulta de membresía por comprobación (fueron ${llamadas.length})`);
        assert(llamadas[0].userId === unaSola.robloxUserId, 'la consulta va filtrada por el userId concreto, no por la lista de miembros');
        assert(llamadas[0].groupId === GROUP.groupId, 'la consulta va contra el grupo del botón pulsado');

        // Y repetir la misma comprobación no vuelve a molestar a Roblox.
        await checkMembership(GROUP_KEY, unaSola.robloxUsername);
        assert(llamadas.length === 1, `repetir la misma consulta se sirve de la caché (llamadas: ${llamadas.length})`);

        // ── 3. No pertenece al grupo ────────────────────────────────────────
        respuestaMembresia = null;
        const fuera = await checkMembership(GROUP_KEY, usuarioNuevo());
        assert(fuera.isMember === false, 'sin membresía, isMember es false');
        assert(fuera.days === null, 'sin membresía no se inventa un número de días');
        assert(fuera.eligible === false, 'quien no está en la comunidad no es elegible');

        // ── 4. Un fallo NUNCA se convierte en "no elegible" ─────────────────
        const fallos = [
            ['not_configured', 'open_cloud_not_configured'],
            ['unauthorized', 'open_cloud_unauthorized'],
            ['rate_limited', 'rate_limited'],
            ['upstream', 'roblox_unavailable'],
            ['network', 'roblox_unavailable'],
        ];
        for (const [codigoApi, codigoEsperado] of fallos) {
            respuestaMembresia = () => {
                const err = new Error('fallo simulado');
                err.code = codigoApi;
                throw err;
            };
            let capturado = null;
            try { await checkMembership(GROUP_KEY, usuarioNuevo()); }
            catch (err) { capturado = err; }
            assert(capturado instanceof GroupCheckError, `un fallo "${codigoApi}" lanza GroupCheckError en vez de devolver un veredicto`);
            assert(capturado?.code === codigoEsperado, `"${codigoApi}" se traduce a "${codigoEsperado}" (fue "${capturado?.code}")`);
            assert(capturado?.robloxUser?.id > 0, `"${codigoApi}" adjunta el usuario ya resuelto, para que la tarjeta manual salga igual de completa`);
        }

        // Un createTime ilegible es lo mismo: "no se pudo comprobar".
        respuestaMembresia = { createTime: 'no-es-una-fecha', role: null, user: null };
        let ilegible = null;
        try { await checkMembership(GROUP_KEY, usuarioNuevo()); }
        catch (err) { ilegible = err; }
        assert(ilegible?.code === 'invalid_create_time', 'un createTime ilegible es un error, no un "no elegible"');

        // ── 5. Un usuario que no existe sí es culpa del usuario ─────────────
        roblox.getUserByUsername = async () => { throw new Error('not_found'); };
        let inexistente = null;
        try { await checkMembership(GROUP_KEY, usuarioNuevo()); }
        catch (err) { inexistente = err; }
        assert(inexistente?.code === 'user_not_found', 'un username que Roblox no conoce da user_not_found');
        roblox.getUserByUsername = async nombre => ({ id: USER_ID, name: nombre });

        // ── 6. Validación del username antes de gastar una petición ─────────
        assert(isValidUsername('Soykevinsitop') === true, 'un username normal es válido');
        assert(isValidUsername('a_b3') === true, 'letras, números y guion bajo son válidos');
        assert(isValidUsername('ab') === false, 'menos de 3 caracteres no es un username de Roblox');
        assert(isValidUsername('a'.repeat(21)) === false, 'más de 20 caracteres no es un username de Roblox');
        assert(isValidUsername('roblox.com/users/1') === false, 'pegar un link no es un username');
        assert(isValidUsername('@alguien') === false, 'una mención de Discord no es un username');

        llamadas.length = 0;
        let invalido = null;
        try { await checkMembership(GROUP_KEY, 'x'); }
        catch (err) { invalido = err; }
        assert(invalido?.code === 'invalid_username', 'un username inválido se rechaza sin preguntar');
        assert(llamadas.length === 0, 'un username inválido no gasta ninguna petición a Roblox');

        // ── 7. Un grupo sin ID configurado no se consulta ────────────────────
        // Hoy las tres comunidades tienen su groupId, así que el caso se monta
        // a propósito: es el guard que protege de consultar a Roblox con un
        // `null` el día que se añada un cuarto botón antes que su ID.
        const CLAVE_SIN_ID = '__prueba_sin_id';
        config.CHECK_GROUPS[CLAVE_SIN_ID] = { label: 'Comunidad sin ID', groupId: null };
        try {
            llamadas.length = 0;
            let noConfig = null;
            try { await checkMembership(CLAVE_SIN_ID, usuarioNuevo()); }
            catch (err) { noConfig = err; }
            assert(noConfig?.code === 'group_not_configured', 'un grupo sin groupId se avisa en vez de consultar');
            assert(llamadas.length === 0, 'un grupo sin ID no genera ninguna petición a Roblox');
        } finally {
            delete config.CHECK_GROUPS[CLAVE_SIN_ID];
        }

        let desconocido = null;
        try { await checkMembership('grupo_inventado', usuarioNuevo()); }
        catch (err) { desconocido = err; }
        assert(desconocido?.code === 'unknown_group', 'una clave de grupo inventada se rechaza');
        assert(getGroup('grupo_inventado') === null, 'getGroup devuelve null para una clave que no existe');

        // ── 8. La API key nunca sale de client.js ───────────────────────────
        const { toOpenCloudError } = roblox.__test;
        const errorDeAxios = {
            message: `Request failed with status code 401 (key ${SECRETO})`,
            config: { url: 'https://apis.roblox.com/cloud/v2/groups/1/memberships', headers: { 'x-api-key': SECRETO } },
            response: { status: 401, data: { message: SECRETO }, headers: {} },
        };
        const saneado = toOpenCloudError(errorDeAxios);
        assert(saneado.code === 'unauthorized', 'un 401 de Open Cloud se clasifica como unauthorized');
        assert(!JSON.stringify({ m: saneado.message, s: saneado.stack }).includes(SECRETO), 'el error saneado no contiene la API key');
        assert(saneado.config === undefined && saneado.response === undefined, 'el error saneado no arrastra config/response de axios');

        const circuito = toOpenCloudError(new CircuitOpenError('open cloud group memberships', Date.now() + 1000));
        assert(circuito.code === 'rate_limited', 'el circuit breaker abierto se traduce a rate_limited, no a un veredicto');

        for (const [status, esperado] of [[403, 'unauthorized'], [404, 'group_not_found'], [400, 'invalid_request'], [429, 'rate_limited'], [500, 'upstream'], [503, 'upstream']]) {
            const clasificado = toOpenCloudError({ response: { status, headers: {} }, config: { headers: { 'x-api-key': SECRETO } } });
            assert(clasificado.code === esperado, `un ${status} de Open Cloud se clasifica como ${esperado}`);
            assert(!String(clasificado.message).includes(SECRETO), `el mensaje de un ${status} no lleva la API key`);
        }

        // ── 9. Las imágenes: cacheadas, y jamás capaces de tumbar nada ───────
        let llamadasAvatar = 0;
        let llamadasIcono = 0;
        roblox.getHeadshot = async () => { llamadasAvatar++; return 'https://tr.rbxcdn.com/avatar.png'; };
        roblox.getGroupIcon = async () => { llamadasIcono++; return 'https://tr.rbxcdn.com/icono.png'; };

        const userImg = 111_222_333;
        assert(await getPlayerAvatar(userImg) === 'https://tr.rbxcdn.com/avatar.png', 'el avatar del jugador sale de la API de thumbnails de Roblox');
        await getPlayerAvatar(userImg);
        await getPlayerAvatar(userImg);
        assert(llamadasAvatar === 1, `el avatar se cachea: 3 lecturas, ${llamadasAvatar} petición(es)`);

        assert(await getCommunityIcon(GROUP.groupId) === 'https://tr.rbxcdn.com/icono.png', 'el icono de la comunidad sale de Roblox, no del PNG local');
        await getCommunityIcon(GROUP.groupId);
        assert(llamadasIcono === 1, `el icono se cachea: 2 lecturas, ${llamadasIcono} petición(es)`);

        // Un fallo de imagen es decoración perdida, nunca una solicitud rota.
        roblox.getHeadshot = async () => { throw new Error('thumbnails caído'); };
        roblox.getGroupIcon = async () => null; // Roblox aún no lo ha renderizado
        assert(await getPlayerAvatar(999_111) === null, 'si el avatar falla se devuelve null en vez de lanzar');
        assert(await getCommunityIcon(999_222) === null, 'si Roblox no tiene icono listo se devuelve null en vez de lanzar');

        // ── 10. La tarjeta del canal de resultados ──────────────────────────
        const ingreso = new Date('2026-02-14T10:00:00.000Z');
        const solicitud = new Date('2026-08-31T18:30:00.000Z');
        const unixIngreso = Math.floor(ingreso.getTime() / 1000);
        const unixSolicitud = Math.floor(solicitud.getTime() / 1000);

        const { embed: elegible, fallbackFile } = flow.buildResultEmbed({
            groupKey: GROUP_KEY,
            groupLabel: GROUP.label,
            groupId: GROUP.groupId,
            robloxUsername: USERNAME,
            robloxDisplayName: 'Kevin',
            robloxUserId: 3156911153,
            discordUserId: config.OWNER_ID,
            status: 'eligible',
            joinedAt: ingreso,
            days: 198,
            avatarUrl: 'https://tr.rbxcdn.com/avatar.png',
            iconUrl: 'https://tr.rbxcdn.com/icono.png',
            requestedAt: solicitud,
        });
        const tarjeta = elegible.data;
        const campo = nombre => (tarjeta.fields ?? []).find(f => f.name === nombre)?.value ?? '';
        const todo = (tarjeta.fields ?? []).map(f => f.value).join('\n');

        assert(tarjeta.title === "Check Group's", 'el título es Check Group\'s');
        assert((tarjeta.fields ?? []).length === 5, `la tarjeta tiene los 5 bloques (tiene ${(tarjeta.fields ?? []).length})`);

        assert(campo(flow.FIELD.PLAYER).includes(USERNAME), 'el bloque del jugador lleva el username');
        assert(campo(flow.FIELD.PLAYER).includes('Kevin'), 'el bloque del jugador lleva el display name');
        assert(campo(flow.FIELD.PLAYER).includes('3156911153'), 'el bloque del jugador lleva el UserId');
        assert(campo(flow.FIELD.COMMUNITY).includes(GROUP.label), 'el bloque de comunidad lleva el nombre de la comunidad');
        assert(campo(flow.FIELD.COMMUNITY).includes(String(GROUP.groupId)), 'el bloque de comunidad lleva el GroupId');

        assert(campo(flow.FIELD.MEMBERSHIP).includes(`<t:${unixIngreso}:F>`), 'la fecha de ingreso se pinta con un timestamp de Discord (zona horaria de cada quien)');
        assert(campo(flow.FIELD.MEMBERSHIP).includes(`<t:${unixIngreso}:R>`), 'la tarjeta también muestra el "hace cuánto" relativo');
        assert(!todo.includes('2026'), 'ninguna fecha se escribe a mano: sólo van timestamps');
        assert(campo(flow.FIELD.MEMBERSHIP).includes('**198** día'), 'la tarjeta lleva los días de antigüedad');
        assert(campo(flow.FIELD.MEMBERSHIP).includes(`**${min}** días`), 'la tarjeta dice el mínimo requerido');
        assert(campo(flow.FIELD.MEMBERSHIP).includes('MIEMBRO'), 'la tarjeta dice el estado de la membresía');
        assert(!campo(flow.FIELD.MEMBERSHIP).includes('Le faltan'), 'a quien ya cumple el mínimo no se le dice cuántos días le faltan');

        assert(campo(flow.FIELD.RESULT).includes('ELEGIBLE'), 'el bloque de resultado da el veredicto');
        assert(campo(flow.FIELD.RESULT).includes('Open Cloud'), 'el resultado dice que se verificó automáticamente vía Open Cloud');
        assert(campo(flow.FIELD.REQUEST).includes(`<@${config.OWNER_ID}>`), 'quien la solicitó aparece como mención real');
        assert(campo(flow.FIELD.REQUEST).includes(`\`${config.OWNER_ID}\``), 'y también su Discord ID en crudo');
        assert(campo(flow.FIELD.REQUEST).includes(`<t:${unixSolicitud}:F>`), 'la fecha de la solicitud es otro timestamp de Discord');

        assert(tarjeta.thumbnail?.url === 'https://tr.rbxcdn.com/avatar.png', 'el avatar del jugador va de thumbnail');
        assert(tarjeta.image?.url === 'https://tr.rbxcdn.com/icono.png', 'el icono de la comunidad va de imagen');
        assert(fallbackFile === null, 'con icono de Roblox no se adjunta ningún PNG local');

        assert(EMOJI_SERVIDOR.test(todo), 'los emojis del servidor van en el value de los campos, donde Discord los pinta');
        assert(!EMOJI_SERVIDOR.test(tarjeta.title ?? ''), 'ningún emoji del servidor en el título (saldría crudo)');
        assert(!EMOJI_SERVIDOR.test(tarjeta.footer?.text ?? ''), 'ningún emoji del servidor en el footer (saldría crudo)');
        assert(!(tarjeta.fields ?? []).some(f => EMOJI_SERVIDOR.test(f.name)), 'ningún emoji del servidor en el NOMBRE de un campo (saldría crudo)');

        for (const f of tarjeta.fields ?? []) {
            assert(f.name.length <= 256 && f.value.length <= 1024, `el campo "${f.name}" cabe en los límites de Discord`);
        }

        // Sin icono de Roblox se cae al PNG local, y sólo entonces.
        const { embed: sinIcono, fallbackFile: local } = flow.buildResultEmbed({
            groupKey: GROUP_KEY, groupLabel: GROUP.label, groupId: GROUP.groupId,
            robloxUsername: USERNAME, discordUserId: config.OWNER_ID,
            status: 'eligible', joinedAt: ingreso, days: 198, requestedAt: solicitud,
        });
        assert(local !== null, 'sin icono de Roblox se recurre al PNG local del repo');
        assert(sinIcono.data.image?.url === `attachment://${local.attachName}`, 'y se referencia como adjunto');
        assert(sinIcono.data.thumbnail === undefined, 'sin avatar no se pone un thumbnail vacío');

        // ── 11. Una tarjeta sin veredicto ───────────────────────────────────
        const sinVeredicto = flow.buildResultEmbed({
            groupKey: GROUP_KEY, groupLabel: GROUP.label, groupId: GROUP.groupId,
            robloxUsername: USERNAME, discordUserId: config.OWNER_ID,
            status: 'unverified', requestedAt: solicitud,
        }).embed.data;
        const campoSin = nombre => (sinVeredicto.fields ?? []).find(f => f.name === nombre)?.value ?? '';
        assert(!campoSin(flow.FIELD.MEMBERSHIP).includes('<t:'), 'sin fecha de ingreso no se inventa ningún timestamp');
        assert(campoSin(flow.FIELD.MEMBERSHIP).includes('NO SE PUDO COMPROBAR'), 'la membresía queda como no comprobada');
        assert(!campoSin(flow.FIELD.MEMBERSHIP).includes('Le faltan'), 'sin días conocidos no se inventa cuántos faltan');
        assert(campoSin(flow.FIELD.RESULT).includes('NO VERIFICADO'), 'una tarjeta sin veredicto dice NO VERIFICADO');
        assert(!campoSin(flow.FIELD.RESULT).includes('NO ELEGIBLE'), 'una tarjeta sin veredicto NO dice "no elegible"');
        assert(campoSin(flow.FIELD.RESULT).includes('revisión manual'), 'y dice que queda pendiente de revisión manual');
        assert(campoSin(flow.FIELD.REQUEST).includes(`<@${config.OWNER_ID}>`), 'una tarjeta sin veredicto también identifica a quien la pidió');

        // Un no-miembro sí tiene veredicto, pero no antigüedad que enseñar.
        const noMiembro = flow.buildResultEmbed({
            groupKey: GROUP_KEY, groupLabel: GROUP.label, groupId: GROUP.groupId,
            robloxUsername: USERNAME, discordUserId: config.OWNER_ID,
            status: 'not_member', requestedAt: solicitud,
        }).embed.data;
        const campoNo = nombre => (noMiembro.fields ?? []).find(f => f.name === nombre)?.value ?? '';
        assert(campoNo(flow.FIELD.MEMBERSHIP).includes('NO PERTENECE'), 'un no-miembro lo dice en el bloque de membresía');
        assert(campoNo(flow.FIELD.RESULT).includes('Open Cloud'), 'y sigue siendo un veredicto automático de Roblox');

        // ── 12. El mínimo de días sale de config, y el texto lo refleja ──────
        const faltan = flow.statusLine('not_eligible', { days: min - 3 });
        assert(faltan.includes(`**${min} días**`), 'el texto de "no elegible" cita config.MIN_GROUP_DAYS');
        assert(faltan.includes('**3 días**'), 'el texto de "no elegible" dice cuántos días faltan');
        assert(flow.statusLine('not_eligible', { days: min - 1 }).includes('**1 día**'), 'un solo día pendiente se escribe en singular');
        assert(flow.statusLine('not_member').includes('NO PERTENECE'), 'quien no está en la comunidad lo ve dicho tal cual');

        const casiElegible = flow.buildResultEmbed({
            groupKey: GROUP_KEY, groupLabel: GROUP.label, groupId: GROUP.groupId,
            robloxUsername: USERNAME, discordUserId: config.OWNER_ID,
            status: 'not_eligible', joinedAt: ingreso, days: min - 3, requestedAt: solicitud,
        }).embed.data;
        const membresiaCasi = (casiElegible.fields ?? []).find(f => f.name === flow.FIELD.MEMBERSHIP)?.value ?? '';
        assert(membresiaCasi.includes('**Le faltan:** **3**'), 'a quien no cumple el mínimo se le dicen los días que le faltan');

        // ── 13. El veredicto manual reescribe SÓLO el resultado ──────────────
        const reescrita = flow.applyManualStatus(tarjeta, 'manual_not_eligible').data;
        const campoRe = nombre => (reescrita.fields ?? []).find(f => f.name === nombre)?.value ?? '';
        assert(campoRe(flow.FIELD.PLAYER) === campo(flow.FIELD.PLAYER), 'marcar a mano no toca el bloque del jugador');
        assert(campoRe(flow.FIELD.COMMUNITY) === campo(flow.FIELD.COMMUNITY), 'ni el de la comunidad');
        assert(campoRe(flow.FIELD.MEMBERSHIP) === campo(flow.FIELD.MEMBERSHIP), 'ni el de la membresía');
        assert(campoRe(flow.FIELD.REQUEST) === campo(flow.FIELD.REQUEST), 'ni quién la solicitó');
        assert(reescrita.thumbnail?.url === tarjeta.thumbnail?.url, 'ni las imágenes');
        assert(reescrita.image?.url === tarjeta.image?.url, 'ni la imagen de la comunidad');
        assert(campoRe(flow.FIELD.RESULT).includes('Marcado manualmente'), 'un veredicto manual se distingue de uno automático');
        assert(!campoRe(flow.FIELD.RESULT).includes('Puede recibir'), 'el veredicto anterior desaparece, no se acumula');
        assert(!campoRe(flow.FIELD.RESULT).includes('Open Cloud'), 'y ya no dice que lo verificara Roblox');
        assert((reescrita.fields ?? []).length === 5, 'sigue habiendo exactamente 5 bloques');

        assert(flow.extractRequesterId(reescrita) === config.OWNER_ID, 'quien la solicitó se sigue leyendo tras reescribir el resultado');
        assert(flow.extractRequesterId({ fields: [] }) === null, 'una tarjeta sin mención devuelve null en vez de romper');

        // ── 14. Las tarjetas del formato ANTERIOR se siguen pudiendo resolver ─
        const heredada = {
            description: `<:member:1501261625523699892> **Usuario de Roblox**\n\`\`\`${USERNAME}\`\`\`\n` +
                `<:point:1501212595464700104> **Solicitado por**\n<@${config.OWNER_ID}>\n\n` +
                `${flow.STATUS_HEADING}\n${flow.statusLine('unverified')}`,
        };
        const heredadaResuelta = flow.applyManualStatus(heredada, 'manual_eligible').data;
        assert(heredadaResuelta.description.includes('Marcado manualmente'), 'una tarjeta del formato viejo también se puede marcar a mano');
        assert(heredadaResuelta.description.includes(USERNAME), 'y conserva sus datos');
        assert(heredadaResuelta.description.split(flow.STATUS_HEADING).length === 2, 'sin duplicar el bloque de estado');
        assert(flow.extractRequesterId(heredada) === config.OWNER_ID, 'y su solicitante se sigue leyendo de la descripción');

        // ── 15. Los tres grupos y el canal de resultados ─────────────────────
        const ESPERADOS = { noctra: 282134403, community: 59218460, group7x: 1101699267 };
        for (const [clave, id] of Object.entries(ESPERADOS)) {
            assert(config.CHECK_GROUPS[clave]?.groupId === id, `cg_${clave} apunta al grupo ${id}`);
        }
        assert(Object.keys(config.CHECK_GROUPS).length === 3, 'no hay más comunidades configuradas de las tres esperadas');
        assert(config.CHANNELS.CHECKGROUP_RESULTS === '1534758835531808869', 'el canal de resultados es el 1534758835531808869');
    } finally {
        roblox.getUserByUsername = originalGetUserByUsername;
        roblox.getGroupMembership = originalGetGroupMembership;
        roblox.getHeadshot = originalGetHeadshot;
        roblox.getGroupIcon = originalGetGroupIcon;
    }

    return finish();
};
