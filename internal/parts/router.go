package parts

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Freerouting releases by the Java they need: 2.5 is built for Java 25,
// 2.1 runs on Java 17+.
var freeroutingByJava = []struct {
	minJava int
	version string
}{
	{25, "2.5.0"},
	{17, "2.1.0"},
}

func freeroutingURL(version string) string {
	return "https://github.com/freerouting/freerouting/releases/download/v" + version + "/freerouting-" + version + ".jar"
}

var javaVersionRe = regexp.MustCompile(`version "(\d+)(?:\.(\d+))?`)

// javaMajor runs `java -version` and returns the major version.
func javaMajor(ctx context.Context, java string) (int, error) {
	out, err := exec.CommandContext(ctx, java, "-version").CombinedOutput()
	if err != nil {
		return 0, fmt.Errorf("run %s -version; %w", java, err)
	}
	m := javaVersionRe.FindSubmatch(out)
	if m == nil {
		return 0, fmt.Errorf("cannot read the Java version from %q", strings.TrimSpace(string(out)))
	}
	major, _ := strconv.Atoi(string(m[1]))
	if major == 1 && len(m[2]) > 0 {
		major, _ = strconv.Atoi(string(m[2]))
	}

	return major, nil
}

// Router runs Freerouting (Java) on a Specctra DSN and returns the SES.
type Router struct {
	// Jar is the path of freerouting.jar; downloaded on first use if missing.
	Jar  string
	Java string

	// configured is true when Jar came from the config: never replace it.
	configured bool

	mu       sync.Mutex
	download sync.Mutex
}

// NewRouter uses jar when set; otherwise it picks the Freerouting release
// that matches the installed Java and downloads it to the user cache dir.
func NewRouter(jar, java string) *Router {
	if java == "" {
		java = "java"
	}

	return &Router{Jar: jar, Java: java, configured: jar != ""}
}

// Configure changes the Java binary and jar (from the admin settings).
// An empty jar goes back to the downloaded release.
func (r *Router) Configure(jar, java string) {
	r.download.Lock()
	defer r.download.Unlock()
	if java == "" {
		java = "java"
	}
	if jar == "" && r.configured {
		r.Jar = ""
	}
	if jar != "" {
		r.Jar = jar
	}
	r.Java = java
	r.configured = jar != ""
}

func (r *Router) ensureJar(ctx context.Context) error {
	r.download.Lock()
	defer r.download.Unlock()

	if r.Jar != "" {
		if st, err := os.Stat(r.Jar); err == nil && st.Size() > 1<<20 {
			return nil
		}
		if r.configured {
			return fmt.Errorf("freerouting jar %s is missing; fix the path in Settings → PCB or clear it to download one", r.Jar)
		}
	}

	major, err := javaMajor(ctx, r.Java)
	if err != nil {
		return err
	}
	version := ""
	for _, v := range freeroutingByJava {
		if major >= v.minJava {
			version = v.version
			break
		}
	}
	if version == "" {
		return fmt.Errorf("autoroute needs Java 17 or newer; the server has Java %d", major)
	}

	dir, err := os.UserCacheDir()
	if err != nil {
		dir = os.TempDir()
	}
	r.Jar = filepath.Join(dir, "ket", "freerouting-"+version+".jar")
	if st, err := os.Stat(r.Jar); err == nil && st.Size() > 1<<20 {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(r.Jar), 0o755); err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, freeroutingURL(version), nil)
	if err != nil {
		return err
	}
	resp, err := (&http.Client{Timeout: 5 * time.Minute}).Do(req)
	if err != nil {
		return fmt.Errorf("download freerouting; %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download freerouting: %s", resp.Status)
	}

	tmp := r.Jar + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	n, err := io.Copy(f, resp.Body)
	_ = f.Close()
	if err != nil || n < 1<<20 {
		_ = os.Remove(tmp)
		return fmt.Errorf("download freerouting: got %d bytes; %v", n, err)
	}

	return os.Rename(tmp, r.Jar)
}

// freerouting.json for headless batch runs: no GUI, no analytics, no
// optimizer (the router alone connects the board).
const routerConfig = `{
  "profile": {"id": "00000000-0000-4000-8000-000000000000", "email": "", "allow_telemetry": false, "allow_contact": false},
  "gui": {"enabled": false, "input_directory": "", "dialog_confirmation_timeout": 5},
  "router": {"optimizer": {"enabled": false}, "scoring": {}},
  "usage_and_diagnostic_data": {"disable_analytics": true},
  "feature_flags": {"multi_threading": true, "inspection_mode": false, "other_menu": false, "save_jobs": false},
  "api_server": {"enabled": false},
  "logging": {"console": {"enabled": true, "level": "INFO"}, "file": {"enabled": false, "level": "INFO", "location": ""}}
}`

// Route runs the autorouter. passes bounds the routing passes.
func (r *Router) Route(ctx context.Context, dsn []byte, passes int, timeout time.Duration) ([]byte, error) {
	r.download.Lock()
	java := r.Java
	r.download.Unlock()
	if _, err := exec.LookPath(java); err != nil {
		return nil, fmt.Errorf("autoroute needs Java (OpenJDK 17+) on the server: %q was not found; an administrator sets the Java path in Settings → PCB", java)
	}
	if err := r.ensureJar(ctx); err != nil {
		return nil, err
	}
	r.download.Lock()
	jar := r.Jar
	r.download.Unlock()

	// One route at a time: Freerouting is memory and CPU hungry.
	r.mu.Lock()
	defer r.mu.Unlock()

	dir, err := os.MkdirTemp("", "ket-route-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)

	in := filepath.Join(dir, "board.dsn")
	out := filepath.Join(dir, "board.ses")
	if err := os.WriteFile(in, dsn, 0o644); err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(dir, "freerouting.json"), []byte(routerConfig), 0o644); err != nil {
		return nil, err
	}

	if passes <= 0 {
		passes = 20
	}
	if timeout <= 0 {
		timeout = 3 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, java, "-Djava.awt.headless=true", "-jar", jar, "-de", in, "-do", out, "-mp", strconv.Itoa(passes))
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"FREEROUTING__USER_DATA_PATH="+dir,
		"FREEROUTING__USAGE_AND_DIAGNOSTIC_DATA__DISABLE_ANALYTICS=true",
	)
	var logs bytes.Buffer
	cmd.Stdout = &logs
	cmd.Stderr = &logs

	runErr := cmd.Run()
	ses, readErr := os.ReadFile(out)
	if readErr != nil {
		tail := logs.String()
		if len(tail) > 1500 {
			tail = tail[len(tail)-1500:]
		}
		if ctx.Err() != nil {
			return nil, fmt.Errorf("autoroute timed out after %s", timeout)
		}
		return nil, fmt.Errorf("freerouting produced no result (%v): %s", runErr, tail)
	}

	return ses, nil
}
