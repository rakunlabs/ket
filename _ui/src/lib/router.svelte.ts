// Hash router: #/ is the project list (#/?q=..&page=..&filter=..), #/p/<id>
// opens a project, #/settings/<tab> is the admin settings. Hash routes need
// no server rewrites and work under any base path.

class Router {
  path = $state(location.hash.slice(1) || '/')

  constructor() {
    window.addEventListener('hashchange', () => {
      this.path = location.hash.slice(1) || '/'
    })
  }

  go(path: string) {
    location.hash = path
  }

  get project(): string | undefined {
    return /^\/p\/([^/?]+)/.exec(this.path)?.[1]
  }

  /** The settings tab, when on #/settings. */
  get settings(): string | undefined {
    const m = /^\/settings(?:\/([^/?]+))?/.exec(this.path)
    return m ? (m[1] ?? 'ai') : undefined
  }

  /** Query parameters of the current route (#/?q=x). */
  get query(): URLSearchParams {
    const i = this.path.indexOf('?')
    return new URLSearchParams(i < 0 ? '' : this.path.slice(i + 1))
  }

  /** Replaces the query of the current route without a history entry. */
  setQuery(params: Record<string, string | number | undefined>) {
    const base = this.path.split('?')[0]
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '' && v !== 0) q.set(k, String(v))
    const next = q.size ? `${base}?${q}` : base
    history.replaceState(null, '', `#${next}`)
    this.path = next
  }
}

export const router = new Router()
