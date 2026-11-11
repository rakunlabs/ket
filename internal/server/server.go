package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"

	"github.com/rakunlabs/ada"
	"github.com/rakunlabs/ada/handler/folder"
	"github.com/rakunlabs/ada/middleware/auth/authz"
	mencoding "github.com/rakunlabs/ada/middleware/encoding"
	mlog "github.com/rakunlabs/ada/middleware/log"
	mrecover "github.com/rakunlabs/ada/middleware/recover"
	mrequestid "github.com/rakunlabs/ada/middleware/requestid"
	mserver "github.com/rakunlabs/ada/middleware/server"

	"github.com/rakunlabs/ket/internal/access"
	"github.com/rakunlabs/ket/internal/agent"
	"github.com/rakunlabs/ket/internal/auth/users"
	"github.com/rakunlabs/ket/internal/catalog"
	"github.com/rakunlabs/ket/internal/config"
	"github.com/rakunlabs/ket/internal/hub"
	"github.com/rakunlabs/ket/internal/mcpserver"
	"github.com/rakunlabs/ket/internal/parts"
	"github.com/rakunlabs/ket/internal/settings"
	"github.com/rakunlabs/ket/internal/sso"
	"github.com/rakunlabs/ket/internal/store"
	authstore "github.com/rakunlabs/ket/internal/store/auth"
)

const apiPrefix = "/api/v1"

type Deps struct {
	Store   *store.Store
	Hub     *hub.Hub
	Tools   *mcpserver.Tools
	Agent   *agent.Agent
	Catalog *catalog.Catalog
	Parts   *parts.Service
	// Settings are what an administrator edits in the UI.
	Settings *settings.Service
	// UI is nil when only the placeholder was embedded.
	UI fs.FS
}

type Server struct {
	cfg *config.Config
	Deps
	guard guard
	// access checks per-project permissions; without accounts it allows
	// everything.
	access *access.Checker
	// sso signs people in through OAuth2 / OIDC providers.
	sso *sso.Manager
}

func Start(ctx context.Context, cfg *config.Config, deps Deps) error {
	s := &Server{cfg: cfg, Deps: deps}

	kit, ast, err := s.setupAuth(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = kit.Close() }()
	s.guard = guard{kit: kit}
	s.access = access.New(s.Store, kit.Users)
	s.Tools.SetAccess(s.access)

	srv, err := s.build(ast)
	if err != nil {
		return err
	}

	return srv.StartWithContext(ctx, cfg.Server.Host+":"+cfg.Server.Port)
}

func (s *Server) build(ast *authstore.Store) (*ada.Server, error) {
	srv := ada.New()
	srv.Use(
		mrecover.Middleware(),
		mserver.Middleware(config.ServiceName),
		mrequestid.Middleware(),
		mlog.Middleware(mlog.WithSkipper(func(r *http.Request) bool {
			return r.URL.Path == "/healthz"
		})),
	)

	srv.GET("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("OK"))
	})

	base := s.cfg.Server.BasePath
	root := srv.Group(base)
	g := s.guard

	// Login page, OAuth server and discovery, /api/account and the user
	// admin API at /api/admin/users.
	g.kit.Mount(srv.Mux)
	mountBrand(root)

	// MCP and the websocket stream; keep them out of the compressing group.
	// MCP needs a token with the mcp scope (OAuth or a personal token).
	mcpHandler := s.Tools.Handler()
	mcpGuard := append(g.with(permWrite), authz.RequireScope("mcp"))
	root.HandleWildcard("/mcp", mcpHandler, mcpGuard...)
	root.HandleFunc("/mcp", mcpHandler.ServeHTTP, mcpGuard...)
	root.HandleFunc(apiPrefix+"/projects/{id}/ws", s.websocket, g.with(permRead)...)
	root.HandleFunc(apiPrefix+"/app/ws", s.appWebsocket, g.with(permRead)...)
	root.HandleFunc(apiPrefix+"/conversations/{id}/messages", s.chat, g.with(permAI)...)

	// /info is public: the version and the MCP address.
	root.GET(apiPrefix+"/info", s.info)
	// Testing a provider can take a while; outside the compressing group.
	root.POST(apiPrefix+"/settings/test-provider", s.testProvider, g.with(permSettings)...)

	api := root.Group(apiPrefix, append([]func(http.Handler) http.Handler{mencoding.Middleware()}, g.api()...)...)
	s.routes(api)

	{
		tokens := &tokenAPI{oauth: g.kit.OAuth, store: ast}
		api.GET("/tokens", tokens.list)
		// Only a signed-in browser may mint or revoke tokens, not a token.
		api.POST("/tokens", tokens.create, users.SessionOnly())
		api.DELETE("/tokens/{id}", tokens.remove, users.SessionOnly())
	}

	if err := mountUI(root, base, s.UI); err != nil {
		return nil, err
	}

	return srv, nil
}

func (s *Server) routes(api *ada.Mux) {
	read, write, ai := s.guard.can(permRead), s.guard.can(permWrite), s.guard.can(permAI)

	api.GET("/me", s.me)
	api.GET("/providers", s.providers, s.guard.can(permAI))
	api.GET("/settings", s.getSettings, s.guard.can(permSettings))
	api.PUT("/settings", s.putSettings, s.guard.can(permSettings))
	api.GET("/catalog", s.catalog, read)

	api.GET("/projects", s.listProjects, read)
	api.POST("/projects", s.createProject, write)
	api.GET("/projects/{id}", s.getProject, read)
	api.PATCH("/projects/{id}", s.updateProject, write)
	api.DELETE("/projects/{id}", s.deleteProject, write)
	api.GET("/projects/{id}/ops", s.listOps, read)

	api.GET("/projects/{id}/members", s.listMembers, read)
	api.PUT("/projects/{id}/members/{user}", s.setMember, write)
	api.DELETE("/projects/{id}/members/{user}", s.removeMember, write)
	api.GET("/users", s.listUsers, read)
	api.PUT("/projects/{id}/groups/{group}", s.setProjectGroup, write)
	api.DELETE("/projects/{id}/groups/{group}", s.removeProjectGroup, write)
	api.GET("/groups", s.listGroups, read)

	// Administration: groups, SSO providers, a user's groups and links.
	usersRead, usersWrite := s.guard.can(users.PermUsersRead), s.guard.can(users.PermUsersWrite)
	api.POST("/groups", s.saveGroup, usersWrite)
	api.PUT("/groups/{id}", s.saveGroup, usersWrite)
	api.DELETE("/groups/{id}", s.deleteGroup, usersWrite)
	api.GET("/admin/users/{user}/access", s.userAccess, usersRead)
	api.PUT("/admin/users/{user}/groups", s.setUserGroups, usersWrite)
	api.POST("/admin/users/{user}/unlink", s.unlinkIdentity, usersWrite)
	api.GET("/settings/sso", s.listSSO, s.guard.can(permSettings))
	api.POST("/settings/sso", s.saveSSO, s.guard.can(permSettings))
	api.PUT("/settings/sso/{name}", s.saveSSO, s.guard.can(permSettings))
	api.DELETE("/settings/sso/{name}", s.deleteSSO, s.guard.can(permSettings))

	api.GET("/projects/{id}/branches", s.listBranches, read)
	api.GET("/branches/{id}", s.branchOps, read)
	api.POST("/branches/{id}/accept", s.acceptBranch, write)
	api.POST("/branches/{id}/reject", s.rejectBranch, write)

	api.GET("/projects/{id}/conversations", s.listConversations, ai)
	api.POST("/projects/{id}/conversations", s.createConversation, ai)
	api.GET("/conversations/{id}", s.getConversation, ai)
	api.DELETE("/conversations/{id}", s.deleteConversation, ai)
	api.POST("/conversations/{id}/stop", s.stopConversation, ai)

	api.GET("/parts/search", s.searchParts, read)
	api.GET("/parts/{lcsc}", s.getPart, read)
	api.GET("/models/{uuid}", s.getModel, read)
	api.GET("/assets", s.getAsset, read)
	api.POST("/parts/offers", s.offers, read)

	api.HandleFuncWildcard("/", func(c *ada.Context) error {
		return ada.NewHTTPError(http.StatusNotFound, "not found")
	})
}

// viteAsset matches Vite's content-hashed asset names, which never change
// under the same name.
const viteAsset = `-[\w-]{8}\.(js|css|woff2?|wasm)$`

func mountUI(root *ada.Mux, base string, ui fs.FS) error {
	if ui == nil {
		slog.Warn("the UI is not built into this binary: run `make build-ui`; only the API is served")
		return nil
	}

	f, err := folder.New(&folder.Config{
		Index:      true,
		SPA:        true,
		PrefixPath: base,
		// embed.FS has no modtime, so only a content hash can validate.
		ETag: folder.ETagStrong,
		CacheRegex: []*folder.RegexCacheStore{
			{Regex: viteAsset, CacheControl: "public, max-age=31536000, immutable"},
			{Regex: `.*`, CacheControl: "no-cache"},
		},
	})
	if err != nil {
		return fmt.Errorf("ui handler; %w", err)
	}

	f.SetFs(http.FS(ui))

	if base != "" {
		root.HandleFunc("", func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, base+"/", http.StatusMovedPermanently)
		})
	}

	root.HandleWildcard("/", mencoding.Middleware()(f))

	return nil
}

// httpErr maps store errors to HTTP statuses.
func bytesReader(b []byte) *bytes.Reader { return bytes.NewReader(b) }

func httpErr(err error) error {
	switch {
	case errors.Is(err, store.ErrNotFound):
		return ada.WrapHTTPError(http.StatusNotFound, err)
	case errors.Is(err, store.ErrConflict):
		return ada.WrapHTTPError(http.StatusConflict, err)
	case errors.Is(err, access.ErrDenied):
		return ada.WrapHTTPError(http.StatusForbidden, err)
	default:
		return err
	}
}
