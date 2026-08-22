'use strict';

const { createSuite } = require('./harness');
const db = require('../db/pool');
const { DDL } = require('../db/schema');

// Tests de la capa de Postgres SIN red ni base de datos, como el resto de la
// suite. Lo que se puede verificar offline es justo lo que mas facil seria
// romper sin enterarse: que requerir el modulo no conecta con nada, que la
// URL con la contraseña nunca sale por ningun lado, y que el DDL es
// idempotente. La verificacion contra un Postgres real vive en
// src/tests/live/db-check.js y se lanza a mano con `npm run db:check`.

module.exports = async function run() {
    const s = createSuite('db');
    const { assert, test } = s;

    test('requerir el modulo no abre ninguna conexion', () => {
        // Si el pool se creara al cargar, esto ya habria intentado conectar y
        // los contadores no estarian a cero.
        const m = db.getMetrics();
        assert.strictEqual(m.total, 0, 'no deberia haber ninguna conexion abierta');
        assert.strictEqual(m.queries, 0, 'no deberia haberse ejecutado ninguna consulta');
    });

    test('sin DATABASE_URL, query() falla claro en vez de colgarse', async () => {
        if (db.isConfigured()) return; // hay una URL en el entorno: no aplica
        await assert.rejects(() => db.query('SELECT 1'), /DATABASE_URL/);
    });

    test('describeTarget() nunca devuelve usuario ni contraseña', () => {
        const info = db.describeTarget('postgresql://postgres:sup3r-secreta@monorail.proxy.rlwy.net:41234/railway');
        assert.deepStrictEqual(info, { host: 'monorail.proxy.rlwy.net', port: '41234', database: 'railway' });
        const serializado = JSON.stringify(info);
        assert.ok(!serializado.includes('sup3r-secreta'), 'la contraseña se ha filtrado');
        assert.ok(!serializado.includes('postgres:'), 'el usuario se ha filtrado');
    });

    test('describeTarget() aguanta una URL ilegible sin volcarla', () => {
        const info = db.describeTarget('esto no es una url :: con secreto dentro');
        assert.strictEqual(info.host, '[url-no-parseable]');
        assert.ok(!JSON.stringify(info).includes('secreto'));
    });

    test('describeTarget() sin URL devuelve null', () => {
        assert.strictEqual(db.describeTarget(null), null);
    });

    test('ssl auto: sin TLS en la red privada de Railway y en local', () => {
        assert.strictEqual(db.resolveSsl('auto', 'postgresql://u:p@postgres.railway.internal:5432/railway'), false);
        assert.strictEqual(db.resolveSsl('auto', 'postgresql://u:p@localhost:5432/railway'), false);
        assert.strictEqual(db.resolveSsl('auto', 'postgresql://u:p@127.0.0.1:5432/railway'), false);
    });

    test('ssl auto: TLS sin verificar contra el proxy publico (certificado autofirmado)', () => {
        assert.deepStrictEqual(
            db.resolveSsl('auto', 'postgresql://u:p@monorail.proxy.rlwy.net:41234/railway'),
            { rejectUnauthorized: false }
        );
    });

    test('ssl explicito manda sobre la deteccion automatica', () => {
        const interna = 'postgresql://u:p@postgres.railway.internal:5432/railway';
        assert.deepStrictEqual(db.resolveSsl('no-verify', interna), { rejectUnauthorized: false });
        assert.deepStrictEqual(db.resolveSsl('verify', interna), { rejectUnauthorized: true });
        assert.strictEqual(db.resolveSsl('disable', 'postgresql://u:p@monorail.proxy.rlwy.net:41234/railway'), false);
    });

    test('un modo de ssl invalido cae en auto en vez de romper el arranque', () => {
        const original = console.warn;
        console.warn = () => {};
        try {
            assert.strictEqual(db.resolveSsl('sí-porfa', 'postgresql://u:p@localhost:5432/railway'), false);
        } finally {
            console.warn = original;
        }
    });

    test('el DDL es idempotente y crea group_whitelist tal cual se pidio', () => {
        const whitelist = DDL.find(d => d.nombre === 'group_whitelist');
        assert.ok(whitelist, 'falta la definicion de group_whitelist');

        const sql = whitelist.sql.replace(/\s+/g, ' ').trim();
        assert.ok(/CREATE TABLE IF NOT EXISTS group_whitelist/i.test(sql), 'debe ser IF NOT EXISTS: se ejecuta en cada arranque');
        assert.ok(/group_id TEXT PRIMARY KEY/i.test(sql));
        assert.ok(/active BOOLEAN NOT NULL DEFAULT true/i.test(sql));
        assert.ok(/created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/i.test(sql));
    });

    test('ninguna sentencia del esquema interpola valores', () => {
        for (const { nombre, sql } of DDL) {
            assert.ok(!sql.includes('${'), `${nombre}: el SQL se construye con plantillas`);
            assert.ok(!sql.includes('+ '), `${nombre}: el SQL se construye concatenando`);
        }
    });

    return s.run();
};
