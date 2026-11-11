package mcpserver

import (
	"encoding/json"
	"testing"

	"github.com/rakunlabs/ket/internal/catalog"
)

func TestToolsFromCatalog(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cat.Commands) == 0 {
		t.Skip("catalog.json is empty: run `make gen`")
	}

	tools := NewTools(cat, nil, nil)

	mcp := tools.List(ScopeMCP)
	agent := tools.List(ScopeAgent)
	if len(mcp) != len(agent)+7 {
		t.Fatalf("MCP has %d tools, agent %d: MCP should add list_projects, create_project, open_project, close_project, reload_ui, start_proposal and finish_proposal", len(mcp), len(agent))
	}

	for _, tool := range mcp {
		var s map[string]any
		if err := json.Unmarshal(tool.Schema, &s); err != nil {
			t.Fatalf("%s: schema is not JSON: %v", tool.Name, err)
		}
		if s["type"] != "object" {
			t.Errorf("%s: schema type = %v, want object", tool.Name, s["type"])
		}
		if tool.Name == toolListProjects || tool.Name == toolCreateProject || tool.Name == toolFinish || tool.Name == toolOpenProject || tool.Name == toolCloseProject || tool.Name == toolReload {
			continue
		}
		props, _ := s["properties"].(map[string]any)
		if _, ok := props[projectProp]; !ok {
			t.Errorf("%s: MCP schema lacks the project argument", tool.Name)
		}
	}

	for _, tool := range agent {
		var s map[string]any
		_ = json.Unmarshal(tool.Schema, &s)
		props, _ := s["properties"].(map[string]any)
		if _, ok := props[projectProp]; ok {
			t.Errorf("%s: agent schema must not have the project argument", tool.Name)
		}
	}
}

func TestToResultLiftsImages(t *testing.T) {
	res := toResult(json.RawMessage(`{"text":"two views","images":[{"mime":"image/png","data":"aGVsbG8="}]}`))
	if res.Text != "two views" {
		t.Errorf("text = %q", res.Text)
	}
	if len(res.Images) != 1 || string(res.Images[0].Data) != "hello" {
		t.Errorf("images = %+v", res.Images)
	}
}
