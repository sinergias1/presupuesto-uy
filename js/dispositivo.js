/*
 * dispositivo.js - Detecta si la persona está en un celular (el lado corto de la pantalla mide menos de 600 px).
 * Las tablets y los iPads quedan con la vista 3D; los celulares van siempre a la vista 2D (detalle.html),
 * que se lee mejor en una pantalla chica y gasta menos batería.
 */
(function () {
  var es = Math.min(screen.width, screen.height) < 600;
  window.ES_CELULAR = es;
  if (!es) return;
  document.documentElement.classList.add('es-celular');
  var pagina = location.pathname.split('/').pop();
  if (pagina === '' || pagina === 'index.html' || pagina === '3d.html') {
    var h = location.hash;
    location.replace('detalle.html' + (/^#\/?(gasto|recursos)\//.test(h) ? h : ''));
  }
})();
