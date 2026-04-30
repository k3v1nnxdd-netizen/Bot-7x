import discord
from discord.ext import commands
import os
from dotenv import load_dotenv
import re
import asyncio
import unicodedata

# --- CONFIG ---
load_dotenv()
TOKEN = os.getenv("TOKEN")
OWNER_ID = 996310284803248158

intents = discord.Intents.default()
intents.message_content = True
intents.guilds = True

bot = commands.Bot(command_prefix="!", intents=intents)

# --- PRECIOS (recortado ejemplo, puedes pegar tu lista completa aquí sin comillas raras) ---
precios = {
    500: "$75", 1000: "$139", 1500: "$216", 2000: "$301", 2500: "$340",
    3000: "$377", 3500: "$420", 4000: "$463", 4500: "$599", 5000: "$625",
    5500: "$702", 6000: "$712", 6500: "$767", 7000: "$777", 7500: "$852",
    8000: "$928", 8500: "$992", 9000: "$1,057", 9500: "$1,176", 10000: "$1,295",
    10500: "$1,329", 11000: "$1,364", 11500: "$1,399", 12000: "$1,433", 12500: "$1,468",
    13000: "$1,502", 13500: "$1,537", 14000: "$1,571", 14500: "$1,606", 15000: "$1,641",
    15500: "$1,675", 16000: "$1,710", 16500: "$1,744", 17000: "$1,781", 17500: "$1,836",
    18000: "$1,891",
    18500: "$1,963", 19000: "$2,035", 19500: "$2,106", 20000: "$2,178", 20500: "$2,250",
    21000: "$2,322", 21500: "$2,393", 22000: "$2,465", 22500: "$2,537", 23000: "$2,609",
    23500: "$2,680", 24000: "$2,752", 24500: "$2,824", 25000: "$2,896", 25500: "$2,968",
    26000: "$3,039", 26500: "$3,111", 27000: "$3,183", 27500: "$3,255", 28000: "$3,326",
    28500: "$3,398", 29000: "$3,470", 29500: "$3,542", 30000: "$3,613", 30500: "$3,685",
    31000: "$3,757", 31500: "$3,829", 32000: "$3,901", 32500: "$3,972", 33000: "$4,044",
    33500: "$4,116", 34000: "$4,188", 34500: "$4,259", 35000: "$4,331", 35500: "$4,403",
    36000: "$4,475", 36500: "$4,546", 37000: "$4,618", 37500: "$4,690", 38000: "$4,762",
    38500: "$4,834", 39000: "$4,905", 39500: "$4,977", 40000: "$5,049", 40500: "$5,121",
    41000: "$5,192", 41500: "$5,264", 42000: "$5,336", 42500: "$5,408", 43000: "$5,479",
    43500: "$5,551", 44000: "$5,623", 44500: "$5,695", 45000: "$5,767", 45500: "$5,838",
    46000: "$5,910", 46500: "$5,982", 47000: "$6,054", 47500: "$6,125", 48000: "$6,197",
    48500: "$6,269", 49000: "$6,341", 49500: "$6,412", 50000: "$6,484",
    50500: "$6,556", 51000: "$6,632", 51500: "$6,709", 52000: "$6,785", 52500: "$6,862",
    53000: "$6,939", 53500: "$7,015", 54000: "$7,092", 54500: "$7,168", 55000: "$7,245",
    55500: "$7,304", 56000: "$7,362", 56500: "$7,420", 57000: "$7,479", 57500: "$7,538",
    58000: "$7,596", 58500: "$7,654", 59000: "$7,713", 59500: "$7,772", 60000: "$7,830",
    60500: "$7,902", 61000: "$7,974", 61500: "$8,046", 62000: "$8,118", 62500: "$8,190",
    63000: "$8,261", 63500: "$8,333", 64000: "$8,405", 64500: "$8,477", 65000: "$8,549",
    65500: "$8,621", 66000: "$8,693", 66500: "$8,765", 67000: "$8,837", 67500: "$8,910",
    68000: "$8,982", 68500: "$9,054", 69000: "$9,126", 69500: "$9,198", 70000: "$9,270",
    70500: "$9,342", 71000: "$9,414", 71500: "$9,486", 72000: "$9,558", 72500: "$9,630",
    73000: "$9,702", 73500: "$9,774", 74000: "$9,846", 74500: "$9,918", 75000: "$9,990",
    75500: "$10,033", 76000: "$10,076", 76500: "$10,120", 77000: "$10,163", 77500: "$10,206",
    78000: "$10,249", 78500: "$10,292", 79000: "$10,336", 79500: "$10,379", 80000: "$10,422",
    80500: "$10,503", 81000: "$10,584", 81500: "$10,665", 82000: "$10,746", 82500: "$10,827",
    83000: "$10,908", 83500: "$10,989", 84000: "$11,070", 84500: "$11,151", 85000: "$11,232",
    85500: "$11,313", 86000: "$11,394", 86500: "$11,475", 87000: "$11,556", 87500: "$11,637",
    88000: "$11,718", 88500: "$11,799", 89000: "$11,880", 89500: "$11,961", 90000: "$12,042",
    90500: "$12,123", 91000: "$12,204", 91500: "$12,285", 92000: "$12,366", 92500: "$12,447",
    93000: "$12,528", 93500: "$12,609", 94000: "$12,690", 94500: "$12,771", 95000: "$12,852",
    95500: "$12,867", 96000: "$12,881", 96500: "$12,896", 97000: "$12,911", 97500: "$12,926",
    98000: "$12,940", 98500: "$12,955", 99000: "$12,970", 99500: "$12,984", 100000: "$12,999"
}

CATEGORIAS = [
    (500, 2500, "Básicos"),
    (2501, 5000, "Estándar"),
    (5001, 10000, "Premium"),
    (10001, 50000, "Ultra"),
    (50001, 100000, "Legendarios"),
]

usuarios_esperando_monto = {}
usuarios_esperando_pago = set()
ticket_owner = {}

# --- UTILIDADES ---
def normalizar_texto(texto):
    texto = texto.lower()
    texto = unicodedata.normalize('NFD', texto).encode('ascii', 'ignore').decode('utf-8')
    texto = re.sub(r'[^\w\s]', '', texto)
    return texto.strip()

def es_pago_exitoso(texto):
    t = normalizar_texto(texto)
    return "pago" in t and "exito" in t

def dividir_bloques(lista, max_chars=900):
    bloques = []
    actual = ""
    for linea in lista:
        if len(actual) + len(linea) > max_chars:
            bloques.append(actual)
            actual = linea
        else:
            actual += linea
    if actual:
        bloques.append(actual)
    return bloques

# --- BOTÓN PRECIOS ---
class MostrarPreciosView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(label="📊 Mostrar precios", style=discord.ButtonStyle.blurple)
    async def mostrar(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer(ephemeral=True)

        try:
            await interaction.followup.send("Enviando precios...", ephemeral=True)

            for min_r, max_r, nombre in CATEGORIAS:
                lista = []
                for r, p in precios.items():
                    if min_r <= r <= max_r:
                        lista.append(f"**{r:,}** → {p}\n")

                bloques = dividir_bloques(lista)

                for bloque in bloques:
                    embed = discord.Embed(
                        title="💰 LISTA DE PRECIOS",
                        description=f"**{nombre}**",
                        color=0x8A2BE2
                    )
                    embed.add_field(name="Robux", value=bloque, inline=False)
                    await interaction.channel.send(embed=embed)
                    await asyncio.sleep(1)

        except Exception as e:
            print("ERROR PRECIOS:", e)

# --- BOTONES ---
class InicioTicketView(discord.ui.View):
    def __init__(self, user_id):
        super().__init__(timeout=None)
        self.user_id = user_id

    @discord.ui.button(label="Comprar Robux", style=discord.ButtonStyle.green)
    async def aceptar(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.user_id:
            return await interaction.response.send_message("No es tu botón", ephemeral=True)

        usuarios_esperando_monto[interaction.channel.id] = interaction.user.id
        await interaction.response.send_message(
            "💰 Escribe cuántos robux quieres comprar",
            view=MostrarPreciosView()
        )

# --- EVENTOS ---
@bot.event
async def on_message(message):
    await bot.process_commands(message)

    if message.author.bot:
        return

    if message.channel.id in usuarios_esperando_monto:
        if message.author.id != usuarios_esperando_monto[message.channel.id]:
            return

        texto = message.content
        match = re.search(r"\d+(?:[\s,]\d+)*", texto)

        if not match:
            await message.channel.send("Número inválido")
            return

        num = match.group(0).replace(",", "").replace(" ", "")
        monto = int(num)

        if monto not in precios:
            cercano = min(precios.keys(), key=lambda x: abs(x - monto))
            monto = cercano

        precio = precios[monto]

        usuarios_esperando_monto.pop(message.channel.id)
        usuarios_esperando_pago.add(message.channel.id)

        embed = discord.Embed(
            title="💳 Pago",
            description=f"{monto} Robux = {precio}",
            color=0x8A2BE2
        )

        await message.channel.send(embed=embed)

# --- COMANDO ---
@bot.command()
async def pagos(ctx):
    embed = discord.Embed(
        title="💳 Métodos de pago",
        description="Elige tu método",
        color=0x8A2BE2
    )
    embed.add_field(name="Transferencia", value="Datos bancarios", inline=False)
    embed.add_field(name="OXXO", value="Ver imagen", inline=False)
    embed.add_field(
        name="Gift Card",
        value="Compra aquí:\nhttps://www.eneba.com/eneba-eneba-gift-card-5-eur-global",
        inline=False
    )

    await ctx.send(embed=embed)

@bot.event
async def on_ready():
    print(f"Bot listo: {bot.user}")

bot.run(TOKEN)