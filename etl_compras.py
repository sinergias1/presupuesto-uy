#!/usr/bin/env python3
"""Cuelga las COMPRAS ADJUDICADAS 2025 (ARCE/OCDS) a la derecha de los rubros del gasto.

    rubro (objeto del gasto) → artículo comprado → proveedor

Se ejecuta DESPUÉS de etl.py y modifica data/2025/gasto/inciso_N.json (idempotente).
Usa dos tablas curadas a mano (se revisan en GitHub):
  datos_fuente/compras_unidades.csv  unidad compradora de la base → inciso / unidad ejecutora
  datos_fuente/compras_reglas.csv    artículo comprado (regex) → rubro del presupuesto

Reglas de cuadratura (el árbol exige que los hijos sumen al padre):
  * las compras de un rubro nunca superan su crédito: si lo superan se escalan hacia abajo
    y se deja constancia (`compras.escalado`); lo que no se compró figura como
    "Resto sin detalle de compra";
  * un rubro presente en varios programas recibe las compras en proporción a su crédito.
"""
from __future__ import annotations
import argparse, csv, json, re, sqlite3, unicodedata
from collections import defaultdict
from pathlib import Path

RAIZ = Path(__file__).resolve().parent
TOPE_ARTICULOS = 40     # artículos por rubro antes de agrupar en "otros artículos"
TOPE_PROVEEDORES = 40


def slug(t):
    a = unicodedata.normalize("NFKD", str(t)).encode("ascii", "ignore").decode()
    return re.sub(r"[^A-Za-z0-9_-]+", "-", a).strip("-").lower()[:40]


PALABRAS = {"electrica": "eléctrica", "electrico": "eléctrico", "mecanica": "mecánica", "camara": "cámara", "maquina": "máquina",
            "informatico": "informático", "informatica": "informática", "tecnico": "técnico", "tecnica": "técnica",
            "hidrogeologico": "hidrogeológico", "medico": "médico", "habitable": "habitable", "automotriz": "automotriz",
            "neumatica": "neumática", "numero": "número", "articulo": "artículo", "vehiculo": "vehículo", "consultoria": "consultoría",
            "peluqueria": "peluquería", "cañeria": "cañería", "cerrajeria": "cerrajería", "bateria": "batería", "gaseosa": "gaseosa",
            "fotografica": "fotográfica", "analisis": "análisis", "pasaje": "pasaje", "ultimo": "último", "telefono": "teléfono",
            "alimentacion": "alimentación", "limon": "limón", "papa": "papa", "camion": "camión", "reparacion": "reparación"}


def acentuar(texto: str) -> str:
    """La base trae las descripciones en mayúsculas sin tildes: restituye las más comunes."""
    def una(m):
        w = m.group(0); l = w.lower()
        if l in PALABRAS: r = PALABRAS[l]
        elif re.search(r"(cion|sion)$", l): r = l[:-4] + l[-4:].replace("cion", "ción").replace("sion", "sión")
        else: return w
        return r.capitalize() if w[0].isupper() else r
    return re.sub(r"[A-Za-zñÑ]+", una, texto)


def repartir(valor: int, pesos: dict) -> dict:
    """Reparte `valor` entero según `pesos` (resto mayor), sumando exacto."""
    tot = sum(pesos.values())
    if valor == 0 or tot == 0:
        return {}
    base = {k: valor * v // tot for k, v in pesos.items()}
    falta = valor - sum(base.values())
    for k in sorted(pesos, key=lambda k: -((valor * pesos[k]) % tot))[:falta]:
        base[k] += 1
    return {k: v for k, v in base.items() if v}


def limpiar(nodo):
    """Quita lo colgado en una corrida anterior."""
    for h in nodo.get("hijos", []) or []:
        limpiar(h)
    if nodo.get("hijos") and nodo["hijos"][-1].get("compras_resto"):
        pass
    if nodo.get("compras") and nodo["compras"] is not True:
        for k in ("compras", "hijos", "nivel_hijos"):
            nodo.pop(k, None)


def hojas_rubro(ue):
    """{codigo_rubro: [(nodo_rubro, tipo 'f'|'i'), …]} bajo todos los programas de la UE."""
    out = defaultdict(list)
    for prog in ue.get("hijos", []):
        for t in prog.get("hijos", []):
            tipo = t["id"].rsplit("/", 1)[1]
            if tipo in ("f", "i"):
                for r in t.get("hijos", []):
                    out[r["codigo"]].append((r, tipo))
    return out


def cargar_reglas():
    with open(RAIZ / "datos_fuente/compras_reglas.csv", encoding="utf-8") as f:
        return [(re.compile(r["patron"]), r["rubro"], r["tipo"]) for r in csv.DictReader(f)]


def clasificar(desc, reglas):
    desc = desc.split(" (Cód")[0].strip().upper()
    for pat, rubro, tipo in reglas:
        if pat.search(desc):
            return rubro, tipo
    return None, None


def nodo(id_, nombre, codigo, valor, fuentes, hijos=None, **extra):
    n = {"id": id_, "nombre": nombre, "codigo": codigo, "valor": valor,
         "fuentes": repartir(valor, fuentes)}
    n.update(extra)
    if hijos:
        n["hijos"] = hijos
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", type=Path, required=True)
    ap.add_argument("--datos", type=Path, default=RAIZ / "data/2025")
    a = ap.parse_args()
    reglas = cargar_reglas()
    con = sqlite3.connect(f"file:{a.db}?mode=ro", uri=True)
    unidades = list(csv.DictReader(open(RAIZ / "datos_fuente/compras_unidades.csv", encoding="utf-8")))
    por_inc = defaultdict(list)
    for u in unidades:
        por_inc[u["inciso"]].append(u)
    for inc, us in por_inc.items():
        ruta = a.datos / f"gasto/inciso_{inc}.json"
        doc = json.loads(ruta.read_text(encoding="utf-8"))
        raiz = doc["nodo"]
        limpiar(raiz)
        for u in us:
            ue = next(h for h in raiz["hijos"] if h["codigo"] == u["ue"])
            rubros = hojas_rubro(ue)
            filas = con.execute(
                """select i.classification_id, i.classification_description, i.supplier_name, i.monto_total
                   from releases r join items i on i.release_id=r.id
                   where r.buyer_name=? and r.buyer_id=?""", (u["buyer_name"], u["buyer_id"])).fetchall()
            res = {"adjudicado": 0, "sin_monto": 0, "sin_rubro": 0, "asignado": 0, "escalado": 0, "renglones": len(filas)}
            # rubro -> artículo(id,desc) -> proveedor -> monto (pesos enteros)
            acu = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))
            sin_rubro = defaultdict(float); tipo_de = {}
            for cid, desc, prov, monto in filas:
                if monto is None:
                    res["sin_monto"] += 1; continue
                res["adjudicado"] += monto
                rubro, tipo = clasificar(desc or "", reglas)
                if rubro: tipo_de.setdefault(rubro, tipo)
                if rubro is None or rubro not in rubros:
                    res["sin_rubro"] += monto; sin_rubro[(desc or "").split(" (Cód")[0]] += monto; continue
                art = (str(cid), acentuar((desc or "").split(" (Cód")[0].strip().capitalize()))
                acu[rubro][art][(prov or "Proveedor sin nombre").strip().title()] += monto
            for rubro, arts in acu.items():
                ocurr = rubros[rubro]
                tipo_pref = tipo_de[rubro]
                # primero el programa/tipo que la regla prefiere; dentro de eso, el de mayor crédito
                ocurr = sorted(ocurr, key=lambda rt: (rt[1] != tipo_pref, -rt[0]["valor"]))
                cred_tot = sum(r["valor"] for r, _ in ocurr)
                lineas = sorted(((m, art, p) for art, pv in arts.items() for p, m in pv.items()), reverse=True)
                comp_tot = sum(m for m, _, _ in lineas)
                factor = min(1.0, cred_tot / comp_tot) if comp_tot else 0
                if factor < 1: res["escalado"] += comp_tot - cred_tot
                # llenado secuencial: cada ocurrencia recibe líneas hasta agotar su crédito
                cola = [[m * factor, art, p] for m, art, p in lineas]
                for r, tipo in ocurr:
                    cap = float(r["valor"]); mios = defaultdict(lambda: defaultdict(float))
                    while cola and cap > 0.5:
                        m, art, p = cola[0]
                        t = min(m, cap)
                        mios[art][p] += t; cap -= t
                        if t >= m - 1e-9: cola.pop(0)
                        else: cola[0][0] = m - t
                    if not mios: continue
                    art_nodos = []
                    for art, pesos in mios.items():
                        v_art = int(sum(pesos.values()))
                        if v_art > 0: art_nodos.append((art[0], art[1], v_art, pesos))
                    art_nodos.sort(key=lambda x: -x[2])
                    hijos = []
                    for cid, nom, v_art, pesos in art_nodos:
                        pv = repartir(v_art, {p: int(m) + 1 for p, m in pesos.items()})
                        pv_nodos = [nodo(f"{r['id']}/c{cid}/{slug(p)}", p, slug(p), v, r["fuentes"], compras=True, nivel="Proveedor")
                                    for p, v in sorted(pv.items(), key=lambda x: -x[1])]
                        hijos.append(nodo(f"{r['id']}/c{cid}", nom, f"c{cid}", v_art, r["fuentes"], pv_nodos, compras=True,
                                          nivel="Artículo comprado", nivel_hijos="Proveedor"))
                    tot_art = sum(h["valor"] for h in hijos)
                    if tot_art > r["valor"]:   # redondeo
                        exceso = tot_art - r["valor"]
                        hijos[0]["valor"] -= exceso; hijos[0]["hijos"][0]["valor"] -= exceso
                        hijos[0]["fuentes"] = repartir(hijos[0]["valor"], r["fuentes"])
                        hijos[0]["hijos"][0]["fuentes"] = repartir(hijos[0]["hijos"][0]["valor"], r["fuentes"])
                        tot_art = r["valor"]
                    resto = r["valor"] - tot_art
                    if resto > 0:
                        hijos.append(nodo(f"{r['id']}/resto", "Resto sin detalle de compra", "resto", resto, r["fuentes"], compras_resto=True, nivel="Resto del rubro"))
                    hijos.sort(key=lambda h: -h["valor"])
                    r["hijos"] = hijos
                    r["nivel_hijos"] = "Artículo comprado"
                    r["compras"] = {"adjudicado": int(tot_art), "escalado": factor < 1}
                    res["asignado"] += tot_art
            ue["compras_resumen"] = {k: int(v) for k, v in res.items()}
            print(f"{inc}/{u['ue']} {ue['nombre']}: adjudicado {res['adjudicado']/1e6:.1f} M | asignado a rubro {res['asignado']/1e6:.1f} M | "
                  f"sin rubro {res['sin_rubro']/1e6:.1f} M | sobre el crédito {res['escalado']/1e6:.1f} M | renglones sin monto {res['sin_monto']}/{res['renglones']}")
            for d, m in sorted(sin_rubro.items(), key=lambda x: -x[1])[:25]:
                print(f"     sin regla: {m/1e6:6.2f}  {d}")
        ruta.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
