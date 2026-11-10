<script lang="ts">
  import { Monitor, Moon, Sun } from '@lucide/svelte'

  import { theme } from '../lib/theme.svelte'

  const labels = { auto: 'System', light: 'Light', dark: 'Dark' } as const
</script>

<button class="btn btn-ghost px-2" onclick={() => theme.next()} title="Theme: {labels[theme.choice]} (click to change)" aria-label="Theme: {labels[theme.choice]}">
  {#if theme.choice === 'dark'}<Moon size={14} />{:else if theme.choice === 'light'}<Sun size={14} />{:else}<Monitor size={14} />{/if}
</button>
