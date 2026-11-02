import { useStarWords } from './game/missions.js';
import { METER_SIZE } from './game/starDrop.js';
import { STORE_CAPACITY } from './game/pearls.js';

// Everything the star machine renames, and the coin game's own words to put back.
const WORDS = [
  ['#game-title', '星珠夜曲<span lang="en">ASTRAL NOCTURNE</span>'],
  ['.stat--credits dt', '剩餘球數'],
  ['#onboardingTitle', '看準時機投球'],
  ['.onboarding li:nth-child(1)', '<strong>投球</strong><span>發射器左右移動，按下就從那裡落球。</span>'],
  ['.onboarding li:nth-child(2)', '<strong>落槽</strong><span>外側集星雨，內側補星珠，中央放星核。集滿五格就下星雨。</span>'],
  ['.onboarding li:nth-child(3)', '<strong>鍊金</strong><span>同色星核相遇會融合升級，推下去獎勵更大。星珠掉出機台就算分。</span>'],
].map(([selector, astral]) => {
  const element = document.querySelector(selector);
  return { element, astral, classic: element?.innerHTML };
});

/**
 * The star machine's controls: tap the field or the big button to drop a ball, and the rename.
 * Polled rather than pushed, because the test panel can swap machines at any moment.
 */
export function mountAstralUI(game, onWords) {
  const field = document.querySelector('#field');
  const banner = document.createElement('div');
  banner.className = 'star-banner';
  banner.hidden = true;
  banner.setAttribute('role', 'status');
  field.append(banner);

  const meter = document.createElement('div');
  meter.className = 'star-meter';
  meter.setAttribute('role', 'img');
  meter.innerHTML = `<span class="star-meter__name">STAR RAIN</span><span class="star-meter__lamps">${'<i></i>'.repeat(METER_SIZE)}</span>`;
  const lamps = [...meter.querySelectorAll('i')];
  document.querySelector('.control-row').prepend(meter);

  field.addEventListener('pointerdown', (event) => {
    if (game.pure && !event.target.closest('button, .pearl-lab')) game.star.fire();
  });

  let shownPure = null;
  const refresh = () => {
    const { pure } = game;
    if (pure === shownPure) return;
    shownPure = pure;
    useStarWords(pure);
    document.documentElement.toggleAttribute('data-astral', pure);
    for (const { element, astral, classic } of WORDS) {
      if (element) element.innerHTML = pure ? astral : classic;
    }
    meter.hidden = !pure;
    onWords();
  };
  refresh();
  window.setInterval(refresh, 200);
  const setMeter = (filled) => {
    lamps.forEach((lamp, index) => lamp.classList.toggle('is-lit', index < filled));
    meter.setAttribute('aria-label', `星雨計量 ${filled} / ${METER_SIZE}`);
  };
  setMeter(0);
  return {
    setMeter,
    /** Puts a two-line message over the machine; with `onAgain`, a play-again button under it. */
    show(title, detail, onAgain) {
      banner.replaceChildren(...[title, detail].map((text) => {
        const line = document.createElement('p');
        line.textContent = text;
        return line;
      }));
      if (onAgain) {
        const again = document.createElement('button');
        again.type = 'button';
        again.textContent = 'PLAY AGAIN';
        again.addEventListener('click', onAgain);
        banner.append(again);
      }
      banner.hidden = false;
    },
    hide() {
      banner.hidden = true;
    },
  };
}
