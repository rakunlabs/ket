package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"strings"

	"github.com/rakunlabs/into"
	"github.com/rakunlabs/logi"

	"github.com/rakunlabs/ket/internal/agent"
	"github.com/rakunlabs/ket/internal/catalog"
	"github.com/rakunlabs/ket/internal/config"
	"github.com/rakunlabs/ket/internal/hub"
	"github.com/rakunlabs/ket/internal/mcpserver"
	"github.com/rakunlabs/ket/internal/parts"
	"github.com/rakunlabs/ket/internal/server"
	"github.com/rakunlabs/ket/internal/settings"
	"github.com/rakunlabs/ket/internal/store"
)

func main() {
	into.Init(run,
		into.WithLogger(logi.InitializeLog(logi.WithCaller(false))),
		into.WithMsgf("%s version:[%s] commit:[%s] date:[%s]", config.ServiceName, config.Version, config.Commit, config.BuildDate),
	)
}

func run(ctx context.Context) error {
	cfg, err := config.Load(ctx)
	if err != nil {
		return err
	}

	cat, err := catalog.Load()
	if err != nil {
		return fmt.Errorf("load command catalog; %w", err)
	}

	st, err := store.New(ctx, cfg.Store)
	if err != nil {
		return fmt.Errorf("init store; %w", err)
	}
	defer st.Close()

	set, err := settings.Load(ctx, st, legacySettings(cfg))
	if err != nil {
		return fmt.Errorf("load settings; %w", err)
	}

	h := hub.New(st, cfg.Hub)
	tools := mcpserver.NewTools(cat, h, st)
	tickets := parts.NewTickets()
	tools.SetUploads(tickets, func(ctx context.Context) string {
		// The server's address as the MCP client used it (the public URL setting wins there);
		// the built-in agent runs in the server and has no request: the public URL or localhost.
		if u := mcpserver.BaseFromContext(ctx); u != "" {
			return u
		}
		if u := strings.TrimRight(set.Get().PublicURL, "/"); u != "" {
			return u
		}
		return "http://localhost:" + cfg.Server.Port + cfg.Server.BasePath
	})
	ag := agent.New(set, tools, st)
	ag.OnBranch = func(ctx context.Context, projectID string, b *store.Branch) {
		h.Notify(ctx, projectID, map[string]any{"t": "branch", "event": "proposed", "branch": b.ID, "name": b.Name})
	}

	ui, err := server.UI()
	if err != nil {
		return fmt.Errorf("load ui; %w", err)
	}
	if cfg.Server.UIDir != "" {
		ui = os.DirFS(cfg.Server.UIDir)
		slog.Info("serving the UI from disk", "dir", cfg.Server.UIDir)
	}
	h.Build = server.UIBuild(ui)
	// From disk, the build changes under a running server.
	if cfg.Server.UIDir != "" {
		h.BuildFn = func() string { return server.UIBuild(ui) }
	}

	if err := server.Start(ctx, cfg, server.Deps{
		Store:    st,
		Hub:      h,
		Tools:    tools,
		Agent:    ag,
		Catalog:  cat,
		Parts:    parts.New(st),
		Tickets:  tickets,
		Settings: set,
		UI:       ui,
	}); err != nil {
		return fmt.Errorf("start server; %w", err)
	}

	return nil
}

// legacySettings turns the ai and pcb sections of an old config file into
// the first admin settings. They are read once, when the database has no
// settings yet; afterwards the admin page is the only place to change them.
func legacySettings(cfg *config.Config) settings.Settings {
	seed := settings.Settings{MaxSteps: cfg.AI.MaxSteps}
	for _, p := range cfg.AI.Providers {
		seed.Providers = append(seed.Providers, settings.Provider{
			Name: p.Name, BaseURL: p.BaseURL, APIKey: p.APIKey, Model: p.Model, Vision: p.Vision, Temperature: p.Temperature,
		})
	}

	return seed
}
