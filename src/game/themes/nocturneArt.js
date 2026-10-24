const cssColor = (value) => `#${value.toString(16).padStart(6, '0')}`;
const TAU = Math.PI * 2;

function addGrain(context, size) {
  if (!context.getImageData || !context.putImageData) return;
  let pixels;
  try {
    pixels = context.getImageData(0, 0, size, size);
  } catch {
    // Some canvas implementations disable pixel readback.
    return;
  }
  let seed = 0x4e4f4354;
  for (let index = 0; index < pixels.data.length; index += 4) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const grain = (seed >>> 0) % 5 - 2;
    for (let channel = 0; channel < 3; channel += 1) pixels.data[index + channel] += grain;
  }
  context.putImageData(pixels, 0, 0);
}

function steppedFrame(context, size, inset, step) {
  const near = size * inset;
  const far = size - near;
  const points = [
    [near + step, near], [far - step, near],
    [far - step, near + step], [far, near + step],
    [far, far - step], [far - step, far - step],
    [far - step, far], [near + step, far],
    [near + step, far - step], [near, far - step],
    [near, near + step], [near + step, near + step],
  ];
  context.beginPath();
  points.forEach(([x, y], index) => context[index ? 'lineTo' : 'moveTo'](x, y));
  context.closePath();
  context.stroke();
}

function clipClearances(context, size, layout) {
  const { pxPerUnit, pins, pinRadius } = layout;
  for (const pin of pins) {
    // Separate clips prevent overlapping clearance holes from cancelling out.
    context.beginPath();
    context.rect(0, 0, size, size);
    const { u, v } = layout.toCanvas(pin.x, pin.y);
    const rx = 2 * pinRadius * pxPerUnit.x;
    const ry = 2 * pinRadius * pxPerUnit.y;
    context.moveTo(u + rx, v);
    context.ellipse(u, v, rx, ry, 0, 0, TAU);
    context.clip('evenodd');
  }
}

function drawRings(context, layout, scale) {
  context.globalAlpha = 0.55;
  context.lineWidth = scale;
  for (const bumper of layout.bumpers) {
    const { u, v } = layout.toCanvas(bumper.x, bumper.y);
    for (const factor of [1.35, 1.65]) {
      context.beginPath();
      context.ellipse(u, v, bumper.radius * factor * layout.pxPerUnit.x, bumper.radius * factor * layout.pxPerUnit.y, 0, 0, TAU);
      context.stroke();
    }
    context.beginPath();
    for (let index = 0; index < 12; index += 1) {
      const angle = TAU * index / 12;
      for (const [step, factor] of [1.72, 1.84].entries()) {
        const point = layout.toCanvas(bumper.x + Math.cos(angle) * bumper.radius * factor, bumper.y + Math.sin(angle) * bumper.radius * factor);
        context[step ? 'lineTo' : 'moveTo'](point.u, point.v);
      }
    }
    context.stroke();
  }
}

function drawCorners(context, size, scale, mintOnly) {
  context.globalAlpha = mintOnly ? 0.8 : 0.65;
  context.lineWidth = (mintOnly ? 2 : 1) * scale;
  for (const [horizontal, vertical] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const point = (x, y) => [horizontal === 1 ? x : size - x, vertical === 1 ? y : size - y];
    const count = mintOnly ? 1 : 3;
    for (let index = 0; index < count; index += 1) {
      const inset = (mintOnly ? 45 : 51 + index * 8) * scale;
      const length = (mintOnly ? 17 : 48 - index * 9) * scale;
      const step = (mintOnly ? 4 : 6) * scale;
      context.beginPath();
      context.moveTo(...point(inset, inset + length));
      context.lineTo(...point(inset, inset + step));
      context.lineTo(...point(inset + step, inset + step));
      context.lineTo(...point(inset + step, inset));
      context.lineTo(...point(inset + length, inset));
      context.stroke();
    }
  }
}

function drawTitle(context, size, layout, scale) {
  const title = 'NOCTURNE';
  const tracking = 9 * scale;
  context.save();
  const mouth = layout.toCanvas(layout.mouth.x, layout.mouth.y);
  context.translate(size / 2, Math.max(size * 0.085, mouth.v + size * 0.045));
  // Undo the panel's nonuniform texture stretch for the glyphs as well.
  context.scale(layout.pxPerUnit.x / layout.pxPerUnit.y, 1);
  context.font = `500 ${24 * scale}px Georgia, serif`;
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.globalAlpha = 0.9;
  const widths = Array.from(title, (character) => context.measureText(character).width);
  let x = -(widths.reduce((sum, width) => sum + width, 0) + tracking * (title.length - 1)) / 2;
  Array.from(title).forEach((character, index) => {
    context.fillStyle = '#081020';
    context.fillText(character, x + scale, 2 * scale);
    context.fillStyle = cssColor(layout.palette.gold);
    context.fillText(character, x, 0);
    x += widths[index] + tracking;
  });
  context.restore();
}

const rgba = (color, alpha) => `rgba(${(color >> 16) & 255}, ${(color >> 8) & 255}, ${color & 255}, ${alpha})`;

function drawNebula(context, size, palette, emissive = false) {
  const glow = context.createRadialGradient(size * 0.48, size * 0.46, 0, size * 0.5, size * 0.5, size * 0.52);
  glow.addColorStop(0, rgba(palette.mint, emissive ? 0.12 : 0.25));
  glow.addColorStop(0.24, rgba(palette.mint, emissive ? 0.04 : 0.12));
  glow.addColorStop(0.58, rgba(emissive ? palette.mint : palette.purple, emissive ? 0 : 0.22));
  glow.addColorStop(1, rgba(emissive ? palette.mint : palette.purple, 0));
  context.globalAlpha = 1;
  context.fillStyle = glow;
  context.fillRect(0, 0, size, size);
}

function compassStar(context, x, y, radius) {
  context.beginPath();
  for (let index = 0; index < 16; index += 1) {
    const angle = index * TAU / 16 - Math.PI / 2;
    const reach = index % 2 ? radius * 0.2 : index % 4 ? radius * 0.62 : radius;
    context[index ? 'lineTo' : 'moveTo'](x + Math.cos(angle) * reach, y + Math.sin(angle) * reach);
  }
  context.closePath();
}

function drawOrbits(context, size, scale) {
  context.globalAlpha = 0.2;
  context.lineWidth = scale;
  for (let index = 0; index < 5; index += 1) {
    context.setLineDash(index % 2 ? [7 * scale, 9 * scale] : []);
    context.beginPath();
    context.ellipse(size / 2, size * 0.51, size * (0.25 + index * 0.055), size * (0.17 + index * 0.045), -0.55 + index * 0.26, 0, TAU);
    context.stroke();
  }
  context.setLineDash([]);
}

function drawStars(context, size, palette, emissive = false) {
  let seed = 0x4e4f4354;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  context.fillStyle = cssColor(emissive ? palette.mint : palette.goldSoft);
  context.strokeStyle = context.fillStyle;
  for (let index = 0; index < 100; index += 1) {
    const x = size * (0.09 + random() * 0.82);
    const y = size * (0.2 + random() * 0.68);
    const radius = size / 1024 * (0.8 + random() * 1.5);
    const bright = index % 17 === 0;
    const alpha = bright ? 0.7 : 0.25 + random() * 0.25;
    if (emissive && !bright) continue;
    context.globalAlpha = alpha;
    context.beginPath();
    context.arc(x, y, radius, 0, TAU);
    context.fill();
    if (!bright) continue;
    context.lineWidth = size / 1024;
    context.beginPath();
    context.moveTo(x - radius * 3, y);
    context.lineTo(x + radius * 3, y);
    context.moveTo(x, y - radius * 3);
    context.lineTo(x, y + radius * 3);
    context.stroke();
  }
}

function drawConstellations(context, size, scale) {
  const constellations = [
    [[0.15, 0.3], [0.23, 0.34], [0.19, 0.44], [0.3, 0.48]],
    [[0.64, 0.32], [0.73, 0.38], [0.81, 0.3], [0.78, 0.5]],
    [[0.31, 0.53], [0.42, 0.59], [0.52, 0.5], [0.59, 0.6]],
    [[0.13, 0.66], [0.22, 0.72], [0.18, 0.82], [0.28, 0.86]],
  ];
  context.lineWidth = scale;
  for (const points of constellations) {
    context.globalAlpha = 0.22;
    context.beginPath();
    points.forEach(([x, y], index) => context[index ? 'lineTo' : 'moveTo'](x * size, y * size));
    context.stroke();
    context.globalAlpha = 0.65;
    for (const [x, y] of points) {
      context.beginPath();
      context.arc(x * size, y * size, 2 * scale, 0, TAU);
      context.fill();
    }
  }
}

function drawArmillary(context, layout, size, scale) {
  const lower = layout.bumpers.reduce((lowest, bumper) => !lowest || bumper.y < lowest.y ? bumper : lowest, null);
  if (!lower) return;
  const { u, v } = layout.toCanvas(lower.x, lower.y);
  context.save();
  context.translate(u, v);
  context.scale(layout.pxPerUnit.x / layout.pxPerUnit.y, 1);
  context.globalAlpha = 0.16;
  context.lineWidth = scale;
  const radius = size * 0.18;
  for (const factor of [0.68, 0.9, 1]) {
    context.beginPath();
    context.arc(0, 0, radius * factor, 0, TAU);
    context.stroke();
  }
  for (const angle of [-0.6, 0.6]) {
    context.beginPath();
    context.ellipse(0, 0, radius, radius * 0.35, angle, 0, TAU);
    context.stroke();
  }
  compassStar(context, 0, 0, radius * 1.12);
  context.fill();
  context.stroke();
  context.restore();
}

function drawMoonBand(context, size, layout, scale) {
  const mouth = layout.toCanvas(layout.mouth.x, layout.mouth.y);
  // Level with the title and flanking it - one band lower they sat on the first row of pins. The
  // full moon in the middle of the cycle is where the title is, so it is left out.
  const y = Math.max(size * 0.085, mouth.v + size * 0.045);
  const radius = 5 * scale;
  context.globalAlpha = 0.5;
  context.lineWidth = scale;
  const across = [0.16, 0.21, 0.26, null, 0.74, 0.79, 0.84];
  for (let index = 0; index < 7; index += 1) {
    if (across[index] === null) continue;
    const x = size * across[index];
    context.beginPath();
    context.arc(x, y, radius, 0, TAU);
    context.stroke();
    if (index === 0 || index === 6) continue;
    context.beginPath();
    if (index === 3) {
      context.arc(x, y, radius, 0, TAU);
    } else {
      const waning = index > 3;
      context.arc(x, y, radius, -Math.PI / 2, Math.PI / 2, waning);
      context.ellipse(x, y, radius * 0.5, radius, 0, Math.PI / 2, -Math.PI / 2, index === 1 || index === 4);
    }
    context.fill();
  }
}

function drawHaloRings(context, layout, scale, emissive = false) {
  context.strokeStyle = cssColor(layout.palette.mint);
  context.globalAlpha = emissive ? 0.28 : 0.45;
  context.lineWidth = 2 * scale;
  for (const bumper of layout.bumpers) {
    const { u, v } = layout.toCanvas(bumper.x, bumper.y);
    context.beginPath();
    context.ellipse(u, v, bumper.radius * 1.18 * layout.pxPerUnit.x, bumper.radius * 1.18 * layout.pxPerUnit.y, 0, 0, TAU);
    context.stroke();
  }
}

function drawFans(context, size, scale) {
  context.globalAlpha = 0.55;
  context.lineWidth = scale;
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const point = (x, y) => [sx === 1 ? x : size - x, sy === 1 ? y : size - y];
    context.beginPath();
    for (let index = 0; index <= 6; index += 1) {
      const angle = Math.PI / 2 * index / 6;
      context.moveTo(...point(66 * scale, 66 * scale));
      context.lineTo(...point((66 + 35 * Math.cos(angle)) * scale, (66 + 35 * Math.sin(angle)) * scale));
    }
    context.stroke();
  }
}

/**
 * Paint the observatory enamel plate and a separate mint-only emissive texture.
 * Layout is read-only, in world units; both square contexts retain their drawing state.
 */
export function drawNocturne(map, emissive, layout) {
  const size = map.canvas.width;
  const scale = size / 1024;
  const gold = cssColor(layout.palette.gold);
  const mint = cssColor(layout.palette.mint);
  map.save();
  emissive.save();
  for (const context of [map, emissive]) {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
  }
  const enamel = map.createLinearGradient(0, 0, 0, size);
  enamel.addColorStop(0, '#142235');
  enamel.addColorStop(0.45, '#0e1624');
  enamel.addColorStop(1, '#081020');
  map.fillStyle = enamel;
  map.fillRect(0, 0, size, size);
  drawNebula(map, size, layout.palette);
  const vignette = map.createRadialGradient(size / 2, size / 2, size * 0.2, size / 2, size / 2, size * 0.7);
  vignette.addColorStop(0, 'rgba(8, 16, 32, 0)');
  vignette.addColorStop(1, 'rgba(8, 16, 32, 0.8)');
  map.fillStyle = vignette;
  map.fillRect(0, 0, size, size);
  addGrain(map, size);

  map.save();
  clipClearances(map, size, layout);
  map.strokeStyle = gold;
  map.fillStyle = gold;
  drawOrbits(map, size, scale);
  drawArmillary(map, layout, size, scale);
  drawConstellations(map, size, scale);
  drawStars(map, size, layout.palette);
  map.strokeStyle = gold;
  map.fillStyle = gold;
  drawRings(map, layout, scale);
  drawHaloRings(map, layout, scale);
  map.restore();

  map.strokeStyle = gold;
  map.fillStyle = gold;
  map.globalAlpha = 0.75;
  map.lineWidth = 2 * scale;
  steppedFrame(map, size, 0.025, 10 * scale);
  map.globalAlpha = 0.65;
  map.lineWidth = scale;
  steppedFrame(map, size, 0.035, 8 * scale);
  drawCorners(map, size, scale, false);
  drawFans(map, size, scale);
  drawTitle(map, size, layout, scale);
  drawMoonBand(map, size, layout, scale);
  map.strokeStyle = mint;
  drawCorners(map, size, scale, true);

  emissive.fillStyle = '#000000';
  emissive.fillRect(0, 0, size, size);
  emissive.strokeStyle = mint;
  drawCorners(emissive, size, scale, true);
  emissive.save();
  clipClearances(emissive, size, layout);
  drawNebula(emissive, size, layout.palette, true);
  drawHaloRings(emissive, layout, scale, true);
  drawStars(emissive, size, layout.palette, true);
  emissive.restore();
  emissive.restore();
  map.restore();
}

/** Paint a face-on purple glass compass cap, leaving the disc's corners transparent. */
export function drawBumperCap(context, size, palette) {
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalCompositeOperation = 'source-over';
  context.globalAlpha = 1;
  context.clearRect(0, 0, size, size);
  const center = size / 2;
  const radius = size * 0.48;
  context.beginPath();
  context.arc(center, center, radius, 0, TAU);
  context.clip();
  const glass = context.createRadialGradient(size * 0.34, size * 0.28, size * 0.02, center, center, radius);
  glass.addColorStop(0, cssColor(palette.goldSoft));
  glass.addColorStop(0.14, cssColor(palette.purple));
  glass.addColorStop(0.65, cssColor(palette.purple));
  glass.addColorStop(1, '#081020');
  context.fillStyle = glass;
  context.fillRect(0, 0, size, size);
  context.globalAlpha = 0.85;
  context.fillStyle = cssColor(palette.gold);
  compassStar(context, center, center, radius * 0.69);
  context.fill();
  context.lineWidth = size * 0.012;
  context.strokeStyle = cssColor(palette.gold);
  context.beginPath();
  context.arc(center, center, radius * 0.97, 0, TAU);
  context.stroke();
  context.globalAlpha = 0.7;
  context.lineWidth = size * 0.008;
  context.strokeStyle = cssColor(palette.mint);
  context.beginPath();
  context.arc(center, center, radius * 0.85, 0, TAU);
  context.stroke();
  context.restore();
}
