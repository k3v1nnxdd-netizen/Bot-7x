# outfit-api

API independiente para **buscar usuarios de Roblox y consultar sus outfits públicos**.

Servicio completamente autónomo: su propio `package.json`, sus propias dependencias, su propio proceso y su propia API key. **No comparte ni una línea de código con el bot de Discord ni con la API existente del repositorio**, y no escribe nada en disco.

---

## Endpoints

Todo lo que cuelga de `/v1` exige la cabecera `x-api-key`. `/health` no.

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/health` | Healthcheck de Railway. Público, sin límite, sin llamadas a Roblox. |
| `GET` | `/v1/users/by-username/:username` | Resuelve `username` → `userId`. |
| `GET` | `/v1/users/:userId/outfits?page=&limit=` | Lista los outfits de un usuario. |
| `GET` | `/v1/users/by-username/:username/outfits?page=&limit=` | Resuelve **y** lista en una sola llamada. |
| `GET` | `/v1/outfits/:outfitId` | Contenido de un outfit concreto. |
| `GET` | `/v1/metrics` | Observabilidad interna. Protegida. |

`page` va de 1 a 100 (por defecto 1). `limit` solo admite **10, 25 o 50** (por defecto 25).

### Ejemplos

```
GET /v1/users/by-username/builderman
{ "userId": 156, "username": "builderman", "displayName": "builderman" }
```

```
GET /v1/users/156/outfits?limit=10
{
  "userId": 156, "page": 1, "limit": 10, "count": 10, "hasMore": true,
  "outfits": [{ "id": 555869704325162, "name": "adidas Ice Angels" }]
}
```

```
GET /v1/outfits/555869704325162
{
  "id": 555869704325162,
  "name": "adidas Ice Angels",
  "outfitType": "Avatar",
  "playerAvatarType": "R15",
  "assets": [{ "id": 101396973232145, "name": "adidas Ice Angels - Left Shoe", "typeId": 70 }],
  "bodyColorFormat": "hex",
  "bodyColors": { "head": "A3A2A5", "torso": "A3A2A5", "leftArm": "A3A2A5", "rightArm": "A3A2A5", "leftLeg": "A3A2A5", "rightLeg": "A3A2A5" },
  "scale": { "height": 1, "width": 1, "head": 1, "depth": 1, "proportion": 0, "bodyType": 0 }
}
```

`typeId` es el enum estable de Roblox, disponible en Lua como `Enum.AvatarAssetType`: por eso no se manda también su nombre — en un outfit de 30 piezas eso sería la mitad del payload duplicando algo que el cliente ya tiene. `bodyColorFormat` indica cómo leer `bodyColors` (`"hex"` o `"brickColorId"`), porque Roblox expone ambos formatos según la antigüedad del outfit.

### Errores

Formato único: `{ "error": { "code", "message" } }`. `code` es estable y está pensado para hacer `if` sobre él.

| HTTP | `code` | Significado |
|---|---|---|
| 400 | `invalid_request` | Parámetro inválido. |
| 401 | `unauthorized` | Falta o es incorrecta `x-api-key`. |
| 404 | `user_not_found` / `outfit_not_found` | No existe en Roblox. |
| 404 | `route_not_found` | Ese endpoint no existe aquí. |
| 429 | `rate_limited` | **Nuestro** límite. Baja el ritmo. Trae `Retry-After`. |
| 503 | `upstream_rate_limited` | Límite de **Roblox**. Espera el `Retry-After` y reintenta. |
| 503 | `upstream_unavailable` | Circuit breaker abierto: Roblox falla de forma sostenida. |
| 502 | `upstream_error` | Roblox devolvió 5xx o no respondió. |
| 500 | `internal_error` | Fallo nuestro. El `X-Request-Id` de la respuesta lo cruza con el log. |

429 y 503 están separados a propósito: la reacción correcta es distinta y el juego debe poder distinguirlas.

---

## Consumo desde Roblox

```lua
local HttpService = game:GetService("HttpService")
local BASE, KEY = "https://<tu-servicio>.up.railway.app", "<OUTFIT_API_KEY>"

local function apiGet(path)
    local ok, res = pcall(HttpService.RequestAsync, HttpService, {
        Url = BASE .. path,
        Method = "GET",
        Headers = { ["x-api-key"] = KEY },
    })
    if not ok then return nil, "network" end
    local body = HttpService:JSONDecode(res.Body)
    if res.StatusCode == 200 then return body end
    -- 503 -> body.error.retryAfterSeconds dice cuánto esperar antes de reintentar
    return nil, body.error and body.error.code or tostring(res.StatusCode)
end

-- Una sola llamada de HttpService: resuelve el nombre y lista sus outfits.
local data, err = apiGet("/v1/users/by-username/builderman/outfits?limit=25")
```

Usa siempre el endpoint compuesto cuando partas de un nombre: `HttpService` tiene su propio presupuesto por servidor, y partirlo en dos peticiones lo duplica sin ahorrarnos a nosotros ni una llamada a Roblox.

---

## Configuración

Solo `OUTFIT_API_KEY` es obligatoria. El resto tiene valores por defecto sensatos.

| Variable | Por defecto | Para qué |
|---|---|---|
| `OUTFIT_API_KEY` | — | **Obligatoria.** El único secreto del servicio. |
| `PORT` | `3100` | La inyecta Railway. |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` |
| `TTL_USERNAME_MS` | 12 h | Caché de `username` → `userId`. |
| `TTL_OUTFIT_LIST_MS` | 5 min | Caché del listado. |
| `TTL_OUTFIT_DETAILS_MS` | 1 h | Caché del contenido de un outfit. |
| `TTL_NEGATIVE_MS` | 5 min | Caché de los 404. |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | 600 / 60 s | Límite propio, por IP. |
| `UPSTREAM_TIMEOUT_MS` | 6 s | Timeout de cada llamada a Roblox. |
| `UPSTREAM_MAX_CONCURRENT` | 3 | Techo global de llamadas simultáneas a Roblox. |
| `UPSTREAM_MAX_QUEUE` | 200 | Cola del gate; al llenarse se rechaza al instante. |
| `UPSTREAM_MAX_RETRIES` | 2 | Reintentos ante 429/5xx/red. |
| `CACHE_MAX_ENTRIES` | 50 000 | Tope LRU en memoria. |
| `CACHE_DRIVER` | `memory` | Reservado para Redis. |

El límite propio va alto a propósito: quien llama son servidores de Roblox, y **una IP = decenas de jugadores**. Un límite pensado para usuarios individuales cortaría un servidor lleno.

---

## Despliegue en Railway

Servicio nuevo sobre **el mismo repositorio**, aislado por `Root Directory`:

| Ajuste | Valor |
|---|---|
| Root Directory | `outfit-api` |
| Watch Paths | `outfit-api/**` |
| Start Command | (auto) `npm start` |
| Healthcheck Path | `/health` |
| Volume | **ninguno** |

Variables: `OUTFIT_API_KEY` y las opcionales de la tabla anterior. `PORT` la inyecta Railway.

Con `Watch Paths` puesto en los tres servicios, un push que solo toque `outfit-api/` deja de redesplegar el bot y la API existente.

Genera la key con:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Desarrollo local

```bash
cd outfit-api
npm install
cp .env.example .env      # y pon una OUTFIT_API_KEY
npm start                 # escucha en 3100

npm test                  # 53 tests, sin red ni disco
npm run test:live         # verificación end-to-end contra la API real de Roblox
```

`npm run test:live` levanta el servicio en un puerto efímero y recorre el camino completo: healthcheck, resolución, listado, detalles, caché, single-flight con 50 peticiones simultáneas, y 404 con caché negativa. Gasta media docena de llamadas reales a Roblox.

---

## Diseño

**Superficie contra Roblox: exactamente tres endpoints públicos**, todos en `src/roblox/client.js`, que es el único módulo del servicio que importa `axios`.

1. `POST users.roblox.com/v1/usernames/users`
2. `GET avatar.roblox.com/v2/avatar/users/{userId}/outfits`
3. `GET avatar.roblox.com/v3/outfits/{outfitId}/details`

**Sin credenciales de Roblox.** Ni cookies, ni `.ROBLOSECURITY`, ni tokens: los tres endpoints sirven datos públicos. `withCredentials: false` y la ausencia de cualquier cookie jar lo hacen estructuralmente imposible, no simplemente omitido. Este servicio no puede actuar en nombre de ninguna cuenta.

**Sin cuotas asumidas.** No hay ningún «N req/min» codificado para ningún endpoint de Roblox: no publica límites estables para estas rutas y los endurece sin avisar. Un 429 se trata como condición normal y la pauta la marca Roblox — `Retry-After` y `x-ratelimit-*` cuando los manda, backoff exponencial con jitter cuando no. Encima de eso, un circuit breaker por ruta que deja de insistir cuando Roblox falla de forma sostenida, con recuperación half-open de una sola petición de tanteo.

**Lo que de verdad protege los límites de Roblox es la caché**, no el limitador. TTL por entidad + LRU acotado + **caché negativa** (un 404 se recuerda, así un buscador de nombres con erratas no se convierte en un martilleo) + **single-flight** (500 peticiones simultáneas sobre una clave fría = 1 llamada a Roblox; verificado en el test de carga y en la verificación en vivo).

**Preparado para Redis.** La interfaz de caché ya es asíncrona, las claves ya van namespaced y versionadas (`v1:user:name:x`) y los valores son objetos planos serializables. Migrar es escribir `redisDriver.js` con las mismas cuatro funciones y cambiar `selectDriver()` en `src/cache/cacheStore.js`: ningún call-site cambia. El single-flight seguirá siendo por proceso — una promesa en memoria no viaja por red — y está bien: con N instancias el peor caso son N llamadas simultáneas en vez de miles.

**El secreto nunca sale.** `x-api-key` solo se acepta por cabecera (jamás por query string, que acabaría en los logs de cualquier proxy), se compara en tiempo constante, no aparece en ninguna respuesta —`/v1/metrics` incluida— y el logger redacta por nombre cualquier campo que suene a credencial. Hay tests que lo verifican.

### Estructura

```
server.js                 arranque, timeouts de socket, apagado limpio
src/app.js                construye la app Express (sin listen)
src/config/               único punto de lectura de process.env
src/api/                  rutas + traducción error → HTTP
src/services/             política de caché por entidad
src/roblox/               cliente, limitador reactivo, breaker, taxonomía de errores
src/cache/                fachada + driver de memoria + single-flight
src/security/             API key, límite por IP
src/validation/           validadores puros
src/observability/        logger JSON, log por petición, métricas
src/tests/                53 tests sin red · live/ para verificación manual
```
