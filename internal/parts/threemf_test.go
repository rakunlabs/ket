package parts

import (
	"archive/zip"
	"bytes"
	"os"
	"strings"
	"testing"
)

func TestThreeMFObjects(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	add := func(name, text string) {
		w, _ := zw.Create(name)
		_, _ = w.Write([]byte(text))
	}
	add("_rels/.rels", `<Relationships><Relationship Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`)
	add("3D/3dmodel.model", `<model unit="millimeter"><resources>
<object id="2" name="Cover" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/></vertices></mesh></object>
<object id="3" type="model"><mesh/></object></resources>
<build><item objectid="2"/><item objectid="3"/></build></model>`)
	add("Metadata/model_settings.config", `<config><object id="3"><metadata key="name" value="Pawn &amp; Rook"/><metadata face_count="12"/></object></config>`)
	_ = zw.Close()

	got, err := ThreeMFObjects(buf.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Name != "Cover" || got[1].Name != "Pawn & Rook" || got[1].Triangles != 12 {
		t.Fatalf("objects: %+v", got)
	}
	if err := CheckUpload("set.3mf", buf.Bytes()); err != nil {
		t.Fatalf("check: %v", err)
	}
	if err := CheckUpload("set.3mf", []byte("solid x")); err == nil || !strings.Contains(err.Error(), "zip") {
		t.Fatalf("want zip error, got %v", err)
	}
	if err := CheckUpload("notes.txt", []byte("hi")); err == nil {
		t.Fatal("want refusal of a .txt")
	}
}

func TestUploadID(t *testing.T) {
	for in, want := range map[string]string{
		"ket:asset/0b6e/case.stl":      "0b6e",
		"ket:asset/0b6e/set.3mf#Cover": "0b6e",
		"https://gitlab.com/x.step":    "",
	} {
		if got, _ := UploadID(in); got != want {
			t.Errorf("UploadID(%q) = %q, want %q", in, got, want)
		}
	}
}

// The real slicer project, when it is on this machine.
func TestThreeMFObjectsBambu(t *testing.T) {
	home, _ := os.UserHomeDir()
	b, err := os.ReadFile(home + "/Downloads/PlayBook'd Chess.3mf")
	if err != nil {
		t.Skip("no sample 3MF")
	}
	got, err := ThreeMFObjects(b)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 7 || got[5].ID != "10" || got[5].Name != "Cover" || got[5].Triangles != 799576 {
		t.Fatalf("objects: %+v", got)
	}
}
