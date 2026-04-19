import discord
from discord.ext import commands
import os
from dotenv import load_dotenv
import re
import asyncio
import unicodedata

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
    3000: "$279", 3100: "$357", 3200: "$365", 3300: "$373", 3400: "$381",
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
    13000: "$1,391", 13500: "$1,423", 14000: "$1,455", 1487: "$1,487", 15000: "$1,519",
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

usuarios_esperando_monto = {}  # channel_id: user_id
usuarios_esperando_pago = set()  # channel_id
ticket_owner = {}  # channel_id: user_id

# Función para normalizar texto
def normalizar_texto(texto):
    # Convertir a minúsculas
    texto = texto.lower()
    # Quitar acentos
    texto = unicodedata.normalize('NFD', texto).encode('ascii', 'ignore').decode('utf-8')
    # Eliminar signos de puntuación
    texto = re.sub(r'[^\w\s]', '', texto)
    return texto.strip()

# Función para detectar intención de "pago exitoso"
def es_pago_exitoso(texto):
    normalizado = normalizar_texto(texto)
    # Verificar si contiene "pago" y alguna forma de "exitoso" o similar
    contiene_pago = 'pago' in normalizado
    contiene_exitoso = any(word in normalizado for word in ['exitoso', 'exitozo', 'exitosa', 'exitoza', 'fue exitoso', 'fue exitosa'])
    return contiene_pago and contiene_exitoso

# --- VISTAS (BOTONES) ---

class PagoConfirmadoView(discord.ui.View):
    def __init__(self, user_id):
        super().__init__(timeout=None)
        self.user_id = user_id

    @discord.ui.button(label="✅ PAGO REALIZADO (SOLO OWNER)", style=discord.ButtonStyle.green)
    async def confirmar_pago(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != OWNER_ID:
            return await interaction.response.send_message("❌ No tienes permiso para usar este botón.", ephemeral=True)

        embed = discord.Embed(
            title="✅ PAGO EXITOSO",
            description=f"<@{self.user_id}>, tus robux han sido enviados correctamente.\n\nPor favor, deja tu referencia en <#1452939436525617293>",
            color=0x8A2BE2
        )
        embed.set_image(url="https://media.discordapp.net/attachments/1468842385420320960/1468842408614826077/Robux_Enviados.png")
        await interaction.response.send_message(embed=embed)
        
        # --- SISTEMA DE CIERRE CON CONTEO REGRESIVO ---
        minutos_restantes = 15
        mensaje_cierre = await interaction.channel.send(f"<@{self.user_id}>, ⏳ Este ticket se cerrará automáticamente en **{minutos_restantes} minutos**...")

        while minutos_restantes > 0:
            await asyncio.sleep(60) # Esperar 1 minuto
            minutos_restantes -= 1
            if minutos_restantes > 0:
                try:
                    await mensaje_cierre.edit(content=f"<@{self.user_id}>, ⏳ Este ticket se cerrará automáticamente en **{minutos_restantes} minutos**...")
                except:
                    break # Si el canal se borra manualmente antes, salimos del bucle
            else:
                break

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
        
        await interaction.message.delete()
        usuarios_esperando_monto[interaction.channel.id] = interaction.user.id
        await interaction.response.send_message("💰 **Escribe cuántos robux quieres comprar:** (Ejemplo: 1500)")

    @discord.ui.button(label="No, otro motivo", style=discord.ButtonStyle.red)
    async def rechazar(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.user_id:
            return await interaction.response.send_message("Este botón no es para ti.", ephemeral=True)
        
        await interaction.message.delete()
        await interaction.response.send_message("🛠️ Entendido. Un moderador te atenderá en un momento para resolver tus dudas.")

# --- EVENTOS ---

@bot.event
async def on_message(message):
    await bot.process_commands(message)
    
    if message.author.bot:
        if "ticket tool" in message.author.name.lower() and "bienvenido" in message.content.lower():
            match = re.search(r"<@(\d+)>", message.content)
            if match:
                user_id = int(match.group(1))
                ticket_owner[message.channel.id] = user_id
                await message.channel.send(
                    f"Hola <@{user_id}> 👋, ¿vienes a comprar Robux baratos?", 
                    view=InicioTicketView(user_id)
                )
        return

    es_ticket = message.channel.name.startswith("ticket-")
    es_cat_valida = message.channel.category and "✮" in message.channel.category.name
    if not (es_ticket or es_cat_valida):
        return

    # --- FASE 1: MONTO ---
    if message.channel.id in usuarios_esperando_monto:
        if message.author.id != usuarios_esperando_monto[message.channel.id]:
            return  # Solo el usuario del ticket puede responder
        
        contenido = message.content.strip()
        
        # Limpiar comas y espacios para aceptar formatos como 1,500 o 1 500
        contenido_limpio = contenido.replace(',', '').replace(' ', '')
        
        if not contenido_limpio.isdigit():
            await message.channel.send("❌ **Escribe un número válido.** (Ejemplo: 1500)")
            return

        monto_ingresado = int(contenido_limpio)
        monto_final = monto_ingresado

        if monto_ingresado not in precios:
            cercano = min(precios.keys(), key=lambda x: abs(x - monto_ingresado))
            diferencia = abs(cercano - monto_ingresado)
            if diferencia <= 15 or diferencia <= (cercano * 0.05):
                await message.channel.send(f"⚠️ El monto **{monto_ingresado}** no está en lista. Redondeando a la oferta de **{cercano} robux**.")
                monto_final = cercano
            else:
                await message.channel.send(f"❌ **Monto inválido.** Por favor elige una cantidad de nuestra lista de precios.")
                return

        precio_texto = precios[monto_final]
        usuarios_esperando_monto.pop(message.channel.id)
        usuarios_esperando_pago.add(message.channel.id)

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
            value="",
            inline=False
        )
        
        canal_metodos = bot.get_channel(1494475415597744360)
        mencion_canal = canal_metodos.mention if canal_metodos else "<#1494475415597744360>"
        embed_pago.add_field(
            name="📞 OTROS MÉTODOS DE PAGO",
            value=f"Consulta {mencion_canal}",
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
        
        embed_pago.set_image(url="attachment://oxxo.jpg")
        
        await message.channel.send(embed=embed_pago, file=discord.File('oxxo.jpg'))
        await message.channel.send(embed=instrucciones, view=PagoConfirmadoView(ticket_owner[message.channel.id]))
        return

    # --- FASE 2: PAGO EXITOSO ---
    if message.channel.id in usuarios_esperando_pago:
        if message.author.id != ticket_owner[message.channel.id]:
            return  # Solo el usuario del ticket puede responder
        
        if es_pago_exitoso(message.content):
            embed_staff = discord.Embed(
                title="🚀 PAGO EN REVISIÓN",
                description="Gracias. Tu comprobante ha sido enviado al staff.\nEn unos momentos recibirás tus Robux.",
                color=0x00FF00
            )
            await message.channel.send(embed=embed_staff)
            try: await message.channel.edit(name=f"✅-pago-{message.author.name}")
            except: pass
            usuarios_esperando_pago.remove(message.channel.id)
        else:
            await message.channel.send(
                content=f"⚠️ <@{message.author.id}>, por favor realiza el pago, manda el comprobante y escribe **PAGO EXITOSO** para confirmar."
            )
        return

@bot.event
async def on_ready():
    print(f"✅ Bot conectado como {bot.user}")
    # Limpiar slash commands antiguos
    bot.tree.clear_commands()
    await bot.tree.sync()
    print(f"✅ Comandos sincronizados")

@bot.command(name='pagos')
async def pagos(ctx):
    """Muestra todos los métodos de pago disponibles"""
    embed_pagos = discord.Embed(
        title="💳 INFORMACIÓN DE PAGO",
        description="Elige tu método de pago y completa tu compra de forma segura.",
        color=0x8A2BE2
    )
    embed_pagos.add_field(
        name="🏦 TRANSFERENCIA",
        value=(
            "**CUENTA 1:**\n```722969040869278041```\n"
            "**MERCADO PAGO**\nVICENTA MARIANO VALDOVINOS\n\n"
            "**CUENTA 2:**\n```721180100042646712```\n"
            "**ALBO**\nHECTOR ALTAMIRANO GONZALEZ"
        ),
        inline=False
    )
    embed_pagos.add_field(
        name="🏪 DEPÓSITO OXXO",
        value="",
        inline=False
    )
    embed_pagos.add_field(
        name="🎁 GIFT CARD",
        value=(
            "Paga fácilmente con Gift Cards disponibles para todos los países.\n"
            "Selecciona el valor según el monto de Robux que deseas comprar.\n\n"
            "[🔗 Comprar Gift Card](https://www.eneba.com/eneba-eneba-gift-card-5-eur-global)"
        ),
        inline=False
    )
    embed_pagos.set_image(url="attachment://oxxo.jpg")
    
    await ctx.send(embed=embed_pagos, file=discord.File('oxxo.jpg'))

bot.run(TOKEN)