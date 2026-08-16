'use strict';

// Normaliza la respuesta de avatar.roblox.com/v3/outfits/{id}/details a una
// forma con la que Roblox Studio puede construir un HumanoidDescription
// directamente, sin consultar nada mas y sin agrupar nada por su cuenta.
//
// CERO LLAMADAS EXTRA. Verificado en vivo contra 9 outfits reales: TODO lo que
// hace falta para reconstruir un avatar ya viene en esa unica respuesta —
// escalas, colores, tipo de avatar y un array `assets` uniforme donde
// conviven sombreros, pelo, caras, ropa clasica 2D, ropa por capas 3D, partes
// del cuerpo, cabezas dinamicas, animaciones y emotes. Esto es puro mapeo en
// memoria sobre datos que ya tenemos.
//
// SE MAPEA POR NOMBRE, NO POR ID. Roblox devuelve `assetType: {id, name}` en
// cada asset, y esos nombres ("HairAccessory", "ClimbAnimation", ...) coinciden
// casi literalmente con las propiedades de HumanoidDescription. Usar el nombre
// que da Roblox en vez de una tabla de ids nuestra significa que aqui no hay
// ni un solo valor inventado: si Roblox dice que el tipo 48 se llama
// "ClimbAnimation", eso es lo que se usa. El id se conserva igualmente en la
// salida para quien lo prefiera.
//
// NADA SE PIERDE. Un tipo de asset que Roblox añada mañana y que no encaje en
// ninguna categoria conocida no se descarta: cae en `other[]` con su id y su
// nombre. Preferible un campo que el juego aun no sabe leer a un dato que
// desaparecio sin avisar.

// HumanoidDescription.Head / .Torso / .LeftArm / ...
const BODY_PARTS = {
    Head: 'head',
    Torso: 'torso',
    LeftArm: 'leftArm',
    RightArm: 'rightArm',
    LeftLeg: 'leftLeg',
    RightLeg: 'rightLeg',
};

// Ropa clasica 2D (texturas planas, no accesorios con geometria).
const CLOTHING = {
    Shirt: 'shirt',
    Pants: 'pants',
    TShirt: 'graphicTShirt', // HumanoidDescription.GraphicTShirt
};

// Accesorios clasicos rigidos. OJO con la diferencia que Roblox mantiene y que
// es facil de confundir: `Face` (id 18) es la cara 2D clasica y va a
// HumanoidDescription.Face, mientras que `FaceAccessory` (id 42) es un
// accesorio 3D que se lleva EN la cara (gafas, mascaras) y va al grupo de
// accesorios. Son cosas distintas y aqui van a sitios distintos.
const CLASSIC_ACCESSORIES = {
    Hat: 'hat',
    HairAccessory: 'hair',
    FaceAccessory: 'face',
    NeckAccessory: 'neck',
    ShoulderAccessory: 'shoulder',
    FrontAccessory: 'front',
    BackAccessory: 'back',
    WaistAccessory: 'waist',
};

// Confirmadas en vivo en avatar.roblox.com: ClimbAnimation(48), FallAnimation(50),
// IdleAnimation(51), JumpAnimation(52), RunAnimation(53), SwimAnimation(54),
// WalkAnimation(55), MoodAnimation(78). Death y Pose se mapean por el mismo
// criterio de nombre; si Roblox nunca los envia, el campo queda simplemente
// en null, que es la verdad.
const ANIMATIONS = {
    ClimbAnimation: 'climb',
    DeathAnimation: 'death',
    FallAnimation: 'fall',
    IdleAnimation: 'idle',
    JumpAnimation: 'jump',
    RunAnimation: 'run',
    SwimAnimation: 'swim',
    WalkAnimation: 'walk',
    PoseAnimation: 'pose',
    MoodAnimation: 'mood',
};

function emptyAccessories() {
    return { hat: [], hair: [], face: [], neck: [], shoulder: [], front: [], back: [], waist: [] };
}

function emptyAnimations() {
    return { climb: null, death: null, fall: null, idle: null, jump: null, run: null, swim: null, walk: null, pose: null, mood: null };
}

// Roblox ha ido cambiando como expone los colores: las respuestas de outfits
// traen `bodyColor3s` (hex, confirmado sin el '#' — "A3A2A5") y las antiguas
// `bodyColors` (ids de BrickColor, p. ej. 125). Se normalizan las dos a las
// mismas seis claves y un campo aparte dice como leerlas, para que el juego no
// tenga que adivinar el formato ni se rompa si Roblox retira uno.
// En Lua: Color3.fromHex(hex) para "hex", BrickColor.new(id).Color para "brickColorId".
function normalizeBodyColors(raw) {
    const hex = raw?.bodyColor3s;
    if (hex && typeof hex === 'object') {
        return {
            format: 'hex',
            colors: {
                head: hex.headColor3 ?? null,
                torso: hex.torsoColor3 ?? null,
                leftArm: hex.leftArmColor3 ?? null,
                rightArm: hex.rightArmColor3 ?? null,
                leftLeg: hex.leftLegColor3 ?? null,
                rightLeg: hex.rightLegColor3 ?? null,
            },
        };
    }

    const ids = raw?.bodyColors;
    if (ids && typeof ids === 'object') {
        return {
            format: 'brickColorId',
            colors: {
                head: ids.headColorId ?? null,
                torso: ids.torsoColorId ?? null,
                leftArm: ids.leftArmColorId ?? null,
                rightArm: ids.rightArmColorId ?? null,
                leftLeg: ids.leftLegColorId ?? null,
                rightLeg: ids.rightLegColorId ?? null,
            },
        };
    }

    return { format: null, colors: null };
}

// Las seis escalas de HumanoidDescription. Se copian una a una en vez de
// reenviar el objeto de Roblox tal cual para que la forma sea siempre la
// misma: si Roblox omitiera una, el campo existe y vale null en lugar de
// desaparecer y obligar al juego a comprobar su presencia.
function normalizeScale(raw) {
    const scale = raw?.scale;
    if (!scale || typeof scale !== 'object') return null;
    return {
        height: scale.height ?? null,
        width: scale.width ?? null,
        depth: scale.depth ?? null,
        head: scale.head ?? null,
        proportion: scale.proportion ?? null,
        bodyType: scale.bodyType ?? null,
    };
}

// Un asset pertenece a la ropa por capas si Roblox le adjunta `meta`. Es la
// propia señal de Roblox (order/puffiness son los parametros de capa), asi que
// no hace falta ninguna lista de tipos nuestra que se quedaria obsoleta en
// cuanto saquen una categoria nueva. Confirmado en vivo sobre
// LeftShoeAccessory(70), RightShoeAccessory(71) y EyebrowAccessory(76).
function isLayered(asset) {
    return asset?.meta != null && typeof asset.meta === 'object';
}

// Recibe la respuesta CRUDA de /v3/outfits/{id}/details y devuelve el outfit
// normalizado. Funcion pura: sin red, sin cache, sin estado — lo que la hace
// trivial de testear contra respuestas reales guardadas.
function buildOutfit(raw, outfitId) {
    const rawAssets = Array.isArray(raw?.assets) ? raw.assets : [];
    const bodyColors = normalizeBodyColors(raw);

    const bodyParts = { head: null, torso: null, leftArm: null, rightArm: null, leftLeg: null, rightLeg: null };
    const clothing = { shirt: null, pants: null, graphicTShirt: null };
    const accessories = emptyAccessories();
    const animations = emptyAnimations();
    const layeredClothing = [];
    const emotes = [];
    const other = [];
    let face = null;
    let dynamicHead = null;

    const assets = rawAssets.map(asset => {
        const typeName = asset?.assetType?.name ?? null;
        const typeId = asset?.assetType?.id ?? null;
        const id = asset?.id ?? null;

        if (id != null && typeName) {
            if (BODY_PARTS[typeName]) {
                bodyParts[BODY_PARTS[typeName]] = id;
            } else if (typeName === 'DynamicHead') {
                // Una cabeza dinamica ocupa el mismo hueco que la cabeza normal
                // en HumanoidDescription.Head, pero el juego necesita saber que
                // lo es (soporta expresiones y formas de cabeza), asi que se
                // expone tambien por separado.
                bodyParts.head = id;
                dynamicHead = id;
            } else if (CLOTHING[typeName]) {
                clothing[CLOTHING[typeName]] = id;
            } else if (typeName === 'Face') {
                face = id;
            } else if (CLASSIC_ACCESSORIES[typeName]) {
                accessories[CLASSIC_ACCESSORIES[typeName]].push(id);
            } else if (ANIMATIONS[typeName]) {
                animations[ANIMATIONS[typeName]] = id;
            } else if (typeName === 'EmoteAnimation') {
                emotes.push(id);
            } else if (!isLayered(asset)) {
                // Ni categoria conocida ni datos de capa: no se descarta.
                other.push({ assetId: id, typeId, typeName });
            }

            // Independiente de lo anterior: si trae `meta`, es una pieza por
            // capas y el juego necesita order/puffiness para colocarla bien.
            // Un mismo asset puede por tanto aparecer en su categoria Y aqui.
            if (isLayered(asset)) {
                layeredClothing.push({
                    assetId: id,
                    typeId,
                    typeName,
                    order: asset.meta.order ?? null,
                    puffiness: asset.meta.puffiness ?? null,
                });
            }
        }

        // El asset tal cual, con nombre para mostrar en interfaz. `meta` se
        // reenvia VERBATIM a proposito: Roblox incluye ahi campos que varian
        // segun el asset, y copiarlos uno a uno significaria perder callado
        // cualquiera que añadan.
        const entry = { id, name: asset?.name ?? null, typeId, typeName, currentVersionId: asset?.currentVersionId ?? null };
        if (asset?.meta != null) entry.meta = asset.meta;
        if (asset?.supportsHeadShapes != null) entry.supportsHeadShapes = asset.supportsHeadShapes;
        return entry;
    });

    return {
        id: raw?.id ?? outfitId ?? null,
        name: raw?.name ?? null,
        outfitType: raw?.outfitType ?? null,
        inventoryType: raw?.inventoryType ?? null,
        isEditable: raw?.isEditable ?? null,
        universeId: raw?.universeId ?? null,
        // "R6" o "R15" tal y como lo da Roblox. Determina que rig monta el
        // juego, asi que se reenvia sin tocar y sin suponer un valor por
        // defecto si faltara.
        playerAvatarType: raw?.playerAvatarType ?? null,

        // Todo lo necesario para construir un HumanoidDescription, ya agrupado.
        humanoidDescription: {
            scale: normalizeScale(raw),
            bodyColorFormat: bodyColors.format,
            bodyColors: bodyColors.colors,
            bodyParts,
            dynamicHead,
            clothing,
            face,
            accessories,
            layeredClothing,
            animations,
            emotes,
            other,
        },

        // Lista plana y completa, con nombres y datos crudos por asset. Es
        // deliberadamente redundante con lo de arriba: `humanoidDescription`
        // sirve para RECONSTRUIR (solo ids, compacto y aplicable tal cual) y
        // `assets` para MOSTRAR (nombres, versiones, meta).
        assets,
    };
}

module.exports = {
    buildOutfit,
    normalizeBodyColors,
    normalizeScale,
    // Exportadas para los tests: verifican que el mapeo cubre lo que Roblox
    // devuelve de verdad, sin duplicar las tablas en el propio test.
    __maps: { BODY_PARTS, CLOTHING, CLASSIC_ACCESSORIES, ANIMATIONS },
};
