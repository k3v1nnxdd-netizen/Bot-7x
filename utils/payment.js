'use strict';

const LEET = new Map([
    ['0', 'o'],
    ['1', 'i'],
    ['3', 'e'],
    ['4', 'a'],
    ['5', 's'],
    ['7', 't'],
]);

function normalize(text) {
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[013457]/g, n => LEET.get(n) ?? n);
}

function lettersOnly(text) {
    return normalize(text).replace(/[^a-z]/g, '');
}

function hasInOrder(source, target, from = 0) {
    let pos = from;
    for (const char of target) {
        pos = source.indexOf(char, pos);
        if (pos === -1) return -1;
        pos++;
    }
    return pos;
}

function isPaymentConfirmation(text) {
    if (!text || typeof text !== 'string') return false;

    const clean = lettersOnly(text);
    if (!clean) return false;

    const pagoEnd = hasInOrder(clean, 'pago');
    if (pagoEnd === -1) return false;

    return hasInOrder(clean, 'exitoso', pagoEnd) !== -1;
}

module.exports = { isPaymentConfirmation };
