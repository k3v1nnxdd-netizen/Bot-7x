'use strict';

// Los dos bundles que hay que reconocer SI O SI: Korblox Deathspeaker y
// Headless Horseman.
//
// POR QUE UN REGISTRO CURADO Y NO SOLO LA BUSQUEDA INVERSA. La busqueda
// inversa (catalog/v1/assets/{id}/bundles) es incompleta y esta documentado en
// este mismo repositorio: "Man - Torso" (12995020128) pertenece de verdad al
// bundle "Man" y devuelve `data: []`. Comprobado ademas al construir esto que
// hay assets del pack de Headless que tampoco resuelven bundle.
//
// Para dos objetos de 17.000 y 31.000 Robux —los mas caros que un jugador
// puede llevar puesto y justo los que se enseñan— "casi siempre acierta" no
// vale. Estos ids llevan una decada sin moverse y son publicos.
//
// La busqueda inversa SIGUE funcionando y tiene prioridad cuando responde:
// esto es la red de seguridad para cuando no responde, no un sustituto.
//
// Composicion verificada EN VIVO contra catalog/v1/bundles/details mientras se
// construia esto (22-08-2026).

const KORBLOX_BUNDLE_ID = '192';
const HEADLESS_BUNDLE_ID = '201';

const SPECIAL_BUNDLES = Object.freeze({
    [KORBLOX_BUNDLE_ID]: Object.freeze({
        bundleId: KORBLOX_BUNDLE_ID,
        special: 'korblox',
        name: 'Korblox Deathspeaker',
        // Brazos, piernas, torso y capucha. El UserOutfit del bundle no se
        // lista: no es un asset que se posea ni que se lleve puesto.
        assetIds: Object.freeze([
            '139607570', // Left Arm
            '139607625', // Right Arm
            '139607673', // Left Leg
            '139607718', // Right Leg
            '139607770', // Torso
            '139610147', // Hood
        ]),
    }),

    [HEADLESS_BUNDLE_ID]: Object.freeze({
        bundleId: HEADLESS_BUNDLE_ID,
        special: 'headless',
        name: 'Headless Horseman',
        assetIds: Object.freeze([
            '134082453', // Left Arm
            '134082473', // Right Arm
            '134082507', // Left Leg
            '134082533', // Right Leg
            '134082557', // Torso
            '131592085', // Headless Horseman's New Head
            '15093053680', // Headless Head
            '11573370910', // Anime - Mood
        ]),
    }),
});

// assetId -> bundleId, precalculado al cargar. Es la direccion en la que se
// consulta: "este asset que lleva puesto, ¿es de un bundle especial?".
const BUNDLE_BY_ASSET = new Map();
for (const bundle of Object.values(SPECIAL_BUNDLES)) {
    for (const assetId of bundle.assetIds) BUNDLE_BY_ASSET.set(assetId, bundle.bundleId);
}

function specialBundleForAsset(assetId) {
    return BUNDLE_BY_ASSET.get(String(assetId)) ?? null;
}

// Etiqueta del bundle: 'korblox' | 'headless' | null. Se usa tanto para el
// bundle en si como para heredarla a sus assets.
function specialLabel(bundleId) {
    return SPECIAL_BUNDLES[String(bundleId)]?.special ?? null;
}

module.exports = {
    SPECIAL_BUNDLES,
    KORBLOX_BUNDLE_ID,
    HEADLESS_BUNDLE_ID,
    specialBundleForAsset,
    specialLabel,
};
