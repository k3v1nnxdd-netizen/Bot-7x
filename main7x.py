import discord
from discord.ext import commands
import os
from dotenv import load_dotenv
import re
import asyncio
import unicodedata

# — CONFIGURACION —

load_dotenv()
TOKEN = os.getenv(“TOKEN”)
OWNER_ID = 996310284803248158

intents = discord.Intents.default()
intents.message_content = True
intents.guilds = True

bot = commands.Bot(command_prefix=”!”, intents=intents)

# DICCIONARIO DE PRECIOS COMPLETO (500 - 100k)

precios = {
500: “$75”, 1000: “$139”, 1500: “$216”, 2000: “$301”, 2500: “$340”,
3000: “$377”, 3500: “$420”, 4000: “$463”, 4500: “$599”, 5000: “$625”,
5500: “$702”, 6000: “$712”, 6500: “$767”, 7000: “$777”, 7500: “$852”,
8000: “$928”, 8500: “$992”, 9000: “$1,057”, 9500: “$1,176”, 10000: “$1,295”,
10500: “$1,329”, 11000: “$1,364”, 11500: “$1,399”, 12000: “$1,433”, 12500: “$1,468”,
13000: “$1,502”, 13500: “$1,537”, 14000: “$1,571”, 14500: “$1,606”, 15000: “$1,641”,
15500: “$1,675”, 16000: “$1,710”, 16500: “$1,744”, 17000: “$1,781”, 17500: “$1,836”,
18000: “$1,891”,
18500: “$1,963”, 19000: “$2,035”, 19500: “$2,106”, 20000: “$2,178”, 20500: “$2,250”,
21000: “$2,322”, 21500: “$2,393”, 22000: “$2,465”, 22500: “$2,537”, 23000: “$2,609”,
23500: “$2,680”, 24000: “$2,752”, 24500: “$2,824”, 25000: “$2,896”, 25500: “$2,968”,
26000: “$3,039”, 26500: “$3,111”, 27000: “$3,183”, 27500: “$3,255”, 28000: “$3,326”,
28500: “$3,398”, 29000: “$3,470”, 29500: “$3,542”, 30000: “$3,613”, 30500: “$3,685”,
31000: “$3,757”, 31500: “$3,829”, 32000: “$3,901”, 32500: “$3,972”, 33000: “$4,044”,
33500: “$4,116”, 34000: “$4,188”, 34500: “$4,259”, 35000: “$4,331”, 35500: “$4,403”,
36000: “$4,475”, 36500: “$4,546”, 37000: “$4,618”, 37500: “$4,690”, 38000: “$4,762”,
38500: “$4,834”, 39000: “$4,905”, 39500: “$4,977”, 40000: “$5,049”, 40500: “$5,121”,
41000: “$5,192”, 41500: “$5,264”, 42000: “$5,336”, 42500: “$5,408”, 43000: “$5,479”,
43500: “$5,551”, 44000: “$5,623”, 44500: “$5,695”, 45000: “$5,767”, 45500: “$5,838”,
46000: “$5,910”, 46500: “$5,982”, 47000: “$6,054”, 47500: “$6,125”, 48000: “$6,197”,
48500: “$6,269”, 49000: “$6,341”, 49500: “$6,412”, 50000: “$6,484”,
50500: “$6,556”, 51000: “$6,632”, 51500: “$6,709”, 52000: “$6,785”, 52500: “$6,862”,
53000: “$6,939”, 53500: “$7,015”, 54000: “$7,092”, 54500: “$7,168”, 55000: “$7,245”,
55500: “$7,304”, 56000: “$7,362”, 56500: “$7,420”, 57000: “$7,479”, 57500: “$7,538”,
58000: “$7,596”, 58500: “$7,654”, 59000: “$7,713”, 59500: “$7,772”, 60000: “$7,830”,
60500: “$7,902”, 61000: “$7,974”, 61500: “$8,046”, 62000: “$8,118”, 62500: “$8,190”,
63000: “$8,261”, 63500: “$8,333”, 64000: “$8,405”, 64500: “$8,477”, 65000: “$8,549”,
65500: “$8,621”, 66000: “$8,693”, 66500: “$8,765”, 67000: “$8,837”, 67500: “$8,910”,
68000: “$8,982”, 68500: “$9,054”, 69000: “$9,126”, 69500: “$9,198”, 70000: “$9,270”,
70500: “$9,342”, 71000: “$9,414”, 71500: “$9,486”, 72000: “$9,558”, 72500: “$9,630”,
73000: “$9,702”, 73500: “$9,774”, 74000: “$9,846”, 74500: “$9,918”, 75000: “$9,990”,
75500: “$10,033”, 76000: “$10,076”, 76500: “$10,120”, 77000: “$10,163”, 77500: “$10,206”,
78000: “$10,249”, 78500: “$10,292”, 79000: “$10,336”, 79500: “$10,379”, 80000: “$10,422”,
80500: “$10,503”, 81000: “$10,584”, 81500: “$10,665”, 82000: “$10,746”, 82500: “$10,827”,
83000: “$10,908”, 83500: “$10,989”, 84000: “$11,070”, 84500: “$11,151”, 85000: “$11,232”,
85500: “$11,313”, 86000: “$11,394”, 86500: “$11,475”, 87000: “$11,556”, 87500: “$11,637”,
88000: “$11,718”, 88500: “$11,799”, 89000: “$11,880”, 89500: “$11,961”, 90000: “$12,042”,
90500: “$12,123”, 91000: “$12,204”, 91500: “$12,285”, 92000: “$12,366”, 92500: “$12,447”,
93000: “$12,528”, 93500: “$12,609”, 94000: “$12,690”, 94500: “$12,771”, 95000: “$12,852”,
95500: “$12,867”, 96000: “$12,881”, 96500: “$12,896”, 97000: “$12,911”, 97500: “$12,926”,
98000: “$12,940”, 98500: “$12,955”, 99000: “$12,970”, 99500: “$12,984”, 100000: “$12,999”
}

# FIX #6: Categorias sin gaps — 18001-50000 ahora en “Paquetes Ultra”

CATEGORIAS = [
(500,   2500,  “Paquetes Basicos”),
(2501,  5000,  “Paquetes Estandar”),
(5001,  10000, “Paquetes Premium”),
(10001, 18000, “Paquetes Mega”),
(18001, 50000, “Paquetes Ultra”),
(50001, 100000,“Paquetes Legendarios”),
]

usuarios_esperando_monto = {}  # channel_id: user_id
usuarios_esperando_pago = set()  # channel_id
ticket_owner = {}  # channel_id: user_id

def normalizar_texto(texto):
texto = texto.lower()
texto = unicodedata.normalize(“NFD”, texto).encode(“ascii”, “ignore”).decode(“utf-8”)
texto = re.sub(r”[^\w\s]”, “”, texto)
return texto.strip()

# FIX #4: Dividir en bloques de max 900 chars para respetar limite de Discord (1024)

def dividir_precios_en_bloques(precios_dict, max_chars=900):
if not precios_dict:
return []
bloques = []
bloque_actual = “”
for robux, precio in sorted(precios_dict.items()):
linea = f”**{robux:,}** -> {precio}\n”
if len(bloque_actual) + len(linea) > max_chars and bloque_actual:
bloques.append(bloque_actual.strip())
bloque_actual = linea
else:
bloque_actual += linea
if bloque_actual:
bloques.append(bloque_actual.strip())
return bloques

def agregar_campos_con_limite(embed, titulo_base, bloques_list):
if not bloques_list:
return
for i, bloque in enumerate(bloques_list, 1):
titulo = f”{titulo_base} ({i})” if len(bloques_list) > 1 else titulo_base
# Safety check: never exceed Discord’s 1024 char field limit
if len(bloque) > 1024:
bloque = bloque[:1020] + “…”
embed.add_field(name=titulo, value=bloque, inline=False)

def es_pago_exitoso(texto):
normalizado = normalizar_texto(texto)
contiene_pago = “pago” in normalizado
contiene_exitoso = any(
word in normalizado
for word in [“exitoso”, “exitozo”, “exitosa”, “exitoza”, “fue exitoso”, “fue exitosa”]
)
return contiene_pago and contiene_exitoso

# — VISTAS (BOTONES) —

class MostrarPreciosView(discord.ui.View):
def **init**(self):
super().**init**(timeout=None)

```
@discord.ui.button(label="Mostrar Precios", style=discord.ButtonStyle.blurple)
async def mostrar_precios(self, interaction: discord.Interaction, button: discord.ui.Button):
    # FIX #7: defer primero, luego followup para evitar "Interaction Failed"
    await interaction.response.defer(ephemeral=True)

    try:
        await interaction.followup.send(
            content="Enviando lista de precios en el chat...", ephemeral=True
        )

        # FIX #5 + #6: Una sola categoria = un solo embed con sus campos divididos
        # Esto reduce el numero de mensajes enviados drasticamente
        for min_r, max_r, titulo in CATEGORIAS:
            precios_rango = {k: v for k, v in precios.items() if min_r <= k <= max_r}
            if not precios_rango:
                continue

            bloques = dividir_precios_en_bloques(precios_rango, max_chars=900)

            # Si hay muchos bloques, los distribuimos en embeds de max 5 campos cada uno
            # para no exceder el limite de 6000 chars por embed
            campos_por_embed = 5
            for chunk_start in range(0, len(bloques), campos_por_embed):
                chunk = bloques[chunk_start:chunk_start + campos_por_embed]
                embed = discord.Embed(
                    title="LISTA DE PRECIOS - ROBUX",
                    description=f"**{titulo}**",
                    color=0x8A2BE2
                )
                for i, bloque in enumerate(chunk, chunk_start + 1):
                    campo_titulo = f"{titulo} ({i})" if len(bloques) > 1 else titulo
                    embed.add_field(name=campo_titulo, value=bloque, inline=False)
                embed.set_footer(text="Escribe el numero de robux que deseas comprar")
                await interaction.channel.send(embed=embed)
                # FIX #5: Pausa entre mensajes para evitar rate-limit spam
                await asyncio.sleep(1)

    except Exception as e:
        print(f"Error en mostrar_precios: {e}")
```

class PagoConfirmadoView(discord.ui.View):
def **init**(self, user_id):
super().**init**(timeout=None)
self.user_id = user_id

```
@discord.ui.button(label="PAGO REALIZADO (SOLO OWNER)", style=discord.ButtonStyle.green)
async def confirmar_pago(self, interaction: discord.Interaction, button: discord.ui.Button):
    if interaction.user.id != OWNER_ID:
        return await interaction.response.send_message(
            "No tienes permiso para usar este boton.", ephemeral=True
        )

    embed = discord.Embed(
        title="PAGO EXITOSO",
        description=(
            f"<@{self.user_id}>, tus robux han sido enviados correctamente.\n\n"
            "Por favor, deja tu referencia en <#1452939436525617293>"
        ),
        color=0x8A2BE2
    )
    embed.set_image(
        url="https://media.discordapp.net/attachments/1468842385420320960/1468842408614826077/Robux_Enviados.png"
    )
    await interaction.response.send_message(embed=embed)

    minutos_restantes = 15
    mensaje_cierre = await interaction.channel.send(
        f"<@{self.user_id}>, Este ticket se cerrara automaticamente en **{minutos_restantes} minutos**..."
    )

    while minutos_restantes > 0:
        await asyncio.sleep(60)
        minutos_restantes -= 1
        if minutos_restantes > 0:
            try:
                await mensaje_cierre.edit(
                    content=f"<@{self.user_id}>, Este ticket se cerrara automaticamente en **{minutos_restantes} minutos**..."
                )
            except Exception:
                break
        else:
            break

    try:
        await interaction.channel.delete()
    except Exception:
        pass
```

class InicioTicketView(discord.ui.View):
def **init**(self, user_id):
super().**init**(timeout=None)
self.user_id = user_id

```
@discord.ui.button(label="Si, quiero Robux", style=discord.ButtonStyle.green)
async def aceptar(self, interaction: discord.Interaction, button: discord.ui.Button):
    if interaction.user.id != self.user_id:
        return await interaction.response.send_message(
            "Este boton no es para ti.", ephemeral=True
        )

    await interaction.message.delete()
    # FIX #8: Usar channel.id como clave para compatibilidad con multiples tickets
    usuarios_esperando_monto[interaction.channel.id] = interaction.user.id
    await interaction.response.send_message(
        "**Escribe cuantos robux quieres comprar:** (Ejemplo: 1500)",
        view=MostrarPreciosView()
    )

@discord.ui.button(label="No, otro motivo", style=discord.ButtonStyle.red)
async def rechazar(self, interaction: discord.Interaction, button: discord.ui.Button):
    if interaction.user.id != self.user_id:
        return await interaction.response.send_message(
            "Este boton no es para ti.", ephemeral=True
        )

    await interaction.message.delete()
    await interaction.response.send_message(
        "Entendido. Un moderador teatendera en un momento para resolver tus dudas."
    )
```

# — EVENTOS —

@bot.event
async def on_message(message):
await bot.process_commands(message)

```
if message.author.bot:
    if "ticket tool" in message.author.name.lower() and "bienvenido" in message.content.lower():
        match = re.search(r"<@(\d+)>", message.content)
        if match:
            user_id = int(match.group(1))
            ticket_owner[message.channel.id] = user_id
            await message.channel.send(
                f"Hola <@{user_id}>, vienes a comprar Robux baratos?",
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
        return

    contenido = message.content.strip()
    numero_match = re.search(r"\d+(?:[\s,]\d+)*", contenido)

    if not numero_match:
        await message.channel.send("**Escribe un numero valido.** (Ejemplo: 1500)")
        return

    numero_extraido = numero_match.group(0)
    contenido_limpio = numero_extraido.replace(",", "").replace(" ", "")

    try:
        monto_ingresado = int(contenido_limpio)
    except ValueError:
        await message.channel.send("**Escribe un numero valido.** (Ejemplo: 1500)")
        return

    monto_final = monto_ingresado

    if monto_ingresado not in precios:
        cercano = min(precios.keys(), key=lambda x: abs(x - monto_ingresado))
        diferencia = abs(cercano - monto_ingresado)
        if diferencia <= 15 or diferencia <= (cercano * 0.05):
            await message.channel.send(
                f"El monto **{monto_ingresado}** no esta en lista. Redondeando a la oferta de **{cercano} robux**."
            )
            monto_final = cercano
        else:
            await message.channel.send(
                "**Monto invalido.** Por favor elige una cantidad de nuestra lista de precios."
            )
            return

    precio_texto = precios[monto_final]
    usuarios_esperando_monto.pop(message.channel.id)
    usuarios_esperando_pago.add(message.channel.id)

    embed_pago = discord.Embed(
        title="INFORMACION DE PAGO",
        description=f"Has seleccionado: **{monto_final} Robux**\nTotal a pagar: **{precio_texto} MXN**",
        color=0x8A2BE2
    )
    embed_pago.add_field(
        name="TRANSFERENCIA",
        value=(
            "**CUENTA 1:**\n```722969040869278041```\n"
            "**MERCADO PAGO**\nVICENTA MARIANO VALDOVINOS\n\n"
            "**CUENTA 2:**\n```721180100042646712```\n"
            "**ALBO**\nHECTOR ALTAMIRANO GONZALEZ"
        ),
        inline=False
    )
    embed_pago.add_field(
        name="DEPOSITO OXXO",
        value="Ver imagen adjunta",
        inline=False
    )

    canal_metodos = bot.get_channel(1494475415597744360)
    mencion_canal = canal_metodos.mention if canal_metodos else "<#1494475415597744360>"
    embed_pago.add_field(
        name="OTROS METODOS DE PAGO",
        value=f"Consulta {mencion_canal}",
        inline=False
    )

    instrucciones = discord.Embed(
        title="SIGUIENTES PASOS",
        description=(
            "1. Realiza el pago por el monto exacto.\n"
            "2. Envia la **FOTO DEL COMPROBANTE** aqui mismo.\n"
            "3. Escribe **PAGO EXITOSO** para confirmar."
        ),
        color=0xFFA500
    )

    embed_pago.set_image(url="attachment://oxxo.jpg")

    # FIX #8: Usar ticket_owner con channel.id, con fallback seguro
    owner_id = ticket_owner.get(message.channel.id, message.author.id)

    await message.channel.send(embed=embed_pago, file=discord.File("oxxo.jpg"))
    await message.channel.send(embed=instrucciones, view=PagoConfirmadoView(owner_id))
    return

# --- FASE 2: PAGO EXITOSO ---
if message.channel.id in usuarios_esperando_pago:
    owner_id = ticket_owner.get(message.channel.id)
    if owner_id and message.author.id != owner_id:
        return

    if es_pago_exitoso(message.content):
        embed_staff = discord.Embed(
            title="PAGO EN REVISION",
            description="Gracias. Tu comprobante ha sido enviado al staff.\nEn unos momentos recibiras tus Robux.",
            color=0x00FF00
        )
        await message.channel.send(embed=embed_staff)
        try:
            await message.channel.edit(name=f"pago-{message.author.name}")
        except Exception:
            pass
        usuarios_esperando_pago.discard(message.channel.id)
    else:
        await message.channel.send(
            content=(
                f"<@{message.author.id}>, por favor realiza el pago, "
                "manda el comprobante y escribe **PAGO EXITOSO** para confirmar."
            )
        )
    return
```

@bot.event
async def on_ready():
print(f”Bot conectado como {bot.user}”)
# FIX #3: Removido bot.tree.clear_commands() — causaba errores y no es necesario
await bot.tree.sync()
print(“Comandos sincronizados”)

@bot.command(name=“pagos”)
async def pagos(ctx):
“”“Muestra todos los metodos de pago disponibles”””
embed_pagos = discord.Embed(
title=“INFORMACION DE PAGO”,
description=“Elige tu metodo de pago y completa tu compra de forma segura.”,
color=0x8A2BE2
)
embed_pagos.add_field(
name=“TRANSFERENCIA”,
value=(
“**CUENTA 1:**\n`722969040869278041`\n”
“**MERCADO PAGO**\nVICENTA MARIANO VALDOVINOS\n\n”
“**CUENTA 2:**\n`721180100042646712`\n”
“**ALBO**\nHECTOR ALTAMIRANO GONZALEZ”
),
inline=False
)
embed_pagos.add_field(
name=“DEPOSITO OXXO”,
value=“Ver imagen adjunta”,
inline=False
)
embed_pagos.add_field(
name=“GIFT CARD”,
value=(
“Paga facilmente con Gift Cards disponibles para todos los paises.\n”
“Selecciona el valor segun el monto de Robux que deseas comprar.\n\n”
“[Comprar Gift Card](https://www.eneba.com/eneba-eneba-gift-card-5-eur-global)”
),
inline=False
)
embed_pagos.set_image(url=“attachment://oxxo.jpg”)
await ctx.send(embed=embed_pagos, file=discord.File(“oxxo.jpg”))

bot.run(TOKEN)