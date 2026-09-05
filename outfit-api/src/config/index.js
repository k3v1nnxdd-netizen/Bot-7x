'use strict';

const path = require('path');

// Ruta EXPLICITA al .env de este servicio. dotenv por defecto resuelve
// contra process.cwd(), asi que un `node outfit-api/server.js` lanzado desde
// la raiz del repo cargaria el .env del BOT (TOKEN, API_KEY) en vez del
// nuestro — variables que no nos pertenecen y que no queremos ni ver en este
// proceso. Con la ruta fija, este servicio solo lee su propio archivo,
// arranque desde donde arranque. En Railway no existe .env y todo llega por
// variables del dashboard; dotenv simplemente no encuentra archivo y sigue.
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

// Punto UNICO de lectura de process.env en todo el servicio: ningun otro
// modulo toca process.env directamente, asi que el conjunto completo de
// perillas del que depende este proceso se ve de un vistazo aqui en vez de
// aparecer disperso en una docena de archivos.

function intFromEnv(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
        console.warn(`[config] ${name}="${raw}" no es un numero valido — usando el default ${fallback}`);
        return fallback;
    }
    return Math.floor(parsed);
}

const port = intFromEnv('PORT', 3100);

// El UNICO secreto de este servicio. Viaja siempre en el header `x-api-key`
// y jamas por query string: un secreto en la URL termina en los logs de
// acceso de cualquier proxy intermedio, y aqui nunca leemos la query para
// autenticar (ver src/security/apiKey.js).
const apiKey = process.env.OUTFIT_API_KEY || null;

// SEGUNDO secreto, y deliberadamente SEPARADO del anterior. `apiKey` la
// conoce el juego de Roblox — vive dentro de un script que se distribuye a
// servidores que no controlamos, asi que hay que asumir que puede filtrarse.
// `adminApiKey` gobierna quien esta autorizado, es decir, quien paga: si
// fuera la misma clave, cualquiera con acceso al juego podria darse licencia
// a si mismo. Nunca sale de aqui ni de un cliente administrativo nuestro.
// Viaja en su propio header (`x-admin-key`), tambien solo por cabecera.
const adminApiKey = process.env.ADMIN_API_KEY || null;

// TERCER secreto, y de nuevo SEPARADO de los dos anteriores. Lo manda el
// plugin de Roblox Studio en su propia cabecera (`x-plugin-key`) y solo abre
// las rutas /plugin.
//
// Por que otra clave y no reutilizar alguna: el plugin es un binario privado
// que se instala en Studio, un sitio distinto del .rbxl que se vende y del
// panel de administracion. Si compartiera secreto con el juego, filtrarse el
// .rbxl abriria tambien la busqueda; si lo compartiera con /admin, un plugin
// perdido daria control sobre las licencias. Tres publicos, tres claves, y
// ninguna abre la puerta de otra.
//
// Sin ella definida, /plugin responde 503 (igual que /admin sin su clave): la
// ruta queda APAGADA, no abierta.
const pluginApiKey = process.env.PLUGIN_API_KEY || null;

const logLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();

// Un unico driver soportado hoy. La variable existe para que activar Redis
// mañana sea un cambio de configuracion, no de codigo — ver src/cache/cacheStore.js.
const cacheDriver = (process.env.CACHE_DRIVER || 'memory').toLowerCase();

// TTLs. Elegidos por cuanto cambia realmente cada dato, no por intuicion:
//  - Un mapeo username -> userId es practicamente permanente (solo cambia si
//    el jugador se renombra), de ahi las 12 h.
//  - La LISTA de outfits cambia cuando el jugador crea o borra uno; 5 min es
//    lo bastante corto para que lo note en la misma sesion.
//  - El CONTENIDO de un outfit concreto cambia solo si lo edita: 1 h.
//  - La cache negativa es la que impide que un buscador de usernames mande a
//    Roblox cada tecla mal escrita. Es tan importante como la positiva.
//  - La pertenencia de un asset a un bundle es un dato ESTRUCTURAL del
//    catalogo: no depende del jugador ni del outfit y no cambia una vez
//    publicado. De ahi las 24 h, y de ahi que sea global — resuelto una vez,
//    lo aprovechan todos los outfits de todos los jugadores que lleven ese
//    asset.
//  - La ficha de catalogo de un asset (limitado, fuera de venta, precio de
//    reventa) es estructural salvo el precio, que se mueve despacio. 1 h es un
//    equilibrio razonable, y como se cachea POR ASSET la comparte cualquier
//    outfit de cualquier jugador que lleve esa pieza.
const ttl = {
    usernameLookup: intFromEnv('TTL_USERNAME_MS', 12 * 60 * 60_000),
    outfitList: intFromEnv('TTL_OUTFIT_LIST_MS', 5 * 60_000),
    outfitDetails: intFromEnv('TTL_OUTFIT_DETAILS_MS', 60 * 60_000),
    assetBundles: intFromEnv('TTL_ASSET_BUNDLES_MS', 24 * 60 * 60_000),
    catalogDetails: intFromEnv('TTL_CATALOG_DETAILS_MS', 60 * 60_000),
    negative: intFromEnv('TTL_NEGATIVE_MS', 5 * 60_000),

    // De quien es una experiencia de Roblox (verificacion de licencia). 6 h
    // porque un juego cambia de dueño practicamente nunca — y las dos veces
    // que pasa al año, esperar unas horas no rompe nada.
    //
    // Esta cache hace dos trabajos, y el segundo es el importante: ademas de
    // ahorrar dos llamadas a Roblox por servidor que arranca, es lo que
    // mantiene la verificacion en pie cuando Roblox tiene un mal rato. Un
    // juego ya visto se sigue verificando con lo que Roblox dijo hace un rato
    // en vez de quedarse sin respuesta.
    gameOwnership: intFromEnv('TTL_GAME_OWNERSHIP_MS', 6 * 60 * 60_000),

    // Composicion de un bundle (que assets lo forman). Estructural: no cambia
    // nunca una vez publicado, igual que la pertenencia asset -> bundle. De ahi
    // las 24 h, y de ahi que este SEPARADA del precio del bundle, que si se
    // mueve y se cachea con el TTL de catalogo (1 h). Meterlos en la misma
    // entrada obligaria a repreguntar la composicion cada hora sin motivo.
    bundleDetails: intFromEnv('TTL_BUNDLE_DETAILS_MS', 24 * 60 * 60_000),

    // Miembros de un grupo, por pagina de cursor. 10 min: una comunidad gana y
    // pierde gente continuamente, pero para MUESTREAR candidatos da igual que
    // la foto sea de hace un rato — y sin esta cache, dos busquedas seguidas
    // sobre el mismo grupo repetirian pagina por pagina el mismo recorrido.
    groupMembers: intFromEnv('TTL_GROUP_MEMBERS_MS', 10 * 60_000),

    // Avatar ACTUAL de un usuario. 10 min por lo mismo que la lista de
    // outfits: un jugador se cambia de ropa cuando quiere, y una foto de hace
    // minutos sigue siendo un outfit real suyo. Es la cache que hace que
    // repetir una busqueda no vuelva a pagar el avatar de cada candidato.
    userAvatar: intFromEnv('TTL_USER_AVATAR_MS', 10 * 60_000),
};

// Guardia anti-abuso de NUESTRA API, por IP de origen. El default es
// deliberadamente alto: quien nos llama son servidores de Roblox, y un
// servidor = una IP con decenas de jugadores detras. Un limite pensado para
// usuarios individuales cortaria un servidor lleno en cuanto se animara la
// cosa. La proteccion real contra los limites de Roblox no es esto, es la
// cache; esto solo frena un bucle de reintentos desbocado o una key filtrada.
const rateLimit = {
    windowMs: intFromEnv('RATE_LIMIT_WINDOW_MS', 60_000),
    max: intFromEnv('RATE_LIMIT_MAX', 600),
};

// Politica de salida hacia Roblox. Sin cuotas asumidas por endpoint: Roblox
// no publica limites estables para estas rutas y los ajusta sin avisar, asi
// que un 429 se trata como condicion NORMAL y la pauta la marca Roblox
// (Retry-After / x-ratelimit-*), no una constante nuestra. Ver
// src/roblox/rateLimiter.js.
const upstream = {
    timeoutMs: intFromEnv('UPSTREAM_TIMEOUT_MS', 6_000),

    // Techo global de peticiones simultaneas a Roblox, compartido por las tres
    // rutas. Bajo a proposito: bajo carga real la cache absorbe la inmensa
    // mayoria del trafico, y lo que llega hasta aqui conviene que llegue en
    // goteo y no en avalancha.
    maxConcurrent: intFromEnv('UPSTREAM_MAX_CONCURRENT', 3),

    // Cola de espera del gate de concurrencia. Al llenarse se rechaza al
    // instante (503 + Retry-After) en vez de acumular miles de peticiones
    // colgadas: con miles de jugadores es preferible un "vuelve en 2s"
    // inmediato a un socket abierto durante medio minuto.
    maxQueue: intFromEnv('UPSTREAM_MAX_QUEUE', 200),

    maxRetries: intFromEnv('UPSTREAM_MAX_RETRIES', 2),
    retryBaseDelayMs: intFromEnv('UPSTREAM_RETRY_BASE_MS', 300),
    retryMaxDelayMs: intFromEnv('UPSTREAM_RETRY_MAX_MS', 3_000),

    // Cuanto estamos dispuestos a esperar DENTRO de la peticion antes de
    // devolver el control al llamador. Si Roblox pide mas espera que esto,
    // respondemos 503 con Retry-After y que reintente el juego: sostener el
    // socket mas tiempo no acelera nada y multiplica las conexiones abiertas.
    inlineWaitCeilingMs: intFromEnv('UPSTREAM_INLINE_WAIT_CEILING_MS', 2_000),

    circuitFailureThreshold: intFromEnv('UPSTREAM_CIRCUIT_THRESHOLD', 5),
    circuitBaseCooldownMs: intFromEnv('UPSTREAM_CIRCUIT_BASE_COOLDOWN_MS', 5_000),
    circuitMaxCooldownMs: intFromEnv('UPSTREAM_CIRCUIT_MAX_COOLDOWN_MS', 60_000),

    // ── Marcapasos adaptativo (AIMD) por ruta ───────────────────────────────
    //
    // Separacion minima entre dos llamadas de la MISMA ruta. ARRANCA EN CERO:
    // mientras Roblox no se queje no hay separacion ninguna y el trafico del
    // juego se comporta exactamente igual que siempre. Solo aparece cuando
    // Roblox señala presion — un 429, o un 'x-ratelimit-remaining: 0' en una
    // respuesta perfectamente correcta — y se relaja sola conforme las llamadas
    // vuelven a salir bien.
    //
    // Existe por la busqueda del plugin, que es lo unico de este servicio que
    // hace rafagas sostenidas: doce olas seguidas agotan la ventana de cuota del
    // catalogo tan deprisa como la red lo permita. Es la diferencia entre
    // gastarse la cuota en cinco segundos y repartirla a lo largo de la
    // busqueda.
    pacerBaseMs: intFromEnv('UPSTREAM_PACER_BASE_MS', 120),

    // Techo de la separacion. Por encima, esperar mas no compra nada: el
    // cooldown reactivo ya cubre las pausas largas.
    pacerMaxMs: intFromEnv('UPSTREAM_PACER_MAX_MS', 2_000),

    // Por debajo de este suelo el marcapasos se apaga del todo, en vez de
    // dejar temporizadores de 3 ms vivos sin ganar nada.
    pacerMinMs: intFromEnv('UPSTREAM_PACER_MIN_MS', 25),

    // Cuanto se relaja la separacion por cada llamada correcta. 0,9 tarda unas
    // 30 llamadas buenas en apagar el marcapasos desde su base: lo bastante
    // rapido para no penalizar una ruta ya recuperada, y lo bastante lento para
    // no volver a la rafaga al primer acierto.
    pacerDecay: Number(process.env.UPSTREAM_PACER_DECAY ?? 0.9),

    // ── Aprendizaje de cabeceras ────────────────────────────────────────────
    //
    // Cuando Roblox publica x-ratelimit-limit/-remaining/-reset, la cuota que
    // queda se REPARTE a lo largo de lo que queda de ventana en vez de gastarse
    // tan deprisa como la red permita. Es lo unico que evita el burst inicial:
    // el AIMD reacciona a la presion, y para cuando reacciona una ola entera
    // puede haberse comido la ventana.
    //
    // Solo se activa por debajo de esta fraccion de cuota restante: con media
    // ventana por delante no hay nada que repartir, y el trafico normal del
    // juego no paga ninguna separacion.
    pacerHeaderFraction: Number(process.env.UPSTREAM_PACER_HEADER_FRACTION ?? 0.5),

    // ── Concurrencia efectiva POR RUTA ──────────────────────────────────────
    //
    // Cuantas llamadas de una MISMA ruta pueden estar en vuelo a la vez, por
    // debajo del gate global. Solo las rutas listadas tienen tope propio; el
    // resto solo esta acotado por el global.
    //
    // El avatar va a 2 y no a 3 (el global) por el burst inicial: una ola de
    // 25 candidatos con tres en vuelo dispara tres peticiones antes de que la
    // primera respuesta haya enseñado nada de la cuota. Con dos, la primera
    // respuesta llega — y con ella sus cabeceras — antes de que la tercera
    // salga. No es una cuota inventada: es cuantas preguntas se hacen antes de
    // escuchar la primera contestacion.
    routeConcurrency: {
        userAvatar: intFromEnv('UPSTREAM_ROUTE_CONCURRENCY_USER_AVATAR', 2),
        catalogDetails: intFromEnv('UPSTREAM_ROUTE_CONCURRENCY_CATALOG_DETAILS', 2),
    },

    // ── 429 SIN cabecera de espera ──────────────────────────────────────────
    //
    // Cuando Roblox devuelve 429 sin Retry-After ni x-ratelimit-reset, no dice
    // cuanto esperar. La respuesta conservadora es esperar BASTANTE y doblar
    // con cada 429 seguido (5 s, 10 s, 20 s, 40 s, hasta el techo), no adivinar
    // por lo bajo. Antes aqui habia un backoff de 150-3000 ms con reintentos en
    // linea: tres sondeos contra una ruta recien cerrada, cada uno gastando
    // cuota y renovando el limite, y una busqueda entera agotaba sus pausas en
    // veinte segundos. No es una cuota inventada: es cuanto se espera cuando
    // Roblox no dice nada.
    rateLimitFallbackBaseMs: intFromEnv('UPSTREAM_RATE_LIMIT_FALLBACK_BASE_MS', 5_000),
    rateLimitFallbackMaxMs: intFromEnv('UPSTREAM_RATE_LIMIT_FALLBACK_MAX_MS', 60_000),
};

// Tope duro de entradas en memoria. Sin Volume ni disco: si se llena, se
// expulsa la entrada menos recientemente usada. Acota el uso de RAM pase lo
// que pase, incluso si alguien barre millones de userIds.
const cache = {
    maxEntries: intFromEnv('CACHE_MAX_ENTRIES', 50_000),
};

// `limit` restringido a un conjunto cerrado en vez de un rango libre: un
// rango deja que un llamador genere decenas de variantes de clave por pagina
// y fragmente el hit rate de la cache sin ningun beneficio. Tres valores
// cubren cualquier UI real. `maxPage` acota igualmente el espacio de claves.
// La paginacion es POR CURSOR (ver src/roblox/client.js): Roblox ignora
// `page`, asi que aqui no hay ningun tope de paginas que configurar — el
// recorrido termina cuando Roblox deja de devolver token.
const pagination = {
    allowedLimits: [10, 25, 50],
    defaultLimit: 25,
};

// Valores de `outfitType` observados en vivo en las respuestas de
// avatar.roblox.com/v2 (cada outfit del listado trae el suyo) y confirmados
// como filtro valido del mismo endpoint. Se validan contra este conjunto en
// lugar de reenviar cualquier cadena, para que un valor mal escrito devuelva
// un 400 claro nuestro en vez de un error opaco de Roblox. Si Roblox añade un
// tipo, se agrega aqui.
const outfitTypes = ['Avatar', 'DynamicHead', 'Shoes'];

// Tope de assets a los que se les resuelve el bundle en una sola peticion con
// ?bundles=1. Un outfit real no pasa de ~20 assets; el tope existe para que
// una respuesta anormalmente grande de Roblox no se traduzca en una rafaga
// desmedida contra catalog.roblox.com.
const maxBundleLookupsPerRequest = intFromEnv('MAX_BUNDLE_LOOKUPS_PER_REQUEST', 24);

// Tamaño maximo del lote a catalog/v1/catalog/items/details.
//
// 120 es el TOPE REAL del endpoint, comprobado en vivo: con 121 responde 400
// "Invalid count". Se usa entero y no un numero redondo por debajo porque en
// esta ruta el coste de cuota es POR LLAMADA, no por item: un lote de 120 y uno
// de 100 gastan exactamente lo mismo de la ventana de Roblox, asi que dejar
// veinte huecos libres en cada lote es tirar un 17% de la cuota — justo la que
// hacia falta para que la busqueda no se quedara a medias.
const maxCatalogBatchSize = intFromEnv('MAX_CATALOG_BATCH_SIZE', 120);

// ── Limites de POST /v1/catalog/batch ───────────────────────────────────────
// Un outfit real ronda los 20 assets; estos topes dejan 3x de margen y a la
// vez garantizan que UNA peticion nuestra nunca se parta en dos lotes de
// Roblox: 80 items caben de sobra en los 120 que admite items/details
// (comprobado en vivo: 121 -> 400 "Invalid count").
// ── Busqueda de outfits para el plugin de Studio ─────────────────────────────
//
// `amount` SON OUTFITS VALIDOS, NO INTENTOS. Un candidato que no encaja no
// gasta plaza: se sustituye por el siguiente de la comunidad. La busqueda tiene
// que poder seguir recorriendo miembros y paginas hasta juntar lo pedido.
//
// DE AHI QUE HAYA DOS PRESUPUESTOS DE CANDIDATOS, Y NO UNO:
//
//   DESEADO (adaptativo)  cuantos candidatos ESPERAMOS necesitar ahora mismo.
//                         Se recalcula en cada vuelta con la tasa de aceptacion
//                         real de esta busqueda y con la EWMA historica del
//                         grupo. Sirve para dimensionar, estimar y
//                         diagnosticar; NO para terminar. Un grupo caro
//                         simplemente sube el numero y se sigue buscando.
//
//   TECHO DURO (hard)     proteccion extrema contra bucles. Esta pensado para
//                         NO alcanzarse en una busqueda sana: lo normal es
//                         terminar por `amount` alcanzado, por vuelta completa
//                         a la comunidad, por limite real de Roblox o por
//                         presupuesto de tiempo.
//
// Un solo numero hacia las dos cosas, y por eso una busqueda de 10 outfits en
// un grupo con un 3% de aceptacion moria en 60 candidatos con 2 resultados: el
// SUELO del presupuesto (60) era tambien su TECHO.
const pluginSearch = {
    // ── Accesorios minimos de un candidato ───────────────────────────────────
    //
    // Un outfit candidato lleva MAS DE TRES accesorios reales (sombreros,
    // accesorios clasicos, ropa por capas, cejas/pestañas; ver
    // catalog/assetTypes.ACCESSORY_TYPES). Partes del cuerpo, cabezas, caras,
    // ropa clasica, gear, animaciones, emotes y humores NO cuentan.
    //
    // Se decide con la respuesta del avatar en la mano, ANTES de tocar el
    // catalogo: un avatar de dos accesorios no va a ser un outfit, y ponerle
    // precio gastaria la cuota del catalogo en alguien que ya sabemos que no
    // sirve. El valor es el minimo ACEPTADO ("mas de 3" = 4). 0 desactiva la
    // regla; la suite lo usa para los mundos de prueba antiguos de un asset
    // por usuario, que prueban precio y rotacion, no esta regla.
    minAccessories: intFromEnv('PLUGIN_SEARCH_MIN_ACCESSORIES', 4),

    // ── Techo ABSOLUTO de paginas de miembros por busqueda ───────────────────
    //
    // No es el limite normal: el normal sale del techo de candidatos (una
    // pagina son 100 candidatos como mucho). Esto cubre el caso patologico en
    // el que Roblox devuelve paginas indefinidamente y NINGUNA trae miembros
    // nuevos — ahi los candidatos no crecen, asi que su techo no cortaria nunca.
    maxMemberPages: intFromEnv('PLUGIN_SEARCH_MAX_MEMBER_PAGES', 400),

    // Paginas de margen sobre las que exige el techo de candidatos. Cubre las
    // que se gastan sin producir candidatos utiles: el solape del wrap-around y
    // los miembros ya vistos en esta misma busqueda.
    memberPageSlack: intFromEnv('PLUGIN_SEARCH_MEMBER_PAGE_SLACK', 10),

    // ── Presupuesto DESEADO (adaptativo) ─────────────────────────────────────

    // Coste asumido por resultado MIENTRAS NO HAY EVIDENCIA: ni tasa de
    // aceptacion propia ni historial del grupo. En cuanto aparece cualquiera de
    // las dos, este numero deja de usarse.
    candidatesPerResult: intFromEnv('PLUGIN_SEARCH_CANDIDATES_PER_RESULT', 4),

    // Suelo del deseado. Con `amount` bajo y un rango estrecho, cuatro
    // candidatos por resultado no encontrarian nada; esto garantiza una muestra
    // con sentido aunque se pida un solo outfit.
    minCandidates: intFromEnv('PLUGIN_SEARCH_MIN_CANDIDATES', 60),

    // Margen sobre el coste estimado. La estimacion es una media: sin margen,
    // la mitad de las busquedas se quedarian cortas por definicion.
    candidateBudgetMargin: Number(process.env.PLUGIN_SEARCH_CANDIDATE_MARGIN ?? 1.5),

    // Techo de la ESTIMACION de coste por resultado. Una racha mala al principio
    // (los diez primeros candidatos fallan) no puede proyectar un presupuesto
    // absurdo para todo el resto.
    maxCandidatesPerResult: intFromEnv('PLUGIN_SEARCH_MAX_CANDIDATES_PER_RESULT', 120),

    // Candidatos examinados a partir de los cuales la evidencia VIVA de esta
    // busqueda pesa el 100% y el historial del grupo deja de contar. Por debajo
    // se mezclan proporcionalmente: con 10 candidatos la tasa propia es ruido y
    // el historial estima mejor; con 100 ya no.
    candidateFullWeightSample: intFromEnv('PLUGIN_SEARCH_CANDIDATE_FULL_WEIGHT_SAMPLE', 100),

    // ── TECHO DURO de candidatos ─────────────────────────────────────────────
    //
    // El techo es `clamp(amount * hardCandidatesPerResult, min, max)`, asi que
    // la tolerancia por resultado NO es constante: la constante de abajo solo
    // manda en el TRAMO PROPORCIONAL, y en los extremos la cambian el suelo y
    // el techo absoluto.
    //
    //   amount    techo    candidatos/resultado
    //      1      1 500          1 500      <- suelo
    //     10      1 500            150      <- suelo, justo al ras
    //    100     15 000            150      <- proporcional
    //    500     25 000             50      <- techo absoluto
    //
    // Por eso la busqueda publica `effectiveHardCandidatesPerResult` en stats:
    // comparar la tasa de aceptacion observada contra "150" seria comparar
    // contra un numero que en media busqueda no es el que se esta aplicando.
    //
    // Y alcanzar el techo NO demuestra que en la comunidad no haya outfits en
    // el rango pedido: demuestra unicamente que no conseguimos encontrar los
    // suficientes dentro de nuestros limites seguros. La rotacion continua
    // donde quedo, asi que reintentar mira gente nueva y puede dar mas.
    hardCandidatesPerResult: intFromEnv('PLUGIN_SEARCH_HARD_CANDIDATES_PER_RESULT', 150),

    // Suelo del techo duro. Pedir 1 outfit tiene que poder recorrer una
    // comunidad de tamaño normal entera antes de darse por vencido.
    minHardCandidates: intFromEnv('PLUGIN_SEARCH_MIN_HARD_CANDIDATES', 1_500),

    // Techo ABSOLUTO, pase lo que pase y se pida lo que se pida. Es lo que
    // baja la tolerancia a 50 por resultado en un pedido de 500, y es
    // deliberado: 25.000 candidatos ya son 25.000 llamadas de avatar — la unica
    // etapa que no admite lote — y subirlo para conservar la proporcion
    // cargaria la cuota de Roblox del servicio entero persiguiendo un caso que
    // el presupuesto de tiempo cortaria igualmente antes.
    maxCandidates: intFromEnv('PLUGIN_SEARCH_MAX_CANDIDATES', 25_000),

    // Override explicito del techo duro. null = se calcula por `amount`. Existe
    // para poder bajarlo en caliente sin redeploy si algo se desmadra.
    hardCandidateLimit: process.env.PLUGIN_SEARCH_HARD_CANDIDATE_LIMIT === undefined
        ? null
        : intFromEnv('PLUGIN_SEARCH_HARD_CANDIDATE_LIMIT', 1_500),

    // ── Presupuesto de TIEMPO ────────────────────────────────────────────────
    //
    // Es el tope que de verdad le importa a quien espera delante de Studio y el
    // que sostiene el peor caso cuando Roblox va lento. Agotarlo devuelve lo
    // encontrado, nunca un error.
    //
    // ESCALA CON `amount` porque el trabajo escala con `amount`: 25 s eran
    // razonables para 10 outfits en modo sincrono y absurdamente cortos para
    // 500. Ahora la busqueda es asincrona — nadie sostiene un socket — asi que
    // el limite puede ser el que el trabajo necesita en vez del que aguanta una
    // peticion HTTP.
    //
    //   10  ->  30 s     100 -> 100 s     500 -> 180 s (techo)
    //
    // El presupuesto NO empieza a correr mientras la busqueda espera turno del
    // grupo: hacer cola no es buscar, y cobrarselo dejaba a la segunda busqueda
    // de una comunidad sin tiempo antes de mirar a nadie.
    timeBudgetMs: process.env.PLUGIN_SEARCH_TIME_BUDGET_MS === undefined
        ? null // null = se calcula por `amount`; un valor explicito manda sobre todo
        : intFromEnv('PLUGIN_SEARCH_TIME_BUDGET_MS', 30_000),

    // ES UN PRESUPUESTO DE TRABAJO (maxWorking), no de reloj de pared: las
    // pausas por limite de Roblox no lo consumen. Pero SI lo consume el ritmo
    // al que Roblox deja preguntar: con la cuota del avatar repartida al ritmo
    // sostenible por el marcapasos (del orden de una llamada por segundo), 300
    // candidatos son cinco minutos de trabajo real. Y ESTO ES UNA PROTECCION
    // EXTREMA, no el terminador normal: una busqueda de 10 tiene que poder
    // recorrer cientos de candidatos malos al ritmo que Roblox deje sin que
    // este reloj se cruce en medio.
    //
    //   10 -> 10 min     100 -> 55 min     500 -> 60 min (techo)
    timeBudgetBaseMs: intFromEnv('PLUGIN_SEARCH_TIME_BUDGET_BASE_MS', 5 * 60_000),
    timeBudgetPerResultMs: intFromEnv('PLUGIN_SEARCH_TIME_BUDGET_PER_RESULT_MS', 30_000),
    timeBudgetMinMs: intFromEnv('PLUGIN_SEARCH_TIME_BUDGET_MIN_MS', 10 * 60_000),
    timeBudgetMaxMs: intFromEnv('PLUGIN_SEARCH_TIME_BUDGET_MAX_MS', 60 * 60_000),

    // Techo del presupuesto en modo SINCRONO. Ahi si hay un socket abierto al
    // otro lado, y HttpService de Roblox tiene su propio plazo: prometer tres
    // minutos seria prometer un timeout. El modo asincrono no tiene este techo.
    timeBudgetSyncCeilingMs: intFromEnv('PLUGIN_SEARCH_TIME_BUDGET_SYNC_CEILING_MS', 25_000),

    // ── Pausas por limite de Roblox (park / resume) ──────────────────────────
    //
    // Un cooldown de Roblox es una INSTRUCCION DE ESPERAR, no un "no hay
    // outfits". La busqueda se ESTACIONA (checkpoint persistido, lease del
    // grupo renovado, cero peticiones) y se reanuda al llegar resumeAt,
    // exactamente donde se quedo. Puede atravesar varios cooldowns: eso es lo
    // normal cuando la cuota del avatar es estrecha, no una anomalia.
    //
    // El presupuesto de espera es INDEPENDIENTE del de trabajo: estar
    // estacionado no consume tiempo de buscar. Lo que acota el total es el
    // reloj de pared (maxWallClock = trabajo + espera), que es la proteccion
    // EXTREMA para que un trabajo no viva para siempre — no el final normal.
    //
    // PROTECCION EXTREMA, no terminador normal. Los Retry-After reales del
    // avatar han rondado los 25-30 s, y sin cabecera el limitador espera 5-60 s
    // escalonados. Quince minutos de espera acumulada son del orden de treinta
    // cooldowns normales: una busqueda de 10 que necesite eso no esta
    // "peleando con la cuota", esta en una situacion que merece el partial.
    //
    // CON SUELO. Es una proteccion extrema, y una variable de entorno heredada
    // de una version anterior (45 s, 20 s por pausa) la convertia en el
    // terminador normal: un Retry-After de 25 s no cabia y la busqueda acababa
    // "2 de 10 · avatarRateLimit" a los 14 s. Por debajo del suelo se avisa
    // por consola y se aplica el suelo.
    rateLimitWaitBudgetMs: Math.max(
        intFromEnv('PLUGIN_SEARCH_RATE_LIMIT_WAIT_BUDGET_MS', 15 * 60_000),
        5 * 60_000
    ),

    // NO hay techo por pausa. Lo hubo (PLUGIN_SEARCH_RATE_LIMIT_SINGLE_WAIT_MS)
    // y era la condicion exacta que terminaba una busqueda asincrona en su
    // primera pausa. Una pausa, por larga que sea, cambia la fase del trabajo
    // y se espera; lo unico que corta es el reloj de pared global.

    // NO hay contador de pausas. Habia uno (ocho), y era la causa directa del
    // ultimo 2 de 10: pausas de un segundo encadenadas por 429 sin cabecera lo
    // agotaban en veinte segundos. Lo que acota el total es el reloj de pared;
    // una pausa individual, por corta o larga que sea, no es motivo para
    // terminar nada.

    // Margen que se añade a lo que pide Roblox. Volver un milisegundo antes de
    // que la ventana se reabra gasta el reintento y renueva el cooldown.
    rateLimitWaitMarginMs: intFromEnv('PLUGIN_SEARCH_RATE_LIMIT_WAIT_MARGIN_MS', 500),

    // Cada cuanto late un trabajo ESTACIONADO. Es lo que lo distingue de uno
    // muerto: refresca el heartbeat del job y renueva el lease del grupo. Bien
    // por debajo del plazo de adopcion (adoptAfterMs) para que una pausa de
    // 30 s no se confunda nunca con un proceso caido.
    rateLimitHeartbeatMs: intFromEnv('PLUGIN_SEARCH_RATE_LIMIT_HEARTBEAT_MS', 5_000),

    // Candidatos cuyos avatares se piden en paralelo. Por encima del gate
    // global de salida (UPSTREAM_MAX_CONCURRENT) no se gana nada — el limitador
    // ya serializa —, pero mantener varios en vuelo evita que el gate se quede
    // ocioso entre llamada y llamada.
    concurrency: intFromEnv('PLUGIN_SEARCH_CONCURRENCY', 4),

    // Candidatos por OLA. Es la pieza que hace que el catalogo no se dispare:
    // se traen los avatares de una ola entera, se juntan TODOS sus assets y se
    // resuelve el catalogo de una sola vez para los N candidatos, en lugar de
    // una llamada por candidato (que es lo que provocaba los 429).
    //
    // 25 no es arbitrario: un avatar ronda los 10-20 assets, asi que una ola
    // produce del orden de 250-500 assets con muchisima repeticion entre ellos,
    // y lo que queda tras deduplicar cabe holgadamente en uno o dos lotes de
    // MAX_CATALOG_BATCH_SIZE. Subirlo agranda el lote y la latencia de la ola
    // sin reducir ya las llamadas; bajarlo devuelve llamadas al catalogo.
    waveSize: intFromEnv('PLUGIN_SEARCH_WAVE_SIZE', 25),

    // Busquedas inversas asset -> bundle por BUSQUEDA (no por ola). Es el
    // unico endpoint de Roblox sin lote que toca esta ruta, asi que es el que
    // hay que racionar: sirve para poner precio a las partes de bundle (unas
    // piernas de Korblox valen 17.000 y sin esto se quedaban sin valorar).
    //
    // 12 cubre de sobra un caso normal: Korblox y Headless salen del registro
    // curado sin gastar ninguna, la pertenencia asset -> bundle se cachea 24 h
    // globalmente, y un avatar tipico no lleva mas de una o dos piezas de
    // bundle. Agotado el presupuesto, las piezas restantes se quedan sin
    // valorar en vez de seguir gastando cuota.
    maxBundleLookups: intFromEnv('PLUGIN_SEARCH_MAX_BUNDLE_LOOKUPS', 12),
};

// ── Rotacion persistente por comunidad ───────────────────────────────────────
//
// Cada groupId recorre su comunidad EN ORDEN y recuerda por donde iba, de modo
// que dos busquedas seguidas no devuelven a la misma gente. El estado vive en
// Postgres (ver src/db/pluginRotationRepo.js) y sobrevive a redeploys.
//
// Sin DATABASE_URL todo esto se desactiva solo y la busqueda vuelve al muestreo
// aleatorio de siempre: la API de outfits nunca ha dependido de la base y no va
// a empezar ahora.
const pluginRotation = {
    // SUELO de la duracion de un lease sobre la rotacion de un grupo. El valor
    // real lo pide cada busqueda al abrir la rotacion, y es su propio
    // presupuesto de tiempo mas `leaseMarginMs`: un lease que expira a mitad
    // deja que OTRA busqueda empiece a avanzar el mismo cursor, que es
    // exactamente la corrupcion que el lease existe para impedir.
    //
    // Por que se pide por busqueda y no se fija aqui al maximo posible: con el
    // presupuesto de tiempo escalando de 30 s a 180 s, un lease unico y
    // dimensionado para el peor caso dejaria un grupo bloqueado tres minutos
    // cada vez que un proceso muriese durante una busqueda de 10 outfits. Cada
    // busqueda reserva lo que de verdad puede llegar a durar, y ni un ms mas.
    leaseMs: intFromEnv('PLUGIN_ROTATION_LEASE_MS', 90_000),

    // Margen del lease sobre el presupuesto de tiempo de la busqueda. Cubre lo
    // que va entre la ultima renovacion (que ocurre al persistir, o sea una vez
    // por segmento) y el cierre.
    leaseMarginMs: intFromEnv('PLUGIN_ROTATION_LEASE_MARGIN_MS', 30_000),

    // NO hay interruptor de "resume inclusivo". Lo hubo, y su efecto era que
    // cada busqueda repitiera al ultimo miembro de la anterior. Ya no hace
    // falta: la rotacion solo avanza DESPUES de que el veredicto este escrito
    // (ver rotation.persistir), asi que adelantar no pierde a nadie.

    // Miembros que entrega la rotacion por segmento. Es el tamaño de ola: se
    // mantiene igual para que el lote de catalogo siga siendo el mismo de siempre
    // y no cambie el perfil de trafico que ya esta estabilizado.
    segmentSize: intFromEnv('PLUGIN_ROTATION_SEGMENT_SIZE', 25),

    // Segmentos seguidos sin ningun miembro nuevo antes de dar la comunidad por
    // agotada EN ESTA busqueda. Con 2 basta: el primero puede ser el solape del
    // wrap-around, dos seguidos ya significan que se dio la vuelta entera.
    emptySegmentsBeforeExhausted: intFromEnv('PLUGIN_ROTATION_EMPTY_SEGMENTS', 2),
};

// ── Trabajos de busqueda (modo asincrono) y estimacion de tiempo ─────────────
// ── Cola por comunidad ───────────────────────────────────────────────────────
//
// UNA sola busqueda recorre un grupo a la vez. La segunda no adelanta ni va por
// otro lado: espera su turno y arranca donde termino la anterior. Grupos
// distintos no se estorban en absoluto — la cola es por groupId.
const pluginQueue = {
    // Busquedas que pueden estar esperando turno POR GRUPO. Pasado el tope se
    // rechaza de inmediato en vez de acumular gente que no va a llegar a
    // tiempo: una cola que crece sin limite solo sirve para que todos esperen
    // mucho y se rindan.
    maxWaiting: intFromEnv('PLUGIN_QUEUE_MAX_WAITING', 8),

    // Espera maxima en cola antes de rendirse. Tiene que dar para que termine
    // la busqueda de delante CON SU PRESUPUESTO MAXIMO, mas margen: si fuera
    // menor, una busqueda de 500 outfits (hasta 180 s) expulsaria de la cola a
    // todas las que llegasen detras, y el 'queue_timeout' que verian no diria
    // nada de lo que en realidad paso.
    //
    // Esperar no cuesta nada aqui: el trabajo asincrono esta en `queued` y el
    // plugin lo enseña como "esperando turno (2º)" en vez de fingir progreso.
    //
    // Se deriva del RELOJ DE PARED maximo (trabajo + pausas por Roblox), no
    // solo del trabajo: una busqueda estacionada 25 s esperando a Roblox sigue
    // teniendo el grupo reservado, y quien esta detras tiene que poder esperar
    // eso tambien.
    waitTimeoutMs: intFromEnv(
        'PLUGIN_QUEUE_WAIT_TIMEOUT_MS',
        pluginSearch.timeBudgetMaxMs + pluginSearch.rateLimitWaitBudgetMs + 30_000
    ),

    // Solo para el caso multi-instancia: si el lease del grupo lo tiene OTRO
    // proceso, no se puede esperar a una promesa local. Se espera una vez hasta
    // que ese lease caduque (mas este margen) y se reintenta. Un solo temporizador,
    // nunca un bucle de sondeo.
    foreignLeaseGraceMs: intFromEnv('PLUGIN_QUEUE_FOREIGN_LEASE_GRACE_MS', 250),
};

// ── WORKER DEL INDICE DE AVATARES (fase 1) ───────────────────────────────────
//
// El worker llena el indice en segundo plano. En la fase 1 NADIE LO LEE: el
// POST del plugin sigue funcionando exactamente igual que antes, y el indice
// solo se escribe. Por eso puede arrancar apagado y encenderse cuando se quiera
// medir, sin que nada dependa de el.
const indexWorker = {
    // El interruptor de la fase. Apagado (el DEFECTO) = el servicio es bit a
    // bit el de antes: ni un ciclo, ni una llamada, ni una escritura. Se
    // enciende con INDEX_WORKER_ENABLED=true y se apaga borrando la variable,
    // que es todo el plan de vuelta atras de la fase 1.
    enabled: process.env.INDEX_WORKER_ENABLED === 'true',

    // Cada cuanto corre UN ciclo. No se encadenan ciclos sin pausa a proposito:
    // el objetivo es un goteo que no compita con las busquedas, no llenar el
    // indice cuanto antes. Con 5 s y 10 usuarios por ciclo son ~2 usuarios por
    // segundo como techo teorico, y bastante menos en la practica porque el
    // marcapasos del limitador manda por encima de esto.
    tickMs: intFromEnv('INDEX_WORKER_TICK_MS', 5_000),
    usersPerCycle: intFromEnv('INDEX_WORKER_USERS_PER_CYCLE', 10),

    // Lease del grupo que se esta recorriendo. Corto a proposito: si una
    // instancia muere a mitad de ciclo, otra puede seguir ese grupo en menos de
    // un minuto en vez de esperar a que caduque media hora.
    leaseMs: intFromEnv('INDEX_WORKER_LEASE_MS', 60_000),

    // ── LOS DOS RELOJES DEL INDICE ──────────────────────────────────────────
    // Vencer NO borra ni invalida: solo coloca esa fila por delante en la cola
    // de refresco (ver avatarIndexRepo.pendientes). Una fila vencida se sigue
    // pudiendo servir; lo unico que se pierde es la certeza, y esa se recupera
    // refrescando, no tirando el dato.
    //
    // El avatar aguanta mas que el precio porque la gente se cambia de ropa
    // menos a menudo de lo que se mueve el mercado.
    avatarTtlMs: intFromEnv('INDEX_WORKER_AVATAR_TTL_MS', 14 * 24 * 60 * 60_000),
    priceTtlMs: intFromEnv('INDEX_WORKER_PRICE_TTL_MS', 3 * 24 * 60 * 60_000),

    // Cada cuanto vuelve a recorrerse un grupo SIN demanda. Es lo que impide
    // que el worker se lance sobre la whitelist entera: sin demanda y sin este
    // plazo cumplido, un grupo no entra en la cola.
    fullPassEveryMs: intFromEnv('INDEX_WORKER_FULL_PASS_EVERY_MS', 7 * 24 * 60 * 60_000),

    // Version de la LOGICA de valoracion y de la lista de tipos de accesorio.
    // Subirla manda las filas viejas al principio de la cola de refresco sin
    // borrar nada y sin un UPDATE masivo: es como se corrige un cambio de
    // criterio sin tirar el trabajo hecho.
    pricingVersion: intFromEnv('INDEX_WORKER_PRICING_VERSION', 1),
};

const pluginJobs = {
    // Cuanto se conserva un trabajo terminado para que el plugin recoja su
    // resultado. Corto a proposito: son resultados de una busqueda, no un
    // almacen. Pasado el plazo responde 'expired' y el plugin lanza otra, que es
    // mas barato que guardar resultados que ya nadie va a mirar.
    resultTtlMs: intFromEnv('PLUGIN_JOB_RESULT_TTL_MS', 120_000),

    // Techo de trabajos vivos en memoria a la vez. Es una cota de RAM, no un
    // limitador de carga: de eso ya se encargan el limitador por IP y los
    // presupuestos de la propia busqueda.
    maxLive: intFromEnv('PLUGIN_JOB_MAX_LIVE', 64),

    // Cada cuanto conviene que el plugin vuelva a preguntar. Se devuelve en la
    // respuesta para que el cliente no tenga que elegirlo (ni equivocarse).
    pollIntervalMs: intFromEnv('PLUGIN_JOB_POLL_INTERVAL_MS', 700),

    // Cada cuanto se vuelca a Postgres el estado de un trabajo en curso.
    // NO se escribe en cada cambio: una busqueda cambia de progreso varias
    // veces por segundo y eso convertiria la base en un stream de escrituras
    // sin ganar nada. Se guarda por HITOS (cada vez que sube `found`) y, si
    // no hay hitos, cada este intervalo — que ademas hace de latido.
    snapshotMs: intFromEnv('PLUGIN_JOB_SNAPSHOT_MS', 2_000),

    // ── Propiedad: latido y adopcion ─────────────────────────────────────────
    //
    // Cada trabajo vivo LATE por su cuenta, cada este intervalo, haga lo que
    // haga: trabajar, esperar turno del grupo o estar estacionado por Roblox.
    // El latido es independiente del progreso a proposito: antes solo se
    // escribia al cerrar cada ola, y una ola lenta o una espera en cola se
    // parecian a un proceso muerto.
    heartbeatIntervalMs: intFromEnv('PLUGIN_JOB_HEARTBEAT_INTERVAL_MS', 5_000),

    // Sin latido durante este tiempo, un trabajo se considera HUERFANO y otra
    // instancia puede adoptarlo — sea cual sea su fase. Es la unica condicion
    // de adopcion (ademas de que su dueño lo haya SOLTADO al apagarse), y la
    // relacion con el intervalo es la tolerancia a fallos transitorios: con
    // latidos cada 5 s, 90 s son dieciocho latidos fallidos seguidos. Un bache
    // de Postgres de veinte segundos no le quita el trabajo a nadie; un
    // proceso muerto se recupera en minuto y medio.
    adoptAfterMs: intFromEnv('PLUGIN_JOB_ADOPT_AFTER_MS', 90_000),

    // Cada cuanto pasa la recuperacion: adoptar lo soltado o huerfano y borrar
    // lo vencido. Corto, porque tras un redeploy el trabajo soltado por la
    // instancia vieja tiene que estar corriendo en la nueva en segundos.
    recoveryIntervalMs: intFromEnv('PLUGIN_JOB_RECOVERY_INTERVAL_MS', 15_000),

    // Un trabajo SOLTADO que ninguna instancia adopta en este plazo (no hay
    // ninguna viva) se expira, para que nada quede 'running' para siempre.
    releasedExpireMs: intFromEnv('PLUGIN_JOB_RELEASED_EXPIRE_MS', 60 * 60_000),

    // Cuanto sobrevive un trabajo TERMINADO en la base, con sus resultados.
    // Es lo que permite recoger el resultado tras un redeploy o desde otra
    // instancia. Pasado el plazo se borra: son resultados de una busqueda, no
    // un almacen.
    retentionMs: intFromEnv('PLUGIN_JOB_RETENTION_MS', 30 * 60_000),
};

const pluginEta = {
    // Peso del dato nuevo en la media exponencial. 0.3 se adapta en unas pocas
    // busquedas sin dar bandazos por una sola rara. Una media aritmetica
    // historica tardaria cientos de busquedas en reaccionar a un cambio real de
    // la comunidad.
    ewmaAlpha: Number(process.env.PLUGIN_ETA_EWMA_ALPHA ?? 0.3),

    // Candidatos examinados por debajo de los cuales NO se da estimacion. Con dos
    // o tres muestras la tasa de aceptacion es ruido, y una ETA inventada es peor
    // que 'calculando': la primera se cree y la segunda no.
    minSamples: intFromEnv('PLUGIN_ETA_MIN_SAMPLES', 8),

    // Techo de la estimacion. Nunca se promete mas alla de lo que la propia
    // busqueda va a durar, porque a esa hora se corta igualmente.
    maxEstimateMs: intFromEnv('PLUGIN_ETA_MAX_MS', 120_000),
};

const catalogBatch = {
    maxAssetIds: intFromEnv('CATALOG_BATCH_MAX_ASSETS', 64),
    maxBundleIds: intFromEnv('CATALOG_BATCH_MAX_BUNDLES', 32),
    maxTotalIds: intFromEnv('CATALOG_BATCH_MAX_TOTAL', 80),

    // Busquedas inversas asset -> bundle por peticion. Es el UNICO endpoint de
    // Roblox sin lote (una llamada por asset), asi que este es el tope que de
    // verdad protege la cuota. Solo se gasta en tipos que pueden venir en un
    // bundle (partes del cuerpo, Dynamic Heads, Mood): 1-3 en un outfit tipico.
    maxReverseLookups: intFromEnv('CATALOG_BATCH_MAX_REVERSE_LOOKUPS', 8),
};

// ── Postgres ────────────────────────────────────────────────────────────────
// La inyecta Railway al enlazar el servicio con la base; en local sale del
// .env. Nunca hay ninguna cadena de conexion escrita en el codigo: sin esta
// variable simplemente no hay base de datos, y el servicio arranca igual
// (ver src/db/pool.js). Lleva la contraseña dentro, asi que no se imprime en
// ningun sitio — ni siquiera aqui, donde solo se dice si esta o no.
const database = {
    url: process.env.DATABASE_URL || null,

    // auto | disable | no-verify | verify. El default resuelve solo los dos
    // sabores de Postgres de Railway (red privada sin TLS / proxy publico con
    // certificado autofirmado). Ver resolveSsl() en src/db/pool.js.
    ssl: (process.env.DATABASE_SSL || 'auto').toLowerCase(),

    poolMax: intFromEnv('DB_POOL_MAX', 5),
    connectionTimeoutMs: intFromEnv('DB_CONNECTION_TIMEOUT_MS', 8_000),
    idleTimeoutMs: intFromEnv('DB_IDLE_TIMEOUT_MS', 30_000),
    statementTimeoutMs: intFromEnv('DB_STATEMENT_TIMEOUT_MS', 10_000),

    // Intentos de aplicar el esquema al arrancar. Tras un redeploy la base
    // puede tardar unos segundos en aceptar conexiones y no merece la pena
    // quedarse sin tablas por eso.
    schemaMaxRetries: intFromEnv('DB_SCHEMA_MAX_RETRIES', 4),
};

if (!apiKey) {
    console.error(
        '[config] ERROR: falta la variable de entorno OUTFIT_API_KEY. ' +
        'El servicio arranca (para no tumbar el healthcheck) pero TODA ruta /v1 respondera 401 hasta que la definas.'
    );
}

if (!adminApiKey) {
    console.warn(
        '[config] ADMIN_API_KEY no esta definida — las rutas /admin responderan 503 admin_disabled. ' +
        'La API de outfits no se ve afectada. Genera una con: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
} else if (adminApiKey === apiKey) {
    console.error(
        '[config] ERROR: ADMIN_API_KEY y OUTFIT_API_KEY son la MISMA clave. Eso anula la separacion ' +
        'entre "puede consultar outfits" y "puede dar licencias": la key del juego se distribuye a ' +
        'servidores de Roblox, asi que cualquiera que la extraiga podria autorizarse solo. Cambia una de las dos.'
    );
}

if (!pluginApiKey) {
    console.warn(
        '[config] PLUGIN_API_KEY no esta definida — POST /plugin/outfits/search respondera 503 ' +
        'plugin_disabled. El resto del servicio no se ve afectado. Genera una con: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
} else if (pluginApiKey === apiKey || pluginApiKey === adminApiKey) {
    console.error(
        '[config] ERROR: PLUGIN_API_KEY coincide con OUTFIT_API_KEY o con ADMIN_API_KEY. Eso anula la ' +
        'separacion entre los tres publicos: el plugin de Studio, el juego vendido y el panel de ' +
        'administracion tienen que poder revocarse por separado. Cambiala.'
    );
}

// Variables HEREDADAS de versiones anteriores. Se avisa para que no queden en
// Railway creyendo que hacen algo.
if (process.env.PLUGIN_ROTATION_RESUME_INCLUSIVE !== undefined) {
    // eslint-disable-next-line no-console
    console.warn(
        "[config] PLUGIN_ROTATION_RESUME_INCLUSIVE ya no existe y se ignora: la rotacion guarda " +
        "siempre el SIGUIENTE miembro a mirar, asi que dos busquedas seguidas no repiten a nadie " +
        "mientras la comunidad no se haya recorrido entera. Borrala del entorno."
    );
}

// Las dos siguientes convertian una pausa de Roblox en el final de la
// busqueda; la primera se ignora y la segunda se acota.
if (process.env.PLUGIN_SEARCH_RATE_LIMIT_SINGLE_WAIT_MS !== undefined) {
    console.warn(
        '[config] PLUGIN_SEARCH_RATE_LIMIT_SINGLE_WAIT_MS ya no existe y se ignora: una pausa de Roblox, ' +
        'por larga que sea, ya no termina una busqueda. Borra la variable.'
    );
}
if (process.env.PLUGIN_SEARCH_RATE_LIMIT_WAIT_BUDGET_MS !== undefined
    && Number(process.env.PLUGIN_SEARCH_RATE_LIMIT_WAIT_BUDGET_MS) < pluginSearch.rateLimitWaitBudgetMs) {
    console.warn(
        `[config] PLUGIN_SEARCH_RATE_LIMIT_WAIT_BUDGET_MS=${process.env.PLUGIN_SEARCH_RATE_LIMIT_WAIT_BUDGET_MS} ` +
        `esta por debajo del suelo: se usan ${pluginSearch.rateLimitWaitBudgetMs} ms. ` +
        'Es una proteccion extrema, no el terminador normal de una busqueda.'
    );
}

if (!database.url) {
    console.warn(
        '[config] DATABASE_URL no esta definida — el servicio arranca y la API de outfits ' +
        'funciona igual, pero no habra base de datos (whitelist de grupos / licencias).'
    );
}

if (cacheDriver !== 'memory') {
    console.warn(
        `[config] CACHE_DRIVER="${cacheDriver}" no esta implementado todavia — usando "memory". ` +
        'Ver src/cache/cacheStore.js para el punto exacto donde enchufar Redis.'
    );
}

module.exports = {
    port,
    apiKey,
    adminApiKey,
    pluginApiKey,
    logLevel,
    cacheDriver,
    ttl,
    rateLimit,
    upstream,
    cache,
    database,
    pagination,
    outfitTypes,
    maxBundleLookupsPerRequest,
    maxCatalogBatchSize,
    catalogBatch,
    pluginSearch,
    pluginRotation,
    pluginQueue,
    pluginJobs,
    pluginEta,
    indexWorker,
    serviceName: 'outfit-api',
};
