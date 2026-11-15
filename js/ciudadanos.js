/*
 * ciudadanos.js - Una familia (papá, nene y mamá) dibujada en línea azul sobre fondo gris-negro, vista de perfil.
 * Devuelve un canvas con el dibujo y la posición de cada bolsillo (de donde salen los billetes), en
 * coordenadas del dibujo. Personajes originales hechos solo con formas simples.
 */
const B = '#6fb3ff', F = '#12151b';
const ST = `fill="${F}" stroke="${B}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"`;
const LN = `fill="none" stroke="${B}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"`;

function brazo(pts, w) {
  const d = 'M' + pts.map((p) => p.join(' ')).join(' L');
  return `<path d="${d}" fill="none" stroke="${B}" stroke-width="${w + 6}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="${d}" fill="none" stroke="${F}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
}
function zapato(x, y) {
  return `<path d="M${x - 14} ${y - 10} H${x + 8} Q${x + 14} ${y - 2} ${x + 28} ${y} Q${x + 32} ${y + 6} ${x + 24} ${y + 6} H${x - 18} Q${x - 22} ${y + 6} ${x - 20} ${y - 2} Z" ${ST}/>`;
}
const zapatos = (x1, x2, y) => zapato(x1, y) + zapato(x2, y);
function cara(cx, cy, r) {
  return `<circle cx="${cx + r * 0.5}" cy="${cy - r * 0.05}" r="${Math.max(2.8, r * 0.09)}" fill="${B}"/>` +
    `<path d="M${cx + r * 0.35} ${cy + r * 0.42} Q${cx + r * 0.58} ${cy + r * 0.58} ${cx + r * 0.8} ${cy + r * 0.38}" ${LN}/>` +
    `<path d="M${cx + r * 0.92} ${cy + r * 0.05} Q${cx + r * 1.08} ${cy + r * 0.2} ${cx + r * 0.9} ${cy + r * 0.28}" ${LN}/>`;
}
const hombre = (x) => `<g transform="translate(${x},0)">
${brazo([[-28, 208], [-44, 268], [-8, 326]], 18)}
<path d="M-36 316 L36 316 L34 470 L6 470 L0 366 L-6 470 L-34 470 Z" ${ST}/>
${zapatos(-20, 20, 478)}
<rect x="-10" y="152" width="20" height="44" rx="6" ${ST}/>
<path d="M-40 196 Q-38 184 -20 182 Q0 190 20 182 Q38 184 40 196 L44 330 Q0 342 -44 330 Z" ${ST}/>
<path d="M12 322 Q28 346 42 322" ${LN} opacity=".7"/>
<ellipse cx="2" cy="122" rx="32" ry="37" ${ST}/>
<circle cx="-28" cy="126" r="7" ${ST}/>
<path d="M-30 116 Q-36 82 0 80 Q40 78 36 112 Q28 96 10 94 Q-12 96 -30 116 Z" ${ST}/>
${cara(2, 122, 34)}
${brazo([[30, 206], [66, 250], [94, 204]], 18)}
<circle cx="96" cy="200" r="11" ${ST}/>
</g>`;
const mujer = (x) => `<g transform="translate(${x},0)">
<path d="M-30 100 Q-50 160 -40 228 Q-36 248 -18 246 Q-4 244 -2 232 L10 120 Z" ${ST}/>
<path d="M-8 400 L-10 466 M14 400 L16 466" fill="none" stroke="${B}" stroke-width="16" stroke-linecap="round"/><path d="M-8 400 L-10 466 M14 400 L16 466" fill="none" stroke="${F}" stroke-width="10" stroke-linecap="round"/>
${zapatos(-10, 16, 476)}
<rect x="-10" y="152" width="20" height="44" rx="6" ${ST}/>
<path d="M-38 198 Q-36 184 -18 182 Q0 190 18 182 Q36 184 38 198 L36 262 Q42 330 58 400 Q0 420 -58 400 Q-40 330 -38 262 Z" ${ST}/>
<path d="M-38 262 Q0 274 36 262" ${LN}/>
${brazo([[-26, 208], [-44, 268], [-6, 334]], 16)}<circle cx="-4" cy="336" r="11" ${ST}/>
<ellipse cx="2" cy="122" rx="32" ry="37" ${ST}/>
<circle cx="-28" cy="126" r="7" ${ST}/>
<path d="M-30 116 Q-36 82 0 80 Q40 78 36 112 Q28 96 10 94 Q-12 96 -30 116 Z" ${ST}/>
${cara(2, 122, 34)}
${brazo([[28, 206], [64, 250], [92, 204]], 16)}
<circle cx="94" cy="200" r="11" ${ST}/>
</g>`;
const nene = (x) => `<g transform="translate(${x},0) translate(0,484) scale(.62) translate(0,-484)">
${brazo([[-30, 222], [-48, 288], [-10, 350]], 24)}<circle cx="-8" cy="352" r="13" ${ST}/>
<path d="M-36 352 L36 352 L34 472 L6 472 L0 396 L-6 472 L-34 472 Z" ${ST}/>
${zapatos(-20, 20, 480)}
<rect x="-12" y="176" width="24" height="34" rx="7" ${ST}/>
<path d="M-40 214 Q-38 200 -20 198 Q0 206 20 198 Q38 200 40 214 L44 364 Q0 376 -44 364 Z" ${ST}/>
<ellipse cx="4" cy="136" rx="46" ry="50" ${ST}/>
<circle cx="-40" cy="142" r="9" ${ST}/>
<path d="M-42 126 Q-46 80 6 80 Q54 80 50 122 Q40 102 16 104 Q-18 106 -42 126 Z" ${ST}/>
<path d="M2 82 Q-6 56 14 54 Q10 66 20 70" fill="none" stroke="${B}" stroke-width="4" stroke-linecap="round"/>
${cara(4, 136, 48)}
${brazo([[30, 230], [72, 272], [100, 226]], 24)}
<circle cx="102" cy="222" r="13" ${ST}/>
</g>`;

// zona del dibujo dentro del SVG
export const MARCO = { x: 130, y: 60, w: 620, h: 450 };
// bolsillos (en coordenadas del SVG), de izquierda a derecha: papá, nene, mamá
export const BOLSILLOS = [{ x: 316, y: 330, alto: 0.5 }, { x: 455, y: 402, alto: 0.9 }, { x: 595, y: 336, alto: 0.32 }];
export const PISO = 490;

export function dibujarCiudadanos() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${MARCO.w * 2}" height="${MARCO.h * 2}" viewBox="${MARCO.x} ${MARCO.y} ${MARCO.w} ${MARCO.h}">` +
    `<path d="M150 ${PISO} H730" stroke="${B}" stroke-width="1.5" opacity=".35"/>${hombre(300)}${nene(445)}${mujer(585)}</svg>`;
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = MARCO.w * 2; c.height = MARCO.h * 2;
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); res(c);
    };
    img.onerror = rej;
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}
