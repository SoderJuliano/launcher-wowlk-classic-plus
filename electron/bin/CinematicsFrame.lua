-- Silencia diálogos modais de erro de script no Glue para não travar a interface nem controles no Steam Deck/PC
pcall(function()
	if seterrorhandler then
		seterrorhandler(function(err) end)
	end
	_ERRORMESSAGE = function(msg) end
end)

-- Stubs para CinematicsFrame (diálogo de Cinemáticas do menu de login)
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

function Cinematics_PlayMovie(self)
	if CinematicsFrame and CinematicsFrame.Hide then
		pcall(function() CinematicsFrame:Hide() end)
	end
end
