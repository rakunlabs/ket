# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Hardware makers who design a printed circuit board and the enclosure around it together: makers and small teams building devices (ESP32 boards, USB-C power supplies, sensor nodes). They work in long sessions, switching between the 3D model, the board layout and the schematic, and increasingly drive the work through an AI assistant (the built-in chat or Claude Code / Cursor over MCP) while watching the result update live.

Administrators run a shared Ket server for a team: they add people, set up the AI provider and the autorouter.

## Product Purpose

One document for parametric CAD and PCB, built to be driven by AI. A design is an op log of commands that both people and agents run; the browser rebuilds and shows it live. Success: describe a device, get a routed board that fits a printable case, verified by checks, DRC and renders, ready to order from JLCPCB.

## Positioning

The enclosure and the board are one model with shared parameters, and every capability is a command an agent can call and verify (query, check or render), never UI-only.

## Operating Context

- Self-hosted single binary with PostgreSQL; the geometry kernel (OpenCascade WASM) runs in the browser, so a project must be open in a tab for agents to work on it. Several projects open side by side as tabs, and agents open and close them (open_project, close_project).
- Used next to an AI chat and an MCP client; renders and checks are how the agent and the person confirm a change.
- Parts come from LCSC/EasyEDA; fabrication output targets JLCPCB (Gerber, drill, BOM, CPL).

## Capabilities and Constraints

- CAD: parameters and expressions, constrained sketches, extrude/revolve/loft/sweep, booleans, fillet/chamfer/shell, patterns, checks, measuring, STEP/STL export.
- PCB: board outline from sketches, LCSC parts with real footprints, symbols and 3D models, nets, copper pours, Freerouting autoroute, DRC, BOM price and stock, fabrication zip.
- Schematic drawn from the netlist with stored wires.
- Accounts always on (ada Auth Kit): first account is admin; roles admin/editor/viewer; per-project sharing; MCP over OAuth or personal tokens.
- Proposals: agent changes on a branch, reviewed and accepted or rejected.
- All configuration beyond infrastructure is done by administrators in the UI.

## Brand Commitments

- Name: Ket.
- Mark: the Lucide `pencil-ruler` icon (replaces the former orange "K" tile).
- Visual family: shares its design language with the team's kafka-console (warm paper neutrals, one yellow highlight, ink-blue links, IBM Plex, corner ticks, square status markers). Recorded in DESIGN.md.

## Product Principles

1. The model is the content: chrome stays quiet so the 3D view, the board and the schematic carry the screen.
2. Everything an agent can do is visible and verifiable: changes show who made them and how to check them.
3. Hardware is unforgiving: problems (DRC, failed features, out-of-stock parts) are stated plainly with the fix.
4. Long sessions: both light and dark themes are first-class.

## Accessibility & Inclusion

WCAG AA contrast for text and controls in both themes; state is never conveyed by color alone.
