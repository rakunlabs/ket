package server

import (
	"embed"
	"net/http"

	"github.com/rakunlabs/ada"
)

// brandFS holds what the login page and the app share: the mark (the
// favicon everywhere, with no background tile), the login page's styles
// and the font they use.
//
//go:embed brand
var brandFS embed.FS

// brandPath is where the files are served, under the base path. It sits
// beside the login page so ada's page can load them relatively.
const brandPath = "/login/brand/"

var brandTypes = map[string]string{
	"mark.svg":        "image/svg+xml",
	"mark-light.svg":  "image/svg+xml",
	"mark-dark.svg":   "image/svg+xml",
	"login.css":       "text/css; charset=utf-8",
	"plex-sans.woff2": "font/woff2",
}

// mountBrand serves the brand files, and the mark in place of ada's
// /login/logo.svg, the login page's favicon, so the tab icon is the same
// on every page. Registered as exact routes, so they
// win over ada's /login/* wildcard and need no sign-in.
func mountBrand(root *ada.Mux) {
	for name, typ := range brandTypes {
		data, err := brandFS.ReadFile("brand/" + name)
		if err != nil {
			panic("brand file missing: " + name)
		}
		root.HandleWithMethod(http.MethodGet, brandPath+name, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", typ)
			w.Header().Set("Cache-Control", "public, max-age=86400")
			_, _ = w.Write(data)
		})
	}
	mark, _ := brandFS.ReadFile("brand/mark.svg")
	root.HandleWithMethod(http.MethodGet, "/login/logo.svg", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/svg+xml")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write(mark)
	})
}
