package server

import (
	"bytes"
	"net/http"
	"strconv"

	"github.com/rakunlabs/ada"
)

func (s *Server) searchParts(c *ada.Context) error {
	q := c.Request.URL.Query().Get("q")
	if q == "" {
		return ada.NewHTTPError(http.StatusBadRequest, "q is required")
	}
	limit, _ := strconv.Atoi(c.Request.URL.Query().Get("limit"))

	hits, err := s.Parts.Search(c.Request.Context(), q, limit)
	if err != nil {
		return ada.WrapHTTPError(http.StatusBadGateway, err)
	}

	return c.SendJSON(hits)
}

func (s *Server) getPart(c *ada.Context) error {
	raw, err := s.Parts.Get(c.Request.Context(), c.Request.PathValue("lcsc"))
	if err != nil {
		return ada.WrapHTTPError(http.StatusBadGateway, err)
	}
	c.SetHeader("Content-Type", "application/json")
	c.SetHeader("Cache-Control", "private, max-age=86400")

	return c.SendJSONRaw(bytesReader(raw))
}

// offers prices a BOM: {"parts": {"C6186": 10, ...}}.
func (s *Server) offers(c *ada.Context) error {
	var in struct {
		Parts map[string]int `json:"parts"`
	}
	if err := c.Bind(&in); err != nil {
		return ada.WrapHTTPError(http.StatusBadRequest, err)
	}
	if len(in.Parts) == 0 || len(in.Parts) > 500 {
		return ada.NewHTTPError(http.StatusBadRequest, "parts must list 1 to 500 LCSC numbers with quantities")
	}

	return c.SendJSON(s.Parts.Offers(c.Request.Context(), in.Parts))
}

// getAsset serves a downloaded STEP/STL model: ?url=https://...[#file-in-zip].
func (s *Server) getAsset(c *ada.Context) error {
	u := c.Request.URL.Query().Get("url")
	if u == "" {
		return ada.NewHTTPError(http.StatusBadRequest, "url is required")
	}
	data, err := s.Parts.Asset(c.Request.Context(), u)
	if err != nil {
		return ada.WrapHTTPError(http.StatusBadGateway, err)
	}
	c.SetHeader("Content-Type", "application/octet-stream")
	c.SetHeader("Cache-Control", "private, max-age=604800")

	return c.SendBlob(bytes.NewReader(data))
}

func (s *Server) getModel(c *ada.Context) error {
	obj, err := s.Parts.Model(c.Request.Context(), c.Request.PathValue("uuid"))
	if err != nil {
		return ada.WrapHTTPError(http.StatusBadGateway, err)
	}
	c.SetHeader("Content-Type", "text/plain; charset=utf-8")
	c.SetHeader("Cache-Control", "private, max-age=604800, immutable")

	return c.SendString(obj)
}
