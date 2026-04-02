import discord
from discord.ext import commands
import os
from dotenv import load_dotenv
import re
import asyncio

# --- CONFIGURACIÓN ---
load_dotenv()
TOKEN = os.getenv("TOKEN")
OWNER_ID = 996310284803248158 

intents = discord.Intents.default()
intents.message_content = True
intents.guilds = True

bot = commands.Bot(command_prefix="!", intents=intents)

# 💰 DICCIONARIO DE PRECIOS COMPLETO (500 - 100k)
precios = {
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

usuarios_esperando_monto = {} 
usuarios_esperando_pago = set()

# --- VISTAS (BOTONES) ---

class PagoConfirmadoView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(label="✅ PAGO REALIZADO (SOLO OWNER)", style=discord.ButtonStyle.green)
    async def confirmar_pago(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != OWNER_ID:
            return await interaction.response.send_message("❌ No tienes permiso para usar este botón.", ephemeral=True)

        embed = discord.Embed(
            title="✅ PAGO EXITOSO",
            description="Tus robux han sido enviados correctamente.\n\nPor favor, deja tu referencia en <#1452939436525617293>",
            color=0x8A2BE2
        )
        embed.set_image(url="https://media.discordapp.net/attachments/1468842385420320960/1468842408614826077/Robux_Enviados.png")
        await interaction.response.send_message(embed=embed)
        
        await interaction.channel.send("⏳ Este ticket se cerrará automáticamente en 15 minutos...")
        await asyncio.sleep(900)
        try:
            await interaction.channel.delete()
        except:
            pass

class InicioTicketView(discord.ui.View):
    def __init__(self, user_id):
        super().__init__(timeout=None)
        self.user_id = user_id

    @discord.ui.button(label="Sí, quiero Robux", style=discord.ButtonStyle.green)
    async def aceptar(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.user_id:
            return await interaction.response.send_message("Este botón no es para ti.", ephemeral=True)
        
        # Eliminar el mensaje de la pregunta inicial
        await interaction.message.delete()
        
        usuarios_esperando_monto[self.user_id] = True
        await interaction.response.send_message("💰 **Escribe cuántos robux quieres comprar:** (Ejemplo: 1500)")

    @discord.ui.button(label="No, otro motivo", style=discord.ButtonStyle.red)
    async def rechazar(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.user_id:
            return await interaction.response.send_message("Este botón no es para ti.", ephemeral=True)
        
        # Eliminar el mensaje de la pregunta inicial
        await interaction.message.delete()
        await interaction.response.send_message("🛠️ Entendido. Un moderador te atenderá en un momento para resolver tus dudas.")

# --- EVENTOS ---

@bot.event
async def on_message(message):
    if message.author.bot:
        # Detectar bienvenida de Ticket Tool
        if "ticket tool" in message.author.name.lower() and "bienvenido" in message.content.lower():
            match = re.search(r"<@(\d+)>", message.content)
            if match:
                user_id = int(match.group(1))
                await message.channel.send(
                    f"Hola <@{user_id}> 👋, ¿vienes a comprar Robux baratos?", 
                    view=InicioTicketView(user_id)
                )
        return

    # 🔒 RESTRICCIÓN DE CANAL
    es_ticket = message.channel.name.startswith("ticket-")
    es_cat_valida = message.channel.category and "✮" in message.channel.category.name
    if not (es_ticket or es_cat_valida):
        return

    # --- FASE 1: VALIDACIÓN DE MONTO ---
    if message.author.id in usuarios_esperando_monto:
        contenido = message.content.strip()
        
        if not contenido.isdigit():
            await message.channel.send("❌ **Escribe un número válido.** (Ejemplo: 1500)")
            return

        monto_ingresado = int(contenido)
        monto_final = monto_ingresado

        # SISTEMA DE REDONDEO
        if monto_ingresado not in precios:
            cercano = min(precios.keys(), key=lambda x: abs(x - monto_ingresado))
            diferencia = abs(cercano - monto_ingresado)
            
            if diferencia <= 15 or diferencia <= (cercano * 0.05):
                await message.channel.send(f"⚠️ El monto **{monto_ingresado}** no está en lista. Redondeando a la oferta de **{cercano} robux**.")
                monto_final = cercano
            else:
                await message.channel.send(f"❌ **Monto inválido.** (Ej: 1500)\nPor favor elige una cantidad de nuestra lista de precios.")
                return

        precio_texto = precios[monto_final]
        usuarios_esperando_monto.pop(message.author.id)
        usuarios_esperando_pago.add(message.author.id)

        # EMBED DE PAGO CON DATOS COMPLETOS
        embed_pago = discord.Embed(
            title="💳 INFORMACIÓN DE PAGO",
            description=f"Has seleccionado: **{monto_final} Robux**\nTotal a pagar: **{precio_texto} MXN**",
            color=0x8A2BE2
        )
        embed_pago.add_field(
            name="🏦 TRANSFERENCIA",
            value=(
                "**CUENTA 1:**\n```722969040869278041```\n"
                "**MERCADO PAGO**\nVICENTA MARIANO VALDOVINOS\n\n"
                "**CUENTA 2:**\n```721180100042646712```\n"
                "**ALBO**\nHECTOR ALTAMIRANO GONZALEZ"
            ),
            inline=False
        )
        embed_pago.add_field(
            name="🏪 DEPÓSITO OXXO",
            value="[Click aquí para el código de barras](https://cdn.discordapp.com/attachments/1464133748923695199/1464371847201292574/0273176f-3966-4d09-a18e-15abac4a5cbb.jpg?ex=69d0318f&is=69cee00f&hm=3e500b640f3e8d74a49e452683067eebc2bd767e31997fa8b89782f51f48048f)",
            inline=False
        )
        
        instrucciones = discord.Embed(
            title="⏳ SIGUIENTES PASOS",
            description=(
                "1. Realiza el pago por el monto exacto.\n"
                "2. Envía la **FOTO DEL COMPROBANTE** aquí mismo.\n"
                "3. Escribe **PAGO EXITOSO** para confirmar."
            ),
            color=0xFFA500
        )
        
        await message.channel.send(embed=embed_pago)
        await message.channel.send(embed=instrucciones, view=PagoConfirmadoView())
        return

    # --- FASE 2: CONFIRMACIÓN DE PAGO ---
    if message.author.id in usuarios_esperando_pago:
        if message.content.lower().strip() == "pago exitoso":
            embed_staff = discord.Embed(
                title="🚀 PAGO EN REVISIÓN",
                description="Gracias. Tu comprobante ha sido enviado al staff.\nEn unos momentos recibirás tus Robux.",
                color=0x00FF00
            )
            await message.channel.send(embed=embed_staff)
            
            try: await message.channel.edit(name=f"✅-pago-{message.author.name}")
            except: pass
            
            usuarios_esperando_pago.remove(message.author.id)
        else:
            await message.channel.send(
                content=f"⚠️ <@{message.author.id}>, por favor realiza el pago, manda el comprobante y escribe **PAGO EXITOSO** para confirmar."
            )
        return

    await bot.process_commands(message)

@bot.event
async def on_ready():
    print(f"✅ Bot de Ventas 7x conectado como {bot.user}")

bot.run(TOKEN)