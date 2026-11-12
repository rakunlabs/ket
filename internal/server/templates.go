package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/rakunlabs/ada"

	"github.com/rakunlabs/ket/internal/store"
)

// maxTemplate bounds a template's .ket text, as import_project does.
const maxTemplate = 25 << 20

func (s *Server) listTemplates(c *ada.Context) error {
	list, err := s.Store.ListTemplates(c.Request.Context(), c.Request.URL.Query().Get("kind"))
	if err != nil {
		return err
	}

	return c.SendJSON(list)
}

func (s *Server) getTemplate(c *ada.Context) error {
	t, err := s.Store.GetTemplate(c.Request.Context(), "", c.Request.PathValue("id"))
	if err != nil {
		return httpErr(err)
	}

	return c.SendJSON(t)
}

// saveTemplate stores a template or block (admins: users:write... settings).
func (s *Server) saveTemplate(c *ada.Context) error {
	var in struct {
		Kind        string `json:"kind"`
		Name        string `json:"name"`
		Description string `json:"description"`
		Data        string `json:"data"`
		Replace     bool   `json:"replace"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(c.Response, c.Request.Body, maxTemplate+4096)).Decode(&in); err != nil {
		return ada.WrapHTTPError(http.StatusBadRequest, err)
	}
	if in.Kind != "template" && in.Kind != "block" {
		return ada.NewHTTPError(http.StatusBadRequest, `kind must be "template" or "block"`)
	}
	if strings.TrimSpace(in.Name) == "" {
		return ada.NewHTTPError(http.StatusBadRequest, "name is required")
	}
	var head struct {
		Format string `json:"format"`
	}
	if json.Unmarshal([]byte(in.Data), &head) != nil || head.Format != "ket-project" {
		return ada.NewHTTPError(http.StatusBadRequest, "data must be the text of a .ket project file (format ket-project); save one with export_project")
	}
	t, err := s.Store.SaveTemplate(c.Request.Context(), &store.Template{Kind: in.Kind, Name: in.Name, Description: in.Description, Data: in.Data, CreatedBy: s.access.Subject(c.Request.Context())}, in.Replace)
	if err != nil {
		if errors.Is(err, store.ErrExists) {
			return ada.WrapHTTPError(http.StatusConflict, err)
		}
		return err
	}
	t.Data = ""

	return c.SetStatus(http.StatusCreated).SendJSON(t)
}

func (s *Server) deleteTemplate(c *ada.Context) error {
	if err := s.Store.DeleteTemplate(c.Request.Context(), c.Request.PathValue("id")); err != nil {
		return httpErr(err)
	}

	return c.SendJSON(map[string]any{"ok": true})
}
