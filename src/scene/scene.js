import * as THREE from 'three';
import { createFerrofluid } from './ferrofluid.js';
import * as state from '../state.js';
import { SAMPLE_LIFESPAN_MS } from '../soul/evolve.js';

// elder = a sample minted at a longer-than-default tier (week / month / year / 2y).
// when one is in the pool, the room remembers and tints mint.
function hasElderSamples(samples) {
  if (!samples?.length) return false;
  return samples.some((s) => Number(s.lifespan_ms) > SAMPLE_LIFESPAN_MS);
}

// Minimal 3D stage:
// - rectangular semi-transparent shell
// - ferrofluid blob at center
// - breathing membrane (inner envelope that grows/shrinks)
// - interior white lights that push through the shell
//
// No controls. The camera slowly drifts.

export function initScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  scene.background = null;
  scene.fog = new THREE.FogExp2(0x05070a, 0.12);

  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
  camera.position.set(0, 0.35, 3.2);

  // ——— rectangular shell ———
  // a cuboid "case", semi-transparent, slightly rounded feel via segments
  const shellGeo = new THREE.BoxGeometry(1.6, 1.0, 1.0, 24, 16, 16);
  const shellMat = new THREE.MeshPhysicalMaterial({
    color: 0xe9eaee,
    transmission: 0.95,
    thickness: 0.5,
    roughness: 0.32,
    metalness: 0.0,
    ior: 1.35,
    attenuationColor: 0xaab0b8,
    attenuationDistance: 1.6,
    clearcoat: 0.4,
    clearcoatRoughness: 0.25,
    transparent: true,
    opacity: 1.0,
    side: THREE.DoubleSide,
  });
  const shell = new THREE.Mesh(shellGeo, shellMat);
  scene.add(shell);

  // subtle inner faint wireframe — gives it a "device" feel
  const cage = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1.601, 1.001, 1.001)),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.08 })
  );
  scene.add(cage);

  // ——— breathing membrane ———
  // a sphere that grows/shrinks with breath — emissive, soft
  const membraneGeo = new THREE.IcosahedronGeometry(0.55, 4);
  const membraneMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveIntensity: 0.55,
    roughness: 1.0,
    metalness: 0.0,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    side: THREE.BackSide,
  });
  const membrane = new THREE.Mesh(membraneGeo, membraneMat);
  scene.add(membrane);

  // ——— ferrofluid ———
  const ferro = createFerrofluid(0.3);
  scene.add(ferro);

  // ——— interior lights ———
  const lights = [
    new THREE.PointLight(0xffffff, 2.0, 2.2, 1.4),
    new THREE.PointLight(0xffffff, 1.2, 2.0, 1.6),
    new THREE.PointLight(0xfff6e6, 1.6, 2.0, 1.6),
  ];
  lights[0].position.set(0.0, 0.0, 0.0);
  lights[1].position.set(-0.55, 0.22, 0.2);
  lights[2].position.set(0.55, -0.2, -0.15);
  for (const l of lights) scene.add(l);

  // base tints for each light; we lerp toward mint when elder samples are alive
  const COLOR_BASE = [
    new THREE.Color(0xffffff),
    new THREE.Color(0xffffff),
    new THREE.Color(0xfff6e6),
  ];
  const SHELL_BASE_COLOR     = new THREE.Color(0xe9eaee);
  const SHELL_BASE_ATTEN     = new THREE.Color(0xaab0b8);
  // more saturated teal — the previous 0xc8f2dc was only 20% away from white
  // on each channel, so a 35% blend was imperceptible.
  const MINT            = new THREE.Color(0x33d9a8);   // for lights
  const SHELL_MINT      = new THREE.Color(0x2fc89e);   // slightly deeper for shell/body
  const SHELL_MINT_ATTEN = new THREE.Color(0x1f9a77);  // deeper still for transmission tint

  // a gentle ambient so the outside has definition
  scene.add(new THREE.AmbientLight(0x223044, 0.35));
  // rim light from camera side to draw edges of the shell
  const rim = new THREE.DirectionalLight(0xbcd0ff, 0.4);
  rim.position.set(2, 2.5, 2.5);
  scene.add(rim);

  // ——— sizing ———
  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  // ——— live signals ———
  let pulse = { breath: 0.5, amp: 0.6, phase: 'awake' };
  let sampleFlash = 0; // brief spike on new sample
  let mintTarget = hasElderSamples(state.currentSamples()) ? 1 : 0;
  let mintAmount = mintTarget;  // start at target so we don't fade in on refresh
  let forceMintUntil = 0;       // DevTools override — __forceMint(seconds)

  function updateMint(samples, reason) {
    const hasElder = hasElderSamples(samples);
    const next = hasElder ? 1 : 0;
    if (next !== mintTarget) {
      console.log('[mint]', reason, '→', next ? 'ON' : 'off', {
        poolSize: samples?.length ?? 0,
        elderIds: (samples || []).filter((s) => Number(s.lifespan_ms) > SAMPLE_LIFESPAN_MS).map((s) => s.id),
      });
    }
    mintTarget = next;
  }
  // re-check elder status on a slow timer since samples cross the threshold silently
  setInterval(() => updateMint(state.currentSamples(), 'timer'), 30_000);
  state.on('pulse', (p) => { pulse = p; });
  state.on('sample', (samples) => {
    sampleFlash = 1.0;
    updateMint(samples, 'sample event');
  });

  // DevTools helpers:
  //   __mintState()        — report current mint status + elder rows
  //   __forceMint(15)      — override tint ON for 15 seconds (no elder needed)
  window.__mintState = () => {
    const samples = state.currentSamples();
    const elders = (samples || []).filter((s) => Number(s.lifespan_ms) > SAMPLE_LIFESPAN_MS);
    return {
      mintTarget,
      mintAmount: mintAmount.toFixed(3),
      poolSize: samples?.length ?? 0,
      elderCount: elders.length,
      elders: elders.map((s) => ({ id: s.id, lifespan_ms: s.lifespan_ms, created_at: s.created_at })),
      forceUntil: forceMintUntil ? new Date(forceMintUntil).toISOString() : null,
    };
  };
  window.__forceMint = (seconds = 15) => {
    forceMintUntil = Date.now() + seconds * 1000;
    console.log(`[mint] forced ON for ${seconds}s`);
    return forceMintUntil;
  };

  const clock = new THREE.Clock();
  let t0 = 0;
  // smoothed copies of amp + awake-ness so phase transitions glide instead of
  // snapping. asymmetric tau matches the audio engine: slow fade out, fast wake up.
  let smoothedAmp = null;
  let smoothedAwake = null;

  function render() {
    const dt = clock.getDelta();
    t0 += dt;

    const breath = pulse.breath ?? 0.5;
    const rawAmp = pulse.amp ?? 0.6;
    const rawAwake = pulse.phase === 'awake' || pulse.phase === 'waking' ? 1 : pulse.phase === 'breathing' ? 0.5 : 0.15;

    if (smoothedAmp == null) smoothedAmp = rawAmp;
    if (smoothedAwake == null) smoothedAwake = rawAwake;
    const ampTau   = rawAmp   < smoothedAmp   ? 35 : 2.5;
    const awakeTau = rawAwake < smoothedAwake ? 35 : 2.5;
    smoothedAmp   += (rawAmp   - smoothedAmp)   * (1 - Math.exp(-dt / ampTau));
    smoothedAwake += (rawAwake - smoothedAwake) * (1 - Math.exp(-dt / awakeTau));

    const amp = smoothedAmp;
    const phaseAwake = smoothedAwake;

    const membraneScale = 0.85 + breath * 0.3;
    membrane.scale.setScalar(membraneScale);
    membrane.material.opacity = 0.14 + breath * 0.18 + phaseAwake * 0.05;
    membrane.material.emissiveIntensity = 0.3 + breath * 0.55 + phaseAwake * 0.25;
    membrane.rotation.y += dt * 0.05;
    membrane.rotation.x += dt * 0.03;

    // ferrofluid reacts to amplitude and breath + transient spike
    ferro.material.uniforms.uTime.value = t0;
    ferro.material.uniforms.uEnergy.value = amp * (0.45 + breath * 0.55);
    sampleFlash = Math.max(0, sampleFlash - dt * 1.2);
    ferro.material.uniforms.uSpike.value = sampleFlash;
    ferro.rotation.y += dt * 0.12 * amp;
    ferro.rotation.x += dt * 0.05 * amp;

    // interior lights pulse with breath + phase
    const lightBase = 0.5 + phaseAwake * 1.4;
    lights[0].intensity = lightBase + breath * 1.6;
    lights[1].intensity = lightBase * 0.7 + breath * 1.0;
    lights[2].intensity = lightBase * 0.85 + (1 - breath) * 0.8;

    // gradually lerp mintAmount toward mintTarget (~8s time constant)
    const effectiveTarget = Date.now() < forceMintUntil ? 1 : mintTarget;
    mintAmount += (effectiveTarget - mintAmount) * (1 - Math.exp(-dt / 8));
    // apply mint blend to the interior lights; center light gets slightly less
    // so the ferrofluid's silhouette stays readable.
    const lightTint = mintAmount * 0.55;
    lights[0].color.copy(COLOR_BASE[0]).lerp(MINT, lightTint * 0.7);
    lights[1].color.copy(COLOR_BASE[1]).lerp(MINT, lightTint);
    lights[2].color.copy(COLOR_BASE[2]).lerp(MINT, lightTint * 0.85);
    // also tint the shell itself — the cube body reads teal when elders live.
    // attenuationColor is what light picks up passing through the material, so
    // it gets the strongest blend and is what 'feels' like the cube's color.
    shellMat.color.copy(SHELL_BASE_COLOR).lerp(SHELL_MINT, mintAmount * 0.55);
    shellMat.attenuationColor.copy(SHELL_BASE_ATTEN).lerp(SHELL_MINT_ATTEN, mintAmount * 0.85);

    // camera drifts in a slow lissajous — never repeats
    const d = 3.3 + 0.12 * Math.sin(t0 * 0.13);
    camera.position.x = Math.sin(t0 * 0.07) * 0.55;
    camera.position.y = 0.25 + Math.sin(t0 * 0.11 + 1.3) * 0.18;
    camera.position.z = d;
    camera.lookAt(0, 0, 0);

    // shell tint shifts with phase — derive from smoothed awake so it glides too
    const shellWarm = 0.85 + phaseAwake * 0.15;
    shellMat.attenuationDistance = 1.1 + breath * 0.8;
    shellMat.opacity = 0.85 + phaseAwake * 0.1 * shellWarm;

    renderer.render(scene, camera);
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  return { scene, camera, renderer };
}
