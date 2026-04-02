import discord
from discord.ext import commands
import os
from dotenv import load_dotenv
import asyncio
import re

load_dotenv()
TOKEN = os.getenv("TOKEN")

intents = discord.Intents.default()
intents.message_content = True
intents.guilds = True

bot = commands.Bot(command_prefix="!", intents=intents)

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
    5000: "$579"
}

usuarios_esperando = {}

# 🔍 DETECTAR MENSAJE DE BIENVENIDA
@bot.event
async def on_message(message):

    if message.author.bot:

        # SOLO categoría ✮
        if message.channel.category and "✮" in message.channel.category.name:

            texto = message.content

            # Buscar ID en mensaje tipo <@123456>
            match = re.search(r"<@(\d+)>", texto)

            if "bienvenido" in texto.lower() and match:

                user_id = int(match.group(1))
                usuario = await bot.fetch_user(user_id)

                view = Botones(user_id)

                await message.channel.send(
                    f"{usuario.mention} ¿Tu ticket está relacionado a la compra de robux baratos?",
                    view=view
                )

    # 👇 DETECTAR RESPUESTA DEL USUARIO
    if not message.author.bot:

        if message.author.id in usuarios_esperando:

            numeros = ''.join(filter(str.isdigit, message.content))

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
                        name="📩 PASOS",
                        value=(
                            "1. Realiza el pago\n"
                            "2. Envía tu comprobante\n"
                            "3. Recibe tus robux en menos de 24h 🚀"
                        ),
                        inline=False
                    )

                    await message.channel.send(embed=embed)

                    usuarios_esperando.pop(message.author.id)

    await bot.process_commands(message)

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
            "🛠️ Perfecto, en breve un moderador responderá a tu ticket 🙏",
            ephemeral=False
        )

@bot.event
async def on_ready():
    print(f"Bot activo como {bot.user}")

bot.run(TOKEN)