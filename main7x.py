import discord
from discord.ext import commands
import os
from dotenv import load_dotenv
import asyncio

# 🔑 TOKEN
load_dotenv()
TOKEN = os.getenv("TOKEN")

# ⚙️ INTENTS
intents = discord.Intents.default()
intents.message_content = True
intents.guilds = True

# 🤖 BOT
bot = commands.Bot(command_prefix="!", intents=intents)

@bot.event
async def on_ready():
    print(f"Bot activo como {bot.user}")

# 🔍 DEBUG DE TICKET TOOL
@bot.event
async def on_message(message):
    if message.author.bot:

        await asyncio.sleep(1)

        print("======== MENSAJE DETECTADO ========")
        print("CANAL:", message.channel.name)

        if message.embeds:
            embed = message.embeds[0]

            print("TITULO:", embed.title)
            print("DESCRIPCION:", embed.description)

            for field in embed.fields:
                print("FIELD:", field.name)
                print("VALOR:", field.value)
                print("------")

        else:
            print("NO ES EMBED, TEXTO:", message.content)

        print("===================================")

    await bot.process_commands(message)

# 🚀 RUN
bot.run(TOKEN)