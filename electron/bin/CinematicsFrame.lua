-- Silencia diálogos modais de erro de script no Glue para não travar a interface nem controles no Steam Deck/PC
pcall(function()
	if seterrorhandler then
		seterrorhandler(function(err) end)
	end
	_ERRORMESSAGE = function(msg) end
end)

-- Stubs defensivos completos para CinematicsFrame e MovieFrame
function CinematicsFrame_OnLoad(self)
	if self and self.Hide then pcall(function() self:Hide() end) end
end
function CinematicsFrame_OnShow(self)
	if self and self.Hide then pcall(function() self:Hide() end) end
end
function CinematicsFrame_OnKeyDown(key)
	if CinematicsFrame and CinematicsFrame.Hide then
		pcall(function() CinematicsFrame:Hide() end)
	end
end
function CinematicsFrameCloseDialogResumeButton_OnClick() end
function CinematicsFrameCloseDialogLeaveButton_OnClick() end

function CinematicFrame_OnLoad(self) end
function CinematicFrame_OnShow(self) end
function CinematicFrame_OnKeyDown(key) end

function Cinematics_PlayMovie(self)
	if CinematicsFrame and CinematicsFrame.Hide then
		pcall(function() CinematicsFrame:Hide() end)
	end
end

function MovieFrame_OnLoad(self) end
function MovieFrame_OnShow(self)
	if self and self.StopMovie then pcall(function() self:StopMovie() end) end
	if self and self.Hide then pcall(function() self:Hide() end) end
	pcall(function() SetGlueScreen("login") end)
	pcall(function() ShowCursor() end)
end
function MovieFrame_PlayMovie(self)
	if self and self.StopMovie then pcall(function() self:StopMovie() end) end
	if self and self.Hide then pcall(function() self:Hide() end) end
	pcall(function() SetGlueScreen("login") end)
	pcall(function() ShowCursor() end)
end
function MovieFrame_OnKeyUp(self)
	if self and self.StopMovie then pcall(function() self:StopMovie() end) end
	if self and self.Hide then pcall(function() self:Hide() end) end
end
function MovieFrame_OnKeyDown(self)
	if self and self.StopMovie then pcall(function() self:StopMovie() end) end
	if self and self.Hide then pcall(function() self:Hide() end) end
end
