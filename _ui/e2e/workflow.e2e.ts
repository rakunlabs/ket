import { expect, test } from '@playwright/test'

import { MCP, createProject, feature, mcpToken, signIn } from './helpers'

// One browser context for the whole file: the first test signs up the
// administrator, the rest reuse that session.
test.describe.configure({ mode: 'serial' })

let ctx: Awaited<ReturnType<import('@playwright/test').Browser['newContext']>>
let page: import('@playwright/test').Page
let project = ''
let mcp: MCP

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext()
  page = await ctx.newPage()
  page.on('console', (m) => m.type() === 'error' && console.log('[browser]', m.text()))
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
})

test.afterAll(async () => {
  await ctx.close()
})

test('the first sign-up becomes the administrator', async () => {
  await signIn(page)
  const me = await (await page.request.get('/api/v1/me')).json()
  expect(JSON.stringify(me)).toContain('admin')
})

test('a project opens and builds in the browser', async () => {
  project = await createProject(page, 'E2E enclosure')
  await expect(page.getByText('None yet.').first()).toBeVisible()
})

test('a command over MCP makes a body appear in the open tab', async () => {
  mcp = await new MCP(page.request, await mcpToken(page)).init()
  const listed = await mcp.call('list_projects')
  expect(JSON.stringify(listed)).toContain(project)
  await mcp.call('box', { project, name: 'case_body', size: [40, 30, 12] })
  await expect(feature(page, 'case_body')).toBeVisible()
  const m = await mcp.call('measure', { project, name: 'case_body' })
  expect(m.size).toEqual([40, 30, 12])
})

test('undo and redo move the head', async () => {
  await page.getByTitle('Undo (Ctrl+Z)').click()
  await expect(feature(page, 'case_body')).toHaveCount(0)
  await page.getByTitle('Redo (Ctrl+Shift+Z)').click()
  await expect(feature(page, 'case_body')).toBeVisible()
})

test('a second tab of the same project follows changes live', async () => {
  const other = await ctx.newPage()
  await other.goto(`/#/p/${project}`)
  await expect(feature(other, 'case_body')).toBeVisible()
  await mcp.call('cylinder', { project, name: 'boss', r: 3, h: 8 })
  await expect(feature(other, 'boss')).toBeVisible()
  await expect(feature(page, 'boss')).toBeVisible()
  await other.close()
})

test('a proposal is reviewed and accepted', async () => {
  await mcp.call('start_proposal', { project, name: 'add a lid' })
  await mcp.call('box', { project, name: 'lid', size: [40, 30, 2], translate: [0, 0, 14] })
  await mcp.call('finish_proposal')
  await expect(page.getByText('Proposal', { exact: true })).toBeVisible()
  const review = page.getByRole('button', { name: 'review' })
  if (await review.isVisible()) await review.click()
  await expect(feature(page, 'lid')).toBeVisible()
  await page.getByRole('button', { name: 'Accept' }).click()
  await expect(page.getByText('Proposal', { exact: true })).toHaveCount(0)
  await expect(feature(page, 'lid')).toBeVisible()
  const doc = await mcp.call('get_document', { project })
  expect(JSON.stringify(doc)).toContain('"lid"')
})

test('export_fab writes the fabrication files of a routed board', async () => {
  await mcp.call('set_board', { project, outline: { rect: { w: 30, h: 20 } } })
  await mcp.call('add_component', { project, footprint_name: '0603', ref: 'R1', at: [-5, 0], pin_names: { 1: 'A', 2: 'B' } })
  await mcp.call('add_component', { project, footprint_name: '0603', ref: 'R2', at: [5, 0], pin_names: { 1: 'A', 2: 'B' } })
  await mcp.call('connect', { project, nets: [{ name: 'SIG', pins: ['R1.2', 'R2.1'] }] })
  await mcp.call('autoroute', { project })
  const download = page.waitForEvent('download')
  const out = await mcp.call('export_fab', { project })
  const file = await download
  expect(file.suggestedFilename()).toMatch(/\.zip$/)
  for (const f of ['board-F_Cu.gtl', 'board-B_Cu.gbl', 'board-Edge_Cuts.gm1', 'board-F_Mask.gts']) expect(out.files).toContain(f)
  expect(out.bytes).toBeGreaterThan(500)
})

test('an SVG logo converts to silkscreen artwork', async () => {
  await page.getByRole('radio', { name: 'PCB', exact: true }).click()
  await page.getByRole('button', { name: 'Appearance' }).click()
  await page.getByRole('button', { name: 'Logo', exact: true }).click()
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect x="2" y="2" width="16" height="6" fill="#000"/></svg>'
  await page.getByLabel('Logo image').setInputFiles({ name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) })
  await expect(page.locator('img[src^="data:image/png"]').first()).toBeVisible()
})
