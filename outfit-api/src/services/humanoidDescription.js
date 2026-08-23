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
//
// AVISO PARA QUIEN CONSUMA ESTO, verificado contra el API dump de Roblox:
// `death` y `pose` NO tienen propiedad en HumanoidDescription. Roblox tiene
// los TIPOS de asset (49 DeathAnimation, 56 PoseAnimation) pero la clase no
// expone DeathAnimation ni PoseAnimation, asi que `d.DeathAnimation = ...` en
// Lua es un error en tiempo de ejecucion que aborta la construccion ENTERA del
// avatar — cara animada incluida. Se siguen exponiendo porque son datos reales
// del outfit y ocultarlos seria mentir; lo que no pueden es aplicarse a ciegas.
//
// `mood` SI existe (HumanoidDescription.MoodAnimation) y es LA pieza que
// anima la cara. Por eso se duplica en `animatedFace`: en esta lista, entre
// climb y walk, es justo donde un juego que aplica "las animaciones de
// movimiento" se la deja sin querer.
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

// typeName de Roblox -> nombre de Enum.AccessoryType, que es lo que espera
// HumanoidDescription:SetAccessories(). La conversion es mecanica (quitarle el
// sufijo "Accessory"), pero tenerla aqui evita que cada juego se escriba su
// propia tabla y se deje justo las dos que importan para la cara: Eyebrow y
// Eyelash. Un tipo que no este aqui sale como null y el juego decide.
const ACCESSORY_TYPES = {
    Hat: 'Hat',
    HairAccessory: 'Hair',
    FaceAccessory: 'Face',
    NeckAccessory: 'Neck',
    ShoulderAccessory: 'Shoulder',
    FrontAccessory: 'Front',
    BackAccessory: 'Back',
    WaistAccessory: 'Waist',
    TShirtAccessory: 'TShirt',
    ShirtAccessory: 'Shirt',
    PantsAccessory: 'Pants',
    JacketAccessory: 'Jacket',
    SweaterAccessory: 'Sweater',
    ShortsAccessory: 'Shorts',
    LeftShoeAccessory: 'LeftShoe',
    RightShoeAccessory: 'RightShoe',
    DressSkirtAccessory: 'DressSkirt',
    EyebrowAccessory: 'Eyebrow',
    EyelashAccessory: 'Eyelash',
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
    // Las tres piezas restantes de la cara animada. Van aparte porque el juego
    // las necesita juntas y Roblox las manda desperdigadas entre los demas
    // assets, sin nada que diga que forman una sola cosa.
    let eyebrow = null;
    let eyelash = null;
    let supportsHeadShapes = null;

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
                // Lo trae el propio asset. Dice si la cabeza acepta las formas
                // de cabeza del jugador, y el juego lo necesita para decidir si
                // respeta la suya o impone la del outfit.
                supportsHeadShapes = asset?.supportsHeadShapes ?? null;
            } else if (CLOTHING[typeName]) {
                clothing[CLOTHING[typeName]] = id;
            } else if (typeName === 'Face') {
                face = id;
            } else if (typeName === 'EyebrowAccessory') {
                // Cejas y pestañas son piezas POR CAPAS, asi que siguen
                // apareciendo en layeredClothing con su order y su puffiness —
                // que es como se aplican. Se capturan ademas aqui porque
                // pertenecen a la CARA, y mezcladas entre camisas y chaquetas
                // es exactamente donde un juego deja de aplicarlas.
                eyebrow = id;
            } else if (typeName === 'EyelashAccessory') {
                eyelash = id;
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
                    // El nombre de Enum.AccessoryType que espera
                    // SetAccessories(). Sin esto, cada juego se escribe la
                    // misma tabla de conversion y las cejas y pestañas son
                    // justo las que se quedan fuera.
                    accessoryType: ACCESSORY_TYPES[typeName] ?? null,
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

            // ── LA CARA ANIMADA NUEVA DE ROBLOX, en un solo sitio ────────────
            //
            // Todo lo de aqui existe ya en otros campos de esta misma
            // respuesta: `head` es `bodyParts.head`, `mood` es
            // `animations.mood`, y las cejas y pestañas estan en
            // `layeredClothing`. Que este repetido es DELIBERADO y es el
            // arreglo: repartida entre "partes del cuerpo", "animaciones" y
            // "ropa por capas", la cara animada no se parece a una sola cosa, y
            // un juego que aplique esas tres categorias por separado se deja
            // el `mood` — que es, literalmente, lo que la anima. La cabeza
            // dinamica sin su mood se monta bien y se queda QUIETA.
            //
            // COMO SE APLICA EN LUA, y son dos lineas distintas:
            //   d.Head          = animatedFace.head    -- la malla con FaceControls
            //   d.MoodAnimation = animatedFace.mood    -- la expresion que la mueve
            // Y las cejas y pestañas por SetAccessories, con el accessoryType
            // que ya viene resuelto en layeredClothing.
            //
            // `isAnimated` es la pregunta que el juego quiere hacer de verdad:
            // ¿esta cara se mueve? Con la cara 2D clasica es false y hay que
            // usar `classic` (HumanoidDescription.Face). Las dos formas
            // conviven en Roblox y un avatar tiene una o la otra, nunca las dos.
            animatedFace: {
                isAnimated: dynamicHead !== null,
                head: dynamicHead,
                mood: animations.mood,
                eyebrow,
                eyelash,
                classic: face,
                supportsHeadShapes,
            },
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
