package mcpserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/rakunlabs/ket/internal/catalog"
)

func TestCoreTools(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	tools := NewTools(cat, nil, nil)
	full := tools.List(ScopeMCP)
	core := tools.CoreTools()
	if len(core) >= len(full)/2 {
		t.Fatalf("core mode has %d tools of %d: it should be much shorter", len(core), len(full))
	}
	names := map[string]bool{}
	for _, c := range core {
		names[c.Name] = true
	}
	for _, want := range []string{"get_document", "box", "autoroute", "list_projects", "start_proposal", toolFindCommands, toolRunCommand} {
		if !names[want] {
			t.Errorf("core mode lacks %s", want)
		}
	}
	for name := range coreCommands {
		if _, ok := cat.Get(name); !ok {
			t.Errorf("core command %s is not in the catalog", name)
		}
	}
	if names["gear"] {
		t.Error("gear should be found, not listed")
	}
}

func TestFindCommands(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	tools := NewTools(cat, nil, nil)
	r, err := tools.findCommands(json.RawMessage(`{"query":"countersink screw hole","schema":true}`))
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		Commands []struct {
			Name   string          `json:"name"`
			Schema json.RawMessage `json:"schema"`
		} `json:"commands"`
	}
	if err := json.Unmarshal([]byte(r.Text), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Commands) == 0 || out.Commands[0].Name != "hole" {
		t.Fatalf("first hit = %+v, want hole", out.Commands)
	}
	if !strings.Contains(string(out.Commands[0].Schema), `"project"`) {
		t.Error("the schema should carry the project argument as MCP tools do")
	}
	r, err = tools.findCommands(json.RawMessage(`{"group":"motion"}`))
	if err != nil || !strings.Contains(r.Text, "set_motion") {
		t.Fatalf("by group: %v %s", err, r.Text)
	}
	if _, err := tools.findCommands(json.RawMessage(`{"query":"zzzz qqqq"}`)); err == nil {
		t.Error("no match should say so")
	}
	if _, err := tools.runCommand(context.Background(), json.RawMessage(`{"command":"no_such"}`), Call{}); err == nil || !strings.Contains(err.Error(), "find_commands") {
		t.Errorf("unknown command: %v", err)
	}
}

// The core list is served at /mcp?tools=core; the full list stays the default.
func TestHandlerServesCoreMode(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	tools := NewTools(cat, nil, nil)
	srv := httptest.NewServer(tools.Handler(func(*http.Request) string { return "" }))
	defer srv.Close()

	count := func(url string) int {
		c := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil)
		s, err := c.Connect(context.Background(), &mcp.StreamableClientTransport{Endpoint: url}, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close() //nolint:errcheck // test cleanup
		r, err := s.ListTools(context.Background(), nil)
		if err != nil {
			t.Fatal(err)
		}
		return len(r.Tools)
	}
	full := count(srv.URL)
	core := count(srv.URL + "?tools=core")
	if core >= full/2 || core < 20 {
		t.Fatalf("full %d tools, core %d", full, core)
	}
}
