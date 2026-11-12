package parts

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"

	"github.com/rakunlabs/ket/internal/store"
)

// Hosts that 3D models (STEP, STL) may be downloaded from: open part
// libraries and vendor download servers. Anything else is refused so the
// server is not an open proxy.
var assetHosts = map[string]bool{
	"raw.githubusercontent.com":     true,
	"github.com":                    true,
	"objects.githubusercontent.com": true,
	"gitlab.com":                    true,
	"files.seeedstudio.com":         true,
	"cdn.sparkfun.com":              true,
	"cdn-learn.adafruit.com":        true,
}

const (
	maxAssetDownload = 64 << 20
	maxAssetFile     = 48 << 20
)

// AssetHosts lists the allowed hosts, for error messages.
func AssetHosts() []string {
	out := make([]string, 0, len(assetHosts))
	for h := range assetHosts {
		out = append(out, h)
	}

	return out
}

// Asset downloads a model file once and caches it. rawURL may end in
// "#path/in/archive.step" to take one file out of a zip; without it a zip
// must hold exactly one .step/.stp/.stl file.
func (s *Service) Asset(ctx context.Context, rawURL string) ([]byte, error) {
	src, inner, _ := strings.Cut(strings.TrimSpace(rawURL), "#")
	u, err := url.Parse(src)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return nil, fmt.Errorf("%q is not an https URL", rawURL)
	}
	if !assetHosts[strings.ToLower(u.Hostname())] {
		return nil, fmt.Errorf("models can only be downloaded from %s; host %q is not allowed", strings.Join(AssetHosts(), ", "), u.Hostname())
	}
	key := u.String()
	if inner != "" {
		key += "#" + inner
	}

	if data, err := s.store.Asset(ctx, key); err == nil {
		return data, nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	client := &http.Client{Timeout: s.http.Timeout * 6}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download %s; %w", u, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download %s: the server answered %s", u, resp.Status)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxAssetDownload+1))
	if err != nil {
		return nil, fmt.Errorf("read %s; %w", u, err)
	}
	if len(raw) > maxAssetDownload {
		return nil, fmt.Errorf("%s is larger than %d MB", u, maxAssetDownload>>20)
	}

	data := raw
	if strings.EqualFold(path.Ext(u.Path), ".3mf") {
		// A 3MF is itself a zip; the browser picks objects out of it.
		if _, err := CheckUpload(path.Base(u.Path), raw); err != nil {
			return nil, err
		}
	} else if bytes.HasPrefix(raw, []byte("PK\x03\x04")) {
		if data, err = fromZip(raw, inner); err != nil {
			return nil, fmt.Errorf("%s: %w", u, err)
		}
	} else if inner != "" {
		return nil, fmt.Errorf("%s is not a zip, so #%s cannot be taken out of it", u, inner)
	}
	if !strings.EqualFold(path.Ext(u.Path), ".3mf") && !looksLikeModel(data) {
		return nil, fmt.Errorf("%s is not a STEP or STL file", rawURL)
	}

	if err := s.store.SaveAsset(ctx, key, data); err != nil {
		return nil, err
	}

	return data, nil
}

func isModelName(n string) bool {
	switch strings.ToLower(path.Ext(n)) {
	case ".step", ".stp", ".stl", ".3mf":
		return true
	}

	return false
}

// MaxUpload is the largest model file that can be uploaded.
const MaxUpload = 200 << 20

// AssetScheme prefixes uploaded files in import URLs: ket:asset/<id>/<name>.
const AssetScheme = "ket:asset/"

// UploadID returns the upload id of a ket:asset/<id>/<name> URL.
func UploadID(rawURL string) (string, bool) {
	rest, ok := strings.CutPrefix(rawURL, AssetScheme)
	if !ok {
		return "", false
	}
	id, _, _ := strings.Cut(rest, "/")
	id, _, _ = strings.Cut(id, "#")

	return id, id != ""
}

// UploadURL is the import URL of an uploaded file.
func UploadURL(id, name string) string {
	return AssetScheme + id + "/" + name
}

var unsafeName = regexp.MustCompile(`[^A-Za-z0-9._\- ()'+,]+`)

// CleanUploadName keeps a file name usable in a ket:asset URL: no folders,
// and characters that would need escaping (#, %, ?, /...) become "_".
func CleanUploadName(raw string) (string, error) {
	name := path.Base(strings.ReplaceAll(strings.TrimSpace(raw), "\\", "/"))
	name = strings.TrimSpace(unsafeName.ReplaceAllString(name, "_"))
	if name == "" || name == "." || strings.HasPrefix(name, ".") {
		return "", fmt.Errorf("%q is not a file name: give the name with its extension, e.g. \"case.3mf\"", raw)
	}
	if len(name) > 200 {
		ext := path.Ext(name)
		name = name[:200-len(ext)] + ext
	}

	return name, CheckUploadName(name)
}

// CheckUploadName says whether a file name is one import can read.
func CheckUploadName(name string) error {
	if !isModelName(name) {
		return fmt.Errorf("%q is not a model file: upload .stl, .3mf, .step or .stp", name)
	}

	return nil
}

// UploadAnswer is what an upload answers: the url for import, and a 3MF's objects.
func UploadAnswer(id, name string, size int64, objects []ThreeMFObject) map[string]any {
	url := UploadURL(id, name)
	out := map[string]any{"id": id, "name": name, "url": url, "bytes": size}
	if len(objects) > 0 {
		out["objects"] = objects
		out["note"] = "import one object with url#<id>, e.g. " + url + "#" + objects[0].ID
	}

	return out
}

// CheckUpload says whether data is a model file that import can read; for
// a 3MF it also lists the objects (what import takes with #<id>).
func CheckUpload(name string, data []byte) ([]ThreeMFObject, error) {
	if err := CheckUploadName(name); err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return nil, fmt.Errorf("%s is empty", name)
	}
	if len(data) > MaxUpload {
		return nil, fmt.Errorf("%s is larger than %d MB", name, MaxUpload>>20)
	}
	if strings.EqualFold(path.Ext(name), ".3mf") {
		if !bytes.HasPrefix(data, []byte("PK\x03\x04")) {
			return nil, fmt.Errorf("%s is not a 3MF file (a 3MF is a zip archive)", name)
		}
		objs, err := ThreeMFObjects(data)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		if len(objs) == 0 {
			return nil, fmt.Errorf("%s has no objects to print (no build items)", name)
		}

		return objs, nil
	}
	if !looksLikeModel(data) {
		return nil, fmt.Errorf("%s is not a STEP or STL file", name)
	}

	return nil, nil
}

func fromZip(raw []byte, inner string) ([]byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return nil, fmt.Errorf("read zip; %w", err)
	}
	var pick *zip.File
	var names []string
	for _, f := range zr.File {
		if f.FileInfo().IsDir() || !isModelName(f.Name) {
			continue
		}
		names = append(names, f.Name)
		if inner != "" && (f.Name == inner || path.Base(f.Name) == inner) {
			pick = f
		}
	}
	if inner == "" && len(names) == 1 {
		for _, f := range zr.File {
			if f.Name == names[0] {
				pick = f
			}
		}
	}
	if pick == nil {
		if inner == "" {
			return nil, fmt.Errorf("the zip holds %d model files (%s); add #<name> to the URL to pick one", len(names), strings.Join(names, ", "))
		}
		return nil, fmt.Errorf("no %q in the zip; it holds %s", inner, strings.Join(names, ", "))
	}
	if pick.UncompressedSize64 > maxAssetFile {
		return nil, fmt.Errorf("%s is larger than %d MB", pick.Name, maxAssetFile>>20)
	}
	rc, err := pick.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()

	return io.ReadAll(io.LimitReader(rc, maxAssetFile))
}

func looksLikeModel(b []byte) bool {
	head := string(b[:min(len(b), 512)])
	if strings.Contains(head, "ISO-10303-21") {
		return true
	}
	if strings.HasPrefix(strings.TrimSpace(head), "solid") {
		return true
	}
	// Binary STL: 80-byte header, triangle count, 50 bytes per triangle.
	if len(b) >= 84 {
		n := int(b[80]) | int(b[81])<<8 | int(b[82])<<16 | int(b[83])<<24
		return 84+n*50 == len(b)
	}

	return false
}

// StoreUpload checks a model file and stores it in a project: what the
// Import model button, upload links and upload_asset all do. It answers
// the url to import it with, and a 3MF's objects.
func StoreUpload(ctx context.Context, st *store.Store, projectID, rawName string, data []byte, by string) (map[string]any, error) {
	name, err := CleanUploadName(rawName)
	if err != nil {
		return nil, err
	}
	objs, err := CheckUpload(name, data)
	if err != nil {
		return nil, err
	}
	var objJSON json.RawMessage
	if len(objs) > 0 {
		objJSON, _ = json.Marshal(objs)
	}
	sum := sha256.Sum256(data)
	up, err := st.SaveUpload(ctx, projectID, name, hex.EncodeToString(sum[:]), data, objJSON, by)
	if err != nil {
		return nil, err
	}

	return UploadAnswer(up.ID, up.Name, up.Size, objs), nil
}

// UploadView is an upload as listed: the url for import and a 3MF's objects.
func UploadView(u *store.Upload) map[string]any {
	out := map[string]any{"id": u.ID, "name": u.Name, "url": UploadURL(u.ID, u.Name), "bytes": u.Size, "created_at": u.CreatedAt.UTC().Format("2006-01-02T15:04:05Z")}
	if u.CreatedBy != "" {
		out["created_by"] = u.CreatedBy
	}
	if len(u.Objects) > 0 {
		out["objects"] = u.Objects
	}

	return out
}
