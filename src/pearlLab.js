// Any fixed number: what matters is that every press of 同堆重置 rebuilds the same pile.
const LAB_SEED = 20261031;

/** Text for the lab's readout. `latency` is null until a poured pearl has gone over the lip. */
export function labReadout({ onBed, pouring, latency }, round, fps) {
  const delay = latency === null ? '-' : `${latency.toFixed(1)}s`;
  const rate = fps ? `${fps.toFixed(0)} fps` : '- fps';
  return `${pouring ? '落珠中 · ' : ''}場上 ${onBed} · 星雨 ${round.meter} · 命中到掉出 ${delay} · ${rate}`;
}

/**
 * Adds the test panel: a corner button on the field opening a small overlay, for the shot interval
 * and a repeatable restart on the device. Built here rather than in index.html so it can
 * be dropped without touching the shipped markup.
 * ponytail: stats poll a few times a second instead of pushing, the panel is the only reader.
 */
export function mountPearlLab(game, onReset) {
  const { pearls, star } = game;
  const toggle = document.createElement('button');
  toggle.className = 'pearl-lab-toggle';
  toggle.type = 'button';
  toggle.textContent = '珠';
  toggle.setAttribute('aria-label', '測試面板');
  toggle.setAttribute('aria-expanded', 'false');

  const panel = document.createElement('section');
  panel.className = 'pearl-lab';
  panel.setAttribute('aria-label', '測試面板');
  panel.hidden = true;
  panel.innerHTML = `
    <div class="pearl-lab__actions">
      <button type="button" data-action="reset">同堆重置</button>
      <button type="button" data-action="pure">純珍珠</button>
    </div>
    <div class="pearl-lab__knobs">
      <label>發射間隔 <output data-value="interval"></output>
        <input type="range" data-knob="interval" min="0.4" max="2" step="0.1" value="${star.fireInterval}" />
      </label>
    </div>
    <output class="pearl-lab__stats"></output>`;

  const stats = panel.querySelector('.pearl-lab__stats');
  const interval = panel.querySelector('[data-value="interval"]');
  const pure = panel.querySelector('[data-action="pure"]');
  const show = () => {
    pure.setAttribute('aria-pressed', String(game.pure));
    interval.textContent = star.fireInterval.toFixed(1);
  };
  const actions = {
    reset: () => {
      game.resetPile(LAB_SEED);
      onReset();
    },
    pure: () => {
      game.setPure(!game.pure, LAB_SEED);
      onReset();
    },
  };
  panel.addEventListener('click', ({ target }) => {
    const button = target.closest('button');
    if (!button) return;
    actions[button.dataset.action]();
    show();
  });
  panel.addEventListener('input', ({ target }) => {
    star.fireInterval = Number(target.value);
    show();
  });
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
  });
  const refresh = () => {
    if (!panel.hidden) stats.textContent = labReadout(pearls.stats(), star, game.perf?.fps);
  };
  const timer = window.setInterval(refresh, 250);

  show();
  refresh();
  document.querySelector('#field').append(panel, toggle);
  return () => window.clearInterval(timer);
}
