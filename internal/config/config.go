package config

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/rakunlabs/chu"
	"github.com/rakunlabs/chu/loader/loaderenv"
	"github.com/rakunlabs/logi"

	"github.com/rakunlabs/ket/internal/auth/users"
)

const ServiceName = "ket"

// Build facts, set by the linker (see the Makefile):
// -X github.com/rakunlabs/ket/internal/config.Version=v1.2.3.
var (
	Version   = "v0.0.0"
	Commit    = "-"
	BuildDate = "-"
)

// Repository is where Ket's source lives.
const Repository = "https://github.com/rakunlabs/ket"

// Config is infrastructure only: where the database is and how the server
// listens. Everything else (AI providers, sign-up, the autorouter, users)
// is set by an administrator in the UI and stored in the database.
type Config struct {
	LogLevel string `cfg:"log_level" default:"info"`

	Server Server `cfg:"server"`
	Store  Store  `cfg:"store"`
	Hub    Hub    `cfg:"hub"`

	// Legacy sections, read once to seed the admin settings on first
	// start; ignored afterwards.
	AI  LegacyAI  `cfg:"ai"`
	PCB LegacyPCB `cfg:"pcb"`
}

// Roles and permissions:
//
//	projects:read   open projects, read the design, render, export
//	projects:write  create, edit, delete projects; run commands over MCP
//	ai:use          use the built-in assistant (costs API tokens)
//	users:*         manage accounts (admin)
//	settings:*      edit the admin settings (admin)
var DefaultRoles = []users.Role{
	{Name: "admin", Description: "Everything, including users and settings", Permissions: []string{"*"}},
	{Name: "editor", Description: "Edits projects and uses the assistant", Permissions: []string{"projects:*", "ai:use"}},
	{Name: "viewer", Description: "Opens projects read-only", Permissions: []string{"projects:read"}},
}

type Server struct {
	Host     string `cfg:"host"`
	Port     string `cfg:"port" default:"8080"`
	BasePath string `cfg:"base_path"`
}

type Store struct {
	Postgres Postgres `cfg:"postgres"`
}

type Postgres struct {
	DSN          string        `cfg:"dsn" default:"postgres://ket:ket@localhost:5432/ket?sslmode=disable" log:"-"`
	MaxOpenConns int           `cfg:"max_open_conns" default:"10"`
	MaxIdleConns int           `cfg:"max_idle_conns" default:"5"`
	ConnMaxLife  time.Duration `cfg:"conn_max_life" default:"30m"`
	// Migrate runs the embedded migrations at start.
	Migrate bool `cfg:"migrate" default:"true"`
}

// Hub relays commands from MCP and the agent to the browser that has the
// project open.
type Hub struct {
	// CallTimeout bounds one command round trip to the browser.
	CallTimeout time.Duration `cfg:"call_timeout" default:"60s"`
}

type LegacyAI struct {
	Providers []LegacyProvider `cfg:"providers"`
	MaxSteps  int              `cfg:"max_steps"`
}

type LegacyProvider struct {
	Name        string  `cfg:"name"`
	BaseURL     string  `cfg:"base_url"`
	APIKey      string  `cfg:"api_key" log:"-"`
	Model       string  `cfg:"model"`
	Vision      bool    `cfg:"vision"`
	Temperature float64 `cfg:"temperature"`
}

type LegacyPCB struct {
	FreeroutingJar string `cfg:"freerouting_jar"`
	Java           string `cfg:"java"`
}

func Load(ctx context.Context) (*Config, error) {
	var cfg Config
	if err := chu.Load(ctx, ServiceName, &cfg,
		chu.WithLoaderOption(loaderenv.New(
			loaderenv.WithPrefix("KET_"),
		)),
		chu.WithVersion(Version),
	); err != nil {
		return nil, fmt.Errorf("load config; %w", err)
	}

	if err := logi.SetLogLevel(cfg.LogLevel); err != nil {
		return nil, fmt.Errorf("set log level %s; %w", cfg.LogLevel, err)
	}

	if err := cfg.prepare(); err != nil {
		return nil, fmt.Errorf("check config; %w", err)
	}

	slog.Info("loaded configuration", "config", chu.MarshalMap(cfg))

	return &cfg, nil
}

func (c *Config) prepare() error {
	if c.Hub.CallTimeout <= 0 {
		c.Hub.CallTimeout = 60 * time.Second
	}
	c.Server.BasePath = strings.TrimRight(c.Server.BasePath, "/")

	return nil
}
