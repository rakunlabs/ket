package parts

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/rakunlabs/ket/internal/config"
	"github.com/rakunlabs/ket/internal/store"
)

func TestOffersRoundToOrderRules(t *testing.T) {
	dsn := os.Getenv("KET_TEST_DSN")
	if dsn == "" {
		t.Skip("KET_TEST_DSN is not set")
	}
	ctx := context.Background()
	st, err := store.New(ctx, config.Store{Postgres: config.Postgres{DSN: dsn, MaxOpenConns: 4, Migrate: true}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)

	// A fresh cache entry: no network needed.
	raw := json.RawMessage(`{"title":"X","lcsc":{"number":"C999001","stock":40,"price":0.5,"min":5,"step":5,"prices":[[1,9,0.5],[10,0,0.3]]},
		"dataStr":{"head":{"c_para":{"Manufacturer Part":"MPN-1","JLCPCB Part Class":"Basic Part"}}}}`)
	if err := st.SavePart(ctx, "C999001", raw); err != nil {
		t.Fatal(err)
	}
	s := New(st)
	got := s.Offers(ctx, map[string]int{"C999001": 7})
	if len(got) != 1 || got[0].Error != "" {
		t.Fatalf("offers = %+v", got)
	}
	o := got[0]
	if o.Order != 10 || o.MPN != "MPN-1" || !o.Basic || *o.Stock != 40 {
		t.Fatalf("offer = %+v", o)
	}
	if *o.Unit != 0.3 {
		t.Fatalf("unit = %v, want the 10+ tier 0.3", *o.Unit)
	}
	if bad := s.Offers(ctx, map[string]int{"nope": 1}); bad[0].Error == "" {
		t.Fatal("a bad number must report an error")
	}
}
