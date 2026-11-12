// HTTP API client.

export interface ProjectItem {
  id: string
  name: string
  description: string
  updated_at: string
  created_at?: string
  head: number
  sessions: number
  access?: Access
}

export type Access = 'owner' | 'editor' | 'viewer'

export interface ProviderIn {
  name: string
  /** The name before a rename, so the stored key follows. */
  previous_name?: string
  base_url: string
  api_key?: string
  model: string
  vision: boolean
  temperature?: number
}

export interface AdminSettings {
  public_url: string
  signup: boolean
  default_role: string
  providers: (ProviderIn & { has_key: boolean })[]
  default_provider?: string
  max_steps: number
  /** History size, in estimated tokens, at which older turns are summarized. */
  compact_tokens: number
  /** Tokens one user may spend per calendar month; 0 = no limit. */
  monthly_tokens: number
}

export interface TemplateInfo {
  id: string
  kind: 'template' | 'block'
  name: string
  description: string
  bytes: number
  created_by?: string
  updated_at: string
}

export interface UsageRow {
  day: string
  user: string
  project_id?: string
  project?: string
  provider: string
  model: string
  requests: number
  prompt_tokens: number
  completion_tokens: number
  estimated?: boolean
}

export type AdminSettingsIn = Omit<AdminSettings, 'providers'> & { providers: ProviderIn[]; clear_keys?: string[] }

export interface AdminUser {
  id: string
  username: string
  name?: string
  email?: string
  roles: string[]
  disabled?: boolean
  created_at?: string | number
}

export interface Member {
  user_id: string
  username: string
  name?: string
  role: 'owner' | 'editor' | 'viewer'
}

export interface Group {
  id: string
  name: string
  description: string
  members: { user_id: string; username: string; name?: string }[]
}

export interface GroupShare {
  group_id: string
  name: string
  role: 'editor' | 'viewer'
}

export interface SSOProvider {
  name: string
  display_name: string
  enabled: boolean
  issuer_url: string
  auth_url: string
  token_url: string
  userinfo_url: string
  jwks_url: string
  client_id: string
  scopes: string[]
  token_auth_method: string
  disable_pkce: boolean
  auto_create: boolean
  link_by_email: boolean
  allowed_domains: string[]
  roles_claim: string
  role_mapping: Record<string, string>
  default_role: string
  group_mapping: Record<string, string>
}

export type SSOView = SSOProvider & { has_secret: boolean; callback_url: string; status?: string }

export interface LinkedIdentity {
  provider: string
  subject: string
  email: string
  last_login: string
}

export interface Project {
  id: string
  name: string
  description: string
  main_branch: string
  head: number
  owner_id?: string
  access?: Access
}

export interface StoredOp {
  seq: number
  op: { cmd: string; args: unknown }
  author: string
  message: string
  created_at: string
}

export interface Info {
  name: string
  version: string
  mcp_url: string
  auth: boolean
  commit?: string
  build_date?: string
  repository?: string
  go?: string
}

export interface ProviderInfo {
  name: string
  model: string
  vision: boolean
}

export interface Me {
  auth: boolean
  id?: string
  username?: string
  name?: string
  roles?: string[]
  permissions: string[]
}

/** Same rules as the server: "*", exact, or a "prefix:*" pattern. */
export function can(me: Me | undefined, perm: string): boolean {
  if (!me) return false
  return me.permissions.some((p) => p === '*' || p === perm || (p.endsWith('*') && perm.startsWith(p.slice(0, -1))))
}

export interface Conversation {
  id: string
  project_id: string
  title: string
  updated_at: string
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content?: string | { type: string; text?: string; image_url?: { url: string } }[]
  tool_calls?: { id: string; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

/** Base path of the app: the directory index.html was served from. */
export const base = new URL('.', document.baseURI).pathname.replace(/\/$/, '')

/**
 * Sends the browser to the login page, coming back here afterwards. The
 * returned promise never settles: the page is going away.
 */
export function toLogin(): Promise<never> {
  location.href = `${base}/login/?redirect_path=${encodeURIComponent(location.pathname + location.search + location.hash)}`
  return new Promise<never>(() => {})
}

/** A model file uploaded to a project; url is what import takes. */
export interface Upload {
  id: string
  name: string
  bytes: number
  url: string
  /** A 3MF's objects: import one with url#<id>. */
  objects?: { id: string; name: string; triangles?: number }[]
  created_by?: string
  created_at: string
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401) return toLogin()
  if (!res.ok) {
    let msg = res.statusText
    try {
      const j = await res.json()
      msg = j.message ?? j.error ?? msg
    } catch {
      // not JSON
    }
    throw new Error(msg)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const api = {
  info: () => req<Info>('GET', '/info'),
  me: () => req<Me>('GET', '/me'),
  providers: () => req<ProviderInfo[]>('GET', '/providers'),
  logout: () => fetch(`${base}/logout`, { method: 'POST' }),
  tokens: () => req<{ id: string; name: string; client_id: string; created_at: string; expires_at: string }[]>('GET', '/tokens'),
  createToken: (name: string, days: number) => req<{ id: string; token: string }>('POST', '/tokens', { name, days }),
  deleteToken: (id: string) => req<void>('DELETE', `/tokens/${id}`),
  projects: (q: { q?: string; sort?: string; filter?: string; limit?: number; offset?: number } = {}) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v))
    return req<{ items: ProjectItem[]; total: number }>('GET', `/projects?${p}`)
  },
  settings: () => req<{ settings: AdminSettings; roles: { name: string; description?: string; permissions: string[] }[] }>('GET', '/settings'),
  saveSettings: (s: AdminSettingsIn) => req<{ settings: AdminSettings }>('PUT', '/settings', s),
  usage: (days = 30) => req<{ days: number; rows: UsageRow[]; monthly_limit: number }>('GET', `/settings/usage?days=${days}`),
  myUsage: () => req<{ used: number; limit: number }>('GET', '/me/usage'),
  testProvider: (p: ProviderIn) => req<{ ok: boolean; message: string }>('POST', '/settings/test-provider', p),
  account: () => fetch(`${base}/api/account`).then((r) => r.json() as Promise<{ username: string; name?: string; email?: string; has_password: boolean }>),
  changePassword: async (current: string, password: string) => {
    const r = await fetch(`${base}/api/account/password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current, password }) })
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message ?? r.statusText)
  },
  adminUsers: async () => {
    const r = await fetch(`${base}/api/admin/users`)
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message ?? r.statusText)
    const body = await r.json()
    return (Array.isArray(body) ? body : (body.users ?? body.items ?? [])) as AdminUser[]
  },
  adminUser: async (method: 'POST' | 'PATCH' | 'DELETE', id: string | undefined, body?: unknown) => {
    const r = await fetch(`${base}/api/admin/users${id ? `/${id}` : ''}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message ?? r.statusText)
    return r.status === 204 ? undefined : r.json()
  },
  createProject: (name: string, description = '', template?: string) => req<Project>('POST', '/projects', { name, description, ...(template ? { template } : {}) }),
  templates: (kind?: 'template' | 'block') => req<TemplateInfo[]>('GET', `/templates${kind ? `?kind=${kind}` : ''}`),
  template: (id: string) => req<TemplateInfo & { data: string }>('GET', `/templates/${encodeURIComponent(id)}`),
  saveTemplate: (t: { kind: 'template' | 'block'; name: string; description?: string; data: string; replace?: boolean }) => req<TemplateInfo>('POST', '/templates', t),
  deleteTemplate: (id: string) => req<{ ok: boolean }>('DELETE', `/templates/${encodeURIComponent(id)}`),
  project: (id: string) => req<Project>('GET', `/projects/${id}`),
  members: (id: string) => req<{ sharing: boolean; access: Access; members: Member[]; groups: GroupShare[] }>('GET', `/projects/${id}/members`),
  setProjectGroup: (id: string, group: string, role: GroupShare['role']) => req<void>('PUT', `/projects/${id}/groups/${group}`, { role }),
  removeProjectGroup: (id: string, group: string) => req<void>('DELETE', `/projects/${id}/groups/${group}`),
  groups: () => req<Group[]>('GET', '/groups'),
  saveGroup: (id: string | undefined, g: { name: string; description: string; members?: string[] }) => req<Group>(id ? 'PUT' : 'POST', id ? `/groups/${id}` : '/groups', g),
  deleteGroup: (id: string) => req<void>('DELETE', `/groups/${id}`),
  userAccess: (id: string) => req<{ groups: string[]; identities: LinkedIdentity[] }>('GET', `/admin/users/${id}/access`),
  setUserGroups: (id: string, groups: string[]) => req<void>('PUT', `/admin/users/${id}/groups`, { groups }),
  unlinkIdentity: (id: string, provider: string, subject: string) => req<void>('POST', `/admin/users/${id}/unlink`, { provider, subject }),
  sso: () => req<{ providers: SSOView[]; callback_base: string }>('GET', '/settings/sso'),
  saveSSO: (original: string | undefined, p: SSOProvider & { client_secret?: string }) =>
    req<{ providers: SSOView[] }>(original ? 'PUT' : 'POST', original ? `/settings/sso/${original}` : '/settings/sso', p),
  deleteSSO: (name: string) => req<{ providers: SSOView[] }>('DELETE', `/settings/sso/${name}`),
  setMember: (id: string, user: string, role: Member['role']) => req<void>('PUT', `/projects/${id}/members/${encodeURIComponent(user)}`, { role }),
  removeMember: (id: string, user: string) => req<void>('DELETE', `/projects/${id}/members/${encodeURIComponent(user)}`),
  users: () => req<Member[]>('GET', '/users'),
  renameProject: (id: string, name: string) => req<void>('PATCH', `/projects/${id}`, { name }),
  deleteProject: (id: string) => req<void>('DELETE', `/projects/${id}`),
  ops: (id: string, from = 0, all = false, branch?: string) =>
    req<{ head: number; top: number; ops: StoredOp[] }>('GET', `/projects/${id}/ops?from=${from}${all ? '&all=true' : ''}${branch ? `&branch=${branch}` : ''}`),
  branches: (id: string) => req<Branch[]>('GET', `/projects/${id}/branches`),
  acceptBranch: (id: string) => req<{ head: number }>('POST', `/branches/${id}/accept`),
  rejectBranch: (id: string) => req<void>('POST', `/branches/${id}/reject`),
  conversations: (id: string) => req<Conversation[]>('GET', `/projects/${id}/conversations`),
  createConversation: (id: string) => req<Conversation>('POST', `/projects/${id}/conversations`),
  conversation: (id: string) => req<{ conversation: Conversation; messages: ChatMessage[] }>('GET', `/conversations/${id}`),
  deleteConversation: (id: string) => req<void>('DELETE', `/conversations/${id}`),
  stop: (id: string) => req<{ stopped: boolean }>('POST', `/conversations/${id}/stop`),
  uploads: (id: string) => req<Upload[]>('GET', `/projects/${id}/uploads`),
  deleteUpload: (id: string, upload: string) => req<void>('DELETE', `/projects/${id}/uploads/${upload}`),
  async upload(id: string, file: File): Promise<Upload> {
    const res = await fetch(`${base}/api/v1/projects/${id}/uploads?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file })
    if (res.status === 401) return toLogin()
    if (!res.ok) {
      let msg = res.statusText
      try {
        const j = await res.json()
        msg = j.message ?? j.error ?? msg
      } catch {
        // not JSON
      }
      throw new Error(msg)
    }
    return res.json() as Promise<Upload>
  },
}

export function wsURL(projectID: string, branch?: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}${base}/api/v1/projects/${projectID}/ws${branch ? `?branch=${branch}` : ''}`
}

export interface Branch {
  id: string
  project_id: string
  name: string
  parent_id?: string
  base_seq: number
  head_seq: number
}

export interface AgentEvent {
  type: 'text' | 'tool_call' | 'tool_result' | 'usage' | 'done' | 'error' | 'branch'
  delta?: string
  usage?: { prompt_tokens: number; completion_tokens: number; estimated?: boolean }
  id?: string
  name?: string
  args?: unknown
  text?: string
  is_error?: boolean
  images?: string[]
  message?: string
}

/** Sends a chat message and calls onEvent for every streamed event. */
export async function chat(
  conversationID: string,
  text: string,
  provider: string | undefined,
  onEvent: (e: AgentEvent) => void,
  signal?: AbortSignal,
  propose = false,
) {
  const res = await fetch(`${base}/api/v1/conversations/${conversationID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, provider, propose }),
    signal,
  })
  if (res.status === 401) await toLogin()
  if (!res.ok || !res.body) {
    let msg = res.statusText
    try {
      msg = (await res.json()).message ?? msg
    } catch {
      // not JSON
    }
    throw new Error(msg)
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += value
    let i: number
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i)
      buf = buf.slice(i + 2)
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data:')) {
          try {
            onEvent(JSON.parse(line.slice(5).trim()))
          } catch {
            // ignore malformed event
          }
        }
      }
    }
  }
}
