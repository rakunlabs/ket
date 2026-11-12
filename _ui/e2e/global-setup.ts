// Empties the end-to-end database and starts bin/ket on it; the returned
// function stops the server after the run.
import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import path from 'node:path'

const repo = path.resolve(import.meta.dirname, '../..')

export default async function globalSetup() {
  const port = process.env.KET_E2E_PORT ?? '18080'
  const dsn = process.env.KET_E2E_DSN ?? 'postgres://ket:ket@localhost:5432/ket_e2e?sslmode=disable'
  const bin = process.env.KET_E2E_BIN ?? path.join(repo, 'bin/ket')

  execFileSync('go', ['run', './_ui/e2e/resetdb'], { cwd: repo, env: { ...process.env, KET_E2E_DSN: dsn }, stdio: 'inherit' })

  const logs = path.join(import.meta.dirname, '../e2e-logs')
  mkdirSync(logs, { recursive: true })
  const log = createWriteStream(path.join(logs, 'ket.log'), { flags: 'w' })
  const server = spawn(bin, [], {
    cwd: repo,
    env: { ...process.env, KET_SERVER_PORT: port, KET_STORE_POSTGRES_DSN: dsn, KET_LOG_LEVEL: 'debug' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.pipe(log)
  server.stderr.pipe(log)
  let exited: number | null = null
  server.on('exit', (code) => (exited = code ?? -1))

  const deadline = Date.now() + 30_000
  for (;;) {
    if (exited !== null) throw new Error(`bin/ket exited with ${exited} before it was ready; see _ui/e2e-logs/ket.log (run make build first)`)
    try {
      const r = await fetch(`http://localhost:${port}/healthz`)
      if (r.ok) break
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      server.kill()
      throw new Error(`bin/ket did not answer /healthz on port ${port} within 30 s; see _ui/e2e-logs/ket.log`)
    }
    await new Promise((r) => setTimeout(r, 200))
  }

  return async () => {
    server.kill('SIGTERM')
    await new Promise((r) => server.once('exit', r))
  }
}
