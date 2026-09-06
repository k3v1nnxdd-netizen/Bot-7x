'use strict';

const config = require('../config');
const requestContext = require('../observability/requestContext');

// Abre el PRESUPUESTO DE TIEMPO de una peticion del juego.
//
// QUE HACE. Marca un instante limite y lo deja en el contexto asincrono, donde
// lo lee el limitador de Roblox (src/roblox/rateLimiter.js) para decidir si un
// reintento merece la pena. No cancela nada a la fuerza ni corta sockets: solo
// evita EMPEZAR trabajo que ya no va a llegar a tiempo.
//
// POR QUE HACE FALTA, MEDIDO. `UPSTREAM_TIMEOUT_MS` acota una llamada, no una
// peticion. Con Roblox sin contestar, un listado de outfits tardaba 18,6 s
// —tres intentos de 6 s— en devolver el mismo error que el primer intento ya
// tenia a los 6 s. Y eso es el coste de UNA llamada: el listado encadena dos
// (usuario -> outfits), asi que lo que tarde la segunda se suma encima. Un
// jugador con la pantalla delante ya se ha ido mucho antes.
//
// DONDE SE MONTA. En las rutas que atiende el juego, que son las que tienen a
// un jugador delante. Un trabajo largo y sin nadie esperando no deberia abrir
// presupuesto: abandonar a los ocho segundos seria lo contrario de lo que
// conviene ahi.
//
// Va ANTES de la comprobacion de licencia porque el tiempo de esa comprobacion
// tambien lo espera el jugador: el presupuesto es del reloj de pared de la
// peticion, no del ultimo tramo.
function requestBudget(req, res, next) {
    const presupuesto = config.upstream.requestBudgetMs;

    // Un presupuesto de cero o negativo lo desactiva por completo y devuelve el
    // comportamiento anterior. Es la valvula de escape de produccion: se cambia
    // con una variable de entorno, sin desplegar codigo.
    if (!(presupuesto > 0)) return next();

    requestContext.ejecutarCon({ fechaLimite: Date.now() + presupuesto }, next);
}

module.exports = { requestBudget };
