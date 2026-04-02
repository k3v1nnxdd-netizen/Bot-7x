import discord
from discord.ext import commands
import os
from dotenv import load_dotenv
import asyncio

# Cargar token desde Railway / .env
load_dotenv()
TOKEN = os.getenv("TOKEN")

# Intents necesarios
intents = discord.Intents.default()
intents.guilds = True

bot = commands.Bot(command_prefix="!", intents=intents)

@bot.event
async def on_ready():
    print(f"Bot activo como {bot.user}")

# Evento cuando se crea un canal (ticket)
@bot.event
async def on_guild_channel_create(channel):
    await asyncio.sleep(2)  # Espera a que el canal esté listo

    if isinstance(channel, discord.TextChannel):

        # SOLO si está en la categoría ✮
        if channel.category and channel.category.name == "✮":

            await channel.send(f"""
👋 **Bienvenido a tu ticket**

💰 **MÉTODOS DE PAGO**

🏦 **TRANSFERENCIA**

**CUENTA 1:**

722969040869278041

MERCADO PAGO  
VICENTA MARIANO VALDOVINOS  

**CUENTA 2:**

721180100042646712

ALBO  
Hector Altamirano Gonzalez  

🏪 **DEPÓSITO OXXO:**
https://cdn.discordapp.com/attachments/1464133748923695199/1464371847201292574/0273176f-3966-4d09-a18e-15abac4a5cbb.jpg

📩 **PASOS:**
1. Indica cuántos Robux quieres  
2. Envía tu usuario de Roblox  
3. Realiza el pago  
4. Envía el comprobante  

⚡ **Entrega rápida:** tus Robux serán enviados lo antes posible 🚀
""")

# Ejecutar bot
bot.run(TOKEN)