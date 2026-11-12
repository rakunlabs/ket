package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
)

// Core mode (/mcp?tools=core): a short list of tools for clients that pay
// for every tool definition in their context. The everyday commands stay as
// tools; every other command is reached with find_commands (search by text
// or group, with schemas) and run_command. Calls behave exactly as when the
// command is a tool of its own.

const (
	toolFindCommands = "find_commands"
	toolRunCommand   = "run_command"
)

// coreCommands are offered as tools of their own in core mode.
var coreCommands = map[string]bool{
	// read and verify
	"get_document": true, "get_problems": true, "run_checks": true, "render": true, "measure": true, "list_faces": true, "list_edges": true, "section": true,
	// model
	"set_parameters": true, "set_checks": true, "box": true, "cylinder": true, "sketch": true, "add_to_sketch": true, "solve_sketch": true, "extrude": true, "boolean": true, "fillet": true, "shell": true, "transform": true, "update_feature": true, "delete_features": true, "batch": true,
	// board
	"set_board": true, "find_parts": true, "add_component": true, "connect": true, "autoroute": true, "get_board": true, "run_drc": true, "render_board": true,
}

// CoreTools is the tool list of core mode: projects, proposals, the core
// commands and the two that reach the rest.
func (t *Tools) CoreTools() []Tool {
	all := t.List(ScopeMCP)
	commands := map[string]bool{}
	for _, c := range t.cat.Commands {
		commands[c.Name] = true
	}
	out := []Tool{}
	for _, tool := range all {
		// Server tools (projects, proposals, uploads, undo) and the core commands.
		if !commands[tool.Name] || coreCommands[tool.Name] {
			out = append(out, tool)
		}
	}
	groups := map[string]bool{}
	for _, c := range t.cat.Commands {
		groups[c.Group] = true
	}
	names := make([]string, 0, len(groups))
	for g := range groups {
		names = append(names, g)
	}
	sort.Strings(names)
	out = append(out,
		Tool{
			Name: toolFindCommands,
			Description: fmt.Sprintf("Find Ket commands that are not listed as tools here (%d more: gears, motion, materials, mechanical features, drawings, keep-outs, stackups, pairs, KiCad, panels, ...). Search by words and/or group (%s); returns each command's name, description and, with schema: true, its argument schema. Then call it with run_command.", len(t.cat.Commands)-len(coreCommands), strings.Join(names, ", ")),
			Schema:      json.RawMessage(`{"type":"object","properties":{"query":{"type":"string","description":"Words to look for in names and descriptions, e.g. \"countersunk hole\""},"group":{"type":"string"},"schema":{"type":"boolean","description":"Include the argument schemas (default true when at most 5 match)"},"limit":{"type":"integer","minimum":1,"maximum":50}}}`),
			ReadOnly:    true,
		},
		Tool{
			Name:        toolRunCommand,
			Description: "Run any Ket command by name with its arguments (as find_commands describes them). Same result as calling the command as a tool, including project (id or name).",
			Schema:      json.RawMessage(`{"type":"object","properties":{"command":{"type":"string"},"args":{"type":"object","description":"The command's arguments; include project when more than one is open"}},"required":["command"]}`),
		},
	)

	return out
}

// findCommands ranks commands by how many query words their name and description contain.
func (t *Tools) findCommands(args json.RawMessage) (Result, error) {
	var in struct {
		Query  string `json:"query"`
		Group  string `json:"group"`
		Schema *bool  `json:"schema"`
		Limit  int    `json:"limit"`
	}
	_ = json.Unmarshal(args, &in)
	if in.Limit <= 0 || in.Limit > 50 {
		in.Limit = 10
	}
	words := strings.Fields(strings.ToLower(in.Query))
	type hit struct {
		score int
		i     int
	}
	var hits []hit
	for i, c := range t.cat.Commands {
		if in.Group != "" && c.Group != in.Group {
			continue
		}
		text := strings.ToLower(c.Name + " " + strings.ReplaceAll(c.Name, "_", " ") + " " + c.Description)
		score := 0
		for _, w := range words {
			if strings.Contains(strings.ToLower(c.Name), w) {
				score += 3
			} else if strings.Contains(text, w) {
				score++
			}
		}
		if len(words) > 0 && score == 0 {
			continue
		}
		hits = append(hits, hit{score, i})
	}
	if len(hits) == 0 {
		return Result{}, errors.New("no command matches; try fewer or other words, or a group")
	}
	sort.SliceStable(hits, func(a, b int) bool { return hits[a].score > hits[b].score })
	if len(hits) > in.Limit {
		hits = hits[:in.Limit]
	}
	withSchema := len(hits) <= 5
	if in.Schema != nil {
		withSchema = *in.Schema
	}
	out := make([]map[string]any, 0, len(hits))
	for _, h := range hits {
		c := t.cat.Commands[h.i]
		m := map[string]any{"name": c.Name, "group": c.Group, "kind": string(c.Kind), "description": c.Description, "tool": coreCommands[c.Name]}
		if withSchema {
			m["schema"] = json.RawMessage(t.schema(c.Schema, ScopeMCP))
			if len(c.Examples) > 0 {
				m["examples"] = c.Examples
			}
		}
		out = append(out, m)
	}

	return jsonResult(map[string]any{"commands": out})
}

// runCommand calls a command by name with its arguments.
func (t *Tools) runCommand(ctx context.Context, args json.RawMessage, call Call) (Result, error) {
	var in struct {
		Command string          `json:"command"`
		Args    json.RawMessage `json:"args"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return Result{}, fmt.Errorf("arguments must be {command, args}: %v", err)
	}
	if in.Command == toolRunCommand || in.Command == toolFindCommands {
		return Result{}, errors.New("run_command runs Ket commands, not itself")
	}
	known := false
	for _, tool := range t.List(ScopeMCP) {
		if tool.Name == in.Command {
			known = true
			break
		}
	}
	if !known {
		return Result{}, fmt.Errorf("no command %q; find_commands lists them", in.Command)
	}
	if len(in.Args) == 0 {
		in.Args = json.RawMessage(`{}`)
	}

	return t.call(ctx, in.Command, in.Args, call)
}
