# ¿De dónde sale la torta y cómo se reparte?

Visualizador de Finanzas Estatales de Uruguay

Diagrama de Sankey interactivo del Presupuesto Nacional 2025 (recursos → fuentes de financiamiento → gasto por inciso), con navegación de mayor a menor y migas de pan.

Datos: paquetes de datos abiertos del MEF y la Contaduría General de la Nación (crédito vigente al 31/05/2025 y recursos proyectados 2025).

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

## Cargos (puestos de trabajo)

Si en `data/raw` hay un archivo `*Puestos_de_trabajo_2025*.csv`, `etl.py` lo integra al gasto:

- Une por inciso, unidad ejecutora y programa (las 177 combinaciones del archivo existen en el gasto).
- Dentro de `Remuneraciones` de cada programa agrega dos partes: **Sueldos nominales de los cargos (estimado)** (importe mensual de cada cargo, ocupado o vacante, por 14) y **Resto de remuneraciones**. La primera se abre por tipo de contrato y escalafón. El detalle original por objeto del gasto queda en `objetos`.
- Cada escalafón se explica en español simple (glosario "¿Qué es cada escalafón?" y descripción en su vista). Las letras A–F y J–R vienen de la Ley 15.809; S, CO2, CO3, PC1 y "Sin escalafón" se dedujeron de los datos y están marcadas. Cada nivel muestra cargos ocupados y vacantes, sueldo nominal mensual y promedio por cargo; los escalafones traen además el detalle por denominación del cargo (`denominaciones`).
- Cobertura: solo Presidencia, ministerios y Ambiente (incisos 2 a 15 y 36). No incluye ANEP, ASSE, Universidad de la República, Poder Judicial, Fiscalía ni otros organismos.
- Los datos no detallan compensaciones adicionales ni incentivos, y no incluyen aportes patronales. La fuente de financiamiento de la parte estimada se reparte en proporción: es un supuesto.
- El ETL verifica que todo siga sumando al peso y que el estimado nunca supere al gasto real en remuneraciones.
