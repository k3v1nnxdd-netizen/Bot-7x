'use strict';

const { isBundleBacked } = require('../../catalog/assetTypes');

// ETAPA 4 — VALORACION. Funciones puras sobre lo que ya se resolvio: no hacen
// ninguna llamada y no conocen la red. Aqui vive la unica logica de negocio
// delicada de esta fase.
//
// REGLA QUE NO SE ROMPE NUNCA: no se inventa ni un Robux. Si un articulo no
// tiene un precio que Roblox afirme HOY, no suma. Lo que cambia respecto a la
// version anterior no es esa regla, es la CONSECUENCIA: antes un solo articulo
// sin precio tiraba el avatar entero; ahora se clasifica, se cuenta, y es la
// POLITICA (requireCompletePrice) la que decide si eso descalifica o no.
//
// Separar las dos cosas es lo que arregla el found:0 del diagnostico: la
// mayoria de avatares reales llevan alguna pieza no comprable, y descartarlos
// por eso dejaba fuera outfits perfectamente utiles.

// ── Categorias ───────────────────────────────────────────────────────────────
//
// Cada asset cae en UNA y solo una. El orden de la clasificacion importa y
// esta razonado en `clasificar`.
const CATEGORIA = Object.freeze({
    ON_SALE: 'onSale',            // a la venta, con precio > 0
    FREE: 'free',                 // a la venta, precio 0 REAL
    LIMITED_RESALE: 'limitedResale', // Limited/LimitedU con reventa disponible
    LIMITED_NO_RESALE: 'limitedNoResale', // Limited sin reventa: no se puede comprar hoy
    BUNDLE_PART: 'bundlePart',    // se compra dentro de un bundle, no suelto
    OFF_SALE: 'offSale',          // fuera de venta: no se puede comprar hoy
    DELETED: 'deleted',           // Roblox ya no tiene ficha (borrado/moderado)
    UNKNOWN: 'unknown',           // hay ficha pero no hay precio afirmable
});

// Las categorias que APORTAN precio. El resto se cuenta como "no valorable" y
// alimenta priceComplete.
const CON_PRECIO = new Set([CATEGORIA.ON_SALE, CATEGORIA.FREE, CATEGORIA.LIMITED_RESALE]);

// Un numero de Robux utilizable. `0` es valido (hay articulos gratis de
// verdad); null, undefined, NaN e Infinity no lo son.
function robuxValidos(valor) {
    return typeof valor === 'number' && Number.isFinite(valor) && valor >= 0;
}

// PRECIO DE REVENTA DE UN LIMITED.
//
// Para un Limited, `price` es el precio ORIGINAL de catalogo y no vale nada:
// puede llevar una decada sin poder comprarse a ese precio. Lo que se paga hoy
// es la reventa, y Roblox la publica en dos campos segun el sistema:
//
//   lowestResalePrice  — sistema nuevo (collectibleItemDetail). Es el que hay
//                        que preferir cuando existe: es literalmente la oferta
//                        mas barata viva ahora mismo.
//   lowestPrice        — el equivalente en el sistema clasico.
//
// Si ninguno de los dos trae un numero, NO hay precio: el articulo es limitado
// y ahora mismo nadie lo esta revendiendo. Eso es informacion, no un hueco que
// haya que rellenar con el precio historico.
function precioDeReventa(ficha) {
    if (robuxValidos(ficha.lowestResalePrice)) return ficha.lowestResalePrice;
    if (robuxValidos(ficha.lowestPrice)) return ficha.lowestPrice;
    return null;
}

// PRECIO DE UN BUNDLE. Mismo criterio que un asset: si el bundle es
// coleccionable se paga su reventa; si se vende normal, su precio de producto.
// `forSale === false` significa que Roblox ya no lo vende, asi que su `price`
// tampoco sirve.
function precioDeBundle(bundle) {
    if (!bundle || bundle.available !== true) return null;

    const reventa = precioDeReventa(bundle);
    if (reventa !== null) return reventa;

    if (bundle.forSale === true && robuxValidos(bundle.price)) return bundle.price;
    return null;
}

// ── Clasificacion de un asset ────────────────────────────────────────────────
//
// EL ORDEN ES LA LOGICA. Cada comprobacion asume que las anteriores ya
// descartaron su caso:
//
//   1. Sin ficha -> `deleted`. No hay nada mas que mirar.
//   2. Limited -> su precio es la reventa, JAMAS `price`. Va antes que
//      offSale porque un Limited casi siempre viene con isOffSale=true y aun
//      asi tiene mercado: tratarlo como "fuera de venta" perderia el unico
//      precio real que existe para el.
//   3. OffSale -> no se puede comprar hoy. Se comprueba ANTES que `price`
//      porque Roblox sigue devolviendo el precio historico de un articulo
//      retirado, y sumarlo seria exactamente inventar un valor.
//   4. Precio propio valido -> onSale / free.
//   5. Sin precio propio pero de un tipo que se vende en bundle -> bundlePart,
//      y el precio sale del bundle (una sola vez por bundle, ver valorar).
//   6. Lo demas -> unknown. Hay ficha, no hay precio y no sabemos por que.
function clasificar(ficha, bundleId) {
    if (!ficha || ficha.available !== true) return CATEGORIA.DELETED;

    if (ficha.isLimited === true) {
        return precioDeReventa(ficha) !== null
            ? CATEGORIA.LIMITED_RESALE
            : CATEGORIA.LIMITED_NO_RESALE;
    }

    if (ficha.offSale === true) return CATEGORIA.OFF_SALE;

    if (robuxValidos(ficha.price)) {
        return ficha.price === 0 ? CATEGORIA.FREE : CATEGORIA.ON_SALE;
    }

    if (bundleId !== null && bundleId !== undefined) return CATEGORIA.BUNDLE_PART;

    // Sin precio propio y de un tipo que SI puede venir en bundle: es una parte
    // de bundle cuyo bundle no se pudo resolver. Se distingue de `unknown`
    // generico porque el motivo se conoce y la siguiente fase puede atacarlo.
    if (isBundleBacked(ficha.assetTypeId)) return CATEGORIA.BUNDLE_PART;

    return CATEGORIA.UNKNOWN;
}

// ¿Este asset necesita que se le resuelva el bundle para poder valorarse? Se
// pregunta ANTES de tener bundles, para no gastar busquedas inversas en assets
// que ya tienen precio propio.
function necesitaBundle(ficha) {
    if (!ficha || ficha.available !== true) return false;
    if (ficha.isLimited === true) return false;
    if (ficha.offSale === true) return false;
    if (robuxValidos(ficha.price)) return false;
    return isBundleBacked(ficha.assetTypeId);
}

// ── Valoracion de un avatar completo ─────────────────────────────────────────
//
// Devuelve el desglose, o un motivo cuando no se puede ni empezar.
//
// `catalogError` es la UNICA condicion que corta aqui, y se distingue a
// proposito del resto: significa que no pudimos PREGUNTAR por ese asset
// (Roblox limitando, caido), no que el asset no tenga precio. Es transitoria y
// se arregla reintentando mas tarde. Tolerarla haria que el mismo avatar
// valiese cosas distintas segun el momento, que es justo lo que no puede pasar
// con un precio.
function valorar(assetIds, indice, bundles) {
    const desglose = {
        totalPrice: 0,
        pricedItems: 0,
        unpricedItems: 0,
        limitedItems: 0,
        offSaleItems: 0,
        bundledItems: 0,
        deletedItems: 0,
    };

    // Bundles ya cobrados en ESTE avatar. Es lo que impide que un Korblox
    // completo (seis piezas del mismo bundle) se cobre seis veces: se paga el
    // bundle una vez, como lo paga el jugador.
    const bundlesCobrados = new Set();

    for (const assetId of assetIds) {
        if (indice.irresoluble(assetId)) return { ok: false, motivo: 'catalogError' };

        const ficha = indice.ficha(assetId);
        // Sin ficha en el indice significa que la etapa de catalogo se corto
        // antes de llegar a este asset (429 a mitad de ola).
        if (ficha === undefined) return { ok: false, motivo: 'catalogError' };

        const bundleId = bundles?.bundleDe(assetId) ?? null;
        const categoria = clasificar(ficha, bundleId);

        switch (categoria) {
            case CATEGORIA.ON_SALE:
            case CATEGORIA.FREE:
                desglose.totalPrice += ficha.price;
                desglose.pricedItems++;
                break;

            case CATEGORIA.LIMITED_RESALE:
                desglose.totalPrice += precioDeReventa(ficha);
                desglose.pricedItems++;
                desglose.limitedItems++;
                break;

            case CATEGORIA.LIMITED_NO_RESALE:
                // Limitado y sin nadie revendiendolo: hoy no se puede comprar
                // a ningun precio. Se cuenta como limitado Y como no valorable.
                desglose.unpricedItems++;
                desglose.limitedItems++;
                break;

            case CATEGORIA.BUNDLE_PART: {
                desglose.bundledItems++;
                const precio = precioDeBundle(bundles?.detalle(bundleId));

                if (precio === null) {
                    // El bundle no se pudo resolver o no tiene precio hoy.
                    desglose.unpricedItems++;
                    break;
                }
                if (bundlesCobrados.has(bundleId)) {
                    // Segunda (o sexta) pieza del mismo bundle: ya esta pagado.
                    // Cuenta como valorada, pero no vuelve a sumar.
                    desglose.pricedItems++;
                    break;
                }
                bundlesCobrados.add(bundleId);
                desglose.totalPrice += precio;
                desglose.pricedItems++;
                break;
            }

            case CATEGORIA.OFF_SALE:
                desglose.offSaleItems++;
                desglose.unpricedItems++;
                break;

            case CATEGORIA.DELETED:
                desglose.deletedItems++;
                desglose.unpricedItems++;
                break;

            default:
                desglose.unpricedItems++;
                break;
        }
    }

    return {
        ok: true,
        valoracion: { ...desglose, priceComplete: desglose.unpricedItems === 0 },
    };
}

// ── ETAPA 5: politica y filtros ──────────────────────────────────────────────
//
// Separada de la valoracion a proposito: valorar es un hecho sobre el avatar,
// aceptar es una DECISION sobre lo que pidio el cliente. Mezclarlas es como se
// acaba sin poder explicar por que se cayo un candidato.
//
// requireCompletePrice = true  -> estricto (comportamiento historico): si algo
//   no se pudo valorar, fuera. Es lo que hay que usar cuando el numero tiene
//   que ser exacto.
// requireCompletePrice = false -> permisivo: basta con que haya ALGO valorable.
//   `totalPrice` es entonces el coste de lo que si se puede comprar, y
//   `priceComplete: false` avisa de que hay mas piezas encima.
//
// Los limites de precio se aplican SIEMPRE sobre `totalPrice`, es decir, sobre
// lo valorable. Un outfit con 1800 en ropa comprable y un OffSale sin precio
// entra en un rango 1000-2000: el filtro habla de lo que se puede comprar.
function aplicarPolitica(valoracion, { requireCompletePrice, minPrice, maxPrice }) {
    if (requireCompletePrice) {
        if (!valoracion.priceComplete) return { ok: false, motivo: 'incompletePrice' };
    } else if (valoracion.pricedItems === 0) {
        // Ni una sola pieza valorable: `totalPrice` seria 0 por ignorancia, no
        // por ser gratis, y colarlo en un rango que empiece en 0 seria mentir.
        return { ok: false, motivo: 'unknownPrice' };
    }

    if (valoracion.totalPrice < minPrice) return { ok: false, motivo: 'minPrice' };
    if (maxPrice !== null && valoracion.totalPrice > maxPrice) return { ok: false, motivo: 'maxPrice' };

    return { ok: true };
}

module.exports = {
    CATEGORIA,
    CON_PRECIO,
    clasificar,
    necesitaBundle,
    precioDeReventa,
    precioDeBundle,
    valorar,
    aplicarPolitica,
};
