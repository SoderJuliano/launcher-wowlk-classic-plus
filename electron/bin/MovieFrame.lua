MOVIE_CAPTION_FADE_TIME = 1.0;
MovieVolumeList = { [1] = 100, [2] = 150, [3] = 150 };
MovieList = { [1] = {}, [2] = {}, [3] = {} };

local function AbortMovie(frame)
	if frame and frame.StopMovie then
		pcall(function() frame:StopMovie() end)
	end
	if frame and frame.Hide then
		pcall(function() frame:Hide() end)
	end
	pcall(function() SetGlueScreen("login") end)
	pcall(function() ShowCursor() end)
end

function MovieFrame_OnLoad(self)
	self.version = GetClientExpansionLevel();
	if MovieFrameSubtitleArea then
		MovieFrameSubtitleArea:Hide();
	end
end

function MovieFrame_PlayMovie(self, index)
	AbortMovie(self);
end

function MovieFrame_PlayNextMovie(self)
	AbortMovie(self);
end

function MovieFrame_OnShow(self)
	AbortMovie(self);
end

function MovieFrame_OnHide(self)
	if MovieFrameSubtitleString then
		MovieFrameSubtitleString:Hide();
	end
	AbortMovie(self);
end

function MovieFrame_OnUpdate(self, elapsed)
	AbortMovie(self);
end

function MovieFrame_OnKeyUp(self, key)
	AbortMovie(self);
end

function MovieFrame_OnKeyDown(self, key)
	AbortMovie(self);
end

function MovieFrame_OnMouseDown(self, button)
	AbortMovie(self);
end

function MovieFrame_OnMouseUp(self, button)
	AbortMovie(self);
end

function MovieFrame_OnMovieFinished(self)
	AbortMovie(self);
end

function MovieFrame_OnMovieShowSubtitle(self, text)
end

function MovieFrame_OnMovieHideSubtitle(self)
end
