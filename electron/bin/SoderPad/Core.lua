-- SoderPad: interface de console para o WoW 3.3.5a.
-- O leitor (SoderPad.exe) transforma o controle em teclas; aqui se decide o que cada tecla faz.
-- Protocolo das teclas, igual ao de soderpad.c:
--   X F1  Y F2  B F3  RB F4  A(com gatilho) F5  D-pad cima/dir/baixo/esq F6-F9
--   Back F10  LB F11  L3 F12  Start ESC  A SPACE  analogico esquerdo WASD
--   LT SHIFT  RT CTRL  liga ALT-CTRL-SHIFT-F11  desliga ALT-CTRL-SHIFT-F12
--   (o jogo so reconhece os modificadores nesta ordem: ALT, CTRL, SHIFT)
local ADDON = "SoderPad"
local SINAL_VALIDADE = 15     -- segundos sem sinal do leitor: considera desconectado
local ICONE, DPAD_ICONE = 44, 30
local MASCARA_REDONDA = not rawget(_G, "__SoderNextgenRunScript")

-- Sempre iguais, para todas as classes. Sem e com gatilho: LB, D-pad sem gatilho etc. nao mudam.
local FIXAS = {
    { "SPACE", "JUMP" },
    { "W", "MOVEFORWARD" }, { "S", "MOVEBACKWARD" }, { "A", "STRAFELEFT" }, { "D", "STRAFERIGHT" },
    { "SHIFT-W", "MOVEFORWARD" }, { "SHIFT-S", "MOVEBACKWARD" }, { "SHIFT-A", "STRAFELEFT" }, { "SHIFT-D", "STRAFERIGHT" },
    { "CTRL-W", "MOVEFORWARD" }, { "CTRL-S", "MOVEBACKWARD" }, { "CTRL-A", "STRAFELEFT" }, { "CTRL-D", "STRAFERIGHT" },
    { "F6", "INTERACTTARGET" },        -- D-pad cima: falar, abrir, saquear
    { "SHIFT-F6", "INTERACTTARGET" },  -- D-pad cima com LT: falar, abrir, saquear
    { "CTRL-F6", "INTERACTTARGET" },   -- D-pad cima com RT: falar, abrir, saquear
    { "F7", "TOGGLECHARACTER0" },      -- D-pad direita: personagem
    { "F8", "OPENALLBAGS" },           -- D-pad baixo: mochila
    { "F9", "TOGGLESPELLBOOK" },       -- D-pad esquerda: livro de magias
    { "F10", "TOGGLEWORLDMAP" },       -- Back: mapa
    { "F11", "TARGETNEARESTENEMY" },   -- LB: proximo inimigo
    { "SHIFT-F11", "TARGETNEARESTENEMY" }, { "CTRL-F11", "TARGETNEARESTENEMY" },
    { "F12", "TOGGLEAUTORUN" },        -- L3: correr sozinho
}

-- Do mais facil para o mais dificil de alcancar.
-- camada: 0 sem gatilho, 1 LT, 2 RT. x e y: posicao no bloco da camada.
local CASAS = {
    { tecla = "F1", camada = 0, x = -1, y = 0, rotulo = "X" },
    { tecla = "F2", camada = 0, x = 0, y = 1, rotulo = "Y" },
    { tecla = "F3", camada = 0, x = 1, y = 0, rotulo = "B" },
    { tecla = "F4", camada = 0, x = 1, y = 1, rotulo = "RB", ataque = true },
    { tecla = "SHIFT-F1", camada = 1, x = -1, y = 0, rotulo = "X" },
    { tecla = "SHIFT-F2", camada = 1, x = 0, y = 1, rotulo = "Y" },
    { tecla = "SHIFT-F3", camada = 1, x = 1, y = 0, rotulo = "B" },
    { tecla = "CTRL-F1", camada = 2, x = -1, y = 0, rotulo = "X" },
    { tecla = "CTRL-F2", camada = 2, x = 0, y = 1, rotulo = "Y" },
    { tecla = "CTRL-F3", camada = 2, x = 1, y = 0, rotulo = "B" },
    { tecla = "SHIFT-F4", camada = 1, x = 1, y = 1, rotulo = "RB" },
    { tecla = "CTRL-F4", camada = 2, x = 1, y = 1, rotulo = "RB" },
    { tecla = "SHIFT-F5", camada = 1, x = 0, y = -1, rotulo = "A" },
    { tecla = "CTRL-F5", camada = 2, x = 0, y = -1, rotulo = "A" },
    { tecla = "SHIFT-F7", camada = 1, x = 0, y = 2, rotulo = ">", dpad = true },
    { tecla = "SHIFT-F8", camada = 1, x = 1, y = 2, rotulo = "v", dpad = true },
    { tecla = "SHIFT-F9", camada = 1, x = -1, y = 1, rotulo = "<", dpad = true },
    { tecla = "CTRL-F7", camada = 2, x = 0, y = 2, rotulo = ">", dpad = true },
    { tecla = "CTRL-F8", camada = 2, x = 1, y = 2, rotulo = "v", dpad = true },
    { tecla = "CTRL-F9", camada = 2, x = -1, y = 1, rotulo = "<", dpad = true },
}

-- As barras escondem por transparencia: SetAlpha vale em combate e nao mexe nos botoes seguros.
local BARRAS = {
    "DragonUI_MainActionBar", "MainMenuBar", "MultiBarBottomLeft", "MultiBarBottomRight",
    "MultiBarLeft", "MultiBarRight", "DragonUI_StanceBar", "ShapeshiftBarFrame", "BonusActionBarFrame",
    "DragonUI_ExtraBar1Container", "DragonUI_ExtraBar2Container", "DragonUI_ExtraBar3Container",
}

local ligado, desejado, manual = false, false, false
local ultimoSinal, sinaisRecebidos = 0, 0
local alfaOriginal = {}
local raiz, dono, sinais
local blocos = {}

local function Escrever(texto)
    DEFAULT_CHAT_FRAME:AddMessage("|cff66ccffSoderPad:|r " .. texto)
end

-- Magias -----------------------------------------------------------------------
local function MagiasConhecidas()
    local nomes = {}
    for aba = 1, GetNumSpellTabs() do
        local _, _, inicio, total = GetSpellTabInfo(aba)
        for i = inicio + 1, inicio + total do
            local nome = GetSpellName(i, BOOKTYPE_SPELL)
            if nome then nomes[nome] = true end
        end
    end
    return nomes
end

local function EscolherMagias()
    local _, classe = UnitClass("player")
    local lista = SoderPadClasses[classe] or {}
    local conhecidas, usados, saida = MagiasConhecidas(), {}, {}
    for _, id in ipairs(lista) do
        local nome = GetSpellInfo(id)
        if nome and conhecidas[nome] and not usados[nome] then
            usados[nome] = true
            saida[#saida + 1] = nome
        end
    end
    return saida
end

-- Sem alvo inimigo vivo, o botao pega o mais proximo e so entao age.
local PEGA_ALVO = "/targetenemy [noharm][dead]\n"
local CORPO_A_CORPO = { WARRIOR = true, ROGUE = true, PALADIN = true, DEATHKNIGHT = true, SHAMAN = true, DRUID = true }
local ICONE_ATAQUE = "Interface\\Icons\\INV_Sword_04"

local function MacroDeAtaque(classe)
    if classe == "HUNTER" then
        return PEGA_ALVO .. "/cast " .. (GetSpellInfo(75) or "Auto Shot")
    end
    return PEGA_ALVO .. "/startattack"
end

local function MacroDaMagia(nome, classe)
    if IsHarmfulSpell(nome) then
        return PEGA_ALVO .. (CORPO_A_CORPO[classe] and "/startattack\n" or "") .. "/cast " .. nome
    else
        return "/cast " .. nome
    end
end

local function AtualizarCasas()
    local _, classe = UnitClass("player")
    local magias = EscolherMagias()
    local proxima = 1
    for _, casa in ipairs(CASAS) do
        local b = casa.botao
        local nome, icone, macro
        if casa.ataque then
            macro, icone = MacroDeAtaque(classe), ICONE_ATAQUE
        else
            nome = magias[proxima]
            proxima = proxima + 1
            if nome then
                macro = MacroDaMagia(nome, classe)
                icone = select(3, GetSpellInfo(nome))
            end
        end
        b.magia = nome
        b:SetAttribute("type", macro and "macro" or (nome and "spell" or nil))
        b:SetAttribute("macrotext", macro)
        b:SetAttribute("spell", nome)
        if icone then
            SetPortraitToTexture(b.icone, icone)
            b.icone:Show()
            b.anel:Show()
            b.rotulo:Show()
        else
            -- Casa sem poder nao aparece: so polui a tela.
            b.icone:Hide()
            b.anel:Hide()
            b.rotulo:Hide()
        end
    end
end

-- Interface --------------------------------------------------------------------
local function CriarCasa(casa, indice)
    local tam = casa.dpad and DPAD_ICONE or ICONE
    local b = CreateFrame("Button", "SoderPadCasa" .. indice, blocos[casa.camada], "SecureActionButtonTemplate")
    b:SetWidth(tam)
    b:SetHeight(tam)
    local passo = ICONE + 6
    b:SetPoint("CENTER", blocos[casa.camada], "CENTER", casa.x * passo, (casa.y - 0.5) * passo)
    b:RegisterForClicks("AnyUp")
    b:EnableMouse(false)
    b.icone = b:CreateTexture(nil, "ARTWORK")
    -- O 32 bits recorta o icone em circulo; o 64 bits desenha quadrado, entao ali ele
    -- precisa caber inteiro dentro do anel.
    local recuo = MASCARA_REDONDA and 3 or tam * 0.15
    b.icone:SetPoint("TOPLEFT", b, "TOPLEFT", recuo, -recuo)
    b.icone:SetPoint("BOTTOMRIGHT", b, "BOTTOMRIGHT", -recuo, recuo)
    b.anel = b:CreateTexture(nil, "OVERLAY")
    b.anel:SetTexture("Interface\\Minimap\\MiniMap-TrackingBorder")
    b.anel:SetWidth(tam * 1.9)
    b.anel:SetHeight(tam * 1.9)
    b.anel:SetPoint("TOPLEFT", b, "TOPLEFT", -tam * 0.09, tam * 0.09)
    b.tempo = CreateFrame("Cooldown", "SoderPadCasa" .. indice .. "Tempo", b, "CooldownFrameTemplate")
    -- A animacao de recarga e quadrada: fica dentro do circulo em qualquer cliente.
    local recuoTempo = tam * 0.15
    b.tempo:SetPoint("TOPLEFT", b, "TOPLEFT", recuoTempo, -recuoTempo)
    b.tempo:SetPoint("BOTTOMRIGHT", b, "BOTTOMRIGHT", -recuoTempo, recuoTempo)
    b.rotulo = b:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
    b.rotulo:SetPoint("BOTTOM", b, "BOTTOM", 0, -4)
    b.rotulo:SetText(casa.rotulo)

    -- Indicativo visual de tecla/habilidade clicada (brilho que dura ~0.6s e se desfaz suavemente)
    b.brilho = b:CreateTexture(nil, "OVERLAY")
    b.brilho:SetTexture("Interface\\Minimap\\UI-Minimap-ZoomButton-Highlight")
    b.brilho:SetBlendMode("ADD")
    b.brilho:SetVertexColor(1, 0.9, 0.25, 1)
    b.brilho:SetPoint("CENTER", b, "CENTER", 0, 0)
    b.brilho:SetWidth(tam * 1.55)
    b.brilho:SetHeight(tam * 1.55)
    b.brilho:Hide()

    local function Acender()
        b.brilho:Show()
        b.brilho:SetAlpha(1.0)
        b.brilhoFim = GetTime() + 0.6
    end
    b:HookScript("OnClick", Acender)
    b:HookScript("OnMouseDown", Acender)

    casa.botao = b
end

local function CriarBloco(camada, deslocamento, titulo)
    local f = CreateFrame("Frame", "SoderPadBloco" .. camada, raiz)
    f:SetWidth(170)
    f:SetHeight(170)
    f:SetPoint("BOTTOM", raiz, "BOTTOM", deslocamento, 0)
    f.titulo = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
    f.titulo:SetPoint("CENTER", f, "CENTER", 0, -25)
    f.titulo:SetText(titulo)
    blocos[camada] = f
end

local function CriarInterface()
    raiz = CreateFrame("Frame", "SoderPadRaiz", UIParent)
    raiz:SetWidth(600)
    raiz:SetHeight(170)
    raiz:SetPoint("BOTTOM", UIParent, "BOTTOM", 0, 90)
    raiz:SetAlpha(0)
    CriarBloco(1, -200, "LT")
    CriarBloco(0, 0, "")
    CriarBloco(2, 200, "RT")
    for i, casa in ipairs(CASAS) do CriarCasa(casa, i) end
end

-- A explicacao dos botoes fixos fica nas opcoes, nao na tela.
local AJUDA = {
    "Liga sozinho quando um controle conecta.",
    " ",
    "|cffffd100Sempre iguais|r",
    "Analogico esquerdo: andar          Analogico direito: camera",
    "A: pular          LB: proximo inimigo",
    "Start: menu (Esc)          Back: mapa",
    "L3: correr sozinho",
    "R3: liga o cursor; com ele, A e B sao os cliques do mouse",
    "D-pad cima: coleta o que estiver perto (corpo, bau, minerio, erva) ou fala com o alvo",
    "D-pad direita: personagem",
    "D-pad baixo: mochila",
    "D-pad esquerda: livro de magias",
    " ",
    "|cffffd100Poderes|r",
    "RB: ataque automatico, e pega o inimigo mais proximo se estiver sem alvo",
    "X, Y e B: os mais usados da sua classe",
    "Segure LT ou RT para os proximos, tambem com A e com o D-pad",
    " ",
    "|cffffd100Menus e mochilas abertos|r",
    "D-pad ou analogico esquerdo: andar pelas opcoes (contorno dourado)",
    "A: confirmar ou usar item     X: pegar item     B: fechar",
}

local function CriarOpcoes()
    local painel = CreateFrame("Frame", "SoderPadOpcoes", UIParent)
    painel.name = "Controle"
    painel:Hide()
    local titulo = painel:CreateFontString(nil, "ARTWORK", "GameFontNormalLarge")
    titulo:SetPoint("TOPLEFT", 16, -16)
    titulo:SetText("Controle")
    local acima = titulo
    for _, linha in ipairs(AJUDA) do
        local t = painel:CreateFontString(nil, "ARTWORK", "GameFontHighlight")
        t:SetPoint("TOPLEFT", acima, "BOTTOMLEFT", 0, -6)
        t:SetText(linha)
        acima = t
    end
    InterfaceOptions_AddCategory(painel)
end

local function AtualizarBotoes()
    for _, casa in ipairs(CASAS) do
        local b = casa.botao
        if b.magia then
            local inicio, duracao = GetSpellCooldown(b.magia)
            if inicio and duracao and duracao > 1.5 then
                b.tempo:SetCooldown(inicio, duracao)
            end
            local usavel, semMana = IsUsableSpell(b.magia)
            if semMana then
                b.icone:SetVertexColor(0.4, 0.4, 1)
            elseif usavel then
                b.icone:SetVertexColor(1, 1, 1)
            else
                b.icone:SetVertexColor(0.4, 0.4, 0.4)
            end
        end
    end
    local camada = IsShiftKeyDown() and 1 or (IsControlKeyDown() and 2 or 0)
    for c, f in pairs(blocos) do
        f:SetAlpha(c == camada and 1 or 0.55)
    end
end

local function EsconderBarras(esconder)
    for _, nome in ipairs(BARRAS) do
        local f = _G[nome]
        if f then
            if esconder then
                if alfaOriginal[nome] == nil then alfaOriginal[nome] = f:GetAlpha() end
                f:SetAlpha(0)
            elseif alfaOriginal[nome] ~= nil then
                f:SetAlpha(alfaOriginal[nome])
                alfaOriginal[nome] = nil
            end
        end
    end
end

-- Liga e desliga ---------------------------------------------------------------
function SoderPadLigado() return ligado end

-- Saque automatico so no modo controle: a escolha do jogador volta ao desligar.
local autoLootAntes, autoInteractAntes
local function SaqueAutomatico(ligar)
    if ligar then
        autoLootAntes = autoLootAntes or GetCVar("autoLootDefault")
        SetCVar("autoLootDefault", "1")
        -- A coleta do leitor usa o clique-para-mover do jogo.
        autoInteractAntes = autoInteractAntes or GetCVar("autoInteract")
        SetCVar("autoInteract", "1")
    elseif autoLootAntes then
        SetCVar("autoLootDefault", autoLootAntes)
        autoLootAntes = nil
        if autoInteractAntes then SetCVar("autoInteract", autoInteractAntes) end
        autoInteractAntes = nil
    end
end

local function AplicarTeclas()
    ClearOverrideBindings(dono)
    if not desejado then return end
    local _, classe = UnitClass("player")
    for _, par in ipairs(FIXAS) do
        SetOverrideBinding(dono, true, par[1], par[2])
    end
    for i, casa in ipairs(CASAS) do
        if casa.ataque and classe ~= "HUNTER" then
            -- Para classes corpo-a-corpo e conjuradores, ATTACKTARGET alterna entre atacar e parar de atacar (toggle)
            SetOverrideBinding(dono, true, casa.tecla, "ATTACKTARGET")
        else
            SetOverrideBindingClick(dono, true, casa.tecla, "SoderPadCasa" .. i, "LeftButton")
        end
    end
end

-- Em combate o jogo proibe trocar teclas; fica para quando o combate acabar.
local function Sincronizar()
    if InCombatLockdown() or not raiz then return end
    if ligado ~= desejado then
        ligado = desejado
        AplicarTeclas()
        if ligado then AtualizarCasas() end
        raiz:SetAlpha(ligado and 1 or 0)
        EsconderBarras(ligado)
        SaqueAutomatico(ligado)
        Escrever(ligado and "controle ligado" or "de volta ao teclado e mouse")
    end
end

local function Pedir(valor)
    desejado = valor
    Sincronizar()
end

-- Eventos ----------------------------------------------------------------------
local eventos = CreateFrame("Frame")
eventos:RegisterEvent("PLAYER_LOGIN")
eventos:RegisterEvent("PLAYER_REGEN_ENABLED")
eventos:RegisterEvent("SPELLS_CHANGED")
eventos:RegisterEvent("LEARNED_SPELL_IN_TAB")
eventos:RegisterEvent("PLAYER_ENTER_COMBAT")
eventos:RegisterEvent("START_AUTOREPEAT_SPELL")

local acumulado = 0
eventos:SetScript("OnUpdate", function(_, passou)
    -- Desfaz o brilho do indicativo de clique suavemente (0.6s)
    local agora = GetTime()
    for _, casa in ipairs(CASAS) do
        local b = casa.botao
        if b and b.brilhoFim then
            local sobra = b.brilhoFim - agora
            if sobra <= 0 then
                b.brilho:Hide()
                b.brilhoFim = nil
            else
                b.brilho:SetAlpha(math.min(1, sobra / 0.4))
            end
        end
    end

    acumulado = acumulado + passou
    if acumulado < 0.2 then return end
    acumulado = 0
    if not raiz then return end
    if desejado and not manual and GetTime() - ultimoSinal > SINAL_VALIDADE then
        Pedir(false)
    end
    if ligado then
        AtualizarBotoes()
        EsconderBarras(true)   -- a DragonUI pode reexibir as barras
    end
end)

eventos:SetScript("OnEvent", function(_, evento)
    if evento == "PLAYER_ENTER_COMBAT" or evento == "START_AUTOREPEAT_SPELL" then
        for _, c in ipairs(CASAS) do
            if c.ataque and c.botao and c.botao.brilho then
                c.botao.brilho:Show()
                c.botao.brilho:SetAlpha(1.0)
                c.botao.brilhoFim = GetTime() + 0.6
            end
        end
        return
    end
    if evento == "PLAYER_LOGIN" then
        dono = CreateFrame("Frame", "SoderPadDono", UIParent)
        CriarInterface()
        CriarOpcoes()
        sinais = CreateFrame("Frame", "SoderPadSinais", UIParent)
        local on = CreateFrame("Button", "SoderPadSinalOn", UIParent)
        on:SetScript("OnClick", function()
            ultimoSinal = GetTime()
            sinaisRecebidos = sinaisRecebidos + 1
            manual = false
            if not desejado then Pedir(true) end
        end)
        local off = CreateFrame("Button", "SoderPadSinalOff", UIParent)
        off:SetScript("OnClick", function()
            manual = false
            Pedir(false)
        end)
        SetOverrideBindingClick(sinais, false, "ALT-CTRL-SHIFT-F11", "SoderPadSinalOn")
        SetOverrideBindingClick(sinais, false, "ALT-CTRL-SHIFT-F12", "SoderPadSinalOff")
    elseif evento == "PLAYER_REGEN_ENABLED" then
        Sincronizar()
        if ligado then AtualizarCasas() end
    elseif ligado and not InCombatLockdown() then
        AtualizarCasas()
    end
end)

SLASH_SODERPAD1 = "/soderpad"
SlashCmdList["SODERPAD"] = function(arg)
    if arg == "on" then
        manual = true
        Pedir(true)
    elseif arg == "off" then
        manual = false
        Pedir(false)
    else
        Escrever("estado: " .. (ligado and "ligado" or "desligado") .. ", sinais do leitor: " .. sinaisRecebidos .. ". Use /soderpad on ou off para testar sem controle.")
    end
end
