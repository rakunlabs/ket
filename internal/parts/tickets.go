package parts

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/rakunlabs/ada/middleware/auth/identity"
)

// UploadTicket lets one PUT of a model file into a project, without a
// session: what an MCP client gets to send a big file over plain HTTP.
type UploadTicket struct {
	ProjectID string
	Name      string
	// By is who asked for it; the upload is recorded as theirs.
	By string
	// Who is their sign-in, to check project access again when the file comes (nil without accounts).
	Who     *identity.Identity
	Expires time.Time
}

// Context is ctx acting as the person the link was made for.
func (t UploadTicket) Context(ctx context.Context) context.Context {
	if t.Who == nil {
		return ctx
	}

	return identity.WithContext(ctx, t.Who)
}

// Open links at once, in all and per person (each is small; this stops a flood).
const (
	maxTickets     = 10000
	maxTicketsEach = 50
)

// UploadTTL is how long an upload link stays valid.
const UploadTTL = 15 * time.Minute

// Tickets holds open upload links in memory; each is used once.
type Tickets struct {
	mu   sync.Mutex
	open map[string]UploadTicket
}

func NewTickets() *Tickets { return &Tickets{open: map[string]UploadTicket{}} }

// Issue opens a link for one file and returns its token.
func (t *Tickets) Issue(ctx context.Context, projectID, name, by string) (string, UploadTicket, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", UploadTicket{}, err
	}
	token := hex.EncodeToString(b)
	tk := UploadTicket{ProjectID: projectID, Name: name, By: by, Who: identity.FromContext(ctx), Expires: time.Now().Add(UploadTTL)}
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now()
	for k, v := range t.open {
		if now.After(v.Expires) {
			delete(t.open, k)
		}
	}
	if len(t.open) >= maxTickets {
		return "", UploadTicket{}, errors.New("too many open upload links; wait a few minutes or upload with the Import model button")
	}
	mine := 0
	for _, v := range t.open {
		if v.By == by {
			mine++
		}
	}
	if mine >= maxTicketsEach {
		return "", UploadTicket{}, fmt.Errorf("you have %d upload links open; use them or wait %s for them to expire", mine, UploadTTL)
	}
	t.open[token] = tk

	return token, tk, nil
}

// Take uses up a token: false when it is unknown, used or expired.
func (t *Tickets) Take(token string) (UploadTicket, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	tk, ok := t.open[token]
	delete(t.open, token)
	if !ok || time.Now().After(tk.Expires) {
		return UploadTicket{}, false
	}

	return tk, true
}
