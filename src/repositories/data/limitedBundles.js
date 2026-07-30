'use strict';

// Roblox's newer "animated face" items (bundleType 4 — moving eyes/mouth,
// e.g. "Snowflake Eyes", "Beast Mode", "ROBLOX Madness Face") are genuine
// Limiteds with real, currently-fluctuating resale value — unlike
// data/officialItemValues.js's bundles, these should NOT get a fixed price;
// they need a live RAP lookup on every un-cached request.
//
// Two things make these different from classic Limiteds (Sparkle Time
// Fedora etc.), both confirmed by testing live:
//   1. Like Headless Horseman/Korblox, the bundle id itself is never worn —
//      a player equips the bundle's DynamicHead + MoodAnimation component
//      assets instead. So matching works the same way as
//      data/officialItemValues.js: by component asset id.
//   2. Classic RAP (economy.roblox.com/v1/assets/{assetId}/resale-data)
//      flat-out rejects these ("The asset id is invalid") — they belong to
//      Roblox's newer GUID-keyed collectible economy instead. The
//      equivalent endpoint is
//        GET https://apis.roblox.com/marketplace-sales/v1/item/{collectibleItemId}/resale-data
//      which returns the same `recentAveragePrice` field, just keyed by
//      `collectibleItemId` (a GUID) instead of the integer asset id.
//
// To add a new one:
//   1. POST catalog.roblox.com/v1/catalog/items/details
//      body: { items: [{ itemType: "Bundle", id: <bundleId> }] }
//   2. Grab `collectibleItemId` from the response, and list every
//      `bundledItems` entry with type "Asset" (normally just "<Name> -
//      Head" and "<Name> - Mood") in matchAssetIds.
const LIMITED_BUNDLES = [
    { id: 187619642691885, name: 'ROBLOX Madness Face',    collectibleItemId: 'ff253784-1554-4428-a8e1-7a372d4b096c', matchAssetIds: [104065003453878, 74656753004438] },
    { id: 259144677693420, name: 'Snowflake Eyes',          collectibleItemId: '1efbdaaf-a2e0-4e6a-b599-f54ef869c6d1', matchAssetIds: [82223146991621, 124531672616950] },
    { id: 158380697314856, name: 'Super Super Happy Face',  collectibleItemId: '5cd2e1f8-8919-4e64-97d3-0f26093ab9a6', matchAssetIds: [130433936882245, 124102129879581] },
    { id: 213249000290945, name: 'Catching Snowflakes',     collectibleItemId: 'dc76034f-13fd-455e-a165-dd43ffd6e61f', matchAssetIds: [139251841457633, 75052027130388] },
    { id: 105919952545574, name: 'Playful Vampire',         collectibleItemId: '30639ffc-2a03-436f-8042-400990a0b0c9', matchAssetIds: [136298162773288, 115024560910687] },
    { id: 76831638855316,  name: 'Blue Wistful Wink',       collectibleItemId: 'aa43128a-efa2-46e3-bbfd-cfefabf160c4', matchAssetIds: [128394984451898, 74788270202182] },
    { id: 161273774968765, name: 'Snow Queen Smile',        collectibleItemId: '1f2a93a5-a99f-4231-8552-d360e61d8693', matchAssetIds: [133196692848803, 133285968979014] },
    { id: 141680612726107, name: 'Blue Goof',                collectibleItemId: '4cbff3c1-0a66-4e7c-944b-46ffdbfba8d6', matchAssetIds: [114624520946660, 140052496463742] },
    { id: 248386134630261, name: 'Green Goof',               collectibleItemId: '63769823-aba3-4116-880e-432201be279b', matchAssetIds: [74755350764511, 126644023676046] },
    { id: 50309297008292,  name: 'Red Goof',                 collectibleItemId: '15ab0dfd-c6ba-427a-83bd-0d75d8a5d450', matchAssetIds: [81782708135833, 127560595189125] },
    { id: 142855532815206, name: 'Green Wistful Wink',       collectibleItemId: '9df8979d-cb3b-4bad-b1c4-2ada4acc3aac', matchAssetIds: [73941496344773, 139056688296438] },
    { id: 142815600916961, name: 'Miss Scarlet',             collectibleItemId: 'e46141ad-d515-46c6-8b06-e97826e55e4f', matchAssetIds: [114031313320461, 71028810522852] },
    { id: 43169053104201,  name: 'Purple Wistful Wink',      collectibleItemId: '3c801795-507b-4559-b86c-7dde8af32abd', matchAssetIds: [121015622358176, 109643108067474] },
    { id: 161442420541976, name: 'Beast Mode',               collectibleItemId: '5d134ac4-32c2-4816-a2aa-662c684a4f2b', matchAssetIds: [127688119049205, 125351719533951] },
    { id: 170591579555886, name: 'Blizzard Beast Mode',      collectibleItemId: '55fcabd2-ab67-425e-98a3-1056381603e0', matchAssetIds: [108864005873622, 128421511488094] },
    { id: 175353425783426, name: 'Gritty Bombo',             collectibleItemId: 'd85fb963-0923-4c07-a9a7-31ccaa2efdb3', matchAssetIds: [136157998320514, 140618689743432] },
    { id: 237277579906692, name: 'Evil Skeptic',             collectibleItemId: '9c32d8bd-da8a-4588-b061-78524fd2a8ba', matchAssetIds: [88871634439416, 109016325316032] },
    { id: 149363664010741, name: 'Pink Shades McCool',       collectibleItemId: '534cabac-7785-4b2c-88b9-60c470cbf16a', matchAssetIds: [110952399150955, 74650238706000] },
    { id: 203349976064280, name: 'Violet Starry Sight',      collectibleItemId: '4e5c5e43-4033-414e-a448-8889889e12b6', matchAssetIds: [125398935000311, 99636073544511] },
    { id: 207033123750918, name: 'Radioactive Beast Mode',   collectibleItemId: 'eb6f0dbd-7a80-4412-9d52-4eb7594d4664', matchAssetIds: [128824320785562, 94069838661094] },
    { id: 26858190729610,  name: 'Yum!',                     collectibleItemId: 'adaab83e-09c1-47f6-9028-7a6c11938321', matchAssetIds: [90223980922049, 120963099526858] },
    { id: 244872167329033, name: 'Red Ultimate Dragon Face', collectibleItemId: 'c2eb7c48-9c3f-476d-8a4c-3324c92d8390', matchAssetIds: [80071849693343, 114604278336737] },
    { id: 273132539401053, name: 'Friendly Trusting Smile',  collectibleItemId: 'f196e251-3bb5-4752-9d74-d5f9bd773d02', matchAssetIds: [128202565043011, 123330892729033] },
    { id: 232651140533287, name: 'Troublemaker',             collectibleItemId: '4e6392c6-c025-4a16-a0ca-7b007bfd737d', matchAssetIds: [76400441982455, 130940389771481] },
];

const COMPONENT_TO_LIMITED_BUNDLE = new Map();
for (const bundle of LIMITED_BUNDLES) {
    for (const assetId of bundle.matchAssetIds) {
        COMPONENT_TO_LIMITED_BUNDLE.set(assetId, bundle);
    }
}

module.exports = { LIMITED_BUNDLES, COMPONENT_TO_LIMITED_BUNDLE };
