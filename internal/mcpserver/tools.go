// Package mcpserver turns the command catalog into tools. The same Tools
// value backs the MCP endpoint and the built-in chat agent, so an external
// agent and the in-app one see exactly the same capabilities.
package mcpserver

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/rakunlabs/ket/internal/access"
	"github.com/rakunlabs/ket/internal/catalog"
	"github.com/rakunlabs/ket/internal/hub"
	"github.com/rakunlabs/ket/internal/store"
)

// Scope is who calls a tool. The agent works inside one project; MCP
// clients name the project in each call.
type Scope int

const (
	ScopeMCP Scope = iota
	ScopeAgent
)

// Tool is one callable tool with its JSON schema.
type Tool struct {
	Name        string
	Description string
	Schema      json.RawMessage
	// ReadOnly tools never change a document.
	ReadOnly bool
}

// Image is a PNG (or other) image a tool returns, e.g. a render.
type Image struct {
	MIME string
	Data []byte
}

// Result is a tool's answer. Text is what the model reads.
type Result struct {
	Text    string
	Images  []Image
	IsError bool
}

// Call is the context of one tool call.
type Call struct {
	// ProjectID is set by the agent; MCP calls resolve it from arguments.
	ProjectID string
	// BranchID is the branch to work on; empty = main.
	BranchID string
	Author   string
}

type Tools struct {
	cat   *catalog.Catalog
	hub   *hub.Hub
	store *store.Store

	// access checks project permissions; nil allows everything.
	access *access.Checker

	// proposals maps an MCP session to the proposal branch it works on.
	mu        sync.Mutex
	proposals map[string]string
}

func NewTools(cat *catalog.Catalog, h *hub.Hub, st *store.Store) *Tools {
	return &Tools{cat: cat, hub: h, store: st, proposals: map[string]string{}}
}

// SetAccess turns on per-project permission checks (with accounts).
func (t *Tools) SetAccess(a *access.Checker) { t.access = a }

// need checks the caller's access to a project for a tool.
func (t *Tools) need(ctx context.Context, p *store.Project, readOnly bool) (*store.Project, error) {
	if t.access == nil {
		return p, nil
	}
	level := access.Editor
	if readOnly {
		level = access.Viewer
	}

	return t.access.Need(ctx, p, level)
}

func (t *Tools) readOnly(name string) bool {
	if c, ok := t.cat.Get(name); ok {
		return c.Kind == catalog.KindQuery
	}

	return false
}

func (t *Tools) Guide() string { return t.cat.Guide }

const projectProp = "project"

// server-side tools, answered without a browser.
const (
	toolListProjects  = "list_projects"
	toolCreateProject = "create_project"
	toolOpenProject   = "open_project"
	toolCloseProject  = "close_project"
	toolUndo          = "undo"
	toolRedo          = "redo"
	toolPropose       = "start_proposal"
	toolFinish        = "finish_proposal"
)

// List returns the tools for a scope.
func (t *Tools) List(scope Scope) []Tool {
	var out []Tool

	if scope == ScopeMCP {
		out = append(out,
			Tool{
				Name:        toolListProjects,
				Description: "List projects with their id, name and whether a browser has them open (commands need the project open in Ket in a browser, because the geometry kernel runs there; open_project opens one in a tab).",
				Schema:      json.RawMessage(`{"type":"object","properties":{}}`),
				ReadOnly:    true,
			},
			Tool{
				Name:        toolCreateProject,
				Description: "Create a new empty project and open it in a tab of the user's Ket window, so modelling commands can run on it right away.",
				Schema:      json.RawMessage(`{"type":"object","properties":{"name":{"type":"string"},"description":{"type":"string"},"activate":{"type":"boolean","description":"Switch the user's window to the new tab (default true)."}},"required":["name"]}`),
			},
			Tool{
				Name:        toolOpenProject,
				Description: "Open a project in a tab of the user's Ket window (several projects can be open side by side, one tab each). Commands need the project open in a browser; this waits until the tab is ready. Commands on a closed project open it in a background tab by themselves.",
				Schema:      json.RawMessage(`{"type":"object","properties":{"project":{"type":"string","description":"Project id or name."},"activate":{"type":"boolean","description":"Switch the user's window to the tab (default true). Use false to work in the background."}},"required":["project"]}`),
				ReadOnly:    true,
			},
			Tool{
				Name:        toolCloseProject,
				Description: "Close the project's tab in the user's Ket windows when you are done with it. The design is saved; nothing is lost.",
				Schema:      json.RawMessage(`{"type":"object","properties":{"project":{"type":"string","description":"Project id or name."}},"required":["project"]}`),
				ReadOnly:    true,
			},
		)
	}

	if scope == ScopeMCP {
		out = append(out,
			Tool{
				Name:        toolPropose,
				Description: "Work on a proposal instead of the design itself: your following changes go to a new branch that the user reviews in Ket and accepts or rejects. Use it for larger changes or when the user asks for options. The open browser follows the proposal.",
				Schema:      t.schema(json.RawMessage(`{"type":"object","properties":{"name":{"type":"string","description":"Short name, e.g. \"thinner walls\""}}}`), scope),
			},
			Tool{
				Name:        toolFinish,
				Description: "Stop working on the proposal: later changes go to the design again. The proposal stays for the user to accept or reject in Ket.",
				Schema:      json.RawMessage(`{"type":"object","properties":{}}`),
			},
		)
	}

	out = append(out,
		Tool{
			Name:        toolUndo,
			Description: "Undo the last change of the project (any author).",
			Schema:      t.schema(json.RawMessage(`{"type":"object","properties":{}}`), scope),
		},
		Tool{
			Name:        toolRedo,
			Description: "Redo the last undone change of the project.",
			Schema:      t.schema(json.RawMessage(`{"type":"object","properties":{}}`), scope),
		},
	)

	for _, c := range t.cat.Commands {
		out = append(out, Tool{
			Name:        c.Name,
			Description: describe(c),
			Schema:      t.schema(c.Schema, scope),
			ReadOnly:    c.Kind == catalog.KindQuery,
		})
	}

	return out
}

func describe(c catalog.Command) string {
	if len(c.Examples) == 0 {
		return c.Description
	}

	var b strings.Builder
	b.WriteString(c.Description)
	b.WriteString("\n\nExamples:")
	for _, ex := range c.Examples {
		e, _ := json.Marshal(ex)
		b.WriteString("\n")
		b.Write(e)
	}

	return b.String()
}

// schema adds the project argument for MCP callers.
func (t *Tools) schema(raw json.RawMessage, scope Scope) json.RawMessage {
	if scope != ScopeMCP {
		return raw
	}

	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return raw
	}
	props, _ := m["properties"].(map[string]any)
	if props == nil {
		props = map[string]any{}
	}
	props[projectProp] = map[string]any{
		"type":        "string",
		"description": "Project id or name. Optional when exactly one project is open in a browser.",
	}
	m["properties"] = props
	delete(m, "$schema")

	b, err := json.Marshal(m)
	if err != nil {
		return raw
	}

	return b
}

// Call runs a tool. Failures the model can act on come back as an error
// Result, not as err.
func (t *Tools) Call(ctx context.Context, name string, args json.RawMessage, call Call) Result {
	res, err := t.call(ctx, name, args, call)
	if err != nil {
		return Result{Text: err.Error(), IsError: true}
	}

	return res
}

func (t *Tools) call(ctx context.Context, name string, args json.RawMessage, call Call) (Result, error) {
	m := map[string]json.RawMessage{}
	if len(args) > 0 && string(args) != "null" {
		if err := json.Unmarshal(args, &m); err != nil {
			return Result{}, fmt.Errorf("arguments must be a JSON object: %v", err)
		}
	}

	switch name {
	case toolListProjects:
		return t.listProjects(ctx)
	case toolCreateProject:
		var in struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			Activate    *bool  `json:"activate"`
		}
		_ = json.Unmarshal(args, &in)
		if strings.TrimSpace(in.Name) == "" {
			return Result{}, errors.New("name is required")
		}
		p, err := t.store.CreateProject(ctx, in.Name, in.Description, t.subject(ctx))
		if err != nil {
			return Result{}, err
		}
		out := map[string]any{"id": p.ID, "name": p.Name}
		if _, err := t.hub.OpenProject(ctx, t.subject(ctx), p, in.Activate == nil || *in.Activate); err != nil {
			out["note"] = "Created, but not opened: " + err.Error()
		} else {
			out["note"] = "Created and open in a tab of the user's Ket window; modelling commands can run now."
		}
		return jsonResult(out)
	case toolOpenProject, toolCloseProject:
		return t.openClose(ctx, name, args)
	}

	if name == toolFinish {
		t.mu.Lock()
		delete(t.proposals, call.Author)
		t.mu.Unlock()
		return Result{Text: "Back on the design. The proposal waits for the user in Ket."}, nil
	}

	p, err := t.project(ctx, m, call)
	if err != nil {
		return Result{}, err
	}
	if p, err = t.need(ctx, p, t.readOnly(name)); err != nil {
		return Result{}, err
	}
	delete(m, projectProp)

	// MCP sessions in proposal mode work on their branch.
	if call.BranchID == "" {
		t.mu.Lock()
		if b, ok := t.proposals[call.Author]; ok {
			call.BranchID = b
		}
		t.mu.Unlock()
		if call.BranchID != "" {
			if br, err := t.store.GetBranch(ctx, call.BranchID); err != nil || br.ProjectID != p.ID {
				// Accepted, rejected or another project: back to main.
				t.mu.Lock()
				delete(t.proposals, call.Author)
				t.mu.Unlock()
				call.BranchID = ""
			}
		}
	}

	if name == toolPropose {
		var in struct {
			Name string `json:"name"`
		}
		_ = json.Unmarshal(args, &in)
		label := strings.TrimSpace(in.Name)
		if label == "" {
			label = "proposal"
		}
		b, err := t.store.CreateBranch(ctx, p.MainBranch, fmt.Sprintf("%s-%d", label, time.Now().Unix()))
		if err != nil {
			return Result{}, err
		}
		t.mu.Lock()
		t.proposals[call.Author] = b.ID
		t.mu.Unlock()
		t.hub.Notify(ctx, p.ID, map[string]any{"t": "branch", "event": "proposed", "branch": b.ID, "name": b.Name})
		return jsonResult(map[string]any{"branch": b.Name, "note": "Your changes now go to this proposal. The user's browser switches to it; call finish_proposal when done."})
	}

	switch name {
	case toolUndo, toolRedo:
		var st store.BranchState
		if name == toolUndo {
			st, err = t.hub.Undo(ctx, p, call.BranchID)
		} else {
			st, err = t.hub.Redo(ctx, p, call.BranchID)
		}
		if err != nil {
			return Result{}, err
		}
		return jsonResult(map[string]any{"ok": true, "head": st.Head, "redo_available": st.Top > st.Head})
	}

	if _, ok := t.cat.Get(name); !ok {
		return Result{}, fmt.Errorf("unknown tool %q", name)
	}

	clean, err := json.Marshal(m)
	if err != nil {
		return Result{}, err
	}

	t.hub.Activity(ctx, p.ID, call.Author, name)

	out, err := t.hub.Call(ctx, p, call.BranchID, name, clean, call.Author)
	if errors.Is(err, hub.ErrNoSession) && call.ProjectID == "" {
		// An MCP client named a closed project: open it in a background tab
		// of the user's window and run the command there.
		if _, oerr := t.hub.OpenProject(ctx, t.subject(ctx), p, false); oerr == nil {
			out, err = t.hub.Call(ctx, p, call.BranchID, name, clean, call.Author)
		}
	}
	if err != nil {
		var cmdErr *hub.CommandError
		if errors.As(err, &cmdErr) {
			res := Result{IsError: true, Text: cmdErr.Message}
			if len(cmdErr.Detail) > 0 && string(cmdErr.Detail) != "null" {
				detail := toResult(cmdErr.Detail)
				res.Images = detail.Images
				res.Text = strings.TrimSpace(cmdErr.Message + "\n" + detail.Text)
			}
			return res, nil
		}
		return Result{}, err
	}

	return toResult(out), nil
}

func (t *Tools) project(ctx context.Context, m map[string]json.RawMessage, call Call) (*store.Project, error) {
	if call.ProjectID != "" {
		return t.store.GetProject(ctx, call.ProjectID)
	}

	var ref string
	if raw, ok := m[projectProp]; ok {
		_ = json.Unmarshal(raw, &ref)
	}
	if ref != "" {
		return t.store.FindProject(ctx, ref)
	}

	list := t.store.ListProjects
	if t.access != nil {
		list = t.access.Visible
	}
	projects, err := list(ctx)
	if err != nil {
		return nil, err
	}
	var open []*store.Project
	for _, p := range projects {
		if t.hub.Sessions(p.ID) > 0 {
			open = append(open, p)
		}
	}
	switch len(open) {
	case 1:
		return open[0], nil
	case 0:
		return nil, errors.New("no project is open in a browser; pass project (see list_projects) or call open_project")
	default:
		names := make([]string, 0, len(open))
		for _, p := range open {
			names = append(names, fmt.Sprintf("%q (%s)", p.Name, p.ID))
		}
		slices.Sort(names)
		return nil, fmt.Errorf("several projects are open, pass project: one of %s", strings.Join(names, ", "))
	}
}

// subject is the signed-in user the call acts for, "" without accounts.
func (t *Tools) subject(ctx context.Context) string {
	if t.access == nil {
		return ""
	}

	return t.access.Subject(ctx)
}

func (t *Tools) openClose(ctx context.Context, name string, args json.RawMessage) (Result, error) {
	var in struct {
		Project  string `json:"project"`
		Activate *bool  `json:"activate"`
	}
	_ = json.Unmarshal(args, &in)
	if strings.TrimSpace(in.Project) == "" {
		return Result{}, errors.New("project is required: an id or name from list_projects")
	}
	p, err := t.store.FindProject(ctx, in.Project)
	if err != nil {
		return Result{}, err
	}
	if p, err = t.need(ctx, p, true); err != nil {
		return Result{}, err
	}

	if name == toolCloseProject {
		if err := t.hub.CloseProject(ctx, t.subject(ctx), p.ID); err != nil {
			return Result{}, err
		}
		return jsonResult(map[string]any{"ok": true, "project": p.Name, "note": "The tab is closed; the design is saved."})
	}

	was, err := t.hub.OpenProject(ctx, t.subject(ctx), p, in.Activate == nil || *in.Activate)
	if err != nil {
		return Result{}, err
	}
	note := "Opened in a new tab; commands can run on it now."
	if was {
		note = "Already open in a browser; commands can run on it now."
	}

	return jsonResult(map[string]any{"ok": true, "id": p.ID, "project": p.Name, "note": note})
}

func (t *Tools) listProjects(ctx context.Context) (Result, error) {
	list := t.store.ListProjects
	if t.access != nil {
		list = t.access.Visible
	}
	projects, err := list(ctx)
	if err != nil {
		return Result{}, err
	}

	type item struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Open    bool   `json:"open_in_browser"`
		Changes int64  `json:"changes"`
		Access  string `json:"access,omitempty"`
	}
	out := make([]item, 0, len(projects))
	for _, p := range projects {
		out = append(out, item{ID: p.ID, Name: p.Name, Open: t.hub.Sessions(p.ID) > 0, Changes: p.Head, Access: p.Access})
	}

	return jsonResult(out)
}

func jsonResult(v any) (Result, error) {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return Result{}, err
	}

	return Result{Text: string(b)}, nil
}

// toResult converts a browser answer to a Result. Images come as
// {"images":[{"mime":"image/png","data":"<base64>"}]} and are lifted out of
// the text so the model gets them as real images.
func toResult(raw json.RawMessage) Result {
	if len(raw) == 0 || string(raw) == "null" {
		return Result{Text: "ok"}
	}

	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return Result{Text: string(raw)}
	}

	var res Result
	if imgs, ok := m["images"]; ok {
		var list []struct {
			MIME string `json:"mime"`
			Data string `json:"data"`
		}
		if err := json.Unmarshal(imgs, &list); err == nil {
			for _, img := range list {
				data, err := base64.StdEncoding.DecodeString(img.Data)
				if err != nil {
					continue
				}
				res.Images = append(res.Images, Image{MIME: img.MIME, Data: data})
			}
			delete(m, "images")
		}
	}

	if text, ok := m["text"]; ok && len(m) == 1 {
		var s string
		if json.Unmarshal(text, &s) == nil {
			res.Text = s
			return res
		}
	}

	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		res.Text = string(raw)
		return res
	}
	res.Text = string(b)

	return res
}
