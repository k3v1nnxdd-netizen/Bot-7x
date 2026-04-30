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

# 💰 DICCIONARIO DE PRECIOS COMPLETO (500 - 100k) CON INTERPOLACIÓN AUTOMÁTICA CADA 500
precios = {
    500: "$69", 1000: "$129", 1500: "$200", 2000: "$279", 2500: "$315", 3000: "$351",
    3500: "$389", 4000: "$429", 4500: "$468", 5000: "$508", 5500: "$548", 6000: "$588",
    6500: "$627", 7000: "$667", 7500: "$707", 8000: "$746", 8500: "$786", 9000: "$826",
    9500: "$866", 10000: "$905", 10500: "$945", 11000: "$985", 11500: "$1,024", 12000: "$1,064",
    12500: "$1,104", 13000: "$1,144", 13500: "$1,183", 14000: "$1,223", 14500: "$1,263",
    15000: "$1,302", 15500: "$1,342", 16000: "$1,382", 16500: "$1,422", 17000: "$1,461",
    17500: "$1,501", 18000: "$1,541", 18500: "$1,580", 19000: "$1,620", 19500: "$1,660",
    20000: "$1,700", 20500: "$1,739", 21000: "$1,779", 21500: "$1,819", 22000: "$1,859",
    22500: "$1,898", 23000: "$1,938", 23500: "$1,978", 24000: "$2,017", 24500: "$2,057",
    25000: "$2,097", 25500: "$2,137", 26000: "$2,176", 26500: "$2,216", 27000: "$2,256",
    27500: "$2,295", 28000: "$2,335", 28500: "$2,375", 29000: "$2,415", 29500: "$2,454",
    30000: "$2,494", 30500: "$2,534", 31000: "$2,573", 31500: "$2,613", 32000: "$2,653",
    32500: "$2,693", 33000: "$2,732", 33500: "$2,772", 34000: "$2,812", 34500: "$2,851",
    35000: "$2,891", 35500: "$2,931", 36000: "$2,970", 36500: "$3,010", 37000: "$3,050",
    37500: "$3,090", 38000: "$3,129", 38500: "$3,169", 39000: "$3,209", 39500: "$3,248",
    40000: "$3,288", 40500: "$3,328", 41000: "$3,368", 41500: "$3,407", 42000: "$3,447",
    42500: "$3,487", 43000: "$3,526", 43500: "$3,566", 44000: "$3,606", 44500: "$3,646",
    45000: "$3,685", 45500: "$3,725", 46000: "$3,765", 46500: "$3,804", 47000: "$3,844",
    47500: "$3,884", 48000: "$3,924", 48500: "$3,963", 49000: "$4,003", 49500: "$4,043",
    50000: "$4,082", 50500: "$4,122", 51000: "$4,162", 51500: "$4,202", 52000: "$4,241",
    52500: "$4,281", 53000: "$4,321", 53500: "$4,360", 54000: "$4,400", 54500: "$4,440",
    55000: "$4,480", 55500: "$4,519", 56000: "$4,559", 56500: "$4,599", 57000: "$4,638",
    57500: "$4,678", 58000: "$4,718", 58500: "$4,758", 59000: "$4,797", 59500: "$4,837",
    60000: "$4,877", 60500: "$4,916", 61000: "$4,956", 61500: "$4,996", 62000: "$5,036",
    62500: "$5,075", 63000: "$5,115", 63500: "$5,155", 64000: "$5,194", 64500: "$5,234",
    65000: "$5,274", 65500: "$5,314", 66000: "$5,353", 66500: "$5,393", 67000: "$5,433",
    67500: "$5,472", 68000: "$5,512", 68500: "$5,552", 69000: "$5,592", 69500: "$5,631",
    70000: "$5,671", 70500: "$5,711", 71000: "$5,750", 71500: "$5,790", 72000: "$5,830",
    72500: "$5,870", 73000: "$5,909", 73500: "$5,949", 74000: "$5,989", 74500: "$6,028",
    75000: "$6,068", 75500: "$6,108", 76000: "$6,148", 76500: "$6,187", 77000: "$6,227",
    77500: "$6,267", 78000: "$6,306", 78500: "$6,346", 79000: "$6,386", 79500: "$6,426",
    80000: "$6,465", 80500: "$6,505", 81000: "$6,545", 81500: "$6,584", 82000: "$6,624",
    82500: "$6,664", 83000: "$6,704", 83500: "$6,743", 84000: "$6,783", 84500: "$6,823",
    85000: "$6,862", 85500: "$6,902", 86000: "$6,942", 86500: "$6,982", 87000: "$7,021",
    87500: "$7,061", 88000: "$7,101", 88500: "$7,140", 89000: "$7,180", 89500: "$7,220",
    90000: "$7,260", 90500: "$7,299", 91000: "$7,339", 91500: "$7,379", 92000: "$7,418",
    92500: "$7,458", 93000: "$7,498", 93500: "$7,538", 94000: "$7,577", 94500: "$7,617",
    95000: "$7,657", 95500: "$7,696", 96000: "$7,736", 96500: "$7,776", 97000: "$7,816",
    97500: "$7,855", 98000: "$7,895", 98500: "$7,935", 99000: "$7,974", 99500: "$8,014",
    100000: "$8,054"
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

class MostrarPreciosView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(label="📊 Mostrar Precios", style=discord.ButtonStyle.blurple)
    async def mostrar_precios(self, interaction: discord.Interaction, button: discord.ui.Button):
        # Diferir la respuesta para evitar timeout de Discord
        await interaction.response.defer(ephemeral=True)
        
        try:
            # MENSAJE 1: Paquetes Básicos, Estándar y Premium
            embed1 = discord.Embed(
                title="💰 LISTA DE PRECIOS - ROBUX (Parte 1)",
                description="Elige la cantidad que deseas comprar",
                color=0x8A2BE2
            )
            
            rangos1 = [
                (500, 2500, "⭐ Paquetes Básicos"),
                (2600, 5000, "✨ Paquetes Estándar"),
                (5100, 10000, "💎 Paquetes Premium"),
            ]
            
            for min_robux, max_robux, titulo in rangos1:
                precios_rango = {k: v for k, v in precios.items() if min_robux <= k <= max_robux}
                if precios_rango:
                    items = "\n".join([f"**{robux:,}** → {precio}" for robux, precio in sorted(precios_rango.items())])
                    embed1.add_field(name=titulo, value=items, inline=False)
            
            embed1.set_footer(text="Escribe el número de robux que deseas comprar")
            
            # Enviar primera parte
            await interaction.followup.send(embed=embed1, ephemeral=True)
            await asyncio.sleep(0.5)  # Pequeño delay para evitar problemas
            
            # MENSAJE 2: Paquetes Mega y Legendarios
            embed2 = discord.Embed(
                title="💰 LISTA DE PRECIOS - ROBUX (Parte 2)",
                description="Elige la cantidad que deseas comprar",
                color=0x8A2BE2
            )
            
            rangos2 = [
                (10500, 30000, "🔥 Paquetes Mega"),
                (35000, 100000, "👑 Paquetes Legendarios")
            ]
            
            for min_robux, max_robux, titulo in rangos2:
                precios_rango = {k: v for k, v in precios.items() if min_robux <= k <= max_robux}
                if precios_rango:
                    items = "\n".join([f"**{robux:,}** → {precio}" for robux, precio in sorted(precios_rango.items())])
                    embed2.add_field(name=titulo, value=items, inline=False)
            
            embed2.set_footer(text="Escribe el número de robux que deseas comprar")
            
            # Enviar segunda parte
            await interaction.followup.send(embed=embed2, ephemeral=True)
        except Exception as e:
            print(f"Error en mostrar_precios: {e}")
            await interaction.followup.send(content="❌ Error al mostrar los precios. Intenta de nuevo.", ephemeral=True)

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
        await interaction.response.send_message(
            "💰 **Escribe cuántos robux quieres comprar:** (Ejemplo: 1500)",
            view=MostrarPreciosView()
        )

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
        
        # Usar regex para extraer números incluso si hay texto alrededor
        # Detecta: "quiero 1500 robux", "dame 1,500", "1500", "1 500", etc.
        numero_match = re.search(r'\d+(?:[\s,]\d+)*', contenido)
        
        if not numero_match:
            await message.channel.send("❌ **Escribe un número válido.** (Ejemplo: 1500)")
            return
        
        # Extraer el número y limpiar comas y espacios
        numero_extraido = numero_match.group(0)
        contenido_limpio = numero_extraido.replace(',', '').replace(' ', '')
        
        try:
            monto_ingresado = int(contenido_limpio)
        except ValueError:
            await message.channel.send("❌ **Escribe un número válido.** (Ejemplo: 1500)")
            return
        
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