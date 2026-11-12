import { type APIRequestContext, type Page, expect } from '@playwright/test'

export const ADMIN = { username: 'admin', password: 'e2e-password-123' }

/** Signs in through the login page (signs up when it offers to create the first account). */
export async function signIn(page: Page, user = ADMIN) {
  await page.goto('/')
  await page.waitForURL(/\/login\//)
  await page.locator('input[name=username]').fill(user.username)
  await page.locator('input[name=password]').fill(user.password)
  const confirm = page.locator('input[name=password_confirm]')
  if (await confirm.isVisible()) await confirm.fill(user.password)
  await page.locator('button[type=submit]').click()
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()
}

/** Creates a project from the projects page and waits until its workspace has built. */
export async function createProject(page: Page, name: string) {
  await page.goto('/#/')
  await page.getByLabel('New project name').fill(name)
  await page.getByRole('button', { name: 'Create' }).click()
  await page.waitForURL(/#\/p\//)
  await expect(page.getByText('Features', { exact: true })).toBeVisible()
  return page.url().split('#/p/')[1].split(/[/?]/)[0]
}

/** The sidebar entry of a feature. */
export function feature(page: Page, name: string) {
  return page.locator('li button').filter({ has: page.locator('span', { hasText: new RegExp(`^${name}$`) }) })
}

/** A personal MCP token, minted by the signed-in browser. */
export async function mcpToken(page: Page): Promise<string> {
  const r = await page.request.post('/api/v1/tokens', { data: { name: `e2e ${Date.now()}`, days: 1 } })
  expect(r.status(), await r.text()).toBe(201)
  return (await r.json()).token
}

/** A minimal MCP client over streamable HTTP (JSON-RPC; answers may come as SSE). */
export class MCP {
  private session = ''
  private id = 0

  constructor(
    private request: APIRequestContext,
    private token: string,
    private path = '/mcp',
  ) {}

  private async rpc(method: string, params?: unknown, notify = false): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    }
    if (this.session) headers['mcp-session-id'] = this.session
    const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++this.id, method, params }
    const r = await this.request.post(this.path, { headers, data: body, timeout: 120_000 })
    const sid = r.headers()['mcp-session-id']
    if (sid) this.session = sid
    if (notify) return undefined
    const text = await r.text()
    expect(r.ok(), text).toBeTruthy()
    const json = r.headers()['content-type']?.includes('text/event-stream')
      ? JSON.parse(
          text
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .filter(Boolean)
            .at(-1)!,
        )
      : JSON.parse(text)
    if (json.error) throw new Error(`${method}: ${json.error.message}`)
    return json.result
  }

  async init() {
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ket-e2e', version: '1' } })
    await this.rpc('notifications/initialized', undefined, true)
    return this
  }

  async tools(): Promise<string[]> {
    const r = (await this.rpc('tools/list', {})) as { tools: { name: string }[] }
    return r.tools.map((x) => x.name)
  }

  /** Calls a tool; returns its text parsed as JSON when it is JSON. Throws on a tool error. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const res = (await this.rpc('tools/call', { name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string }[] }
    const text = res.content.find((c) => c.type === 'text')?.text ?? ''
    if (res.isError) throw new Error(`${name}: ${text}`)
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
}
