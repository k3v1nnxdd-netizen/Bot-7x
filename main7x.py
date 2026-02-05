import discord
from discord.ext import commands
from dotenv import load_dotenv
import os

# 🔐 Cargar token
load_dotenv()
TOKEN = os.getenv("TOKEN")

# ⚠️ PEGA TU SERVER ID AQUÍ (sin comillas)
GUILD_ID = 1162602588328435802

intents = discord.Intents.default()
bot = commands.Bot(command_prefix="!", intents=intents)


# 🚀 Evento cuando el bot prende
@bot.event
async def on_ready():
    print(f'🔥 Bot conectado como {bot.user}')

    try:
        guild = discord.Object(id=GUILD_ID)

        # 🔥 sincroniza SOLO en tu server (instantáneo)
        synced = await bot.tree.sync(guild=guild)

        print(f'✅ {len(synced)} comandos sincronizados al instante')

    except Exception as e:
        print(e)


# 💳 COMANDO /mp
@bot.tree.command(
    name="mp",
    description="Muestra los métodos de pago",
    guild=discord.Object(id=GUILD_ID)  # ⚡ instantáneo
)
async def mp(interaction: discord.Interaction):

    await interaction.response.defer()

    embed = discord.Embed(
        title="💳 Métodos de Pago",
        description="""
**Transferencia - 721180100042646712**  
Hector Altamirano Gonzales  
Banco: ALBO  

**PayPal**  
https://www.paypal.com/paypalme/kewuinsitove  

<a:arrow_arrow:1190501694350557185> **Es necesario enviar una captura del comprobante de pago con el Usuario Correcto de Roblox al que recibirá los Robux!**
        """,
        color=discord.Color(0x9B59B6)
    )

    embed.set_image(
        url="https://cdn.discordapp.com/attachments/1468842385420320960/1468844898793947279/metodos_pago.png"
    )

    embed.set_footer(text="Sistema automático de pagos")

    await interaction.followup.send(embed=embed)



# ✅ COMANDO /pagoex
@bot.tree.command(
    name="pagoex",
    description="Confirma un pago exitoso",
    guild=discord.Object(id=GUILD_ID)
)
async def pagoex(interaction: discord.Interaction):

    await interaction.response.defer()

    embed = discord.Embed(
        title="✅ Pago Exitoso",
        description="""
**Tu Pago fue Exitoso y ya han sido enviados tus Robux!** <a:shop:1190502129748676650>  

Acabas de recibir el rol <@&1468776275580817408>  

Ayúdanos dejando una referencia con una captura de tus robux en el canal <#1452939436525617293>  

🔥 **Disfruta tus Robux!**
        """,
        color=discord.Color(0x9B59B6)
    )

    embed.set_image(
        url="https://cdn.discordapp.com/attachments/1468842385420320960/1468842408614826077/Robux_Enviados.png"
    )

    embed.set_footer(text="Gracias por tu compra 🚀")

    await interaction.followup.send(embed=embed)



# 🔥 Encender bot
bot.run(TOKEN)
