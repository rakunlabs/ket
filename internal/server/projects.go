package server

import (
	"net/http"
	"runtime"
	"strconv"
	"strings"

	"github.com/rakunlabs/ada"

	"github.com/rakunlabs/ket/internal/access"
	"github.com/rakunlabs/ket/internal/catalog"
	"github.com/rakunlabs/ket/internal/config"
	"github.com/rakunlabs/ket/internal/store"
)

func (s *Server) info(c *ada.Context) error {
	return c.SendJSON(map[string]any{
		"name":       config.ServiceName,
		"version":    config.Version,
		"commit":     config.Commit,
		"build_date": config.BuildDate,
		"repository": config.Repository,
		"go":         runtime.Version(),
		"mcp_url":    s.publicURL(c.Request) + "/mcp",
		"auth":       true,
	})
}

// publicURL is the server's base URL as clients see it.
func (s *Server) publicURL(r *http.Request) string {
	if u := strings.TrimRight(s.Settings.Get().PublicURL, "/"); u != "" {
		return u
	}

	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	host := r.Host
	if h := r.Header.Get("X-Forwarded-Host"); h != "" {
		host = h
	}

	return scheme + "://" + host + s.cfg.Server.BasePath
}

func (s *Server) catalog(c *ada.Context) error {
	c.SetHeader("Content-Type", "application/json")

	return c.SendBlob(strings.NewReader(string(catalog.Raw())))
}

type projectIn struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// listProjects pages the projects the user may see:
// ?q=words&sort=updated|name|created&limit=20&offset=0&filter=all|mine|shared.
func (s *Server) listProjects(c *ada.Context) error {
	qs := c.Request.URL.Query()
	q := store.ProjectQuery{Q: strings.TrimSpace(qs.Get("q")), Sort: qs.Get("sort")}
	q.Limit, _ = strconv.Atoi(qs.Get("limit"))
	q.Offset, _ = strconv.Atoi(qs.Get("offset"))
	switch qs.Get("filter") {
	case "mine":
		q.Mine = true
	case "shared":
		q.Shared = true
	}
	page, err := s.access.Search(c.Request.Context(), q)
	if err != nil {
		return err
	}

	type item struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		Description string `json:"description"`
		UpdatedAt   string `json:"updated_at"`
		CreatedAt   string `json:"created_at"`
		Head        int64  `json:"head"`
		Sessions    int    `json:"sessions"`
		Access      string `json:"access"`
	}
	out := make([]item, 0, len(page.Items))
	for _, p := range page.Items {
		out = append(out, item{
			ID: p.ID, Name: p.Name, Description: p.Description,
			UpdatedAt: p.UpdatedAt.Format("2006-01-02T15:04:05Z07:00"),
			CreatedAt: p.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
			Head:      p.Head, Sessions: s.Hub.Sessions(p.ID), Access: p.Access,
		})
	}

	return c.SendJSON(map[string]any{"items": out, "total": page.Total})
}

func (s *Server) createProject(c *ada.Context) error {
	var in projectIn
	if err := c.Bind(&in); err != nil {
		return ada.WrapHTTPError(http.StatusBadRequest, err)
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return ada.NewHTTPError(http.StatusBadRequest, "name is required")
	}

	p, err := s.Store.CreateProject(c.Request.Context(), in.Name, in.Description, s.access.Subject(c.Request.Context()))
	if err != nil {
		return err
	}

	return c.SetStatus(http.StatusCreated).SendJSON(p)
}

func (s *Server) getProject(c *ada.Context) error {
	p, err := s.access.Project(c.Request.Context(), c.Request.PathValue("id"), access.Viewer)
	if err != nil {
		return httpErr(err)
	}

	return c.SendJSON(p)
}

func (s *Server) updateProject(c *ada.Context) error {
	ctx := c.Request.Context()
	p, err := s.access.Project(ctx, c.Request.PathValue("id"), access.Editor)
	if err != nil {
		return httpErr(err)
	}

	in := projectIn{Name: p.Name, Description: p.Description}
	if err := c.Bind(&in); err != nil {
		return ada.WrapHTTPError(http.StatusBadRequest, err)
	}
	if strings.TrimSpace(in.Name) == "" {
		return ada.NewHTTPError(http.StatusBadRequest, "name is required")
	}

	if err := s.Store.UpdateProject(ctx, p.ID, strings.TrimSpace(in.Name), in.Description); err != nil {
		return httpErr(err)
	}

	return c.SendNoContent()
}

func (s *Server) deleteProject(c *ada.Context) error {
	p, err := s.access.Project(c.Request.Context(), c.Request.PathValue("id"), access.Owner)
	if err != nil {
		return httpErr(err)
	}
	if err := s.Store.DeleteProject(c.Request.Context(), p.ID); err != nil {
		return httpErr(err)
	}

	return c.SendNoContent()
}

// listOps returns the ops of a branch (main unless ?branch=) in
// (from, head], plus the state, so a client can rebuild the document.
func (s *Server) listOps(c *ada.Context) error {
	ctx := c.Request.Context()
	p, err := s.access.Project(ctx, c.Request.PathValue("id"), access.Viewer)
	if err != nil {
		return httpErr(err)
	}

	branch := p.MainBranch
	if q := c.Request.URL.Query().Get("branch"); q != "" {
		b, err := s.Store.GetBranch(ctx, q)
		if err != nil || b.ProjectID != p.ID {
			return ada.NewHTTPError(http.StatusNotFound, "no such branch")
		}
		branch = b.ID
	}

	st, err := s.Store.BranchState(ctx, branch)
	if err != nil {
		return httpErr(err)
	}

	from, _ := strconv.ParseInt(c.Request.URL.Query().Get("from"), 10, 64)
	to := st.Head
	if c.Request.URL.Query().Get("all") == "true" {
		to = st.Top
	}

	ops, err := s.Store.Ops(ctx, branch, from, to)
	if err != nil {
		return err
	}

	return c.SendJSON(map[string]any{"head": st.Head, "top": st.Top, "ops": ops})
}
