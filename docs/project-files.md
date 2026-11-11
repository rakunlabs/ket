# Portable Ket projects (`.ket`)

A `.ket` file is editable source, unlike STL (triangles) or STEP (CAD geometry).
It is UTF-8 JSON with this versioned envelope:

```json
{
  "format": "ket-project",
  "version": 1,
  "units": "mm",
  "ops": [
    {"cmd": "box", "args": {"name": "case_body", "size": [20, 10, 3]}}
  ]
}
```

## Save and reopen

1. In a project, choose **Project file → Save Ket project**.
2. Create an empty project in the other Ket instance.
3. Choose **Project file → Import Ket into empty project**, then select the file.

Agents use `export_project` and `import_project`. Import is one atomic, undoable
operation. It refuses a nonempty project unless `replace: true` is explicitly
provided. Malformed files, unknown versions and query operations are rejected.
The maximum file size is 25 MiB and maximum operation count is 20,000, including
batch steps (at most eight nested batch levels).

The export includes only applied operations up to the current undo head. It
excludes collaborators, user identities, server/project IDs and credentials.
Prepared part footprints, schematic information and routing results are kept,
so opening a file does not search the parts library or autoroute the design
again. A re-export flattens previous project imports rather than nesting files.

**External assets are not embedded:** imported STEP/STL models, vendor models,
textures and decals can refer to external URLs/IDs. The destination Ket server
needs network access and its usual permitted asset hosts on first build. Keep
an assembly STEP and printable STLs alongside the editable source as a durable
geometry backup. Version 1 requires a Ket build with the recorded commands;
future versions must migrate explicitly rather than silently ignoring changes.

## Manufacturer handoff

**Manufacture** in the workspace prepares a prototype package for JLCPCB or
PCBWay. Choose the quantity, download the checked ZIP, then open the quote link.
It includes Gerber/drill files, JLCPCB-style BOM/CPL, `manufacturing.json`, and
`ORDERING.md`. The command `manufacturing_quote` is a **local preflight report**,
not a live price quote. `export_manufacturing` downloads that package. Both
report explicitly that no order has been submitted.

The checked exporter blocks failed geometry, failed checks, DRC violations,
unrouted connections and board errors. It does not certify physical fit, RF
antenna keepouts, switch travel, solderability or manufacturer DFM. Parts without
real 3D models are listed as proxies. Review these before payment, inspect all
Gerbers and confirm assembly side/rotation; PCBWay may need BOM/CPL column mapping.

Direct API integrations are possible but not configured by this feature:

- [JLCPCB API access application](https://jlcpcb.com/help/article/jlcpcb-online-api-available-now)
- [JLCPCB API documentation](https://api.jlcpcb.com/docs/api-list)
- [PCBWay API cooperation](https://www.pcbway.com/api_cooperation.html)

Those require approved accounts and server-side credentials. A future adapter
should separate upload/quote from order/payment, and require explicit user
confirmation before sending private Gerbers or creating any order. No API keys
belong in `.ket` files or Git repositories.
