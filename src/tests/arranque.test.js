'use strict';

// Tests del arranque: que main.js no se deje a medias nada de lo que importa.
//
// Nace de un fallo real: el panel de estado de entrega se importó en main.js,
// se le escribió el comando y los tests, y NUNCA se llamó al arrancar. El canal
// se quedó vacío y no hubo ni un error en consola — un import sin usar no se
// queja. Se descubrió mirando el canal, que es la peor forma de descubrirlo.
//
// Esto lo comprueba leyendo main.js como texto, sin arrancar el bot: cualquier
// `ensure*Panel` que se importe tiene que llamarse dentro del ClientReady, y
// cualquier `handle*` de un comando registrado tiene que estar enrutado.

const fs = require('fs');
const path = require('path');
const { createSuite } = require('./testHarness');

// Normalizado a LF: en Windows el fichero se saca del repo con CRLF, y sin esto
// cualquier patrón que cruce un salto de línea deja de encontrar nada — y un
// test que no encuentra nada pasa por vacío en vez de fallar.
const MAIN = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');

// Los `ensure…Panel` que main.js requiere de un módulo del proyecto.
function panelesImportados() {
    const out = new Set();
    for (const m of MAIN.matchAll(/const\s*\{([^}]*)\}\s*=\s*require\('\.\/[^']+'\)/g)) {
        for (const nombre of m[1].split(',')) {
            const limpio = nombre.trim();
            if (/^ensure\w*Panel$/.test(limpio)) out.add(limpio);
        }
    }
    return [...out];
}

// Los nombres de comando registrados en guild.commands.set([...]).
function comandosRegistrados() {
    return [...MAIN.matchAll(/^\s*name: '([a-z0-9_-]+)',\s*$/gm)]
        .map(m => m[1])
        // `name:` aparece también en las opciones y en sus choices; los
        // comandos son los que llevan una descripción justo debajo y no están
        // anidados. Se filtran por los que main.js enruta o registra a primer
        // nivel: basta con quedarse con los que aparecen junto a `description:`
        // en la misma entrada, que es el caso de todos.
        .filter(nombre => new RegExp(`name: '${nombre}',\\n\\s*description:`).test(MAIN));
}

module.exports = async function run() {
    const { assert, finish } = createSuite('arranque');

    // ── 1. Todo panel importado se publica al arrancar ───────────────────────
    const paneles = panelesImportados();
    assert(paneles.length >= 8, `main.js importa varios paneles (${paneles.length})`);

    for (const panel of paneles) {
        // Llamado de verdad, no sólo importado. Se busca `await <panel>(client)`
        // porque es como se llaman todos en el ClientReady.
        const llamado = new RegExp(`await\\s+${panel}\\(client\\)`).test(MAIN);
        assert(llamado, `${panel} se llama al arrancar, no sólo se importa`);
    }

    // ── 2. Todo comando registrado tiene su enrutado ─────────────────────────
    // El otro lado del mismo error: registrar un comando en Discord y no
    // enrutarlo deja al usuario con "La aplicación no responde".
    const comandos = comandosRegistrados();
    assert(comandos.length >= 10, `hay comandos registrados (${comandos.length})`);

    // `connect` lo enruta handleConnect desde utils/voice, con el mismo patrón.
    for (const comando of comandos) {
        const enrutado = new RegExp(`commandName === '${comando}'`).test(MAIN);
        assert(enrutado, `/${comando} está enrutado en InteractionCreate`);
    }

    // ── 3. Los canales que usan esos paneles existen en config ───────────────
    const config = require('../../config');
    for (const [clave, id] of Object.entries(config.CHANNELS)) {
        assert(/^\d{17,20}$/.test(String(id)), `CHANNELS.${clave} es un id de Discord válido (${id})`);
    }

    return finish();
};
