import * as THREE from 'three';
import { createFerrofluid } from './ferrofluid.js';
import * as state from '../state.js';

const ELDER_THRESHOLD_MS = 3 * 60 * 60 * 1000;  // 3 hours — anything older tints the room mint

function hasElderSamples(samples) {
  if (!samples?.length) return false;
  const now = Date.now();
  return samples.some((s) => now - new Date(s.created_at).getTime() > ELDER_THRESHOLD_MS);
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
  const MINT = new THREE.Color(0xc8f2dc);  // soft mint, restrained

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
  // re-check elder status on a slow timer since samples cross the 3h line silently
  setInterval(() => { mintTarget = hasElderSamples(state.currentSamples()) ? 1 : 0; }, 30_000);
  state.on('pulse', (p) => { pulse = p; });
  state.on('sample', (samples) => {
    sampleFlash = 1.0;
    mintTarget = hasElderSamples(samples) ? 1 : 0;
  });

  const clock = new THREE.Clock();
  let t0 = 0;

  function render() {
    const dt = clock.getDelta();
    t0 += dt;

    // breath drives membrane scale + opacity + light intensity
    const breath = pulse.breath ?? 0.5;
    const amp = pulse.amp ?? 0.6;
    const phaseAwake = pulse.phase === 'awake' || pulse.phase === 'waking' ? 1 : pulse.phase === 'breathing' ? 0.5 : 0.15;

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
    mintAmount += (mintTarget - mintAmount) * (1 - Math.exp(-dt / 8));
    // apply a gentle mint blend to each light. center light gets slightly less
    // so the ferrofluid's silhouette stays readable.
    const tint = mintAmount * 0.35;
    lights[0].color.copy(COLOR_BASE[0]).lerp(MINT, tint * 0.65);
    lights[1].color.copy(COLOR_BASE[1]).lerp(MINT, tint);
    lights[2].color.copy(COLOR_BASE[2]).lerp(MINT, tint * 0.85);

    // camera drifts in a slow lissajous — never repeats
    const d = 3.3 + 0.12 * Math.sin(t0 * 0.13);
    camera.position.x = Math.sin(t0 * 0.07) * 0.55;
    camera.position.y = 0.25 + Math.sin(t0 * 0.11 + 1.3) * 0.18;
    camera.position.z = d;
    camera.lookAt(0, 0, 0);

    // shell tint shifts with phase
    const shellWarm = pulse.phase === 'sleeping' ? 0.85 : pulse.phase === 'breathing' ? 0.92 : 1.0;
    shellMat.attenuationDistance = 1.1 + breath * 0.8;
    shellMat.opacity = 0.85 + phaseAwake * 0.1 * shellWarm;

    renderer.render(scene, camera);
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  return { scene, camera, renderer };
}
