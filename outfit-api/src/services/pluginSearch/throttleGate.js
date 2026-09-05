'use strict';

const config = require('../../config');
const logger = require('../../observability/logger');
const rateLimiter = require('../../roblox/rateLimiter');
const requestContext = require('../../observability/requestContext');

// LA PUERTA. Antes de gastar una llamada en una ruta de Roblox, se pregunta
// aqui si esa ruta esta disponible — y si no lo esta, LA BUSQUEDA SE ESTACIONA
// hasta que lo este.
//
// ── EL ERROR QUE ESTO CORRIGE ────────────────────────────────────────────────
//
// Un cooldown se estaba tratando como el final de la busqueda. En cuanto Roblox
// decia "espera 25 segundos" y esos 25 segundos no cabian en un presupuesto de
// espera en linea, la busqueda se rendia: 4 de 10, `stoppedBy:
// avatarRateLimit`, a los 20 segundos. Pero "espera 25 segundos" no es "no hay
// outfits" — es literalmente una instruccion de esperar 25 segundos, y un
// trabajo asincrono que el plugin sigue por searchId puede permitirse esperarlos
// sin sostener ningun socket.
//
// ── ESTACIONAR, NO DORMIR ────────────────────────────────────────────────────
//
//   RUNNING
//     ↓ Roblox pide esperar (retry-after / reset)
//   calcular resumeAt
//     ↓
//   PARK: se persiste el checkpoint del trabajo (fase, resumeAt, ruta, lo
//         encontrado, lo pendiente), se renueva el lease del grupo hasta
//         resumeAt + margen, y el plugin ve `phase: rateLimitWait`.
//     ↓ CERO peticiones a Roblox mientras tanto
//   latidos periodicos: el trabajo sigue vivo y el lease sigue renovado
//     ↓ llega resumeAt
//   RUNNING, exactamente donde se quedo
//
// Si el proceso muere estacionado, el checkpoint es lo que permite que otra
// instancia lo adopte y siga: `resumeAt` se reaplica al limitador, los
// pendientes se retoman y la rotacion no se ha movido.
//
// ── LAS DOS REGLAS ──────────────────────────────────────────────────────────
//
//   1. NI UNA PETICION mientras la ruta esta frenada. No se sondea, no se
//      "prueba a ver": se espera exactamente lo que Roblox pidio, ni un ms
//      menos. Insistir sobre un 429 es como un limite corto se convierte en uno
//      largo. Esta invariante la garantiza el propio limitador (recomprueba el
//      cooldown justo antes de cada envio); la puerta solo evita ENTRAR ahi.
//
//   2. ESPERAR TIENE PRESUPUESTO, y es distinto del de trabajar. Puede
//      atravesar VARIOS cooldowns — eso es lo normal, no la excepcion — pero un
//      trabajo no puede vivir para siempre: hay un techo de reloj de pared, y
//      cuando la pausa que Roblox pide no cabe en el, se corta con el motivo
//      preciso y se devuelve lo encontrado. Ese corte es la proteccion
//      extrema, no el comportamiento habitual.

const VEREDICTO = Object.freeze({
    LIBRE: 'libre',        // la ruta esta disponible: adelante
    ESPERADO: 'esperado',  // estaba frenada, se estaciono lo que pidio, ya se puede
    AGOTADO: 'agotado',    // frenada y la espera no cabe: hay que parar
});

function dormir(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// `presupuestoDeEspera()` devuelve cuantos ms se pueden gastar estacionado
// AHORA MISMO. Lo calcula quien llama porque depende de sus relojes.
//
// Los tres ganchos son lo que hace el estacionamiento DURABLE en vez de un
// setTimeout: `alParquear` persiste el checkpoint y renueva el lease,
// `latido` mantiene vivos el trabajo y el lease mientras se espera, y
// `alReanudar` deja constancia de que se volvio a trabajar. Cualquiera de ellos
// puede lanzar — por ejemplo, si otra instancia adopto este trabajo — y ese
// lanzamiento SALE de aqui tal cual: es la señal de que este proceso ya no es
// el dueño y tiene que parar.
function crearPuerta(stats, {
    presupuestoDeEspera,
    alParquear = async () => {},
    latido = async () => {},
    alReanudar = async () => {},
    ahora = () => Date.now(),
    dormirFn = dormir,
} = {}) {
    const {
        rateLimitMaxWaits, rateLimitSingleWaitMs, rateLimitWaitMarginMs, rateLimitHeartbeatMs,
    } = config.pluginSearch;

    let esperas = 0;
    let esperadoMs = 0;
    let parqueoActual = null;

    return {
        get esperas() { return esperas; },
        get esperadoMs() { return esperadoMs; },
        get parqueo() { return parqueoActual; },

        // Se llama al reanudar un trabajo desde un checkpoint que ya llevaba
        // pausas: la contabilidad continua, no empieza de cero.
        restaurar({ esperas: e = 0, esperadoMs: ms = 0 } = {}) {
            esperas = e;
            esperadoMs = ms;
        },

        // Deja pasar cuando la ruta este disponible. NUNCA lanza por si misma:
        // devuelve un veredicto y quien llama decide, igual que hace el resto
        // de la busqueda con los candidatos que no encajan.
        async abrir(routeKey) {
            const freno = rateLimiter.getThrottleState(routeKey);
            if (!freno.throttled) return VEREDICTO.LIBRE;

            // El breaker abierto no trae un plazo de Roblox sino uno nuestro, y
            // significa algo mas grave que una cuota agotada: la ruta viene
            // fallando de forma sostenida. Se respeta igual.
            const pedido = Math.max(0, freno.cooldownRemainingMs) + rateLimitWaitMarginMs;

            const razones = [];
            if (esperas >= rateLimitMaxWaits) razones.push('demasiadas pausas');
            if (pedido > rateLimitSingleWaitMs) razones.push('pausa demasiado larga');

            const disponible = Math.max(0, presupuestoDeEspera());
            if (pedido > disponible) razones.push('sin presupuesto de reloj de pared');

            if (razones.length > 0) {
                logger.warn('Busqueda del plugin detenida: Roblox frena y la pausa no cabe', {
                    requestId: requestContext.requestId(),
                    searchId: requestContext.searchId(),
                    routeKey,
                    reason: freno.reason,
                    cooldownRemainingMs: freno.cooldownRemainingMs,
                    pausaPedidaMs: pedido,
                    presupuestoRestanteMs: disponible,
                    pausasHechas: esperas,
                    motivo: razones.join(' + '),
                });
                return VEREDICTO.AGOTADO;
            }

            // ── PARK ─────────────────────────────────────────────────────────
            const inicio = ahora();
            const resumeAt = inicio + pedido;
            esperas++;
            stats.sumar('rateLimitWaits');

            parqueoActual = {
                route: routeKey,
                reason: freno.reason,
                resumeAt,
                retryAfterMs: pedido,
                pausa: esperas,
            };

            logger.info('Busqueda del plugin estacionada: esperando a que Roblox reabra una ruta', {
                requestId: requestContext.requestId(),
                searchId: requestContext.searchId(),
                routeKey,
                reason: freno.reason,
                retryAfterMs: pedido,
                resumeAt: new Date(resumeAt).toISOString(),
                spacingMs: freno.spacingMs,
                pausa: esperas,
                quotaLimit: freno.quota?.limit ?? null,
            });

            try {
                await alParquear(parqueoActual);

                // ── La espera, con latidos ───────────────────────────────────
                // Se duerme a trozos y no de una vez: cada trozo es un latido
                // que mantiene vivos el trabajo (heartbeat) y el lease del
                // grupo. Sin latidos, una pausa de 25 s se pareceria a un
                // proceso muerto y el recolector lo daria por huerfano.
                for (;;) {
                    const restante = resumeAt - ahora();
                    if (restante <= 0) break;
                    const trozo = Math.min(restante, rateLimitHeartbeatMs);
                    await dormirFn(trozo);
                    esperadoMs += trozo;
                    stats.sumar('rateLimitWaitedMs', trozo);
                    await latido({ ...parqueoActual, restanteMs: Math.max(0, resumeAt - ahora()) });
                }

                await alReanudar(parqueoActual);
            } finally {
                parqueoActual = null;
            }

            logger.info('Busqueda del plugin reanudada tras la pausa de Roblox', {
                requestId: requestContext.requestId(),
                searchId: requestContext.searchId(),
                routeKey,
                pausa: esperas,
                esperadoTotalMs: esperadoMs,
            });

            return VEREDICTO.ESPERADO;
        },
    };
}

// Puerta que nunca estaciona. Existe para que `crearIndiceDeCatalogo` pueda
// construirse sin puerta en una prueba sin arrastrar `undefined` hasta un
// `await`. Ningun camino de produccion la usa.
const PUERTA_ABIERTA = Object.freeze({
    esperas: 0,
    esperadoMs: 0,
    parqueo: null,
    restaurar() {},
    async abrir(routeKey) {
        return rateLimiter.getThrottleState(routeKey).throttled
            ? VEREDICTO.AGOTADO
            : VEREDICTO.LIBRE;
    },
});

module.exports = { crearPuerta, VEREDICTO, PUERTA_ABIERTA };
