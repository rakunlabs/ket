// Package catalog holds the command catalog generated from the UI engine
// (_ui/scripts/gen-catalog.ts). It is the single source of truth for the
// tools MCP and the built-in agent expose: every command the browser can run
// is described here with its JSON schema.
package catalog

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

//go:embed catalog.json
var raw []byte

// Kind tells how a command is used.
//   - mutate: changes the document; recorded in the op log.
//   - query:  reads the document or the model; never recorded.
type Kind string

const (
	KindMutate Kind = "mutate"
	KindQuery  Kind = "query"
)

type Command struct {
	Name        string          `json:"name"`
	Group       string          `json:"group"`
	Kind        Kind            `json:"kind"`
	Description string          `json:"description"`
	Schema      json.RawMessage `json:"schema"`
	Examples    []any           `json:"examples,omitempty"`
}

type Catalog struct {
	Version  string    `json:"version"`
	Guide    string    `json:"guide"`
	Commands []Command `json:"commands"`

	byName map[string]*Command
}

func Load() (*Catalog, error) {
	return Parse(raw)
}

func Parse(data []byte) (*Catalog, error) {
	var c Catalog
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("parse catalog; %w", err)
	}

	c.byName = make(map[string]*Command, len(c.Commands))
	for i := range c.Commands {
		cmd := &c.Commands[i]
		if cmd.Kind != KindMutate && cmd.Kind != KindQuery {
			return nil, fmt.Errorf("command %s: unknown kind %q", cmd.Name, cmd.Kind)
		}
		if len(cmd.Schema) == 0 {
			cmd.Schema = json.RawMessage(`{"type":"object"}`)
		}
		c.byName[cmd.Name] = cmd
	}

	return &c, nil
}

func (c *Catalog) Get(name string) (*Command, bool) {
	cmd, ok := c.byName[name]

	return cmd, ok
}

// Raw returns the catalog JSON as embedded, for the UI.
func Raw() []byte {
	return raw
}
