package parts

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
)

// ThreeMFObject is one build item of a 3MF: what import takes with #<id>.
type ThreeMFObject struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Triangles int    `json:"triangles,omitempty"`
}

// Limits for reading 3MF archives: a small zip can inflate to gigabytes.
const (
	max3MFEntry = 1 << 30 // one model file, uncompressed
	max3MFTotal = 4 << 30 // all entries
	max3MFMeta  = 8 << 20 // a config or relationships file
)

var (
	objectRe   = regexp.MustCompile(`<object\s+id="([^"]+)"[^>]*>([\s\S]*?)</object>`)
	nameMetaRe = regexp.MustCompile(`<metadata\s+(?:type="object"\s+)?key="name"\s+value="([^"]*)"`)
	faceCount  = regexp.MustCompile(`face_count="(\d+)"`)
)

// open3MF opens a 3MF archive and refuses one that inflates past the limits.
func open3MF(data []byte) (*zip.Reader, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("read 3MF; %w", err)
	}
	var total uint64
	for _, f := range zr.File {
		if f.UncompressedSize64 > max3MFEntry {
			return nil, fmt.Errorf("the 3MF entry %s inflates to %d MB, more than %d MB", f.Name, f.UncompressedSize64>>20, max3MFEntry>>20)
		}
		total += f.UncompressedSize64
	}
	if total > max3MFTotal {
		return nil, fmt.Errorf("the 3MF inflates to %d MB, more than %d MB", total>>20, max3MFTotal>>20)
	}
	// The directory can lie about sizes: inflate every entry once, counting, so
	// a browser that opens the file later meets nothing bigger than it says.
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil, fmt.Errorf("the 3MF entry %s cannot be read; %w", f.Name, err)
		}
		n, err := io.Copy(io.Discard, io.LimitReader(rc, int64(f.UncompressedSize64)+1))
		rc.Close()
		if err != nil {
			return nil, fmt.Errorf("the 3MF entry %s is damaged; %w", f.Name, err)
		}
		if uint64(n) != f.UncompressedSize64 {
			return nil, fmt.Errorf("the 3MF entry %s inflates to more than its directory says; save the file again from the slicer", f.Name)
		}
	}

	return zr, nil
}

func zipEntry(zr *zip.Reader, name string) *zip.File {
	for _, f := range zr.File {
		if strings.TrimPrefix(f.Name, "/") == strings.TrimPrefix(name, "/") {
			return f
		}
	}

	return nil
}

func readSmall(zr *zip.Reader, name string) ([]byte, bool) {
	f := zipEntry(zr, name)
	if f == nil {
		return nil, false
	}
	rc, err := f.Open()
	if err != nil {
		return nil, false
	}
	defer rc.Close()
	b, err := io.ReadAll(io.LimitReader(rc, max3MFMeta))

	return b, err == nil
}

// ThreeMFObjects lists the build items of a 3MF, with the names slicers
// (Bambu Studio, Orca, Prusa) give them.
func ThreeMFObjects(data []byte) ([]ThreeMFObject, error) {
	zr, err := open3MF(data)
	if err != nil {
		return nil, err
	}

	root := "3D/3dmodel.model"
	if rels, ok := readSmall(zr, "_rels/.rels"); ok {
		var r struct {
			Rel []struct {
				Target string `xml:"Target,attr"`
				Type   string `xml:"Type,attr"`
			} `xml:"Relationship"`
		}
		if xml.Unmarshal(rels, &r) == nil {
			for _, x := range r.Rel {
				if strings.HasSuffix(x.Type, "3dmodel") {
					root = x.Target
				}
			}
		}
	}
	f := zipEntry(zr, root)
	if f == nil {
		return nil, fmt.Errorf("the 3MF has no %s", root)
	}
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()

	// Stream the model: meshes are skipped, only object names and build items are kept.
	names := map[string]string{}
	var items []string
	dec := xml.NewDecoder(io.LimitReader(rc, max3MFEntry))
	inBuild := false
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read %s; %w", root, err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "object":
				var id, name string
				for _, a := range t.Attr {
					switch a.Name.Local {
					case "id":
						id = a.Value
					case "name":
						name = a.Value
					}
				}
				if name != "" {
					names[id] = name
				}
			case "mesh":
				if err := dec.Skip(); err != nil {
					return nil, fmt.Errorf("read %s; %w", root, err)
				}
			case "build":
				inBuild = true
			case "item":
				if inBuild {
					for _, a := range t.Attr {
						if a.Name.Local == "objectid" {
							items = append(items, a.Value)
						}
					}
				}
			}
		case xml.EndElement:
			if t.Name.Local == "build" {
				inBuild = false
			}
		}
	}

	counts := map[string]int{}
	for _, cfg := range []string{"Metadata/model_settings.config", "Metadata/Slic3r_PE_model.config"} {
		b, ok := readSmall(zr, cfg)
		if !ok {
			continue
		}
		for _, m := range objectRe.FindAllSubmatch(b, -1) {
			if n := nameMetaRe.FindSubmatch(m[2]); n != nil {
				names[string(m[1])] = xmlUnescape(string(n[1]))
			}
			if c := faceCount.FindSubmatch(m[2]); c != nil {
				if v, err := strconv.Atoi(string(c[1])); err == nil {
					counts[string(m[1])] = v
				}
			}
		}
	}

	out := make([]ThreeMFObject, 0, len(items))
	for _, id := range items {
		n := names[id]
		if n == "" {
			n = "object " + id
		}
		out = append(out, ThreeMFObject{ID: id, Name: n, Triangles: counts[id]})
	}

	return out, nil
}

func xmlUnescape(s string) string {
	r := strings.NewReplacer("&lt;", "<", "&gt;", ">", "&quot;", `"`, "&apos;", "'", "&#39;", "'", "&#34;", `"`, "&amp;", "&")

	return r.Replace(s)
}
