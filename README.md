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

## Ejecutar

```bash
npm start
```

## Notas

- El bot envía un mensaje principal al canal especificado al iniciar.
- Evita tickets duplicados por usuario.
- Los tickets se cierran automáticamente después de confirmar pago.