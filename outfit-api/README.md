# outfit-api

API independiente para **buscar usuarios de Roblox y consultar sus outfits públicos**, devolviendo todo lo necesario para reconstruir el avatar en Roblox Studio.

Servicio completamente autónomo: su propio `package.json`, sus propias dependencias, su propio proceso y su propia API key. **No comparte ni una línea de código con el bot de Discord ni con la API existente del repositorio**, y no escribe nada en disco.

---

## Endpoints

Todo lo que cuelga de `/v1` exige la cabecera `x-api-key`. `/health` no.

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/health` | Healthcheck de Railway. Público, sin límite, sin llamadas a Roblox. |
| `GET` | `/v1/users/by-username/:username` | Resuelve `username` → `userId`. |
| `GET` | `/v1/users/:userId/outfits?page=&limit=&outfitType=` | Lista los outfits de un usuario. |
| `GET` | `/v1/users/by-username/:username/outfits?…` | Resuelve **y** lista en una sola llamada. |
| `GET` | `/v1/outfits/:outfitId?bundles=1` | Contenido completo del outfit. |
| `GET` | `/v1/metrics` | Observabilidad interna. Protegida. |

`page` va de 1 a 100 (por defecto 1). `limit` solo admite **10, 25 o 50** (por defecto 25). `outfitType` solo admite **`Avatar`, `DynamicHead`, `Shoes`** — los tres valores que Roblox usa realmente.

### Listado

```
GET /v1/users/156/outfits?limit=10&outfitType=DynamicHead
{
  "userId": 156, "page": 1, "limit": 10, "outfitType": "DynamicHead",
  "count": 10, "hasMore": true,
  "outfits": [{ "id": 17762785106, "name": "Winky", "outfitType": "DynamicHead", "isEditable": false }]
}
```

`hasMore` se deduce de si la página vino llena. Roblox **no** devuelve ningún total en este endpoint (comprobado en vivo: la respuesta solo trae `data` y `paginationToken`), así que inventar un `totalCount` sería justamente lo que no se debe hacer.

### Detalle del outfit

```
GET /v1/outfits/11685920016
```

```json
{
  "id": 11685920016,
  "name": "Check It",
  "outfitType": "DynamicHead",
  "inventoryType": "DynamicHead",
  "isEditable": false,
  "universeId": null,
  "playerAvatarType": "R15",

  "humanoidDescription": {
    "scale": { "height": 1, "width": 1, "depth": 1, "head": 1, "proportion": 0, "bodyType": 0 },
    "bodyColorFormat": "hex",
    "bodyColors": { "head": "A3A2A5", "torso": "A3A2A5", "leftArm": "A3A2A5", "rightArm": "A3A2A5", "leftLeg": "A3A2A5", "rightLeg": "A3A2A5" },
    "bodyParts": { "head": 11308945948, "torso": null, "leftArm": null, "rightArm": null, "leftLeg": null, "rightLeg": null },
    "dynamicHead": 11308945948,
    "clothing": { "shirt": null, "pants": null, "graphicTShirt": null },
    "face": null,
    "accessories": { "hat": [], "hair": [], "face": [], "neck": [], "shoulder": [], "front": [], "back": [], "waist": [] },
    "layeredClothing": [{ "assetId": 11308949065, "typeId": 76, "typeName": "EyebrowAccessory", "order": 2, "puffiness": 0 }],
    "animations": { "climb": null, "death": null, "fall": null, "idle": null, "jump": null, "run": null, "swim": null, "walk": null, "pose": null, "mood": 11308935548 },
    "emotes": [],
    "other": []
  },

  "assets": [
    { "id": 11308945948, "name": "Check It - Head", "typeId": 79, "typeName": "DynamicHead", "currentVersionId": 69499489978947, "supportsHeadShapes": true },
    { "id": 11308949065, "name": "Check It - Eyebrow", "typeId": 76, "typeName": "EyebrowAccessory", "currentVersionId": 14302683670, "meta": { "order": 2, "puffiness": 0, "version": 1 } }
  ]
}
```

Los dos bloques son deliberadamente redundantes y tienen trabajos distintos:

- **`humanoidDescription`** sirve para **reconstruir**: solo ids, ya agrupados por la ranura de `HumanoidDescription` a la que van. Studio lo aplica sin procesar nada.
- **`assets`** sirve para **mostrar**: nombres, versión y el `meta` crudo de Roblox reenviado verbatim.

Un outfit completo ocupa ~1,5 KB.

Notas sobre campos concretos:

- **`bodyColorFormat`** dice cómo leer `bodyColors`. Roblox mantiene vivos dos formatos: `"hex"` (`"A3A2A5"`, **sin** `#` — `Color3.fromHex` lo acepta igual) y `"brickColorId"` (`125` → `BrickColor.new(125).Color`).
- **`dynamicHead`** repite el id que ya está en `bodyParts.head`. Una cabeza dinámica ocupa la misma ranura que una normal, pero el juego necesita saber que lo es porque soporta expresiones y formas de cabeza.
- **`layeredClothing`** trae `order` y `puffiness` de cada pieza 3D. Sin ellos no se puede colocar bien la ropa por capas: es la diferencia entre «lleva zapatos» y «los lleva por encima o por debajo del pantalón». Un asset por capas aparece a la vez aquí y en su categoría.
- **`other`** recoge cualquier tipo de asset que Roblox devuelva y que no encaje en una ranura conocida. Nunca se descarta nada en silencio.
- Un `null` significa **«Roblox no lo proporcionó»**, nunca un valor rellenado por nuestra cuenta. `proportion: 0` y `bodyType: 0` son valores legítimos y distintos de `null`.

### Errores

Formato único: `{ "error": { "code", "message" } }`.

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
| 500 | `internal_error` | Fallo nuestro. El `X-Request-Id` lo cruza con el log. |

429 y 503 están separados a propósito: la reacción correcta es distinta.

---

## Consumo desde Roblox

```lua
local HttpService = game:GetService("HttpService")
local BASE, KEY = "https://<tu-servicio>.up.railway.app", "<OUTFIT_API_KEY>"

local function apiGet(path)
    local ok, res = pcall(HttpService.RequestAsync, HttpService, {
        Url = BASE .. path, Method = "GET", Headers = { ["x-api-key"] = KEY },
    })
    if not ok then return nil, "network" end
    local body = HttpService:JSONDecode(res.Body)
    if res.StatusCode == 200 then return body end
    return nil, body.error and body.error.code or tostring(res.StatusCode)
end

local function buildDescription(outfit)
    local hd = outfit.humanoidDescription
    local d  = Instance.new("HumanoidDescription")

    d.HeightScale, d.WidthScale     = hd.scale.height, hd.scale.width
    d.DepthScale,  d.HeadScale      = hd.scale.depth,  hd.scale.head
    d.ProportionScale, d.BodyTypeScale = hd.scale.proportion, hd.scale.bodyType

    if hd.bodyColorFormat == "hex" then
        d.HeadColor    = Color3.fromHex(hd.bodyColors.head)
        d.TorsoColor   = Color3.fromHex(hd.bodyColors.torso)
        d.LeftArmColor = Color3.fromHex(hd.bodyColors.leftArm)
        d.RightArmColor= Color3.fromHex(hd.bodyColors.rightArm)
        d.LeftLegColor = Color3.fromHex(hd.bodyColors.leftLeg)
        d.RightLegColor= Color3.fromHex(hd.bodyColors.rightLeg)
    end

    d.Head    = hd.bodyParts.head    or 0
    d.Torso   = hd.bodyParts.torso   or 0
    d.LeftArm = hd.bodyParts.leftArm or 0
    d.RightArm= hd.bodyParts.rightArm or 0
    d.LeftLeg = hd.bodyParts.leftLeg or 0
    d.RightLeg= hd.bodyParts.rightLeg or 0

    d.Shirt, d.Pants = hd.clothing.shirt or 0, hd.clothing.pants or 0
    d.GraphicTShirt, d.Face = hd.clothing.graphicTShirt or 0, hd.face or 0

    d.HatAccessory      = table.concat(hd.accessories.hat, ",")
    d.HairAccessory     = table.concat(hd.accessories.hair, ",")
    d.FaceAccessory     = table.concat(hd.accessories.face, ",")
    d.NeckAccessory     = table.concat(hd.accessories.neck, ",")
    d.ShouldersAccessory= table.concat(hd.accessories.shoulder, ",")
    d.FrontAccessory    = table.concat(hd.accessories.front, ",")
    d.BackAccessory     = table.concat(hd.accessories.back, ",")
    d.WaistAccessory    = table.concat(hd.accessories.waist, ",")

    d.ClimbAnimation = hd.animations.climb or 0
    d.FallAnimation  = hd.animations.fall  or 0
    d.IdleAnimation  = hd.animations.idle  or 0
    d.JumpAnimation  = hd.animations.jump  or 0
    d.RunAnimation   = hd.animations.run   or 0
    d.SwimAnimation  = hd.animations.swim  or 0
    d.WalkAnimation  = hd.animations.walk  or 0
    d.DeathAnimation = hd.animations.death or 0

    -- Ropa por capas: aplicar con AddAccessory usando Order y Puffiness de
    -- hd.layeredClothing, o mediante AccessoryBlob según tu flujo.
    return d
end

-- Una sola llamada de HttpService: resuelve el nombre y lista sus outfits.
local lista = apiGet("/v1/users/by-username/builderman/outfits?limit=25")
local outfit = apiGet("/v1/outfits/" .. lista.outfits[1].id)
local desc   = buildDescription(outfit)
```

Usa siempre el endpoint compuesto cuando partas de un nombre: `HttpService` tiene su propio presupuesto por servidor.

---

## Configuración

Solo `OUTFIT_API_KEY` es obligatoria.

| Variable | Por defecto | Para qué |
|---|---|---|
| `OUTFIT_API_KEY` | — | **Obligatoria.** El único secreto del servicio. |
| `PORT` | `3100` | La inyecta Railway. |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` |
| `TTL_USERNAME_MS` | 12 h | Caché de `username` → `userId`. |
| `TTL_OUTFIT_LIST_MS` | 5 min | Caché del listado. |
| `TTL_OUTFIT_DETAILS_MS` | 1 h | Caché del contenido de un outfit. |
| `TTL_ASSET_BUNDLES_MS` | 24 h | Caché de bundle por asset (global). |
| `TTL_NEGATIVE_MS` | 5 min | Caché de los 404. |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | 600 / 60 s | Límite propio, por IP. |
| `UPSTREAM_TIMEOUT_MS` | 6 s | Timeout de cada llamada a Roblox. |
| `UPSTREAM_MAX_CONCURRENT` | 3 | Techo global de llamadas simultáneas a Roblox. |
| `UPSTREAM_MAX_QUEUE` | 200 | Cola del gate; al llenarse se rechaza al instante. |
| `UPSTREAM_MAX_RETRIES` | 2 | Reintentos ante 429/5xx/red. |
| `MAX_BUNDLE_LOOKUPS_PER_REQUEST` | 24 | Tope de assets resueltos con `?bundles=1`. |
| `CACHE_MAX_ENTRIES` | 50 000 | Tope LRU en memoria. |
| `CACHE_DRIVER` | `memory` | Reservado para Redis. |

El límite propio va alto a propósito: quien llama son servidores de Roblox, y **una IP = decenas de jugadores**.

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

Genera la key con `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

---

## Desarrollo local

```bash
cd outfit-api
npm install
cp .env.example .env      # y pon una OUTFIT_API_KEY
npm start                 # escucha en 3100

npm test                  # 77 tests, sin red ni disco
npm run test:live         # verificación end-to-end contra la API real de Roblox
```

---

## Diseño

### Qué da Roblox y qué no

Comprobado en vivo contra 9 outfits reales antes de escribir una línea:

**`/v3/outfits/{id}/details` ya lo trae TODO en una sola respuesta.** Escalas, colores, tipo de avatar (`R6`/`R15`), y un array `assets` uniforme donde conviven sombreros, pelo, caras 2D, accesorios de cara, cuello, hombros, espalda y cintura, ropa clásica (Shirt/Pants/TShirt), ropa por capas con su `meta`, las cinco partes del cuerpo, cabezas dinámicas, animaciones y emotes. **Reconstruir un outfit cuesta exactamente una llamada a Roblox**: lo demás es agrupar en memoria.

**Lo que Roblox NO da:**

- **Total de outfits.** El listado solo devuelve `data` y `paginationToken`.
- **Bundles.** El detalle del outfit no los menciona en ningún campo. Ver abajo.
- **Emotes en outfits guardados.** El campo `emotes` existe en el avatar *actual* (`/v1/users/{id}/avatar`) pero nunca apareció en un outfit guardado. Si algún día aparece, `EmoteAnimation` ya está mapeado y saldrá solo.

### Bundles: por qué son opt-in

`?bundles=1` está apagado por defecto, y no por pereza. La única vía que ofrece Roblox es la búsqueda inversa `catalog/v1/assets/{assetId}/bundles`, con tres problemas comprobados:

1. **No admite lote.** Una petición por asset. El hermano `catalog/v1/bundles/details?bundleIds=` sí es por lotes, pero va en dirección contraria.
2. **Es incompleta.** «Man - Torso» (`12995020128`), que pertenece de verdad al bundle «Man», devuelve `data: []`.
3. **Trae ruido.** «Roblox Baseball Cap» (`607702162`) devuelve un bundle interno llamado «BundleForTesting».

Cuando funciona, funciona bien: con `?bundles=1` sobre «adidas Ice Angels» sale correctamente el bundle `193315158229798`. Pero presentarlo como dato garantizado sería afirmar más de lo que Roblox sostiene. Por eso se pide explícitamente, y el coste se amortiza: la pertenencia a bundle es un dato **estructural del asset**, cacheado 24 h de forma global, así que la segunda vez que cualquier jugador use esa pieza cuesta cero. Además tiene su **propio bucket** en el limitador, para que este camino opcional no pueda dejar sin cuota a los tres endpoints principales.

### Resto del diseño

**Superficie contra Roblox: tres endpoints públicos** (más el de bundles, solo bajo petición), todos en `src/roblox/client.js`, el único módulo que importa `axios`.

**Sin credenciales de Roblox.** Ni cookies, ni `.ROBLOSECURITY`, ni tokens. `withCredentials: false` y la ausencia de cookie jar lo hacen estructuralmente imposible.

**El mapeo va por nombre, no por id.** Roblox devuelve `assetType: {id, name}` y esos nombres coinciden casi literalmente con las propiedades de `HumanoidDescription`. Usar el nombre que da Roblox en lugar de una tabla de ids nuestra significa que no hay ni un solo valor inventado en la normalización.

**Sin cuotas asumidas.** No hay ningún «N req/min» codificado. Un 429 se trata como condición normal y la pauta la marca Roblox (`Retry-After`, `x-ratelimit-*`), con backoff exponencial y jitter cuando no manda nada, más un circuit breaker por ruta con recuperación half-open.

**Lo que de verdad protege los límites de Roblox es la caché.** TTL por entidad + LRU acotado + caché negativa + single-flight (500 peticiones simultáneas sobre una clave fría = 1 llamada a Roblox, verificado).

**Preparado para Redis.** Interfaz de caché ya asíncrona, claves namespaced y versionadas, valores planos serializables. Migrar es escribir `redisDriver.js` y cambiar `selectDriver()`.

**El secreto nunca sale.** `x-api-key` solo por cabecera, comparada en tiempo constante, ausente de toda respuesta —`/v1/metrics` incluida— y redactada por nombre en el logger.

### Estructura

```
server.js                        arranque, timeouts de socket, apagado limpio
src/app.js                       construye la app Express (sin listen)
src/config/                      único punto de lectura de process.env
src/api/                         rutas + traducción error → HTTP
src/services/humanoidDescription.js   normalización pura, cero llamadas extra
src/services/                    política de caché por entidad
src/roblox/                      cliente, limitador reactivo, breaker, errores
src/cache/                       fachada + driver de memoria + single-flight
src/security/                    API key, límite por IP
src/validation/                  validadores puros
src/observability/               logger JSON, log por petición, métricas
src/tests/                       77 tests sin red · fixtures/ con respuestas
                                 reales de Roblox · live/ verificación manual
```
