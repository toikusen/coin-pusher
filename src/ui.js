import { GAME, MACHINE_GEOMETRY_LIMITS } from './game/config.js';


// Slider id -> the setPhysics key it drives, and how many decimals its readout shows.
// Order is display order; `resize` marks the one that has to reseed the pile on release.
//
// Only the two player-facing difficulty knobs are exposed. Thickness decides whether coins climb
// or slide; table friction decides how long an impulse survives. Coin-to-coin and pusher friction
// remain calibrated implementation details: exposing all three invites combinations that either
// break the force chain or drag the tray pile backwards. setPhysics and TUNING_DEFAULTS still
// carry every key for diagnostics.
export const TUNING_CONTROLS = Object.freeze([
  { id: 'tuneThickness', key: 'thickness', digits: 2, resize: true },
  { id: 'tuneGroundFriction', key: 'groundFriction', digits: 2 },
]);

// Slider id -> the machineGeometryFor key it drives. Every one of them resizes colliders and
// reseeds the pile on release, so unlike the physics knobs there is no cheap-to-apply subset.
export const GEOMETRY_CONTROLS = Object.freeze([
  { id: 'geoScraperZ', key: 'scraperZ' },
  { id: 'geoUpperCenterZ', key: 'upperCenterZ' },
  { id: 'geoUpperLength', key: 'upperLength' },
  { id: 'geoLowerCenterZ', key: 'lowerCenterZ' },
  { id: 'geoLowerLength', key: 'lowerLength' },
]);

// Reset throws the round away, so it takes two taps: the first only arms it, for this long.
export const RESET_CONFIRM_MS = 3000;

/** Whether a reset tap at `now` goes through, given when the button was last armed. */
export function resetConfirmed(armedAt, now) {
  return now - armedAt <= RESET_CONFIRM_MS;
}

export function collectUI() {
  const ids = [
    'score', 'credits', 'bestScore', 'missionValue', 'missionBar', 'missionLabel',
    'gameCanvas', 'field', 'loading', 'loadError', 'errorMessage', 'retryButton',
    'reward', 'rewardAmount', 'rewardCombo', 'dropButton', 'autoButton',
    'soundButton', 'helpButton', 'resetButton', 'onboarding', 'startButton', 'announcer',
    'tuneToggle', 'tunePanel', 'tuneClose', 'tunePhysicsReset', 'tuneGeometryReset',
    'hdriHorizontal', 'hdriHorizontalValue', 'hdriVertical', 'hdriVerticalValue', 'hdriReset',
    'cheatSlot', 'cheatOdds', 'cheatDrop', 'cheatSpin',
    ...TUNING_CONTROLS.flatMap((control) => [control.id, `${control.id}Value`]),
    ...GEOMETRY_CONTROLS.flatMap((control) => [control.id, `${control.id}Value`]),
  ];
  return Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
}

export class GameUI {
  constructor(elements) {
    this.el = elements;
    this.rewardTimer = 0;
  }

  update(state) {
    this.el.score.textContent = state.score;
    this.el.credits.textContent = Number.isFinite(state.credits) ? state.credits : '∞';
    this.el.bestScore.textContent = state.bestScore;
    this.el.missionValue.textContent = `推落 ${Math.min(state.score, GAME.missionTarget)} / ${GAME.missionTarget}`;
    this.el.missionBar.style.width = `${Math.min(100, (state.score / GAME.missionTarget) * 100)}%`;
    const idle = state.credits <= 0 || !state.ready;
    this.el.dropButton.disabled = idle;
    this.el.autoButton.disabled = idle;
  }

  setTunePanel(open) {
    this.el.tunePanel.hidden = !open;
    this.el.tuneToggle.setAttribute('aria-expanded', String(open));
  }

  // Mirror the live physics values onto every slider and its readout. Called on boot and after
  // a reset, so the panel never drifts from what the world is actually running.
  setTuning(tuning) {
    for (const { id, key, digits } of TUNING_CONTROLS) {
      this.el[id].value = tuning[key];
      this.el[`${id}Value`].value = Number(tuning[key]).toFixed(digits);
    }
  }

  // Same job as setTuning, and it has one more reason to exist: machineGeometryFor clamps what
  // it is given - the upper deck grows to stay under the scraper - so the applied geometry is not
  // always the one the slider was dropped on, and the panel has to show what the machine took.
  setGeometry(geometry) {
    for (const { id, key } of GEOMETRY_CONTROLS) {
      // Ranges come from the same limits machineGeometryFor clamps to: hard-coded in the markup they
      // went stale as the machine was retuned, and a slider whose max sat under the default yanked
      // the pusher back the moment it was touched.
      [this.el[id].min, this.el[id].max] = MACHINE_GEOMETRY_LIMITS[key];
      this.el[id].value = geometry[key];
      this.el[`${id}Value`].value = Number(geometry[key]).toFixed(2);
    }
  }

  // The cheat select and its odds line are both built from GAME.slotOutcomes, so a new reel
  // symbol shows up here on its own: one config entry, one prize handler in main.js, no third
  // list to keep in step. slot is whatever the query string already forced, or null.
  initCheats(slot) {
    const options = [
      ['', '隨機（正常機率）'],
      ...GAME.slotOutcomes.map(({ symbol, label }) => [symbol, `一定 ${label}`]),
      ['miss', '一定沒中'],
    ];
    this.el.cheatSlot.replaceChildren(...options.map(([value, text]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      return option;
    }));
    this.el.cheatSlot.value = slot ?? '';
    const paid = GAME.slotOutcomes.reduce((sum, outcome) => sum + outcome.chance, 0);
    this.el.cheatOdds.textContent = [
      ...GAME.slotOutcomes.map(({ label, chance }) => `${label} ${Math.round(chance * 100)}%`),
      `沒中 ${Math.round((1 - paid) * 100)}%`,
    ].join('、');
  }

  setHdriRotation(horizontal, vertical) {
    this.el.hdriHorizontal.value = horizontal;
    this.el.hdriVertical.value = vertical;
    this.el.hdriHorizontalValue.value = `${horizontal}°`;
    this.el.hdriVerticalValue.value = `${vertical}°`;
  }

  setAuto(enabled) {
    this.el.autoButton.setAttribute('aria-pressed', String(enabled));
  }

  setSound(enabled) {
    this.el.soundButton.setAttribute('aria-pressed', String(enabled));
    this.el.soundButton.setAttribute('aria-label', enabled ? '關閉音效' : '開啟音效');
    this.el.soundButton.firstElementChild.textContent = enabled ? '♪' : '×';
  }

  ready() {
    this.el.loading.hidden = true;
    this.el.loadError.hidden = true;
  }

  error(message) {
    this.el.loading.hidden = true;
    this.el.errorMessage.textContent = message;
    this.el.loadError.hidden = false;
  }

  // jackpot is the prize's own headline when a chest pays - '' or absent for a normal payout.
  reward({ total, combo, premium, bonus, jackpot }) {
    clearTimeout(this.rewardTimer);
    this.el.rewardAmount.textContent = `+${total}`;
    // The bonus is paid once per chain, so it cannot carry the combo readout on its own: past
    // the threshold the count still has to be visible on the payouts that earn no bonus.
    this.el.rewardCombo.textContent = jackpot
      ? jackpot
      : bonus > 0
      ? `COMBO ×${combo} · BONUS +${bonus}`
      : combo >= GAME.comboThreshold
        ? `COMBO ×${combo}`
        : premium ? 'STAR COIN ×3' : 'NICE DROP';
    this.el.reward.classList.remove('is-visible');
    void this.el.reward.offsetWidth;
    this.el.reward.classList.add('is-visible');
    this.rewardTimer = window.setTimeout(() => this.el.reward.classList.remove('is-visible'), 1200);
  }

  armReset(armed) {
    this.el.resetButton.classList.toggle('is-armed', armed);
    this.el.resetButton.setAttribute('aria-label', armed ? '再按一次重新開始' : '重新開始');
    if (armed) this.announce('再按一次重新開始');
  }

  announce(message) {
    this.el.announcer.textContent = '';
    window.setTimeout(() => { this.el.announcer.textContent = message; }, 20);
  }

  missionComplete() {
    this.el.missionLabel.textContent = '任務完成';
    this.announce(`任務完成，已推落 ${GAME.missionTarget} 分`);
  }

  resetMission() { this.el.missionLabel.textContent = '本局任務'; }
}
