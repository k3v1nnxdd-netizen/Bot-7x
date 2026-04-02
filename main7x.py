import discord
from discord.ext import commands
import os
from dotenv import load_dotenv
import asyncio

load_dotenv()
TOKEN = os.getenv("TOKEN")

intents = discord.Intents.default()
intents.message_content = True
intents.guilds = True

# 🔥 CREAR BOT
bot = commands.Bot(command_prefix="!", intents=intents)

# 📊 PRECIOS
precios = {
    500: "$69",
    1000: "$129",
    1500: "$200",
    2000: "$279",
    2500: "$315",
    3000: "$349",
    3500: "$389",
    4000: "$429",
    4500: "$505",
    5000: "$579",
    10000: "$1,199",
    15000: "$1,450",
    17000: "$1,649",
    20000: "$1,950",
    25000: "$2,450",
    30000: "$2,999",
    35000: "$3,750",
    40000: "$4,500",
    45000: "$5,250",
    50000: "$5,999",
    50500: "$6,070",
    55000: "$6,610",
    60000: "$7,215",
    65000: "$7,820",
    70000: "$8,425",
    75000: "$9,030",
    80000: "$9,635",
    85000: "$10,240",
    90000: "$10,845",
    95000: "$11,450",
    100000: "$12,999"
}

@bot.event
async def on_ready():
    print(f"Bot activo como {bot.user}")

@bot.event
async def on_message(message):
    if message.author.bot:

        # ⏳ Espera para asegurar que el embed cargue
        await asyncio.sleep(1)

        if message.embeds:

            embed = message.embeds[0]

            # 🎯 SOLO categoría ✮
            if message.channel.category and "✮" in message.channel.category.name:

                for field in embed.fields:
                    nombre = field.name.lower().replace("*", "").strip()

                    print("Campo detectado:", nombre, "| Valor:", field.value)

                    if "cuantos robux quieres comprar" in nombre:

                        try:
                            cantidad = int(field.value.replace(",", "").strip())

                            if cantidad in precios:
                                precio = precios[cantidad]

                                embed_msg = discord.Embed(
                                    title="💰 Compra detectada",
                                    description=f"**Robux:** {cantidad}\n**Precio:** {precio} MXN",
                                    color=0x8A2BE2
                                )

                                # 🖼️ Imagen principal
                                embed_msg.set_image(
                                    url="https://media.discordapp.net/attachments/1468842385420320960/1468844898793947279/metodos_pago.png"
                                )

                                # 🏦 Transferencia
                                embed_msg.add_field(
                                    name="🏦 TRANSFERENCIA",
                                    value=(
                                        "**CUENTA 1:**\n"
                                        "```722969040869278041```\n"
                                        "MERCADO PAGO\n"
                                        "VICENTA MARIANO VALDOVINOS\n\n"
                                        "**CUENTA 2:**\n"
                                        "```721180100042646712```\n"
                                        "ALBO\n"
                                        "Hector Altamirano Gonzalez"
                                    ),
                                    inline=False
                                )

                                # 🏪 OXXO
                                embed_msg.add_field(
                                    name="🏪 DEPÓSITO OXXO",
                                    value="https://cdn.discordapp.com/attachments/1464133748923695199/1464371847201292574/0273176f-3966-4d09-a18e-15abac4a5cbb.jpg",
                                    inline=False
                                )

                                # 📩 PASOS
                                embed_msg.add_field(
                                    name="📩 PASOS",
                                    value=(
                                        "1. Realiza el pago\n"
                                        "2. Envía tu comprobante de pago\n"
                                        "3. Tus Robux serán enviados en menos de 24 Hrs 🚀"
                                    ),
                                    inline=False
                                )

                                await message.channel.send(embed=embed_msg)

                        except Exception as e:
                            print("Error:", e)

    await bot.process_commands(message)

bot.run(TOKEN)