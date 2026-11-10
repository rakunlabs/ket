# Agent notes

- Go follows the rakunlabs layout: `cmd/ket`, `internal/*`, UI in `_ui/`
  built into `internal/server/dist` and embedded.
- **The command registry in `_ui/src/engine` is the source of truth.** After
  adding or changing a command, run `make gen` so `internal/catalog/catalog.json`
  (and so MCP and the agent) match. Every new capability ships as a command
  plus a way to verify it (query, check or render), never as UI-only code.
- Commands must be pure functions of the document (`apply`), so replaying
  the op log is deterministic. Error messages are read by models: say what
  is wrong and what to do.
- Commands that need the network (parts, autoroute) do it in `prepare`,
  and the fetched data goes into the op's arguments (`internal` fields hidden
  from tool schemas). `apply` never does I/O.
- replicad operations consume their inputs: work on `kernel.shape(name)`
  (a clone), never on cached shapes.
- Verify: `go vet ./...`, `go test ./...`, `cd _ui && pnpm check && pnpm test`.
  Store tests need `KET_TEST_DSN` (see `make env`).
