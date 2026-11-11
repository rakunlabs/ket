package parts

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"
)

func TestFromZip(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, n := range []string{"board/XIAO v15.step", "render.png"} {
		w, _ := zw.Create(n)
		_, _ = w.Write([]byte("ISO-10303-21;\n" + n))
	}
	_ = zw.Close()

	got, err := fromZip(buf.Bytes(), "")
	if err != nil || !strings.Contains(string(got), "XIAO v15.step") {
		t.Fatalf("single model: %q %v", got, err)
	}
	if got, err = fromZip(buf.Bytes(), "XIAO v15.step"); err != nil || !looksLikeModel(got) {
		t.Fatalf("by base name: %q %v", got, err)
	}
	if _, err = fromZip(buf.Bytes(), "nope.step"); err == nil || !strings.Contains(err.Error(), "board/XIAO v15.step") {
		t.Fatalf("missing file should list the models: %v", err)
	}
}

func TestLooksLikeModel(t *testing.T) {
	for _, c := range []struct {
		in   []byte
		want bool
	}{
		{[]byte("ISO-10303-21;\nHEADER;"), true},
		{[]byte("solid cube\nfacet normal"), true},
		{[]byte("<html>not found</html>"), false},
		{append(append(make([]byte, 80), 1, 0, 0, 0), make([]byte, 50)...), true},
	} {
		if got := looksLikeModel(c.in); got != c.want {
			t.Errorf("looksLikeModel(%q) = %v", c.in[:min(len(c.in), 20)], got)
		}
	}
}

func TestAssetRefusesOtherHosts(t *testing.T) {
	s := &Service{}
	if _, err := s.Asset(t.Context(), "https://example.com/x.step"); err == nil || !strings.Contains(err.Error(), "not allowed") {
		t.Fatalf("want host refusal, got %v", err)
	}
	if _, err := s.Asset(t.Context(), "http://raw.githubusercontent.com/x.step"); err == nil || !strings.Contains(err.Error(), "https") {
		t.Fatalf("want https refusal, got %v", err)
	}
}
