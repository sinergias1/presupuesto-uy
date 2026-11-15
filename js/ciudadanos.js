/*
 * ciudadanos.js - Tres personajes (una mujer, un hombre y un nene) dibujados con canvas 2D, que sacan
 * billetes del bolsillo y los tiran hacia los ingresos del Estado. Son personajes originales, hechos solo
 * con formas simples. Cada función devuelve un canvas de 400 x 800 px (los pies abajo, mirando a la derecha)
 * y dónde quedan el bolsillo y la mano, en coordenadas normalizadas (0-1) de ese canvas.
 */

const W = 400, H = 800, PISO = 770, CX = 200;
const BORDE = 'rgba(190, 225, 255, 0.55)';

// Pasa una coordenada del dibujo base (persona adulta) a la del personaje, que puede ser más chico.
const mapa = (s) => ({
  x: (x) => CX + (x - CX) * s,
  y: (y) => PISO - (PISO - y) * s,
});

function billete(g, x, y, ang, ancho) {
  g.save();
  g.translate(x, y); g.rotate(ang);
  const w = ancho, h = ancho * 0.5;
  g.fillStyle = '#eef2f6'; g.strokeStyle = '#8f9bab'; g.lineWidth = 3;
  g.beginPath(); g.roundRect(-w / 2, -h / 2, w, h, 4); g.fill(); g.stroke();
  g.strokeStyle = '#b3bdca'; g.lineWidth = 1.5; g.strokeRect(-w / 2 + 6, -h / 2 + 6, w - 12, h - 12);
  g.fillStyle = '#5b6674'; g.font = 'bold ' + Math.round(h * 0.6) + 'px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('$U', 0, 1);
  g.restore();
}

function extremidad(g, pts, grosor, color) {
  g.save();
  g.lineCap = 'round'; g.lineJoin = 'round';
  g.strokeStyle = BORDE; g.lineWidth = grosor + 6;
  g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let k = 1; k < pts.length; k++) g.lineTo(pts[k][0], pts[k][1]); g.stroke();
  g.strokeStyle = color; g.lineWidth = grosor;
  g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let k = 1; k < pts.length; k++) g.lineTo(pts[k][0], pts[k][1]); g.stroke();
  g.restore();
}

function forma(g, trazar, relleno) {
  g.save();
  g.beginPath(); trazar(); g.fillStyle = relleno; g.fill();
  g.lineWidth = 4; g.strokeStyle = BORDE; g.stroke();
  g.restore();
}

/**
 * o: { s, cabeza (radio), piel, pelo, peloEstilo ('largo'|'corto'|'nene'), remera, pantalon, vestido, zapato, anchoCuerpo }
 */
function persona(o) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const m = mapa(o.s || 1);
  const X = m.x, Y = m.y, S = o.s || 1;
  const ancho = o.anchoCuerpo || 1;

  // --- piernas
  const cadera = Y(470);
  const patas = o.vestido ? [[X(178), cadera + 70 * S, X(172), Y(770)], [X(226), cadera + 70 * S, X(232), Y(770)]]
    : [[X(180), cadera, X(172), Y(770)], [X(226), cadera, X(236), Y(770)]];
  patas.forEach((p, k) => {
    extremidad(g, [[p[0], p[1]], [p[2], p[3] - 14 * S]], (o.vestido ? 30 : 46) * S, o.vestido ? o.piel : o.pantalon);
    forma(g, () => { g.ellipse(p[2] + 14 * S * (k ? 1 : 0.6), p[3] - 6 * S, 34 * S, 14 * S, 0, 0, 7); }, o.zapato);
  });

  // --- brazo de atrás: va al bolsillo
  const bolsillo = [X(190), Y(478)];
  extremidad(g, [[X(176), Y(292)], [X(148), Y(372)], [bolsillo[0] - 2 * S, bolsillo[1] - 6 * S]], 32 * S, o.piel);

  // --- cuerpo
  if (o.vestido) {
    forma(g, () => {
      g.moveTo(X(156), Y(270)); g.lineTo(X(248), Y(270)); g.quadraticCurveTo(X(268), Y(330), X(270), Y(420));
      g.lineTo(X(292), Y(570)); g.quadraticCurveTo(X(205), Y(595), X(118), Y(570)); g.lineTo(X(138), Y(420));
      g.quadraticCurveTo(X(142), Y(330), X(156), Y(270)); g.closePath();
    }, o.remera);
    // bolsillo del vestido
    g.save(); g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(X(165), Y(500)); g.quadraticCurveTo(X(196), Y(540), X(228), Y(500)); g.stroke(); g.restore();
  } else {
    forma(g, () => {
      g.moveTo(X(206 - 56 * ancho), Y(268)); g.lineTo(X(206 + 56 * ancho), Y(268));
      g.quadraticCurveTo(X(206 + 66 * ancho), Y(350), X(206 + 58 * ancho), Y(486)); g.lineTo(X(206 - 58 * ancho), Y(486));
      g.quadraticCurveTo(X(206 - 66 * ancho), Y(350), X(206 - 56 * ancho), Y(268)); g.closePath();
    }, o.remera);
    // pantalón (cintura) y bolsillo
    forma(g, () => { g.rect(X(206 - 58 * ancho), Y(440), 116 * ancho * S, 52 * S); }, o.pantalon);
    g.save(); g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(X(172), Y(462)); g.quadraticCurveTo(X(194), Y(500), X(220), Y(462)); g.stroke(); g.restore();
  }

  // billete que asoma del bolsillo
  billete(g, bolsillo[0] + 4 * S, bolsillo[1] - 10 * S, -0.5, 66 * S);
  // mano que lo agarra
  forma(g, () => { g.arc(bolsillo[0] - 4 * S, bolsillo[1] - 4 * S, 17 * S, 0, 7); }, o.piel);

  // --- cuello y cabeza
  const hx = X(214), hy = Y(188), hr = (o.cabeza || 52) * (o.s < 1 ? 1.0 : 1);
  forma(g, () => { g.rect(hx - 14 * S, hy + hr * 0.7, 28 * S, 40 * S); }, o.piel);
  if (o.peloEstilo === 'largo') {
    forma(g, () => {
      g.moveTo(hx - hr * 0.9, hy - hr * 0.2); g.quadraticCurveTo(hx - hr * 1.3, hy + hr * 2.4, hx - hr * 0.4, hy + hr * 2.5);
      g.lineTo(hx + hr * 0.3, hy + hr * 1.2); g.lineTo(hx, hy - hr * 0.5); g.closePath();
    }, o.pelo);
  }
  forma(g, () => { g.arc(hx, hy, hr, 0, 7); }, o.piel);
  // pelo de arriba
  forma(g, () => {
    g.moveTo(hx - hr, hy + hr * 0.05);
    g.quadraticCurveTo(hx - hr * 1.15, hy - hr * 1.25, hx + hr * 0.2, hy - hr * 1.12);
    g.quadraticCurveTo(hx + hr * 1.1, hy - hr * 0.9, hx + hr * 0.95, hy - hr * 0.1);
    g.quadraticCurveTo(hx + hr * 0.6, hy - hr * 0.55, hx + hr * 0.05, hy - hr * 0.5);
    g.quadraticCurveTo(hx - hr * 0.5, hy - hr * 0.45, hx - hr, hy + hr * 0.05); g.closePath();
  }, o.pelo);
  if (o.peloEstilo === 'nene') {
    forma(g, () => { g.arc(hx + hr * 0.05, hy - hr * 1.05, hr * 0.28, 0, 7); }, o.pelo); // un mechón parado
  }
  // cara: ojo, sonrisa, mejilla
  g.fillStyle = '#1b2430';
  g.beginPath(); g.arc(hx + hr * 0.42, hy - hr * 0.02, hr * 0.095, 0, 7); g.fill();
  g.strokeStyle = '#1b2430'; g.lineWidth = Math.max(3, hr * 0.07); g.lineCap = 'round';
  g.beginPath(); g.arc(hx + hr * 0.3, hy + hr * 0.28, hr * 0.32, 0.15, 1.15); g.stroke();
  g.fillStyle = 'rgba(255, 120, 120, .35)';
  g.beginPath(); g.arc(hx + hr * 0.42, hy + hr * 0.3, hr * 0.17, 0, 7); g.fill();

  // --- brazo de adelante: levantado, con un billete listo para tirar
  const mano = [X(372), Y(222)];
  extremidad(g, [[X(246), Y(292)], [X(318), Y(318)], mano], 32 * S, o.piel);
  billete(g, mano[0] + 18 * S, mano[1] - 22 * S, -0.45, 84 * S);
  forma(g, () => { g.arc(mano[0], mano[1], 18 * S, 0, 7); }, o.piel);

  return { canvas: c, bolsillo: [bolsillo[0] / W, bolsillo[1] / H], mano: [(mano[0] + 14 * S) / W, (mano[1] - 14 * S) / H] };
}

export function dibujarCiudadanos() {
  return [
    persona({ s: 0.97, cabeza: 50, piel: '#c98a5e', pelo: '#2d1f1a', peloEstilo: 'largo', remera: '#a56ce6', vestido: true, zapato: '#3b2f4a' }),
    persona({ s: 1.0, cabeza: 52, piel: '#f0c7a0', pelo: '#4a3223', peloEstilo: 'corto', remera: '#2fb9a3', pantalon: '#2f4b7a', zapato: '#e8e8ee', anchoCuerpo: 1.08 }),
    persona({ s: 0.62, cabeza: 66, piel: '#e2a97e', pelo: '#a8501f', peloEstilo: 'nene', remera: '#ffc233', pantalon: '#e0524b', zapato: '#ffffff', anchoCuerpo: 1.0 }),
  ];
}
