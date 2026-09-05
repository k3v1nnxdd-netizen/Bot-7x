'use strict';

// Tipos de asset de Roblox, por ID.
//
// Hace falta una tabla porque los dos endpoints hablan distinto: el de detalle
// de outfit (avatar.roblox.com/v3) devuelve `assetType: { id, name }` — y por
// eso src/services/humanoidDescription.js puede mapear por NOMBRE sin inventar
// nada —, pero el de catalogo por lotes devuelve solo el NUMERO. Para que
// /v1/catalog/batch pueda decir "esto es una Dynamic Head" sin una llamada de
// mas, ese numero hay que traducirlo aqui.
//
// REGLA: un id que no este en esta tabla sale con `name: null`, nunca con un
// nombre adivinado. Si Roblox añade un tipo mañana, el juego recibira
// `{ id: 99, name: null }` y podra decidir; lo que no recibira es una etiqueta
// inventada por nosotros que parezca cierta.
//
// Confirmados EN VIVO contra catalog/v1/catalog/items/details mientras se
// construia esto: 29 (LeftArm), 30 (LeftLeg), 78 (MoodAnimation), 79
// (DynamicHead). El resto es el enum publico de Roblox.
const ASSET_TYPES = Object.freeze({
    2: 'TShirt',
    8: 'Hat',
    11: 'Shirt',
    12: 'Pants',
    17: 'Head',
    18: 'Face',
    19: 'Gear',
    27: 'Torso',
    28: 'RightArm',
    29: 'LeftArm',
    30: 'LeftLeg',
    31: 'RightLeg',
    41: 'HairAccessory',
    42: 'FaceAccessory',
    43: 'NeckAccessory',
    44: 'ShoulderAccessory',
    45: 'FrontAccessory',
    46: 'BackAccessory',
    47: 'WaistAccessory',
    48: 'ClimbAnimation',
    49: 'DeathAnimation',
    50: 'FallAnimation',
    51: 'IdleAnimation',
    52: 'JumpAnimation',
    53: 'RunAnimation',
    54: 'SwimAnimation',
    55: 'WalkAnimation',
    56: 'PoseAnimation',
    61: 'EmoteAnimation',
    64: 'TShirtAccessory',
    65: 'ShirtAccessory',
    66: 'PantsAccessory',
    67: 'JacketAccessory',
    68: 'SweaterAccessory',
    69: 'ShortsAccessory',
    70: 'LeftShoeAccessory',
    71: 'RightShoeAccessory',
    72: 'DressSkirtAccessory',
    76: 'EyebrowAccessory',
    77: 'EyelashAccessory',
    78: 'MoodAnimation',
    79: 'DynamicHead',
});

// Partes del cuerpo. Son las que pueden venir de un bundle de tipo BodyParts
// (Korblox, Headless, "Man", "Woman"...).
const BODY_PART_TYPES = new Set([27, 28, 29, 30, 31]);

// LOS UNICOS TIPOS A LOS QUE SE LES HACE BUSQUEDA INVERSA DE BUNDLE.
//
// Es la optimizacion que hace viable todo esto: catalog/v1/assets/{id}/bundles
// es el UNICO endpoint sin lote, una llamada por asset. Lanzarlo para los ~20
// assets de un outfit seria absurdo; lanzarlo solo para los que de verdad
// pueden venir en un bundle (partes del cuerpo, cabezas dinamicas y sus
// animaciones de humor) lo deja en 1-3 llamadas en un outfit tipico.
//
// Un sombrero o una camisa jamas se compran por bundle, asi que preguntarlo
// solo gastaria cuota.
const BUNDLE_BACKED_TYPES = new Set([...BODY_PART_TYPES, 78, 79]);

// ACCESORIOS REALES, para la regla "un outfit candidato lleva mas de tres
// accesorios". Es lo que decide, con la respuesta del avatar en la mano y
// ANTES de gastar una sola llamada de catalogo, si un candidato merece que se
// le ponga precio.
//
// Entran: sombreros (8), los siete accesorios clasicos (41-47), la ropa por
// capas (64-72: camisetas, camisas, pantalones, chaquetas, sueteres, shorts,
// zapatos, faldas) y cejas/pestañas (76-77). Todos son "*Accessory" en el
// enum de Roblox: piezas 3D que se llevan puestas.
//
// NO entran, y la lista importa tanto como la de arriba: ropa clasica (2, 11,
// 12: son texturas, no accesorios), cabeza y cara (17, 18), partes del cuerpo
// (27-31), gear (19), animaciones y emotes (48-61), humor (78) y cabezas
// dinamicas (79). Un tipo desconocido tampoco cuenta: no se adivina.
const ACCESSORY_TYPES = new Set([
    8,
    41, 42, 43, 44, 45, 46, 47,
    64, 65, 66, 67, 68, 69, 70, 71, 72,
    76, 77,
]);

function isAccessory(id) {
    return ACCESSORY_TYPES.has(Number(id));
}

// Cuenta accesorios DISTINTOS entre los assets de un avatar. Se cuenta por id
// de asset, no por entrada: un avatar puede repetir un asset (capas) y contarlo
// dos veces inflaria el recuento igual que inflaria el precio.
function countAccessories(assets) {
    const vistos = new Set();
    for (const asset of assets ?? []) {
        if (!asset || asset.id == null) continue;
        if (!isAccessory(asset.assetTypeId)) continue;
        vistos.add(String(asset.id));
    }
    return vistos.size;
}

function assetTypeName(id) {
    return ASSET_TYPES[id] ?? null;
}

function describeAssetType(id) {
    if (id === null || id === undefined) return { id: null, name: null };
    return { id, name: assetTypeName(id) };
}

function isBundleBacked(id) {
    return BUNDLE_BACKED_TYPES.has(id);
}

function isBodyPart(id) {
    return BODY_PART_TYPES.has(id);
}

module.exports = {
    ASSET_TYPES,
    BODY_PART_TYPES,
    BUNDLE_BACKED_TYPES,
    ACCESSORY_TYPES,
    assetTypeName,
    describeAssetType,
    isBundleBacked,
    isBodyPart,
    isAccessory,
    countAccessories,
};
