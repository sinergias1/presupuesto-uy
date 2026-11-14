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
