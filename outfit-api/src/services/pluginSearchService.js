'use strict';

const roblox = require('../roblox/client');
const cacheStore = require('../cache/cacheStore');
const config = require('../config');
const logger = require('../observability/logger');
const { resolverFichasDeAsset } = require('./catalogService');

// Busqueda de outfits reales para el plugin de Studio: miembros de una
// comunidad -> avatar que llevan puesto AHORA -> precio de ese avatar ->
// filtro por rango de precio.
//
// LA FORMA DE LA BUSQUEDA LA IMPONE ROBLOX, no una preferencia nuestra. No
// existe ningun endpoint que devuelva "outfits de esta comunidad", ni "un
// miembro al azar", ni "el precio de un avatar". Hay que componerlo:
//
//   1. groups/v1/groups/{id}/users      miembros, paginado POR CURSOR
//   2. avatar/v1/users/{id}/avatar      que lleva puesto (UNA llamada por usuario)
//   3. catalog/v1/catalog/items/details precio, POR LOTES (una por usuario)
//
// El paso 2 es el que manda en el coste: no admite lote de ninguna forma, asi
// que cada candidato cuesta una llamada como minimo. De ahi que todo este
// modulo gire alrededor de MIRAR LO MENOS POSIBLE: cache por usuario, topes
// duros y parada temprana en cuanto hay suficientes resultados.

// Cache por PAGINA de cursor, no por grupo entero: es la unidad que devuelve
// Roblox, y asi dos busquedas seguidas sobre el mismo grupo reaprovechan el
// recorrido en vez de repetirlo pagina por pagina. `sortOrder` entra en la
// clave porque Asc y Desc son recorridos distintos del mismo grupo.
function membersCacheKey(groupId, sortOrder, cursor) {
    return cacheStore.key('group', 'members', groupId, sortOrder, cursor || 'first');
}

// Por USUARIO y no por busqueda: el mismo jugador puede salir en dos
// busquedas seguidas del mismo grupo, y su avatar no cambia entre una y otra.
function avatarCacheKey(userId) {
    return cacheStore.key('user', 'avatar', userId);
}

// El resto del servicio pasa `res.locals.cache` a la cache para que el log de
// la peticion diga de donde salio cada dato. AQUI NO SE HACE, y es deliberado:
// una busqueda toca cientos de claves, y empujar un 'hit'/'miss' por cada una
// convertiria la linea de log de la peticion en un churro de mil elementos.
// Se cuentan en agregado y se publican en la linea de la busqueda, que dice lo
// mismo y de forma legible.
function contador(marcas) {
    return estado => {
        if (estado === 'hit') marcas.hits++;
        else if (estado === 'miss') marcas.misses++;
        else marcas.negativos++;
    };
}

// ── Muestreo ────────────────────────────────────────────────────────────────

// Fisher-Yates. Barajar es un REQUISITO, no un adorno: sin esto, cada busqueda
// sobre el mismo grupo devolveria a los mismos primeros miembros que Roblox
// pagine, y el plugin acabaria importando siempre los mismos avatares.
function barajar(lista) {
    for (let i = lista.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [lista[i], lista[j]] = [lista[j], lista[i]];
    }
    return lista;
}

// La API de grupos NO tiene offset: solo cursor, asi que no se puede saltar a
// una pagina al azar sin recorrer todas las anteriores. La variedad se
// consigue con lo unico que si es gratis (empezar por un extremo o por el
// otro) y barajando despues el bombo entero. No es un muestreo uniforme sobre
// toda la comunidad y no se pretende que lo sea: es lo que la API permite sin
// pagar N paginas para llegar a la N+1.
function ordenAleatorio() {
    return Math.random() < 0.5 ? 'Asc' : 'Desc';
}

// Cuantos candidatos merece la pena examinar para `amount` resultados. Se
// escala con lo pedido (pedir 5 no puede costar lo mismo que pedir 500) pero
// con suelo y techo: el suelo evita que un `amount` pequeño con un rango de
// precio estrecho se quede sin muestra, y el techo es el que impide que esto
// se convierta en un barrido de la comunidad entera.
function cuposDeCandidatos(amount) {
    const { candidatesPerResult, minCandidates, maxCandidates } = config.pluginSearch;
    return Math.min(maxCandidates, Math.max(minCandidates, amount * candidatesPerResult));
}

async function recogerCandidatos(groupId, objetivo, marcas) {
    const sortOrder = ordenAleatorio();
    const candidatos = [];
    const vistos = new Set();

    let cursor = null;
    let paginas = 0;

    // Se para en cuanto hay bombo suficiente O se acaban las paginas
    // permitidas O Roblox deja de dar cursor (grupo recorrido entero).
    while (candidatos.length < objetivo && paginas < config.pluginSearch.maxMemberPages) {
        const pagina = await cacheStore.withCache(
            membersCacheKey(groupId, sortOrder, cursor),
            config.ttl.groupMembers,
            () => roblox.listGroupMembers(groupId, { limit: 100, cursor, sortOrder }),
            { negativeTtlMs: config.ttl.negative, onStatus: contador(marcas) }
        );

        paginas++;

        // Deduplicado YA en el bombo. Roblox puede repetir a alguien entre
        // paginas si el grupo cambia a mitad del recorrido, y arrastrar el
        // duplicado hasta el final obligaria a comprobarlo dos veces.
        for (const miembro of pagina.members) {
            if (vistos.has(miembro.userId)) continue;
            vistos.add(miembro.userId);
            candidatos.push(miembro);
        }

        cursor = pagina.nextCursor;
        if (!cursor) break;
    }

    return { candidatos: barajar(candidatos), paginas, sortOrder };
}

// ── Precio de un avatar ─────────────────────────────────────────────────────

// PRECIO COMPRABLE, y con una regla dura: O SE SABE ENTERO, O NO SE SABE.
// Devuelve el total, o null si ALGUN asset del avatar no tiene un precio
// fiable — y entonces el candidato se descarta.
//
// Es la diferencia entre un numero y una mentira. Si un asset no se puede
// resolver y se contara como 0, un avatar de tres piezas caras del que solo se
// resuelve una barata daria un total pequeño y se colaria en un rango de
// precio bajo donde no pinta nada. El plugin no tendria forma de notarlo: un
// totalPrice es un totalPrice. Devolver menos candidatos es recuperable;
// devolver precios falsos, no.
//
// UN PRECIO REAL DE 0 SI ES VALIDO. Roblox devuelve price 0 para los articulos
// gratuitos, y eso es un dato fiable, no una ausencia: un avatar entero de
// piezas gratis vale 0 de verdad y tiene que poder salir con minPrice 0.
// Por eso la comprobacion es sobre el TIPO y no sobre el valor.
//
// QUE CUENTA COMO "NO FIABLE" HOY:
//   - el asset no vino en el lote de catalogo (borrado, moderado, fuera del
//     catalogo): `available !== true`;
//   - Roblox no pudo consultarse para ese lote (lo reporta `fallos`);
//   - la ficha existe pero `price` no es un numero, que es lo que ocurre con
//     los Limiteds (su valor vive en la reventa) y con parte de lo que esta
//     fuera de venta.
//
// Ese ultimo caso hace que hoy un avatar con un Limited quede descartado. Es
// consecuencia de esta regla, no un filtro de Limiteds: tratarlos de verdad
// (leer lowestPrice / lowestResalePrice) es la fase siguiente, y hasta
// entonces es preferible no contarlos que contarlos mal.
function precioDelAvatar(assetIds, fichas) {
    let total = 0;
    for (const assetId of assetIds) {
        const ficha = fichas.get(assetId);
        if (!ficha || ficha.available !== true) return null;
        if (typeof ficha.price !== 'number' || !Number.isFinite(ficha.price) || ficha.price < 0) return null;
        total += ficha.price;
    }
    return total;
}

// Un candidato entero: avatar -> precio. Devuelve null cuando hay que
// DESCARTARLO, que es la respuesta normal y no un error: un usuario baneado,
// sin avatar consultable o con el catalogo caido no puede evaluarse, y la
// busqueda tiene que seguir con el siguiente.
async function evaluarCandidato(miembro, marcas) {
    let avatar;
    try {
        avatar = await cacheStore.withCache(
            avatarCacheKey(miembro.userId),
            config.ttl.userAvatar,
            () => roblox.getCurrentAvatar(miembro.userId),
            { negativeTtlMs: config.ttl.negative, onStatus: contador(marcas) }
        );
    } catch (err) {
        // Nivel debug y no warn: con cientos de candidatos, que unos cuantos no
        // se puedan consultar es lo ESPERADO, y a nivel warn ahogaria el log
        // util de todo el servicio.
        logger.debug('Candidato descartado: no se pudo leer su avatar', {
            userId: miembro.userId, detail: err?.message,
        });
        return null;
    }

    const assetIds = [...new Set(avatar.assets.map(a => String(a.id)))];
    if (assetIds.length === 0) return null; // avatar vacio: no hay outfit que importar

    // Reutiliza el resolutor de /v1/catalog/batch: misma cache por asset
    // (v1:asset:catalog:<id>), mismo single-flight y mismo bucket del
    // limitador. Un sombrero que ya resolvio otro candidato, o un juego con
    // licencia, sale de cache y no cuesta ni una llamada.
    const fallos = { assetIds: [] };
    const fichas = await resolverFichasDeAsset(assetIds, fallos);

    // CUALQUIER hueco descalifica al candidato, no solo que fallen todos: un
    // solo asset sin precio fiable ya hace que el total no se pueda afirmar.
    // `fallos` cubre lo que Roblox no pudo responder; precioDelAvatar cubre lo
    // que respondio pero sin precio utilizable.
    if (fallos.assetIds.length > 0) {
        logger.debug('Candidato descartado: no se pudo consultar el precio de parte de su avatar', {
            userId: miembro.userId, assets: assetIds.length, sinResolver: fallos.assetIds.length,
        });
        return null;
    }

    const totalPrice = precioDelAvatar(assetIds, fichas);
    if (totalPrice === null) {
        logger.debug('Candidato descartado: algun asset de su avatar no tiene precio fiable', {
            userId: miembro.userId, assets: assetIds.length,
        });
        return null;
    }

    return {
        userId: miembro.userId,
        username: miembro.username,
        totalPrice,
    };
}

// ── Busqueda ────────────────────────────────────────────────────────────────

async function searchOutfits({ amount, groupId, minPrice, maxPrice }, { requestId = null } = {}) {
    const empezado = Date.now();
    const marcas = { hits: 0, misses: 0, negativos: 0 };
    const { timeBudgetMs, concurrency } = config.pluginSearch;
    const cupo = cuposDeCandidatos(amount);

    const { candidatos, paginas, sortOrder } = await recogerCandidatos(groupId, cupo, marcas);

    const encontrados = [];
    const yaIncluidos = new Set(); // ningun userId repetido en la respuesta
    let examinados = 0;
    let motivoDeParada = 'candidatos_agotados';

    // Por tandas de `concurrency`: mantiene varias llamadas en vuelo sin
    // lanzar cientos de golpe. El gate global de salida ya serializa contra
    // Roblox, pero lanzarlas todas a la vez llenaria su cola y provocaria
    // rechazos (503) en lugar de espera ordenada.
    for (let i = 0; i < candidatos.length; i += concurrency) {
        if (encontrados.length >= amount) { motivoDeParada = 'completo'; break; }
        if (examinados >= cupo) { motivoDeParada = 'tope_de_candidatos'; break; }
        if (Date.now() - empezado >= timeBudgetMs) { motivoDeParada = 'tiempo_agotado'; break; }

        const tanda = candidatos.slice(i, i + concurrency);
        examinados += tanda.length;

        // allSettled y no all: un candidato que falle no puede tumbar a los
        // otros tres de su tanda. evaluarCandidato ya devuelve null en vez de
        // lanzar en el caso normal; esto cubre lo imprevisto.
        const resultados = await Promise.allSettled(tanda.map(m => evaluarCandidato(m, marcas)));

        for (const resultado of resultados) {
            if (resultado.status !== 'fulfilled' || resultado.value === null) continue;
            const candidato = resultado.value;

            if (yaIncluidos.has(candidato.userId)) continue;
            if (candidato.totalPrice < minPrice) continue;
            if (maxPrice !== null && candidato.totalPrice > maxPrice) continue;

            yaIncluidos.add(candidato.userId);
            encontrados.push(candidato);
            if (encontrados.length >= amount) break;
        }
    }

    if (encontrados.length >= amount) motivoDeParada = 'completo';

    // Una sola linea por busqueda, con lo que hace falta para entender por que
    // volvieron 12 y no 100: es la diferencia entre "el grupo es pequeño", "el
    // rango de precio es imposible" y "Roblox iba lento y se agoto el tiempo".
    logger.info('Busqueda de outfits del plugin', {
        requestId,
        groupId,
        amount,
        minPrice,
        maxPrice,
        encontrados: encontrados.length,
        examinados,
        candidatos: candidatos.length,
        paginasDeMiembros: paginas,
        sortOrder,
        motivoDeParada,
        cacheHits: marcas.hits,
        cacheMisses: marcas.misses,
        durationMs: Date.now() - empezado,
    });

    // slice defensivo: la ultima tanda puede meter varios a la vez y pasarse
    // de `amount` por uno o dos.
    return encontrados.slice(0, amount);
}

module.exports = { searchOutfits, precioDelAvatar, barajar, cuposDeCandidatos };
