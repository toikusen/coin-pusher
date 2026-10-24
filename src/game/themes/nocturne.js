// "Nocturne Observatory": the pin board as an Art Deco astronomical instrument - engraved navy
// enamel, machined gold, purple glass, restrained mint light. A board theme builds only what is
// drawn; the pins and bumpers sit exactly where PIN_BOARD (and pachinko.js's calibration) puts them.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { drawBumperCap, drawNocturne } from './nocturneArt.js';

const PIN_DEPTH = 0.75;
// Lathe profile, (depth fraction, radius / pinRadius): a mounting foot, the full-width shaft, a
// recessed neck and a bevelled head.
// The head is wider than the pin the coins bounce off on purpose: it stands in front of the coins'
// plane, so a coin passes behind it the way it does under a real pachinko nail.
const PIN_PROFILE = [[0, 0.8], [0.06, 1], [0.78, 1], [0.82, 0.75], [0.88, 1.2], [0.96, 1.2], [1, 1.05]];
// Where the coins' plane crosses a pin, as a fraction of its depth (coins ride 0.4 off the plate).
export const PIN_COIN_PLANE = 0.4 / PIN_DEPTH;
const BULBS_PER_SHOULDER = 6;
const BULB_CHASE_SECONDS = 0.45;

// +Y (a lathe's axis) turned to point out of the panel, towards the player at -Z.
const OUT_OF_PANEL = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

function lathe(points, segments) {
  return new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), segments);
}

/** The pin's turned profile, `radius` at its widest, PIN_DEPTH long along +Y. */
export function pinProfile(radius) {
  return [[0, 0], ...PIN_PROFILE.map(([depth, r]) => [r * radius, depth * PIN_DEPTH]), [0, PIN_DEPTH]];
}

/**
 * Pop bumper, built along +Y from the panel: gold skirt, fluted navy body, bevelled purple cap and
 * a mint ring by the cap. Dimensions are the spec's, in multiples of the bumper's radius.
 */
function bumperParts(r) {
  const skirt = lathe([[0, 0], [r, 0], [r, 0.18 * r], [0.9 * r, 0.18 * r], [0, 0.18 * r]], 32);
  // Twelve flutes: every other ring of vertices pulled in a touch.
  // 0.97r rather than the spec's 0.9r: coins bounce off r, and a slimmer body left them visibly
  // turning short of it.
  const body = new THREE.CylinderGeometry(0.97 * r, 0.97 * r, 2.17 * r, 48, 1, true);
  const position = body.attributes.position;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const z = position.getZ(i);
    const angle = Math.atan2(z, x);
    const flute = 1 - 0.06 * Math.max(0, Math.cos(angle * 12));
    position.setX(i, x * flute);
    position.setZ(i, z * flute);
  }
  body.computeVertexNormals();
  body.translate(0, 0.18 * r + 2.17 * r / 2, 0);
  const cap = lathe([[0, 0], [0.95 * r, 0], [0.95 * r, 0.12 * r], [0.84 * r, 0.26 * r], [0.52 * r, 0.33 * r], [0, 0.33 * r]], 40);
  cap.translate(0, 2.35 * r, 0);
  const ring = new THREE.TorusGeometry(0.97 * r, 0.06 * r, 10, 48);
  ring.rotateX(Math.PI / 2);
  ring.translate(0, 2.35 * r, 0);
  return { skirt, body, cap, ring };
}

/** How the chase lights a bulb at `index` of `count` per shoulder, time in seconds: 0.25 to 0.7. */
export function bulbLevel(index, time) {
  const lit = Math.floor(time / BULB_CHASE_SECONDS) % BULBS_PER_SHOULDER;
  return index === lit ? 0.7 : 0.25;
}

export const nocturne = {
  id: 'nocturne-observatory',
  name: 'Nocturne Observatory',

  /**
   * Builds the board into `ctx.board` (the reclining rig's inner group, world coordinates) and
   * returns the handles the game animates: pins, bumpers, the carriage and a per-frame animate.
   */
  build(ctx) {
    const { board, palette, metal, glowTexture, quality, bounds, layout, bumpers: bumperLayout, mouth } = ctx;
    const { left, right, bottom, top, backZ, coinZ } = bounds;
    const width = right - left;
    const height = top - bottom;
    const animated = [];

    // --- materials ---------------------------------------------------------------------------
    const gold = metal({ color: palette.gold, metalness: 0.85, roughness: 0.32, emissive: palette.gold, emissiveIntensity: 0.04 });
    const goldPin = metal({ color: 0xc9a451, metalness: 0.8, roughness: 0.4 });
    const lacquer = metal({ color: palette.shell, metalness: 0.45, roughness: 0.38 });
    const channel = new THREE.MeshStandardMaterial({ color: palette.shellDeep, metalness: 0.2, roughness: 0.8 });
    const tube = new THREE.MeshStandardMaterial({ color: palette.mint, emissive: palette.mint, emissiveIntensity: 0.45 });
    const enamel = new THREE.MeshPhysicalMaterial({
      color: palette.purple, metalness: 0.1, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.12,
      emissive: palette.purple, emissiveIntensity: 0.08,
    });
    const navyBody = metal({ color: palette.shellRaised, metalness: 0.6, roughness: 0.34 });

    // --- backboard: the engraved enamel plate -------------------------------------------------
    const size = quality.lowPower ? 512 : 1024;
    const canvas = (s) => Object.assign(document.createElement('canvas'), { width: s, height: s });
    const mapCanvas = canvas(size);
    const glowCanvas = canvas(size);
    const pxPerUnit = { x: size / width, y: size / height };
    drawNocturne(mapCanvas.getContext('2d'), glowCanvas.getContext('2d'), {
      width,
      height,
      pxPerUnit,
      // The plate faces the player at -Z, whose right is world -X: canvas u runs from +X to -X.
      toCanvas: (x, y) => ({ u: ((right - x) / width) * size, v: ((top - y) / height) * size }),
      pins: layout,
      pinRadius: ctx.pinRadius,
      bumpers: bumperLayout,
      mouth,
      palette,
    });
    const texture = (c, srgb) => {
      const t = new THREE.CanvasTexture(c);
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      return t;
    };
    const plateMaterial = new THREE.MeshStandardMaterial({
      map: texture(mapCanvas, true),
      emissiveMap: texture(glowCanvas, true),
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.9,
      metalness: 0.35,
      roughness: 0.55,
    });
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(width, height), plateMaterial);
    plate.rotation.y = Math.PI;
    plate.position.set((left + right) / 2, (top + bottom) / 2, backZ);
    plate.receiveShadow = quality.shadows;
    board.add(plate);
    const back = new THREE.Mesh(new THREE.BoxGeometry(width, height, 0.06), channel);
    back.position.set((left + right) / 2, (top + bottom) / 2, backZ + 0.035);
    board.add(back);

    // --- frame: a lacquered instrument case ---------------------------------------------------
    // The board is only ever seen face-on, so the case's craft has to read from the front: a broad
    // bezel of distinct parallel bands, brass fittings standing proud of it, and a stepped crown.
    // `r` runs outward from the plate's edge, `f` towards the player (z = backZ - f).
    const box = (material, w, h, d, x, y, z, rounded = 0) => {
      const geometry = rounded ? new RoundedBoxGeometry(w, h, d, 2, rounded) : new THREE.BoxGeometry(w, h, d);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      board.add(mesh);
      return mesh;
    };
    // A box spanning x0..x1, y0..y1 and f0..f1 out of the plate.
    const slab = (material, x0, x1, y0, y1, f0, f1, rounded = 0) => box(
      material, Math.abs(x1 - x0), y1 - y0, f1 - f0,
      (x0 + x1) / 2, (y0 + y1) / 2, backZ - (f0 + f1) / 2, rounded,
    );
    const cx = (left + right) / 2;
    const insert = new THREE.MeshStandardMaterial({ color: palette.mint, emissive: palette.mint, emissiveIntensity: 0.35 });
    // Navy under a clear lacquer, so the band reads as enamel by its highlight, not by colour.
    const navyEnamel = new THREE.MeshPhysicalMaterial({
      color: palette.shellRaised, metalness: 0.3, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.08,
    });
    const third = height / 3;
    const fittingRuns = [bottom + 0.36, bottom + third - 0.05, bottom + third + 0.05, bottom + 2 * third - 0.05,
      bottom + 2 * third + 0.05, top - 0.36];
    for (const side of [-1, 1]) {
      const edge = side < 0 ? left : right;
      const at = (r) => edge + side * r;
      slab(lacquer, at(0), at(0.34), bottom, top, 0, 0.32, 0.02); // backing
      slab(goldPin, at(0), at(0.045), bottom, top, 0.32, 0.4, 0.01); // inner bead
      slab(channel, at(0.07), at(0.16), bottom, top, 0.32, 0.33); // recessed channel
      slab(navyEnamel, at(0.18), at(0.29), bottom, top, 0.32, 0.37, 0.01); // raised enamel band
      slab(goldPin, at(0.3), at(0.34), bottom, top, 0.32, 0.36, 0.01); // outer lip
      // The channel's mint insert, broken at every fitting so it reads as lamps in a case.
      for (let run = 0; run < fittingRuns.length; run += 2) {
        slab(insert, at(0.104), at(0.126), fittingRuns[run], fittingRuns[run + 1], 0.33, 0.34);
      }
      // Brass collars at the thirds.
      for (const y of [bottom + third, bottom + 2 * third]) {
        slab(goldPin, at(-0.01), at(0.35), y - 0.045, y + 0.045, 0.32, 0.45, 0.012);
      }
      // Corner plates: a navy inset on brass with three brass rays fanning inward.
      for (const [y, down] of [[top - 0.2, 1], [bottom + 0.2, -1]]) {
        slab(gold, at(0), at(0.34), y - 0.18, y + 0.18, 0.395, 0.43, 0.01);
        slab(lacquer, at(0.05), at(0.29), y - 0.125, y + 0.125, 0.43, 0.44, 0.005);
        [-30, 0, 30].forEach((degrees, ray) => {
          const length = ray === 1 ? 0.16 : 0.1;
          const mesh = box(gold, 0.018, length, 0.01, at(0.17), y, backZ - 0.445);
          mesh.rotation.z = THREE.MathUtils.degToRad(degrees) * side * down;
        });
      }
    }
    // Stepped crown under the slot: three courses, navy with brass lower lips, each narrower and
    // further forward - and each parted in the middle, where the carriage passes through it.
    // Wide enough to frame the coin hopper's hood (half-width 0.64 plus its rim) whole.
    const gap = 0.7;
    [[width + 0.68, 0.14, top - 0.07, 0.28], [width + 0.48, 0.1, top - 0.19, 0.36], [width + 0.28, 0.08, top - 0.28, 0.42]]
      .forEach(([w, h, y, f]) => {
        for (const sign of [-1, 1]) {
          const x0 = cx + sign * gap;
          const x1 = cx + sign * w / 2;
          slab(lacquer, x0, x1, y - h / 2, y + h / 2, 0, f, 0.012);
          slab(gold, x0, x1, y - h / 2, y - h / 2 + 0.025, f - 0.02, f + 0.005, 0.006);
        }
      });

    // Marquee bulbs on the crown's shoulders, chasing in mirrored pairs.
    const bulbMaterial = new THREE.MeshStandardMaterial({ color: palette.goldSoft, emissive: palette.goldSoft, emissiveIntensity: 0.25 });
    const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.04, 14, 10), bulbMaterial, BULBS_PER_SHOULDER * 2);
    const sockets = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.065, 0.065, 0.03, 20).rotateX(Math.PI / 2), gold, BULBS_PER_SHOULDER * 2);
    bulbs.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(BULBS_PER_SHOULDER * 2 * 3), 3);
    const bulbPose = new THREE.Matrix4();
    for (let i = 0; i < BULBS_PER_SHOULDER; i += 1) {
      // Index 0 is the outermost, so the chase runs inward from both ends.
      const offset = 0.7 + 0.5 * (BULBS_PER_SHOULDER - 1 - i);
      for (const [slot, sign] of [[i, 1], [i + BULBS_PER_SHOULDER, -1]]) {
        bulbPose.makeTranslation(cx + sign * offset, top - 0.19, backZ - 0.47);
        bulbs.setMatrixAt(slot, bulbPose);
        bulbPose.makeTranslation(cx + sign * offset, top - 0.19, backZ - 0.44);
        sockets.setMatrixAt(slot, bulbPose);
      }
    }
    board.add(bulbs, sockets);
    const bulbColour = new THREE.Color();
    const setBulbs = (time) => {
      for (let i = 0; i < BULBS_PER_SHOULDER; i += 1) {
        // A bulb's colour scales the material's emissive, so this is its brightness.
        bulbColour.setScalar(bulbLevel(i, time) / 0.25);
        bulbs.setColorAt(i, bulbColour);
        bulbs.setColorAt(i + BULBS_PER_SHOULDER, bulbColour);
      }
      bulbs.instanceColor.needsUpdate = true;
    };
    setBulbs(0);
    if (!quality.reducedMotion && !quality.lowPower) animated.push(({ time }) => setBulbs(time));

    // --- pins ----------------------------------------------------------------------------------
    const pins = new THREE.InstancedMesh(lathe(pinProfile(ctx.pinRadius), 24), goldPin, layout.length);
    const pose = new THREE.Matrix4();
    layout.forEach(({ x, y }, index) => {
      pose.compose(new THREE.Vector3(x, y, backZ), OUT_OF_PANEL, new THREE.Vector3(1, 1, 1));
      pins.setMatrixAt(index, pose);
      pins.setColorAt(index, new THREE.Color(1, 1, 1));
    });
    // No shadows: the key light strikes the face-on board from the side, and every pin threw a long
    // black streak across the plate.
    board.add(pins);

    // --- bumpers -------------------------------------------------------------------------------
    const skirtMaterial = gold;
    // The board is always seen face-on, so a bumper is its cap: the face carries a compass star on
    // purple glass (drawBumperCap), on a disc just proud of the domed cap. One texture for all.
    const capCanvas = canvas(quality.lowPower ? 128 : 256);
    drawBumperCap(capCanvas.getContext('2d'), capCanvas.width, palette);
    const capFace = new THREE.MeshStandardMaterial({
      map: texture(capCanvas, true), transparent: true, metalness: 0.2, roughness: 0.25,
      emissive: new THREE.Color(palette.purple), emissiveIntensity: 0.15,
    });
    const bumpers = bumperLayout.map(({ x, y, radius }, index) => {
      const parts = bumperParts(radius);
      const group = new THREE.Group();
      const ringMaterial = new THREE.MeshStandardMaterial({ color: palette.mint, emissive: palette.mint, emissiveIntensity: 0.45 });
      const cap = new THREE.Mesh(parts.cap, enamel);
      const face = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.95, 40), capFace);
      // Circle faces +Z; the bumper's axis is +Y before it is turned out of the panel.
      face.rotation.x = -Math.PI / 2;
      face.position.y = 2.35 * radius + 0.34 * radius;
      cap.add(face);
      group.add(
        new THREE.Mesh(parts.skirt, skirtMaterial),
        new THREE.Mesh(parts.body, navyBody),
        cap,
        new THREE.Mesh(parts.ring, ringMaterial),
      );
      group.quaternion.copy(OUT_OF_PANEL);
      group.position.set(x, y, backZ);
      board.add(group);
      // A soft card of light on the plate behind it.
      if (!quality.lowPower && glowTexture) {
        const card = new THREE.Mesh(
          new THREE.PlaneGeometry(radius * 5, radius * 5),
          new THREE.MeshBasicMaterial({
            map: glowTexture, color: palette.mint, transparent: true, opacity: 0.22,
            blending: THREE.AdditiveBlending, depthWrite: false,
          }),
        );
        card.rotation.y = Math.PI;
        card.position.set(x, y, backZ - 0.01);
        board.add(card);
      }
      return { group, ring: ringMaterial, cap, glow: 0, phase: index * 2.1 };
    });
    // Six-second breathing; a hit rides on top (see hit()).
    animated.push(({ time }) => {
      for (const bumper of bumpers) {
        const breath = 0.45 + 0.05 * Math.sin((time / 6) * Math.PI * 2 + bumper.phase);
        bumper.ring.emissiveIntensity = breath + bumper.glow * 3;
        bumper.group.scale.setScalar(1 + bumper.glow * 0.12);
        // The cap is pressed in on a hit and springs back.
        bumper.cap.position.y = -0.1 * bumper.group.userData.radius * bumper.glow;
      }
    });
    bumpers.forEach((bumper, index) => { bumper.group.userData.radius = bumperLayout[index].radius; });

    // --- carriage: a brass coin hopper at the head of the board ------------------------------
    // Seen face-on: a stepped Art Deco hood in navy enamel and brass and a compass medallion, with
    // the mouth's shuttle running beneath it. Coins fall in the plane z = 0 here, the hood stands
    // behind it.
    // Local y 0 is DROPPER_Y; the mouth is at mouth.y, the slot machine sits on top at +0.45.
    const carriage = new THREE.Group();
    const throat = mouth.halfWidth + 0.04;
    // The hood stops level with the crown's lowest course (top - 0.32), so its brass rim continues
    // the crown's line. It used to hang down to a fixed centre mouth and dip the frame there.
    const hoodBottom = top - 0.32 - ctx.carriageY;
    const hood = new THREE.Shape();
    hood.moveTo(-0.64, hoodBottom);
    hood.lineTo(0.64, hoodBottom);
    hood.lineTo(0.64, 0.24);
    hood.lineTo(0.54, 0.24);
    hood.lineTo(0.54, 0.31);
    hood.lineTo(0.42, 0.31);
    hood.absarc(0, 0.31, 0.42, 0, Math.PI, false);
    hood.lineTo(-0.54, 0.31);
    hood.lineTo(-0.54, 0.24);
    hood.lineTo(-0.64, 0.24);
    hood.closePath();
    const extruded = (shape, depth, bevel) => new THREE.ExtrudeGeometry(shape, {
      depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 24,
    });
    // Gold backing a touch larger than the enamel, so a brass rim shows all round it.
    const rim = new THREE.Mesh(extruded(hood, 0.04, 0.03), gold);
    rim.scale.set(1.04, 1.04, 1);
    rim.position.set(0, -0.012, 0.3);
    const hoodPlate = new THREE.Mesh(extruded(hood, 0.05, 0.012), navyEnamel);
    hoodPlate.position.z = 0.22;
    carriage.add(rim, hoodPlate);
    // The cap is clipped off the top of the arch by the slot machine standing on it; fine - the
    // arch reads as the slot's plinth.
    const medallionY = hoodBottom + 0.16;
    const medallion = new THREE.Mesh(new THREE.CircleGeometry(0.15, 40), capFace);
    medallion.rotation.y = Math.PI;
    medallion.position.set(0, medallionY, 0.205);
    const bezel = new THREE.Mesh(new THREE.TorusGeometry(0.155, 0.018, 8, 40), goldPin);
    bezel.position.set(0, medallionY, 0.2);
    carriage.add(medallion, bezel);
    // The mouth is a shuttle: an open-fronted brass cell the game slides along the beam
    // (shuttle.position.x is board x). The next coin stands in it, so a drop is that coin leaving:
    // the floor plates pull apart sideways - a hinge swinging down would clip the pins 0.05 under
    // it - and close again behind it. A mint lamp across the top flashes on every drop.
    // No funnel above it: slanted jambs pointing at the centre read as every coin coming from there.
    const seatY = ctx.seat.y - ctx.carriageY;
    const cellBottom = seatY - ctx.seat.radius - 0.03;
    const cellTop = seatY + ctx.seat.radius + 0.04;
    const shuttle = new THREE.Group();
    for (const side of [-1, 1]) {
      const cheek = new THREE.Mesh(new RoundedBoxGeometry(0.1, cellTop - cellBottom, 0.46, 2, 0.02), gold);
      cheek.position.set(side * (throat + 0.03), (cellTop + cellBottom) / 2, 0);
      shuttle.add(cheek);
    }
    const mouthLight = new THREE.MeshStandardMaterial({ color: palette.mint, emissive: palette.mint, emissiveIntensity: 0.35 });
    const lid = new THREE.Mesh(new RoundedBoxGeometry(throat * 2 + 0.16, 0.05, 0.46, 2, 0.015), mouthLight);
    lid.position.set(0, cellTop, 0);
    shuttle.add(lid);
    const floor = [-1, 1].map((side) => {
      const plate = new THREE.Mesh(new RoundedBoxGeometry(throat, 0.025, 0.3, 2, 0.008), goldPin);
      plate.position.set(side * throat / 2, cellBottom, 0);
      shuttle.add(plate);
      return { plate, side };
    });
    carriage.add(shuttle);
    const track = new THREE.Mesh(new RoundedBoxGeometry(width - 0.3, 0.03, 0.03, 2, 0.01), goldPin);
    track.position.set(cx, cellTop + 0.06, 0.2);
    carriage.add(track);
    // Three lamps across the hood's shoulders, lit in turn as a coin is dispensed.
    const lamps = [-1, 0, 1].map((step) => {
      const material = new THREE.MeshStandardMaterial({ color: palette.goldSoft, emissive: palette.goldSoft, emissiveIntensity: 0.2 });
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.032, 12, 8), material);
      lamp.position.set(step * 0.42, 0.27, 0.17);
      const socket = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.025, 16).rotateX(Math.PI / 2), gold);
      socket.position.set(step * 0.42, 0.27, 0.2);
      carriage.add(lamp, socket);
      return material;
    });
    carriage.position.set(0, ctx.carriageY, coinZ);
    board.add(carriage);
    let dispensed = -Infinity;
    animated.push(({ time }) => {
      const since = time - dispensed;
      mouthLight.emissiveIntensity = 0.35 + 2.2 * Math.max(0, 1 - since / 0.35);
      // Open on the drop, back shut from 0.2s to 0.3s: before the cell refills (CoinPusher).
      const open = since < 0.2 ? 1 : Math.max(0, 1 - (since - 0.2) / 0.1);
      for (const { plate, side } of floor) plate.position.x = side * throat * (0.5 + open);
      lamps.forEach((material, index) => {
        const at = since - index * 0.08;
        material.emissiveIntensity = 0.2 + (at >= 0 && at < 0.25 ? 2.5 * (1 - at / 0.25) : 0);
      });
    });
    const dispense = (time) => { dispensed = time; };

    // --- sill: where coins leave the board ----------------------------------------------------
    box(lacquer, width + 0.68, 0.16, 0.18, cx, bottom - 0.08, coinZ - 0.1, 0.02);
    box(gold, width + 0.68, 0.025, 0.02, cx, bottom - 0.0125, coinZ - 0.2, 0.006);

    return {
      pins,
      bumpers,
      carriage,
      shuttle,
      neon: [tube, insert],
      // Called with the game clock when a coin leaves the hopper.
      dispense,
      animate(state) { for (const step of animated) step(state); },
    };
  },
};
