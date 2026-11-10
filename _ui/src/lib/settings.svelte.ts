// Loads and saves the admin settings; the tabs share one copy.

import { api, type AdminSettings, type ProviderIn } from './api'

export type Role = { name: string; description?: string; permissions: string[] }

class SettingsStore {
  current = $state<AdminSettings>()
  roles = $state<Role[]>([])
  error = $state('')
  loading = $state(false)

  async load() {
    this.loading = true
    try {
      const r = await api.settings()
      this.current = r.settings
      this.roles = r.roles
      this.error = ''
    } catch (e) {
      this.error = (e as Error).message
    } finally {
      this.loading = false
    }
  }

  /**
   * Saves a change. Providers carry api_key only when it was typed; the
   * server keeps stored keys otherwise. clearKeys removes stored keys.
   */
  async save(next: Omit<AdminSettings, 'providers'> & { providers: (ProviderIn & { has_key?: boolean })[] }, clearKeys: string[] = []) {
    const r = await api.saveSettings({
      ...next,
      providers: next.providers.map((p) => ({
        name: p.name.trim(),
        base_url: p.base_url.trim(),
        model: p.model.trim(),
        vision: p.vision,
        ...(p.temperature ? { temperature: p.temperature } : {}),
        ...(p.api_key ? { api_key: p.api_key } : {}),
        ...(p.previous_name && p.previous_name !== p.name ? { previous_name: p.previous_name } : {}),
      })),
      clear_keys: clearKeys,
    })
    this.current = r.settings
  }
}

export const settings = new SettingsStore()
