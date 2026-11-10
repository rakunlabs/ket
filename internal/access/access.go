// Package access decides what a signed-in user may do with a project.
//
// A project has an owner (its creator) and members, people or groups, with
// the viewer or editor role; the best of them counts. The user's global role caps that: a member "editor" whose
// account role only reads is a viewer. Administrators see and manage every
// project; projects without an owner (made before accounts were turned
// on) are open to everyone by their global role. Without accounts
// everybody owns everything.
package access

import (
	"context"
	"errors"
	"fmt"

	"github.com/rakunlabs/ada/middleware/auth/identity"

	"github.com/rakunlabs/ket/internal/auth/users"
	"github.com/rakunlabs/ket/internal/store"
)

type Level int

const (
	None Level = iota
	Viewer
	Editor
	Owner
)

func (l Level) String() string {
	switch l {
	case Viewer:
		return "viewer"
	case Editor:
		return "editor"
	case Owner:
		return "owner"
	default:
		return "none"
	}
}

// Global permissions (see config.DefaultRoles).
const (
	PermRead  = "projects:read"
	PermWrite = "projects:write"
	// PermAll sees and manages every project; admins hold it through "*".
	PermAll = "admin:projects"
)

// ErrDenied is returned when the user may see the project but not do the
// asked thing. Projects a user may not see are reported as not found.
var ErrDenied = errors.New("forbidden")

type Checker struct {
	store *store.Store
	// users is nil without accounts.
	users *users.Service
}

func New(st *store.Store, u *users.Service) *Checker {
	return &Checker{store: st, users: u}
}

// On reports whether accounts are enabled.
func (c *Checker) On() bool { return c != nil && c.users != nil }

// cap is the most the user's global role allows on any project.
func (c *Checker) cap(id *identity.Identity) Level {
	switch {
	case c.users.Can(id, PermAll):
		return Owner
	case c.users.Can(id, PermWrite):
		return Editor
	case c.users.Can(id, PermRead):
		return Viewer
	default:
		return None
	}
}

// Level is what the user in ctx may do with p.
func (c *Checker) Level(ctx context.Context, p *store.Project) (Level, error) {
	if !c.On() {
		return Owner, nil
	}
	id := identity.FromContext(ctx)
	if id == nil {
		return None, nil
	}
	capped := c.cap(id)
	if capped == Owner || capped == None {
		return capped, nil
	}
	if p.OwnerID == nil {
		return capped, nil
	}
	if *p.OwnerID == id.Subject {
		// Owners keep ownership but a read-only account cannot edit.
		if capped < Editor {
			return Viewer, nil
		}
		return Owner, nil
	}
	role, err := c.store.AccessRole(ctx, p.ID, id.Subject)
	if err != nil {
		return None, err
	}
	switch role {
	case store.MemberEditor:
		return min(Editor, capped), nil
	case store.MemberViewer:
		return Viewer, nil
	default:
		return None, nil
	}
}

// Need returns the project when the user has at least level, a not-found
// error when they cannot see it, and ErrDenied otherwise.
func (c *Checker) Need(ctx context.Context, p *store.Project, level Level) (*store.Project, error) {
	got, err := c.Level(ctx, p)
	if err != nil {
		return nil, err
	}
	if got == None {
		return nil, fmt.Errorf("project %s; %w", p.ID, store.ErrNotFound)
	}
	p.Access = got.String()
	if got < level {
		return nil, fmt.Errorf("you are %s on project %q and need %s access; ask its owner to share it with you; %w", articled(got), p.Name, level, ErrDenied)
	}

	return p, nil
}

// Project loads a project by id and checks access.
func (c *Checker) Project(ctx context.Context, id string, level Level) (*store.Project, error) {
	p, err := c.store.GetProject(ctx, id)
	if err != nil {
		return nil, err
	}

	return c.Need(ctx, p, level)
}

// Visible lists the projects the user may see, with Access filled in.
func (c *Checker) Visible(ctx context.Context) ([]*store.Project, error) {
	page, err := c.Search(ctx, store.ProjectQuery{Limit: 100})
	if err != nil {
		return nil, err
	}

	return page.Items, nil
}

// Search pages the projects the user may see, with Access filled in.
func (c *Checker) Search(ctx context.Context, q store.ProjectQuery) (*store.ProjectPage, error) {
	if !c.On() {
		q.UserID = ""
		page, _, err := c.store.SearchProjects(ctx, q)
		if err == nil {
			for _, p := range page.Items {
				p.Access = Owner.String()
			}
		}
		return page, err
	}
	id := identity.FromContext(ctx)
	if id == nil {
		return &store.ProjectPage{Items: []*store.Project{}}, nil
	}
	capped := c.cap(id)
	if capped == None {
		return &store.ProjectPage{Items: []*store.Project{}}, nil
	}
	// Administrators see everything, unless they ask for their own.
	q.UserID = id.Subject
	if capped == Owner && !q.Mine && !q.Shared {
		q.UserID = ""
	}
	page, roles, err := c.store.SearchProjects(ctx, q)
	if err != nil {
		return nil, err
	}
	for _, p := range page.Items {
		p.Access = levelOf(p, id.Subject, roles[p.ID], capped).String()
	}

	return page, nil
}

// levelOf is Level without a database round trip: the member role is known.
func levelOf(p *store.Project, subject, member string, capped Level) Level {
	switch {
	case capped == Owner:
		return Owner
	case p.OwnerID == nil:
		return capped
	case *p.OwnerID == subject:
		if capped < Editor {
			return Viewer
		}
		return Owner
	case member == store.MemberEditor:
		return min(Editor, capped)
	case member == store.MemberViewer:
		return Viewer
	default:
		return None
	}
}

// Subject is the signed-in user's id, "" without accounts.
func (c *Checker) Subject(ctx context.Context) string {
	if !c.On() {
		return ""
	}
	if id := identity.FromContext(ctx); id != nil {
		return id.Subject
	}

	return ""
}

func articled(l Level) string {
	if l == Owner {
		return "the owner"
	}

	return "a " + l.String()
}
