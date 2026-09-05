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
// Tercera clave, y distinta de las dos anteriores por la misma razon: hay
// casos que comprueban justamente que la del plugin no abre /admin ni /v1, y
// que ninguna de esas dos abre /plugin.
process.env.PLUGIN_API_KEY = process.env.PLUGIN_API_KEY_TEST || 'clave-plugin-de-pruebas-distinta-de-las-otras-dos';
process.env.LOG_LEVEL = 'error';          // sin ruido de peticiones en la salida
process.env.CACHE_MAX_ENTRIES = '5';      // tope bajo para poder verificar la expulsion LRU
process.env.RATE_LIMIT_MAX = '25';        // tope bajo para poder verificar el 429 propio
process.env.UPSTREAM_RETRY_BASE_MS = '5'; // backoff casi instantaneo: los tests miden
process.env.UPSTREAM_RETRY_MAX_MS = '10'; // el COMPORTAMIENTO, no la duracion real

// Las PAUSAS por limite de Roblox se apagan por defecto en la suite: en
// produccion la busqueda duerme lo que Roblox pida (ver throttleGate.js), y con
// varios casos que provocan un 'retry-after' de 12-30 s a proposito, respetarlo
// aqui convertiria la suite en varios minutos de sleep. Los casos que prueban
// la pausa suben este presupuesto ELLOS, con cooldowns de milisegundos.
process.env.PLUGIN_SEARCH_RATE_LIMIT_WAIT_BUDGET_MS = '0';

// El limitador ABSORBE en linea los cooldowns cortos (hasta 2 s en produccion:
// duerme y reintenta sin devolver el control). Para poder ejercitar el camino de
// estacionar/reanudar con cooldowns de milisegundos, ese techo se baja aqui: un
// cooldown de 300 ms tiene que llegar a la busqueda como lo haria uno de 25 s.
process.env.UPSTREAM_INLINE_WAIT_CEILING_MS = '100';

const fs = require('fs');
const path = require('path');

(async () => {
    const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort();
    console.log(`outfit-api — ejecutando ${files.length} archivo(s) de test: ${files.join(', ')}\n`);

    let allOk = true;
    for (const file of files) {
        console.log(`--- ${file} ---`);
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
    console.error('EL RUNNER SE ROMPIO:', err);
    process.exit(1);
});
