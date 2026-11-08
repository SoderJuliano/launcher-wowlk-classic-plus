CHARACTER_SELECT_ROTATION_START_X = nil;
CHARACTER_SELECT_INITIAL_FACING = nil;

CHARACTER_ROTATION_CONSTANT = 0.6;

MAX_CHARACTERS_DISPLAYED = 10;
MAX_CHARACTERS_PER_REALM = 50;
CHARACTER_LIST_OFFSET = 0;
CHARACTER_LIST_PAGE = 1;

function CharacterSelect_NextPage()
	local numChars = GetNumCharacters();
	local maxPages = math.max(1, math.ceil(math.min(numChars + 1, MAX_CHARACTERS_PER_REALM) / MAX_CHARACTERS_DISPLAYED));
	if ( CHARACTER_LIST_PAGE < maxPages ) then
		PlaySound("igMainMenuOptionCheckBoxOn");
		CHARACTER_LIST_PAGE = CHARACTER_LIST_PAGE + 1;
		CHARACTER_LIST_OFFSET = (CHARACTER_LIST_PAGE - 1) * MAX_CHARACTERS_DISPLAYED;
		local firstOnPage = CHARACTER_LIST_OFFSET + 1;
		if ( firstOnPage <= numChars ) then
			CharacterSelect.selectedIndex = firstOnPage;
		else
			CharacterSelect.selectedIndex = 0;
		end
		UpdateCharacterList();
	end
end

function CharacterSelect_PrevPage()
	if ( CHARACTER_LIST_PAGE > 1 ) then
		local numChars = GetNumCharacters();
		PlaySound("igMainMenuOptionCheckBoxOn");
		CHARACTER_LIST_PAGE = CHARACTER_LIST_PAGE - 1;
		CHARACTER_LIST_OFFSET = (CHARACTER_LIST_PAGE - 1) * MAX_CHARACTERS_DISPLAYED;
		local firstOnPage = CHARACTER_LIST_OFFSET + 1;
		if ( firstOnPage <= numChars ) then
			CharacterSelect.selectedIndex = firstOnPage;
		else
			CharacterSelect.selectedIndex = 0;
		end
		UpdateCharacterList();
	end
end


function CharacterSelect_OnLoad(self)
	self:SetSequence(0);
	self:SetCamera(0);

	self.createIndex = 0;
	self.selectedIndex = 0;
	self.selectLast = 0;
	self.currentModel = nil;
	self:RegisterEvent("ADDON_LIST_UPDATE");
	self:RegisterEvent("CHARACTER_LIST_UPDATE");
	self:RegisterEvent("UPDATE_SELECTED_CHARACTER");
	self:RegisterEvent("SELECT_LAST_CHARACTER");
	self:RegisterEvent("SELECT_FIRST_CHARACTER");
	self:RegisterEvent("SUGGEST_REALM");
	self:RegisterEvent("FORCE_RENAME_CHARACTER");

	self:EnableMouseWheel(true);
	self:SetScript("OnMouseWheel", function(frame, delta)
		if ( delta < 0 ) then
			CharacterSelect_NextPage();
		else
			CharacterSelect_PrevPage();
		end
	end);

	-- CharacterSelect:SetModel("Interface\\Glues\\Models\\UI_Orc\\UI_Orc.m2");

	-- local fogInfo = CharModelFogInfo["ORC"];
	-- CharacterSelect:SetFogColor(fogInfo.r, fogInfo.g, fogInfo.b);
	-- CharacterSelect:SetFogNear(0);
	-- CharacterSelect:SetFogFar(fogInfo.far);

	SetCharSelectModelFrame("CharacterSelect");

	-- Color edit box backdrops
	local backdropColor = DEFAULT_TOOLTIP_COLOR;
	CharacterSelectCharacterFrame:SetBackdropBorderColor(backdropColor[1], backdropColor[2], backdropColor[3]);
	CharacterSelectCharacterFrame:SetBackdropColor(backdropColor[4], backdropColor[5], backdropColor[6], 0.85);
	
end

function CharacterSelect_OnShow()
	-- request account data times from the server (so we know if we should refresh keybindings, etc...)
	ReadyForAccountDataTimes()
	
	local CurrentModel = CharacterSelect.currentModel;

	if ( CurrentModel ) then
		PlayGlueAmbience(GlueAmbienceTracks[strupper(CurrentModel)], 4.0);
	end

	UpdateAddonButton();

	local serverName, isPVP, isRP = GetServerName();
	local connected = IsConnectedToServer();
	local serverType = "";
	if ( serverName ) then
		if( not connected ) then
			serverName = serverName.."\n("..SERVER_DOWN..")";
		end
		if ( isPVP ) then
			if ( isRP ) then
				serverType = RPPVP_PARENTHESES;
			else
				serverType = PVP_PARENTHESES;
			end
		elseif ( isRP ) then
			serverType = RP_PARENTHESES;
		end
		CharSelectRealmName:SetText(serverName.." "..serverType);
		CharSelectRealmName:Show();
	else
		CharSelectRealmName:Hide();
	end

	if ( connected ) then
		GetCharacterListUpdate();
	else
		UpdateCharacterList();
	end

	-- Gameroom billing stuff (For Korea and China only)
	if ( SHOW_GAMEROOM_BILLING_FRAME ) then
		local paymentPlan, hasFallBackBillingMethod, isGameRoom = GetBillingPlan();
		if ( paymentPlan == 0 ) then
			-- No payment plan
			GameRoomBillingFrame:Hide();
			CharacterSelectRealmSplitButton:ClearAllPoints();
			CharacterSelectRealmSplitButton:SetPoint("TOP", CharacterSelectLogo, "BOTTOM", 0, -5);
		else
			local billingTimeLeft = GetBillingTimeRemaining();
			-- Set default text for the payment plan
			local billingText = _G["BILLING_TEXT"..paymentPlan];
			if ( paymentPlan == 1 ) then
				-- Recurring account
				billingTimeLeft = ceil(billingTimeLeft/(60 * 24));
				if ( billingTimeLeft == 1 ) then
					billingText = BILLING_TIME_LEFT_LAST_DAY;
				end
			elseif ( paymentPlan == 2 ) then
				-- Free account
				if ( billingTimeLeft < (24 * 60) ) then
					billingText = format(BILLING_FREE_TIME_EXPIRE, billingTimeLeft.." "..MINUTES_ABBR);
				end				
			elseif ( paymentPlan == 3 ) then
				-- Fixed but not recurring
				if ( isGameRoom == 1 ) then
					if ( billingTimeLeft <= 30 ) then
						billingText = BILLING_GAMEROOM_EXPIRE;
					else
						billingText = format(BILLING_FIXED_IGR, MinutesToTime(billingTimeLeft, 1));
					end
				else
					-- personal fixed plan
					if ( billingTimeLeft < (24 * 60) ) then
						billingText = BILLING_FIXED_LASTDAY;
					else
						billingText = format(billingText, MinutesToTime(billingTimeLeft));
					end	
				end
			elseif ( paymentPlan == 4 ) then
				-- Usage plan
				if ( isGameRoom == 1 ) then
					-- game room usage plan
					if ( billingTimeLeft <= 600 ) then
						billingText = BILLING_GAMEROOM_EXPIRE;
					else
						billingText = BILLING_IGR_USAGE;
					end
				else
					-- personal usage plan
					if ( billingTimeLeft <= 30 ) then
						billingText = BILLING_TIME_LEFT_30_MINS;
					else
						billingText = format(billingText, billingTimeLeft);
					end
				end
			end
			-- If fallback payment method add a note that says so
			if ( hasFallBackBillingMethod == 1 ) then
				billingText = billingText.."\n\n"..BILLING_HAS_FALLBACK_PAYMENT;
			end
			GameRoomBillingFrameText:SetText(billingText);
			GameRoomBillingFrame:SetHeight(GameRoomBillingFrameText:GetHeight() + 26);
			GameRoomBillingFrame:Show();
			CharacterSelectRealmSplitButton:ClearAllPoints();
			CharacterSelectRealmSplitButton:SetPoint("TOP", GameRoomBillingFrame, "BOTTOM", 0, -10);
		end
	end
	
	if( IsTrialAccount() ) then
		CharacterSelectUpgradeAccountButton:Show();
	else
		CharacterSelectUpgradeAccountButton:Hide();
	end

	-- fadein the character select ui
	GlueFrameFadeIn(CharacterSelectUI, CHARACTER_SELECT_FADE_IN)

	RealmSplitCurrentChoice:Hide();
	RequestRealmSplitInfo();

	--Clear out the addons selected item
	GlueDropDownMenu_SetSelectedValue(AddonCharacterDropDown, ALL);
end

function CharacterSelect_OnHide()
	CharacterDeleteDialog:Hide();
	CharacterRenameDialog:Hide();
	if ( DeclensionFrame ) then
		DeclensionFrame:Hide();
	end
	SERVER_SPLIT_STATE_PENDING = -1;
end

function CharacterSelect_OnUpdate(elapsed)
	if ( SERVER_SPLIT_STATE_PENDING > 0 ) then
		CharacterSelectRealmSplitButton:Show();

		if ( SERVER_SPLIT_CLIENT_STATE > 0 ) then
			RealmSplit_SetChoiceText();
			RealmSplitPending:SetPoint("TOP", RealmSplitCurrentChoice, "BOTTOM", 0, -10);
		else
			RealmSplitPending:SetPoint("TOP", CharacterSelectRealmSplitButton, "BOTTOM", 0, 0);
			RealmSplitCurrentChoice:Hide();
		end

		if ( SERVER_SPLIT_STATE_PENDING > 1 ) then
			CharacterSelectRealmSplitButton:Disable();
			CharacterSelectRealmSplitButtonGlow:Hide();
			RealmSplitPending:SetText( SERVER_SPLIT_PENDING );
		else
			CharacterSelectRealmSplitButton:Enable();
			CharacterSelectRealmSplitButtonGlow:Show();
			local datetext = SERVER_SPLIT_CHOOSE_BY.."\n"..SERVER_SPLIT_DATE;
			RealmSplitPending:SetText( datetext );
		end

		if ( SERVER_SPLIT_SHOW_DIALOG and not GlueDialog:IsShown() ) then
			SERVER_SPLIT_SHOW_DIALOG = false;
			local dialogString = format(SERVER_SPLIT,SERVER_SPLIT_DATE);
			if ( SERVER_SPLIT_CLIENT_STATE > 0 ) then
				local serverChoice = RealmSplit_GetFormatedChoice(SERVER_SPLIT_REALM_CHOICE);
				local stringWithDate = format(SERVER_SPLIT,SERVER_SPLIT_DATE);
				dialogString = stringWithDate.."\n\n"..serverChoice;
				GlueDialog_Show("SERVER_SPLIT_WITH_CHOICE", dialogString);
			else
				GlueDialog_Show("SERVER_SPLIT", dialogString);
			end
		end
	else
		CharacterSelectRealmSplitButton:Hide();
	end

	-- Account Msg stuff
	if ( (ACCOUNT_MSG_NUM_AVAILABLE > 0) and not GlueDialog:IsShown() ) then
		if ( ACCOUNT_MSG_HEADERS_LOADED ) then
			if ( ACCOUNT_MSG_BODY_LOADED ) then
				local dialogString = AccountMsg_GetHeaderSubject( ACCOUNT_MSG_CURRENT_INDEX ).."\n\n"..AccountMsg_GetBody();
				GlueDialog_Show("ACCOUNT_MSG", dialogString);
			end
		end
	end
end

function CharacterSelect_OnKeyDown(self,key)
	if ( key == "ESCAPE" ) then
		CharacterSelect_Exit();
	elseif ( key == "ENTER" ) then
		CharacterSelect_EnterWorld();
	elseif ( key == "PRINTSCREEN" ) then
		Screenshot();
	elseif ( key == "UP" or key == "LEFT" ) then
		local numChars = GetNumCharacters();
		if ( numChars > 1 ) then
			if ( self.selectedIndex > 1 ) then
				CharacterSelect_SelectCharacter(self.selectedIndex - 1);
			else
				CharacterSelect_SelectCharacter(numChars);
			end
		end
	elseif ( key == "DOWN" or key == "RIGHT" or arg1 == "DOWN" or arg1 == "RIGHT" ) then
		local numChars = GetNumCharacters();
		if ( numChars > 1 ) then
			if ( self.selectedIndex < GetNumCharacters() ) then
				CharacterSelect_SelectCharacter(self.selectedIndex + 1);
			else
				CharacterSelect_SelectCharacter(1);
			end
		end
	end
end

function CharacterSelect_OnEvent(self, event, ...)
	if ( event == "ADDON_LIST_UPDATE" ) then
		UpdateAddonButton();
	elseif ( event == "CHARACTER_LIST_UPDATE" ) then
		UpdateCharacterList();
		CharSelectCharacterName:SetText(GetCharacterInfo(self.selectedIndex));
	elseif ( event == "UPDATE_SELECTED_CHARACTER" ) then
		local index = ...;
		if ( index == 0 ) then
			CharSelectCharacterName:SetText("");
		else
			CharSelectCharacterName:SetText(GetCharacterInfo(index));
			self.selectedIndex = index;
		end
		UpdateCharacterSelection(self);
	elseif ( event == "SELECT_LAST_CHARACTER" ) then
		self.selectLast = 1;
	elseif ( event == "SELECT_FIRST_CHARACTER" ) then
		CharacterSelect_SelectCharacter(1, 1);
	elseif ( event == "SUGGEST_REALM" ) then
		local category, id = ...;
		local name = GetRealmInfo(category, id);
		if ( name ) then
			RealmWizard.suggestedRealmName = name;
			RealmWizard.suggestedCategory = category;
			RealmWizard.suggestedID = id;
			GlueDialog_Show("SUGGEST_REALM");
		else
			if ( RealmList:IsShown() ) then
				RealmListUpdate();
			else
				RealmList:Show();
			end
		end
	elseif ( event == "FORCE_RENAME_CHARACTER" ) then
		local message = ...;
		CharacterRenameDialog:Show();
		CharacterRenameText1:SetText(_G[message]);
	end
end

function CharacterSelect_UpdateModel(self)
	UpdateSelectionCustomizationScene();
	self:AdvanceTime();
end

function UpdateCharacterSelection(self)
	for i=1, MAX_CHARACTERS_DISPLAYED, 1 do
		_G["CharSelectCharacterButton"..i]:UnlockHighlight();
	end

	local buttonIndex = self.selectedIndex - (CHARACTER_LIST_OFFSET or 0);
	if ( (buttonIndex > 0) and (buttonIndex <= MAX_CHARACTERS_DISPLAYED) ) then
		_G["CharSelectCharacterButton"..buttonIndex]:LockHighlight();
	end
end

function UpdateCharacterList()
	local numChars = GetNumCharacters();
	local maxPages = math.max(1, math.ceil(math.min(numChars + 1, MAX_CHARACTERS_PER_REALM) / MAX_CHARACTERS_DISPLAYED));

	if ( not CHARACTER_LIST_PAGE or CHARACTER_LIST_PAGE > maxPages ) then
		CHARACTER_LIST_PAGE = maxPages;
	end
	if ( CHARACTER_LIST_PAGE < 1 ) then
		CHARACTER_LIST_PAGE = 1;
	end
	CHARACTER_LIST_OFFSET = (CHARACTER_LIST_PAGE - 1) * MAX_CHARACTERS_DISPLAYED;

	-- Update Page Navigation UI
	local prevBtn = _G["CharSelectPrevPageButton"];
	local nextBtn = _G["CharSelectNextPageButton"];
	local realmText = _G["CharSelectRealmName"];

	local serverName = GetServerName();
	if ( not serverName ) then serverName = ""; end

	if ( maxPages > 1 ) then
		if ( prevBtn ) then
			prevBtn:Show();
			if ( CHARACTER_LIST_PAGE > 1 ) then
				prevBtn:Enable();
			else
				prevBtn:Disable();
			end
		end
		if ( nextBtn ) then
			nextBtn:Show();
			if ( CHARACTER_LIST_PAGE < maxPages ) then
				nextBtn:Enable();
			else
				nextBtn:Disable();
			end
		end
		if ( realmText ) then
			realmText:SetText(serverName .. " (" .. CHARACTER_LIST_PAGE .. "/" .. maxPages .. ")");
		end
	else
		if ( prevBtn ) then prevBtn:Hide(); end
		if ( nextBtn ) then nextBtn:Hide(); end
		if ( realmText ) then realmText:SetText(serverName); end
	end

	-- Render 10 visible buttons
	for buttonIdx=1, MAX_CHARACTERS_DISPLAYED do
		local charIdx = buttonIdx + CHARACTER_LIST_OFFSET;
		local button = _G["CharSelectCharacterButton"..buttonIdx];
		if ( charIdx <= numChars ) then
			local name, race, class, level, zone, sex, ghost, PCC, PRC, PFC = GetCharacterInfo(charIdx);
			button:SetID(charIdx);
			if ( not name ) then
				button:SetText("ERROR - Tell Jeremy");
			else
				if ( not zone ) then zone = ""; end
				_G["CharSelectCharacterButton"..buttonIdx.."ButtonTextName"]:SetText(name);
				if ( ghost ) then
					_G["CharSelectCharacterButton"..buttonIdx.."ButtonTextInfo"]:SetFormattedText(CHARACTER_SELECT_INFO_GHOST, level, class);
				else
					_G["CharSelectCharacterButton"..buttonIdx.."ButtonTextInfo"]:SetFormattedText(CHARACTER_SELECT_INFO, level, class);
				end
				_G["CharSelectCharacterButton"..buttonIdx.."ButtonTextLocation"]:SetText(zone);
			end
			button:Show();

			-- Paid service buttons
			_G["CharSelectCharacterCustomize"..buttonIdx]:Hide();
			_G["CharSelectRaceChange"..buttonIdx]:Hide();
			_G["CharSelectFactionChange"..buttonIdx]:Hide();
			if ( PFC ) then
				_G["CharSelectFactionChange"..buttonIdx]:SetID(charIdx);
				_G["CharSelectFactionChange"..buttonIdx]:Show();
			elseif ( PRC ) then
				_G["CharSelectRaceChange"..buttonIdx]:SetID(charIdx);
				_G["CharSelectRaceChange"..buttonIdx]:Show();
			elseif ( PCC ) then
				_G["CharSelectCharacterCustomize"..buttonIdx]:SetID(charIdx);
				_G["CharSelectCharacterCustomize"..buttonIdx]:Show();
			end
		else
			button:Hide();
			_G["CharSelectCharacterCustomize"..buttonIdx]:Hide();
			_G["CharSelectRaceChange"..buttonIdx]:Hide();
			_G["CharSelectFactionChange"..buttonIdx]:Hide();
		end
	end

	-- Create Character Button
	CharacterSelect.createIndex = numChars + 1;
	local connected = IsConnectedToServer();
	local createPage = math.floor(numChars / MAX_CHARACTERS_DISPLAYED) + 1;

	if ( connected and (numChars < MAX_CHARACTERS_PER_REALM) and (CHARACTER_LIST_PAGE == createPage) ) then
		CharSelectCreateCharacterButton:SetID(CharacterSelect.createIndex);
		CharSelectCreateCharacterButton:Show();
	else
		CharSelectCreateCharacterButton:Hide();
	end

	-- Selection handling
	if ( numChars == 0 ) then
		CharacterSelect.selectedIndex = 0;
		CharacterSelectDeleteButton:Disable();
		CharSelectEnterWorldButton:Disable();
		UpdateCharacterSelection(CharacterSelect);
		return;
	end

	if ( CharacterSelect.selectLast == 1 ) then
		CharacterSelect.selectLast = 0;
		CharacterSelect.selectedIndex = numChars;
		CHARACTER_LIST_PAGE = math.floor((numChars - 1) / MAX_CHARACTERS_DISPLAYED) + 1;
		CHARACTER_LIST_OFFSET = (CHARACTER_LIST_PAGE - 1) * MAX_CHARACTERS_DISPLAYED;
		CharacterSelect_SelectCharacter(numChars, 1);
		return;
	end

	local selectedPage = (CharacterSelect.selectedIndex > 0) and (math.floor((CharacterSelect.selectedIndex - 1) / MAX_CHARACTERS_DISPLAYED) + 1) or 0;
	local charsOnThisPage = math.min(math.max(0, numChars - CHARACTER_LIST_OFFSET), MAX_CHARACTERS_DISPLAYED);

	if ( selectedPage ~= CHARACTER_LIST_PAGE ) then
		if ( charsOnThisPage > 0 ) then
			CharacterSelect.selectedIndex = CHARACTER_LIST_OFFSET + 1;
			CharacterSelect_SelectCharacter(CharacterSelect.selectedIndex, 1);
			CharacterSelectDeleteButton:Enable();
			CharSelectEnterWorldButton:Enable();
		else
			CharacterSelect.selectedIndex = 0;
			CharacterSelectDeleteButton:Disable();
			CharSelectEnterWorldButton:Disable();
			UpdateCharacterSelection(CharacterSelect);
		end
	else
		CharacterSelectDeleteButton:Enable();
		CharSelectEnterWorldButton:Enable();
		CharacterSelect_SelectCharacter(CharacterSelect.selectedIndex, 1);
	end
end

function CharacterSelectButton_OnClick(self)
	local id = self:GetID();
	if ( id ~= CharacterSelect.selectedIndex ) then
		CharacterSelect_SelectCharacter(id);
	end
end

function CharacterSelectButton_OnDoubleClick(self)
	local id = self:GetID();
	if ( id ~= CharacterSelect.selectedIndex ) then
		CharacterSelect_SelectCharacter(id);
	end
	CharacterSelect_EnterWorld();
end

function CharacterSelect_TabResize(self)
	local buttonMiddle = _G[self:GetName().."Middle"];
	local buttonMiddleDisabled = _G[self:GetName().."MiddleDisabled"];
	local width = self:GetTextWidth() - 8;
	local leftWidth = _G[self:GetName().."Left"]:GetWidth();
	buttonMiddle:SetWidth(width);
	buttonMiddleDisabled:SetWidth(width);
	self:SetWidth(width + (2 * leftWidth));
end

function CharacterSelect_SelectCharacter(id, noCreate)
	if ( not id or id <= 0 ) then
		CharacterSelect.selectedIndex = 0;
		CharacterSelectDeleteButton:Disable();
		CharSelectEnterWorldButton:Disable();
		UpdateCharacterSelection(CharacterSelect);
		return;
	end

	if ( id == CharacterSelect.createIndex ) then
		if ( not noCreate ) then
			PlaySound("gsCharacterSelectionCreateNew");
			SetGlueScreen("charcreate");
		end
	else
		local targetPage = math.floor((id - 1) / MAX_CHARACTERS_DISPLAYED) + 1;
		if ( targetPage ~= CHARACTER_LIST_PAGE and not noCreate ) then
			CHARACTER_LIST_PAGE = targetPage;
			CHARACTER_LIST_OFFSET = (CHARACTER_LIST_PAGE - 1) * MAX_CHARACTERS_DISPLAYED;
			CharacterSelect.selectedIndex = id;
			UpdateCharacterList();
			return;
		end

		CharacterSelect.selectedIndex = id;
		CharacterSelect.currentModel = GetSelectBackgroundModel(id);
		SetBackgroundModel(CharacterSelect, CharacterSelect.currentModel);

		SelectCharacter(id);
	end
end

function CharacterDeleteDialog_OnShow()
	local name, race, class, level = GetCharacterInfo(CharacterSelect.selectedIndex);
	CharacterDeleteText1:SetFormattedText(CONFIRM_CHAR_DELETE, name, level, class);
	CharacterDeleteBackground:SetHeight(16 + CharacterDeleteText1:GetHeight() + CharacterDeleteText2:GetHeight() + 23 + CharacterDeleteEditBox:GetHeight() + 8 + CharacterDeleteButton1:GetHeight() + 16);
	CharacterDeleteButton1:Disable();
end

function CharacterSelect_EnterWorld()
	if ( CharacterSelect.selectedIndex and CharacterSelect.selectedIndex > 0 ) then
		PlaySound("gsCharacterSelectionEnterWorld");
		StopGlueAmbience();
		EnterWorld();
	end
end

function CharacterSelect_Exit()
	PlaySound("gsCharacterSelectionExit");
	DisconnectFromServer();
	SetGlueScreen("login");
end

function CharacterSelect_AccountOptions()
	PlaySound("gsCharacterSelectionAcctOptions");
end

function CharacterSelect_TechSupport()
	PlaySound("gsCharacterSelectionAcctOptions");
	LaunchURL(TECH_SUPPORT_URL);
end

function CharacterSelect_Delete()
	PlaySound("gsCharacterSelectionDelCharacter");
	if ( CharacterSelect.selectedIndex > 0 ) then
		CharacterDeleteDialog:Show();
	end
end

function CharacterSelect_ChangeRealm()
	PlaySound("gsCharacterSelectionDelCharacter");
	RequestRealmList(1);
end

function CharacterSelectFrame_OnMouseDown(button)
	if ( button == "LeftButton" ) then
		CHARACTER_SELECT_ROTATION_START_X = GetCursorPosition();
		CHARACTER_SELECT_INITIAL_FACING = GetCharacterSelectFacing();
	end
end

function CharacterSelectFrame_OnMouseUp(button)
	if ( button == "LeftButton" ) then
		CHARACTER_SELECT_ROTATION_START_X = nil
	end
end

function CharacterSelectFrame_OnUpdate()
	if ( CHARACTER_SELECT_ROTATION_START_X ) then
		local x = GetCursorPosition();
		local diff = (x - CHARACTER_SELECT_ROTATION_START_X) * CHARACTER_ROTATION_CONSTANT;
		CHARACTER_SELECT_ROTATION_START_X = GetCursorPosition();
		SetCharacterSelectFacing(GetCharacterSelectFacing() + diff);
	end
end

function CharacterSelectRotateRight_OnUpdate(self)
	if ( self:GetButtonState() == "PUSHED" ) then
		SetCharacterSelectFacing(GetCharacterSelectFacing() + CHARACTER_FACING_INCREMENT);
	end
end

function CharacterSelectRotateLeft_OnUpdate(self)
	if ( self:GetButtonState() == "PUSHED" ) then
		SetCharacterSelectFacing(GetCharacterSelectFacing() - CHARACTER_FACING_INCREMENT);
	end
end

function CharacterSelect_ManageAccount()
	PlaySound("gsCharacterSelectionAcctOptions");
	LaunchURL(AUTH_NO_TIME_URL);
end

function RealmSplit_GetFormatedChoice(formatText)
	if ( SERVER_SPLIT_CLIENT_STATE == 1 ) then
		realmChoice = SERVER_SPLIT_SERVER_ONE;
	else
		realmChoice = SERVER_SPLIT_SERVER_TWO;
	end
	return format(formatText, realmChoice);
end

function RealmSplit_SetChoiceText()
	RealmSplitCurrentChoice:SetText( RealmSplit_GetFormatedChoice(SERVER_SPLIT_CURRENT_CHOICE) );
	RealmSplitCurrentChoice:Show();
end

function CharacterSelect_PaidServiceOnClick(self, button, down, service)
	PAID_SERVICE_CHARACTER_ID = self:GetID();
	PAID_SERVICE_TYPE = service;
	PlaySound("gsCharacterSelectionCreateNew");
	SetGlueScreen("charcreate");
end

function CharacterSelect_DeathKnightSwap(self)
	if ( CharacterSelect.currentModel == "DEATHKNIGHT" ) then
		if (self.currentModel ~= "DEATHKNIGHT") then
			self.currentModel = "DEATHKNIGHT";
			self:SetNormalTexture("Interface\\Glues\\Common\\Glue-Panel-Button-Up-Blue");
			self:SetPushedTexture("Interface\\Glues\\Common\\Glue-Panel-Button-Down-Blue");
			self:SetHighlightTexture("Interface\\Glues\\Common\\Glue-Panel-Button-Highlight-Blue");
		end
	else
		if (self.currentModel == "DEATHKNIGHT") then
			self.currentModel = nil;
			self:SetNormalTexture("Interface\\Glues\\Common\\Glue-Panel-Button-Up");
			self:SetPushedTexture("Interface\\Glues\\Common\\Glue-Panel-Button-Down");
			self:SetHighlightTexture("Interface\\Glues\\Common\\Glue-Panel-Button-Highlight");
		end
	end
end

