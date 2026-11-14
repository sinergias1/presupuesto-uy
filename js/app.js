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
    if (ancho >= 900) return { clave: 'ancho', izq: 190, der: 230, etiqueta: 180, fuente: 12, fila: 30, gap: 10, maxHijos: 12, col0Izq: true };
    if (ancho >= 600) return { clave: 'medio', izq: 150, der: 170, etiqueta: 140, fuente: 12, fila: 32, gap: 10, maxHijos: 10, col0Izq: true };
    return { clave: 'angosto', izq: 8, der: 96, etiqueta: 92, fuente: 11, fila: 36, gap: 8, maxHijos: 7, col0Izq: false };
  }

  // ------------------------------------------------------------ gráfico
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
        extraCssText: 'border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.14);',
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
        labelLayout: { hideOverlap: true },
        label: {
          color: pal.ink,
          fontSize: L.fuente,
          width: L.etiqueta,
          overflow: 'truncate',
          ellipsis: '…',
          textBorderColor: pal.surface,
          textBorderWidth: 3,
          formatter: (p) => {
            const n = nodos.get(p.name);
            return n ? n.label + (n.drillable ? ' ›' : '') : p.name;
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
      'No se pudo cargar la biblioteca de gráficos (Apache ECharts). Los mismos datos están en las tablas de abajo.'));
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
      h('summary', {}, `${n} flujo${n === 1 ? '' : 's'} demasiado pequeño${n === 1 ? '' : 's'} para dibujarse (suman ${M.fmtMonto(suma)})`),
      h('ul', {}, spec.omitidos.map((o) => h('li', {}, `${o.origen} → ${o.destino}: ${M.fmtMonto(o.valor)}`))));
  }

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
    $('pista').textContent =
      'Clic en un nodo con › para profundizar, o en un nombre de las tablas. El color de los flujos indica la fuente de financiamiento.' +
      (hayOtros ? ' «Otros» agrupa los elementos menores; el detalle completo está en la tabla.' : '');
    const quien = v.tipo === 'general' ? 'la vista general' : v.nodo.nombre;
    cont.setAttribute('aria-label',
      `Diagrama de Sankey de ${quien}. Los mismos datos están en las tablas siguientes.`);

    if (!window.echarts) { avisoSinGrafico(cont); return; }
    try {
      if (!state.chart) {
        cont.replaceChildren();
        state.chart = window.echarts.init(cont, null, { renderer: 'svg' });
        state.chart.on('click', (p) => {
          if (p.dataType !== 'node' || !state.idx) return;
          const n = state.idx.nodos.get(p.name);
          if (n && n.nav) location.hash = '#' + n.nav;
        });
      }
      cont.style.height = Math.max(360, Math.min(900, spec.maxCol * L.fila + 70)) + 'px';
      state.chart.resize();
      state.chart.setOption(opcionesSankey(spec, paleta(), L), true);
    } catch (e) {
      console.error(e);
      state.chart = null;
      avisoSinGrafico(cont);
    }
  }

  // --------------------------------------------------------- cabecera
  function renderMigas(items) {
    const ol = h('ol', { class: 'migas' });
    items.forEach((m, i) => {
      const ultimo = i === items.length - 1;
      ol.append(h('li', {}, ultimo
        ? h('span', { 'aria-current': 'page', title: m.texto }, m.texto)
        : h('a', { href: m.hash, title: m.texto }, m.texto)));
    });
    $('migas').replaceChildren(ol);
  }

  function tile(etiqueta, valor, nota, exacto) {
    return h('div', { class: 'tile' },
      h('div', { class: 'tile-l' }, etiqueta),
      h('div', { class: 'tile-v', title: exacto || null }, valor),
      nota ? h('div', { class: 'tile-n' }, nota) : null);
  }

  function tileTipos(tipos) {
    return h('div', { class: 'tile' },
      h('div', { class: 'tile-l' }, 'Tipo de gasto'),
      h('div', { class: 'tipos' }, tipos.map((t) =>
        h('div', { class: 'tipo', title: `${t.tipo}: ${M.fmtMonto(t.valor)}` },
          h('span', { class: 'tipo-n' }, t.tipo),
          h('span', { class: 'tipo-p' }, M.fmtPct(t.pct)),
          h('span', { class: 'tipo-b' }, h('i', { style: `width:${(t.pct * 100).toFixed(1)}%` }))))));
  }

  function textoDescripcion(r) {
    if (r.nHijos) {
      return r.esGasto
        ? `Cómo se financia (por fuente de financiamiento) y cómo se distribuye entre ${r.nHijos} ${r.nivelSiguientePlural}.`
        : `De qué ${r.nivelSiguientePlural} se compone y a qué fuente de financiamiento se asigna cada parte (${r.nHijos}).`;
    }
    return 'Es el nivel más detallado: no tiene subdivisiones. Se muestra su fuente de financiamiento.';
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

  function filaRanking(f, conClasif) {
    return h('tr', {},
      h('th', { scope: 'row' }, f.hash ? h('a', { href: f.hash }, f.nombre) : f.nombre),
      conClasif ? h('td', { class: 'col-clas' }, f.clasificacion) : null,
      h('td', { class: 'num', title: M.fmtCompleto(f.valor) }, M.fmtMonto(f.valor)),
      h('td', { class: 'num' }, M.fmtPct(f.pct)),
      h('td', { class: 'col-fuentes' }, barraFuentes(f.fuentes)));
  }

  function tablaRanking({ titulo, nota, filas, columnaNombre, pctEtiqueta, conClasif, pagina = 25 }) {
    const tbody = h('tbody');
    const cabeza = h('tr', {},
      h('th', { scope: 'col' }, columnaNombre),
      conClasif ? h('th', { scope: 'col', class: 'col-clas' }, 'Clasificación') : null,
      h('th', { scope: 'col', class: 'num' }, 'Monto'),
      h('th', { scope: 'col', class: 'num' }, pctEtiqueta),
      h('th', { scope: 'col', class: 'col-fuentes' }, 'Fuentes de financiamiento'));
    const mas = h('p', { class: 'mas' });
    let mostradas = 0;

    function agregar() {
      const desde = mostradas;
      const hasta = Math.min(filas.length, mostradas + pagina);
      for (; mostradas < hasta; mostradas++) tbody.append(filaRanking(filas[mostradas], conClasif));
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
      h('h3', {}, 'Fuentes de financiamiento'),
      h('div', { class: 'tabla-wrap' }, h('table', { class: 'tabla' },
        h('caption', { class: 'sr-only' }, 'Fuentes de financiamiento'),
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col' }, 'Fuente'),
          h('th', { scope: 'col', class: 'num' }, 'Monto'),
          h('th', { scope: 'col', class: 'num' }, '% de este nodo'))),
        h('tbody', {}, filas.map((f) => h('tr', {},
          h('th', { scope: 'row' }, celdaFuente(f.codigo, f.nombre)),
          h('td', { class: 'num', title: M.fmtCompleto(f.valor) }, M.fmtMonto(f.valor)),
          h('td', { class: 'num' }, M.fmtPct(f.pct))))))));
  }

  function tablaPuente(filas) {
    return h('section', { class: 'tabla-sec' },
      h('h3', {}, 'Fuentes de financiamiento: recursos y gasto'),
      h('p', { class: 'tabla-nota' },
        'La diferencia compara los recursos proyectados con el crédito vigente de cada fuente. No equivale por sí sola a déficit.'),
      h('div', { class: 'tabla-wrap' }, h('table', { class: 'tabla' },
        h('caption', { class: 'sr-only' }, 'Fuentes de financiamiento: recursos, gasto y diferencia'),
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col' }, 'Fuente'),
          h('th', { scope: 'col', class: 'num' }, 'Recursos'),
          h('th', { scope: 'col', class: 'num' }, 'Gasto'),
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
          titulo: 'Gasto por inciso', nota: 'Todos los incisos, de mayor a menor. Clic en un nombre para ver su detalle.',
          filas: g.incisos, columnaNombre: 'Inciso', pctEtiqueta: '% del gasto total', conClasif: true,
        }),
        tablaRanking({
          titulo: 'Recursos por capítulo', filas: g.capitulos, columnaNombre: 'Capítulo',
          pctEtiqueta: '% de los recursos',
        }),
        tablaPuente(g.fuentes));
      return;
    }
    const r = M.resumenNodo(state.ov, v);
    const secciones = [];
    const filas = M.filasHijos(v);
    if (filas.length) {
      secciones.push(tablaRanking({
        titulo: r.nivelSiguiente ? r.nivelSiguiente[0].toUpperCase() + r.nivelSiguiente.slice(1) + ' (de mayor a menor)' : 'Detalle',
        filas, columnaNombre: r.nivelSiguiente || 'Nombre', pctEtiqueta: '% de este nodo',
      }));
    }
    secciones.push(tablaFuentesNodo(M.filasFuentesDeNodo(state.ov, v.nodo)));
    cont.replaceChildren(...secciones);
  }

  function renderNotas() {
    const m = state.ov.meta;
    $('notas').replaceChildren(h('details', {},
      h('summary', {}, 'Sobre los datos y cómo leer el gráfico'),
      h('ul', {},
        h('li', {}, `Recursos: ${m.recursos}.`),
        h('li', {}, `Gasto: ${m.gasto}.`),
        h('li', {}, `Unidad: ${m.unidad}.`),
        m.notas.map((t) => h('li', {}, t)),
        h('li', {}, 'El color de los flujos indica la fuente de financiamiento. Los nodos en gris no tienen color propio.'))));
  }

  // ------------------------------------------------------------- vista
  function renderVista() {
    const v = state.vista;
    const ov = state.ov;
    let titulo, contexto, sub, tiles, titDoc;

    if (v.tipo === 'general') {
      titulo = 'Vista general: recursos, fuentes y gasto';
      contexto = 'Vista general';
      sub = 'Recursos proyectados para 2025 → fuente de financiamiento → gasto por clasificación de inciso (crédito vigente al 31/05/2025).';
      tiles = [
        tile('Recursos proyectados 2025', M.fmtMonto(ov.totales.recursos), null, M.fmtCompleto(ov.totales.recursos)),
        tile('Gasto: crédito vigente al 31/05/2025', M.fmtMonto(ov.totales.gasto), null, M.fmtCompleto(ov.totales.gasto)),
        tile('Recursos menos gasto', M.fmtMonto(ov.totales.diferencia), 'No equivale por sí sola a déficit.', M.fmtCompleto(ov.totales.diferencia)),
      ];
      renderMigas([{ texto: 'Vista general', hash: null }]);
      titDoc = 'Presupuesto del Estado uruguayo 2025: de dónde viene y a dónde va el dinero';
    } else {
      const r = M.resumenNodo(ov, v);
      titulo = r.titulo;
      contexto = r.padre ? `${r.nivel} · ${r.padre}` : r.nivel;
      sub = textoDescripcion(r);
      tiles = [
        tile(r.esGasto ? 'Monto (crédito vigente)' : 'Monto proyectado', M.fmtMonto(r.valor), null, M.fmtCompleto(r.valor)),
        tile('Participación', M.fmtPct(r.pctTotal), r.totalEtiqueta),
      ];
      if (r.tipos) tiles.push(tileTipos(r.tipos));
      renderMigas(M.migas(v));
      titDoc = `${r.titulo} · Presupuesto 2025`;
    }

    $('contexto').textContent = contexto;
    $('titulo').textContent = titulo;
    $('subtitulo').textContent = sub;
    $('tiles').replaceChildren(...tiles);
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
      h('a', { href: '#' }, 'Volver a la vista general')));
  }

  function mostrarNoEncontrado(id) {
    $('vista').hidden = true;
    renderMigas([{ texto: 'Vista general', hash: '#' }, { texto: 'Vista no encontrada', hash: null }]);
    mostrarEstado(h('div', { class: 'aviso', role: 'alert' },
      `No existe la vista «${id}». Puede que el enlace sea antiguo. `,
      h('a', { href: '#' }, 'Volver a la vista general')));
  }

  async function route() {
    const token = ++state.token;
    const card = $('grafico-card');
    card.classList.add('cargando'); // mantiene el cuadro anterior, atenuado, mientras carga
    card.setAttribute('aria-busy', 'true');
    try {
      const id = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
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
