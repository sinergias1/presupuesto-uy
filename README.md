# ¿De dónde sale la torta y cómo se reparte?

Visualizador de Finanzas Estatales de Uruguay

Diagrama de Sankey interactivo del Presupuesto Nacional 2025 (recursos → fuentes de financiamiento → gasto por inciso), con navegación de mayor a menor y migas de pan.

Datos: paquetes de datos abiertos del MEF y la Contaduría General de la Nación (crédito vigente al 31/05/2025 y recursos proyectados 2025), más el Poder Legislativo con datos propios (ver abajo).

## Ver en local

```
python -m http.server 8000
```

Abrir http://localhost:8000 (no abrir `index.html` con doble clic: el navegador bloquea la carga de los JSON).

## Estructura

- `detalle.html`, `css/`, `js/`: la página (el gráfico 2D) (Apache ECharts 5.6.0 desde CDN; `js/model.js` es la lógica pura, `js/app.js` la interfaz).
- `data/2025/overview.json` y `data/2025/gasto/inciso_*.json`: árboles generados por el ETL.
- `etl.py`: convierte los CSV oficiales (`;`, cp1252) en esos JSON.
  `python etl.py --raw data/raw --out data --pretty`.
- `datos_fuente/`: datos curados a mano que no están en los CSV oficiales (hoy, el Poder Legislativo).

## Cargos (puestos de trabajo)

Si en `data/raw` hay un archivo `*Puestos_de_trabajo_2025*.csv`, `etl.py` lo integra al gasto:

- Une por inciso, unidad ejecutora y programa (las 177 combinaciones del archivo existen en el gasto).
- Dentro de `Remuneraciones` de cada programa agrega dos partes: **Sueldos nominales de los cargos (estimado)** (importe mensual de cada cargo, ocupado o vacante, por 14) y **Resto de remuneraciones**. La primera se abre por tipo de contrato y escalafón. El detalle original por objeto del gasto queda en `objetos`.
- Cada escalafón se explica en español simple (glosario "¿Qué es cada escalafón?" y descripción en su vista). Las letras A–F y J–R vienen de la Ley 15.809; S, CO2, CO3, PC1 y "Sin escalafón" se dedujeron de los datos y están marcadas. Cada nivel muestra cargos ocupados y vacantes, sueldo nominal mensual y promedio por cargo; los escalafones traen además el detalle por denominación del cargo (`denominaciones`).
- Cobertura: solo Presidencia, ministerios y Ambiente (incisos 2 a 15 y 36). No incluye ANEP, ASSE, Universidad de la República, Poder Judicial, Fiscalía ni otros organismos.
- Los datos no detallan compensaciones adicionales ni incentivos, y no incluyen aportes patronales. La fuente de financiamiento de la parte estimada se reparte en proporción: es un supuesto.
- El ETL verifica que todo siga sumando al peso y que el estimado nunca supere al gasto real en remuneraciones.

## Parlamento (Poder Legislativo, inciso 1)

El inciso 1 no figura en los CSV oficiales de gasto (tampoco el 28, BPS, ni el 30). El ETL agrega el Poder Legislativo como un grupo aparte, **Parlamento**, desde `datos_fuente/legislativo_2025.csv` (77 filas, cada una con el documento de origen en la columna `fuente`; ver `datos_fuente/LEEME_legislativo_2025.md`).

- Jerarquía: Parlamento > Poder Legislativo (inciso 1) > unidad ejecutora (001 Senado, 002 Representantes, 003 Comisión Administrativa, que incluye la INDDHH como programa 228) > programa > tipo de gasto > concepto.
- El valor de cada nodo es el **crédito definitivo al 31/12/2025**; el resto del gasto es crédito vigente a mayo de 2025. La diferencia de fecha de corte se avisa en la página.
- Los nodos del Parlamento traen además `ejecutado` (lo gastado en 2025), que se ve en tarjetas, tablas y tooltips. Solo el Parlamento trae ejecución, así que no es comparable con otros organismos.
- Todo el gasto del Parlamento sale de Rentas Generales (fuente 11, la "Plata sin destino fijo" de la página), confirmado por la autora del proyecto.
- Los recursos no cambian: el gasto total pasa de 926,3 a 936,5 mil millones $U y la diferencia, de −66,6 a −76,8.
- Sin datos de cargos (el archivo de puestos no lo cubre): se usa el aviso de "sin cargos".
- El ETL se detiene si el CSV deja de cerrar con los totales de control por unidad ejecutora (tomados de cada PDF), si algún nodo ejecuta más que su crédito o si los hijos no suman al padre.

## Legisladores (nóminas y sueldos)

Los nodos de la Cámara de Senadores (`gasto/p/1/001`) y de la Cámara de Representantes (`gasto/p/1/002`) traen un bloque `legisladores` con la nómina pública, los integrantes por partido y los sueldos nominales. Salen de `datos_fuente/`:

- Se usan como si fueran de 2025 (decisión del proyecto: la diferencia es chica); las fechas reales están en cada fila de los CSV y en "Sobre los datos".
- `legisladores.csv`: 31 integrantes del Senado (vicepresidenta y 30 senadores; 6 son suplentes de senadores que pasaron a ministros) según la consulta de Integración histórica del Parlamento del 28/08/2025, y 99 representantes según la nómina de la Cámara al 13/11/2026 (incluye suplentes en ejercicio). Cada Cámara tiene su propia fecha.
- `remuneraciones_legisladores.csv`: sueldo nominal y gastos de representación por mes. Senado: planilla vigente desde enero de 2026 (senador $399.346 en total; vicepresidencia $797.987). Representantes: mismas cifras, pero el archivo no indica la vigencia.
- `partidas_senado.csv`: partidas con cargo al rubro de gastos (secretarios parlamentarios, telefonía).
- `senado_escala_funcionarios.csv`: escala de sueldos básicos de los funcionarios del Senado (1/8/2026), que se muestra en el programa 222. Es una escala por cargo, sin cantidad de personas.
- El "sueldo anual de los legisladores" es un cálculo (personas x total nominal x 14) y no es comparable con el crédito de sueldos del presupuesto: no incluye aportes patronales ni partidas para secretarios.
- El ETL se detiene si el número de integrantes o las bancas por partido no coinciden con los controles, o si falta algún sueldo.

## Prototipo 3D (`3d.html`)

Vista experimental que dibuja el mismo flujo del Sankey general (recursos → fondos → gasto) como billetes y monedas en 3D (unos 2.600 en computadora, 1.100 en celular, con `InstancedMesh`) que avanzan girando sobre fondo negro, con three.js 0.160 (desde CDN). No cambia ningún dato: usa `FinanzasModel.specGeneral` de `js/model.js`, así que los nodos, flujos y nombres son los mismos que en el gráfico clásico.

**Navegable.** La vista 3D tiene el mismo drill-down que el gráfico clásico, con las mismas rutas por hash (`3d.html#gasto/a/4`, `3d.html#recursos/ingresos-tributarios`): clic en un bloque con › entra, las migas de arriba (o la tecla Esc) suben un nivel, y cada nivel usa `FinanzasModel.resolver` + `specNodo`, así que los datos son idénticos. Los incisos se cargan de `data/2025/gasto/` cuando se entra.

**Todo desplegado (`index.html`).** Dibuja a la vez todo el árbol, de cada ingreso hasta el último rubro de gasto (unos 26.000 bloques y enlaces, 12 columnas), y se recorre solo con zoom y arrastre: el doble clic en un bloque o cinta abre la vista por niveles. Los billetes recorren el camino completo: nacen en un ingreso (en proporción a su monto), pasan por su fondo y bajan por el gasto que ese fondo financia, eligiendo en cada paso en proporción al monto del fondo. Los nombres aparecen según el zoom (solo los de bloques que se ven lo bastante grandes) y al pasar el cursor por un bloque se ve su monto y dentro de qué está. Para que los bloques más chicos se puedan ver al acercarse, ningún bloque mide menos de una altura mínima (`MINH`): las franjas conservan el ancho proporcional al monto, pero un bloque muy chico es más alto que su monto. Carga `overview.json` y los 34 archivos de `data/2025/gasto/` (unos 4,6 MB).

**Moverse por la imagen.** Rueda o pellizco = zoom hacia donde apuntás; arrastrar (mouse o dedo) o flechas/WASD = desplazarte hacia arriba, abajo, izquierda o derecha; botones +, − y ⌖ (o tecla 0, o doble clic) = acercar, alejar y volver al centro. El clic en un bloque sigue entrando a su detalle, también con zoom.

**Densidad y velocidad según el monto.** Para cada flujo: `peso = (monto / monto del flujo mayor de la vista) ^ GAMMA` (GAMMA = 0,55 en `flujo3d.js`). La cantidad de billetes es proporcional a `peso × superficie de la franja` y la velocidad va de `VEL_MIN` a `VEL_MAX` según el peso. Con GAMMA = 1 sería estrictamente proporcional, pero lo chico quedaría casi invisible y congelado. La escala es relativa a cada vista, no al total del Estado.

- `js/flujo3d.js`, `css/flujo3d.css`, `3d.html`.
- Mover el mouse (o arrastrar) cambia el ángulo; la rueda acerca; al pasar por un bloque se realzan sus flujos y aparece su tooltip; el clic lleva al detalle en el gráfico clásico (`detalle.html#<id>`).
- Respeta `prefers-reduced-motion` (casi sin movimiento) y avisa si el navegador no tiene WebGL. En pantallas verticales las columnas se acercan y las etiquetas van hacia adentro.
- Es un prototipo: la lectura precisa de montos sigue siendo el gráfico clásico y las tablas.

### Ciudadanos en la vista "todo desplegado"

A la izquierda de `index.html` hay una familia dibujada en línea azul (`js/ciudadanos.js`) cuyos billetes salen directo de los bolsillos y vuelan hacia los ingresos, para mostrar que la plata sale de la gente.


### Cómo se conectan las vistas (v10)

- **`index.html` (portada): 3D todo desplegado.** Doble clic (o doble toque) en un bloque o en una cinta abre `3d.html#<id>` (vista por niveles, ya parada en ese bloque; en una cinta, el bloque al que llega). Doble clic en el vacío vuelve a ver todo. Los fondos y ajustes no tienen vista propia: ahí la cámara se acerca.
- **`3d.html`: vista por niveles.** Tiene "← Vista completa" (vuelve a la portada) y siempre el botón "Explorar más detalles de estos datos en 2D →", que abre `detalle.html#<id>` en ese mismo bloque.
- **`detalle.html`: gráfico 2D** con el detalle fino. Tiene "← Volver a la vista 3D completa".
- Los links viejos `index.html#gasto/...` o `#recursos/...` redirigen a `detalle.html` con el mismo hash.


### Celulares (v11)

El 3D es solo para computadoras, tablets e iPads. En un celular (el lado corto de la pantalla mide menos de 600 px) `index.html` y `3d.html` redirigen solos a `detalle.html` (la vista 2D), que se lee mejor en pantalla chica y gasta menos batería. La detección está en `js/dispositivo.js`. En la vista 2D de un celular, un toque en un bloque sin salida muestra un cartelito en lugar del doble clic.

## Licencia

© 2026 Uruguay Papers. Todos los derechos reservados: el código y el diseño no se pueden copiar ni reutilizar sin permiso por escrito (ver `LICENSE`). Los datos de origen son abiertos (MEF y Contaduría General de la Nación) y se rigen por los términos de esas fuentes.

## Compras adjudicadas (v12, piloto)

`etl_compras.py` cuelga las compras del catálogo de compras estatales (ARCE, `compras_2025.db`) a la derecha de los rubros del gasto: **rubro → artículo comprado → proveedor → compra individual**. Se corre después de `etl.py`:

    python etl_compras.py --db ruta/a/compras_2025.db

- `datos_fuente/compras_unidades.csv`: unidad compradora de la base → inciso / unidad ejecutora (la base no trae códigos, solo nombres). Piloto: Secretaría del Ministerio del Interior.
- `datos_fuente/compras_reglas.csv`: regla artículo comprado → rubro del presupuesto (curada a mano; la base no trae el rubro).
- Las compras sin monto en el catálogo se listan aparte en cada rubro («Compras adjudicadas sin monto informado»), con enlace al portal.
- Adjudicar es decidir comprar; el pago puede llegar después. Lo adjudicado por encima del crédito de un rubro se muestra hasta el tope; lo que no figura en el catálogo queda en «Resto sin detalle de compra». Los renglones sin monto (≈26% en el piloto) no se incluyen.

## Compras en todo el presupuesto (v13)

`datos_fuente/compras_unidades.csv` ahora cubre las 237 unidades compradoras de la base que corresponden a una unidad ejecutora del presupuesto (revisadas a mano las que no calzan por nombre). `datos_fuente/compras_reglas.csv` es la tabla de reglas artículo → rubro (cada regla lista rubros candidatos: se usa el primero que exista en la unidad ejecutora).

- Los montos son los **reales** de la adjudicación; no se recortan. Si lo adjudicado supera lo autorizado en el rubro (contratos de varios años, otros rubros que pagan), el rubro queda marcado `compras.excede`.
- Las compras no viven en el JSON del inciso: están en `data/2025/compras/<inciso>_<ue>.json` y se cargan al entrar a un rubro (`compras_ref`).
- Quedan fuera las entidades que no están en el presupuesto nacional (UTE, OSE, ANCAP, intendencias, bancos…) y las compras sin rubro asignable.

### Ubicación aproximada de compras (v13)
Si una compra no calza con un rubro específico de su unidad ejecutora, `etl_compras.py` la ubica en el rubro "otros" de su familia
(199-0 consumo, 299-0 servicios, 399-0 bienes de uso). Esas compras llevan `aprox: true`, se marcan con "≈" en el gráfico y
con una nota en tooltip y tarjetas. Si la unidad tampoco tiene ese rubro, la compra va a la tabla "Compras que no pudimos ubicar
en un rubro" de la unidad (`__ue__` en `data/2025/compras/<inciso>_<ue>.json`). Cobertura: ~96% de lo adjudicado queda en el gráfico.
