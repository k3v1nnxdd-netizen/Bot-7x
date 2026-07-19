'use strict';

// Terms indicating trading/buying/selling activity that should only happen
// through the official owners — used to catch off-platform scam attempts.
const TERMS = [
    'trade', 'trades', 'trading', 'trader', 'tradear', 'tradeo',
    'intercambio', 'intercambiar', 'intercambios', 'swap', 'exchange', 'barter',
    'permuta', 'permutar', 'canje', 'canjear', 'cambiar', 'cambio', 'cambias',

    'vendo', 'vender', 'venta', 'ventas', 'vendiendo', 'compro', 'comprar',
    'compra', 'compras', 'comprando', 'comprador', 'compradores', 'vendedor',
    'vendedores', 'buyer', 'buyers', 'buying', 'buy', 'seller', 'sellers',
    'selling', 'sell',

    'wts', 'wtb', 'offer', 'offers', 'offering', 'oferta', 'ofertas', 'ofertar',
    'negocio', 'negociar', 'negociacion', 'deal', 'deals',

    'vendo por', 'busco comprador', 'busco vendedor', 'quien compra',
    'quien vende', 'alguien compra', 'alguien vende', 'quiero vender',
    'quiero comprar', 'deseo vender', 'deseo comprar', 'se vende', 'se compra',
    'en venta', 'en venta por', 'for sale', 'looking to buy', 'looking to sell',
    'looking for offers', 'lf offers', 'accepting offers', 'best offer',
    'taking offers',

    'dm me', 'dm for', 'dm para', 'md para', 'inbox', 'privado',
    'mensaje privado', 'mp', 'pvt', 'pv', 'escribeme al privado',
    'hablame al privado',
];

// Leetspeak / lookalike substitutions (v3nta -> venta, c0mpro -> compro, ...).
// Applied before matching so both digit and symbol obfuscation get caught.
const LEET_MAP = {
    '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b',
    '@': 'a', '$': 's', '!': 'i', '+': 't', '|': 'l',
};

function stripAccents(str) {
    return str.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

function applyLeet(str) {
    let out = '';
    for (const ch of str) out += LEET_MAP[ch] ?? ch;
    return out;
}

// Lowercase + de-accent + de-leet — the shared base every check runs on.
function normalize(content) {
    return applyLeet(stripAccents(content.toLowerCase()));
}

function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const NORMALIZED_TERMS = TERMS.map(t => normalize(t));

// ── Stage A: whole-word / whole-phrase match on the normalized message ───────
// Catches plain usage plus single-token obfuscation (v3nta, c0mpro, vend0).

const WORD_PATTERN = new RegExp(
    `\\b(?:${NORMALIZED_TERMS.map(escapeRegExp).join('|')})\\b`,
    'i'
);

// ── Stage B: space/punctuation-stripped match for split-word evasion ─────────
// Catches fragments deliberately broken up with spaces/dots/dashes
// ("com pro", "vend 0" -> "vendo", "v-e-n-t-a"). Restricted to single-word,
// 5+ character terms only, to keep the odds of two unrelated words
// accidentally concatenating into a false match negligible.
const LONG_SINGLE_WORD_TERMS = TERMS
    .filter(t => !t.includes(' '))
    .map(normalize)
    .filter(t => t.length >= 5);

function containsScamTerm(content) {
    if (!content) return false;

    const normalized = normalize(content);
    if (WORD_PATTERN.test(normalized)) return true;

    const collapsed = normalized.replace(/[^a-z0-9]+/g, '');
    return LONG_SINGLE_WORD_TERMS.some(term => collapsed.includes(term));
}

module.exports = { containsScamTerm };
