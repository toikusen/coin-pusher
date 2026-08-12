import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GAME, PALETTE } from './config.js';
import { coinPhase, launchSpeedFor } from './rules.js';
import {
  COIN_HEIGHT,
  COIN_RADIUS,
  CONTACT_SOLVER_OPTIONS,
  TUNING_DEFAULTS,
  applyCoinTuning,
  createCoinBody,
  pusherMotionAt,
  seedPosition,
  syncFrictionGravity,
} from './physics.js';

// One pusher half-stroke, entered at full retreat (runPusherToFullRetreat): long enough for
// the seeded stack to collapse and be squeezed forward once. Every step of it is simulated
// before the first frame, so this is also the load-time cost of the opening pile - ~1.5 s on
// a 2024 laptop, and cylinder-vs-cylinder narrowphase is the whole of it. Halving it halves
// the cost and visibly puts the rows back, so it is a look/load knob, not free headroom.
const PILE_SETTLE_SECONDS = Math.PI / GAME.pusherSpeed;
// Every part of the cabinet is cut from the playfield's half-width, so widening the machine is
// one config change rather than thirty literals. Kept as offsets from the interior, not ratios:
// a wider machine should get more playfield, not fatter trim.
const INNER_X = GAME.playfieldHalfWidth;
const BED_WIDTH = INNER_X * 2 + 0.15;
// The payout chute hangs off the front lip, so it travels with playfieldFrontZ.
const CHUTE_Z = GAME.playfieldFrontZ - 1.6;
// The rail's run: from the glass on one side in to railExitX. Shared by buildRails and
// updateRolling - split them and the coin rolls along something other than the drawn track.
const RAIL_LENGTH = INNER_X - GAME.railExitX;
const RAIL_SLOPE = GAME.railRise / RAIL_LENGTH;
const RAIL_FLOOR = 0.07;
// Trim finish. On a machine made of painted metal an emissive strip is the one thing that cannot
// be a real object, so the gold reads as polished brass instead: same colour, same job marking an
// edge, but lit by the room rather than glowing on its own.
const BRASS = Object.freeze({ roughness: 0.26, metalness: 0.92, envMapIntensity: 0.9 });
// Height of the track's top face, and so of whatever is rolling on it, `along` metres in from the
// outer end. Ends on GAME.railY exactly, which is the height rules.js measures the arc's fall from.
const railSurfaceY = (along) => GAME.railY + GAME.railRise - along * RAIL_SLOPE;
const SETTLE_SOLVER_ITERATIONS = 12;

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
    this.rolling = [];
    // Which rail the next coin comes from; the lit housing is the only cue for it on screen.
    this.armedSide = 1;
    // Structural parts a loaded cabinet re-skins: the surfaces a real machine builds out of the
    // same painted metal as its shell. The bed is deliberately not among them - it carries drawn
    // markings, and a box UV would sample an arbitrary patch of the model's atlas over them.
    this.railParts = [];
    // Cabinet furniture: hidden wholesale when a real cabinet model loads. Functional surfaces
    // (bed, glass, tray, scraper, rails) are never in here - those are aligned to physics and a
    // model cannot replace them without the collision bodies moving too.
    this.decor = [];
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

    // Framed around the cabinet model, not the playfield: a downloaded cabinet is a whole standing
    // machine and its marquee sits 8.1 above the bed, so the frame has to reach that high while
    // still holding the front lip at z=-5 near the bottom edge. Those two ends squeeze the pitch
    // to about 26° and push the camera out to 15.5, and the cost is real - the bed drops from
    // roughly half the frame's width to about 42% of it. Every degree of pitch also trades
    // backdrop for playfield, and addHall's height and sink are solved against this pitch, so
    // move any of these three numbers and re-derive the hall with them.
    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 100);
    camera.position.set(0, 9, -15.5);
    camera.lookAt(0, 1.34, 0.2);
    this.camera = camera;

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
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.34, 0.42, 0.92));
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
    const scaleY = this.tuning.thickness / COIN_HEIGHT;
    for (const coin of [...this.activeCoins, ...this.coinPool]) {
      applyCoinTuning(coin.body, this.tuning, resizeShape);
      coin.mesh.scale.y = scaleY;
    }
    if (resizeShape) this.resetPile();
  }

  async setupSharedAssets(environmentReady) {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const [model, hallTexture] = await Promise.all([
      new GLTFLoader().loadAsync('/models/coin.glb'),
      new THREE.TextureLoader().loadAsync('/backdrop/hall.jpg'),
    ]);
    hallTexture.colorSpace = THREE.SRGBColorSpace;
    this.hallTexture = hallTexture;
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

    // Preserve the downloaded asset's PBR material and every embedded texture.
    await environmentReady;
    const regular = sourceCoin.material.clone();
    regular.envMap = this.environmentTexture;
    regular.needsUpdate = true;
    // ponytail: colour multiply on the shared texture, not a second coin model. The downloaded
    // asset has one coin, and the two values only have to be told apart at a glance. Mint matches
    // the premium spark burst in emitParticles(), so the coin and its payout read as one thing.
    // Upgrade path: a separate premium mesh/texture if the tint stops reading against the pile.
    const premium = regular.clone();
    premium.color = new THREE.Color(PALETTE.mintSoft);
    premium.emissive = new THREE.Color(PALETTE.mint);
    premium.emissiveIntensity = 0.4;
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

  // Playfield markings. What makes a real cabinet look like it has content is graphic design on
  // its surfaces, not polygon count, and graphics are the one thing a 2D canvas is genuinely good
  // at. Drawn at the bed's own aspect ratio because a box's top face maps the whole texture across
  // it once, so a square source would stretch.
  // Symmetric front-to-back on purpose: a box face's V direction is not obvious from here, and a
  // design with a top and a bottom would come out reversed half the time.
  createDeckTexture() {
    const width = 512;
    const height = Math.round((width * (GAME.playfieldBackZ - GAME.playfieldFrontZ)) / BED_WIDTH);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');

    const wash = context.createLinearGradient(0, 0, 0, height);
    wash.addColorStop(0, '#0d2b36');
    wash.addColorStop(0.5, '#0a2028');
    wash.addColorStop(1, '#0d2b36');
    context.fillStyle = wash;
    context.fillRect(0, 0, width, height);

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
    context.lineWidth = 10;
    context.stroke();
    context.restore();

    // Lane pinstripes with tick marks: the eye reads them as the machine telling it where coins
    // are supposed to travel, which is most of what playfield art is for.
    for (const x of [width * 0.28, width * 0.72]) {
      context.strokeStyle = 'rgba(242, 201, 76, 0.26)';
      context.lineWidth = 3;
      context.beginPath();
      context.moveTo(x, height * 0.12);
      context.lineTo(x, height * 0.88);
      context.stroke();
      context.strokeStyle = 'rgba(46, 230, 210, 0.3)';
      for (let tick = 0; tick <= 8; tick += 1) {
        const y = height * 0.12 + (height * 0.76 * tick) / 8;
        context.beginPath();
        context.moveTo(x - 9, y);
        context.lineTo(x + 9, y);
        context.stroke();
      }
    }

    // Hazard chevrons at both ends, which is where coins leave the bed.
    const band = height * 0.055;
    for (const top of [0, height - band]) {
      context.save();
      context.beginPath();
      context.rect(0, top, width, band);
      context.clip();
      context.strokeStyle = 'rgba(242, 201, 76, 0.34)';
      context.lineWidth = 9;
      for (let offset = -band; offset < width + band; offset += 26) {
        context.beginPath();
        context.moveTo(offset, top + band);
        context.lineTo(offset + band, top);
        context.stroke();
      }
      context.restore();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
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
      body.addShape(new CANNON.Box(new CANNON.Vec3(collisionWidth / 2, collisionHeight / 2, collisionDepth / 2)));
      body.position.set(
        options.collisionX ?? x,
        options.collisionY ?? y,
        options.collisionZ ?? z,
      );
      this.world.addBody(body);
    }
    return mesh;
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

  // Optional downloaded cabinet, standing in for the procedural furniture. Absent is the normal
  // case and must stay cheap and quiet: a missing file is not an error, it just means the
  // procedural cabinet keeps its job.
  // The committed cabinet.glb was run through
  //   npx @gltf-transform/cli webp in.glb cabinet.glb --quality 82
  // which took the Sketchfab download from 9.1 MB to 1.1 MB with the textures still at 1k. Do the
  // same to any replacement: a raw export is most of the download budget for the whole game, and
  // resizing the textures instead costs the marquee its legibility for another 0.4 MB.
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
    cabinet.rotation.y = GAME.cabinetYaw;

    // A mesh's own name is useless in a Sketchfab export - every one of them is "defaultMaterial"
    // and the descriptive name sits on the parent node - so match up the chain.
    const labelOf = (object) => {
      const parts = [];
      for (let node = object; node && node !== cabinet; node = node.parent) parts.push(node.name);
      return parts.filter(Boolean).join('/');
    };
    const boxOf = (token) => {
      const box = new THREE.Box3();
      cabinet.traverse((object) => {
        if (object.isMesh && labelOf(object).includes(token)) box.union(new THREE.Box3().setFromObject(object));
      });
      return box.isEmpty() ? null : box;
    };

    // Scale so the fit part spans the playfield, falling back to the whole model's width.
    cabinet.updateMatrixWorld(true);
    const anchor = GAME.cabinetFitPart ? boxOf(GAME.cabinetFitPart) : null;
    const reference = anchor ?? new THREE.Box3().setFromObject(cabinet);
    const size = reference.getSize(new THREE.Vector3());
    const target = (anchor ? BED_WIDTH : BED_WIDTH + 0.9) * GAME.cabinetWidthFit;
    const scale = size.x > 0 ? target / size.x : 1;
    cabinet.scale.setScalar(scale);
    cabinet.updateMatrixWorld(true);

    // Land the fit part's top face on the bed's top face, centred on the playfield. Without an
    // anchor there is nothing to align to but the floor, so sit it on that instead.
    const fitted = anchor ? boxOf(GAME.cabinetFitPart) : new THREE.Box3().setFromObject(cabinet);
    const centre = fitted.getCenter(new THREE.Vector3());
    const bedTop = 0;
    cabinet.position.set(
      cabinet.position.x - centre.x + GAME.cabinetOffset.x,
      cabinet.position.y - (anchor ? fitted.max.y - bedTop : fitted.min.y + 2.78) + GAME.cabinetOffset.y,
      cabinet.position.z - centre.z + (GAME.playfieldBackZ + GAME.playfieldFrontZ) / 2 + GAME.cabinetOffset.z,
    );
    let hidden = 0;
    let lit = 0;
    cabinet.traverse((object) => {
      if (!object.isMesh) return;
      const label = labelOf(object);
      if (GAME.cabinetHide.some((token) => label.includes(token))) {
        object.visible = false;
        hidden += 1;
        return;
      }
      object.castShadow = this.quality.shadows;
      object.receiveShadow = this.quality.shadows;
      if (GAME.cabinetGlow.some((token) => label.includes(token))) {
        // Cloned first: glTF materials are shared across meshes, and the marquee's material is
        // the same one several other decals use. Lighting the material would light all of them.
        object.material = object.material.clone();
        object.material.emissiveMap = object.material.map;
        object.material.emissive = new THREE.Color(0xffffff);
        object.material.emissiveIntensity = 0.75;
        object.material.needsUpdate = true;
        lit += 1;
      }
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        // Opaque parts only. The model ships its panes at metalness 1, and handing one of those a
        // reflection probe turns the glass into a sheet of milk over the playfield.
        if (!material || material.envMap || material.transparent) continue;
        material.envMap = this.environmentTexture;
        material.envMapIntensity = 0.55;
        material.needsUpdate = true;
      }
    });
    this.scene.add(cabinet);
    for (const mesh of this.decor) mesh.visible = false;

    // Re-skin the launch rails in the cabinet's own metal. Nothing we can draw procedurally will
    // sit next to a textured model without looking pasted on, and the cheapest way to belong is
    // to be made of the same thing. The box UVs sample an arbitrary patch of the model's atlas,
    // which is fine for a worn metal but would be visibly wrong on a material carrying artwork -
    // hence the opaque, non-decal preference below rather than just taking the first material.
    const metal = this.cabinetMetal(cabinet, labelOf);
    if (metal) {
      for (const part of this.railParts) part.material = metal;
      // The housings are highlighted by emissiveIntensity, which would now be shared with every
      // other part using this material, so they get their own copy.
      for (const housing of this.railHousings) housing.mesh.material = metal.clone();
    }

    if (import.meta.env.DEV) {
      // Extending cabinetHide needs the part names and their extents, and there is no other way
      // to learn either.
      const rows = [];
      cabinet.traverse((object) => {
        if (!object.isMesh) return;
        const box = new THREE.Box3().setFromObject(object);
        const extent = box.getSize(new THREE.Vector3()).toArray().map((v) => v.toFixed(2)).join('x');
        rows.push(`${object.visible ? ' ' : '-'} ${labelOf(object)} [${extent}]`);
      });
      console.info(
        '[cabinet] scale %s, source %s, %d hidden, %d lit',
        scale.toFixed(4),
        size.toArray().map((v) => v.toFixed(2)).join(' x '),
        hidden,
        lit,
      );
      console.info('[cabinet] parts (- = hidden):\n%s', rows.join('\n'));
    }
  }

  // The model's plain structural metal: opaque, and not one of the materials carrying artwork.
  // Preferring the exact name first keeps this predictable for the cabinet we actually ship;
  // the fallback is what makes it survive a different model.
  cabinetMetal(cabinet, labelOf) {
    const candidates = [];
    cabinet.traverse((object) => {
      if (!object.isMesh || !object.visible || !object.material) return;
      const material = object.material;
      if (material.transparent || /decal/i.test(material.name ?? '')) return;
      if (!candidates.includes(material)) candidates.push(material);
    });
    return candidates.find((material) => material.name === 'material') ?? candidates[0] ?? null;
  }

  // Matte-painted casino hall. The camera never moves, so one unlit plane is the entire set - no
  // side walls, no room geometry, nothing lit.
  //
  // The numbers below are one derivation, not a set of knobs. Given the camera (9 up, 15.5 back,
  // 48° fov, 26° pitch) the frame's top ray meets the HALL_Z plane 8.07 above the floor, so the
  // strip of the painting the player can ever see is the 10.85 units from the real floor at -2.78
  // up to there. HALL_HORIZON is where the painting's own horizon sits, measured from the bottom
  // of the image, and the plane is sized and sunk so that line lands exactly on the real floor:
  //   height >= 7.74 / (1 - HALL_HORIZON)   and   y = -2.78 + height * (0.5 - HALL_HORIZON)
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
    // Above the 17.7 minimum on purpose, and not only for the width. Scaling the plane up moves
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
    badge.position.set(0, 1.62, GAME.playfieldBackZ - 0.09);
    badge.rotation.y = Math.PI;
    this.scene.add(badge);
    // The badge belongs to the headboard, so it has to go with it - a CP hexagon left floating
    // where a hidden panel used to be is worse than no badge at all.
    this.decor.push(badge);

    // Gold sill under the headboard, matching the front lip.
    this.decor.push(this.addStaticBox(BED_WIDTH + 0.9, 0.1, 0.34, 0, 0.16, GAME.playfieldBackZ + 0.42, PALETTE.gold, {
      ...BRASS,
      ...this.surfaces.brushed,
      envMap: this.environmentTexture,
      visualOnly: true,
    }));
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
        post.position.set(x, 0.95, z);
        this.scene.add(post);
      }
      // Outer skirt closes the gap between the posts.
      this.decor.push(this.addStaticBox(0.3, 2.5, playfieldDepth - 0.2, x, 0.9, playfieldCenter, PALETTE.metal, {
        ...this.surfaces.brushed,
        roughness: 0.34,
        metalness: 0.72,
        visualOnly: true,
      }));
    }
  }

  buildMachine() {
    this.buildBackdrop();
    // Lower stationary playfield and cabinet.
    const playfieldDepth = GAME.playfieldBackZ - GAME.playfieldFrontZ;
    const playfieldCenter = (GAME.playfieldBackZ + GAME.playfieldFrontZ) / 2;
    // White base colour, not PALETTE.felt: the deck texture already carries the navy it is drawn
    // on, and a tinted material would multiply the two and crush the markings to black.
    this.addStaticBox(BED_WIDTH, 0.5, playfieldDepth, 0, -0.25, playfieldCenter, PALETTE.white, {
      ...this.surfaces.deck,
      map: this.createDeckTexture(),
      roughness: 0.42,
      metalness: 0.3,
      receiveShadow: true,
    });
    const backPanel = this.addStaticBox(BED_WIDTH, 2.6, 0.25, 0, 1.05, GAME.playfieldBackZ + 0.05, PALETTE.dark, { map: this.createBackTexture() });
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
      });
      this.decor.push(glass);
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
    this.frontTrim = this.addStaticBox(BED_WIDTH, 0.12, 0.14, 0, -0.02, GAME.playfieldFrontZ - 0.02, PALETTE.gold, {
      ...BRASS,
      ...this.surfaces.brushed,
      envMap: this.environmentTexture,
      emissive: PALETTE.gold,
      emissiveIntensity: 0.14,
      visualOnly: true,
    });
    this.decor.push(this.addStaticBox(BED_WIDTH + 0.4, 0.3, 2, 0, -2.4, CHUTE_Z, PALETTE.dark, { receiveShadow: true }));
    this.addStaticBox(BED_WIDTH + 0.5, 0.09, 0.12, 0, -2.2, CHUTE_Z - 1.07, PALETTE.gold, {
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
    chuteGlow.position.set(0, -2.23, CHUTE_Z);
    this.scene.add(chuteGlow);
    this.decor.push(
      this.addStaticBox(0.2, 1.2, 2, -(INNER_X + 0.175), -1.9, CHUTE_Z, PALETTE.metal),
      this.addStaticBox(0.2, 1.2, 2, INNER_X + 0.175, -1.9, CHUTE_Z, PALETTE.metal),
      this.addStaticBox(BED_WIDTH + 0.4, 1.2, 0.2, 0, -1.9, CHUTE_Z - 0.9, PALETTE.metal),
    );

    // A fixed rear deck closes the dead zone the retreating tray leaves behind. It sits a
    // hair below the tray so the tray slides over it and a coin never rests on both at once.
    this.addStaticBox(BED_WIDTH - 0.2, GAME.upperTrayHeight, 2.1, 0, GAME.upperTrayY - GAME.deckClearance, 2.9, PALETTE.shell, {
      ...this.surfaces.deck,
      roughness: 0.45,
      metalness: 0.38,
      receiveShadow: true,
    });
    const trayTopY = GAME.upperTrayY + GAME.upperTrayHeight / 2;
    const scraperGuardHeight = GAME.scraperGuardTopY - trayTopY;
    this.railParts.push(this.scraper = this.addStaticBox(BED_WIDTH - 0.2, 0.68, 0.16, 0, 1.05, GAME.scraperZ, PALETTE.metal, {
      ...this.surfaces.brushed,
      roughness: 0.4,
      metalness: 0.7,
      emissive: PALETTE.gold,
      emissiveIntensity: 0.35,
      // Keep the low plate visually unobtrusive while sealing the whole opening in physics.
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

    // Moving upper tray: coins land here, meet the fixed scraper, then spill to the lower bed.
    const pusherMesh = new THREE.Group();
    const trayMaterial = new THREE.MeshStandardMaterial({ ...this.surfaces.brushed, color: PALETTE.shellRaised, metalness: 0.55, roughness: 0.35 });
    const tray = new THREE.Mesh(
      new THREE.BoxGeometry(BED_WIDTH - 0.3, GAME.upperTrayHeight, GAME.pusherDepth),
      trayMaterial,
    );
    tray.position.y = GAME.upperTrayY;
    this.railParts.push(tray);
    tray.castShadow = this.quality.shadows;
    tray.receiveShadow = this.quality.shadows;
    pusherMesh.add(tray);

    const trayTop = new THREE.Mesh(
      new THREE.BoxGeometry(BED_WIDTH - 0.5, 0.035, GAME.pusherDepth - 0.12),
      new THREE.MeshStandardMaterial({ ...this.surfaces.deck, color: PALETTE.glassTint, metalness: 0.25, roughness: 0.55 }),
    );
    this.railParts.push(trayTop);
    trayTop.position.y = GAME.upperTrayY + GAME.upperTrayHeight / 2 + 0.018;
    pusherMesh.add(trayTop);

    const bladeHeight = 0.64;
    const blade = new THREE.Mesh(
      new THREE.BoxGeometry(BED_WIDTH - 0.3, bladeHeight, 0.14),
      new THREE.MeshStandardMaterial({ ...this.surfaces.brushed, color: PALETTE.shellRaised, metalness: 0.72, roughness: 0.3 }),
    );
    this.railParts.push(blade);
    blade.position.set(0, bladeHeight / 2, -GAME.pusherDepth / 2);
    blade.castShadow = this.quality.shadows;
    pusherMesh.add(blade);

    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(BED_WIDTH - 0.3, 0.11, 0.075),
      new THREE.MeshStandardMaterial({ ...BRASS, ...this.surfaces.brushed, color: PALETTE.gold, envMap: this.environmentTexture }),
    );
    strip.position.set(0, 0.55, -GAME.pusherDepth / 2 - 0.075);
    pusherMesh.add(strip);

    for (const x of [-(INNER_X - 0.125), INNER_X - 0.125]) {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, 0.12, GAME.pusherDepth),
        new THREE.MeshStandardMaterial({ ...BRASS, ...this.surfaces.brushed, color: PALETTE.gold, envMap: this.environmentTexture }),
      );
      rail.position.set(x, 0.79, 0);
      pusherMesh.add(rail);
    }
    this.scene.add(pusherMesh);
    this.buildCabinetShell();
    this.buildHeadboard();

    const pusherBody = new CANNON.Body({ mass: 0, material: this.pusherMaterial, type: CANNON.Body.KINEMATIC });
    pusherBody.addShape(
      new CANNON.Box(new CANNON.Vec3((BED_WIDTH - 0.3) / 2, GAME.upperTrayHeight / 2, GAME.pusherDepth / 2)),
      new CANNON.Vec3(0, GAME.upperTrayY, 0),
    );
    pusherBody.addShape(
      new CANNON.Box(new CANNON.Vec3((BED_WIDTH - 0.3) / 2, bladeHeight / 2, 0.07)),
      new CANNON.Vec3(0, bladeHeight / 2, -GAME.pusherDepth / 2),
    );
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

    this.pusherMesh = pusherMesh;
    this.pusherBody = pusherBody;
    this.buildRails();
  }

  // Two rails, one per side, sloping in towards the centre. Visual only: the roll along them is
  // scripted (see launchFromRail), so there is no surface here for physics to catch on.
  // Built as a channel - floor, two lips, gold end trim - and not as a slab. At this camera angle
  // a bare slab reads as a rod floating inside the machine; the near lip is what puts the coin
  // visibly down inside a track. The outer end is buried in a housing sitting on the glass wall
  // for the same reason: a track has to start somewhere, or it looks like it is hanging in air.
  buildRails() {
    const lip = 0.06;
    const shell = new THREE.MeshStandardMaterial({
      ...this.surfaces.brushed,
      color: PALETTE.shellRaised,
      emissive: PALETTE.gold,
      emissiveIntensity: 0.22,
      metalness: 0.66,
      roughness: 0.3,
    });
    const trim = new THREE.MeshStandardMaterial({
      color: PALETTE.gold,
      emissive: PALETTE.gold,
      emissiveIntensity: 0.5,
      metalness: 0.7,
      roughness: 0.32,
    });
    this.railHousings = [];
    this.railParts ??= [];
    // Kept so loadCabinet can re-skin them, along with the machine's own moving parts. Nothing we
    // draw procedurally sits next to a textured model without looking pasted on, and the cheapest
    // way to belong is to be made of the same thing.
    for (const side of [-1, 1]) {
      // Local X runs the length of the rail, so the inner end - the one the coin leaves from -
      // is at -side * half length whichever side this is.
      const rail = new THREE.Group();
      const floor = new THREE.Mesh(new THREE.BoxGeometry(RAIL_LENGTH, RAIL_FLOOR, GAME.railDepth), shell);
      rail.add(floor);
      this.railParts.push(floor);
      for (const z of [-1, 1]) {
        const wall = new THREE.Mesh(new THREE.BoxGeometry(RAIL_LENGTH, 0.2, lip), shell);
        wall.position.set(0, 0.1, (z * (GAME.railDepth + lip)) / 2);
        rail.add(wall);
        this.railParts.push(wall);
      }
      const endTrim = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, 0.28, GAME.railDepth + lip * 2 + 0.06),
        trim,
      );
      endTrim.position.set((-side * RAIL_LENGTH) / 2, 0.09, 0);
      rail.add(endTrim);
      // Local +X is always world +X, so the outer end is local +X on the right rail and local -X
      // on the left one: the tilt that lifts it therefore takes the side's sign, not its inverse.
      // Inverted, both rails run uphill towards the centre and the coins visibly float above the
      // track instead of sitting in it. The centre line drops half a floor thickness so the floor's
      // top face lands exactly on railSurfaceY, which is what updateRolling rests the coin on.
      rail.position.set(
        side * (GAME.railExitX + RAIL_LENGTH / 2),
        GAME.railY + GAME.railRise / 2 - RAIL_FLOOR / 2,
        GAME.dropZoneZ,
      );
      rail.rotation.z = side * Math.atan(RAIL_SLOPE);
      this.scene.add(rail);

      // Housing over the glass wall, lit only while its rail is the one selected: the player
      // needs to see which side the next coin comes from before spending it.
      const housing = new THREE.Mesh(
        new THREE.BoxGeometry(0.46, 0.66, GAME.railDepth + 0.36),
        new THREE.MeshStandardMaterial({
          ...this.surfaces.brushed,
          color: PALETTE.shell,
          emissive: PALETTE.gold,
          emissiveIntensity: 0.2,
          metalness: 0.5,
          roughness: 0.36,
        }),
      );
      housing.position.set(side * (INNER_X + 0.125), GAME.railY + GAME.railRise + 0.12, GAME.dropZoneZ);
      this.scene.add(housing);
      this.railHousings.push({ side, mesh: housing });
      this.railParts.push(housing);
    }
  }

  // Roll a coin down the selected rail, then hand it to physics at the inner end with the pose
  // and velocity it had there. Scripted rather than simulated on a real groove: a coin balanced
  // on its edge stalls or tips on a physical rail, and a stalled coin is a spent credit that
  // never lands. Nothing here can jam, and the part the player actually watches - the arc off
  // the end and the tumble on the pile - is real physics.
  launchFromRail(side, power) {
    const coin = this.acquireCoin();
    if (!coin) return false;
    coin.isPremium = Math.random() < GAME.premiumChance;
    coin.mesh.material = this.coinMaterials[coin.isPremium ? 'premium' : 'regular'];
    coin.mesh.visible = true;
    coin.counted = false;
    coin.falling = false;
    coin.recycleAt = Infinity;
    this.rolling.push({
      coin,
      side,
      speed: launchSpeedFor(power),
      travelled: 0,
      spin: 0,
    });
    return true;
  }

  // Rolling coins are not in the world yet, so they are stepped here rather than by cannon-es.
  updateRolling(delta) {
    for (let index = this.rolling.length - 1; index >= 0; index -= 1) {
      const roll = this.rolling[index];
      roll.travelled += roll.speed * delta;
      const done = roll.travelled >= RAIL_LENGTH;
      const along = Math.min(roll.travelled, RAIL_LENGTH);
      const x = roll.side * (INNER_X - along);
      const y = railSurfaceY(along) + COIN_RADIUS;
      // Contact point stationary: omega_z = -v_x / r, and v_x is -side * speed.
      const angular = (roll.side * roll.speed) / COIN_RADIUS;
      roll.spin += angular * delta;
      roll.coin.mesh.position.set(x, y, GAME.dropZoneZ);
      roll.coin.mesh.quaternion.copy(CoinPusher.onEdgeQuaternion(roll.spin));
      if (!done) continue;
      this.rolling.splice(index, 1);
      this.releaseCoin(roll.coin, {
        position: new CANNON.Vec3(x, y, GAME.dropZoneZ),
        velocity: new CANNON.Vec3(-roll.side * roll.speed, -roll.speed * RAIL_SLOPE, 0),
        angularVelocity: new CANNON.Vec3(0, 0, angular),
        spin: roll.spin,
      });
    }
  }

  // Standing on its edge, face towards the camera, rolled by `spin` about Z. The coin model is
  // built around Y like every Three.js cylinder, so the quarter turn about X is what tips it up.
  static onEdgeQuaternion(spin) {
    return new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 0, 1), spin)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
  }

  releaseCoin(coin, { position, velocity, angularVelocity, spin }) {
    const orientation = CoinPusher.onEdgeQuaternion(spin);
    coin.body.position.copy(position);
    coin.body.previousPosition.copy(position);
    coin.body.interpolatedPosition.copy(position);
    coin.body.velocity.copy(velocity);
    coin.body.angularVelocity.copy(angularVelocity);
    coin.body.quaternion.set(orientation.x, orientation.y, orientation.z, orientation.w);
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
    const sparkColor = new THREE.Color(premium ? PALETTE.mintSoft : PALETTE.goldSoft);
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
    this.createdCoins += 1;
    return { mesh, body, isPremium, counted: false, falling: false, recycleAt: Infinity };
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

  // Side is -1 for the right rail and +1 for the left, matching world X; power is 0..1 from how
  // long the press was held.
  drop(side, power) {
    return this.launchFromRail(Math.sign(side) || 1, power);
  }

  recycleCoin(index) {
    const [coin] = this.activeCoins.splice(index, 1);
    if (!coin) return;
    this.world.removeBody(coin.body);
    coin.body.velocity.setZero();
    coin.body.angularVelocity.setZero();
    coin.mesh.visible = false;
    coin.falling = false;
    this.coinPool.push(coin);
  }

  resetPile() {
    for (const roll of this.rolling) {
      roll.coin.mesh.visible = false;
      this.coinPool.push(roll.coin);
    }
    this.rolling.length = 0;
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

  // Press a half of the canvas to arm that rail and start charging, release to launch. The charge
  // timing itself lives in main.js, which owns the buttons and the keys too - one implementation,
  // three ways in, so a hold is worth the same however the player made it.
  bindPointer() {
    let pressed = false;
    const sideAt = (clientX) => {
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width) return 1;
      // Screen-left is world +X, so the canvas's left half is the left rail.
      return (clientX - rect.left) / rect.width < 0.5 ? 1 : -1;
    };
    const onDown = (event) => {
      pressed = true;
      this.armSide(sideAt(event.clientX));
      this.canvas.setPointerCapture?.(event.pointerId);
      this.callbacks.onPressStart?.(this.armedSide);
    };
    const onUp = () => {
      if (!pressed) return;
      pressed = false;
      this.callbacks.onPressEnd?.();
    };
    const onCancel = () => {
      if (!pressed) return;
      pressed = false;
      this.callbacks.onPressCancel?.();
    };
    this.canvas.addEventListener('pointerdown', onDown);
    this.canvas.addEventListener('pointerup', onUp);
    this.canvas.addEventListener('pointercancel', onCancel);
    this.cleanup.push(() => {
      this.canvas.removeEventListener('pointerdown', onDown);
      this.canvas.removeEventListener('pointerup', onUp);
      this.canvas.removeEventListener('pointercancel', onCancel);
    });
  }

  armSide(side) { this.armedSide = Math.sign(side) || 1; }

  bindResize() {
    const resize = () => {
      const width = this.canvas.clientWidth;
      const height = this.canvas.clientHeight;
      if (!width || !height) return;
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height, false);
      this.composer?.setSize(width, height);
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
    this.updateRolling(delta);

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
        coin.body.velocity.set(0, -1.5, -3);
        coin.body.wakeUp();
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
    }
    this.updateParticles(delta);
    // Light the rail the next coin will come from. With no aim guide left, this is the only thing
    // telling the player which side they have armed.
    for (const housing of this.railHousings) {
      housing.mesh.material.emissiveIntensity = housing.side === this.armedSide ? 1.1 : 0.16;
    }
    this.pusherMesh.position.copy(this.pusherBody.interpolatedPosition);
    if (this.composer) this.composer.render(); else this.renderer.render(this.scene, this.camera);
  };

  destroy() {
    this.stop();
    this.composer?.dispose();
    this.cleanup.splice(0).forEach((cleanup) => cleanup());
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
