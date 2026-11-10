// Who is signed in, loaded once per page.

import { api, can, type Me } from './api'

class Account {
  me = $state<Me>()
  loaded = $state(false)

  async load() {
    if (this.loaded) return
    try {
      this.me = await api.me()
    } finally {
      this.loaded = true
    }
  }

  can(perm: string) {
    return can(this.me, perm)
  }
}

export const account = new Account()
