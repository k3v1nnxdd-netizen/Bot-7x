import discord
from discord.ext import commands
import os
from dotenv import load_dotenv
import re

load_dotenv()
TOKEN = os.getenv("TOKEN")

OWNER_ID = 996310284803248158  # 👈 ID de Kevvv7x

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
tickets_usados = set()

# 🔘 BOTÓN OWNER
class PagoView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(label="PAGO REALIZADO (SOLO OWNER)", style=discord.ButtonStyle.green)
    async def pago(self, interaction: discord.Interaction, button: discord.ui.Button):

        if interaction.user.id != OWNER_ID:
            return await interaction.response.send_message("❌ Solo el owner puede usar este botón", ephemeral=True)

        embed = discord.Embed(
            title="✅ PAGO EXITOSO",
            description="Tus robux fueron enviados.\n\nPor favor deja una referencia en <#1452939436525617293>",
            color=0x8A2BE2
        )

        embed.set_image(
            url="https://media.discordapp.net/attachments/1468842385420320960/1468842408614826077/Robux_Enviados.png"
        )

        await interaction.response.send_message(embed=embed)

# 🔘 BOTONES INICIALES
class Botones(discord.ui.View):
    def __init__(self, user_id):
        super().__init__(timeout=None)
        self.user_id = user_id

    @discord.ui.button(label="Sí", style=discord.ButtonStyle.green)
    async def si(self, interaction: discord.Interaction, button: discord.ui.Button):

        if interaction.user.id != self.user_id:
            return await interaction.response.send_message("No es tu ticket", ephemeral=True)

        usuarios_esperando[self.user_id] = True

        await interaction.response.send_message("💰 Escribe cuántos robux quieres comprar:")

    @discord.ui.button(label="No", style=discord.ButtonStyle.red)
    async def no(self, interaction: discord.Interaction, button: discord.ui.Button):

        if interaction.user.id != self.user_id:
            return await interaction.response.send_message("No es tu ticket", ephemeral=True)

        await interaction.response.send_message(
            "🛠️ En breve un moderador responderá a tu ticket 🙏"
        )

# 🎯 DETECCIÓN PRINCIPAL
@bot.event
async def on_message(message):

    # 🔥 SOLO MENSAJE DE TICKET TOOL
    if message.author.bot:

        if message.channel.id in tickets_usados:
            return

        if "bienvenido" in message.content.lower():

            match = re.search(r"<@(\d+)>", message.content)

            if match:
                user_id = int(match.group(1))

                tickets_usados.add(message.channel.id)

                view = Botones(user_id)

                await message.channel.send(
                    f"<@{user_id}> ¿Tu ticket está relacionado a la compra de robux baratos?",
                    view=view
                )

    # 💰 RESPUESTA DEL USUARIO
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
                        name="🏪 DEPÓSITO OXXO",
                        value="https://cdn.discordapp.com/attachments/1464133748923695199/1464371847201292574/0273176f-3966-4d09-a18e-15abac4a5cbb.jpg",
                        inline=False
                    )

                    embed.add_field(
                        name="📩 PASOS",
                        value=(
                            "1. Realiza el pago\n"
                            "2. Envía tu comprobante\n"
                            "3. Tus Robux serán enviados en menos de 24 Hrs 🚀"
                        ),
                        inline=False
                    )

                    embed.add_field(
                        name="⚠️ IMPORTANTE",
                        value=(
                            "Al realizar el pago y enviar el comprobante responde con:\n\n"
                            "**Pago exitoso**\n\n"
                            "(Respeta mayúsculas y minúsculas)"
                        ),
                        inline=False
                    )

                    await message.channel.send(embed=embed, view=PagoView())

                    usuarios_esperando.pop(message.author.id)

    await bot.process_commands(message)

@bot.event
async def on_ready():
    print(f"Bot activo como {bot.user}")

bot.run(TOKEN)