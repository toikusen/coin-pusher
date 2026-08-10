import { GAME } from './game/config.js';


// Slider id -> the setPhysics key it drives, and how many decimals its readout shows.
// Order is display order; `resize` marks the one that has to reseed the pile on release.
//
// Only the two knobs that measurably move difficulty are exposed. Over a 120 s sim (2 seeds,
// ~268 drops) thickness took the coin count resting on the field from 81 down to 39, and ground
// friction moved it 69 / 81 / 88 across its range - both monotonic. The ones left out either
// measured flat (payout tilt: 0.3 and 1.2 both gave 81) or barely moved it (coin-to-coin +3,
// pusher friction -7, and that one in the counter-intuitive direction). Mass is inert by
// construction: weight, inertia and the friction ceiling all scale with it together.
// setPhysics and TUNING_DEFAULTS still carry every key, so re-adding a slider is markup only.
export const TUNING_CONTROLS = Object.freeze([
  { id: 'tuneThickness', key: 'thickness', digits: 2, resize: true },
  { id: 'tuneGroundFriction', key: 'groundFriction', digits: 2 },
]);

export function collectUI() {
  const ids = [
    'score', 'credits', 'bestScore', 'missionValue', 'missionBar', 'missionLabel',
    'gameCanvas', 'field', 'loading', 'loadError', 'errorMessage', 'retryButton',
    'reward', 'rewardAmount', 'rewardCombo', 'aimValue', 'dropButton', 'autoButton',
    'soundButton', 'helpButton', 'resetButton', 'onboarding', 'startButton', 'announcer',
    'tuneToggle', 'tunePanel', 'tuneClose', 'tunePhysicsReset',
    'hdriHorizontal', 'hdriHorizontalValue', 'hdriVertical', 'hdriVerticalValue', 'hdriReset',
    ...TUNING_CONTROLS.flatMap((control) => [control.id, `${control.id}Value`]),
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
    this.el.credits.textContent = state.credits;
    this.el.bestScore.textContent = state.bestScore;
    this.el.missionValue.textContent = `推落 ${Math.min(state.score, GAME.missionTarget)} / ${GAME.missionTarget}`;
    this.el.missionBar.style.width = `${Math.min(100, (state.score / GAME.missionTarget) * 100)}%`;
    this.el.dropButton.disabled = state.credits <= 0 || !state.ready;
    this.el.autoButton.disabled = state.credits <= 0 || !state.ready;
  }

  setAim(label) { this.el.aimValue.textContent = label; }

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

  reward({ total, combo, premium, bonus }) {
    clearTimeout(this.rewardTimer);
    this.el.rewardAmount.textContent = `+${total}`;
    this.el.rewardCombo.textContent = bonus > 0 ? `COMBO ×${combo} · BONUS +${bonus}` : premium ? 'STAR COIN ×3' : 'NICE DROP';
    this.el.reward.classList.remove('is-visible');
    void this.el.reward.offsetWidth;
    this.el.reward.classList.add('is-visible');
    this.rewardTimer = window.setTimeout(() => this.el.reward.classList.remove('is-visible'), 1200);
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
