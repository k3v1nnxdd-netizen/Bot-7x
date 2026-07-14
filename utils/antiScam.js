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

function stripAccents(str) {
    return str.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SCAM_PATTERN = new RegExp(
    `\\b(?:${TERMS.map(t => escapeRegExp(stripAccents(t.toLowerCase()))).join('|')})\\b`,
    'i'
);

function containsScamTerm(content) {
    if (!content) return false;
    return SCAM_PATTERN.test(stripAccents(content.toLowerCase()));
}

module.exports = { containsScamTerm };
