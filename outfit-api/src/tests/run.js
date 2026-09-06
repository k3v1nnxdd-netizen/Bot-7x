'use strict';

// Runner de los tests propios de outfit-api. Ejecuta todos los *.test.js de
// este directorio. NO entra en src/tests/live/, que si golpea Roblox de
// verdad y es solo para verificacion manual bajo demanda.
//
// Ninguno de estos tests toca la red ni el disco: la unica dependencia
// externa del servicio es Roblox, y la clasificacion de sus fallos se
// ejercita con errores fabricados con la forma exacta que produce axios.

// Las variables se fijan ANTES de requerir nada, porque src/config las lee
// una sola vez al cargarse. dotenv no pisa lo que ya existe en process.env,
// asi que esto gana aunque haya un .env local.
process.env.OUTFIT_API_KEY = process.env.OUTFIT_API_KEY_TEST || 'clave-de-pruebas-no-usada-en-produccion';
// Distinta de la anterior a proposito: varios tests comprueban justamente que
// una no sirve para lo de la otra.
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY_TEST || 'clave-admin-de-pruebas-distinta-de-la-otra';
process.env.LOG_LEVEL = 'error';          // sin ruido de peticiones en la salida
process.env.CACHE_MAX_ENTRIES = '5';      // tope bajo para poder verificar la expulsion LRU
process.env.RATE_LIMIT_MAX = '25';        // tope bajo para poder verificar el 429 propio
process.env.UPSTREAM_RETRY_BASE_MS = '5'; // backoff casi instantaneo: los tests miden
process.env.UPSTREAM_RETRY_MAX_MS = '10'; // el COMPORTAMIENTO, no la duracion real

// El limitador ABSORBE en linea los cooldowns cortos (hasta 2 s en produccion:
// duerme y reintenta sin devolver el control). Ese techo se baja aqui para poder
// ejercitar con cooldowns de milisegundos el camino en el que la espera NO cabe
// y se le devuelve el control al llamador con un Retry-After.
process.env.UPSTREAM_INLINE_WAIT_CEILING_MS = '100';

// Y el cooldown conservador para 429 sin cabecera se acorta: en produccion
// son 5-60 s escalonados; aqui basta con que exista y escale.
process.env.UPSTREAM_RATE_LIMIT_FALLBACK_BASE_MS = '150';
process.env.UPSTREAM_RATE_LIMIT_FALLBACK_MAX_MS = '1200';

const fs = require('fs');
const path = require('path');

// ── DIAGNOSTICO DE MUERTES SILENCIOSAS ──────────────────────────────────────
//
// Sin esto, una promesa rechazada sin dueño mata el proceso con exit 1 y SIN
// una sola linea de FAIL: Node 24 trata un unhandledRejection como fatal. El
// resultado es una corrida roja que no dice que test la rompio — y si ademas
// la salida se descarto, no hay forma de averiguarlo. Ya paso una vez en este
// proyecto y costo once corridas completas no reproducirlo.
//
// Estos dos manejadores no cambian NADA de como se ejecutan los tests: solo
// garantizan que, si el proceso se muere por la puerta de atras, deje dicho
// donde estaba y por que.

// Fichero de test en curso. Es el dato que faltaba: un rechazo suelto puede
// aflorar mucho despues de la linea que lo creo, pero casi siempre dentro del
// mismo archivo, y saber cual acota la busqueda de treinta ficheros a uno.
let ficheroEnCurso = '(ninguno todavia)';

function abortarPor(tipo, error) {
    console.error(`\n=== ${tipo.toUpperCase()} — EL PROCESO DE TESTS MUERE AQUI ===`);
    console.error(`archivo de test en curso: ${ficheroEnCurso}`);

    // El stack completo, sin recortar: es lo unico que senala la linea real.
    if (error instanceof Error) {
        console.error(`tipo: ${error.name}`);
        console.error(`mensaje: ${error.message}`);
        if (error.code) console.error(`code: ${error.code}`);
        console.error(error.stack ?? '(sin stack)');
        // Un error envuelto (axios, pg) esconde la causa util dentro.
        if (error.cause) console.error('causa:', error.cause);
    } else {
        // Un rechazo puede llevar cualquier cosa, no solo un Error.
        console.error('valor rechazado (no es un Error):', error);
    }

    console.error('=== fin del diagnostico ===\n');

    // Se sale despues de imprimirlo TODO, no antes: process.exit corta la
    // escritura pendiente de stdout, asi que el orden aqui importa.
    process.exit(1);
}

process.on('unhandledRejection', razon => abortarPor('unhandledRejection', razon));
process.on('uncaughtException', err => abortarPor('uncaughtException', err));

(async () => {
    const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort();
    console.log(`outfit-api — ejecutando ${files.length} archivo(s) de test: ${files.join(', ')}\n`);

    let allOk = true;
    for (const file of files) {
        console.log(`--- ${file} ---`);
        ficheroEnCurso = file;
        const testFn = require(path.join(__dirname, file));
        const ok = await testFn();
        if (!ok) allOk = false;
        console.log();
    }

    if (!allOk) {
        console.error('FALLARON ALGUNOS TESTS');
        process.exit(1);
    }
    console.log('TODOS LOS TESTS PASARON');
    process.exit(0);
})().catch(err => {
    // Fallo del propio bucle (un require roto, un test que lanza fuera de su
    // arnes). Se aprovecha el mismo diagnostico para que la salida sea
    // identica venga por donde venga.
    console.error('EL RUNNER SE ROMPIO');
    abortarPor('runner', err);
});
