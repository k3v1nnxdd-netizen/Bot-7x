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
antiguedad: nunca un numero inventado.

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
    noctra:    { label: '7x (Antes Noctra Study)', groupId: 282134403 },
    community: { label: "7x Community's",          groupId: 59218460 },
    group7x:   { label: '#7x $tudio',              groupId: 1101699267 },
},
```

La clave de cada entrada es el sufijo del customId del boton (`cg_noctra` ->
`noctra`), y `handlers/buttons.js` deriva de aqui que botones acepta, asi que
anadir una cuarta comunidad no puede quedarse a medias.

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
de las tres comunidades configuradas arriba, y su lista de IPs permitidas tiene
que dejar salir a Railway.

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

### Cache

Todo en memoria (`src/cache/memoryCache.js`), y cada TTL elegido por lo que de
verdad cambia:

| Dato | TTL | Por que |
|---|---|---|
| Identidad (username -> UserId) | 10 min | Un username no cambia de dueno entre dos clics |
| Membresia encontrada (`createTime`) | 5 min | `createTime` es inmutable mientras la membresia exista; los dias se recalculan igual en cada consulta |
| "No es miembro" | 60 s | Corto a proposito: es justo el caso de alguien que se va a unir y vuelve enseguida |
| Avatar del jugador | 60 min | Cambia si se cambia de ropa. Comprobar los 3 grupos seguidos cuesta UNA peticion |
| Icono de la comunidad | 12 h | Practicamente nunca cambia, y solo hay 3 comunidades: ~3 peticiones al dia |
| Imagen que Roblox no dio | 5 min (avatar) / 30 min (icono) | Tambien se cachea el "no hay", pero poco: suele ser un render pendiente que se resuelve solo |

## Ejecutar

```bash
npm start
```

## Notas

- El bot envía un mensaje principal al canal especificado al iniciar.
- Evita tickets duplicados por usuario.
- Los tickets se cierran automáticamente después de confirmar pago.