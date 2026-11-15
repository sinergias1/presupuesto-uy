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

- `index.html`, `css/`, `js/`: la página (Apache ECharts 5.6.0 desde CDN; `js/model.js` es la lógica pura, `js/app.js` la interfaz).
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
- Todo el gasto del Parlamento sale de Rentas Generales (fuente 11, la "Plata de libre uso" de la página), confirmado por la autora del proyecto.
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

Vista experimental que dibuja el mismo flujo del Sankey general (recursos → fondos → gasto) como miles de partículas de luz sobre fondo negro, con three.js 0.160 (desde CDN). No cambia ningún dato: usa `FinanzasModel.specGeneral` de `js/model.js`, así que los nodos, flujos y nombres son los mismos que en el gráfico clásico.

- `js/flujo3d.js`, `css/flujo3d.css`, `3d.html`.
- Mover el mouse (o arrastrar) cambia el ángulo; la rueda acerca; al pasar por un bloque se realzan sus flujos y aparece su tooltip; el clic lleva al detalle en el gráfico clásico (`index.html#<id>`).
- Respeta `prefers-reduced-motion` (casi sin movimiento) y avisa si el navegador no tiene WebGL. En pantallas verticales las columnas se acercan y las etiquetas van hacia adentro.
- Es un prototipo: la lectura precisa de montos sigue siendo el gráfico clásico y las tablas.
