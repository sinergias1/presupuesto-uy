/*
 * flujo3d.js - Prototipo 3D: la plata del Estado como flujos de luz (three.js).
 *
 * Reutiliza model.js (specGeneral) para obtener exactamente los mismos nodos y flujos
 * que el Sankey clásico, y los dibuja como bloques en 3 columnas unidos por miles de
 * partículas. No cambia ningún dato. El texto que sale de los datos pasa siempre por
 * model.js (esc) o por textContent.
 */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js';

const M = window.FinanzasModel;
const $ = (id) => document.getElementById(id);

// Colores por fondo (la entidad, no la posición). Luz sobre negro.
const COLOR_FUENTE = { '11': '#4aa3ff', '12': '#ff7a45', '15': '#2fd6a1', '21': '#ffc233' };
const GRIS = '#8b94a3';
const ACERO = '#b9cfec';
const colorFuente = (codigo) => COLOR_FUENTE[codigo] || GRIS;

const REDUCIR = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const MOVIL = Math.min(innerWidth, innerHeight) < 700;
if (innerWidth / innerHeight < 0.85) document.body.classList.add('vertical');
const N_PARTICULAS = MOVIL ? 20000 : 60000;

// En pantallas verticales (celular) las columnas se acercan y el gráfico se alarga, y las
// etiquetas de los costados van hacia adentro para no salirse de la pantalla.
const VERTICAL = innerWidth / innerHeight < 0.85;
const X_COL = VERTICAL ? [-4.6, 0, 4.6] : [-9.5, 0, 9.5];
const ANCHO_NODO = 0.3;
const PROF = VERTICAL ? 1.2 : 1.7; // profundidad (z) de los bloques y de las corrientes
const ALTO_TOTAL = VERTICAL ? 14 : 11;
const HUECO = 0.3;

function aviso(html) {
  const a = $('aviso');
  a.replaceChildren();
  a.insertAdjacentHTML('beforeend', html);
  a.hidden = false;
}

function webglDisponible() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch (e) { return false; }
}

async function cargar() {
  const r = await fetch('data/2025/overview.json');
  if (!r.ok) throw new Error('No se pudo cargar overview.json (' + r.status + ')');
  return r.json();
}

// --------------------------------------------------------------------------- layout
function disponer(spec) {
  const cols = [[], [], []];
  spec.nodes.forEach((n) => { if (cols[n.col]) cols[n.col].push(n); });
  const suma = (c) => c.reduce((a, n) => a + n.valor, 0);
  const mayor = Math.max(...cols.map((c) => suma(c) + HUECO * Math.max(0, c.length - 1) * 0 )); // en pesos
  // Escala: la columna más alta (incluyendo huecos) ocupa ALTO_TOTAL.
  const maxHuecos = Math.max(...cols.map((c) => Math.max(0, c.length - 1)));
  const escala = (ALTO_TOTAL - HUECO * maxHuecos) / mayor;

  const pos = new Map();
  cols.forEach((c, i) => {
    const alto = suma(c) * escala + HUECO * Math.max(0, c.length - 1);
    let y = alto / 2; // arriba
    c.forEach((n) => {
      const h = Math.max(n.valor * escala, 0.04);
      pos.set(n.id, { n, x: X_COL[i], top: y, h, centro: y - h / 2, col: i, usadoSale: 0, usadoEntra: 0 });
      y -= h + HUECO;
    });
  });

  // Cada enlace ocupa una "rebanada" dentro de su origen y de su destino, ordenadas para cruzarse poco.
  const enlaces = spec.links.map((l) => ({ l, s: pos.get(l.source), t: pos.get(l.target), h: l.valor * escala }));
  pos.forEach((p) => {
    const sal = enlaces.filter((e) => e.s === p).sort((a, b) => b.t.centro - a.t.centro);
    let y = p.top;
    sal.forEach((e) => { e.y0 = y; y -= e.h; });
    const ent = enlaces.filter((e) => e.t === p).sort((a, b) => b.s.centro - a.s.centro);
    y = p.top;
    ent.forEach((e) => { e.y1 = y; y -= e.h; });
  });
  return { pos, enlaces, escala };
}

// --------------------------------------------------------------------------- escena
async function iniciar() {
  if (!M) throw new Error('model.js no cargó');
  if (!webglDisponible()) {
    aviso('Tu navegador no puede mostrar gráficos 3D (WebGL). <a href="index.html">Ver el gráfico clásico</a>.');
    return;
  }
  const ov = await cargar();
  const spec = M.specGeneral(ov);
  const { pos, enlaces } = disponer(spec);

  // --- HUD
  const leyenda = $('leyenda');
  M.leyendaFuentes(spec).forEach((f) => {
    const li = document.createElement('li');
    const i = document.createElement('i');
    i.style.color = colorFuente(f.codigo);
    li.append(i, document.createTextNode(f.nombre));
    leyenda.append(li);
  });
  const t = ov.totales;
  const cifras = [
    ['Se espera cobrar', M.fmtMonto(t.recursos)],
    ['Se puede gastar', M.fmtMonto(t.gasto)],
    [t.diferencia < 0 ? 'Falta para cubrir' : 'Sobra', M.fmtMonto(Math.abs(t.diferencia))],
  ];
  $('cifras').replaceChildren(...cifras.map(([k, v]) => {
    const d = document.createElement('div');
    d.className = 'cifra';
    const s = document.createElement('small'); s.textContent = k;
    const b = document.createElement('strong'); b.textContent = v;
    d.append(s, b);
    return d;
  }));

  // --- renderer, escena, cámara
  const canvas = $('lienzo');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, MOVIL ? 1.5 : 2));
  renderer.setClearColor(0x04060a, 1);
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x04060a, 0.022);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);

  // suelo tipo cuadrícula (luz tenue) y polvo de estrellas lejano
  const grid = new THREE.GridHelper(70, 70, 0x1c3a5e, 0x0e1e33);
  grid.position.y = -ALTO_TOTAL / 2 - 1.2;
  scene.add(grid);
  const nEstrellas = 900;
  const ge = new THREE.BufferGeometry();
  const pe = new Float32Array(nEstrellas * 3);
  for (let i = 0; i < nEstrellas; i++) {
    pe[i * 3] = (Math.random() - 0.5) * 120;
    pe[i * 3 + 1] = (Math.random() - 0.3) * 60;
    pe[i * 3 + 2] = -20 - Math.random() * 60;
  }
  ge.setAttribute('position', new THREE.BufferAttribute(pe, 3));
  scene.add(new THREE.Points(ge, new THREE.PointsMaterial({ color: 0x5f8fd0, size: 0.08, transparent: true, opacity: 0.55, sizeAttenuation: true, depthWrite: false })));

  // --- bloques (nodos)
  const meshes = [];
  const etiquetas = $('etiquetas');
  pos.forEach((p) => {
    const n = p.n;
    const c = new THREE.Color(n.kind === 'fuente' ? colorFuente(n.fuente) : n.kind === 'ajuste' ? GRIS : ACERO);
    const geo = new THREE.BoxGeometry(ANCHO_NODO, p.h, PROF);
    const mat = new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.28 });
    const m = new THREE.Mesh(geo, mat);
    m.position.set(p.x, p.centro, 0);
    m.userData = { p };
    scene.add(m);
    const borde = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.95 }));
    borde.position.copy(m.position);
    scene.add(borde);
    p.mesh = m; p.mat = mat; p.borde = borde; p.realce = 0;
    meshes.push(m);

    const d = document.createElement('div');
    d.className = 'lbl' + (n.kind === 'fuente' ? ' fuente' : '');
    const b = document.createElement('b'); b.textContent = n.label + (n.drillable ? ' ›' : '');
    const s = document.createElement('span'); s.textContent = M.fmtMonto(n.valor);
    d.append(b, s);
    etiquetas.append(d);
    p.etiqueta = d;
  });

  // --- partículas
  const total = spec.links.reduce((a, l) => a + l.valor, 0);
  const parts = [];
  enlaces.forEach((e, idx) => {
    const cuantas = Math.max(60, Math.round((e.l.valor / total) * N_PARTICULAS));
    const col = new THREE.Color(e.l.fuente ? colorFuente(e.l.fuente) : GRIS);
    for (let k = 0; k < cuantas; k++) {
      const br = 0.75 + Math.random() * 0.5;
      parts.push({
        e, idx, t: Math.random(), v: Math.random(), z: (Math.random() - 0.5) * (PROF * 0.9),
        vel: 0.07 + Math.random() * 0.08, tam: 0.05 + Math.random() * 0.06,
        r: Math.min(1, col.r * br), g: Math.min(1, col.g * br), b: Math.min(1, col.b * br),
      });
    }
  });
  const n = parts.length;
  const aPos = new Float32Array(n * 3), aT = new Float32Array(n), aSize = new Float32Array(n), aCol = new Float32Array(n * 3);
  parts.forEach((q, i) => { aCol[i * 3] = q.r; aCol[i * 3 + 1] = q.g; aCol[i * 3 + 2] = q.b; aT[i] = q.t; aSize[i] = q.tam; });
  const gp = new THREE.BufferGeometry();
  gp.setAttribute('position', new THREE.BufferAttribute(aPos, 3));
  gp.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
  gp.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
  gp.setAttribute('aColor', new THREE.BufferAttribute(aCol, 3));
  const mp = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uScale: { value: 600 } },
    vertexShader: `
      attribute float aT; attribute float aSize; attribute vec3 aColor;
      varying float vT; varying vec3 vColor; uniform float uScale;
      void main() {
        vT = aT; vColor = aColor;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uScale / -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying float vT; varying vec3 vColor;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d) * 2.0;
        if (r > 1.0) discard;
        float a = pow(1.0 - r, 2.0);
        a *= smoothstep(0.0, 0.07, vT) * smoothstep(1.0, 0.93, vT);
        gl_FragColor = vec4(vColor * 1.3, a * 0.9);
      }`,
  });
  const puntos = new THREE.Points(gp, mp);
  puntos.frustumCulled = false;
  scene.add(puntos);

  // realce por enlace al pasar el cursor (0 = normal, 1 = realzado, -1 = apagado)
  const realceEnlace = new Float32Array(enlaces.length);
  const objetivoEnlace = new Float32Array(enlaces.length);

  const suave = (x) => x * x * (3 - 2 * x);
  function actualizarParticulas(dt) {
    const v = REDUCIR ? 0.12 : 1;
    for (let i = 0; i < n; i++) {
      const q = parts[i];
      q.t += q.vel * dt * v;
      if (q.t > 1) q.t -= 1;
      const e = q.e, s = suave(q.t);
      const x0 = e.s.x + ANCHO_NODO / 2, x1 = e.t.x - ANCHO_NODO / 2;
      const top = e.y0 + (e.y1 - e.y0) * s, bot = (e.y0 - e.h) + ((e.y1 - e.h) - (e.y0 - e.h)) * s;
      aPos[i * 3] = x0 + (x1 - x0) * q.t;
      aPos[i * 3 + 1] = bot + q.v * (top - bot);
      aPos[i * 3 + 2] = q.z + Math.sin(q.t * 6.283 + i) * 0.04;
      aT[i] = q.t;
      const r = realceEnlace[q.idx];
      aSize[i] = q.tam * (r > 0 ? 1 + 0.9 * r : 1 + 0.55 * r);
    }
    gp.attributes.position.needsUpdate = true;
    gp.attributes.aT.needsUpdate = true;
    gp.attributes.aSize.needsUpdate = true;
  }

  // --- tamaño y cámara
  function ajustar() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    mp.uniforms.uScale.value = (h * renderer.getPixelRatio()) / (2 * Math.tan((camera.fov * Math.PI) / 360));
  }
  addEventListener('resize', ajustar);
  ajustar();

  const cam = { yaw: 0, pitch: 0, yawT: 0, pitchT: 0, dist: 60, distT: 27, arrastrando: false };
  const distBase = () => { const asp = innerWidth / innerHeight; return VERTICAL ? 34 : asp < 1.5 ? 31 : 26; };
  cam.distT = distBase();
  const MIN = 14, MAX = 52;
  let ultimoMov = 0;

  function mover(x, y) {
    if (REDUCIR) return;
    cam.yawT = (x / innerWidth - 0.5) * 0.9;
    cam.pitchT = (y / innerHeight - 0.5) * -0.4 + 0.08;
    ultimoMov = performance.now();
  }

  // --- hover / clic
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let hover = null;
  const tip = $('tip');
  function elegir(cx, cy) {
    ndc.set((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(meshes, false)[0];
    return hit ? hit.object.userData.p : null;
  }
  function fijarHover(p, cx, cy) {
    if (p !== hover) {
      hover = p;
      objetivoEnlace.fill(0);
      if (p) {
        enlaces.forEach((e, i) => { objetivoEnlace[i] = (e.s === p || e.t === p) ? 1 : -1; });
        const n = p.n;
        const color = n.kind === 'fuente' ? colorFuente(n.fuente) : null;
        tip.replaceChildren();
        tip.insertAdjacentHTML('beforeend', M.tooltipNodo(n, spec.total, color));
        tip.hidden = false;
      } else {
        tip.hidden = true;
      }
      canvas.style.cursor = p && p.n.nav ? 'pointer' : 'default';
    }
    if (p) {
      const w = tip.offsetWidth, h = tip.offsetHeight;
      tip.style.left = Math.min(cx + 16, innerWidth - w - 10) + 'px';
      tip.style.top = Math.min(cy + 16, innerHeight - h - 10) + 'px';
    }
  }
  let ptrDown = null;
  canvas.addEventListener('pointermove', (ev) => {
    if (cam.arrastrando) {
      cam.yawT += ev.movementX * 0.004;
      cam.pitchT -= ev.movementY * 0.004;
      cam.pitchT = Math.max(-0.5, Math.min(0.5, cam.pitchT));
      cam.yawT = Math.max(-0.9, Math.min(0.9, cam.yawT));
      return;
    }
    mover(ev.clientX, ev.clientY);
    fijarHover(elegir(ev.clientX, ev.clientY), ev.clientX, ev.clientY);
  });
  canvas.addEventListener('pointerdown', (ev) => {
    ptrDown = { x: ev.clientX, y: ev.clientY };
    if (ev.pointerType !== 'mouse') cam.arrastrando = true;
    else if (ev.button === 0) cam.arrastrando = false;
    canvas.setPointerCapture(ev.pointerId);
  });
  canvas.addEventListener('pointerup', (ev) => {
    const movio = ptrDown && Math.hypot(ev.clientX - ptrDown.x, ev.clientY - ptrDown.y) > 6;
    cam.arrastrando = false;
    if (!movio) {
      const p = elegir(ev.clientX, ev.clientY);
      if (p && p.n.nav) location.href = 'index.html#' + p.n.nav;
    }
    ptrDown = null;
  });
  canvas.addEventListener('pointerleave', () => { fijarHover(null); });
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    cam.distT = Math.max(MIN, Math.min(MAX, cam.distT * (1 + Math.sign(ev.deltaY) * 0.08)));
  }, { passive: false });

  // --- etiquetas: posición en pantalla
  const v3 = new THREE.Vector3();
  function ubicarEtiquetas() {
    const porCol = [[], [], []];
    pos.forEach((p) => {
      const col = p.col;
      const lado = VERTICAL ? -1 : 1; // en vertical, las etiquetas de los costados van hacia adentro
      const ax = col === 0 ? p.x - lado * (ANCHO_NODO / 2 + 0.7) : col === 2 ? p.x + lado * (ANCHO_NODO / 2 + 0.7) : p.x;
      const ay = col === 1 ? p.top + 0.45 : p.centro;
      v3.set(ax, ay, 0).project(camera);
      p.px = (v3.x * 0.5 + 0.5) * innerWidth;
      p.py = (-v3.y * 0.5 + 0.5) * innerHeight;
      porCol[col].push(p);
    });
    // Evita que se encimen: en cada columna, de arriba hacia abajo, separa las que quedan muy juntas.
    const sep = VERTICAL ? 15 : 32;
    porCol.forEach((lista) => {
      lista.sort((a, b) => a.py - b.py);
      for (let i = 1; i < lista.length; i++) {
        if (lista[i].py - lista[i - 1].py < sep) lista[i].py = lista[i - 1].py + sep;
      }
      lista.forEach((p) => {
        const izq = VERTICAL ? 'translate(0,-50%)' : 'translate(-100%,-50%)';
        const der = VERTICAL ? 'translate(-100%,-50%)' : 'translate(0,-50%)';
        const tr = p.col === 0 ? izq : p.col === 2 ? der : 'translate(-50%,-100%)';
        p.etiqueta.style.transform = `translate(${p.px.toFixed(1)}px,${p.py.toFixed(1)}px) ${tr}`;
        p.etiqueta.style.opacity = hover && hover !== p ? '0.45' : '1';
      });
    });
  }

  // --- bucle
  let t0 = performance.now(), tPrev = t0;
  function cuadro(now) {
    const dt = Math.min(0.05, (now - tPrev) / 1000);
    tPrev = now;
    const inicio = Math.min(1, (now - t0) / 2600);
    const ease = 1 - Math.pow(1 - inicio, 3);
    // sin mouse por un rato, la cámara respira sola
    if (!REDUCIR && (now - ultimoMov > 2500) && !cam.arrastrando) {
      cam.yawT = Math.sin(now / 5200) * 0.22;
      cam.pitchT = 0.06 + Math.sin(now / 7300) * 0.05;
    }
    cam.yaw += (cam.yawT - cam.yaw) * 0.05;
    cam.pitch += (cam.pitchT - cam.pitch) * 0.05;
    cam.dist += (cam.distT - cam.dist) * 0.06;
    const d = REDUCIR ? cam.distT : cam.dist + (1 - ease) * 22;
    camera.position.set(Math.sin(cam.yaw) * d, Math.sin(cam.pitch) * d * 0.55 + 0.6, Math.cos(cam.yaw) * d);
    camera.lookAt(0, 0, 0);

    for (let i = 0; i < realceEnlace.length; i++) realceEnlace[i] += (objetivoEnlace[i] - realceEnlace[i]) * 0.12;
    pos.forEach((p) => {
      const obj = hover === p ? 1 : 0;
      p.realce += (obj - p.realce) * 0.15;
      p.mat.opacity = 0.28 + 0.5 * p.realce;
    });
    actualizarParticulas(dt);
    ubicarEtiquetas();
    renderer.render(scene, camera);
    requestAnimationFrame(cuadro);
  }
  requestAnimationFrame(cuadro);
  window.__flujo3d = { listo: true, particulas: n, nodos: pos.size, enlaces: enlaces.length };
}

iniciar().catch((e) => {
  console.error(e);
  aviso('No se pudo armar la vista 3D. <a href="index.html">Ver el gráfico clásico</a>.');
});
