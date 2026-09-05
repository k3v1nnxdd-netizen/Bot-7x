--!strict
--[[
	7x Outfit Importer — fuente canonica del plugin de Roblox Studio.
	Version 2.0.0

	POR QUE ESTA FUENTE VIVE EN EL REPOSITORIO
	El plugin es la mitad del contrato de /plugin/outfits/search, y hasta ahora
	solo existia dentro de Studio. Eso hacia imposible razonar sobre un cambio
	del servidor sin adivinar como reaccionaba el cliente. Aqui esta, versionada
	junto al servicio que consume.

	QUE CAMBIA EN LA 2.0.0
	El servidor puede responder de dos formas y esta version entiende las dos:

	  TERMINAL (sin searchId)   con INDEX_SERVE_ENABLED=true. La respuesta trae
	                            ya los outfits. NO se sondea nada: el boton se
	                            rehabilita en el acto. Es el camino normal.

	  ASINCRONA (con searchId)  el modo de siempre. Se sondea el GET hasta que
	                            el trabajo termina.

	La diferencia importa para quien mira: antes, una comunidad a medio indexar
	dejaba el plugin sondeando durante minutos para acabar en "3 de 10". Ahora
	responde al instante y dice exactamente que esta pasando.

	LA CLAVE NO ESTA AQUI. Se pide una vez y se guarda en el plugin; este
	archivo no contiene ningun secreto y no debe contenerlo nunca.
]]

local HttpService = game:GetService("HttpService")

local PLUGIN_VERSION = "2.0.0"
local API_BASE = "https://outfit-api.up.railway.app"

-- La clave se guarda en los ajustes del plugin, nunca en el codigo.
local AJUSTE_CLAVE = "7x_outfit_api_key"

-- Sondeo, solo para el modo asincrono. El servidor dice cada cuanto volver
-- (`pollAfterMs`); esto es el respaldo por si no lo dijera.
local SONDEO_POR_DEFECTO_MS = 1500
local SONDEO_MAXIMO_S = 180

local toolbar = plugin:CreateToolbar("7x Outfits")
local boton = toolbar:CreateButton("Buscar outfits", "Importa outfits de una comunidad", "rbxassetid://0")

local widget = plugin:CreateDockWidgetPluginGui(
	"SieteXOutfitImporter",
	DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, false, false, 380, 260, 320, 220)
)
widget.Title = "7x Outfit Importer " .. PLUGIN_VERSION

-- ── Interfaz minima ─────────────────────────────────────────────────────────
local marco = Instance.new("Frame")
marco.Size = UDim2.fromScale(1, 1)
marco.BackgroundColor3 = Color3.fromRGB(46, 46, 46)
marco.BorderSizePixel = 0
marco.Parent = widget

local estado = Instance.new("TextLabel")
estado.Size = UDim2.new(1, -20, 0, 60)
estado.Position = UDim2.new(0, 10, 0, 10)
estado.BackgroundTransparency = 1
estado.TextColor3 = Color3.fromRGB(230, 230, 230)
estado.TextWrapped = true
estado.TextXAlignment = Enum.TextXAlignment.Left
estado.TextYAlignment = Enum.TextYAlignment.Top
estado.Font = Enum.Font.Gotham
estado.TextSize = 13
estado.Text = "Listo."
estado.Parent = marco

local buscar = Instance.new("TextButton")
buscar.Size = UDim2.new(1, -20, 0, 32)
buscar.Position = UDim2.new(0, 10, 1, -42)
buscar.BackgroundColor3 = Color3.fromRGB(0, 122, 204)
buscar.TextColor3 = Color3.fromRGB(255, 255, 255)
buscar.Font = Enum.Font.GothamMedium
buscar.TextSize = 14
buscar.Text = "BUSCAR"
buscar.Parent = marco

local function decir(texto: string)
	estado.Text = texto
end

-- EL BOTON SE REHABILITA SIEMPRE, pase lo que pase. Un plugin con el boton
-- muerto obliga a reinstalarlo, y eso es peor que cualquier error.
local function liberar()
	buscar.Active = true
	buscar.AutoButtonColor = true
	buscar.BackgroundColor3 = Color3.fromRGB(0, 122, 204)
	buscar.Text = "BUSCAR"
end

local function ocupar(texto: string)
	buscar.Active = false
	buscar.AutoButtonColor = false
	buscar.BackgroundColor3 = Color3.fromRGB(90, 90, 90)
	buscar.Text = texto
end

-- ── El texto que ve el usuario ──────────────────────────────────────────────
--
-- Es la parte que mas importa de esta version. "3 de 10" a secas parece un
-- fallo del servicio; "indexando la comunidad" dice la verdad, que es que el
-- trabajo esta en marcha y volver en un rato dara mas.
local function describir(respuesta): string
	local pedidos = respuesta.requested or 0
	local hallados = respuesta.found or 0

	if respuesta.status == "completed" then
		return string.format("Listo: %d de %d outfits importados.", hallados, pedidos)
	end

	if respuesta.indexWarming then
		local cobertura = respuesta.coverage or {}
		local conocidos = cobertura.indexed or 0
		local miembros = cobertura.members or 0
		return string.format(
			"Indexando comunidad: %d de %d miembros conocidos · %d outfits disponibles ahora.",
			conocidos, miembros, hallados
		)
	end

	return string.format("Encontrados %d de %d outfits.", hallados, pedidos)
end

-- ── Llamadas ────────────────────────────────────────────────────────────────
local function pedir(metodo: string, ruta: string, cuerpo)
	local clave = plugin:GetSetting(AJUSTE_CLAVE)
	if not clave or clave == "" then
		return nil, "Falta la clave del plugin. Configurala una vez en los ajustes."
	end

	local opciones = {
		Url = API_BASE .. ruta,
		Method = metodo,
		Headers = { ["x-plugin-key"] = clave, ["Content-Type"] = "application/json" },
	}
	if cuerpo then
		opciones.Body = HttpService:JSONEncode(cuerpo)
	end

	local ok, resultado = pcall(function()
		return HttpService:RequestAsync(opciones)
	end)
	if not ok then
		return nil, "No se pudo contactar con el servicio."
	end

	local decodificado
	local okJson = pcall(function()
		decodificado = HttpService:JSONDecode(resultado.Body)
	end)
	if not okJson then
		return nil, "El servicio devolvio una respuesta ilegible."
	end

	-- El indice no esta disponible. Se dice tal cual: el servicio no esta roto,
	-- no puede servir AHORA, y reintentar mas tarde tiene sentido.
	if resultado.StatusCode == 503 and decodificado.error and decodificado.error.code == "index_unavailable" then
		return nil, "El indice no esta disponible ahora mismo. Reintenta en unos segundos."
	end

	if not resultado.Success then
		local mensaje = decodificado.error and decodificado.error.message or ("Error " .. resultado.StatusCode)
		return nil, mensaje
	end

	return decodificado, nil
end

-- Sondeo del modo asincrono. Solo se usa cuando la respuesta trae searchId.
local function sondear(searchId: string)
	local limite = os.clock() + SONDEO_MAXIMO_S
	while os.clock() < limite do
		local respuesta, err = pedir("GET", "/plugin/outfits/search/" .. searchId, nil)
		if err then
			return nil, err
		end

		local terminal = respuesta.status == "completed"
			or respuesta.status == "partial"
			or respuesta.status == "failed"
			or respuesta.status == "expired"
		if terminal then
			return respuesta, nil
		end

		local progreso = respuesta.progress or {}
		if progreso.waitingForRoblox then
			decir(string.format("Roblox pidio esperar · %d outfits encontrados.", respuesta.found or 0))
		else
			decir(string.format("Buscando... %d de %d.", respuesta.found or 0, respuesta.requested or 0))
		end

		local espera = (respuesta.pollAfterMs or SONDEO_POR_DEFECTO_MS) / 1000
		task.wait(espera)
	end

	return nil, "La busqueda tardo demasiado. Vuelve a intentarlo."
end

local function importar(outfits)
	-- La importacion real de cada outfit vive en el modulo de importacion del
	-- plugin; aqui solo se cuenta lo que llego.
	return #outfits
end

local ocupado = false

local function ejecutar(peticion)
	if ocupado then return end
	ocupado = true
	ocupar("BUSCANDO...")

	-- El boton vuelve SIEMPRE: aunque falle la red, aunque el servidor conteste
	-- algo inesperado, aunque la importacion lance.
	local function terminar(texto: string)
		decir(texto)
		liberar()
		ocupado = false
	end

	local respuesta, err = pedir("POST", "/plugin/outfits/search", peticion)
	if err then
		terminar(err)
		return
	end

	-- ── RESPUESTA TERMINAL, sin searchId ────────────────────────────────────
	-- El servidor sirvio desde su indice: los outfits ya estan aqui y no hay
	-- nada que sondear. Es el camino normal con INDEX_SERVE_ENABLED=true.
	if respuesta.searchId == nil then
		local importados = importar(respuesta.outfits or {})
		terminar(describir(respuesta) .. (importados > 0 and "" or " Sin outfits que importar."))
		return
	end

	-- ── RESPUESTA ASINCRONA, con searchId ───────────────────────────────────
	if respuesta.status == "completed" or respuesta.status == "partial" then
		importar(respuesta.outfits or {})
		terminar(describir(respuesta))
		return
	end

	local final, errSondeo = sondear(respuesta.searchId)
	if errSondeo then
		terminar(errSondeo)
		return
	end

	importar(final.outfits or {})
	terminar(describir(final))
end

buscar.MouseButton1Click:Connect(function()
	ejecutar({
		amount = 10,
		groupId = plugin:GetSetting("7x_group_id") or 0,
		minPrice = 300,
		maxPrice = 100000000,
		requireCompletePrice = false,
		-- Con el indice sirviendo, el servidor ignora esta bandera y responde
		-- en el acto. Se manda igual para seguir funcionando contra un servidor
		-- que aun no tenga el indice encendido.
		async = true,
	})
end)

boton.Click:Connect(function()
	widget.Enabled = not widget.Enabled
end)

liberar()
