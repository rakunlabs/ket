package server

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"

	"github.com/rakunlabs/ada"

	"github.com/rakunlabs/ket/internal/access"
	"github.com/rakunlabs/ket/internal/parts"
	"github.com/rakunlabs/ket/internal/store"
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

// getAsset serves a model for import: ?url=https://...[#file-in-zip], or
// ket:asset/<id>/<name> for an uploaded file (needs read access to its project).
func (s *Server) getAsset(c *ada.Context) error {
	u := c.Request.URL.Query().Get("url")
	if u == "" {
		return ada.NewHTTPError(http.StatusBadRequest, "url is required")
	}
	if id, ok := parts.UploadID(u); ok {
		ctx := c.Request.Context()
		up, err := s.Store.UploadInfo(ctx, id)
		if err != nil {
			return httpErr(err)
		}
		if _, err := s.access.Project(ctx, up.ProjectID, access.Viewer); err != nil {
			// The same answer as a missing file: do not tell what exists.
			return ada.NewHTTPError(http.StatusNotFound, "upload "+id+" not found")
		}
		data, err := s.Store.UploadData(ctx, id)
		if err != nil {
			return httpErr(err)
		}
		c.SetHeader("Content-Type", "application/octet-stream")
		c.SetHeader("Cache-Control", "private, max-age=604800, immutable")

		return c.SendBlob(bytes.NewReader(data))
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

// uploadAsset stores a model file for a project: the raw file is the body,
// ?name= its file name. Answers the ket:asset URL to import it with.
func (s *Server) uploadAsset(c *ada.Context) error {
	ctx := c.Request.Context()
	p, err := s.access.Project(ctx, c.Request.PathValue("id"), access.Editor)
	if err != nil {
		return httpErr(err)
	}
	data, err := readUpload(c)
	if err != nil {
		return err
	}
	out, err := parts.StoreUpload(ctx, s.Store, p.ID, c.Request.URL.Query().Get("name"), data, s.access.Subject(ctx))
	if err != nil {
		return uploadErr(err)
	}

	return c.SetStatus(http.StatusCreated).SendJSON(out)
}

func (s *Server) listUploads(c *ada.Context) error {
	ctx := c.Request.Context()
	p, err := s.access.Project(ctx, c.Request.PathValue("id"), access.Viewer)
	if err != nil {
		return httpErr(err)
	}
	list, err := s.Store.Uploads(ctx, p.ID)
	if err != nil {
		return err
	}
	out := make([]map[string]any, 0, len(list))
	for i := range list {
		out = append(out, parts.UploadView(&list[i]))
	}

	return c.SendJSON(out)
}

func (s *Server) deleteUpload(c *ada.Context) error {
	ctx := c.Request.Context()
	p, err := s.access.Project(ctx, c.Request.PathValue("id"), access.Editor)
	if err != nil {
		return httpErr(err)
	}
	if err := s.Store.DeleteUpload(ctx, p.ID, c.Request.PathValue("upload")); err != nil {
		return httpErr(err)
	}

	return c.SendNoContent()
}

// putUpload takes the file of an upload link that upload_asset handed out:
// the token in the path is the permission, valid once and for a short time.
// Access to the project is checked again, as the person who asked for it.
func (s *Server) putUpload(c *ada.Context) error {
	ctx := c.Request.Context()
	tk, ok := s.Tickets.Take(c.Request.PathValue("token"))
	if !ok {
		return ada.NewHTTPError(http.StatusNotFound, "this upload link is unknown, used or expired; call upload_asset again for a new one")
	}
	if _, err := s.access.Project(tk.Context(ctx), tk.ProjectID, access.Editor); err != nil {
		return ada.NewHTTPError(http.StatusForbidden, "the project is gone, or the person this upload link was made for can no longer edit it")
	}
	data, err := readUpload(c)
	if err != nil {
		return err
	}
	out, err := parts.StoreUpload(ctx, s.Store, tk.ProjectID, tk.Name, data, tk.By)
	if err != nil {
		return uploadErr(fmt.Errorf("%w; call upload_asset again for a new link", err))
	}

	return c.SetStatus(http.StatusCreated).SendJSON(out)
}

// uploadErr maps store errors and refused files to HTTP statuses.
func uploadErr(err error) error {
	switch {
	case errors.Is(err, store.ErrNotFound):
		return ada.WrapHTTPError(http.StatusNotFound, err)
	case errors.Is(err, store.ErrConflict):
		return ada.WrapHTTPError(http.StatusInsufficientStorage, err)
	case errors.As(err, new(*parts.UploadError)):
		return ada.WrapHTTPError(http.StatusBadRequest, err)
	default:
		return err
	}
}

func readUpload(c *ada.Context) ([]byte, error) {
	data, err := io.ReadAll(http.MaxBytesReader(c.Response, c.Request.Body, parts.MaxUpload))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return nil, ada.NewHTTPError(http.StatusRequestEntityTooLarge, "the file is larger than "+strconv.Itoa(parts.MaxUpload>>20)+" MB")
		}
		return nil, ada.WrapHTTPError(http.StatusBadRequest, err)
	}
	if len(data) == 0 {
		return nil, ada.NewHTTPError(http.StatusBadRequest, "the request body is empty: send the file's bytes")
	}

	return data, nil
}
