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

  // Textos para el público general. Los nombres oficiales (inciso, unidad ejecutora...)
  // se conservan entre paréntesis o en los tooltips.
  var NIVELES_GASTO = [
    'Gasto público', 'Grupo de organismos', 'Organismo (inciso)', 'Oficina o dirección (unidad ejecutora)',
    'Programa', 'En qué se gasta', 'Rubro del gasto',
  ];
  var NIVELES_RECURSOS = ['Recursos', 'Tipo de ingreso', 'Subtipo de ingreso', 'Ingreso'];
  var PLURAL = {
    'Grupo de organismos': 'grupos de organismos',
    'Organismo (inciso)': 'organismos (incisos)',
    'Oficina o dirección (unidad ejecutora)': 'oficinas o direcciones (unidades ejecutoras)',
    'Programa': 'programas',
    'En qué se gasta': 'formas de gasto',
    'Rubro del gasto': 'rubros del gasto',
    'Parte de las remuneraciones': 'partes',
    'Tipo de contrato': 'tipos de contrato',
    'Escalafón': 'escalafones',
    'Tipo de ingreso': 'tipos de ingreso',
    'Subtipo de ingreso': 'subtipos de ingreso',
    'Ingreso': 'ingresos',
    'Artículo comprado': 'artículos comprados',
    'Proveedor': 'proveedores',
    'Compra': 'compras',
  };

  // Nombres simples para lo que se repite en todas las vistas: [nombre, explicación].
  // Clave: id del nodo, o "fuente/<código>" para los fondos de financiamiento.
  var AMIGABLE = {
    'fuente/11': ['Plata sin destino fijo', 'Rentas Generales: la plata del Estado que puede gastarse en lo que se decida, sin estar reservada para nada en particular.'],
    'fuente/12': ['Plata con destino fijo', 'Recursos con afectación especial: cobros que la ley reserva para un fin determinado.'],
    'fuente/15': ['Plata fija para vivienda', 'Fondo Nacional de Vivienda: plata reservada para vivienda.'],
    'fuente/21': ['Préstamos del exterior', 'Endeudamiento externo: préstamos para proyectos específicos.'],
    'fuente/13': ['Otra fuente (código 13)', 'Los datos oficiales no la describen.'],
    'fuente/51': ['Otra fuente (código 51)', 'Los datos oficiales no la describen.'],
    'recursos/ingresos-tributarios': ['Impuestos', 'Lo que se cobra por impuestos, como el IVA y el IRPF.'],
    'recursos/ingresos-no-tributarios': ['Tasas, multas y otros cobros', 'Venta de bienes y servicios del Estado, alquileres, multas y concesiones.'],
    'recursos/transferencias': ['Transferencias recibidas', 'Plata que un organismo recibe de otro.'],
    'recursos/incremento-de-patrimonio': ['Aumento de patrimonio', 'Ingresos contables que aumentan el patrimonio del Estado.'],
    'recursos/ingresos-por-disminucion-de-activos': ['Venta o baja de bienes', 'Ingresos por vender o dar de baja bienes del Estado.'],
    'recursos/contribuciones-figurativas-en-el-pto-nal': ['Aportes entre organismos', 'Movimientos de plata dentro del propio Estado.'],
    'gasto/a': ['Presidencia y ministerios', 'Administración Central: Presidencia de la República y los ministerios.'],
    'gasto/b': ['Pagos generales del Estado', 'Otros Organismos: intereses de la deuda, apoyo a la seguridad social, subsidios y partidas que se reparten después.'],
    'gasto/p': ['Parlamento', 'Poder Legislativo: Cámara de Senadores, Cámara de Representantes y Comisión Administrativa (con la Institución Nacional de Derechos Humanos). No está en los archivos oficiales de gasto: lo sumamos con datos de cada Cámara, a fin de 2025.'],
    'gasto/p/1/002/0': ['Todo el gasto de la Cámara', 'Los documentos de la Cámara de Representantes no dividen su gasto en programas, así que este nivel junta todo su gasto.'],
    'gasto/c': ['Educación, salud y justicia', 'Organismos del Art. 220: organismos con autonomía, como ANEP, ASSE, la Universidad de la República, el Poder Judicial y la Fiscalía.'],
  };
  var TIPOS_AMIGABLES = {
    'Remuneraciones': 'Sueldos y salarios',
    'Funcionamiento': 'Gastos del día a día (compras y servicios)',
    'Inversiones': 'Obras y equipamiento',
  };

  // Escalafones: [nombre simple, qué es, ¿lo definen la ley y las fuentes? (false = se dedujo de los datos)].
  var ESCALAFONES = {
    'A': ['Profesionales (escalafón A)', 'Cargos que piden título universitario: abogados, médicos, contadores, ingenieros y similares.', true],
    'B': ['Técnicos (escalafón B)', 'Cargos que piden una formación técnica específica para tareas especializadas.', true],
    'C': ['Administrativos (escalafón C)', 'Trabajo de oficina: atender trámites, registrar datos, archivar y ordenar papeles.', true],
    'D': ['Especializados (escalafón D)', 'Tareas que piden una habilidad o capacitación especial, pero no un título universitario.', true],
    'E': ['Oficios (escalafón E)', 'Trabajos manuales de oficio: electricistas, carpinteros, mecánicos, albañiles y similares.', true],
    'F': ['Servicios auxiliares (escalafón F)', 'Tareas de apoyo: limpieza, portería, conducción de vehículos y vigilancia.', true],
    'J': ['Docentes de otros organismos (escalafón J)', 'Docentes que trabajan en organismos distintos de la Universidad de la República y de la ANEP.', true],
    'K': ['Militares (escalafón K)', 'Personal de las Fuerzas Armadas. En los datos aparece sobre todo en Defensa Nacional.', true],
    'L': ['Policías (escalafón L)', 'Personal de la Policía. En los datos aparece sobre todo en el Ministerio del Interior.', true],
    'M': ['Servicio exterior (escalafón M)', 'Diplomáticos y personal que representa al país en otros países.', true],
    'N': ['Justicia y fiscalía (escalafón N)', 'La ley lo llama "personal judicial". En estos datos aparecen sobre todo abogados y fiscales del Estado.', true],
    'P': ['Cargos políticos (escalafón P)', 'Cargos que se llenan por elección o por decisión política, como ministros y subsecretarios.', true],
    'Q': ['Cargos de confianza (escalafón Q)', 'Personas que elige directamente una autoridad para que la acompañen. Se llaman "particular confianza".', true],
    'R': ['Otros cargos (escalafón R)', 'Cargos que no entran en ninguno de los otros grupos, como asesores o informáticos.', true],
    'S': ['Cárceles (escalafón S)', 'En los datos son los operadores penitenciarios, que trabajan en las cárceles. La ley no lo describe: es una deducción a partir de los cargos.', false],
    'CO2': ['Dirección (CO2)', 'Cargos de dirección, como directores de división. Es una deducción a partir de los nombres de los cargos.', false],
    'CO3': ['Dirección (CO3)', 'Cargos de dirección, como gerentes de área. Es una deducción a partir de los nombres de los cargos.', false],
    'PC1': ['Nivel superior (PC1)', 'Un subgrupo "Superior" dentro del Ministerio del Interior. Es una deducción a partir de los nombres de los cargos.', false],
    'SIN': ['Sin escalafón', 'Cargos que en los datos no tienen escalafón, como zafrales, función pública y encuestadores.', false],
  };

  /** Clave de escalafón de un nodo (A, L, CO3, SIN...) o null si el nodo no es un escalafón. */
  function escalafonClave(id, oficial) {
    if (!oficial || !/\/r\/cargos\/[^/]+\/[^/]+$/.test(id || '')) return null;
    if (oficial === 'Sin escalafón') return 'SIN';
    var m = /^Escalafón (\S+)$/.exec(oficial);
    return m && ESCALAFONES[m[1]] ? m[1] : null;
  }
  var NOMBRE_SUELDOS_CORTO = 'Sueldos de los cargos (estimado)';
  var AYUDA_SUELDOS = 'Sueldos nominales de los cargos (estimado): lo que dicen los datos de cargos, multiplicado por 14 pagos al año. No incluye compensaciones adicionales, incentivos ni aportes patronales.';
  function esSueldos(id) { return /\/r\/cargos$/.test(id || ''); }

  function nombreDe(id, oficial) {
    if (AMIGABLE[id]) return AMIGABLE[id][0];
    if (esSueldos(id)) return NOMBRE_SUELDOS_CORTO;
    var e = escalafonClave(id, oficial);
    return e ? ESCALAFONES[e][0] : oficial;
  }
  function ayudaDe(id, oficial) {
    if (AMIGABLE[id]) return AMIGABLE[id][1];
    if (esSueldos(id)) return AYUDA_SUELDOS;
    var e = escalafonClave(id, oficial);
    return e ? ESCALAFONES[e][1] : null;
  }
  function extraDe(id, oficial) {
    var a = ayudaDe(id, oficial);
    return a ? { ayuda: a, oficial: oficial } : {};
  }
  function conExtra(def, id, oficial) {
    var e = extraDe(id, oficial);
    Object.keys(e).forEach(function (k) { def[k] = e[k]; });
    return def;
  }

  // El color sigue a la fuente de financiamiento (la entidad), nunca a su posición:
  // las cuatro fuentes descritas en la metadata ocupan los slots 1-4 de la paleta;
  // el resto (códigos 13 y 51) va en gris.
  var FUENTE_SLOT = { '11': 0, '12': 1, '15': 2, '21': 3 };

  // Los flujos menores a esta fracción del total no se dibujan (quedarían como un
  // hilo invisible con la etiqueta encimada); siguen en las tablas.
  var UMBRAL_FLUJO = 0.0005;

  var AJ_ENTRADA = 'ajuste/entrada';
  var AJ_SALIDA = 'ajuste/salida';
  var ETIQ_AJ_ENTRADA = 'Falta para cubrir el gasto';
  var ETIQ_AJ_SALIDA = 'Sobra sin gasto asignado';

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

  var MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  /** '2025-08-28' -> '28/08/2025'; '2026-01' -> 'enero de 2026'. */
  function fmtFecha(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (m) return m[3] + '/' + m[2] + '/' + m[1];
    m = /^(\d{4})-(\d{2})$/.exec(iso || '');
    if (m) return MESES[Number(m[2]) - 1] + ' de ' + m[1];
    return iso || '';
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
    for (var i = 0; i < fs.length; i++) if (fs[i].codigo === code) return nombreDe('fuente/' + code, fs[i].nombre);
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
    var out = [{ texto: 'Inicio', hash: '#' }];
    vista.cadena.forEach(function (n, i) {
      out.push({ texto: nombreDe(n.id, n.nombre), hash: i < vista.cadena.length - 1 ? '#' + n.id : null });
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
      defs.push(conExtra({ id: c.id, label: nombreDe(c.id, c.nombre), col: 0, kind: 'recurso', fuente: null, nav: c.id, drillable: true }, c.id, c.nombre));
    });
    defs.push({ id: AJ_ENTRADA, label: ETIQ_AJ_ENTRADA, col: 0, kind: 'ajuste', fuente: null, nav: null, drillable: false });
    P.fuentes.forEach(function (f) {
      defs.push(conExtra({ id: 'fuente/' + f.codigo, label: nombreDe('fuente/' + f.codigo, f.nombre), col: 1, kind: 'fuente', fuente: f.codigo, nav: null, drillable: false }, 'fuente/' + f.codigo, f.nombre));
    });
    ov.gasto.hijos.forEach(function (c) {
      defs.push(conExtra({ id: c.id, label: nombreDe(c.id, c.nombre), col: 2, kind: 'gasto', fuente: null, nav: c.id, drillable: true, ejecutado: c.ejecutado != null ? c.ejecutado : null }, c.id, c.nombre));
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
      return conExtra({ id: 'fuente/' + e[0], label: fuenteNombre(ov, e[0]), col: colFuente, kind: 'fuente', fuente: e[0], nav: null, drillable: false }, 'fuente/' + e[0], (ov.puente.fuentes.filter(function (f) { return f.codigo === e[0]; })[0] || {}).nombre);
    });

    var defsHijo = [];
    if (!hijos.length) {
      defsHijo.push(conExtra({ id: nodo.id, label: nombreDe(nodo.id, nodo.nombre), col: colHijo, kind: kind, fuente: null, nav: null, drillable: false, cargos: nodo.cargos || null, ejecutado: nodo.ejecutado != null ? nodo.ejecutado : null }, nodo.id, nodo.nombre));
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
        defsHijo.push(conExtra({ id: h.id, label: nombreDe(h.id, h.nombre), col: colHijo, kind: kind, fuente: null, nav: dr ? h.id : null, drillable: dr, cargos: h.cargos || null, ejecutado: h.ejecutado != null ? h.ejecutado : null, compras: h.compras === true ? 'compra' : (h.compras_resto ? 'resto' : (h.compras ? 'rubro' : null)), escalado: !!(h.compras && h.compras.escalado), detalle: h.detalle || null }, h.id, h.nombre));
        entradasDesc(h.fuentes).forEach(function (e) { enlazar(e[0], h.id, e[1]); });
      });
      if (cola.length) {
        var idOtros = nodo.id + '#otros';
        defsHijo.push({ id: idOtros, label: 'Otros (' + cola.length + ' más)', col: colHijo, kind: 'otros', fuente: null, nav: null, drillable: false });
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
    var nivelSig = hijos.length ? n.nivel_hijos || niveles[prof + 1] || null : null;
    var tipos = n.tipos
      ? entradasDesc(n.tipos).map(function (e) { return { tipo: TIPOS_AMIGABLES[e[0]] || e[0], oficial: e[0], valor: e[1], pct: e[1] / n.valor }; })
      : null;
    return {
      id: n.id,
      titulo: nombreDe(n.id, n.nombre),
      esGasto: esGasto,
      nivel: n.nivel || niveles[prof] || '',
      cargos: n.cargos || null,
      sinCargos: !!n.sin_cargos,
      enlaces: n.enlaces || null,
      detalleCompra: n.detalle || null,
      enCompras: n.compras === true || !!n.compras_resto,
      comprasResto: !!n.compras_resto,
      comprasRubro: n.compras && n.compras !== true ? n.compras : null,
      ejecutado: n.ejecutado != null ? n.ejecutado : null,
      pctEjecutado: n.ejecutado != null && n.valor ? n.ejecutado / n.valor : null,
      esParlamento: /^gasto\/p(\/|$)/.test(n.id),
      legisladores: n.legisladores || null,
      escalaFuncionarios: n.escala_funcionarios || null,
      sufijo: n.id.slice(n.id.lastIndexOf('/') + 1),
      tieneObjetos: !!(n.objetos && n.objetos.length),
      oficial: ayudaDe(n.id, n.nombre) ? n.nombre : null,
      ayuda: ayudaDe(n.id, n.nombre),
      escalafon: escalafonClave(n.id, n.nombre),
      tieneDenominaciones: !!(n.denominaciones && n.denominaciones.length),
      tieneSueldos: !!(n.cargos && n.cargos.importe_mensual),
      padre: padre ? nombreDe(padre.id, padre.nombre) : null,
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
      nombre: nombreDe(n.id, n.nombre),
      valor: n.valor,
      pct: totalRef ? n.valor / totalRef : 0,
      fuentes: n.fuentes || {},
      hash: esDrillable(n) ? '#' + n.id : null,
      enlaces: n.enlaces || null,
    };
    if (n.ejecutado != null) {
      fila.ejecutado = n.ejecutado;
      fila.pctEjecutado = n.valor ? n.ejecutado / n.valor : 0;
    }
    if (extra) Object.keys(extra).forEach(function (k) { fila[k] = extra[k]; });
    return fila;
  }

  function filasHijos(vista) {
    var n = vista.nodo;
    return (n.hijos || []).map(function (h) { return filaDe(h, n.valor); });
  }

  /** Desglose por objeto del gasto de un nodo "Remuneraciones" que se separó en partes. */
  function filasObjetos(vista) {
    var n = vista.nodo;
    return (n.objetos || []).map(function (o) { return filaDe(o, n.valor); });
  }

  /** Cargos por tipo de contrato (régimen) de un nodo que trae resumen de cargos. */
  function filasRegimenes(nodo) {
    var c = nodo.cargos;
    if (!c || !c.regimenes) return [];
    return c.regimenes.map(function (r) {
      var cargos = r.ocupados + r.vacantes;
      return {
        nombre: r.nombre,
        ocupados: r.ocupados,
        vacantes: r.vacantes,
        importe: r.importe_mensual,
        promedio: cargos ? r.importe_mensual / cargos : 0,
      };
    });
  }

  /** Hijos con cargos (tipo de contrato o escalafón): cuántos cargos y cuánto sueldo mensual. */
  function filasCargosHijos(nodo) {
    return (nodo.hijos || []).filter(function (h) { return h.cargos && h.cargos.importe_mensual != null; }).map(function (h) {
      var c = h.cargos, cargos = c.ocupados + c.vacantes;
      return { nombre: nombreDe(h.id, h.nombre), ocupados: c.ocupados, vacantes: c.vacantes, importe: c.importe_mensual,
        promedio: cargos ? c.importe_mensual / cargos : 0, ayuda: ayudaDe(h.id, h.nombre), hash: esDrillable(h) ? '#' + h.id : null };
    });
  }

  /** Cargos de un escalafón, uno por denominación: [nombre, ocupados, vacantes, importe mensual]. */
  function filasDenominaciones(nodo) {
    return (nodo.denominaciones || []).map(function (d) {
      var cargos = d[1] + d[2];
      return { nombre: d[0], ocupados: d[1], vacantes: d[2], importe: d[3], promedio: cargos ? d[3] / cargos : 0 };
    });
  }

  /** Integrantes de una Cámara por partido: nombre, cantidad y parte del total. */
  function filasPartidos(l) {
    var total = l.partidos.reduce(function (a, p) { return a + p.integrantes; }, 0);
    return l.partidos.map(function (p) { return { nombre: p.nombre, codigo: p.codigo, integrantes: p.integrantes, pct: total ? p.integrantes / total : 0 }; });
  }

  /** Una fila por integrante: [nombre, partido (nombre completo), departamento, observación]. */
  function filasPersonas(l) {
    var nombres = {};
    l.partidos.forEach(function (p) { nombres[p.codigo] = p.nombre; });
    return l.personas.map(function (p) { return { nombre: p[0], partido: nombres[p[1]] || p[1], departamento: p[2], observacion: p[3] }; });
  }

  /** El cargo que cobra la mayoría de los integrantes (el sueldo "típico" de la Cámara). */
  function sueldoPrincipal(l) {
    var mejor = null;
    l.sueldos.forEach(function (s) { if (s.cantidad && (!mejor || s.cantidad > mejor.cantidad)) mejor = s; });
    return mejor;
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
        incisos.push(filaDe(inc, ov.totales.gasto, { clasificacion: nombreDe(clas.id, clas.nombre) }));
      });
    });
    incisos.sort(function (a, b) { return b.valor - a.valor; });
    var fuentes = ov.puente.fuentes.map(function (f) {
      return { codigo: f.codigo, nombre: nombreDe('fuente/' + f.codigo, f.nombre), recursos: f.recursos, gasto: f.gasto, saldo: f.saldo };
    });
    return { capitulos: capitulos, incisos: incisos, fuentes: fuentes };
  }

  // ---------------------------------------------------------------- tooltips
  /** "3.755 cargos ocupados y 523 vacantes. Sueldo mensual promedio por cargo: $ 66 mil." */
  function textoCargos(c) {
    var t = numEs(c.ocupados, 0) + ' cargos ocupados y ' + numEs(c.vacantes, 0) + ' vacantes.';
    var tot = c.ocupados + c.vacantes;
    if (c.importe_mensual && tot) t += ' Sueldo nominal mensual promedio por cargo: ' + fmtMonto(c.importe_mensual / tot) + '.';
    return t;
  }

  function tooltipNodo(n, total, color) {
    var h = ['<div class="tt"><div class="tt-v">', esc(fmtMonto(n.valor)), '</div><div class="tt-n">'];
    if (n.kind === 'fuente' && color) h.push('<span class="tt-key" style="background:', esc(color), '"></span>');
    h.push(esc(n.label), '</div><div class="tt-s">', esc(fmtPct(total ? n.valor / total : 0) + ' del total de este gráfico'), '</div>');
    if (n.ejecutado != null && n.valor) {
      h.push('<div class="tt-h">', esc('Ejecutado en 2025: ' + fmtMonto(n.ejecutado) + ' (' + fmtPct(n.ejecutado / n.valor) + ' de lo autorizado).'), '</div>');
    }
    if (n.cargos) h.push('<div class="tt-h">', esc(textoCargos(n.cargos)), '</div>');
    if (n.ayuda) h.push('<div class="tt-h">', esc(n.ayuda), '</div>');
    if (n.detalle) h.push('<div class="tt-h">', esc(n.detalle), '</div>');
    if (n.compras === 'compra') h.push('<div class="tt-h">', esc('Compra adjudicada en 2025 (catálogo de compras estatales). Adjudicar es decidir comprar: el pago puede llegar después.'), '</div>');
    if (n.compras === 'resto') h.push('<div class="tt-h">', esc('Parte de este rubro que no aparece en el catálogo de compras: otros tipos de gasto, compras sin monto o sin clasificar.'), '</div>');
    if (n.compras === 'rubro') h.push('<div class="tt-h">', esc('Este rubro incluye compras adjudicadas en 2025.' + (n.escalado ? ' Se adjudicó más de lo autorizado en este rubro: se muestra hasta el tope.' : '')), '</div>');
    if (n.drillable) h.push('<div class="tt-h">' + ((typeof window !== 'undefined' && window.ES_CELULAR) ? 'Toca' : 'Haz clic') + ' para ver el detalle ›</div>');
    if (n.kind === 'otros') h.push('<div class="tt-h">Junta los elementos más chicos. La lista completa está en la tabla de abajo.</div>');
    if (n.kind === 'ajuste') {
      h.push('<div class="tt-h">Es la diferencia entre lo que se espera cobrar y lo que se puede gastar con ese fondo. No es el déficit oficial.</div>');
    }
    h.push('</div>');
    return h.join('');
  }

  function tooltipEnlace(l, etiquetaOrigen, etiquetaDestino, total, color) {
    var h = ['<div class="tt"><div class="tt-v">', esc(fmtMonto(l.valor)), '</div><div class="tt-n">'];
    if (color) h.push('<span class="tt-key" style="background:', esc(color), '"></span>');
    h.push(esc(etiquetaOrigen), ' → ', esc(etiquetaDestino), '</div><div class="tt-s">',
      esc(fmtPct(total ? l.valor / total : 0) + ' del total de este gráfico'), '</div></div>');
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
    fmtFecha: fmtFecha,
    filasPartidos: filasPartidos,
    filasPersonas: filasPersonas,
    sueldoPrincipal: sueldoPrincipal,
    esc: esc,
    nombreDe: nombreDe,
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
    filasObjetos: filasObjetos,
    filasRegimenes: filasRegimenes,
    filasCargosHijos: filasCargosHijos,
    filasDenominaciones: filasDenominaciones,
    ESCALAFONES: ESCALAFONES,
    textoCargos: textoCargos,
    filasFuentesDeNodo: filasFuentesDeNodo,
    filasGeneral: filasGeneral,
    tooltipNodo: tooltipNodo,
    tooltipEnlace: tooltipEnlace,
  };
});
