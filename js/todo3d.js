/*
 * todo3d.js - Todo el recorrido de la plata desplegado a la vez (three.js).
 *
 * Dibuja el árbol completo: ingresos (hasta el último concepto) -> fondos -> gastos (hasta el último
 * rubro), unos 26.000 bloques. Se recorre solo con zoom y arrastre; nada se abre con clics.
 * Los billetes viajan por todo el camino: nacen en un ingreso, pasan por su fondo y bajan por el gasto
 * que ese fondo financia. Cada paso elige su camino en proporción al monto, así que la densidad es la
 * del dinero real. La velocidad depende del monto del tramo.
 * No cambia ningún dato: usa overview.json y data/2025/gasto/inciso_*.json. El texto que sale de los
 * datos pasa por model.js (esc) o por textContent.
 */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js';
import { dibujarCiudadanos, MARCO, BOLSILLOS, PISO } from './ciudadanos.js';

const M = window.FinanzasModel;
const $ = (id) => document.getElementById(id);

const COLOR_FUENTE = { '11': '#4aa3ff', '12': '#ff7a45', '15': '#2fd6a1', '21': '#ffc233' };
const GRIS = '#8b94a3';
const colorFuente = (c) => COLOR_FUENTE[c] || GRIS;

const REDUCIR = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const MOVIL = Math.min(innerWidth, innerHeight) < 700;
const N_BILLETES = MOVIL ? 1400 : 3600;

// --- escala del dibujo (unidades de la escena)
const ESC = 1 / 20e9;        // altura por peso: 20 mil millones = 1 unidad
const MINH = 0.006;          // altura mínima de un bloque (para que los más chicos se puedan ver al acercarse)
const GAP = 0.002;           // separación entre hermanos
const GAP_RAIZ = 0.4;        // separación entre los grandes grupos
const NCOLS = 12;            // 3 de ingresos (ingreso, subtipo, tipo) + fondos + 8 niveles de gasto
const COL_FONDOS = 3;
const GAMMA = 0.55;          // peso del monto en la velocidad (1 = estrictamente proporcional)
const VEL_MIN = 0.010, VEL_MAX = 0.046;
const DIST_BILLETE = 26;     // distancia de cámara con la que los billetes tienen su tamaño normal
const ANCHO_BILLETE = 0.32;

const NOMBRE_COL = [
  'Ingreso', 'Subtipo de ingreso', 'Tipo de ingreso', 'Fondos',
  'Grupo de organismos', 'Organismo (inciso)', 'Oficina (unidad ejecutora)', 'Programa', 'En qué se gasta', 'Rubro del gasto', 'Tipo de contrato', 'Escalafón',
];

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
async function json(ruta) {
  const r = await fetch(ruta);
  if (!r.ok) throw new Error('No se pudo cargar ' + ruta + ' (' + r.status + ')');
  return r.json();
}

// --------------------------------------------------------------------------- datos -> modelo
async function cargarTodo(ov) {
  const tareas = [];
  let hechas = 0;
  ov.gasto.hijos.forEach((g) => g.hijos.forEach((inc, k) => {
    if (inc.archivo && !inc.hijos) {
      tareas.push(json('data/2025/' + inc.archivo).then((j) => {
        if (!j.nodo || j.nodo.id !== inc.id) throw new Error('El archivo ' + inc.archivo + ' no corresponde a ' + inc.id);
        g.hijos[k] = j.nodo;
        aviso('Cargando el detalle… ' + (++hechas) + ' de ' + tareas.length);
      }));
    }
  }));
  await Promise.all(tareas);
  $('aviso').hidden = true;
}

function dominante(fuentes) {
  let mejor = null, v = -1;
  Object.keys(fuentes || {}).forEach((f) => { if (fuentes[f] > v) { v = fuentes[f]; mejor = f; } });
  return mejor;
}

function armar(ov) {
  const nodos = [];
  const mk = (o) => { o.i = nodos.length; o.kids = []; o.outs = []; o.ins = []; nodos.push(o); return o; };

  // ---- gasto: grupo (col 4) ... hasta 8 niveles
  const raicesGasto = [];
  const agregarGasto = (n, padre, prof) => {
    const o = mk({ id: n.id, label: M.nombreDe(n.id, n.nombre), valor: n.valor, fuentes: n.fuentes || {}, kind: 'gasto', col: COL_FONDOS + prof, prof, padre,
      ejecutado: n.ejecutado != null ? n.ejecutado : null, ayuda: n.ayuda || null });
    o.dom = dominante(o.fuentes);
    if (padre) padre.kids.push(o); else raicesGasto.push(o);
    (n.hijos || []).forEach((h) => agregarGasto(h, o, prof + 1));
    return o;
  };
  ov.gasto.hijos.forEach((g) => agregarGasto(g, null, 1));

  // ---- ingresos: tipo (col 2) <- subtipo (col 1) <- ingreso (col 0)
  const raicesRec = [];
  const agregarRec = (n, padre, prof) => {
    const o = mk({ id: n.id, label: M.nombreDe(n.id, n.nombre), valor: n.valor, fuentes: n.fuentes || {}, kind: 'recurso', col: COL_FONDOS - prof, prof, padre });
    o.dom = dominante(o.fuentes);
    if (padre) padre.kids.push(o); else raicesRec.push(o);
    (n.hijos || []).forEach((h) => agregarRec(h, o, prof + 1));
    return o;
  };
  ov.recursos.hijos.forEach((r) => agregarRec(r, null, 1));

  // ---- fondos (col 3)
  const P = ov.puente;
  const fuenteNodo = {};
  P.fuentes.forEach((f) => {
    const en = P.flujos_recursos.filter((x) => x.fuente === f.codigo).reduce((a, x) => a + x.valor, 0)
      + P.ajustes.filter((a) => a.fuente === f.codigo && a.tipo === 'gasto_sin_recurso_asignado').reduce((a, x) => a + x.valor, 0);
    const sa = P.flujos_gasto.filter((x) => x.fuente === f.codigo).reduce((a, x) => a + x.valor, 0)
      + P.ajustes.filter((a) => a.fuente === f.codigo && a.tipo !== 'gasto_sin_recurso_asignado').reduce((a, x) => a + x.valor, 0);
    const v = Math.max(en, sa);
    if (!(v > 0)) return;
    const o = mk({ id: 'fuente/' + f.codigo, label: M.nombreDe('fuente/' + f.codigo, f.nombre), valor: v, fuentes: { [f.codigo]: v }, kind: 'fuente', col: COL_FONDOS, prof: 0, padre: null,
      ayuda: null });
    o.dom = f.codigo; o.cod = f.codigo;
    fuenteNodo[f.codigo] = o;
  });
  const sumaAj = (tipoEntrada) => P.ajustes.filter((a) => (a.tipo === 'gasto_sin_recurso_asignado') === tipoEntrada).reduce((a, x) => a + x.valor, 0);
  const ajEntrada = mk({ id: 'ajuste/entrada', label: 'Falta para cubrir el gasto', valor: sumaAj(true), fuentes: {}, kind: 'ajuste', col: 2, prof: 0, padre: null });
  const ajSalida = mk({ id: 'ajuste/salida', label: 'Sobra sin gasto asignado', valor: sumaAj(false), fuentes: {}, kind: 'ajuste', col: 4, prof: 0, padre: null });

  // ---- alturas y posiciones
  const altura = (n) => {
    if (!n.kids.length) { n.H = Math.max(n.valor * ESC, MINH); return n.H; }
    let s = GAP * (n.kids.length - 1);
    n.kids.forEach((k) => { s += altura(k); });
    n.H = Math.max(n.valor * ESC, s);
    return n.H;
  };
  const colocar = (n, top) => {
    n.top = top; n.cy = top - n.H / 2;
    let y = top;
    n.kids.forEach((k) => { colocar(k, y); y -= k.H + GAP; });
  };
  const apilar = (raices, centro, gap) => {
    let alto = gap * Math.max(0, raices.length - 1);
    raices.forEach((r) => { alto += altura(r); });
    let y = centro + alto / 2;
    raices.forEach((r) => { colocar(r, y); y -= r.H + gap; });
    return { alto, base: centro - alto / 2 };
  };
  const g = apilar(raicesGasto, 0, GAP_RAIZ);
  const r = apilar(raicesRec, 0, GAP_RAIZ);
  // fondos
  const fn = Object.values(fuenteNodo);
  let af = 1.2 * Math.max(0, fn.length - 1);
  fn.forEach((o) => { o.H = Math.max(o.valor * ESC, MINH); af += o.H; });
  let yy = af / 2;
  fn.forEach((o) => { o.top = yy; o.cy = yy - o.H / 2; yy -= o.H + 1.2; });
  // ajustes: debajo de su columna
  ajEntrada.H = Math.max(ajEntrada.valor * ESC, MINH); ajEntrada.top = r.base - 0.8; ajEntrada.cy = ajEntrada.top - ajEntrada.H / 2;
  ajSalida.H = Math.max(ajSalida.valor * ESC, MINH); ajSalida.top = g.base - 0.8; ajSalida.cy = ajSalida.top - ajSalida.H / 2;

  const altoTotal = Math.max(g.alto, r.alto) + 4;
  const DX = Math.max(10, altoTotal * 0.11);
  nodos.forEach((n) => { n.x = (n.col - (NCOLS - 1) / 2) * DX; });

  // ---- enlaces
  const enlaces = [];
  const enlazar = (s, t, valor, fuente) => {
    if (!(valor > 0)) return null;
    const e = { s, t, valor, th: valor * ESC, fuente, i: enlaces.length };
    enlaces.push(e); s.outs.push(e); t.ins.push(e);
    return e;
  };
  nodos.forEach((n) => {
    if (n.kind === 'gasto' && n.padre) n.linkIn = enlazar(n.padre, n, n.valor, n.dom);
    if (n.kind === 'recurso' && n.padre) n.linkUp = enlazar(n, n.padre, n.valor, n.dom);
  });
  const recPorId = new Map(nodos.filter((n) => n.kind === 'recurso').map((n) => [n.id, n]));
  const gasPorId = new Map(nodos.filter((n) => n.kind === 'gasto').map((n) => [n.id, n]));
  P.flujos_recursos.forEach((f) => {
    const a = recPorId.get(f.origen_id), b = fuenteNodo[f.fuente];
    if (!a || !b) return;
    const e = enlazar(a, b, f.valor, f.fuente);
    if (e) { (a.aFondo = a.aFondo || {})[f.fuente] = e; }
  });
  fn.forEach((o) => { o.aGasto = []; });
  P.flujos_gasto.forEach((f) => {
    const a = fuenteNodo[f.fuente], b = gasPorId.get(f.destino_id);
    if (!a || !b) return;
    const e = enlazar(a, b, f.valor, f.fuente);
    if (e) a.aGasto.push({ e, nodo: b, w: f.valor });
  });
  P.ajustes.forEach((a) => {
    const f = fuenteNodo[a.fuente];
    if (!f) return;
    if (a.tipo === 'gasto_sin_recurso_asignado') enlazar(ajEntrada, f, a.valor, null);
    else enlazar(f, ajSalida, a.valor, null);
  });

  // cada nodo reparte su alto entre los enlaces que salen / entran, ordenados para cruzarse poco
  nodos.forEach((n) => {
    let y = n.top;
    n.outs.sort((a, b) => b.t.cy - a.t.cy).forEach((e) => { e.yS = y; y -= e.th; });
    y = n.top;
    n.ins.sort((a, b) => b.s.cy - a.s.cy).forEach((e) => { e.yT = y; y -= e.th; });
  });

  return { nodos, enlaces, raicesGasto, raicesRec, fuenteNodo, fn, altoTotal, DX, ajEntrada, ajSalida,
    hojasRec: nodos.filter((n) => n.kind === 'recurso' && !n.kids.length) };
}

// --------------------------------------------------------------------------- escena
async function iniciar() {
  if (!M) throw new Error('model.js no cargó');
  if (!webglDisponible()) {
    aviso('Tu navegador no puede mostrar gráficos 3D (WebGL). <a href="detalle.html">Ver el detalle en 2D</a>.');
    return;
  }
  aviso('Cargando datos…');
  const ov = await json('data/2025/overview.json');
  await cargarTodo(ov);
  aviso('Armando el dibujo…');
  await new Promise((r) => setTimeout(r, 30));
  const D = armar(ov);
  const { nodos, enlaces } = D;
  $('aviso').hidden = true;

  // --- HUD
  const leyenda = $('leyenda');
  Object.values(D.fuenteNodo).filter((n) => COLOR_FUENTE[n.cod]).forEach((n) => {
    const li = document.createElement('li');
    const i = document.createElement('i'); i.style.color = colorFuente(n.cod);
    li.append(i, document.createTextNode(n.label)); leyenda.append(li);
  });
  const t = ov.totales;
  [['Se estimó recaudar', M.fmtMonto(t.recursos)], ['Se estimó gastar', M.fmtMonto(t.gasto)], [t.diferencia < 0 ? 'Faltante estimado' : 'Superávit estimado', M.fmtMonto(Math.abs(t.diferencia))]]
    .forEach(([k, v]) => {
      const d = document.createElement('div'); d.className = 'cifra';
      const sm = document.createElement('small'); sm.textContent = k;
      const b = document.createElement('strong'); b.textContent = v;
      d.append(sm, b); $('cifras').append(d);
    });

  // --- renderer
  const canvas = $('lienzo');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, MOVIL ? 1.5 : 2));
  renderer.setClearColor(0x04060a, 1);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 6000);
  const tanMedio = Math.tan(camera.fov * Math.PI / 360);
  const unidadesPorPixel = (dist) => 2 * dist * tanMedio / innerHeight;

  // --- bloques (una sola llamada de dibujo)
  const geoBloque = new THREE.BoxGeometry(1, 1, 1);
  const matBloque = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false });
  const bloques = new THREE.InstancedMesh(geoBloque, matBloque, nodos.length);
  bloques.frustumCulled = false;
  bloques.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const cTmp = new THREE.Color();
  nodos.forEach((n) => {
    cTmp.set(n.kind === 'ajuste' || !n.dom ? GRIS : colorFuente(n.dom));
    if (n.kind !== 'fuente') cTmp.lerp(new THREE.Color(0xffffff), 0.12);
    bloques.setColorAt(n.i, cTmp);
  });
  bloques.instanceColor.needsUpdate = true;
  scene.add(bloques);
  const PROF = 0.2;
  const mTmp = new THREE.Matrix4(), qI = new THREE.Quaternion(), vP = new THREE.Vector3(), vS = new THREE.Vector3();
  let anchoBloque = -1;
  function actualizarBloques(dist) {
    const w = Math.min(Math.max(0.012, dist * 0.006), D.DX * 0.12);
    if (Math.abs(w - anchoBloque) < anchoBloque * 0.03) return;
    anchoBloque = w;
    for (let k = 0; k < nodos.length; k++) {
      const n = nodos[k];
      vP.set(n.x, n.cy, 0); vS.set(n.kind === 'fuente' ? w * 1.6 : w, n.H, PROF);
      mTmp.compose(vP, qI, vS);
      bloques.setMatrixAt(n.i, mTmp);
    }
    bloques.instanceMatrix.needsUpdate = true;
  }

  // --- cintas (una sola malla con todos los enlaces)
  (function cintas() {
    const SEG = 8;
    const nv = enlaces.length * (SEG + 1) * 2;
    const pos = new Float32Array(nv * 3), col = new Float32Array(nv * 3);
    const idx = new Uint32Array(enlaces.length * SEG * 6);
    let v = 0, q = 0;
    const c = new THREE.Color();
    enlaces.forEach((e) => {
      c.set(e.fuente ? colorFuente(e.fuente) : GRIS);
      const x0 = e.s.x, x1 = e.t.x;
      const base = v;
      for (let k = 0; k <= SEG; k++) {
        const u = k / SEG, s = u * u * (3 - 2 * u);
        const x = x0 + (x1 - x0) * u;
        const top = e.yS + (e.yT - e.yS) * s;
        pos.set([x, top, -0.02], v * 3); col.set([c.r, c.g, c.b], v * 3); v++;
        pos.set([x, top - e.th, -0.02], v * 3); col.set([c.r, c.g, c.b], v * 3); v++;
      }
      for (let k = 0; k < SEG; k++) {
        const a = base + k * 2;
        idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], q); q += 6;
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.34, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    m.frustumCulled = false;
    m.renderOrder = -1;
    scene.add(m);
  })();

  // --- billetes y monedas
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
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
  }
  function texturaMoneda() {
    const c = document.createElement('canvas'); c.width = 128; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#f1f4f8'; g.fillRect(0, 0, 128, 128);
    g.strokeStyle = '#8d98a7'; g.lineWidth = 8; g.beginPath(); g.arc(64, 64, 56, 0, 7); g.stroke();
    g.fillStyle = '#566170'; g.font = 'bold 44px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('$U', 64, 68);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
  }
  const geoMon = new THREE.CylinderGeometry(ANCHO_BILLETE * 0.32, ANCHO_BILLETE * 0.32, ANCHO_BILLETE * 0.07, 20);
  geoMon.rotateZ(Math.PI / 2);

  // tabla de enlaces para animar rápido
  const nE = enlaces.length;
  const Lx0 = new Float32Array(nE), Lx1 = new Float32Array(nE), LyS = new Float32Array(nE), LyT = new Float32Array(nE),
    Lth = new Float32Array(nE), Lvel = new Float32Array(nE);
  const vmax = Math.max(...enlaces.map((e) => e.valor));
  enlaces.forEach((e) => {
    Lx0[e.i] = e.s.x; Lx1[e.i] = e.t.x; LyS[e.i] = e.yS; LyT[e.i] = e.yT; Lth[e.i] = e.th;
    const peso = Math.pow(e.valor / vmax, GAMMA);
    // velocidad en unidades de escena por segundo -> fracción del tramo por segundo
    Lvel[e.i] = ((VEL_MIN + (VEL_MAX - VEL_MIN) * peso) * 19) / Math.max(1, Math.abs(e.t.x - e.s.x));
  });

  // caminos: nacen en un ingreso (en proporción a su monto), eligen fondo, y bajan por el gasto que ese fondo financia
  const hojas = D.hojasRec;
  const acum = new Float64Array(hojas.length);
  hojas.reduce((a, n, k) => (acum[k] = a + n.valor), 0);
  const totalHojas = acum[acum.length - 1];
  const elegirHoja = () => {
    const x = Math.random() * totalHojas;
    let lo = 0, hi = acum.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (acum[m] < x) lo = m + 1; else hi = m; }
    return hojas[lo];
  };
  const elegirPonderado = (lista, peso) => {
    let s = 0;
    for (let k = 0; k < lista.length; k++) s += peso(lista[k]);
    if (!(s > 0)) return null;
    let x = Math.random() * s;
    for (let k = 0; k < lista.length; k++) { x -= peso(lista[k]); if (x <= 0) return lista[k]; }
    return lista[lista.length - 1];
  };
  function nuevoCamino() {
    for (let intento = 0; intento < 6; intento++) {
      const hoja = elegirHoja();
      const fcod = elegirPonderado(Object.keys(hoja.fuentes), (f) => hoja.fuentes[f]);
      if (!fcod || !D.fuenteNodo[fcod]) continue;
      const camino = [];
      let n = hoja;
      while (n.linkUp) { camino.push(n.linkUp.i); n = n.padre; }
      const aF = n.aFondo && n.aFondo[fcod];
      if (!aF) continue;
      camino.push(aF.i);
      const fnodo = D.fuenteNodo[fcod];
      const dest = elegirPonderado(fnodo.aGasto, (x) => x.w);
      if (!dest) continue;
      camino.push(dest.e.i);
      let cur = dest.nodo;
      while (cur.kids.length) {
        const k = elegirPonderado(cur.kids, (c) => c.fuentes[fcod] || 0);
        if (!k) break;
        camino.push(k.linkIn.i);
        cur = k;
      }
      return { camino, fcod };
    }
    return null;
  }
  const bills = [];
  for (let k = 0; k < N_BILLETES; k++) {
    const c = nuevoCamino();
    if (!c) continue;
    bills.push({
      camino: c.camino, fcod: c.fcod, k: Math.floor(Math.random() * c.camino.length), t: Math.random(), v: Math.random(),
      z: (Math.random() - 0.5) * 0.12, fase: Math.random() * 6.283, giro: (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 1.2),
      moneda: Math.random() < 0.38, inc: (Math.random() - 0.5) * 1.1, esc: 0.8 + Math.random() * 0.45,
    });
  }
  const nBill = bills.filter((b) => !b.moneda).length, nMon = bills.length - nBill;
  const matBillete = new THREE.MeshStandardMaterial({ map: texturaBillete(), roughness: 0.55, metalness: 0.05 });
  const matMoneda = new THREE.MeshStandardMaterial({ map: texturaMoneda(), roughness: 0.28, metalness: 0.55 });
  const billetes = new THREE.InstancedMesh(new THREE.BoxGeometry(ANCHO_BILLETE, ANCHO_BILLETE / 2, ANCHO_BILLETE * 0.03), matBillete, Math.max(1, nBill));
  const monedas = new THREE.InstancedMesh(geoMon, matMoneda, Math.max(1, nMon));
  billetes.count = nBill; monedas.count = nMon;
  [billetes, monedas].forEach((m) => { m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(m); });
  let ib = 0, im = 0;
  bills.forEach((b) => {
    const c = new THREE.Color(colorFuente(b.fcod)); c.lerp(new THREE.Color(0xffffff), (MOVIL ? 0.04 : 0.14) + Math.random() * 0.1);
    b.mesh = b.moneda ? monedas : billetes; b.i = b.moneda ? im++ : ib++; b.mesh.setColorAt(b.i, c);
  });
  if (billetes.instanceColor) billetes.instanceColor.needsUpdate = true;
  if (monedas.instanceColor) monedas.instanceColor.needsUpdate = true;

  const suave = (x) => x * x * (3 - 2 * x);
  const obj = new THREE.Object3D();
  let reloj = 0;
  function animarBilletes(dt, dist) {
    const v = REDUCIR ? 0.12 : 1;
    reloj += dt * v;
    // al alejarse, los billetes se agrandan y aceleran para seguir viéndose; al acercarse, se achican
    const f = Math.pow(dist / DIST_BILLETE, 0.9);
    const tam = Math.max(f, 0.05);
    const rapidez = Math.min(Math.max(Math.pow(dist / DIST_BILLETE, 0.8), 0.15), 14) * v;
    for (let i = 0; i < bills.length; i++) {
      const b = bills[i];
      let e = b.camino[b.k];
      b.t += Lvel[e] * dt * rapidez;
      if (b.t >= 1) {
        b.t -= 1; b.k++;
        if (b.k >= b.camino.length) {
          const c = nuevoCamino();
          if (c) {
            b.camino = c.camino;
            if (c.fcod !== b.fcod) {
              b.fcod = c.fcod;
              const col = new THREE.Color(colorFuente(c.fcod)); col.lerp(new THREE.Color(0xffffff), 0.16);
              b.mesh.setColorAt(b.i, col); b.mesh.instanceColor.needsUpdate = true;
            }
          }
          b.k = 0; b.t = 0;
        }
        e = b.camino[b.k];
      }
      const s = suave(b.t);
      const x = Lx0[e] + (Lx1[e] - Lx0[e]) * b.t;
      const top = LyS[e] + (LyT[e] - LyS[e]) * s;
      const th = Lth[e];
      obj.position.set(x, top - b.v * th, b.z);
      obj.rotation.set(b.fase + reloj * b.giro, b.inc, Math.sin(reloj * 0.8 + b.fase) * 0.5);
      // nunca más ancho que la cinta por la que viaja
      const tope = (th * 1.15 + 0.004) / ANCHO_BILLETE;
      const aparecer = Math.min(1, b.t / 0.05, (1 - b.t) / 0.05);
      obj.scale.setScalar(Math.min(tam * b.esc, tope * b.esc) * aparecer);
      obj.updateMatrix();
      b.mesh.setMatrixAt(b.i, obj.matrix);
    }
    billetes.instanceMatrix.needsUpdate = true;
    monedas.instanceMatrix.needsUpdate = true;
  }

  // --- columnas ordenadas de arriba hacia abajo, para buscar por posición
  const porCol = Array.from({ length: NCOLS }, () => []);
  nodos.forEach((n) => porCol[n.col].push(n));
  porCol.forEach((l) => l.sort((a, b) => b.top - a.top));
  const colX = (c) => (c - (NCOLS - 1) / 2) * D.DX;
  const yBase = Math.min(...nodos.map((n) => n.top - n.H));
  // techo de cada columna (el bloque más alto), para poner el título de la columna ahí arriba
  const colTop = porCol.map((lista) => (lista.length ? lista[0].top : yBase));

  // --- ciudadanos: de la gente sale la plata. Una familia a la izquierda tira billetes (directo desde los bolsillos) hacia los ingresos
  const lienzoGente = await dibujarCiudadanos();
  const texGente = new THREE.CanvasTexture(lienzoGente); texGente.colorSpace = THREE.SRGBColorSpace; texGente.anisotropy = 4;
  const PH = D.altoTotal * 0.4, PW = PH * MARCO.w / MARCO.h;
  const gx = colX(0) - D.DX * 2.4 - PW / 2, gyTop = yBase + PH * 0.98;   // arriba del dibujo (en el mundo)
  const mundoX = (sx) => gx + ((sx - MARCO.x) / MARCO.w - 0.5) * PW;
  const mundoY = (sy) => gyTop - ((sy - MARCO.y) / MARCO.h) * PH;
  const planoGente = new THREE.Mesh(new THREE.PlaneGeometry(PW, PH), new THREE.MeshBasicMaterial({ map: texGente, transparent: true, depthWrite: false }));
  planoGente.position.set(gx, gyTop - PH / 2, -0.5); scene.add(planoGente);
  // el piso del dibujo queda apoyado en el fondo del gráfico
  planoGente.position.y += yBase - mundoY(PISO);
  const gyTopFinal = gyTop + (yBase - mundoY(PISO));
  const gente = BOLSILLOS.map((b) => ({ x: mundoX(b.x), y: gyTopFinal - ((b.y - MARCO.y) / MARCO.h) * PH, alto: b.alto }));

  // --- cartel en el hueco junto a la familia: cuánto le cuesta el Estado a cada uruguayo, en promedio.
  // Tamaño en función de la altura de la familia (PH), no del espaciado entre columnas (D.DX, que es
  // mucho más chico): así queda claramente grande, como una tarjeta con un número destacado.
  const FUENTE = 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, Menlo, monospace';
  function dibujarCartel() {
    const W = 760, H = 520;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.textAlign = 'center';
    ctx.fillStyle = '#eaf3ff';
    ctx.font = '600 44px ' + FUENTE;
    ctx.fillText('En promedio,', W / 2, 55);
    ctx.fillText('cada uruguayo aporta', W / 2, 108);
    ctx.font = '700 80px ' + FUENTE;
    ctx.fillText('$U 20.500', W / 2, 225);
    ctx.font = '600 44px ' + FUENTE;
    ctx.fillText('por mes para', W / 2, 288);
    ctx.fillText('mantener al Estado.*', W / 2, 340);
    ctx.fillStyle = '#8fa6c4';
    ctx.font = '400 30px ' + FUENTE;
    ['*Promedio entre toda la población.', 'Aportan personas y empresas;', 'no todos tributan igual.']
      .forEach((linea, i) => ctx.fillText(linea, W / 2, 410 + i * 38));
    return c;
  }
  const texCartel = new THREE.CanvasTexture(dibujarCartel());
  texCartel.colorSpace = THREE.SRGBColorSpace; texCartel.anisotropy = 4;
  const PHc = PH * 0.72, PWc = PHc * (760 / 520);
  const cartelX = colX(0) - D.DX * 0.4; // centro del hueco: más a la derecha, más lejos de la familia
  const planoCartel = new THREE.Mesh(new THREE.PlaneGeometry(PWc, PHc),
    new THREE.MeshBasicMaterial({ map: texCartel, transparent: true, depthWrite: false }));
  planoCartel.position.set(cartelX, yBase + PHc / 2 + PH * 0.02, -0.5);
  scene.add(planoCartel);
  const NT = MOVIL ? 16 : 30;
  const tiradas = [];
  gente.forEach((p) => { for (let j = 0; j < NT; j++) tiradas.push({ p, t: 0, dur: 3, hoja: null, giro: 0 }); });
  const lanzados = new THREE.InstancedMesh(new THREE.BoxGeometry(ANCHO_BILLETE, ANCHO_BILLETE / 2, ANCHO_BILLETE * 0.03), matBillete, tiradas.length);
  lanzados.frustumCulled = false; lanzados.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(lanzados);
  const cTir = new THREE.Color();
  function nuevaTirada(q) {
    q.hoja = elegirHoja();
    q.dur = 2.8 + Math.random() * 1.6; q.t = 0;
    q.ty = q.hoja.top - Math.random() * q.hoja.H;
    q.giro = (Math.random() - 0.5) * 9; q.vari = 0.8 + Math.random() * 0.4;
    cTir.set(colorFuente(q.hoja.dom)).lerp(new THREE.Color(0xffffff), 0.12);
    lanzados.setColorAt(q.i, cTir); lanzados.instanceColor.needsUpdate = true;
  }
  tiradas.forEach((q, i) => { q.i = i; nuevaTirada(q); q.t = -Math.random() * q.dur; });
  function animarGente(dt, dist, tseg) {
    const v = REDUCIR ? 0.15 : 1;
    const tam = Math.max(Math.pow(dist / DIST_BILLETE, 0.9), 0.05);
    planoGente.rotation.z = Math.sin(tseg * 1.1) * 0.004;
    for (const q of tiradas) {
      q.t += dt * v;
      if (q.t >= q.dur) nuevaTirada(q);
      if (q.t < 0) { obj.scale.setScalar(0); obj.updateMatrix(); lanzados.setMatrixAt(q.i, obj.matrix); continue; }
      const u = q.t / q.dur, p = q.p;
      const tx = q.hoja.x - 0.4, ty = q.ty;
      const e = u * (0.5 + 0.5 * u);                           // sale despacio del bolsillo y toma velocidad
      const x = p.x + (tx - p.x) * e;
      const y = p.y + (ty - p.y) * e + Math.sin(Math.min(1, u * 1.15) * Math.PI) * PH * p.alto * q.vari;
      obj.position.set(x, y, 0.3 + Math.sin(u * 3) * 0.2);
      obj.rotation.set(u * q.giro, 0.3, u * q.giro * 0.7);
      const crece = Math.min(1, 0.3 + u * 6);                  // sale chico del bolsillo y crece
      obj.scale.setScalar(tam * 1.7 * crece * Math.min(1, (1 - u) / 0.06));
      obj.updateMatrix();
      lanzados.setMatrixAt(q.i, obj.matrix);
    }
    lanzados.instanceMatrix.needsUpdate = true;
  }
  // primer índice cuyo borde de abajo queda por encima de y (o igual)
  function primeroDebajo(lista, y) {
    let lo = 0, hi = lista.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (lista[m].top - lista[m].H > y) lo = m + 1; else hi = m; }
    return lo;
  }

  // --- cámara
  const cam = { yaw: 0, pitch: 0, yawT: 0, pitchT: 0, dist: 1, distT: 1, px: 0, py: 0, pxT: 0, pyT: 0 };
  const ancho = () => (NCOLS - 1) * D.DX + 12;
  const distTodo = () => {
    const porAlto = (D.altoTotal * 1.08) / (2 * tanMedio);
    const porAncho = (ancho() * 1.04) / (2 * tanMedio * (innerWidth / innerHeight));
    return Math.max(porAlto, porAncho);
  };
  const MIN = 0.12, MAX = distTodo() * 1.3;
  cam.dist = cam.distT = distTodo() * 1.5;
  const LIM_X = ancho() / 2 + 20, LIM_Y = D.altoTotal / 2 + 10;
  const clampPan = () => {
    cam.pxT = Math.max(-LIM_X, Math.min(LIM_X, cam.pxT));
    cam.pyT = Math.max(-LIM_Y, Math.min(LIM_Y, cam.pyT));
  };
  function ajustar() {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', ajustar);
  ajustar();
  const volverATodo = () => { cam.pxT = 0; cam.pyT = 0; cam.distT = distTodo(); };
  let ultimoMov = 0;

  function zoomHacia(factor, cx, cy) {
    const nueva = Math.max(MIN, Math.min(MAX, cam.distT * factor));
    const real = nueva / cam.distT;
    if (real === 1) return;
    const k = unidadesPorPixel(cam.distT);
    cam.pxT += (cx - innerWidth / 2) * k * (1 - real);
    cam.pyT -= (cy - innerHeight / 2) * k * (1 - real);
    cam.distT = nueva;
    clampPan();
  }

  // --- puntero
  const tip = $('tip');
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plano = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), vHit = new THREE.Vector3();
  function nodoEn(cx, cy) {
    ndc.set((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    if (!ray.ray.intersectPlane(plano, vHit)) return null;
    const c = Math.round(vHit.x / D.DX + (NCOLS - 1) / 2);
    if (c < 0 || c >= NCOLS) return null;
    const tolerancia = Math.max(anchoBloque / 2, unidadesPorPixel(cam.dist) * 5);
    if (Math.abs(vHit.x - colX(c)) > tolerancia) return null;
    const lista = porCol[c];
    const k = primeroDebajo(lista, vHit.y - unidadesPorPixel(cam.dist) * 3);
    for (let j = Math.max(0, k - 1); j < Math.min(lista.length, k + 3); j++) {
      const n = lista[j];
      const m = unidadesPorPixel(cam.dist) * 3;
      if (vHit.y <= n.top + m && vHit.y >= n.top - n.H - m) return n;
    }
    return null;
  }
  let hover = null;
  function camino(n) {
    const ids = [];
    for (let p = n.padre; p; p = p.padre) ids.push(p.label);
    return ids.reverse().join(' › ');
  }
  function fijarHover(n, cx, cy) {
    if (n !== hover) {
      hover = n;
      if (n) {
        tip.replaceChildren();
        const total = n.kind === 'recurso' ? t.recursos : t.gasto;
        tip.insertAdjacentHTML('beforeend', M.tooltipNodo({ valor: n.valor, label: n.label, kind: n.kind, ejecutado: n.ejecutado, ayuda: n.ayuda, drillable: false },
          total, n.kind === 'fuente' ? colorFuente(n.cod) : null));
        const nombreCol = NOMBRE_COL[n.col];
        const extra = document.createElement('div'); extra.className = 'tt-camino';
        extra.textContent = (nombreCol ? nombreCol + (n.padre ? ' · dentro de: ' + camino(n) : '') : '');
        if (n.id.startsWith('gasto/') || n.id.startsWith('recursos/')) { const h = document.createElement('div'); h.className = 'tt-pista'; h.textContent = 'Doble clic: verlo por niveles'; extra.append(h); }
        tip.firstChild.append(extra);
        tip.hidden = false;
      } else tip.hidden = true;
    }
    if (n) {
      const w = tip.offsetWidth, h = tip.offsetHeight;
      tip.style.left = Math.min(cx + 16, innerWidth - w - 10) + 'px';
      tip.style.top = Math.min(cy + 16, innerHeight - h - 10) + 'px';
    }
  }
  const punteros = new Map();
  let ptrDown = null, movioMucho = false, distPinza = 0;
  canvas.addEventListener('pointermove', (ev) => {
    const ant = punteros.get(ev.pointerId);
    if (ant) {
      const dx = ev.clientX - ant.x, dy = ev.clientY - ant.y;
      punteros.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (ptrDown && Math.hypot(ev.clientX - ptrDown.x, ev.clientY - ptrDown.y) > 4) movioMucho = true;
      if (movioMucho) {
        if (punteros.size >= 2) {
          const [a, b] = [...punteros.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (distPinza) zoomHacia(distPinza / d, (a.x + b.x) / 2, (a.y + b.y) / 2);
          distPinza = d;
        } else {
          const k = unidadesPorPixel(cam.dist);
          cam.pxT -= dx * k; cam.pyT += dy * k; clampPan();
          cam.px = cam.pxT; cam.py = cam.pyT;
        }
        canvas.style.cursor = 'grabbing';
        fijarHover(null);
      }
      return;
    }
    ultimoMov = performance.now();
    fijarHover(nodoEn(ev.clientX, ev.clientY), ev.clientX, ev.clientY);
  });
  canvas.addEventListener('pointerdown', (ev) => {
    punteros.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (punteros.size === 1) { ptrDown = { x: ev.clientX, y: ev.clientY }; movioMucho = false; distPinza = 0; }
    else { movioMucho = true; const [a, b] = [...punteros.values()]; distPinza = Math.hypot(a.x - b.x, a.y - b.y); }
    canvas.setPointerCapture(ev.pointerId);
  });
  const soltar = (ev) => { punteros.delete(ev.pointerId); distPinza = 0; canvas.style.cursor = 'grab'; if (!punteros.size) ptrDown = null; };
  canvas.addEventListener('pointerup', soltar);
  canvas.addEventListener('pointercancel', soltar);
  canvas.addEventListener('pointerleave', () => { if (!punteros.size) fijarHover(null); });
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    zoomHacia(Math.exp(Math.sign(ev.deltaY) * Math.min(Math.abs(ev.deltaY), 120) * 0.0018), ev.clientX, ev.clientY);
  }, { passive: false });
  // --- doble clic (o doble toque): en un bloque o en una cinta abre la vista por niveles; en el vacío vuelve a ver todo
  const esNavegable = (n) => n && !n.id.includes('#') && (n.id.startsWith('gasto/') || n.id.startsWith('recursos/'));

  // --- buscador: escribir "ministerio", "secretaría de presidencia", etc. y saltar directo a ese nodo
  const normalizar = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const indiceBusqueda = nodos.filter((n) => esNavegable(n) && n.label)
    .map((n) => ({ n, norm: normalizar(n.label) }));
  function buscarNodos(q) {
    const nq = normalizar(q.trim());
    if (nq.length < 2) return [];
    // cada palabra escrita tiene que aparecer en el nombre, en cualquier orden y aunque haya
    // otras palabras en el medio (p.ej. "secretaria de presidencia" -> "Secretaría de la Presidencia...")
    const palabras = nq.split(/\s+/).filter(Boolean);
    return indiceBusqueda.filter((e) => palabras.every((p) => e.norm.includes(p)))
      .sort((a, b) => b.n.valor - a.n.valor).slice(0, 8).map((e) => e.n);
  }
  function irANodo(n) {
    location.href = '3d.html#' + encodeURIComponent(n.id).replace(/%2F/g, '/');
  }
  const buscadorWrap = document.createElement('div'); buscadorWrap.className = 'buscador';
  const buscadorInput = document.createElement('input');
  buscadorInput.type = 'search'; buscadorInput.placeholder = 'Buscar organismo, programa…';
  buscadorInput.setAttribute('aria-label', 'Buscar un organismo o programa, para ir directo a su detalle');
  const buscadorLista = document.createElement('ul'); buscadorLista.className = 'resultados'; buscadorLista.hidden = true;
  buscadorWrap.append(buscadorInput, buscadorLista);
  $('cifras').append(buscadorWrap);
  let resultadosActuales = [];
  buscadorInput.addEventListener('input', () => {
    resultadosActuales = buscarNodos(buscadorInput.value);
    buscadorLista.replaceChildren(...resultadosActuales.map((n) => {
      const li = document.createElement('li');
      const btn = document.createElement('button'); btn.type = 'button';
      const nombreCol = NOMBRE_COL[n.col];
      btn.append(document.createTextNode(n.label));
      if (nombreCol) { const sm = document.createElement('small'); sm.textContent = nombreCol; btn.append(sm); }
      // mousedown (no click): dispara ANTES de que el input pierda el foco, así no hace falta
      // esperar a que el 'blur' del input se resuelva y un solo click ya alcanza para navegar.
      btn.addEventListener('mousedown', (ev) => { ev.preventDefault(); irANodo(n); });
      btn.addEventListener('click', () => irANodo(n)); // por si se activa con teclado (Enter/Espacio)
      li.append(btn);
      return li;
    }));
    buscadorLista.hidden = !resultadosActuales.length;
  });
  buscadorInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { buscadorInput.value = ''; buscadorLista.hidden = true; buscadorLista.replaceChildren(); buscadorInput.blur(); }
    else if (ev.key === 'Enter' && resultadosActuales.length) irANodo(resultadosActuales[0]);
    else return;
    ev.stopPropagation();
  });
  buscadorInput.addEventListener('blur', () => {
    // da tiempo a que el click en un resultado se procese antes de ocultar la lista
    setTimeout(() => { buscadorLista.hidden = true; }, 150);
  });
  buscadorInput.addEventListener('focus', () => { if (resultadosActuales.length) buscadorLista.hidden = false; });
  // en escritorio, que los botones de abajo midan lo mismo que las tarjetas de arriba (mismo borde
  // izquierdo), en vez de quedar más angostos y desalineados
  function alinearControles() {
    if (MOVIL) return;
    const controles = document.querySelector('.controles');
    const ancho = $('cifras').getBoundingClientRect().width;
    if (controles && ancho) { controles.style.width = ancho + 'px'; controles.style.justifyContent = 'space-between'; }
  }
  alinearControles();
  addEventListener('resize', alinearControles);

  function cintaEn(cx, cy) {
    ndc.set((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    if (!ray.ray.intersectPlane(plano, vHit)) return null;
    const m = unidadesPorPixel(cam.dist) * 3;
    let mejor = null, mejorD = Infinity;
    for (let e = 0; e < enlaces.length; e++) {
      const x0 = Lx0[e], x1 = Lx1[e];
      if (vHit.x < x0 || vHit.x > x1) continue;
      const a = (vHit.x - x0) / (x1 - x0);
      const top = LyS[e] + (LyT[e] - LyS[e]) * suave(a);
      const th = Lth[e];
      if (vHit.y > top + m || vHit.y < top - th - m) continue;
      const d = Math.abs(vHit.y - (top - th / 2));
      if (d < mejorD) { mejorD = d; mejor = enlaces[e]; }
    }
    return mejor;
  }
  let ultimoDoble = 0;
  function dobleAccion(cx, cy) {
    if (performance.now() - ultimoDoble < 400) return;
    ultimoDoble = performance.now();
    let n = nodoEn(cx, cy);
    if (!n) { const e = cintaEn(cx, cy); if (e) n = esNavegable(e.t) ? e.t : (esNavegable(e.s) ? e.s : e.t); }
    if (!n) { volverATodo(); return; }
    if (esNavegable(n)) { location.href = '3d.html#' + encodeURIComponent(n.id).replace(/%2F/g, '/'); return; }
    // fondos y ajustes no tienen vista propia: se acerca la cámara a ese bloque
    cam.pxT = n.x; cam.pyT = n.cy; cam.distT = Math.max(distTodo() * 0.3, 8); clampPan();
  }
  canvas.addEventListener('dblclick', (ev) => dobleAccion(ev.clientX, ev.clientY));
  let ultimoToque = null;
  canvas.addEventListener('pointerup', (ev) => {
    if (ev.pointerType !== 'touch' || movioMucho) return;
    const ahora = performance.now();
    if (ultimoToque && ahora - ultimoToque.t < 350 && Math.hypot(ev.clientX - ultimoToque.x, ev.clientY - ultimoToque.y) < 30) { dobleAccion(ev.clientX, ev.clientY); ultimoToque = null; }
    else ultimoToque = { t: ahora, x: ev.clientX, y: ev.clientY };
  });
  $('zoom-mas').addEventListener('click', () => zoomHacia(0.6, innerWidth / 2, innerHeight / 2));
  $('zoom-menos').addEventListener('click', () => zoomHacia(1.67, innerWidth / 2, innerHeight / 2));
  $('zoom-centro').addEventListener('click', volverATodo);
  // mover la vista un paso (mismo cálculo que las flechas del teclado), para los botones del D-pad
  function moverPaso(dx, dy) {
    const paso = unidadesPorPixel(cam.dist) * 90;
    cam.pxT += dx * paso; cam.pyT += dy * paso; clampPan();
  }
  $('mover-izq').addEventListener('click', () => moverPaso(-1, 0));
  $('mover-der').addEventListener('click', () => moverPaso(1, 0));
  $('mover-arriba').addEventListener('click', () => moverPaso(0, 1));
  $('mover-abajo').addEventListener('click', () => moverPaso(0, -1));
  addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA')) return; // no robar teclas al buscador
    const k = ev.key.toLowerCase();
    if (k === 'arrowleft' || k === 'a') moverPaso(-1, 0);
    else if (k === 'arrowright' || k === 'd') moverPaso(1, 0);
    else if (k === 'arrowup' || k === 'w') moverPaso(0, 1);
    else if (k === 'arrowdown' || k === 's') moverPaso(0, -1);
    else if (k === '+' || k === '=') zoomHacia(0.8, innerWidth / 2, innerHeight / 2);
    else if (k === '-' || k === '_') zoomHacia(1.25, innerWidth / 2, innerHeight / 2);
    else if (k === '0') volverATodo();
    else return;
    ev.preventDefault();
  });

  // --- carteles: solo los de bloques que se ven lo bastante grandes, con tope
  const MAX_ETQ = MOVIL ? 40 : 90;
  const etiquetas = $('etiquetas');
  const pool = [];
  for (let k = 0; k < MAX_ETQ; k++) {
    const d = document.createElement('div'); d.className = 'etq'; d.hidden = true;
    const b = document.createElement('b'); const s = document.createElement('span');
    d.append(b, s); etiquetas.append(d);
    pool.push({ d, b, s, nodo: null });
  }
  const cabezas = $('cabezas');
  const cabs = NOMBRE_COL.map((txt) => {
    const d = document.createElement('div'); d.className = 'cab'; d.textContent = txt; cabezas.append(d); return d;
  });
  // ancho real de cada título (medido una sola vez, visibles, antes de ocultarlos): así se puede
  // decidir si entra sin pisar al de al lado, en vez de adivinar con una fila fija.
  const cabW = cabs.map((d) => d.offsetWidth);
  cabs.forEach((d) => { d.hidden = true; });

  const v3 = new THREE.Vector3();
  const candidatos = [];
  function ubicarCarteles() {
    const dist = cam.dist;
    const upp = unidadesPorPixel(dist);
    const hh = dist * tanMedio, hw = hh * camera.aspect;
    const yMax = cam.py + hh, yMin = cam.py - hh;
    const sepCols = D.DX / upp;                 // píxeles entre columnas
    candidatos.length = 0;
    if (sepCols >= 110) {
      for (let c = 0; c < NCOLS; c++) {
        const x = colX(c);
        if (x < cam.px - hw - D.DX * 0.3 || x > cam.px + hw + D.DX * 0.3) continue;
        const lista = porCol[c];
        for (let j = primeroDebajo(lista, yMax); j < lista.length; j++) {
          const n = lista[j];
          if (n.top < yMin) break;
          if (n.H / upp >= 30) candidatos.push(n);
        }
      }
      candidatos.sort((a, b) => b.H - a.H);
    }
    const n = Math.min(candidatos.length, MAX_ETQ);
    for (let k = 0; k < MAX_ETQ; k++) {
      const p = pool[k];
      if (k >= n) { if (!p.d.hidden) p.d.hidden = true; continue; }
      const nodo = candidatos[k];
      if (p.nodo !== nodo) {
        p.nodo = nodo; p.b.textContent = nodo.label; p.s.textContent = M.fmtMonto(nodo.valor);
      }
      p.d.hidden = false;
      p.d.style.maxWidth = Math.max(110, Math.min(300, sepCols * 0.8)) + 'px';
      v3.set(nodo.x + anchoBloque / 2 + upp * 4, Math.min(yMax, Math.max(yMin, nodo.cy)), 0).project(camera);
      const py = (-v3.y * 0.5 + 0.5) * innerHeight;
      // sin pisar los botones del pie de la pantalla
      if (py > innerHeight - 96 || py < 8) { p.d.hidden = true; continue; }
      p.d.style.transform = `translate(${((v3.x * 0.5 + 0.5) * innerWidth).toFixed(1)}px,${py.toFixed(1)}px) translate(0,-50%)`;
    }
    // títulos de columna: flotando arriba del bloque más alto de cada una (ahí siempre hay aire),
    // y solo si el título entra sin pisar al de la columna de al lado (se midió su ancho real antes).
    for (let c = 0; c < NCOLS; c++) {
      const d = cabs[c];
      const x = colX(c);
      const visible = sepCols >= 50 && cabW[c] <= sepCols - 10 && x > cam.px - hw && x < cam.px + hw;
      if (!visible) { if (!d.hidden) d.hidden = true; continue; }
      v3.set(x, colTop[c] + D.altoTotal * 0.012, 0).project(camera);
      const py = (-v3.y * 0.5 + 0.5) * innerHeight;
      if (py < 8 || py > innerHeight - 20) { d.hidden = true; continue; }
      d.hidden = false;
      d.style.transform = `translate(${((v3.x * 0.5 + 0.5) * innerWidth).toFixed(1)}px,${py.toFixed(1)}px) translate(-50%,-100%)`;
    }
  }

  // --- bucle
  let tPrev = performance.now();
  const t0 = tPrev;
  function cuadro(now) {
    const dt = Math.min(0.05, (now - tPrev) / 1000);
    tPrev = now;
    const entrada = REDUCIR ? 1 : 1 - Math.pow(1 - Math.min(1, (now - t0) / 1800), 3);
    if (!REDUCIR && (now - ultimoMov > 2500) && !punteros.size) {
      cam.yawT = Math.sin(now / 5200) * 0.12;
      cam.pitchT = 0.03 + Math.sin(now / 7300) * 0.03;
    } else if (ultimoMov && now - ultimoMov <= 2500) { cam.yawT *= 0.98; cam.pitchT *= 0.98; }
    cam.yaw += (cam.yawT - cam.yaw) * 0.05;
    cam.pitch += (cam.pitchT - cam.pitch) * 0.05;
    cam.dist += (cam.distT - cam.dist) * 0.14;
    cam.px += (cam.pxT - cam.px) * 0.2; cam.py += (cam.pyT - cam.py) * 0.2;
    const d = cam.dist;
    camera.position.set(cam.px + Math.sin(cam.yaw) * d, cam.py + Math.sin(cam.pitch) * d * 0.55, Math.cos(cam.yaw) * d);
    camera.lookAt(cam.px, cam.py, 0);
    camera.near = Math.max(0.005, d * 0.02);
    camera.far = d * 6 + 400;
    camera.updateProjectionMatrix();
    actualizarBloques(d);
    matBloque.opacity = 0.9 * entrada;
    animarBilletes(dt, d);
    animarGente(dt, d, now / 1000);
    ubicarCarteles();
    renderer.render(scene, camera);
    requestAnimationFrame(cuadro);
  }
  window.__todo3d = { listo: true, nodos: nodos.length, enlaces: enlaces.length, billetes: bills.length, altoTotal: D.altoTotal, DX: D.DX,
    cam, distTodo, zoomHacia, volverATodo, nodoEn, camera, D };
  requestAnimationFrame(cuadro);
}

iniciar().catch((e) => {
  console.error(e);
  aviso('No se pudo armar la vista. <a href="detalle.html">Ir al detalle en 2D</a>.');
});
