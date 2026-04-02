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

# 💰 DICCIONARIO DE PRECIOS (500 - 100k)
precios = {
    # 100 en 100
    500: "$69", 600: "$81", 700: "$93", 800: "$105", 900: "$117",
    1000: "$129", 1100: "$143", 1200: "$157", 1300: "$171", 1400: "$185",
    1500: "$200", 1600: "$215", 1700: "$230", 1800: "$245", 1900: "$260",
    2000: "$279", 2100: "$286", 2200: "$293", 2300: "$300", 2400: "$307",
    2500: "$315", 2600: "$320", 2700: "$325", 2800: "$330", 2900: "$340",
    3000: "$349", 3100: "$357", 3200: "$365", 3300: "$373", 3400: "$381",
    3500: "$389", 3600: "$397", 3700: "$405", 3800: "$413", 3900: "$421",
    4000: "$429", 4100: "$459", 4200: "$489", 4300: "$519", 4400: "$549",
    4500: "$555", 4600: "$560", 4700: "$565", 4800: "$570", 4900: "$575",
    5000: "$579", 5100: "$595", 5200: "$611", 5300: "$627", 5400: "$643",
    5500: "$650", 5600: "$652", 5700: "$654", 5800: "$656", 5900: "$658",
    6000: "$659", 6100: "$671", 6200: "$683", 6300: "$695", 6400: "$707",
    6500: "$710", 6600: "$712", 6700: "$714", 6800: "$716", 6900: "$718",
    7000: "$719", 7100: "$747", 7200: "$775", 7300: "$803", 7400: "$831",
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
    35000: "$3,675", 40000: "$4,425", 45000: "$5,175", 50000: "$5,999", 55000: "$6,709",
    60000: "$7,250", 65000: "$7,916", 70000: "$8,583", 75000: "$9,250", 80000: "$9,650",
    85000: "$10,400", 90000: "$11,150", 95000: "$11,900", 100000: "$12,999"
}

usuarios_esperando = {} 
usuarios_en_pago = set()

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
            try: await mensaje.edit(content=f"⏳ Este ticket se cerrará en {i-1} minutos...")
            except: break
        await canal.delete()

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

@bot.event
async def on_message(message):
    if message.author.bot:
        if "ticket tool" in message.author.name.lower() and "bienvenido" in message.content.lower():
            match = re.search(r"<@(\d+)>", message.content)
            if match:
                user_id = int(match.group(1))
                await message.channel.send(f"<@{user_id}> ¿Tu ticket está relacionado a la compra de robux baratos?", view=Botones(user_id))
        return

    es_ticket = message.channel.name.startswith("ticket-")
    es_categoria_valida = message.channel.category and "✮" in message.channel.category.name
    
    if not (es_ticket or es_categoria_valida):
        return

    # --- LÓGICA DE MONTO ---
    if message.author.id in usuarios_esperando:
        texto_limpio = message.content.strip()
        
        if not texto_limpio.isdigit():
            await message.channel.send("❌ Escribe un número válido")
            return

        cantidad_original = int(texto_limpio)
        cantidad = cantidad_original

        # Sistema de Redondeo: Si no está en precios, buscar el más cercano
        if cantidad not in precios:
            # Encontrar el valor de la lista de precios que tenga la menor diferencia absoluta
            cercano = min(precios.keys(), key=lambda x: abs(x - cantidad_original))
            diferencia = abs(cercano - cantidad_original)
            
            # Solo redondear si la diferencia es pequeña (ej: menos del 5% o max 100 de diferencia)
            if diferencia <= (cercano * 0.05) or diferencia <= 10:
                await message.channel.send(f"⚠️ El monto **{cantidad_original}** no está en la lista, redondeando a **{cercano}** robux.")
                cantidad = cercano
            else:
                await message.channel.send(f"❌ Monto inválido (Ej: 1500). El monto **{cantidad_original}** no está en nuestra lista de precios.")
                return

        # Proceder con la compra (ya sea monto exacto o redondeado)
        precio = precios[cantidad]
        usuarios_esperando.pop(message.author.id) 
        usuarios_en_pago.add(message.author.id)

        embed_pago = discord.Embed(
            title="💰 Compra detectada",
            description=f"**Robux:** {cantidad}\n**Precio:** {precio} MXN",
            color=0x8A2BE2
        )
        embed_pago.add_field(name="🏦 TRANSFERENCIA", value="**CUENTA 1 (Mercado Pago):**\n