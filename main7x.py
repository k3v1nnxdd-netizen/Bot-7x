import discord
from discord.ext import commands
import os
from dotenv import load_dotenv
import re
import asyncio

load_dotenv()
TOKEN = os.getenv("TOKEN")

OWNER_ID = 996310284803248158

intents = discord.Intents.default()
intents.message_content = True
intents.guilds = True

bot = commands.Bot(command_prefix="!", intents=intents)

# 💰 PRECIOS COMPLETOS
precios = {
    500: "$69", 600: "$81", 700: "$93", 800: "$105", 900: "$117",
    1000: "$129", 1100: "$143", 1200: "$157", 1300: "$171", 1400: "$185",
    1500: "$200", 1600: "$215", 1700: "$231", 1800: "$247", 1900: "$263",
    2000: "$279", 2100: "$286", 2200: "$293", 2300: "$300", 2400: "$307",
    2500: "$315", 2600: "$320", 2700: "$325",

    2800: "$328", 2900: "$338", 3000: "$349", 3100: "$357", 3200: "$365",
    3300: "$373", 3400: "$381", 3500: "$279", 3600: "$397", 3700: "$405",
    3800: "$413", 3900: "$421", 4000: "$429", 4100: "$459", 4200: "$489",
    4300: "$519", 4400: "$549", 4500: "$505", 4600: "$520", 4700: "$535",
    4800: "$550", 4900: "$565", 5000: "$579",

    10000: "$1,199", 15000: "$1,450", 17000: "$1,649", 20000: "$1,950",
    25000: "$2,450", 30000: "$2,999", 35000: "$3,750", 40000: "$4,500",
    45000: "$5,250", 50000: "$5,999",

    60000: "$7,250", 65000: "$7,850", 70000: "$8,450", 75000: "$9,050",
    80000: "$9,650", 85000: "$10,250", 90000: "$11,500", 95000: "$12,250",
    100000: "$12,999"
}

# 🧠 ESTADOS
usuarios_esperando = {}
usuarios_en_pago = set()
tickets_usados = set()
procesando_tickets = set()

# 🔘 BOTÓN OWNER
class PagoView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(label="PAGO REALIZADO (SOLO OWNER)", style=discord.ButtonStyle.green)
    async def pago(self, interaction: discord.Interaction, button: discord.ui.Button):

        if interaction.user.id != OWNER_ID:
            return await interaction.response.send_message("❌ Solo el owner puede usar este botón", ephemeral=True)

        canal = interaction.channel

        # ✅ MENSAJE ORIGINAL RESTAURADO
        embed = discord.Embed(
            title="✅ PAGO EXITOSO",
            description="Tus robux fueron enviados.\n\nDeja tu referencia en <#1452939436525617293>",
            color=0x8A2BE2
        )

        embed.set_image(url="https://media.discordapp.net/attachments/1468842385420320960/1468842408614826077/Robux_Enviados.png")

        await interaction.response.send_message(embed=embed)

        mensaje = await canal.send("⏳ Este ticket se cerrará en 15 minutos...")

        for i in range(15, 0, -1):
            await asyncio.sleep(60)
            await mensaje.edit(content=f"⏳ Este ticket se cerrará en {i-1} minutos...")

        await canal.delete()

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
            "💰 Escribe cuántos robux quieres comprar: (Ejemplo: 1500)"
        )

    @discord.ui.button(label="No", style=discord.ButtonStyle.red)
    async def no(self, interaction: discord.Interaction, button: discord.ui.Button):

        if interaction.user.id != self.user_id:
            return await interaction.response.send_message("No es tu ticket", ephemeral=True)

        await interaction.response.send_message("🛠️ Un moderador te ayudará pronto 🙏")

# 🎯 EVENTO
@bot.event
async def on_message(message):

    # 🎟️ TICKET TOOL
    if message.author.bot:

        if not message.channel.category or "✮" not in message.channel.category.name:
            return

        if "ticket tool" not in message.author.name.lower():
            return

        if message.channel.id in tickets_usados or message.channel.id in procesando_tickets:
            return

        if "bienvenido" in message.content.lower():

            procesando_tickets.add(message.channel.id)

            match = re.search(r"<@(\d+)>", message.content)

            if match:
                user_id = int(match.group(1))

                tickets_usados.add(message.channel.id)

                await message.channel.send(
                    f"<@{user_id}> ¿Tu ticket está relacionado a la compra de robux baratos?",
                    view=Botones(user_id)
                )

            procesando_tickets.discard(message.channel.id)

    # 💬 USUARIO
    if not message.author.bot:

        texto = message.content.lower()

        # 💳 PAGO
        if message.author.id in usuarios_en_pago:

            if "pago" in texto and "exitoso" in texto:

                embed = discord.Embed(
                    title="⏳ Pago en revisión",
                    description="Tu pago está siendo verificado.\nEn breve recibirás tus robux 🚀",
                    color=0x8A2BE2
                )

                await message.channel.send(embed=embed)

                try:
                    await message.channel.edit(name="robux-pendientes")
                except:
                    pass

                usuarios_en_pago.remove(message.author.id)
                return

            await message.channel.send(
                "**⚠️ IMPORTANTE ⚠️**\n\n"
                "Para continuar con tu compra:\n\n"
                "1. Realiza el pago\n"
                "2. Envía tu comprobante\n"
                "3. Responde con:\n\n"
                "**PAGO EXITOSO**\n\n"
                "❌ Evita mensajes innecesarios para agilizar tu pedido."
            )

        # 💰 MONTO
        if message.author.id in usuarios_esperando:

            match = re.search(r"\d+", texto)

            if match:
                cantidad = int(match.group())

                if cantidad in precios:

                    precio = precios[cantidad]

                    embed = discord.Embed(
                        title="💰 Compra detectada",
                        description=f"**Robux:** {cantidad}\n**Precio:** {precio} MXN",
                        color=0x8A2BE2
                    )

                    # 💳 MÉTODOS DE PAGO RESTAURADOS
                    embed.add_field(
                        name="🏦 TRANSFERENCIA",
                        value=(
                            "**CUENTA 1:**\n```722969040869278041```\n"
                            "MERCADO PAGO\nVICENTA MARIANO VALDOVINOS\n\n"
                            "**CUENTA 2:**\n```721180100042646712```\n"
                            "ALBO\nHector Altamirano Gonzalez"
                        ),
                        inline=False
                    )

                    embed.add_field(
                        name="🏪 DEPÓSITO OXXO",
                        value="https://cdn.discordapp.com/attachments/1464133748923695199/1464371847201292574/0273176f-3966-4d09-a18e-15abac4a5cbb.jpg",
                        inline=False
                    )

                    await message.channel.send(embed=embed)

                    embed2 = discord.Embed(
                        title="⏳ PAGO PENDIENTE",
                        description="Responde con:\n\n**Pago exitoso**",
                        color=0x8A2BE2
                    )

                    await message.channel.send(embed=embed2, view=PagoView())

                    usuarios_esperando.pop(message.author.id)
                    usuarios_en_pago.add(message.author.id)

                else:
                    await message.channel.send("❌ Monto inválido (Ej: 1500)")

            else:
                await message.channel.send("❌ Escribe un número válido")

    await bot.process_commands(message)

@bot.event
async def on_ready():
    print(f"Bot activo como {bot.user}")

bot.run(TOKEN)