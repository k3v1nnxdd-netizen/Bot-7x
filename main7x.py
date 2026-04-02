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

# 💰 PRECIOS ACTUALIZADOS (100 en 100 hasta 10k, luego 500 en 500 hasta 100k)
precios = {
    # 100 en 100
    500: "$69", 600: "$81", 700: "$93", 800: "$105", 900: "$117",
    1000: "$129", 1100: "$143", 1200: "$157", 1300: "$171", 1400: "$185",
    1500: "$200", 1600: "$215", 1700: "$230", 1800: "$245", 1900: "$260",
    2000: "$279", 2100: "$286", 2200: "$293", 2300: "$300", 2400: "$307",
    2500: "$315", 2600: "$320", 2700: "$325", 2800: "$330", 2900: "$340",
    3000: "$349", 3100: "$357", 3200: "$365", 3300: "$373", 3400: "$381",
    3500: "$279", 3600: "$397", 3700: "$405", 3800: "$413", 3900: "$421",
    4000: "$429", 4100: "$459", 4200: "$489", 4300: "$519", 4400: "$549",
    4500: "$555", 4600: "$560", 4700: "$565", 4800: "$570", 4900: "$575",
    5000: "$579", 5100: "$595", 5200: "$611", 5300: "$627", 5400: "$643",
    5500: "$650", 5600: "$652", 5700: "$654", 5800: "$656", 5900: "$658",
    6000: "$659", 6100: "$671", 6200: "$683", 6300: "$695", 6400: "$707",
    6500: "$710", 6600: "$712", 6700: "$714", 6800: "$716", 6900: "$718",
    7000: "$558", 7100: "$747", 7200: "$775", 7300: "$803", 7400: "$831",
    7500: "$789", 7600: "$803", 7700: "$817", 7800: "$831", 7900: "$845",
    8000: "$859", 8100: "$871", 8200: "$883", 8300: "$895", 8400: "$907",
    8500: "$919", 8600: "$931", 8700: "$943", 8800: "$955", 8900: "$967",
    9000: "$979", 9100: "$1,001", 9200: "$1,023", 9300: "$1,045", 9400: "$1,067",
    9500: "$1,089", 9600: "$1,111", 9700: "$1,133", 9800: "$1,155", 9900: "$1,177",
    10000: "$1,199",
    
    # 500 en 500
    10500: "$1,231", 11000: "$1,263", 11500: "$1,295", 12000: "$1,327", 12500: "$1,359",
    13000: "$1,391", 13500: "$1,423", 14000: "$1,455", 14500: "$1,487", 15000: "$1,519",
    15500: "$1,551", 16000: "$1,583", 16500: "$1,615", 17000: "$1,649", 17500: "$1,700",
    18000: "$1,751", 18500: "$1,802", 19000: "$1,853", 19500: "$1,904", 20000: "$1,955",
    20500: "$2,006", 21000: "$2,057", 21500: "$2,108", 22000: "$2,159", 22500: "$2,210",
    23000: "$2,261", 23500: "$2,312", 24000: "$2,363", 24500: "$2,414", 25000: "$2,465",
    25500: "$2,516", 26000: "$2,567", 26500: "$2,618", 27000: "$2,669", 27500: "$2,720",
    28000: "$2,771", 28500: "$2,822", 29000: "$2,873", 29500: "$2,924", 30000: "$2,999",
    30500: "$3,074", 31000: "$3,149", 31500: "$3,224", 32000: "$3,299", 32500: "$3,374",
    33000: "$3,449", 33500: "$3,450", 34000: "$3,525", 34500: "$3,600", 35000: "$3,675",
    35500: "$3,750", 36000: "$3,825", 36500: "$3,900", 37000: "$3,975", 37500: "$4,050",
    38000: "$4,125", 38500: "$4,200", 39000: "$4,275", 39500: "$4,350", 40000: "$4,425",
    40500: "$4,500", 41000: "$4,575", 41500: "$4,650", 42000: "$4,725", 42500: "$4,800",
    43000: "$4,875", 43500: "$4,950", 44000: "$5,025", 44500: "$5,100", 45000: "$5,175",
    45500: "$5,250", 46000: "$5,325", 46500: "$5,400", 47000: "$5,475", 47500: "$5,550",
    48000: "$5,625", 48500: "$5,700", 49000: "$5,775", 49500: "$5,850", 50000: "$5,999",
    50500: "$6,070", 51000: "$6,141", 51500: "$6,212", 52000: "$6,283", 52500: "$6,354",
    53000: "$6,425", 53500: "$6,496", 54000: "$6,567", 54500: "$6,638", 55000: "$6,709",
    55500: "$6,780", 56000: "$6,851", 56500: "$6,783", 57000: "$6,850", 57500: "$6,916",
    58000: "$6,983", 58500: "$7,050", 59000: "$7,116", 59500: "$7,183", 60000: "$7,250",
    60500: "$7,316", 61000: "$7,383", 61500: "$7,450", 62000: "$7,516", 62500: "$7,583",
    63000: "$7,650", 63500: "$7,716", 64000: "$7,783", 64500: "$7,850", 65000: "$7,916",
    65500: "$7,983", 66000: "$8,050", 66500: "$8,116", 67000: "$8,183", 67500: "$8,250",
    68000: "$8,316", 68500: "$8,383", 69000: "$8,450", 69500: "$8,516", 70000: "$8,583",
    70500: "$8,650", 71000: "$8,716", 71500: "$8,783", 72000: "$8,850", 72500: "$8,916",
    73000: "$8,983", 73500: "$9,050", 74000: "$9,116", 74500: "$9,183", 75000: "$9,250",
    75500: "$9,316", 76000: "$9,383", 76500: "$9,450", 77000: "$9,516", 77500: "$9,583",
    78000: "$9,650", 78500: "$9,717", 79000: "$9,784", 79500: "$9,575", 80000: "$9,650",
    80500: "$9,725", 81000: "$9,800", 81500: "$9,875", 82000: "$9,950", 82500: "$10,025",
    83000: "$10,100", 83500: "$10,175", 84000: "$10,250", 84500: "$10,325", 85000: "$10,400",
    85500: "$10,475", 86000: "$10,550", 86500: "$10,625", 87000: "$10,700", 87500: "$10,775",
    88000: "$10,850", 88500: "$10,925", 89000: "$11,000", 89500: "$11,075", 90000: "$11,150",
    90500: "$11,225", 91000: "$11,300", 91500: "$11,375", 92000: "$11,450", 92500: "$11,525",
    93000: "$11,600", 93500: "$11,675", 94000: "$11,750", 94500: "$11,825", 95000: "$11,900",
    95500: "$11,975", 96000: "$12,050", 96500: "$12,125", 97000: "$12,200", 97500: "$12,275",
    98000: "$12,350", 98500: "$12,425", 99000: "$12,500", 99500: "$12,750", 100000: "$12,999"
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
            try:
                await mensaje.edit(content=f"⏳ Este ticket se cerrará en {i-1} minutos...")
            except: break

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
        await interaction.response.send_message("💰 Escribe cuántos robux quieres comprar: (Ejemplo: 1500)")

    @discord.ui.button(label="No", style=discord.ButtonStyle.red)
    async def no(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.user_id:
            return await interaction.response.send_message("No es tu ticket", ephemeral=True)
        await interaction.response.send_message("🛠️ Un moderador te ayudará pronto 🙏")

# 🎯 EVENTO PRINCIPAL
@bot.event
async def on_message(message):
    if not message.channel.category or "✮" not in message.channel.category.name:
        return

    if message.author.bot:
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
                try: await message.channel.edit(name="robux-pendientes")
                except: pass
                usuarios_en_pago.remove(message.author.id)
                return

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