import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GAME, PALETTE } from './config.js';
import { clampAim, coinPhase, screenAimToWorld, worldAimToScreen } from './rules.js';
import {
  COIN_HEIGHT,
  COIN_RADIUS,
  CONTACT_SOLVER_OPTIONS,
  TUNING_DEFAULTS,
  applyCoinTuning,
  createCoinBody,
  pusherMotionAt,
  seedPosition,
} from './physics.js';

// One pusher half-stroke, entered at full retreat (runPusherToFullRetreat): long enough for
// the seeded stack to collapse and be squeezed forward once. Every step of it is simulated
// before the first frame, so this is also the load-time cost of the opening pile - ~1.5 s on
// a 2024 laptop, and cylinder-vs-cylinder narrowphase is the whole of it. Halving it halves
// the cost and visibly puts the rows back, so it is a look/load knob, not free headroom.
const PILE_SETTLE_SECONDS = Math.PI / GAME.pusherSpeed;
const SETTLE_SOLVER_ITERATIONS = 12;

export class CoinPusher {
  constructor(canvas, quality, callbacks = {}) {
    this.canvas = canvas;
    this.quality = quality;
    this.callbacks = callbacks;
    this.aimX = 0;
    this.elapsed = 0;
    this.running = false;
    this.activeCoins = [];
    this.coinPool = [];
    this.createdCoins = 0;
    this.recycleDelay = 0.38;
    this.frameId = 0;
    this.cleanup = [];
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
    await this.setupBloom();
    this.setupParticles();
    this.addAimGuide();
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

    const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 100);
    camera.position.set(0, 8.6, -9.8);
    camera.lookAt(0, -0.3, 0.15);
    this.camera = camera;

    scene.add(new THREE.HemisphereLight(0xf2fbff, 0x0e1c26, 1.35));
    const key = new THREE.DirectionalLight(0xeaf6ff, this.quality.shadows ? 2.35 : 1.85);
    key.position.set(-4, 10, -6);
    key.castShadow = this.quality.shadows;
    key.shadow.mapSize.set(this.quality.lowPower ? 512 : 1024, this.quality.lowPower ? 512 : 1024);
    Object.assign(key.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 1, far: 30 });
    scene.add(key);

    const playfieldFill = new THREE.PointLight(0xffe8c7, 5.2, 18);
    playfieldFill.position.set(0, 5.5, -2.5);
    scene.add(playfieldFill);

    // Brand colors remain as restrained accent light instead of tinting the machine.
    const tealAccent = new THREE.PointLight(PALETTE.mint, 2.6, 16);
    tealAccent.position.set(-3.5, 3.5, -3.5);
    scene.add(tealAccent);
    const goldAccent = new THREE.PointLight(PALETTE.gold, 1.1, 12);
    goldAccent.position.set(3.5, 3.8, -1);
    scene.add(goldAccent);
    // Cool rim from behind the cabinet, matching the mock's corridor lighting.
    const rimAccent = new THREE.PointLight(PALETTE.blue, 3.2, 18);
    rimAccent.position.set(0, 4.2, 5.2);
    scene.add(rimAccent);
    const purpleAccent = new THREE.PointLight(PALETTE.purple, 2.2, 16);
    purpleAccent.position.set(3.8, 1.6, 3.2);
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
    const model = await new GLTFLoader().loadAsync('/models/coin.glb');
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
    const premium = regular.clone();
    this.coinMaterials = { regular, premium };

    sourceMeshes.forEach((mesh) => {
      mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((material) => material.dispose());
    });
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

  addStaticBox(width, height, depth, x, y, z, color, options = {}) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(width, height, depth),
      new THREE.MeshStandardMaterial({
        color,
        roughness: options.roughness ?? 0.78,
        metalness: options.metalness ?? 0.16,
        emissive: options.emissive ?? 0x000000,
        emissiveIntensity: options.emissiveIntensity ?? 0,
        map: options.map ?? null,
      }),
    );
    mesh.position.set(x, y, z);
    mesh.receiveShadow = this.quality.shadows && Boolean(options.receiveShadow);
    this.scene.add(mesh);
    if (!options.visualOnly) {
      const body = new CANNON.Body({ mass: 0, material: this.groundMaterial });
      body.addShape(new CANNON.Box(new CANNON.Vec3(width / 2, height / 2, depth / 2)));
      body.position.set(x, y, z);
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

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.MeshStandardMaterial({
        color: 0x04121c,
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
        color: PALETTE.mint,
        transparent: true,
        opacity: 0.32,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(0, -2.74, -0.5);
    this.scene.add(pool);

    const grid = new THREE.GridHelper(64, 32, PALETTE.mint, PALETTE.mint);
    grid.position.y = -2.76;
    Object.assign(grid.material, { transparent: true, opacity: 0.07, depthWrite: false });
    this.scene.add(grid);

    const columnGeometry = new THREE.CapsuleGeometry(0.16, 8.4, 4, 8);
    for (const [x, z, color] of [[-4.9, 2.2, PALETTE.mint], [4.9, 2.2, PALETTE.mint], [-6.4, 6.5, PALETTE.blue], [6.4, 6.5, PALETTE.purple]]) {
      const column = new THREE.Mesh(
        columnGeometry,
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.7, roughness: 0.3 }),
      );
      column.position.set(x, 1.9, z);
      this.scene.add(column);
    }
  }

  // Headboard: glowing arch frame, dark inner panel, hexagon CP badge, gold sill.
  buildHeadboard() {
    const extrude = { depth: 0.3, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 2, curveSegments: 10 };
    const frame = new THREE.Mesh(
      new THREE.ExtrudeGeometry(CoinPusher.roundedRect(6.5, 3.5, 0.85), extrude),
      new THREE.MeshStandardMaterial({ color: PALETTE.mint, emissive: PALETTE.mint, emissiveIntensity: 1.05, roughness: 0.35, metalness: 0.3 }),
    );
    frame.position.set(0, 1.75, GAME.playfieldBackZ + 0.5);
    this.scene.add(frame);
    this.neon.push(frame);

    const panel = new THREE.Mesh(
      new THREE.ExtrudeGeometry(CoinPusher.roundedRect(5.6, 2.7, 0.6), extrude),
      new THREE.MeshStandardMaterial({
        color: PALETTE.dark,
        roughness: 0.42,
        metalness: 0.55,
        envMap: this.environmentTexture,
        envMapIntensity: 0.5,
      }),
    );
    panel.position.set(0, 1.75, GAME.playfieldBackZ + 0.34);
    this.scene.add(panel);

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

    // Gold sill under the headboard, matching the front lip.
    this.addStaticBox(5.9, 0.1, 0.34, 0, 0.16, GAME.playfieldBackZ + 0.42, PALETTE.gold, {
      emissive: PALETTE.gold,
      emissiveIntensity: 0.4,
      visualOnly: true,
    });
  }

  // Rounded corner posts and gold rails that give the boxy cabinet the mock's soft silhouette.
  buildCabinetShell() {
    const playfieldDepth = GAME.playfieldBackZ - GAME.playfieldFrontZ;
    const playfieldCenter = (GAME.playfieldBackZ + GAME.playfieldFrontZ) / 2;
    const postGeometry = new THREE.CapsuleGeometry(0.17, 2.15, 4, 10);
    const postMaterial = new THREE.MeshStandardMaterial({
      color: 0x2a6b74,
      roughness: 0.3,
      metalness: 0.5,
      emissive: PALETTE.mint,
      emissiveIntensity: 0.12,
      envMap: this.environmentTexture,
      envMapIntensity: 1.1,
    });
    for (const x of [-2.78, 2.78]) {
      for (const z of [GAME.playfieldFrontZ + 0.1, GAME.playfieldBackZ - 0.1]) {
        const post = new THREE.Mesh(postGeometry, postMaterial);
        post.position.set(x, 0.95, z);
        this.scene.add(post);
      }
      // Outer skirt closes the gap between the posts.
      this.addStaticBox(0.3, 2.5, playfieldDepth - 0.2, x, 0.9, playfieldCenter, PALETTE.metal, {
        roughness: 0.34,
        metalness: 0.72,
        visualOnly: true,
      });
    }
  }

  buildMachine() {
    this.buildBackdrop();
    // Lower stationary playfield and cabinet.
    const playfieldDepth = GAME.playfieldBackZ - GAME.playfieldFrontZ;
    const playfieldCenter = (GAME.playfieldBackZ + GAME.playfieldFrontZ) / 2;
    this.addStaticBox(5, 0.5, playfieldDepth, 0, -0.25, playfieldCenter, PALETTE.felt, { roughness: 0.42, metalness: 0.3, receiveShadow: true });
    const backPanel = this.addStaticBox(5, 2.6, 0.25, 0, 1.05, GAME.playfieldBackZ + 0.05, PALETTE.dark, { map: this.createBackTexture() });
    Object.assign(backPanel.material, {
      emissiveMap: this.backTexture,
      emissive: new THREE.Color(PALETTE.white),
      emissiveIntensity: 0.5,
    });
    // Side walls read as tinted glass, so the pile stays visible through them like the mock.
    for (const x of [-2.55, 2.55]) {
      const glass = this.addStaticBox(0.25, 2.4, playfieldDepth + 0.2, x, 0.95, playfieldCenter, PALETTE.mint, {
        metalness: 0.1,
        roughness: 0.08,
      });
      Object.assign(glass.material, {
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        envMap: this.environmentTexture,
        envMapIntensity: 1.6,
      });
    }
    this.neon = [
      this.addStaticBox(0.14, 0.14, playfieldDepth + 0.2, -2.55, 2.2, playfieldCenter, PALETTE.mint, { emissive: PALETTE.mint, emissiveIntensity: 0.85, visualOnly: true }),
      this.addStaticBox(0.14, 0.14, playfieldDepth + 0.2, 2.55, 2.2, playfieldCenter, PALETTE.mint, { emissive: PALETTE.mint, emissiveIntensity: 0.85, visualOnly: true }),
    ];
    this.frontTrim = this.addStaticBox(5, 0.12, 0.14, 0, -0.02, GAME.playfieldFrontZ - 0.02, PALETTE.gold, { emissive: PALETTE.gold, emissiveIntensity: 0.45, visualOnly: true });
    this.addStaticBox(5.4, 0.3, 2, 0, -2.4, -4.8, PALETTE.dark, { receiveShadow: true });
    this.addStaticBox(5.5, 0.09, 0.12, 0, -2.2, -5.87, PALETTE.mint, {
      emissive: PALETTE.mint,
      emissiveIntensity: 0.7,
      visualOnly: true,
    });
    // Lit payout chute, so the tray is not a black hole under the playfield.
    const chuteGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(5.2, 2.1),
      new THREE.MeshBasicMaterial({
        map: this.glowTexture,
        color: PALETTE.mint,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    chuteGlow.rotation.x = -Math.PI / 2;
    chuteGlow.position.set(0, -2.23, -4.8);
    this.scene.add(chuteGlow);
    this.addStaticBox(0.2, 1.2, 2, -2.6, -1.9, -4.8, PALETTE.metal);
    this.addStaticBox(0.2, 1.2, 2, 2.6, -1.9, -4.8, PALETTE.metal);
    this.addStaticBox(5.4, 1.2, 0.2, 0, -1.9, -5.7, PALETTE.metal);

    // A fixed rear deck closes the dead zone the retreating tray leaves behind. It sits a
    // hair below the tray so the tray slides over it and a coin never rests on both at once.
    this.addStaticBox(4.8, GAME.upperTrayHeight, 2.1, 0, GAME.upperTrayY - GAME.deckClearance, 2.9, 0x0d2632, {
      roughness: 0.45,
      metalness: 0.38,
      receiveShadow: true,
    });
    this.scraper = this.addStaticBox(4.8, 0.68, 0.16, 0, 1.05, GAME.scraperZ, PALETTE.metal, {
      roughness: 0.4,
      metalness: 0.7,
      emissive: PALETTE.mint,
      emissiveIntensity: 0.35,
    });
    const scraperStrip = this.addStaticBox(4.65, 0.08, 0.19, 0, 0.73, GAME.scraperZ - 0.02, PALETTE.gold, {
      emissive: PALETTE.gold,
      emissiveIntensity: 0.4,
      visualOnly: true,
    });
    this.scraperStrip = scraperStrip;

    // Moving upper tray: coins land here, meet the fixed scraper, then spill to the lower bed.
    const pusherMesh = new THREE.Group();
    const trayMaterial = new THREE.MeshStandardMaterial({ color: 0x143844, metalness: 0.55, roughness: 0.35 });
    const tray = new THREE.Mesh(
      new THREE.BoxGeometry(4.7, GAME.upperTrayHeight, GAME.pusherDepth),
      trayMaterial,
    );
    tray.position.y = GAME.upperTrayY;
    tray.castShadow = this.quality.shadows;
    tray.receiveShadow = this.quality.shadows;
    pusherMesh.add(tray);

    const trayTop = new THREE.Mesh(
      new THREE.BoxGeometry(4.5, 0.035, GAME.pusherDepth - 0.12),
      new THREE.MeshStandardMaterial({ color: 0x0d4d55, metalness: 0.25, roughness: 0.55 }),
    );
    trayTop.position.y = GAME.upperTrayY + GAME.upperTrayHeight / 2 + 0.018;
    pusherMesh.add(trayTop);

    const bladeHeight = 0.64;
    const blade = new THREE.Mesh(
      new THREE.BoxGeometry(4.7, bladeHeight, 0.14),
      new THREE.MeshStandardMaterial({ color: 0x16303d, metalness: 0.72, roughness: 0.3 }),
    );
    blade.position.set(0, bladeHeight / 2, -GAME.pusherDepth / 2);
    blade.castShadow = this.quality.shadows;
    pusherMesh.add(blade);

    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(4.7, 0.11, 0.075),
      new THREE.MeshStandardMaterial({ color: PALETTE.mint, emissive: PALETTE.mint, emissiveIntensity: 0.7 }),
    );
    strip.position.set(0, 0.55, -GAME.pusherDepth / 2 - 0.075);
    pusherMesh.add(strip);

    for (const x of [-2.3, 2.3]) {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, 0.12, GAME.pusherDepth),
        new THREE.MeshStandardMaterial({ color: PALETTE.mint, emissive: PALETTE.mint, emissiveIntensity: 0.45 }),
      );
      rail.position.set(x, 0.79, 0);
      pusherMesh.add(rail);
    }
    this.scene.add(pusherMesh);
    this.buildCabinetShell();
    this.buildHeadboard();

    const pusherBody = new CANNON.Body({ mass: 0, material: this.pusherMaterial, type: CANNON.Body.KINEMATIC });
    pusherBody.addShape(
      new CANNON.Box(new CANNON.Vec3(2.35, GAME.upperTrayHeight / 2, GAME.pusherDepth / 2)),
      new CANNON.Vec3(0, GAME.upperTrayY, 0),
    );
    pusherBody.addShape(
      new CANNON.Box(new CANNON.Vec3(2.35, bladeHeight / 2, 0.07)),
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
  }

  addAimGuide() {
    const trayTopY = GAME.upperTrayY + GAME.upperTrayHeight / 2;
    const guideHeight = 3.05;
    this.aimGuide = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, guideHeight, 8),
      new THREE.MeshBasicMaterial({ color: PALETTE.mint, transparent: true, opacity: 0.38 }),
    );
    this.aimGuide.position.set(0, trayTopY + guideHeight / 2, GAME.dropZoneZ);
    this.scene.add(this.aimGuide);
    this.aimRing = new THREE.Mesh(
      new THREE.RingGeometry(0.32, 0.47, 24),
      new THREE.MeshBasicMaterial({ color: PALETTE.mint, transparent: true, opacity: 0.7, side: THREE.DoubleSide }),
    );
    this.aimRing.rotation.x = -Math.PI / 2;
    this.aimRing.position.set(0, trayTopY + 0.025, GAME.dropZoneZ);
    this.scene.add(this.aimRing);

    this.dropNozzle = new THREE.Mesh(
      new THREE.TorusGeometry(0.22, 0.065, 8, 20),
      new THREE.MeshStandardMaterial({
        color: PALETTE.mintSoft,
        emissive: PALETTE.mint,
        emissiveIntensity: 0.8,
        metalness: 0.25,
        roughness: 0.35,
      }),
    );
    this.dropNozzle.rotation.x = Math.PI / 2;
    this.dropNozzle.position.set(0, 3.85, GAME.dropZoneZ);
    this.scene.add(this.dropNozzle);
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

  spawnCoin(x, y, z, seed = false) {
    const coin = this.acquireCoin();
    if (!coin) return false;
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
    if (seed) coin.body.velocity.set((Math.random() - 0.5) * 0.8, 0, (Math.random() - 0.5) * 0.8);
    else coin.body.velocity.set(0, -1, 0);
    coin.body.angularVelocity.set((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 2);
    const yaw = new CANNON.Quaternion();
    yaw.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), Math.random() * Math.PI * 2);
    const tilt = new CANNON.Quaternion();
    tilt.setFromAxisAngle(
      new CANNON.Vec3(Math.random(), 0, Math.random()),
      (Math.random() - 0.5) * (seed ? 0.42 : 0.3),
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

  dropAtAim() {
    return this.spawnCoin(this.aimX, 4, GAME.dropZoneZ, false);
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
    for (let index = this.activeCoins.length - 1; index >= 0; index -= 1) this.recycleCoin(index);
    this.runPusherToFullRetreat();
    const pileSeed = Math.floor(Math.random() * 1_000_000_000);
    for (let index = 0; index < this.quality.seedCount; index += 1) {
      const position = seedPosition(index, pileSeed, this.tuning.thickness, this.pusherBody.position.z);
      this.spawnCoin(position.x, position.y, position.z, true);
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

  setAim(value) {
    this.aimX = clampAim(value);
    this.callbacks.onAim?.(this.aimX);
  }

  setEnvironmentRotation(horizontalDegrees, verticalDegrees) {
    const horizontal = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(horizontalDegrees, -180, 180));
    const vertical = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(verticalDegrees, -90, 90));
    Object.values(this.coinMaterials).forEach((material) => {
      material.envMapRotation.set(vertical, horizontal, 0);
    });
  }

  setAimFromScreen(value) { this.setAim(screenAimToWorld(value)); }

  moveAimOnScreen(delta) {
    this.setAimFromScreen(worldAimToScreen(this.aimX) + delta);
  }

  bindPointer() {
    let dragging = false;
    let moved = false;
    let startX = 0;
    const pointAim = (clientX) => {
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width) return;
      this.setAimFromScreen((((clientX - rect.left) / rect.width) - 0.5) * 4.4);
    };
    const onDown = (event) => {
      dragging = true;
      moved = false;
      startX = event.clientX;
      pointAim(event.clientX);
      this.canvas.setPointerCapture?.(event.pointerId);
    };
    const onMove = (event) => {
      if (!dragging) return;
      moved ||= Math.abs(event.clientX - startX) > 5;
      pointAim(event.clientX);
    };
    const onUp = (event) => {
      if (!dragging) return;
      dragging = false;
      pointAim(event.clientX);
      if (!moved) this.callbacks.onTap?.();
    };
    const onCancel = () => { dragging = false; };
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

    // The postStep handler advances the kinematic tray along an exact bounded sine stroke.
    this.world.step(this.quality.physicsStep, delta, this.quality.physicsMaxSubSteps);

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
      this.frontTrim.material.emissiveIntensity = 0.4 + 0.15 * Math.sin(this.elapsed * 3 + 1);
    }
    this.updateParticles(delta);
    this.aimGuide.position.x = this.aimX;
    this.aimRing.position.x = this.aimX;
    this.dropNozzle.position.x = this.aimX;
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
