import './styles.css';
import { CoinPusher } from './game/CoinPusher.js';
import { GAME, getQualityProfile } from './game/config.js';
import { TUNING_DEFAULTS } from './game/physics.js';
import { CHARGE_SECONDS, calculateReward, chargeToPower } from './game/rules.js';
import { GameAudio } from './audio.js';
import { loadProgress, saveProgress } from './storage.js';
import { collectUI, GameUI, TUNING_CONTROLS } from './ui.js';

const elements = collectUI();
const ui = new GameUI(elements);
const quality = getQualityProfile();
const progress = loadProgress();
progress.hdriHorizontal = Number.isFinite(progress.hdriHorizontal)
  ? Math.min(180, Math.max(-180, progress.hdriHorizontal))
  : 0;
progress.hdriVertical = Number.isFinite(progress.hdriVertical)
  ? Math.min(90, Math.max(-90, progress.hdriVertical))
  : 0;

// Saved tuning comes back from localStorage, so it is untrusted: keep only known keys whose
// value is a finite number inside the range its own slider allows. A hand-edited or stale
// entry would otherwise reach cannon-es as NaN and quietly break every contact in the world.
function sanitiseTuning(saved) {
  if (!saved || typeof saved !== 'object') return {};
  const clean = {};
  for (const { id, key } of TUNING_CONTROLS) {
    // Require an actual number: Number(null) and Number('') are 0, which would silently pass
    // as a legitimate setting rather than being rejected.
    const value = saved[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const input = elements[id];
    clean[key] = Math.min(Number(input.max), Math.max(Number(input.min), value));
  }
  return clean;
}
progress.tuning = sanitiseTuning(progress.tuning);
const audio = new GameAudio(progress.soundEnabled);

const state = {
  ready: false,
  score: 0,
  credits: GAME.startingCredits,
  bestScore: progress.bestScore,
  combo: 0,
  lastScoreAt: -Infinity,
  auto: false,
  missionComplete: false,
};

let game = null;
let autoTimer = 0;

function persist() {
  saveProgress({
    bestScore: state.bestScore,
    soundEnabled: audio.enabled,
    hasSeenOnboarding: progress.hasSeenOnboarding,
    hdriHorizontal: progress.hdriHorizontal,
    hdriVertical: progress.hdriVertical,
    tuning: progress.tuning,
  });
}

function renderState() {
  ui.update(state);
  ui.setAuto(state.auto);
  ui.setSound(audio.enabled);
}

function stopAuto() {
  state.auto = false;
  window.clearInterval(autoTimer);
  autoTimer = 0;
  ui.setAuto(false);
}

function attemptDrop(side, power) {
  if (!state.ready || !game) return;
  audio.ensureContext();
  if (state.credits <= 0) {
    stopAuto();
    audio.error();
    ui.announce('硬幣用完了，等待機台上的硬幣掉落，或重新開始。');
    return;
  }
  if (!game.drop(side, power)) {
    audio.error();
    ui.announce('投幣槽忙碌中，請稍後再試。');
    return;
  }
  state.credits -= 1;
  audio.drop();
  navigator.vibrate?.(12);
  renderState();
}

// Press-and-hold charging, in one place. The buttons, the arrow keys and a press on the canvas all
// funnel through here, so the three of them cannot drift apart on what a given hold is worth.
// The bar itself is a CSS animation; this only keeps the timestamp, so there is no rAF loop.
let charge = null;

function beginCharge(side) {
  if (!state.ready || !game || charge?.side === side) return;
  if (state.credits <= 0) {
    audio.error();
    ui.announce('硬幣用完了，等待機台上的硬幣掉落，或重新開始。');
    return;
  }
  audio.ensureContext();
  charge = { side, at: performance.now() };
  game.armSide(side);
  ui.setCharging(side);
}

function releaseCharge() {
  if (!charge) return;
  const { side, at } = charge;
  charge = null;
  ui.setCharging(0);
  attemptDrop(side, chargeToPower((performance.now() - at) / 1000));
}

function cancelCharge() {
  charge = null;
  ui.setCharging(0);
}

function toggleAuto() {
  if (!state.ready) return;
  if (state.auto) {
    stopAuto();
    ui.announce('已關閉自動投幣');
    return;
  }
  if (state.credits <= 0) {
    ui.announce('硬幣不足，無法開啟自動投幣');
    return;
  }
  state.auto = true;
  ui.setAuto(true);
  ui.announce('已開啟自動投幣');
  // Alternating sides at a middling power: an unattended machine should still spread its coins,
  // and alternating is the only pattern a watching player can predict.
  let autoSide = 1;
  const autoDrop = () => {
    attemptDrop(autoSide, 0.45);
    autoSide = -autoSide;
  };
  autoDrop();
  autoTimer = window.setInterval(() => {
    if (!document.hidden && !elements.onboarding.open) autoDrop();
  }, GAME.autoInterval * 1000);
}

// The game reports one frame's worth of coins per payout, and an avalanche spills over many
// frames. Collect them for a moment so one avalanche reads as one payout: one sound, one
// announcement, one save - instead of a burst of each in the same tenth of a second.
const PAYOUT_BATCH_MS = 140;
let payout = null;

function handleScore(coins, elapsed) {
  // Snapshot what the reward depends on: coin objects are pooled and reused, so holding the
  // objects across the batch window would let a recycled coin change what it paid.
  const dropped = coins.map((coin) => ({ isPremium: coin.isPremium }));
  if (payout) {
    payout.coins.push(...dropped);
    payout.elapsed = elapsed;
    return;
  }
  payout = { coins: dropped, elapsed, timer: window.setTimeout(flushPayout, PAYOUT_BATCH_MS) };
}

function clearPayout() {
  if (!payout) return;
  window.clearTimeout(payout.timer);
  payout = null;
}

function flushPayout() {
  if (!payout) return;
  const { coins, elapsed } = payout;
  payout = null;
  const result = calculateReward(coins, state.combo, elapsed - state.lastScoreAt);
  const premium = coins.some((coin) => coin.isPremium);
  state.combo = result.combo;
  state.lastScoreAt = elapsed;
  state.score += result.total;
  state.credits += result.base;
  state.bestScore = Math.max(state.bestScore, state.score);

  ui.reward({ ...result, premium });
  ui.announce(`掉落 ${coins.length} 枚，獲得 ${result.total} 分，剩餘 ${state.credits} 枚硬幣`);
  if (result.bonus > 0) audio.jackpot();
  else audio.payout(premium);
  navigator.vibrate?.(result.bonus > 0 ? [25, 35, 45] : 20);

  if (!state.missionComplete && state.score >= GAME.missionTarget) {
    state.missionComplete = true;
    ui.missionComplete();
    audio.jackpot();
  }
  // Only the best score can change here, and localStorage writes are synchronous - during a
  // payout run this is the one thing in the frame that touches disk.
  if (state.bestScore > progress.bestScore) {
    progress.bestScore = state.bestScore;
    persist();
  }
  renderState();
}

function resetSession() {
  stopAuto();
  // A payout still in the batch window belongs to the session being thrown away.
  clearPayout();
  state.score = 0;
  state.credits = GAME.startingCredits;
  state.combo = 0;
  state.lastScoreAt = -Infinity;
  state.missionComplete = false;
  game?.resetPile();
  ui.resetMission();
  ui.announce('遊戲已重新開始');
  renderState();
  elements.gameCanvas.focus();
}

function showOnboarding() {
  stopAuto();
  game?.stop();
  if (!elements.onboarding.open) elements.onboarding.showModal();
}

function closeOnboarding() {
  progress.hasSeenOnboarding = true;
  persist();
  elements.onboarding.close();
  game?.start();
  elements.gameCanvas.focus();
}

function bindUI() {
  const updateHdriRotation = (save = false) => {
    progress.hdriHorizontal = Number(elements.hdriHorizontal.value);
    progress.hdriVertical = Number(elements.hdriVertical.value);
    game?.setEnvironmentRotation(progress.hdriHorizontal, progress.hdriVertical);
    ui.setHdriRotation(progress.hdriHorizontal, progress.hdriVertical);
    if (save) persist();
  };

  for (const { id, key, digits, resize } of TUNING_CONTROLS) {
    const input = elements[id];
    const readout = elements[`${id}Value`];
    // Thickness resizes collision shapes and reseeds the pile, so it waits for release;
    // every other knob is safe to apply on each drag frame.
    const apply = (event) => {
      const value = Number(input.value);
      readout.value = value.toFixed(digits);
      if (resize && event.type === 'input') return;
      game?.setPhysics({ [key]: value });
      progress.tuning = { ...progress.tuning, [key]: value };
      if (event.type === 'change') persist();
    };
    input.addEventListener('input', apply);
    input.addEventListener('change', apply);
  }

  elements.tunePhysicsReset.addEventListener('click', () => {
    progress.tuning = {};
    game?.setPhysics({ ...TUNING_DEFAULTS, solverIterations: quality.solverIterations });
    if (game) ui.setTuning(game.tuning);
    persist();
    ui.announce('物理參數已回到預設值');
  });

  for (const [side, button] of [[1, elements.dropLeft], [-1, elements.dropRight]]) {
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      beginCharge(side);
    });
    button.addEventListener('pointerup', releaseCharge);
    button.addEventListener('pointerleave', cancelCharge);
    button.addEventListener('pointercancel', cancelCharge);
  }
  elements.autoButton.addEventListener('click', toggleAuto);
  elements.soundButton.addEventListener('click', () => {
    audio.setEnabled(!audio.enabled);
    ui.setSound(audio.enabled);
    persist();
    ui.announce(audio.enabled ? '音效已開啟' : '音效已關閉');
  });
  elements.helpButton.addEventListener('click', showOnboarding);
  elements.startButton.addEventListener('click', closeOnboarding);
  elements.resetButton.addEventListener('click', resetSession);
  elements.retryButton.addEventListener('click', () => window.location.reload());
  elements.tuneToggle.addEventListener('click', () => {
    ui.setTunePanel(elements.tunePanel.hidden);
  });
  elements.tuneClose.addEventListener('click', () => {
    ui.setTunePanel(false);
    elements.tuneToggle.focus();
  });
  elements.hdriHorizontal.addEventListener('input', () => updateHdriRotation());
  elements.hdriHorizontal.addEventListener('change', () => updateHdriRotation(true));
  elements.hdriVertical.addEventListener('input', () => updateHdriRotation());
  elements.hdriVertical.addEventListener('change', () => updateHdriRotation(true));
  elements.hdriReset.addEventListener('click', () => {
    elements.hdriHorizontal.value = 0;
    elements.hdriVertical.value = 0;
    updateHdriRotation(true);
  });
  elements.onboarding.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeOnboarding();
  });
  // Held keys repeat, and a repeat must not restart the charge - beginCharge already ignores a
  // press on the side it is charging, so the guard is only about not stealing the other side.
  elements.gameCanvas.addEventListener('keydown', (event) => {
    const side = { ArrowLeft: 1, ArrowRight: -1 }[event.key];
    if (side) {
      event.preventDefault();
      if (!event.repeat) beginCharge(side);
    } else if (event.key.toLowerCase() === 'a') {
      event.preventDefault();
      toggleAuto();
    }
  });
  elements.gameCanvas.addEventListener('keyup', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') releaseCharge();
  });
  // A charge left running because focus moved away would fire on the next unrelated press.
  window.addEventListener('blur', cancelCharge);
  document.addEventListener('visibilitychange', () => {
    if (!game || elements.onboarding.open) return;
    if (document.hidden) game.stop();
    else game.start();
  });
  window.addEventListener('beforeunload', () => game?.destroy(), { once: true });
}

async function boot() {
  // CSS animates the charge bar, rules.js decides how long a full charge takes; this is the seam.
  document.documentElement.style.setProperty('--charge-duration', `${CHARGE_SECONDS}s`);
  bindUI();
  renderState();
  try {
    game = await new CoinPusher(elements.gameCanvas, quality, {
      onPressStart: beginCharge,
      onPressEnd: releaseCharge,
      onPressCancel: cancelCharge,
      onScore: handleScore,
      onError: (message) => ui.error(message),
    }).init();
    // Dev-only handle so motion can be measured from the console. Stripped from the build.
    if (import.meta.env.DEV) window.__game = game;
    game.setEnvironmentRotation(progress.hdriHorizontal, progress.hdriVertical);
    ui.setHdriRotation(progress.hdriHorizontal, progress.hdriVertical);
    if (Object.keys(progress.tuning).length > 0) game.setPhysics(progress.tuning);
    ui.setTuning(game.tuning);
    state.ready = true;
    ui.ready();
    renderState();
    if (progress.hasSeenOnboarding) {
      game.start();
      elements.gameCanvas.focus();
    } else {
      showOnboarding();
    }
  } catch (error) {
    state.ready = false;
    ui.error(error instanceof Error ? error.message : '未知的啟動錯誤，請重新載入。');
    renderState();
  }
}

boot();
