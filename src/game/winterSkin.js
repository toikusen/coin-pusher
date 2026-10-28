import * as THREE from 'three';
import { GAME } from './config.js';
import { loadConfiguredCoinPusher } from './winter/loadConfiguredCoinPusher.js';
import { winterLook } from './winter/winterLook.js';

// The winter cabinet (public/models/winter/) is a re-dressed export of this game's own scene, taken
// while scraperZ was 4.04 (before 313d2d5). Its parts therefore already sit in game coordinates at
// game scale: the bed, glass, chute and pusher line up with the colliders CoinPusher builds, and
// nothing here fits, scales or re-centres the model. The physics world is the same one for both
// looks - this module only swaps what is drawn and keeps the model's moving parts following the
// bodies and rigs that already move.
const BASE_PATH = 'models/winter/';

/** The delivery's final exposure (+0.08 EV). AgX, so it is not comparable with the classic 1.05. */
export const WINTER_EXPOSURE = 2 ** winterLook.exposureEV;
const WINTER_BACKGROUND = '#161c24';
// The delivery's phone budget: pixel ratio 1.5 and about 1.5 million rendered pixels.
const MOBILE_MAX_PIXEL_RATIO = 1.5;
const MOBILE_MAX_PIXELS = 1_500_000;
const X_AXIS = new THREE.Vector3(1, 0, 0);

// Runtime names (GLTFLoader strips '.' from node names, so 'Foo.001' arrives as 'Foo001').
// Each is checked on load: a re-export that renames them fails loudly and the game stays classic.
export const WINTER_NODES = Object.freeze({
  // CoinPusher.boardRig: pivots at BOARD_PIVOT and carries the recline.
  boardRig: 'Node_33',
  // CoinPusher.boardInner: cancels the pivot; everything on the board hangs off it.
  boardInner: 'Node_34',
  // CoinPusher.pusherMesh: tray and blade, merged by the artist into one mesh (pusherMesh below).
  // Safe to merge: the blade's stroke is the tray front's exactly (physics.js lowerBladeZAt).
  pusher: 'Node_26',
  pusherMesh: 'Box_#142235',
  // The theme's mouth shuttle (themes/nocturne.js), sliding along the carriage beam.
  shuttle: 'Node_118',
  // Parent of the three reel drums (CoinPusher.reelPanel).
  reels: 'Node_138',
  // The fixed scraper plate, the one static part the newer layout moved.
  scraper: 'Box_#d0d0d0',
  wallpaper: 'wallpaper',
});

/**
 * The tray position the export froze the pusher at, from its deck's rear edge: the deck reaches
 * pusherRearExtension + pusherDepth / 2 behind the body's origin (CoinPusher.buildMachine).
 */
export function exportedPusherZ(deckRearZ, { pusherRearExtension, pusherDepth }) {
  return deckRearZ - (pusherRearExtension + pusherDepth / 2);
}

// Parts standing this high hang off the pin board's head - the slot cabinet, the top crystals and
// garlands - and were exported as loose top-level nodes. They are re-parented onto the board so
// they recline with it when a foldable stands the board up.
export const BOARD_DECOR_MIN_Y = 4;
export const isBoardDecor = (box) => !box.isEmpty() && box.getCenter(new THREE.Vector3()).y > BOARD_DECOR_MIN_Y;

const touchDevice = () => matchMedia('(pointer: coarse)').matches
  || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** The delivery's render budget (renderQuality.js): phones cap at 1.5x and ~1.5 MP. */
export function winterPixelRatio(ratio, width, height, mobile) {
  if (!mobile) return ratio;
  return Math.min(ratio, MOBILE_MAX_PIXEL_RATIO, Math.sqrt(MOBILE_MAX_PIXELS / Math.max(width * height, 1)));
}

export class WinterSkin {
  /** Loads the cabinet into the game's scene, hidden; setActive(true) shows it. */
  static async load(game) {
    const { renderer, scene } = game;
    // The loader sets tone mapping and fog on the shared renderer and scene; keep the classic ones.
    const classic = {
      toneMapping: renderer.toneMapping,
      fog: scene.fog,
      background: scene.background,
    };
    let model;
    try {
      model = await loadConfiguredCoinPusher(renderer, scene, { baseURL: new URL(BASE_PATH, document.baseURI) });
    } finally {
      renderer.toneMapping = classic.toneMapping;
      const winterFog = scene.fog;
      scene.fog = classic.fog;
      classic.winterFog = winterFog;
    }
    try {
      return new WinterSkin(game, model, classic);
    } catch (error) {
      scene.remove(model.scene);
      model.dispose();
      throw error;
    }
  }

  constructor(game, model, classic) {
    this.game = game;
    this.model = model;
    this.classic = classic;
    this.fog = classic.winterFog;
    this.background = new THREE.Color(WINTER_BACKGROUND);
    this.mobile = touchDevice();
    this.active = false;
    this.exposure = WINTER_EXPOSURE;
    const root = model.scene;
    root.visible = false;
    root.updateMatrixWorld(true);
    const node = (name) => {
      const found = root.getObjectByName(name);
      if (!found) throw new Error(`冬季外觀模型缺少零件 ${name}`);
      return found;
    };
    this.boardRig = node(WINTER_NODES.boardRig);
    this.boardInner = node(WINTER_NODES.boardInner);
    this.pusher = node(WINTER_NODES.pusher);
    this.shuttle = node(WINTER_NODES.shuttle);
    this.scraper = node(WINTER_NODES.scraper);
    // The backdrop leans back with the board, as the classic hall does (CoinPusher.poseCamera): it
    // was baked at the board's flat recline, and turns by however far the board has moved from it.
    this.wallpaper = node(WINTER_NODES.wallpaper);
    this.wallpaperRest = this.wallpaper.quaternion.clone();
    this.exportRecline = this.boardRig.rotation.x;
    const deck = new THREE.Box3().setFromObject(node(WINTER_NODES.pusherMesh));
    this.pusherExportZ = exportedPusherZ(deck.max.z, GAME);
    this.scraperRestZ = this.scraper.position.z;
    this.scraperExportZ = new THREE.Box3().setFromObject(this.scraper).getCenter(new THREE.Vector3()).z;
    // Same order as CoinPusher.reelDrums: panel-local x, column -1 first.
    this.reels = [...node(WINTER_NODES.reels).children].sort((a, b) => a.position.x - b.position.x);

    const fixed = new Set([this.boardRig, this.pusher, this.wallpaper]);
    // A bare grouping node (the foliage root) is judged by its members, not its overall bounds.
    const candidates = root.children.flatMap((child) => (
      !child.isMesh && child.position.lengthSq() === 0 && child.children.length > 0 ? child.children : [child]
    ));
    for (const part of candidates) {
      if (fixed.has(part)) continue;
      if (isBoardDecor(new THREE.Box3().setFromObject(part))) this.boardInner.attach(part);
    }
    this.mirrorHallBelowBoard();
  }

  // The pin board and what hangs off it keep the delivery's sunset; everything below it - bed,
  // pusher, cabinet - mirrors the classic hall, as the classic machine does. Materials are shared
  // across the model, so those get their own copies, carrying the lightmap patch that clone()
  // leaves behind.
  mirrorHallBelowBoard() {
    const copies = new Map();
    const hallCopy = (material) => {
      if (!copies.has(material)) {
        const copy = material.clone();
        copy.onBeforeCompile = material.onBeforeCompile;
        copy.customProgramCacheKey = material.customProgramCacheKey;
        copy.envMap = this.game.environmentTexture;
        copy.envMapRotation.set(0, 0, 0);
        copies.set(material, copy);
      }
      return copies.get(material);
    };
    const onBoard = new Set();
    this.boardRig.traverse((object) => onBoard.add(object));
    this.model.scene.traverse((object) => {
      if (onBoard.has(object) || !object.isMesh || !object.material?.envMap) return;
      object.material = Array.isArray(object.material) ? object.material.map(hallCopy) : hallCopy(object.material);
    });
  }

  /** Shows the winter cabinet over the same physics, or hands the screen back to the classic one. */
  setActive(active) {
    if (active === this.active) return;
    this.active = active;
    const { game, model } = this;
    const { scene, renderer } = game;
    model.scene.visible = active;
    renderer.toneMapping = active ? THREE.AgXToneMapping : this.classic.toneMapping;
    scene.fog = active ? this.fog : this.classic.fog;
    scene.background = active ? this.background : this.classic.background;
    if (active) {
      this.hideClassic();
      this.update();
    } else {
      for (const object of this.hidden) object.visible = true;
      this.hidden = [];
    }
  }

  // Everything the classic look draws, and its lights: the cabinet is lit by its bake and must not
  // be lit twice. What stays is what the model does not draw - coins, the coin in the shuttle,
  // chests, sparks and the collider overlay - all named by the game (CoinPusher.skinKeepRoots).
  hideClassic() {
    const keep = new Set();
    for (const root of this.game.skinKeepRoots()) root?.traverse((object) => keep.add(object));
    this.model.scene.traverse((object) => keep.add(object));
    this.hidden = [];
    this.game.scene.traverse((object) => {
      if (keep.has(object) || !object.visible) return;
      if (object.isMesh || object.isPoints || object.isSprite || object.isLine || object.isLight) {
        object.visible = false;
        this.hidden.push(object);
      }
    });
  }

  /** Puts the model's moving parts where the game's are this frame. */
  update() {
    const { game } = this;
    this.boardRig.position.copy(game.boardRig.position);
    this.boardRig.quaternion.copy(game.boardRig.quaternion);
    this.wallpaper.quaternion.setFromAxisAngle(X_AXIS, game.boardRig.rotation.x - this.exportRecline).multiply(this.wallpaperRest);
    // The export's pivot sat at the old dropZoneZ; taking the game's moves the board onto today's.
    this.boardInner.position.copy(game.boardInner.position);
    this.pusher.position.z = game.pusherMesh.position.z - this.pusherExportZ;
    this.scraper.position.z = this.scraperRestZ + GAME.scraperZ - this.scraperExportZ;
    if (game.dropShuttle) this.shuttle.position.x = game.dropShuttle.position.x;
    game.reelDrums?.forEach((drum, index) => {
      if (this.reels[index]) this.reels[index].rotation.x = drum.rotation.x;
    });
  }

  pixelRatio(ratio, width, height) {
    return this.active ? winterPixelRatio(ratio, width, height, this.mobile) : ratio;
  }

  dispose() {
    this.setActive(false);
    this.game.scene.remove(this.model.scene);
    this.model.dispose();
  }
}
