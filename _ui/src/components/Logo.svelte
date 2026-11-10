<script lang="ts">
  // Ket's mark: Lucide's pencil-ruler, the ruler in ink and the pencil on
  // the yellow highlight, like a selected row in the rest of the UI.
  let { size = 22, title }: { size?: number; title?: string } = $props()
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke-linecap="round"
  stroke-linejoin="round"
  role={title ? 'img' : undefined}
  aria-label={title}
  aria-hidden={title ? undefined : 'true'}
>
  <g class="ruler">
    <path d="M13 7 8.7 2.7a2.41 2.41 0 0 0-3.4 0L2.7 5.3a2.41 2.41 0 0 0 0 3.4L7 13" />
    <path d="m8 6 2-2" />
    <path d="m18 16 2-2" />
    <path d="m17 11 4.3 4.3c.94.94.94 2.46 0 3.4l-2.6 2.6c-.94.94-2.46.94-3.4 0L11 17" />
  </g>
  <g class="pencil">
    <path class="hl" d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    <path d="m15 5 4 4" />
  </g>
</svg>

<style>
  svg {
    flex: none;
    display: block;
    --mark-ink: var(--text);
    --mark-stroke: 1.8;
  }
  .hl {
    fill: var(--cta);
  }
  .ruler {
    stroke: var(--mark-ink);
    stroke-width: var(--mark-stroke);
  }
  .pencil {
    /* Ink on yellow stays dark, just like the login mark. */
    stroke: var(--cta-text);
    stroke-width: var(--mark-stroke);
  }
  :global([data-theme='dark']) svg {
    --mark-ink: var(--text-2);
    --mark-stroke: 1.6;
  }
  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme='light'])) svg {
      --mark-ink: var(--text-2);
      --mark-stroke: 1.6;
    }
  }
</style>
