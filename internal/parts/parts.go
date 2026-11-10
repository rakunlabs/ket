// Package parts fetches real components from the EasyEDA / LCSC catalog
// (the library JLCPCB assembles from) and caches the raw responses in
// PostgreSQL. The browser parses the footprint, so the parser and the
// document stay in one language.
package parts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/rakunlabs/ket/internal/store"
)

const (
	componentsURL = "https://easyeda.com/api/products/%s/components?version=6.4.19.5"
	searchURL     = "https://easyeda.com/api/components/search"
	userAgent     = "Mozilla/5.0 (X11; Linux x86_64) ket/0.1"
)

var (
	lcscRe  = regexp.MustCompile(`^C\d+$`)
	modelRe = regexp.MustCompile(`^[0-9a-f]{32}$`)
)

const modelURL = "https://modules.easyeda.com/3dmodel/%s"

type Service struct {
	store *store.Store
	http  *http.Client
}

func New(st *store.Store) *Service {
	return &Service{store: st, http: &http.Client{Timeout: 20 * time.Second}}
}

// Hit is one search result.
type Hit struct {
	LCSC        string   `json:"lcsc"`
	MPN         string   `json:"mpn"`
	Mfr         string   `json:"mfr,omitempty"`
	Package     string   `json:"package,omitempty"`
	Description string   `json:"description,omitempty"`
	Basic       bool     `json:"basic,omitempty"`
	Stock       *int     `json:"stock,omitempty"`
	Price       *float64 `json:"price,omitempty"`
}

// Search runs a keyword search. EasyEDA's search ranks by MPN and
// manufacturer, not parameters: "AMS1117-3.3" works better than
// "3.3V regulator".
func (s *Service) Search(ctx context.Context, query string, limit int) ([]Hit, error) {
	if limit <= 0 || limit > 50 {
		limit = 15
	}
	form := url.Values{"type": {"3"}, "doctype[]": {"2"}, "wd": {query}, "pageSize": {fmt.Sprint(limit)}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, searchURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/json")

	resp, err := s.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("search parts; %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("search parts: EasyEDA answered %s", resp.Status)
	}

	var body struct {
		Result struct {
			Lists struct {
				LCSC []rawItem `json:"lcsc"`
			} `json:"lists"`
		} `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("decode search; %w", err)
	}

	out := make([]Hit, 0, len(body.Result.Lists.LCSC))
	for _, it := range body.Result.Lists.LCSC {
		h := it.hit()
		if h.LCSC != "" {
			out = append(out, h)
		}
	}

	return out, nil
}

type rawItem struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	LCSC        *struct {
		Number string   `json:"number"`
		Stock  *int     `json:"stock"`
		Price  *float64 `json:"price"`
	} `json:"lcsc"`
	DataStr *struct {
		Head struct {
			CPara map[string]any `json:"c_para"`
		} `json:"head"`
	} `json:"dataStr"`
}

func (it rawItem) hit() Hit {
	h := Hit{MPN: it.Title, Description: it.Description}
	if it.LCSC != nil {
		h.LCSC = it.LCSC.Number
		h.Stock = it.LCSC.Stock
		h.Price = it.LCSC.Price
	}
	if it.DataStr != nil {
		p := it.DataStr.Head.CPara
		str := func(k string) string { v, _ := p[k].(string); return v }
		if v := str("Manufacturer Part"); v != "" {
			h.MPN = v
		}
		h.Mfr = str("Manufacturer")
		h.Package = str("package")
		h.Basic = str("JLCPCB Part Class") == "Basic Part"
		if h.LCSC == "" {
			h.LCSC = str("Supplier Part")
		}
	}

	return h
}

// Get returns the raw EasyEDA component response for an LCSC number, from
// the cache or the network.
func (s *Service) Get(ctx context.Context, lcsc string) (json.RawMessage, error) {
	return s.get(ctx, lcsc, 0)
}

// get uses the cache unless it is older than maxAge (0 = any age). A stale
// entry is still returned when the refresh fails.
func (s *Service) get(ctx context.Context, lcsc string, maxAge time.Duration) (json.RawMessage, error) {
	lcsc = strings.ToUpper(strings.TrimSpace(lcsc))
	if !lcscRe.MatchString(lcsc) {
		return nil, fmt.Errorf("%q is not an LCSC part number (like C6186); search first", lcsc)
	}

	cached, at, err := s.store.Part(ctx, lcsc)
	if err == nil && (maxAge == 0 || time.Since(at) < maxAge) {
		return cached, nil
	} else if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}

	fresh, ferr := s.fetch(ctx, lcsc)
	if ferr != nil && cached != nil {
		return cached, nil
	}

	return fresh, ferr
}

func (s *Service) fetch(ctx context.Context, lcsc string) (json.RawMessage, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf(componentsURL, lcsc), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/json")

	resp, err := s.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch %s; %w", lcsc, err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, fmt.Errorf("read %s; %w", lcsc, err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch %s: EasyEDA answered %s", lcsc, resp.Status)
	}

	var env struct {
		Success bool            `json:"success"`
		Message string          `json:"message"`
		Result  json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, fmt.Errorf("decode %s; %w", lcsc, err)
	}
	if !env.Success || len(env.Result) == 0 || string(env.Result) == "null" {
		msg := env.Message
		if msg == "" {
			msg = "not found"
		}
		return nil, fmt.Errorf("part %s: %s", lcsc, msg)
	}

	if err := s.store.SavePart(ctx, lcsc, env.Result); err != nil {
		return nil, err
	}

	return env.Result, nil
}

// Model returns a part's 3D model (EasyEDA OBJ with inline materials).
func (s *Service) Model(ctx context.Context, uuid string) (string, error) {
	uuid = strings.ToLower(strings.TrimSpace(uuid))
	if !modelRe.MatchString(uuid) {
		return "", fmt.Errorf("%q is not a model id", uuid)
	}

	if obj, err := s.store.Model(ctx, uuid); err == nil {
		return obj, nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf(modelURL, uuid), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", userAgent)

	resp, err := s.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("fetch model %s; %w", uuid, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("fetch model %s: EasyEDA answered %s", uuid, resp.Status)
	}

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return "", fmt.Errorf("read model %s; %w", uuid, err)
	}
	obj := string(raw)
	if !strings.Contains(obj, "\nv ") && !strings.HasPrefix(obj, "v ") {
		return "", fmt.Errorf("model %s is not an OBJ", uuid)
	}

	if err := s.store.SaveModel(ctx, uuid, obj); err != nil {
		return "", err
	}

	return obj, nil
}

// Offer is a part's price and stock for a quantity.
type Offer struct {
	LCSC  string `json:"lcsc"`
	MPN   string `json:"mpn,omitempty"`
	Basic bool   `json:"basic"`
	// Stock at LCSC (JLCPCB assembly draws from it); nil when unknown.
	Stock *int `json:"stock,omitempty"`
	// Min and Step are the order quantity rules.
	Min  int `json:"min,omitempty"`
	Step int `json:"step,omitempty"`
	// Unit price in USD at the asked quantity; nil when unknown.
	Unit *float64 `json:"unit,omitempty"`
	// Order is what would be bought: the quantity rounded up to min/step.
	Order int `json:"order"`
	// Checked is when the data was fetched.
	Checked time.Time `json:"checked"`
	Error   string    `json:"error,omitempty"`
}

// PriceAge is how old cached prices may be before a BOM check refreshes them.
const PriceAge = 24 * time.Hour

// Offers prices parts for quantities (lcsc → pieces), refreshing cached
// data older than PriceAge.
func (s *Service) Offers(ctx context.Context, qty map[string]int) []Offer {
	out := make([]Offer, 0, len(qty))
	for lcsc, n := range qty {
		o := Offer{LCSC: strings.ToUpper(lcsc)}
		raw, err := s.get(ctx, lcsc, PriceAge)
		if err != nil {
			o.Error = err.Error()
			out = append(out, o)
			continue
		}
		if _, at, err := s.store.Part(ctx, o.LCSC); err == nil {
			o.Checked = at
		}
		var r struct {
			Title string `json:"title"`
			LCSC  *struct {
				Stock *int     `json:"stock"`
				Price *float64 `json:"price"`
				Min   int      `json:"min"`
				Step  int      `json:"step"`
				// Tiers: [[from, to, price], ...] on some responses.
				Prices [][]float64 `json:"prices"`
			} `json:"lcsc"`
			DataStr *struct {
				Head struct {
					CPara map[string]any `json:"c_para"`
				} `json:"head"`
			} `json:"dataStr"`
		}
		if err := json.Unmarshal(raw, &r); err != nil {
			o.Error = "unreadable part data"
			out = append(out, o)
			continue
		}
		o.MPN = r.Title
		if r.DataStr != nil {
			if v, _ := r.DataStr.Head.CPara["Manufacturer Part"].(string); v != "" {
				o.MPN = v
			}
			cls, _ := r.DataStr.Head.CPara["JLCPCB Part Class"].(string)
			o.Basic = cls == "Basic Part"
		}
		o.Order = n
		if r.LCSC != nil {
			o.Stock = r.LCSC.Stock
			o.Min, o.Step = r.LCSC.Min, r.LCSC.Step
			if o.Min > o.Order {
				o.Order = o.Min
			}
			if o.Step > 1 && o.Order%o.Step != 0 {
				o.Order += o.Step - o.Order%o.Step
			}
			o.Unit = r.LCSC.Price
			for _, t := range r.LCSC.Prices {
				if len(t) >= 3 && float64(o.Order) >= t[0] && (t[1] <= 0 || float64(o.Order) <= t[1]) {
					p := t[2]
					o.Unit = &p
				}
			}
		}
		out = append(out, o)
	}

	return out
}
