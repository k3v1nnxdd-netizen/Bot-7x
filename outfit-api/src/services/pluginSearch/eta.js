'use strict';

const config = require('../../config');

// Estimacion del tiempo restante. Puro: no toca red ni base, solo aritmetica
// sobre lo que ya se ha medido.
//
// LA REGLA: NUNCA PROMETER PRECISION QUE NO SE TIENE. Con dos candidatos
// examinados la tasa de aceptacion es ruido, y una ETA sacada de ahi no es una
// estimacion mala: es una mentira, porque quien la lee se la cree. Mientras no
// haya muestra suficiente se devuelve `null` y el plugin escribe "calculando".
//
// EL MODELO, en una linea: lo que falta por encontrar, dividido por la
// proporcion de candidatos que valen, por lo que cuesta mirar un candidato.
//
//   candidatosQueFaltan = (objetivo - encontrados) / tasaDeAceptacion
//   msRestantes         = candidatosQueFaltan * msPorCandidato
//
// Las dos magnitudes se suavizan con EWMA para que la cifra no salte en cada
// vuelta del bucle: sin suavizar, aceptar dos candidatos seguidos dispararia la
// tasa y la ETA se desplomaria, para volver a subir al siguiente rechazo. Una
// ETA que baila es peor que no tenerla.

// Media exponencial. `anterior` null = primera muestra, que entra tal cual.
function ewma(anterior, muestra, alpha = config.pluginEta.ewmaAlpha) {
    if (!Number.isFinite(muestra)) return anterior;
    if (anterior === null || anterior === undefined || !Number.isFinite(anterior)) return muestra;
    return anterior * (1 - alpha) + muestra * alpha;
}

// Crea el estimador de UNA busqueda.
//
// `previas` son las medias que la comunidad ya aprendio en busquedas
// anteriores (Postgres). Sirven para dar una ETA util DESDE EL PRIMER
// SEGUNDO en un grupo ya conocido, en vez de esperar a juntar muestra propia.
// Si el grupo es nuevo, se empieza sin nada y se dice "calculando".
function crearEstimador({ target, previas = null, ahora = () => Date.now() } = {}) {
    const empezado = ahora();

    // Se siembran con lo aprendido, que es lo que hace la primera estimacion
    // creible. La muestra propia las va desplazando conforme llega.
    let tasaAceptacion = previas?.acceptanceRate ?? null;
    let msPorCandidato = previas?.candidateLatencyMs ?? null;

    let examinadosPrevios = 0;
    let ultimoInstante = empezado;

    // Tiempo que la busqueda ha pasado ESTACIONADA esperando a Roblox. Se
    // descuenta de todo lo que mide velocidad: un candidato no "tarda" 25 s
    // porque entre el y el siguiente hubiera una pausa.
    let pausadoMs = 0;

    return {
        // Se llama cuando termina una pausa, con lo que duro. Desplaza el
        // ultimo instante medido para que la siguiente observacion no cargue
        // la pausa al coste por candidato.
        pausar(ms) {
            if (!Number.isFinite(ms) || ms <= 0) return;
            pausadoMs += ms;
            ultimoInstante += ms;
        },

        // Reanudacion desde un checkpoint: lo ya pausado antes del reinicio
        // sigue contando como pausado.
        restaurar({ pausadoMs: previo = 0 } = {}) {
            if (Number.isFinite(previo) && previo > 0) pausadoMs += previo;
        },

        // Se llama cuando cambia el progreso. `examinados` y `encontrados` son
        // acumulados, no incrementos.
        observar({ examinados, encontrados }) {
            const instante = ahora();
            const nuevos = examinados - examinadosPrevios;

            if (nuevos > 0) {
                const msPorCadaUno = (instante - ultimoInstante) / nuevos;
                msPorCandidato = ewma(msPorCandidato, msPorCadaUno);
                examinadosPrevios = examinados;
                ultimoInstante = instante;
            }

            if (examinados > 0) {
                tasaAceptacion = ewma(tasaAceptacion, encontrados / examinados);
            }
        },

        // La foto que se devuelve al plugin. Todo numero que salga de aqui es
        // finito y no negativo, o es null; nunca NaN ni Infinity.
        //
        // `parqueo` es la pausa EN CURSO, si la hay: { route, resumeAt,
        // retryAfterMs }. Con ella la foto lleva `phase: 'rateLimitWait'` y la
        // ETA suma el cooldown que queda ANTES de la estimacion de trabajo, en
        // vez de fingir que se sigue examinando gente.
        progreso({ examinados, encontrados, parqueo = null }) {
            const instante = ahora();
            const elapsedMs = Math.max(0, instante - empezado);
            const faltan = Math.max(0, target - encontrados);

            const enPausa = Boolean(parqueo);
            const cooldownRestanteMs = enPausa
                ? Math.max(0, Math.round((parqueo.resumeAt ?? instante) - instante))
                : 0;

            // Lo que el plugin necesita para decir "esperando a Roblox" en vez
            // de dejar una barra congelada sin explicacion. Aditivo: un cliente
            // que no lo conozca lo ignora sin romperse.
            const fase = enPausa
                ? {
                    phase: 'rateLimitWait',
                    rateLimitedRoute: parqueo.route ?? null,
                    resumeAt: parqueo.resumeAt ? new Date(parqueo.resumeAt).toISOString() : null,
                    retryAfterMs: Number.isFinite(parqueo.retryAfterMs) ? Math.max(0, Math.round(parqueo.retryAfterMs)) : null,
                    cooldownRemainingMs: cooldownRestanteMs,
                }
                : {
                    phase: 'working',
                    rateLimitedRoute: null,
                    resumeAt: null,
                    retryAfterMs: null,
                    cooldownRemainingMs: 0,
                };

            // La ultima ola puede aceptar un par de mas antes de que se
            // compruebe la parada, y esos sobrantes se recortan al devolver los
            // resultados. Aqui se recorta igual: enseñar "41 / 40 encontrados"
            // en el panel seria absurdo, y ademas no coincidiria con los
            // outfits que llegan. El recuento crudo sigue en stats.accepted.
            const mostrados = Math.min(encontrados, target);

            const base = {
                target,
                found: mostrados,
                candidatesExamined: examinados,
                elapsedMs,
                // Tiempo de TRABAJO, sin las pausas. Es el que se compara con
                // el presupuesto de trabajo.
                workingMs: Math.max(0, elapsedMs - pausadoMs),
                pausedMs: Math.max(0, Math.round(pausadoMs)),
                ...fase,
                // Progreso de RESULTADOS, que es lo unico honesto que se puede
                // pintar en una barra: los candidatos examinados no dicen nada
                // sobre cuanto queda, porque no se sabe cuantos haran falta.
                completionRatio: target > 0 ? Math.min(1, mostrados / target) : 1,
                acceptanceRate: redondear(tasaAceptacion),
                msPerCandidate: redondear(msPorCandidato),
            };

            if (faltan === 0) {
                return { ...base, estimatedRemainingMs: 0, etaConfidence: 'done' };
            }

            // Sin muestra suficiente NI historial del grupo: no se estima el
            // trabajo. En pausa, lo unico honesto que se puede prometer es el
            // cooldown que queda — eso si se sabe con exactitud.
            const muestraSuficiente = examinados >= config.pluginEta.minSamples;
            const hayHistorial = previas?.searchesCompleted > 0;
            if (!muestraSuficiente && !hayHistorial) {
                return {
                    ...base,
                    estimatedRemainingMs: enPausa ? cooldownRestanteMs : null,
                    etaConfidence: enPausa ? 'low' : 'calculating',
                };
            }

            // Una tasa de aceptacion de 0 significa "de momento no ha valido
            // ninguno". No se puede dividir por eso, y fingir un numero seria
            // justo lo que no se quiere: se dice que no se sabe.
            if (!Number.isFinite(tasaAceptacion) || tasaAceptacion <= 0
                || !Number.isFinite(msPorCandidato) || msPorCandidato <= 0) {
                return {
                    ...base,
                    estimatedRemainingMs: enPausa ? cooldownRestanteMs : null,
                    etaConfidence: enPausa ? 'low' : 'unknown',
                };
            }

            const candidatosQueFaltan = faltan / tasaAceptacion;
            // En pausa: lo que queda de cooldown + lo que costara el trabajo
            // que falta. Nunca se recalcula como si se estuviera procesando.
            const estimado = cooldownRestanteMs + candidatosQueFaltan * msPorCandidato;

            return {
                ...base,
                estimatedRemainingMs: Math.min(
                    Math.max(0, Math.round(estimado)),
                    config.pluginEta.maxEstimateMs + cooldownRestanteMs
                ),
                // `low` cuando la cifra se apoya sobre todo en el historial del
                // grupo y no en lo medido ahora. El plugin puede pintarla mas
                // discreta en vez de darla por buena.
                etaConfidence: muestraSuficiente ? 'ok' : 'low',
            };
        },

        // Lo que esta busqueda le enseña a la comunidad para la proxima.
        muestraFinal({ examinados, encontrados }) {
            const elapsedMs = Math.max(1, ahora() - empezado);
            // La latencia que se enseña al grupo es de TRABAJO: una comunidad
            // no es "lenta" porque Roblox nos hiciera esperar un rato.
            const trabajadoMs = Math.max(1, elapsedMs - pausadoMs);
            return {
                acceptanceRate: examinados > 0 ? encontrados / examinados : 0,
                candidateLatencyMs: examinados > 0 ? trabajadoMs / examinados : trabajadoMs,
                candidatesPerResult: encontrados > 0 ? examinados / encontrados : examinados,
                durationMs: elapsedMs,
                candidatesExamined: examinados,
            };
        },
    };
}

// Dos decimales bastan para lo que se enseña, y evita arrastrar dieciseis
// digitos de coma flotante hasta el JSON.
function redondear(valor) {
    if (valor === null || !Number.isFinite(valor)) return null;
    return Math.round(valor * 100) / 100;
}

module.exports = { crearEstimador, ewma };
