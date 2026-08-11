import { renderMarkdown } from './markdown.js';

/**
 * The default view: one answer, nothing else.
 *
 * The answer persists until the next request replaces it — hovering away and
 * back shows the same text, which is the whole point of the hover model. State
 * lives at module scope rather than inside mount() so a trip through Settings
 * and back doesn't wipe it.
 */

let entry = null; // last structured answer
let streamText = ''; // live text for typed (chat) questions
let streaming = false;
let failure = '';

const CONFIDENCE_TITLE = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence — the model flagged this as uncertain',
};

export default {
  id: 'answer',

  mount(el, ctx) {
    const api = ctx.api.ai;

    const question = document.createElement('div');
    question.className = 'question';

    const answer = document.createElement('div');
    answer.className = 'answer';

    const meta = document.createElement('div');
    meta.className = 'meta';

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.hidden = true;

    const input = document.createElement('textarea');
    input.className = 'input';
    input.rows = 2;
    input.placeholder = 'Ask something…  (Enter to send, Esc to close)';
    input.hidden = true;

    el.append(question, answer, meta, input, toast);

    let frame = 0;
    let toastTimer = 0;

    /* ------------------------------------------------------------ render */

    function paint() {
      frame = 0;

      if (failure) {
        question.hidden = true;
        meta.hidden = true;
        const p = document.createElement('p');
        p.className = 'failed';
        p.textContent = failure;
        answer.replaceChildren(p);
        return reportHeight();
      }

      if (streaming && streamText) {
        question.hidden = true;
        meta.hidden = true;
        renderMarkdown(answer, streamText);
        return reportHeight();
      }

      if (!entry) {
        question.hidden = true;
        meta.hidden = true;
        const p = document.createElement('p');
        p.className = 'placeholder';
        p.append(ctx.kbd(ctx.info.hotkeys.answer), ' answer what is on screen');
        answer.replaceChildren(p);
        return reportHeight();
      }

      // The extracted question is the cheapest guard against the worst failure
      // this app has: a confident answer to the question you didn't mean.
      if (entry.question) {
        question.hidden = false;
        question.textContent = entry.question;
      } else {
        question.hidden = true;
      }

      renderMarkdown(answer, entry.answer || '');

      const bits = [];
      if (entry.confidence) {
        const dot = document.createElement('span');
        dot.className = `dot ${entry.confidence}`;
        dot.title = CONFIDENCE_TITLE[entry.confidence] || entry.confidence;
        bits.push(dot);
      }
      if (entry.total > 1) bits.push(text(`${entry.index + 1}/${entry.total}`));
      if (entry.ms) bits.push(text(`${(entry.ms / 1000).toFixed(1)}s`));
      if (entry.costUsd) bits.push(text(`$${entry.costUsd.toFixed(3)}`));

      meta.hidden = bits.length === 0;
      meta.replaceChildren(...bits);
      reportHeight();
    }

    function text(value) {
      const span = document.createElement('span');
      span.textContent = value;
      return span;
    }

    // Shrink-to-fit: a four-word answer shouldn't sit in a half-empty panel.
    function reportHeight() {
      requestAnimationFrame(() => {
        const padding = 24;
        ctx.api.reportHeight(el.scrollHeight + padding);
      });
    }

    const schedulePaint = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };

    function showToast(message) {
      toast.textContent = message;
      toast.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toast.hidden = true;
      }, 1600);
    }

    /* ------------------------------------------------------------ events */

    const off = [
      api.onStart((payload) => {
        streaming = !!payload?.streaming;
        streamText = '';
        failure = '';
        if (streaming) entry = null;
        ctx.setBusy(true);
        paint();
      }),

      api.onDelta((delta) => {
        streamText += delta;
        schedulePaint();
      }),

      api.onDone((result) => {
        ctx.setBusy(false);
        if (result && !result.ok && !result.aborted) failure = result.error;
        if (streaming && result?.ok) {
          // The streamed text is already in the history entry main pushed;
          // answer:show will replace this with the canonical version.
          streamText = '';
        }
        streaming = false;
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        paint();
      }),

      ctx.api.onAnswer((payload) => {
        entry = payload;
        failure = '';
        streamText = '';
        streaming = false;
        paint();
      }),

      ctx.api.onToast((message) => showToast(message)),

      ctx.api.onAskOpen(() => {
        input.hidden = false;
        input.focus();
        input.select();
        reportHeight();
      }),
    ];

    function closeInput() {
      input.hidden = true;
      input.value = '';
      ctx.api.setInputOpen(false);
      reportHeight();
    }

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (streaming) api.cancel();
        closeInput();
        return;
      }
      if (event.key !== 'Enter' || event.shiftKey) return;
      event.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      // The screenshot always rides along — a follow-up is nearly always about
      // the same screen, and one checkbox is one more thing to think about.
      api.ask(value);
      closeInput();
    });

    // Restore whatever was on screen before a trip through Settings.
    ctx.api.currentAnswer().then((current) => {
      if (current) {
        entry = current;
        paint();
      }
    });

    paint();

    return {
      unmount() {
        for (const fn of off) fn();
        if (frame) cancelAnimationFrame(frame);
        clearTimeout(toastTimer);
      },
    };
  },
};
