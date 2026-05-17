'use strict';

// Strict list of patterns that unambiguously mean "I paid".
// Strip accents + non-alphanumeric before matching.
const PATTERNS = [
    'pagoexitoso',
    'pagorealizado',
    'pagohecho',
    'pagocompletado',
    'pagoenviado',
    'pagoconfirmado',
    'yapague',
    'yahicelpago',
    'yahiceelpago',
    'yahepagado',
    'hepagado',
    'pagado',
];

function normalize(text) {
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]/g, '');
}

function isPaymentConfirmation(text) {
    if (!text || typeof text !== 'string') return false;
    const clean = normalize(text);
    if (!clean) return false;
    return PATTERNS.some(p => clean.includes(p));
}

module.exports = { isPaymentConfirmation };
