import discord
from discord.ext import commands
import os
from dotenv import load_dotenv
import asyncio

load_dotenv()
TOKEN = os.getenv("TOKEN")

intents = discord.Intents.default()
intents.message_content = True
intents.guilds = True
intents.members = True

bot = commands.Bot(command_prefix="!", intents=intents)

# 💰 PRECIOS
precios = {
    500: "$69",
    1000: "$129",
    1500: "$200",
    2000: "$279",
    2500: "$315",
    3000: "$349",
    3500: "$389",
    4000: "$429",
    4500: "$505",
    5000: "$579",
    10000: "$1,199",
    15000: "$1,450",
    17000: "$1,649",
    20000: "$1,950",
    25000: "$2,450",
    30000: "$2,999",
    35000: "$3,750",
    40000: "$4,500",
    45000: "$5,250",
    50000: "$5,999"
}

# 🧠 USUARIOS ESPERANDO RESPUESTA
usuarios_esperando = {}

# 🎟️ DETECTAR CREACIÓN DE TICKET
@bot.event
async def on_guild_channel_create(channel):
    await asyncio.sleep(2)

    if isinstance(channel, discord.TextChannel):
        if channel.category and "✮" in channel.category.name:

            miembros = [m for m in channel.members if not m.bot]

            if not miembros:
                return

            usuario = miembros[0]

            view = Botones(usuario.id)

            await channel.send(
                f"{usuario.mention} ¿Tu ticket está relacionado a la compra de robux baratos?",
                view=view
            )

# 🔘 BOTONES
class Botones(discord.ui.View):
    def __init__(self, user_id):
        super().__init__(timeout=None)
        self.user_id = user_id

    @discord.ui.button(label="Sí", style=discord.ButtonStyle.green)
    async def si(self, interaction: discord.Interaction, button: discord.ui.Button):

        if interaction.user.id != self.user_id:
            return await interaction.response.send_message("No es tu ticket", ephemeral=True)

        usuarios_esperando[self.user_id] = True

        await interaction.response.send_message(
            "💰 Escribe cuántos robux quieres comprar:",
            ephemeral=False
        )

    @discord.ui.button(label="No", style=discord.ButtonStyle.red)
    async def no(self, interaction: discord.Interaction, button: discord.ui.Button):

        if interaction.user.id != self.user_id:
            return await interaction.response.send_message("No es tu ticket", ephemeral=True)

        await interaction.response.send_message(
            "🛠️ Perfecto, en breve un moderador responderá a tu ticket. Por favor espera un momento 🙏",
            ephemeral=False
        )

# 💬 DETECTAR MENSAJES DEL USUARIO
@bot.event
async def on_message(message):

    if message.author.bot:
        return

    if message.author.id in usuarios_esperando:

        texto = message.content
        numeros = ''.join(filter(str.isdigit, texto))

        if numeros:
            cantidad = int(numeros)

            if cantidad in precios:
                precio = precios[cantidad]

                embed = discord.Embed(
                    title="💰 Compra detectada",
                    description=f"**Robux:** {cantidad}\n**Precio:** {precio} MXN",
                    color=0x8A2BE2
                )

                embed.set_image(
                    url="https://media.discordapp.net/attachments/1468842385420320960/1468844898793947279/metodos_pago.png"
                )

                embed.add_field(
                    name="🏦 TRANSFERENCIA",
                    value=(
                        "**CUENTA 1:**\n"
                        "```722969040869278041```\n"
                        "MERCADO PAGO\n"
                        "VICENTA MARIANO VALDOVINOS\n\n"
                        "**CUENTA 2:**\n"
                        "```721180100042646712```\n"
                        "ALBO\n"
                        "Hector Altamirano Gonzalez"
                    ),
                    inline=False
                )

                embed.add_field(
                    name="🏪 DEPÓSITO OXXO",
                    value="https://cdn.discordapp.com/attachments/1464133748923695199/1464371847201292574/0273176f-3966-4d09-a18e-15abac4a5cbb.jpg",
                    inline=False
                )

                embed.add_field(
                    name="📩 PASOS",
                    value=(
                        "1. Realiza el pago\n"
                        "2. Envía tu comprobante de pago\n"
                        "3. Tus Robux serán enviados en menos de 24 Hrs 🚀"
                    ),
                    inline=False
                )

                await message.channel.send(embed=embed)

                usuarios_esperando.pop(message.author.id)

    await bot.process_commands(message)

@bot.event
async def on_ready():
    print(f"Bot activo como {bot.user}")

bot.run(TOKEN)