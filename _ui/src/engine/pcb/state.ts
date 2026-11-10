import type { ResolvedBoard } from './board'
import type { Ratsnest, Violation } from './drc'
import type { ZoneFill } from './zones'

/** What the browser and commands get about the board. */
export interface BoardState {
  board: ResolvedBoard
  ratsnest: Ratsnest
  zones: ZoneFill[]
  drc?: Violation[]
}
