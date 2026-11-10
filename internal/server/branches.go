package server

import (
	"errors"
	"net/http"

	"github.com/rakunlabs/ada"

	"github.com/rakunlabs/ket/internal/access"
	"github.com/rakunlabs/ket/internal/store"
)

func (s *Server) listBranches(c *ada.Context) error {
	p, err := s.access.Project(c.Request.Context(), c.Request.PathValue("id"), access.Viewer)
	if err != nil {
		return httpErr(err)
	}
	list, err := s.Store.Branches(c.Request.Context(), p.ID)
	if err != nil {
		return httpErr(err)
	}

	return c.SendJSON(list)
}

// branchOps returns a branch's ops, for the review diff.
func (s *Server) branchOps(c *ada.Context) error {
	ctx := c.Request.Context()
	b, err := s.branch(c, access.Viewer)
	if err != nil {
		return httpErr(err)
	}
	st, err := s.Store.BranchState(ctx, b.ID)
	if err != nil {
		return httpErr(err)
	}
	ops, err := s.Store.Ops(ctx, b.ID, 0, st.Top)
	if err != nil {
		return err
	}

	return c.SendJSON(map[string]any{"branch": b, "head": st.Head, "top": st.Top, "ops": ops})
}

// acceptBranch merges a proposal into main and tells every open tab.
func (s *Server) acceptBranch(c *ada.Context) error {
	ctx := c.Request.Context()
	b, err := s.branch(c, access.Editor)
	if err != nil {
		return httpErr(err)
	}
	if b.ParentID == nil {
		return ada.NewHTTPError(http.StatusBadRequest, "main cannot be accepted")
	}

	head, err := s.Store.MergeBranch(ctx, b.ID)
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			return ada.WrapHTTPError(http.StatusConflict, err)
		}
		return httpErr(err)
	}
	s.detachConversations(c, b)
	s.Hub.Notify(ctx, b.ProjectID, map[string]any{"t": "branch", "event": "accepted", "branch": b.ID, "head": head})

	return c.SendJSON(map[string]any{"head": head})
}

func (s *Server) rejectBranch(c *ada.Context) error {
	ctx := c.Request.Context()
	b, err := s.branch(c, access.Editor)
	if err != nil {
		return httpErr(err)
	}
	if b.ParentID == nil {
		return ada.NewHTTPError(http.StatusBadRequest, "main cannot be rejected")
	}
	if err := s.Store.DeleteBranch(ctx, b.ID); err != nil {
		return httpErr(err)
	}
	s.detachConversations(c, b)
	s.Hub.Notify(ctx, b.ProjectID, map[string]any{"t": "branch", "event": "rejected", "branch": b.ID})

	return c.SendNoContent()
}

// detachConversations points conversations that worked on b back at main,
// so the next proposal starts fresh.
func (s *Server) detachConversations(c *ada.Context, b *store.Branch) {
	convs, err := s.Store.ListConversations(c.Request.Context(), b.ProjectID)
	if err != nil {
		return
	}
	for _, conv := range convs {
		if conv.BranchID != nil && *conv.BranchID == b.ID {
			_ = s.Store.SetConversationBranch(c.Request.Context(), conv.ID, "")
		}
	}
}

// branch loads the branch in the path and checks access to its project.
func (s *Server) branch(c *ada.Context, level access.Level) (*store.Branch, error) {
	ctx := c.Request.Context()
	b, err := s.Store.GetBranch(ctx, c.Request.PathValue("id"))
	if err != nil {
		return nil, err
	}
	if _, err := s.access.Project(ctx, b.ProjectID, level); err != nil {
		return nil, err
	}

	return b, nil
}
