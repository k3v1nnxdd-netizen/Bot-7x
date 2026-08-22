'use strict';

const db = require('./pool');
const config = require('../config');
const logger = require('../observability/logger');

// Esquema de la base, aplicado en cada arranque. No hay herramienta de
// migraciones ni la hace falta todavia: el conjunto es una tabla y el DDL es
// idempotente, asi que ejecutarlo siempre es mas simple — y mas dificil de
// olvidar — que mantener un historial de migraciones para un unico CREATE.
//
// Cuando el sistema de licencias crezca, la regla para seguir aqui es que
// cada sentencia debe poder ejecutarse mil veces seguidas sin cambiar nada:
// CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, ADD COLUMN IF NOT
// EXISTS. El dia que haga falta algo que no sea idempotente, ese es el dia de
// meter una herramienta de migraciones de verdad.

// Whitelist de grupos con licencia. `group_id` es TEXT y no BIGINT a
// proposito: los ids de grupo de Roblox llegan como cadena desde HTTP y desde
// Discord, y JavaScript no representa enteros grandes sin perder precision.
// Guardar el identificador tal cual llega elimina toda una clase de bugs de
// conversion, y contra una clave primaria TEXT se busca igual de rapido.
const DDL = [
    {
        nombre: 'group_whitelist',
        sql: `
            CREATE TABLE IF NOT EXISTS group_whitelist (
                group_id TEXT PRIMARY KEY,
                active BOOLEAN NOT NULL DEFAULT true,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `,

        // Datos de la licencia (quien la compro, quien la dio de alta, cuando
        // se enlazo por ultima vez). Van como ALTER y NO dentro del CREATE de
        // arriba porque la tabla ya existe en produccion: una base ya creada
        // no vuelve a ejecutar el CREATE nunca, asi que ampliarlo ahi solo
        // serviria para una instalacion nueva y dejaria a la real sin las
        // columnas. Con ADD COLUMN IF NOT EXISTS las licencias existentes se
        // conservan intactas y la ampliacion se puede repetir mil veces.
        //
        // Todas son NULLABLE a proposito. Las licencias dadas de alta antes de
        // este cambio no tienen comprador ni administrador asociados, y un NOT
        // NULL con relleno inventado convertiria "no se sabe" en un dato
        // falso. NULL significa exactamente lo que paso: se autorizo antes de
        // que se guardara esta informacion.
        //
        // Todo TEXT, incluidos los ids de Discord, por la misma razon que
        // group_id: son enteros de 64 bits que JavaScript no representa sin
        // perder precision, y guardarlos tal como llegan elimina de raiz una
        // familia entera de bugs de conversion.
        columnas: [
            'ALTER TABLE group_whitelist ADD COLUMN IF NOT EXISTS discord_user_id TEXT',
            'ALTER TABLE group_whitelist ADD COLUMN IF NOT EXISTS roblox_username TEXT',
            'ALTER TABLE group_whitelist ADD COLUMN IF NOT EXISTS group_name TEXT',
            'ALTER TABLE group_whitelist ADD COLUMN IF NOT EXISTS added_by TEXT',

            // Fecha del ULTIMO enlace o reactivacion, distinta de created_at
            // (el alta original, que nunca se reescribe). Las dos hacen falta:
            // una responde "desde cuando es cliente" y la otra "desde cuando
            // esta vigente esta licencia".
            'ALTER TABLE group_whitelist ADD COLUMN IF NOT EXISTS linked_at TIMESTAMPTZ',

            // Rastro de la baja, para poder responder "¿por que se le retiro?"
            // meses despues sin depender de que alguien recuerde el ticket.
            'ALTER TABLE group_whitelist ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ',
            'ALTER TABLE group_whitelist ADD COLUMN IF NOT EXISTS deactivated_by TEXT',
            'ALTER TABLE group_whitelist ADD COLUMN IF NOT EXISTS deactivation_reason TEXT',

            // Relleno idempotente para las filas anteriores a la columna: su
            // enlace real fue su alta. Sin esto quedarian con linked_at NULL y
            // el panel tendria que inventarse una fecha. El WHERE lo hace
            // no-op a partir de la segunda pasada, asi que puede ejecutarse en
            // cada arranque como el resto del esquema.
            'UPDATE group_whitelist SET linked_at = created_at WHERE linked_at IS NULL',
        ],
    },
];

// Postgres tiene una carrera conocida en CREATE TABLE IF NOT EXISTS: dos
// conexiones que lo ejecutan a la vez pueden pasar las dos la comprobacion de
// existencia y chocar al insertar en el catalogo. Railway arranca la instancia
// nueva ANTES de apagar la vieja en cada redeploy, asi que este solape es
// exactamente nuestro caso. Los dos codigos significan "otro llego primero",
// que es justo el resultado que buscabamos.
const YA_EXISTE = new Set([
    '23505', // unique_violation en un indice del catalogo
    '42P07', // duplicate_table
    '42701', // duplicate_column: el mismo solape, pero en un ADD COLUMN
]);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Estado del ultimo intento, para exponerlo en /v1/metrics y poder responder
// desde fuera del proceso a "el esquema esta aplicado?" sin abrir un psql.
const state = { ready: false, lastError: null };

// Comprobacion de existencia PARAMETRIZADA. to_regclass devuelve el oid de la
// relacion o NULL si no existe, sin lanzar error — que es justo lo que se
// quiere para preguntar "existe?" sin tener que capturar nada.
async function tableExists(nombre) {
    const { rows } = await db.query('SELECT to_regclass($1) AS oid', [nombre]);
    return rows[0]?.oid !== null && rows[0]?.oid !== undefined;
}

// Aplica el esquema. NUNCA lanza: devuelve un informe.
//
// Que no lance es una decision, no un descuido. Este servicio ya estaba en
// produccion sirviendo outfits sin base de datos ninguna, y esa parte no
// depende de Postgres. Si la base tarda en levantar tras un redeploy o el
// proxy esta teniendo un mal rato, tumbar el proceso convertiria un problema
// de licencias en una caida total de la API de outfits — y en un bucle de
// reinicios con el healthcheck de Railway. Se registra el fallo, se sigue
// sirviendo, y `ready` queda en false para que se vea en /v1/metrics.
async function ensureSchema() {
    if (!db.isConfigured()) {
        logger.warn('DATABASE_URL no definida — se omite la creacion del esquema', {
            impacto: 'la API de outfits funciona igual; el sistema de licencias queda inactivo',
        });
        return { ready: false, skipped: true, reason: 'no_database_url', tables: [] };
    }

    const maxIntentos = Math.max(1, config.database.schemaMaxRetries);

    for (let intento = 1; intento <= maxIntentos; intento++) {
        try {
            const tables = [];

            for (const { nombre, sql, columnas = [] } of DDL) {
                // Se mira ANTES para poder distinguir en el log "la acabo de
                // crear" de "ya estaba": lo primero deberia verse una unica
                // vez en la vida del proyecto, y lo segundo en cada arranque.
                // CREATE TABLE IF NOT EXISTS devuelve lo mismo en ambos casos.
                const existiaAntes = await tableExists(nombre);

                try {
                    await db.query(sql);
                } catch (err) {
                    if (!YA_EXISTE.has(err?.code)) throw err;
                    logger.info('Otra instancia creo la tabla a la vez', { tabla: nombre, code: err.code });
                }

                // Verificacion real contra el catalogo: no se da por buena la
                // ausencia de excepcion, se comprueba que la tabla esta.
                const existeAhora = await tableExists(nombre);
                if (!existeAhora) {
                    throw new Error(`la tabla ${nombre} sigue sin existir despues del CREATE`);
                }

                // Ampliaciones idempotentes de la tabla, DESPUES de garantizar
                // que existe. Misma tolerancia que el CREATE: en un redeploy
                // de Railway conviven dos instancias unos segundos y pueden
                // ejecutar el mismo ADD COLUMN a la vez; que otra llegara
                // primero es exactamente el resultado que se buscaba.
                for (const alteracion of columnas) {
                    try {
                        await db.query(alteracion);
                    } catch (err) {
                        if (!YA_EXISTE.has(err?.code)) throw err;
                        logger.info('Otra instancia aplico la misma ampliacion a la vez', {
                            tabla: nombre,
                            code: err.code,
                        });
                    }
                }

                tables.push({ nombre, creada: !existiaAntes, ampliaciones: columnas.length });
            }

            const creadas = tables.filter(t => t.creada).map(t => t.nombre);
            logger.info('Esquema de Postgres listo', {
                tablas: tables.map(t => t.nombre).join(','),
                creadasAhora: creadas.length ? creadas.join(',') : 'ninguna (ya existian)',
                intento,
            });

            state.ready = true;
            state.lastError = null;
            return { ready: true, skipped: false, tables };
        } catch (err) {
            const ultimo = intento === maxIntentos;
            state.ready = false;
            state.lastError = err?.code ?? err?.message ?? 'error_desconocido';

            logger.error('Fallo aplicando el esquema de Postgres', {
                intento,
                de: maxIntentos,
                code: err?.code ?? null,
                detail: err?.message,
                siguiente: ultimo ? 'se abandona' : 'se reintenta',
            });

            if (ultimo) {
                return { ready: false, skipped: false, reason: err?.code ?? 'error', tables: [] };
            }

            // Backoff exponencial acotado. Tras un redeploy la base puede
            // tardar unos segundos en aceptar conexiones; reintentar un par
            // de veces evita quedarse sin esquema por unos segundos de mas.
            await sleep(Math.min(500 * 2 ** (intento - 1), 5_000));
        }
    }

    return { ready: false, skipped: false, reason: 'sin_intentos', tables: [] };
}

function getStatus() {
    return { schemaReady: state.ready, lastSchemaError: state.lastError };
}

module.exports = { ensureSchema, getStatus, tableExists, DDL };
