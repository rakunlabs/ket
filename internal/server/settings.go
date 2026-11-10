package server

import (
	"net/http"

	"github.com/rakunlabs/ada"

	"github.com/rakunlabs/ket/internal/settings"
)

func (s *Server) roleNames() []string {
	roles := s.guard.kit.Users.Roles()
	out := make([]string, 0, len(roles))
	for _, r := range roles {
		out = append(out, r.Name)
	}

	return out
}

// getSettings returns the admin settings; API keys are replaced by has_key.
func (s *Server) getSettings(c *ada.Context) error {
	return c.SendJSON(map[string]any{"settings": s.Settings.Public(), "roles": s.guard.kit.Users.Roles()})
}

type settingsIn struct {
	settings.Settings
	// ClearKeys names providers whose stored API key is removed. Otherwise
	// a provider sent without api_key keeps its key.
	ClearKeys []string `json:"clear_keys"`
}

func (s *Server) putSettings(c *ada.Context) error {
	var in settingsIn
	if err := c.Bind(&in); err != nil {
		return ada.WrapHTTPError(http.StatusBadRequest, err)
	}
	if _, err := s.Settings.Update(c.Request.Context(), in.Settings, in.ClearKeys, s.roleNames(), author(c.Request)); err != nil {
		return ada.WrapHTTPError(http.StatusBadRequest, err)
	}

	return c.SendJSON(map[string]any{"settings": s.Settings.Public()})
}

// testProvider sends a short prompt to a provider (as entered in the form;
// an empty key uses the stored one) and reports the answer or the error.
func (s *Server) testProvider(w http.ResponseWriter, r *http.Request) {
	var p settings.Provider
	if err := decodeJSON(r, &p); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	msg, err := s.Agent.Test(r.Context(), p)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": msg})
}

// providers lists the AI providers people may pick in the chat (no keys).
func (s *Server) providers(c *ada.Context) error {
	return c.SendJSON(s.Agent.Providers())
}
