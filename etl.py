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
    "puestos": "*Puestos_de_trabajo_2025*.csv",  # opcional
}

# Cargos (puestos de trabajo): el importe del archivo es mensual y nominal; se anualiza
# con este factor (12 meses + aguinaldo + salario vacacional, aproximado).
FACTOR_ANUAL = 14
NOMBRE_SUELDOS = "Sueldos nominales de los cargos (estimado)"
NOMBRE_RESTO = "Resto de remuneraciones"
NIVEL_PARTE = "Parte de las remuneraciones"
SIN_ESCALAFON = "Sin escalafón"


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

COLS_PUESTOS = {
    "INCISO": "inciso",
    "UNIDAD_EJECUTORA": "ue",
    "PROGRAMA": "prog",
    "DESC_REG": "regimen",
    "ESCALAFON": "escalafon",
    "DENOMINACION": "denominacion",
    "OCUPADO": "ocupado",
    "VACANTE": "vacante",
    "IMPORTE_TOT": "importe",
}

# Niveles del árbol de gasto que llevan el desglose por tipo de gasto
# (clasificación=1, inciso=2, unidad ejecutora=3, programa=4).
NIVEL_MAX_TIPOS = 4

# Poder Legislativo (inciso 1): no está en los CSV oficiales. Se agrega desde un CSV curado
# (datos_fuente/legislativo_2025.csv) como grupo aparte. Los montos son crédito definitivo
# al 31/12/2025 y vienen con su ejecución; todo sale de Rentas Generales (fuente 11, confirmado).
ARCHIVO_LEGISLATIVO = Path(__file__).resolve().parent / "datos_fuente" / "legislativo_2025.csv"
CLAS_LEGISLATIVO = ("P", "Poder Legislativo")
FUENTE_LEGISLATIVO = "11"
COLS_LEGISLATIVO = [
    "inciso", "ue", "ue_nombre", "prog", "prog_nombre", "tipo_gasto", "concepto",
    "credito_definitivo", "ejecutado", "fuente",
]
# Totales de control por unidad ejecutora (crédito definitivo, ejecutado), tomados de los
# totales de cada PDF original. Si el CSV curado deja de cerrar con ellos, el ETL se detiene.
CONTROL_LEGISLATIVO = {
    "001": (2_087_350_032, 1_612_142_864),  # Cámara de Senadores
    "002": (3_586_367_767, 2_781_300_519),  # Cámara de Representantes
    "003": (4_546_693_909, 2_847_665_451),  # Comisión Administrativa (programas 226, 227, 228)
}

# Legisladores (nóminas y sueldos nominales): datos curados de los documentos de cada Cámara.
CARPETA_FUENTES = Path(__file__).resolve().parent / "datos_fuente"
UE_LEGISLADORES = {"Senadores": "001", "Representantes": "002"}
PARTIDOS = {
    "FA": "Frente Amplio", "PN": "Partido Nacional", "PC": "Partido Colorado",
    "CA": "Cabildo Abierto", "IS": "Identidad Soberana", "PI": "Partido Independiente",
}
# Integrantes y bancas por partido, según los totales de cada nómina original.
CONTROL_LEGISLADORES = {
    "Senadores": (31, {"FA": 17, "PN": 9, "PC": 5}),  # vicepresidenta + 30 senadores
    "Representantes": (99, {"FA": 48, "PN": 29, "PC": 17, "CA": 2, "IS": 2, "PI": 1}),
}
PAGOS_AL_ANIO = FACTOR_ANUAL  # 12 sueldos + aguinaldo + salario vacacional, aproximado

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


def acumular(raiz: dict, ruta: list[tuple[str, str]], fuente: str, tipo: str | None, valor: int,
             ejec: int | None = None) -> None:
    """Suma `valor` en la raíz y en cada nodo de la ruta, creándolos si hace falta.
    Si se pasa `ejec`, también suma lo ejecutado en cada nodo de la ruta (no en la raíz:
    solo una parte del gasto total trae ejecución)."""
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
        if ejec is not None:
            hijo["ejec"] = hijo.get("ejec", 0) + ejec
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
    if "ejec" in nodo:
        salida["ejecutado"] = int(nodo["ejec"])
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


def construir_gasto(gas: pd.DataFrame, leg: pd.DataFrame | None = None) -> dict:
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
    if leg is not None:
        for r in leg.itertuples(index=False):
            ruta = [
                (r.clas, r.clas_nombre),
                (r.inciso, r.inciso_nombre),
                (r.ue, r.ue_nombre),
                (r.prog, r.prog_nombre),
                (TIPO_CODIGO[r.tipo], r.tipo),
                (r.obj, r.obj_nombre),
            ]
            acumular(raiz, ruta, r.fuente, r.tipo, int(r.monto), ejec=int(r.ejec))
    return finalizar(raiz)



# --------------------------------------------------------------------------- #
# Poder Legislativo (datos curados aparte)
# --------------------------------------------------------------------------- #
def leer_legislativo(path: Path) -> pd.DataFrame:
    """Lee el CSV curado del Poder Legislativo y lo deja con las columnas del gasto
    (monto = crédito definitivo) más `ejec` (ejecutado). Valida contra los totales de control."""
    df = pd.read_csv(path, encoding="utf-8", dtype=str, keep_default_na=False)
    faltan = [c for c in COLS_LEGISLATIVO if c not in df.columns]
    exigir(not faltan, f"Legislativo: faltan columnas {faltan}")
    df = df[COLS_LEGISLATIVO].copy()
    for c in df.columns:
        df[c] = df[c].str.strip().str.replace(r"\s+", " ", regex=True)
    exigir((df[["inciso", "ue", "ue_nombre", "prog", "prog_nombre", "concepto"]] != "").all().all(),
           "Legislativo: hay celdas vacías en columnas obligatorias")
    exigir(set(df["inciso"]) == {"1"}, "Legislativo: solo se espera el inciso 1")
    exigir(set(df["tipo_gasto"]) <= set(TIPO_CODIGO),
           f"Legislativo: tipos de gasto desconocidos {sorted(set(df['tipo_gasto']) - set(TIPO_CODIGO))}")
    for c in ("credito_definitivo", "ejecutado"):
        exigir(df[c].str.fullmatch(r"\d+").all(), f"Legislativo: {c} con valores no enteros o negativos")
        df[c] = df[c].astype("int64")
    exigir(bool((df["credito_definitivo"] > 0).all()), "Legislativo: hay filas con crédito en cero")
    exigir(bool((df["ejecutado"] <= df["credito_definitivo"]).all()),
           "Legislativo: hay filas con más ejecución que crédito")
    exigir(set(df["fuente"].unique()) != {""} and (df["fuente"] != "").all(),
           "Legislativo: falta la fuente documental de alguna fila")
    df["obj"] = df["concepto"].map(slug)
    exigir(not df.duplicated(["ue", "prog", "tipo_gasto", "obj"]).any(),
           "Legislativo: hay conceptos repetidos dentro de una misma unidad, programa y tipo de gasto")
    exigir(not df.groupby("ue")["ue_nombre"].nunique().gt(1).any()
           and not df.groupby(["ue", "prog"])["prog_nombre"].nunique().gt(1).any(),
           "Legislativo: un código tiene dos nombres")
    exigir(set(df["ue"]) == set(CONTROL_LEGISLATIVO), "Legislativo: unidades ejecutoras distintas de las de control")
    for ue, (cred, eje) in CONTROL_LEGISLATIVO.items():
        g = df[df["ue"] == ue]
        exigir(int(g["credito_definitivo"].sum()) == cred,
               f"Legislativo UE {ue}: el crédito suma {int(g['credito_definitivo'].sum()):,}, el control dice {cred:,}")
        exigir(int(g["ejecutado"].sum()) == eje,
               f"Legislativo UE {ue}: lo ejecutado suma {int(g['ejecutado'].sum()):,}, el control dice {eje:,}")
    print(f"  Legislativo: {len(df)} filas, crédito {int(df['credito_definitivo'].sum()):,}, "
          f"ejecutado {int(df['ejecutado'].sum()):,} (cierra con los totales de control por unidad ejecutora)")
    out = pd.DataFrame({
        "clas": CLAS_LEGISLATIVO[0], "clas_nombre": CLAS_LEGISLATIVO[1],
        "inciso": df["inciso"], "inciso_nombre": "Poder Legislativo",
        "ue": df["ue"], "ue_nombre": df["ue_nombre"],
        "prog": df["prog"], "prog_nombre": df["prog_nombre"],
        "tipo": df["tipo_gasto"], "obj": df["obj"], "aux": "", "obj_nombre": df["concepto"],
        "fuente": FUENTE_LEGISLATIVO, "monto": df["credito_definitivo"], "ejec": df["ejecutado"],
    })
    return out


def leer_legisladores(carpeta: Path) -> dict[str, dict]:
    """Nóminas y sueldos nominales de senadores y representantes. Devuelve, por cámara, el bloque
    `legisladores` que se cuelga de su unidad ejecutora. Todo se valida contra los controles."""
    nom = pd.read_csv(carpeta / "legisladores.csv", encoding="utf-8", dtype=str, keep_default_na=False)
    rem = pd.read_csv(carpeta / "remuneraciones_legisladores.csv", encoding="utf-8", dtype=str, keep_default_na=False)
    par = pd.read_csv(carpeta / "partidas_senado.csv", encoding="utf-8", dtype=str, keep_default_na=False)
    esc = pd.read_csv(carpeta / "senado_escala_funcionarios.csv", encoding="utf-8", dtype=str, keep_default_na=False)
    for nombre, df, cols in (
        ("legisladores", nom, ["camara", "nombre", "partido", "departamento", "observacion", "fecha_nomina", "fuente"]),
        ("remuneraciones_legisladores", rem, ["camara", "cargo", "categoria", "sueldo_nominal", "gastos_representacion", "vigencia", "fuente"]),
        ("partidas_senado", par, ["camara", "partida", "unidad", "monto_mensual", "observacion"]),
        ("senado_escala_funcionarios", esc, ["escalafon", "serie", "cargo", "sueldo_basico", "vigencia", "fuente"]),
    ):
        faltan = [c for c in cols if c not in df.columns]
        exigir(not faltan, f"{nombre}: faltan columnas {faltan}")
    for c in ("sueldo_nominal", "gastos_representacion"):
        exigir(rem[c].str.fullmatch(r"\d+").all(), f"remuneraciones_legisladores: {c} no entero")
        rem[c] = rem[c].astype("int64")
    exigir(par["monto_mensual"].str.fullmatch(r"\d+").all(), "partidas_senado: monto no entero")
    par["monto_mensual"] = par["monto_mensual"].astype("int64")
    exigir(esc["sueldo_basico"].str.fullmatch(r"\d+").all(), "senado_escala_funcionarios: sueldo no entero")
    esc["sueldo_basico"] = esc["sueldo_basico"].astype("int64")
    exigir(set(nom["camara"]) == set(UE_LEGISLADORES), "legisladores: cámaras inesperadas")
    exigir(set(nom["partido"]) <= set(PARTIDOS), f"legisladores: partidos desconocidos {sorted(set(nom['partido']) - set(PARTIDOS))}")
    exigir(bool((nom["nombre"] != "").all()), "legisladores: hay nombres vacíos")

    salida = {}
    for camara, ue in UE_LEGISLADORES.items():
        g = nom[nom["camara"] == camara]
        total, por_partido = CONTROL_LEGISLADORES[camara]
        exigir(len(g) == total, f"{camara}: {len(g)} integrantes, el control dice {total}")
        exigir(not g["nombre"].duplicated().any(), f"{camara}: nombres repetidos")
        exigir(g["partido"].value_counts().to_dict() == por_partido,
               f"{camara}: bancas por partido {g['partido'].value_counts().to_dict()} != control {por_partido}")
        exigir(g["fecha_nomina"].nunique() == 1 and g["fuente"].nunique() == 1, f"{camara}: fecha o fuente mezcladas")
        r = rem[rem["camara"] == camara]
        exigir(len(r) >= 1, f"{camara}: sin sueldos")
        # cantidad de personas que cobra cada cargo de la escala
        if camara == "Senadores":
            cantidad = {"Vicepresidente": 1, "Senador y Secretario": total - 1}
            legisl = [c for c in cantidad]
        else:
            cantidad = {"Representante Nacional": total}
            legisl = list(cantidad)
        exigir(set(legisl) <= set(r["cargo"]), f"{camara}: falta el sueldo de algún cargo")
        sueldos = []
        mensual = 0
        for x in r.itertuples(index=False):
            n = cantidad.get(x.cargo)
            fila = {"cargo": x.cargo, "sueldo": int(x.sueldo_nominal), "gastos_representacion": int(x.gastos_representacion),
                    "total": int(x.sueldo_nominal + x.gastos_representacion)}
            if n is not None:
                fila["cantidad"] = n
                mensual += n * fila["total"]
            sueldos.append(fila)
        bloque = {
            "camara": camara,
            "fecha_nomina": g["fecha_nomina"].iloc[0],
            "fuente_nomina": g["fuente"].iloc[0],
            "vigencia_sueldos": r["vigencia"].iloc[0] or None,
            "fuente_sueldos": r["fuente"].iloc[0],
            "partidos": [{"codigo": k, "nombre": PARTIDOS[k], "integrantes": int(v)}
                         for k, v in sorted(g["partido"].value_counts().items(), key=lambda kv: (-kv[1], kv[0]))],
            "personas": [[x.nombre, x.partido, x.departamento, x.observacion]
                         for x in g.sort_values("nombre").itertuples(index=False)],
            "sueldos": sueldos,
            "mensual_legisladores": int(mensual),
            "anual_legisladores": int(mensual) * PAGOS_AL_ANIO,
            "pagos_al_anio": PAGOS_AL_ANIO,
        }
        if camara == "Senadores":
            p = par[par["camara"] == camara]
            exigir(len(p) == 4, "partidas del Senado: se esperaban 4")
            bloque["partidas"] = [{"partida": x.partida, "unidad": x.unidad, "monto": int(x.monto_mensual), "observacion": x.observacion}
                                  for x in p.itertuples(index=False)]
        salida[ue] = bloque
    # Escala de sueldos de los funcionarios del Senado (programa 222)
    exigir(len(esc) > 0 and esc["vigencia"].nunique() == 1, "escala de funcionarios del Senado: vigencia mezclada")
    salida["escala_funcionarios_senado"] = {
        "vigencia": esc["vigencia"].iloc[0],
        "fuente": esc["fuente"].iloc[0],
        "filas": [[x.escalafon, x.serie, x.cargo, int(x.sueldo_basico)] for x in esc.itertuples(index=False)],
    }
    print(f"  Legisladores: Senado {len(nom[nom['camara'] == 'Senadores'])}, Representantes {len(nom[nom['camara'] == 'Representantes'])}; "
          f"escala de funcionarios del Senado: {len(esc)} cargos (cierra con los controles)")
    return salida


def colgar_legisladores(arbol_gas: dict, datos: dict) -> None:
    """Cuelga el bloque `legisladores` de la unidad ejecutora de cada Cámara y la escala de
    sueldos de funcionarios del programa 222 del Senado."""
    clas = next((c for c in arbol_gas["hijos"] if c["codigo"] == CLAS_LEGISLATIVO[0]), None)
    exigir(clas is not None, "legisladores: no está el grupo del Poder Legislativo en el árbol de gasto")
    inc = next(i for i in clas["hijos"] if i["codigo"] == "1")
    ues = {u["codigo"]: u for u in inc["hijos"]}
    for ue in UE_LEGISLADORES.values():
        exigir(ue in ues, f"legisladores: no existe la unidad ejecutora {ue}")
        ues[ue]["legisladores"] = datos[ue]
    prog = next((p for p in ues["001"]["hijos"] if p["codigo"] == "222"), None)
    exigir(prog is not None, "legisladores: no existe el programa 222 del Senado")
    prog["escala_funcionarios"] = datos["escala_funcionarios_senado"]


# --------------------------------------------------------------------------- #
# Cargos (puestos de trabajo)
# --------------------------------------------------------------------------- #
def leer_puestos(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path, sep=";", encoding="cp1252", dtype=str, index_col=0, low_memory=False)
    df.columns = df.columns.str.strip()
    faltan = [c for c in COLS_PUESTOS if c not in df.columns]
    exigir(not faltan, f"Puestos: faltan columnas {faltan}")
    df = df[list(COLS_PUESTOS)].rename(columns=COLS_PUESTOS)
    for c in df.columns:
        df[c] = df[c].str.strip().str.replace(r"\s+", " ", regex=True)
    # Algunos contratos (zafrales, función pública, etc.) no tienen escalafón: es válido.
    n_sin = int(df["escalafon"].isna().sum())
    df["escalafon"] = df["escalafon"].fillna(SIN_ESCALAFON)
    print(f"  Puestos: {n_sin} filas sin escalafón se agrupan como '{SIN_ESCALAFON}'")
    exigir(not df.isna().any().any(), "Puestos: hay celdas vacías en columnas usadas")
    for c in ("ocupado", "vacante", "importe"):
        df[c] = parsear_montos(df[c], f"Puestos {c}")
        exigir(bool((df[c] >= 0).all()), f"Puestos: {c} con valores negativos")
    for c in ("inciso", "ue", "prog"):
        exigir(df[c].str.fullmatch(r"\d+").all(), f"Puestos: {c} con códigos no numéricos")
        df[c] = df[c].astype(int)
    print(f"  Puestos: {len(df):,} filas, {int(df['ocupado'].sum()):,} ocupados, "
          f"{int(df['vacante'].sum()):,} vacantes, {len(df[df['importe'] == 0])} filas con importe 0")
    return df


def apartar(fuentes: dict, pesos: list[int]) -> list[dict]:
    """Reparte `fuentes` (código -> monto) entre partes con los `pesos` dados, en
    proporción, con enteros y exactitud en ambos sentidos: cada fuente suma su monto y
    cada parte suma su peso. Se redondea hacia abajo y los pesos sobrantes (pocos) se
    asignan emparejando filas y columnas pendientes."""
    total = sum(pesos)
    exigir(total == sum(fuentes.values()), "apartar: las fuentes no suman lo que suman las partes")
    codigos = list(fuentes)
    celdas = [[fuentes[f] * w // total for w in pesos] for f in codigos]
    filas_pend = [fuentes[f] - sum(celdas[i]) for i, f in enumerate(codigos)]
    cols_pend = [pesos[j] - sum(celdas[i][j] for i in range(len(codigos))) for j in range(len(pesos))]
    exigir(min(filas_pend) >= 0 and min(cols_pend) >= 0, "apartar: sobrante negativo")
    unid_f = [i for i, k in enumerate(filas_pend) for _ in range(k)]
    unid_c = [j for j, k in enumerate(cols_pend) for _ in range(k)]
    exigir(len(unid_f) == len(unid_c), "apartar: sobrantes desparejos")
    for i, j in zip(unid_f, unid_c):
        celdas[i][j] += 1
    return [
        {f: celdas[i][j] for i, f in enumerate(codigos) if celdas[i][j]}
        for j in range(len(pesos))
    ]


def _ordenar(hijos: list[dict]) -> list[dict]:
    return sorted(hijos, key=lambda h: (-h["valor"], h["nombre"]))


def _resumen_cargos(g: pd.DataFrame) -> dict:
    regs = []
    for reg, gr in g.groupby("regimen"):
        regs.append({
            "nombre": reg,
            "ocupados": int(gr["ocupado"].sum()),
            "vacantes": int(gr["vacante"].sum()),
            "importe_mensual": int(gr["importe"].sum()),
        })
    regs.sort(key=lambda r: (-(r["ocupados"] + r["vacantes"]), r["nombre"]))
    return {
        "ocupados": int(g["ocupado"].sum()),
        "vacantes": int(g["vacante"].sum()),
        "importe_mensual": int(g["importe"].sum()),
        "regimenes": regs,
    }


def _sumar_cargos(lista: list[dict]) -> dict:
    regs: dict[str, dict] = {}
    for c in lista:
        for r in c["regimenes"]:
            t = regs.setdefault(r["nombre"], {"nombre": r["nombre"], "ocupados": 0, "vacantes": 0, "importe_mensual": 0})
            for k in ("ocupados", "vacantes", "importe_mensual"):
                t[k] += r[k]
    return {
        "ocupados": sum(c["ocupados"] for c in lista),
        "vacantes": sum(c["vacantes"] for c in lista),
        "importe_mensual": sum(c["importe_mensual"] for c in lista),
        "regimenes": sorted(regs.values(), key=lambda r: (-(r["ocupados"] + r["vacantes"]), r["nombre"])),
    }


def _denominaciones(g: pd.DataFrame) -> list[list]:
    """[denominación, ocupados, vacantes, importe mensual] por cargo, de más a menos cargos."""
    agg = g.groupby("denominacion")[["ocupado", "vacante", "importe"]].sum().reset_index()
    agg["cargos"] = agg["ocupado"] + agg["vacante"]
    agg = agg.sort_values(["cargos", "denominacion"], ascending=[False, True])
    return [[r.denominacion, int(r.ocupado), int(r.vacante), int(r.importe)] for r in agg.itertuples(index=False)]


def partir_remuneraciones(prog: dict, g: pd.DataFrame) -> int:
    """Dentro de 'Remuneraciones' de un programa: separa los sueldos de los cargos
    (importe mensual x FACTOR_ANUAL, por régimen y escalafón) del resto. Devuelve el
    estimado. El desglose original por objeto del gasto pasa a `objetos`."""
    rem = next((h for h in prog.get("hijos", []) if h["codigo"] == "R"), None)
    exigir(rem is not None, f"{prog['id']}: tiene cargos pero no gasto en Remuneraciones")
    est = FACTOR_ANUAL * int(g["importe"].sum())
    exigir(
        est <= rem["valor"],
        f"{prog['id']}: el estimado de sueldos ({est:,}) supera el gasto en remuneraciones ({rem['valor']:,})",
    )
    if est == 0:
        return 0
    resto = rem["valor"] - est
    pesos = [est] + ([resto] if resto else [])
    fu = apartar(rem["fuentes"], pesos)

    regimenes = []
    for reg, gr in g.groupby("regimen"):
        v = FACTOR_ANUAL * int(gr["importe"].sum())
        if v:
            regimenes.append((reg, gr, v))
    regimenes.sort(key=lambda t: (-t[2], t[0]))
    fu_reg = apartar(fu[0], [t[2] for t in regimenes])
    hijos_reg = []
    for (reg, gr, v), f_reg in zip(regimenes, fu_reg):
        escs = []
        for esc, ge in gr.groupby("escalafon"):
            ve = FACTOR_ANUAL * int(ge["importe"].sum())
            if ve:
                escs.append((esc, ge, ve))
        escs.sort(key=lambda t: (-t[2], t[0]))
        fu_esc = apartar(f_reg, [t[2] for t in escs])
        nodo_reg = {
            "id": f"{rem['id']}/cargos/{slug(reg)}", "nombre": reg, "codigo": reg, "valor": v,
            "fuentes": f_reg, "nivel": "Tipo de contrato", "nivel_hijos": "Escalafón",
            "cargos": {"ocupados": int(gr["ocupado"].sum()), "vacantes": int(gr["vacante"].sum()),
                       "importe_mensual": int(gr["importe"].sum())},
            "hijos": [
                {
                    "id": f"{rem['id']}/cargos/{slug(reg)}/{slug(esc)}", "nombre": esc if esc == SIN_ESCALAFON else f"Escalafón {esc}",
                    "codigo": esc, "valor": ve, "fuentes": f_esc, "nivel": "Escalafón",
                    "cargos": {"ocupados": int(ge["ocupado"].sum()), "vacantes": int(ge["vacante"].sum()),
                               "importe_mensual": int(ge["importe"].sum())},
                    "denominaciones": _denominaciones(ge),
                }
                for (esc, ge, ve), f_esc in zip(escs, fu_esc)
            ],
        }
        hijos_reg.append(nodo_reg)
    nodo_a = {
        "id": f"{rem['id']}/cargos", "nombre": NOMBRE_SUELDOS, "codigo": "cargos", "valor": est,
        "fuentes": fu[0], "nivel": NIVEL_PARTE, "nivel_hijos": "Tipo de contrato",
        "cargos": {"ocupados": int(g["ocupado"].sum()), "vacantes": int(g["vacante"].sum()),
                   "importe_mensual": int(g["importe"].sum())},
        "hijos": hijos_reg,
    }
    nuevos = [nodo_a]
    if resto:
        nuevos.append({
            "id": f"{rem['id']}/resto", "nombre": NOMBRE_RESTO, "codigo": "resto", "valor": resto,
            "fuentes": fu[1], "nivel": NIVEL_PARTE,
        })
    rem["objetos"] = rem.pop("hijos")
    rem["hijos"] = _ordenar(nuevos)
    rem["nivel_hijos"] = NIVEL_PARTE
    return est


def integrar_puestos(arbol_gas: dict, pu: pd.DataFrame) -> dict:
    """Une los cargos al árbol de gasto por (inciso, unidad ejecutora, programa)."""
    grupos = {k: g for k, g in pu.groupby(["inciso", "ue", "prog"])}
    usados: set = set()
    total_est = 0
    incisos_con_datos: list[int] = []
    for clas in arbol_gas["hijos"]:
        cargos_clas = []
        for inc in clas["hijos"]:
            cargos_inc = []
            for ue in inc["hijos"]:
                cargos_ue = []
                for prog in ue["hijos"]:
                    clave = (int(inc["codigo"]), int(ue["codigo"]), int(prog["codigo"]))
                    g = grupos.get(clave)
                    if g is None:
                        prog["sin_cargos"] = True
                        continue
                    usados.add(clave)
                    total_est += partir_remuneraciones(prog, g)
                    prog["cargos"] = _resumen_cargos(g)
                    cargos_ue.append(prog["cargos"])
                if cargos_ue:
                    ue["cargos"] = _sumar_cargos(cargos_ue)
                    cargos_inc.append(ue["cargos"])
                else:
                    ue["sin_cargos"] = True
            if cargos_inc:
                inc["cargos"] = _sumar_cargos(cargos_inc)
                cargos_clas.append(inc["cargos"])
                incisos_con_datos.append(int(inc["codigo"]))
            else:
                inc["sin_cargos"] = True
        if cargos_clas:
            clas["cargos"] = _sumar_cargos(cargos_clas)
    exigir(usados == set(grupos), f"hay {len(set(grupos) - usados)} combinaciones de cargos sin programa en el gasto")
    exigir(total_est == FACTOR_ANUAL * int(pu["importe"].sum()), "el estimado total no coincide con el importe del CSV")
    cargos_total = _sumar_cargos([c["cargos"] for c in arbol_gas["hijos"] if "cargos" in c])
    exigir(cargos_total["ocupados"] == int(pu["ocupado"].sum()), "los ocupados del árbol no suman los del CSV")
    exigir(cargos_total["vacantes"] == int(pu["vacante"].sum()), "las vacantes del árbol no suman las del CSV")
    return {
        "ocupados": cargos_total["ocupados"],
        "vacantes": cargos_total["vacantes"],
        "importe_mensual": cargos_total["importe_mensual"],
        "estimado_anual": total_est,
        "factor_anual": FACTOR_ANUAL,
        "incisos": sorted(incisos_con_datos),
        "programas": len(grupos),
    }

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
    if nodo.get("objetos"):
        exigir(
            sum(o["valor"] for o in nodo["objetos"]) == nodo["valor"],
            f"los objetos del gasto no suman al valor en {nodo['id']}",
        )
    if "ejecutado" in nodo:
        exigir(0 <= nodo["ejecutado"] <= nodo["valor"], f"lo ejecutado excede el crédito en {nodo['id']}")
    hijos = nodo.get("hijos")
    if hijos and "ejecutado" in nodo:
        exigir(
            all("ejecutado" in h for h in hijos) and sum(h["ejecutado"] for h in hijos) == nodo["ejecutado"],
            f"lo ejecutado de los hijos no suma al padre en {nodo['id']}",
        )
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
    ap.add_argument("--legislativo", type=Path, default=ARCHIVO_LEGISLATIVO,
                    help="CSV curado del Poder Legislativo (si no existe, se omite)")
    ap.add_argument("--pretty", action="store_true", help="JSON con sangría (más pesado, legible)")
    args = ap.parse_args()

    print("Leyendo archivos…")
    rec = leer(localizar(args.raw, PATRONES["recursos"]), COLS_RECURSOS, "Recursos 2025 (AÑO_0)")
    gas = leer(localizar(args.raw, PATRONES["gasto"]), COLS_GASTO, "Crédito vigente 2025")

    exigir(
        (gas.groupby("inciso")["clas"].nunique() == 1).all(),
        "hay incisos con más de una clasificación",
    )

    leg = None
    if args.legislativo.exists():
        print("Leyendo Poder Legislativo (datos curados aparte)…")
        leg = leer_legislativo(args.legislativo)
        exigir(not set(leg["inciso"]) & set(gas["inciso"]),
               "el Poder Legislativo ya figura en el CSV oficial de gasto: revisar para no duplicarlo")
    else:
        print(f"(sin {args.legislativo}: se omite el Poder Legislativo)")
    # Para el puente por fuente, el gasto incluye el Legislativo (crédito definitivo).
    gas_total = gas if leg is None else pd.concat(
        [gas, leg[list(gas.columns)]], ignore_index=True)

    print("Construyendo árboles…")
    arbol_rec = construir_recursos(rec)
    arbol_gas = construir_gasto(gas, leg)
    total_rec, total_gas = int(rec["monto"].sum()), int(gas_total["monto"].sum())
    exigir(arbol_rec["valor"] == total_rec, "el árbol de recursos no suma el total del CSV")
    exigir(arbol_gas["valor"] == total_gas, "el árbol de gasto no suma el total del CSV")
    validar_arbol(arbol_rec, set())
    ids_gasto: set[str] = set()
    validar_arbol(arbol_gas, ids_gasto)

    legisladores = None
    carpeta_leg = args.legislativo.parent
    if leg is not None and (carpeta_leg / "legisladores.csv").exists():
        print("Leyendo legisladores (nóminas y sueldos)…")
        datos_leg = leer_legisladores(carpeta_leg)
        colgar_legisladores(arbol_gas, datos_leg)
        legisladores = {u: {k: d[k] for k in ("camara", "fecha_nomina", "vigencia_sueldos")} for u, d in datos_leg.items() if u in UE_LEGISLADORES.values()}

    resumen_puestos = None
    hay_puestos = bool(sorted(args.raw.glob(PATRONES["puestos"])))
    if hay_puestos:
        print("Integrando cargos (puestos de trabajo)…")
        pu = leer_puestos(localizar(args.raw, PATRONES["puestos"]))
        resumen_puestos = integrar_puestos(arbol_gas, pu)
        ids_gasto = set()
        validar_arbol(arbol_gas, ids_gasto)
        exigir(arbol_gas["valor"] == total_gas, "al integrar cargos cambió el total del gasto")
        print(f"  Cargos: {resumen_puestos['ocupados']:,} ocupados, {resumen_puestos['vacantes']:,} vacantes; "
              f"estimado anual {mm(resumen_puestos['estimado_anual'])} mil millones $U "
              f"en {len(resumen_puestos['incisos'])} incisos")
    else:
        print("(sin archivo de puestos: se omite la capa de cargos)")

    puente = construir_puente(rec, gas_total, arbol_rec, arbol_gas)

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
            "gasto": "Crédito vigente al 31/05/2025 (Crédito_vigente_2025_Gastos_VF.csv)"
            + (" más el Poder Legislativo: crédito definitivo al 31/12/2025, de fuentes propias" if leg is not None else ""),
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
            ] + ([
                "Poder Legislativo (inciso 1): no está en los CSV oficiales de gasto. Se agregó como grupo aparte desde los "
                "documentos de cada Cámara y de la Comisión Administrativa (ver datos_fuente/LEEME_legislativo_2025.md). "
                "El valor de cada nodo es el crédito definitivo al 31/12/2025; el CSV oficial es crédito vigente a mayo de 2025, "
                "así que la fecha de corte no es la misma.",
                "Solo el Poder Legislativo trae ejecución 2025 (lo efectivamente gastado, `ejecutado`): el resto del gasto es solo crédito, "
                "así que la ejecución no se puede comparar entre organismos.",
                "El gasto del Poder Legislativo se financia con Rentas Generales (código 11, el 'Fondo común' de la página): "
                "se asignó todo a esa fuente.",
                "Los recursos no cambian al agregar el Poder Legislativo (solo recauda una suma muy chica). Por eso la diferencia entre "
                "recursos y gasto crece en lo que suma su gasto.",
                "Legisladores: la nómina del Senado es de la consulta del 28/08/2025 (vicepresidenta y 30 senadores; 6 son suplentes de "
                "senadores que pasaron a ministros o subsecretarios). La de Representantes es del 13/11/2026 e incluye suplentes en ejercicio, "
                "así que puede no coincidir con 2025.",
                "Los sueldos de los legisladores son nominales (antes de descuentos) y salen de las planillas de cada Cámara; los del Senado "
                "rigen desde enero de 2026. Representantes trae las mismas cifras pero sin fecha de vigencia. No son exactamente los de 2025.",
                "Sueldo anual de los legisladores (cálculo): cantidad de integrantes x (sueldo nominal + gastos de representación) x 14. No incluye "
                "aportes patronales ni partidas para secretarios, y por eso no es comparable con el crédito de sueldos del presupuesto.",
                "Los nombres de los programas 221 a 223 del Senado y el 0 de Representantes son descriptivos: sus documentos "
                "no traen programas con nombre oficial en esos casos.",
            ] if leg is not None else []) + ([
                "Cargos: el archivo de puestos de trabajo cubre solo los incisos "
                + ", ".join(str(i) for i in resumen_puestos["incisos"])
                + " (Presidencia, ministerios y Ambiente); no incluye ANEP, ASSE, Universidad de la República, "
                "Poder Judicial, Fiscalía ni otros organismos.",
                f"Sueldos de los cargos (estimado) = importe mensual nominal de cada cargo (ocupado o vacante) x {FACTOR_ANUAL}, "
                "para incluir aguinaldo y salario vacacional. Los datos no detallan compensaciones adicionales ni "
                "incentivos, y no incluyen aportes patronales.",
                "La fuente de financiamiento de los sueldos estimados se reparte en la misma proporción que la de "
                "las remuneraciones del programa; es un supuesto, no un dato.",
                "'Resto de remuneraciones' es el gasto en remuneraciones del programa menos el estimado de sueldos de los cargos; "
                "el detalle por objeto del gasto de todo el rubro está en `objetos`.",
            ] if resumen_puestos else []),
        },
        "totales": {"recursos": total_rec, "gasto": total_gas, "diferencia": total_rec - total_gas},
        "legislativo": None if leg is None else {
            "credito": int(leg["monto"].sum()),
            "ejecutado": int(leg["ejec"].sum()),
            "corte": "2025-12-31",
            "fuente_financiamiento": FUENTE_LEGISLATIVO,
            "legisladores": legisladores,
            "gasto_sin_legislativo": int(gas["monto"].sum()),
            "diferencia_sin_legislativo": total_rec - int(gas["monto"].sum()),
        },
        "puestos": resumen_puestos,
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
