/*
 * app.js - interfaz del Visualizador de Finanzas Estatales de Uruguay.
 *
 * Carga overview.json, enruta por hash (#gasto/a/4, #recursos/ingresos-tributarios),
 * carga bajo demanda el archivo de cada inciso y dibuja el Sankey con Apache ECharts.
 * La lógica de datos vive en model.js; acá solo hay DOM, ECharts y navegación.
 *
 * Todo texto que viene de los datos entra al DOM con textContent / nodos de texto
 * (helper h()). El único HTML armado a mano son los tooltips, escapados en model.js.
 */
(function () {
  'use strict';

  const M = window.FinanzasModel;
  const BASE = 'data/2025/';
  const MQ_OSCURO = window.matchMedia('(prefers-color-scheme: dark)');
  const MQ_MOVIMIENTO = window.matchMedia('(prefers-reduced-motion: reduce)');

  const state = {
    ov: null,       // overview.json
    token: 0,       // descarta respuestas de navegaciones superadas
    vista: null,    // {tipo:'general'} | {tipo:'nodo', arbol, cadena, nodo}
    chart: null,
    clave: '',      // tamaño de layout con el que se dibujó
    idx: null,      // índices del spec actual, para tooltips y clics
    primera: true,
  };

  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------------ DOM
  // cartelito que sigue al mouse y aparece/desaparece con transición de opacidad
  const cartel = { el: null, t: null, x: 0, y: 0 };
  addEventListener('mousemove', (ev) => {
    cartel.x = ev.clientX; cartel.y = ev.clientY;
    if (cartel.el && cartel.el.classList.contains('visible')) ubicarCartel();
  }, { passive: true });
  function ubicarCartel() {
    const w = cartel.el.offsetWidth, hh = cartel.el.offsetHeight;
    // arriba a la izquierda del cursor: el tooltip del gráfico sale abajo a la derecha, así no se tapan
    const x = Math.min(Math.max(8, cartel.x - w - 14), innerWidth - w - 8);
    const y = Math.min(Math.max(8, cartel.y - hh - 16), innerHeight - hh - 8);
    cartel.el.style.transform = `translate(${x}px, ${y}px)`;
  }
  const esToque = () => window.matchMedia('(pointer: coarse)').matches || !!window.ES_CELULAR;
  function mostrarCartel(texto, pos) {
    if (pos) { cartel.x = pos.x; cartel.y = pos.y; }
    if (!cartel.el) {
      cartel.el = document.createElement('div');
      cartel.el.className = 'cartel-mouse'; cartel.el.setAttribute('role', 'status');
      document.body.appendChild(cartel.el);
    }
    cartel.el.textContent = texto;
    ubicarCartel();
    requestAnimationFrame(() => cartel.el.classList.add('visible'));
    clearTimeout(cartel.t);
    cartel.t = setTimeout(() => cartel.el.classList.remove('visible'), 2800);
  }
  // Esc: subir un nivel
  addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !state.vista || state.vista.tipo === 'general') return;
    const migas = M.migas(state.vista);
    if (migas.length > 1) location.hash = migas[migas.length - 2].hash;
  });

  function h(tag, attrs, ...hijos) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of hijos.flat()) {
      if (c == null || c === false) continue;
      el.append(c);
    }
    return el;
  }

  // ---------------------------------------------------------------- datos
  const cache = new Map();
  async function getJSON(url) {
    if (cache.has(url)) return cache.get(url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`No se pudo cargar ${url} (HTTP ${res.status}).`);
    const data = await res.json();
    cache.set(url, data);
    return data;
  }
  const cargarArchivo = async (archivo) => (await getJSON(BASE + archivo)).nodo;

  // ------------------------------------------------------------ ECharts
  function cargarScript(src) {
    return new Promise((ok, fallo) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = ok;
      s.onerror = () => fallo(new Error('No se pudo cargar ' + src));
      document.head.append(s);
    });
  }
  async function asegurarEcharts() {
    if (window.echarts) return true;
    try { await cargarScript('vendor/echarts.min.js'); } catch (e) { /* sin copia local */ }
    return !!window.echarts;
  }

  // ------------------------------------------------------------ colores
  const claseFuente = (codigo) => {
    const s = M.fuenteSlot(codigo);
    return s >= 0 ? 'bg-s' + (s + 1) : 'bg-sx';
  };

  function paleta() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    return {
      series: [v('--s1'), v('--s2'), v('--s3'), v('--s4')],
      muted: v('--muted'),
      ink: v('--ink'),
      ink2: v('--ink2'),
      surface: v('--surface'),
      borde: v('--axis'),
    };
  }

  function layoutPara(ancho) {
    if (ancho >= 1150) return { clave: 'extra', izq: 230, der: 280, etiqueta: 220, fuente: 13, fila: 36, gap: 14, maxHijos: 14, col0Izq: true };
    if (ancho >= 900) return { clave: 'ancho', izq: 190, der: 230, etiqueta: 180, fuente: 12, fila: 30, gap: 10, maxHijos: 12, col0Izq: true };
    if (ancho >= 600) return { clave: 'medio', izq: 150, der: 170, etiqueta: 140, fuente: 12, fila: 32, gap: 10, maxHijos: 10, col0Izq: true };
    return { clave: 'angosto', izq: 8, der: 118, etiqueta: 112, fuente: 11, fila: 36, gap: 8, maxHijos: 7, col0Izq: false };
  }

  // ------------------------------------------------------------ gráfico
  // Texto de la etiqueta de un bloque. En el celular los fondos no llevan etiqueta (se leen en la leyenda de colores)
  // y los nombres largos se recortan.
  function textoEtiqueta(n, L) {
    if (L.clave !== 'angosto') return n.label + (n.drillable ? ' ›' : '');
    if (n.kind === 'fuente') return '';
    const t = n.label.length > 44 ? n.label.slice(0, 43).trimEnd() + '…' : n.label;
    return t + (n.drillable ? ' ›' : '');
  }

  // En el celular ninguna etiqueta se esconde por encimarse: se reparten hacia arriba y abajo, cada una lo más cerca
  // posible de su bloque, para que hasta el bloque más chico (por ejemplo el Parlamento) conserve su nombre.
  function acomodarEtiquetas(opt, spec, L) {
    const grafo = state.chart.getModel().getSeriesByIndex(0).getGraph();
    const alto = state.chart.getHeight();
    const lineaH = L.fuente + 3, sep = 3;
    // cuántas líneas ocupa un texto de verdad: se miden las palabras con la misma tipografía del gráfico
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `${L.fuente}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    const lineasDe = (texto) => {
      let lineas = 1, actual = '';
      texto.split(' ').forEach((pal) => {
        lineas += Math.floor(ctx.measureText(pal).width / L.etiqueta); // una palabra muy larga se parte en más de una línea
        const prueba = actual ? actual + ' ' + pal : pal;
        if (actual && ctx.measureText(prueba).width > L.etiqueta - 2) { lineas++; actual = pal; } else actual = prueba;
      });
      return lineas;
    };
    const columnas = new Map();
    state.etqOff = {};
    spec.nodes.forEach((n, i) => {
      const nodo = grafo.getNodeByIndex(i), lay = nodo && nodo.getLayout();
      const txt = textoEtiqueta(n, L);
      if (!lay || !txt) return;
      const hh = lineasDe(txt) * lineaH;
      const centro = lay.y + lay.dy / 2;
      if (!columnas.has(n.col)) columnas.set(n.col, []);
      columnas.get(n.col).push({ i, hh, centro, top: centro - hh / 2 });
    });
    columnas.forEach((items) => {
      items.sort((a, b) => a.top - b.top);
      let borde = 2;
      items.forEach((it) => { it.top = Math.max(it.top, borde); borde = it.top + it.hh + sep; });
      borde = alto - 2;
      for (let k = items.length - 1; k >= 0; k--) {
        const it = items[k];
        it.top = Math.min(it.top, borde - it.hh);
        borde = it.top - sep;
      }
      items.forEach((it) => {
        const off = it.top + it.hh / 2 - it.centro;
        const d = opt.series[0].data[it.i];
        if (Math.abs(off) > 70) d.label = Object.assign({}, d.label, { show: false }); // demasiado lejos de su bloque: mejor sin nombre que uno equivocado
        else state.etqOff[it.i] = off;
      });
    });
    state.chart.setOption(opt, true);
  }

  function opcionesSankey(spec, pal, L) {
    const nodos = new Map(spec.nodes.map((n) => [n.id, n]));
    const enlaces = new Map(spec.links.map((l) => [l.source + '>' + l.target, l]));
    state.idx = { nodos, enlaces };
    const etiqueta = (id) => (nodos.has(id) ? nodos.get(id).label : id);
    const colorDe = (codigo) => {
      const s = M.fuenteSlot(codigo);
      return s >= 0 ? pal.series[s] : pal.muted;
    };

    // Color = fuente de financiamiento. Los demás nodos van en gris para que el color signifique una sola cosa.
    const data = spec.nodes.map((n) => ({
      name: n.id,
      depth: n.col,
      cursor: n.drillable ? 'pointer' : 'default',
      itemStyle: {
        color: n.kind === 'fuente' ? colorDe(n.fuente) : pal.muted,
        opacity: n.kind === 'otros' || n.kind === 'ajuste' ? 0.55 : 1,
        borderWidth: 0,
      },
      label: {
        position: n.col === 0 && L.col0Izq ? 'left' : 'right',
        fontWeight: n.kind === 'fuente' ? 600 : 400,
      },
    }));

    const links = spec.links.map((l) => ({
      source: l.source,
      target: l.target,
      value: l.valor,
      lineStyle: { color: l.fuente ? colorDe(l.fuente) : pal.muted, opacity: l.fuente ? 0.5 : 0.3 },
    }));

    return {
      animation: !MQ_MOVIMIENTO.matches,
      animationDuration: 350,
      animationDurationUpdate: 350,
      textStyle: { fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
      tooltip: {
        trigger: 'item',
        confine: true,
        padding: 0,
        backgroundColor: pal.surface,
        borderColor: pal.borde,
        borderWidth: 1,
        textStyle: { color: pal.ink },
        extraCssText: 'border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.14);white-space:normal;max-width:min(320px,86vw);',
        formatter: (p) => {
          if (p.dataType === 'node') {
            const n = nodos.get(p.name);
            return n ? M.tooltipNodo(n, spec.total, n.kind === 'fuente' ? colorDe(n.fuente) : null) : '';
          }
          if (p.dataType === 'edge') {
            const l = enlaces.get(p.data.source + '>' + p.data.target);
            return l
              ? M.tooltipEnlace(l, etiqueta(l.source), etiqueta(l.target), spec.total, l.fuente ? colorDe(l.fuente) : null)
              : '';
          }
          return '';
        },
      },
      series: [{
        type: 'sankey',
        left: L.izq,
        right: L.der,
        top: 12,
        bottom: 12,
        nodeWidth: 14,
        nodeGap: L.gap,
        layoutIterations: 0, // conserva el orden de los datos: de mayor a menor
        draggable: false,
        emphasis: { focus: 'adjacency' },
        lineStyle: { curveness: 0.5 },
        labelLayout: L.clave === 'angosto' ? ((q) => ({ dy: (state.etqOff && state.etqOff[q.dataIndex]) || 0 })) : { hideOverlap: true },
        label: {
          color: pal.ink,
          fontSize: L.fuente,
          width: L.etiqueta,
          overflow: L.clave === 'angosto' ? 'break' : 'truncate',
          lineHeight: L.clave === 'angosto' ? L.fuente + 3 : undefined,
          ellipsis: '…',
          textBorderColor: pal.surface,
          textBorderWidth: 3,
          formatter: (p) => {
            const n = nodos.get(p.name);
            return n ? textoEtiqueta(n, L) : p.name;
          },
        },
        data,
        links,
      }],
    };
  }

  function avisoSinGrafico(cont) {
    cont.style.height = 'auto';
    cont.replaceChildren(h('p', { class: 'aviso' },
      'No se pudo cargar el gráfico (falta la biblioteca Apache ECharts). Los mismos datos están en las tablas de abajo.'));
  }

  function renderLeyenda(spec) {
    $('leyenda').replaceChildren(...M.leyendaFuentes(spec).map((f) =>
      h('li', { class: 'ley-item' }, h('span', { class: 'sw ' + claseFuente(f.codigo) }), f.nombre)));
  }

  function renderOmitidos(spec) {
    const det = $('omitidos');
    const n = spec.omitidos.length;
    if (!n) { det.hidden = true; det.replaceChildren(); return; }
    const suma = spec.omitidos.reduce((a, o) => a + o.valor, 0);
    det.hidden = false;
    det.replaceChildren(
      h('summary', {}, `${n} movimiento${n === 1 ? '' : 's'} de plata ${n === 1 ? 'es' : 'son'} muy chico${n === 1 ? '' : 's'} para dibujarse (en total, ${M.fmtMonto(suma)})`),
      h('ul', {}, spec.omitidos.map((o) => h('li', {}, `${o.origen} → ${o.destino}: ${M.fmtMonto(o.valor)}`))));
  }

  // Cada celda guarda el nombre de su columna: en el celular las tablas se muestran como tarjetas y lo necesitan.
  function etiquetarTablas() {
    document.querySelectorAll('table.tabla').forEach((t) => {
      const cab = [...t.querySelectorAll('thead th')].map((x) => x.textContent.trim());
      t.querySelectorAll('tbody tr').forEach((tr) => {
        [...tr.children].forEach((c, i) => {
          if (c.tagName !== 'TD') return;
          if (cab[i] && !c.dataset.label) c.dataset.label = cab[i];
          if (/^[—–-]?$/.test(c.textContent.trim())) c.classList.add('vacia'); // sin dato: en las tarjetas no se muestra la fila
        });
      });
    });
  }
  let etiquetando = 0;
  new MutationObserver(() => { cancelAnimationFrame(etiquetando); etiquetando = requestAnimationFrame(etiquetarTablas); })
    .observe(document.documentElement, { childList: true, subtree: true });

  function renderGrafico() {
    const v = state.vista;
    if (!v) return;
    const cont = $('grafico');
    const ancho = cont.clientWidth || $('grafico-card').clientWidth || 900;
    const L = layoutPara(ancho);
    const spec = v.tipo === 'general'
      ? M.specGeneral(state.ov)
      : M.specNodo(state.ov, v, { maxHijos: L.maxHijos });
    state.clave = L.clave;

    renderLeyenda(spec);
    renderOmitidos(spec);

    const hayOtros = spec.nodes.some((n) => n.kind === 'otros');
    $('pista').textContent = (esToque()
      ? 'Toca un bloque con › para ver qué hay adentro, o un nombre de las tablas de abajo. Para volver, usa las migas de arriba. Toca cualquier bloque para ver el monto exacto.'
      : 'Haz clic en un bloque con › para ver qué hay adentro, o en un nombre de las tablas de abajo. Doble clic en un fondo: volver al inicio. Esc: subir un nivel. Pasa el cursor para ver el monto exacto.') +
      (hayOtros ? ' «Otros» junta los elementos más chicos; la lista completa está en la tabla.' : '');
    $('guia').textContent = v.tipo === 'general'
      ? 'Cómo leerlo: la plata va de izquierda a derecha. Cuanto más ancha la franja, más plata. El color muestra de qué fondo sale.'
      : (v.arbol === 'gasto'
        ? 'Cómo leerlo: a la izquierda, de qué fondos sale la plata. A la derecha, en qué se reparte. Cuanto más ancha la franja, más plata.'
        : 'Cómo leerlo: a la izquierda, de qué se compone este ingreso. A la derecha, a qué fondo va. Cuanto más ancha la franja, más plata.');
    const quien = v.tipo === 'general' ? 'el panorama completo' : v.nodo.nombre;
    cont.setAttribute('aria-label',
      `Diagrama de flujo de la plata: ${quien}. Los mismos datos están en las tablas siguientes.`);

    if (!window.echarts) { avisoSinGrafico(cont); return; }
    try {
      if (!state.chart) {
        cont.replaceChildren();
        state.chart = window.echarts.init(cont, null, { renderer: 'svg' });
        state.chart.on('click', (p) => {
          if (p.dataType !== 'node' || !state.idx) return;
          const n = state.idx.nodos.get(p.name);
          if (n && n.nav) { state.ultimaNav = performance.now(); location.hash = '#' + n.nav; return; }
          // en pantallas táctiles no hay doble clic cómodo: un toque en un bloque sin salida avisa con el cartelito
          if (n && esToque() && (n.kind === 'otros' || n.kind === 'gasto' || n.kind === 'recurso')) {
            const ze = p.event, rc = $('grafico').getBoundingClientRect(); // posición del toque dentro del gráfico
            mostrarCartel(n.kind === 'otros'
              ? 'Acá hay muchos elementos chicos juntos. Mirá la lista completa en la tabla de abajo.'
              : 'Sin más detalle a la derecha. Usá las migas de arriba para volver atrás.',
            ze && ze.offsetX != null ? { x: rc.left + ze.offsetX, y: rc.top + ze.offsetY } : null);
          }
        });
        // doble clic en un bloque que no se abre más: un fondo sube al inicio; otro ("Otros"…) sube un nivel
        state.chart.on('dblclick', (p) => {
          if (p.dataType !== 'node' || !state.idx || !state.vista || state.vista.tipo === 'general') return;
          if (performance.now() - (state.ultimaNav || 0) < 800) return; // el primer clic de un doble clic acaba de abrir otra vista
          const n = state.idx.nodos.get(p.name);
          if (!n || n.nav) return;
          if (n.kind === 'fuente') { location.hash = '#'; return; } // un fondo: sube al inicio, donde se ve a dónde va esa plata
          // un bloque sin salida: no navega; avisa con un cartelito que sigue al mouse
          mostrarCartel(n.kind === 'otros'
            ? 'Acá hay muchos elementos chicos juntos. Mirá la lista completa en la tabla de abajo.'
            : 'Sin más detalle a la derecha. Usá Esc o navegá por las migas para volver atrás.');
        });
      }
      const movil = L.clave === 'angosto';
      const base = movil ? Math.max(480, Math.min(700, innerHeight * 0.74)) : Math.max(540, Math.min(900, innerHeight * 0.8));
      cont.style.height = Math.round(Math.max(base, Math.min(1100, spec.maxCol * L.fila + 70))) + 'px';
      state.chart.resize();
      state.chart.dispatchAction({ type: 'hideTip' }); // evita que el tooltip busque un nodo de la vista anterior mientras se reemplazan los datos
      state.etqOff = {};
      const opt = opcionesSankey(spec, paleta(), L);
      state.chart.setOption(opt, true);
      if (L.clave === 'angosto') acomodarEtiquetas(opt, spec, L);
    } catch (e) {
      console.error(e);
      state.chart = null;
      avisoSinGrafico(cont);
    }
  }

  // --------------------------------------------------------- cabecera
  function renderMigas(items, enGrafico) {
    const ol = h('ol', { class: 'migas' });
    const migaDe = (m, ultimo) => ultimo
      ? h('span', { 'aria-current': 'page', title: m.texto }, m.texto)
      : h('a', { href: m.hash, title: m.texto }, m.texto);
    // Si el camino es largo: Inicio, un "…" que despliega los pasos del medio y los últimos tres.
    const MAX = 5;
    if (items.length > MAX) {
      const ocultos = items.slice(1, items.length - 3);
      ol.append(h('li', {}, migaDe(items[0], false)));
      ol.append(h('li', { class: 'migas-mas' },
        h('details', {},
          h('summary', { title: 'Ver los pasos del medio', 'aria-label': `Ver ${ocultos.length} pasos del medio` }, '…'),
          h('ul', {}, ocultos.map((m) => h('li', {}, migaDe(m, false)))))));
      items.slice(items.length - 3).forEach((m, i, a) => ol.append(h('li', {}, migaDe(m, i === a.length - 1))));
    } else {
      items.forEach((m, i) => ol.append(h('li', {}, migaDe(m, i === items.length - 1))));
    }
    const nav = $('migas');
    nav.replaceChildren(ol);
    // En la vista con gráfico las migas van arriba a la izquierda del propio gráfico.
    $(enGrafico ? 'migas-slot' : 'migas-home').append(nav);
  }

  function tile(etiqueta, valor, nota, exacto) {
    return h('div', { class: 'tile' },
      h('div', { class: 'tile-l' }, etiqueta),
      h('div', { class: 'tile-v', title: exacto || null }, valor),
      nota ? h('div', { class: 'tile-n' }, nota) : null);
  }

  function tileCargos(c) {
    return tile('Cargos (puestos de trabajo)', `${M.numEs(c.ocupados, 0)} ocupados`,
      `y ${M.numEs(c.vacantes, 0)} vacantes. Son cargos, no personas.`);
  }

  function tileSueldo(c) {
    const tot = c.ocupados + c.vacantes;
    return tile('Sueldo nominal por mes', M.fmtMonto(c.importe_mensual),
      tot ? `Promedio por cargo: ${M.fmtMonto(c.importe_mensual / tot)} al mes, antes de descuentos.` : null,
      M.fmtCompleto(c.importe_mensual));
  }

  function tileTipos(tipos) {
    return h('div', { class: 'tile' },
      h('div', { class: 'tile-l' }, 'En qué se gasta'),
      h('div', { class: 'tipos' }, tipos.map((t) =>
        h('div', { class: 'tipo', title: `${t.tipo} (en los datos: ${t.oficial}): ${M.fmtMonto(t.valor)}` },
          h('span', { class: 'tipo-n' }, t.tipo),
          h('span', { class: 'tipo-p' }, M.fmtPct(t.pct)),
          h('span', { class: 'tipo-b' }, h('i', { style: `width:${(t.pct * 100).toFixed(1)}%` }))))));
  }

  function textoDescripcion(r) {
    if (r.nHijos) {
      return r.esGasto
        ? `A la izquierda, de qué fondos sale esta plata. A la derecha, cómo se reparte entre ${r.nHijos} ${r.nivelSiguientePlural}.`
        : `A la izquierda, de qué se compone este ingreso (${r.nHijos} ${r.nivelSiguientePlural}). A la derecha, a qué fondo va cada parte.`;
    }
    return 'Es el nivel más detallado: ya no se divide más. Se muestra de qué fondos sale la plata.';
  }

  // ------------------------------------------------------------ tablas
  function barraFuentes(fuentes) {
    const entradas = Object.entries(fuentes).sort((a, b) => b[1] - a[1]);
    const total = entradas.reduce((a, e) => a + e[1], 0);
    const resumen = entradas.map(([f, v]) => `${M.fuenteNombre(state.ov, f)} ${M.fmtPct(v / total)}`).join(', ');
    return h('span', { class: 'fbar', role: 'img', 'aria-label': resumen },
      entradas.map(([f, v]) => h('span', {
        class: claseFuente(f),
        style: `flex-grow:${((v / total) * 1000).toFixed(3)}`,
        title: `${M.fuenteNombre(state.ov, f)}: ${M.fmtMonto(v)} (${M.fmtPct(v / total)})`,
      })));
  }

  /** Enlaces externos (solo https) a la compra en el portal oficial. */
  function enlacesExternos(lista) {
    const ok = (lista || []).filter((e) => e && /^https:\/\/www\.comprasestatales\.gub\.uy\//.test(e.u));
    if (!ok.length) return null;
    return h('span', { class: 'enlaces-compra' }, ok.map((e, i) => [i ? ' · ' : '', h('a', { href: e.u, target: '_blank', rel: 'noopener noreferrer' }, e.t + ' ↗')]).flat());
  }

  function filaRanking(f, conClasif, conEjec) {
    return h('tr', {},
      h('th', { scope: 'row' }, f.hash ? h('a', { href: f.hash }, f.nombre) : f.nombre, f.enlaces ? h('br') : null, enlacesExternos(f.enlaces)),
      conClasif ? h('td', { class: 'col-clas' }, f.clasificacion) : null,
      h('td', { class: 'num', title: M.fmtCompleto(f.valor) }, M.fmtMonto(f.valor)),
      h('td', { class: 'num' }, M.fmtPct(f.pct)),
      conEjec ? h('td', { class: 'num', title: f.ejecutado != null ? M.fmtCompleto(f.ejecutado) : null },
        f.ejecutado != null ? `${M.fmtMonto(f.ejecutado)} (${M.fmtPct(f.pctEjecutado)})` : '—') : null,
      h('td', { class: 'col-fuentes' }, barraFuentes(f.fuentes)));
  }

  function tablaRanking({ titulo, nota, filas, columnaNombre, pctEtiqueta, conClasif, pagina = 25 }) {
    const tbody = h('tbody');
    const conEjec = filas.some((f) => f.ejecutado != null);
    const cabeza = h('tr', {},
      h('th', { scope: 'col' }, columnaNombre),
      conClasif ? h('th', { scope: 'col', class: 'col-clas' }, 'Grupo') : null,
      h('th', { scope: 'col', class: 'num' }, 'Monto'),
      h('th', { scope: 'col', class: 'num' }, pctEtiqueta),
      conEjec ? h('th', { scope: 'col', class: 'num' }, 'Ejecutado en 2025 (parte del monto)') : null,
      h('th', { scope: 'col', class: 'col-fuentes' }, 'De qué fondos sale'));
    const mas = h('p', { class: 'mas' });
    let mostradas = 0;

    function agregar() {
      const desde = mostradas;
      const hasta = Math.min(filas.length, mostradas + pagina);
      for (; mostradas < hasta; mostradas++) tbody.append(filaRanking(filas[mostradas], conClasif, conEjec));
      mas.replaceChildren();
      if (mostradas < filas.length) {
        mas.append(h('button', { type: 'button', onclick: agregar }, `Mostrar más (${filas.length - mostradas} restantes)`));
      }
      if (desde > 0) {
        const enlace = tbody.children[desde] && tbody.children[desde].querySelector('a');
        if (enlace) enlace.focus({ preventScroll: true });
      }
    }
    agregar();

    return h('section', { class: 'tabla-sec' },
      h('h3', {}, titulo),
      nota ? h('p', { class: 'tabla-nota' }, nota) : null,
      h('div', { class: 'tabla-wrap' },
        h('table', { class: 'tabla' }, h('caption', { class: 'sr-only' }, titulo), h('thead', {}, cabeza), tbody)),
      mas);
  }

  const celdaFuente = (codigo, nombre) =>
    h('span', { class: 'celda-fuente' }, h('span', { class: 'sw ' + claseFuente(codigo) }), nombre);

  function tablaFuentesNodo(filas) {
    return h('section', { class: 'tabla-sec' },
      h('h3', {}, 'De qué fondos sale la plata'),
      h('div', { class: 'tabla-wrap' }, h('table', { class: 'tabla' },
        h('caption', { class: 'sr-only' }, 'De qué fondos sale la plata'),
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col' }, 'Fondo'),
          h('th', { scope: 'col', class: 'num' }, 'Monto'),
          h('th', { scope: 'col', class: 'num' }, 'Parte del total'))),
        h('tbody', {}, filas.map((f) => h('tr', {},
          h('th', { scope: 'row' }, celdaFuente(f.codigo, f.nombre)),
          h('td', { class: 'num', title: M.fmtCompleto(f.valor) }, M.fmtMonto(f.valor)),
          h('td', { class: 'num' }, M.fmtPct(f.pct))))))));
  }

  function tablaRegimenes(filas, opc) {
    const o = Object.assign({ titulo: 'Cargos por tipo de contrato', columna: 'Tipo de contrato',
      nota: 'El importe es mensual y nominal, y suma cargos ocupados y vacantes. Son cargos, no personas.' }, opc || {});
    return h('section', { class: 'tabla-sec' },
      h('h3', {}, o.titulo),
      h('p', { class: 'tabla-nota' }, o.nota),
      h('div', { class: 'tabla-wrap' }, h('table', { class: 'tabla' },
        h('caption', { class: 'sr-only' }, o.titulo),
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col' }, o.columna),
          h('th', { scope: 'col', class: 'num' }, 'Ocupados'),
          h('th', { scope: 'col', class: 'num' }, 'Vacantes'),
          h('th', { scope: 'col', class: 'num' }, 'Importe mensual'),
          h('th', { scope: 'col', class: 'num' }, 'Promedio por cargo'))),
        h('tbody', {}, filas.map((f) => h('tr', {},
          h('th', { scope: 'row', title: f.ayuda || null }, f.hash ? h('a', { href: f.hash }, f.nombre) : f.nombre),
          h('td', { class: 'num' }, M.numEs(f.ocupados, 0)),
          h('td', { class: 'num' }, M.numEs(f.vacantes, 0)),
          h('td', { class: 'num', title: M.fmtCompleto(f.importe) }, M.fmtMonto(f.importe)),
          h('td', { class: 'num', title: M.fmtCompleto(Math.round(f.promedio)) }, M.fmtMonto(f.promedio))))))));
  }

  /** Tabla simple y accesible; con `pagina` agrega "Mostrar más". `filas`: arrays de celdas (texto o nodo). */
  function tablaSimple({ titulo, nota, columnas, filas, pagina = 25 }) {
    const tbody = h('tbody');
    let mostradas = 0;
    const mas = h('p', { class: 'mas' });
    function agregar() {
      const hasta = Math.min(filas.length, mostradas + pagina);
      for (; mostradas < hasta; mostradas++) {
        const f = filas[mostradas];
        tbody.append(h('tr', {}, f.map((c, i) => i === 0
          ? h('th', { scope: 'row' }, c)
          : h('td', { class: columnas[i].num ? 'num' : null }, c))));
      }
      mas.replaceChildren();
      if (mostradas < filas.length) {
        mas.append(h('button', { type: 'button', onclick: agregar }, `Mostrar más (${filas.length - mostradas} restantes)`));
      }
    }
    agregar();
    return h('section', { class: 'tabla-sec' },
      h('h3', {}, titulo),
      nota ? h('p', { class: 'tabla-nota' }, nota) : null,
      h('div', { class: 'tabla-wrap' }, h('table', { class: 'tabla' },
        h('caption', { class: 'sr-only' }, titulo),
        h('thead', {}, h('tr', {}, columnas.map((c) => h('th', { scope: 'col', class: c.num ? 'num' : null }, c.t)))),
        tbody)),
      mas);
  }

  function tablasLegisladores(l) {
    const esSenado = l.camara === 'Senadores';
    const conMonto = (v) => h('span', { title: M.fmtCompleto(v) }, M.fmtMonto(v));
    const nombreCamara = esSenado ? 'del Senado' : 'de la Cámara de Representantes';
    const out = [];
    out.push(tablaSimple({
      titulo: 'Integrantes por partido',
      nota: 'Cuántos integrantes tiene cada partido en la nómina de la Cámara.',
      columnas: [{ t: 'Partido' }, { t: 'Integrantes', num: true }, { t: 'Parte del total', num: true }],
      filas: M.filasPartidos(l).map((p) => [p.nombre, M.numEs(p.integrantes, 0), M.fmtPct(p.pct)]),
    }));
    out.push(tablaSimple({
      titulo: `Quiénes integran la Cámara ${esSenado ? 'de Senadores' : 'de Representantes'}`,
      nota: `Nómina pública ${nombreCamara}, en orden alfabético. ` +
        (esSenado ? 'La vicepresidenta de la República preside el Senado y figura en la lista.' : 'Los suplentes figuran con una observación.'),
      columnas: esSenado
        ? [{ t: 'Nombre' }, { t: 'Partido' }, { t: 'Observación' }]
        : [{ t: 'Nombre' }, { t: 'Partido' }, { t: 'Departamento' }, { t: 'Observación' }],
      filas: M.filasPersonas(l).map((p) => esSenado
        ? [p.nombre, p.partido, p.observacion || '—']
        : [p.nombre, p.partido, p.departamento, p.observacion || '—']),
    }));
    out.push(tablaSimple({
      titulo: 'Sueldos nominales por mes',
      nota: 'Son montos mensuales, nominales (antes de descuentos): gravados por aporte jubilatorio, IRPF y FONASA. ' +
        `Entre los ${M.numEs(l.personas.length, 0)} integrantes suman ${M.fmtCompleto(l.mensual_legisladores)} por mes, unos ${M.fmtMonto(l.anual_legisladores)} al año con ${l.pagos_al_anio} pagos.`,
      columnas: [{ t: 'Cargo' }, { t: 'Personas', num: true }, { t: 'Sueldo', num: true }, { t: 'Gastos de representación', num: true }, { t: 'Total nominal', num: true }],
      filas: l.sueldos.map((s) => [s.cargo, s.cantidad != null ? M.numEs(s.cantidad, 0) : '—', conMonto(s.sueldo), conMonto(s.gastos_representacion), conMonto(s.total)]),
    }));
    if (l.partidas) {
      out.push(tablaSimple({
        titulo: 'Otras partidas con cargo al gasto del Senado',
        nota: 'Se pagan con cargo al rubro de gastos de funcionamiento, no a sueldos. Son montos mensuales.',
        columnas: [{ t: 'Partida' }, { t: 'Para quién', num: false }, { t: 'Monto por mes', num: true }, { t: 'Observación' }],
        filas: l.partidas.map((x) => [x.partida, x.unidad, conMonto(x.monto), x.observacion]),
      }));
    }
    return out;
  }

  function tablaEscala(e) {
    return tablaSimple({
      titulo: 'Escala de sueldos básicos de los funcionarios del Senado',
      nota: `Sueldo básico mensual por cargo. Es la escala, no lo que cobra cada persona: no incluye las primas y compensaciones que se suman al básico, y no hay datos de cuántas personas ocupan cada cargo.`,
      columnas: [{ t: 'Cargo' }, { t: 'Grupo' }, { t: 'Sueldo básico por mes', num: true }],
      filas: e.filas.map((f) => [f[2].charAt(0) + f[2].slice(1).toLowerCase(), `Escalafón ${f[0]} · ${f[1]}`, h('span', { title: M.fmtCompleto(f[3]) }, M.fmtMonto(f[3]))]),
      pagina: 20,
    });
  }

  function tablaPuente(filas) {
    return h('section', { class: 'tabla-sec' },
      h('h3', {}, 'Cada fondo: lo que entra y lo que sale'),
      h('p', { class: 'tabla-nota' },
        'Entra lo que se espera cobrar y sale lo que se puede gastar con ese fondo. La diferencia no es el déficit oficial.'),
      h('div', { class: 'tabla-wrap' }, h('table', { class: 'tabla' },
        h('caption', { class: 'sr-only' }, 'Cada fondo: lo que entra, lo que sale y la diferencia'),
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col' }, 'Fondo'),
          h('th', { scope: 'col', class: 'num' }, 'Entra (lo que se cobra)'),
          h('th', { scope: 'col', class: 'num' }, 'Sale (lo que se gasta)'),
          h('th', { scope: 'col', class: 'num' }, 'Diferencia'))),
        h('tbody', {}, filas.map((f) => h('tr', {},
          h('th', { scope: 'row' }, celdaFuente(f.codigo, f.nombre)),
          h('td', { class: 'num', title: M.fmtCompleto(f.recursos) }, M.fmtMonto(f.recursos)),
          h('td', { class: 'num', title: M.fmtCompleto(f.gasto) }, M.fmtMonto(f.gasto)),
          h('td', { class: 'num', title: M.fmtCompleto(f.saldo) }, M.fmtMonto(f.saldo))))))));
  }

  function renderTablas() {
    const v = state.vista;
    const cont = $('tablas');
    if (v.tipo === 'general') {
      const g = M.filasGeneral(state.ov);
      cont.replaceChildren(
        tablaRanking({
          titulo: 'A dónde va la plata, organismo por organismo', nota: 'Del que más recibe al que menos. ' + (esToque() ? 'Toca' : 'Haz clic en') + ' un nombre para ver su detalle.',
          filas: g.incisos, columnaNombre: 'Organismo (inciso)', pctEtiqueta: 'Parte del gasto total', conClasif: true,
        }),
        tablaRanking({
          titulo: 'De dónde viene la plata', nota: 'Los tipos de ingreso, del que más aporta al que menos.',
          filas: g.capitulos, columnaNombre: 'Tipo de ingreso',
          pctEtiqueta: 'Parte de lo que se cobra',
        }),
        tablaPuente(g.fuentes));
      return;
    }
    const r = M.resumenNodo(state.ov, v);
    const secciones = [];
    const filas = M.filasHijos(v);
    if (filas.length) {
      secciones.push(tablaRanking({
        titulo: r.nivelSiguientePlural ? r.nivelSiguientePlural[0].toUpperCase() + r.nivelSiguientePlural.slice(1) + ', del que más al que menos' : 'Detalle',
        filas, columnaNombre: r.nivelSiguiente || 'Nombre', pctEtiqueta: 'Parte de este total',
      }));
    }
    secciones.push(tablaFuentesNodo(M.filasFuentesDeNodo(state.ov, v.nodo)));
    if (r.cargos && r.cargos.regimenes) secciones.push(tablaRegimenes(M.filasRegimenes(v.nodo)));
    const hijosCargos = M.filasCargosHijos(v.nodo);
    if (hijosCargos.length) {
      secciones.push(tablaRegimenes(hijosCargos, {
        titulo: `Cargos y sueldo mensual, por ${(r.nivelSiguiente || 'grupo').toLowerCase()}`,
        columna: r.nivelSiguiente || 'Grupo',
        nota: 'El sueldo es mensual, nominal (antes de descuentos) y suma cargos ocupados y vacantes. El promedio es por cargo. Son cargos, no personas.',
      }));
    }
    if (r.tieneDenominaciones) {
      secciones.push(tablaRegimenes(M.filasDenominaciones(v.nodo), {
        titulo: 'Cada tipo de cargo y su sueldo mensual', columna: 'Cargo',
        nota: 'Cada fila es un tipo de cargo de este grupo. El sueldo es mensual y nominal (antes de descuentos); el promedio es por cargo, ocupado o vacante.',
      }));
    }
    if (r.legisladores) secciones.push(...tablasLegisladores(r.legisladores));
    if (r.escalaFuncionarios) secciones.push(tablaEscala(r.escalaFuncionarios));
    if (r.tieneObjetos) {
      secciones.push(tablaRanking({
        titulo: 'Todo el gasto en remuneraciones, por rubro',
        nota: 'Es el detalle completo de este gasto, sin separar entre cargos y resto.',
        filas: M.filasObjetos(v), columnaNombre: 'Rubro del gasto', pctEtiqueta: 'Parte de este total',
      }));
    }
    cont.replaceChildren(...secciones);
  }

  function renderNotas() {
    const m = state.ov.meta;
    const palabras = [
      ['Recursos', 'La plata que el Estado espera cobrar en el año: impuestos, tasas, multas y otros ingresos.'],
      ['Crédito vigente', 'La plata que ya está autorizada para gastar. No es lo que ya se gastó.'],
      ['Fondo (fuente de financiamiento)', 'De qué “bolsillo” sale la plata. Cada color del gráfico es un fondo.'],
      ['Rentas Generales (“plata sin destino fijo”)', 'La plata que puede gastarse en lo que se decida, sin estar reservada para un fin.'],
      ['Afectación especial (“plata con destino fijo”)', 'Plata que una ley reserva para un fin determinado.'],
      ['Inciso', 'Cada organismo grande del presupuesto: un ministerio, la Presidencia, la Universidad, el Poder Judicial, etc.'],
      ['Unidad ejecutora', 'Una oficina o dirección dentro de un inciso, con su propio presupuesto.'],
      ['Programa', 'Un objetivo concreto en el que se gasta, por ejemplo “Seguridad pública”.'],
      ['Rubro del gasto', 'La compra o el pago puntual: un sueldo, un alquiler, un equipo.'],
      ['Cargo', 'Un puesto de trabajo en el Estado. Un cargo puede estar ocupado o vacante. Son cargos, no personas.'],
      ['Vacante', 'Un cargo que existe pero que hoy no tiene a nadie.'],
      ['Tipo de contrato (régimen)', 'La forma en que se contrata: efectivo, presupuestado, contrato permanente, zafral, etc.'],
      ['Escalafón', 'El grupo de cargos al que pertenece una función, por tipo de trabajo. En los datos aparece como una letra; mira “¿Qué es cada escalafón?” arriba.'],
      ['Sueldo nominal', 'El sueldo antes de descuentos e impuestos.'],
      ['Mil millones', 'Mil veces un millón. Por ejemplo, 1,0 mil millones son 1.000.000.000 de pesos.'],
    ];
    const esc = M.ESCALAFONES;
    const bloqueEscalafones = state.ov.puestos ? h('details', {},
      h('summary', {}, '¿Qué es cada escalafón?'),
      h('p', { class: 'tabla-nota' },
        'El escalafón es el grupo de cargos al que pertenece una función, como un “cajón” por tipo de trabajo. En los datos aparece como una letra. Las letras A a F, J a R vienen de la ley de funcionarios públicos (Ley 15.809); las marcadas con * las dedujimos mirando qué cargos tienen.'),
      h('dl', { class: 'glosario' }, Object.keys(esc).flatMap((k) => [
        h('dt', {}, esc[k][0] + (esc[k][2] ? '' : ' *')),
        h('dd', {}, esc[k][1])])),
      h('p', { class: 'tabla-nota' }, 'Las escalas de sueldo oficiales por grado (por ejemplo las de la ONSC) son de 2020: no las usamos. Los sueldos de esta página salen del archivo de puestos de trabajo 2025.')) : null;
    $('notas').replaceChildren(
      bloqueEscalafones,
      h('details', {},
        h('summary', {}, 'Palabras que conviene conocer'),
        h('dl', { class: 'glosario' }, palabras.flatMap(([t, d]) => [h('dt', {}, t), h('dd', {}, d)]))),
      h('details', {},
        h('summary', {}, 'Sobre los datos (para quien quiere más detalle)'),
        h('ul', {},
          h('li', {}, `Recursos: ${m.recursos}.`),
          h('li', {}, `Gasto: ${m.gasto}.`),
          h('li', {}, `Unidad: ${m.unidad}.`),
          m.notas.map((t) => h('li', {}, t)),
          h('li', {}, state.ov.legislativo
            ? 'Los archivos oficiales de gasto no incluyen el Poder Legislativo (inciso 1), el Banco de Previsión Social (inciso 28) ni el inciso 30, que probablemente corresponde a la amortización de la deuda pública. El Poder Legislativo lo sumamos aparte, como el grupo “Parlamento”, con los datos publicados por cada Cámara y por la Comisión Administrativa. El BPS y el inciso 30 siguen sin aparecer en el gráfico. La Constitución (art. 108) dice que cada Cámara aprueba su propio presupuesto, en los primeros doce meses de cada legislatura, y lo comunica al Poder Ejecutivo para que lo incluya en el Presupuesto Nacional. Puede que por eso no esté en los archivos oficiales, pero los datos oficiales no lo explican.'
            : 'Los archivos oficiales que usamos no incluyen el Poder Legislativo (inciso 1), el Banco de Previsión Social (inciso 28) ni el inciso 30, que probablemente corresponde a la amortización de la deuda pública. Por eso no aparecen en el gráfico. La Constitución (art. 108) dice que cada Cámara aprueba su propio presupuesto, en los primeros doce meses de cada legislatura, y lo comunica al Poder Ejecutivo para que lo incluya en el Presupuesto Nacional. Puede que por eso no esté en estos archivos, pero los datos oficiales no lo explican.'),
          state.ov.puestos ? h('li', {}, `Cargos: el archivo de puestos de trabajo cubre solo Presidencia, los ministerios y Ambiente (${state.ov.puestos.incisos.length} incisos). No incluye educación, salud, justicia ni otros organismos.`) : null,
          state.ov.puestos ? h('li', {}, 'Sueldos de los cargos (estimado): importe mensual nominal de cada cargo, ocupado o vacante, por 14. Los datos no detallan compensaciones adicionales ni incentivos, y no incluyen aportes patronales.') : null,
          state.ov.puestos ? h('li', {}, 'La fuente de financiamiento de los sueldos estimados se reparte en la misma proporción que la de las remuneraciones del programa: es un supuesto, no un dato.') : null,
          h('li', {}, 'Los nombres simples de los fondos y de los grupos de organismos son una traducción nuestra. Al pasar el cursor por un nodo se ve su nombre oficial.'),
          h('li', {}, 'El color de las franjas indica el fondo del que sale la plata. Lo que está en gris no tiene color propio.'))));
  }

  // ------------------------------------------------------------- vista
  // Explicación en palabras simples de lo que muestran las cifras de arriba.
  function renderExplica(v, r) {
    const $$ = (n) => M.fmtMonto(n).replace('$U ', '$');
    const b = (t) => h('strong', {}, t);
    const tarjeta = (titulo, ...contenido) =>
      h('div', { class: 'ex-card' }, h('h4', {}, titulo), h('p', {}, ...contenido));
    const tarjetas = [];
    if (v.tipo === 'general') {
      const t = state.ov.totales;
      const dif = t.diferencia;
      tarjetas.push(tarjeta('Lo que se espera cobrar', b($$(t.recursos)),
        ' con impuestos, tasas, multas y otros ingresos. Es un cálculo, no la plata ya cobrada.'));
      tarjetas.push(tarjeta('Lo que se puede gastar', b($$(t.gasto)),
        (state.ov.legislativo
          ? ' ya autorizados: hasta mayo de 2025 para casi todo el Estado, y a fin de 2025 para el Parlamento. Eso no quiere decir que ya se haya gastado todo.'
          : ' ya autorizados hasta mayo de 2025. Eso no quiere decir que ya se haya gastado todo.')));
      tarjetas.push(tarjeta('Lo que falta o sobra', dif < 0
        ? h('span', {}, 'Se puede gastar ', b($$(Math.abs(dif))), ' más de lo que se espera cobrar. ')
        : h('span', {}, 'Se espera cobrar ', b($$(Math.abs(dif))), ' más de lo que se puede gastar. '),
        'Ojo: esta diferencia no es el déficit oficial, porque ese se calcula con otras reglas.'));
      tarjetas.push(tarjeta('Para leer los números',
        '“Mil millones” es un 1 seguido de nueve ceros (1.000.000.000).'));
    } else if (r.esGasto) {
      tarjetas.push(r.enCompras
        ? tarjeta('Cuánto es', r.comprasResto ? `Del rubro, ${$$(r.valor)} no tienen detalle de compra en el catálogo.` : `Se adjudicaron compras por `, ...(r.comprasResto ? [] : [b($$(r.valor)), ' en “' + r.titulo + '”.']))
        : r.id.includes('/cargos')
        ? tarjeta('Cuánto es', `“${r.titulo}” se estima en `, b($$(r.valor)), ' al año.')
        : tarjeta('Cuánto es', `“${r.titulo}” tiene autorizado gastar `, b($$(r.valor)), '.'));
      tarjetas.push(tarjeta('Qué parte del total',
        `De cada $100 que gasta el Estado, $${M.numEs(r.pctTotal * 100, 1)} son de aquí.`));
      if (r.enlaces) {
        tarjetas.push(tarjeta('Ver la compra', (r.detalleCompra ? r.detalleCompra + '. ' : ''), enlacesExternos(r.enlaces)));
      }
      if (r.comprasRubro) {
        tarjetas.push(tarjeta('Las compras de este rubro',
          `Abajo se ven las compras adjudicadas en 2025 (catálogo de compras estatales de ARCE): qué se compró y a qué proveedor. Adjudicar es decidir comprar; el pago puede llegar después. ` +
          (r.comprasRubro.escalado ? 'Se adjudicó más que lo autorizado en este rubro, y se muestra hasta lo autorizado.' : 'Lo que no figura en el catálogo queda en “Resto sin detalle de compra”.')));
      }
      if (r.tipos && r.tipos.length) {
        const t = r.tipos[0];
        tarjetas.push(tarjeta('En qué se va', 'La parte más grande, ', b(M.fmtPct(t.pct)), `, es de ${t.tipo.toLowerCase()}.`));
      }
      tarjetas.push(tarjeta('Qué hay adentro', r.nHijos
        ? `Abajo puedes ver cómo se reparte entre ${r.nHijos} ${r.nivelSiguientePlural}.`
        : 'Este es el nivel más chico: ya no se divide en partes.'));
      if (r.cargos && r.cargos.importe_mensual !== undefined) {
        tarjetas.push(tarjeta('Cargos',
          `Hay ${M.numEs(r.cargos.ocupados, 0)} cargos ocupados y ${M.numEs(r.cargos.vacantes, 0)} vacantes. ` +
          `Entre todos suman un importe nominal de ${$$(r.cargos.importe_mensual)} por mes.`));
      }
      if (r.sinCargos) {
        tarjetas.push(tarjeta('Cargos', r.esParlamento
          ? 'No hay datos de cargos para el Parlamento: el archivo de puestos no lo cubre. Sus sueldos se ven por rubro (sueldo básico, primas, aportes…) en el detalle.'
          : 'No hay datos de cargos para esto. El archivo de puestos solo cubre Presidencia, los ministerios y Ambiente, y no todos sus programas.'));
      }
      if (r.ejecutado != null) {
        tarjetas.push(tarjeta('Autorizado y gastado',
          `De ${$$(r.valor)} autorizados a fin de 2025 se gastaron ${$$(r.ejecutado)} (${M.fmtPct(r.pctEjecutado)}). ` +
          'Solo el Parlamento trae este dato, así que no se puede comparar con otros organismos.'));
      }
      if (r.legisladores) {
        const l = r.legisladores;
        tarjetas.push(tarjeta('Quiénes son y cuánto cobran',
          `Abajo está la lista de los ${M.numEs(l.personas.length, 0)} integrantes, publicada por la propia Cámara, con su partido. ` +
          `Si todos cobraran el sueldo nominal más los gastos de representación durante 14 pagos al año, sumarían unos ${$$(l.anual_legisladores)}. ` +
          'Es un cálculo nuestro: no incluye aportes patronales ni las partidas para secretarios, y no es lo mismo que el crédito de sueldos del presupuesto.'));
      }
      if (r.escalaFuncionarios) {
        tarjetas.push(tarjeta('Sueldos de los funcionarios',
          'Abajo está la escala de sueldos básicos del personal del Senado. ' +
          'Dice cuánto cobra cada cargo, pero no cuántas personas hay en cada uno.'));
      }
      if (r.esParlamento) {
        tarjetas.push(tarjeta('De dónde sale la plata',
          'La plata del Parlamento sale de Rentas Generales, que en esta página se llama “Plata sin destino fijo”.'));
      }
      if (r.sufijo === 'r' && r.tieneObjetos) {
        tarjetas.push(tarjeta('Cómo se parte',
          'Las remuneraciones se separan en dos: los sueldos de los cargos (un estimado) y el resto. ' +
          'La fuente de financiamiento de cada parte se reparte en la misma proporción: es un supuesto, no un dato.'));
      }
      if (r.sufijo === 'cargos') {
        tarjetas.push(tarjeta('Cómo se calculó',
          'Se tomó el importe mensual de cada cargo, ocupado o vacante, y se multiplicó por 14 para incluir aguinaldo y salario vacacional. ' +
          'Los datos no detallan compensaciones adicionales ni incentivos, y no incluyen los aportes patronales.'));
      }
      if (r.sufijo === 'resto') {
        tarjetas.push(tarjeta('Qué es',
          'Es el gasto en remuneraciones de este programa que no está en los sueldos de los cargos: aportes patronales, compensaciones, incentivos y otros pagos.'));
      }
    } else {
      tarjetas.push(tarjeta('Cuánto es', `Por “${r.titulo}” el Estado espera cobrar `, b($$(r.valor)), '.'));
      tarjetas.push(tarjeta('Qué parte del total',
        `De cada $100 que se cobran, $${M.numEs(r.pctTotal * 100, 1)} vienen de aquí.`));
      tarjetas.push(tarjeta('Qué hay adentro', r.nHijos
        ? `Abajo puedes ver de qué se compone (${r.nHijos} ${r.nivelSiguientePlural}) y a qué fondo va cada parte.`
        : 'Este es el nivel más chico: ya no se divide en partes.'));
    }
    $('explica').replaceChildren(
      h('h3', { id: 'explica-t' }, '¿Qué significa esto?'),
      h('div', { class: 'ex-grid' }, ...tarjetas));
  }

  function renderVista() {
    const v = state.vista;
    const ov = state.ov;
    let titulo, contexto, sub, tiles, titDoc;

    if (v.tipo === 'general') {
      titulo = 'El panorama completo';
      contexto = 'Inicio';
      sub = 'Primero se junta la plata (izquierda), después va a un fondo (centro) y al final se reparte (derecha). ' + (esToque() ? 'Toca' : 'Haz clic en') + ' un bloque con › para ver qué hay adentro.';
      const dif = ov.totales.diferencia;
      tiles = [
        tile('Lo que se espera cobrar en 2025', M.fmtMonto(ov.totales.recursos), 'Impuestos, tasas, multas y otros cobros.', M.fmtCompleto(ov.totales.recursos)),
        tile('Lo que se puede gastar', M.fmtMonto(ov.totales.gasto), ov.legislativo
          ? 'Plata ya autorizada: a mayo de 2025 (crédito vigente), y a fin de 2025 para el Parlamento.'
          : 'Plata ya autorizada a mayo de 2025 (crédito vigente).', M.fmtCompleto(ov.totales.gasto)),
        tile('Lo que falta o sobra', M.fmtMonto(dif),
          (dif < 0 ? 'Se puede gastar más de lo que se espera cobrar.' : 'Se espera cobrar más de lo que se puede gastar.') + ' No es el déficit oficial: ese se calcula de otra forma.',
          M.fmtCompleto(dif)),
      ];
      renderMigas([{ texto: 'Inicio', hash: null }], true);
      titDoc = '¿De dónde sale la torta y cómo se reparte? Presupuesto del Estado uruguayo 2025';
    } else {
      const r = M.resumenNodo(ov, v);
      titulo = r.titulo;
      contexto = r.padre ? `${r.nivel} · ${r.padre}` : r.nivel;
      sub = (r.ayuda ? r.ayuda + ' ' : '') + textoDescripcion(r);
      tiles = [
        tile(r.enCompras ? 'Compras adjudicadas' : r.id.includes('/cargos') ? 'Estimado al año' : r.esGasto ? 'Plata autorizada para gastar' : 'Lo que se espera cobrar', M.fmtMonto(r.valor),
          r.esParlamento ? 'Crédito definitivo al 31/12/2025.' : null, M.fmtCompleto(r.valor)),
        tile('Qué parte es del total', M.fmtPct(r.pctTotal),
          r.esGasto
            ? `De cada $100 que se gastan, $${M.numEs(r.pctTotal * 100, 1)} van aquí.`
            : `De cada $100 que se cobran, $${M.numEs(r.pctTotal * 100, 1)} vienen de aquí.`),
      ];
      if (r.legisladores) {
        const l = r.legisladores, n = l.personas.length, p = M.sueldoPrincipal(l);
        tiles.push(tile('Integrantes de la Cámara', M.numEs(n, 0),
          `Nómina publicada por la Cámara. ${l.camara === 'Senadores' ? 'Incluye a la vicepresidenta y a 6 suplentes de senadores que pasaron a ministros.' : 'Incluye suplentes en ejercicio.'}`));
        if (p) {
          tiles.push(tile('Sueldo nominal por mes de cada legislador', M.fmtMonto(p.total),
            `${M.fmtCompleto(p.sueldo)} de sueldo y ${M.fmtCompleto(p.gastos_representacion)} de gastos de representación, antes de descuentos.`,
            M.fmtCompleto(p.total)));
        }
      }
      if (r.ejecutado != null) {
        tiles.push(tile('Ya gastado en 2025', M.fmtMonto(r.ejecutado),
          `${M.fmtPct(r.pctEjecutado)} de lo autorizado. Es lo ejecutado, según los documentos del Parlamento.`, M.fmtCompleto(r.ejecutado)));
      }
      if (r.tipos) tiles.push(tileTipos(r.tipos));
      if (r.cargos) tiles.push(tileCargos(r.cargos));
      if (r.tieneSueldos) tiles.push(tileSueldo(r.cargos));
      renderMigas(M.migas(v), true);
      titDoc = `${r.titulo} · ¿De dónde sale la torta y cómo se reparte?`;
    }

    $('contexto').textContent = contexto;
    $('titulo').textContent = titulo;
    $('subtitulo').textContent = sub;
    $('tiles').replaceChildren(...tiles);
    renderExplica(v, v.tipo === 'general' ? null : M.resumenNodo(ov, v));
    document.title = titDoc;
    renderTablas();
    renderGrafico();
    $('anuncio').textContent = `Mostrando ${titulo}.`;
  }

  // ---------------------------------------------------------- estados
  function mostrarEstado(...contenido) {
    $('estado').replaceChildren(...contenido);
  }

  function mostrarError(e) {
    console.error(e);
    $('vista').hidden = true;
    const local = location.protocol === 'file:';
    mostrarEstado(h('div', { class: 'aviso', role: 'alert' },
      h('strong', {}, 'No se pudieron cargar los datos. '),
      local
        ? 'Los navegadores bloquean la lectura de archivos locales. Desde la carpeta web/ se puede abrir un servidor con "python -m http.server 8000" y visitar http://localhost:8000.'
        : (e && e.message) || 'Intente nuevamente.',
      ' ',
      h('a', { href: '#' }, 'Volver al inicio')));
  }

  function mostrarNoEncontrado(id) {
    $('vista').hidden = true;
    renderMigas([{ texto: 'Inicio', hash: '#' }, { texto: 'Página no encontrada', hash: null }]);
    mostrarEstado(h('div', { class: 'aviso', role: 'alert' },
      `No existe la vista «${id}». Puede que el enlace sea antiguo. `,
      h('a', { href: '#' }, 'Volver al inicio')));
  }

  async function route() {
    const token = ++state.token;
    const card = $('grafico-card');
    card.classList.add('cargando'); // mantiene el cuadro anterior, atenuado, mientras carga
    card.setAttribute('aria-busy', 'true');
    try {
      const id = decodeURIComponent(location.hash.replace(/^#\/?/, '')).split('#')[0]; // ignora sufijos como #otros
      const vista = id
        ? Object.assign({ tipo: 'nodo' }, await M.resolver(state.ov, id, cargarArchivo))
        : { tipo: 'general' };
      if (token !== state.token) return;
      state.vista = vista;
      mostrarEstado();
      $('vista').hidden = false;
      renderVista();
      if (!state.primera) {
        $('migas').scrollIntoView({ behavior: MQ_MOVIMIENTO.matches ? 'auto' : 'smooth', block: 'start' });
        $('titulo').focus({ preventScroll: true });
      }
      state.primera = false;
    } catch (e) {
      if (token !== state.token) return;
      if (e && e.code === 'NOT_FOUND') mostrarNoEncontrado(location.hash.slice(1));
      else mostrarError(e);
    } finally {
      if (token === state.token) {
        card.classList.remove('cargando');
        card.removeAttribute('aria-busy');
      }
    }
  }

  async function boot() {
    if (location.protocol === 'file:') { mostrarError(new Error('file')); return; }
    mostrarEstado('Cargando datos…');
    try {
      state.ov = await getJSON(BASE + 'overview.json');
    } catch (e) { mostrarError(e); return; }
    await asegurarEcharts();
    renderNotas();
    window.addEventListener('hashchange', route);
    MQ_OSCURO.addEventListener('change', () => { if (state.vista) renderGrafico(); });

    let raf = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!state.vista || !state.chart) return;
        if (layoutPara($('grafico').clientWidth).clave !== state.clave) renderGrafico();
        else state.chart.resize();
      });
    }).observe($('grafico-card'));

    $('vista').hidden = false; // el contenedor debe ser visible para medirlo
    route();
  }

  boot();
})();
