'use strict';

const fs = require('fs');
const { dataPath, ensureDataDir } = require('./dataDir');
const config = require('../config');

// ── Sistema de invitaciones: los datos y las reglas ──────────────────────────
//
// Cada entrada al servidor es UN registro, y todas las cifras (invitaciones de
// alguien, el top de la semana, el de siempre) se CALCULAN a partir de los
// registros. No hay contadores sueltos que puedan descuadrarse: si un miembro
// se va, se marca su registro y todas las cifras lo reflejan a la vez.
//
// Los registros viven en DATA_DIR/invitaciones.json, que en Railway es el
// volumen: sobreviven a reinicios y despliegues.
//
// Un registro tiene un ESTADO, y sólo 'valida' suma:
//
//   valida    — la cuenta pasó los filtros y sigue en el servidor
//   salio     — era válida, pero el miembro se fue: deja de sumar
//   falsa     — cuenta sospechosa (ver clasificar): nunca suma
//   repetida  — ese miembro ya había entrado antes: una persona cuenta UNA vez
//   propia    — alguien entrando con su propia invitación
//   sin_autor — entró por la URL personalizada (vanity) o no se pudo saber por
//               qué invitación: queda registrado, pero no suma a nadie

const FILE = dataPath('invitaciones.json');
const TMP  = FILE + '.tmp';

const I = config.INVITACIONES;
const DIA = 86_400_000;
const SEMANA = 7 * DIA;

function vacio() {
    return { registros: [], semana: null, historial: [], mensajeRef: null };
}

function load() {
    try {
        const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        return {
            registros: Array.isArray(d?.registros) ? d.registros : [],
            semana: typeof d?.semana === 'string' ? d.semana : null,
            historial: Array.isArray(d?.historial) ? d.historial : [],
            mensajeRef: d?.mensajeRef ?? null,
        };
    } catch {
        return vacio();
    }
}

function save(data) {
    ensureDataDir();
    fs.writeFileSync(TMP, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(TMP, FILE);
}

// ── Las semanas ──────────────────────────────────────────────────────────────
// Van de lunes 00:00 a lunes 00:00 en hora del centro de México (UTC-6 todo el
// año: México ya no cambia de horario). La clave de una semana es la fecha de
// su lunes, "2026-10-19".

const OFFSET_MS = I.UTC_OFFSET_HORAS * 3600_000;

function inicioSemana(ts) {
    const local = new Date(ts + OFFSET_MS);
    const desdeLunes = (local.getUTCDay() + 6) % 7;
    const lunesLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - desdeLunes);
    return lunesLocal - OFFSET_MS;
}

function claveSemana(ts) {
    return new Date(inicioSemana(ts) + OFFSET_MS).toISOString().slice(0, 10);
}

function rangoDeClave(clave) {
    const inicio = Date.parse(`${clave}T00:00:00Z`) - OFFSET_MS;
    return { inicio, fin: inicio + SEMANA };
}

// ── Clasificar una entrada ───────────────────────────────────────────────────
//
// Las señales de una invitación falsa, de más a menos clara:
//
//   1. Entrar con tu propia invitación.
//   2. Haber entrado antes: salir y volver a entrar no es un cliente nuevo, y
//      es el truco más fácil para inflar números.
//   3. Una cuenta de Discord recién creada (menos de MIN_DIAS_CUENTA días).
//   4. Una cuenta joven (menos de DIAS_SIN_AVATAR) que ni siquiera tiene foto.
//   5. Una ráfaga: varias cuentas jóvenes entrando por la misma persona en
//      pocos minutos. Una persona que promociona bien trae gente, pero no
//      tres cuentas de una semana en cinco minutos.
//
// Devuelve { estado, motivo }.
function clasificar(data, e) {
    if (!e.inviterId) return { estado: 'sin_autor', motivo: e.tipo === 'vanity' ? 'URL personalizada' : 'no se pudo detectar la invitación' };
    if (e.inviterId === e.memberId) return { estado: 'propia', motivo: 'usó su propia invitación' };

    if (data.registros.some(r => r.memberId === e.memberId)) {
        return { estado: 'repetida', motivo: 'ya había entrado al servidor antes' };
    }

    const edadDias = (e.ahora - e.cuentaCreada) / DIA;
    if (edadDias < I.MIN_DIAS_CUENTA) {
        const d = Math.max(0, Math.floor(edadDias));
        return { estado: 'falsa', motivo: `cuenta creada hace ${d === 0 ? 'menos de un día' : `${d} día${d === 1 ? '' : 's'}`}` };
    }
    if (edadDias < I.DIAS_SIN_AVATAR && !e.tieneAvatar) {
        return { estado: 'falsa', motivo: `cuenta de ${Math.floor(edadDias)} días y sin foto de perfil` };
    }

    if (edadDias < I.RAFAGA.DIAS_CUENTA) {
        const desde = e.ahora - I.RAFAGA.VENTANA_MIN * 60_000;
        const recientes = data.registros.filter(r =>
            r.inviterId === e.inviterId && r.joinedAt >= desde &&
            (r.joinedAt - r.cuentaCreada) / DIA < I.RAFAGA.DIAS_CUENTA
        ).length;
        if (recientes + 1 >= I.RAFAGA.CUENTAS) {
            return { estado: 'falsa', motivo: `ráfaga de cuentas nuevas (${recientes + 1} en ${I.RAFAGA.VENTANA_MIN} min)` };
        }
    }

    return { estado: 'valida', motivo: null };
}

// Registra una entrada y devuelve el registro creado.
//
//   e = { memberId, inviterId|null, tipo: 'invitacion'|'vanity'|'desconocido',
//         code|null, cuentaCreada (ms), tieneAvatar, ahora (ms) }
function registrarEntrada(e) {
    const data = load();
    const ahora = e.ahora ?? Date.now();
    const { estado, motivo } = clasificar(data, { ...e, ahora });
    const reg = {
        memberId: String(e.memberId),
        inviterId: e.inviterId ? String(e.inviterId) : null,
        tipo: e.tipo,
        code: e.code ?? null,
        joinedAt: ahora,
        cuentaCreada: e.cuentaCreada,
        estado,
        motivo,
    };
    data.registros.push(reg);
    save(data);
    return reg;
}

// Un miembro se fue: su registro válido deja de sumar. Devuelve el registro
// afectado (o null si no sumaba a nadie).
function registrarSalida(memberId, ahora = Date.now()) {
    const data = load();
    const reg = [...data.registros].reverse().find(r => r.memberId === String(memberId) && r.estado === 'valida');
    if (!reg) return null;
    reg.estado = 'salio';
    reg.salioEn = ahora;
    save(data);
    return reg;
}

// Al arrancar: quien se fue mientras el bot estaba apagado no generó evento.
// `siguenDentro` es un Set con los ids de los miembros actuales.
function reconciliarSalidas(siguenDentro, ahora = Date.now()) {
    const data = load();
    let n = 0;
    for (const r of data.registros) {
        if (r.estado === 'valida' && !siguenDentro.has(r.memberId)) {
            r.estado = 'salio';
            r.salioEn = ahora;
            n++;
        }
    }
    if (n) save(data);
    return n;
}

// ── Las cifras ───────────────────────────────────────────────────────────────

function enRango(r, rango) {
    return !rango || (r.joinedAt >= rango.inicio && r.joinedAt < rango.fin);
}

function resumenDe(userId, ahora = Date.now(), data = load()) {
    const id = String(userId);
    const rango = rangoDeClave(claveSemana(ahora));
    const mias = data.registros.filter(r => r.inviterId === id && r.estado !== 'propia');
    const cuenta = est => mias.filter(r => r.estado === est).length;
    const entrada = [...data.registros].reverse().find(r => r.memberId === id) ?? null;
    return {
        validas: cuenta('valida'),
        semana: mias.filter(r => r.estado === 'valida' && enRango(r, rango)).length,
        salieron: cuenta('salio'),
        falsas: cuenta('falsa'),
        repetidas: cuenta('repetida'),
        total: mias.length,
        puestoSemana: puesto(id, 'semana', ahora, data),
        puestoTotal: puesto(id, 'total', ahora, data),
        invitadoPor: entrada?.inviterId ?? null,
        entroPor: entrada?.tipo ?? null,
    };
}

// El top de la semana en curso ('semana'), de una semana concreta (clave), o
// de todos los tiempos ('total'). Empates: gana quien llegó antes a esa cifra
// (su última invitación válida es más antigua).
function top(periodo = 'total', ahora = Date.now(), data = load(), limite = I.TOP) {
    const rango = periodo === 'total' ? null
        : rangoDeClave(periodo === 'semana' ? claveSemana(ahora) : periodo);
    const porUsuario = new Map();
    for (const r of data.registros) {
        if (r.estado !== 'valida' || !r.inviterId || !enRango(r, rango)) continue;
        const u = porUsuario.get(r.inviterId) ?? { userId: r.inviterId, invitaciones: 0, ultima: 0 };
        u.invitaciones++;
        u.ultima = Math.max(u.ultima, r.joinedAt);
        porUsuario.set(r.inviterId, u);
    }
    return [...porUsuario.values()]
        .sort((a, b) => b.invitaciones - a.invitaciones || a.ultima - b.ultima)
        .slice(0, limite ?? Infinity);
}

function puesto(userId, periodo, ahora = Date.now(), data = load()) {
    const i = top(periodo, ahora, data, null).findIndex(u => u.userId === String(userId));
    return i < 0 ? null : i + 1;
}

// ── El cierre de la semana ───────────────────────────────────────────────────
//
// Se llama al arrancar y cada pocos minutos. Si la semana guardada ya no es la
// actual, se cierra: se apunta el ganador (con sus invitaciones de ESE momento:
// que luego se le vaya alguien no le quita una semana ya ganada) y se empieza
// la nueva. Devuelve lo cerrado, o null si no tocaba.
//
// No va con un temporizador hasta el lunes: el bot se reinicia en cada
// despliegue y un temporizador así no sobreviviría.
function cerrarSemanaSiToca(ahora = Date.now()) {
    const data = load();
    const actual = claveSemana(ahora);

    if (!data.semana) {
        data.semana = actual;
        save(data);
        return null;
    }
    if (data.semana === actual) return null;

    const cerrada = data.semana;
    const [g] = top(cerrada, ahora, data, 1);
    const entrada = {
        semana: cerrada,
        ganadorId: g?.userId ?? null,
        invitaciones: g?.invitaciones ?? 0,
        premio: I.PREMIO_ROBUX,
        cerradaEn: ahora,
    };
    data.historial.push(entrada);
    data.semana = actual;
    save(data);
    return entrada;
}

function ultimoGanador(data = load()) {
    return [...data.historial].reverse().find(h => h.ganadorId) ?? null;
}

function getMensajeRef() { return load().mensajeRef; }
function setMensajeRef(ref) { const d = load(); d.mensajeRef = ref; save(d); }

module.exports = {
    registrarEntrada, registrarSalida, reconciliarSalidas,
    resumenDe, top, puesto, cerrarSemanaSiToca, ultimoGanador,
    claveSemana, inicioSemana, rangoDeClave,
    getMensajeRef, setMensajeRef, load, I,
};
