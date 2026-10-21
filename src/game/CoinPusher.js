import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import {
  GAME,
  MACHINE_GEOMETRY_DEFAULTS,
  PALETTE,
  applyMachineGeometry,
  machineGeometryFor,
} from './config.js';
import {
  coinPhase,
  gildTargets,
  launcherReachFor,
  launcherTargetFor,
  launcherYawFor,
  launcherXFor,
  quakeKick,
  rollSlotResult,
  slotWin,
} from './rules.js';
import {
  COIN_HEIGHT,
  COIN_RADIUS,
  CONTACT_SOLVER_OPTIONS,
  TUNING_DEFAULTS,
  applyCoinTuning,
  createCoinBody,
  pusherMotionAt,
  seedPosition,
  chestDropZ,
  nudgeOverLip,
  settleChestOnLowerBed,
  stopRailCoinAtWall,
  syncFrictionGravity,
} from './physics.js';

// One pusher half-stroke, entered at full retreat (runPusherToFullRetreat): long enough for
// the seeded stack to collapse and be squeezed forward once. Every step of it is simulated
// before the first frame, so this is also the load-time cost of the opening pile - ~1.5 s on
// a 2024 laptop, and cylinder-vs-cylinder narrowphase is the whole of it. Halving it halves
// the cost and visibly puts the rows back, so it is a look/load knob, not free headroom.
const PILE_SETTLE_SECONDS = Math.PI / GAME.pusherSpeed;

// How far off centre a chest may be dropped. playfieldHalfWidth less a whole chest width leaves
// more than the tumbling box's own half-diagonal clear of the glass at any spawn yaw.
const CHEST_DROP_HALF_WIDTH = GAME.playfieldHalfWidth - GAME.chestWidth;

// The reel panel's ground, shared by the panel fill and the hole punched in the money bag.
const REEL_GROUND = '#050b14';
// The spinning strip is exactly the payable symbols - see GAME.slotIdleSymbol for why the idle
// face is not one of them.
const REEL_STRIP = GAME.slotOutcomes.map((outcome) => outcome.symbol);

// ponytail: the bag is a canvas path, not a sprite - the panel is 384px wide at the top of the
// shot, and an imported texture is one more asset to load and colour-match against the win glow.
// Upgrade path: a symbol atlas if the slot ever gets a camera of its own.
function drawMoneyBag(context, x, y, size, fill) {
  const halfWidth = size * 0.4;
  const neckY = y - size * 0.16;
  const neckHalf = size * 0.15;
  context.fillStyle = fill;
  // Body: a teardrop hanging off the cinched neck, spreading at the base.
  context.beginPath();
  context.moveTo(x - neckHalf, neckY);
  context.bezierCurveTo(x - halfWidth * 1.35, y + size * 0.06, x - halfWidth, y + size * 0.5, x, y + size * 0.5);
  context.bezierCurveTo(x + halfWidth, y + size * 0.5, x + halfWidth * 1.35, y + size * 0.06, x + neckHalf, neckY);
  context.closePath();
  context.fill();
  // Tie: the gathered cloth above the body, a trapezium because anything finer is mush at this size.
  context.beginPath();
  context.moveTo(x - neckHalf * 1.7, neckY - size * 0.22);
  context.lineTo(x + neckHalf * 1.7, neckY - size * 0.22);
  context.lineTo(x + neckHalf, neckY + size * 0.02);
  context.lineTo(x - neckHalf, neckY + size * 0.02);
  context.closePath();
  context.fill();
  // Punched in the panel's own ground, so the mark reads as a hole in the cloth, not an outline.
  context.fillStyle = REEL_GROUND;
  context.font = `bold ${Math.round(size * 0.44)}px system-ui, sans-serif`;
  context.fillText('$', x, y + size * 0.2);
}

// A seismograph trace: flat, one tall spike, flat again. Reads as a tremor at panel size, where
// a shaking-cabinet pictogram would be mush, and it shares nothing with the bag's silhouette.
function drawQuake(context, x, y, size, fill) {
  const step = size * 0.16;
  context.strokeStyle = fill;
  context.lineWidth = Math.max(4, size * 0.1);
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.beginPath();
  const trace = [
    [-2.4, 0], [-1.6, 0], [-1.1, -1.5], [-0.5, 1.6],
    [0.1, -2.2], [0.7, 1.2], [1.3, -0.8], [1.9, 0], [2.4, 0],
  ];
  trace.forEach(([offsetX, offsetY], index) => {
    const pointX = x + offsetX * step;
    const pointY = y + offsetY * step;
    if (index === 0) context.moveTo(pointX, pointY);
    else context.lineTo(pointX, pointY);
  });
  context.stroke();
}

// A coin with a sparkle punched out of it: the gild prize turns coins already on the machine to
// gold, and a disc is the only silhouette on the strip that says "the coins themselves". Shares
// nothing with the bag's teardrop or the quake's trace.
function drawGildedCoin(context, x, y, size, fill) {
  const radius = size * 0.38;
  context.fillStyle = fill;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
  // Punched in the panel's own ground, the same trick the bag's '$' uses - an outline at this size
  // closes up into a blob.
  context.fillStyle = REEL_GROUND;
  const arm = radius * 0.78;
  const waist = radius * 0.16;
  context.beginPath();
  context.moveTo(x, y - arm);
  context.quadraticCurveTo(x + waist, y - waist, x + arm, y);
  context.quadraticCurveTo(x + waist, y + waist, x, y + arm);
  context.quadraticCurveTo(x - waist, y + waist, x - arm, y);
  context.quadraticCurveTo(x - waist, y - waist, x, y - arm);
  context.fill();
}

// Symbols that need more than a glyph. Anything absent is drawn as its own text, which is what
// keeps '7' and any other plain character free.
const REEL_PAINTERS = { bag: drawMoneyBag, quake: drawQuake, gild: drawGildedCoin };
// Every part of the cabinet is cut from the playfield's half-width, so widening the machine is
// one config change rather than thirty literals. Kept as offsets from the interior, not ratios:
// a wider machine should get more playfield, not fatter trim.
const INNER_X = GAME.playfieldHalfWidth;
const BED_WIDTH = INNER_X * 2 + 0.15;
// World units per tile of public/textures/deck_plate.jpg. The tile is two plates across, so a
// plate is two units - about three coin diameters.
const DECK_PLATE_TILE = 4;
// How much the plate art is darkened, 0..1.
const DECK_PLATE_SHADE = 0.3;
// Colour multiplied over the plate art on the tray inlays. Grey, not glassTint - see inlaySurface.
const DECK_PLATE_INLAY_TINT = 0xffffff;
// The payout chute hangs off the front lip, so it travels with playfieldFrontZ - which the
// geometry panel moves, so this is read per placement rather than captured at import.
const chuteZ = () => GAME.playfieldFrontZ - 1.6;
// Trim finish. On a machine made of painted metal an emissive strip is the one thing that cannot
// be a real object, so the gold reads as polished brass instead: same colour, same job marking an
// edge, but lit by the room rather than glowing on its own.
const BRASS = Object.freeze({ roughness: 0.26, metalness: 0.92, envMapIntensity: 0.9 });
const SETTLE_SOLVER_ITERATIONS = 12;
// Yaw angles measureLauncherClip checks the launcher's silhouette at. Five is enough for a shape
// this simple - the samples only have to bracket where the widest point crosses the frame's edge.
const FAN_SAMPLES = [-2, -1, 0, 1, 2].map((step) => (step / 2) * (GAME.launcherFanDegrees * Math.PI) / 180);

export class CoinPusher {
  constructor(canvas, quality, callbacks = {}) {
    this.canvas = canvas;
    this.quality = quality;
    this.callbacks = callbacks;
    this.elapsed = 0;
    this.running = false;
    this.activeCoins = [];
    this.coinPool = [];
    this.createdCoins = 0;
    this.recycleDelay = 0.38;
    this.frameId = 0;
    this.cleanup = [];
    this.launching = [];
    this.launcherAim = 0;
    this.launcherX = 0;
    // How far off centre the launcher may sit. Starts at the rail's full half-width and shrinks
    // to whatever the current window frames - see updateLauncherReach.
    this.launcherReach = GAME.launcherTravelHalfWidth;
    this.launcherClip = null;
    this.pinHover = 1.02;
    // Mechanical surfaces re-skinned when a cabinet shell loads: the tray, its inlay, the blade,
    // the scraper and the rear deck. Their own materials are tuned for the procedural machine -
    // the scraper's gold emissive in particular only reads as a lit guard against procedural
    // furniture - and left showing next to a shell they are the thing that looks pasted on. The
    // bed is deliberately not among them: it carries drawn markings.
    this.shellSurfaces = [];
    // Cabinet furniture: hidden wholesale when a real cabinet model loads. Functional surfaces
    // (bed, glass, tray, scraper, rails) are never in here - those are aligned to physics and a
    // model cannot replace them without the collision bodies moving too.
    this.decor = [];
    // Parts whose Z placement or length is decided by the geometry panel. Collected during the
    // build and re-placed by layoutGeometry(), so a slider never rebuilds the machine.
    this.glassPanes = [];
    this.neonBars = [];
    // Emissive shell parts the pulse in animate() drives. Empty without a cabinet model.
    this.shellNeon = [];
    this.chuteParts = [];
    this.shellPosts = [];
    this.shellSkirts = [];
    this.headboardParts = [];
    this.trayParts = [];
    // Read back off GAME rather than passed in: main.js applies any saved geometry before the
    // machine is built, and this is the same five numbers seen from the other side.
    this.geometry = machineGeometryFor({
      scraperZ: GAME.scraperZ,
      upperCenterZ: GAME.pusherOriginZ,
      upperLength: GAME.pusherDepth + GAME.pusherRearExtension,
      lowerCenterZ: (GAME.playfieldFrontZ + GAME.playfieldBackZ) / 2,
      lowerLength: GAME.playfieldBackZ - GAME.playfieldFrontZ,
    });
    // Solver iterations are the one knob whose default is device-dependent, so it is seeded
    // from the quality profile rather than the shared defaults.
    this.tuning = { ...TUNING_DEFAULTS, solverIterations: quality.solverIterations };
  }

  async init() {
    this.setupRenderer();
    const environmentReady = this.setupScene();
    this.setupPhysics();
    await Promise.all([
      environmentReady,
      this.setupSharedAssets(environmentReady),
    ]);
    this.buildMachine();
    // After buildMachine: the cabinet hides the procedural furniture, which has to exist first.
    await this.loadCabinet();
    // After loadCabinet: the slot machine sits on the cabinet's crown, whose height it measures.
    this.buildBonusStage();
    await this.setupBloom();
    this.setupParticles();
    this.bindPointer();
    this.bindResize();
    this.resetPile();
    this.timer = new THREE.Timer();
    this.timer.connect(document);
    return this;
  }

  setupRenderer() {
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        antialias: !this.quality.lowPower,
        alpha: false,
        powerPreference: this.quality.lowPower ? 'low-power' : 'high-performance',
      });
    } catch (error) {
      throw new Error('無法建立 WebGL 畫面，請更新瀏覽器或開啟硬體加速。', { cause: error });
    }
    renderer.setPixelRatio(this.quality.pixelRatio);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = this.quality.shadows;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer = renderer;

    const onContextLost = (event) => {
      event.preventDefault();
      this.stop();
      this.callbacks.onError?.('圖形裝置中斷，請按「重新載入」恢復遊戲。');
    };
    this.canvas.addEventListener('webglcontextlost', onContextLost);
    this.cleanup.push(() => this.canvas.removeEventListener('webglcontextlost', onContextLost));
  }

  setupScene() {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(PALETTE.scene);
    scene.fog = new THREE.Fog(PALETTE.fog, 17, 42);
    this.scene = scene;

    // First person: the player stands at the cabinet instead of looking down on it. 27° of pitch at
    // a 9.4 standoff, down from 39° at 10.4, and the fov opens 56 -> 62 to hold the bed's share of
    // the width at the shorter distance. What puts a floor under the pitch is the launcher, not the
    // bed: it hangs in front of the machine, so a flatter camera slides it behind the cabinet's
    // front panel, and by about 20° it is under the frame's bottom edge entirely.
    // Two things this framing gives up on purpose. The marquee was already fully cropped at 39° and
    // stays cropped - the cabinet fit is keyed to the bed, so widening the machine scaled the model
    // up and took the sign out of frame. And the pitch now clears the machine's rear, so the hall
    // backdrop shows through the playfield's back opening; it reads as a lit backglass, which is
    // why addHall's height and sink still work unchanged. Anything flatter starts showing the
    // painted floor below the hall's horizon and does need the hall re-derived.
    // Fov is vertical, so the pitch margins hold at any window shape; only the bed's share of the
    // width moves with aspect, and a tall narrow window is what runs out of room first.
    const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 100);
    camera.position.set(0, 5.4, -9.4);
    camera.lookAt(0, 0.4, 0.6);
    this.camera = camera;
    // The camera never moves in play, so an earthquake can shake it and put it back here.
    this.cameraBase = camera.position.clone();

    scene.add(new THREE.HemisphereLight(PALETTE.white, PALETTE.shell, 1.35));
    const key = new THREE.DirectionalLight(PALETTE.white, this.quality.shadows ? 2.35 : 1.85);
    key.position.set(-4, 10, -6);
    key.castShadow = this.quality.shadows;
    key.shadow.mapSize.set(this.quality.lowPower ? 512 : 1024, this.quality.lowPower ? 512 : 1024);
    Object.assign(key.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 32 });
    scene.add(key);

    const playfieldFill = new THREE.PointLight(PALETTE.goldSoft, 5.2, 18);
    playfieldFill.position.set(0, 5.5, -2.5);
    scene.add(playfieldFill);

    // Brand colors remain as restrained accent light instead of tinting the machine.
    const tealAccent = new THREE.PointLight(PALETTE.blue, 2.2, 16);
    tealAccent.position.set(-5.2, 4.6, -3.2);
    scene.add(tealAccent);
    const goldAccent = new THREE.PointLight(PALETTE.gold, 1.1, 12);
    goldAccent.position.set(5.2, 4.4, -1.2);
    scene.add(goldAccent);
    // Cool rim from behind the cabinet, matching the mock's corridor lighting.
    const rimAccent = new THREE.PointLight(PALETTE.blue, 3.2, 18);
    rimAccent.position.set(0, 4.2, 5.2);
    scene.add(rimAccent);
    const purpleAccent = new THREE.PointLight(PALETTE.goldSoft, 1.4, 16);
    purpleAccent.position.set(5.4, 2.6, 3);
    scene.add(purpleAccent);

    return this.loadCoinEnvironment();
  }

  async loadCoinEnvironment() {
    const { RGBELoader } = await import('three/addons/loaders/RGBELoader.js');
    const sourceTexture = await new RGBELoader().loadAsync('/environment/decor_shop_1k.hdr');
    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.environmentTexture = pmremGenerator.fromEquirectangular(sourceTexture).texture;
    sourceTexture.dispose();
    pmremGenerator.dispose();
  }

  // The mock's look is mostly bloom: neon trim and gold rims bleeding into the dark cabinet.
  // ponytail: skipped on low-power devices — an extra full-screen pass is the first thing to cut.
  async setupBloom() {
    if (this.quality.lowPower) return;
    const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] = await Promise.all([
      import('three/addons/postprocessing/EffectComposer.js'),
      import('three/addons/postprocessing/RenderPass.js'),
      import('three/addons/postprocessing/UnrealBloomPass.js'),
      import('three/addons/postprocessing/OutputPass.js'),
    ]);
    const composer = new EffectComposer(this.renderer);
    composer.addPass(new RenderPass(this.scene, this.camera));
    // strength / radius / threshold — only emissive trim and lit coin rims pass the threshold.
    // Down from 0.34 / 0.92: the machine grew a lot of emissive after this was first set (the
    // cabinet's rails and marquee, the launcher, the slot's crown), and each addition spent the
    // same budget. Raising the threshold first is what keeps the trim reading as trim — it cuts
    // the number of pixels that glow rather than dimming the ones that should.
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.22, 0.42, 0.96));
    composer.addPass(new OutputPass());
    this.composer = composer;
    this.resize?.();
  }

  setupPhysics() {
    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -24, -this.tuning.tilt), allowSleep: true });
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.solver.iterations = this.tuning.solverIterations;
    syncFrictionGravity(world, this.quality.physicsStep);

    // Every contact in the machine involves a coin, so all three pairs below are registered
    // explicitly and defaultContactMaterial is never consulted. Tune stiffness here, on the
    // ContactMaterials, or the change silently does nothing. Kept as fields because
    // setPhysics writes their friction live - narrowphase re-reads it every step.
    this.groundMaterial = new CANNON.Material('ground');
    this.pusherMaterial = new CANNON.Material('pusher');
    this.coinPhysicsMaterial = new CANNON.Material('coin');
    // The chest is the one body in the machine that is not a coin, and it cannot share the coin's
    // friction - see GAME.chestFrictionScale for why a box on the coin material slides.
    this.chestMaterial = new CANNON.Material('chest');
    this.contacts = {
      ground: new CANNON.ContactMaterial(this.coinPhysicsMaterial, this.groundMaterial, {
        ...CONTACT_SOLVER_OPTIONS,
        friction: this.tuning.groundFriction,
      }),
      coin: new CANNON.ContactMaterial(this.coinPhysicsMaterial, this.coinPhysicsMaterial, {
        ...CONTACT_SOLVER_OPTIONS,
        friction: this.tuning.coinFriction,
      }),
      pusher: new CANNON.ContactMaterial(this.coinPhysicsMaterial, this.pusherMaterial, {
        ...CONTACT_SOLVER_OPTIONS,
        friction: this.tuning.pusherFriction,
      }),
      chestGround: new CANNON.ContactMaterial(this.chestMaterial, this.groundMaterial, {
        ...CONTACT_SOLVER_OPTIONS,
        friction: this.tuning.groundFriction * GAME.chestFrictionScale,
      }),
      chestCoin: new CANNON.ContactMaterial(this.chestMaterial, this.coinPhysicsMaterial, {
        ...CONTACT_SOLVER_OPTIONS,
        friction: this.tuning.coinFriction * GAME.chestFrictionScale,
      }),
      chestPusher: new CANNON.ContactMaterial(this.chestMaterial, this.pusherMaterial, {
        ...CONTACT_SOLVER_OPTIONS,
        friction: this.tuning.pusherFriction * GAME.chestFrictionScale,
      }),
    };
    Object.values(this.contacts).forEach((contact) => world.addContactMaterial(contact));
    this.world = world;
  }

  // Live tuning. Everything but thickness lands on the running world; thickness resizes every
  // coin's collision shape, which would leave a settled pile interpenetrating, so the pile is
  // reseeded instead. Pooled coins are patched too, or a recycled coin reverts to old values.
  setPhysics(patch) {
    Object.assign(this.tuning, patch);
    const resizeShape = Object.hasOwn(patch, 'thickness');
    this.world.gravity.z = -this.tuning.tilt;
    syncFrictionGravity(this.world, this.quality.physicsStep);
    this.world.solver.iterations = this.tuning.solverIterations;
    this.contacts.ground.friction = this.tuning.groundFriction;
    this.contacts.coin.friction = this.tuning.coinFriction;
    this.contacts.pusher.friction = this.tuning.pusherFriction;
    this.contacts.chestGround.friction = this.tuning.groundFriction * GAME.chestFrictionScale;
    this.contacts.chestCoin.friction = this.tuning.coinFriction * GAME.chestFrictionScale;
    this.contacts.chestPusher.friction = this.tuning.pusherFriction * GAME.chestFrictionScale;
    const scaleY = this.tuning.thickness / COIN_HEIGHT;
    for (const coin of [...this.activeCoins, ...this.coinPool]) {
      applyCoinTuning(coin.body, this.tuning, resizeShape);
      coin.mesh.scale.y = scaleY;
    }
    if (resizeShape) this.resetPile();
  }

  async setupSharedAssets(environmentReady) {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    // Optional decoration loads the same way the launcher does: a missing file is a warning and a
    // feature that quietly does nothing, never a failed boot.
    const optional = (path, label) => new GLTFLoader().loadAsync(path).catch((error) => {
      console.warn(`[${label}] GLB unavailable.`, error);
      return null;
    });
    const [model, hallTexture, launcherModel, chestModel, slotModel, deckPlate] = await Promise.all([
      new GLTFLoader().loadAsync('/models/coin.glb'),
      new THREE.TextureLoader().loadAsync('/backdrop/hall.jpg'),
      // The game remains playable if an asset CDN or a stale deployment omitted the optional
      // launcher. buildLauncher() falls back to the procedural barrel below.
      optional('/models/launcher.glb', 'launcher'),
      optional('/models/chest_tripo.glb', 'chest'),
      optional('/models/slot_tripo.glb', 'slot'),
      // The bed's plate art. Missing, the bed falls back to its drawn grid.
      new THREE.ImageLoader().loadAsync('/textures/deck_plate.jpg').catch((error) => {
        console.warn('[deck] plate texture unavailable.', error);
        return null;
      }),
    ]);
    this.deckPlate = deckPlate;
    hallTexture.colorSpace = THREE.SRGBColorSpace;
    this.hallTexture = hallTexture;
    this.launcherModelSource = launcherModel?.scene ?? null;
    this.chestModelSource = chestModel?.scene ?? null;
    this.slotModelSource = slotModel?.scene ?? null;
    const sourceMeshes = [];
    model.scene.traverse((object) => {
      if (object.isMesh) sourceMeshes.push(object);
    });
    const sourceCoin = model.scene.getObjectByName('coin_lp') ?? sourceMeshes[0];
    if (!sourceCoin?.isMesh) throw new Error('硬幣模型中找不到可用的網格。');

    sourceCoin.updateWorldMatrix(true, false);
    this.coinGeometry = sourceCoin.geometry.clone().applyMatrix4(sourceCoin.matrixWorld);
    this.coinGeometry.center();
    this.coinGeometry.computeBoundingBox();
    const modelSize = new THREE.Vector3();
    this.coinGeometry.boundingBox.getSize(modelSize);
    this.coinGeometry.scale(
      (COIN_RADIUS * 2) / modelSize.x,
      COIN_HEIGHT / modelSize.y,
      (COIN_RADIUS * 2) / modelSize.z,
    );
    this.coinGeometry.computeBoundingSphere();

    // Silver and gold, from one gold asset. Both share the model's normal map, its ambient
    // occlusion and its packed roughness/metalness - only the base colour differs.
    //
    // The premium coin used to be this same gold multiplied by mint, and that is why it was hard
    // to read: `color` multiplies `map` in three.js, so a tint can only take channels away. Gold
    // has almost no blue to take, so no tint turns it silver - it turns it olive. The two coins
    // ended up differing by a muddy hue shift on identical brightness, in a scene already full of
    // teal. Nulling `map` on the plain coin instead hands its hue entirely to `color`, and the
    // pair then differs on hue AND on value, which is what tells them apart at a glance.
    //
    // Which way round is not arbitrary: the mechanic is already called gilding. gildCoins() turns
    // plain coins premium, and a silver coin turning gold is the thing the player watches happen.
    await environmentReady;
    const regular = sourceCoin.material.clone();
    regular.envMap = this.environmentTexture;
    regular.map = null;
    // Brushed pewter, not chrome. A metal takes its colour entirely from what it reflects, so
    // all three of these dim it and they do different jobs: colour tints the reflection, envMap
    // intensity scales the HDR feeding it, and roughness spreads the key light's highlight from a
    // hot spot into a sheen. At metalness 1 / roughness 0.34 / intensity 1.1 the plain coins came
    // back as mirrors of a brightly lit shop HDR - brighter than the neon, and flat enough to
    // lose the relief the normal map is there to show. The palette has no silver, so the hue is
    // its white taken down in value rather than a new colour.
    regular.color = new THREE.Color(PALETTE.white).multiplyScalar(0.62);
    regular.metalness = 0.92;
    regular.roughness = 0.56;
    regular.envMapIntensity = 0.55;
    regular.needsUpdate = true;

    const premium = sourceCoin.material.clone();
    premium.envMap = this.environmentTexture;
    // A glint, not a lamp. The pair already reads without it; this is what makes the rare one
    // feel rare when a few of them sit in a pile of plain ones.
    premium.emissive = new THREE.Color(PALETTE.gold);
    premium.emissiveIntensity = 0.18;
    premium.needsUpdate = true;
    this.coinMaterials = { regular, premium };

    sourceMeshes.forEach((mesh) => {
      mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((material) => material.dispose());
    });
    this.buildSurfaceMaps();
    this.glowTexture = this.createGlowTexture();
    this.badgeTexture = this.createBadgeTexture();
  }

  createGlowTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d');
    const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.3, 'rgba(255,255,255,.7)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(canvas);
  }

  createBackTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    const wash = context.createLinearGradient(0, 0, 0, 256);
    wash.addColorStop(0, '#0a2432');
    wash.addColorStop(1, '#050f1a');
    context.fillStyle = wash;
    context.fillRect(0, 0, 512, 256);
    context.textAlign = 'center';
    context.fillStyle = '#f2c94c';
    context.font = '700 30px Rajdhani, sans-serif';
    context.fillText('PUSH YOUR LUCK', 256, 226);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.backTexture = texture;
    return texture;
  }

  // Playfield art. What makes a cabinet look like it has content is graphic design on its
  // surfaces, not polygon count, and graphics are the one thing a 2D canvas is genuinely good at. This is the largest single surface on screen - the camera looks straight down
  // the bed - so it carries most of what the machine looks like, and it is the one place the
  // backdrop's own floor treatment can be quoted directly: dark navy ground, faint gold grid.
  //
  // Orientation is derived, not guessed. BoxGeometry's +Y face is buildPlane('x','z','y',1,1,...)
  // with uv.v = 1 - iy/gridY, and iy = 0 sits at z = -depth/2 - so uv.v = 1 is the machine's FRONT.
  // CanvasTexture defaults to flipY, which samples uv.v = 1 from the image's first row. Therefore
  // canvas y = 0 is the payout edge and canvas y = height is the back panel. Get this backwards
  // and the payout band ends up marking the wall the coins can never reach.
  createDeckTexture() {
    // The plate art's seams are a few pixels wide in the source; at 1024 across 8 units they fall
    // under a pixel and the bed reads as flat colour. The drawn grid never needed more.
    const width = this.quality.lowPower ? 512 : (this.deckPlate ? 2048 : 1024);
    const depth = GAME.playfieldBackZ - GAME.playfieldFrontZ;
    const height = Math.round((width * depth) / BED_WIDTH);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    // One scale for both axes, so the grid below comes out square rather than stretched.
    const perUnit = width / BED_WIDTH;
    const toX = (x) => (x + BED_WIDTH / 2) * perUnit;
    const toY = (z) => (z - GAME.playfieldFrontZ) * perUnit;

    const wash = context.createLinearGradient(0, 0, 0, height);
    wash.addColorStop(0, '#0b2530');
    wash.addColorStop(0.5, '#071820');
    wash.addColorStop(1, '#0b2530');
    context.fillStyle = wash;
    context.fillRect(0, 0, width, height);

    if (this.deckPlate) {
      // Plate art instead of the grid: one tile is two plates across, laid against world units like
      // the grid was, so the seams stay square whatever the canvas resolution.
      const plates = context.createPattern(this.deckPlate, 'repeat');
      const scale = (perUnit * DECK_PLATE_TILE) / this.deckPlate.width;
      plates.setTransform(new DOMMatrix().translate(toX(0), toY(0)).scale(scale));
      context.fillStyle = plates;
      context.fillRect(0, 0, width, height);
      // The art is painted a step lighter than PALETTE.felt; keep the bed under the coins.
      context.fillStyle = `rgba(3, 10, 16, ${DECK_PLATE_SHADE})`;
      context.fillRect(0, 0, width, height);
    }

    // The backdrop's floor, quoted: faint gold grid on near-black, every world unit, with every
    // fourth line carried brighter, laid out against world coordinates rather than the texture's
    // own 0..1.
    //
    // It stretches with the bed and that is fine. placeBox scales the mesh rather than rebuilding
    // its geometry, and nothing regenerates this texture, so at the geometry panel's longest bed
    // the cells come out 1 x 1.43 - the same stretch the hexagon and the pinstripes have always
    // taken. Looking down the bed, z is foreshortened hard enough that the stretched cells read
    // closer to square on screen than the true ones do.
    context.lineWidth = Math.max(1, perUnit * 0.012);
    for (let x = -Math.floor(BED_WIDTH / 2); x <= BED_WIDTH / 2 && !this.deckPlate; x += 1) {
      context.strokeStyle = `rgba(242, 201, 76, ${x % 4 === 0 ? 0.17 : 0.075})`;
      context.beginPath();
      context.moveTo(toX(x), 0);
      context.lineTo(toX(x), height);
      context.stroke();
    }
    for (let z = Math.ceil(GAME.playfieldFrontZ); z <= GAME.playfieldBackZ && !this.deckPlate; z += 1) {
      context.strokeStyle = `rgba(242, 201, 76, ${z % 4 === 0 ? 0.17 : 0.075})`;
      context.beginPath();
      context.moveTo(0, toY(z));
      context.lineTo(width, toY(z));
      context.stroke();
    }

    // Watermark hexagon, the same mark the badge and the UI use.
    context.save();
    context.translate(width / 2, height / 2);
    context.beginPath();
    for (let corner = 0; corner < 6; corner += 1) {
      const angle = (Math.PI / 3) * corner - Math.PI / 2;
      const radius = width * 0.3;
      context[corner === 0 ? 'moveTo' : 'lineTo'](radius * Math.cos(angle), radius * Math.sin(angle));
    }
    context.closePath();
    context.strokeStyle = 'rgba(242, 201, 76, 0.13)';
    context.lineWidth = perUnit * 0.08;
    context.stroke();
    context.restore();

    // Lane pinstripes with tick marks: the eye reads them as the machine telling it where coins
    // are supposed to travel, which is most of what playfield art is for. Dimmer than they were,
    // because the grid now carries the structure and two full-strength systems fight.
    for (const x of [width * 0.28, width * 0.72]) {
      context.strokeStyle = 'rgba(242, 201, 76, 0.2)';
      context.lineWidth = perUnit * 0.024;
      context.beginPath();
      context.moveTo(x, height * 0.12);
      context.lineTo(x, height * 0.88);
      context.stroke();
      context.strokeStyle = 'rgba(46, 230, 210, 0.26)';
      for (let tick = 0; tick <= 8; tick += 1) {
        const y = height * 0.12 + (height * 0.76 * tick) / 8;
        context.beginPath();
        context.moveTo(x - perUnit * 0.072, y);
        context.lineTo(x + perUnit * 0.072, y);
        context.stroke();
      }
    }

    // The payout edge, lit. It is the only line on the bed that pays, and until now nothing on the
    // deck said so - the gold front trim marks it from outside the glass, where a player looking
    // down the machine is not looking. Fades back over a coin diameter and a half so it reads as
    // the edge glowing rather than as a painted stripe.
    const lip = context.createLinearGradient(0, 0, 0, perUnit * COIN_RADIUS * 3);
    lip.addColorStop(0, 'rgba(46, 230, 210, 0.5)');
    lip.addColorStop(0.45, 'rgba(46, 230, 210, 0.14)');
    lip.addColorStop(1, 'rgba(46, 230, 210, 0)');
    context.fillStyle = lip;
    context.fillRect(0, 0, width, perUnit * COIN_RADIUS * 3);

    // ponytail: the hazard chevrons that used to band both ends were cut on request - the payout
    // band above marks the lip now. Re-add them here if the edge ever needs the warning.

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    return texture;
  }

  // Headboard artwork. ExtrudeGeometry writes UVs straight from the shape's own coordinates, not
  // normalised 0..1, so the panel's UVs run about -w/2..w/2 - without the repeat and offset below
  // the texture tiles several times across it instead of fitting once.
  createHeadboardTexture(width, panelWidth, panelHeight) {
    const height = Math.round((width * panelHeight) / panelWidth);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');

    const wash = context.createLinearGradient(0, 0, 0, height);
    wash.addColorStop(0, '#0b1a2a');
    wash.addColorStop(0.55, '#061220');
    wash.addColorStop(1, '#0a1826');
    context.fillStyle = wash;
    context.fillRect(0, 0, width, height);

    // Faint hex lattice, so the panel is not a void behind the badge.
    context.strokeStyle = 'rgba(46, 230, 210, 0.09)';
    context.lineWidth = 2;
    const cell = width / 22;
    for (let row = -1; row * cell * 1.5 < height + cell; row += 1) {
      for (let column = -1; column * cell * 1.74 < width + cell; column += 1) {
        const cx = column * cell * 1.74 + (row % 2 ? cell * 0.87 : 0);
        const cy = row * cell * 1.5;
        context.beginPath();
        for (let corner = 0; corner < 6; corner += 1) {
          const angle = (Math.PI / 3) * corner - Math.PI / 2;
          context[corner === 0 ? 'moveTo' : 'lineTo'](cx + cell * Math.cos(angle), cy + cell * Math.sin(angle));
        }
        context.closePath();
        context.stroke();
      }
    }

    context.strokeStyle = 'rgba(242, 201, 76, 0.5)';
    context.lineWidth = Math.max(2, height * 0.016);
    for (const y of [height * 0.14, height * 0.86]) {
      context.beginPath();
      context.moveTo(width * 0.06, y);
      context.lineTo(width * 0.94, y);
      context.stroke();
    }

    context.textAlign = 'center';
    context.fillStyle = 'rgba(238, 247, 251, 0.9)';
    context.font = `700 ${Math.round(height * 0.15)}px Orbitron, sans-serif`;
    context.fillText('COIN PUSHER', width / 2, height * 0.32);
    context.fillStyle = 'rgba(46, 230, 210, 0.85)';
    context.font = `700 ${Math.round(height * 0.085)}px Rajdhani, sans-serif`;
    context.letterSpacing = '10px';
    context.fillText('SILVER HALL · ARCADE', width / 2, height * 0.78);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    // Negative on U: the panel is extruded towards +Z and the camera sits at -Z, so what it sees
    // is the extrusion's back cap, whose UVs run the other way. Left as positive, the wordmark
    // comes out mirrored. The offset still puts the shape's origin at the texture's centre.
    texture.repeat.set(-1 / panelWidth, 1 / panelHeight);
    texture.offset.set(0.5, 0.5);
    return texture;
  }

  // Surface detail, drawn rather than downloaded. An untextured MeshStandardMaterial is one flat
  // colour at one roughness, which is exactly what reads as unpainted plastic: a large panel gets
  // a single uniform highlight, and nothing in a real machine is uniform. The roughness map does
  // most of the work here; the normal map is derived from the same height field so the streaks
  // that dull a reflection are the ones that catch the light, rather than two unrelated patterns
  // fighting each other.
  // ponytail: box UVs run 0..1 per face, so one repeat cannot be right for a 7-unit bed and a
  // 0.3-unit post at once. Each set is tuned for its biggest consumer and reused as-is elsewhere;
  // split the texture per part only if the density difference ever actually shows.
  buildSurfaceMaps() {
    // Deterministic: a machine that looks slightly different on every reload is a machine whose
    // screenshots cannot be compared.
    let seed = 0x2f6e2b1;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    // Brushed metal for the cabinet: fine streaks along U, which is what breaks a long highlight
    // into something that reads as rolled steel.
    const brushed = this.surfaceMaps(256, 4, 2.4, (context, size) => {
      context.fillStyle = '#8c8c8c';
      context.fillRect(0, 0, size, size);
      for (let stroke = 0; stroke < size * 4; stroke += 1) {
        const shade = Math.round(96 + random() * 104);
        context.strokeStyle = `rgba(${shade},${shade},${shade},0.42)`;
        context.lineWidth = random() < 0.85 ? 1 : 2;
        context.beginPath();
        const y = random() * size;
        context.moveTo(0, y);
        context.lineTo(size, y);
        context.stroke();
      }
    });

    // Playfield deck: panel seams plus a fine grain. The seams are the important half - a groove
    // with a lit edge is the cheapest thing that tells the eye a surface has been built rather
    // than filled in.
    const deck = this.surfaceMaps(256, 3, 3.6, (context, size) => {
      context.fillStyle = '#767676';
      context.fillRect(0, 0, size, size);
      for (let speck = 0; speck < size * 24; speck += 1) {
        const shade = Math.round(104 + random() * 76);
        context.fillStyle = `rgba(${shade},${shade},${shade},0.3)`;
        context.fillRect(random() * size, random() * size, 1, 1);
      }
      context.strokeStyle = '#e2e2e2';
      context.lineWidth = Math.max(2, size / 96);
      for (const offset of [0, size / 2]) {
        context.beginPath();
        context.moveTo(offset, 0);
        context.lineTo(offset, size);
        context.moveTo(0, offset);
        context.lineTo(size, offset);
        context.stroke();
      }
    });

    this.surfaces = { brushed, deck };
  }

  // The bed's relief, read off the plate art itself so its grooves sit exactly under the painted
  // seams. surfaceMaps repeats square; the bed's UVs span its own width and depth, so the repeat is
  // reset per axis to one tile every DECK_PLATE_TILE units, matching createDeckTexture.
  // withArt adds the plate art itself as the colour map, for the tray inlays; the bed draws it
  // into its own canvas under the markings instead.
  plateSurfaceMaps(width, depth, withArt = false) {
    if (!this.plateBase) {
      this.plateBase = this.surfaceMaps(1024, 1, 2.4, (context, size) => {
        context.filter = 'grayscale(1)';
        context.drawImage(this.deckPlate, 0, 0, size, size);
      });
      this.plateBase.map = this.artTexture(this.deckPlate);
    }
    const maps = {};
    for (const [key, texture] of Object.entries(this.plateBase)) {
      if (key === 'map' && !withArt) continue;
      // clone() shares the image and the upload; only the repeat is per surface.
      maps[key] = texture.clone();
      maps[key].repeat.set(width / DECK_PLATE_TILE, depth / DECK_PLATE_TILE);
    }
    return maps;
  }

  artTexture(image) {
    const art = new THREE.Texture(image);
    art.colorSpace = THREE.SRGBColorSpace;
    art.wrapS = THREE.RepeatWrapping;
    art.wrapT = THREE.RepeatWrapping;
    art.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    art.needsUpdate = true;
    return art;
  }

  // Gold panel frames across the scraper's face, the same motif build_cabinet.py puts on the side
  // walls. The scraper is a plain board in the middle of the shot, and a flat texture on a surface
  // seen this dark reads as nothing; thin lit relief does. Children of the scraper, so they follow
  // it when the geometry panel moves scraperZ. Visual only: they stand FRAME_PROUD in front of the
  // collider's face, a coin's sliver, so a coin pressed against the board overlaps them invisibly.
  frameScraper(width, height, depth) {
    const PANELS = 4;
    const MARGIN = 0.15;
    const GAP = 0.12;
    const BAR = 0.03;
    const FRAME_PROUD = 0.015;
    // Local y: from just above the brass strip (world 0.77) to just under the top edge.
    const bottom = 0.77 + 0.08 - this.scraper.position.y;
    const top = height / 2 - 0.12;
    const panelWidth = (width - 2 * MARGIN - (PANELS - 1) * GAP) / PANELS;
    const material = new THREE.MeshStandardMaterial({
      color: PALETTE.gold,
      metalness: 0.9,
      roughness: 0.3,
      emissive: PALETTE.gold,
      emissiveIntensity: 0.3,
      envMap: this.environmentTexture,
      envMapIntensity: 0.55,
    });
    const z = -depth / 2 - FRAME_PROUD / 2;
    const bar = (w, h, x, y) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, FRAME_PROUD), material);
      mesh.position.set(x, y, z);
      this.scraper.add(mesh);
    };
    for (let index = 0; index < PANELS; index += 1) {
      const left = -width / 2 + MARGIN + index * (panelWidth + GAP);
      const centre = left + panelWidth / 2;
      bar(panelWidth, BAR, centre, bottom + BAR / 2);
      bar(panelWidth, BAR, centre, top - BAR / 2);
      bar(BAR, top - bottom, left + BAR / 2, (top + bottom) / 2);
      bar(BAR, top - bottom, left + panelWidth - BAR / 2, (top + bottom) / 2);
    }
  }

  // The tray inlays' surface: plate art where it loaded, the drawn deck grid where it did not.
  // White under the art, because glassTint multiplied into an already-teal image crushes it; the
  // art is painted in that family, so the upper tier keeps its tint either way.
  inlaySurface(width, depth) {
    if (!this.deckPlate) return { ...this.surfaces.deck, color: PALETTE.glassTint };
    return { ...this.plateSurfaceMaps(width, depth, true), color: DECK_PLATE_INLAY_TINT };
  }

  // One height field in, a roughness map and the normal map that agrees with it out.
  surfaceMaps(size, repeat, strength, draw) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    draw(context, size);
    const height = context.getImageData(0, 0, size, size);

    const normalCanvas = document.createElement('canvas');
    normalCanvas.width = size;
    normalCanvas.height = size;
    const normalContext = normalCanvas.getContext('2d');
    const normal = normalContext.createImageData(size, size);
    // Wrapped central differences, so the normal map tiles exactly where the height field does.
    // Sampling the red channel only: the height field is greyscale by construction.
    const at = (x, y) => height.data[((((y + size) % size) * size + ((x + size) % size)) * 4)];
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const dx = ((at(x + 1, y) - at(x - 1, y)) / 255) * strength;
        const dy = ((at(x, y + 1) - at(x, y - 1)) / 255) * strength;
        const length = Math.hypot(dx, dy, 1);
        const index = (y * size + x) * 4;
        normal.data[index] = (-dx / length) * 127.5 + 127.5;
        normal.data[index + 1] = (-dy / length) * 127.5 + 127.5;
        normal.data[index + 2] = (1 / length) * 127.5 + 127.5;
        normal.data[index + 3] = 255;
      }
    }
    normalContext.putImageData(normal, 0, 0);

    const roughnessMap = new THREE.CanvasTexture(canvas);
    const normalMap = new THREE.CanvasTexture(normalCanvas);
    for (const texture of [roughnessMap, normalMap]) {
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(repeat, repeat);
    }
    return { roughnessMap, normalMap };
  }

  addStaticBox(width, height, depth, x, y, z, color, options = {}) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(width, height, depth),
      new THREE.MeshStandardMaterial({
        color,
        roughness: options.roughness ?? 0.78,
        metalness: options.metalness ?? 0.16,
        roughnessMap: options.roughnessMap ?? null,
        normalMap: options.normalMap ?? null,
        envMap: options.envMap ?? null,
        envMapIntensity: options.envMapIntensity ?? 1,
        emissive: options.emissive ?? 0x000000,
        emissiveIntensity: options.emissiveIntensity ?? 0,
        map: options.map ?? null,
      }),
    );
    mesh.position.set(x, y, z);
    mesh.receiveShadow = this.quality.shadows && Boolean(options.receiveShadow);
    this.scene.add(mesh);
    if (!options.visualOnly) {
      const collisionWidth = options.collisionWidth ?? width;
      const collisionHeight = options.collisionHeight ?? height;
      const collisionDepth = options.collisionDepth ?? depth;
      const body = new CANNON.Body({ mass: 0, material: this.groundMaterial });
      body.collisionRole = options.collisionRole ?? null;
      body.addShape(new CANNON.Box(new CANNON.Vec3(collisionWidth / 2, collisionHeight / 2, collisionDepth / 2)));
      body.position.set(
        options.collisionX ?? x,
        options.collisionY ?? y,
        options.collisionZ ?? z,
      );
      this.world.addBody(body);
      // layoutGeometry() moves these again when a geometry slider does; it needs the collider and
      // the offsets it was built with, and nothing else keeps a static body reachable.
      mesh.userData.body = body;
      mesh.userData.collisionHalfZ = collisionDepth / 2;
      mesh.userData.collisionZOffset = (options.collisionZ ?? z) - z;
    }
    return mesh;
  }

  // The fixed rear deck reaches from the moving tray's back edge at full extension to the back
  // panel, and a long tray on a short bed reaches the panel on its own - leaving this nothing to
  // cover, or less than nothing. It stays a real box at a sliver's depth either way: cannon-es
  // accepts a negative half extent without complaint and turns the box inside out, so coins fall
  // straight through it, and the mesh is hidden so the sliver is not a bright seam under the tray.
  static rearDeckSpan() {
    const front = GAME.pusherOriginZ - GAME.pusherAmplitude
      + GAME.pusherDepth / 2 + GAME.pusherRearExtension - 0.15;
    const span = GAME.playfieldBackZ - 0.05 - front;
    return {
      centre: front + span / 2,
      depth: Math.max(span, 0.02),
      inlayDepth: Math.max(span - 0.12, 0.02),
      covers: span > 0.02,
    };
  }

  // Move, and optionally restretch, one box along Z. Depth is baked into BoxGeometry, so the
  // stretch rides on scale.z against the depth the part was built with, and the static collider
  // addStaticBox left on the mesh follows by the same factor.
  placeBox(mesh, z, depth) {
    const built = mesh.geometry.parameters?.depth;
    mesh.position.z = z;
    const stretch = depth && built ? depth / built : 1;
    if (depth && built) mesh.scale.z = stretch;
    const body = mesh.userData.body;
    if (!body) return;
    body.position.z = z + mesh.userData.collisionZOffset;
    if (depth && built) {
      body.shapes[0].halfExtents.z = mesh.userData.collisionHalfZ * stretch;
      body.shapes[0].updateConvexPolyhedronRepresentation();
      body.updateBoundingRadius();
    }
    body.aabbNeedsUpdate = true;
  }

  // Re-place every part the geometry panel owns, from whatever GAME currently holds. Called once
  // at the end of buildMachine and again on each slider move; the build's own literals are the
  // sizes the geometry was baked at, and only this decides where anything ends up.
  layoutGeometry() {
    const front = GAME.playfieldFrontZ;
    const back = GAME.playfieldBackZ;
    const depth = back - front;
    const centre = (back + front) / 2;

    this.placeBox(this.bed, centre, depth);
    this.placeBox(this.backPanel, back + 0.05);
    this.placeBox(this.frontTrim, front - 0.02);
    for (const glass of this.glassPanes) this.placeBox(glass, centre, depth + 0.2);
    for (const bar of this.neonBars) this.placeBox(bar, centre, depth + 0.2);
    for (const { mesh, offset } of this.chuteParts) this.placeBox(mesh, chuteZ() + offset);
    for (const { mesh, front: isFront } of this.shellPosts) {
      mesh.position.z = isFront ? front + 0.1 : back - 0.1;
    }
    for (const skirt of this.shellSkirts) this.placeBox(skirt, centre, depth - 0.2);
    for (const { mesh, offset } of this.headboardParts) mesh.position.z = back + offset;
    // The cabinet model is fitted to the playfield's centre, so it travels with it, and it
    // stretches with the bed's length: a fixed-size machine standing around a longer playfield
    // is a bed growing out through its own front panel. Scale 1 is the default length, which is
    // the length the model was hand-fitted against.
    if (this.cabinet) {
      this.cabinet.position.z = centre;
      this.cabinet.scale.z = depth / MACHINE_GEOMETRY_DEFAULTS.lowerLength;
    }

    // Moving deck: the blade end is fixed to the centre, the rear tail carries the length.
    const deckDepth = GAME.pusherDepth + GAME.pusherRearExtension;
    const deckCentre = GAME.pusherRearExtension / 2;
    for (const { mesh, inset } of this.trayParts) this.placeBox(mesh, deckCentre, deckDepth - inset);
    if (this.pusherDeckShape) {
      this.pusherDeckShape.halfExtents.z = deckDepth / 2;
      this.pusherDeckShape.updateConvexPolyhedronRepresentation();
      this.pusherBody.shapeOffsets[0].z = deckCentre;
      this.pusherBody.updateBoundingRadius();
      this.pusherBody.aabbNeedsUpdate = true;
    }

    const rear = CoinPusher.rearDeckSpan();
    this.rearDeck.visible = rear.covers;
    this.rearDeckTop.visible = rear.covers;
    this.placeBox(this.rearDeck, rear.centre, rear.depth);
    this.placeBox(this.rearDeckTop, rear.centre, rear.inlayDepth);

    this.placeBox(this.scraper, GAME.scraperZ);
    this.placeBox(this.scraperStrip, GAME.scraperZ - 0.02);
    this.updateLauncherVisuals();
  }

  // The geometry panel's commit. Everything lands at once - meshes, colliders and the payout
  // edge - because a machine whose collision does not match what it looks like is worse than a
  // frame of visible stretch. `reseed` is the drag's release: coins settled against the old
  // layout can be pinched by a moved part or left hanging over a gap, so the pile is rebuilt.
  setMachineGeometry(patch, { reseed = false } = {}) {
    this.geometry = applyMachineGeometry({ ...this.geometry, ...patch });
    this.layoutGeometry();
    if (reseed) this.resetPile();
    return this.geometry;
  }

  // Rounded-rectangle profile shared by the headboard and its glow frame.
  static roundedRect(width, height, radius) {
    const shape = new THREE.Shape();
    const w = width / 2;
    const h = height / 2;
    shape.moveTo(-w + radius, -h);
    shape.lineTo(w - radius, -h);
    shape.quadraticCurveTo(w, -h, w, -h + radius);
    shape.lineTo(w, h - radius);
    shape.quadraticCurveTo(w, h, w - radius, h);
    shape.lineTo(-w + radius, h);
    shape.quadraticCurveTo(-w, h, -w, h - radius);
    shape.lineTo(-w, -h + radius);
    shape.quadraticCurveTo(-w, -h, -w, -h + radius);
    return shape;
  }

  createBackdropTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 512;
    const context = canvas.getContext('2d');
    const gradient = context.createLinearGradient(0, 0, 0, 512);
    gradient.addColorStop(0, '#030710');
    gradient.addColorStop(0.46, '#06182a');
    gradient.addColorStop(0.62, '#0b3b46');
    gradient.addColorStop(0.78, '#061a28');
    gradient.addColorStop(1, '#030710');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 512);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  createBadgeTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const context = canvas.getContext('2d');
    const hexagon = (radius) => {
      context.beginPath();
      for (let corner = 0; corner < 6; corner += 1) {
        const angle = (Math.PI / 3) * corner - Math.PI / 2;
        const method = corner === 0 ? 'moveTo' : 'lineTo';
        context[method](128 + radius * Math.cos(angle), 128 + radius * Math.sin(angle));
      }
      context.closePath();
    };
    const fill = context.createLinearGradient(0, 0, 256, 256);
    fill.addColorStop(0, '#2ee6d2');
    fill.addColorStop(0.55, '#00c8b4');
    fill.addColorStop(1, '#3b4fd8');
    hexagon(112);
    context.fillStyle = fill;
    context.fill();
    hexagon(112);
    context.strokeStyle = '#f2c94c';
    context.lineWidth = 9;
    context.stroke();
    context.fillStyle = '#041018';
    context.font = '700 92px Orbitron, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('CP', 128, 134);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  // The room the cabinet stands in: graded sky, wet-looking floor, corridor light columns.
  buildBackdrop() {
    this.scene.background = this.createBackdropTexture();
    this.addHall();

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.MeshStandardMaterial({
        color: PALETTE.shellDeep,
        metalness: 0.92,
        roughness: 0.24,
        envMap: this.environmentTexture,
        envMapIntensity: 0.7,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -2.78;
    floor.receiveShadow = this.quality.shadows;
    this.scene.add(floor);

    // Pool of light the cabinet sits in — additive so it never darkens the floor.
    const pool = new THREE.Mesh(
      new THREE.PlaneGeometry(16, 22),
      new THREE.MeshBasicMaterial({
        map: this.glowTexture,
        color: PALETTE.goldSoft,
        transparent: true,
        opacity: 0.26,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(0, -2.74, -0.5);
    this.scene.add(pool);

    const grid = new THREE.GridHelper(64, 32, PALETTE.gold, PALETTE.gold);
    grid.position.y = -2.76;
    Object.assign(grid.material, { transparent: true, opacity: 0.07, depthWrite: false });
    this.scene.add(grid);

  }

  // Optional cabinet shell, standing in for the procedural furniture. Absent is a supported state
  // and must stay cheap and quiet: a missing file is not an error, it just means the procedural
  // cabinet keeps its job.
  //
  // The model is generated, not downloaded - tools/build_cabinet.py authors it at the world origin
  // the mount expects, in the palette the rest of the machine already uses, and with its emissive
  // trim baked in. That is why nothing here fits, rotates, hides or re-lights it: the apparatus
  // that did all four is gone, and tests/cabinet.test.js is what keeps the model honest enough to
  // not need it back. Rebuild with:
  //   /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/build_cabinet.py
  //
  // Only the furniture is replaced. The bed, glass, tray, scraper and rails stay exactly where
  // they are, because their positions are the physics - a model cannot take those over without
  // every collision body moving with it, and then the machine plays differently than it looks.
  async loadCabinet() {
    let model;
    try {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      model = await new GLTFLoader().loadAsync('/models/cabinet.glb');
    } catch {
      return; // no cabinet.glb - procedural furniture stands
    }
    const cabinet = model.scene;
    // scene.environment is never set: loadCoinEnvironment only builds the PMREM texture, and every
    // material is handed it one at a time with its own intensity. A model that skips this pass has
    // no reflection at all - and reflection is the shell's entire look, a near-black polished body
    // that is only legible by what it reflects.
    cabinet.traverse((object) => {
      if (!object.isMesh) return;
      object.castShadow = this.quality.shadows;
      object.receiveShadow = this.quality.shadows;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (!material || material.envMap || material.transparent) continue;
        material.envMap = this.environmentTexture;
        material.envMapIntensity = 0.55;
        material.needsUpdate = true;
      }
    });
    // An unrotated parent, purely so the geometry panel can stretch the machine along world Z.
    // The stretch is close to free from where the player sits: the camera looks down Z, so the
    // front elevation, which is all the artwork anyone reads, keeps its proportions however deep
    // the machine gets. What it is not free of is the front face - see build_cabinet.py on why
    // that face is pinned to the bed's front lip rather than standing proud of it.
    const mount = new THREE.Group();
    mount.add(cabinet);
    this.scene.add(mount);
    this.cabinet = mount;
    // The mount carries the playfield's centre and length, and buildMachine's layout pass has
    // already been and gone by the time a cabinet finishes loading - so run it again rather than
    // placing the mount here and having two places that decide where the machine stands.
    this.layoutGeometry();

    // Two exceptions to hiding the procedural furniture. The side glass is already tuned - opacity
    // 0.15 over envMapIntensity 0.45 - and the model deliberately stops 0.3 short of it rather
    // than reproduce it. The payout chute is placed off chuteZ() in world space instead of riding
    // the mount, so a model part cannot follow it: at the longest bed the two would sit about 1.2
    // apart. All of the chute is below the frame's bottom edge either way.
    const keep = new Set([...this.glassPanes, ...this.chuteParts.map((part) => part.mesh)]);
    for (const mesh of this.decor) if (!keep.has(mesh)) mesh.visible = false;

    // Bring the mechanical surfaces into the shell's lighting instead of re-colouring them. Two
    // adjustments, both fixing something specific:
    //
    // envMap, because none of these five ever had one. Every part of the shell does (the traverse
    // above), so without it the tray, its inlay, the blade and the scraper are the only unlit,
    // unreflective things in the machine, and they read as flat plastic parked inside polished
    // metal. This is the whole of what "looks pasted on" meant.
    //
    // emissive off, because the scraper carries gold at 0.35. Against procedural furniture that
    // reads as a lit guard rail; against a near-black shell it is the brightest surface in the
    // machine and reads as a painted mustard board.
    //
    // What is deliberately NOT touched is their colour. The tray inlay and the rear deck are
    // glassTint, the same family the bed's drawn deck texture sits in, and that shared tint is
    // what separates the upper tier from the lower one. Re-skinning all five in one dark metal
    // does fix both complaints and takes the tier read with it - the machine goes uniformly black.
    // Emissive parts that animate. glTF shares one material across every mesh that uses it, so
    // each of these needs its own copy or the whole set pulses in lockstep - the same trap the old
    // cabinetGlow pass documented. Node transforms are all applied in the build script, so the
    // geometry's own bounding box is already in model-local coordinates.
    cabinet.traverse((object) => {
      if (!object.isMesh) return;
      const isRing = object.name.startsWith('marquee_ring');
      const isColumn = object.name.startsWith('wall_column');
      if (!isRing && !isColumn) return;
      object.material = object.material.clone();
      object.geometry.computeBoundingBox();
      const box = object.geometry.boundingBox;
      this.shellNeon.push({
        material: object.material,
        base: object.material.emissiveIntensity,
        // Phase off the part's own place in the machine, so the wave has somewhere to travel:
        // rings off their radius, which runs the chase outwards through the marquee; columns off
        // their depth, which runs the breath away down the corridor.
        phase: isRing ? box.max.x * 1.15 : ((box.min.z + box.max.z) / 2) * 0.5,
      });
    });

    for (const mesh of this.shellSurfaces) {
      mesh.material.envMap = this.environmentTexture;
      mesh.material.envMapIntensity = 0.55;
      mesh.material.emissiveIntensity = 0;
      mesh.material.needsUpdate = true;
    }
  }

  // Fit a downloaded prop by its own X extent and re-origin it so the group's position means
  // "centred here, standing on here" - which is the only thing the callers below want to say.
  fitProp(source, width) {
    const prop = source.clone(true);
    prop.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(prop);
    const size = box.getSize(new THREE.Vector3());
    const scale = size.x > 0 ? width / size.x : 1;
    prop.scale.setScalar(scale);
    const centre = box.getCenter(new THREE.Vector3()).multiplyScalar(scale);
    prop.position.set(-centre.x, -box.min.y * scale, -centre.z);
    prop.traverse((object) => {
      if (!object.isMesh) return;
      object.castShadow = this.quality.shadows;
      object.receiveShadow = this.quality.shadows;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (!material || material.envMap || material.transparent) continue;
        material.envMap = this.environmentTexture;
        material.envMapIntensity = 0.55;
        material.needsUpdate = true;
      }
    });
    const group = new THREE.Group();
    group.add(prop);
    return group;
  }

  // Bonus stage: the slot machine at the top of the machine, and the chest that drops into the tray
  // to start it. The slot is pure decoration; the chest is a real body in the world.
  buildBonusStage() {
    this.chests = [];
    this.chestPool = [];
    // Chests waiting for the reels. One chest, one spin - see spinSlot.
    this.slotQueue = [];
    this.slotHold = 0;
    this.coinRain = null;
    this.quake = null;
    if (this.chestModelSource) {
      // Kept off the scene as the template every dropped chest is cloned from - a chest takes over
      // two minutes to ride the machine, so several are in flight whenever thresholds come close.
      this.chestPrototype = this.fitProp(this.chestModelSource, GAME.chestWidth);
      const size = new THREE.Box3().setFromObject(this.chestPrototype).getSize(new THREE.Vector3());
      // fitProp stands the model on the group's origin; a cannon body's origin is its centre. Sink
      // the model half its height inside the group and the group can track the body's pose
      // directly, tumbling included.
      this.chestPrototype.children[0].position.y -= size.y / 2;
      this.chestHalfExtents = new CANNON.Vec3(size.x / 2, size.y / 2, size.z / 2);
      this.chestHalfHeight = size.y / 2;
      this.chestHalfDepth = size.z / 2;
    }
    if (!this.slotModelSource) return;
    const slot = this.fitProp(this.slotModelSource, GAME.slotWidth);
    slot.rotation.y = GAME.slotYaw;
    slot.position.set(0, GAME.slotY, GAME.slotZ);
    this.scene.add(slot);
    this.slotMesh = slot;

    // The readout goes over the model's own three reel windows, which are blank panes: find them by
    // material and take their footprint, so the panel keeps fitting if slotWidth or slotY move.
    const windows = new THREE.Box3();
    slot.updateMatrixWorld(true);
    slot.traverse((object) => {
      if (object.isMesh && object.material?.name === GAME.slotReelMaterial) {
        windows.union(new THREE.Box3().setFromObject(object));
      }
    });
    if (windows.isEmpty()) return;

    // ponytail: three digits drawn to a canvas, not three turning drums. The machine is small at
    // the top of the shot, where a real spinning reel is a grey smear, and the model's drums are
    // static geometry with no bones to turn anyway. Upgrade path: animated drums if the slot ever
    // gets a camera of its own.
    const size = windows.getSize(new THREE.Vector3());
    const canvas = document.createElement('canvas');
    canvas.width = 384;
    canvas.height = Math.round((384 * size.y) / size.x);
    this.reelContext = canvas.getContext('2d');
    this.reelTexture = new THREE.CanvasTexture(canvas);
    this.reelTexture.colorSpace = THREE.SRGBColorSpace;
    // Three question marks until a chest pays: the machine must not sit there displaying a win it
    // has not paid yet. They stay on the winning symbol afterwards, as a real one does.
    this.reelSymbols = [GAME.slotIdleSymbol, GAME.slotIdleSymbol, GAME.slotIdleSymbol];
    this.drawReels();

    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(size.x, size.y),
      new THREE.MeshBasicMaterial({ map: this.reelTexture, toneMapped: false }),
    );
    // Just proud of the panes' front face. The player stands at -Z, so the plane faces that way.
    const centre = windows.getCenter(new THREE.Vector3());
    panel.position.set(centre.x, centre.y, windows.min.z - 0.01);
    panel.rotation.y = Math.PI;
    this.scene.add(panel);
    this.reelPanel = panel;
  }

  drawReels() {
    const context = this.reelContext;
    if (!context) return;
    const { width, height } = context.canvas;
    context.fillStyle = REEL_GROUND;
    context.fillRect(0, 0, width, height);
    // A finished spin only: while one runs, reel three cycles past the symbol the first two locked
    // on, and the glow must not fire on that flicker. The idle face never counts either.
    const win = !this.slotSpin && this.reelSymbols[0] !== GAME.slotIdleSymbol
      ? slotWin(this.reelSymbols)
      : null;
    context.strokeStyle = win ? '#f2c94c' : '#1d5c66';
    context.lineWidth = 8;
    context.strokeRect(4, 4, width - 8, height - 8);
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    const ink = win ? '#ffe9a3' : '#eef7fb';
    this.reelSymbols.forEach((symbol, index) => {
      const x = width * (index + 0.5) / 3;
      const paint = REEL_PAINTERS[symbol];
      if (paint) {
        paint(context, x, height / 2, height * 0.62, ink);
        return;
      }
      context.fillStyle = ink;
      context.font = 'bold 104px system-ui, sans-serif';
      context.fillText(String(symbol), x, height / 2 + 4);
    });
    this.reelTexture.needsUpdate = true;
  }

  // A chest body and its model, pooled: retired chests come back rather than rebuilding the clone.
  acquireChest() {
    const pooled = this.chestPool.pop();
    if (pooled) return pooled;
    const mesh = this.chestPrototype.clone(true);
    mesh.visible = false;
    this.scene.add(mesh);
    const body = new CANNON.Body({
      mass: GAME.chestMass,
      // Its own material, at GAME.chestFrictionScale times the coin's friction: a resting box
      // makes about a fifth of the contacts a coin's rim does, and syncFrictionGravity divides the
      // world's whole friction budget by that contact count, so a box on the coin material keeps
      // only a fraction of the grip - enough for the payout tilt alone to slide it off the bed.
      material: this.chestMaterial,
      allowSleep: true,
      shape: new CANNON.Box(this.chestHalfExtents),
    });
    body.linearDamping = GAME.chestLinearDamping;
    body.angularDamping = GAME.chestAngularDamping;
    const chest = { body, mesh, drop: null };
    // Touchdown is whatever it hits first - the tray, or the coins already on it. It is dust
    // only: the prize is paid when the chest falls off the front, not when it lands.
    body.addEventListener('collide', () => {
      if (!chest.drop || chest.drop.landed) return;
      chest.drop.landed = true;
      const { x, y, z } = body.position;
      this.emitParticles(x, y, z, 14, true);
    });
    return chest;
  }

  // Random across the tray, re-rolled while it would land on a chest already sitting at the drop
  // line: one payout can clear two thresholds, and two boxes spawned inside each other in the same
  // frame shove one another out of the machine.
  chestDropX() {
    const clear = (x) => this.chests.every(({ body }) => Math.abs(body.position.x - x) > GAME.chestWidth
      || Math.abs(body.position.z - chestDropZ(this.chestHalfDepth)) > 2 * this.chestHalfDepth);
    let x = 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      x = (Math.random() * 2 - 1) * CHEST_DROP_HALF_WIDTH;
      if (clear(x)) break;
    }
    return x;
  }

  // Drop a bonus chest into the tray. It then rides the machine like a coin - swept off the tray
  // onto the lower bed, shoved forward by the blade, over the payout lip - and `onWin` fires once,
  // when the reels have spun after it has fully dropped - three of a kind pays, a miss does not. A chest still on the machine has paid
  // nothing yet.
  dropChest(onWin) {
    if (!this.chestPrototype) return false;
    const chest = this.acquireChest();
    const { body } = chest;
    body.position.set(this.chestDropX(), GAME.chestStartY, chestDropZ(this.chestHalfDepth));
    body.previousPosition.copy(body.position);
    body.interpolatedPosition.copy(body.position);
    body.velocity.setZero();
    body.angularVelocity.set(0, 1.8, 0);
    body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), Math.random() * Math.PI * 2);
    body.previousQuaternion.copy(body.quaternion);
    body.interpolatedQuaternion.copy(body.quaternion);
    body.aabbNeedsUpdate = true;
    body.wakeUp();
    this.world.addBody(body);
    chest.mesh.visible = true;
    chest.drop = {
      landed: false,
      lowerBedLanded: false,
      falling: false,
      counted: false,
      onWin,
    };
    this.chests.push(chest);
    return true;
  }

  // Take one chest out of the world and back into the pool.
  retireChest(index) {
    const chest = this.chests[index];
    if (!chest) return;
    this.world.removeBody(chest.body);
    chest.body.velocity.setZero();
    chest.body.angularVelocity.setZero();
    chest.mesh.visible = false;
    chest.drop = null;
    this.chests.splice(index, 1);
    this.chestPool.push(chest);
  }

  cancelChest() {
    for (let index = this.chests.length - 1; index >= 0; index -= 1) this.retireChest(index);
    this.slotSpin = null;
    this.slotQueue = [];
    this.coinRain = null;
    this.quake = null;
    this.camera.position.copy(this.cameraBase);
  }

  // Money-bag payout: coins rain over the upper tray. Returns how many were scheduled, which is
  // what the HUD announces - a rain arriving on top of one still running just adds to the queue.
  rainCoins(count = GAME.coinRainCount) {
    this.coinRain = { remaining: (this.coinRain?.remaining ?? 0) + count, timer: 0 };
    return count;
  }

  updateCoinRain(delta) {
    const rain = this.coinRain;
    if (!rain) return;
    rain.timer -= delta;
    // Bounded by remaining, so a long frame catches up rather than dropping coins on the floor.
    while (rain.remaining > 0 && rain.timer <= 0) {
      rain.timer += GAME.coinRainInterval;
      rain.remaining -= 1;
      this.spawnCoin(
        (Math.random() - 0.5) * 2 * GAME.coinRainHalfWidth,
        GAME.coinRainY + Math.random() * 0.4,
        GAME.dropZoneZ + (Math.random() - 0.5) * GAME.coinRainDepth,
      );
    }
    if (rain.remaining <= 0) this.coinRain = null;
  }

  // Gild payout: turns the coins gildTargets picked. Returns how many changed, which is what the
  // HUD announces and, on an empty machine, is legitimately zero.
  gildCoins(ratio = GAME.gildRatio) {
    const gilded = gildTargets(this.activeCoins, ratio);
    for (const coin of gilded) {
      coin.isPremium = true;
      coin.mesh.material = this.coinMaterials.premium;
    }
    return gilded.length;
  }

  // Earthquake payout. Overlapping quakes extend rather than stack: two events shaking the same
  // pile twice as hard would fire coins into the glass.
  shakeTable(seconds = GAME.quakeSeconds) {
    this.quake = { remaining: Math.max(this.quake?.remaining ?? 0, seconds) };
    return seconds;
  }

  updateQuake(delta) {
    const quake = this.quake;
    if (!quake) return;
    quake.remaining -= delta;
    for (const coin of this.activeCoins) {
      // A counted coin is already down the chute; shaking it only fights its recycle.
      if (coin.counted) continue;
      const kick = quakeKick();
      coin.body.velocity.x += kick.x * delta;
      coin.body.velocity.y += kick.y * delta;
      coin.body.velocity.z += kick.z * delta;
      coin.body.wakeUp();
    }
    // reducedMotion drops the camera work and keeps the physics, the same rule the neon follows.
    if (!this.quality.reducedMotion) {
      // Decaying, so the shake settles instead of stopping dead on the last frame.
      const amount = GAME.quakeCameraShake * Math.min(1, quake.remaining / GAME.quakeSeconds);
      this.camera.position.set(
        this.cameraBase.x + (Math.random() - 0.5) * amount,
        this.cameraBase.y + (Math.random() - 0.5) * amount,
        this.cameraBase.z,
      );
    }
    if (quake.remaining > 0) return;
    this.quake = null;
    this.camera.position.copy(this.cameraBase);
  }

  updateBonus(delta) {
    this.updateCoinRain(delta);
    this.updateQuake(delta);
    // Backwards, because a retired chest is spliced out of the list.
    for (let index = this.chests.length - 1; index >= 0; index -= 1) {
      const { body, mesh, drop } = this.chests[index];
      mesh.position.copy(body.interpolatedPosition);
      mesh.quaternion.copy(body.interpolatedQuaternion);
      // The same phases a coin runs through: over the lip, then paid once it is under the bed.
      // ponytail: no hold timer. A chest lives until it drops - chestWidth is kept under what the
      // scraper can clear (tests/physics.test.js) and the blade spans the whole bed, so nothing
      // can park out of its reach.
      settleChestOnLowerBed(body, drop, this.chestHalfHeight, this.chestHalfDepth);
      const phase = coinPhase(drop, body.position);
      if (phase === 'cross') {
        drop.falling = true;
        // The chest gets the same nudge a coin does. It used to be left to the pile, and a chest
        // balanced on the lip - eight times a coin's friction, 0.9 damping - is exactly what the
        // pile cannot shift: its centre of mass is still over the bed, so it does not even tip.
        nudgeOverLip(body);
      } else if (phase === 'score') {
        drop.counted = true;
        const { x, z } = body.position;
        this.emitParticles(x, GAME.trayY, z, 18, true);
        this.spinSlot(drop.onWin);
      }
      // Paid or not, it leaves the world down the chute rather than blinking out at the tray line.
      if (phase === 'lost' || body.position.y < GAME.lostY) this.retireChest(index);
    }

    const spin = this.slotSpin;
    if (!spin) {
      // Between two chests' spins: hold the finished faces long enough to read them, then take
      // the next chest off the queue. Nothing to hold for while the queue is empty.
      if (this.slotQueue.length === 0) return;
      this.slotHold -= delta;
      if (this.slotHold <= 0) this.startSpin(this.slotQueue.shift());
      return;
    }
    spin.elapsed += delta;
    // Reels lock left to right over the spin, the last one on the final beat. Until a reel locks
    // it cycles off the clock, which is a spinning drum as far as a glance from the bed goes.
    const symbols = this.reelSymbols.map((symbol, index) => {
      const lockAt = GAME.slotSpinSeconds * (index + 1) / 3;
      if (spin.elapsed >= lockAt) return spin.faces[index];
      // Each reel runs at its own rate. A shared clock with a fixed per-reel offset was fine over
      // ten filler digits, but over a two-symbol strip it puts reels one and three in lock-step
      // for the whole spin; drifting rates keep the three faces mixing. The win glow does not
      // depend on this - see drawReels.
      return REEL_STRIP[Math.floor(spin.elapsed * (18 + index * 5)) % REEL_STRIP.length];
    });
    if (symbols.some((symbol, index) => symbol !== this.reelSymbols[index])) {
      this.reelSymbols = symbols;
      this.drawReels();
    }
    if (spin.elapsed < GAME.slotSpinSeconds) return;
    // Cleared before the last redraw, because that is what turns the glow on - see drawReels.
    this.slotSpin = null;
    this.reelSymbols = spin.faces;
    this.drawReels();
    const win = slotWin(spin.faces);
    // Confetti on a win only - a miss gets the reels it earned and nothing else.
    if (win !== null) {
      this.emitParticles(0, this.reelPanel.position.y, this.reelPanel.position.z, 18, true);
    }
    this.slotHold = GAME.slotHoldSeconds;
    spin.notify?.(win);
  }

  // onResult is called with the slotWin result - the symbol three reels showed, or null.
  spinSlot(onResult) {
    if (!this.reelContext) {
      onResult?.(slotWin(rollSlotResult()));
      return;
    }
    // One chest, one spin. A second chest paying while the reels are still turning queues up and
    // spins for itself once they stop: it rode the whole machine to earn that spin, and two chests
    // sharing one set of faces reads as the machine paying twice for a single result.
    if (this.slotSpin || this.slotQueue.length > 0) {
      this.slotQueue.push(onResult);
      return;
    }
    this.startSpin(onResult);
  }

  startSpin(notify) {
    this.slotSpin = { elapsed: 0, faces: rollSlotResult(), notify };
  }

  // Matte-painted casino hall. The camera never moves, so one unlit plane is the entire set - no
  // side walls, no room geometry, nothing lit.
  //
  // The numbers below are one derivation, not a set of knobs. Given the camera (9.2 up, 10.4 back,
  // 56° fov, 39° pitch) the frame's top ray meets the HALL_Z plane 5.13 above the floor, so the
  // strip of the painting the player can ever see is the 7.91 units from the real floor at -2.78
  // up to there. HALL_HORIZON is where the painting's own horizon sits, measured from the bottom
  // of the image, and the plane is sized and sunk so that line lands exactly on the real floor:
  //   height >= 7.91 / (1 - HALL_HORIZON)   and   y = -2.78 + height * (0.5 - HALL_HORIZON)
  // Height is taken above that minimum on purpose - it is what widens the plane, and at the bare
  // minimum the plane is only as wide as the frame, so a wide window shows past its edges.
  // Re-solve all of it together after touching the camera or swapping the art; if the painted
  // horizon drifts off the real floor line the whole illusion goes with it.
  addHall() {
    const HALL_Z = 11;
    const HALL_ASPECT = 2.334;
    // Measured off the art, not guessed: the row where the corridor converges. Everything below
    // it is painted floor, which the real floor plane hides.
    const HALL_HORIZON = 0.387;
    // Above the 12.9 minimum on purpose, and not only for the width. Scaling the plane up moves
    // the visible band down the painting: at the minimum the frame is filled by the nearest
    // ceiling ring, and it takes roughly this much to trade that for the receding corridor, which
    // is what actually reads as a hall. The cost is magnification - about 370 source pixels
    // stretched over the band - which the fog, the defocused look, and now the cabinet standing
    // in front of most of it absorb.
    const height = 24;
    const hall = new THREE.Mesh(
      new THREE.PlaneGeometry(height * HALL_ASPECT, height),
      // Unlit on purpose: a matte painting carries its own light, and the scene's accent lamps
      // would smear across it as flat blobs. Fog still applies, which is what sells the depth.
      new THREE.MeshBasicMaterial({ map: this.hallTexture, color: 0xcdd8e2 }),
    );
    hall.position.set(0, -2.78 + height * (0.5 - HALL_HORIZON), HALL_Z);
    hall.rotation.y = Math.PI;
    this.scene.add(hall);
  }

  // Headboard: glowing arch frame, dark inner panel, hexagon CP badge, gold sill.
  buildHeadboard() {
    const extrude = { depth: 0.3, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 2, curveSegments: 10 };
    const frame = new THREE.Mesh(
      new THREE.ExtrudeGeometry(CoinPusher.roundedRect(BED_WIDTH + 1.5, 3.5, 0.85), extrude),
      new THREE.MeshStandardMaterial({
        ...this.surfaces.brushed,
        color: PALETTE.shellRaised,
        emissive: PALETTE.gold,
        emissiveIntensity: 0.24,
        roughness: 0.32,
        metalness: 0.62,
        envMap: this.environmentTexture,
        envMapIntensity: 0.9,
      }),
    );
    this.headboardParts.push({ mesh: frame, offset: 0.5 });
    frame.position.set(0, 1.75, GAME.playfieldBackZ + 0.5);
    this.scene.add(frame);
    this.decor.push(frame);
    this.neon.push(frame);

    const panel = new THREE.Mesh(
      new THREE.ExtrudeGeometry(CoinPusher.roundedRect(BED_WIDTH + 0.6, 2.7, 0.6), extrude),
      new THREE.MeshStandardMaterial({
        ...this.surfaces.brushed,
        map: this.createHeadboardTexture(768, BED_WIDTH + 0.6, 2.7),
        color: PALETTE.white,
        roughness: 0.42,
        metalness: 0.55,
        envMap: this.environmentTexture,
        envMapIntensity: 0.5,
      }),
    );
    this.headboardParts.push({ mesh: panel, offset: 0.34 });
    panel.position.set(0, 1.75, GAME.playfieldBackZ + 0.34);
    this.scene.add(panel);
    this.decor.push(panel);

    const badge = new THREE.Mesh(
      new THREE.PlaneGeometry(1.35, 1.35),
      new THREE.MeshStandardMaterial({
        map: this.badgeTexture,
        emissiveMap: this.badgeTexture,
        emissive: PALETTE.white,
        emissiveIntensity: 0.55,
        transparent: true,
        roughness: 0.4,
      }),
    );
    this.headboardParts.push({ mesh: badge, offset: -0.09 });
    badge.position.set(0, 1.62, GAME.playfieldBackZ - 0.09);
    badge.rotation.y = Math.PI;
    this.scene.add(badge);
    // The badge belongs to the headboard, so it has to go with it - a CP hexagon left floating
    // where a hidden panel used to be is worse than no badge at all.
    this.decor.push(badge);

    // Gold sill under the headboard, matching the front lip.
    const sill = this.addStaticBox(BED_WIDTH + 0.9, 0.1, 0.34, 0, 0.16, GAME.playfieldBackZ + 0.42, PALETTE.gold, {
      ...BRASS,
      ...this.surfaces.brushed,
      envMap: this.environmentTexture,
      visualOnly: true,
    });
    this.headboardParts.push({ mesh: sill, offset: 0.42 });
    this.decor.push(sill);
  }

  // Rounded corner posts and gold rails that give the boxy cabinet the mock's soft silhouette.
  buildCabinetShell() {
    const playfieldDepth = GAME.playfieldBackZ - GAME.playfieldFrontZ;
    const playfieldCenter = (GAME.playfieldBackZ + GAME.playfieldFrontZ) / 2;
    const postGeometry = new THREE.CapsuleGeometry(0.17, 2.15, 4, 10);
    const postMaterial = new THREE.MeshStandardMaterial({
      ...this.surfaces.brushed,
      color: PALETTE.glassTint,
      roughness: 0.3,
      metalness: 0.5,
      emissive: PALETTE.gold,
      emissiveIntensity: 0.12,
      envMap: this.environmentTexture,
      envMapIntensity: 0.6,
    });
    for (const x of [-(INNER_X + 0.355), INNER_X + 0.355]) {
      for (const z of [GAME.playfieldFrontZ + 0.1, GAME.playfieldBackZ - 0.1]) {
        const post = new THREE.Mesh(postGeometry, postMaterial);
        this.decor.push(post);
        this.shellPosts.push({ mesh: post, front: z < playfieldCenter });
        post.position.set(x, 0.95, z);
        this.scene.add(post);
      }
      // Outer skirt closes the gap between the posts.
      const skirt = this.addStaticBox(0.3, 2.5, playfieldDepth - 0.2, x, 0.9, playfieldCenter, PALETTE.metal, {
        ...this.surfaces.brushed,
        roughness: 0.34,
        metalness: 0.72,
        visualOnly: true,
      });
      this.shellSkirts.push(skirt);
      this.decor.push(skirt);
    }
  }

  buildMachine() {
    this.buildBackdrop();
    // Lower stationary playfield and cabinet.
    const playfieldDepth = GAME.playfieldBackZ - GAME.playfieldFrontZ;
    const playfieldCenter = (GAME.playfieldBackZ + GAME.playfieldFrontZ) / 2;
    // White base colour, not PALETTE.felt: the deck texture already carries the navy it is drawn
    // on, and a tinted material would multiply the two and crush the markings to black.
    this.bed = this.addStaticBox(BED_WIDTH, 0.5, playfieldDepth, 0, -0.25, playfieldCenter, PALETTE.white, {
      ...(this.deckPlate ? this.plateSurfaceMaps(BED_WIDTH, playfieldDepth) : this.surfaces.deck),
      map: this.createDeckTexture(),
      roughness: 0.42,
      metalness: 0.3,
      receiveShadow: true,
    });
    const backPanel = this.backPanel = this.addStaticBox(BED_WIDTH, 2.6, 0.25, 0, 1.05, GAME.playfieldBackZ + 0.05, PALETTE.dark, { map: this.createBackTexture() });
    Object.assign(backPanel.material, {
      emissiveMap: this.backTexture,
      emissive: new THREE.Color(PALETTE.white),
      emissiveIntensity: 0.5,
    });
    // Side walls read as tinted glass, so the pile stays visible through them like the mock.
    for (const x of [-(INNER_X + 0.125), INNER_X + 0.125]) {
      const glass = this.addStaticBox(0.25, 2.4, playfieldDepth + 0.2, x, 0.95, playfieldCenter, PALETTE.glassTint, {
        metalness: 0.1,
        roughness: 0.16,
        collisionRole: 'side-wall',
      });
      this.decor.push(glass);
      this.glassPanes.push(glass);
      Object.assign(glass.material, {
        transparent: true,
        opacity: 0.15,
        depthWrite: false,
        envMap: this.environmentTexture,
        // Was 1.6, which turned the glass into an opaque mint slab that hid the pile behind it.
        envMapIntensity: 0.45,
      });
    }
    // Also decor: a real cabinet brings its own lit window frame, and these bars sit outside it,
    // reading as two loose glowing sticks rather than part of the machine. The pulse in animate()
    // keeps running on them either way - it just has nothing visible to drive.
    this.neon = [
      this.addStaticBox(0.14, 0.14, playfieldDepth + 0.2, -(INNER_X + 0.125), 2.2, playfieldCenter, PALETTE.gold, { emissive: PALETTE.gold, emissiveIntensity: 0.85, visualOnly: true }),
      this.addStaticBox(0.14, 0.14, playfieldDepth + 0.2, INNER_X + 0.125, 2.2, playfieldCenter, PALETTE.gold, { emissive: PALETTE.gold, emissiveIntensity: 0.85, visualOnly: true }),
    ];
    this.decor.push(...this.neon);
    // buildHeadboard adds its frame to this.neon for the pulse, and that one does not move with
    // the playfield's length - so the two bars that do are kept apart here.
    this.neonBars = [...this.neon];
    this.frontTrim = this.addStaticBox(BED_WIDTH, 0.12, 0.14, 0, -0.02, GAME.playfieldFrontZ - 0.02, PALETTE.gold, {
      ...BRASS,
      ...this.surfaces.brushed,
      envMap: this.environmentTexture,
      emissive: PALETTE.gold,
      emissiveIntensity: 0.14,
      visualOnly: true,
    });
    const chuteFloor = this.addStaticBox(BED_WIDTH + 0.4, 0.3, 2, 0, -2.4, chuteZ(), PALETTE.dark, { receiveShadow: true });
    this.decor.push(chuteFloor);
    const chuteLip = this.addStaticBox(BED_WIDTH + 0.5, 0.09, 0.12, 0, -2.2, chuteZ() - 1.07, PALETTE.gold, {
      ...BRASS,
      ...this.surfaces.brushed,
      envMap: this.environmentTexture,
      visualOnly: true,
    });
    // Lit payout chute, so the tray is not a black hole under the playfield.
    const chuteGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(BED_WIDTH + 0.2, 2.1),
      new THREE.MeshBasicMaterial({
        map: this.glowTexture,
        color: PALETTE.goldSoft,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    chuteGlow.rotation.x = -Math.PI / 2;
    chuteGlow.position.set(0, -2.23, chuteZ());
    this.scene.add(chuteGlow);
    const chuteWalls = [
      this.addStaticBox(0.2, 1.2, 2, -(INNER_X + 0.175), -1.9, chuteZ(), PALETTE.metal),
      this.addStaticBox(0.2, 1.2, 2, INNER_X + 0.175, -1.9, chuteZ(), PALETTE.metal),
      this.addStaticBox(BED_WIDTH + 0.4, 1.2, 0.2, 0, -1.9, chuteZ() - 0.9, PALETTE.metal),
    ];
    this.decor.push(...chuteWalls);
    // The whole chute hangs off the front lip: offsets from chuteZ(), never absolute positions.
    this.chuteParts = [
      { mesh: chuteFloor, offset: 0 },
      { mesh: chuteLip, offset: -1.07 },
      { mesh: chuteGlow, offset: 0 },
      { mesh: chuteWalls[0], offset: 0 },
      { mesh: chuteWalls[1], offset: 0 },
      { mesh: chuteWalls[2], offset: -0.9 },
    ];

    // A fixed rear deck closes the dead zone the retreating tray leaves behind. It sits a
    // hair below the tray so the tray slides over it and a coin never rests on both at once.
    // Its front edge has to reach the tray's back edge at full extension, or the shortfall is an
    // open slot straight down to the lower bed. It used to be a literal 1.85 against a tray that
    // reached 1.75, and the 0.1 of daylight only went unnoticed because the scraper stood at 1.72
    // and hid it; moving scraperZ back uncovered it. Derived from the stroke now, so it cannot
    // come apart again, with an overlap so the seam is never exactly on the tray's edge.
    const rear = CoinPusher.rearDeckSpan();
    this.rearDeck = this.addStaticBox(BED_WIDTH - 0.2, GAME.upperTrayHeight, rear.depth, 0, GAME.upperTrayY - GAME.deckClearance, rear.centre, PALETTE.shell, {
      ...this.surfaces.deck,
      roughness: 0.45,
      metalness: 0.38,
      receiveShadow: true,
    });
    // Same inlay the moving tray carries, so the strip the tray uncovers at full extension reads
    // as more shelf rather than a different object parked behind it. Sits at the deck's own top
    // face, not the tray's, or the tray would drag coins across a raised lip every stroke.
    const deckTop = new THREE.Mesh(
      new THREE.BoxGeometry(BED_WIDTH - 0.5, 0.035, rear.inlayDepth),
      new THREE.MeshStandardMaterial({ ...this.inlaySurface(BED_WIDTH - 0.5, rear.inlayDepth), metalness: 0.25, roughness: 0.55 }),
    );
    this.rearDeckTop = deckTop;
    deckTop.position.set(0, GAME.upperTrayY - GAME.deckClearance + GAME.upperTrayHeight / 2 - 0.0175, rear.centre);
    this.shellSurfaces.push(deckTop);
    this.scene.add(deckTop);
    const trayTopY = GAME.upperTrayY + GAME.upperTrayHeight / 2;
    const scraperGuardHeight = GAME.scraperGuardTopY - trayTopY;
    this.shellSurfaces.push(this.scraper = this.addStaticBox(BED_WIDTH - 0.2, 1.2, 0.16, 0, 1.31, GAME.scraperZ, PALETTE.metal, {
      ...this.surfaces.brushed,
      roughness: 0.4,
      metalness: 0.7,
      emissive: PALETTE.gold,
      emissiveIntensity: 0.35,
      // BED_WIDTH overlaps the side-wall colliders, so an edge-on coin cannot squeeze around
      // either end; the top reaches the glass, so a pile impact cannot vault it.
      collisionWidth: BED_WIDTH,
      collisionHeight: scraperGuardHeight,
      collisionY: trayTopY + scraperGuardHeight / 2,
    }));
    const scraperStrip = this.addStaticBox(BED_WIDTH - 0.35, 0.08, 0.19, 0, 0.73, GAME.scraperZ - 0.02, PALETTE.gold, {
      ...BRASS,
      ...this.surfaces.brushed,
      envMap: this.environmentTexture,
      visualOnly: true,
    });
    this.scraperStrip = scraperStrip;
    this.frameScraper(BED_WIDTH - 0.2, 1.2, 0.16);

    // Moving upper tray: coins land here, meet the fixed scraper, then spill to the lower bed.
    const pusherMesh = new THREE.Group();
    const pusherDeckDepth = GAME.pusherDepth + GAME.pusherRearExtension;
    const pusherDeckCenterZ = GAME.pusherRearExtension / 2;
    const trayMaterial = new THREE.MeshStandardMaterial({ ...this.surfaces.brushed, color: PALETTE.shellRaised, metalness: 0.55, roughness: 0.35 });
    const tray = new THREE.Mesh(
      new THREE.BoxGeometry(BED_WIDTH - 0.3, GAME.upperTrayHeight, pusherDeckDepth),
      trayMaterial,
    );
    tray.position.set(0, GAME.upperTrayY, pusherDeckCenterZ);
    this.trayParts.push({ mesh: tray, inset: 0 });
    this.shellSurfaces.push(tray);
    tray.castShadow = this.quality.shadows;
    tray.receiveShadow = this.quality.shadows;
    pusherMesh.add(tray);

    const trayTop = new THREE.Mesh(
      new THREE.BoxGeometry(BED_WIDTH - 0.5, 0.035, pusherDeckDepth - 0.12),
      new THREE.MeshStandardMaterial({ ...this.inlaySurface(BED_WIDTH - 0.5, pusherDeckDepth - 0.12), metalness: 0.25, roughness: 0.55 }),
    );
    this.shellSurfaces.push(trayTop);
    this.trayParts.push({ mesh: trayTop, inset: 0.12 });
    trayTop.position.set(0, GAME.upperTrayY + GAME.upperTrayHeight / 2 + 0.018, pusherDeckCenterZ);
    pusherMesh.add(trayTop);

    const bladeHeight = 0.64;
    const blade = new THREE.Mesh(
      new THREE.BoxGeometry(BED_WIDTH - 0.3, bladeHeight, 0.14),
      new THREE.MeshStandardMaterial({ ...this.surfaces.brushed, color: PALETTE.shellRaised, metalness: 0.72, roughness: 0.3 }),
    );
    this.shellSurfaces.push(blade);
    blade.position.set(0, bladeHeight / 2, -GAME.pusherDepth / 2);
    blade.castShadow = this.quality.shadows;
    pusherMesh.add(blade);

    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(BED_WIDTH - 0.3, 0.11, 0.075),
      new THREE.MeshStandardMaterial({ ...BRASS, ...this.surfaces.brushed, color: PALETTE.gold, envMap: this.environmentTexture }),
    );
    strip.position.set(0, 0.55, -GAME.pusherDepth / 2 - 0.075);
    pusherMesh.add(strip);

    // Gold edge strips, sunk so their top face is the tray's collision surface rather than a lip
    // standing 0.08 above it. The tray is only BED_WIDTH - 0.3 wide while a coin can rest with its
    // centre out at INNER_X - COIN_RADIUS, so a coin against either wall always overhangs these:
    // as a raised lip they were a gold bar drawn straight through the coin. Nothing on the tray
    // may sit above trayTopY for that reason - if these ever want to be a real lip they need a
    // collider on the pusher body too, which costs the outer 0.36 of tray on each side.
    for (const x of [-(INNER_X - 0.125), INNER_X - 0.125]) {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, 0.12, pusherDeckDepth),
        new THREE.MeshStandardMaterial({ ...BRASS, ...this.surfaces.brushed, color: PALETTE.gold, envMap: this.environmentTexture }),
      );
      rail.position.set(x, trayTopY - 0.06, pusherDeckCenterZ);
      this.trayParts.push({ mesh: rail, inset: 0 });
      pusherMesh.add(rail);
    }
    this.scene.add(pusherMesh);
    this.buildCabinetShell();
    this.buildHeadboard();

    const pusherBody = new CANNON.Body({ mass: 0, material: this.pusherMaterial, type: CANNON.Body.KINEMATIC });
    pusherBody.addShape(
      new CANNON.Box(new CANNON.Vec3((BED_WIDTH - 0.3) / 2, GAME.upperTrayHeight / 2, pusherDeckDepth / 2)),
      new CANNON.Vec3(0, GAME.upperTrayY, pusherDeckCenterZ),
    );
    pusherBody.addShape(
      new CANNON.Box(new CANNON.Vec3((BED_WIDTH - 0.3) / 2, bladeHeight / 2, 0.07)),
      new CANNON.Vec3(0, bladeHeight / 2, -GAME.pusherDepth / 2),
    );
    // Shape 0 is the deck, shape 1 the blade. Only the deck's length follows the panel; the
    // blade stays a fixed half-depth in front of the centre, which is what keeps the stroke's
    // calibration out of the player's hands.
    this.pusherDeckShape = pusherBody.shapes[0];
    pusherBody.position.set(0, 0, GAME.pusherOriginZ);
    pusherBody.previousPosition.copy(pusherBody.position);
    pusherBody.interpolatedPosition.copy(pusherBody.position);
    this.world.addBody(pusherBody);

    const updatePusherMotion = () => {
      const motion = pusherMotionAt(this.world.stepnumber, this.quality.physicsStep);
      pusherBody.position.z = motion.positionZ;
      pusherBody.velocity.set(0, 0, motion.velocityZ);
      pusherBody.aabbNeedsUpdate = true;
    };
    updatePusherMotion();
    this.world.addEventListener('postStep', updatePusherMotion);
    this.cleanup.push(() => this.world.removeEventListener('postStep', updatePusherMotion));

    // Apply after the solver has finished the wall impact. Doing it from the collision callback
    // itself would let the same solver step write some of the rejected velocity straight back.
    const stopRailCoinsAtWalls = () => {
      for (const coin of this.activeCoins) {
        if (!coin.pendingWallStop) continue;
        stopRailCoinAtWall(coin.body);
        coin.pendingWallStop = false;
        coin.railWallStopUntil = -Infinity;
      }
    };
    this.world.addEventListener('postStep', stopRailCoinsAtWalls);
    this.cleanup.push(() => this.world.removeEventListener('postStep', stopRailCoinsAtWalls));

    this.pusherMesh = pusherMesh;
    this.pusherBody = pusherBody;
    this.buildLauncher();
    // Every geometry-driven part now exists, so a saved layout can be applied in one pass
    // instead of being threaded through the build.
    this.layoutGeometry();
  }

  // A foreground launcher on a brass travel rail, matching the reference game's first-person
  // control language. The reticle is parented to the pusher so its promise stays physically true.
  buildLauncher() {
    const shell = new THREE.MeshStandardMaterial({
      ...this.surfaces.brushed,
      color: PALETTE.shellRaised,
      emissive: PALETTE.gold,
      emissiveIntensity: 0.18,
      metalness: 0.72,
      roughness: 0.28,
    });
    const brass = new THREE.MeshStandardMaterial({
      ...BRASS,
      ...this.surfaces.brushed,
      color: PALETTE.gold,
      envMap: this.environmentTexture,
      emissive: PALETTE.gold,
      emissiveIntensity: 0.28,
    });
    const glow = new THREE.MeshBasicMaterial({ color: PALETTE.goldSoft, transparent: true, opacity: 0.9 });

    // ponytail: the travel rail is gone, both the lit inlay along its top and the body under it.
    // Cut on request - the body's gold emissive read as a brown line lying across the floor, which
    // is exactly what the inlay had looked like. The launcher hovers with nothing under it now.
    // Its launcherTrackY went with it, since nothing else read that key; the rail sat at y -0.7,
    // spanning the travel plus 0.375 each side, if one is ever wanted back.

    const launcher = new THREE.Group();
    if (this.launcherModelSource) {
      const model = this.launcherModelSource.clone(true);
      // No rotate, no scale, no fit. tools/build_launcher.py authors the barrel pointing +Z with
      // its muzzle already on launcherMuzzleZ - launcherZ and its feet on launcherMountY, in this
      // group's own space, so the only thing left to do is light it. tests/launcher.test.js holds
      // the model to those two planes.
      model.traverse((object) => {
        if (!object.isMesh) return;
        object.castShadow = this.quality.shadows;
        object.receiveShadow = this.quality.shadows;
        const hasMaterialArray = Array.isArray(object.material);
        const materials = hasMaterialArray ? object.material : [object.material];
        const copies = materials.map((material) => {
          const copy = material.clone();
          copy.envMap = this.environmentTexture;
          copy.envMapIntensity = 0.65;
          copy.needsUpdate = true;
          return copy;
        });
        object.material = hasMaterialArray ? copies : copies[0];
      });
      // The charge core breathes on the same list the shell's neon rides. Only the core: this is
      // a foreground object at the very bottom edge of the frame, and lighting all of it up would
      // pull the eye off the playfield to look at a sliver.
      const core = model.getObjectByName('launcher_core');
      if (core) {
        this.shellNeon.push({
          material: core.material,
          base: core.material.emissiveIntensity,
          phase: 0,
        });
      }
      launcher.add(model);
      this.launcherModel = model;
    } else {
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.48, 0.25, 16), shell);
      base.position.y = 0.42;
      const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.36, 0.22, 16), brass);
      collar.position.y = 0.61;
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.23, 0.92, 16), shell);
      barrel.rotation.x = 1.06;
      barrel.position.set(0, 0.78, 0.34);
      const muzzle = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.055, 8, 20), brass);
      muzzle.position.set(0, GAME.launcherMuzzleY, GAME.launcherMuzzleZ - GAME.launcherZ);
      const sight = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.48), glow);
      sight.position.set(0, 0.92, 0.34);
      sight.rotation.x = 1.06;
      launcher.add(base, collar, barrel, muzzle, sight);
    }
    launcher.position.set(this.launcherX, 0, GAME.launcherZ);
    launcher.traverse((object) => {
      if (!object.isMesh) return;
      object.castShadow = this.quality.shadows;
    });
    this.scene.add(launcher);
    this.launcherMesh = launcher;
    this.measureLauncherClip(launcher);
    this.updateLauncherReach();

    // No trajectory line, and no ring on the tray either. The camera sits almost on the shot's
    // own axis, so the arc projects as one near-vertical streak into the backboard and a flat
    // marker at the landing point is edge-on to the point of invisibility. Both were tried. What
    // survives is a lit gold pin hovering over the spot, on a camera-facing halo - a sprite,
    // because anything lying on the tray is edge-on and any column tall enough to see reads as a
    // solid can. The one thing aim changes is X, and a floating shape shows it at any framing.
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTexture,
      color: PALETTE.gold,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    halo.scale.setScalar(0.74);
    this.scene.add(halo);
    this.launcherBeacon = halo;

    const pin = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.23),
      new THREE.MeshStandardMaterial({
        color: PALETTE.gold,
        emissive: PALETTE.gold,
        emissiveIntensity: 0.45,
        ...BRASS,
      }),
    );
    this.scene.add(pin);
    this.launcherPin = pin;

    // The needle is what plants the marker on the tray: vertical is the one direction this camera
    // does not foreshorten, so even a post a tenth of a coin wide reads the whole way down.
    const needle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.012, 0.012, 0.86, 6),
      new THREE.MeshBasicMaterial({
        color: PALETTE.goldSoft,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.scene.add(needle);
    this.launcherNeedle = needle;
    this.updateLauncherVisuals();
  }

  launchFromFront() {
    const coin = this.acquireCoin();
    if (!coin) return false;
    coin.isPremium = Math.random() < GAME.premiumChance;
    coin.mesh.material = this.coinMaterials[coin.isPremium ? 'premium' : 'regular'];
    coin.mesh.visible = true;
    coin.counted = false;
    coin.falling = false;
    coin.recycleAt = Infinity;
    const target = launcherTargetFor(this.launcherAim);
    this.launching.push({
      coin,
      // Leaves the muzzle where the launcher actually stands and crosses to where it was aimed.
      fromX: this.launcherX,
      x: target.x,
      z: target.z,
      elapsed: 0,
      spin: Math.random() * Math.PI * 2,
    });
    return true;
  }

  // Coins stay scripted only for the presentation arc. Its endpoint is the world-fixed point the
  // shot was aimed at; at touchdown Cannon takes over and the tray drags the coin along itself.
  updateLaunching(delta) {
    const orientation = new CANNON.Quaternion();
    for (let index = this.launching.length - 1; index >= 0; index -= 1) {
      const shot = this.launching[index];
      shot.elapsed += delta;
      shot.spin += delta * 12;
      const t = Math.min(shot.elapsed / GAME.launcherFlightTime, 1);
      const eased = 1 - (1 - t) ** 2;
      const z = THREE.MathUtils.lerp(GAME.launcherMuzzleZ, shot.z, eased);
      const y = THREE.MathUtils.lerp(GAME.launcherMuzzleY, GAME.launcherLandingY, eased)
        + Math.sin(Math.PI * t) * GAME.launcherArcHeight;
      shot.coin.mesh.position.set(THREE.MathUtils.lerp(shot.fromX, shot.x, eased), y, z);
      shot.coin.mesh.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), shot.spin);
      if (t < 1) continue;

      this.launching.splice(index, 1);
      orientation.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), shot.spin);
      this.releaseCoin(shot.coin, {
        position: new CANNON.Vec3(shot.x, GAME.launcherLandingY, shot.z),
        // No pusher Z any more: the arc now ends where it was aimed, so inheriting the blade's
        // velocity would shove the coin off that point by a random amount per stroke phase.
        velocity: new CANNON.Vec3(0, -1.1, 0),
        angularVelocity: new CANNON.Vec3(0, 5.5, 0),
        orientation,
      });
    }
  }

  releaseCoin(coin, { position, velocity, angularVelocity, orientation }) {
    coin.pendingWallStop = false;
    coin.railWallStopUntil = -Infinity;
    coin.body.position.copy(position);
    coin.body.previousPosition.copy(position);
    coin.body.interpolatedPosition.copy(position);
    coin.body.velocity.copy(velocity);
    coin.body.angularVelocity.copy(angularVelocity);
    coin.body.quaternion.copy(orientation);
    coin.body.previousQuaternion.copy(coin.body.quaternion);
    coin.body.interpolatedQuaternion.copy(coin.body.quaternion);
    coin.body.aabbNeedsUpdate = true;
    coin.body.wakeUp();
    this.world.addBody(coin.body);
    this.activeCoins.push(coin);
  }

  setupParticles() {
    const count = this.quality.sparkCount;
    this.particles = [];
    if (count === 0) return;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) positions[index * 3 + 1] = -100;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const material = new THREE.PointsMaterial({
      size: 0.28,
      map: this.glowTexture,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
      sizeAttenuation: true,
    });
    this.particlePoints = new THREE.Points(geometry, material);
    this.scene.add(this.particlePoints);
    this.particleCursor = 0;
    this.particles = Array.from({ length: count }, () => ({ life: 0, velocity: new THREE.Vector3() }));
  }

  emitParticles(x, y, z, amount, premium) {
    if (!this.particlePoints) return;
    const position = this.particlePoints.geometry.attributes.position;
    const color = this.particlePoints.geometry.attributes.color;
    // Follows the coins: gold sparks for the gold coin, cool white for the silver one. The
    // premium burst used to be mint to match a mint coin, and both moved together.
    const sparkColor = new THREE.Color(premium ? PALETTE.goldSoft : PALETTE.white);
    for (let index = 0; index < amount; index += 1) {
      const particleIndex = this.particleCursor % this.particles.length;
      this.particleCursor += 1;
      const particle = this.particles[particleIndex];
      particle.life = 0.55 + Math.random() * 0.3;
      const angle = Math.random() * Math.PI * 2;
      const speed = 1.2 + Math.random() * 2.2;
      particle.velocity.set(Math.cos(angle) * speed, 2.2 + Math.random() * 2.5, Math.sin(angle) * speed - 1);
      position.setXYZ(particleIndex, x + (Math.random() - 0.5) * 0.4, y, z + (Math.random() - 0.5) * 0.4);
      color.setXYZ(particleIndex, sparkColor.r, sparkColor.g, sparkColor.b);
    }
    position.needsUpdate = true;
    color.needsUpdate = true;
  }

  updateParticles(delta) {
    if (!this.particlePoints) return;
    const position = this.particlePoints.geometry.attributes.position;
    let changed = false;
    this.particles.forEach((particle, index) => {
      if (particle.life <= 0) return;
      particle.life -= delta;
      changed = true;
      if (particle.life <= 0) {
        position.setXYZ(index, 0, -100, 0);
        return;
      }
      particle.velocity.y -= 10 * delta;
      position.setXYZ(
        index,
        position.getX(index) + particle.velocity.x * delta,
        position.getY(index) + particle.velocity.y * delta,
        position.getZ(index) + particle.velocity.z * delta,
      );
    });
    if (changed) position.needsUpdate = true;
  }

  makeCoin() {
    const isPremium = Math.random() < GAME.premiumChance;
    const mesh = new THREE.Mesh(this.coinGeometry, this.coinMaterials[isPremium ? 'premium' : 'regular']);
    mesh.castShadow = this.quality.shadows;
    mesh.receiveShadow = this.quality.shadows;
    // The geometry is shared and baked at COIN_HEIGHT, so thickness rides on the instance.
    mesh.scale.y = this.tuning.thickness / COIN_HEIGHT;
    this.scene.add(mesh);
    const body = createCoinBody(this.coinPhysicsMaterial, this.tuning);
    const coin = {
      mesh,
      body,
      isPremium,
      counted: false,
      falling: false,
      recycleAt: Infinity,
      pendingWallStop: false,
      railWallStopUntil: -Infinity,
    };
    body.addEventListener('collide', (event) => {
      if (event.body?.collisionRole !== 'side-wall') return;
      if (coin.railWallStopUntil < this.elapsed) return;
      coin.pendingWallStop = true;
    });
    this.createdCoins += 1;
    return coin;
  }

  acquireCoin() {
    if (this.coinPool.length > 0) return this.coinPool.pop();
    if (this.createdCoins >= this.quality.coinCap) return null;
    return this.makeCoin();
  }

  spawnCoin(x, y, z, seedTier = null) {
    const coin = this.acquireCoin();
    if (!coin) return false;
    const seed = seedTier !== null;
    const lowerSeed = seedTier === 'lower';
    coin.isPremium = seed ? Math.random() < GAME.premiumChance : Math.random() < GAME.premiumChance;
    coin.mesh.material = this.coinMaterials[coin.isPremium ? 'premium' : 'regular'];
    coin.mesh.visible = true;
    coin.counted = false;
    coin.falling = false;
    coin.recycleAt = Infinity;
    coin.pendingWallStop = false;
    coin.railWallStopUntil = -Infinity;
    coin.body.position.set(x, y, z);
    coin.body.previousPosition.copy(coin.body.position);
    coin.body.interpolatedPosition.copy(coin.body.position);
    // A seeded coin gets a sideways shove rather than being placed at rest: sliding a few
    // centimetres into its neighbours during settlePile() is what rubs out the rows and
    // columns it was seeded on. A dropped coin still just falls.
    if (seed) {
      // The lower bed is intentionally a flat, open layer. A large startup kick was useful for
      // breaking up the old dense lattice, but it also climbed coins over their neighbours
      // before frame one. Its randomized slots already provide the visual variation it needs.
      const kick = lowerSeed ? 0 : 0.8;
      coin.body.velocity.set((Math.random() - 0.5) * kick, 0, (Math.random() - 0.5) * kick);
    }
    else coin.body.velocity.set(0, -1, 0);
    const spin = lowerSeed ? 0 : 1;
    coin.body.angularVelocity.set(
      (Math.random() - 0.5) * 2 * spin,
      (Math.random() - 0.5) * 4 * spin,
      (Math.random() - 0.5) * 2 * spin,
    );
    const yaw = new CANNON.Quaternion();
    yaw.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), Math.random() * Math.PI * 2);
    const tilt = new CANNON.Quaternion();
    tilt.setFromAxisAngle(
      new CANNON.Vec3(Math.random(), 0, Math.random()),
      (Math.random() - 0.5) * (lowerSeed ? 0 : seed ? 0.42 : 0.3),
    );
    const orientation = yaw.mult(tilt);
    coin.body.quaternion.copy(orientation);
    coin.body.previousQuaternion.copy(coin.body.quaternion);
    coin.body.interpolatedQuaternion.copy(coin.body.quaternion);
    coin.body.aabbNeedsUpdate = true;
    coin.body.wakeUp();
    this.world.addBody(coin.body);
    this.activeCoins.push(coin);
    return true;
  }

  drop() {
    return this.launchFromFront();
  }

  recycleCoin(index) {
    const [coin] = this.activeCoins.splice(index, 1);
    if (!coin) return;
    this.world.removeBody(coin.body);
    coin.body.velocity.setZero();
    coin.body.angularVelocity.setZero();
    coin.mesh.visible = false;
    coin.falling = false;
    coin.pendingWallStop = false;
    coin.railWallStopUntil = -Infinity;
    this.coinPool.push(coin);
  }

  resetPile() {
    this.cancelChest();
    for (const shot of this.launching) {
      shot.coin.mesh.visible = false;
      this.coinPool.push(shot.coin);
    }
    this.launching.length = 0;
    for (let index = this.activeCoins.length - 1; index >= 0; index -= 1) this.recycleCoin(index);
    this.runPusherToFullRetreat();
    const pileSeed = Math.floor(Math.random() * 1_000_000_000);
    for (let index = 0; index < this.quality.seedCount; index += 1) {
      const position = seedPosition(index, pileSeed, this.tuning.thickness, this.pusherBody.position.z);
      this.spawnCoin(position.x, position.y, position.z, position.tier);
    }
    this.settlePile();
  }

  // Run the empty world - no coins in it, so the steps cost nothing - up to the instant the
  // pusher sits at full retreat. settlePile() then spends its whole budget on the forward
  // half of the stroke, which is the half that does the work.
  runPusherToFullRetreat() {
    const step = this.quality.physicsStep;
    const perStroke = Math.round((2 * Math.PI / GAME.pusherSpeed) / step);
    const atRetreat = Math.round((Math.PI / 2 / GAME.pusherSpeed) / step);
    const wait = ((atRetreat - this.world.stepnumber) % perStroke + perStroke) % perStroke;
    for (let i = 0; i < wait; i += 1) this.world.step(step);
  }

  // A seeded lattice reads as a grid however hard the slots are jittered - the eye locks onto
  // the columns, not the millimetres. So the player never sees the lattice: the world runs
  // forward before the first frame and the pile arrives already collapsed, coins tipped and
  // riding on each other the way they are after a minute of play. Half of that is the pusher
  // squeezing the pile against the lip; gravity alone just settles it back into flat rows.
  settlePile() {
    // Much the most expensive thing the game ever does - every coin awake, every pair in
    // contact - so the solver runs lean. Residual error is cleaned up by the first real
    // frames at full iterations, before the player has taken a turn.
    const iterations = this.world.solver.iterations;
    this.world.solver.iterations = SETTLE_SOLVER_ITERATIONS;
    // Has to be the game's own step: the pusher's postStep handler derives its stroke from
    // world.stepnumber times this exact value.
    const step = this.quality.physicsStep;
    for (let i = 0; i < Math.round(PILE_SETTLE_SECONDS / step); i += 1) this.world.step(step);
    this.world.solver.iterations = iterations;
    // A coin the stroke shoved over the lip never happened: recycle it, or the payout check
    // on frame one pays the player for a pile that fell over on its own.
    for (let i = this.activeCoins.length - 1; i >= 0; i -= 1) {
      if (this.activeCoins[i].body.position.z < GAME.edgeZ) this.recycleCoin(i);
    }
    for (const coin of this.activeCoins) {
      coin.mesh.position.copy(coin.body.position);
      coin.mesh.quaternion.copy(coin.body.quaternion);
    }
  }

  setEnvironmentRotation(horizontalDegrees, verticalDegrees) {
    const horizontal = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(horizontalDegrees, -180, 180));
    const vertical = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(verticalDegrees, -90, 90));
    Object.values(this.coinMaterials).forEach((material) => {
      material.envMapRotation.set(vertical, horizontal, 0);
    });
  }

  // Direct manipulation: dragging anywhere on the playfield moves the foreground launcher. A
  // canvas drag never spends a coin; firing remains a separate, deliberate button/key action.
  bindPointer() {
    let dragging = false;
    const aimAt = (clientX) => {
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width) return 0;
      return THREE.MathUtils.clamp(((clientX - rect.left) / rect.width) * 2 - 1, -1, 1);
    };
    const moveTo = (clientX) => {
      const aim = aimAt(clientX);
      this.setLauncherAim(aim);
      this.callbacks.onAimChange?.(aim);
    };
    const onDown = (event) => {
      dragging = true;
      this.canvas.setPointerCapture?.(event.pointerId);
      moveTo(event.clientX);
    };
    const onMove = (event) => { if (dragging) moveTo(event.clientX); };
    const onUp = () => {
      dragging = false;
    };
    const onCancel = () => {
      dragging = false;
    };
    this.canvas.addEventListener('pointerdown', onDown);
    this.canvas.addEventListener('pointermove', onMove);
    this.canvas.addEventListener('pointerup', onUp);
    this.canvas.addEventListener('pointercancel', onCancel);
    this.cleanup.push(() => {
      this.canvas.removeEventListener('pointerdown', onDown);
      this.canvas.removeEventListener('pointermove', onMove);
      this.canvas.removeEventListener('pointerup', onUp);
      this.canvas.removeEventListener('pointercancel', onCancel);
    });
  }

  // Every vertex the frame can show, reduced to the pair the reach clamp needs: how far from the
  // camera it sits, and how far off the rail's centre. Both are constants - the camera never moves
  // and fov is fixed - so this runs once and resize only rescales it. ~1.1k vertices, which beats
  // reasoning about the bounding box: the box's corners are not where its silhouette is tightest.
  measureLauncherClip(launcher) {
    launcher.updateWorldMatrix(true, true);
    this.camera.updateMatrixWorld();
    // The frame's bottom edge is focal * view.y === -depth.
    const focal = 1 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const point = new THREE.Vector3();
    const world = new THREE.Vector3();
    const clip = [];
    launcher.traverse((object) => {
      const position = object.geometry?.attributes?.position;
      if (!position) return;
      for (let index = 0; index < position.count; index += 1) {
        world.fromBufferAttribute(position, index).applyMatrix4(object.matrixWorld);
        for (const yaw of FAN_SAMPLES) {
          // The same yaw launcherYawFor applies, about the launcher's own origin. Sampled across
          // the whole fan rather than at its ends: turning swings the muzzle out and the tail in,
          // so neither extreme is reliably the widest, and a mid-fan angle can be.
          const localZ = world.z - GAME.launcherZ;
          point.set(
            world.x * Math.cos(yaw) + localZ * Math.sin(yaw),
            world.y,
            GAME.launcherZ - world.x * Math.sin(yaw) + localZ * Math.cos(yaw),
          );
          const offset = Math.abs(point.x - launcher.position.x);
          point.applyMatrix4(this.camera.matrixWorldInverse);
          const depth = -point.z;
          // Below the bottom edge: cropped either way, so how far this one hangs off to the side is
          // invisible and must not cost the rail any travel. The launcher is meant to sit half under
          // the frame, so this is most of the near end of the barrel.
          if (focal * point.y + depth < 0) continue;
          clip.push(depth, offset);
        }
      }
    });
    this.launcherClip = clip;
  }

  // The rail is wider than a narrow window can frame: at z -5.9 the launcher sits between the
  // camera and the machine, so the visible width there is a fraction of the playfield's and full
  // aim pushed the barrel off screen. Aim keeps its whole -1..1 range; what it maps onto is the
  // smaller of the rail's half-width and what the frame holds, so the launcher and the point it
  // drops on stay together.
  // The camera has no yaw or roll, so a vertex's depth does not move with x: each one is an
  // independent ceiling on the reach and the tightest wins. Vertical fov means the result only
  // moves with aspect - a tall narrow window runs out of room first - which is why resize is the
  // only caller.
  updateLauncherReach() {
    if (!this.launcherClip) return;
    let reach = GAME.launcherTravelHalfWidth;
    for (let index = 0; index < this.launcherClip.length; index += 2) {
      reach = Math.min(
        reach,
        launcherReachFor(this.camera.fov, this.camera.aspect, this.launcherClip[index], this.launcherClip[index + 1]),
      );
    }
    this.launcherReach = reach;
    this.setLauncherAim(this.launcherAim);
  }

  setLauncherAim(aim) {
    this.launcherAim = THREE.MathUtils.clamp(Number.isFinite(aim) ? aim : 0, -1, 1);
    this.launcherX = launcherXFor(this.launcherAim, this.launcherReach);
    this.updateLauncherVisuals();
  }

  updateLauncherVisuals() {
    if (!this.launcherMesh || !this.launcherPin || !this.launcherBeacon) return;
    const y = GAME.upperTrayY + GAME.upperTrayHeight / 2 + 0.02;
    // Two different x's on purpose: the launcher sits where the frame lets it, the markers sit on
    // the drop point, and the barrel's yaw is what spans the gap between them.
    const targetX = launcherTargetFor(this.launcherAim).x;
    this.launcherMesh.position.x = this.launcherX;
    this.launcherMesh.rotation.y = launcherYawFor(this.launcherX, targetX);
    this.launcherPin.position.set(targetX, y + this.pinHover, GAME.dropZoneZ);
    this.launcherBeacon.position.copy(this.launcherPin.position);
    this.launcherNeedle.position.set(targetX, y + 0.43, GAME.dropZoneZ);
  }

  bindResize() {
    const resize = () => {
      const width = this.canvas.clientWidth;
      const height = this.canvas.clientHeight;
      if (!width || !height) return;
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height, false);
      this.composer?.setSize(width, height);
      this.updateLauncherReach();
    };
    this.resize = resize;
    this.resizeObserver = new ResizeObserver(resize);
    this.resizeObserver.observe(this.canvas);
    this.cleanup.push(() => this.resizeObserver.disconnect());
    resize();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.timer.reset();
    this.animate();
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.frameId);
  }

  animate = (timestamp) => {
    if (!this.running) return;
    this.frameId = requestAnimationFrame(this.animate);
    this.timer.update(timestamp);
    const delta = Math.min(this.timer.getDelta(), 0.05);
    this.elapsed += delta;

    // The pusher always runs, including before the first player drop. Initial stability comes
    // from the seeded clearances in physics.js, not from pausing the machine.
    this.world.step(this.quality.physicsStep, delta, this.quality.physicsMaxSubSteps);
    this.updateLaunching(delta);

    const scored = [];
    for (let index = this.activeCoins.length - 1; index >= 0; index -= 1) {
      const coin = this.activeCoins[index];
      // Render from the interpolated pose: world.step() runs a fixed-step accumulator, so
      // a display running at any other rate takes 0 or 2 steps on some frames. Reading the
      // raw pose there freezes a coin for a frame and double-jumps it the next.
      coin.mesh.position.copy(coin.body.interpolatedPosition);
      coin.mesh.quaternion.copy(coin.body.interpolatedQuaternion);
      if (coin.counted && coin.recycleAt <= this.elapsed) {
        this.recycleCoin(index);
        continue;
      }
      const phaseResult = coinPhase(coin, coin.body.position);
      if (phaseResult === 'cross') {
        coin.falling = true;
        nudgeOverLip(coin.body);
      } else if (phaseResult === 'score') {
        coin.counted = true;
        coin.recycleAt = this.elapsed + this.recycleDelay;
        scored.push(coin);
        this.emitParticles(coin.body.position.x, -1.5, coin.body.position.z, coin.isPremium ? 12 : 7, coin.isPremium);
      } else if (phaseResult === 'lost') {
        this.recycleCoin(index);
      }
    }
    if (scored.length > 0) this.callbacks.onScore?.(scored, this.elapsed);

    if (!this.quality.reducedMotion) {
      const pulse = 0.75 + 0.2 * Math.sin(this.elapsed * 3);
      this.neon.forEach((mesh) => { mesh.material.emissiveIntensity = pulse; });
      this.frontTrim.material.emissiveIntensity = 0.12 + 0.06 * Math.sin(this.elapsed * 3 + 1);
      // Squared so the crest is narrow: a plain sine reads as everything breathing together,
      // where this reads as one bright band travelling through the set.
      for (const part of this.shellNeon) {
        const wave = 0.5 + 0.5 * Math.sin(this.elapsed * 2.4 - part.phase);
        part.material.emissiveIntensity = part.base * (0.2 + 0.8 * wave * wave);
      }
    }
    this.updateBonus(delta);
    this.updateParticles(delta);
    this.pusherMesh.position.copy(this.pusherBody.interpolatedPosition);
    // Guide and reticle are world-fixed now, so they only move when the aim does - no per-frame
    // rebuild of the arc, which is what made it ride the stroke in the first place.
    if (!this.quality.reducedMotion) {
      this.pinHover = 1.02 + Math.sin(this.elapsed * 2.6) * 0.07;
      this.launcherPin.position.y = GAME.upperTrayY + GAME.upperTrayHeight / 2 + 0.02 + this.pinHover;
      this.launcherPin.rotation.y = this.elapsed * 0.9;
      this.launcherBeacon.position.y = this.launcherPin.position.y;
      this.launcherBeacon.material.opacity = 0.5 + Math.sin(this.elapsed * 2.6) * 0.14;
    }
    if (this.composer) this.composer.render(); else this.renderer.render(this.scene, this.camera);
  };

  destroy() {
    this.stop();
    this.composer?.dispose();
    this.cleanup.splice(0).forEach((cleanup) => cleanup());
    for (const shot of this.launching) shot.coin.mesh.visible = false;
    this.launching.length = 0;
    for (let index = this.activeCoins.length - 1; index >= 0; index -= 1) this.recycleCoin(index);
    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    this.scene.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);
      const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
      objectMaterials.filter(Boolean).forEach((material) => materials.add(material));
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => {
      Object.values(material).forEach((value) => {
        if (value?.isTexture) textures.add(value);
      });
      material.dispose();
    });
    textures.forEach((texture) => texture.dispose());
    this.environmentTexture?.dispose();
    this.timer?.dispose();
    this.renderer.dispose();
  }
}
