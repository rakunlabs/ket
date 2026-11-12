package mcpserver

import (
	"context"
	"net/http"
	"time"

	mcpauth "github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/rakunlabs/ada/middleware/auth/identity"

	"github.com/rakunlabs/ket/internal/config"
)

// Handler serves the tools over MCP streamable HTTP. base is the server's
// address as the client sees it (for links tools hand back).
func (t *Tools) Handler(base func(*http.Request) string) http.Handler {
	server := mcp.NewServer(&mcp.Implementation{Name: config.ServiceName, Version: config.Version}, &mcp.ServerOptions{
		Instructions: t.Guide(),
	})

	for _, tool := range t.List(ScopeMCP) {
		tool := tool
		mt := &mcp.Tool{
			Name:        tool.Name,
			Description: tool.Description,
			InputSchema: tool.Schema,
		}
		if tool.ReadOnly {
			mt.Annotations = &mcp.ToolAnnotations{ReadOnlyHint: true}
		}

		server.AddTool(mt, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			author := "mcp"
			if req.Session != nil {
				author = "mcp:" + req.Session.ID()
			}
			// With auth the token's user is who is acting (see Handler);
			// project access is checked against them.
			if req.Extra != nil && req.Extra.TokenInfo != nil {
				if name, _ := req.Extra.TokenInfo.Extra["username"].(string); name != "" {
					author += "@" + name
				}
				if id, _ := req.Extra.TokenInfo.Extra["identity"].(*identity.Identity); id != nil {
					ctx = identity.WithContext(ctx, id)
				}
			}

			if req.Extra != nil {
				if base := req.Extra.Header.Get(baseHeader); base != "" {
					ctx = context.WithValue(ctx, baseKey{}, base)
				}
			}
			res := t.Call(ctx, tool.Name, req.Params.Arguments, Call{Author: author})

			out := &mcp.CallToolResult{IsError: res.IsError}
			if res.Text != "" {
				out.Content = append(out.Content, &mcp.TextContent{Text: res.Text})
			}
			for _, img := range res.Images {
				out.Content = append(out.Content, &mcp.ImageContent{MIMEType: img.MIME, Data: img.Data})
			}
			if len(out.Content) == 0 {
				out.Content = []mcp.Content{&mcp.TextContent{Text: "ok"}}
			}

			return out, nil
		})
	}

	h := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil)

	// With auth, ada has already checked the token; hand the user to the
	// SDK as TokenInfo, which binds each MCP session to that user (no
	// session hijacking) and reaches tool calls. Without auth nobody is
	// signed in and the handler is used as is.
	verify := func(ctx context.Context, _ string, r *http.Request) (*mcpauth.TokenInfo, error) {
		id := identity.FromContext(r.Context())
		if id == nil {
			return nil, mcpauth.ErrInvalidToken
		}
		name := id.Name
		if u, ok := id.Claims["username"].(string); ok && u != "" {
			name = u
		}

		return &mcpauth.TokenInfo{UserID: id.Subject, Scopes: []string{"mcp"}, Extra: map[string]any{"username": name, "identity": id}, Expiration: time.Now().Add(time.Hour)}, nil
	}
	withUser := mcpauth.RequireBearerToken(verify, nil)(h)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The address the client used, for links tools hand back (upload links).
		r = r.Clone(r.Context())
		r.Header.Set(baseHeader, base(r))
		// A browser session (cookie) has no bearer header; the SDK
		// middleware only needs one to be present.
		if identity.FromContext(r.Context()) != nil {
			if r.Header.Get("Authorization") == "" {
				r.Header.Set("Authorization", "Bearer session")
			}
			withUser.ServeHTTP(w, r)
			return
		}
		h.ServeHTTP(w, r)
	})
}

// baseHeader carries the server address the client used into tool calls.
const baseHeader = "X-Ket-Base-Url"

type baseKey struct{}

// BaseFromContext is the server address the MCP client used ("" outside MCP).
func BaseFromContext(ctx context.Context) string {
	s, _ := ctx.Value(baseKey{}).(string)
	return s
}
