# Roadmap and implementation plan

Status: items 1–24 are done (November 2026). Still to check by hand: a
zip64 3MF from a real slicer, the release workflow on a tag, and STEP
assemblies opened in other CAD tools.

What comes after roadmap items 1–8 in the README. Each item names the
commands to add, the files it touches and how it is verified. Sizes are
rough: S is days, M is one to two weeks, L is longer.

A server-side (headless) kernel is deliberately not part of this plan: the
geometry kernel stays in the browser.

## Rules for every item

These repeat `AGENTS.md`; an item is not done until all of them hold.

- The capability is a command in `_ui/src/engine` plus a way to verify it
  (query, check or render). Nothing is UI-only.
- `apply` is a pure function of the document. Network and file reads happen
  in `prepare`, and what they fetched goes into the op's arguments.
- Error messages say what is wrong and what to change.
- Old op logs must still replay: new document fields are optional and
  default to today's behavior.
- Add a vitest test in `_ui/tests`, update `_ui/src/engine/guide.ts` when
  agents need to know about it, then run `make gen`.
- Verify with `go vet ./...`, `go test ./...`,
  `cd _ui && pnpm check && pnpm test`.

## Decisions already taken

- **Assembly:** instances only. A mate/joint constraint solver is out of
  scope here and needs its own decision.
- **Differential pairs:** declaration, length report and DRC first; paired
  routing and length tuning are a second stage.
- **KiCad:** export before import. Export is simpler and gives an
  independent DRC through `kicad-cli`.
- **Interactive routing:** walk-around only. Push/shove is out of scope.

## Order

Phase 0, then phase 1. After that two tracks can run in parallel:

- CAD: 9 → 10 → 11 → 12
- PCB: 13 → 14 → 17 (export) → 15 → 16 → 18 → 17 (import) → 19 → 20

Phase 4 items are independent and fit in between; 21 and 22 do not depend
on anything else.

## Phase 0: groundwork

Do this first: almost every later item edits these files.

### 1. Split `kernel.ts` and `pcb/commands.ts` (M)

`_ui/src/engine/kernel.ts` is about 2800 lines and
`_ui/src/engine/pcb/commands.ts` about 1300.

- Move the kernel into `_ui/src/engine/kernel/`: selectors, profiles and
  drawings, one module per group of feature types, checks, export, board
  bodies. Keep `kernel.ts` as the entry that re-exports the same names.
- Split PCB commands by subject: board and parts, nets, copper (tracks,
  vias, zones, autoroute), outputs (fab, BOM, schematic).
- No behavior change. Done when the existing tests pass untouched and
  `catalog.json` is byte-identical after `make gen`.

### 2. End-to-end tests (M)

There is no browser test today; the hub, websocket, tab and kernel chain
is covered only by unit tests.

- Playwright in `_ui/e2e`, run in CI against the real binary and the
  PostgreSQL service the workflow already starts.
- Scenarios: first-account sign-up; create and open a project; a command
  over MCP makes a body appear; undo and redo; two tabs stay in sync;
  a proposal is accepted; `export_fab` returns a zip with the expected
  files.
- Add a job to `.github/workflows/ci.yml`. Keep it separate from the
  `verify` job so unit failures stay fast.

### 3. Distribution (S)

- Multi-stage `Dockerfile` (pnpm build, then `CGO_ENABLED=0` Go build, then
  a minimal runtime image).
- A compose file with Ket and PostgreSQL for a one-command start, next to
  the development one in `env/compose.yaml`.
- A release workflow on `v*` tags: binaries for linux and darwin
  (amd64, arm64) and an image on ghcr. The Makefile already sets the
  version ldflags.
- README quick start gains the Docker route.

## Phase 1: quick wins

### 4. SVG logos on silkscreen (S)

`_ui/src/lib/board-logo.ts` accepts PNG, JPEG and WebP only. Rasterize the
SVG on a canvas and feed the existing bitmap path. Update
`docs/board-artwork.md`. Verify with `render_board` and the artwork tests.

### 5. zip64 3MF (S)

`_ui/src/engine/model-files.ts` refuses zip64 archives. Read the zip64
end-of-central-directory record and extra fields. Check whether
`internal/parts/threemf.go` has the same limit and fix it there too. Keep
the zip-bomb limits that were added recently. Test with a fixture.

### 6. Idlers inside a belt loop (S)

`_ui/src/engine/mechanisms.ts` rejects a pulley inside the loop. Add
`side: 'inside'` to a belt pulley and choose the tangent accordingly; an
inside idler turns the other way. Verify with `get_mechanisms` and
`sweep_motion`.

### 7. Parameter configurations (M)

Named parameter sets for variants of one design.

- Document: `configurations: { name, values }[]` and an optional active
  name.
- Commands: `set_configuration`, `use_configuration`,
  `delete_configurations`.
- `run_checks` takes `configurations: 'all'` and reports per
  configuration; `export` and `export_fab` take a configuration name.
- UI: a selector in the sidebar next to the parameters.

### 8. Printability checks (M)

Two check kinds in `_ui/src/engine/schema.ts`, evaluated on the
tessellated body so they work for B-rep and mesh bodies:

- `overhang`: faces steeper than `angle` from the print direction, with
  their area and boxes.
- `min_wall`: thinnest wall found by sampling rays inward from faces.
  This is approximate; the result must say so and give the sample spacing.

Move the matching rules of thumb in the guide to "set these checks".

## Phase 2: CAD

### 9. Sketch on a face or an offset plane (M)

The sketch plane is `XY`, `XZ` or `YZ` only. The kernel's `onPlane`
already takes an offset.

- `sketch` gains `offset` and `on: { feature, face: <selector> }`.
- Reference the face by selector (`>Z`), never by index, so a rebuild
  does not move the sketch to another face. Fail with a clear message when
  the selector matches zero or several faces, or a face that is not flat.
- Verify with `solve_sketch` and `get_feature` (reports the resolved
  plane origin and normal).

### 10. Mechanical features (L, one command at a time)

Each is a feature that produces or modifies a body, so `measure`, checks
and `section` verify it.

- `hole`: plain, countersunk and counterbored, sized from a built-in
  table (M2–M6, clearance and tap drill), placed on a face at points.
- `insert_boss`: boss and hole for heat-set inserts, from a table of
  common insert sizes.
- `thread`: cosmetic first (a note on the hole plus the right diameter),
  then modelled helical threads for printed parts.
- `draft`: taper faces from a neutral plane. Check first whether replicad
  exposes OpenCascade's draft operation; if not it needs raw `oc` access.
  Do a small spike before committing to the design.
- `snap_fit`: a cantilever hook and its matching window, with a clearance
  parameter.

### 11. 2D drawings and DXF (M–L)

- `drawing` query: front, top, side and iso views by hidden-line
  projection, plus section views reusing `_ui/src/engine/section-draw.ts`.
  Output SVG and PDF.
- First version dimensions: overall sizes and the dimensions driven by
  named parameters. No manual dimension placement yet.
- `export_dxf`: one sketch or one flat face profile, for laser cutting.

### 12. Assembly instances (L)

`transform` consumes its source and `pattern` merges its copies into one
body, so one part cannot be placed twice.

- An `instance` feature: `of`, translate, rotate. The source stays a body.
- Checks, `measure_between`, `set_explode`, motion and STEP export work on
  instances; STEP export writes an assembly with shared geometry when the
  writer allows it.
- Mates and joints solved from constraints are not part of this item.

## Phase 3: PCB

### 13. Keepouts (M)

- `add_keepout` and `remove_keepouts`: a region, the layers, and what it
  forbids (tracks, vias, pours, parts).
- The autorouter treats it as an obstacle, zone fill subtracts it,
  `auto_place` avoids it, DRC reports violations.
- Drawn hatched in `render_board`. A preset for antenna areas is useful.

### 14. Teardrops (S–M)

A board option (`set_board teardrops`). The shapes are derived when the
board is resolved, so they follow track edits and are never stored.
Written to Gerber as regions; DRC clearance must include them.

### 15. Stackup and via spans (L)

Layers are `2 | 4` and every via connects all layers
(`_ui/src/engine/pcb/drc.ts`).

- `set_stackup`: copper and dielectric thicknesses, εr, with JLCPCB
  presets. Add 6 layers.
- `Via.span: [from, to]` for blind and buried vias. Connectivity, DRC and
  the router respect the span.
- `_ui/src/engine/pcb/fab.ts` writes one drill file per span; the
  manufacturing report lists the stackup and flags spans that the chosen
  manufacturer charges extra for or cannot make.
- `impedance` query: track width for a target impedance (microstrip,
  stripline, differential) from the stackup. State in the result that it
  is an estimate and the manufacturer's calculator decides.

### 16. Differential pairs and length matching (L, two stages)

Stage 1:

- `set_diff_pair` (two nets, gap, width) and a length target or group on
  net classes.
- `get_net_lengths` query: routed length per net, including vias.
- DRC rules: gap along the coupled part, skew within a pair, length
  outside the target.

Stage 2:

- Coupled routing in `_ui/src/engine/pcb/router.ts`: both tracks routed
  together at the gap.
- `tune_length`: adds a serpentine to a track to reach a target.

### 17. KiCad bridge (L)

Export first:

- `export_kicad` writes a `.kicad_pcb` (outline, cut-outs, footprints,
  pads, nets, tracks, vias, zones, silkscreen artwork) with our own
  writer. The notes in `research_notes` list the gaps of the existing
  `kicad-converter` package that rule it out as a base.
- An optional CI job runs `kicad-cli pcb drc` on exported fixtures as an
  independent check. KiCad stays a separate program; no GPL code is
  linked or translated.

Import second:

- `import_kicad`: the file is read in `prepare`; footprints and copper go
  into the op's arguments so replay needs no file.
- Anything unsupported is listed in a loss report in the result. Never
  drop data silently.
- Schematic import is not part of this item.

### 18. Interactive routing (L)

`_ui/src/components/BoardView.svelte` pans and zooms but cannot draw
copper.

- Click a pad, then click to add corners; the existing A* routes each
  leg around obstacles at the net class width, 45° only. Pressing V
  places a via and switches layer. The result commits as `add_track` and
  `add_via`, one batch per finished connection, Esc commits nothing.
- Dragging a segment goes through `edit_copper`.
- Live clearance feedback from the same DRC code.

### 19. Multi-sheet schematic (M)

- Optional `sheet` on components, `set_sheet`, and
  `render_schematic sheet:`.
- Nets that cross sheets show as labels.
- Reusable hierarchical blocks depend on item 23.

### 20. Panelization (M, low priority)

`export_fab panel: { nx, ny, method: 'vcut' | 'mousebite', rails }`.
JLCPCB can panelize for the customer, so this is last.

## Phase 4: agent and product

### 21. Chat compaction and usage tracking (M)

`prune` in `internal/agent/agent.go` only drops old images, and the loop
stops at `MaxSteps`.

- When the history passes a threshold, summarize the older turns with the
  same provider and store the summary in the conversation.
- Record `usage` from provider responses per user, project and day in a
  new migration. Show it in Settings; optional monthly limit per user.

### 22. MCP tool grouping (S–M)

All commands are separate tools. `catalog.Command` already has `Group`.

- An opt-in mode (`/mcp?tools=core`): a core set plus `find_commands`
  (search by text or group) and `run_command`.
- The default stays as it is today, so existing clients do not change.

### 23. Templates and reusable blocks (L)

- A template is an exported op list; "new project from template" replays
  it. Templates are shared per server, managed by admins.
- `insert_block`: fetches the block's ops in `prepare`, embeds them in
  the arguments and prefixes names (features, refs, nets) to avoid
  clashes. `_ui/src/engine/project-file.ts` refuses nested
  `import_project` today, so this needs the namespacing designed first.

### 24. README (S, after every phase)

The feature list and roadmap in `README.md` stop at item 8 and do not
mention gears, motion, materials, mesh editing or ERC. Update them at the
end of each phase and link to this file.
