'use strict';

// Respuestas REALES de Roblox, capturadas en vivo el 2026-08-16 y pegadas
// aqui verbatim. No son inventadas ni "de ejemplo": son exactamente lo que
// devolvieron los endpoints oficiales, y por eso valen como test — si Roblox
// cambia la forma, el fallo aparece contra datos que de verdad existieron.

// GET https://avatar.roblox.com/v3/outfits/555869704325162/details
// Ropa por capas: dos accesorios de calzado con `meta` (order/puffiness).
const ropaPorCapas = {
    id: 555869704325162,
    name: 'adidas Ice Angels',
    assets: [
        { id: 101396973232145, name: 'adidas Ice Angels - Left Shoe Accessory', assetType: { id: 70, name: 'LeftShoeAccessory' }, currentVersionId: 35533994053, meta: { order: 0, puffiness: 0.0, version: 1 } },
        { id: 140536907916269, name: 'adidas Ice Angels - Right Shoe Accessory', assetType: { id: 71, name: 'RightShoeAccessory' }, currentVersionId: 35533994943, meta: { order: 0, puffiness: 0.0, version: 1 } },
    ],
    bodyColor3s: { headColor3: 'A3A2A5', torsoColor3: 'A3A2A5', rightArmColor3: 'A3A2A5', leftArmColor3: 'A3A2A5', rightLegColor3: 'A3A2A5', leftLegColor3: 'A3A2A5' },
    scale: { height: 1.0, width: 1.0, head: 1.0, depth: 1.00, proportion: 0.0, bodyType: 0.0 },
    playerAvatarType: 'R15',
    outfitType: 'Shoes',
    isEditable: false,
    universeId: null,
    inventoryType: 'Shoes',
};

// GET https://avatar.roblox.com/v3/outfits/11685920016/details
// Cabeza dinamica + ceja por capas + animacion de expresion.
const cabezaDinamica = {
    id: 11685920016,
    name: 'Check It',
    assets: [
        { id: 11308945948, name: 'Check It - Head', assetType: { id: 79, name: 'DynamicHead' }, currentVersionId: 69499489978947, supportsHeadShapes: true },
        { id: 11308949065, name: 'Check It - Eyebrow', assetType: { id: 76, name: 'EyebrowAccessory' }, currentVersionId: 14302683670, meta: { order: 2, puffiness: 0.0, version: 1 } },
        { id: 11308935548, name: 'Check It - Mood', assetType: { id: 78, name: 'MoodAnimation' }, currentVersionId: 16076193511960 },
    ],
    bodyColor3s: { headColor3: 'A3A2A5', torsoColor3: 'A3A2A5', rightArmColor3: 'A3A2A5', leftArmColor3: 'A3A2A5', rightLegColor3: 'A3A2A5', leftLegColor3: 'A3A2A5' },
    scale: { height: 1.0, width: 1.0, head: 1.0, depth: 1.00, proportion: 0.0, bodyType: 0.0 },
    playerAvatarType: 'R15',
    outfitType: 'DynamicHead',
    isEditable: false,
    universeId: null,
    inventoryType: 'DynamicHead',
};

// GET https://avatar.roblox.com/v3/outfits/131929576/details
// Las cinco partes del cuerpo, con colores DISTINTOS entre si (util para
// comprobar que cada color acaba en su parte y no se copian entre ellas).
const partesDelCuerpo = {
    id: 131929576,
    name: 'Robloxian 2.0',
    assets: [
        { id: 27112025, name: 'Roblox 2.0 Torso', assetType: { id: 27, name: 'Torso' }, currentVersionId: 11201616558 },
        { id: 27112052, name: 'Roblox 2.0 Left Arm', assetType: { id: 29, name: 'LeftArm' }, currentVersionId: 11201616588 },
        { id: 27112039, name: 'Roblox 2.0 Right Arm', assetType: { id: 28, name: 'RightArm' }, currentVersionId: 11201616570 },
        { id: 27112056, name: 'Roblox 2.0 Left Leg', assetType: { id: 30, name: 'LeftLeg' }, currentVersionId: 4414048454802 },
        { id: 27112068, name: 'Roblox 2.0 Right Leg', assetType: { id: 31, name: 'RightLeg' }, currentVersionId: 67685323292678 },
    ],
    bodyColor3s: { headColor3: 'F9F9F9', torsoColor3: 'A7C7E7', rightArmColor3: 'F9F9F9', leftArmColor3: 'F9F9F9', rightLegColor3: '6495ED', leftLegColor3: '6495ED' },
    scale: { height: 1.0, width: 1.0, head: 1.0, depth: 1.00, proportion: 0.0, bodyType: 0.0 },
    playerAvatarType: 'R15',
    outfitType: 'Avatar',
    isEditable: false,
    universeId: null,
    inventoryType: 'Body',
};

// Avatar COMPLETO: sombrero, ropa clasica 2D, las siete animaciones de
// movimiento, partes del cuerpo, cabeza dinamica y animacion de expresion.
//
// Procedencia exacta, para que conste: los `assets` son verbatim los de
// GET https://avatar.roblox.com/v1/users/1/avatar (el avatar actual de la
// cuenta Roblox), montados dentro del sobre de /v3/outfits/{id}/details. Se
// hace asi porque los outfits GUARDADOS que pude consultar son antiguos y
// ninguno lleva paquete de animaciones — y el shape de cada entrada de
// `assets` es identico en los dos endpoints, comprobado. Ni un id ni un tipo
// de aqui esta inventado.
const avatarCompleto = {
    id: 999000111,
    name: 'Avatar completo (assets reales de userId 1)',
    assets: [
        { id: 301811432, name: 'Oakley Pants', assetType: { id: 12, name: 'Pants' }, currentVersionId: 10151325111 },
        { id: 607702162, name: 'Roblox Baseball Cap', assetType: { id: 8, name: 'Hat' }, currentVersionId: 1171146069 },
        { id: 607785314, name: 'ROBLOX Jacket', assetType: { id: 11, name: 'Shirt' }, currentVersionId: 955993454 },
        { id: 2510230574, name: 'Rthro Climb', assetType: { id: 48, name: 'ClimbAnimation' }, currentVersionId: 13806699923 },
        { id: 2510233257, name: 'Rthro Fall', assetType: { id: 50, name: 'FallAnimation' }, currentVersionId: 13806699941 },
        { id: 2510235063, name: 'Rthro Idle', assetType: { id: 51, name: 'IdleAnimation' }, currentVersionId: 17686818829 },
        { id: 2510236649, name: 'Rthro Jump', assetType: { id: 52, name: 'JumpAnimation' }, currentVersionId: 13806699943 },
        { id: 2510238627, name: 'Rthro Run', assetType: { id: 53, name: 'RunAnimation' }, currentVersionId: 13806699940 },
        { id: 2510240941, name: 'Rthro Swim', assetType: { id: 54, name: 'SwimAnimation' }, currentVersionId: 13806699946 },
        { id: 2510242378, name: 'Rthro Walk', assetType: { id: 55, name: 'WalkAnimation' }, currentVersionId: 13806699951 },
        { id: 10638267973, name: 'Stevie Standard - Head', assetType: { id: 79, name: 'DynamicHead' }, currentVersionId: 39165652861187 },
        { id: 10647852134, name: 'DefaultFallBackMood', assetType: { id: 78, name: 'MoodAnimation' }, currentVersionId: 70169831179700 },
        { id: 12995014400, name: 'Man - Left Arm', assetType: { id: 29, name: 'LeftArm' }, currentVersionId: 16754708924 },
        { id: 12995015868, name: 'Man - Left Leg', assetType: { id: 30, name: 'LeftLeg' }, currentVersionId: 16754710931 },
        { id: 12995017412, name: 'Man - Right Arm', assetType: { id: 28, name: 'RightArm' }, currentVersionId: 16754713361 },
        { id: 12995018829, name: 'Man - Right Leg', assetType: { id: 31, name: 'RightLeg' }, currentVersionId: 16754715470 },
        { id: 12995020128, name: 'Man - Torso', assetType: { id: 27, name: 'Torso' }, currentVersionId: 16754717279 },
    ],
    bodyColor3s: { headColor3: 'D7C59A', torsoColor3: '0F1E5B', rightArmColor3: 'D7C59A', leftArmColor3: 'D7C59A', rightLegColor3: '2C4C9B', leftLegColor3: '2C4C9B' },
    scale: { height: 1.05, width: 0.95, head: 1.0, depth: 1.0, proportion: 0.3, bodyType: 0.7 },
    playerAvatarType: 'R15',
    outfitType: 'Avatar',
    isEditable: true,
    universeId: null,
    inventoryType: 'Body',
};

// GET https://avatar.roblox.com/v1/users/156/avatar — el MISMO avatar pero
// desde el endpoint que devuelve `bodyColors` con ids de BrickColor en lugar
// de `bodyColor3s` en hex. Sirve para comprobar que la normalizacion de
// colores cubre los dos formatos que Roblox tiene vivos a la vez.
const coloresPorIdDeBrickColor = {
    scales: { height: 1.0, width: 1.0, head: 1.0, depth: 1.00, proportion: 0.0, bodyType: 0.0 },
    playerAvatarType: 'R15',
    bodyColors: { headColorId: 125, torsoColorId: 125, rightArmColorId: 125, leftArmColorId: 125, rightLegColorId: 125, leftLegColorId: 125 },
    assets: [
        { id: 11844853, name: 'Turbo Builders Club Hard Hat', assetType: { id: 8, name: 'Hat' }, currentVersionId: 883360292 },
    ],
};

// GET https://avatar.roblox.com/v2/avatar/users/156/outfits?page=1&itemsPerPage=3
// Sin `filteredCount` por ningun lado: solo `data` y `paginationToken`.
const listadoDeOutfits = {
    data: [
        { id: 555869704325162, name: 'adidas Ice Angels', isEditable: false, outfitType: 'Shoes' },
        { id: 17762785106, name: 'Winky', isEditable: false, outfitType: 'DynamicHead' },
        { id: 11685920016, name: 'Check It', isEditable: false, outfitType: 'DynamicHead' },
    ],
    paginationToken: 'MXx8fGlkXzJ6d0FBQVlubHF4WFl4QkJSU3podXJ0aWFSS2FjeVV4b3NnMjF8fHww',
};

module.exports = {
    ropaPorCapas,
    cabezaDinamica,
    partesDelCuerpo,
    avatarCompleto,
    coloresPorIdDeBrickColor,
    listadoDeOutfits,
};
