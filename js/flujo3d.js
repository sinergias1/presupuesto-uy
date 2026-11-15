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
const N_OBJETOS = MOVIL ? 1100 : 2600;

// En pantallas verticales (celular) las columnas se acercan y el gráfico se alarga, y las
// etiquetas de los costados van hacia adentro para no salirse de la pantalla.
const VERTICAL = innerWidth / innerHeight < 0.85;
const X_COLS = {
  3: VERTICAL ? [-4.6, 0, 4.6] : [-9.5, 0, 9.5],
  2: VERTICAL ? [-3.4, 3.4] : [-7.5, 7.5],
};
// Cuánto pesa el monto en la densidad y en la velocidad de los billetes (1 = estrictamente proporcional;
// menos de 1 evita que lo chico quede invisible o congelado al lado de lo enorme).
const GAMMA = 0.55;
const VEL_MIN = 0.010, VEL_MAX = 0.046;
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
  const nCols = Math.max(...spec.nodes.map((n) => n.col)) + 1;
  const X_COL = X_COLS[nCols] || X_COLS[3];
  const cols = Array.from({ length: nCols }, () => []);
  spec.nodes.forEach((n) => { cols[n.col].push(n); });
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
  return { pos, enlaces, escala, nCols };
}

// --------------------------------------------------------------------------- escena
const BASE = 'data/2025/';
async function cargarJSON(ruta) {
  const r = await fetch(ruta);
  if (!r.ok) throw new Error('No se pudo cargar ' + ruta + ' (' + r.status + ')');
  return r.json();
}
const cargarArchivo = async (archivo) => (await cargarJSON(BASE + archivo)).nodo;

async function iniciar() {
  if (!M) throw new Error('model.js no cargó');
  if (!webglDisponible()) {
    aviso('Tu navegador no puede mostrar gráficos 3D (WebGL). <a href="index.html">Ver el gráfico clásico</a>.');
    return;
  }
  const ov = await cargar();

  // --- renderer, escena, cámara (se crean una sola vez)
  const canvas = $('lienzo');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, MOVIL ? 1.5 : 2));
  renderer.setClearColor(0x04060a, 1);
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x04060a, VERTICAL ? 0.008 : 0.022);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);

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

  scene.add(new THREE.AmbientLight(0xffffff, MOVIL ? 2.4 : 1.9));
  const sol = new THREE.DirectionalLight(0xffffff, MOVIL ? 3.2 : 2.6); sol.position.set(-6, 10, 14); scene.add(sol);
  const luz2 = new THREE.DirectionalLight(0x7fb4ff, 0.9); luz2.position.set(8, -4, 10); scene.add(luz2);

  function texturaBillete() {
    const c = document.createElement('canvas'); c.width = 256; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#eef2f6'; g.fillRect(0, 0, 256, 128);
    g.strokeStyle = '#9aa5b3'; g.lineWidth = 6; g.strokeRect(8, 8, 240, 112);
    g.lineWidth = 2; g.strokeRect(18, 18, 220, 92);
    g.fillStyle = '#c9d2dc'; g.beginPath(); g.ellipse(128, 64, 46, 34, 0, 0, 7); g.fill();
    g.strokeStyle = '#7f8b9a'; g.lineWidth = 3; g.stroke();
    g.fillStyle = '#5b6674'; g.font = 'bold 40px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('$U', 128, 66);
    g.fillStyle = '#7f8b9a';
    [[34, 34], [222, 34], [34, 94], [222, 94]].forEach(([x, y]) => { g.beginPath(); g.arc(x, y, 7, 0, 7); g.fill(); });
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
  }
  function texturaMoneda() {
    const c = document.createElement('canvas'); c.width = 128; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#f1f4f8'; g.fillRect(0, 0, 128, 128);
    g.strokeStyle = '#8d98a7'; g.lineWidth = 8; g.beginPath(); g.arc(64, 64, 56, 0, 7); g.stroke();
    g.lineWidth = 2; g.beginPath(); g.arc(64, 64, 44, 0, 7); g.stroke();
    g.fillStyle = '#566170'; g.font = 'bold 44px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('$U', 64, 68);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
  }
  const ancho = VERTICAL ? 0.3 : 0.32;
  const matBillete = new THREE.MeshStandardMaterial({ map: texturaBillete(), roughness: 0.55, metalness: 0.05, });
  const matMoneda = new THREE.MeshStandardMaterial({ map: texturaMoneda(), roughness: 0.28, metalness: 0.55 });
  const geoBillete = new THREE.BoxGeometry(ancho, ancho / 2, ancho * 0.03);
  const geoMon = new THREE.CylinderGeometry(ancho * 0.32, ancho * 0.32, ancho * 0.07, 20);
  geoMon.rotateZ(Math.PI / 2); // la cara queda mirando a ±x; así el giro se ve al avanzar

  // --- estado de la vista actual (se reconstruye al navegar)
  let V = null; // { spec, vista, pos, enlaces, meshes, parts, billetes, monedas, realceEnlace, objetivoEnlace, nodosObj }
  let entrada = 0; // 0 -> 1 al aparecer una vista nueva
  let hover = null;
  const etiquetas = $('etiquetas');
  const conectores = $('conectores');
  const SVGNS = 'http://www.w3.org/2000/svg';
  const tip = $('tip');

  function limpiar() {
    if (!V) return;
    V.nodosObj.forEach((o) => { scene.remove(o); if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    [V.billetes, V.monedas].forEach((m) => { scene.remove(m); m.dispose(); });
    etiquetas.replaceChildren();
    conectores.replaceChildren();
    tip.hidden = true;
    hover = null;
    V = null;
  }

  function construir(spec, vista) {
    limpiar();
    const { pos, enlaces, nCols } = disponer(spec);
    const nodosObj = [];
    const meshes = [];
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
      nodosObj.push(m, borde);
      p.mesh = m; p.mat = mat; p.borde = borde; p.realce = 0;
      meshes.push(m);

      const d = document.createElement('div');
      d.className = 'lbl' + (n.kind === 'fuente' ? ' fuente' : '') + (n.nav ? ' nav' : '');
      const b = document.createElement('b'); b.textContent = n.label + (n.drillable ? '\u00a0›' : '');
      const sp = document.createElement('span'); sp.textContent = M.fmtMonto(n.valor);
      d.append(b, sp);
      etiquetas.append(d);
      p.etiqueta = d;
      const g = document.createElementNS(SVGNS, 'g');
      const ln = document.createElementNS(SVGNS, 'line');
      const pt = document.createElementNS(SVGNS, 'circle');
      const col = '#' + c.getHexString();
      ln.setAttribute('stroke', col); ln.setAttribute('stroke-width', '1.6'); ln.setAttribute('stroke-dasharray', '1 5'); ln.setAttribute('stroke-linecap', 'round');
      pt.setAttribute('r', '3.2'); pt.setAttribute('fill', col);
      g.append(ln, pt); conectores.append(g);
      p.cLinea = ln; p.cPunto = pt; p.cG = g;
    });

    // Billetes y monedas. Cada flujo recibe una cantidad y una velocidad que dependen de su monto:
    //   peso = (monto / monto del mayor) ^ GAMMA
    //   cantidad de billetes ∝ peso × superficie de la franja (que ya es ∝ monto)
    //   velocidad = entre VEL_MIN (el flujo más chico) y VEL_MAX (el más grande), según el peso.
    const vmax = Math.max(...enlaces.map((e) => e.l.valor));
    enlaces.forEach((e) => {
      e.peso = Math.pow(e.l.valor / vmax, GAMMA);
      e.superficie = e.h * Math.abs((e.t.x - e.s.x) - ANCHO_NODO);
    });
    const sumaW = enlaces.reduce((a, e) => a + e.peso * e.superficie, 0);
    const parts = [];
    enlaces.forEach((e, idx) => {
      const cuantas = Math.max(3, Math.round(N_OBJETOS * (e.peso * e.superficie) / sumaW));
      e.cuantas = cuantas;
      const velBase = VEL_MIN + (VEL_MAX - VEL_MIN) * e.peso;
      e.velBase = velBase;
      for (let k = 0; k < cuantas; k++) {
        parts.push({
          e, idx, t: Math.random(), v: Math.random(), z: (Math.random() - 0.5) * (PROF * 0.9),
          vel: velBase * (0.85 + Math.random() * 0.3), esc: 0.8 + Math.random() * 0.45,
          fase: Math.random() * 6.283, giro: (Math.random() < 0.5 ? -1 : 1) * (0.4 + 1.4 * e.peso * (0.6 + Math.random() * 0.8)),
          moneda: Math.random() < 0.38, inc: (Math.random() - 0.5) * 1.1,
        });
      }
    });
    const nBill = parts.filter((q) => !q.moneda).length, nMon = parts.length - nBill;
    const billetes = new THREE.InstancedMesh(geoBillete, matBillete, Math.max(1, nBill));
    const monedas = new THREE.InstancedMesh(geoMon, matMoneda, Math.max(1, nMon));
    billetes.count = nBill; monedas.count = nMon;
    [billetes, monedas].forEach((m) => { m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(m); });
    let ib = 0, im = 0;
    parts.forEach((q) => {
      const c = new THREE.Color(q.e.l.fuente ? colorFuente(q.e.l.fuente) : GRIS);
      c.lerp(new THREE.Color(0xffffff), (MOVIL ? 0.04 : 0.18) + Math.random() * 0.1);
      q.mesh = q.moneda ? monedas : billetes;
      q.i = q.moneda ? im++ : ib++;
      q.mesh.setColorAt(q.i, c);
    });
    if (billetes.instanceColor) billetes.instanceColor.needsUpdate = true;
    if (monedas.instanceColor) monedas.instanceColor.needsUpdate = true;

    V = {
      spec, vista, pos, enlaces, meshes, parts, billetes, monedas, nodosObj, nCols,
      realceEnlace: new Float32Array(enlaces.length), objetivoEnlace: new Float32Array(enlaces.length),
    };
    entrada = 0; t0 = performance.now();
    cam.distT = distBase();
    MIN = Math.round(cam.distT * 0.66); // no se puede acercar tanto como para que todo tape todo
    cam.dist = cam.distT + 8;
    window.__flujo3d = { listo: true, vista: vista.tipo === 'general' ? '' : vista.nodo.id, particulas: parts.length, nodos: pos.size, enlaces: enlaces.length,
      detalle: enlaces.map((e) => ({ de: e.l.source, a: e.l.target, valor: e.l.valor, cuantas: e.cuantas, vel: e.velBase })) };
  }

  // --- HUD que cambia con cada vista
  function hudDe(spec, vista) {
    const leyenda = $('leyenda');
    leyenda.replaceChildren();
    M.leyendaFuentes(spec).forEach((f) => {
      const li = document.createElement('li');
      const i = document.createElement('i');
      i.style.color = colorFuente(f.codigo);
      li.append(i, document.createTextNode(f.nombre));
      leyenda.append(li);
    });

    // migas: cada nivel es un enlace para volver
    const migas = $('migas');
    migas.replaceChildren();
    const lista = vista.tipo === 'general' ? [{ texto: 'Inicio', hash: null }] : M.migas(vista);
    lista.forEach((m, i) => {
      if (i) { const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '›'; migas.append(sep); }
      if (m.hash == null) { const s = document.createElement('span'); s.className = 'actual'; s.textContent = m.texto; s.setAttribute('aria-current', 'page'); migas.append(s); }
      else { const a = document.createElement('a'); a.href = m.hash; a.textContent = m.texto; migas.append(a); }
    });

    const h1 = $('titulo'), sub = $('sub'), kick = $('kicker');
    if (vista.tipo === 'general') {
      kick.textContent = 'URUGUAY · PRESUPUESTO 2025 · PROTOTIPO 3D';
      h1.textContent = 'La plata del Estado, en movimiento';
      sub.textContent = 'Cada billete y cada moneda es plata. Va de lo que se cobra (izquierda), pasa por un fondo (centro) y termina en lo que se gasta (derecha). Más plata, más billetes y más velocidad. Clic en un bloque con › para entrar.';
    } else {
      const nombre = lista[lista.length - 1].texto;
      kick.textContent = (vista.arbol === 'gasto' ? 'EN QUÉ SE GASTA' : 'DE DÓNDE SALE LA PLATA') + ' · NIVEL ' + (lista.length - 1);
      h1.textContent = nombre;
      sub.textContent = vista.arbol === 'gasto'
        ? 'A la izquierda, de qué fondos sale la plata. A la derecha, en qué se reparte. Más plata = más billetes y más velocidad.'
        : 'A la izquierda, de qué se compone este ingreso. A la derecha, a qué fondo va. Más plata = más billetes y más velocidad.';
    }
    document.title = (vista.tipo === 'general' ? 'La plata del Estado en movimiento' : lista[lista.length - 1].texto + ' · 3D') + ' · Uruguay 2025';

    const t = ov.totales;
    const cifras = vista.tipo === 'general'
      ? [['Se espera cobrar', M.fmtMonto(t.recursos)], ['Se puede gastar', M.fmtMonto(t.gasto)], [t.diferencia < 0 ? 'Falta para cubrir' : 'Sobra', M.fmtMonto(Math.abs(t.diferencia))]]
      : [['Monto de esta vista', M.fmtMonto(spec.total)], ['Partes dibujadas', String(spec.nodes.filter((n) => n.kind !== 'fuente').length)]];
    if (vista.tipo !== 'general' && vista.nodo.ejecutado != null) cifras.push(['Ya gastado en 2025', M.fmtMonto(vista.nodo.ejecutado)]);
    $('cifras').replaceChildren(...cifras.map(([k, v]) => {
      const d = document.createElement('div');
      d.className = 'cifra';
      const sm = document.createElement('small'); sm.textContent = k;
      const b = document.createElement('strong'); b.textContent = v;
      d.append(sm, b);
      return d;
    }));
    // en los niveles de detalle los totales van abajo del título, para dejar libre la derecha a los carteles largos
    const hudIzq = document.querySelector('.hud-izq');
    if (vista.tipo === 'general') { if ($('cifras').parentElement === hudIzq) document.body.append($('cifras')); $('cifras').classList.remove('en-izq'); }
    else { hudIzq.append($('cifras')); $('cifras').classList.add('en-izq'); }
    const clasico = $('clasico');
    clasico.href = vista.tipo === 'general' ? 'index.html' : 'index.html#' + vista.nodo.id;
    clasico.textContent = vista.tipo === 'general' ? '← Volver al gráfico clásico' : 'Ver tablas de este nivel (gráfico clásico) →';
  }

  // --- tamaño y cámara
  function ajustar() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', ajustar);
  ajustar();

  const cam = { yaw: 0, pitch: 0, yawT: 0, pitchT: 0, dist: 60, distT: 27, arrastrando: false };
  const distBase = () => {
    const asp = innerWidth / innerHeight;
    const dos = V && V.nCols === 2;
    if (VERTICAL) return dos ? 30 : 34;
    return dos ? (asp < 1.5 ? 29 : 26) : (asp < 1.5 ? 35 : 32);
  };
  let MIN = 12; const MAX = 52;
  let ultimoMov = 0;
  let t0 = performance.now();

  function mover(x, y) {
    if (REDUCIR) return;
    cam.yawT = (x / innerWidth - 0.5) * 0.9;
    cam.pitchT = (y / innerHeight - 0.5) * -0.4 + 0.08;
    ultimoMov = performance.now();
  }

  // --- hover / clic
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function elegir(cx, cy) {
    if (!V) return null;
    ndc.set((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(V.meshes, false)[0];
    return hit ? hit.object.userData.p : null;
  }
  function fijarHover(p, cx, cy) {
    if (!V) return;
    if (p !== hover) {
      hover = p;
      V.objetivoEnlace.fill(0);
      if (p) {
        V.enlaces.forEach((e, i) => { V.objetivoEnlace[i] = (e.s === p || e.t === p) ? 1 : -1; });
        const n = p.n;
        const color = n.kind === 'fuente' ? colorFuente(n.fuente) : null;
        tip.replaceChildren();
        tip.insertAdjacentHTML('beforeend', M.tooltipNodo(n, V.spec.total, color));
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
      if (p && p.n.nav) location.hash = '#' + p.n.nav; // navega dentro del 3D
    }
    ptrDown = null;
  });
  canvas.addEventListener('pointerleave', () => { fijarHover(null); });
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    cam.distT = Math.max(MIN, Math.min(MAX, cam.distT * (1 + Math.sign(ev.deltaY) * 0.08)));
  }, { passive: false });
  // Escape sube un nivel
  addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !V || V.vista.tipo === 'general') return;
    const m = M.migas(V.vista);
    location.hash = m[m.length - 2].hash;
  });

  // --- navegación por hash (#gasto/a/4), igual que el gráfico clásico
  let ficha = 0;
  async function ir() {
    const mi = ++ficha;
    const id = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
    $('aviso').hidden = true;
    try {
      let vista, spec;
      if (!id) { vista = { tipo: 'general' }; spec = M.specGeneral(ov); }
      else {
        document.body.classList.add('cargando');
        vista = Object.assign({ tipo: 'nodo' }, await M.resolver(ov, id, cargarArchivo));
        spec = M.specNodo(ov, vista, { maxHijos: Math.max(5, Math.min(13, Math.floor((innerHeight - 190) / (MOVIL ? 52 : 70)))) });
      }
      if (mi !== ficha) return;
      hudDe(spec, vista);
      construir(spec, vista);
    } catch (e) {
      if (mi !== ficha) return;
      console.error(e);
      if (e && e.code === 'NOT_FOUND') {
        aviso('No existe esa vista. <a href="#">Volver al inicio</a>.');
      } else {
        aviso('No se pudo cargar esta parte. <a href="#">Volver al inicio</a>.');
      }
    } finally {
      if (mi === ficha) document.body.classList.remove('cargando');
    }
  }
  addEventListener('hashchange', ir);

  // --- partículas
  const suave = (x) => x * x * (3 - 2 * x);
  const obj = new THREE.Object3D();
  let reloj = 0;
  function actualizarParticulas(dt) {
    if (!V) return;
    const v = REDUCIR ? 0.12 : 1;
    reloj += dt * v;
    const { parts, realceEnlace } = V;
    for (let i = 0; i < parts.length; i++) {
      const q = parts[i];
      q.t += q.vel * dt * v;
      if (q.t > 1) q.t -= 1;
      const e = q.e, s = suave(q.t);
      const x0 = e.s.x + ANCHO_NODO / 2, x1 = e.t.x - ANCHO_NODO / 2;
      const top = e.y0 + (e.y1 - e.y0) * s, bot = (e.y0 - e.h) + ((e.y1 - e.h) - (e.y0 - e.h)) * s;
      obj.position.set(x0 + (x1 - x0) * q.t, bot + q.v * (top - bot), q.z + Math.sin(q.t * 6.283 + i) * 0.04);
      obj.rotation.set(q.fase + reloj * q.giro, q.inc, Math.sin(reloj * 0.8 + q.fase) * 0.5);
      const r = realceEnlace[q.idx];
      const aparecer = Math.min(1, q.t / 0.06, (1 - q.t) / 0.06);
      obj.scale.setScalar(q.esc * (r > 0 ? 1 + 0.45 * r : 1 + 0.6 * r) * aparecer * entrada);
      obj.updateMatrix();
      q.mesh.setMatrixAt(q.i, obj.matrix);
    }
    V.billetes.instanceMatrix.needsUpdate = true;
    V.monedas.instanceMatrix.needsUpdate = true;
  }

  // --- etiquetas: posición en pantalla
  const v3 = new THREE.Vector3();
  function ubicarEtiquetas() {
    if (!V) return;
    const ultima = V.nCols - 1;
    const porCol = Array.from({ length: V.nCols }, () => []);
    V.pos.forEach((p) => {
      const col = p.col;
      const lado = VERTICAL ? -1 : 1; // en vertical, las etiquetas de los costados van hacia adentro
      const ax = col === 0 ? p.x - lado * (ANCHO_NODO / 2 + 0.7) : col === ultima ? p.x + lado * (ANCHO_NODO / 2 + 0.7) : p.x;
      const ay = (col !== 0 && col !== ultima) ? p.top + 0.45 : p.centro;
      v3.set(ax, ay, 0).project(camera);
      p.px = (v3.x * 0.5 + 0.5) * innerWidth;
      p.py = (-v3.y * 0.5 + 0.5) * innerHeight;
      if (VERTICAL && col === 0) p.px = 8;                    // en celular, cada lado pega su cartel al borde
      else if (VERTICAL && col === ultima) p.px = innerWidth - 8;
      porCol[col].push(p);
    });
    // Los carteles pueden ocupar varias líneas (el nombre se muestra entero): se separan según su altura real.
    const alto = (p) => (p.hh || (p.hh = p.etiqueta.offsetHeight || 44));
    const repartir = (lista, tope, techo) => {
      const adelante = () => {
        for (let i = 1; i < lista.length; i++) {
          const min = (alto(lista[i - 1]) + alto(lista[i])) / 2 + 5;
          if (lista[i].py - lista[i - 1].py < min) lista[i].py = lista[i - 1].py + min;
        }
      };
      lista.sort((x, y) => x.py - y.py);
      adelante();
      const n = lista.length;
      if (n && lista[n - 1].py + alto(lista[n - 1]) / 2 > tope) {
        lista[n - 1].py = tope - alto(lista[n - 1]) / 2;
        for (let i = n - 2; i >= 0; i--) {
          const min = (alto(lista[i + 1]) + alto(lista[i])) / 2 + 5;
          if (lista[i + 1].py - lista[i].py < min) lista[i].py = lista[i + 1].py - min;
        }
      }
      // nunca debajo del título / los totales (tienen prioridad sobre el borde de abajo)
      if (n && lista[0].py - alto(lista[0]) / 2 < techo) { lista[0].py = techo + alto(lista[0]) / 2; adelante(); }
    };
    const hudI = document.querySelector('.hud-izq').getBoundingClientRect().bottom + 10;
    const cif = $('cifras');
    const hudD = cif.classList.contains('en-izq') ? 16 : cif.getBoundingClientRect().bottom + 10;
    const tope = innerHeight - (VERTICAL ? 130 : 44);
    if (VERTICAL) repartir([].concat(...porCol), tope, hudI); // en celular todos comparten el ancho: se ordenan juntos
    porCol.forEach((lista) => {
      if (!VERTICAL) repartir(lista, tope, lista === porCol[0] ? hudI : hudD);
      lista.forEach((p) => {
        const izq = VERTICAL ? 'translate(0,-50%)' : 'translate(-100%,-50%)';
        const der = VERTICAL ? 'translate(-100%,-50%)' : 'translate(0,-50%)';
        const tr = p.col === 0 ? izq : p.col === ultima ? der : 'translate(-50%,-100%)';
        // que no se salga de la pantalla
        const w = p.etiqueta.offsetWidth || 160;
        const h = alto(p);
        const medio = p.col !== 0 && p.col !== ultima;
        let x0 = p.col === 0 ? (VERTICAL ? p.px : p.px - w) : p.col === ultima ? (VERTICAL ? p.px - w : p.px) : p.px - w / 2;
        let dx = 0;
        if (x0 < 6) dx = 6 - x0; else if (x0 + w > innerWidth - 6) dx = -(x0 + w - (innerWidth - 6));
        p.px += dx; x0 += dx;
        // conector punteado desde el bloque hasta el borde más cercano del cartel
        const ax3 = medio ? p.x : p.col === 0 ? p.x - ANCHO_NODO / 2 : p.x + ANCHO_NODO / 2;
        v3.set(ax3, medio ? p.top : p.centro, 0).project(camera);
        const bx = (v3.x * 0.5 + 0.5) * innerWidth, by = (-v3.y * 0.5 + 0.5) * innerHeight;
        const cy = medio ? p.py - h / 2 : p.py;
        let ex, ey;
        if (bx < x0) { ex = x0; ey = cy; } else if (bx > x0 + w) { ex = x0 + w; ey = cy; }
        else { ex = bx; ey = by > cy ? cy + h / 2 : cy - h / 2; }
        p.cLinea.setAttribute('x1', bx.toFixed(1)); p.cLinea.setAttribute('y1', by.toFixed(1));
        p.cLinea.setAttribute('x2', ex.toFixed(1)); p.cLinea.setAttribute('y2', ey.toFixed(1));
        p.cPunto.setAttribute('cx', bx.toFixed(1)); p.cPunto.setAttribute('cy', by.toFixed(1));
        p.cG.setAttribute('opacity', ((hover && hover !== p ? 0.35 : 0.9) * entrada).toFixed(2));
        p.etiqueta.style.transform = `translate(${p.px.toFixed(1)}px,${p.py.toFixed(1)}px) ${tr}`;
        p.etiqueta.style.opacity = (hover && hover !== p ? 0.45 : 1) * entrada;
      });
    });
  }

  // --- bucle
  let tPrev = performance.now();
  function cuadro(now) {
    const dt = Math.min(0.05, (now - tPrev) / 1000);
    tPrev = now;
    const inicio = Math.min(1, (now - t0) / 1800);
    const ease = 1 - Math.pow(1 - inicio, 3);
    entrada = REDUCIR ? 1 : ease;
    if (!REDUCIR && (now - ultimoMov > 2500) && !cam.arrastrando) {
      cam.yawT = Math.sin(now / 5200) * 0.22;
      cam.pitchT = 0.06 + Math.sin(now / 7300) * 0.05;
    }
    cam.yaw += (cam.yawT - cam.yaw) * 0.05;
    cam.pitch += (cam.pitchT - cam.pitch) * 0.05;
    cam.dist += (cam.distT - cam.dist) * 0.06;
    const d = cam.dist;
    camera.position.set(Math.sin(cam.yaw) * d, Math.sin(cam.pitch) * d * 0.55 + 0.6, Math.cos(cam.yaw) * d);
    camera.lookAt(0, 0, 0);

    if (V) {
      for (let i = 0; i < V.realceEnlace.length; i++) V.realceEnlace[i] += (V.objetivoEnlace[i] - V.realceEnlace[i]) * 0.12;
      V.pos.forEach((p) => {
        const o = hover === p ? 1 : 0;
        p.realce += (o - p.realce) * 0.15;
        p.mat.opacity = (0.28 + 0.5 * p.realce) * entrada;
        p.borde.material.opacity = 0.95 * entrada;
      });
    }
    actualizarParticulas(dt);
    ubicarEtiquetas();
    renderer.render(scene, camera);
    requestAnimationFrame(cuadro);
  }
  await ir();
  requestAnimationFrame(cuadro);
}

iniciar().catch((e) => {
  console.error(e);
  aviso('No se pudo armar la vista 3D. <a href="index.html">Ver el gráfico clásico</a>.');
});
