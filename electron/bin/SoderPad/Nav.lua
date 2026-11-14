-- SoderPad: andar pelos menus com o controle. Enquanto um menu esta aberto, D-pad e analogico
-- movem um contorno dourado, A confirma, X da o clique esquerdo em itens e B fecha. Ao fechar,
-- tudo volta a controlar o personagem. So fora de combate: o jogo proibe trocar teclas em combate.

-- Do mais para o menos prioritario. Janela modal esconde o resto.
local MODAIS = { "StaticPopup1", "StaticPopup2", "StaticPopup3", "StaticPopup4", "DropDownList2", "DropDownList1" }
local JANELAS = {
    "GameMenuFrame", "VideoOptionsFrame", "AudioOptionsFrame", "InterfaceOptionsFrame", "KeyBindingFrame",
    "LootFrame", "DragonUILootFrame", "DragonUI_LootFrame", "GossipFrame", "QuestFrame", "QuestLogFrame", "MerchantFrame", "ClassTrainerFrame", "TradeFrame",
    "MailFrame", "OpenMailFrame", "BankFrame", "AuctionFrame", "GuildBankFrame", "CharacterFrame",
    "SpellBookFrame", "DragonUI_SpellbookFrame", "PlayerTalentFrame", "DragonUI_TalentFrame", "FriendsFrame",
    "PVPParentFrame", "LFDParentFrame", "AchievementFrame", "TradeSkillFrame", "PetStableFrame", "TabardFrame",
    "ReadyCheckFrame",
    "ContainerFrame1", "ContainerFrame2", "ContainerFrame3", "ContainerFrame4", "ContainerFrame5", "ContainerFrame6",
    "ContainerFrame7", "ContainerFrame8", "ContainerFrame9", "ContainerFrame10", "ContainerFrame11", "ContainerFrame12",
}
local MAX_ITENS_BOLSA = 300
-- Botao que fecha cada janela, quando nao segue o padrao <janela>CloseButton.
local FECHAR = {
    GameMenuFrame = "GameMenuButtonContinue", VideoOptionsFrame = "VideoOptionsFrameCancel",
    AudioOptionsFrame = "AudioOptionsFrameCancelButton", InterfaceOptionsFrame = "InterfaceOptionsFrameCancel",
    KeyBindingFrame = "KeyBindingFrameCancelButton", StaticPopup1 = "StaticPopup1Button2",
    StaticPopup2 = "StaticPopup2Button2", StaticPopup3 = "StaticPopup3Button2", StaticPopup4 = "StaticPopup4Button2",
    LootFrame = "LootCloseButton", DragonUILootFrame = "LootCloseButton",
}
local TECLAS_DIRECAO = {
    { "F6", "Cima" }, { "W", "Cima" }, { "F8", "Baixo" }, { "S", "Baixo" },
    { "F9", "Esquerda" }, { "A", "Esquerda" }, { "F7", "Direita" }, { "D", "Direita" },
}
-- Fora destas, os poderes ficam mudos enquanto o menu esta aberto.
local TECLAS_MUDAS = { "F2", "F4", "F5", "SHIFT-F1", "SHIFT-F2", "SHIFT-F3", "CTRL-F1", "CTRL-F2", "CTRL-F3" }

local dono, moldura
local ativo, foco, itens = false, nil, {}
local assinatura = ""

local function ItemDeBolsa(b)
    local nome = b:GetName()
    return nome and (nome:find("^ContainerFrame%d+Item") or nome:find("^DragonUI_BagsterItem")
        or nome:find("^BankFrameItem")) ~= nil
end

local function Clicavel(f)
    local tipo = f:GetObjectType()
    if tipo ~= "Button" and tipo ~= "CheckButton" then return false end
    if not f:IsVisible() or not f:IsEnabled() or not f:IsMouseEnabled() then return false end
    return f:GetWidth() >= 12 and f:GetHeight() >= 12
end

local function Juntar(f, saida, nivel)
    if nivel > 7 or not f:IsVisible() then return end
    if Clicavel(f) then saida[#saida + 1] = f end
    for _, filho in ipairs({ f:GetChildren() }) do Juntar(filho, saida, nivel + 1) end
end

local function JanelasAbertas()
    for _, nome in ipairs(MODAIS) do
        local f = _G[nome]
        if f and f:IsVisible() then return { f }, nome end
    end
    local abertas, ultima = {}, nil
    for _, nome in ipairs(JANELAS) do
        local f = _G[nome]
        if f and f:IsVisible() then
            abertas[#abertas + 1] = f
            ultima = ultima or nome
        end
    end
    return abertas, ultima
end

local function ColetarItens()
    local abertas, topo = JanelasAbertas()
    local saida = {}
    for _, f in ipairs(abertas) do Juntar(f, saida, 0) end
    -- A janela de Loot pode ser Blizzard padrao ou DragonUI (com botoes reparentados)
    local lootAberto = (_G.LootFrame and _G.LootFrame:IsVisible())
    if not lootAberto then
        for i = 1, 4 do
            local lb = _G["LootButton" .. i]
            if lb and lb:IsVisible() then lootAberto = true; break end
        end
    end
    if lootAberto then
        topo = topo or "LootFrame"
        for i = 1, 16 do
            local b = _G["LootButton" .. i]
            if b and Clicavel(b) then saida[#saida + 1] = b end
        end
        for i = 1, 32 do
            local b = _G["DragonUILootRow" .. i]
            if b and Clicavel(b) then saida[#saida + 1] = b end
        end
    end
    -- A mochila da DragonUI nao tem janela de nome fixo: os itens sim.
    if #abertas ~= 1 or not (topo or ""):find("^StaticPopup") and not (topo or ""):find("^DropDownList") then
        for i = 1, MAX_ITENS_BOLSA do
            local b = _G["DragonUI_BagsterItem" .. i]
            if b and Clicavel(b) then saida[#saida + 1] = b end
        end
        if #saida > #abertas and not topo then topo = "Bagster" end
    end
    return saida, topo
end

local function Centro(f)
    local e, c = f:GetEffectiveScale(), { f:GetCenter() }
    if not c[1] then return nil end
    return c[1] * e, c[2] * e
end

local function SairDoItem()
    if foco then
        local sair = foco:GetScript("OnLeave")
        if sair then pcall(sair, foco) end
    end
end

local function BotaoDeFechar(topo)
    local nome = FECHAR[topo or ""] or ((topo or "") .. "CloseButton")
    local b = _G[nome]
    return b and b:IsVisible() and nome or nil
end

local function LigarClique()
    if InCombatLockdown() then return end
    if not foco then
        SetOverrideBindingClick(dono, true, "SPACE", "SoderPadNavMudo")
        return
    end
    local nome = foco:GetName()
    if nome then
        -- Tecla ligada ao proprio botao: e um clique de verdade, vale ate em botao protegido.
        SetOverrideBindingClick(dono, true, "SPACE", nome, ItemDeBolsa(foco) and "RightButton" or "LeftButton")
        SetOverrideBindingClick(dono, true, "F1", nome, "LeftButton")
    else
        SetOverrideBindingClick(dono, true, "SPACE", "SoderPadNavConfirma")
        SetOverrideBindingClick(dono, true, "F1", "SoderPadNavConfirma")
    end
end

local function Focar(f)
    if f == foco then return end
    SairDoItem()
    foco = f
    if not f then
        moldura:Hide()
    else
        moldura:ClearAllPoints()
        moldura:SetPoint("TOPLEFT", f, "TOPLEFT", -3, 3)
        moldura:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", 3, -3)
        moldura:Show()
        local entrar = f:GetScript("OnEnter")
        if entrar then pcall(entrar, f) end
    end
    LigarClique()
end

-- O mais perto na direcao apertada; um item muito de lado conta como mais longe.
local function Mover(dx, dy)
    if not foco then return end
    local x, y = Centro(foco)
    if not x then return end
    local melhor, nota = nil, math.huge
    for _, b in ipairs(itens) do
        if b ~= foco then
            local bx, by = Centro(b)
            if bx then
                local frente = (bx - x) * dx + (by - y) * dy
                local lado = math.abs((bx - x) * dy) + math.abs((by - y) * dx)
                if frente > 1 and lado <= frente * 2 then
                    local n = frente + lado * 2
                    if n < nota then melhor, nota = b, n end
                end
            end
        end
    end
    if melhor then Focar(melhor) end
end

-- Em cima e a esquerda; com mochila aberta, comeca nos itens e nao nos botoes da janela.
local function PrimeiroItem()
    local temItem = false
    for _, b in ipairs(itens) do
        if ItemDeBolsa(b) then temItem = true end
    end
    local melhor, nota = nil, -math.huge
    for _, b in ipairs(itens) do
        local x, y = Centro(b)
        if x and (not temItem or ItemDeBolsa(b)) and y - x * 0.2 > nota then melhor, nota = b, y - x * 0.2 end
    end
    return melhor
end

local function Sair()
    if not ativo then return end
    ativo = false
    SairDoItem()
    foco = nil
    moldura:Hide()
    ClearOverrideBindings(dono)
end

-- Taxi / Pontos de Voo ---------------------------------------------------------
local circuloVoo
local nosVoo = {}
local vooAtual = 1
local taxiAtivo = false

local function ObterNosVoo()
    local lista = {}
    local total = NumTaxiNodes()
    for i = 1, total do
        if TaxiNodeGetType(i) == "REACHABLE" then
            local b = _G["TaxiButton" .. i]
            if b and b:IsVisible() then
                local e, c = b:GetEffectiveScale(), { b:GetCenter() }
                local x = c[1] and (c[1] * e) or 0
                local y = c[2] and (c[2] * e) or 0
                lista[#lista + 1] = {
                    indice = i,
                    botao = b,
                    x = x,
                    y = y,
                    nome = TaxiNodeName(i),
                    custo = TaxiNodeCost(i),
                }
            end
        end
    end
    return lista
end

local function CriarCirculoVoo()
    if circuloVoo then return end
    local parent = _G.TaxiRouteMap or _G.TaxiFrame or UIParent
    circuloVoo = CreateFrame("Frame", "SoderPadTaxiCirculo", parent)
    circuloVoo:SetSize(42, 42)
    circuloVoo:SetFrameStrata("TOOLTIP")
    circuloVoo:Hide()

    local halo = circuloVoo:CreateTexture(nil, "BACKGROUND")
    halo:SetTexture("Interface\\Minimap\\UI-Minimap-ZoomButton-Highlight")
    halo:SetBlendMode("ADD")
    halo:SetAllPoints(circuloVoo)
    halo:SetVertexColor(1, 0.88, 0.2, 0.95)
    circuloVoo.halo = halo

    local anel = circuloVoo:CreateTexture(nil, "OVERLAY")
    anel:SetTexture("Interface\\Minimap\\MiniMap-TrackingBorder")
    anel:SetSize(48, 48)
    anel:SetPoint("CENTER", circuloVoo, "CENTER", 4, -4)
    circuloVoo.anel = anel

    local t = 0
    circuloVoo:SetScript("OnUpdate", function(self, d)
        t = t + d * 5
        local a = 0.75 + 0.25 * math.sin(t)
        halo:SetAlpha(a)
    end)
end

local function SelecionarNoVoo(idx)
    if not nosVoo or #nosVoo == 0 then
        if circuloVoo then circuloVoo:Hide() end
        return
    end
    if idx < 1 then idx = #nosVoo end
    if idx > #nosVoo then idx = 1 end
    vooAtual = idx
    local no = nosVoo[vooAtual]
    if not no or not no.botao then return end

    CriarCirculoVoo()
    circuloVoo:ClearAllPoints()
    circuloVoo:SetPoint("CENTER", no.botao, "CENTER", 0, 0)
    circuloVoo:Show()

    if TaxiNodeOnButtonEnter then
        pcall(TaxiNodeOnButtonEnter, no.botao)
    end
end

local function MoverVoo(dx, dy)
    if not nosVoo or #nosVoo <= 1 then return end
    local atual = nosVoo[vooAtual]
    local melhorIdx, melhorNota = nil, math.huge
    for i, no in ipairs(nosVoo) do
        if i ~= vooAtual and no.x and atual and atual.x then
            local vx = no.x - atual.x
            local vy = no.y - atual.y
            local frente = vx * dx + vy * dy
            local lado = math.abs(vx * dy) + math.abs(vy * dx)
            if frente > 4 and lado <= frente * 2.5 then
                local nota = frente + lado * 1.5
                if nota < melhorNota then
                    melhorNota = nota
                    melhorIdx = i
                end
            end
        end
    end
    if melhorIdx then
        SelecionarNoVoo(melhorIdx)
    else
        local passo = (dx > 0 or dy > 0) and 1 or -1
        SelecionarNoVoo(vooAtual + passo)
    end
end

local function SairTaxi()
    if not taxiAtivo then return end
    taxiAtivo = false
    if circuloVoo then circuloVoo:Hide() end
    if GameTooltip then GameTooltip:Hide() end
    ClearOverrideBindings(dono)
end

local function EntrarTaxi()
    taxiAtivo = true
    moldura:Hide()
    for _, par in ipairs(TECLAS_DIRECAO) do
        SetOverrideBindingClick(dono, true, par[1], "SoderPadTaxi" .. par[2])
    end
    for _, tecla in ipairs(TECLAS_MUDAS) do
        SetOverrideBindingClick(dono, true, tecla, "SoderPadNavMudo")
    end
    SetOverrideBindingClick(dono, true, "SPACE", "SoderPadTaxiConfirma")
    SetOverrideBindingClick(dono, true, "F1", "SoderPadTaxiConfirma")
    SetOverrideBindingClick(dono, true, "F3", "SoderPadTaxiFecha")
    SetOverrideBindingClick(dono, true, "F10", "SoderPadTaxiFecha")
end

local function AtualizarTaxi()
    nosVoo = ObterNosVoo()
    if #nosVoo == 0 then
        SairTaxi()
        return
    end
    if not taxiAtivo then EntrarTaxi() end
    SelecionarNoVoo(vooAtual)
end

-- Mapa Mundial ----------------------------------------------------------------
local mapaAtivo = false

local function SairMapa()
    if not mapaAtivo then return end
    mapaAtivo = false
    ClearOverrideBindings(dono)
end

local function ZoomInMapa()
    if _G.WorldMapButton and _G.WorldMapButton:GetScript("OnMouseWheel") then
        pcall(_G.WorldMapButton:GetScript("OnMouseWheel"), _G.WorldMapButton, 1)
    end
end

local function ZoomOutMapa()
    if _G.WorldMapButton and _G.WorldMapButton:GetScript("OnMouseWheel") then
        pcall(_G.WorldMapButton:GetScript("OnMouseWheel"), _G.WorldMapButton, -1)
    elseif _G.WorldMapZoomOutButton and _G.WorldMapZoomOutButton:IsEnabled() then
        pcall(WorldMapZoomOutButton_OnClick)
    end
end

local function FecharMapa()
    ToggleWorldMap()
    SairMapa()
end

local function EntrarMapa()
    mapaAtivo = true
    moldura:Hide()
    SetOverrideBindingClick(dono, true, "F6", "SoderPadMapaZoomIn")
    SetOverrideBindingClick(dono, true, "W", "SoderPadMapaZoomIn")
    SetOverrideBindingClick(dono, true, "F8", "SoderPadMapaZoomOut")
    SetOverrideBindingClick(dono, true, "S", "SoderPadMapaZoomOut")
    SetOverrideBindingClick(dono, true, "F9", "SoderPadMapaEsq")
    SetOverrideBindingClick(dono, true, "A", "SoderPadMapaEsq")
    SetOverrideBindingClick(dono, true, "F7", "SoderPadMapaDir")
    SetOverrideBindingClick(dono, true, "D", "SoderPadMapaDir")
    SetOverrideBindingClick(dono, true, "SPACE", "SoderPadMapaZoomIn")
    SetOverrideBindingClick(dono, true, "F1", "SoderPadMapaZoomIn")
    SetOverrideBindingClick(dono, true, "F3", "SoderPadMapaFecha")
    SetOverrideBindingClick(dono, true, "F10", "SoderPadMapaFecha")
    for _, tecla in ipairs(TECLAS_MUDAS) do
        SetOverrideBindingClick(dono, true, tecla, "SoderPadNavMudo")
    end
end

local function Entrar()
    ativo = true
    for _, par in ipairs(TECLAS_DIRECAO) do
        SetOverrideBindingClick(dono, true, par[1], "SoderPadNav" .. par[2])
    end
    for _, tecla in ipairs(TECLAS_MUDAS) do
        SetOverrideBindingClick(dono, true, tecla, "SoderPadNavMudo")
    end
end

local function Atualizar()
    if InCombatLockdown() then return end
    if not SoderPadLigado() then
        if ativo then Sair() end
        if taxiAtivo then SairTaxi() end
        if mapaAtivo then SairMapa() end
        return
    end

    -- 1. Janela de Voos (Taxi) tem prioridade maxima se aberta
    if _G.TaxiFrame and _G.TaxiFrame:IsVisible() then
        if ativo then Sair() end
        if mapaAtivo then SairMapa() end
        AtualizarTaxi()
        return
    elseif taxiAtivo then
        SairTaxi()
    end

    -- 2. Mapa Mundial
    if _G.WorldMapFrame and _G.WorldMapFrame:IsVisible() then
        if ativo then Sair() end
        if taxiAtivo then SairTaxi() end
        if not mapaAtivo then EntrarMapa() end
        return
    elseif mapaAtivo then
        SairMapa()
    end

    -- 3. Demais janelas (menus, mochilas, caixas de dialogo, loot)
    local lista, topo = ColetarItens()
    if not topo and #lista == 0 then
        Sair()
        return
    end
    if not ativo then Entrar() end
    local partes = { topo or "" }
    local tem = false
    for i, b in ipairs(lista) do
        partes[#partes + 1] = tostring(b)
        if b == foco then tem = true end
    end
    local nova = table.concat(partes)
    itens = lista
    if nova ~= assinatura or not tem then
        assinatura = nova
        if not tem then
            foco = nil
            Focar(PrimeiroItem())
        end
        local fechar = BotaoDeFechar(topo)
        SetOverrideBindingClick(dono, true, "F3", fechar or "SoderPadNavFecha")
    end
end

local function Botao(nome, acao)
    local b = CreateFrame("Button", nome, UIParent)
    b:RegisterForClicks("AnyDown")
    b:SetScript("OnClick", acao)
end

local relogio = CreateFrame("Frame")
relogio:RegisterEvent("PLAYER_LOGIN")
relogio:RegisterEvent("PLAYER_REGEN_DISABLED")
relogio:SetScript("OnEvent", function(_, evento)
    if evento == "PLAYER_REGEN_DISABLED" then
        -- Ultimo momento em que ainda se pode trocar as teclas antes do combate.
        Sair()
        SairTaxi()
        SairMapa()
        return
    end
    dono = CreateFrame("Frame", "SoderPadNavDono", UIParent)
    moldura = CreateFrame("Frame", "SoderPadNavMoldura", UIParent)
    moldura:SetFrameStrata("TOOLTIP")
    moldura:Hide()
    local ouro = { 1, 0.82, 0.1, 1 }
    local function Borda(a, b, largura, altura)
        local t = moldura:CreateTexture(nil, "OVERLAY")
        t:SetTexture(ouro[1], ouro[2], ouro[3], ouro[4])
        t:SetPoint(a, moldura, a)
        t:SetPoint(b, moldura, b)
        if largura then t:SetWidth(largura) end
        if altura then t:SetHeight(altura) end
    end
    Borda("TOPLEFT", "TOPRIGHT", nil, 3)
    Borda("BOTTOMLEFT", "BOTTOMRIGHT", nil, 3)
    Borda("TOPLEFT", "BOTTOMLEFT", 3, nil)
    Borda("TOPRIGHT", "BOTTOMRIGHT", 3, nil)

    -- Botoes de navegacao padrao
    Botao("SoderPadNavCima", function() Mover(0, 1) end)
    Botao("SoderPadNavBaixo", function() Mover(0, -1) end)
    Botao("SoderPadNavEsquerda", function() Mover(-1, 0) end)
    Botao("SoderPadNavDireita", function() Mover(1, 0) end)
    Botao("SoderPadNavMudo", function() end)
    Botao("SoderPadNavConfirma", function() if foco then foco:Click() end end)
    Botao("SoderPadNavFecha", function()
        local abertas = JanelasAbertas()
        for _, f in ipairs(abertas) do
            if f:GetName():find("^ContainerFrame") then CloseAllBags() else HideUIPanel(f); f:Hide() end
        end
        if ToggleAllBags and _G["DragonUI_BagsterItem1"] and _G["DragonUI_BagsterItem1"]:IsVisible() then CloseAllBags() end
        if _G.LootFrame and _G.LootFrame:IsVisible() then CloseLoot() end
    end)

    -- Botoes de Taxi / Ponto de Voo
    Botao("SoderPadTaxiCima", function() MoverVoo(0, 1) end)
    Botao("SoderPadTaxiBaixo", function() MoverVoo(0, -1) end)
    Botao("SoderPadTaxiEsquerda", function() MoverVoo(-1, 0) end)
    Botao("SoderPadTaxiDireita", function() MoverVoo(1, 0) end)
    Botao("SoderPadTaxiConfirma", function()
        if nosVoo and nosVoo[vooAtual] then
            TakeTaxiNode(nosVoo[vooAtual].indice)
        end
    end)
    Botao("SoderPadTaxiFecha", function()
        CloseTaxiMap()
        if _G.TaxiFrame then _G.TaxiFrame:Hide() end
        SairTaxi()
    end)

    -- Botoes de Mapa Mundial
    Botao("SoderPadMapaZoomIn", ZoomInMapa)
    Botao("SoderPadMapaZoomOut", ZoomOutMapa)
    Botao("SoderPadMapaFecha", FecharMapa)
    Botao("SoderPadMapaEsq", ZoomOutMapa)
    Botao("SoderPadMapaDir", ZoomInMapa)

    local passou = 0
    relogio:SetScript("OnUpdate", function(_, d)
        passou = passou + d
        if passou >= 0.15 then
            passou = 0
            Atualizar()
        end
    end)
end)
