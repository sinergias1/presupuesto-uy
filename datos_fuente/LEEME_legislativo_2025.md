# Poder Legislativo (inciso 1) — datos 2025

> En este repositorio solo está `legislativo_2025.csv` (lo usa `etl.py`). Los demás archivos que menciona esta nota (ejecución del Senado por objeto, cargos, misiones, nómina, escala de la INDDHH) quedaron fuera del repositorio. Códigos de unidad ejecutora: 001 Senado, 002 Representantes (confirmado por el equipo del proyecto), 003 Comisión Administrativa. Nombres de programa 221 a 223 (Senado) y 0 (Representantes): descriptivos, tomados de los encabezados de cada documento.

## Qué hay en esta carpeta
| Archivo | Contenido |
|---|---|
| `legislativo_2025_ejecucion.csv` | 77 filas: crédito definitivo y ejecutado 2025 por cámara, programa, tipo de gasto y concepto |
| `legislativo_2025_resumen.csv` | Lo mismo, sumado por cámara y tipo de gasto (Remuneraciones / Funcionamiento / Inversiones) |
| `senado_2025_ejecucion_por_objeto.csv` | Ejecución del Senado por objeto del gasto (75 filas, cierra con el total) |
| `cargos_remuneraciones_diputados.csv` | 48 cargos: escalafón, plazas, ocupados, vacantes y sueldos mensuales |
| `misiones_exterior_2025.csv` | 156 viajes al exterior que empezaron en 2025 (US$) |
| `misiones_exterior_2025_2026_todas.csv` | Todas las filas leídas, incluidas las de 2026 |
| `representantes_nomina.csv` | Los 99 representantes con partido y departamento |
| `inddhh_escala_remuneraciones.csv` | Escala de sueldos nominales de la INDDHH (10 niveles) |

## Totales 2025 (pesos uruguayos)
| Unidad ejecutora | Crédito definitivo | Ejecutado |
|---|---:|---:|
| Cámara de Senadores | 2.087.350.032 | 1.612.142.864 |
| Cámara de Representantes | 3.586.367.767 | 2.781.300.519 |
| Comisión Administrativa (programas 226, 227 y 228 INDDHH) | 4.546.693.909 | 2.847.665.451 |
| **Poder Legislativo** | **10.220.411.708** | **7.241.108.834** |

## Cómo se controló
- Senado: la suma de las filas coincide con el total del Anexo 1 (crédito y ejecutado) y la suma por objeto coincide con el total del Anexo 7.
- Representantes: la suma coincide con los totales del Estado integral de gestión.
- Comisión Administrativa: el PDF es un escaneo. Las planillas se transcribieron a mano de las imágenes y la suma coincide con la "Planilla resumen" del propio PDF (programa 226: 4.187.105.724 / 2.544.935.867; programa 227: 58.950.281 / 13.076.359).
- INDDHH: las remuneraciones de la tabla suman exactamente el total del informe (crédito 202.272.545 / ejecutado 196.731.038).
- Nómina de representantes: 99 filas y la cantidad por partido coincide con el PDF (FA 48, PN 29, PC 17, CA 2, IS 2, PI 1).

## Cosas a tener en cuenta
1. **Fecha de corte distinta.** Estos créditos son los definitivos al 31/12/2025. El crédito vigente del resto del presupuesto en tus archivos llega hasta mayo de 2025. Para sumarlos al gráfico hay que avisarlo.
2. **Palabras distintas para "ejecutado".** Senado: imputaciones. Representantes: egresos presupuestales. Comisión Administrativa: afectaciones. Son equivalentes en espíritu, pero no idénticas.
3. **La Comisión Administrativa incluye $612 millones de inversiones "por única vez"**, casi todo el proyecto 747 (100 años del Palacio Legislativo). Eso explica su peso en Inversiones.
4. **INDDHH (programa 228):** forma parte de la unidad ejecutora Comisión Administrativa (lo dice la Nota 1 de sus estados financieros). Sus cifras salen del Informe anual 2025 de la propia INDDHH (Anexo 4), no de una rendición de cuentas. Allí "Búsqueda de detenidos desaparecidos" ($63,3 millones) y "Fondos concursables para sitios de memoria" ($2,1 millones) figuran aparte; los clasifiqué como Funcionamiento. La INDDHH informa 5 miembros del Consejo Directivo, 51 cargos presupuestados y 8 pasantes. La escala de sueldos viene de una página de gub.uy fechada 27/02/2023: puede estar desactualizada.
5. **Presupuestos 2026-2030 (Senado y Comisión Administrativa):** son para 2026 en adelante, a valores de enero de 2025/2026. No se usaron para las cifras de 2025.
6. **Nómina de representantes:** está a la fecha 13/11/2026, no a 2025. Hay suplentes en ejercicio.
7. **Cargos de Representantes:** el archivo no dice la cámara ni la fecha de los sueldos. Lo asigné a Representantes porque trae el cargo "Representante Nacional" con 99 plazas. Hay 442 plazas (399 ocupadas). Sueldo básico + dedicación especial + gastos de representación de los ocupados ≈ $93,1 millones por mes, ≈ $1.303 millones por 14 pagos: es una estimación, no incluye primas ni aportes patronales.
8. **Misiones:** "2025" significa que la misión empezó en 2025. Las filas son por persona, no por misión. Los montos son en US$.
9. **No se usó** el organigrama (PDF).
