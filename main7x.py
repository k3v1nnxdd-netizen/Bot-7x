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

# 💰 DICCIONARIO DE PRECIOS COMPLETO
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

usuarios_esperando_monto = {}
usuarios_esperando_pago = set()
ticket_owner = {}

# --- FUNCIONES DE UTILIDAD ---

def normalizar_texto(texto):
    """Limpia el texto de acentos, mayúsculas y signos."""
    texto = texto.lower()
    texto = unicodedata.normalize('NFD', texto).encode('ascii', 'ignore').decode('utf-8')
    texto = re.sub(r'[^\w\s]', '', texto)
    return texto.strip()

def es_pago_exitoso(texto):
    normalizado = normalizar_texto(texto)
    contiene_pago = 'pago' in normalizado
    palabras_exito = ['exitoso', 'exitozo', 'exitosa', 'exitoza', 'hecho', 'enviado', 'listo']
    contiene_exitoso = any(word in normalizado for word in palabras_exito)
    return contiene_pago and contiene_exitoso

def dividir_precios_en_bloques(precios_dict, max_chars=900):
    if not precios_dict: return []
    bloques, bloque_actual = [], ""
    for robux, precio in sorted(precios_dict.items()):
        linea = f"**{robux:,}** → {precio}\n"
        if len(bloque_actual) + len(linea) > max_chars:
            bloques.append(bloque_actual.strip())
            bloque_actual = linea
        else:
            bloque_actual += linea
    if bloque_actual: bloques.append(bloque_actual.strip())
    return bloques

def agregar_campos_con_limite(embed, titulo_base, bloques_list):
    if not bloques_list: return
    for i, bloque in enumerate(bloques_list, 1):
        titulo = f"{titulo_base} ({i})" if len(bloques_list) > 1 else titulo_base
        embed.add_field(name=titulo, value=bloque, inline=False)

# --- VISTAS ---

class MostrarPreciosView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(label="📊 Mostrar Precios", style=discord.ButtonStyle.blurple)
    async def mostrar_precios(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer(ephemeral=True)
        try:
            # PARTE 1
            embed1 = discord.Embed(title="💰 LISTA DE PRECIOS - PARTE 1", color=0x8A2BE2)
            rangos1 = [(500, 2500, "⭐ Paquetes Básicos"), (2600, 5000, "✨ Paquetes Estándar"), (5100, 10000, "💎 Paquetes Premium")]
            for mi, ma, t in rangos1:
                p_r = {k: v for k, v in precios.items() if mi <= k <= ma}
                agregar_campos_con_limite(embed1, t, dividir_precios_en_bloques(p_r))
            
            # PARTE 2
            embed2 = discord.Embed(title="💰 LISTA DE PRECIOS - PARTE 2", color=0x8A2BE2)
            rangos2 = [(10500, 30000, "🔥 Paquetes Mega"), (35000, 100000, "👑 Paquetes Legendarios")]
            for mi, ma, t in rangos2:
                p_r = {k: v for k, v in precios.items() if mi <= k <= ma}
                agregar_campos_con_limite(embed2, t, dividir_precios_en_bloques(p_r))

            await interaction.followup.send(embed=embed1, ephemeral=True)
            await interaction.followup.send(embed=embed2, ephemeral=True)
        except Exception as e:
            print(f"Error: {e}")
            await interaction.followup.send("❌ Error al mostrar precios.", ephemeral=True)

class PagoConfirmadoView(discord.ui.View):
    def __init__(self, user_id):
        super().__init__(timeout=None)
        self.user_id = user_id

    @discord.ui.button(label="✅ PAGO REALIZADO (SOLO OWNER)", style=discord.ButtonStyle.green)
    async def confirmar_pago(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != OWNER_ID:
            return await interaction.response.send_message("❌ Solo el dueño puede usar esto.", ephemeral=True)

        embed = discord.Embed(title="✅ PAGO EXITOSO", description=f"<@{self.user_id}>, Robux enviados. Deja tu referencia en <#1452939436525617293>", color=0x00FF00)
        await interaction.response.send_message(embed=embed)
        
        for i in range(15, 0, -1):
            await asyncio.sleep(60)
            # Aquí podrías editar un mensaje de aviso si quisieras

        try: await interaction.channel.delete()
        except: pass

class InicioTicketView(discord.ui.View):
    def __init__(self, user_id):
        super().__init__(timeout=None)
        self.user_id = user_id

    @discord.ui.button(label="Sí, quiero Robux", style=discord.ButtonStyle.green)
    async def aceptar(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.user_id: return
        await interaction.message.delete()
        usuarios_esperando_monto[interaction.channel.id] = interaction.user.id
        await interaction.response.send_message("💰 **Escribe cuántos robux quieres:**", view=MostrarPreciosView())

    @discord.ui.button(label="No, otro motivo", style=discord.ButtonStyle.red)
    async def rechazar(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.user_id: return
        await interaction.message.delete()
        await interaction.response.send_message("🛠️ Un moderador te atenderá pronto.")

# --- EVENTOS ---

@bot.event
async def on_message(message):
    if message.author.bot:
        if "ticket tool" in message.author.name.lower() and "bienvenido" in message.content.lower():
            match = re.search(r"<@(\d+)>", message.content)
            if match:
                uid = int(match.group(1))
                ticket_owner[message.channel.id] = uid
                await message.channel.send(f"Hola <@{uid}> 👋, ¿vienes a comprar Robux?", view=InicioTicketView(uid))
        return

    await bot.process_commands(message)

    if message.channel.id in usuarios_esperando_monto and message.author.id == usuarios_esperando_monto[message.channel.id]:
        match = re.search(r'\d+', message.content.replace(',', '').replace(' ', ''))
        if not match: return
        
        monto = int(match.group(0))
        if monto not in precios:
            cercano = min(precios.keys(), key=lambda x: abs(x - monto))
            await message.channel.send(f"⚠️ Redondeando a la oferta de **{cercano} robux**.")
            monto = cercano

        usuarios_esperando_monto.pop(message.channel.id)
        usuarios_esperando_pago.add(message.channel.id)

        emb = discord.Embed(title="💳 PAGO", description=f"Monto: **{monto}**\nPrecio: **{precios[monto]} MXN**", color=0x8A2BE2)
        emb.add_field(name="Cuentas", value="`722969040869278041` (MP)\n`721180100042646712` (Albo)")
        
        # Nota: Asegúrate de que 'oxxo.jpg' existe en la carpeta del bot
        try:
            await message.channel.send(embed=emb, file=discord.File('oxxo.jpg'), view=PagoConfirmadoView(message.author.id))
        except:
            await message.channel.send(embed=emb, view=PagoConfirmadoView(message.author.id))

    elif message.channel.id in usuarios_esperando_pago and message.author.id == ticket_owner.get(message.channel.id):
        if es_pago_exitoso(message.content):
            await message.channel.send("🚀 **Pago en revisión por el Staff...**")
            usuarios_esperando_pago.remove(message.channel.id)

@bot.event
async def on_ready():
    print(f"✅ {bot.user} online")

bot.run(TOKEN)