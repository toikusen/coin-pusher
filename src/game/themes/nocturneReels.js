export const SYMBOL_IDS = ['7', 'bag', 'quake', 'gild', '?'];

const TAU = Math.PI * 2;
const DEFAULT_PALETTE = {
  shell: 0x0e1624, shellRaised: 0x142235, gold: 0xf2c94c,
  goldSoft: 0xffe9a3, mint: 0x00c8b4, purple: 0x7a37b8,
};
const cssColor = (value) => `#${value.toString(16).padStart(6, '0')}`;

function polygon(context, points) {
  context.beginPath();
  points.forEach(([x, y], index) => context[index ? 'lineTo' : 'moveTo'](x, y));
  context.closePath();
}

function circle(context, radius) {
  context.beginPath();
  context.arc(0, 0, radius, 0, TAU);
}

function drawSeven(context, ink) {
  const outline = [
    [-0.35, -0.48], [0.32, -0.48], [0.4, -0.4], [0.4, -0.22],
    [0.08, 0.36], [0.08, 0.48], [-0.24, 0.48], [-0.24, 0.34],
    [0.07, -0.18], [-0.36, -0.18], [-0.36, -0.27], [-0.43, -0.27],
    [-0.43, -0.4], [-0.35, -0.4],
  ];
  context.save();
  context.translate(0.035, 0.04);
  context.globalAlpha *= 0.24;
  context.fillStyle = ink.shell;
  polygon(context, outline);
  context.fill();
  context.restore();
  const enamel = context.createLinearGradient(-0.3, -0.45, 0.3, 0.45);
  enamel.addColorStop(0, ink.shellRaised);
  enamel.addColorStop(0.4, ink.purple);
  enamel.addColorStop(1, ink.shell);
  context.fillStyle = enamel;
  context.strokeStyle = ink.gold;
  context.lineWidth = 0.035;
  polygon(context, outline);
  context.fill();
  context.stroke();
  context.strokeStyle = ink.goldSoft;
  context.lineWidth = 0.012;
  context.beginPath();
  context.moveTo(-0.32, -0.41);
  context.lineTo(0.28, -0.41);
  context.moveTo(0.28, -0.25);
  context.lineTo(-0.12, 0.4);
  context.stroke();
}

function drawBag(context, ink) {
  context.fillStyle = ink.shellRaised;
  context.strokeStyle = ink.gold;
  context.lineWidth = 0.026;
  context.beginPath();
  context.moveTo(-0.14, -0.2);
  context.bezierCurveTo(-0.53, 0.03, -0.47, 0.46, -0.19, 0.47);
  context.lineTo(0.19, 0.47);
  context.bezierCurveTo(0.47, 0.46, 0.53, 0.03, 0.14, -0.2);
  context.closePath();
  context.fill();
  context.stroke();
  context.fillStyle = ink.purple;
  polygon(context, [[-0.26, -0.45], [-0.06, -0.4], [0.08, -0.47], [0.25, -0.43], [0.14, -0.23], [-0.14, -0.23]]);
  context.fill();
  context.stroke();
  context.fillStyle = ink.gold;
  context.fillRect(-0.19, -0.24, 0.38, 0.065);
  context.globalAlpha *= 0.45;
  context.beginPath();
  context.moveTo(-0.17, -0.12);
  context.quadraticCurveTo(-0.36, 0.07, -0.3, 0.29);
  context.moveTo(0.17, -0.12);
  context.quadraticCurveTo(0.36, 0.07, 0.3, 0.29);
  context.stroke();
  context.globalAlpha /= 0.45;
  context.fillStyle = ink.gold;
  polygon(context, [[-0.13, -0.045], [0.13, -0.045], [0.19, 0.015], [0.19, 0.28], [0.13, 0.34], [-0.13, 0.34], [-0.19, 0.28], [-0.19, 0.015]]);
  context.fill();
  context.strokeStyle = ink.shell;
  context.lineWidth = 0.034;
  context.beginPath();
  context.moveTo(0.09, 0.045);
  context.bezierCurveTo(-0.13, -0.035, -0.14, 0.13, 0, 0.14);
  context.bezierCurveTo(0.16, 0.15, 0.12, 0.31, -0.1, 0.25);
  context.moveTo(0, -0.015);
  context.lineTo(0, 0.31);
  context.stroke();
}

function drawQuake(context, ink) {
  circle(context, 0.43);
  context.fillStyle = ink.shell;
  context.strokeStyle = ink.gold;
  context.lineWidth = 0.022;
  context.fill();
  context.stroke();
  circle(context, 0.37);
  context.strokeStyle = ink.shellRaised;
  context.lineWidth = 0.025;
  context.stroke();
  context.strokeStyle = ink.mint;
  context.lineWidth = 0.057;
  context.beginPath();
  const trace = [[-0.36, 0.04], [-0.24, 0.04], [-0.16, -0.14], [-0.06, 0.23], [0.05, -0.29], [0.14, 0.13], [0.23, -0.03], [0.36, -0.03]];
  trace.forEach(([x, y], index) => context[index ? 'lineTo' : 'moveTo'](x, y));
  context.stroke();
  context.fillStyle = ink.goldSoft;
  context.fillRect(-0.015, -0.4, 0.03, 0.045);
  context.fillRect(-0.015, 0.355, 0.03, 0.045);
}

function drawCoin(context, ink) {
  const metal = context.createLinearGradient(-0.35, -0.4, 0.35, 0.4);
  metal.addColorStop(0, ink.gold);
  metal.addColorStop(0.36, ink.goldSoft);
  metal.addColorStop(0.65, ink.gold);
  metal.addColorStop(1, '#b0802f');
  circle(context, 0.44);
  context.fillStyle = metal;
  context.strokeStyle = ink.shell;
  context.lineWidth = 0.024;
  context.fill();
  context.stroke();
  circle(context, 0.365);
  context.lineWidth = 0.014;
  context.stroke();
  context.beginPath();
  for (let index = 0; index < 24; index += 1) {
    const angle = index * TAU / 24;
    context.moveTo(Math.cos(angle) * 0.391, Math.sin(angle) * 0.391);
    context.lineTo(Math.cos(angle) * 0.418, Math.sin(angle) * 0.418);
  }
  context.stroke();
  const star = Array.from({ length: 16 }, (_, index) => {
    const radius = index % 2 ? 0.095 : index % 4 ? 0.22 : 0.31;
    const angle = index * TAU / 16 - Math.PI / 2;
    return [Math.cos(angle) * radius, Math.sin(angle) * radius];
  });
  polygon(context, star);
  context.fillStyle = ink.shellRaised;
  context.fill();
  context.strokeStyle = ink.goldSoft;
  context.lineWidth = 0.012;
  context.stroke();
  circle(context, 0.045);
  context.fillStyle = ink.goldSoft;
  context.fill();
}

function drawIdle(context, ink) {
  circle(context, 0.34);
  context.strokeStyle = ink.shellRaised;
  context.lineWidth = 0.016;
  context.stroke();
  context.strokeStyle = ink.shell;
  context.lineWidth = 0.065;
  context.beginPath();
  context.moveTo(-0.12, -0.12);
  context.bezierCurveTo(-0.13, -0.3, 0.2, -0.3, 0.14, -0.1);
  context.bezierCurveTo(0.12, -0.035, 0, -0.015, 0, 0.09);
  context.stroke();
  context.fillStyle = ink.shell;
  context.fillRect(-0.033, 0.17, 0.066, 0.065);
}

const PAINTERS = { '7': drawSeven, bag: drawBag, quake: drawQuake, gild: drawCoin, '?': drawIdle };

function drawSymbol(context, symbol, x, y, size, ink, alpha = 1) {
  context.save();
  context.translate(x, y);
  context.scale(size, size);
  context.globalAlpha *= alpha;
  context.lineJoin = 'round';
  context.lineCap = 'round';
  (PAINTERS[symbol] ?? drawIdle)(context, ink);
  context.restore();
}

function drawSunburst(context, x, y, radius, ink) {
  context.save();
  context.translate(x, y);
  context.fillStyle = ink.gold;
  context.globalAlpha = 0.16;
  for (let index = 0; index < 20; index += 1) {
    const angle = index * TAU / 20;
    polygon(context, [
      [Math.cos(angle) * radius * 0.22, Math.sin(angle) * radius * 0.22],
      [Math.cos(angle - 0.035) * radius, Math.sin(angle - 0.035) * radius],
      [Math.cos(angle + 0.035) * radius, Math.sin(angle + 0.035) * radius],
    ]);
    context.fill();
  }
  context.restore();
}

/**
 * Paint three enamel drums without allocating DOM nodes or changing inputs.
 * `time` is elapsed seconds. `spinning` is a boolean for all reels, or three
 * booleans (true = moving, false = locked). Locked art ignores time entirely.
 * Palette keys match PALETTE in config.js; omitted keys use Nocturne defaults.
 * The caller decides `win`; only pass a truthy result after the final reel locks.
 */
export function drawNocturneReels(context, { symbols, win = false, spinning = false, time = 0, palette = {} }) {
  const { width, height } = context.canvas;
  const ink = Object.fromEntries(Object.entries(DEFAULT_PALETTE).map(([key, fallback]) => [key, cssColor(palette[key] ?? fallback)]));
  const rim = height * 0.035;
  const pitch = (width - rim * 2) / 3;
  const top = height * 0.065;
  const drumHeight = height - top * 2;
  context.save();
  context.globalAlpha = 1;
  context.globalCompositeOperation = 'source-over';
  context.shadowBlur = 0;
  context.shadowColor = 'transparent';
  context.shadowOffsetX = 0;
  context.shadowOffsetY = 0;
  context.fillStyle = ink.shell;
  context.fillRect(0, 0, width, height);
  context.strokeStyle = ink.gold;
  context.lineWidth = height * 0.009;
  context.strokeRect(rim / 2, rim / 2, width - rim, height - rim);

  for (let index = 0; index < 3; index += 1) {
    const x = rim + index * pitch + height * 0.012;
    const drumWidth = pitch - height * 0.024;
    const centerX = x + drumWidth / 2;
    const centerY = height / 2;
    const size = Math.min(drumHeight * 0.82, drumWidth * 0.8);
    context.save();
    context.beginPath();
    context.rect(x, top, drumWidth, drumHeight);
    context.clip();
    const enamel = context.createLinearGradient(0, top, 0, top + drumHeight);
    for (const [stop, color] of [
      [0, '#887451'], [0.13, '#c8b68f'], [0.33, '#efdfb9'],
      [0.47, '#fff1d2'], [0.6, '#f4e7c7'], [0.83, '#c8b68f'], [1, '#887451'],
    ]) enamel.addColorStop(stop, color);
    context.fillStyle = enamel;
    context.fillRect(x, top, drumWidth, drumHeight);
    context.save();
    context.globalAlpha = 0.1;
    context.strokeStyle = ink.shellRaised;
    context.lineWidth = height * 0.002;
    for (const side of [-1, 1]) {
      for (let line = 0; line < 4; line += 1) {
        const y = centerY + side * drumHeight * (0.3 + line * 0.035);
        context.beginPath();
        context.moveTo(x + drumWidth * 0.06, y);
        context.lineTo(centerX - drumWidth * 0.12, y);
        context.lineTo(centerX, y - side * drumHeight * 0.035);
        context.lineTo(centerX + drumWidth * 0.12, y);
        context.lineTo(x + drumWidth * 0.94, y);
        context.stroke();
      }
    }
    context.restore();
    if (win) drawSunburst(context, centerX, centerY, drumHeight * 0.63, ink);

    const moving = Array.isArray(spinning) ? spinning[index] : spinning;
    if (moving) {
      const phase = ((time * (2.4 + index * 0.35) + index * 0.19) % 1 + 1) % 1;
      const offset = (phase - 0.5) * drumHeight * 0.14;
      for (const [trail, alpha] of [[-0.16, 0.06], [-0.1, 0.1], [-0.045, 0.18], [0.045, 0.07]]) {
        drawSymbol(context, symbols[index], centerX, centerY + offset + drumHeight * trail, size, ink, alpha);
      }
      drawSymbol(context, symbols[index], centerX, centerY + offset, size, ink, 0.72);
    } else drawSymbol(context, symbols[index], centerX, centerY, size, ink);
    context.restore();

    context.save();
    context.strokeStyle = win ? ink.goldSoft : ink.gold;
    context.lineWidth = height * (win ? 0.014 : 0.008);
    if (win) {
      context.shadowColor = ink.gold;
      context.shadowBlur = height * 0.055;
    }
    context.strokeRect(x, top, drumWidth, drumHeight);
    context.restore();
  }
  context.restore();
}

// The drum's ground colour, between and behind the artwork.
export const REEL_GROUND = '#14202f';

/**
 * An image with the box round its visible (non-transparent) pixels, for drawReelStrip.
 * Browser only: it reads the pixels back through a canvas.
 */
export function trimmedArt(image) {
  const canvas = Object.assign(document.createElement('canvas'), { width: image.width, height: image.height });
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, image.width, image.height);
  return { image, ...alphaBox(data, image.width, image.height) };
}

/** The box round the pixels of RGBA `data` whose alpha is above `floor`; the whole image if none. */
export function alphaBox(data, width, height, floor = 8) {
  let [minX, minY, maxX, maxY] = [width, height, -1, -1];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] <= floor) continue;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w: width, h: height };
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// The reel artwork files, by face. Square PNGs with transparent ground (public/textures/reels).
export const REEL_IMAGE_FILES = Object.freeze({
  '7': 'textures/reels/7.png', bag: 'textures/reels/bag.png', quake: 'textures/reels/quake.png',
  gild: 'textures/reels/gild.png', '?': 'textures/reels/idle.png',
});

/**
 * The texture wrapped round one 3D reel drum: `faces` in order, one cell each, laid along the
 * canvas's x - which a cylinder maps round its circumference. Each cell is drawn turned a quarter
 * turn by `turn` (radians), because the drum lies on its side: the texture's x runs round it and
 * its y runs along the axis. Ivory enamel with fine engraved bands; the drum's own curvature and
 * lighting supply the shading, so none is painted in.
 */
export function drawReelStrip(context, faces, { palette = {}, turn = Math.PI / 2, images = {} } = {}) {
  const { width, height } = context.canvas;
  const ink = Object.fromEntries(Object.entries(DEFAULT_PALETTE).map(([key, fallback]) => [key, cssColor(palette[key] ?? fallback)]));
  const cell = width / faces.length;
  context.save();
  context.fillStyle = REEL_GROUND;
  context.fillRect(0, 0, width, height);
  faces.forEach((face, index) => {
    context.save();
    context.translate(cell * (index + 0.5), height / 2);
    context.rotate(turn);
    // In the turned frame: x runs along the drum's axis (height px), y round it (cell px).
    const along = height;
    const round = cell;
    // A flat ground and a hairline between cells: the drum's real curvature does the shading and
    // the artwork carries the ornament, so nothing here competes with either.
    context.fillStyle = ink.gold;
    context.globalAlpha = 0.5;
    context.fillRect(-along / 2, round / 2 - round * 0.003, along, round * 0.006);
    context.globalAlpha = 1;
    // An artwork image for the face if one has loaded (public/textures/reels), else the drawn mark.
    const art = images[face];
    if (!art) drawSymbol(context, face, 0, 0, Math.min(along, round) * 0.72, ink);
    else {
      // A soft pool of light behind the face lifts dark artwork (the navy bag) off the navy ground.
      const pool = context.createRadialGradient(0, 0, 0, 0, 0, Math.min(along, round) * 0.5);
      pool.addColorStop(0, '#34486a');
      pool.addColorStop(1, REEL_GROUND);
      context.fillStyle = pool;
      context.fillRect(-along / 2, -round / 2, along, round);
      // Fit the visible artwork, not the PNG's transparent margin, so every face reads the same size.
      const { image, x, y, w, h } = art;
      const scale = Math.min((along * 0.78) / w, (round * 0.82) / h);
      context.drawImage(image, x, y, w, h, (-w * scale) / 2, (-h * scale) / 2, w * scale, h * scale);
    }
    context.restore();
  });
  context.restore();
}
