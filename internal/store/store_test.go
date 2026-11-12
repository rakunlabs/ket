package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/rakunlabs/ada/middleware/auth/sessionstore"

	"github.com/rakunlabs/ket/internal/config"
)

// The store tests need a PostgreSQL: set KET_TEST_DSN, e.g.
// postgres://ket:ket@localhost:5432/ket?sslmode=disable (make env).
func testStore(t *testing.T) *Store {
	t.Helper()
	dsn := os.Getenv("KET_TEST_DSN")
	if dsn == "" {
		t.Skip("KET_TEST_DSN is not set")
	}

	st, err := New(context.Background(), config.Store{Postgres: config.Postgres{DSN: dsn, MaxOpenConns: 4, Migrate: true}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)

	return st
}

func TestOpLog(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	p, err := st.CreateProject(ctx, "oplog test", "", "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.DeleteProject(ctx, p.ID) })

	op := json.RawMessage(`{"cmd":"box","args":{"name":"a"}}`)
	for i := int64(0); i < 3; i++ {
		o, err := st.AppendOp(ctx, p.MainBranch, i, op, "user", "")
		if err != nil {
			t.Fatal(err)
		}
		if o.Seq != i+1 {
			t.Fatalf("seq = %d, want %d", o.Seq, i+1)
		}
	}

	// A stale base is refused.
	if _, err := st.AppendOp(ctx, p.MainBranch, 1, op, "user", ""); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale base: err = %v, want conflict", err)
	}

	// Undo twice, then a new op drops the undone tail.
	if _, err := st.MoveHead(ctx, p.MainBranch, -1); err != nil {
		t.Fatal(err)
	}
	s, err := st.MoveHead(ctx, p.MainBranch, -1)
	if err != nil {
		t.Fatal(err)
	}
	if s.Head != 1 || s.Top != 3 {
		t.Fatalf("after undo: %+v", s)
	}
	if _, err := st.MoveHead(ctx, p.MainBranch, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AppendOp(ctx, p.MainBranch, 2, op, "ai:x", "new"); err != nil {
		t.Fatal(err)
	}
	s, _ = st.BranchState(ctx, p.MainBranch)
	if s.Head != 3 || s.Top != 3 {
		t.Fatalf("after new op: %+v", s)
	}
	ops, err := st.Ops(ctx, p.MainBranch, 0, s.Head)
	if err != nil {
		t.Fatal(err)
	}
	if len(ops) != 3 || ops[2].Author != "ai:x" {
		t.Fatalf("ops = %+v", ops)
	}

	if _, err := st.GetProject(ctx, "not-a-uuid"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("bad id: err = %v, want not found", err)
	}
}

func TestProposalBranch(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	p, err := st.CreateProject(ctx, "branch test", "", "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.DeleteProject(ctx, p.ID) })

	op := json.RawMessage(`{"cmd":"box","args":{}}`)
	if _, err := st.AppendOp(ctx, p.MainBranch, 0, op, "user", "base"); err != nil {
		t.Fatal(err)
	}

	b, err := st.CreateBranch(ctx, p.MainBranch, "proposal")
	if err != nil {
		t.Fatal(err)
	}
	if b.BaseSeq != 1 || b.HeadSeq != 1 {
		t.Fatalf("fork = %+v", b)
	}
	// The branch replays on its own: it has main's op.
	ops, _ := st.Ops(ctx, b.ID, 0, 1)
	if len(ops) != 1 || ops[0].Message != "base" {
		t.Fatalf("forked ops = %+v", ops)
	}
	for i := int64(1); i <= 2; i++ {
		if _, err := st.AppendOp(ctx, b.ID, i, op, "ai:x", "proposed"); err != nil {
			t.Fatal(err)
		}
	}

	head, err := st.MergeBranch(ctx, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	if head != 3 {
		t.Fatalf("merged head = %d, want 3", head)
	}
	main, _ := st.Ops(ctx, p.MainBranch, 0, 3)
	if len(main) != 3 || main[2].Author != "ai:x" {
		t.Fatalf("main after merge = %+v", main)
	}
	if _, err := st.GetBranch(ctx, b.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("merged branch must be gone")
	}

	// A proposal against an older main is refused.
	b2, _ := st.CreateBranch(ctx, p.MainBranch, "stale")
	_, _ = st.AppendOp(ctx, b2.ID, 3, op, "ai:x", "")
	_, _ = st.AppendOp(ctx, p.MainBranch, 3, op, "user", "meanwhile")
	if _, err := st.MergeBranch(ctx, b2.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale merge: err = %v, want conflict", err)
	}
	if err := st.DeleteBranch(ctx, p.MainBranch); !errors.Is(err, ErrNotFound) {
		t.Fatal("main must not be deletable")
	}
}

func TestSharing(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	mine, err := st.CreateProject(ctx, "mine", "", "u-alice")
	if err != nil {
		t.Fatal(err)
	}
	open, _ := st.CreateProject(ctx, "open", "", "")
	other, _ := st.CreateProject(ctx, "bob's", "", "u-bob")
	t.Cleanup(func() {
		for _, p := range []*Project{mine, open, other} {
			_ = st.DeleteProject(ctx, p.ID)
		}
	})
	if mine.OwnerID == nil || *mine.OwnerID != "u-alice" || open.OwnerID != nil {
		t.Fatalf("owners: %v %v", mine.OwnerID, open.OwnerID)
	}

	visible := func(user string) map[string]bool {
		list, _, err := st.ProjectsFor(ctx, user)
		if err != nil {
			t.Fatal(err)
		}
		out := map[string]bool{}
		for _, p := range list {
			out[p.ID] = true
		}
		return out
	}
	v := visible("u-alice")
	if !v[mine.ID] || !v[open.ID] || v[other.ID] {
		t.Fatalf("alice sees %v", v)
	}

	if err := st.SetMember(ctx, other.ID, "u-alice", MemberViewer); err != nil {
		t.Fatal(err)
	}
	if !visible("u-alice")[other.ID] {
		t.Fatal("shared project must be visible")
	}
	if r, _ := st.MemberRole(ctx, other.ID, "u-alice"); r != MemberViewer {
		t.Fatalf("role = %q", r)
	}
	if err := st.SetMember(ctx, other.ID, "u-alice", "admin"); err == nil {
		t.Fatal("bad role must fail")
	}
	if err := st.RemoveMember(ctx, other.ID, "u-alice"); err != nil {
		t.Fatal(err)
	}
	if r, _ := st.MemberRole(ctx, other.ID, "u-alice"); r != "" {
		t.Fatalf("removed member role = %q", r)
	}
}

func TestSearchProjects(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	tag := fmt.Sprintf("srch%d", time.Now().UnixNano())
	var made []*Project
	for i := 0; i < 25; i++ {
		owner := "u-search-a"
		if i%5 == 0 {
			owner = "u-search-b"
		}
		p, err := st.CreateProject(ctx, fmt.Sprintf("%s board %02d", tag, i), map[bool]string{true: "has usb_c", false: ""}[i%2 == 0], owner)
		if err != nil {
			t.Fatal(err)
		}
		made = append(made, p)
	}
	t.Cleanup(func() {
		for _, p := range made {
			_ = st.DeleteProject(ctx, p.ID)
		}
	})

	page, _, err := st.SearchProjects(ctx, ProjectQuery{Q: tag, Limit: 10, Sort: "name"})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 25 || len(page.Items) != 10 || !strings.HasSuffix(page.Items[0].Name, "00") {
		t.Fatalf("page 1: total %d, %d items, first %q", page.Total, len(page.Items), page.Items[0].Name)
	}
	last, _, _ := st.SearchProjects(ctx, ProjectQuery{Q: tag, Limit: 10, Offset: 20, Sort: "name"})
	if len(last.Items) != 5 || !strings.HasSuffix(last.Items[4].Name, "24") {
		t.Fatalf("last page: %d items", len(last.Items))
	}

	// Every word must match; description counts; LIKE wildcards are literal.
	if p, _, _ := st.SearchProjects(ctx, ProjectQuery{Q: tag + " USB_C"}); p.Total != 13 {
		t.Fatalf("word search total = %d, want 13", p.Total)
	}
	if p, _, _ := st.SearchProjects(ctx, ProjectQuery{Q: tag + " usb%c"}); p.Total != 0 {
		t.Fatalf("%% must not be a wildcard; total = %d", p.Total)
	}

	// A user sees their own and what is shared with them.
	_ = st.SetMember(ctx, made[5].ID, "u-search-a", MemberViewer)
	mine, _, _ := st.SearchProjects(ctx, ProjectQuery{Q: tag, UserID: "u-search-a", Mine: true})
	shared, roles, _ := st.SearchProjects(ctx, ProjectQuery{Q: tag, UserID: "u-search-a", Shared: true})
	all, _, _ := st.SearchProjects(ctx, ProjectQuery{Q: tag, UserID: "u-search-a"})
	if mine.Total != 20 || shared.Total != 1 || all.Total != 21 || roles[made[5].ID] != MemberViewer {
		t.Fatalf("mine %d shared %d all %d roles %v", mine.Total, shared.Total, all.Total, roles)
	}
}

func TestSettingsTable(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	key := fmt.Sprintf("test-%d", time.Now().UnixNano())
	t.Cleanup(func() { _, _ = st.DB().Exec(`DELETE FROM settings WHERE key = $1`, key) })

	var v struct{ A int }
	if err := st.Setting(ctx, key, &v); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	first := struct{ A int }{1}
	if err := st.SettingOnce(ctx, key, &first); err != nil {
		t.Fatal(err)
	}
	second := struct{ A int }{2}
	_ = st.SettingOnce(ctx, key, &second)
	if second.A != 1 {
		t.Fatalf("SettingOnce must keep the first value, got %d", second.A)
	}
	_ = st.SetSetting(ctx, key, struct{ A int }{3}, "test")
	_ = st.Setting(ctx, key, &v)
	if v.A != 3 {
		t.Fatalf("after set: %d", v.A)
	}
}

func TestSessionStore(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	ss, err := st.Sessions([]byte("0123456789abcdef0123456789abcdef"), sessionstore.Options{Path: "/", MaxAge: 3600})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.Sessions([]byte("short"), sessionstore.Options{}); err == nil {
		t.Fatal("a short key must be refused")
	}

	// Cookie round trip: save, read back by the signed cookie.
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	sess, _ := ss.Get(r, "auth_session")
	if !sess.IsNew {
		t.Fatal("no cookie must give a new session")
	}
	sess.Values["user"] = "alice"
	w := httptest.NewRecorder()
	if err := ss.Save(r, w, sess); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ss.DeleteByID(ctx, sess.ID) })
	r2 := httptest.NewRequest(http.MethodGet, "/", nil)
	for _, c := range w.Result().Cookies() {
		r2.AddCookie(c)
	}
	back, _ := ss.Get(r2, "auth_session")
	if back.IsNew || back.Values["user"] != "alice" {
		t.Fatalf("read back: %+v", back)
	}
	// A forged cookie is a new session.
	r3 := httptest.NewRequest(http.MethodGet, "/", nil)
	r3.AddCookie(&http.Cookie{Name: "auth_session", Value: "x|y"})
	if forged, _ := ss.Get(r3, "auth_session"); !forged.IsNew {
		t.Fatal("forged cookie accepted")
	}

	// Transactions: change, keep expiry, delete.
	id := fmt.Sprintf("tx-%d", time.Now().UnixNano())
	_ = ss.SaveByID(ctx, id, map[string]any{"n": 1.0}, time.Hour)
	got, err := ss.TransactByID(ctx, id, 0, func(cur map[string]any) (map[string]any, bool, error) {
		cur["n"] = cur["n"].(float64) + 1
		return cur, true, nil
	})
	if err != nil || got["n"] != 2.0 {
		t.Fatalf("transact: %v %v", got, err)
	}
	if v, _ := ss.LoadByID(ctx, id); v["n"] != 2.0 {
		t.Fatalf("after transact: %v", v)
	}
	_, _ = ss.TransactByID(ctx, id, 0, func(map[string]any) (map[string]any, bool, error) { return nil, true, nil })
	if _, err := ss.LoadByID(ctx, id); !errors.Is(err, sessionstore.ErrNoSession) {
		t.Fatalf("deleted session: %v", err)
	}
	// Expired records are gone.
	_ = ss.SaveByID(ctx, id, map[string]any{}, time.Millisecond)
	time.Sleep(20 * time.Millisecond)
	if _, err := ss.LoadByID(ctx, id); !errors.Is(err, sessionstore.ErrNoSession) {
		t.Fatalf("expired session: %v", err)
	}
	if _, err := ss.TransactByID(ctx, id, 0, func(map[string]any) (map[string]any, bool, error) { return nil, false, nil }); !errors.Is(err, sessionstore.ErrNoSession) {
		t.Fatalf("expired transact: %v", err)
	}
	_ = ss.DeleteByID(ctx, id)
}

func TestGroups(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	p, err := st.CreateProject(ctx, "bob's board", "", "u-bob")
	if err != nil {
		t.Fatal(err)
	}
	g, err := st.SaveGroup(ctx, &Group{Name: "Hardware team"}, []string{"u-alice", "u-carol"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = st.DeleteProject(ctx, p.ID)
		_ = st.DeleteGroup(ctx, g.ID)
	})
	if _, err := st.SaveGroup(ctx, &Group{Name: "hardware TEAM"}, nil); err == nil {
		t.Fatal("duplicate group name must fail")
	}

	if r, _ := st.AccessRole(ctx, p.ID, "u-alice"); r != "" {
		t.Fatalf("before sharing: %q", r)
	}
	if err := st.SetProjectGroup(ctx, p.ID, g.ID, MemberViewer); err != nil {
		t.Fatal(err)
	}
	if r, _ := st.AccessRole(ctx, p.ID, "u-alice"); r != MemberViewer {
		t.Fatalf("group viewer: %q", r)
	}
	// The best of direct and group roles wins.
	if err := st.SetMember(ctx, p.ID, "u-alice", MemberEditor); err != nil {
		t.Fatal(err)
	}
	if r, _ := st.AccessRole(ctx, p.ID, "u-alice"); r != MemberEditor {
		t.Fatalf("direct editor + group viewer: %q", r)
	}

	page, roles, err := st.SearchProjects(ctx, ProjectQuery{UserID: "u-carol", Shared: true})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || roles[p.ID] != MemberViewer {
		t.Fatalf("carol shared: total %d roles %v", page.Total, roles)
	}
	if page, _, _ := st.SearchProjects(ctx, ProjectQuery{UserID: "u-dave"}); page.Total != 0 {
		for _, x := range page.Items {
			if x.ID == p.ID {
				t.Fatal("non-member must not see the project")
			}
		}
	}

	// Sign-in sync manages only mapped groups.
	if err := st.SetUserGroups(ctx, "u-carol", nil, []string{g.ID}); err != nil {
		t.Fatal(err)
	}
	if r, _ := st.AccessRole(ctx, p.ID, "u-carol"); r != "" {
		t.Fatalf("removed from group: %q", r)
	}
	if err := st.ForgetUser(ctx, "u-alice"); err != nil {
		t.Fatal(err)
	}
	if r, _ := st.AccessRole(ctx, p.ID, "u-alice"); r != "" {
		t.Fatalf("forgotten user: %q", r)
	}
	if list, _ := st.ProjectGroups(ctx, p.ID); len(list) != 1 || list[0].Name != "Hardware team" {
		t.Fatalf("project groups: %v", list)
	}
}

func TestUploads(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	p, err := st.CreateProject(ctx, "uploads test", "", "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.DeleteProject(ctx, p.ID) })

	objs := json.RawMessage(`[{"id":"2","name":"Cover"}]`)
	u, err := st.SaveUpload(ctx, p.ID, "set.3mf", "abc", []byte("PK data"), objs, "")
	if err != nil {
		t.Fatal(err)
	}
	// The same file again is the same upload.
	again, err := st.SaveUpload(ctx, p.ID, "set.3mf", "abc", []byte("PK data"), objs, "")
	if err != nil || again.ID != u.ID {
		t.Fatalf("again: %v %v", again, err)
	}
	list, err := st.Uploads(ctx, p.ID)
	if err != nil || len(list) != 1 || string(list[0].Objects) == "" {
		t.Fatalf("list: %+v %v", list, err)
	}
	if data, err := st.UploadData(ctx, u.ID); err != nil || string(data) != "PK data" {
		t.Fatalf("data: %q %v", data, err)
	}

	// Imported by the history: it stays.
	op := json.RawMessage(`{"cmd":"import","args":{"name":"cover","url":"ket:asset/` + u.ID + `/set.3mf#2"}}`)
	if _, err := st.AppendOp(ctx, p.MainBranch, 0, op, "user", ""); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteUpload(ctx, p.ID, u.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("delete of a used file: want conflict, got %v", err)
	}

	other, err := st.SaveUpload(ctx, p.ID, "spare.stl", "def", []byte("solid x"), nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteUpload(ctx, p.ID, other.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := st.UploadInfo(ctx, other.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted upload still there: %v", err)
	}
}

func TestTemplates(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	data := `{"format":"ket-project","version":1,"units":"mm","ops":[]}`
	tpl, err := st.SaveTemplate(ctx, &Template{Kind: "block", Name: "usb power test", Description: "USB-C in", Data: data}, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.DeleteTemplate(ctx, tpl.ID) })
	if _, err := st.SaveTemplate(ctx, &Template{Kind: "block", Name: "usb power test", Data: data}, false); !errors.Is(err, ErrExists) {
		t.Fatalf("duplicate: %v", err)
	}
	if _, err := st.SaveTemplate(ctx, &Template{Kind: "block", Name: "usb power test", Description: "v2", Data: data}, true); err != nil {
		t.Fatal(err)
	}
	got, err := st.GetTemplate(ctx, "block", "usb power test")
	if err != nil || got.Data != data || got.Description != "v2" {
		t.Fatalf("get by name: %+v %v", got, err)
	}
	if _, err := st.GetTemplate(ctx, "template", "usb power test"); err == nil {
		t.Fatal("a block is not a template")
	}
	list, err := st.ListTemplates(ctx, "block")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, x := range list {
		found = found || (x.ID == tpl.ID && x.Data == "" && x.Bytes == len(data))
	}
	if !found {
		t.Fatal("list misses the block or carries its data")
	}
}
