// Access to one open project. Each tab has its own, given to its
// components through context.

import { getContext, setContext } from 'svelte'

import { account } from './account.svelte'
import type { Access } from './api'

const KEY = Symbol('project-access')

export class ProjectAccess {
  access = $state<Access>()

  /** May change the project: account role and project access. */
  get canEdit() {
    return account.can('projects:write') && this.access !== 'viewer'
  }

  get isOwner() {
    return this.access === 'owner'
  }
}

export function provideAccess(a: ProjectAccess) {
  setContext(KEY, a)
}

export function projectAccess(): ProjectAccess {
  return getContext<ProjectAccess>(KEY) ?? new ProjectAccess()
}
