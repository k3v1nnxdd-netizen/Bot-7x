'use strict';

// Tests para Check Group's: la parte que decide si alguien es elegible para
// recibir Robux desde una comunidad de Roblox, y la tarjeta que se publica en
// el canal de resultados. Sin red y sin cliente de Discord.
//
// Lo que protegen es exactamente lo que dolería y que un smoke test manual no
// vería:
//
//   1. UN FALLO DE LA API NUNCA ES "NO ELEGIBLE". Si Roblox no contesta no se
//      publica NADA: sólo un aviso efímero al usuario. Convertir un timeout en
//      un veredicto negativo le niega Robux a un cliente que sí los tenía
//      ganados, y en el canal se vería idéntico a un "no" legítimo.
//   0. NO HAY BOTONES BAJO UN RESULTADO. El sistema es 100% automático: si
//      alguna vez volviera a publicarse un `components`, alguien podría decidir
//      a mano lo que Roblox ya había decidido.
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
const flowModule = require('../../handlers/checkGroupFlow');
const { __test: flow, handleCheckGroupModal } = flowModule;

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

    // El anti-spam es de verdad (15 s de cooldown, 6 por 10 min), así que para
    // los bloques que ejercitan el handler varias veces seguidas se abre la mano
    // y se restaura al final. La sección 16 lo prueba con sus propios números.
    const antispamOriginal = { ...config.CHECKGROUP_ANTISPAM };
    Object.assign(config.CHECKGROUP_ANTISPAM, { COOLDOWN_MS: 0, MAX_PER_WINDOW: 10_000, WINDOW_MS: 60_000 });

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
            assert(capturado?.eligible === undefined && capturado?.isMember === undefined, `"${codigoApi}" no lleva ningún veredicto encima: es un error, no un resultado`);
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
        roblox.getUserByUsername = async nombre => ({ id: idDe(nombre), name: nombre, displayName: `Display ${nombre}` });

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

        // ── 10. La tarjeta: compacta, horizontal y sin botones ──────────────
        const ingreso = new Date('2026-02-14T10:00:00.000Z');
        const unixIngreso = Math.floor(ingreso.getTime() / 1000);

        const { embed: elegible, fallbackFile } = flow.buildResultEmbed({
            groupKey: GROUP_KEY,
            groupLabel: GROUP.label,
            robloxUsername: USERNAME,
            status: 'eligible',
            joinedAt: ingreso,
            days: 198,
            avatarUrl: 'https://tr.rbxcdn.com/avatar.png',
            iconUrl: 'https://tr.rbxcdn.com/icono.png',
            requesterName: 'Kevin',
        });
        const tarjeta = elegible.data;
        const campos = tarjeta.fields ?? [];
        const campo = nombre => campos.find(f => f.name === nombre)?.value ?? '';
        const todo = campos.map(f => f.value).join('\n');

        assert(tarjeta.title === `Check Group's — ${GROUP.label}`, 'el título lleva la comunidad consultada');
        assert(campos.length === 3, `un resultado elegible son 3 columnas y nada más (tiene ${campos.length})`);

        // El jugador: nombre + foto pequeña a la izquierda, estilo Discord.
        assert(tarjeta.author?.name === USERNAME, 'el usuario de Roblox va en el author, junto a su foto');
        assert(tarjeta.author?.icon_url === 'https://tr.rbxcdn.com/avatar.png', 'el avatar del jugador es el icono del author (pequeño y redondo)');
        // La comunidad: thumbnail arriba a la derecha, nunca imagen grande.
        assert(tarjeta.thumbnail?.url === 'https://tr.rbxcdn.com/icono.png', 'el icono de la comunidad va de thumbnail');
        assert(tarjeta.image === undefined, 'NADA de imagen grande abajo: eso es lo que hacía el embed demasiado alto');
        assert(fallbackFile === null, 'con icono de Roblox no se adjunta ningún PNG local');

        assert(campos.every(f => f.inline === true), 'las tres columnas son inline: el resultado se lee horizontal');
        assert(campo(flow.FIELD.JOINED) === `<t:${unixIngreso}:D>`, 'la fecha de ingreso es un timestamp de Discord (zona horaria de cada quien)');
        assert(campo(flow.FIELD.AGE) === '**198 días**', 'la antigüedad son los días calculados desde createTime');
        assert(campo(flow.FIELD.STATUS).includes('ELEGIBLE'), 'el estado da el veredicto');

        // Los dos emojis del veredicto, escritos aquí a mano a propósito: si
        // alguien cambia un id en checkGroupFlow.js, este archivo tiene que
        // discrepar. Un id equivocado no rompe nada — simplemente se imprime
        // crudo en el canal, que es justo el fallo que nadie revisa.
        const E_ELEGIBLE = '<a:add:1540603311890104321>';
        const E_NO_ELEGIBLE = '<a:remove:1540604743234228364>';
        assert(flow.statusValue('eligible') === `${E_ELEGIBLE} **ELEGIBLE**`, 'ELEGIBLE lleva el emoji add');
        assert(flow.statusValue('not_eligible') === `${E_NO_ELEGIBLE} **NO ELEGIBLE**`, 'NO ELEGIBLE lleva el emoji remove');
        assert(flow.statusValue('not_member') === `${E_NO_ELEGIBLE} **NO PERTENECE**`, 'NO PERTENECE lleva el mismo emoji remove: para quien pregunta es el mismo "hoy no"');
        assert(!todo.includes('2026'), 'ninguna fecha se escribe a mano: sólo va el timestamp');

        // Lo que ya NO debe aparecer en ningún sitio de la tarjeta.
        const tarjetaEntera = JSON.stringify(tarjeta);
        for (const prohibido of ['UserId', 'GroupId', 'Discord ID', 'Open Cloud', 'Display Name', 'Mínimo requerido', 'revisión manual', 'NO VERIFICADO', String(GROUP.groupId)]) {
            assert(!tarjetaEntera.includes(prohibido), `la tarjeta ya no muestra "${prohibido}"`);
        }
        assert(!tarjetaEntera.includes('<@'), 'no se menciona a nadie: el solicitante va discreto en el footer');
        assert(tarjeta.timestamp === undefined, 'sin hora de solicitud');

        // El solicitante: en el footer, por nombre, nunca por ID.
        assert(tarjeta.footer?.text === 'Solicitado por Kevin', 'el footer dice quién lo solicitó, por su nombre de Discord');
        assert(!EMOJI_SERVIDOR.test(tarjeta.footer?.text ?? ''), 'sin emojis del servidor en el footer (saldría crudo)');
        assert(!EMOJI_SERVIDOR.test(tarjeta.title ?? ''), 'ni en el título (saldría crudo)');
        assert(!campos.some(f => EMOJI_SERVIDOR.test(f.name)), 'ni en el NOMBRE de un campo (saldría crudo)');
        assert(EMOJI_SERVIDOR.test(todo), 'sí en el value de los campos, que es donde Discord los pinta');

        for (const f of campos) {
            assert(f.name.length >= 1 && f.name.length <= 256 && f.value.length <= 1024, `el campo "${f.name}" cabe en los límites de Discord`);
        }

        // ── 11. "Le faltan N días" sólo cuando de verdad falta ──────────────
        const casiElegible = flow.buildResultEmbed({
            groupKey: GROUP_KEY, groupLabel: GROUP.label, robloxUsername: USERNAME,
            status: 'not_eligible', joinedAt: ingreso, days: min - 6, requesterName: 'Kevin',
        }).embed.data;
        assert((casiElegible.fields ?? []).length === 4, 'un no-elegible añade UNA línea, no otro bloque');
        const linea = (casiElegible.fields ?? [])[3];
        assert(linea.name === flow.BLANK_FIELD_NAME, 'esa línea no lleva encabezado: va suelta bajo las columnas');
        assert(linea.inline === false, 'y ocupa el ancho completo, debajo de las tres columnas');
        assert(linea.value.includes('**6 días**'), 'dice cuántos días faltan');
        assert(linea.value.includes('para ser elegible'), 'y para qué');
        assert(flow.missingDaysLine(min - 1).includes('Le falta **1 día**'), 'un solo día se escribe en singular');
        assert(!JSON.stringify(casiElegible).includes(`**${min} días**`), 'sin bloque de "mínimo requerido": el mínimo ya se deduce de la línea');

        assert((elegible.data.fields ?? []).length === 3, 'a quien ya es elegible no se le dice cuántos días le faltan');

        // ── 12. No pertenece: veredicto, sin datos inventados ───────────────
        const noMiembro = flow.buildResultEmbed({
            groupKey: GROUP_KEY, groupLabel: GROUP.label, robloxUsername: USERNAME,
            status: 'not_member', requesterName: 'Kevin',
        }).embed.data;
        const campoNo = nombre => (noMiembro.fields ?? []).find(f => f.name === nombre)?.value ?? '';
        assert(campoNo(flow.FIELD.STATUS).includes('NO PERTENECE'), 'un no-miembro lo dice claramente');
        assert(campoNo(flow.FIELD.JOINED) === '—' && campoNo(flow.FIELD.AGE) === '—', 'sin fecha de ingreso ni días inventados');
        assert((noMiembro.fields ?? []).length === 3, 'y sin línea de días faltantes');

        // Sin icono de Roblox se cae al PNG local, y sólo entonces.
        const { embed: sinIcono, fallbackFile: local } = flow.buildResultEmbed({
            groupKey: GROUP_KEY, groupLabel: GROUP.label, robloxUsername: USERNAME,
            status: 'eligible', joinedAt: ingreso, days: 198,
        });
        assert(local !== null, 'sin icono de Roblox se recurre al PNG local del repo');
        assert(sinIcono.data.thumbnail?.url === `attachment://${local.attachName}`, 'y se referencia como adjunto, siempre de thumbnail');
        assert(sinIcono.data.author?.icon_url === undefined, 'sin avatar el author va sin icono, no con uno vacío');
        assert(sinIcono.data.footer === undefined, 'sin solicitante no se pone un footer vacío');

        // ── 13. Ni rastro del flujo manual ──────────────────────────────────
        const fuente = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'handlers', 'checkGroupFlow.js'), 'utf8');
        for (const muerto of ['pendingByUser', 'MAX_PENDING', 'manual_eligible', 'manual_not_eligible', 'ButtonBuilder', 'buildEligibilityRow', 'handleEligibilityConfirm', 'OWNER_ID', 'revisión manual', 'NO VERIFICADO']) {
            assert(!fuente.includes(muerto), `el flujo ya no contiene "${muerto}"`);
        }
        assert(!Object.keys(flowModule).includes('handleEligibilityButton'), 'el módulo no exporta ningún handler de elegibilidad manual');
        assert(!require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'handlers', 'buttons.js'), 'utf8').includes('cg_elig'),
            'buttons.js ya no tiene guards para los botones manuales');

        // ── 14. El handler completo, con una interacción falsa ──────────────
        // Es lo único que puede demostrar de verdad las dos reglas que más
        // importan: que un resultado se publica SIN botones, y que un fallo de
        // Roblox no publica absolutamente nada.
        roblox.getHeadshot = async () => 'https://tr.rbxcdn.com/avatar.png';
        roblox.getGroupIcon = async () => 'https://tr.rbxcdn.com/icono.png';

        const enviados = [];
        const efimeros = [];
        const canalFalso = { id: config.CHANNELS.CHECKGROUP_RESULTS, send: async payload => { enviados.push(payload); return { id: 'msg' }; } };

        const interaccionFalsa = (nombreUsuario, discordId = '996310284803248158') => {
            const i = {
                customId: `cg_modal_${GROUP_KEY}`,
                replied: false,
                deferred: false,
                fields: { getTextInputValue: () => nombreUsuario },
                user: { id: discordId, username: 'kevin' },
                member: { displayName: 'Kevin' },
                client: {
                    channels: {
                        cache: { get: id => (id === config.CHANNELS.CHECKGROUP_RESULTS ? canalFalso : null) },
                        fetch: async () => null,
                    },
                },
                deferReply: async () => { i.deferred = true; },
                editReply: async payload => { efimeros.push(payload); },
                reply: async payload => { i.replied = true; efimeros.push(payload); },
            };
            return i;
        };

        // 14a. Resultado correcto -> se publica, sin components.
        enviados.length = 0; efimeros.length = 0;
        respuestaMembresia = { createTime: haceDias(198), role: null, user: null };
        await handleCheckGroupModal(interaccionFalsa(usuarioNuevo()));
        assert(enviados.length === 1, `un resultado correcto publica exactamente una tarjeta (fueron ${enviados.length})`);
        assert(enviados[0].components === undefined, 'y NO lleva components: no hay ningún botón bajo el resultado');
        assert(enviados[0].embeds?.length === 1, 'lleva el embed del resultado');
        assert(enviados[0].embeds[0].data.fields.every(f => f.inline), 'con sus columnas horizontales');
        assert(enviados[0].embeds[0].data.footer?.text === 'Solicitado por Kevin', 'y el solicitante en el footer');
        assert(efimeros.length === 1 && efimeros[0].content.includes('elegible'), 'y al usuario se le confirma en efímero');

        // 14b. Open Cloud falla -> NO se publica nada, y NO es "no elegible".
        enviados.length = 0; efimeros.length = 0;
        respuestaMembresia = () => { const e = new Error('caído'); e.code = 'unauthorized'; throw e; };
        await handleCheckGroupModal(interaccionFalsa(usuarioNuevo()));
        assert(enviados.length === 0, 'un fallo de Open Cloud NO publica ninguna tarjeta');
        assert(efimeros.length === 1, 'sólo se responde al usuario en efímero');
        assert(efimeros[0].content === flow.GENERIC_FAILURE, 'con el mensaje de "no se pudo comprobar, intenta más tarde"');
        assert(!efimeros[0].content.includes('ELEGIBLE'), 'un fallo NUNCA se muestra como veredicto');
        assert(!/key|api|token/i.test(efimeros[0].content), 'y el mensaje no filtra ningún detalle técnico');

        // 14c. Sin ROBLOX_OPEN_CLOUD_KEY el resultado es el mismo: aviso, nada más.
        enviados.length = 0; efimeros.length = 0;
        respuestaMembresia = () => { const e = new Error('sin key'); e.code = 'not_configured'; throw e; };
        await handleCheckGroupModal(interaccionFalsa(usuarioNuevo()));
        assert(enviados.length === 0, 'sin API key tampoco se publica nada');
        assert(efimeros[0].content === flow.GENERIC_FAILURE, 'y el usuario ve el mismo aviso genérico');

        // 14d. Un username inexistente sí se le explica al usuario.
        enviados.length = 0; efimeros.length = 0;
        roblox.getUserByUsername = async () => { throw new Error('not_found'); };
        await handleCheckGroupModal(interaccionFalsa('NoExisteEsteUser'));
        assert(enviados.length === 0, 'un username inexistente no publica tarjeta');
        assert(efimeros[0].content.includes('NoExisteEsteUser'), 'y se le dice exactamente qué revisar');
        roblox.getUserByUsername = async nombre => ({ id: idDe(nombre), name: nombre, displayName: `Display ${nombre}` });

        // 14e. No pertenece: sí se publica, también sin botones.
        enviados.length = 0; efimeros.length = 0;
        respuestaMembresia = null;
        await handleCheckGroupModal(interaccionFalsa(usuarioNuevo()));
        assert(enviados.length === 1, 'un "no pertenece" sí es un veredicto y se publica');
        assert(enviados[0].components === undefined, 'tampoco lleva botones');
        assert(JSON.stringify(enviados[0].embeds[0].data).includes('NO PERTENECE'), 'y dice NO PERTENECE');

        // ── 15. Los tres grupos y el canal de resultados ─────────────────────
        const ESPERADOS = { noctra: 282134403, community: 59218460, group7x: 1101699267 };
        for (const [clave, id] of Object.entries(ESPERADOS)) {
            assert(config.CHECK_GROUPS[clave]?.groupId === id, `cg_${clave} apunta al grupo ${id}`);
        }
        assert(config.CHECK_GROUPS.group7x.label === '#7x $tudio', 'group7x se llama #7x $tudio');
        assert(Object.keys(config.CHECK_GROUPS).length === 3, 'no hay más comunidades configuradas de las tres esperadas');
        assert(config.CHANNELS.CHECKGROUP_RESULTS === '1534758835531808869', 'el canal de resultados es el 1534758835531808869');
        assert(enviados.every(() => canalFalso.id === '1534758835531808869'), 'y es el único canal al que se publica');
        // ── 16. Anti-spam: por usuario, y ANTES de tocar Roblox ─────────────
        // Lo que se prueba no es "se muestra un aviso" sino las dos
        // consecuencias que importan: que una solicitud frenada NO llega a
        // Roblox y NO publica nada en el canal.
        Object.assign(config.CHECKGROUP_ANTISPAM, { COOLDOWN_MS: 30_000, MAX_PER_WINDOW: 3, WINDOW_MS: 60_000 });
        respuestaMembresia = { createTime: haceDias(198), role: null, user: null };

        // 16a. Cooldown: la segunda seguida se corta en seco.
        enviados.length = 0; efimeros.length = 0; llamadas.length = 0;
        const spammer = '111111111111111111';
        await handleCheckGroupModal(interaccionFalsa(usuarioNuevo(), spammer));
        assert(enviados.length === 1, 'la primera comprobación pasa con normalidad');
        const llamadasTrasPrimera = llamadas.length;

        efimeros.length = 0;
        await handleCheckGroupModal(interaccionFalsa(usuarioNuevo(), spammer));
        assert(enviados.length === 1, 'la segunda seguida NO publica nada en el canal');
        assert(llamadas.length === llamadasTrasPrimera, 'y NO gasta ninguna petición a Roblox');
        assert(efimeros.length === 1 && efimeros[0].content.includes('Podrás hacer otra'), 'al usuario se le dice que espere');
        assert(/<t:\d+:R>/.test(efimeros[0].content), 'con un timestamp de Discord, no con un "espera un momento" inútil');

        // 16b. Cuota: aunque pase el cooldown, no se puede seguir indefinidamente.
        Object.assign(config.CHECKGROUP_ANTISPAM, { COOLDOWN_MS: 0, MAX_PER_WINDOW: 3, WINDOW_MS: 60_000 });
        enviados.length = 0; efimeros.length = 0;
        const cuotero = '222222222222222222';
        for (let i = 0; i < 3; i++) await handleCheckGroupModal(interaccionFalsa(usuarioNuevo(), cuotero));
        assert(enviados.length === 3, `se permiten las 3 del periodo (publicadas ${enviados.length})`);

        efimeros.length = 0;
        const llamadasTrasCuota = llamadas.length;
        await handleCheckGroupModal(interaccionFalsa(usuarioNuevo(), cuotero));
        assert(enviados.length === 3, 'la cuarta ya no publica nada');
        assert(llamadas.length === llamadasTrasCuota, 'ni llega a Roblox');
        assert(efimeros[0].content.includes('3 comprobaciones'), 'y se le dice cuántas lleva');
        assert(/<t:\d+:R>/.test(efimeros[0].content), 'y cuándo podrá volver a intentarlo');

        // 16c. El freno es POR USUARIO: otro no hereda el castigo.
        enviados.length = 0; efimeros.length = 0;
        await handleCheckGroupModal(interaccionFalsa(usuarioNuevo(), '333333333333333333'));
        assert(enviados.length === 1, 'otro usuario distinto no queda frenado por el spam del primero');

        // 16d. Una errata no gasta cuota: no cuesta ninguna petición a Roblox.
        enviados.length = 0; efimeros.length = 0;
        const torpe = '444444444444444444';
        for (let i = 0; i < 5; i++) await handleCheckGroupModal(interaccionFalsa('no válido!', torpe));
        assert(enviados.length === 0, 'un username mal escrito nunca publica nada');
        assert(efimeros.every(e => e.content.includes('3-20 caracteres')), 'se le explica qué formato se espera');
        efimeros.length = 0;
        await handleCheckGroupModal(interaccionFalsa(usuarioNuevo(), torpe));
        assert(enviados.length === 1, 'y sus 5 erratas no le han gastado el cupo: la siguiente buena pasa');

        // 16e. Los límites salen de config, no están escritos en el flujo.
        const fuenteFlujo = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'handlers', 'checkGroupFlow.js'), 'utf8');
        assert(fuenteFlujo.includes('config.CHECKGROUP_ANTISPAM'), 'el flujo lee los límites de config');
        assert(!/COOLDOWN_MS\s*[:=]\s*\d/.test(fuenteFlujo), 'y no tiene ningún número de anti-spam escrito a mano');
        for (const clave of ['COOLDOWN_MS', 'MAX_PER_WINDOW', 'WINDOW_MS']) {
            assert(typeof antispamOriginal[clave] === 'number' && antispamOriginal[clave] > 0, `config.CHECKGROUP_ANTISPAM.${clave} está definido`);
        }
    } finally {
        roblox.getUserByUsername = originalGetUserByUsername;
        roblox.getGroupMembership = originalGetGroupMembership;
        roblox.getHeadshot = originalGetHeadshot;
        roblox.getGroupIcon = originalGetGroupIcon;
        Object.assign(config.CHECKGROUP_ANTISPAM, antispamOriginal);
    }

    return finish();
};
