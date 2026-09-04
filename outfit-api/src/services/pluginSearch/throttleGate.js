'use strict';

const config = require('../../config');
const logger = require('../../observability/logger');
const rateLimiter = require('../../roblox/rateLimiter');
const requestContext = require('../../observability/requestContext');

// LA PUERTA. Antes de gastar una llamada en una ruta de Roblox, se pregunta
// aqui si esa ruta esta disponible — y si no lo esta, SE ESPERA A QUE LO ESTE.
//
// ── EL ERROR QUE ESTO CORRIGE ────────────────────────────────────────────────
//
// Un cooldown se estaba tratando como el final de la busqueda. En cuanto Roblox
// decia "espera 8 segundos", la busqueda se rendia y devolvia lo que llevara:
// 3 de 10, `stoppedBy: catalogRateLimit`, a los 18 segundos. Pero "espera 8
// segundos" no es "no hay outfits" — es literalmente una instruccion de esperar
// ocho segundos, y la mayoria de las veces la ventana de cuota de Roblox se
// reabre en menos de lo que el usuario tarda en volver a pulsar BUSCAR.
//
// Rendirse ahi era ademas contraproducente: el usuario relanza la busqueda de
// inmediato, la ruta sigue en cooldown, y el reintento manual llega ANTES que
// la espera que no quisimos hacer.
//
// ── LAS DOS REGLAS ──────────────────────────────────────────────────────────
//
//   1. NI UNA PETICION mientras la ruta esta frenada. No se sondea, no se
//      "prueba a ver": se duerme exactamente lo que Roblox pidio, ni un ms
//      menos. Insistir sobre un 429 es como un limite corto se convierte en uno
//      largo.
//
//   2. ESPERAR TIENE PRESUPUESTO, y es distinto del de trabajar. Una espera que
//      no cabe en lo que queda no se empieza: se corta con el motivo preciso y
//      se devuelve lo encontrado. Nadie va a mirar un plugin parado dos minutos.
//
// La espera consume el presupuesto de ESPERA, no el de trabajo (ver
// pluginSearchService): parar el reloj de trabajo mientras estamos parados es
// lo que hace que una pausa de Roblox no se coma la busqueda entera.

const VEREDICTO = Object.freeze({
    LIBRE: 'libre',        // la ruta esta disponible: adelante
    ESPERADO: 'esperado',  // estaba frenada, se espero lo que pidio, ya se puede
    AGOTADO: 'agotado',    // frenada y la espera no cabe: hay que parar
});

function dormir(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// `presupuestoDeEspera()` devuelve cuantos ms se pueden gastar esperando AHORA
// MISMO. Lo calcula quien llama porque depende de dos relojes suyos (la espera
// acumulada y el techo de reloj de pared) y de nada de aqui.
function crearPuerta(stats, { presupuestoDeEspera, ahora = () => Date.now(), dormirFn = dormir } = {}) {
    const {
        rateLimitMaxWaits, rateLimitSingleWaitMs, rateLimitWaitMarginMs,
    } = config.pluginSearch;

    let esperas = 0;
    let esperadoMs = 0;

    return {
        get esperas() { return esperas; },
        get esperadoMs() { return esperadoMs; },

        // Deja pasar cuando la ruta este disponible. NUNCA lanza: devuelve un
        // veredicto y quien llama decide, igual que hace el resto de la
        // busqueda con los candidatos que no encajan.
        async abrir(routeKey) {
            const freno = rateLimiter.getThrottleState(routeKey);
            if (!freno.throttled) return VEREDICTO.LIBRE;

            // El breaker abierto no trae un plazo de Roblox sino uno nuestro, y
            // significa algo mas grave que una cuota agotada: la ruta viene
            // fallando de forma sostenida. Se respeta igual, pero se cuenta el
            // cooldown del breaker como espera.
            const pedido = Math.max(0, freno.cooldownRemainingMs) + rateLimitWaitMarginMs;

            const razones = [];
            if (esperas >= rateLimitMaxWaits) razones.push('demasiadas esperas');
            if (pedido > rateLimitSingleWaitMs) razones.push('espera demasiado larga');

            const disponible = Math.max(0, presupuestoDeEspera());
            if (pedido > disponible) razones.push('sin presupuesto de espera');

            if (razones.length > 0) {
                logger.warn('Busqueda del plugin detenida: Roblox frena y la espera no cabe', {
                    requestId: requestContext.requestId(),
                    searchId: requestContext.searchId(),
                    routeKey,
                    reason: freno.reason,
                    cooldownRemainingMs: freno.cooldownRemainingMs,
                    esperaPedidaMs: pedido,
                    presupuestoRestanteMs: disponible,
                    esperasHechas: esperas,
                    motivo: razones.join(' + '),
                });
                return VEREDICTO.AGOTADO;
            }

            esperas++;
            esperadoMs += pedido;
            stats.sumar('rateLimitWaits');
            stats.sumar('rateLimitWaitedMs', pedido);

            logger.info('Busqueda del plugin en pausa: esperando a que Roblox reabra una ruta', {
                requestId: requestContext.requestId(),
                searchId: requestContext.searchId(),
                routeKey,
                reason: freno.reason,
                esperaMs: pedido,
                spacingMs: freno.spacingMs,
                esperaNumero: esperas,
            });

            await dormirFn(pedido);
            return VEREDICTO.ESPERADO;
        },
    };
}

// Puerta que nunca espera. Existe para los llamadores que no participan del
// presupuesto de una busqueda (hoy, ninguno) y para que `crearIndiceDeCatalogo`
// pueda seguir construyendose sin puerta en una prueba sin arrastrar `undefined`
// hasta un `await`.
const PUERTA_ABIERTA = Object.freeze({
    esperas: 0,
    esperadoMs: 0,
    async abrir(routeKey) {
        return rateLimiter.getThrottleState(routeKey).throttled
            ? VEREDICTO.AGOTADO
            : VEREDICTO.LIBRE;
    },
});

module.exports = { crearPuerta, VEREDICTO, PUERTA_ABIERTA };
