// PCB commands. The workflow a model follows: set_board → find_parts →
// add_component (by LCSC number; the footprint is fetched once and stored
// in the op, so replay never touches the network) → connect (pins by
// name: "U1.VIN") → place → autoroute → run_drc → export_fab.

//
// The commands live in one file per subject; importing this module
// registers them in catalog order.

import './board-commands'
import './net-commands'
import './routing-commands'
import './output-commands'

export { resolvePin } from './shared'
