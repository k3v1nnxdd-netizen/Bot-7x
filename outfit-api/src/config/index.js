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

    // PRESUPUESTO DE TIEMPO DE UNA PETICION DEL JUEGO, upstream incluido.
    //
    // EL PROBLEMA QUE RESUELVE, MEDIDO. `timeoutMs` acota UNA llamada, no la
    // peticion. Con Roblox colgado, un listado de outfits gastaba 18,6 s: tres
    // intentos de 6 s contra un servidor que no contestaba, mas el backoff, para
    // acabar devolviendo exactamente el mismo error que el primer intento ya
    // habia dado a los 6 s. Y el listado encadena DOS llamadas (usuario ->
    // outfits), asi que esos 18,6 s son el coste de UNA: lo que tarde la segunda
    // se suma encima.
    //
    // Reintentar un timeout es el reintento que menos vale: agotar el timeout ya
    // ES la señal de que ese servidor no esta contestando. Reintentar un 5xx
    // rapido, en cambio, sale bien a menudo.
    //
    // Este presupuesto distingue los dos casos sin tocar `maxRetries`: antes de
    // reintentar se comprueba si el siguiente intento cabe en lo que queda, y el
    // coste se estima con lo que tardo el intento ANTERIOR. Un 5xx de 120 ms
    // predice otro intento barato y se reintenta; un timeout de 6 s predice otros
    // 6 s y se abandona. El jugador recibe el error a los ~6 s en vez de a los 37.
    //
    // Lo abren las peticiones HTTP del juego (ver api/requestBudget.js), que
    // son las que tienen a alguien esperando delante. Un camino que no abra
    // presupuesto conserva el comportamiento de siempre: reintenta hasta
    // agotar `maxRetries` sin mirar el reloj.
    requestBudgetMs: intFromEnv('UPSTREAM_REQUEST_BUDGET_MS', 8_000),
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
    // Existe para las rafagas: un lote de veinticuatro outfits con precios
    // puede agotar la ventana de cuota del catalogo tan deprisa como la red lo
    // permita. Es la diferencia entre gastarsela de golpe y repartirla.
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
        userAvatarV2: intFromEnv('UPSTREAM_ROUTE_CONCURRENCY_USER_AVATAR_V2', 2),
        catalogDetails: intFromEnv('UPSTREAM_ROUTE_CONCURRENCY_CATALOG_DETAILS', 2),
    },

    // ── SUELO DE RITMO POR RUTA ─────────────────────────────────────────────
    //
    // Separacion MINIMA entre llamadas, desde la primera y sin esperar a que
    // Roblox se queje. El marcapasos normal arranca en cero y solo aparece tras
    // un 429; esto es lo contrario: un ritmo que no se supera nunca.
    //
    // Para v2 son 334 ms, es decir 3 por segundo. La medicion real desde
    // Railway aguanto 3,59 por segundo con doscientas llamadas y cero 429, y la
    // cabecera anuncia numeros muchisimo mas altos — pero esa cabecera ya
    // demostro no ser un contador fiable (repitio el mismo 'remaining' en
    // llamadas consecutivas), asi que el ritmo se fija por lo MEDIDO y con
    // margen por debajo, no por lo que se anuncia.
    routeMinSpacingMs: {
        userAvatarV2: intFromEnv('UPSTREAM_MIN_SPACING_USER_AVATAR_V2', 334),
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

// ── POST /v1/outfits/batch ───────────────────────────────────────────────────
//
// El buscador del juego enseña hasta 24 outfits a la vez. Pedirlos uno a uno
// desde Lua no es viable y esta MEDIDO: cada GetOutfit cuesta 3 fichas del
// limitador del servidor de Roblox, el cubo tiene 40 y recarga 8/s, asi que 24
// peticiones cuestan 72 fichas y once se quedan sin datos aunque el cliente
// limite el pico a cinco en paralelo. El problema no es la cuota nuestra: es
// que el JUEGO no puede permitirse 24 llamadas HTTP.
//
// Con una sola peticion, el coste en el servidor de Roblox pasa de 72 fichas a
// 3. Aqui dentro no se convierte en 24 llamadas seriales: se resuelve la cache
// de golpe y solo lo que falta sale a Roblox, con concurrencia acotada.
const outfitsBatch = {
    // Tope duro de ids por peticion. 40 deja margen sobre los 24 del buscador
    // sin abrir la puerta a que alguien pida cientos: cada id que falte en
    // cache es una llamada a Roblox, y el tope es lo que acota el peor caso.
    maxIds: intFromEnv('OUTFITS_BATCH_MAX_IDS', 40),

    // Cuantos outfits sin cachear se resuelven a la vez. Por encima del gate
    // global de salida no se gana nada — el limitador ya serializa — pero
    // mantener varios en vuelo evita que el gate se quede ocioso entre llamada
    // y llamada.
    concurrency: intFromEnv('OUTFITS_BATCH_CONCURRENCY', 4),
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
    outfitsBatch,
    catalogBatch,
    serviceName: 'outfit-api',
};
