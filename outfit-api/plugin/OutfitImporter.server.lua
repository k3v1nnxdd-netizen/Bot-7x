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
-- PALETA Y MEDIDAS
-- =========================================================
--
-- Todo el aspecto sale de aqui. Un color repetido a mano en quince sitios es
-- un color que dentro de un mes esta puesto en catorce.

local TweenService = game:GetService("TweenService")

local COLOR_PANEL = Color3.fromRGB(18, 18, 21)
local COLOR_HUECO = Color3.fromRGB(7, 7, 9)
local COLOR_TARJETA = Color3.fromRGB(26, 26, 30)
local COLOR_TEXTO = Color3.fromRGB(245, 245, 248)
local COLOR_TENUE = Color3.fromRGB(146, 146, 156)
local COLOR_APAGADO = Color3.fromRGB(96, 96, 106)
local COLOR_VERDE = Color3.fromRGB(58, 202, 108)
local COLOR_ROJO = Color3.fromRGB(226, 74, 74)
local COLOR_BORRAR = Color3.fromRGB(176, 32, 32)
local COLOR_AMBAR = Color3.fromRGB(224, 168, 62)
local COLOR_AZUL = Color3.fromRGB(78, 148, 236)

local ESPACIO = 10
local RADIO = 12
local ALTO_ETIQUETA = 20
local ALTO_CAMPO = 42
local ALTO_BOTON = 44
local ALTO_BARRA = 32
local ALTO_TAB = 34

-- Por debajo de este ancho, lo que iba en fila pasa a columna. El plugin tiene
-- que seguir siendo usable en un panel acoplado y estrecho, y una fila de dos
-- botones a 320 px son dos botones ilegibles.
local ANCHO_COMPACTO = 380

-- =========================================================
-- HELPERS DE FORMA
-- =========================================================

local function redondear(instancia, radio)

	local esquina = Instance.new("UICorner")
	esquina.CornerRadius = UDim.new(0, radio or RADIO)
	esquina.Parent = instancia
	return esquina

end

local function acolchar(instancia, vertical, horizontal)

	local relleno = Instance.new("UIPadding")
	relleno.PaddingTop = UDim.new(0, vertical)
	relleno.PaddingBottom = UDim.new(0, vertical)
	relleno.PaddingLeft = UDim.new(0, horizontal)
	relleno.PaddingRight = UDim.new(0, horizontal)
	relleno.Parent = instancia
	return relleno

end

local function enFila(padre, separacion, alineacion)

	local disposicion = Instance.new("UIListLayout")
	disposicion.FillDirection = Enum.FillDirection.Horizontal
	disposicion.Padding = UDim.new(0, separacion or ESPACIO)
	disposicion.SortOrder = Enum.SortOrder.LayoutOrder
	disposicion.HorizontalAlignment = alineacion or Enum.HorizontalAlignment.Center
	disposicion.VerticalAlignment = Enum.VerticalAlignment.Center
	disposicion.Parent = padre
	return disposicion

end

local function enColumna(padre, separacion, alineacion)

	local disposicion = Instance.new("UIListLayout")
	disposicion.FillDirection = Enum.FillDirection.Vertical
	disposicion.Padding = UDim.new(0, separacion or ESPACIO)
	disposicion.SortOrder = Enum.SortOrder.LayoutOrder
	disposicion.HorizontalAlignment = alineacion or Enum.HorizontalAlignment.Center
	disposicion.Parent = padre
	return disposicion

end

-- =========================================================
-- ANIMACION
-- =========================================================
--
-- Todo lo que se mueve pasa por aqui, y por una razon: TweenService interpola
-- en el motor, mientras que un bucle propio con `task.wait` interpola en Lua y
-- paga el coste en cada fotograma. Con tres tabs, una lista de tarjetas y
-- media docena de contadores, la diferencia entre las dos formas es la
-- diferencia entre un panel y un panel que ralentiza Studio.

local SUAVE = TweenInfo.new(0.18, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
local BARRA = TweenInfo.new(0.35, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
local APARECER = TweenInfo.new(0.22, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)

local function animar(instancia, info, propiedades)

	local tween = TweenService:Create(instancia, info, propiedades)
	tween:Play()
	return tween

end

-- Un boton que responde al raton. El hover agranda un pelo y el click encoge:
-- es la señal minima de que algo es pulsable, y no cuesta un fotograma.
--
-- El tamaño base se lee en el momento del evento, no se guarda: en modo
-- compacto los botones cambian de tamaño y una copia guardada al crearlos
-- devolveria el boton al ancho de antes en cuanto alguien pasara el raton.
local function botonVivo(boton, obtenerMedida)

	local function escalar(factor)
		if boton.Active == false then return end
		local base = obtenerMedida()
		animar(boton, SUAVE, {
			Size = UDim2.new(
				base.X.Scale * factor, base.X.Offset * factor,
				base.Y.Scale * factor, base.Y.Offset * factor
			),
		})
	end

	boton.MouseEnter:Connect(function() escalar(1.02) end)
	boton.MouseLeave:Connect(function() escalar(1) end)
	boton.MouseButton1Down:Connect(function() escalar(0.97) end)
	boton.MouseButton1Up:Connect(function() escalar(1.02) end)

end

-- Numeros que cuentan en vez de saltar.
--
-- El TOKEN es lo que hace que esto funcione con datos que llegan solos: cada
-- animacion nueva invalida la anterior sobre esa misma etiqueta. Sin el, dos
-- respuestas del sondeo separadas por medio segundo dejarian dos bucles
-- escribiendo en el mismo sitio y el numero parpadearia entre los dos valores.
local contadores = {}

local function animarNumero(etiqueta, destino, formatear)

	destino = tonumber(destino) or 0
	formatear = formatear or function(n) return tostring(n) end

	local estado = contadores[etiqueta]
	if estado == nil then
		estado = { valor = destino, token = 0 }
		contadores[etiqueta] = estado
		etiqueta.Text = formatear(destino)
		return
	end

	if estado.valor == destino then
		etiqueta.Text = formatear(destino)
		return
	end

	estado.token = estado.token + 1
	local token = estado.token
	local desde = estado.valor
	estado.valor = destino

	-- 0,5 s repartidos en unos treinta pasos. Funciona igual bajando que
	-- subiendo porque interpola entre dos numeros, sin suponer cual es mayor.
	task.spawn(function()
		local pasos = 30
		for i = 1, pasos do
			if estado.token ~= token then return end
			local t = i / pasos
			-- Desaceleracion: el numero llega y se posa, no frena en seco.
			local suavizado = 1 - (1 - t) * (1 - t)
			etiqueta.Text = formatear(math.floor(desde + (destino - desde) * suavizado + 0.5))
			task.wait(0.5 / pasos)
		end
		if estado.token == token then
			etiqueta.Text = formatear(destino)
		end
	end)

end

-- =========================================================
-- FONDO Y PESTAÑAS
-- =========================================================

local root = Instance.new("Frame")

root.Name = "Root"
root.Size = UDim2.fromScale(1, 1)
root.BackgroundColor3 = COLOR_PANEL
root.BorderSizePixel = 0
root.BackgroundTransparency = 1
root.Parent = widget

acolchar(root, 12, 12)

-- Apertura: el panel entra con un fundido corto. Se hace sobre el fondo y no
-- sobre cada hijo para no pagar una animacion por elemento.
animar(root, TweenInfo.new(0.35), { BackgroundTransparency = 0 })

local barraTabs = Instance.new("Frame")

barraTabs.Name = "Tabs"
barraTabs.Size = UDim2.new(1, 0, 0, ALTO_TAB)
barraTabs.Position = UDim2.new(0, 0, 0, 0)
barraTabs.BackgroundColor3 = COLOR_HUECO
barraTabs.BorderSizePixel = 0
barraTabs.Parent = root

redondear(barraTabs, 10)
acolchar(barraTabs, 3, 3)
enFila(barraTabs, 3)

-- El contenedor de paginas ocupa TODO lo que sobra. Es scale menos el offset
-- de la barra: crece y encoge con el widget sin que haya una sola altura
-- escrita a mano que se quede vieja.
local contenedor = Instance.new("Frame")

contenedor.Name = "Pages"
contenedor.Position = UDim2.new(0, 0, 0, ALTO_TAB + ESPACIO)
contenedor.Size = UDim2.new(1, 0, 1, -(ALTO_TAB + ESPACIO))
contenedor.BackgroundTransparency = 1
contenedor.Parent = root

-- Cada pagina es un ScrollingFrame. Si el contenido no cabe se desplaza; nunca
-- se recorta. Un Frame a secas esconderia el boton de buscar en un widget
-- estrecho sin decir nada.
local function crearPagina(nombre, orden)

	local pagina = Instance.new("ScrollingFrame")

	pagina.Name = nombre
	pagina.LayoutOrder = orden
	pagina.Size = UDim2.fromScale(1, 1)
	pagina.BackgroundTransparency = 1
	pagina.BorderSizePixel = 0
	pagina.CanvasSize = UDim2.new()
	pagina.AutomaticCanvasSize = Enum.AutomaticSize.Y
	pagina.ScrollBarThickness = 4
	pagina.ScrollBarImageColor3 = COLOR_TENUE
	pagina.ScrollBarImageTransparency = 0.65
	pagina.Visible = orden == 1
	pagina.Parent = contenedor

	enColumna(pagina, ESPACIO)

	return pagina

end

local paginaBuscar = crearPagina("Buscar", 1)
local paginaComunidades = crearPagina("Comunidades", 2)
local paginaActividad = crearPagina("Actividad", 3)

local tabs = {}
local tabActiva = "Buscar"

local function mostrarTab(nombre)

	if tabActiva == nombre then return end
	tabActiva = nombre

	for clave, ficha in pairs(tabs) do

		local activa = clave == nombre

		animar(ficha.boton, SUAVE, {
			BackgroundTransparency = activa and 0 or 1,
			TextColor3 = activa and COLOR_TEXTO or COLOR_TENUE,
		})

		ficha.pagina.Visible = activa

	end

	-- La pagina entrante se desliza un poco al aparecer. Un fundido de verdad
	-- necesitaria un CanvasGroup —un ScrollingFrame no tiene transparencia de
	-- grupo— y meter una capa mas en el arbol por una animacion de dos
	-- decimas no compensa: el deslizamiento se lee igual de bien.
	local entrante = tabs[nombre]
	if entrante ~= nil then
		entrante.pagina.Position = UDim2.new(0, 0, 0, 10)
		animar(entrante.pagina, APARECER, { Position = UDim2.new(0, 0, 0, 0) })
	end

end

local function crearTab(nombre, pagina, orden)

	local boton = Instance.new("TextButton")

	boton.Name = nombre
	boton.LayoutOrder = orden
	boton.Size = UDim2.new(1 / 3, -2, 1, 0)
	boton.BackgroundColor3 = COLOR_TARJETA
	boton.BackgroundTransparency = orden == 1 and 0 or 1
	boton.BorderSizePixel = 0
	boton.Text = nombre
	boton.TextColor3 = orden == 1 and COLOR_TEXTO or COLOR_TENUE
	boton.TextSize = 13
	boton.Font = Enum.Font.GothamBold
	boton.AutoButtonColor = false
	boton.Parent = barraTabs

	redondear(boton, 8)

	tabs[nombre] = { boton = boton, pagina = pagina }
	boton.MouseButton1Click:Connect(function() mostrarTab(nombre) end)

	return boton

end

crearTab("Buscar", paginaBuscar, 1)
crearTab("Comunidades", paginaComunidades, 2)
crearTab("Actividad", paginaActividad, 3)

-- =========================================================
-- HELPERS DE UI
-- =========================================================

local function createLabel(text, order, padre)

	local label = Instance.new("TextLabel")

	label.LayoutOrder = order
	label.Size = UDim2.new(1, 0, 0, ALTO_ETIQUETA)
	label.BackgroundTransparency = 1
	label.Text = text
	label.TextColor3 = COLOR_TEXTO
	label.TextSize = 13
	label.Font = Enum.Font.GothamBold
	label.TextXAlignment = Enum.TextXAlignment.Center
	label.Parent = padre or paginaBuscar

	return label

end

local function createTextBox(defaultText, placeholder, order, padre)

	local box = Instance.new("TextBox")

	box.LayoutOrder = order
	box.Size = UDim2.new(1, 0, 0, ALTO_CAMPO)
	box.BackgroundColor3 = COLOR_HUECO
	box.BorderSizePixel = 0
	box.Text = defaultText
	box.PlaceholderText = placeholder
	box.TextColor3 = COLOR_TEXTO
	box.PlaceholderColor3 = COLOR_APAGADO
	box.TextSize = 15
	box.Font = Enum.Font.GothamMedium
	box.TextXAlignment = Enum.TextXAlignment.Center
	box.ClearTextOnFocus = false
	box.Parent = padre or paginaBuscar

	redondear(box)
	acolchar(box, 0, 12)

	-- Un borde que solo aparece al escribir: dice donde esta el foco sin
	-- dibujar cuatro marcos permanentes que compiten con el contenido.
	local borde = Instance.new("UIStroke")
	-- BORDER, no el modo por defecto. En Contextual el trazo se aplica al
	-- contenido renderizado, y en un TextBox el contenido es EL TEXTO: se
	-- perfilaba cada cifra en verde y el campo seguia sin marca de foco.
	borde.ApplyStrokeMode = Enum.ApplyStrokeMode.Border
	borde.Color = COLOR_VERDE
	borde.Thickness = 1
	borde.Transparency = 1
	borde.Parent = box

	box.Focused:Connect(function()
		animar(borde, SUAVE, { Transparency = 0.35 })
	end)
	box.FocusLost:Connect(function()
		animar(borde, SUAVE, { Transparency = 1 })
	end)

	return box

end

local function crearBoton(texto, color, order, padre)

	local boton = Instance.new("TextButton")

	boton.LayoutOrder = order
	boton.Size = UDim2.new(1, 0, 0, ALTO_BOTON)
	boton.BackgroundColor3 = color
	boton.BorderSizePixel = 0
	boton.Text = texto
	boton.TextColor3 = COLOR_TEXTO
	boton.TextSize = 15
	boton.Font = Enum.Font.GothamBold
	boton.AutoButtonColor = true
	boton.Parent = padre

	redondear(boton)

	return boton

end

-- Una linea de texto que crece sola si no cabe en una. Es lo que evita tener
-- que adivinar alturas: con seis cifras de miembros, la misma frase ocupa una
-- linea o dos segun el ancho del widget.
local function crearTexto(padre, texto, orden, medida, color, negrita)

	local label = Instance.new("TextLabel")

	label.LayoutOrder = orden
	label.Size = UDim2.new(1, 0, 0, 0)
	label.AutomaticSize = Enum.AutomaticSize.Y
	label.BackgroundTransparency = 1
	label.Text = texto
	label.TextColor3 = color or COLOR_TENUE
	label.TextSize = medida or 12
	label.Font = negrita and Enum.Font.GothamBold or Enum.Font.Gotham
	label.TextWrapped = true
	label.TextXAlignment = Enum.TextXAlignment.Center
	label.Parent = padre

	return label

end

-- =========================================================
-- PESTAÑA BUSCAR
-- =========================================================

local cabecera = Instance.new("Frame")

cabecera.Name = "Header"
cabecera.LayoutOrder = 1
cabecera.Size = UDim2.new(1, 0, 0, 50)
cabecera.BackgroundColor3 = COLOR_HUECO
cabecera.BorderSizePixel = 0
cabecera.Parent = paginaBuscar

redondear(cabecera)

local title = Instance.new("TextLabel")

title.Name = "Title"
title.Size = UDim2.fromScale(1, 1)
title.BackgroundTransparency = 1
title.Text = "7x Outfit Importer"
title.TextColor3 = COLOR_TEXTO
title.TextSize = 21
title.Font = Enum.Font.GothamBlack
title.TextXAlignment = Enum.TextXAlignment.Center
title.Parent = cabecera

createLabel("Cantidad de Outfits", 2)
local amountBox = createTextBox("100", "Ejemplo: 100", 3)

createLabel("ID de comunidad", 4)
local groupBox = createTextBox("59218460", "Ejemplo: 59218460", 5)

createLabel("Precio mínimo", 6)
local minPriceBox = createTextBox("100", "Ejemplo: 100", 7)

createLabel("Precio máximo", 8)
local maxPriceBox = createTextBox("3000", "Ejemplo: 3000", 9)

-- ── Los dos botones ─────────────────────────────────────────────────────────
--
-- En fila cuando cabe; en columna cuando no. La decision la toma el bloque
-- responsive de mas abajo, que es el unico sitio que sabe cuanto mide el
-- widget en cada momento.

local filaBotones = Instance.new("Frame")

filaBotones.Name = "Buttons"
filaBotones.LayoutOrder = 10
filaBotones.Size = UDim2.new(1, 0, 0, ALTO_BOTON)
filaBotones.BackgroundTransparency = 1
filaBotones.Parent = paginaBuscar

local disposicionBotones = enFila(filaBotones, ESPACIO)

local searchButton = crearBoton("Buscar", COLOR_VERDE, 1, filaBotones)
local cancelImportButton = crearBoton("Cancelar importación", COLOR_ROJO, 2, filaBotones)

cancelImportButton.TextSize = 13

local modoCompacto = false

local function medidaDeBoton()
	if modoCompacto then
		return UDim2.new(1, 0, 0, ALTO_BOTON)
	end
	return UDim2.new(0.5, -ESPACIO / 2, 1, 0)
end

botonVivo(searchButton, medidaDeBoton)
botonVivo(cancelImportButton, medidaDeBoton)

local statusLabel = crearTexto(paginaBuscar, "Esperando...", 11, 12, COLOR_TENUE)

-- ── La barra ────────────────────────────────────────────────────────────────

local progressTrack = Instance.new("Frame")

progressTrack.Name = "Progress"
progressTrack.LayoutOrder = 12
progressTrack.Size = UDim2.new(1, 0, 0, ALTO_BARRA)
progressTrack.BackgroundColor3 = COLOR_HUECO
progressTrack.BorderSizePixel = 0
progressTrack.ClipsDescendants = true
progressTrack.Parent = paginaBuscar

redondear(progressTrack)

local progressFill = Instance.new("Frame")

progressFill.Name = "Fill"
progressFill.Size = UDim2.fromScale(0, 1)
progressFill.BackgroundColor3 = COLOR_VERDE
progressFill.BorderSizePixel = 0
progressFill.ZIndex = 2
progressFill.Parent = progressTrack

redondear(progressFill)

-- EL BRILLO. Se mueve mientras hay trabajo y se para cuando no lo hay, asi que
-- dice algo que el relleno no puede decir: que el proceso sigue vivo aunque el
-- porcentaje lleve un rato quieto — que es exactamente lo que pasa cuando
-- Roblox esta limitando.
--
-- Es UN tween con Reverses y repeticion infinita, no un bucle. El motor lo
-- lleva solo y no cuesta nada por fotograma.
local brillo = Instance.new("Frame")

brillo.Name = "Shine"
brillo.Size = UDim2.new(0.25, 0, 1, 0)
brillo.Position = UDim2.new(-0.3, 0, 0, 0)
brillo.BackgroundColor3 = COLOR_TEXTO
brillo.BackgroundTransparency = 0.88
brillo.BorderSizePixel = 0
brillo.Visible = false
brillo.ZIndex = 3
brillo.Parent = progressTrack

local tweenBrillo = TweenService:Create(
	brillo,
	TweenInfo.new(1.1, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true),
	{ Position = UDim2.new(1.05, 0, 0, 0) }
)

local function brillar(encendido)
	if encendido then
		brillo.Visible = true
		tweenBrillo:Play()
	else
		tweenBrillo:Pause()
		brillo.Visible = false
		brillo.Position = UDim2.new(-0.3, 0, 0, 0)
	end
end

local progressText = Instance.new("TextLabel")

progressText.Name = "ProgressText"
progressText.Size = UDim2.fromScale(1, 1)
progressText.BackgroundTransparency = 1
progressText.Text = "0/0 encontrados"
progressText.TextColor3 = COLOR_TEXTO
progressText.TextSize = 14
progressText.Font = Enum.Font.GothamBold
progressText.TextXAlignment = Enum.TextXAlignment.Center
progressText.ZIndex = 4
progressText.Parent = progressTrack

-- El relleno NUNCA retrocede por cuenta propia: representa progreso real. Lo
-- unico que se suaviza es el salto entre dos valores reales.
local function moverBarra(ratio)
	animar(progressFill, BARRA, { Size = UDim2.fromScale(math.clamp(ratio, 0, 1), 1) })
end

local progressMeta = crearTexto(paginaBuscar, "Sin búsqueda activa.", 13, 12, COLOR_TENUE)

local indexLine = Instance.new("TextLabel")

indexLine.Name = "IndexStats"
indexLine.LayoutOrder = 14
indexLine.Size = UDim2.new(1, 0, 0, 0)
indexLine.AutomaticSize = Enum.AutomaticSize.Y
indexLine.BackgroundColor3 = COLOR_HUECO
indexLine.BorderSizePixel = 0
indexLine.Text = "Índice sin consultar todavía"
indexLine.TextColor3 = COLOR_TENUE
indexLine.TextSize = 12
indexLine.Font = Enum.Font.GothamMedium
indexLine.TextWrapped = true
indexLine.TextXAlignment = Enum.TextXAlignment.Center
indexLine.Parent = paginaBuscar

redondear(indexLine, 10)
acolchar(indexLine, 8, 12)

-- =========================================================
-- PESTAÑA COMUNIDADES
-- =========================================================

local panelAhora = Instance.new("Frame")

panelAhora.Name = "Now"
panelAhora.LayoutOrder = 1
panelAhora.Size = UDim2.new(1, 0, 0, 0)
panelAhora.AutomaticSize = Enum.AutomaticSize.Y
panelAhora.BackgroundColor3 = COLOR_HUECO
panelAhora.BorderSizePixel = 0
panelAhora.Parent = paginaComunidades

redondear(panelAhora)
acolchar(panelAhora, 12, 12)
enColumna(panelAhora, 4)

crearTexto(panelAhora, "INDEXANDO AHORA", 1, 11, COLOR_APAGADO, true)
local ahoraNombre = crearTexto(panelAhora, "Worker en espera", 2, 15, COLOR_TEXTO, true)
local ahoraGrupo = crearTexto(panelAhora, "", 3, 12, COLOR_TENUE)
local ahoraEtapa = crearTexto(panelAhora, "", 4, 12, COLOR_VERDE, true)
local ahoraProgreso = crearTexto(panelAhora, "", 5, 12, COLOR_TENUE)
local ahoraDisponibles = crearTexto(panelAhora, "", 6, 12, COLOR_TENUE)
local ahoraUltimo = crearTexto(panelAhora, "", 7, 11, COLOR_APAGADO)

local listaComunidades = Instance.new("Frame")

listaComunidades.Name = "Communities"
listaComunidades.LayoutOrder = 2
listaComunidades.Size = UDim2.new(1, 0, 0, 0)
listaComunidades.AutomaticSize = Enum.AutomaticSize.Y
listaComunidades.BackgroundTransparency = 1
listaComunidades.Parent = paginaComunidades

enColumna(listaComunidades, ESPACIO)

local avisoComunidades = crearTexto(paginaComunidades, "Consultando el índice...", 3, 12, COLOR_APAGADO)

-- =========================================================
-- PESTAÑA ACTIVIDAD
-- =========================================================

local panelWorker = Instance.new("Frame")

panelWorker.Name = "Worker"
panelWorker.LayoutOrder = 1
panelWorker.Size = UDim2.new(1, 0, 0, 0)
panelWorker.AutomaticSize = Enum.AutomaticSize.Y
panelWorker.BackgroundColor3 = COLOR_HUECO
panelWorker.BorderSizePixel = 0
panelWorker.Parent = paginaActividad

redondear(panelWorker)
acolchar(panelWorker, 12, 12)
enColumna(panelWorker, 4)

crearTexto(panelWorker, "ESTADO DEL WORKER", 1, 11, COLOR_APAGADO, true)

local campos = {}

local function crearCampo(clave, titulo, orden)
	local label = crearTexto(panelWorker, titulo .. ": —", orden, 12, COLOR_TENUE)
	campos[clave] = { label = label, titulo = titulo }
	return label
end

crearCampo("comunidad", "Comunidad", 2)
crearCampo("etapa", "Etapa", 3)
crearCampo("miembros", "Miembros descubiertos", 4)
crearCampo("avatares", "Avatares indexados", 5)
crearCampo("precios", "Usuarios valorados", 6)
crearCampo("cooldown", "Cooldown por ruta", 7)
crearCampo("ultimoCiclo", "Último ciclo", 8)
crearCampo("siguienteCiclo", "Siguiente ciclo", 9)
crearCampo("ultimoProgreso", "Último progreso", 10)

local listaEventos = Instance.new("Frame")

listaEventos.Name = "Events"
listaEventos.LayoutOrder = 2
listaEventos.Size = UDim2.new(1, 0, 0, 0)
listaEventos.AutomaticSize = Enum.AutomaticSize.Y
listaEventos.BackgroundTransparency = 1
listaEventos.Parent = paginaActividad

enColumna(listaEventos, 4)

crearTexto(listaEventos, "ÚLTIMOS EVENTOS", 1, 11, COLOR_APAGADO, true)

-- =========================================================
-- DIALOGO DE CONFIRMACION
-- =========================================================
--
-- Una sola capa reutilizada por las tres cosas que preguntan: buscar en una
-- comunidad cancelada, cancelar la indexacion y eliminar. Tres dialogos
-- distintos serian tres sitios donde arreglar el mismo fallo de maquetacion.

local velo = Instance.new("Frame")

velo.Name = "Modal"
velo.Size = UDim2.fromScale(1, 1)
velo.BackgroundColor3 = Color3.fromRGB(0, 0, 0)
velo.BackgroundTransparency = 1
velo.Visible = false
velo.ZIndex = 50
-- ACTIVE, no solo ZIndex. Un Frame nace con Active = false y entonces no
-- participa en el reparto de clics: se dibuja encima pero los clics lo
-- ATRAVIESAN. El dialogo parecia modal y no lo era — con la confirmacion de
-- borrado en pantalla se podia pulsar "eliminar" en otra tarjeta, y preguntar
-- reescribia el dialogo abierto sin que se notara que habia cambiado de
-- destinatario.
velo.Active = true
velo.Parent = root

local cuadro = Instance.new("Frame")

cuadro.Name = "Dialog"
cuadro.AnchorPoint = Vector2.new(0.5, 0.5)
cuadro.Position = UDim2.fromScale(0.5, 0.5)
cuadro.Size = UDim2.new(1, -24, 0, 0)
cuadro.AutomaticSize = Enum.AutomaticSize.Y
cuadro.BackgroundColor3 = COLOR_TARJETA
cuadro.BorderSizePixel = 0
cuadro.ZIndex = 51
cuadro.Parent = velo

redondear(cuadro)
acolchar(cuadro, 14, 14)
enColumna(cuadro, 8)

local dialogoTitulo = crearTexto(cuadro, "", 1, 15, COLOR_TEXTO, true)
local dialogoTexto = crearTexto(cuadro, "", 2, 12, COLOR_TENUE)
dialogoTitulo.ZIndex = 52
dialogoTexto.ZIndex = 52

local dialogoEntrada = createTextBox("", "Escribe el ID para confirmar", 3, cuadro)
dialogoEntrada.ZIndex = 52
dialogoEntrada.Visible = false

local dialogoBotones = Instance.new("Frame")

dialogoBotones.LayoutOrder = 4
dialogoBotones.Size = UDim2.new(1, 0, 0, 0)
dialogoBotones.AutomaticSize = Enum.AutomaticSize.Y
dialogoBotones.BackgroundTransparency = 1
dialogoBotones.ZIndex = 52
dialogoBotones.Parent = cuadro

enColumna(dialogoBotones, 6)

-- El apagado va con testigo. Sin el, cerrar un dialogo y abrir otro antes de
-- 0,18 s dejaba que el temporizador del primero apagara el segundo: la
-- confirmacion desaparecia sola y la accion no llegaba a ejecutarse.
local dialogoAbierto = 0

local function cerrarDialogo()
	dialogoAbierto = dialogoAbierto + 1
	local mio = dialogoAbierto
	animar(velo, SUAVE, { BackgroundTransparency = 1 })
	task.delay(0.18, function()
		if dialogoAbierto == mio then velo.Visible = false end
	end)
end

-- `opciones` es una lista de { texto, color, alPulsar }. La ultima siempre es
-- la salida sin consecuencias, y se añade sola.
local function preguntar(titulo, mensaje, opciones, exigirTexto)

	dialogoTitulo.Text = titulo
	dialogoTexto.Text = mensaje

	dialogoEntrada.Visible = exigirTexto ~= nil
	dialogoEntrada.Text = ""

	for _, hijo in ipairs(dialogoBotones:GetChildren()) do
		if hijo:IsA("TextButton") then hijo:Destroy() end
	end

	for indice, opcion in ipairs(opciones) do

		local boton = crearBoton(opcion.texto, opcion.color, indice, dialogoBotones)
		boton.TextSize = 13
		boton.ZIndex = 52
		botonVivo(boton, function() return UDim2.new(1, 0, 0, ALTO_BOTON) end)

		boton.MouseButton1Click:Connect(function()

			-- La confirmacion por escrito se comprueba AQUI y tambien en el
			-- servidor. Aqui evita el susto; alli evita el error de verdad.
			if exigirTexto ~= nil and dialogoEntrada.Text ~= exigirTexto then
				dialogoTexto.Text = "El ID no coincide. Escribe " .. exigirTexto .. " para confirmar."
				return
			end

			cerrarDialogo()
			task.spawn(opcion.alPulsar)

		end)

	end

	local salir = crearBoton("Volver", COLOR_TARJETA, #opciones + 1, dialogoBotones)
	salir.TextSize = 13
	salir.TextColor3 = COLOR_TENUE
	salir.ZIndex = 52
	salir.MouseButton1Click:Connect(cerrarDialogo)

	dialogoAbierto = dialogoAbierto + 1
	velo.Visible = true
	velo.BackgroundTransparency = 1
	animar(velo, APARECER, { BackgroundTransparency = 0.45 })

end

-- =========================================================
-- FORMATO
-- =========================================================

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

local function haceCuanto(ms)
	if type(ms) ~= "number" then return "—" end
	local texto = formatMilliseconds(ms)
	if texto == nil then return "—" end
	return "hace " .. texto
end

-- =========================================================
-- LA LINEA DEL INDICE
-- =========================================================
--
-- Se usa `eligible` y no `indexed`: el segundo cuenta tambien avatares vacios
-- y cuentas borradas, y ninguno de esos va a ser un outfit.
local function actualizarIndice(
	coverage
)

	if type(coverage) ~= "table" then

		return

	end

	local indexados =
		tonumber(
			coverage.eligible
		)

	if indexados == nil then

		indexados =
			tonumber(
				coverage.indexed
			)
			or 0

	end

	local miembros =
		tonumber(
			coverage.knownMembers
		)

	if miembros == nil then

		miembros =
			tonumber(
				coverage.members
			)
			or 0

	end

	indexLine.Text =
		tostring(
			indexados
		)
		.. " Outfits indexados  |  "
		.. tostring(
			miembros
		)
		.. " miembros vistos"

end

-- =========================================================
-- CANCELAR IMPORTACION
-- =========================================================
--
-- Es LO MAS LOCAL que hay en todo el plugin, y conviene decir en voz alta lo
-- que NO es: no toca el backend, no toca Postgres, no pausa la comunidad, no
-- para el worker y no borra nada de Workspace. Solo deja de meter modelos.
--
-- Los treinta y siete outfits que ya entraron se quedan donde estan. Borrarlos
-- seria destruir trabajo que la persona ya puede estar usando, y nadie que
-- pulsa "cancelar" espera que le quiten lo que ya tiene.
--
-- La comprobacion es ENTRE OUTFIT Y OUTFIT, en un punto donde no hay ningun
-- modelo a medio armar. Matar la tarea a lo bruto dejaria un rig sin cabeza
-- colgando de Workspace.

local importacion = {
	enCurso = false,     -- hay un bucle de insercion corriendo
	pendiente = false,   -- hay resultados en la mano, aun sin insertar
	cancelada = false,
}

-- Esta busqueda salio de una comunidad con la indexacion cancelada y con lo
-- que ya habia en el indice. Se avisa al terminar, porque un resultado corto
-- de una comunidad cancelada no significa lo mismo que uno corto de una que
-- se esta indexando, y sin decirlo parecen lo mismo.
local avisoExistente = false

local function puedeCancelarImportacion()
	return importacion.enCurso or importacion.pendiente
end

local function refrescarBotonCancelar()

	local activo = puedeCancelarImportacion()

	cancelImportButton.Active = activo
	cancelImportButton.AutoButtonColor = activo

	animar(cancelImportButton, SUAVE, {
		BackgroundTransparency = activo and 0 or 0.6,
		TextTransparency = activo and 0 or 0.45,
	})

end

refrescarBotonCancelar()

cancelImportButton.MouseButton1Click:Connect(function()

	if not puedeCancelarImportacion() then return end

	importacion.cancelada = true
	statusLabel.Text = "Cancelando la importación..."

end)

-- =========================================================
-- EL PANEL: SONDEO Y ACCIONES
-- =========================================================
--
-- `pedirJson` se rellena mas abajo, cuando `requestJson` existe. Declararlo
-- aqui permite que la UI se construya entera antes que la capa de red sin que
-- ninguna de las dos tenga que saber de la otra.
local pedirJson

local API_PANEL = string.gsub(API_URL, "/plugin/outfits/search$", "/plugin/index")

-- Lo que el panel sabe de cada comunidad, para poder preguntar antes de buscar
-- sin tener que ir al servidor otra vez.
local comunidadesConocidas = {}

local ESTADOS = {
	cancelled = { texto = "Indexación cancelada", color = COLOR_ROJO },
	indexing = { texto = "Indexando", color = COLOR_VERDE },
	cooldown = { texto = "Cooldown", color = COLOR_AMBAR },
	waiting = { texto = "Esperando", color = COLOR_AZUL },
	up_to_date = { texto = "Al día", color = COLOR_VERDE },
	error = { texto = "Error", color = COLOR_ROJO },
}

local ETAPAS = {
	crawler = "Miembros",
	avatar = "Avatar",
	pricing = "Precios",
	idle = "En espera",
}

-- Las tarjetas se REUTILIZAN entre sondeos. Reconstruirlas cada cinco segundos
-- tiraria el scroll al principio y haria parpadear la lista entera; ademas,
-- volveria a lanzar la animacion de aparicion en bucle.
local tarjetas = {}

local refrescarComunidades   -- declaradas antes de usarse en los botones
local refrescarEstado

local function accionSobre(groupId, ruta, metodo, cuerpo, alTerminar)

	task.spawn(function()

		local datos, err = pedirJson(
			metodo,
			API_PANEL .. "/groups/" .. tostring(groupId) .. ruta,
			cuerpo
		)

		if datos == nil then

			-- `requestJson` devuelve dos formas de error distintas: la de red,
			-- con `message`, y la de HTTP, que trae el cuerpo ya decodificado.
			-- Leer solo una deja la mitad de los fallos como "error de red".
			local detalle = "error de red"
			if err ~= nil then
				if err.body ~= nil and err.body.error ~= nil and err.body.error.message ~= nil then
					detalle = tostring(err.body.error.message)
				elseif err.message ~= nil then
					detalle = tostring(err.message)
				elseif err.statusCode ~= nil then
					detalle = "HTTP " .. tostring(err.statusCode)
				end
			end

			avisoComunidades.Text = "No se pudo completar la acción: " .. detalle
			avisoComunidades.TextColor3 = COLOR_ROJO
			return

		end

		if alTerminar ~= nil then alTerminar(datos) end
		refrescarComunidades()
		refrescarEstado()

	end)

end

local function cancelarIndexacion(groupId)

	preguntar(
		"Cancelar indexación",
		"El worker dejará de procesar la comunidad " .. tostring(groupId)
			.. ". No se borra nada: se conservan el cursor, los miembros, los avatares y los precios. "
			.. "Puedes reanudarla cuando quieras.",
		{
			{
				texto = "Cancelar indexación",
				color = COLOR_ROJO,
				alPulsar = function()
					accionSobre(groupId, "/cancel", "POST", { reason = "cancelada desde el plugin" })
				end,
			},
		}
	)

end

local function reanudarIndexacion(groupId, despues)

	accionSobre(groupId, "/resume", "POST", nil, despues)

end

local function eliminarComunidad(groupId)

	preguntar(
		"Eliminar comunidad",
		"Eliminar esta comunidad borrará su progreso e información indexada. "
			.. "Esta acción no se puede deshacer.",
		{
			{
				texto = "Eliminar definitivamente",
				color = COLOR_BORRAR,
				alPulsar = function()
					accionSobre(groupId, "", "DELETE", { confirm = tostring(groupId) })
				end,
			},
		},
		tostring(groupId)
	)

end

-- ── UNA TARJETA ─────────────────────────────────────────────────────────────

local function crearTarjeta(groupId)

	local tarjeta = Instance.new("Frame")

	tarjeta.Name = "G" .. tostring(groupId)
	tarjeta.Size = UDim2.new(1, 0, 0, 0)
	tarjeta.AutomaticSize = Enum.AutomaticSize.Y
	tarjeta.BackgroundColor3 = COLOR_TARJETA
	tarjeta.BorderSizePixel = 0
	tarjeta.BackgroundTransparency = 1
	tarjeta.Parent = listaComunidades

	redondear(tarjeta)
	acolchar(tarjeta, 12, 12)
	enColumna(tarjeta, 5)

	local ficha = {
		marco = tarjeta,
		nombre = crearTexto(tarjeta, "", 1, 14, COLOR_TEXTO, true),
		grupo = crearTexto(tarjeta, "", 2, 11, COLOR_APAGADO),
		estado = crearTexto(tarjeta, "", 3, 12, COLOR_TENUE, true),
		miembros = crearTexto(tarjeta, "", 4, 12, COLOR_TENUE),
		outfits = crearTexto(tarjeta, "", 5, 12, COLOR_TENUE),
		etapa = crearTexto(tarjeta, "", 6, 11, COLOR_APAGADO),
		progreso = crearTexto(tarjeta, "", 7, 11, COLOR_APAGADO),
	}

	local acciones = Instance.new("Frame")
	acciones.LayoutOrder = 8
	acciones.Size = UDim2.new(1, 0, 0, 0)
	acciones.AutomaticSize = Enum.AutomaticSize.Y
	acciones.BackgroundTransparency = 1
	acciones.Parent = tarjeta

	ficha.acciones = acciones
	ficha.disposicionAcciones = enColumna(acciones, 6)

	-- Aparicion: solo el fundido. El deslizamiento se quito porque no se veia:
	-- la tarjeta es hija de un UIListLayout, que reescribe la posicion de sus
	-- hijos en cada pasada de maquetacion y le gana la partida a cualquier
	-- tween sobre Position. Animar algo que otro sobrescribe no es una
	-- animacion sutil, es una que no ocurre.
	animar(tarjeta, APARECER, { BackgroundTransparency = 0 })

	return ficha

end

local ALTO_ACCION = 36

-- El tamaño BASE de un boton de tarjeta. Tiene que salir de aqui y no de
-- `boton.Size`: durante el hover el boton ya esta escalado, y leerlo entonces
-- compondria la escala una y otra vez hasta deformarlo.
local function medidaDeAccion()
	if modoCompacto then
		return UDim2.new(1, 0, 0, ALTO_ACCION)
	end
	return UDim2.new(0.5, -3, 0, ALTO_ACCION)
end

local function ajustarAcciones(ficha)

	local horizontal = not modoCompacto
	ficha.disposicionAcciones.FillDirection = horizontal
		and Enum.FillDirection.Horizontal
		or Enum.FillDirection.Vertical

	for _, hijo in ipairs(ficha.acciones:GetChildren()) do
		if hijo:IsA("TextButton") then
			hijo.Size = medidaDeAccion()
		end
	end

	ficha.acciones.Size = UDim2.new(
		1, 0, 0,
		horizontal and ALTO_ACCION or (ALTO_ACCION * 2 + 6)
	)

end

local function pintarAcciones(ficha, grupo)

	-- Solo se rehacen si cambio lo que ofrecen. La lista se refresca sola cada
	-- diez segundos, y destruir y recrear tres botones en cada vuelta genera
	-- basura sin parar y ademas quita el foco a quien tenga el raton encima.
	local firma = grupo.paused and "pausada" or "activa"
	if ficha.firmaAcciones == firma then return end
	ficha.firmaAcciones = firma

	for _, hijo in ipairs(ficha.acciones:GetChildren()) do
		if hijo:IsA("TextButton") then hijo:Destroy() end
	end

	local groupId = grupo.groupId

	if grupo.paused then

		local reanudar = crearBoton("Reanudar indexación", COLOR_VERDE, 1, ficha.acciones)
		reanudar.TextSize = 13
		botonVivo(reanudar, medidaDeAccion)
		reanudar.MouseButton1Click:Connect(function() reanudarIndexacion(groupId) end)

	else

		local cancelar = crearBoton("Cancelar indexación", COLOR_ROJO, 1, ficha.acciones)
		cancelar.TextSize = 13
		botonVivo(cancelar, medidaDeAccion)
		cancelar.MouseButton1Click:Connect(function() cancelarIndexacion(groupId) end)

	end

	local eliminar = crearBoton("Eliminar comunidad", COLOR_BORRAR, 2, ficha.acciones)
	eliminar.TextSize = 13
	botonVivo(eliminar, medidaDeAccion)
	eliminar.MouseButton1Click:Connect(function() eliminarComunidad(groupId) end)

	ajustarAcciones(ficha)

end

local function pintarComunidades(grupos)

	local vistos = {}

	for indice, grupo in ipairs(grupos) do

		local clave = tostring(grupo.groupId)
		vistos[clave] = true
		comunidadesConocidas[clave] = grupo

		local ficha = tarjetas[clave]
		if ficha == nil then
			ficha = crearTarjeta(clave)
			tarjetas[clave] = ficha
		end

		ficha.marco.LayoutOrder = indice

		local estado = ESTADOS[grupo.status] or { texto = grupo.status, color = COLOR_TENUE }

		ficha.nombre.Text = grupo.groupName or ("Comunidad " .. clave)
		ficha.grupo.Text = clave

		-- El indicador cambia de color con una transicion, no de golpe: es la
		-- forma de que se note que ALGO cambio en una lista que se refresca
		-- sola cada diez segundos.
		ficha.estado.Text = estado.texto
		animar(ficha.estado, SUAVE, { TextColor3 = estado.color })

		animarNumero(ficha.miembros, grupo.indexed or 0, function(n)
			return tostring(n) .. " de " .. tostring(grupo.knownMembers or 0) .. " miembros con avatar"
		end)

		animarNumero(ficha.outfits, grupo.eligible or 0, function(n)
			return tostring(n) .. " outfits disponibles"
		end)

		ficha.etapa.Text = grupo.stage ~= nil
			and ("Etapa: " .. (ETAPAS[grupo.stage] or grupo.stage))
			or (grupo.lastError and ("Último error: " .. tostring(grupo.lastError)) or "Etapa: —")

		ficha.progreso.Text = "Último progreso: " .. haceCuanto(grupo.lastProgressAgoMs)

		pintarAcciones(ficha, grupo)

	end

	for clave, ficha in pairs(tarjetas) do
		if not vistos[clave] then
			-- Los contadores estan indexados por etiqueta: si la tarjeta se va
			-- y su entrada se queda, la tabla crece con cada comunidad
			-- eliminada durante toda la sesion de Studio.
			contadores[ficha.miembros] = nil
			contadores[ficha.outfits] = nil
			ficha.marco:Destroy()
			tarjetas[clave] = nil
			comunidadesConocidas[clave] = nil
		end
	end

	if #grupos == 0 then
		avisoComunidades.Text = "El índice no conoce ninguna comunidad todavía."
		avisoComunidades.TextColor3 = COLOR_APAGADO
	else
		avisoComunidades.Text = tostring(#grupos) .. " comunidades en el índice"
		avisoComunidades.TextColor3 = COLOR_APAGADO
	end

end

-- ── INDEXANDO AHORA ─────────────────────────────────────────────────────────

local function pintarAhora(actual)

	if actual == nil then

		ahoraNombre.Text = "Worker en espera"
		ahoraGrupo.Text = ""
		ahoraEtapa.Text = ""
		ahoraProgreso.Text = ""
		ahoraDisponibles.Text = ""
		ahoraUltimo.Text = ""
		return

	end

	local clave = tostring(actual.groupId)
	local grupo = comunidadesConocidas[clave]

	ahoraNombre.Text = (grupo and grupo.groupName) or ("Comunidad " .. clave)
	ahoraGrupo.Text = clave
	ahoraEtapa.Text = "Etapa: " .. (ETAPAS[actual.stage] or tostring(actual.stage))

	if grupo ~= nil then
		animarNumero(ahoraProgreso, grupo.indexed or 0, function(n)
			return tostring(n) .. " / " .. tostring(grupo.knownMembers or 0) .. " miembros indexados"
		end)
		animarNumero(ahoraDisponibles, grupo.eligible or 0, function(n)
			return tostring(n) .. " outfits disponibles"
		end)
		ahoraUltimo.Text = "Último progreso: " .. haceCuanto(grupo.lastProgressAgoMs)
	end

end

-- ── ACTIVIDAD ───────────────────────────────────────────────────────────────

local etiquetasEvento = {}

local TEXTO_EVENTO = {
	cycle = "Ciclo terminado",
	lap_complete = "Vuelta completa",
	cooldown_start = "Entró en cooldown",
	cooldown_end = "Salió del cooldown",
	group_paused = "Comunidad cancelada",
	group_resumed = "Comunidad reanudada",
	group_deleted = "Comunidad eliminada",
	error = "Error",
}

local function pintarEventos(eventos)

	for indice = 1, 20 do

		local evento = eventos[indice]
		local label = etiquetasEvento[indice]

		if evento == nil then
			if label ~= nil then label.Visible = false end
		else

			if label == nil then
				label = crearTexto(listaEventos, "", indice + 1, 11, COLOR_APAGADO)
				label.TextXAlignment = Enum.TextXAlignment.Left
				etiquetasEvento[indice] = label
			end

			label.Visible = true
			label.Text = (TEXTO_EVENTO[evento.tipo] or evento.tipo)
				.. (evento.groupId and ("  ·  " .. evento.groupId) or "")
				.. (evento.detalle and ("  ·  " .. evento.detalle) or "")

		end

	end

end

-- ── LOS DOS SONDEOS ─────────────────────────────────────────────────────────
--
-- Ninguno de los dos llama a Roblox ni crea trabajo: el servidor los sirve de
-- Postgres y de su propia memoria. Por eso se pueden repetir cada pocos
-- segundos sin quitarle cuota al worker, que es quien la necesita.
--
-- El estado va cada 5 s porque es lo que cambia deprisa y es lo mas barato (no
-- toca la base siquiera). La lista de comunidades va cada 10 s porque cuenta
-- filas, y contar filas cada cinco segundos para enseñar un numero que se
-- mueve despacio es pagar de mas.

local generacionSondeo = 0

refrescarEstado = function()

	if pedirJson == nil then return end

	local datos = pedirJson("GET", API_PANEL .. "/status")
	if datos == nil then return end

	local worker = datos.worker or {}
	local contadores = datos.counters or {}

	pintarAhora(worker.groupId ~= nil and worker.etapa ~= "idle"
		and { groupId = worker.groupId, stage = worker.etapa } or nil)

	campos.comunidad.label.Text = "Comunidad: " .. tostring(worker.groupId or "—")
	campos.etapa.label.Text = "Etapa: " .. (ETAPAS[worker.etapa] or tostring(worker.etapa))

	animarNumero(campos.miembros.label, contadores.memberRowsSeen or 0,
		function(n) return "Miembros descubiertos: " .. tostring(n) end)
	animarNumero(campos.avatares.label, contadores.avatarsIndexed or 0,
		function(n) return "Avatares indexados: " .. tostring(n) end)
	animarNumero(campos.precios.label, contadores.usersPriced or 0,
		function(n) return "Usuarios valorados: " .. tostring(n) end)

	local frenos = {}
	for ruta, freno in pairs(datos.cooldowns or {}) do
		if freno.remainingMs and freno.remainingMs > 0 then
			table.insert(frenos, ruta .. " " .. (formatMilliseconds(freno.remainingMs) or "?"))
		end
	end
	campos.cooldown.label.Text = "Cooldown por ruta: "
		.. (#frenos > 0 and table.concat(frenos, ", ") or "ninguno")

	campos.ultimoCiclo.label.Text = "Último ciclo: "
		.. (contadores.lastCycleMs and (formatMilliseconds(contadores.lastCycleMs) or "—") or "—")
	campos.siguienteCiclo.label.Text = "Siguiente ciclo: en "
		.. (formatMilliseconds(datos.nextCycleInMs) or "—")
	campos.ultimoProgreso.label.Text = "Último progreso: " .. haceCuanto(worker.lastProgressAgoMs)

	pintarEventos(datos.events or {})

end

refrescarComunidades = function()

	if pedirJson == nil then return end

	local datos = pedirJson("GET", API_PANEL .. "/groups")
	if datos == nil then
		avisoComunidades.Text = "No se pudo consultar el índice."
		avisoComunidades.TextColor3 = COLOR_ROJO
		return
	end

	pintarComunidades(datos.groups or {})
	pintarAhora(datos.current)

end

local function arrancarSondeo()

	generacionSondeo = generacionSondeo + 1
	local mia = generacionSondeo

	task.spawn(function()

		local vueltas = 0

		while widget.Enabled and generacionSondeo == mia do

			-- pcall: un fallo de red no puede llevarse por delante el bucle. Si
			-- se cae, el panel deja de refrescarse hasta que alguien reabra el
			-- widget, y eso es un fallo peor que el que lo causo.
			pcall(refrescarEstado)

			if vueltas % 2 == 0 then
				pcall(refrescarComunidades)
			end

			vueltas = vueltas + 1
			task.wait(5)

		end

	end)

end

-- Cerrar el widget para el sondeo. Sin esto, un plugin abierto una vez seguiria
-- preguntando cada cinco segundos durante toda la sesion de Studio.
widget:GetPropertyChangedSignal("Enabled"):Connect(function()
	if widget.Enabled then
		arrancarSondeo()
	else
		generacionSondeo = generacionSondeo + 1
	end
end)

-- Y RECARGAR EL PLUGIN tambien lo para. generacionSondeo protege contra
-- duplicados dentro de una misma carga, pero no entre cargas: al recargar, la
-- corrutina vieja seguia viva comparando contra SU propio contador y mirando SU
-- propio widget, que conserva Enabled = true aunque este destruido. Cada
-- guardado del archivo durante el desarrollo dejaba un sondeo huerfano mas, y
-- no habia forma de pararlos salvo reiniciar Studio.
plugin.Unloading:Connect(function()
	generacionSondeo = generacionSondeo + 1
end)

-- =========================================================
-- RESPONSIVE
-- =========================================================
--
-- El unico sitio que sabe cuanto mide el widget. Cambia lo MINIMO: la
-- direccion de las filas y el tamaño de los botones. No reconstruye nada, que
-- es lo que haria que arrastrar el borde del panel diera tirones.

local function aplicarAncho()

	local compacto = root.AbsoluteSize.X < ANCHO_COMPACTO
	if compacto == modoCompacto then return end
	modoCompacto = compacto

	if compacto then

		disposicionBotones.FillDirection = Enum.FillDirection.Vertical
		filaBotones.Size = UDim2.new(1, 0, 0, ALTO_BOTON * 2 + ESPACIO)
		searchButton.Size = UDim2.new(1, 0, 0, ALTO_BOTON)
		cancelImportButton.Size = UDim2.new(1, 0, 0, ALTO_BOTON)

	else

		disposicionBotones.FillDirection = Enum.FillDirection.Horizontal
		filaBotones.Size = UDim2.new(1, 0, 0, ALTO_BOTON)
		searchButton.Size = UDim2.new(0.5, -ESPACIO / 2, 1, 0)
		cancelImportButton.Size = UDim2.new(0.5, -ESPACIO / 2, 1, 0)

	end

	-- Las tarjetas ya creadas se reajustan; NO se reconstruyen. Rehacer la
	-- lista al arrastrar el borde del panel daria tirones y perderia el scroll.
	for _, ficha in pairs(tarjetas) do
		ajustarAcciones(ficha)
	end

end

root:GetPropertyChangedSignal("AbsoluteSize"):Connect(aplicarAncho)
aplicarAncho()

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

-- El panel ya puede hablar. Se engancha aqui, y no antes, porque la UI se
-- construye entera antes de que exista la capa de red: asi ninguna de las dos
-- tiene que saber en que orden se cargo la otra.
pedirJson = requestJson

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

	-- El relleno representa progreso REAL y nunca retrocede por su cuenta: lo
	-- unico que se suaviza es el salto entre dos valores que ya son reales.
	moverBarra(ratio)

	animarNumero(
		progressText,
		found,
		function(n)
			return tostring(n) .. "/" .. tostring(target) .. " encontrados"
		end
	)

	-- La linea del indice se refresca en cada pintado, con la cobertura que
	-- venga en la respuesta. Si no viene, se queda la anterior: borrarla en
	-- cada sondeo la dejaria parpadeando.
	actualizarIndice(
		job.coverage
	)

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
			"Buscando..."

		searchButton.Active =
			false

		searchButton.AutoButtonColor =
			false

		searchButton.BackgroundTransparency =
			0.4

		-- EL BRILLO se enciende mientras hay trabajo. Dice algo que el relleno
		-- no puede decir: que el proceso sigue vivo aunque el porcentaje lleve
		-- un rato quieto, que es justo lo que pasa cuando Roblox esta limitando.
		brillar(true)

	else

		searchButton.Text =
			"Buscar"

		searchButton.Active =
			true

		searchButton.AutoButtonColor =
			true

		searchButton.BackgroundTransparency =
			0

		brillar(false)

	end

	-- El boton de cancelar la importacion NO depende de si se esta buscando,
	-- sino de si hay algo que insertar. Son dos cosas distintas: la busqueda
	-- puede haber terminado y la insercion seguir a la mitad.
	refrescarBotonCancelar()

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
		importacion.pendiente = false
		refrescarBotonCancelar()
		return resumen
	end

	local carpeta = carpetaDeOutfits()

	-- Desde donde se coloca la fila: detras de lo que ya haya en la carpeta,
	-- para que dos busquedas seguidas no apilen modelos en el mismo sitio. Se
	-- cuenta lo que hay en vez de guardar un atributo — la carpeta es de tu
	-- sistema y no se le añade nada que no le corresponda.
	local base = #carpeta:GetChildren()

	-- Si lo cancelaron mientras llegaba la respuesta, no se empieza siquiera.
	if importacion.cancelada then
		resumen.cancelado = true
		importacion.pendiente = false
		refrescarBotonCancelar()
		return resumen
	end

	importacion.enCurso = true
	refrescarBotonCancelar()

	for indice, outfit in ipairs(outfits) do

		-- EL PUNTO SEGURO. Se comprueba aqui, entre un outfit y el siguiente,
		-- donde no hay ningun rig a medio armar. Matar la tarea a lo bruto
		-- dejaria un modelo sin cabeza colgando de Workspace. Y los que ya
		-- entraron se quedan donde estan: nadie que pulsa "cancelar" espera
		-- que ademas le quiten lo que ya tiene.
		if importacion.cancelada then
			resumen.cancelado = true
			break
		end

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

	importacion.enCurso = false
	importacion.pendiente = false
	refrescarBotonCancelar()

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

	-- Con los resultados YA en la mano y antes de meter el primer modelo, la
	-- cancelacion pasa a estar disponible. Es lo que permite pararlo entre que
	-- llega la respuesta y empieza la insercion, que en cien outfits es una
	-- ventana de varios segundos.
	importacion.cancelada = false
	importacion.pendiente = true
	refrescarBotonCancelar()

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

	-- Las dos lineas de estadisticas, con las cifras de esta busqueda: lo
	-- insertado sale del resumen de la importacion, lo buscado es lo que se
	-- pidio y lo encontrado es lo que devolvio el servidor.
	if resumen.cancelado then

		-- Lo que ya entro se queda. Se dice cuanto, porque "cancelado" a secas
		-- deja a quien lo pulso sin saber si tiene 37 outfits o ninguno.
		statusLabel.Text =
			"Importación cancelada · "
			.. tostring(
				resumen.insertados
			)
			.. " outfits insertados se conservan"

	elseif resumen.fallidos > 0 then

		statusLabel.Text =
			tostring(
				resumen.fallidos
			)
			.. " no se pudieron importar"

	else

		statusLabel.Text =
			"Búsqueda terminada."

	end

	if avisoExistente then

		statusLabel.Text =
			"Resultados obtenidos del índice existente. "
			.. "La indexación de esta comunidad está cancelada."

		avisoExistente = false

	end

	progressMeta.Text =
		tostring(
			resumen.insertados
		)
		.. " Outfits insertados  |  "
		.. tostring(
			amount
		)
		.. " Outfits buscados  |  "
		.. tostring(
			resumen.recibidos
		)
		.. " Outfits encontrados"

	actualizarIndice(
		finalData.coverage
	)

end

-- =========================================================
-- CONEXIÓN DEL BOTÓN
-- =========================================================

-- BUSCAR EN UNA COMUNIDAD CON LA INDEXACION CANCELADA.
--
-- Nunca se reactiva en silencio. El panel ya sabe el estado de cada comunidad
-- porque lo sondea, asi que la pregunta se hace ANTES de salir a la red y las
-- dos salidas son explicitas:
--
--   REANUDAR Y BUSCAR       se reanuda de verdad —conservando cursor y
--                           progreso, sin empezar de cero— y despues se busca.
--   BUSCAR CON LO QUE HAY   no se toca el estado de la comunidad. La busqueda
--                           sale del indice que ya existe, y se avisa de que
--                           eso es lo que se esta enseñando.
-- LA UNICA PUERTA POR LA QUE SE LANZA UNA BUSQUEDA.
--
-- Los tres caminos —el directo, y los dos del dialogo de comunidad cancelada—
-- pasan por aqui. Antes la proteccion vivia en el manejador del boton, y los
-- dos caminos del dialogo se la saltaban: corren en otra corrutina, lanzada
-- desde preguntar, asi que un fallo alli mataba la corrutina en silencio y
-- dejaba el boton clavado en Buscando... hasta recargar el plugin.
local function ejecutarBusqueda()

	local ok, fallo = pcall(searchOutfits)

	-- Se reponen SIEMPRE, salga como salga. El aviso de indice existente
	-- tambien: se encendia al elegir buscar con datos existentes y solo se
	-- apagaba al final del camino feliz, asi que una busqueda que fallara por
	-- red lo dejaba puesto y la SIGUIENTE, sobre una comunidad perfectamente
	-- activa, anunciaba que estaba cancelada.
	importacion.enCurso = false
	importacion.pendiente = false
	avisoExistente = false
	refrescarBotonCancelar()

	if not ok then
		warn("[7x Outfit Importer] La busqueda fallo:", fallo)
		statusLabel.Text = "La búsqueda falló. Revisa el Output."
		setSearching(false)
	end

end

-- BUSCAR EN UNA COMUNIDAD CON LA INDEXACION CANCELADA.
--
-- Nunca se reactiva en silencio. El panel ya sabe el estado de cada comunidad
-- porque lo sondea, asi que la pregunta se hace ANTES de salir a la red y las
-- dos salidas son explicitas:
--
--   REANUDAR Y BUSCAR       se reanuda de verdad —conservando cursor y
--                           progreso, sin empezar de cero— y despues se busca.
--   BUSCAR CON LO QUE HAY   no se toca el estado de la comunidad. La busqueda
--                           sale del indice que ya existe, y se avisa de que
--                           eso es lo que se esta enseñando.
local function buscarConAviso()

	if searching then return end

	local groupId = string.match(groupBox.Text or "", "%d+")
	local grupo = groupId ~= nil and comunidadesConocidas[groupId] or nil

	if grupo == nil or not grupo.paused then
		ejecutarBusqueda()
		return
	end

	preguntar(
		"Indexación cancelada",
		"La indexación de esta comunidad está cancelada. Puedes reanudarla "
			.. "antes de buscar, o buscar solo con los datos que ya hay en el índice.",
		{
			{
				texto = "Reanudar y buscar",
				color = COLOR_VERDE,
				alPulsar = function()
					reanudarIndexacion(groupId, ejecutarBusqueda)
				end,
			},
			{
				texto = "Buscar con datos existentes",
				color = COLOR_AZUL,
				alPulsar = function()
					avisoExistente = true
					ejecutarBusqueda()
				end,
			},
		}
	)

end

searchButton.MouseButton1Click:Connect(
	function()
		task.spawn(function()
			local ok, fallo = pcall(buscarConAviso)
			if not ok then
				warn("[7x Outfit Importer] No se pudo abrir la busqueda:", fallo)
			end
		end)
	end
)

-- El panel arranca si el widget ya estaba abierto al cargar el plugin. Si no,
-- lo enciende y lo apaga el evento de Enabled.
if widget.Enabled then
	arrancarSondeo()
end
