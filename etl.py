#!/usr/bin/env python3
"""
ETL del Visualizador de Finanzas Estatales de Uruguay - prototipo 2025.

Lee los paquetes de datos abiertos del MEF / Contaduría General de la Nación y
genera JSON en árbol listos para un Sankey con drill-down en una web estática.

Entradas (CSV separados por ';', codificación cp1252):
  - Recursos_2025-2029_VF.csv           -> se usa MONTO_MON_NAC_AÑO_0 (proyección 2025)
  - Crédito_vigente_2025_Gastos_VF.csv  -> crédito vigente al 31/05/2025

Salidas (en <out>/2025/):
  - overview.json            meta + totales + puente recursos<->gasto + árbol de
                             recursos completo + árbol de gasto hasta nivel Inciso
  - gasto/inciso_<cod>.json  subárbol completo de cada Inciso (carga bajo demanda)

Jerarquías (cada nivel ordenado de mayor a menor monto):
  recursos: Capítulo > Clase > Recurso
  gasto:    Clasificación de inciso > Inciso > Unidad ejecutora > Programa
            > Tipo de gasto > Objeto del gasto (con auxiliar)

Todos los montos son pesos uruguayos corrientes, como enteros.

Uso:
  python etl.py --raw data/raw --out web/data [--pretty]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

ANIO = 2025
VERSION_ESQUEMA = 1

# Patrones tolerantes: aceptan el nombre oficial ("2. Crédito_vigente...") y
# variantes donde el acento fue reemplazado o hay un prefijo agregado al subir.
PATRONES = {
    "recursos": "*Recursos_2025-2029*.csv",
    "gasto": "*dito_vigente_2025*.csv",
}

# Fuentes de financiamiento descritas en la hoja de metadata. Los códigos 13 y 51
# aparecen en Recursos pero la metadata no los describe: no se les inventa nombre.
FUENTES_DESCRITAS = {
    "11": "Rentas Generales",
    "12": "Recursos con Afectación Especial",
    "15": "Fondo Nacional de Vivienda",
    "21": "Endeudamiento Externo (proyectos específicos)",
}

TIPO_CODIGO = {"Remuneraciones": "R", "Funcionamiento": "F", "Inversiones": "I"}

COLS_RECURSOS = {
    "REC_CAPITULO_DESCRIPCION": "capitulo",
    "REC_CLASE_DESCRIPCION": "clase",
    "RECURSO": "recurso",
    "DESC_RECURSO": "recurso_nombre",
    "FINANCIAMIENTO": "fuente",
    "DESC_DESTINO": "destino",
    "MONTO_MON_NAC_AÑO_0": "monto",
}

COLS_GASTO = {
    "DOM_CLAS_INCISOS_VALOR": "clas",
    "CLASIFICACION_INCISO": "clas_nombre",
    "INSTITUCION": "inciso",
    "INST_DESC": "inciso_nombre",
    "UNIDAD_EJECUTORA": "ue",
    "UE_DESC": "ue_nombre",
    "PROGRAMA": "prog",
    "PROG_DESC": "prog_nombre",
    "Tipo de Gasto": "tipo",
    "OBJETO_DEL_GASTO": "obj",
    "AUXILIAR": "aux",
    "OBJGAS_DENOMINACION": "obj_nombre",
    "FINANCIAMIENTO": "fuente",
    "MONTO_MON_NAC_VIGENTE": "monto",
}

# Niveles del árbol de gasto que llevan el desglose por tipo de gasto
# (clasificación=1, inciso=2, unidad ejecutora=3, programa=4).
NIVEL_MAX_TIPOS = 4

_RE_PLANO = r"-?\d+"
_RE_MILES = r"-?\d{1,3}(\.\d{3})+"


def exigir(condicion: bool, mensaje: str) -> None:
    if not condicion:
        raise SystemExit(f"ERROR de validación: {mensaje}")


# --------------------------------------------------------------------------- #
# Lectura y limpieza
# --------------------------------------------------------------------------- #
def localizar(raw: Path, patron: str) -> Path:
    hallados = sorted(raw.glob(patron))
    exigir(
        len(hallados) == 1,
        f"se esperaba 1 archivo para '{patron}' en {raw}, se encontraron {len(hallados)}",
    )
    return hallados[0]


def parsear_montos(serie: pd.Series, nombre: str) -> pd.Series:
    """Convierte montos a entero. Acepta '123456', '62.691.770 ' (punto de miles) y
    ' - ' (cero). Cualquier otro formato detiene el proceso en vez de adivinar."""
    txt = serie.str.strip()
    exigir(not txt.isna().any(), f"{nombre}: hay montos vacíos")
    n_guion = int((txt == "-").sum())
    txt = txt.mask(txt == "-", "0")
    plano = txt.str.fullmatch(_RE_PLANO)
    miles = txt.str.fullmatch(_RE_MILES)
    invalido = ~(plano | miles)
    exigir(
        not invalido.any(),
        f"{nombre}: {int(invalido.sum())} montos con formato desconocido, "
        f"p. ej. {txt[invalido].head(5).tolist()}",
    )
    print(
        f"  {nombre}: {int(plano.sum()) - n_guion} montos planos, "
        f"{int(miles.sum())} con punto de miles, {n_guion} en blanco ('-') = 0"
    )
    entero = pd.to_numeric(txt.str.replace(".", "", regex=False), errors="raise")
    return entero.astype("int64")


def leer(path: Path, columnas: dict[str, str], nombre: str) -> pd.DataFrame:
    df = pd.read_csv(
        path, sep=";", encoding="cp1252", dtype=str, index_col=0, low_memory=False
    )
    df.columns = df.columns.str.strip()
    faltan = [c for c in columnas if c not in df.columns]
    exigir(not faltan, f"{nombre}: faltan columnas {faltan}")
    df = df[list(columnas)].rename(columns=columnas)
    for c in df.columns:
        df[c] = df[c].str.strip().str.replace(r"\s+", " ", regex=True)
    exigir(not df.isna().any().any(), f"{nombre}: hay celdas vacías en columnas usadas")
    df["monto"] = parsear_montos(df["monto"], nombre)
    exigir(
        bool((df["monto"] >= 0).all()),
        f"{nombre}: hay {int((df['monto'] < 0).sum())} montos negativos; "
        "un Sankey no puede dibujarlos, revisar antes de seguir",
    )
    n_cero = int((df["monto"] == 0).sum())
    df = df[df["monto"] != 0].reset_index(drop=True)
    print(f"  {nombre}: {len(df):,} filas con monto > 0 ({n_cero:,} filas en cero descartadas)")
    return df


# --------------------------------------------------------------------------- #
# Construcción de árboles
# --------------------------------------------------------------------------- #
def slug(texto: str) -> str:
    ascii_ = unicodedata.normalize("NFKD", str(texto)).encode("ascii", "ignore").decode()
    return re.sub(r"[^A-Za-z0-9_-]+", "-", ascii_).strip("-").lower()


def nuevo_nodo(id_: str, nombre: str, codigo: str) -> dict:
    return {
        "id": id_,
        "nombre": nombre,
        "codigo": codigo,
        "valor": 0,
        "fuentes": defaultdict(int),
        "tipos": defaultdict(int),
        "_hijos": {},
    }


def acumular(raiz: dict, ruta: list[tuple[str, str]], fuente: str, tipo: str | None, valor: int) -> None:
    """Suma `valor` en la raíz y en cada nodo de la ruta, creándolos si hace falta."""
    raiz["valor"] += valor
    raiz["fuentes"][fuente] += valor
    if tipo is not None and NIVEL_MAX_TIPOS >= 0:
        raiz["tipos"][tipo] += valor
    nodo = raiz
    for profundidad, (codigo, nombre) in enumerate(ruta, start=1):
        hijo = nodo["_hijos"].get(codigo)
        if hijo is None:
            hijo = nuevo_nodo(f"{nodo['id']}/{slug(codigo)}", nombre, codigo)
            nodo["_hijos"][codigo] = hijo
        else:
            exigir(
                hijo["nombre"] == nombre,
                f"el código '{codigo}' tiene dos nombres bajo {nodo['id']}: "
                f"'{hijo['nombre']}' y '{nombre}'",
            )
        hijo["valor"] += valor
        hijo["fuentes"][fuente] += valor
        if tipo is not None and profundidad <= NIVEL_MAX_TIPOS:
            hijo["tipos"][tipo] += valor
        nodo = hijo


def finalizar(nodo: dict) -> dict:
    """Pasa a la forma de salida: hijos en lista, ordenados de mayor a menor."""
    salida = {
        "id": nodo["id"],
        "nombre": nodo["nombre"],
        "codigo": nodo["codigo"],
        "valor": int(nodo["valor"]),
        "fuentes": {
            k: int(v)
            for k, v in sorted(nodo["fuentes"].items(), key=lambda kv: (-kv[1], kv[0]))
            if v
        },
    }
    if nodo["tipos"]:
        salida["tipos"] = {
            k: int(v)
            for k, v in sorted(nodo["tipos"].items(), key=lambda kv: (-kv[1], kv[0]))
            if v
        }
    hijos = sorted(nodo["_hijos"].values(), key=lambda h: (-h["valor"], h["nombre"]))
    if hijos:
        salida["hijos"] = [finalizar(h) for h in hijos]
    return salida


def construir_recursos(rec: pd.DataFrame) -> dict:
    agg = rec.groupby(
        ["capitulo", "clase", "recurso", "recurso_nombre", "fuente"], sort=False
    )["monto"].sum().reset_index()
    raiz = nuevo_nodo("recursos", f"Recursos {ANIO}", "recursos")
    for r in agg.itertuples(index=False):
        ruta = [(r.capitulo, r.capitulo), (r.clase, r.clase), (r.recurso, r.recurso_nombre)]
        acumular(raiz, ruta, r.fuente, None, int(r.monto))
    return finalizar(raiz)


def construir_gasto(gas: pd.DataFrame) -> dict:
    exigir(
        set(gas["tipo"]) <= set(TIPO_CODIGO),
        f"tipos de gasto desconocidos: {sorted(set(gas['tipo']) - set(TIPO_CODIGO))}",
    )
    claves = [c for c in gas.columns if c != "monto"]
    agg = gas.groupby(claves, sort=False)["monto"].sum().reset_index()
    raiz = nuevo_nodo("gasto", f"Gasto público {ANIO}", "gasto")
    for r in agg.itertuples(index=False):
        ruta = [
            (r.clas, r.clas_nombre),
            (r.inciso, r.inciso_nombre),
            (r.ue, r.ue_nombre),
            (r.prog, r.prog_nombre),
            (TIPO_CODIGO[r.tipo], r.tipo),
            (f"{r.obj}-{r.aux}", r.obj_nombre),
        ]
        acumular(raiz, ruta, r.fuente, r.tipo, int(r.monto))
    return finalizar(raiz)


# --------------------------------------------------------------------------- #
# Puente recursos <-> gasto (por fuente de financiamiento)
# --------------------------------------------------------------------------- #
def construir_puente(rec: pd.DataFrame, gas: pd.DataFrame, arbol_rec: dict, arbol_gas: dict) -> dict:
    r_f = rec.groupby("fuente")["monto"].sum()
    g_f = gas.groupby("fuente")["monto"].sum()
    codigos = sorted(
        set(r_f.index) | set(g_f.index),
        key=lambda c: (-max(int(r_f.get(c, 0)), int(g_f.get(c, 0))), c),
    )
    destinos = rec.groupby(["fuente", "destino"])["monto"].sum()

    fuentes, ajustes = [], []
    for c in codigos:
        r, g = int(r_f.get(c, 0)), int(g_f.get(c, 0))
        d = destinos.get(c, pd.Series(dtype="int64"))
        fuentes.append({
            "codigo": c,
            "nombre": FUENTES_DESCRITAS.get(c, f"Fuente {c} (sin descripción en la metadata)"),
            "descrita_en_metadata": c in FUENTES_DESCRITAS,
            "recursos": r,
            "gasto": g,
            "saldo": r - g,
            "destinos_recursos": {
                k: int(v) for k, v in sorted(d.items(), key=lambda kv: -kv[1]) if v
            },
        })
        if g > r:
            ajustes.append({"fuente": c, "tipo": "gasto_sin_recurso_asignado", "valor": g - r})
        elif r > g:
            ajustes.append({"fuente": c, "tipo": "recurso_sin_gasto_asignado", "valor": r - g})

    id_cap = {h["nombre"]: h["id"] for h in arbol_rec["hijos"]}
    id_clas = {h["nombre"]: h["id"] for h in arbol_gas["hijos"]}
    f_rec = rec.groupby(["capitulo", "fuente"])["monto"].sum().reset_index()
    f_gas = gas.groupby(["fuente", "clas_nombre"])["monto"].sum().reset_index()

    return {
        "fuentes": fuentes,
        "flujos_recursos": sorted(
            (
                {"origen": r.capitulo, "origen_id": id_cap[r.capitulo], "fuente": r.fuente, "valor": int(r.monto)}
                for r in f_rec.itertuples(index=False)
            ),
            key=lambda x: -x["valor"],
        ),
        "flujos_gasto": sorted(
            (
                {"fuente": r.fuente, "destino": r.clas_nombre, "destino_id": id_clas[r.clas_nombre], "valor": int(r.monto)}
                for r in f_gas.itertuples(index=False)
            ),
            key=lambda x: -x["valor"],
        ),
        "ajustes": sorted(ajustes, key=lambda x: -x["valor"]),
    }


# --------------------------------------------------------------------------- #
# Validación
# --------------------------------------------------------------------------- #
def validar_arbol(nodo: dict, ids: set[str]) -> None:
    exigir(nodo["id"] not in ids, f"id duplicado: {nodo['id']}")
    ids.add(nodo["id"])
    exigir(
        sum(nodo["fuentes"].values()) == nodo["valor"],
        f"las fuentes no suman al valor en {nodo['id']}",
    )
    hijos = nodo.get("hijos")
    if hijos:
        exigir(
            sum(h["valor"] for h in hijos) == nodo["valor"],
            f"los hijos no suman al padre en {nodo['id']}",
        )
        exigir(
            all(hijos[i]["valor"] >= hijos[i + 1]["valor"] for i in range(len(hijos) - 1)),
            f"hijos fuera de orden (mayor a menor) en {nodo['id']}",
        )
        for h in hijos:
            validar_arbol(h, ids)


def contar_hojas(nodo: dict) -> int:
    return sum(contar_hojas(h) for h in nodo["hijos"]) if nodo.get("hijos") else 1


# --------------------------------------------------------------------------- #
# Escritura
# --------------------------------------------------------------------------- #
def escribir_json(obj: dict, ruta: Path, pretty: bool) -> None:
    ruta.parent.mkdir(parents=True, exist_ok=True)
    with ruta.open("w", encoding="utf-8") as f:
        if pretty:
            json.dump(obj, f, ensure_ascii=False, indent=1)
        else:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def partir_gasto(arbol_gas: dict, carpeta: Path, pretty: bool) -> dict:
    """Devuelve el árbol de gasto recortado a nivel Inciso y escribe un archivo por
    Inciso con su subárbol completo."""
    carpeta.mkdir(parents=True, exist_ok=True)
    for viejo in carpeta.glob("inciso_*.json"):
        viejo.unlink()

    recortado = {k: v for k, v in arbol_gas.items() if k != "hijos"}
    recortado["hijos"] = []
    for clas in arbol_gas["hijos"]:
        c = {k: v for k, v in clas.items() if k != "hijos"}
        c["hijos"] = []
        for inc in clas["hijos"]:
            archivo = f"gasto/inciso_{slug(inc['codigo'])}.json"
            escribir_json(
                {
                    "anio": ANIO,
                    "version_esquema": VERSION_ESQUEMA,
                    "ruta": [
                        {"id": arbol_gas["id"], "nombre": arbol_gas["nombre"]},
                        {"id": clas["id"], "nombre": clas["nombre"]},
                    ],
                    "nodo": inc,
                },
                carpeta.parent / archivo,
                pretty,
            )
            i = {k: v for k, v in inc.items() if k != "hijos"}
            i["archivo"] = archivo
            i["n_hijos"] = len(inc["hijos"])
            c["hijos"].append(i)
        recortado["hijos"].append(c)
    return recortado


def validar_salida(carpeta: Path, totales: dict) -> None:
    """Relee lo escrito en disco y verifica que cierre contra los totales."""
    ov = json.loads((carpeta / "overview.json").read_text(encoding="utf-8"))
    exigir(ov["recursos"]["valor"] == totales["recursos"], "overview: total de recursos no coincide")
    exigir(ov["gasto"]["valor"] == totales["gasto"], "overview: total de gasto no coincide")
    exigir(
        ov["totales"]["diferencia"] == totales["recursos"] - totales["gasto"],
        "overview: diferencia mal calculada",
    )
    suma_incisos = 0
    for clas in ov["gasto"]["hijos"]:
        exigir(
            sum(i["valor"] for i in clas["hijos"]) == clas["valor"],
            f"overview: incisos no suman a {clas['id']}",
        )
        for inc in clas["hijos"]:
            sub = json.loads((carpeta / inc["archivo"]).read_text(encoding="utf-8"))["nodo"]
            exigir(sub["id"] == inc["id"] and sub["valor"] == inc["valor"], f"archivo de {inc['id']} no coincide")
            validar_arbol(sub, set())
            suma_incisos += sub["valor"]
    exigir(suma_incisos == totales["gasto"], "la suma de los archivos por inciso no da el gasto total")
    validar_arbol(ov["recursos"], set())
    print("  OK: el árbol releído desde disco cierra contra los totales de los CSV")


def mm(x: int) -> str:
    return f"{x / 1e9:,.1f}"


# --------------------------------------------------------------------------- #
def main() -> None:
    ap = argparse.ArgumentParser(description="ETL Visualizador de Finanzas Estatales UY (2025)")
    ap.add_argument("--raw", type=Path, default=Path("data/raw"), help="carpeta con los CSV oficiales")
    ap.add_argument("--out", type=Path, default=Path("web/data"), help="carpeta de salida")
    ap.add_argument("--pretty", action="store_true", help="JSON con sangría (más pesado, legible)")
    args = ap.parse_args()

    print("Leyendo archivos…")
    rec = leer(localizar(args.raw, PATRONES["recursos"]), COLS_RECURSOS, "Recursos 2025 (AÑO_0)")
    gas = leer(localizar(args.raw, PATRONES["gasto"]), COLS_GASTO, "Crédito vigente 2025")

    exigir(
        (gas.groupby("inciso")["clas"].nunique() == 1).all(),
        "hay incisos con más de una clasificación",
    )

    print("Construyendo árboles…")
    arbol_rec = construir_recursos(rec)
    arbol_gas = construir_gasto(gas)
    total_rec, total_gas = int(rec["monto"].sum()), int(gas["monto"].sum())
    exigir(arbol_rec["valor"] == total_rec, "el árbol de recursos no suma el total del CSV")
    exigir(arbol_gas["valor"] == total_gas, "el árbol de gasto no suma el total del CSV")
    validar_arbol(arbol_rec, set())
    ids_gasto: set[str] = set()
    validar_arbol(arbol_gas, ids_gasto)

    puente = construir_puente(rec, gas, arbol_rec, arbol_gas)

    carpeta = args.out / str(ANIO)
    gasto_recortado = partir_gasto(arbol_gas, carpeta / "gasto", args.pretty)

    overview = {
        "meta": {
            "anio": ANIO,
            "version_esquema": VERSION_ESQUEMA,
            "generado_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "moneda": "UYU",
            "unidad": "pesos uruguayos corrientes (enteros, sin escalar)",
            "recursos": "Proyección 2025 (columna MONTO_MON_NAC_AÑO_0 de Recursos_2025-2029_VF.csv)",
            "gasto": "Crédito vigente al 31/05/2025 (Crédito_vigente_2025_Gastos_VF.csv)",
            "jerarquia_recursos": ["Capítulo", "Clase", "Recurso"],
            "jerarquia_gasto": [
                "Clasificación de inciso", "Inciso", "Unidad ejecutora",
                "Programa", "Tipo de gasto", "Objeto del gasto",
            ],
            "notas": [
                "El gasto es crédito vigente a mayo de 2025, no ejecución final.",
                "Los recursos 2025 son una proyección, no recaudación efectiva.",
                "El puente une recursos y gasto por fuente de financiamiento. Cada 'ajuste' es la "
                "diferencia entre ambos lados de una fuente; no equivale por sí solo a déficit.",
                "Los códigos de fuente 13 y 51 figuran en Recursos pero no están descritos en la metadata.",
                "Cada hoja del árbol de gasto suma todos los proyectos con la misma combinación "
                "de unidad ejecutora, programa, tipo de gasto, objeto y auxiliar.",
                "Los nodos 'tipos' y 'fuentes' desglosan el valor del nodo por tipo de gasto y por fuente.",
            ],
        },
        "totales": {"recursos": total_rec, "gasto": total_gas, "diferencia": total_rec - total_gas},
        "puente": puente,
        "recursos": arbol_rec,
        "gasto": gasto_recortado,
    }
    escribir_json(overview, carpeta / "overview.json", args.pretty)

    print("\nResumen")
    print(f"  Recursos {ANIO}: {mm(total_rec)} mil millones $U ({contar_hojas(arbol_rec):,} recursos)")
    print(f"  Gasto {ANIO}:    {mm(total_gas)} mil millones $U ({contar_hojas(arbol_gas):,} hojas, {len(ids_gasto):,} nodos)")
    print(f"  Diferencia:     {mm(total_rec - total_gas)} mil millones $U")
    print("  Puente por fuente (mil millones $U): código, recursos, gasto, saldo")
    for f in puente["fuentes"]:
        print(f"    {f['codigo']:>3}  {mm(f['recursos']):>8}  {mm(f['gasto']):>8}  {mm(f['saldo']):>8}  {f['nombre']}")
    print("\nArchivos")
    for p in sorted(carpeta.rglob("*.json")):
        print(f"  {p.relative_to(args.out)}  {p.stat().st_size / 1024:,.0f} KB")

    print("\nValidando salida…")
    validar_salida(carpeta, {"recursos": total_rec, "gasto": total_gas})


if __name__ == "__main__":
    sys.exit(main())
