'use strict';

module.exports = {
    OWNER_ID: '996310284803248158',
    GUILD_ID: '1162602588328435802',

    CHANNELS: {
        PANEL:      '1442456304420524146',
        OUTFIT:     '1496085917314842709',
        REFERENCIAS:'1452939436525617293',
        METODOS:    '1494475415597744360',
        CALC:       '1499571855789527173',
        REGLAS:     '1178782534721622067',
        VERIF:      '1511199906285486141',
    },

    ROBLOX_GROUP_ID:       282134403,
    ROBLOX_GROUP_DAYS_REQ: 15,
    ROBLOX_GROUP_LINK:     'https://www.roblox.com/es/communities/282134403/Noctra-Study',

    CATEGORIES: {
        TICKETS: '1184353695643729940',
    },

    ROLES: {
        AUTO_ASSIGN: '1500335259575910450',
    },

    IMAGES: {
        ROBUX_ENVIADOS: 'https://media.discordapp.net/attachments/1468842385420320960/1468842408614826077/Robux_Enviados.png',
    },

    // Ticket channel topic prefix — used for persistence across restarts
    TOPIC_PREFIX: 'ticket:',

    TIMEOUTS: {
        PAYMENT_CLOSE_MS: 10 * 60 * 1000,   // 10 min after owner confirms
        COUNTDOWN_TICK_MS: 60 * 1000,        // edit message every 1 min
        MANUAL_CLOSE_MS: 5000,               // delay before delete on user close
        LOCK_MS: 3000,                        // anti-spam per-user lock
        BUTTON_LOCK_MS: 1500,                 // anti auto-clicker for buttons
        TICKET_CREATE_LOCK_MS: 30 * 1000,     // atomic ticket creation reservation
    },
};
