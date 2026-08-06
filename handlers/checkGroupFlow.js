'use strict';

const fs = require('fs');
const path = require('path');
const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { safeReply, safeEditReply, safeDeferReply, safeShowModal } = require('../utils/safe');
const config = require('../config');

const EMBED_COLOR = 0x2B2D31; // gray, per request

const GROUPS = {
    noctra:    { label: '7x (Antes Noctra Study)', file: path.join(__dirname, '..', 'se7en.png'),          attachName: 'se7en.png' },
    community: { label: "7x Community's",          file: path.join(__dirname, '..', '7 communitys.png'),   attachName: 'communitys.png' },
    group7x:   { label: '#7x Group',                file: path.join(__dirname, '..', '$7 studio.png'),      attachName: 'studio.png' },
};

// ── Step 1: panel button click → ask Roblox username via modal ───────────────

function buildUsernameModal(groupKey) {
    const group = GROUPS[groupKey];
    const modal = new ModalBuilder().setCustomId(`cg_modal_${groupKey}`).setTitle(`Check Group — ${group.label}`);
    modal.addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('roblox_username')
                .setLabel('¿Cuál es tu usuario de Roblox?')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Ej: PlayerName123')
                .setRequired(true)
        )
    );
    return modal;
}

async function handleCheckGroupButton(interaction) {
    if (interaction.replied || interaction.deferred) return;

    const groupKey = interaction.customId.slice('cg_'.length);
    if (!GROUPS[groupKey]) return;

    const ok = await safeShowModal(interaction, buildUsernameModal(groupKey));
    if (!ok) await safeReply(interaction, { content: '❌ No se pudo abrir el formulario. Intenta de nuevo.', ephemeral: true });
}

// ── Step 2: username submitted → post pending eligibility card to results ────

function buildEligibilityEmbed(groupKey, robloxUsername, discordUserId, status) {
    const group = GROUPS[groupKey];

    let statusText;
    if (status === 'eligible')     statusText = '<:true:1501213776878501899> **ELEGIBLE** — Puede recibir envíos de Robux.';
    else if (status === 'not_eligible') statusText = '<:alert:1501220021035204658> **NO ELEGIBLE** — No puede recibir envíos de Robux.';
    else                             statusText = 'Pendiente de revisión.';

    return new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle(`Elegibilidad - ${group.label}`)
        .setDescription(
            `<:member:1501261625523699892> **Usuario de Roblox**\n\`\`\`${robloxUsername}\`\`\`\n` +
            `<:point:1501212595464700104> **Solicitado por**\n<@${discordUserId}>\n\n` +
            `**Estado**\n${statusText}`
        )
        .setThumbnail(`attachment://${group.attachName}`)
        .setFooter({ text: '7x Community • Check Group' })
        .setTimestamp();
}

function buildEligibilityRow(disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('cg_elig_yes')
            .setLabel('Elegible')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId('cg_elig_no')
            .setLabel('No elegible')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled),
    );
}

async function handleCheckGroupModal(interaction) {
    if (interaction.replied || interaction.deferred) return;

    const groupKey = interaction.customId.slice('cg_modal_'.length);
    const group = GROUPS[groupKey];
    if (!group) return;

    const username = interaction.fields.getTextInputValue('roblox_username').trim();
    if (!username) {
        return safeReply(interaction, { content: '❌ Ingresa un nombre de usuario válido.', ephemeral: true });
    }

    if (!await safeDeferReply(interaction, { ephemeral: true })) return;

    const resultsChannel = interaction.client.channels.cache.get(config.CHANNELS.CHECKGROUP_RESULTS);
    if (!resultsChannel) {
        console.warn('[checkGroupFlow] Results channel not found.');
        return safeEditReply(interaction, { content: '❌ No se pudo enviar tu solicitud. Contacta a un administrador.' });
    }

    try {
        const embed = buildEligibilityEmbed(groupKey, username, interaction.user.id, 'pending');
        const fileExists = fs.existsSync(group.file);
        await resultsChannel.send({
            embeds: [embed],
            components: [buildEligibilityRow()],
            ...(fileExists && { files: [{ attachment: group.file, name: group.attachName }] }),
        });
        await safeEditReply(interaction, { content: '✅ Tu solicitud fue enviada. Revisa el canal de resultados para ver si eres elegible.' });
    } catch (err) {
        console.error('[checkGroupFlow] send error:', err);
        await safeEditReply(interaction, { content: '❌ Ocurrió un error al enviar tu solicitud. Intenta de nuevo.' });
    }
}

// ── Step 3: owner marks eligible / not eligible ───────────────────────────────

async function handleEligibilityButton(interaction) {
    if (interaction.replied || interaction.deferred) return;

    if (interaction.user.id !== config.OWNER_ID) {
        return safeReply(interaction, { content: '❌ Solo el owner puede usar este botón.', ephemeral: true });
    }

    const alreadyResolved = interaction.message.components[0]?.components?.every(c => c.disabled);
    if (alreadyResolved) {
        return safeReply(interaction, { content: '❌ Esta solicitud ya fue resuelta.', ephemeral: true });
    }

    const status = interaction.customId === 'cg_elig_yes' ? 'eligible' : 'not_eligible';

    const oldEmbed = interaction.message.embeds[0];
    const desc = oldEmbed?.description ?? '';
    const usernameMatch = desc.match(/```([^`]+)```/);
    const discordMatch = desc.match(/<@(\d+)>/);
    const robloxUsername = usernameMatch ? usernameMatch[1] : 'desconocido';
    const discordUserId = discordMatch ? discordMatch[1] : interaction.user.id;

    const groupLabel = (oldEmbed?.title ?? '').replace(/^Elegibilidad - /, '');
    const groupKey = Object.keys(GROUPS).find(k => GROUPS[k].label === groupLabel) ?? 'noctra';

    const embed = buildEligibilityEmbed(groupKey, robloxUsername, discordUserId, status);
    await interaction.update({ embeds: [embed], components: [buildEligibilityRow(true)] });
}

// ── Routers (called from handlers/buttons.js and handlers/modals.js) ─────────

async function handleCheckGroupButtonRouter(interaction) {
    if (interaction.customId.startsWith('cg_elig_')) return handleEligibilityButton(interaction);
    return handleCheckGroupButton(interaction);
}

module.exports = {
    handleCheckGroupButton: handleCheckGroupButtonRouter,
    handleCheckGroupModal,
};
