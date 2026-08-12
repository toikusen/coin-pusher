import { GAME } from './game/config.js';


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

export function collectUI() {
  const ids = [
    'score', 'credits', 'bestScore', 'missionValue', 'missionBar', 'missionLabel',
    'gameCanvas', 'field', 'loading', 'loadError', 'errorMessage', 'retryButton',
    'reward', 'rewardAmount', 'rewardCombo', 'dropLeft', 'dropRight', 'autoButton',
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
    const idle = state.credits <= 0 || !state.ready;
    this.el.dropLeft.disabled = idle;
    this.el.dropRight.disabled = idle;
    this.el.autoButton.disabled = idle;
  }

  // The charge bar is a CSS animation, so this only has to say which button is filling. Restarting
  // it needs the class off for a frame, or a second press on the same button inherits the finished
  // animation and shows a full bar immediately.
  setCharging(side) {
    for (const [buttonSide, button] of [[1, this.el.dropLeft], [-1, this.el.dropRight]]) {
      button.classList.toggle('is-charging', buttonSide === side);
    }
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
    // The bonus is paid once per chain, so it cannot carry the combo readout on its own: past
    // the threshold the count still has to be visible on the payouts that earn no bonus.
    this.el.rewardCombo.textContent = bonus > 0
      ? `COMBO ×${combo} · BONUS +${bonus}`
      : combo >= GAME.comboThreshold
        ? `COMBO ×${combo}`
        : premium ? 'STAR COIN ×3' : 'NICE DROP';
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
