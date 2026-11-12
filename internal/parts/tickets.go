package parts

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

// UploadTicket lets one PUT of a model file into a project, without a
// session: what an MCP client gets to send a big file over plain HTTP.
type UploadTicket struct {
	ProjectID string
	Name      string
	// By is who asked for it; the upload is recorded as theirs.
	By      string
	Expires time.Time
}

// UploadTTL is how long an upload link stays valid.
const UploadTTL = 15 * time.Minute

// Tickets holds open upload links in memory; each is used once.
type Tickets struct {
	mu   sync.Mutex
	open map[string]UploadTicket
}

func NewTickets() *Tickets { return &Tickets{open: map[string]UploadTicket{}} }

// Issue opens a link for one file and returns its token.
func (t *Tickets) Issue(projectID, name, by string) (string, UploadTicket) {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	token := hex.EncodeToString(b)
	tk := UploadTicket{ProjectID: projectID, Name: name, By: by, Expires: time.Now().Add(UploadTTL)}
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now()
	for k, v := range t.open {
		if now.After(v.Expires) {
			delete(t.open, k)
		}
	}
	t.open[token] = tk

	return token, tk
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
