--!nolint
--[[
	7x Outfit Importer — FUENTE CANONICA del plugin de Roblox Studio.

	Este archivo es la version que corre en Studio, extraida del plugin
	instalado y verificada alli. No es una reescritura ni una aproximacion: el
	repositorio y lo que se ejecuta tienen que decir lo mismo, o dejan de
	servir de nada el uno al otro.

	QUE HACE, de arriba abajo:

	  - POST a /plugin/outfits/search y entiende las DOS respuestas posibles:
	    la TERMINAL del indice (sin searchId, con los outfits ya dentro) y la
	    asincrona de siempre (con searchId, que se sondea).
	  - Con 'completed' o 'partial' importa TODO lo recibido. Ochenta y uno de
	    cien son ochenta y un outfits que insertar, no una razon para esperar.
	  - `importOutfits` es la unica puerta de entrada a la importacion, y por
	    ella pasan los dos caminos.
	  - Cada outfit se convierte en un Model R15 armado con
	    CreateHumanoidModelFromDescription, con su HumanoidDescription como
	    hijo directo del Humanoid y un nombre unico con prefijo 7x.
	  - Antes de parentar se borra cualquier LuaSourceContainer (el Animate que
	    Roblox mete en el rig, y cualquier otro).
	  - El modelo entra en Workspace.Outfits ARMADO, NOMBRADO y COLOCADO. Ni un
	    paso antes.
	  - Un outfit que falle no detiene a los demas, y al final se dice cuantos
	    se insertaron y cuantos fallaron.

	LO QUE NO HACE, y es deliberado: no crea ProximityPrompt, ni scripts, ni
	atributos, ni likes, ni ancla las partes. De todo eso se encarga el sistema
	del juego cuando detecta que entra un Model en Workspace.Outfits.

	LA CLAVE NO ESTA AQUI y no debe estarlo nunca.
]]

assert(
	plugin,
	"Este script debe ejecutarse como plugin"
)

local HttpService =
	game:GetService("HttpService")

-- =========================================================
-- CONFIGURACIÓN
-- =========================================================

local API_URL =
	"https://outfit-api-production.up.railway.app/plugin/outfits/search"

-- LA CLAVE NO VIVE EN EL REPOSITORIO. Se pega en la copia instalada, en
-- local, y se regenera en Railway cuando toque. Un secreto en el control de
-- versiones sigue estando ahi despues de borrarlo.
local PLUGIN_API_KEY =
	""

-- Cada cuánto consultar el progreso del job.
-- 0.75 segundos = polling moderado, sin spamear la API.
local POLL_INTERVAL = 0.75

-- =========================================================
-- TOOLBAR
-- =========================================================

local toolbar =
	plugin:CreateToolbar(
		"7x Tools"
	)

local openButton =
	toolbar:CreateButton(
		"7x Outfit Importer",
		"Abrir 7x Outfit Importer",
		""
	)

-- =========================================================
-- VENTANA
-- =========================================================

local widgetInfo =
	DockWidgetPluginGuiInfo.new(
		Enum.InitialDockState.Float,

		false,
		false,

		420,
		670,

		360,
		520
	)

local widget =
	plugin:CreateDockWidgetPluginGui(
		"7xOutfitImporter",
		widgetInfo
	)

widget.Title =
	"7x Outfit Importer"

openButton.Click:Connect(
	function()

		widget.Enabled =
			not widget.Enabled

	end
)

-- =========================================================
-- FONDO
-- =========================================================

local background =
	Instance.new("Frame")

background.Name =
	"Background"

background.Size =
	UDim2.fromScale(
		1,
		1
	)

background.BackgroundColor3 =
	Color3.fromRGB(
		25,
		25,
		28
	)

background.BorderSizePixel =
	0

background.Parent =
	widget

local padding =
	Instance.new("UIPadding")

padding.PaddingTop =
	UDim.new(
		0,
		20
	)

padding.PaddingBottom =
	UDim.new(
		0,
		20
	)

padding.PaddingLeft =
	UDim.new(
		0,
		20
	)

padding.PaddingRight =
	UDim.new(
		0,
		20
	)

padding.Parent =
	background

local layout =
	Instance.new("UIListLayout")

layout.Padding =
	UDim.new(
		0,
		10
	)

layout.SortOrder =
	Enum.SortOrder.LayoutOrder

layout.Parent =
	background

-- =========================================================
-- HELPERS DE UI
-- =========================================================

local function createLabel(
	text,
	order
)

	local label =
		Instance.new(
			"TextLabel"
		)

	label.LayoutOrder =
		order

	label.Size =
		UDim2.new(
			1,
			0,
			0,
			22
		)

	label.BackgroundTransparency =
		1

	label.Text =
		text

	label.TextColor3 =
		Color3.fromRGB(
			200,
			200,
			205
		)

	label.TextSize =
		14

	label.Font =
		Enum.Font.Gotham

	label.TextXAlignment =
		Enum.TextXAlignment.Left

	label.Parent =
		background

	return label

end

local function createTextBox(
	defaultText,
	placeholder,
	order
)

	local box =
		Instance.new(
			"TextBox"
		)

	box.LayoutOrder =
		order

	box.Size =
		UDim2.new(
			1,
			0,
			0,
			42
		)

	box.BackgroundColor3 =
		Color3.fromRGB(
			38,
			38,
			42
		)

	box.BorderSizePixel =
		0

	box.Text =
		defaultText

	box.PlaceholderText =
		placeholder

	box.TextColor3 =
		Color3.fromRGB(
			255,
			255,
			255
		)

	box.PlaceholderColor3 =
		Color3.fromRGB(
			120,
			120,
			125
		)

	box.TextSize =
		15

	box.Font =
		Enum.Font.Gotham

	box.ClearTextOnFocus =
		false

	box.Parent =
		background

	local corner =
		Instance.new(
			"UICorner"
		)

	corner.CornerRadius =
		UDim.new(
			0,
			8
		)

	corner.Parent =
		box

	local inputPadding =
		Instance.new(
			"UIPadding"
		)

	inputPadding.PaddingLeft =
		UDim.new(
			0,
			12
		)

	inputPadding.PaddingRight =
		UDim.new(
			0,
			12
		)

	inputPadding.Parent =
		box

	return box

end

local function formatMilliseconds(
	milliseconds
)

	if type(milliseconds)
		~= "number" then

		return nil

	end

	if milliseconds ~= milliseconds then
		return nil
	end

	if milliseconds < 0 then
		return nil
	end

	if milliseconds == math.huge then
		return nil
	end

	local seconds =
		milliseconds / 1000

	if seconds < 1 then

		return "<1 s"

	end

	if seconds < 60 then

		return string.format(
			"%.1f s",
			seconds
		)

	end

	local minutes =
		math.floor(
			seconds / 60
		)

	local remainingSeconds =
		math.floor(
			seconds % 60
		)

	return string.format(
		"%dm %02ds",
		minutes,
		remainingSeconds
	)

end

-- =========================================================
-- TÍTULO
-- =========================================================

local title =
	Instance.new(
		"TextLabel"
	)

title.LayoutOrder =
	1

title.Size =
	UDim2.new(
		1,
		0,
		0,
		38
	)

title.BackgroundTransparency =
	1

title.Text =
	"7x Outfit Importer"

title.TextColor3 =
	Color3.fromRGB(
		255,
		255,
		255
	)

title.TextSize =
	22

title.Font =
	Enum.Font.GothamBold

title.TextXAlignment =
	Enum.TextXAlignment.Left

title.Parent =
	background

-- =========================================================
-- CAMPOS
-- =========================================================

createLabel(
	"Cantidad de outfits",
	2
)

local amountBox =
	createTextBox(
		"100",
		"Ejemplo: 100",
		3
	)

createLabel(
	"ID de comunidad",
	4
)

local groupBox =
	createTextBox(
		"59218460",
		"Ejemplo: 59218460",
		5
	)

createLabel(
	"Precio mínimo",
	6
)

local minPriceBox =
	createTextBox(
		"100",
		"Ejemplo: 100",
		7
	)

createLabel(
	"Precio máximo",
	8
)

local maxPriceBox =
	createTextBox(
		"3000",
		"Ejemplo: 3000",
		9
	)

-- =========================================================
-- BOTÓN BUSCAR
-- =========================================================

local searchButton =
	Instance.new(
		"TextButton"
	)

searchButton.LayoutOrder =
	10

searchButton.Size =
	UDim2.new(
		1,
		0,
		0,
		48
	)

searchButton.BackgroundColor3 =
	Color3.fromRGB(
		70,
		110,
		255
	)

searchButton.BorderSizePixel =
	0

searchButton.Text =
	"BUSCAR"

searchButton.TextColor3 =
	Color3.fromRGB(
		255,
		255,
		255
	)

searchButton.TextSize =
	15

searchButton.Font =
	Enum.Font.GothamBold

searchButton.Parent =
	background

local searchCorner =
	Instance.new(
		"UICorner"
	)

searchCorner.CornerRadius =
	UDim.new(
		0,
		8
	)

searchCorner.Parent =
	searchButton

-- =========================================================
-- ESTADO
-- =========================================================

local statusLabel =
	Instance.new(
		"TextLabel"
	)

statusLabel.LayoutOrder =
	11

statusLabel.Size =
	UDim2.new(
		1,
		0,
		0,
		42
	)

statusLabel.BackgroundTransparency =
	1

statusLabel.Text =
	"Esperando..."

statusLabel.TextColor3 =
	Color3.fromRGB(
		150,
		150,
		155
	)

statusLabel.TextSize =
	13

statusLabel.Font =
	Enum.Font.Gotham

statusLabel.TextWrapped =
	true

statusLabel.TextXAlignment =
	Enum.TextXAlignment.Left

statusLabel.TextYAlignment =
	Enum.TextYAlignment.Top

statusLabel.Parent =
	background

-- =========================================================
-- TEXTO DE PROGRESO
-- =========================================================

local progressText =
	Instance.new(
		"TextLabel"
	)

progressText.LayoutOrder =
	12

progressText.Size =
	UDim2.new(
		1,
		0,
		0,
		22
	)

progressText.BackgroundTransparency =
	1

progressText.Text =
	"0 / 0 encontrados"

progressText.TextColor3 =
	Color3.fromRGB(
		230,
		230,
		235
	)

progressText.TextSize =
	13

progressText.Font =
	Enum.Font.GothamMedium

progressText.TextXAlignment =
	Enum.TextXAlignment.Left

progressText.Parent =
	background

-- =========================================================
-- BARRA DE PROGRESO
-- =========================================================

local progressTrack =
	Instance.new(
		"Frame"
	)

progressTrack.LayoutOrder =
	13

progressTrack.Size =
	UDim2.new(
		1,
		0,
		0,
		10
	)

progressTrack.BackgroundColor3 =
	Color3.fromRGB(
		45,
		45,
		50
	)

progressTrack.BorderSizePixel =
	0

progressTrack.Parent =
	background

local trackCorner =
	Instance.new(
		"UICorner"
	)

trackCorner.CornerRadius =
	UDim.new(
		1,
		0
	)

trackCorner.Parent =
	progressTrack

local progressFill =
	Instance.new(
		"Frame"
	)

progressFill.Name =
	"Fill"

progressFill.Size =
	UDim2.fromScale(
		0,
		1
	)

progressFill.BackgroundColor3 =
	Color3.fromRGB(
		70,
		110,
		255
	)

progressFill.BorderSizePixel =
	0

progressFill.Parent =
	progressTrack

local fillCorner =
	Instance.new(
		"UICorner"
	)

fillCorner.CornerRadius =
	UDim.new(
		1,
		0
	)

fillCorner.Parent =
	progressFill

-- =========================================================
-- META DE PROGRESO
-- =========================================================

local progressMeta =
	Instance.new(
		"TextLabel"
	)

progressMeta.LayoutOrder =
	14

progressMeta.Size =
	UDim2.new(
		1,
		0,
		0,
		48
	)

progressMeta.BackgroundTransparency =
	1

progressMeta.Text =
	"Sin búsqueda activa."

progressMeta.TextColor3 =
	Color3.fromRGB(
		145,
		145,
		150
	)

progressMeta.TextSize =
	12

progressMeta.Font =
	Enum.Font.Gotham

progressMeta.TextWrapped =
	true

progressMeta.TextXAlignment =
	Enum.TextXAlignment.Left

progressMeta.TextYAlignment =
	Enum.TextYAlignment.Top

progressMeta.Parent =
	background

-- =========================================================
-- VALIDACIÓN
-- =========================================================

local function readInteger(
	box,
	name
)

	local value =
		tonumber(
			box.Text
		)

	if value == nil then

		return nil,
			name
			.. " debe ser un número."

	end

	if value % 1 ~= 0 then

		return nil,
			name
			.. " debe ser un número entero."

	end

	return value

end

-- =========================================================
-- HTTP
-- =========================================================

local function requestJson(
	method,
	url,
	body
)

	local requestSuccess,
		response =
		pcall(
			function()

				local options = {

					Url =
					url,

					Method =
					method,

					Headers = {

						["Content-Type"] =
						"application/json",

						["x-plugin-key"] =
						PLUGIN_API_KEY

					}

				}

				if body ~= nil then

					options.Body =
					HttpService:JSONEncode(
						body
					)

				end

				return HttpService:RequestAsync(
					options
				)

			end
		)

	if not requestSuccess then

		return nil,
			{

				kind =
				"connection",

				message =
				tostring(
					response
				)

			}

	end

	local decodedData =
		nil

	if type(response.Body)
		== "string"
		and response.Body
		~= "" then

		local decodeSuccess,
			decoded =
			pcall(
				function()

					return HttpService:JSONDecode(
						response.Body
					)

				end
			)

		if decodeSuccess
			and type(decoded)
			== "table" then

			decodedData =
				decoded

		end

	end

	if not response.Success then

		return nil,
			{

				kind =
				"http",

				statusCode =
				response.StatusCode,

				body =
				decodedData,

				rawBody =
				response.Body

			}

	end

	return decodedData or {},
		nil,
		response.StatusCode

end

-- =========================================================
-- ERRORES HTTP
-- =========================================================

local function showApiError(
	errorInfo
)

	if errorInfo == nil then

		statusLabel.Text =
			"Error desconocido."

		return

	end

	if errorInfo.kind
		== "connection" then

		statusLabel.Text =
			"No se pudo conectar con 7x API."

		warn(
			"[7x Outfit Importer]",
			errorInfo.message
		)

		return

	end

	local statusCode =
		errorInfo.statusCode

	if statusCode == 400 then

		statusLabel.Text =
			"Datos inválidos. Revisa los filtros."

	elseif statusCode == 401 then

		statusLabel.Text =
			"PLUGIN_API_KEY incorrecta."

	elseif statusCode == 404 then

		statusLabel.Text =
			"La búsqueda no existe o ya expiró."

	elseif statusCode == 429 then

		statusLabel.Text =
			"Demasiadas solicitudes. Intenta después."

	elseif statusCode == 503 then

		statusLabel.Text =
			"El buscador está ocupado o Roblox no está disponible."

	else

		statusLabel.Text =
			"Error de API: "
			.. tostring(
				statusCode
			)

	end

	warn(
		"[7x Outfit Importer API]",
		statusCode,
		errorInfo.rawBody
	)

end

-- =========================================================
-- NORMALIZAR JOB
-- =========================================================

local function normalizeJob(
	data
)

	if type(data)
		~= "table" then

		return {}

	end

	if type(data.job)
		== "table" then

		return data.job

	end

	return data

end

-- =========================================================
-- OBTENER RESULTADO FINAL
-- =========================================================

local function getFinalResult(
	job
)

	if type(job.result)
		== "table" then

		return job.result

	end

	return job

end

-- =========================================================
-- MOTIVOS DE PARADA
-- =========================================================

local function getStopReasonText(
	reason
)

	local reasons = {

		catalogRateLimit =
			"Límite del catálogo de Roblox",

		avatarRateLimit =
			"Límite de avatares de Roblox",

		timeBudget =
			"Límite de tiempo",

		candidateCap =
			"Límite de candidatos",

		fullCycle =
			"Se completó una vuelta de la comunidad",

		queue_timeout =
			"Tiempo máximo esperando turno",

		queue_full =
			"Cola llena",

		catalogError =
			"Error de catálogo",

		avatarError =
			"Error de avatar"

	}

	if reason == nil then

		return "Sin motivo especificado"

	end

	return reasons[reason]
		or tostring(
			reason
		)

end

-- =========================================================
-- RENDER DE PROGRESO
-- =========================================================

local function renderProgress(
	job,
	requestedAmount
)

	job =
		normalizeJob(
			job
		)

	local status =
		tostring(
			job.status
			or "running"
		)

	local progress = {}

	if type(job.progress)
		== "table" then

		progress =
			job.progress

	end

	local result = {}

	if type(job.result)
		== "table" then

		result =
			job.result

	end

	local found =
		tonumber(
			progress.found
		)

	if found == nil then

		found =
			tonumber(
				job.found
			)

	end

	if found == nil then

		found =
			tonumber(
				result.found
			)

	end

	if found == nil
		and type(result.outfits)
		== "table" then

		found =
			#result.outfits

	end

	found =
		found or 0

	found =
		math.max(
			0,
			found
		)

	local target =
		tonumber(
			progress.target
		)

	if target == nil then

		target =
			tonumber(
				job.requested
			)

	end

	if target == nil then

		target =
			tonumber(
				result.requested
			)

	end

	if target == nil then

		target =
			requestedAmount

	end

	target =
		target or 0

	target =
		math.max(
			0,
			target
		)

	local ratio =
		0

	if target > 0 then

		ratio =
			math.clamp(
				found / target,
				0,
				1
			)

	end

	progressFill.Size =
		UDim2.fromScale(
			ratio,
			1
		)

	progressText.Text =
		tostring(
			found
		)
		.. " / "
		.. tostring(
			target
		)
		.. " encontrados"

	-- =====================================================
	-- EN COLA
	-- =====================================================

	if status
		== "queued" then

		statusLabel.Text =
			"Esperando turno..."

		local queuePosition =
			tonumber(
				job.queuePosition
			)

		if queuePosition == nil then

			queuePosition =
				tonumber(
					progress.queuePosition
				)

		end

		if queuePosition ~= nil then

			progressMeta.Text =
				"Posición en cola: "
				.. tostring(
					queuePosition
				)

		else

			progressMeta.Text =
				"Esperando disponibilidad de esta comunidad..."

		end

		return

	end

	-- =====================================================
	-- EJECUTANDO
	-- =====================================================

	if status
		== "running" then

		statusLabel.Text =
			"Analizando comunidad..."

		local examined =
			tonumber(
				progress.candidatesExamined
			)

		if examined == nil then

			examined =
				tonumber(
					job.candidatesExamined
				)

		end

		examined =
			examined or 0

		local elapsedMs =
			tonumber(
				progress.elapsedMs
			)

		local etaMs =
			tonumber(
				progress.estimatedRemainingMs
			)

		local elapsedText =
			formatMilliseconds(
				elapsedMs
			)

		local etaText =
			formatMilliseconds(
				etaMs
			)

		local parts = {

			tostring(
				examined
			)
				.. " candidatos revisados"

		}

		if elapsedText ~= nil then

			table.insert(
				parts,
				"Tiempo: "
					.. elapsedText
			)

		end

		if etaText ~= nil then

			table.insert(
				parts,
				"ETA aprox.: "
					.. etaText
			)

		else

			table.insert(
				parts,
				"Calculando tiempo..."
			)

		end

		progressMeta.Text =
			table.concat(
				parts,
				"  •  "
			)

	end

end

-- =========================================================
-- DIAGNÓSTICO FINAL
-- =========================================================

local function printFinalResult(
	finalData,
	groupId,
	amount,
	minPrice,
	maxPrice
)

	local outfits =
		finalData.outfits
		or {}

	local stats =
		finalData.stats
		or {}

	print(
		"===== DIAGNÓSTICO ====="
	)

	print(
		"Revisados:",
		stats.candidatesExamined
			or 0
	)

	print(
		"Aceptados:",
		stats.accepted
			or #outfits
	)

	print(
		"Error avatar:",
		stats.rejectedAvatarError
			or 0
	)

	if stats.rejectedAvatarNotFound
		~= nil then

		print(
			"Avatar 404:",
			stats.rejectedAvatarNotFound
				or 0
		)

	end

	if stats.rejectedAvatarRateLimit
		~= nil then

		print(
			"Avatar rate limit:",
			stats.rejectedAvatarRateLimit
				or 0
		)

	end

	if stats.rejectedAvatarServerError
		~= nil then

		print(
			"Avatar 5xx:",
			stats.rejectedAvatarServerError
				or 0
		)

	end

	if stats.rejectedAvatarTimeout
		~= nil then

		print(
			"Avatar timeout:",
			stats.rejectedAvatarTimeout
				or 0
		)

	end

	if stats.rejectedAvatarCooldown
		~= nil then

		print(
			"Avatar cooldown:",
			stats.rejectedAvatarCooldown
				or 0
		)

	end

	if stats.rejectedAvatarNetworkError
		~= nil then

		print(
			"Avatar red:",
			stats.rejectedAvatarNetworkError
				or 0
		)

	end

	if stats.rejectedAvatarInvalidResponse
		~= nil then

		print(
			"Avatar respuesta inválida:",
			stats.rejectedAvatarInvalidResponse
				or 0
		)

	end

	print(
		"Avatar vacío:",
		stats.rejectedEmptyAvatar
			or 0
	)

	print(
		"Error catálogo:",
		stats.rejectedCatalogError
			or 0
	)

	print(
		"Precio desconocido:",
		stats.rejectedUnknownPrice
			or 0
	)

	print(
		"Precio incompleto:",
		stats.rejectedIncompletePrice
			or 0
	)

	print(
		"Debajo mínimo:",
		stats.rejectedMinPrice
			or 0
	)

	print(
		"Encima máximo:",
		stats.rejectedMaxPrice
			or 0
	)

	print(
		"Parada:",
		stats.stoppedBy
			or "none"
	)

	print(
		"Rate limit catálogo:",
		stats.stoppedByCatalogRateLimit
			or false
	)

	if stats.memberPagesFetched
		~= nil then

		print(
			"Páginas de miembros:",
			stats.memberPagesFetched
				or 0
		)

	end

	if stats.avatarRequests
		~= nil then

		print(
			"Requests avatar:",
			stats.avatarRequests
				or 0
		)

	end

	if stats.catalogBatches
		~= nil then

		print(
			"Batches catálogo:",
			stats.catalogBatches
				or 0
		)

	end

	if stats.bundleLookups
		~= nil then

		print(
			"Bundle lookups:",
			stats.bundleLookups
				or 0
		)

	end

	if stats.cacheHits
		~= nil then

		print(
			"Cache hits:",
			stats.cacheHits
				or 0
		)

	end

	if stats.cacheMisses
		~= nil then

		print(
			"Cache misses:",
			stats.cacheMisses
				or 0
		)

	end

	print(
		"======================="
	)

	print("")

	print(
		"========================================"
	)

	print(
		"7x OUTFIT IMPORTER"
	)

	print(
		"========================================"
	)

	print(
		"Comunidad:",
		groupId
	)

	print(
		"Solicitados:",
		amount
	)

	print(
		"Encontrados:",
		#outfits
	)

	print(
		"Precio:",
		minPrice,
		"-",
		maxPrice,
		"Robux"
	)

	print(
		"----------------------------------------"
	)

	for index,
		outfit
		in ipairs(
			outfits
		) do

		print(
			"#"
				.. tostring(
					index
				),

			"@"
				.. tostring(
					outfit.username
				),

			"| UserId:",

			tostring(
				outfit.userId
			),

			"| Precio:",

			tostring(
				outfit.totalPrice
			)
				.. " R$"
		)

	end

	print(
		"========================================"
	)

	print("")

end

-- =========================================================
-- ESTADO DE BÚSQUEDA
-- =========================================================

local searching =
	false

local function setSearching(
	value
)

	searching =
		value

	if value then

		searchButton.Text =
			"BUSCANDO..."

		searchButton.Active =
			false

		searchButton.AutoButtonColor =
			false

	else

		searchButton.Text =
			"BUSCAR"

		searchButton.Active =
			true

		searchButton.AutoButtonColor =
			true

	end

end

-- =========================================================
-- BÚSQUEDA
-- =========================================================

-- =========================================================
-- IMPORTACIÓN A WORKSPACE.OUTFITS
-- =========================================================
--
-- ESTE CÓDIGO ES NUEVO. El plugin nunca tuvo importador: sus trece funciones
-- eran interfaz, HTTP, progreso y `printFinalResult`, que solo escribe un
-- diagnóstico en Output. Por eso una búsqueda terminaba enseñando números y no
-- insertaba nada — ni por el camino nuevo ni por el antiguo.
--
-- LO ESCRIBE UNA SOLA FUNCIÓN, `importOutfits`, y por ella pasan los dos
-- caminos: el resultado directo del índice y el trabajo asíncrono de siempre.
-- Los dos terminan en el mismo sitio del flujo, así que no hay nada duplicado.
--
-- LO QUE ESTE CÓDIGO NO HACE, y es tan importante como lo que hace: no crea
-- ProximityPrompt, ni scripts dentro del modelo, ni atributos, ni sistema de
-- likes, ni ancla las partes. De eso se encarga el sistema del juego cuando
-- detecta que entra un Model en Workspace.Outfits. Aquí solo se arma el rig y
-- se deja donde toca.

local Players = game:GetService("Players")

local NOMBRE_CARPETA = "Outfits"
local PREFIJO = "7x"

-- Separación entre modelos, en studs. Se colocan en fila desde el origen de la
-- carpeta para que no se solapen entre ellos.
local SEPARACION = 8
local ALTURA = 5

-- Alfabeto sin caracteres que se confundan al leerlos (ni O ni 0, ni I ni l).
local ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

local usados = {}

-- Nombre único: el prefijo mas cuatro caracteres. Se comprueba contra la
-- carpeta y contra lo insertado en esta misma tanda, porque dos outfits de la
-- misma búsqueda podrían sacar el mismo sorteo.
local function nombreUnico(carpeta)
	for _ = 1, 200 do
		local sufijo = ""
		for _ = 1, 4 do
			local i = math.random(1, #ALFABETO)
			sufijo = sufijo .. ALFABETO:sub(i, i)
		end
		local nombre = PREFIJO .. sufijo
		if not usados[nombre] and not carpeta:FindFirstChild(nombre) then
			usados[nombre] = true
			return nombre
		end
	end
	-- Salida de emergencia: con 32^4 combinaciones esto no pasa, pero un bucle
	-- que pueda no terminar nunca no se deja escrito.
	local nombre = PREFIJO .. tostring(os.clock()):gsub("%.", "")
	usados[nombre] = true
	return nombre
end

local function carpetaDeOutfits()
	local carpeta = workspace:FindFirstChild(NOMBRE_CARPETA)
	if carpeta == nil then
		carpeta = Instance.new("Folder")
		carpeta.Name = NOMBRE_CARPETA
		carpeta.Parent = workspace
	end
	return carpeta
end

-- Arma UN outfit y lo devuelve TERMINADO, todavía sin padre.
--
-- El rig sale de `CreateHumanoidModelFromDescription`, que es la vía que da
-- Roblox para esto: devuelve un Model R15 completo —Humanoid,
-- HumanoidRootPart, UpperTorso, LowerTorso, Head y el resto— con la
-- descripción ya aplicada, ropa y accesorios incluidos. Armarlo pieza a pieza
-- sería reimplementar peor lo que la API ya hace bien.
--
-- La descripción se pide por `userId`. La respuesta de la API trae el precio y
-- el usuario, pero NO la lista de assets, así que esta es la única forma de
-- reconstruir el avatar sin tocar la API.
local function construirOutfit(outfit, carpeta)
	local userId = tonumber(outfit.userId)
	if userId == nil then
		error("outfit sin userId")
	end

	local descripcion = Players:GetHumanoidDescriptionFromUserId(userId)

	local modelo = Players:CreateHumanoidModelFromDescription(
		descripcion,
		Enum.HumanoidRigType.R15
	)

	local humanoid = modelo:FindFirstChildOfClass("Humanoid")
	if humanoid == nil then
		modelo:Destroy()
		error("el rig vino sin Humanoid")
	end

	-- El modelo tiene que tener torso: es lo que el sistema del juego busca.
	local torso = modelo:FindFirstChild("UpperTorso")
		or modelo:FindFirstChild("Torso")
		or modelo:FindFirstChild("HumanoidRootPart")
	if torso == nil then
		modelo:Destroy()
		error("el rig vino sin torso ni HumanoidRootPart")
	end

	-- EL HumanoidDescription, HIJO DIRECTO DEL HUMANOID. `CreateHumanoidModel-
	-- FromDescription` aplica la descripción pero no la deja colgada, y el
	-- sistema del juego la necesita ahí para poder leerla.
	local aplicada = descripcion:Clone()
	aplicada.Name = "HumanoidDescription"
	aplicada.Parent = humanoid

	modelo.Name = nombreUnico(carpeta)
	if modelo.PrimaryPart == nil then
		modelo.PrimaryPart = modelo:FindFirstChild("HumanoidRootPart") or torso
	end

	-- ── SIN UNA SOLA LINEA DE CODIGO DENTRO DEL MODELO ──────────────────
	--
	-- `CreateHumanoidModelFromDescription` mete un LocalScript llamado
	-- Animate en el rig: es lo que anima a un personaje vivo. Un outfit
	-- expuesto en una estanteria no es un personaje vivo, y ese script se
	-- pondria a correr dentro de Workspace.Outfits por su cuenta.
	--
	-- Se barre el modelo entero. `LuaSourceContainer` es la clase madre de
	-- Script, LocalScript y ModuleScript, asi que una sola comprobacion cubre
	-- los tres — incluido cualquiera que Roblox añada al rig el dia de mañana.
	--
	-- Aqui, con el rig YA armado y ANTES de que el modelo tenga padre: asi no
	-- llega a existir ni un instante de ese script dentro de Workspace.
	for _, descendiente in ipairs(modelo:GetDescendants()) do
		if descendiente:IsA("LuaSourceContainer") then
			descendiente:Destroy()
		end
	end

	-- NO se anclan las partes. Lo hace el sistema del juego al detectar el
	-- modelo, y anclarlas aquí romperia su montaje.
	return modelo
end

-- LA ÚNICA PUERTA DE ENTRADA. Por aquí pasan los dos caminos.
--
-- Un outfit que falle NO detiene a los demás: se cuenta y se sigue. Con
-- ochenta y un outfits, que dos den error es un martes cualquiera, y perder
-- los setenta y nueve buenos por eso sería absurdo.
local function importOutfits(outfits)
	outfits = outfits or {}

	local resumen = {
		recibidos = #outfits,
		insertados = 0,
		fallidos = 0,
		errores = {},
	}
	if resumen.recibidos == 0 then
		return resumen
	end

	local carpeta = carpetaDeOutfits()

	-- Desde donde se coloca la fila: detras de lo que ya haya en la carpeta,
	-- para que dos busquedas seguidas no apilen modelos en el mismo sitio. Se
	-- cuenta lo que hay en vez de guardar un atributo — la carpeta es de tu
	-- sistema y no se le añade nada que no le corresponda.
	local base = #carpeta:GetChildren()

	for indice, outfit in ipairs(outfits) do
		local ok, resultado = pcall(construirOutfit, outfit, carpeta)

		if ok and resultado then
			-- Colocado ANTES de tener padre: el modelo entra en Workspace ya
			-- puesto en su sitio y terminado, que es justo lo que el sistema
			-- del juego espera detectar.
			local columna = base + (indice - 1)
			resultado:PivotTo(
				CFrame.new(columna * SEPARACION, ALTURA, 0)
			)

			-- Y AHORA, con el rig armado, el Humanoid con su descripción, el
			-- nombre puesto y la posición fijada, se mete en la carpeta. Ni un
			-- paso antes.
			resultado.Parent = carpeta

			resumen.insertados = resumen.insertados + 1
		else
			resumen.fallidos = resumen.fallidos + 1
			local detalle = tostring(resultado)
			table.insert(resumen.errores, {
				userId = outfit and outfit.userId or "?",
				detalle = detalle,
			})
			warn(
				"[7x Outfit Importer] No se pudo importar el outfit de",
				outfit and outfit.userId or "?",
				"-",
				detalle
			)
		end

		-- Un respiro entre modelos: `GetHumanoidDescriptionFromUserId` va
		-- contra Roblox y ochenta seguidas sin pausa se ganan un limite.
		task.wait(0.1)
	end

	return resumen
end

local function searchOutfits()

	if searching then

		return

	end

	-- =====================================================
	-- CANTIDAD
	-- =====================================================

	local amount,
		amountError =
		readInteger(
			amountBox,
			"La cantidad"
		)

	if not amount then

		statusLabel.Text =
			amountError

		return

	end

	if amount < 1
		or amount > 500 then

		statusLabel.Text =
			"La cantidad debe estar entre 1 y 500."

		return

	end

	-- =====================================================
	-- COMUNIDAD
	-- =====================================================

	local groupId,
		groupError =
		readInteger(
			groupBox,
			"El ID de comunidad"
		)

	if not groupId then

		statusLabel.Text =
			groupError

		return

	end

	if groupId <= 0 then

		statusLabel.Text =
			"El ID de comunidad debe ser mayor que 0."

		return

	end

	-- =====================================================
	-- PRECIO MÍNIMO
	-- =====================================================

	local minPrice,
		minError =
		readInteger(
			minPriceBox,
			"El precio mínimo"
		)

	if not minPrice then

		statusLabel.Text =
			minError

		return

	end

	if minPrice < 0 then

		statusLabel.Text =
			"El precio mínimo no puede ser negativo."

		return

	end

	-- =====================================================
	-- PRECIO MÁXIMO
	-- =====================================================

	local maxPrice,
		maxError =
		readInteger(
			maxPriceBox,
			"El precio máximo"
		)

	if not maxPrice then

		statusLabel.Text =
			maxError

		return

	end

	if maxPrice < minPrice then

		statusLabel.Text =
			"El precio máximo no puede ser menor que el mínimo."

		return

	end

	-- =====================================================
	-- API KEY
	-- =====================================================

	if PLUGIN_API_KEY == ""
		or PLUGIN_API_KEY
		== "PEGA_AQUI_TU_PLUGIN_API_KEY" then

		statusLabel.Text =
			"Falta configurar PLUGIN_API_KEY."

		return

	end

	-- =====================================================
	-- PREPARAR UI
	-- =====================================================

	setSearching(
		true
	)

	statusLabel.Text =
		"Iniciando búsqueda..."

	progressText.Text =
		"0 / "
		.. tostring(
			amount
		)
		.. " encontrados"

	progressFill.Size =
		UDim2.fromScale(
			0,
			1
		)

	progressMeta.Text =
		"Preparando trabajo..."

	-- =====================================================
	-- POST ASÍNCRONO
	-- =====================================================

	local createData,
		createError =
		requestJson(
			"POST",

			API_URL,

			{

				amount =
				amount,

				groupId =
				groupId,

				minPrice =
				minPrice,

				maxPrice =
				maxPrice,

				requireCompletePrice =
				false,

				async =
				true

			}
		)

	if createError then

		setSearching(
			false
		)

		showApiError(
			createError
		)

		return

	end

	local currentJob =
		normalizeJob(
			createData
		)

	-- =====================================================
	-- RESPUESTA TERMINAL (backend con indice)
	-- =====================================================
	--
	-- El backend sirve desde Postgres y devuelve el resultado hecho: no hay
	-- trabajo que sondear y por eso no manda searchId. Se comprueba AQUI,
	-- antes de exigirlo, porque exigirlo primero descartaba una respuesta
	-- buena con "La API no devolvio un searchId valido".

	local terminalStatus =
		tostring(
			currentJob.status
			or ""
		)

	local terminalDirecto =
		(terminalStatus
			== "completed"
			or terminalStatus
			== "partial")
		and type(currentJob.outfits)
		== "table"

	if terminalDirecto then

		print(
			"[7x Outfit Importer] Resultado directo del indice:",
			terminalStatus,
			tostring(
				currentJob.found
				or #currentJob.outfits
			)
			.. "/"
			.. tostring(
				amount
			)
		)

		-- Se pinta YA lo que esta pasando, sin esperar a nada.
		if currentJob.indexWarming
			== true then

			local cobertura =
				currentJob.coverage

			if type(cobertura)
				~= "table" then

				cobertura = {}

			end

			statusLabel.Text =
				"Indexando comunidad: "
				.. tostring(
					cobertura.indexed
					or 0
				)
				.. " de "
				.. tostring(
					cobertura.members
					or 0
				)
				.. " miembros conocidos · "
				.. tostring(
					currentJob.found
					or #currentJob.outfits
				)
				.. " outfits disponibles ahora"

		end

		renderProgress(
			currentJob,
			amount
		)

	end

	local searchId =
		currentJob.searchId

	if searchId == nil then

		searchId =
			createData.searchId

	end

	if not terminalDirecto
		and (type(searchId)
		~= "string"
		or searchId == "") then

		setSearching(
			false
		)

		statusLabel.Text =
			"La API no devolvió un searchId válido."

		warn(
			"[7x Outfit Importer]",
			"Respuesta POST sin searchId"
		)

		return

	end

	if not terminalDirecto then

		print(
			"[7x Outfit Importer] Job creado:",
			searchId
		)

		renderProgress(
			currentJob,
			amount
		)

	end

	-- =====================================================
	-- POLLING
	-- =====================================================

	local finalJob =
		nil

	if terminalDirecto then

		finalJob =
			currentJob

	end

	while searching
		and finalJob == nil do

		local currentStatus =
			tostring(
				currentJob.status
				or ""
			)

		if currentStatus
			== "completed"
			or currentStatus
			== "partial"
			or currentStatus
			== "failed"
			or currentStatus
			== "expired" then

			finalJob =
				currentJob

			break

		end

		task.wait(
			POLL_INTERVAL
		)

		local jobData,
			jobError =
			requestJson(
				"GET",

				API_URL
				.. "/"
				.. HttpService:UrlEncode(
					searchId
				),

				nil
			)

		if jobError then

			setSearching(
				false
			)

			showApiError(
				jobError
			)

			return

		end

		currentJob =
			normalizeJob(
				jobData
			)

		renderProgress(
			currentJob,
			amount
		)

	end

	-- =====================================================
	-- FIN DE POLLING
	-- =====================================================

	setSearching(
		false
	)

	if finalJob == nil then

		statusLabel.Text =
			"La búsqueda terminó inesperadamente."

		progressMeta.Text =
			"No se recibió un resultado final."

		return

	end

	local finalStatus =
		tostring(
			finalJob.status
			or ""
		)

	local finalData =
		getFinalResult(
			finalJob
		)

	-- =====================================================
	-- FAILED
	-- =====================================================

	if finalStatus
		== "failed" then

		local errorCode =
			finalJob.errorCode

		if errorCode == nil
			and type(finalData)
			== "table" then

			errorCode =
				finalData.errorCode

		end

		statusLabel.Text =
			"Búsqueda fallida."

		progressMeta.Text =
			"Motivo: "
			.. getStopReasonText(
				errorCode
			)

		return

	end

	-- =====================================================
	-- EXPIRED
	-- =====================================================

	if finalStatus
		== "expired" then

		statusLabel.Text =
			"La búsqueda expiró."

		progressMeta.Text =
			"Puedes iniciar una nueva búsqueda."

		return

	end

	-- =====================================================
	-- RESULTADO
	-- =====================================================

	local outfits =
		finalData.outfits
		or {}

	local stats =
		finalData.stats
		or {}

	local found =
		tonumber(
			finalJob.found
		)

	if found == nil then

		found =
			tonumber(
				finalData.found
			)

	end

	if found == nil then

		found =
			#outfits

	end

	found =
		math.max(
			0,
			found
		)

	-- =====================================================
	-- ACTUALIZAR BARRA FINAL
	-- =====================================================

	local finalRatio =
		0

	if amount > 0 then

		finalRatio =
			math.clamp(
				found / amount,
				0,
				1
			)

	end

	progressFill.Size =
		UDim2.fromScale(
			finalRatio,
			1
		)

	progressText.Text =
		tostring(
			found
		)
		.. " / "
		.. tostring(
			amount
		)
		.. " encontrados"

	-- =====================================================
	-- TIEMPO FINAL
	-- =====================================================

	local elapsedMs =
		nil

	if type(finalJob.progress)
		== "table" then

		elapsedMs =
			tonumber(
				finalJob.progress.elapsedMs
			)

	end

	if elapsedMs == nil then

		elapsedMs =
			tonumber(
				finalData.elapsedMs
			)

	end

	if elapsedMs == nil then

		elapsedMs =
			tonumber(
				stats.elapsedMs
			)

	end

	local elapsedText =
		formatMilliseconds(
			elapsedMs
		)

	-- =====================================================
	-- COMPLETADO
	-- =====================================================

	if finalStatus
		== "completed" then

		statusLabel.Text =
			"¡Búsqueda completada!"

		if elapsedText ~= nil then

			progressMeta.Text =
				"Completado en "
				.. elapsedText

		else

			progressMeta.Text =
				"Búsqueda completada."

		end

		-- =====================================================
		-- PARCIAL
		-- =====================================================

	elseif finalStatus
		== "partial" then

		local stopReason =
			finalJob.stoppedBy

		if stopReason == nil then

			stopReason =
				finalData.stoppedBy

		end

		if stopReason == nil then

			stopReason =
				stats.stoppedBy

		end

		if finalJob.indexWarming
			== true then

			local cobertura =
				finalJob.coverage

			if type(cobertura)
				~= "table" then

				cobertura = {}

			end

			statusLabel.Text =
				"Indexando comunidad: "
				.. tostring(
					cobertura.indexed
					or 0
				)
				.. " de "
				.. tostring(
					cobertura.members
					or 0
				)
				.. " miembros conocidos · "
				.. tostring(
					found
				)
				.. " outfits disponibles ahora"

			progressMeta.Text =
				"Vuelve a buscar en un rato: la comunidad sigue indexandose."

		else

			statusLabel.Text =
				"Búsqueda finalizada parcialmente."

			progressMeta.Text =
				"Motivo: "
				.. getStopReasonText(
					stopReason
				)

		end

		if elapsedText ~= nil then

			progressMeta.Text =
				progressMeta.Text
				.. "  •  "
				.. elapsedText

		end

	else

		statusLabel.Text =
			"Búsqueda terminada."

	end

	-- =====================================================
	-- OUTPUT
	-- =====================================================

	printFinalResult(
		finalData,
		groupId,
		amount,
		minPrice,
		maxPrice
	)

	-- =====================================================
	-- IMPORTACION
	-- =====================================================
	--
	-- El punto donde convergen los DOS caminos: el resultado directo del
	-- indice (terminal, sin searchId) y el trabajo asincrono de siempre.
	-- Los dos llegan aqui con `finalData.outfits` en la mano, asi que una
	-- sola llamada cubre a ambos.
	--
	-- 'partial' importa IGUAL que 'completed': ochenta y uno de cien
	-- encontrados son ochenta y un outfits que insertar, no una razon para
	-- esperar a los cien.

	progressMeta.Text =
		"Insertando "
		.. tostring(
			#outfits
		)
		.. " outfits..."

	local resumen =
		importOutfits(
			outfits
		)

	print(
		"[7x Outfit Importer]",
		resumen.recibidos,
		"outfits encontrados ·",
		resumen.insertados,
		"insertados ·",
		resumen.fallidos,
		"fallaron"
	)

	statusLabel.Text =
		tostring(
			resumen.recibidos
		)
		.. " outfits encontrados"

	if resumen.fallidos > 0 then

		progressMeta.Text =
			tostring(
				resumen.insertados
			)
			.. " insertados · "
			.. tostring(
				resumen.fallidos
			)
			.. " fallaron"

	else

		progressMeta.Text =
			tostring(
				resumen.insertados
			)
			.. " insertados en Workspace.Outfits"

	end

end

-- =========================================================
-- CONEXIÓN DEL BOTÓN
-- =========================================================

searchButton.MouseButton1Click:Connect(
	searchOutfits
)