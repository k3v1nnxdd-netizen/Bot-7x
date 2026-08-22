'use strict';

// VERIFICACION MANUAL CONTRA POSTGRES DE VERDAD — SI abre una conexion real.
// Nunca se ejecuta con `npm test` (el runner solo recorre src/tests/*.test.js
// y no entra en live/). Se lanza a mano:
//
//   cd outfit-api
//   DATABASE_URL="postgresql://..." npm run db:check     # bash
//   $env:DATABASE_URL="postgresql://..."; npm run db:check   # PowerShell
//
// En Railway, con la CLI: `railway run npm run db:check` — asi ni siquiera
// hace falta tener la URL a mano, la inyecta el propio Railway.
//
// Comprueba, en este orden:
//   1. que se puede conectar y quienes somos (usuario, base, version);
//   2. que ensureSchema() deja group_whitelist creada (y que repetirlo no
//      rompe nada: se ejecuta DOS veces a proposito);
//   3. que las columnas son exactamente las pedidas, con sus tipos y defaults;
//   4. que una escritura/lectura parametrizada funciona de punta a punta.
//
// El paso 4 va dentro de una transaccion con ROLLBACK: prueba el camino
// completo de escritura SIN dejar ni una fila en la tabla.

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error'; // salida limpia
process.env.OUTFIT_API_KEY = process.env.OUTFIT_API_KEY || 'clave-de-verificacion-local';

const db = require('../../db/pool');
const { ensureSchema } = require('../../db/schema');

const TABLA = 'group_whitelist';
const GROUP_ID_PRUEBA = "prueba-'; DROP TABLE group_whitelist; --";

let fallos = 0;

function ok(label, detalle) {
    console.log(`  ok   ${label}${detalle ? ` — ${detalle}` : ''}`);
}

function fail(label, detalle) {
    fallos++;
    console.error(`  FAIL ${label}${detalle ? ` — ${detalle}` : ''}`);
}

(async () => {
    if (!db.isConfigured()) {
        console.error('DATABASE_URL no esta definida. Exportala antes de lanzar esta verificacion.');
        process.exit(1);
    }

    const destino = db.describeTarget();
    console.log(`outfit-api — verificacion de Postgres contra ${destino.host}:${destino.port}/${destino.database}\n`);

    // ── 1. Conexion ──────────────────────────────────────────────────────────
    try {
        const { rows } = await db.query(
            'SELECT current_database() AS base, current_user AS usuario, version() AS version'
        );
        ok('conexion establecida', `base=${rows[0].base} usuario=${rows[0].usuario}`);
        console.log(`       ${rows[0].version.split(',')[0]}`);
    } catch (err) {
        fail('conexion establecida', err.message);
        await db.close();
        process.exit(1);
    }

    // ── 2. Esquema idempotente ───────────────────────────────────────────────
    const primera = await ensureSchema();
    primera.ready
        ? ok('ensureSchema() primera pasada', primera.tables.map(t => `${t.nombre}${t.creada ? ' (creada ahora)' : ' (ya existia)'}`).join(', '))
        : fail('ensureSchema() primera pasada', primera.reason);

    const segunda = await ensureSchema();
    segunda.ready && segunda.tables.every(t => !t.creada)
        ? ok('ensureSchema() repetido no rompe ni recrea', 'la tabla ya existia en la segunda pasada')
        : fail('ensureSchema() repetido no rompe ni recrea', JSON.stringify(segunda));

    // ── 3. Forma de la tabla ─────────────────────────────────────────────────
    const ESPERADO = {
        group_id: { data_type: 'text', is_nullable: 'NO', column_default: null },
        active: { data_type: 'boolean', is_nullable: 'NO', column_default: 'true' },
        created_at: { data_type: 'timestamp with time zone', is_nullable: 'NO', column_default: 'now()' },
    };

    try {
        const { rows } = await db.query(
            `SELECT column_name, data_type, is_nullable, column_default
               FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = $1
              ORDER BY ordinal_position`,
            [TABLA]
        );

        if (!rows.length) {
            fail(`la tabla ${TABLA} existe`, 'information_schema no devuelve columnas');
        } else {
            ok(`la tabla ${TABLA} existe`, `${rows.length} columnas`);
            for (const [nombre, esperado] of Object.entries(ESPERADO)) {
                const real = rows.find(r => r.column_name === nombre);
                if (!real) {
                    fail(`columna ${nombre}`, 'no existe');
                    continue;
                }
                const problemas = [];
                if (real.data_type !== esperado.data_type) problemas.push(`tipo=${real.data_type}`);
                if (real.is_nullable !== esperado.is_nullable) problemas.push(`nullable=${real.is_nullable}`);
                if ((real.column_default ?? null) !== esperado.column_default) problemas.push(`default=${real.column_default}`);
                problemas.length
                    ? fail(`columna ${nombre}`, problemas.join(' '))
                    : ok(`columna ${nombre}`, `${real.data_type}${real.column_default ? ` default ${real.column_default}` : ''} not null`);
            }
        }

        // La clave primaria no sale de information_schema.columns.
        const { rows: pk } = await db.query(
            `SELECT a.attname AS columna
               FROM pg_index i
               JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
              WHERE i.indrelid = to_regclass($1) AND i.indisprimary`,
            [TABLA]
        );
        pk.length === 1 && pk[0].columna === 'group_id'
            ? ok('clave primaria', 'group_id')
            : fail('clave primaria', JSON.stringify(pk));
    } catch (err) {
        fail('inspeccion del esquema', err.message);
    }

    // ── 4. Escritura/lectura parametrizada, revertida al final ───────────────
    // El group_id de prueba lleva comillas y un DROP TABLE dentro a proposito:
    // si algun dia alguien concatena en vez de parametrizar, esta prueba se
    // lleva la tabla por delante y el fallo se ve al instante.
    // El ROLLBACK se provoca lanzando un centinela desde dentro de la
    // transaccion: withTransaction revierte ante cualquier error, asi que asi
    // se prueba el camino de escritura completo sin dejar rastro.
    const REVERTIR = Symbol('rollback-intencionado');
    try {
        let rows = [];
        try {
            await db.withTransaction(async q => {
                await q(
                    'INSERT INTO group_whitelist (group_id) VALUES ($1) ON CONFLICT (group_id) DO NOTHING',
                    [GROUP_ID_PRUEBA]
                );
                ({ rows } = await q(
                    'SELECT group_id, active, created_at FROM group_whitelist WHERE group_id = $1',
                    [GROUP_ID_PRUEBA]
                ));
                throw REVERTIR;
            });
        } catch (err) {
            if (err !== REVERTIR) throw err;
        }

        if (rows.length === 1 && rows[0].group_id === GROUP_ID_PRUEBA && rows[0].active === true && rows[0].created_at instanceof Date) {
            ok('insert + select parametrizados', 'active=true y created_at por defecto');
        } else {
            fail('insert + select parametrizados', JSON.stringify(rows));
        }

        const { rows: restantes } = await db.query(
            'SELECT count(*)::int AS n FROM group_whitelist WHERE group_id = $1',
            [GROUP_ID_PRUEBA]
        );
        restantes[0].n === 0
            ? ok('rollback limpio', 'la fila de prueba no quedo en la tabla')
            : fail('rollback limpio', `quedaron ${restantes[0].n} filas`);

        const sigueViva = await db.query('SELECT to_regclass($1) AS oid', [TABLA]);
        sigueViva.rows[0].oid
            ? ok('sin inyeccion SQL', 'la tabla sigue existiendo tras usar un id con DROP TABLE dentro')
            : fail('sin inyeccion SQL', 'LA TABLA HA DESAPARECIDO');
    } catch (err) {
        fail('insert + select parametrizados', err.message);
    }

    // ── 5. El SQL real del servicio de whitelist ─────────────────────────────
    // Los tests de src/tests/adminGroups.test.js sustituyen la base por un
    // doble, asi que verifican el cableado HTTP pero NO que estas consultas
    // sean SQL valido para Postgres. Eso solo lo puede decir Postgres, y es
    // justo lo que se comprueba aqui: el UPSERT con `xmax = 0`, la funcion de
    // ventana del listado y el UPDATE de baja, ejecutados de verdad.
    //
    // Usa un id de prueba imposible de confundir con un grupo real y lo borra
    // al terminar, pase lo que pase.
    const ID_PRUEBA = '999000000000000001';
    const whitelist = require('../../services/groupWhitelistService');
    const { NotFoundError } = require('../../roblox/errors');

    try {
        const alta = await whitelist.addGroup(ID_PRUEBA);
        alta.created === true && alta.active === true
            ? ok('addGroup() da de alta', `created=${alta.created} createdAt=${alta.createdAt}`)
            : fail('addGroup() da de alta', JSON.stringify(alta));

        const repetida = await whitelist.addGroup(ID_PRUEBA);
        repetida.created === false && repetida.createdAt === alta.createdAt
            ? ok('addGroup() repetido es idempotente y conserva el alta original')
            : fail('addGroup() repetido', JSON.stringify(repetida));

        const consulta = await whitelist.getGroup(ID_PRUEBA);
        whitelist.isAuthorized(consulta)
            ? ok('getGroup() lo ve autorizado')
            : fail('getGroup()', JSON.stringify(consulta));

        const listado = await whitelist.listGroups({ includeInactive: true, limit: 500, offset: 0 });
        listado.groups.some(g => g.groupId === ID_PRUEBA) && typeof listado.total === 'number'
            ? ok('listGroups() lo lista y calcula el total', `total=${listado.total}`)
            : fail('listGroups()', JSON.stringify(listado).slice(0, 200));

        const baja = await whitelist.removeGroup(ID_PRUEBA);
        baja.active === false && baja.purged === false
            ? ok('removeGroup() desactiva sin borrar')
            : fail('removeGroup() desactiva', JSON.stringify(baja));

        const trasBaja = await whitelist.getGroup(ID_PRUEBA);
        trasBaja !== null && !whitelist.isAuthorized(trasBaja)
            ? ok('tras la baja: sigue en la tabla pero ya no autorizado')
            : fail('tras la baja', JSON.stringify(trasBaja));

        const readmision = await whitelist.addGroup(ID_PRUEBA);
        readmision.active === true && readmision.createdAt === alta.createdAt
            ? ok('addGroup() readmite conservando la fecha de alta original')
            : fail('readmision', JSON.stringify(readmision));

        const purga = await whitelist.removeGroup(ID_PRUEBA, { purge: true });
        purga.purged === true
            ? ok('removeGroup({purge:true}) borra la fila')
            : fail('purga', JSON.stringify(purga));

        (await whitelist.getGroup(ID_PRUEBA)) === null
            ? ok('tras la purga no queda rastro')
            : fail('tras la purga', 'la fila sigue ahi');

        try {
            await whitelist.removeGroup(ID_PRUEBA);
            fail('dar de baja algo inexistente', 'deberia lanzar NotFoundError');
        } catch (err) {
            err instanceof NotFoundError && err.code === 'group_not_found'
                ? ok('dar de baja algo inexistente lanza group_not_found')
                : fail('dar de baja algo inexistente', err.message);
        }
    } catch (err) {
        fail('servicio de whitelist', err.message);
    } finally {
        // Red de seguridad: si algo de arriba fallo a mitad, la fila de prueba
        // no puede quedarse viviendo en la whitelist de produccion.
        try {
            await db.query('DELETE FROM group_whitelist WHERE group_id = $1', [ID_PRUEBA]);
        } catch { /* si la base ya no responde, no hay nada que limpiar */ }
    }

    console.log(`\n${fallos === 0 ? 'VERIFICACION DE POSTGRES OK' : `VERIFICACION DE POSTGRES: ${fallos} fallo(s)`}`);
    await db.close();
    process.exit(fallos === 0 ? 0 : 1);
})().catch(async err => {
    console.error('LA VERIFICACION SE ROMPIO:', err?.message);
    await db.close();
    process.exit(1);
});
