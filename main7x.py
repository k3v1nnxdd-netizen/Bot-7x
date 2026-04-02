@bot.event
async def on_message(message):
    if message.author.bot and message.embeds:

        embed = message.embeds[0]

        # SOLO en categoría ✮
        if message.channel.category and "✮" in message.channel.category.name:

            for field in embed.fields:
                nombre = field.name.lower().replace("*", "").strip()

                # DEBUG (puedes quitar después)
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

                            embed_msg.set_image(url="https://media.discordapp.net/attachments/1468842385420320960/1468844898793947279/metodos_pago.png")

                            embed_msg.add_field(
                                name="🏦 Transferencia",
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

                            embed_msg.add_field(
                                name="🏪 Depósito OXXO",
                                value="https://cdn.discordapp.com/attachments/1464133748923695199/1464371847201292574/0273176f-3966-4d09-a18e-15abac4a5cbb.jpg",
                                inline=False
                            )

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