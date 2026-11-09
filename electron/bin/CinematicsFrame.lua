-- Stubs para CinematicsFrame e MovieFrame
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
function Cinematics_PlayMovie(self)
	if CinematicsFrame and CinematicsFrame.Hide then
		pcall(function() CinematicsFrame:Hide() end)
	end
end
