import './styles.css';
import { CoinPusher } from './game/CoinPusher.js';
import { GAME, getQualityProfile } from './game/config.js';
import { TUNING_DEFAULTS } from './game/physics.js';
import { aimLabel, calculateReward, worldAimToScreen } from './game/rules.js';
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

function attemptDrop() {
  if (!state.ready || !game) return;
  audio.ensureContext();
  if (state.credits <= 0) {
    stopAuto();
    audio.error();
    ui.announce('硬幣用完了，等待機台上的硬幣掉落，或重新開始。');
    return;
  }
  if (!game.dropAtAim()) {
    audio.error();
    ui.announce('投幣槽忙碌中，請稍後再試。');
    return;
  }
  state.credits -= 1;
  audio.drop();
  navigator.vibrate?.(12);
  renderState();
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
  attemptDrop();
  autoTimer = window.setInterval(() => {
    if (!document.hidden && !elements.onboarding.open) attemptDrop();
  }, GAME.autoInterval * 1000);
}

function handleScore(coins, elapsed) {
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
  persist();
  renderState();
}

function resetSession() {
  stopAuto();
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

  elements.dropButton.addEventListener('click', attemptDrop);
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
  elements.gameCanvas.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      game?.moveAimOnScreen(-0.25);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      game?.moveAimOnScreen(0.25);
    } else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      attemptDrop();
    } else if (event.key.toLowerCase() === 'a') {
      event.preventDefault();
      toggleAuto();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!game || elements.onboarding.open) return;
    if (document.hidden) game.stop();
    else game.start();
  });
  window.addEventListener('beforeunload', () => game?.destroy(), { once: true });
}

async function boot() {
  bindUI();
  renderState();
  try {
    game = await new CoinPusher(elements.gameCanvas, quality, {
      onTap: attemptDrop,
      onAim: (value) => ui.setAim(aimLabel(worldAimToScreen(value))),
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
