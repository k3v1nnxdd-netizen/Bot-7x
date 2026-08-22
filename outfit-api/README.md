# outfit-api

API independiente para **buscar usuarios de Roblox y consultar sus outfits públicos**, devolviendo todo lo necesario para reconstruir el avatar en Roblox Studio.

Servicio completamente autónomo: su propio `package.json`, sus propias dependencias, su propio proceso y su propia API key. **No comparte ni una línea de código con el bot de Discord ni con la API existente del repositorio**, y no escribe nada en disco.

---

## Endpoints

Todo lo que cuelga de `/v1` exige la cabecera `x-api-key`. `/health` no. Lo que cuelga de `/admin` exige **otra** cabecera, `x-admin-key` — ver [Administración de licencias](#administración-de-licencias).

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/health` | Healthcheck de Railway. Público, sin límite, sin llamadas a Roblox. |
| `GET` | `/v1/users/by-username/:username` | Resuelve `username` → `userId`. |
| `GET` | `/v1/users/:userId/outfits?limit=&pageToken=&outfitType=` | Lista los outfits **guardados** de un usuario. |
| `GET` | `/v1/users/by-username/:username/outfits?…` | Resuelve **y** lista en una sola llamada. |
| `GET` | `/v1/outfits/:outfitId?catalog=1&bundles=1` | Contenido completo del outfit. |
| `GET` | `/v1/metrics` | Observabilidad interna. Protegida. |
| `POST` | `/v1/catalog/batch` | Inteligencia de catálogo de un outfit entero. **`x-api-key` + token de licencia.** |
| `POST` | `/v1/license/verify` | ¿Puede este juego usar el sistema? **`x-api-key` + token de licencia.** |
| `POST` | `/admin/groups` | Autoriza un grupo. **`x-admin-key`.** |
| `GET` | `/admin/groups` | Lista los grupos autorizados. **`x-admin-key`.** |
| `GET` | `/admin/groups/:groupId` | ¿Está autorizado este grupo? **`x-admin-key`.** |
| `DELETE` | `/admin/groups/:groupId` | Retira la licencia. **`x-admin-key`.** |

`limit` solo admite **10, 25 o 50** (por defecto 25). `outfitType` solo admite **`Avatar`, `DynamicHead`, `Shoes`** — los tres valores que Roblox usa realmente.

### Listado y paginación por cursor

```
GET /v1/users/156/outfits?limit=25
{
  "userId": 156, "limit": 25, "outfitType": null,
  "count": 25, "hasMore": true,
  "nextPageToken": "MXx8fGlkXzJ6d0FBQVlubHF4WFl4QkJSU3po…",
  "outfits": [{ "id": 24477597, "name": "builderman2", "outfitType": "Avatar", "isEditable": true }]
}

GET /v1/users/156/outfits?limit=25&pageToken=MXx8fGlkXzJ6d0FBQVlubHF4WFl4QkJSU3po…
```

Para avanzar, reenvía el `nextPageToken` que recibiste como `pageToken`. **URL-encódealo** (puede contener `+`). Cuando `hasMore` es `false`, `nextPageToken` es `null` y el recorrido terminó.

**`page` no existe en esta API y se rechaza con 400.** Roblox lo documenta pero lo **ignora**: `page=1`, `page=2` y `page=3` devuelven exactamente los mismos outfits — ese era el síntoma. Lo que sí funciona es `paginationToken`, y cuando se agota Roblox devuelve **cadena vacía** (`""`), que es lo que traduce `hasMore: false`.

Roblox **no** devuelve ningún total en este endpoint (la respuesta solo trae `data` y `paginationToken`), así que no se expone ninguno.

**Solo outfits guardados.** El listado envía siempre `isEditable=true`, así que devuelve únicamente los outfits que el jugador guardó, no los derivados de bundles del catálogo. La diferencia es enorme: builderman devuelve 25+ entradas sin el filtro y exactamente **2** con él.

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

### Estado de catálogo — `?catalog=1`

Añade a cada asset si es limitado, si está fuera de venta y si Roblox todavía lo reconoce. **Una sola llamada por lote para el outfit entero**, no una por asset.

```json
"assets": [{
  "id": 11844853, "name": "Turbo Builders Club Hard Hat", "typeId": 8, "typeName": "Hat",
  "catalog": {
    "available": true, "restrictions": ["Limited"], "isLimited": true, "offSale": true,
    "price": 0, "lowestPrice": 0, "lowestResalePrice": 1100, "hasResellers": true,
    "creatorType": "User", "creatorTargetId": 1, "creatorName": "Roblox"
  }
}]
```

- **Un asset fuera de venta no desaparece.** Conserva su `assetId`, su nombre, su tipo y todo lo que Roblox siga dando. Sigue formando parte del avatar.
- **`available: false`** = Roblox no devolvió ficha para ese asset (borrado, moderado o fuera del catálogo). Se detecta por **ausencia** en la respuesta del lote, que es como Roblox lo señala. En ese caso el resto de campos van a `null` — «no se sabe», no `false`.
- **`catalogResolved: false`** en la raíz = alguna consulta falló por nuestro lado. Permite distinguir «Roblox dice que no existe» de «no lo pudimos comprobar».
- La ficha se cachea **por asset** (1 h) y de forma global: dos outfits que compartan sombrero comparten la entrada. Verificado en vivo: 10 assets → **1 llamada**; repetir → **0**.

### Errores

Formato único: `{ "error": { "code", "message" } }`.

| HTTP | `code` | Significado |
|---|---|---|
| 400 | `invalid_request` | Parámetro inválido. |
| 503 | `verificacion_no_disponible` | No se pudo comprobar la propiedad del juego con Roblox. Reintentar. |
| 401 | `unauthorized` | Falta o es incorrecta `x-api-key` (o `x-admin-key` en `/admin`). |
| 404 | `user_not_found` / `outfit_not_found` | No existe en Roblox. |
| 404 | `group_not_found` | Ese grupo no está en la whitelist (solo `DELETE`). |
| 404 | `route_not_found` | Ese endpoint no existe aquí. |
| 413 | `payload_too_large` | Cuerpo mayor de 4 kB en `POST /admin/groups`. |
| 429 | `rate_limited` | **Nuestro** límite. Baja el ritmo. Trae `Retry-After`. |
| 503 | `upstream_rate_limited` | Límite de **Roblox**. Espera el `Retry-After` y reintenta. |
| 503 | `upstream_unavailable` | Circuit breaker abierto: Roblox falla de forma sostenida. |
| 502 | `upstream_error` | Roblox devolvió 5xx o no respondió. |
| 503 | `database_unavailable` | Postgres no responde. Reintentar sirve. Solo en `/admin`. |
| 503 | `admin_disabled` | Falta `ADMIN_API_KEY` en el servidor. Solo en `/admin`. |
| 500 | `internal_error` | Fallo nuestro. El `X-Request-Id` lo cruza con el log. |

429 y 503 están separados a propósito: la reacción correcta es distinta. Por lo mismo, un fallo de Postgres es `503 database_unavailable` y no un `500`: dice de quién es el problema y si reintentar sirve de algo.

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

Solo `OUTFIT_API_KEY` es obligatoria para servir outfits. `DATABASE_URL` solo hace falta para la base de licencias: sin ella el servicio arranca igual y la API de outfits funciona con normalidad.

| Variable | Por defecto | Para qué |
|---|---|---|
| `OUTFIT_API_KEY` | — | **Obligatoria.** La key que usa el juego de Roblox (`x-api-key`). |
| `ADMIN_API_KEY` | — | Key de administración de licencias (`x-admin-key`). **Distinta de la anterior.** |
| `PORT` | `3100` | La inyecta Railway. |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` |
| `TTL_USERNAME_MS` | 12 h | Caché de `username` → `userId`. |
| `TTL_OUTFIT_LIST_MS` | 5 min | Caché del listado. |
| `TTL_OUTFIT_DETAILS_MS` | 1 h | Caché del contenido de un outfit. |
| `TTL_ASSET_BUNDLES_MS` | 24 h | Caché de bundle por asset (global). |
| `TTL_CATALOG_DETAILS_MS` | 1 h | Caché de ficha de catálogo por asset (global). |
| `TTL_NEGATIVE_MS` | 5 min | Caché de los 404. |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | 600 / 60 s | Límite propio, por IP. |
| `UPSTREAM_TIMEOUT_MS` | 6 s | Timeout de cada llamada a Roblox. |
| `UPSTREAM_MAX_CONCURRENT` | 3 | Techo global de llamadas simultáneas a Roblox. |
| `UPSTREAM_MAX_QUEUE` | 200 | Cola del gate; al llenarse se rechaza al instante. |
| `UPSTREAM_MAX_RETRIES` | 2 | Reintentos ante 429/5xx/red. |
| `MAX_BUNDLE_LOOKUPS_PER_REQUEST` | 24 | Tope de assets resueltos con `?bundles=1`. |
| `MAX_CATALOG_BATCH_SIZE` | 100 | Tamaño del lote a catalog/items/details. |
| `CACHE_MAX_ENTRIES` | 50 000 | Tope LRU en memoria. |
| `CACHE_DRIVER` | `memory` | Reservado para Redis. |
| `DATABASE_URL` | — | Postgres del sistema de licencias. La inyecta Railway al enlazar la base. |
| `DATABASE_SSL` | `auto` | `auto` \| `disable` \| `no-verify` \| `verify`. |
| `DB_POOL_MAX` | `5` | Conexiones por instancia. |
| `DB_CONNECTION_TIMEOUT_MS` | 8 s | Espera máxima por una conexión libre. |
| `DB_IDLE_TIMEOUT_MS` | 30 s | Cierre de conexiones ociosas. |
| `DB_STATEMENT_TIMEOUT_MS` | 10 s | Corte por consulta, del lado del servidor. |
| `DB_SCHEMA_MAX_RETRIES` | `4` | Intentos de aplicar el esquema al arrancar. |

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

El **Volume sigue siendo ninguno**: la caché es en memoria y el único estado persistente vive ahora en Postgres, no en disco.

---

## Base de datos (sistema de licencias)

Postgres entra **solo** para las licencias. La API de outfits no lo toca: es de lectura contra Roblox y su caché es en memoria, así que si la base no está disponible los outfits se sirven igual y lo único que queda inactivo es la parte de licencias.

**Conexión.** Únicamente por `DATABASE_URL` — no hay ni una cadena de conexión en el código. En Railway se enlaza el servicio con la base (referencia `${{Postgres.DATABASE_URL}}`, red privada) y la variable se inyecta sola. El TLS se resuelve solo con `DATABASE_SSL=auto`: sin TLS contra `*.railway.internal`, y TLS sin verificar certificado contra el proxy público `*.proxy.rlwy.net`, que usa uno autofirmado.

**Esquema.** Se aplica en cada arranque, después de empezar a escuchar y sin bloquear: el healthcheck responde desde el primer segundo. Todo el DDL es idempotente (`CREATE TABLE IF NOT EXISTS`), así que arrancar con la tabla ya creada es el caso normal, no una excepción. Se tolera además la carrera de dos instancias creando la tabla a la vez durante un redeploy (SQLSTATE `23505` / `42P07`), y se reintenta con backoff si la base todavía no acepta conexiones.

```sql
CREATE TABLE IF NOT EXISTS group_whitelist (
    group_id TEXT PRIMARY KEY,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

`group_id` es `TEXT` a propósito: los ids de grupo de Roblox llegan como cadena y JavaScript no representa enteros grandes sin perder precisión.

**Consultas siempre parametrizadas.** Todo pasa por `db.query(text, params)` de `src/db/pool.js`; ningún valor variable se concatena en el SQL. Para varias sentencias sobre la misma conexión (transacciones) está `db.withTransaction(fn)` — `query()` pide un cliente distinto en cada llamada, así que un `BEGIN` suelto no serviría de nada.

---

## Catálogo por lotes — `POST /v1/catalog/batch`

La **inteligencia de catálogo** de un outfit entero en una sola petición: nombre, precio, tipo, fuera de venta, limitado, reventa, a qué bundle pertenece cada asset, qué es una Dynamic Head, cuál es su Mood, qué es Korblox y qué es Headless — y, sobre todo, **qué tiene que comprobar el juego** para saber si el jugador lo posee.

### Doble puerta: `x-api-key` **y** token de licencia

```
POST /v1/catalog/batch
x-api-key: <OUTFIT_API_KEY>
Content-Type: application/json

{
  "token": "7xl_…",
  "gameId": "5432109876",
  "placeId": "1234567890",
  "assetIds": ["11308945948", "11308935548", "607702162"],
  "bundleIds": ["192"],
  "resolveBundles": true
}
```

`x-api-key` **no basta**, y es deliberado: esa clave viaja dentro del `.rbxl` que se vende, así que todo el que compre el sistema —o le robe una copia— la tiene. Sirve para decir «esto viene de un juego que usa el sistema», no «este juego ha pagado». Para lo segundo está el token, que es único por licencia y revocable de uno en uno.

La comprobación es **exactamente la misma cadena de `/v1/license/verify`**, reutilizada sin duplicar una línea (`src/security/licenseGuard.js` → `licenseService.verify`): token → licencia activa → **propiedad real del juego resuelta contra Roblox**. Un `creatorId` falsificado en el `.rbxl` no abre el catálogo. La propiedad sale de la caché de 6 h, así que abrir un outfit **no** vuelve a preguntarle a Roblox de quién es la experiencia.

Una licencia sin autorización responde `403 { "ok": false, "motivo": "…" }` — misma forma que `/v1/license/verify`, para que el juego no aprenda dos formatos.

### Límites

| | Máximo |
|---|---|
| `assetIds` | 64 |
| `bundleIds` | 32 |
| `assetIds + bundleIds` | 80 |
| Búsquedas inversas por petición | 8 |
| Cuerpo | 8 KB |

80 ítems caben de sobra en los 120 que admite `items/details`, así que **una petición nuestra nunca se parte en dos lotes de Roblox**. Pasarse → `400 invalid_request` antes de tocar caché o red.

### Respuesta

```jsonc
{
  "resolvedAt": "2026-08-22T18:04:11.482Z",
  "partial": false,
  "counts": { "assets": 3, "bundles": 2, "reverseLookups": 2 },

  "assets": [{
    "assetId": "11308945948",
    "found": true,
    "name": "Check It - Head",
    "assetType": { "id": 79, "name": "DynamicHead" },
    "price": null, "offSale": true, "limited": false, "restrictions": [],
    "resale": { "lowestPrice": null, "lowestResalePrice": null, "hasResellers": null, "collectibleItemId": null },
    "creator": { "type": "User", "id": "1", "name": "Roblox" },
    "bundleIds": ["968"],
    "special": "dynamicHead",
    "ownedVia": { "kind": "Bundle", "id": "968" }
  }],

  "bundles": [{
    "bundleId": "192",
    "found": true,
    "name": "Korblox Deathspeaker",
    "bundleType": "BodyParts",
    "price": 17000, "forSale": true, "limited": false,
    "assetIds": ["139607570", "139607625", "139607673", "139607718", "139607770", "139610147"],
    "special": "korblox"
  }],

  "ownershipChecks": [
    { "kind": "Bundle", "id": "968", "special": "dynamicHead", "covers": ["11308945948", "11308935548"] },
    { "kind": "Bundle", "id": "192", "special": "korblox",     "covers": ["139607718"] },
    { "kind": "Asset",  "id": "607702162", "special": null,    "covers": ["607702162"] }
  ],

  "unresolved": { "assetIds": [], "bundleIds": [], "reverseTruncated": 0 }
}
```

**Todos los ids son STRING** en petición, respuesta y lógica interna. Se aceptan como número por comodidad del cliente y se normalizan en la frontera: un id de Roblox cabe hoy en un entero seguro de JavaScript, pero el margen se estrecha cada año y una comparación que pierda precisión es imposible de depurar después.

`found: false` (Roblox ya no tiene ficha: borrado, moderado, fuera del catálogo) conserva **todas** las claves con `null`. `null` significa «no se sabe»; `false` significa «Roblox dijo que no». Nunca se inventa un cero.

### Lo único que le queda a Roblox

```lua
for _, check in ipairs(res.ownershipChecks) do
    local owned = (check.kind == "Bundle")
        and MarketplaceService:PlayerOwnsBundleAsync(player, tonumber(check.id))
        or  MarketplaceService:PlayerOwnsAssetAsync(player, tonumber(check.id))
    for _, assetId in ipairs(check.covers) do estado[assetId] = owned end
end
```

`ownershipChecks` es la lista **mínima y deduplicada**: la API colapsa N assets en 1 bundle. Una Dynamic Head y su Mood son **una** comprobación, no dos; las seis piezas de Korblox son **una**, no seis. Medido: un outfit de 20 assets con Dynamic Head + Korblox pasa de 20 comprobaciones a **19**, y de ~20 `GetProductInfoAsync` repartidos por 8 servicios a **cero**.

### Cuántas llamadas a Roblox cuesta

Medido con un outfit realista (20 assets: 1 Dynamic Head + 1 Mood + 1 pierna de Korblox + 17 accesorios):

| | Llamadas a Roblox |
|---|---|
| Outfit **frío** | **6** — `items/details(20)` + 3 inversas + `bundles/details(2)` + `items/details(2 bundles)` |
| Outfit **caliente** | **0** |
| Otro outfit que comparte 17 piezas | **1** (solo la pieza nueva) |

Tres olas, y ni una llamada de más:

1. **`items/details`** (lote mixto Asset+Bundle, ≤120) → metadatos, precio, offsale, limitado, reventa.
2. **`assets/{id}/bundles`** → el único endpoint sin lote, así que **solo se lanza para tipos que pueden venir en un bundle** (partes del cuerpo, Dynamic Heads y Moods). Un sombrero jamás gasta una llamada aquí. En un outfit típico son 1-3.
3. **`bundles/details`** (lote, ≤100) → composición del bundle + precio + reventa.

Todo se cachea **por ítem y de forma global**, nunca por outfit ni por jugador: dos jugadores con el mismo sombrero comparten entrada, y con `singleFlight` 200 servidores abriendo el mismo outfit frío producen **una** resolución, no 200. Las claves `asset:catalog:*` y `asset:bundles:*` son **las mismas** que usa `/v1/outfits?catalog=1&bundles=1`: resolver un asset aquí lo deja resuelto allí y al revés.

| Caché | TTL | Por qué |
|---|---|---|
| `asset:catalog:{id}` | 1 h | el precio se mueve despacio |
| `asset:bundles:{id}` | 24 h | la pertenencia a bundle no cambia nunca |
| `bundle:details:{id}` | 24 h | la composición es estructural |
| `bundle:catalog:{id}` | 1 h | el precio del bundle sí se mueve |

### Casos especiales

| Caso | Cómo se detecta | `special` | `ownedVia` |
|---|---|---|---|
| Dynamic Head | `assetType.id === 79` | `dynamicHead` | su bundle |
| Mood Animation | `assetType.id === 78` | `moodAnimation` | **el mismo bundle** que la cabeza |
| Korblox | pertenece al bundle `192` | `korblox` | `Bundle 192` |
| Headless | pertenece al bundle `201` | `headless` | `Bundle 201` |
| Parte del cuerpo | `assetType.id` ∈ 27–31 | `bodyPart` | su bundle si lo tiene |

Korblox y Headless llevan además un **registro curado** (`src/catalog/specialBundles.js`) porque la búsqueda inversa es incompleta —ya está documentado en este repo que «Man - Torso» devuelve `[]`, y se comprobó en vivo que la cabeza de Headless tampoco resuelve bundle—. Para los dos objetos más caros que un jugador puede llevar puesto, «casi siempre acierta» no vale. La búsqueda inversa sigue teniendo prioridad cuando responde; el registro es la red de seguridad.

### Fallos: parcial, y nunca un vacío mentiroso

- **Algo se resolvió** → `200` con `partial: true` y la lista exacta de lo que faltó en `unresolved`. El juego pinta lo que tiene.
- **No se resolvió nada y no había caché** → `503 upstream_unavailable` con `Retry-After`. Un `200` con la lista vacía le diría al juego «estos items no existen», que es falso: dejaría al jugador viendo un armario roto por un bache de Roblox.
- **Falla solo la búsqueda inversa** → el outfit se entrega igual; los assets afectados salen con `ownedVia` de tipo `Asset`, que es lo único que se sabe con certeza.

---

## Verificación de licencia — `POST /v1/license/verify`

Lo que el **juego** pregunta al arrancar: *¿este servidor puede usar el sistema?*

Cuelga de `/v1`, así que va detrás de `x-api-key` y del limitador por IP como el resto de lo que consume Roblox. **`ADMIN_API_KEY` no se acepta aquí y no debe aparecer nunca en un script de Roblox**: esa clave decide quién tiene licencia, y un script se distribuye a servidores que no controlamos. Lo que el juego presenta es su propio token, que solo le sirve a él y se puede revocar sin tocar nada más.

```
POST /v1/license/verify
x-api-key: <OUTFIT_API_KEY>
Content-Type: application/json

{ "token": "7xl_…", "gameId": 5432109876, "placeId": 1234567890,
  "creatorType": "Group", "creatorId": 35216530 }
```

```json
200 { "ok": true, "groupId": "35216530" }
403 { "ok": false, "motivo": "grupo_no_coincide" }
```

### La propiedad NO la declara el cliente: la resuelve la API

El comprador tiene el `.rbxl` en su ordenador. Puede abrir el script, cambiar cualquier número y mandar lo que quiera. **Todo lo que el juego afirma sobre a quién pertenece es una declaración suya, no un hecho** — usarla para autorizar equivale a preguntarle a alguien si tiene permiso y creerle.

Por eso `creatorId` y `creatorType` son **opcionales y puramente informativos**. La propiedad se averigua preguntándosela a Roblox:

```
placeId (lo declara el juego)
   │
   ├─► GET apis.roblox.com/universes/v1/places/{placeId}/universe
   │      → universeId REAL
   │      → ¿coincide con el gameId declarado?  si no: juego_no_coincide
   │
   └─► GET games.roblox.com/v1/games?universeIds={universeId REAL}
          → creator REAL { type: "Group"|"User", id }
          → ese id es el que se compara con el group_id de la licencia
```

El único dato del cliente que entra en la decisión es `placeId`, y **no como prueba de propiedad sino como puntero**: «mira este sitio y dime tú de quién es».

### La cadena, en este orden exacto

| # | Comprobación | Si falla |
|---|---|---|
| 1 | El token existe y su hash coincide con el guardado | `token_invalido` |
| 2 | La licencia está activa | `licencia_inactiva` |
| 3 | Roblox reconoce el `placeId` | `juego_desconocido` |
| 4 | El universo real de ese place **es** el `gameId` declarado | `juego_no_coincide` |
| 5 | El dueño **real** es un grupo (no un usuario) | `no_es_grupo` |
| 6 | Ese grupo **real** es el de la licencia | `grupo_no_coincide` |

Los pasos 3-6 van **después** del token a propósito: primero se demuestra quién eres y solo después se mira si eso encaja con dónde estás. Al revés, cualquiera podría sondear la propiedad de juegos ajenos sin presentar credencial — y además se gastaría una llamada a Roblox para atender a alguien sin licencia.

Un `creatorId` declarado que no coincida con el real **no cambia la decisión** (ya se tomó con datos reales) pero se registra como **aviso** en el log: es la firma de un `.rbxl` editado.

### Hasta dónde llega esto, y hasta dónde no

**Lo que resuelve:** nadie puede inventarse un dueño. Un `creatorId` falso en el JSON es irrelevante porque el resultado no sale del JSON. Para pasar por el grupo X hay que estar dentro de un universo que **Roblox** diga que es de X.

**Lo que no resuelve, dicho claramente:** `placeId` sigue siendo un dato que manda el cliente. Quien tenga el token de una licencia puede mandar el `placeId` real del cliente legítimo —es público— y la cadena dará que sí. Ningún esquema basado solo en un JSON de `HttpService` puede impedirlo, porque **Roblox no firma nada que demuestre desde qué servidor se está llamando**. Lo que se gana es que la mentira ahora tiene que ser *consistente con datos públicos de Roblox* en vez de ser una cifra inventada, y que el robo del `.rbxl` deja rastro en el log.

Para cerrar el resto haría falta una de estas dos, y ninguna es gratis:

- **Atar la licencia a un `universeId` concreto** al emitirla. El pirata tendría que ejecutar dentro del universo del cliente legítimo, donde el dueño del grupo controla quién publica.
- **Intercambio con Open Cloud**: la API entrega un nonce y el juego debe devolverlo por un canal que exija credenciales del propio cliente (DataStore/MessagingService vía Open Cloud). Es la única forma de probar identidad de verdad, y obliga al cliente a dar una API key suya.

### Otras respuestas

- **400** `{"error":{"code":"invalid_request",…}}` — la petición está mal formada (falta `token`, `gameId` o `placeId`, o un id que no es número). Es un bug del script que llama, no una denegación, y por eso se distingue.
- **503** `verificacion_no_disponible` — **Roblox no responde** (caído, limitándonos, o con el breaker abierto). Lleva `Retry-After`.
- **503** `database_unavailable` — Postgres no responde.

**Ni Roblox caído ni Postgres caído producen jamás un 403.** Es la regla que impide que un mal rato de un tercero eche a todos los clientes legítimos de sus propios juegos: «ahora mismo no lo sé, reintenta» no es lo mismo que «no eres el dueño». Para el juego, la lógica es: `200` → autorizado; `403` → denegado de verdad, con motivo; **cualquier otro código** → temporal, reintentar con backoff y mantener el último estado conocido.

La resolución de propiedad se **cachea por `placeId` 6 h** (`TTL_GAME_OWNERSHIP_MS`), con single-flight: 200 servidores del mismo juego arrancando a la vez producen **una** resolución, no 200. Esa caché es además lo que sostiene la verificación durante un bache de Roblox — un juego ya visto se sigue verificando con lo que Roblox dijo hace un rato, que para «de quién es este universo» sigue siendo verdad.

Un token con forma imposible responde **exactamente igual** que uno desconocido (`token_invalido`, sin llegar a consultar la base ni a Roblox). Distinguirlos solo ayudaría a quien está probando tokens.

**El token nunca se registra**, ni entero, ni en trozos, ni su hash. `gameId` y `placeId` sí, junto al dueño real y al declarado: es lo que convierte el log en algo útil cuando alguien reclama.

### Desde Roblox (Lua)

```lua
local HttpService = game:GetService("HttpService")

local respuesta = HttpService:RequestAsync({
    Url = "https://<tu-servicio>.up.railway.app/v1/license/verify",
    Method = "POST",
    Headers = { ["Content-Type"] = "application/json", ["x-api-key"] = OUTFIT_API_KEY },
    Body = HttpService:JSONEncode({
        token   = LICENSE_TOKEN,   -- el que se entregó al dar de alta
        gameId  = game.GameId,     -- universeId; se contrasta con el place
        placeId = game.PlaceId,    -- el puntero que usa la API para preguntar a Roblox
        -- Opcionales, solo informativos: la API NO los usa para decidir.
        creatorType = tostring(game.CreatorType.Name),
        creatorId   = game.CreatorId,
    }),
})

local datos = HttpService:JSONDecode(respuesta.Body)

if respuesta.StatusCode == 200 and datos.ok then
    print("Licencia OK para el grupo " .. datos.groupId)
elseif respuesta.StatusCode == 403 then
    warn("Sin licencia: " .. tostring(datos.motivo))   -- denegación definitiva
else
    warn("No se pudo verificar ahora mismo, reintentando...")  -- 5xx: temporal
end
```

---

## Administración de licencias

Cuatro endpoints sobre `group_whitelist`, protegidos por **`ADMIN_API_KEY`** en la cabecera **`x-admin-key`**.

**Quién los consume:** el bot de Discord, con `/addgroup`, `/deletegroup`, `/checkgroup` y `/groups` (ver `handlers/groupLicenses.js` y `utils/outfitApi.js` en la raíz del repo). El bot **no** se conecta a Postgres: todo pasa por aquí, que es lo que mantiene un único sitio donde se decide quién tiene licencia.

**Dos secretos separados, y no es ceremonia.** `OUTFIT_API_KEY` vive dentro de un script de Roblox distribuido a servidores que no controlamos: hay que darla por filtrable. Si esa misma clave sirviera para administrar, cualquiera que la extrajera del juego podría autorizarse a sí mismo. Por eso van en **variables distintas y cabeceras distintas**: ninguna de las dos abre la puerta de la otra, y el servicio protesta por consola al arrancar si las configuras iguales. Están fuera de `/v1` por la misma razón: `/v1` es el contrato que consume Roblox, esto es un panel interno.

| Método | Ruta | Respuesta |
|---|---|---|
| `POST` | `/admin/groups` | `201` si es alta nueva, `200` si ya estaba (idempotente). |
| `GET` | `/admin/groups?includeInactive=&limit=&offset=` | Listado paginado con `total` y `hasMore`. |
| `GET` | `/admin/groups/:groupId` | `200` siempre, con `authorized` booleano. |
| `DELETE` | `/admin/groups/:groupId?purge=1&reason=&actor=` | Desactiva (o borra con `purge=1`). `404` si no está. |

Cuatro decisiones que conviene conocer antes de consumirlos:

- **Dar de alta dos veces no es un error.** `POST` es un UPSERT: si el grupo ya existe lo **reactiva** conservando su `created_at` original, y responde `200` con `created: false` en vez de `201`. Readmitir a un cliente es la operación normal, no un caso raro.
- **`GET /admin/groups/:groupId` de un grupo que no está devuelve `200`, no `404`.** La pregunta es «¿está autorizado?», y «no» es una respuesta válida, no un recurso ausente. Trae `authorized` (el booleano que se usa) y `found` aparte, para poder distinguir «nunca estuvo» de «se le retiró la licencia».
- **`DELETE` desactiva, no borra.** Conserva la fila y la fecha de alta, que es lo que hace falta el día que alguien reclame un pago. Con `?purge=1` sí se borra de verdad.
- **La licencia guarda a quién pertenece.** Además del grupo, la fila lleva el usuario de Discord enlazado, el usuario de Roblox del comprador, quién dio el alta y cuándo, y —si se retiró— por qué y quién. Todo eso viaja en la misma respuesta de los cuatro endpoints, con la **misma forma** siempre.

### Credencial de la licencia (token)

Cada licencia lleva un **token propio**: 256 bits aleatorios con prefijo `7xl_`, que vive dentro del juego del cliente y solo le sirve a él.

**De la base nunca se puede sacar un token.** Se guarda su **SHA-256** en `license_token_hash` y nada más. Si esta tabla se filtrara —una copia mal guardada, un volcado en un ticket— con los hashes nadie puede suplantar a ningún cliente.

- **Alta nueva** → se genera un token, se guarda su hash y el token en claro **se devuelve una sola vez** en la respuesta del `POST`. No hay forma de volver a consultarlo.
- **Reactivación** → **no se cambia el token**. El juego del cliente sigue funcionando sin tocar una línea. La respuesta trae `token: null` y `tokenIssued: false`.
- **Licencia antigua sin token** (las anteriores a esto) → adopta uno la próxima vez que se dé de alta. No es cambiárselo: es que no tenía ninguno.

SHA-256 a secas y **no** bcrypt/argon2 a propósito: eso es lo correcto para contraseñas, que las elige una persona y tienen poquísima entropía. Aquí son 256 bits aleatorios —no hay diccionario que probar— y esta ruta se llama desde el juego en caliente, así que un hash lento solo compraría latencia. El hash determinista es además lo que permite **buscar por clave única** en vez de leer la tabla entera comparando fila a fila.

Un índice `UNIQUE` sobre `license_token_hash` garantiza en la base —y no solo en el código— que una credencial no pueda autorizar a dos grupos.

### Qué guarda cada licencia

| Campo | Columna | Qué es |
|---|---|---|
| `groupId` | `group_id` | Id del grupo de Roblox, como texto. Clave primaria. |
| `active` | `active` | Si la licencia está vigente ahora mismo. |
| `createdAt` | `created_at` | **Alta original.** No se reescribe nunca, ni al readmitir. |
| `linkedAt` | `linked_at` | **Último enlace o reactivación.** Se actualiza en cada `POST`. |
| `discordUserId` | `discord_user_id` | Usuario de Discord al que está enlazada. |
| `robloxUsername` | `roblox_username` | Usuario de Roblox del comprador. |
| `groupName` | `group_name` | Nombre del grupo tal como estaba en Roblox al darlo de alta. |
| `addedBy` | `added_by` | Quién hizo el alta o la reactivación. |
| `deactivatedAt` / `deactivatedBy` / `deactivationReason` | ídem | Rastro de la baja. Se limpia al reactivar. |
| *(nunca se expone)* | `license_token_hash` | SHA-256 del token. **No sale en ninguna respuesta**, ni siquiera en `/admin`. |

**Todas las columnas nuevas son opcionales y `NULL`-ables**, y el esquema se amplía con `ADD COLUMN IF NOT EXISTS` (ver `src/db/schema.js`): las licencias que ya existían **no se tocan** y siguen funcionando con esos campos a `null`. Un `POST` que no manda un dato **no borra** el que hubiera (`COALESCE(EXCLUDED.x, tabla.x)`), así que un `curl` suelto no puede vaciar la ficha de un cliente; mandarlo sí lo actualiza.

`groupName` se guarda además de consultarse en vivo por una razón concreta: el listado de 50 licencias del bot se pinta con **una** llamada a esta API y **cero** a Roblox.

### Ejemplos

```bash
ADMIN="tu-ADMIN_API_KEY"
BASE="https://<tu-servicio>.up.railway.app"

# Agregar (201 la primera vez, 200 las siguientes).
# Solo groupId es obligatorio; el resto son los datos de la licencia.
curl -X POST "$BASE/admin/groups" \
  -H "x-admin-key: $ADMIN" -H "Content-Type: application/json" \
  -d '{"groupId":"35216530","discordUserId":"996310284803248158",
       "robloxUsername":"CompradorRblx","groupName":"Mi Grupo",
       "addedBy":"996310284803248158"}'
# {"groupId":"35216530","active":true,"createdAt":"2026-08-21T18:04:11.482Z",
#  "linkedAt":"2026-08-21T18:04:11.482Z","discordUserId":"996310284803248158",
#  "robloxUsername":"CompradorRblx","groupName":"Mi Grupo","addedBy":"996310284803248158",
#  "deactivatedAt":null,"deactivatedBy":null,"deactivationReason":null,
#  "created":true,"authorized":true}

# Comprobar si está autorizado
curl "$BASE/admin/groups/35216530" -H "x-admin-key: $ADMIN"
# {"groupId":"35216530","authorized":true,"found":true,"active":true, ...misma forma...}

# Listar (solo activos; añade ?includeInactive=1 para ver también las bajas)
curl "$BASE/admin/groups?includeInactive=1" -H "x-admin-key: $ADMIN"
# {"total":1,"count":1,"limit":100,"offset":0,"includeInactive":true,"hasMore":false,
#  "groups":[{"groupId":"35216530","active":true,"groupName":"Mi Grupo", ...}]}

# Retirar la licencia (la fila se conserva, active pasa a false).
# reason y actor quedan guardados con la baja.
curl -X DELETE "$BASE/admin/groups/35216530?reason=Reembolso&actor=996310284803248158" \
  -H "x-admin-key: $ADMIN"
# {"groupId":"35216530","active":false,"createdAt":"...","deactivationReason":"Reembolso",
#  "deactivatedBy":"996310284803248158","authorized":false,"purged":false}

# Borrar la fila de verdad
curl -X DELETE "$BASE/admin/groups/35216530?purge=1" -H "x-admin-key: $ADMIN"
```

En PowerShell:

```powershell
$H = @{ "x-admin-key" = "tu-ADMIN_API_KEY" }
$BASE = "https://<tu-servicio>.up.railway.app"

$body = '{"groupId":"35216530","discordUserId":"996310284803248158","robloxUsername":"CompradorRblx","groupName":"Mi Grupo","addedBy":"996310284803248158"}'
Invoke-RestMethod -Method Post -Uri "$BASE/admin/groups" -Headers $H `
  -ContentType "application/json" -Body $body
Invoke-RestMethod -Uri "$BASE/admin/groups/35216530" -Headers $H
Invoke-RestMethod -Uri "$BASE/admin/groups?includeInactive=1" -Headers $H
Invoke-RestMethod -Method Delete -Uri "$BASE/admin/groups/35216530?reason=Reembolso" -Headers $H
```

### Cómo comprobar que todo esto está bien

```bash
npm test                  # 216 tests sin red ni base de datos (incluye /admin y la verificacion de licencia)
npm run db:check          # contra el Postgres real: conexión, tabla, columnas, PK,
                          # y el alta/consulta/baja/purga completos del servicio
```

Los tests de `/admin` sustituyen la base por un doble, así que verifican el cableado (separación de claves, validación, parametrización, códigos de error) pero **no** que el SQL sea válido para Postgres — eso solo lo puede decir Postgres, y es lo que hace `db:check`, que ejecuta el UPSERT, la función de ventana del listado y el `UPDATE` de baja de verdad y luego limpia lo que creó.

Desde fuera del proceso, `GET /v1/metrics` trae un bloque `db` con `configured`, `schemaReady`, contadores y el último SQLSTATE. Nunca la cadena de conexión.

---

## Desarrollo local

```bash
cd outfit-api
npm install
cp .env.example .env      # y pon una OUTFIT_API_KEY
npm start                 # escucha en 3100

npm test                  # 216 tests, sin red ni base de datos
npm run test:live         # verificación end-to-end contra la API real de Roblox
npm run db:check          # verificación contra el Postgres real (necesita DATABASE_URL)
```

---

## Diseño

### Auditoría: qué se puede obtener de un outfit

Comprobado contra respuestas reales de los endpoints oficiales, no contra documentación.

| Dato | ¿Se obtiene? | De dónde | Coste |
|---|---|---|---|
| ID y nombre | ✅ | `v3/outfits/{id}/details` | incluido |
| `outfitType` | ✅ | `v3` details **y** `v2` listado | incluido |
| `isEditable` | ✅ | `v3` details **y** `v2` listado | incluido |
| R6 / R15 (`playerAvatarType`) | ✅ | `v3` details | incluido |
| BodyParts + sus IDs | ✅ | `v3` details (tipos 17, 27-31, 79) | incluido |
| Colores exactos del cuerpo (6) | ✅ | `v3` details → `bodyColor3s` (hex) | incluido |
| Escala completa (6) | ✅ | `v3` details → `scale` | incluido |
| Accesorios (8 categorías) | ✅ | `v3` details | incluido |
| Ropa clásica (Shirt/Pants/TShirt) | ✅ | `v3` details | incluido |
| Layered Clothing + `order`/`puffiness` | ✅ | `v3` details → `assets[].meta` | incluido |
| Dynamic Head + `supportsHeadShapes` | ✅ | `v3` details | incluido |
| Cara (Face 2D) | ✅ | `v3` details | incluido |
| IDs de todos los assets | ✅ | `v3` details | incluido |
| Datos para el `HumanoidDescription` | ✅ | `v3` details | incluido |
| Assets **limitados** | ✅ `?catalog=1` | `catalog/v1/catalog/items/details` | **1 llamada por lote** |
| Assets **fuera de venta** | ✅ `?catalog=1` | ídem | ídem |
| Assets **eliminados / no disponibles** | ✅ `?catalog=1` | ídem (ausencia = señal) | ídem |
| **Animaciones** de movimiento | ⚠️ ver abajo | — | — |
| **Emotes** | ❌ no están en el outfit | `v1/users/{id}/avatar` (avatar actual) | otro endpoint |
| **Bundles** | ⚠️ parcial, `?bundles=1` | `catalog/v1/assets/{id}/bundles` | **1 por asset** |

**Todo lo marcado «incluido» sale de UNA sola llamada a Roblox.** Reconstruir un outfit no cuesta ni una petición por accesorio.

#### Animaciones y emotes: la respuesta concreta

Esto se comprobó específicamente, porque es fácil confundirlo:

- **Emotes: NO pertenecen al outfit guardado.** El campo `emotes` **no existe** en la respuesta de `v3/outfits/{id}/details` — ni vacío ni nulo, no está. Sus claves de nivel superior son exactamente `id, name, assets, bodyColor3s, scale, playerAvatarType, outfitType, isEditable, universeId, inventoryType`. El campo `emotes` **solo** aparece en `v1/users/{userId}/avatar`, que describe el **avatar actual** del jugador, no un outfit guardado. Son dos cosas distintas y aquí no se mezclan.

- **Animaciones de movimiento: no observadas en ningún outfit guardado.** Los assets de animación (`ClimbAnimation` 48, `FallAnimation` 50, `IdleAnimation` 51, `JumpAnimation` 52, `RunAnimation` 53, `SwimAnimation` 54, `WalkAnimation` 55) **sí** aparecen en el `assets` del **avatar actual** (verificado con la cuenta Roblox). En los outfits **guardados** examinados —4 de 2 usuarios, más 9 derivados de catálogo— no apareció ninguno. No puedo demostrar que Roblox nunca los guarde, así que el mapeo está preparado: si algún día llegan, se rellenan solas. Mientras no lleguen, esas ranuras quedan en `null` en lugar de inventarse.

- **`MoodAnimation` sí viene**, porque forma parte del bundle de la cabeza dinámica, no de un paquete de animaciones.

**Si necesitas animaciones o emotes**, el endpoint oficial adicional es `GET https://avatar.roblox.com/v1/users/{userId}/avatar` — pero devuelve el **avatar puesto ahora mismo**, no el outfit guardado que estés mostrando. Dímelo y lo añado como endpoint aparte, sin mezclarlo con este.

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
src/db/                          pool de Postgres + esquema idempotente
src/security/                    API key, límite por IP
src/validation/                  validadores puros
src/observability/               logger JSON, log por petición, métricas
src/tests/                       136 tests sin red ni base de datos · fixtures/
                                 con respuestas reales de Roblox · live/
                                 verificación manual (Roblox y Postgres)
```
