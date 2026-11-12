<script lang="ts">
  import { CircleAlert, Check, X } from '@lucide/svelte'
  import { onMount } from 'svelte'

  import { toasts } from '../lib/toasts'

  onMount(() => {
    const visibility = () => toasts.setHidden(document.hidden)
    visibility()
    document.addEventListener('visibilitychange', visibility)
    return () => {
      document.removeEventListener('visibilitychange', visibility)
      toasts.clear()
      toasts.setHidden(false)
    }
  })
</script>

<section class="toasts" aria-label="Notifications" data-toast-region>
  {#each $toasts as toast (toast.id)}
    <div
      class="toast pop"
      role={toast.tone === 'error' ? 'alert' : 'status'}
      aria-atomic="true"
      onpointerenter={() => toasts.pause(toast.id, 'pointer')}
      onpointerleave={() => toasts.resume(toast.id, 'pointer')}
      onfocusin={() => toasts.pause(toast.id, 'focus')}
      onfocusout={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) toasts.resume(toast.id, 'focus')
      }}
    >
      <span class={['toast-icon', toast.tone === 'error' ? 'text-danger' : 'text-ok']} aria-hidden="true">
        {#if toast.tone === 'error'}<CircleAlert size={17} />{:else}<Check size={17} />{/if}
      </span>
      <p class="min-w-0 flex-1 whitespace-pre-wrap break-words"><span class="sr-only">{toast.tone === 'error' ? 'Error: ' : 'Success: '}</span>{toast.message}</p>
      <button class="btn btn-ghost toast-close" aria-label="Dismiss notification" onclick={() => toasts.dismiss(toast.id)}><X size={15} /></button>
    </div>
  {/each}
</section>

<style>
  .toasts {
    position: fixed;
    right: max(16px, env(safe-area-inset-right));
    bottom: max(16px, env(safe-area-inset-bottom));
    z-index: 100;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: min(384px, calc(100vw - 32px));
    max-height: calc(100dvh - 32px);
    overflow-y: auto;
    overscroll-behavior: contain;
    pointer-events: none;
  }

  .toast {
    display: flex;
    flex-shrink: 0;
    align-items: flex-start;
    gap: 10px;
    padding: 12px;
    font-size: 13px;
    line-height: 1.5;
    pointer-events: auto;
    animation: toast-in 180ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  .toast-icon {
    flex: none;
    margin-top: 2px;
  }

  .toast-close {
    flex: none;
    justify-content: center;
    width: 28px;
    height: 28px;
    margin: -4px -4px -4px 0;
    padding: 0;
    color: var(--text-2);
  }

  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translateX(16px);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .toast {
      animation: none;
    }
  }
</style>
