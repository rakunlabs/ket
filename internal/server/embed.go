package server

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io/fs"
)

// dist is filled by `pnpm build` in _ui/ (vite outDir).
//
//go:embed all:dist
var distFS embed.FS

// UI returns the built frontend, or nil when only the placeholder is present.
func UI() (fs.FS, error) {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		return nil, err
	}

	if _, err := fs.Stat(sub, "index.html"); err != nil {
		return nil, nil
	}

	return sub, nil
}

// UIBuild is a short hash of the built index.html: it changes whenever any
// asset changes, because Vite names assets by content.
func UIBuild(ui fs.FS) string {
	if ui == nil {
		return ""
	}
	b, err := fs.ReadFile(ui, "index.html")
	if err != nil {
		return ""
	}
	h := sha256.New()
	h.Write(b)
	// index.html names the entry chunks only; a change in the kernel worker
	// (its own hashed file) must count as a new build too.
	if names, err := fs.Glob(ui, "assets/*"); err == nil {
		for _, n := range names {
			h.Write([]byte(n))
		}
	}

	return hex.EncodeToString(h.Sum(nil)[:6])
}
