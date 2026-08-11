const box = document.getElementById('box');
const size = document.getElementById('size');
const hint = document.getElementById('hint');

let origin = null;

const rectFrom = (a, b) => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(a.x - b.x),
  height: Math.abs(a.y - b.y),
});

function draw(rect) {
  box.hidden = false;
  box.style.left = `${rect.x}px`;
  box.style.top = `${rect.y}px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;

  size.hidden = false;
  size.textContent = `${Math.round(rect.width)} x ${Math.round(rect.height)}`;
  // Sit the readout just below the box, or just above it near the screen edge.
  const below = rect.y + rect.height + 6;
  size.style.left = `${rect.x}px`;
  size.style.top = `${below + 20 > window.innerHeight ? rect.y - 24 : below}px`;
}

window.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  origin = { x: event.clientX, y: event.clientY };
  hint.hidden = true;
  draw(rectFrom(origin, origin));
});

window.addEventListener('mousemove', (event) => {
  if (!origin) return;
  draw(rectFrom(origin, { x: event.clientX, y: event.clientY }));
});

window.addEventListener('mouseup', (event) => {
  if (!origin) return;
  const rect = rectFrom(origin, { x: event.clientX, y: event.clientY });
  origin = null;
  window.region.done(rect);
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.region.cancel();
});

// The picker is useless without focus — grab it as soon as we paint.
window.focus();
