'use strict';

const fs = require('fs');
const { EmbedBuilder } = require('discord.js');
const config = require('./config');

const IMAGE_PATH  = './7x REEGLAS.png';
const IMAGE_NAME  = '7xreeglas.png';
const IMAGE_EXISTS = fs.existsSync(IMAGE_PATH);

function buildReglasEmbed() {
    const embed = new EmbedBuilder()
        .setColor(0x000000)
        .setDescription(
            '<:rgl:1510169745557819543> **REGLAS DEL SERVIDOR**\n\n' +

            '<:point:1501212595464700104> **Respeto:** Trata a todos los miembros con respeto, independientemente de sus opiniones, gustos o creencias. Las faltas de respeto, insultos o provocaciones no serán toleradas.\n\n' +
            '<:point:1501212595464700104> **No Spam:** Está totalmente prohibido enviar enlaces externos, invitaciones a otros servidores, publicidad no autorizada o cualquier tipo de spam.\n\n' +
            '<:point:1501212595464700104> **Temas Sensibles:** Evita discusiones relacionadas con política, religión u otros temas que puedan generar conflictos innecesarios dentro de la comunidad.\n\n' +
            '<:point:1501212595464700104> **Lenguaje Apropiado:** No se permite el uso de lenguaje ofensivo, discriminatorio o vulgar. Cualquier acto de xenofobia, racismo, homofobia o discriminación de cualquier tipo está estrictamente prohibido.\n\n' +
            '<:point:1501212595464700104> **Contenido NSFW:** Está prohibido compartir contenido sexualmente explícito o cualquier material que pueda considerarse inapropiado para todos los públicos.\n\n' +
            '<:point:1501212595464700104> **Sentido Común:** Utiliza siempre el sentido común. Aunque estas reglas cubren la mayoría de situaciones, el equipo de moderación podrá actuar ante comportamientos que afecten negativamente a la comunidad aunque no estén mencionados explícitamente.\n\n' +
            'Ten en cuenta que estas reglas podrán ampliarse o modificarse con el tiempo para mantener una comunidad segura y organizada.\n\n' +
            '━━━━━━━━━━━━━━━━━━━━\n\n' +

            '<:7xrbx:1501216922241335459> **REGLAS ROBUX**\n\n' +

            '<:point:1501212595464700104> **Elegibilidad para Comunidades:** Si realizas un depósito o transferencia antes de cumplir los requisitos para recibir Robux por comunidad, no se realizarán reembolsos. Tus Robux permanecerán reservados y serán entregados una vez cumplas los 14 días requeridos dentro de una comunidad elegible de Roblox.\n\n' +
            '<:point:1501212595464700104> **Método de Entrega:** Actualmente los Robux se envían únicamente mediante comunidades de Roblox. No realizamos envíos mediante Roblox Premium (Plus).\n\n' +
            '<:point:1501212595464700104> **Seguridad:** Los Robux son completamente legítimos. No existe riesgo de baneo relacionado con nuestras entregas y no se realizan reembolsos de Robux ya entregados.\n\n' +
            '<:point:1501212595464700104> **Verifica tu Usuario:** Es responsabilidad del comprador proporcionar correctamente su nombre de usuario de Roblox. No nos hacemos responsables por errores al proporcionar información incorrecta.\n\n' +
            '<:point:1501212595464700104> **Tiempos de Entrega:** Los tiempos de entrega pueden variar dependiendo de la elegibilidad de la comunidad, disponibilidad y procesos internos. Se agradece la paciencia durante el proceso.\n\n' +
            '<:point:1501212595464700104> **Compras Finales:** Una vez realizado el pago, la compra se considera final. No se realizarán devoluciones por cambios de opinión o errores del comprador.\n\n' +
            'Gracias por formar parte de **7x Community**.'
        );

    if (IMAGE_EXISTS) embed.setImage(`attachment://${IMAGE_NAME}`);

    return embed;
}

function isReglasMsg(msg, botId) {
    return (
        msg.author.id === botId &&
        msg.embeds.length > 0 &&
        msg.embeds[0]?.description?.includes('REGLAS DEL SERVIDOR') &&
        msg.embeds[0]?.description?.includes('REGLAS ROBUX')
    );
}

async function ensureReglasPanel(client) {
    const channel = client.channels.cache.get(config.CHANNELS.REGLAS);
    if (!channel) {
        console.warn('[reglas] Reglas channel not found — skipping.');
        return;
    }

    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (messages) {
        const pinned = messages.find(m => m.pinned && isReglasMsg(m, client.user.id));
        if (pinned) {
            const payload = { embeds: [buildReglasEmbed()], ...(IMAGE_EXISTS && { files: [{ attachment: IMAGE_PATH, name: IMAGE_NAME }] }) };
            await pinned.edit(payload).catch(err => console.warn('[reglas] Could not edit pinned:', err.message));
            console.log('[reglas] Pinned reglas updated.');
            return;
        }
        const existing = messages.find(m => isReglasMsg(m, client.user.id));
        if (existing) {
            const payload = { embeds: [buildReglasEmbed()], ...(IMAGE_EXISTS && { files: [{ attachment: IMAGE_PATH, name: IMAGE_NAME }] }) };
            await existing.edit(payload).catch(err => console.warn('[reglas] Could not edit:', err.message));
            await existing.pin().catch(err => console.warn('[reglas] Could not pin:', err.message));
            console.log('[reglas] Reglas updated and pinned.');
            return;
        }
    }

    await new Promise(r => setTimeout(r, 3000));

    const recheck = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    if (recheck?.find(m => isReglasMsg(m, client.user.id))) {
        console.log('[reglas] Reglas appeared while waiting — skipping send.');
        return;
    }

    const payload = { embeds: [buildReglasEmbed()], ...(IMAGE_EXISTS && { files: [{ attachment: IMAGE_PATH, name: IMAGE_NAME }] }) };
    const msg = await channel.send(payload);
    await msg.pin().catch(err => console.warn('[reglas] Could not pin:', err.message));
    console.log('[reglas] Reglas sent and pinned.');
}

module.exports = { ensureReglasPanel };
