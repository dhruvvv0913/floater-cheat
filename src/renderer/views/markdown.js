/**
 * A deliberately small Markdown subset: fenced code, inline code, bold and
 * bullet lists. Everything is built with DOM nodes rather than innerHTML, so
 * model output can never inject markup and the strict CSP stays intact.
 */

function renderInline(target, text) {
  // Split on `code` and **bold**, keeping the delimiters via a capture group.
  for (const part of text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g)) {
    if (!part) continue;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      const code = document.createElement('code');
      code.textContent = part.slice(1, -1);
      target.append(code);
    } else if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      const strong = document.createElement('strong');
      strong.textContent = part.slice(2, -2);
      target.append(strong);
    } else {
      target.append(document.createTextNode(part));
    }
  }
}

export function renderMarkdown(container, text) {
  const nodes = [];
  // Odd indices are the insides of fenced blocks.
  const segments = text.split(/```/g);

  segments.forEach((segment, index) => {
    if (index % 2 === 1) {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = segment.replace(/^[a-zA-Z0-9+#-]*\n/, ''); // drop language tag
      pre.append(code);
      nodes.push(pre);
      return;
    }

    let list = null;
    for (const line of segment.split('\n')) {
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      if (bullet) {
        if (!list) {
          list = document.createElement('ul');
          nodes.push(list);
        }
        const li = document.createElement('li');
        renderInline(li, bullet[1]);
        list.append(li);
        continue;
      }
      list = null;
      if (!line.trim()) continue;
      const p = document.createElement('p');
      renderInline(p, line);
      nodes.push(p);
    }
  });

  container.replaceChildren(...nodes);
}
