package server

import (
	"errors"
	"net/http"
	"strings"

	"github.com/rakunlabs/ada"

	"github.com/rakunlabs/ket/internal/access"
	"github.com/rakunlabs/ket/internal/auth/users"
	"github.com/rakunlabs/ket/internal/sso"
	"github.com/rakunlabs/ket/internal/store"
)

// ////////////////////////////////////////////////////////////////////////////
// groups

type groupOut struct {
	ID          string      `json:"id"`
	Name        string      `json:"name"`
	Description string      `json:"description"`
	Members     []memberOut `json:"members"`
	CreatedAt   any         `json:"created_at"`
}

func (s *Server) groupOut(c *ada.Context, g *store.Group, names map[string]*users.User) groupOut {
	out := groupOut{ID: g.ID, Name: g.Name, Description: g.Description, CreatedAt: g.CreatedAt, Members: []memberOut{}}
	for _, id := range g.MemberIDs {
		m := memberOut{UserID: id, Username: id}
		if u := names[id]; u != nil {
			m.Username, m.Name = u.Username, u.Name
		}
		out.Members = append(out.Members, m)
	}

	return out
}

func (s *Server) userIndex(c *ada.Context) map[string]*users.User {
	list, _ := s.guard.kit.Users.Store().ListUsers(c.Request.Context())
	out := make(map[string]*users.User, len(list))
	for _, u := range list {
		out[u.ID] = u
	}

	return out
}

// listGroups lists the groups with their members; anyone who may share a
// project sees them to pick one.
func (s *Server) listGroups(c *ada.Context) error {
	list, err := s.Store.Groups(c.Request.Context())
	if err != nil {
		return err
	}
	names := s.userIndex(c)
	out := make([]groupOut, 0, len(list))
	for _, g := range list {
		out = append(out, s.groupOut(c, g, names))
	}

	return c.SendJSON(out)
}

type groupIn struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	// Members are user ids or usernames; nil leaves them as they are.
	Members *[]string `json:"members"`
}

func (s *Server) saveGroup(c *ada.Context) error {
	var in groupIn
	if err := c.Bind(&in); err != nil {
		return ada.WrapHTTPError(http.StatusBadRequest, err)
	}
	var members []string
	if in.Members != nil {
		members = []string{}
		for _, ref := range *in.Members {
			u, err := s.findUser(c, ref)
			if err != nil {
				return ada.NewHTTPError(http.StatusBadRequest, "no user "+ref+"; pick members from the user list")
			}
			members = append(members, u.ID)
		}
	}
	g, err := s.Store.SaveGroup(c.Request.Context(), &store.Group{ID: c.Request.PathValue("id"), Name: in.Name, Description: in.Description}, members)
	if errors.Is(err, store.ErrNotFound) {
		return httpErr(err)
	}
	if err != nil {
		return ada.WrapHTTPError(http.StatusBadRequest, err)
	}
	status := http.StatusOK
	if c.Request.PathValue("id") == "" {
		status = http.StatusCreated
	}

	return c.SetStatus(status).SendJSON(s.groupOut(c, g, s.userIndex(c)))
}

func (s *Server) deleteGroup(c *ada.Context) error {
	return sendNone(c, httpErr(s.Store.DeleteGroup(c.Request.Context(), c.Request.PathValue("id"))))
}

func sendNone(c *ada.Context, err error) error {
	if err != nil {
		return err
	}

	return c.SendNoContent()
}

func (s *Server) findUser(c *ada.Context, ref string) (*users.User, error) {
	st := s.guard.kit.Users.Store()
	u, err := st.GetUser(c.Request.Context(), ref)
	if err != nil {
		u, err = st.GetUserByUsername(c.Request.Context(), ref)
	}

	return u, err
}

// ////////////////////////////////////////////////////////////////////////////
// sharing with groups

func (s *Server) setProjectGroup(c *ada.Context) error {
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
	err = s.Store.SetProjectGroup(ctx, p.ID, c.Request.PathValue("group"), in.Role)
	if errors.Is(err, store.ErrNotFound) {
		return httpErr(err)
	}
	if err != nil {
		return ada.WrapHTTPError(http.StatusBadRequest, err)
	}

	return c.SendNoContent()
}

func (s *Server) removeProjectGroup(c *ada.Context) error {
	ctx := c.Request.Context()
	p, err := s.access.Project(ctx, c.Request.PathValue("id"), access.Owner)
	if err != nil {
		return httpErr(err)
	}

	return sendNone(c, httpErr(s.Store.RemoveProjectGroup(ctx, p.ID, c.Request.PathValue("group"))))
}

// ////////////////////////////////////////////////////////////////////////////
// SSO providers (admin)

func (s *Server) listSSO(c *ada.Context) error {
	return c.SendJSON(map[string]any{"providers": s.sso.Views(), "callback_base": s.sso.CallbackURL("")})
}

type ssoIn struct {
	sso.Provider
	// ClientSecret replaces the stored secret when set; omitted keeps it.
	ClientSecret *string `json:"client_secret"`
}

func (s *Server) saveSSO(c *ada.Context) error {
	var in ssoIn
	if err := c.Bind(&in); err != nil {
		return ada.WrapHTTPError(http.StatusBadRequest, err)
	}
	if in.ClientSecret != nil {
		v := strings.TrimSpace(*in.ClientSecret)
		in.ClientSecret = &v
	}
	if err := s.sso.Save(c.Request.Context(), c.Request.PathValue("name"), in.Provider, in.ClientSecret, author(c.Request)); err != nil {
		return ada.WrapHTTPError(http.StatusBadRequest, err)
	}

	return s.listSSO(c)
}

func (s *Server) deleteSSO(c *ada.Context) error {
	if err := s.sso.Delete(c.Request.Context(), c.Request.PathValue("name"), author(c.Request)); err != nil {
		return httpErr(err)
	}

	return s.listSSO(c)
}

// ////////////////////////////////////////////////////////////////////////////
// a user's groups and sign-in links (admin)

func (s *Server) userAccess(c *ada.Context) error {
	ctx := c.Request.Context()
	id := c.Request.PathValue("user")
	groups, err := s.Store.UserGroups(ctx, id)
	if err != nil {
		return err
	}
	links, err := s.Store.UserIdentities(ctx, id)
	if err != nil {
		return err
	}

	return c.SendJSON(map[string]any{"groups": groups, "identities": links})
}

// setUserGroups puts a user in exactly the given groups.
func (s *Server) setUserGroups(c *ada.Context) error {
	ctx := c.Request.Context()
	id := c.Request.PathValue("user")
	if _, err := s.guard.kit.Users.Store().GetUser(ctx, id); err != nil {
		return ada.NewHTTPError(http.StatusNotFound, "no such user")
	}
	var in struct {
		Groups []string `json:"groups"`
	}
	if err := c.Bind(&in); err != nil {
		return ada.WrapHTTPError(http.StatusBadRequest, err)
	}
	have, err := s.Store.UserGroups(ctx, id)
	if err != nil {
		return err
	}
	var remove []string
	for _, g := range have {
		if !contains(in.Groups, g) {
			remove = append(remove, g)
		}
	}
	if err := s.Store.SetUserGroups(ctx, id, in.Groups, remove); err != nil {
		return err
	}

	return c.SendNoContent()
}

func (s *Server) unlinkIdentity(c *ada.Context) error {
	var in struct {
		Provider string `json:"provider"`
		Subject  string `json:"subject"`
	}
	if err := c.Bind(&in); err != nil {
		return ada.WrapHTTPError(http.StatusBadRequest, err)
	}

	return sendNone(c, httpErr(s.Store.UnlinkIdentity(c.Request.Context(), c.Request.PathValue("user"), in.Provider, in.Subject)))
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}

	return false
}
