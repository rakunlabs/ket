# AI-first verification and repair

Ket's command registry is the interface for both MCP and the built-in assistant.
The Problems panel uses the same diagnostics; there is no separate UI-only checker.

## Recommended loop

1. `get_document` reads the design and current revision. For PCB definitions use
   `get_board`; for exact tracks/vias use `get_copper`.
2. `get_problems` combines failed history replay, CAD features/checks, PCB DRC,
   unrouted connections, explicit-pin ERC and manufacturing warnings.
3. Inspect affected objects and measurements. `focus_problem` shows a current
   issue in the UI; `render_board` / `render` provide visual evidence.
4. `preview_changes` tests a proposed batch without saving it. Compare introduced,
   resolved and remaining errors. Expensive geometry/routing and preparation can
   still run, but there is no design commit, download or order.
5. Apply reviewed steps with `batch`, preferably on a proposal branch. Steps are
   prepared against the preceding scratch document; a failed step saves nothing.
6. Re-run `get_problems` and render affected geometry. Report remaining issues and
   verification limits. Do not remove or weaken requirements to make checks pass.

```json
{"cmd":"get_problems","args":{"severity":"error","limit":60}}
{"cmd":"get_copper","args":{"vias":[1]}}
{"cmd":"preview_changes","args":{"steps":[{"cmd":"edit_copper","args":{"vias":[{"number":1,"at":[5,3]}]}}]}}
{"cmd":"batch","args":{"steps":[{"cmd":"edit_copper","args":{"vias":[{"number":1,"at":[5,3]}]}}]}}
{"cmd":"get_problems","args":{}}
```

Problem IDs depend on domain/rule/objects, not measured values. They are useful
for repair comparisons, not permanent database entities. Track/via numbers are
**1-based positions in the current revision**: re-read after deletion/rerouting.
`get_problems` supports domain/severity/object filters and pagination; its counts
describe the whole design even when the returned list is filtered.

The Problems panel's **Ask AI to repair** drafts a scoped prompt and selects
proposal mode. It preserves any unsent draft and does not send/spend automatically.

## Electrical rules

`set_pin_rules` records datasheet-derived intent on a physical pad number or pin
name. Types are input, output, bidirectional, passive, power_in, power_out,
open_drain and no_connect. `required: true` demands another pad on its net.
`type: null` removes an annotation on an existing pad.

`run_erc` reports output/power-source conflicts, connected no-connect pads,
required but disconnected pads, stale/multiply assigned pads, and undeclared
drivers. Supply/driver warnings are conservative: ERC does not infer behavior
through resistors, connectors or analog networks. Unknown pin types are reported
as incomplete coverage, **never assumed passive or safe**. No voltage, current,
signal-integrity or functional simulation is performed.

Checked manufacturing exports block ERC **errors**, but retain unknown-coverage
and driver **warnings** for human review. A warning is not proof of correctness.

## Recovery and interruption

History replay stops at the first failed/missing operation. The viewport shows
only the last working prefix, with an explicit recovery banner. Editing and
CAD/PCB/project exports are blocked; even force-export cannot bypass this.
Nothing is deleted from storage. `get_history` exposes the recorded operations
and recovery sequence. Load a compatible Ket version or undo to the reported
last-good operation before continuing. A new edit after undo follows the existing
undo model and replaces the redo tail, so inspect/back up history first.

`cancel_operation` interrupts the local executor and queued work, then rebuilds
the saved design. Already-saved operations are not undone. A pending preparation
that completes later cannot commit after cancellation. This does **not** stop a
server-side AI conversation or a remote provider request; stop the conversation
separately. Kernel failures/timeouts reject requests and allow a fresh worker.
Keyboard focus now uses normal Tab navigation; **Shift+V** cycles 3D/PCB/SCH.

## Fabrication corrections

DRC now checks full track/via radius against edges and cutouts (not only track
endpoints), checks pour edge/foreign-copper clearance, and checks actual slot
centerlines for drill spacing. Pad slots preserve orientation and plating through
world geometry, routing obstacles, 2D/3D, CAD and fabrication.

Drilling is exported as separate `board-PTH.drl` and `board-NPTH.drl` files, with
G85 slot endpoints. The former mixed `board.drl` is no longer emitted; upload both
new drill files. Gerber and drill inspection in an independent manufacturer
viewer remains mandatory. Physical fit and manufacturer DFM are not certified.

## Remaining roadmap

This reliability slice does not yet implement named revisions/server snapshots,
headless execution, routing progress percentages, token/cost budgeting, reusable
audited circuit/enclosure templates, KiCad import/export or high-speed/RF checks.
Keep those as separate verified capabilities rather than UI-only shortcuts.

## Regression checks

`pnpm test` includes production geometry, slot export, atomic preparation/replay,
AI preview/repair, ERC and worker-interruption regressions. The GitHub Verify
workflow also builds the UI, checks registry/catalog drift and runs Go race tests
against a dedicated PostgreSQL service so store tests are not silently skipped.
