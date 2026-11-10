package authstore_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rakunlabs/ada"
	"github.com/rakunlabs/ada/middleware/auth/identity"
	"github.com/rakunlabs/ada/middleware/auth/oauthserver"
	store "github.com/rakunlabs/ket/internal/store/auth"
)

// Exercise dynamic registration with Ket's SQL store, not just the OAuth
// library's memory store. Public app registrations are shared; grants are not.
func TestSharedClientRegistration(t *testing.T) {
	each(t, func(t *testing.T, st *store.Store) {
		ctx := context.Background()
		srv, err := oauthserver.New(oauthserver.Config{
			Issuer: "https://ket.example.com",
			Authenticate: func(http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					w.WriteHeader(http.StatusUnauthorized)
				})
			},
		}, st)
		if err != nil {
			t.Fatal(err)
		}
		mux := ada.New().Mux
		srv.Mount(mux)

		register := func(redirect, method string) oauthserver.RegistrationResponse {
			t.Helper()
			body, err := json.Marshal(oauthserver.RegistrationRequest{
				ClientName: "CLI", RedirectURIs: []string{redirect}, TokenEndpointAuthMethod: method,
			})
			if err != nil {
				t.Fatal(err)
			}
			req := httptest.NewRequest(http.MethodPost, "/oauth/register", strings.NewReader(string(body)))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)
			if rec.Code != http.StatusCreated {
				t.Fatalf("register: %d %s", rec.Code, rec.Body.String())
			}
			var out oauthserver.RegistrationResponse
			if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
				t.Fatal(err)
			}
			if out.ClientID == "" {
				t.Fatal("registration returned no client_id")
			}
			return out
		}

		first := register("http://127.0.0.1:1234/callback", "none")
		for _, redirect := range []string{"http://127.0.0.1:1234/callback", "http://127.0.0.1:5678/callback"} {
			again := register(redirect, "none")
			if again.ClientID != first.ClientID || again.RedirectURIs[0] != redirect {
				t.Fatalf("public client must reuse its ID and return the requested redirect")
			}
		}
		clients, err := st.ListClients(ctx)
		if err != nil || len(clients) != 1 {
			t.Fatalf("re-registration must leave one client: count=%d err=%v", len(clients), err)
		}

		// Sharing a client must not share tokens or remembered approval.
		for _, subject := range []string{"alice", "bob"} {
			if err := st.SaveToken(ctx, &oauthserver.Token{
				ID: subject, ClientID: first.ClientID, Identity: &identity.Identity{Subject: subject}, AccessHash: subject,
			}); err != nil {
				t.Fatal(err)
			}
			if err := st.SaveConsent(ctx, &oauthserver.Consent{Subject: subject, ClientID: first.ClientID}); err != nil {
				t.Fatal(err)
			}
			tokens, err := st.TokensBySubject(ctx, subject)
			if err != nil || len(tokens) != 1 || tokens[0].Subject() != subject {
				t.Fatalf("tokens leaked across users: subject=%s err=%v", subject, err)
			}
		}
		if err := st.DeleteSubject(ctx, "alice"); err != nil {
			t.Fatal(err)
		}
		if tok, err := st.TokenByAccess(ctx, "bob"); err != nil || tok.Subject() != "bob" {
			t.Fatalf("revoking alice must not revoke bob: %v", err)
		}
		if _, err := st.GetConsent(ctx, "bob", first.ClientID); err != nil {
			t.Fatalf("revoking alice must not remove bob's consent: %v", err)
		}

		// A matching name alone is not enough. Never merge different
		// callbacks, or confidential clients whose secrets cannot be shared.
		if other := register("http://127.0.0.1:1234/other", "none"); other.ClientID == first.ClientID {
			t.Fatal("different callback paths must not share a registration")
		}
		secret1 := register("http://127.0.0.1:1234/callback", "client_secret_basic")
		secret2 := register("http://127.0.0.1:1234/callback", "client_secret_basic")
		if secret1.ClientID == first.ClientID || secret2.ClientID == secret1.ClientID || secret1.ClientSecret == "" || secret2.ClientSecret == "" {
			t.Fatal("confidential clients must keep separate registrations and secrets")
		}
	})
}
