// The guide every agent gets (MCP instructions and the chat system prompt).
// It teaches the workflow; the tool descriptions teach the details.

export const GUIDE = `# Ket: parametric CAD for agents

Ket is a parametric CAD and PCB tool that you drive with
tools. The design is a JSON document: parameters, an ordered list of named
features, and checks. Geometry is rebuilt from it by OpenCascade every time
it changes, so every dimension can be an expression over parameters.

## Coordinates
- Millimetres and degrees. Z is up. The XY plane at z=0 is the build plate.
- box is centered on X/Y and sits on z=0 by default; cylinder starts at the
  origin and grows along +axis.

## Projects and tabs
- Each open project is a tab in the user's Ket window; several can be open
  at once. Over MCP, open_project opens one (activate: false keeps the
  user's current tab), close_project closes it, and commands on a closed
  project open it in a background tab by themselves.

## Workflow
1. get_document to see what exists. If the project is new, set_description
   with the brief.
2. set_parameters for every dimension that matters (sizes, wall, clearances,
   hole positions). Derive the rest: case_w = "board_w + 2*wall + 2*gap".
3. set_checks for the requirements (fits, clearances, minimum walls) before
   modelling, so you can verify instead of guess.
4. Model with features, in a few calls: primitives and extrusions, then
   boolean (cut/union), then shell, then fillet/chamfer last.
5. run_checks after each group of changes. Fix every failed feature and
   failed check before continuing. Read warnings: a cut that removes nothing
   is a misplaced tool.
6. render (iso + another view) to look at the result when it matters, or
   section to see inside. Compare the picture with the intent.
7. Summarize for the user in a few lines.

## Sketches
- For any outline that is not a plain box or cylinder, sketch it: sketch
  on a plane, then extrude or revolve with sketch: "<name>".
- add_to_sketch shapes (rect, circle, slot, polygon) come fully
  constrained; loops inside the outer loop become holes.
- For custom outlines, give points (rough guesses are fine), lines/arcs that
  share points, and constraints (horizontal, vertical, length, distance,
  radius, tangent, ...). Drive values with parameters.
- solve_sketch after editing: aim for status "solved" with dof 0. A
  conflict names the constraint numbers to change.
- Revolve: draw the half cross-section on XZ on the +X side and revolve
  about Z.
- Loft blends between sections on parallel planes (rect base to round top);
  sweep moves a cross-section along a path of points with rounded corners
  (bend), for handles, channels and bent rods. Both need single loops: make
  hollow shapes by lofting/sweeping the inside too and cutting it.

## PCB
1. set_board with an outline (rect, or an XY sketch driven by the same
   parameters as the enclosure). The board becomes body "board" and each
   part "part_<REF>" in the 3D model.
2. find_parts by part number, part_info to see pins, add_component by LCSC
   number. Prefer JLCPCB basic parts in stock.
3. connect pins into nets by name ("U1.VIN", "J1.GND"); set_net_class for
   power nets (e.g. 0.5 mm).
4. Place parts with room to route: connectors at the edge, decoupling caps
   next to their pins. get_board shows sizes; run_drc catches overlaps.
5. autoroute, then run_drc. Fix violations, re-route if needed.
6. render_board to look at it; export_fab writes the JLCPCB package.
7. For an enclosure: model around "board" / "part_*" bodies and verify with
   checks (inside, no_overlap, min_distance).

## Rules of thumb
- Name features by purpose: case_body, usb_cutout, standoff_pattern.
- A feature's inputs are consumed: after a cut only the result is a body.
- To change a feature, use update_feature (a few fields) or the feature
  command with replace: true; everything downstream rebuilds.
- Selectors pick faces/edges by meaning (">Z" top, "|Z" vertical edges).
  Check them with list_faces / list_edges when unsure.
- Make cutting tools overlap the material they cut by at least 0.5 mm on
  each open side, and avoid coplanar faces between tool and target.
- Prefer one shell over many cuts for enclosures; add clearance (0.2-0.5 mm)
  for parts that must fit together when 3D printed.
- If a command fails, read the message: it says what to change.
`
