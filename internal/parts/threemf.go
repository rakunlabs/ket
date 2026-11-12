package parts

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"path"
	"regexp"
	"strings"
)

// ThreeMFObject is one build item of a 3MF: what import takes with #<id>.
type ThreeMFObject struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Triangles int    `json:"triangles,omitempty"`
}

var (
	objectRe   = regexp.MustCompile(`<object\s+id="([^"]+)"[^>]*>([\s\S]*?)</object>`)
	nameMetaRe = regexp.MustCompile(`<metadata\s+(?:type="object"\s+)?key="name"\s+value="([^"]*)"`)
	faceCount  = regexp.MustCompile(`face_count="(\d+)"`)
)

// ThreeMFObjects lists the build items of a 3MF, with the names slicers
// (Bambu Studio, Orca, Prusa) give them.
func ThreeMFObjects(data []byte) ([]ThreeMFObject, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("read 3MF; %w", err)
	}
	read := func(name string) ([]byte, bool) {
		for _, f := range zr.File {
			if strings.TrimPrefix(f.Name, "/") == strings.TrimPrefix(name, "/") {
				rc, err := f.Open()
				if err != nil {
					return nil, false
				}
				defer rc.Close()
				b, err := io.ReadAll(io.LimitReader(rc, 8<<20))
				return b, err == nil
			}
		}
		return nil, false
	}

	root := "3D/3dmodel.model"
	if rels, ok := read("_rels/.rels"); ok {
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
	// The root model can be large when meshes are inline: read only its head and build.
	var model []byte
	for _, f := range zr.File {
		if strings.TrimPrefix(f.Name, "/") == strings.TrimPrefix(root, "/") {
			rc, err := f.Open()
			if err != nil {
				return nil, err
			}
			model, err = io.ReadAll(rc)
			rc.Close()
			if err != nil {
				return nil, err
			}
		}
	}
	if model == nil {
		return nil, fmt.Errorf("the 3MF has no %s", root)
	}

	type item struct {
		ObjectID string `xml:"objectid,attr"`
	}
	type object struct {
		ID   string `xml:"id,attr"`
		Name string `xml:"name,attr"`
	}
	// Scan tags without unmarshalling the meshes.
	names := map[string]string{}
	var items []string
	dec := xml.NewDecoder(bytes.NewReader(model))
	inBuild := false
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read %s; %w", path.Base(root), err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "object":
				var o object
				for _, a := range t.Attr {
					switch a.Name.Local {
					case "id":
						o.ID = a.Value
					case "name":
						o.Name = a.Value
					}
				}
				if o.Name != "" {
					names[o.ID] = o.Name
				}
			case "mesh":
				_ = dec.Skip()
			case "build":
				inBuild = true
			case "item":
				if inBuild {
					var it item
					for _, a := range t.Attr {
						if a.Name.Local == "objectid" {
							it.ObjectID = a.Value
						}
					}
					items = append(items, it.ObjectID)
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
		b, ok := read(cfg)
		if !ok {
			continue
		}
		for _, m := range objectRe.FindAllSubmatch(b, -1) {
			if n := nameMetaRe.FindSubmatch(m[2]); n != nil {
				names[string(m[1])] = xmlUnescape(string(n[1]))
			}
			if c := faceCount.FindSubmatch(m[2]); c != nil {
				var v int
				fmt.Sscan(string(c[1]), &v)
				counts[string(m[1])] = v
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
