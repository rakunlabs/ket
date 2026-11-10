# Ket

Parametric CAD and PCB design in one document, built to be driven by AI.
Describe a part or a board in the chat panel, or point Claude Code / Cursor
at the MCP endpoint, and watch it being modelled, routed, checked and
rendered live in the browser. The board and its parts are bodies of the 3D
model, so an enclosure is designed around them with the same parameters.

One Go binary serves the API, the MCP endpoint and the embedded Svelte UI;
OpenCascade (WASM) runs in the browser.

## Quick start

```sh
make env                 # PostgreSQL in Docker
make build && ./bin/ket  # http://localhost:8080
```

Open Ket and create the first account: it becomes the administrator (and
owns any projects made before accounts). Then **Settings**:

- **AI providers**: any OpenAI-compatible endpoint (OpenAI, OpenRouter,
  Ollama, vLLM...), with a connection test. Keys are encrypted in the
  database and never sent back to the browser.
- **Users**: add people, roles (admin, editor, viewer), disable, reset
  passwords.
- **Groups**: teams of users; share a project with a group to give all its
  members access.
- **Sign-in providers**: Google, Microsoft Entra, GitHub, GitLab, Keycloak or
  any OAuth2 / OpenID Connect provider. Sign-ins link to local accounts (by a
  verified email, or created on first sign-in); roles and groups can follow
  the provider's claims (`groups`, `realm_access.roles`, ...).
- **Access & server**: open sign-up, role of new accounts, public URL.
- **PCB tools**: Java and Freerouting jar for autoroute.

`ket.yaml` (optional, see `ket.example.yaml`) holds infrastructure only:
database DSN, port, base path. An `ai:` or `pcb:` section from an older
config seeds the settings once, on first start.

Autorouting needs Java 17+ on the server; the matching Freerouting release
is downloaded on first use (2.1 for Java 17-24, 2.5 for Java 25+).

Development: `make run` (backend on :8080) and `make run-ui` (Vite with
hot reload, proxies the API).

Connect an external agent (open the project in the browser first: the
geometry kernel runs there):

```sh
claude mcp add --transport http ket http://localhost:8080/mcp
```

## How it works

```
MCP client ─┐                         ┌─ browser tab (Svelte UI)
            ├─ Go server ──WebSocket──┤   command registry + op log
chat panel ─┘  (ada, hub, agent)      └─ kernel worker (OpenCascade WASM)
                    │
                 PostgreSQL: projects, op log, conversations
```

- **The document** is JSON: parameters (numbers or expressions such as
  `board_w + 2*wall`), an ordered list of named features (box, cylinder,
  extrude, boolean, fillet, chamfer, shell, transform, pattern) and checks.
  Geometry is never stored; it is rebuilt from the features, and only the
  features that changed are recomputed.
- **One command registry** (`_ui/src/engine`) defines every operation with
  a zod schema. `pnpm gen` writes `internal/catalog/catalog.json`, which the
  server turns into MCP tools and the agent's tools. The UI, MCP and the
  chat agent therefore have exactly the same capabilities.
- **Op log**: every change is one op (`{cmd, args}`, or an atomic `batch`)
  in PostgreSQL. Undo/redo move the head; replaying 1..head rebuilds the
  document. Other tabs get each op live.
- **The hub** relays a tool call from MCP or the agent to the browser that
  has the project open; the browser runs it and answers with a compact
  result (what changed, bounding boxes, volumes, errors, warnings).
- **Tabs**: several projects open side by side, one tab each (Alt+1..9).
  Every Ket window keeps a link to the server, so an MCP client opens and
  closes tabs itself (`open_project`, `close_project`), and a command on a
  closed project opens it in a background tab. Tabs not used lately sleep
  to save memory and wake on click.
- **AI-first feedback**: `run_checks` verifies requirements (`inside`,
  `min_distance`, `no_overlap`, `volume`, expressions); `measure`,
  `list_faces` and `list_edges` answer numerically; `render` returns PNG
  views (iso, top, front, ..., highlights, section cuts). Errors say what to
  change ("fillet r is too large for the selected edges ...").
- **Sketches**: constrained 2D sketches solved by FreeCAD's planegcs
  (WASM): points, lines, arcs, circles and constraints (horizontal, length,
  tangent, ...). `solve_sketch` reports degrees of freedom and conflicting
  constraints by number. Extrude or revolve them; inner loops are holes.
- **PCB**: real parts from the LCSC / JLCPCB library (fetched by the server,
  cached in PostgreSQL, footprint and pin names parsed in the browser),
  nets by pin name (`U1.VIN`), net classes, Freerouting autoroute (Java on
  the server), JLCPCB DRC, ratsnest, Gerber X2 + Excellon + BOM + CPL zip.
  The parsing and Specctra conventions follow Flamingo (MIT).
- **Copper pours** (Clipper2): clearance to other nets, thermal spokes to
  same-net pads, floating islands dropped; the ratsnest and DRC count pour
  connectivity, Gerber writes them with clear polarity for holes.
- **Real part models**: EasyEDA 3D models (OBJ) fetched and cached by the
  server, placed on the board in the viewport and in renders; their height
  feeds the `part_*` blocks used for enclosure checks.
- **Schematic**: drawn from the netlist with the parts' symbols and net
  labels, so it always matches the board (`render_schematic`). Editable:
  click a pin, click empty space to bend, click another pin to draw a wire
  (`wire_pins`, merges nets); wires are stored, routed orthogonally around
  symbols and follow moved parts; select a wire and press Delete
  (`remove_wires`, splits automatic nets); shift-click a pin to disconnect;
  drag symbols (`place_symbol`); `rename_net`.
- **Measuring**: click a body for its size, volume and center; the ruler (M)
  measures between two picked surface points; `measure_between` for agents
  (features or points).
- **BOM check** (`check_bom`, BOM button in the PCB view): LCSC stock and
  price for N boards, order rounding, basic/extended parts and their fees,
  stock problems; prices refresh daily.
- **Loft and sweep**: blend between sections; sweep a profile along a path
  with rounded bends.
- **Proposals**: the agent (chat "propose", or `start_proposal` over MCP)
  works on a branch; the browser follows it, shows the changes against the
  current design and accepts (merges) or rejects it.
- **Accounts** (ada Auth Kit, always on): login page, first-run sign-up of
  the administrator, users and roles (admin, editor, viewer), MCP over OAuth
  2.1 or personal tokens, op log authors per user. Login sessions live in
  PostgreSQL (signed and encrypted with keys generated on first start), so
  restarts keep everyone signed in. Projects belong to their creator and are shared
  with people or groups as viewer or editor (Share button); MCP and the assistant see
  only what the user may see.
- **Chat agent** (`internal/agent`): the tool loop runs on the server
  against any OpenAI-compatible endpoint, so API keys stay on the server.
  Renders go to vision models as images.

## Layout

```
cmd/ket/            main: into.Init(run)
internal/config/    chu config: infrastructure only (KET_ env prefix)
internal/settings/  admin settings (AI providers, sign-up, PCB tools), encrypted keys
internal/sso/       OAuth2 / OIDC sign-in providers, claim → role/group sync
internal/store/     PostgreSQL (pgx) + muz migrations
internal/hub/       browser sessions, op commits, command relay
internal/catalog/   generated command catalog (catalog.json)
internal/mcpserver/ tools from the catalog; MCP streamable HTTP
internal/agent/     built-in chat agent (OpenAI-compatible)
internal/auth/      ada Auth Kit (copied reference: users, roles, OAuth wiring)
internal/parts/     LCSC/EasyEDA parts proxy + cache, Freerouting runner
internal/server/    ada routes, websocket, SSE chat, embedded UI
_ui/src/engine/     document, expressions, commands, kernel (replicad),
                    sketches (planegcs)
_ui/src/engine/pcb/ footprints, board, DRC, ratsnest, DSN/SES, Gerber
_ui/src/lib/        session (op log + sync), kernel worker client, 3D scene
_ui/src/components/ sidebar, viewport, chat
```

## Roadmap

1. ~~Skeleton, op log, MCP, chat agent, CAD primitives and operations~~
2. ~~Constrained 2D sketches (planegcs), revolve~~
3. ~~PCB: LCSC parts, nets by pin name, Freerouting, DRC, Gerber/BOM/CPL~~
4. ~~Board ↔ enclosure: outline from a sketch, part blocks as bodies, fit checks~~
5. ~~Copper pours, real 3D part models, schematic view~~
6. ~~Proposal branches with review/accept, ada Auth Kit (users, roles, MCP OAuth)~~
7. ~~Loft/sweep, schematic editing (wires), per-project sharing, vendor 3D models in STEP (`export` detail: "models")~~
8. ~~Stored schematic wires, 3D selection and measuring, BOM price and stock check~~
