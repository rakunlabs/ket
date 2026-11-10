// Tiny, safe markdown for chat: escapes HTML first, then applies code
// blocks, inline code, bold, italics, lists and paragraphs.

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inline(s: string) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1<em>$2</em>')
}

export function markdown(src: string): string {
  const parts = esc(src).split(/```[a-z]*\n?/)
  let out = ''
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      out += `<pre>${part.replace(/\n$/, '')}</pre>`
      return
    }
    const blocks = part.split(/\n{2,}/)
    for (const b of blocks) {
      const lines = b.split('\n').filter((l) => l.trim() !== '')
      if (!lines.length) continue
      if (lines.every((l) => /^\s*[-*] /.test(l))) {
        out += '<ul>' + lines.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('') + '</ul>'
      } else if (lines.every((l) => /^\s*\d+[.)] /.test(l))) {
        out += '<ol>' + lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)] /, ''))}</li>`).join('') + '</ol>'
      } else if (/^#{1,4} /.test(lines[0]) && lines.length === 1) {
        out += `<p><strong>${inline(lines[0].replace(/^#+ /, ''))}</strong></p>`
      } else {
        out += `<p>${lines.map(inline).join('<br>')}</p>`
      }
    }
  })
  return out
}
