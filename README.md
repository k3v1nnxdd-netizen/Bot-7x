# Bot 7x - Discord Bot

Este bot de Discord está diseñado para la comunidad 7x, proporcionando un sistema de tickets para compras de Robux y soporte.

## Requisitos

- Node.js v16.9.0 o superior
- Un token de bot de Discord

## Instalación

1. Clona o descarga los archivos en una carpeta.
2. Ejecuta `npm install` para instalar las dependencias.
3. Crea un archivo `.env` en la raíz con tu TOKEN:

```
TOKEN=tu_token_aqui
```

4. Asegúrate de tener el archivo `oxxo.jpg` en la raíz para las imágenes de pago.

## Configuración

- OWNER_ID: ID del propietario (996310284803248158)
- ADMIN_IDS: quién puede hacer cosas de owner (el propietario + `ADMINS_EXTRA`) — ver «Quien puede hacer cosas de owner»
- Canal principal: 1442456304420524146
- Categoría de tickets: 1184353695643729940
- Canal de métodos de pago: 1494475415597744360
- Rol automático para nuevos miembros: 1500335259575910450

## Funcionalidades

- Sistema de tickets con botones y modales
- Precios de Robux
- Métodos de pago
- Comandos slash: `/pagos` y `/precios`
- Todos los embeds en color negro (#000000)

## Licencias de grupos (solo owner)

Cuatro comandos que gestionan la whitelist de grupos de Roblox a través de **outfit-api**. El bot **no** toca Postgres: todo pasa por `/admin/groups` (ver `utils/outfitApi.js`).

| Comando | Opciones | Visibilidad |
|---|---|---|
| `/addgroup` | `group_id` (req.), `discord_user` (req.), `roblox_user` (req.) | Pública |
| `/regeneratetoken` | `group_id` (req.), `discord_user` (req.), `roblox_user` (req.) | Pública + token en privado |
| `/deletegroup` | `group_id` (req.), `motivo` (opc.) | Pública |
| `/checkgroup` | `group_id` (req.) | Pública |
| `/groups` | — | **Efímera** (solo quien la ejecuta) |

Requiere dos variables de entorno (ya definidas en Railway):

```
OUTFIT_API_URL=https://<servicio-outfit-api>.up.railway.app
OUTFIT_ADMIN_API_KEY=<la ADMIN_API_KEY de outfit-api>
```

Sin ellas el bot arranca igual y avisa por consola; los cuatro comandos responden que el sistema no está configurado. `OUTFIT_ADMIN_API_KEY` solo se lee en `utils/outfitApi.js`, viaja únicamente en la cabecera `x-admin-key` y no aparece en ningún mensaje ni log.

`/addgroup` comprueba **primero** contra Roblox que el Group ID existe: si no existe, se detiene y no crea ninguna licencia.

### Token de licencia

Un alta **nueva** genera una credencial propia del grupo (`7xl_…`). El bot la entrega en un **mensaje efímero que solo ve quien ejecutó el comando** — nunca en el embed público, porque publicar la credencial de un cliente en un canal es entregársela a todo el que pase por ahí, y eso no se puede deshacer.

Se muestra **una sola vez**: la API solo guarda su SHA-256, así que no hay forma de volver a consultarla. El embed público únicamente dice si se emitió y si llegó a entregarse.

**Reactivar una licencia no cambia el token**, así que el juego del cliente sigue funcionando sin tocar nada. El cliente usa ese token en `POST /v1/license/verify` (ver el README de `outfit-api`).

**Si el token se pierde, `/regeneratetoken`.** Emite uno nuevo e **invalida el anterior en el acto**. Los tres argumentos son obligatorios y `discord_user` / `roblox_user` **no modifican la licencia**: son una confirmación de identidad que debe coincidir exactamente con lo enlazado, o no se regenera nada. Sin ellos, un dedo mal puesto en un id de nueve cifras dejaría a otro cliente fuera de su propio juego sin aviso.

**Un solo mensaje, con el token dentro** (grupo, Discord enlazado, Roblox enlazado, regenerado por, fecha, alta original y token). Está pensado para ejecutarse **dentro de un ticket privado**, donde ya están solo el comprador y el staff autorizado — que son las dos partes que necesitan el token. Ese mensaje **no es efímero**: el token queda en el historial del canal donde se ejecute, así que no lo uses fuera de un ticket.

`/addgroup` funciona distinto: ahí el token va en un mensaje **efímero** aparte, porque su embed sí se publica en canales abiertos.

## Check Group's

El panel tiene un boton por comunidad. Al pulsarlo se pide el usuario de Roblox
y el bot responde **al momento**. Es **100% automatico**: el veredicto lo da
Roblox y nadie mas. No hay botones bajo los resultados, nadie revisa nada a
mano, no hay cola de pendientes y el owner no decide elegibilidad.

El dato no se estima: sale de `createTime` de la membresia, que es la fecha en
la que Roblox creo esa membresia. Se consulta con **Roblox Open Cloud**, filtrada
por el usuario, en **una sola peticion**:

```
GET https://apis.roblox.com/cloud/v2/groups/{GROUP_ID}/memberships
    ?maxPageSize=1&filter=user == 'users/{USER_ID}'
```

Nunca se recorre la lista de miembros del grupo: el filtro lo aplica Roblox, asi
que una comunidad de 300.000 miembros cuesta exactamente lo mismo que una de 3.

| Paso | Que pasa |
|---|---|
| 1 | El usuario pulsa el boton de una comunidad |
| 2 | Se abre el modal y escribe su usuario de Roblox |
| 3 | El bot resuelve usuario -> UserId (`users.roblox.com`) |
| 4 | Consulta SU membresia en ese grupo (Open Cloud, filtrada por UserId) |
| 5 | Calcula los dias desde `createTime` hasta hoy |
| 6 | Pide el avatar del jugador y el icono de la comunidad |
| 7 | Publica el resultado en el canal de resultados y confirma en efimero |

### El panel

Un Container de Components V2, como el de tickets: barra de color a la izquierda
y, DENTRO del mismo bloque, el texto, una linea por comunidad con su icono y los
botones. Antes era un embed clasico con los botones colgando debajo.

Nada del panel esta escrito a mano: las lineas, los iconos y los botones salen de
recorrer `config.CHECK_GROUPS`. Los botones se reparten en filas de 3.

El **panel de comunidades** (`verif.js`, el del canal de verificacion) sale de esa
MISMA lista. Antes tenia las tres comunidades escritas a mano, y eso significaba
que anadir una la dejaba fuera de ese panel sin que nada avisara: la gente se unia
a las que veia alli y luego Check Group's le decia que no pertenecia a una cuarta
que nunca le habian ensenado.

### Por que los iconos son emojis

Porque **el icono va a la izquierda del nombre**, y en Components V2 la imagen de
una Section es su `accessory`, que Discord pinta SIEMPRE a la derecha. No es que
no usemos la opcion: la API no la tiene. La unica imagen que Discord pinta a la
izquierda de un texto es un emoji.

Asi que `utils/groupEmojis.js` sube el icono real de cada comunidad como **emoji
de la aplicacion** (del bot, no del servidor: no gasta los 50 huecos del servidor,
funciona en cualquier servidor donde este el bot y no necesita permisos de gestion
de emojis). El nombre es `cg_<clave>_<hash del icono>`, y ese hash es lo que hace
que el sistema se mantenga solo:

| Situacion | Que pasa |
|---|---|
| Primer arranque | Se sube uno por comunidad |
| Reinicio sin cambios | Se encuentra por nombre y **no se sube nada** |
| El dueno cambia el icono en Roblox | Cambia el hash -> se sube el nuevo y se borra el viejo **de esa comunidad** |
| Roblox no da el icono | Esa comunidad sale con el emoji generico |
| Discord rechaza la subida | Igual: emoji generico, y el panel se publica |

Sin el hash en el nombre no habria forma de enterarse de que la foto ya no es la
misma; sin la reutilizacion por nombre, cada reinicio dejaria cinco emojis nuevos
y en unas semanas la app llegaria a su tope de 2000.

El icono se pide en **150x150**, no en 420x420: un emoji no puede pasar de 256 KB
y el icono de 7x UGC en 420 pesa 218, demasiado cerca del techo. En 150 el mayor
baja a 37 KB, y Discord los pinta a ~48 px de todos modos. El 420x420 se sigue
usando donde si se ve grande: la TARJETA DE RESULTADO.

Todo esto es decoracion y **nunca lanza**: un panel sin fotos es peor que uno con
ellas, pero un panel que no se publica porque una foto fallo es mucho peor.

Dos reglas mas que evitan estropear lo que ya esta publicado:

- **Si falta algun icono, no se reedita un panel que si los tiene.** Es preferible
  dejar el bueno a sustituirlo por uno sin fotos; el "no hay icono" se cachea 30
  minutos, asi que el siguiente arranque lo arregla solo.
- **El panel se busca primero entre los mensajes FIJADOS**, no en los ultimos 100:
  en un canal con movimiento, buscar solo en los ultimos 100 acaba publicando un
  duplicado en cuanto el panel queda enterrado.

### La tarjeta

Compacta y horizontal: tres columnas y nada mas.

```
Check Group's — 7x Community's
(o) soykevinsitop                                        [icono grupo]

Se unio            Antiguedad          Estado
14 feb 2026        198 dias            ELEGIBLE

                                        Solicitado por Kevin
```

| Elemento | Como |
|---|---|
| Avatar del jugador | `setAuthor({ name, iconURL })` — pequeño y redondo, junto al nombre |
| Icono de la comunidad | `setThumbnail(...)` — arriba a la derecha |
| Se unio / Antiguedad / Estado | Tres fields con `inline: true` |
| "Le faltan N dias para ser elegible" | Solo si NO es elegible: una linea suelta debajo, sin encabezado |
| Quien lo pidio | Footer: `Solicitado por <nombre>`. Sin Discord ID, sin emojis (ahi Discord no los renderiza) |

Nunca `setImage()`: una imagen a ancho completo hacia el embed demasiado alto.

Fuera de la tarjeta, a proposito: display name, UserId, GroupId, Discord ID,
fuente de verificacion, estado de membresia como bloque aparte, minimo requerido
como bloque aparte y hora de solicitud.

Si no pertenece, se publica igual con `NO PERTENECE` y guiones en fecha y
antiguedad: nunca un numero inventado. En ese caso, y solo en ese, se anade un
cuarto campo con el **link de la comunidad** para que pueda unirse y volver a
comprobarlo — el link tambien va en su respuesta efimera, para que no tenga que
ir al canal a buscarlo. Vive junto al label y al ID en `config.CHECK_GROUPS`.

Las dos imagenes se piden a Roblox en vivo:

| Imagen | Origen |
|---|---|
| Avatar del jugador | `thumbnails.roblox.com/v1/users/avatar-headshot` |
| Icono de la comunidad | `thumbnails.roblox.com/v1/groups/icons` |

Los PNG del repo (`se7en.png`, `7 communitys.png`, `$7 studio.png`) **no son la
fuente principal**: solo se adjuntan si Roblox aun no tiene un icono renderizado
para ese grupo. Y si falla cualquiera de las dos imagenes, la solicitud se
publica igual — una imagen es decoracion, nunca un motivo para no dar un
veredicto.

### El minimo de dias

```js
// config.js
MIN_GROUP_DAYS: 14,
```

Son los dias que Roblox exige de membresia antes de permitir un payout de grupo
hacia esa cuenta. **Esta escrito en un unico sitio**: el flujo, el texto del
panel y la linea de "te faltan N dias" lo leen todos de ahi. Para cambiarlo, se
cambia ese numero y nada mas.

No confundirlo con `ROBLOX_GROUP_DAYS_REQ`, que es el requisito propio del bot
en el canal de verificacion y sigue siendo independiente.

### Los IDs de las comunidades

```js
// config.js
CHECK_GROUPS: {
    noctra:      { label: '7x (Antes Noctra Study)', groupId: 282134403,  link: '...' },
    community:   { label: "7x Community's",          groupId: 59218460,   link: '...' },
    group7x:     { label: '#7x $tudio',              groupId: 1101699267, link: '...' },
    noctranuevo: { label: 'Noctra nuevo',            groupId: 679239229,  link: '...' },
    ugc:         { label: '7x UGC',                  groupId: 729107867,  link: '...' },
},
```

La clave de cada entrada es el sufijo del customId del boton (`cg_noctra` ->
`noctra`). De aqui salen TODAS las piezas: los botones que acepta
`handlers/buttons.js`, la fila y el icono de cada comunidad en el panel, y el
groupId contra el que consulta el flujo. Anadir una comunidad es escribirla aqui
y nada mas; no puede quedarse a medias.

El canal de resultados es `config.CHANNELS.CHECKGROUP_RESULTS`
(`1534758835531808869`), escrito una sola vez ahi. Si no esta en la cache del
cliente (arranque en frio) se pide a la API antes de darlo por perdido.

### Variable de entorno (Railway)

```
ROBLOX_OPEN_CLOUD_KEY=<API key de Roblox Open Cloud>
```

Es **obligatoria**: sin ella Check Group's no puede funcionar, porque Open Cloud
es la unica fuente de `createTime`. El bot arranca igual y lo avisa por consola,
pero cada solicitud respondera con un error al usuario.

La key necesita el permiso **`group:read`** (Groups -> Read) sobre **cada una**
de las comunidades configuradas arriba — las cinco — y su lista de IPs permitidas
tiene que dejar salir a Railway. Una comunidad nueva en `CHECK_GROUPS` sin ese
permiso en la key sale en el panel y responde `open_cloud_unauthorized`: el
usuario ve "no se pudo comprobar" y el motivo real queda en consola.

Igual que `OUTFIT_ADMIN_API_KEY`, **solo se lee en un sitio**
(`src/roblox/client.js`), viaja unicamente en la cabecera `x-api-key` y no
aparece en ningun mensaje ni en ningun log: todo fallo de Open Cloud se convierte
ahi mismo en un error con codigo, y el error original de axios — que lleva dentro
`config.headers` con la key — se descarta sin salir del modulo.

### Si algo falla

Un fallo **nunca** se traduce en "no elegible", y **no publica nada**. El usuario
recibe un unico mensaje efimero:

```
No se pudo comprobar tu antiguedad en Roblox en este momento.
Intenta nuevamente mas tarde.
```

El detalle tecnico (que grupo, que usuario, que codigo de error) se queda en la
consola de Railway. Los unicos errores que se le explican al usuario son los que
puede arreglar el mismo: username inexistente o mal escrito.

### Anti-spam

Dos limites por usuario de Discord, comprobados ANTES de tocar Roblox y antes de
publicar nada: una solicitud frenada no cuesta ni una peticion ni un mensaje en
el canal.

```js
// config.js
CHECKGROUP_ANTISPAM: {
    COOLDOWN_MS:    15_000,      // entre una comprobacion y la siguiente
    MAX_PER_WINDOW: 6,           // comprobaciones...
    WINDOW_MS:      10 * 60_000, // ...por cada 10 minutos (ventana deslizante)
},
```

Hacen falta los dos, porque responden a preguntas distintas: el cooldown corta
la rafaga (dobles clics, alguien probando diez usernames seguidos) y la cuota
corta el goteo sostenido — sin ella, 15 s de cooldown todavia permiten 240
comprobaciones por hora. La ventana es DESLIZANTE y no por cubos fijos: con
cubos, quien gasta su cuota al final de uno puede gastar otra entera al empezar
el siguiente y colar el doble de golpe justo en la frontera.

6 cada 10 minutos da de sobra para el uso real: comprobar las comunidades que a
uno le interesen y repetirlo. Con cinco configuradas, quien quiera comprobarlas
todas de una tacada lo hara en dos tandas.

Al usuario frenado se le dice **cuando** podra volver, con un timestamp de
Discord relativo, no con un "espera un momento" que no dice nada. Y una errata
en el username **no gasta cuota**: el formato se valida antes, y una errata no
cuesta ninguna peticion a Roblox.

Esto es el techo POR PERSONA. El techo global ya estaba en otra capa:
`src/roblox/rateLimiter.js` pacea cada ruta de Roblox con su propio token bucket
y abre el circuito si Roblox se queja. Y la cache de mas abajo hace que repetir
la misma consulta no llegue siquiera a salir.

La mecanica vive en `utils/spam.js`, que ya tenia los cooldowns por clave que
usa el resto del bot; lo nuevo es la cuota por ventana deslizante, que es
reutilizable desde cualquier otro flujo.

### Cache

Todo en memoria (`src/cache/memoryCache.js`), y cada TTL elegido por lo que de
verdad cambia:

| Dato | TTL | Por que |
|---|---|---|
| Identidad (username -> UserId) | 10 min | Un username no cambia de dueno entre dos clics |
| Membresia encontrada (`createTime`) | 5 min | `createTime` es inmutable mientras la membresia exista; los dias se recalculan igual en cada consulta |
| "No es miembro" | 60 s | Corto a proposito: es justo el caso de alguien que se va a unir y vuelve enseguida |
| Avatar del jugador | 60 min | Cambia si se cambia de ropa. Comprobar varios grupos seguidos cuesta UNA peticion |
| Icono de la comunidad | 12 h | Practicamente nunca cambia. El panel los pide todos al arrancar; con la cache, un reinicio no vuelve a pedirlos |
| Imagen que Roblox no dio | 5 min (avatar) / 30 min (icono) | Tambien se cachea el "no hay", pero poco: suele ser un render pendiente que se resuelve solo |

## Headless Horseman

Venta de un paquete cerrado: **31,000 Robux por $3,579 MXN** para comprar el Headless Horseman. Panel propio, ticket propio e interruptor de venta.

### Las cifras

Todas viven en `config.HEADLESS` y en ningun sitio mas — precio, Robux, precio de referencia en Roblox, dias de antiguedad y las dos comunidades. Cambiar el precio es cambiar **una linea**: el panel, el resumen del ticket y el aviso de pago lo leen de ahi.

El porcentaje de ahorro **no se escribe**: se calcula desde `PRECIO_MXN` y `PRECIO_ROBLOX_MXN` cada vez que se pinta el panel, para que no pueda quedarse anunciando el descuento de ayer.

### El panel

Se publica y se fija solo en `CHANNELS.HEADLESS` al arrancar el bot (`headless.js`). Es un Container de Components V2, igual que el panel de tickets: barra naranja, la imagen del Headless como miniatura a la derecha y **los dos botones dentro del bloque**.

- **Comprar** — abre el formulario y crea el ticket.
- **Verificar** — enlace al canal de Check Group's, para comprobar la antiguedad antes de pagar.

La imagen se busca como `headless.png` y, si no esta, `transparent (1).png`. Se sube como adjunto con el hash del contenido en el nombre, asi que reemplazar el archivo hace que el panel se reedite solo en el siguiente arranque.

### El ticket

Un ticket de compra de Robux normal: mismos mensajes, mismos metodos de pago, mismo boton de "PAGO REALIZADO" del owner. Dos diferencias:

1. Solo se pregunta el **usuario de Roblox**. La cantidad y el precio son fijos.
2. El canal se llama `headless-0001`.

Internamente el tipo de ticket es `comprar`, no `headless`, y es a proposito: de ese tipo cuelgan el boton de pago del owner, el "PAGO EXITOSO" del cliente, el registro en el canal de pedidos y el ranking de compradores. Un tipo nuevo dejaria el ticket a medio funcionar. Por lo mismo, el resumen usa las mismas etiquetas que el de compra normal ("Usuario de Roblox", "Robux a recibir", "Precio a pagar"): es de ahi de donde `utils/orderNotify.js` saca los datos del ranking.

### /headless on|off (solo owner)

Abre o cierra la venta.

| Comando | Boton Comprar | Panel |
|---|---|---|
| `/headless on` | abre el ticket | "Venta abierta" |
| `/headless off` | responde que todavia no esta a la venta | "Venta cerrada" |

El boton sigue pulsable con la venta cerrada **a proposito**: quien llega lee por que no puede comprar todavia, en vez de encontrarse un boton gris sin explicacion.

El estado se guarda en `DATA_DIR/headlessSale.json`, no en memoria: un reinicio del bot no puede abrir una venta que estaba cerrada. Por defecto **cerrada** — un fichero que no existe, corrupto o a medias significa cerrada, nunca abierta. Sin un Volume montado en `DATA_DIR`, un redeploy vuelve a dejarla cerrada.

Cada cambio repinta el panel al momento; si el repintado falla, el estado ya esta guardado y la respuesta lo dice.

## Mejoras del servidor (boosts)

Cuando alguien mejora el servidor, el bot publica una tarjeta en
`CHANNELS.BOOST`: embed gris, el avatar y el nombre de quien ha boosteado en la
linea de autor (`@Sombra`) y la animacion cerrando el mensaje abajo.

La arroba de esa linea se escribe a mano: la linea de autor de un embed es texto
plano y no admite menciones. La mencion de verdad, la que Discord pinta en azul,
esta en la descripcion. El nombre es el que se ve en el chat: el apodo del
servidor por delante del de la cuenta.

El avatar va de AUTOR y no de thumbnail a proposito: de thumbnail Discord lo
pinta grande arriba a la derecha y le roba el ancho a la descripcion, asi que el
texto queda estrecho y se lee pequeno al lado de la foto. Como icono del autor
sale pequeno y redondo, encima del texto, y la descripcion se queda con todo el
ancho de la tarjeta.

### Como se detecta: DOS detectores

Hacen falta los dos. Cada uno cubre el agujero del otro, y un candado
compartido (60 s por usuario) impide que un boost visto por ambos se anuncie dos
veces.

**1. `GuildMemberUpdate`** — `premiumSince` pasa de `null` a una fecha. Ese salto,
y solo ese, es un boost que empieza.

Ese evento llega para **cualquier** cambio de un miembro: un rol, un apodo, un
timeout. Por eso la decision no esta en el listener sino en `esBoostNuevo()`, y
por eso hay tres casos que NO se anuncian por esta via:

| Situacion | Por que no |
|---|---|
| Ya boosteaba y cambia otra cosa | No es un boost nuevo; anunciarlo diria que acaba de boostear cada vez que cambia de rol |
| Deja de boostear | Es el salto contrario |
| El miembro no estaba en cache (`partial`) | Discord no dice como estaba ANTES, asi que no se puede afirmar que no boosteaba |

**Su agujero, y es grave:** discord.js SOLO emite este evento si el miembro esta
en la cache. Con `Partials.GuildMember` desactivado —lo esta, y activarlo
afectaria a todo el bot— su handler hace `guild.members.cache.get(id)` y, si no
lo encuentra, emite `GuildMemberAvailable` **en lugar de** `GuildMemberUpdate`.
Discord manda al arrancar solo los miembros CONECTADOS de un servidor grande,
asi que un booster que llevara callado desde el ultimo reinicio no se anunciaria
nunca.

**2. El mensaje de sistema de boost** (tipos 8, 9, 10 y 11), el que Discord
publica en el canal de sistema del servidor. Llega **siempre**, este el miembro
en cache o no, y su autor es quien ha boosteado. Ese es justo el hueco que tapa.

**Su agujero:** depende de que "Enviar un mensaje cuando alguien mejore este
servidor" siga activado en Ajustes del servidor -> Informacion general, y de que
el bot vea ese canal.

Por separado cada uno se deja boosts sin anunciar; juntos, solo si fallan los dos
a la vez.

### El contador de mejoras

Se pide el servidor **a la API**, no se lee de la cache. El evento del miembro y
el que actualiza el numero de mejoras del servidor son dos eventos distintos y no
hay orden garantizado, asi que la cache puede tener el numero de ANTES del boost
— el unico que no se puede anunciar. Si la peticion falla se usa la cache, que es
mejor que no anunciar nada.

El plural se calcula (`1 mejora` / `3 mejoras`): un "ahora tenemos 1 mejoras" en
el primer boost del servidor es justo el detalle que delata un anuncio hecho a
medias.

### La animacion

El fichero del repo se llama `image-1788931423031.png` pero **es un GIF**
(800x320, 234 frames, 6,5 MB). Se adjunta con nombre `boost.gif` a proposito:
Discord decide por la extension del ADJUNTO si lo anima, asi que con `.png` se
publicaria congelado. Para sustituirlo basta con dejar un `boost.gif` en la raiz
— se busca antes que el otro.

Hay un anti-duplicado de 60 s por usuario: un reintento de la pasarela o dos
shards no pueden anunciar el mismo boost dos veces. Y nada de este flujo lanza:
por el listener pasan todos los cambios de todos los miembros, asi que un fallo
publicando el anuncio no puede tumbarlo.

## Estado de entrega de Robux

Un panel en `CHANNELS.GROUP_STATUS` que dice, de un vistazo, desde que
comunidades se estan enviando Robux ahora mismo. Existe para que un cliente no
tenga que preguntarlo.

Las comunidades salen de `config.CHECK_GROUPS`, la misma lista de la que viven
Check Group's y el panel de comunidades: anadir una la hace aparecer aqui sola,
activa, y tambien en el desplegable del comando.

### /groupactive (solo owner)

```
/groupactive grupo:<comunidad> estado:<on|off>
```

`on` la marca como que esta enviando Robux; `off`, como caida. El panel se
repinta al momento, y si el repintado falla la respuesta lo dice en vez de dejar
creer que ya esta.

El estado vive en `DATA_DIR/groupActive.json`, no en memoria: si el owner
enciende una comunidad y el bot se reinicia solo de madrugada, tiene que seguir
encendida. Lo contrario —volver sola al valor por defecto— cambiaria lo que se le
esta diciendo al cliente sin que nadie lo haya decidido.

**Por defecto, APAGADA.** Solo un `true` explicito enciende una comunidad, asi
que el panel se publica con las cinco en "no esta enviando" y el owner enciende
las que de verdad estan enviando. Un fichero perdido, corrupto o a medias, o una
comunidad recien anadida a config, caen en ese mismo lado: el panel se queda
callado en vez de prometer un envio que nadie ha confirmado.

El mensaje **ya esta publicado** antes de tocar el comando: `ensureGroupStatusPanel`
lo envia y lo fija al arrancar el bot (y tambien si el comando se ejecuta y el
panel no existiera todavia). `/groupactive` no publica uno nuevo cada vez: edita
ese mismo mensaje.

### El boton

Dentro del bloque va un boton de enlace **Verificar elegibilidad** que abre el
canal de Check Groups. Es el mismo patron que el del panel de comunidades: al
ser Link no lleva customId, asi que no pasa por `handlers/buttons.js` y no hay
nada que enrutar ni que pueda fallar.

Ese boton es la razon de que el panel sea un **Container de Components V2** y no
un embed clasico: un embed no admite botones — en un mensaje clasico quedarian
colgando debajo, fuera del marco de color.

### Tres detalles del panel

- **El titulo va en la DESCRIPCION**, como encabezado markdown, no en
  `setTitle()`. No es una preferencia: Discord no renderiza los emojis del
  servidor en el titulo de un embed —ni en el nombre de un field, ni en el
  footer—, ahi `<a:active:1529…>` se imprime crudo. En la descripcion si se
  pintan.
- **Cada comunidad lleva su icono de Roblox** (el mismo emoji de aplicacion que
  usan Check Groups y el panel de comunidades): con cinco grupos, el icono es lo
  que deja distinguirlos de un vistazo sin leer.
- **Con todas apagadas el panel se pone rojo** y lo dice con una linea. Un
  "se estan enviando desde estos grupos" en verde seguido de cinco cruces seria
  lo contrario de informar.
- **La hora del pie sale del fichero de estado, no del reloj.** El panel se
  repinta en cada arranque: una hora calculada al vuelo cambiaria el texto cada
  vez —reeditando el mensaje en cada reinicio— y ademas mentiria sobre cuando
  cambio el estado de verdad.

### El resumen de comunidades del ticket

Al abrir un ticket de Robux, el resumen incluye el estado del comprador en cada
comunidad (`utils/communityStatus.js`), para que no tenga que preguntarlo:

- **Una tarjeta por comunidad**, en linea, asi que Discord las coloca en filas de
  tres: icono de la comunidad, nombre y, debajo, los dias que lleva dentro con
  su marca de elegible o no.
- **Un campo de envio** al final, que lista SOLO las comunidades que el owner
  tiene encendidas con `/groupactive`, cada una con los dias del comprador y si
  puede recibir por ella. Si no puede por ninguna de las activas, se le avisa —
  es lo que evita que pague y se quede esperando.
- **La linea de autor lleva el avatar de la cuenta de ROBLOX**, no el de Discord:
  identifica a quien van los Robux. Es el unico sitio donde Discord pinta una
  imagen pequena junto a un texto.

El icono y el nombre de la comunidad van los dos en el VALUE del field, y el
nombre del field va vacio (un espacio de ancho cero), porque Discord no renderiza
los emojis del servidor en el nombre de un field.

Lo usan **los dos tickets de Robux**: la compra normal y el del Headless. La
diferencia es el umbral de dias con el que se juzga la elegibilidad, que es un
parametro: la compra normal se mide contra los dias que exige Roblox para pagar
(`MIN_GROUP_DAYS`, 14) y el Headless contra los suyos (`HEADLESS.DIAS_REQ`, 15).
Sin eso, una cuenta con 14 dias saldria elegible en un ticket de Headless que
pide 15 — prometiendole una entrega que todavia no puede recibir. Por eso la
elegibilidad se recalcula desde los dias en vez de usar el `eligible` que trae
`checkMembership`, que siempre viene medido contra MIN_GROUP_DAYS.

Las cinco consultas salen **a la vez** (`Promise.allSettled`) y comparten la
cache de `resolveRobloxUser`, asi que el username se resuelve una sola vez; lo
unico que se paga son las membresias, cacheadas 5 minutos.

**Nada de esto puede impedir que se abra un ticket.** Se calcula DESPUES de crear
el canal, y cualquier fallo se degrada a "no se pudo comprobar" en esa comunidad.
Un fallo nunca se convierte en un "no elegible": decirle a un cliente que no
puede recibir porque Roblox tardo en contestar le niega algo que si tenia, y en
pantalla se veria igual que un no legitimo. Con Roblox entero caido, el resumen
sale con las cinco en "no se pudo comprobar" y el ticket funciona igual.

## Quien puede hacer cosas de owner

`config.OWNER_ID` es el dueno: la persona concreta, la que sale nombrada en los
avisos del anti-estafa. `config.ADMIN_IDS` es **quien puede**, que ya no es una
sola persona.

Para dar permisos a alguien mas, anade su id a `ADMINS_EXTRA` en `config.js` y a
ningun otro sitio. La lista se construye desde `OWNER_ID`, asi que el dueno no
puede quedarse fuera de sus propios permisos por una errata.

`utils/permisos.js` es el UNICO sitio que decide:

| | Que responde |
|---|---|
| `esAdmin(userId)` | ¿puede hacer cosas de owner? |
| `esAdminDeInteraccion(interaction)` | lo mismo, desde un boton o un comando |
| `puedeGestionarTicket(userId, duenoDelTicket)` | el cliente manda sobre SU ticket; un admin, sobre cualquiera |

Antes ese chequeo estaba copiado a mano en once archivos
(`interaction.user.id !== config.OWNER_ID`). El problema de eso no era la
repeticion: era que olvidarse de UNO no da ningun error — esa accion se queda
siendo solo del dueno, en silencio, hasta que alguien la necesita y no puede.

Por eso `src/tests/permisos.test.js` **recorre el codigo** buscando
comparaciones sueltas contra `OWNER_ID` en `handlers/`, `utils/` y `main.js`. Si
alguien anade un comando nuevo con el chequeo copiado, el test lo caza. Se
permite nombrar `OWNER_ID` para MENCIONAR al dueno (`<@${config.OWNER_ID}>`),
que no es decidir nada.

### Los ids se comparan como cadena, siempre

Un snowflake de Discord tiene 17-20 digitos y NO cabe exacto en un numero de
JavaScript. Si un id llegara ya convertido a numero, volverlo a cadena no lo
arregla: la precision se perdio antes (`620310742138224661` como numero vale
620310742138224700). El modulo no intenta recuperarlo — simplemente no coincide
y deniega, que es el lado correcto en el que equivocarse.

## Metodos de pago

Un Container de Components V2 en `CHANNELS.METODOS`: el GIF, el texto y los
CINCO BOTONES dentro del mismo bloque. Antes era un embed con un desplegable
colgando debajo.

| Boton | Que enseña |
|---|---|
| Cripto | BTC, ETH, LINK, LTC y UNI, cada una con su direccion y su red |
| Transferencia | Cuenta de Mercado Pago, titular y banco |
| Deposito OXXO | El codigo QR |
| Gift Card Eneba | Enlace de compra |
| Gift Card Amazon | Enlace de compra (Amazon Mexico) |

### La respuesta es EFIMERA

Pulsar un boton responde **solo a quien lo pulso**. No es un detalle estetico:
una cuenta bancaria y cinco direcciones de cobro escritas en un canal abierto
las lee cualquiera, para siempre, y no se pueden "despublicar".

`/pagos` es la excepcion, y a proposito: ese lo usa el staff DENTRO de un ticket
para enseñarle los datos al cliente, asi que su respuesta es publica. El
contenido sale de la misma funcion (`buildDetallePayload`), asi que no hay dos
versiones de una cuenta bancaria que puedan desincronizarse.

### Las direcciones de cobro

Viven en `metodos.js`, juntas y en un solo sitio, porque **son dinero**: un
caracter de mas o de menos manda el pago de un cliente a la nada, y en una
blockchain eso no se deshace ni se reclama.

Por eso `src/tests/metodos.test.js` comprueba su FORMATO en cada `npm test`:
longitud exacta, alfabeto valido por moneda (bech32 para BTC/LTC, hex para las
EVM) y que no haya dos iguales. No valida el checksum —haria falta una
libreria— pero caza lo que de verdad pasa al copiar y pegar: que se quede un
caracter por el camino. La cuenta de Mercado Pago se comprueba igual: 18
digitos.

ETH, LINK y UNI son tres direcciones EVM **distintas entre si**, no
intercambiables, y el mensaje lo avisa: enviar una moneda a la direccion de otra
o por otra red pierde el pago.

### El GIF y los tickets

El panel del canal lleva el GIF; los tickets mandan **el mismo bloque sin el**.
Son 6,5 MiB: en el canal se suben una vez y se quedan, pero en un ticket serian
6,5 MiB de subida y varios segundos de espera por cada cliente, para una
decoracion que ya vio en el canal. El texto y los botones son identicos. Si
alguna vez se quiere con GIF, `buildMetodosPayload({ conBanner: true })`.

Los tres tickets que mandan metodos de pago (compra de Robux, Headless y
seguidores) usan ese mismo bloque, asi que cambiar un dato de pago se hace en un
solo sitio.

### Anadir un metodo

Se escribe en el objeto `METODOS` de `metodos.js` y en ningun otro sitio: de ahi
salen el boton del panel, su enrutado en `handlers/buttons.js` y las opciones de
`/pagos`. No se puede quedar a medias.

## Ejecutar





```bash
npm start
```

## Notas

- El bot envía un mensaje principal al canal especificado al iniciar.
- Evita tickets duplicados por usuario.
- Los tickets se cierran automáticamente después de confirmar pago.