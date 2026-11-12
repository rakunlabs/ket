# PCB colors and silkscreen artwork

In the workspace's **PCB** view, open **Appearance**.

- Choose a solder-mask color: green, black, white, blue, red, purple or yellow.
- Choose white or black silkscreen ink. Use contrasting mask/ink colors.
- Add text, or choose **+ Logo** to import a PNG, JPEG, WebP or SVG (up to
  5 MiB). Image conversion happens locally; an SVG is drawn by the browser
  as an image (no scripts, nothing external loads) and needs width/height or
  a viewBox. Dark pixels become ink and transparent areas remain empty. Use
  Threshold and Invert to inspect a monochrome preview before adding it.
- Set the printed width, center X/Y, rotation and face. Dimensions accept
  parameter expressions. The original aspect ratio is preserved. Bottom
  artwork is mirrored automatically so it reads correctly from underneath.
- Select an existing item to edit it, or use **Place on board…** and click
  its new center. Escape cancels placement. Coordinates also allow precise
  positioning without using the pointer. Remove an item with its trash button;
  the workspace's Undo restores changes.

The same prepared ink polygons are used in 2D, 3D and the top/bottom Gerber
legend layers (`.gto` / `.gbo`). Font outlines and converted image polygons
travel with the operation log and editable `.ket` file: replay and export do
not depend on a remote image or font service. This is **single-color silkscreen**,
not photographic or full-color UV printing. CAD decals remain display-only;
they are not substituted for manufacturing artwork.

## Checks and ordering

**Check print clearance** checks custom artwork against exposed pads, board
edges/cutouts and drilled holes. `run_drc` and the checked manufacturing export
include these checks too. Custom silk keeps 0.2 mm from copper pads (including
the nominal mask opening expansion), edges and holes. Existing footprint silk
is not newly certified by these checks.

Very small letters, narrow ink strokes/gaps, image detail and artwork hidden
under component bodies still need visual and manufacturer DFM review. The
preview is not a guarantee of exact factory color, print resolution or finish.

Gerber describes **where ink is printed**, not the ink or mask color to order.
`export_manufacturing` records the requested mask and ink in `manufacturing.json`
and `ORDERING.md`. Select the same options explicitly on the manufacturer's
order form and check availability; supported colors and shades vary.

## Commands for agents

```json
{"cmd":"set_board_style","args":{"mask":"purple","silk":"white"}}
{"cmd":"add_board_artwork","args":{"name":"revision","text":"Ket REV 01","at":[0,8],"width":14,"side":"top"}}
{"cmd":"add_board_artwork","args":{"name":"logo","bitmap":["###","#.#","###"],"at":[0,-6],"width":4,"side":"bottom"}}
{"cmd":"update_board_artwork","args":{"name":"logo","at":[5,-6],"rotation":90}}
{"cmd":"remove_board_artwork","args":{"names":["logo"]}}
```

Use `get_board` to list artwork and colors, `render_board` / `render` to inspect
the board, and `run_drc` to verify clearances. To replace text or logo content,
call `add_board_artwork` with the same name and `replace: true`. Bitmaps are
rectangular rows of `#` (ink) and `.` (empty), at most 256 × 256. Boards support
up to 100 named artwork items, with at most 20,000 polygon vertices per item.
