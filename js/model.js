/*
 * model.js - lógica pura (sin DOM ni ECharts) del Visualizador de Finanzas Estatales de Uruguay.
 *
 * Convierte los JSON generados por etl.py en "especificaciones" de Sankey neutrales
 * ({nodes, links}) y en filas de tabla. app.js las traduce a ECharts y a DOM.
 * Se puede probar con Node: const M = require('./model.js').
 *
 * Todo el texto que sale de los datos es no confiable: los constructores de HTML
 * de tooltip pasan siempre por esc().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FinanzasModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var NIVELES_GASTO = [
    'Gasto público', 'Clasificación de inciso', 'Inciso', 'Unidad ejecutora',
    'Programa', 'Tipo de gasto', 'Objeto del gasto',
  ];
  var NIVELES_RECURSOS = ['Recursos', 'Capítulo', 'Clase', 'Recurso'];
  var PLURAL = {
    'Clasificación de inciso': 'clasificaciones de inciso',
    'Inciso': 'incisos',
    'Unidad ejecutora': 'unidades ejecutoras',
    'Programa': 'programas',
    'Tipo de gasto': 'tipos de gasto',
    'Objeto del gasto': 'objetos del gasto',
    'Capítulo': 'capítulos',
    'Clase': 'clases',
    'Recurso': 'recursos',
  };

  // El color sigue a la fuente de financiamiento (la entidad), nunca a su posición:
  // las cuatro fuentes descritas en la metadata ocupan los slots 1-4 de la paleta;
  // el resto (códigos 13 y 51) va en gris.
  var FUENTE_SLOT = { '11': 0, '12': 1, '15': 2, '21': 3 };

  // Los flujos menores a esta fracción del total no se dibujan (quedarían como un
  // hilo invisible con la etiqueta encimada); siguen en las tablas.
  var UMBRAL_FLUJO = 0.0005;

  var AJ_ENTRADA = 'ajuste/entrada';
  var AJ_SALIDA = 'ajuste/salida';
  var ETIQ_AJ_ENTRADA = 'Diferencia (gasto > recursos)';
  var ETIQ_AJ_SALIDA = 'Diferencia (recursos > gasto)';

  // ------------------------------------------------------------------ formato
  function numEs(n, dec) {
    var s = Math.abs(n).toFixed(dec);
    var partes = s.split('.');
    var miles = partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (n < 0 ? '−' : '') + miles + (partes[1] ? ',' + partes[1] : '');
  }

  function fmtCorto(v) {
    var a = Math.abs(v);
    if (a >= 1e9) return numEs(a / 1e9, 1) + ' mil millones';
    if (a >= 1e8) return numEs(a / 1e6, 0) + ' millones';
    if (a >= 1e6) return numEs(a / 1e6, 1) + ' millones';
    return numEs(a, 0);
  }

  function fmtMonto(v) {
    return (v < 0 ? '−' : '') + '$U ' + fmtCorto(v);
  }

  function fmtCompleto(v) {
    return (v < 0 ? '−' : '') + '$U ' + numEs(Math.abs(v), 0);
  }

  function fmtPct(x) {
    var p = x * 100;
    if (p > 0 && p < 0.1) return '<0,1 %';
    return numEs(p, 1) + ' %';
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ------------------------------------------------------------------ fuentes
  function fuenteSlot(code) {
    return Object.prototype.hasOwnProperty.call(FUENTE_SLOT, code) ? FUENTE_SLOT[code] : -1;
  }

  function fuenteNombre(ov, code) {
    var fs = ov.puente.fuentes;
    for (var i = 0; i < fs.length; i++) if (fs[i].codigo === code) return fs[i].nombre;
    return 'Fuente ' + code;
  }

  // --------------------------------------------------------------------- árbol
  function esDrillable(n) {
    return !!(n.archivo || (n.hijos && n.hijos.length));
  }

  function profundidad(id) {
    return id.split('/').length - 1;
  }

  function noEncontrado(id) {
    var e = new Error('No existe la vista: ' + id);
    e.code = 'NOT_FOUND';
    return e;
  }

  /**
   * Resuelve un id ("gasto/a/24/1") a la cadena de nodos desde el primer nivel hasta él.
   * Los incisos del overview vienen sin hijos y con `archivo`: se cargan con
   * cargarArchivo(archivo) -> Promise<nodo completo>.
   */
  async function resolver(ov, id, cargarArchivo) {
    var partes = id.split('/');
    var arbol = partes[0];
    if ((arbol !== 'gasto' && arbol !== 'recursos') || partes.length < 2) throw noEncontrado(id);
    var cur = ov[arbol];
    var cadena = [];
    for (var i = 1; i < partes.length; i++) {
      var pid = partes.slice(0, i + 1).join('/');
      var hijo = (cur.hijos || []).find(function (h) { return h.id === pid; });
      if (!hijo) throw noEncontrado(id);
      if (hijo.archivo && !hijo.hijos) {
        var completo = await cargarArchivo(hijo.archivo);
        if (!completo || completo.id !== hijo.id) throw new Error('El archivo ' + hijo.archivo + ' no corresponde a ' + hijo.id);
        hijo = completo;
      }
      cadena.push(hijo);
      cur = hijo;
    }
    return { arbol: arbol, cadena: cadena, nodo: cadena[cadena.length - 1] };
  }

  function migas(vista) {
    var out = [{ texto: 'Vista general', hash: '#' }];
    vista.cadena.forEach(function (n, i) {
      out.push({ texto: n.nombre, hash: i < vista.cadena.length - 1 ? '#' + n.id : null });
    });
    return out;
  }

  // -------------------------------------------------------- utilidades de spec
  function entradasDesc(obj) {
    return Object.keys(obj || {})
      .map(function (k) { return [k, obj[k]]; })
      .filter(function (e) { return e[1] > 0; })
      .sort(function (a, b) { return b[1] - a[1] || (a[0] < b[0] ? -1 : 1); });
  }

  function sumarFuentes(nodos) {
    var acc = {};
    nodos.forEach(function (n) {
      Object.keys(n.fuentes || {}).forEach(function (f) { acc[f] = (acc[f] || 0) + n.fuentes[f]; });
    });
    return acc;
  }

  /** Aplica el umbral, calcula el valor de cada nodo y descarta los que quedan sin flujos. */
  function ensamblar(defs, links, total) {
    var umbral = total * UMBRAL_FLUJO;
    var etiqueta = {};
    defs.forEach(function (d) { etiqueta[d.id] = d.label; });

    var kept = [];
    var omitidos = [];
    links.forEach(function (l) {
      if (l.valor >= umbral) kept.push(l);
      else omitidos.push({ origen: etiqueta[l.source], destino: etiqueta[l.target], valor: l.valor });
    });

    var entra = {};
    var sale = {};
    kept.forEach(function (l) {
      sale[l.source] = (sale[l.source] || 0) + l.valor;
      entra[l.target] = (entra[l.target] || 0) + l.valor;
    });

    var nodes = [];
    defs.forEach(function (d) {
      if (!(d.id in entra) && !(d.id in sale)) return;
      var copia = {};
      Object.keys(d).forEach(function (k) { copia[k] = d[k]; });
      copia.valor = Math.max(entra[d.id] || 0, sale[d.id] || 0);
      nodes.push(copia);
    });
    nodes.sort(function (a, b) { return a.col - b.col; }); // estable: conserva el orden mayor -> menor

    var porCol = {};
    nodes.forEach(function (n) { porCol[n.col] = (porCol[n.col] || 0) + 1; });
    var maxCol = 0;
    Object.keys(porCol).forEach(function (c) { if (porCol[c] > maxCol) maxCol = porCol[c]; });

    return { nodes: nodes, links: kept, omitidos: omitidos, total: total, maxCol: maxCol };
  }

  // ------------------------------------------------------------- vista general
  /** recursos (capítulo) -> fuente de financiamiento -> gasto (clasificación de inciso). */
  function specGeneral(ov) {
    var P = ov.puente;
    var total = Math.max(ov.totales.recursos, ov.totales.gasto);
    var defs = [];
    var links = [];

    ov.recursos.hijos.forEach(function (c) {
      defs.push({ id: c.id, label: c.nombre, col: 0, kind: 'recurso', fuente: null, nav: c.id, drillable: true });
    });
    defs.push({ id: AJ_ENTRADA, label: ETIQ_AJ_ENTRADA, col: 0, kind: 'ajuste', fuente: null, nav: null, drillable: false });
    P.fuentes.forEach(function (f) {
      defs.push({ id: 'fuente/' + f.codigo, label: f.nombre, col: 1, kind: 'fuente', fuente: f.codigo, nav: null, drillable: false });
    });
    ov.gasto.hijos.forEach(function (c) {
      defs.push({ id: c.id, label: c.nombre, col: 2, kind: 'gasto', fuente: null, nav: c.id, drillable: true });
    });
    defs.push({ id: AJ_SALIDA, label: ETIQ_AJ_SALIDA, col: 2, kind: 'ajuste', fuente: null, nav: null, drillable: false });

    P.flujos_recursos.forEach(function (r) {
      links.push({ source: r.origen_id, target: 'fuente/' + r.fuente, valor: r.valor, fuente: r.fuente });
    });
    P.flujos_gasto.forEach(function (g) {
      links.push({ source: 'fuente/' + g.fuente, target: g.destino_id, valor: g.valor, fuente: g.fuente });
    });
    P.ajustes.forEach(function (a) {
      if (a.tipo === 'gasto_sin_recurso_asignado') {
        links.push({ source: AJ_ENTRADA, target: 'fuente/' + a.fuente, valor: a.valor, fuente: null });
      } else {
        links.push({ source: 'fuente/' + a.fuente, target: AJ_SALIDA, valor: a.valor, fuente: null });
      }
    });

    var spec = ensamblar(defs, links, total);
    spec.tipo = 'general';
    return spec;
  }

  // ------------------------------------------------------- vista de un nodo
  /**
   * Gasto:    fuentes (izquierda) -> hijos del nodo (derecha), enlaces exactos fuente x hijo.
   * Recursos: hijos del nodo (izquierda) -> fuentes (derecha).
   * Más de `maxHijos` hijos: los menores se agrupan en "Otros (n)"; la tabla lista todos.
   */
  function specNodo(ov, vista, opts) {
    var max = Math.max(3, (opts && opts.maxHijos) || 12);
    var nodo = vista.nodo;
    var esGasto = vista.arbol === 'gasto';
    var kind = esGasto ? 'gasto' : 'recurso';
    var colFuente = esGasto ? 0 : 1;
    var colHijo = esGasto ? 1 : 0;
    var hijos = nodo.hijos || [];
    var links = [];

    function enlazar(f, hid, v) {
      links.push(esGasto
        ? { source: 'fuente/' + f, target: hid, valor: v, fuente: f }
        : { source: hid, target: 'fuente/' + f, valor: v, fuente: f });
    }

    var fuentesOrden = entradasDesc(nodo.fuentes);
    var defsFuente = fuentesOrden.map(function (e) {
      return { id: 'fuente/' + e[0], label: fuenteNombre(ov, e[0]), col: colFuente, kind: 'fuente', fuente: e[0], nav: null, drillable: false };
    });

    var defsHijo = [];
    if (!hijos.length) {
      defsHijo.push({ id: nodo.id, label: nodo.nombre, col: colHijo, kind: kind, fuente: null, nav: null, drillable: false });
      fuentesOrden.forEach(function (e) { enlazar(e[0], nodo.id, e[1]); });
    } else {
      var visibles = hijos;
      var cola = [];
      if (hijos.length > max) {
        visibles = hijos.slice(0, max - 1);
        cola = hijos.slice(max - 1);
      }
      visibles.forEach(function (h) {
        var dr = esDrillable(h);
        defsHijo.push({ id: h.id, label: h.nombre, col: colHijo, kind: kind, fuente: null, nav: dr ? h.id : null, drillable: dr });
        entradasDesc(h.fuentes).forEach(function (e) { enlazar(e[0], h.id, e[1]); });
      });
      if (cola.length) {
        var idOtros = nodo.id + '#otros';
        defsHijo.push({ id: idOtros, label: 'Otros (' + cola.length + ')', col: colHijo, kind: 'otros', fuente: null, nav: null, drillable: false });
        entradasDesc(sumarFuentes(cola)).forEach(function (e) { enlazar(e[0], idOtros, e[1]); });
      }
    }

    var defs = esGasto ? defsFuente.concat(defsHijo) : defsHijo.concat(defsFuente);
    var spec = ensamblar(defs, links, nodo.valor);
    spec.tipo = 'nodo';
    return spec;
  }

  function leyendaFuentes(spec) {
    return spec.nodes
      .filter(function (n) { return n.kind === 'fuente'; })
      .map(function (n) { return { codigo: n.fuente, nombre: n.label }; });
  }

  // ---------------------------------------------------------- resúmenes / tablas
  function resumenNodo(ov, vista) {
    var n = vista.nodo;
    var prof = profundidad(n.id);
    var esGasto = vista.arbol === 'gasto';
    var niveles = esGasto ? NIVELES_GASTO : NIVELES_RECURSOS;
    var total = esGasto ? ov.totales.gasto : ov.totales.recursos;
    var padre = vista.cadena.length > 1 ? vista.cadena[vista.cadena.length - 2] : null;
    var hijos = n.hijos || [];
    var nivelSig = hijos.length ? niveles[prof + 1] || null : null;
    var tipos = n.tipos
      ? entradasDesc(n.tipos).map(function (e) { return { tipo: e[0], valor: e[1], pct: e[1] / n.valor }; })
      : null;
    return {
      titulo: n.nombre,
      esGasto: esGasto,
      nivel: niveles[prof] || '',
      padre: padre ? padre.nombre : null,
      valor: n.valor,
      pctTotal: n.valor / total,
      totalEtiqueta: esGasto ? 'del gasto total' : 'de los recursos totales',
      nHijos: hijos.length,
      nivelSiguiente: nivelSig,
      nivelSiguientePlural: nivelSig ? PLURAL[nivelSig] || nivelSig.toLowerCase() : null,
      tipos: tipos,
    };
  }

  function filaDe(n, totalRef, extra) {
    var fila = {
      id: n.id,
      nombre: n.nombre,
      valor: n.valor,
      pct: totalRef ? n.valor / totalRef : 0,
      fuentes: n.fuentes || {},
      hash: esDrillable(n) ? '#' + n.id : null,
    };
    if (extra) Object.keys(extra).forEach(function (k) { fila[k] = extra[k]; });
    return fila;
  }

  function filasHijos(vista) {
    var n = vista.nodo;
    return (n.hijos || []).map(function (h) { return filaDe(h, n.valor); });
  }

  function filasFuentesDeNodo(ov, nodo) {
    return entradasDesc(nodo.fuentes).map(function (e) {
      return { codigo: e[0], nombre: fuenteNombre(ov, e[0]), valor: e[1], pct: e[1] / nodo.valor };
    });
  }

  function filasGeneral(ov) {
    var capitulos = ov.recursos.hijos.map(function (c) { return filaDe(c, ov.totales.recursos); });
    var incisos = [];
    ov.gasto.hijos.forEach(function (clas) {
      clas.hijos.forEach(function (inc) {
        incisos.push(filaDe(inc, ov.totales.gasto, { clasificacion: clas.nombre }));
      });
    });
    incisos.sort(function (a, b) { return b.valor - a.valor; });
    var fuentes = ov.puente.fuentes.map(function (f) {
      return { codigo: f.codigo, nombre: f.nombre, recursos: f.recursos, gasto: f.gasto, saldo: f.saldo };
    });
    return { capitulos: capitulos, incisos: incisos, fuentes: fuentes };
  }

  // ---------------------------------------------------------------- tooltips
  function tooltipNodo(n, total, color) {
    var h = ['<div class="tt"><div class="tt-v">', esc(fmtMonto(n.valor)), '</div><div class="tt-n">'];
    if (n.kind === 'fuente' && color) h.push('<span class="tt-key" style="background:', esc(color), '"></span>');
    h.push(esc(n.label), '</div><div class="tt-s">', esc(fmtPct(total ? n.valor / total : 0) + ' del total mostrado'), '</div>');
    if (n.drillable) h.push('<div class="tt-h">Clic para profundizar ›</div>');
    if (n.kind === 'otros') h.push('<div class="tt-h">Agrupa los elementos menores; el detalle está en la tabla.</div>');
    if (n.kind === 'ajuste') {
      h.push('<div class="tt-h">Diferencia entre recursos y gasto de una misma fuente. No equivale por sí sola a déficit.</div>');
    }
    h.push('</div>');
    return h.join('');
  }

  function tooltipEnlace(l, etiquetaOrigen, etiquetaDestino, total, color) {
    var h = ['<div class="tt"><div class="tt-v">', esc(fmtMonto(l.valor)), '</div><div class="tt-n">'];
    if (color) h.push('<span class="tt-key" style="background:', esc(color), '"></span>');
    h.push(esc(etiquetaOrigen), ' → ', esc(etiquetaDestino), '</div><div class="tt-s">',
      esc(fmtPct(total ? l.valor / total : 0) + ' del total mostrado'), '</div></div>');
    return h.join('');
  }

  return {
    NIVELES_GASTO: NIVELES_GASTO,
    NIVELES_RECURSOS: NIVELES_RECURSOS,
    UMBRAL_FLUJO: UMBRAL_FLUJO,
    numEs: numEs,
    fmtCorto: fmtCorto,
    fmtMonto: fmtMonto,
    fmtCompleto: fmtCompleto,
    fmtPct: fmtPct,
    esc: esc,
    fuenteSlot: fuenteSlot,
    fuenteNombre: fuenteNombre,
    esDrillable: esDrillable,
    profundidad: profundidad,
    resolver: resolver,
    migas: migas,
    specGeneral: specGeneral,
    specNodo: specNodo,
    leyendaFuentes: leyendaFuentes,
    resumenNodo: resumenNodo,
    filasHijos: filasHijos,
    filasFuentesDeNodo: filasFuentesDeNodo,
    filasGeneral: filasGeneral,
    tooltipNodo: tooltipNodo,
    tooltipEnlace: tooltipEnlace,
  };
});
