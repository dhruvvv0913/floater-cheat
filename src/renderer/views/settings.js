/**
 * Everything that used to clutter the panel, moved behind the tray menu.
 * Reached from the tray only, so the answer view stays a single block of text.
 */

// WDA_EXCLUDEFROMCAPTURE needs Windows 10 build 19041 (2004). Below that the
// flag silently degrades to WDA_MONITOR, which paints a black box instead of
// hiding the window — visibly worse than not trying.
const MIN_BUILD = 19041;

const SELFTEST_LABELS = {
  pass: 'PASS',
  fail: 'FAIL',
  inconclusive: 'INCONCLUSIVE',
  error: 'ERROR',
};

// Display names for provider ids. A provider with no adapter yet simply never
// appears in `settings.providers`, so this map can list more than actually
// ships without misleading anyone — it just never gets read for those ids.
const PROVIDER_LABELS = {
  anthropic: 'Claude (Anthropic)',
  openai: 'OpenAI',
  gemini: 'Gemini',
  ollama: 'Ollama (local, free)',
};

function section(title) {
  const el = document.createElement('div');
  el.className = 'section';
  const heading = document.createElement('div');
  heading.className = 'section-title';
  heading.textContent = title;
  el.append(heading);
  return el;
}

function row(label, value, tone) {
  const dl = document.createElement('dl');
  dl.className = 'row';
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  if (tone) dd.className = tone;
  dl.append(dt, dd);
  return dl;
}

function note(text, tone) {
  const p = document.createElement('p');
  p.className = tone ? `note ${tone}` : 'note';
  p.textContent = text;
  return p;
}

function windowsBuild(osRelease) {
  const match = /^\d+\.\d+\.(\d+)/.exec(osRelease || '');
  return match ? Number(match[1]) : null;
}

export default {
  id: 'settings',

  mount(el, ctx) {
    const api = ctx.api;

    /* --- header (also the drag handle in this view) --- */
    const head = document.createElement('div');
    head.className = 'settings-head';
    const title = document.createElement('h1');
    title.textContent = 'Settings';
    const done = document.createElement('button');
    done.className = 'primary';
    done.textContent = 'Done';
    done.addEventListener('click', () => api.setMode('answer'));
    head.append(title, done);
    el.append(head);

    /* --- provider + API key + model --- */
    const keySection = section('AI provider');
    el.append(keySection);

    async function renderKey() {
      const settings = await api.ai.getSettings();
      keySection.replaceChildren(keySection.firstChild);

      // Provider picker sits above everything else — it's shown even with
      // only one option registered, both to prove the wiring end-to-end and
      // because it's where a second provider will simply appear once its
      // adapter exists, with no other UI change needed.
      const providerRow = document.createElement('div');
      providerRow.className = 'controls';
      const providerPicker = document.createElement('select');
      providerPicker.title = 'Which AI answers your questions';
      for (const id of settings.providers) {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = PROVIDER_LABELS[id] || id;
        option.selected = id === settings.provider;
        providerPicker.append(option);
      }
      providerPicker.addEventListener('change', async () => {
        const result = await api.ai.setOption('provider', providerPicker.value);
        if (result?.ok) renderKey();
        else keySection.append(note(result?.error || 'Could not switch provider.', 'bad'));
      });
      providerRow.append(providerPicker);
      keySection.append(providerRow);

      if (!settings.needsKey) {
        // e.g. Ollama — local, no key, nothing to configure here beyond the
        // model picker below.
        keySection.append(note(`${PROVIDER_LABELS[settings.provider] || settings.provider} runs locally — no API key needed.`));
      } else if (!settings.key.configured) {
        const controls = document.createElement('div');
        controls.className = 'controls';

        const field = document.createElement('input');
        field.type = 'password';
        field.placeholder = settings.provider === 'anthropic' ? 'sk-ant-…' : 'API key…';
        field.disabled = !settings.key.encryptionAvailable;

        const save = document.createElement('button');
        save.className = 'primary';
        save.textContent = 'Save';
        save.disabled = !settings.key.encryptionAvailable;
        save.addEventListener('click', async () => {
          const result = await api.ai.setKey(field.value);
          field.value = '';
          if (result?.ok) renderKey();
          else keySection.append(note(result?.error || 'Could not save the key.', 'bad'));
        });

        controls.append(field, save);
        keySection.append(
          controls,
          note(
            settings.key.encryptionAvailable
              ? 'Encrypted with the OS keystore and tied to your Windows account. Never written to config.json.'
              : `OS encryption unavailable — set the ${settings.keyEnvVar || 'matching'} environment variable instead.`
          )
        );
        return;
      }

      // From here down is shared by every provider that's usable right now —
      // either a key was just confirmed present above, or this provider
      // never needed one (Ollama). Only the trailing "Remove key" control is
      // conditional; model/effort/quality apply the same way to all of them.
      if (settings.needsKey) {
        keySection.append(row('Key', settings.key.source, 'good'));
      }

      const controls = document.createElement('div');
      controls.className = 'controls';

      const picker = (title, options, selected, onChange) => {
        const select = document.createElement('select');
        select.title = title;
        for (const [value, label] of options) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = label;
          option.selected = value === selected;
          select.append(option);
        }
        select.addEventListener('change', () => onChange(select.value));
        return select;
      };

      const modelIds = settings.modelCatalog[settings.provider] || [];
      const model = picker(
        settings.provider === 'ollama'
          ? 'A vision-capable local model is required to read screenshots'
          : 'Stronger models cost more and answer slightly slower',
        modelIds.map((id) => [id, id.replace('claude-', '')]),
        settings.model,
        (value) => api.ai.setOption('model', value)
      );

      const effort = picker(
        'Higher effort reasons more deeply but answers slower',
        ['low', 'medium', 'high', 'xhigh', 'max'].map((l) => [l, `effort: ${l}`]),
        settings.effort,
        (value) => api.ai.setOption('effort', value)
      );

      const quality = picker(
        'Smaller images upload faster and cost fewer tokens',
        [
          ['fast', 'image: 1280px'],
          ['balanced', 'image: 1568px'],
          ['max', 'image: 2576px'],
        ],
        settings.capture.quality,
        (value) => api.ai.setOption('quality', value)
      );

      controls.append(model, effort, quality);

      if (settings.needsKey) {
        const remove = document.createElement('button');
        remove.textContent = 'Remove key';
        remove.addEventListener('click', async () => {
          await api.ai.setKey('');
          renderKey();
        });
        controls.append(remove);
      }

      keySection.append(controls);

      /* --- capture region --- */
      const regionRow = document.createElement('div');
      regionRow.className = 'controls';

      const pick = document.createElement('button');
      pick.textContent = settings.capture.region ? 'Reselect region' : 'Select region';
      pick.addEventListener('click', async () => {
        await api.pickRegion();
        renderKey();
      });
      regionRow.append(pick);

      if (settings.capture.region) {
        const clear = document.createElement('button');
        clear.textContent = 'Clear';
        clear.addEventListener('click', async () => {
          await api.clearRegion();
          renderKey();
        });
        regionRow.append(clear);
      }

      keySection.append(
        row(
          'Reading',
          settings.capture.region
            ? `${settings.capture.region.width}x${settings.capture.region.height} region`
            : 'whole screen'
        ),
        regionRow,
        note(
          'Cropping to just the question area is the single biggest win available: far fewer image ' +
            'tokens, a smaller upload, and no competing questions in frame for the model to answer instead.'
        )
      );

      /* --- spend --- */
      const money = document.createElement('div');
      money.className = 'section';
      const moneyTitle = document.createElement('div');
      moneyTitle.className = 'section-title';
      moneyTitle.textContent = 'Spend';
      money.append(
        moneyTitle,
        row('This session', `$${settings.usage.session.costUsd.toFixed(3)} · ${settings.usage.session.requests} req`),
        row('Lifetime', `$${settings.usage.lifetime.costUsd.toFixed(2)} · ${settings.usage.lifetime.requests} req`)
      );

      const moneyControls = document.createElement('div');
      moneyControls.className = 'controls';

      const newChat = document.createElement('button');
      newChat.textContent = 'New chat';
      newChat.title = 'Forget the conversation and clear stored answers';
      newChat.addEventListener('click', () => api.ai.clearHistory());

      const resetUsage = document.createElement('button');
      resetUsage.textContent = 'Reset counter';
      resetUsage.addEventListener('click', async () => {
        await api.ai.resetUsage();
        renderKey();
      });

      moneyControls.append(newChat, resetUsage);
      money.append(moneyControls);
      keySection.append(money);
    }
    renderKey();

    /* --- display & privacy --- */
    const displaySection = section('Display & privacy');
    el.append(displaySection);

    api.ai.getSettings().then((settings) => {
      const controls = document.createElement('div');
      controls.className = 'controls';

      const slider = (label, min, max, step, value, onInput) => {
        const wrap = document.createElement('label');
        wrap.className = 'slider';
        const caption = document.createElement('span');
        caption.textContent = label;
        const range = document.createElement('input');
        range.type = 'range';
        range.min = min;
        range.max = max;
        range.step = step;
        range.value = value;
        range.addEventListener('input', () => onInput(Number(range.value)));
        wrap.append(caption, range);
        return wrap;
      };

      const theme = document.createElement('select');
      theme.title = 'Panel colour — auto follows Windows';
      for (const [value, label] of [
        ['dark', 'theme: dark'],
        ['light', 'theme: light'],
        ['auto', 'theme: auto'],
      ]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        option.selected = value === settings.display.theme;
        theme.append(option);
      }
      theme.addEventListener('change', () => api.ai.setOption('theme', theme.value));

      const opacity = slider('opacity', 0.4, 1, 0.02, settings.display.opacity, (v) =>
        api.ai.setOption('opacity', v)
      );
      const font = slider('text size', 0.8, 1.6, 0.05, settings.display.fontScale, (v) =>
        api.ai.setOption('fontScale', v)
      );

      const keepHistory = document.createElement('label');
      keepHistory.className = 'ask-toggle';
      const keepBox = document.createElement('input');
      keepBox.type = 'checkbox';
      keepBox.checked = settings.keepHistory !== false;
      keepBox.addEventListener('change', () => api.ai.setOption('keepHistory', keepBox.checked));
      const keepLabel = document.createElement('span');
      keepLabel.textContent = 'remember conversation';
      keepHistory.append(keepBox, keepLabel);

      const panic = document.createElement('button');
      panic.textContent = 'Clear everything now';
      panic.title = 'Wipe all answers and conversation from memory';
      panic.addEventListener('click', () => api.ai.panic());

      controls.append(theme, opacity, font);
      displaySection.append(controls, keepHistory, panic);
    });

    /* --- capture status --- */
    const statusSection = section('Screen capture');
    const build = windowsBuild(ctx.info.osRelease);
    const supported = ctx.info.platform === 'win32' && build !== null && build >= MIN_BUILD;

    if (ctx.info.platform === 'win32') {
      statusSection.append(
        row('Windows build', build === null ? ctx.info.osRelease : String(build), supported ? 'good' : 'bad')
      );
      if (!supported) {
        statusSection.append(
          note(
            `Build ${build} predates ${MIN_BUILD}, so the panel is rendered as a black box in captures rather than hidden. Do not rely on it.`,
            'bad'
          )
        );
      }
    } else {
      statusSection.append(
        note(
          ctx.info.platform === 'darwin'
            ? 'macOS: uses NSWindow.sharingType = .none.'
            : 'Linux: X11/Wayland expose no capture-exclusion API. The panel WILL be captured.',
          ctx.info.platform === 'darwin' ? null : 'bad'
        )
      );
    }
    statusSection.append(row('Display scale', `${ctx.info.scaleFactor}x`));
    el.append(statusSection);

    /* --- self-test --- */
    const testSection = section('Invisibility self-test');
    const testButton = document.createElement('button');
    testButton.textContent = 'Run self-test';

    const testResult = document.createElement('div');
    testResult.className = 'result';
    testResult.hidden = true;

    const showResult = (status, message, detail) => {
      testResult.hidden = false;
      testResult.className = `result ${status}`;
      testResult.replaceChildren(
        document.createTextNode(`${SELFTEST_LABELS[status] || status}  ${message}`)
      );
      if (detail) {
        const span = document.createElement('span');
        span.className = 'detail';
        span.textContent = detail;
        testResult.append(span);
      }
    };

    testButton.addEventListener('click', async () => {
      testButton.disabled = true;
      testButton.textContent = 'Testing…';
      testResult.hidden = true;
      try {
        const outcome = await api.runSelfTest();
        if (outcome) showResult(outcome.status, outcome.message, outcome.detail);
      } catch (err) {
        showResult('error', err.message);
      } finally {
        testButton.disabled = false;
        testButton.textContent = 'Run self-test';
      }
    });

    const offStarted = api.onSelfTestStarted(() => {
      testButton.disabled = true;
      testButton.textContent = 'Testing…';
      testResult.hidden = true;
    });
    const offResult = api.onSelfTestResult((outcome) => {
      testButton.disabled = false;
      testButton.textContent = 'Run self-test';
      if (outcome) showResult(outcome.status, outcome.message, outcome.detail);
    });

    testSection.append(
      testButton,
      note(
        'Captures this display through the same Windows Graphics Capture path Zoom, Teams and OBS use. ' +
          'Runs a control pass with protection off first, so a broken capture reports inconclusive rather than a false pass. ' +
          'The panel flashes magenta for about a second — that is the probe target.'
      ),
      testResult
    );
    el.append(testSection);

    /* --- hotkeys --- */
    const keysSection = section('Hotkeys');
    const labels = {
      answer: 'Answer what is on screen',
      ask: 'Ask a question',
      retryHarder: 'Retry harder',
      explain: 'Explain last answer',
      answerClipboard: 'Answer clipboard text',
      copyAnswer: 'Copy answer',
      previousAnswer: 'Previous answer',
      nextAnswer: 'Next answer',
      selectRegion: 'Select region',
      clearRegion: 'Clear region',
      panic: 'Clear everything',
      togglePin: 'Keep visible (pin)',
      toggleProtection: 'Toggle stealth',
      selfTest: 'Self-test',
    };
    for (const [action, label] of Object.entries(labels)) {
      const dl = document.createElement('dl');
      dl.className = 'row';
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.append(ctx.kbd(ctx.info.hotkeys[action]));
      dl.append(dt, dd);
      keysSection.append(dl);
    }

    const failures = ctx.info.hotkeyFailures || [];
    if (failures.length) {
      const describe = (f) => `${labels[f.action] || f.action} (${f.accelerator})`;
      const byReason = { conflict: [], invalid: [], unavailable: [] };
      for (const f of failures) (byReason[f.reason] || byReason.unavailable).push(f);

      // Conflicts are reported once per accelerator, not once per action —
      // both clashing actions carry reason:'conflict', which would otherwise
      // print "X clashes with Y" and "Y clashes with X" as two lines.
      if (byReason.conflict.length) {
        const byAccel = new Map();
        for (const f of byReason.conflict) {
          if (!byAccel.has(f.accelerator)) byAccel.set(f.accelerator, []);
          byAccel.get(f.accelerator).push(f);
        }
        const lines = [...byAccel.entries()].map(
          ([accel, group]) => `${group.map((f) => labels[f.action] || f.action).join(' / ')} both use ${accel}`
        );
        keysSection.append(note(`Clashing with each other: ${lines.join('; ')}.`, 'bad'));
      }
      if (byReason.invalid.length) {
        keysSection.append(
          note(`Not a valid shortcut: ${byReason.invalid.map(describe).join(', ')}.`, 'bad')
        );
      }
      if (byReason.unavailable.length) {
        keysSection.append(
          note(`Already used by another app: ${byReason.unavailable.map(describe).join(', ')}.`, 'bad')
        );
      }
      keysSection.append(note(`Change any of these in ${ctx.info.configPath}.`));
    }
    keysSection.append(note('Drag the panel anywhere by pressing and holding it.'));
    el.append(keysSection);

    return {
      unmount() {
        offStarted();
        offResult();
      },
    };
  },
};
