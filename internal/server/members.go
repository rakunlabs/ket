package server

import (
	"net/http"

	"github.com/rakunlabs/ada"

	"github.com/rakunlabs/ket/internal/access"
	"github.com/rakunlabs/ket/internal/store"
)

type memberOut struct {
	UserID   string `json:"user_id"`
	Username string `json:"username"`
	Name     string `json:"name,omitempty"`
	Role     string `json:"role"`
}

// listMembers returns the owner and the members of a project.
func (s *Server) listMembers(c *ada.Context) error {
	ctx := c.Request.Context()
	p, err := s.access.Project(ctx, c.Request.PathValue("id"), access.Viewer)
	if err != nil {
		return httpErr(err)
	}
	list, err := s.Store.Members(ctx, p.ID)
	if err != nil {
		return err
	}
	out := []memberOut{}
	if p.OwnerID != nil {
		out = append(out, s.member(c, *p.OwnerID, "owner"))
	}
	for _, m := range list {
		out = append(out, s.member(c, m.UserID, m.Role))
	}

	groups, err := s.Store.ProjectGroups(ctx, p.ID)
	if err != nil {
		return err
	}

	return c.SendJSON(map[string]any{"sharing": true, "access": p.Access, "members": out, "groups": groups})
}

func (s *Server) member(c *ada.Context, id, role string) memberOut {
	m := memberOut{UserID: id, Username: id, Role: role}
	if u, err := s.guard.kit.Users.Store().GetUser(c.Request.Context(), id); err == nil {
		m.Username, m.Name = u.Username, u.Name
	}

	return m
}

// setMember shares a project (owner only). The body is {"role": "viewer"
// | "editor" | "owner"}; owner hands the project over and makes the old
// owner an editor.
func (s *Server) setMember(c *ada.Context) error {
	ctx := c.Request.Context()
	p, err := s.access.Project(ctx, c.Request.PathValue("id"), access.Owner)
	if err != nil {
		return httpErr(err)
	}
	var in struct {
		Role string `json:"role"`
	}
	if err := c.Bind(&in); err != nil {
		return ada.WrapHTTPError(http.StatusBadRequest, err)
	}

	userID := c.Request.PathValue("user")
	u, err := s.guard.kit.Users.Store().GetUser(ctx, userID)
	if err != nil {
		// Accept a username too.
		u, err = s.guard.kit.Users.Store().GetUserByUsername(ctx, userID)
		if err != nil {
			return ada.NewHTTPError(http.StatusNotFound, "no such user")
		}
	}
	if p.OwnerID != nil && *p.OwnerID == u.ID {
		return ada.NewHTTPError(http.StatusBadRequest, "that user owns the project")
	}

	if in.Role == "owner" {
		if err := s.Store.SetOwner(ctx, p.ID, u.ID); err != nil {
			return httpErr(err)
		}
		_ = s.Store.RemoveMember(ctx, p.ID, u.ID)
		if p.OwnerID != nil {
			if err := s.Store.SetMember(ctx, p.ID, *p.OwnerID, store.MemberEditor); err != nil {
				return err
			}
		}
		return c.SendNoContent()
	}
	if err := s.Store.SetMember(ctx, p.ID, u.ID, in.Role); err != nil {
		return ada.WrapHTTPError(http.StatusBadRequest, err)
	}

	return c.SendNoContent()
}

// removeMember unshares a project: the owner removes anyone, a member may
// leave.
func (s *Server) removeMember(c *ada.Context) error {
	ctx := c.Request.Context()
	userID := c.Request.PathValue("user")
	level := access.Owner
	if userID == s.access.Subject(ctx) {
		level = access.Viewer
	}
	p, err := s.access.Project(ctx, c.Request.PathValue("id"), level)
	if err != nil {
		return httpErr(err)
	}
	if err := s.Store.RemoveMember(ctx, p.ID, userID); err != nil {
		return httpErr(err)
	}

	return c.SendNoContent()
}

// listUsers lets a signed-in user pick someone to share with: names only.
func (s *Server) listUsers(c *ada.Context) error {
	list, err := s.guard.kit.Users.Store().ListUsers(c.Request.Context())
	if err != nil {
		return err
	}
	out := make([]memberOut, 0, len(list))
	for _, u := range list {
		if u.Disabled {
			continue
		}
		out = append(out, memberOut{UserID: u.ID, Username: u.Username, Name: u.Name})
	}

	return c.SendJSON(out)
}
