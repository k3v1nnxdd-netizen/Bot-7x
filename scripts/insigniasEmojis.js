'use strict';

// ── Insignias oficiales de Discord como emojis del bot ───────────────────────
//
// Las imágenes de assets/insignias/ son las que Discord sirve en su CDN para
// los perfiles (cdn.discordapp.com/badge-icons/<hash>.png). Se suben como
// emojis de la APLICACIÓN (se ven en todos lados, con o sin Nitro) para que
// /userinfo enseñe las insignias igual que el perfil.
//
//   node scripts/insigniasEmojis.js   -> sube las que falten e imprime los ids
//
// Los ids van a config.INSIGNIAS_EMOJIS.

const fs = require('fs');
const path = require('path');
const { subir } = require('./barraEmojis');

if (require.main === module) {
    (async () => {
        const dir = path.join(__dirname, '..', 'assets', 'insignias');
        const pngs = {};
        for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.png') && f !== 'muestra.png')) {
            pngs[`b_${path.basename(f, '.png')}`] = fs.readFileSync(path.join(dir, f));
        }
        const ids = await subir(pngs);
        console.log('\nPara config.INSIGNIAS_EMOJIS:');
        console.log(JSON.stringify(Object.fromEntries(Object.entries(ids).map(([k, v]) => [k.slice(2), v])), null, 2));
    })().catch(err => { console.error(err); process.exit(1); });
}
