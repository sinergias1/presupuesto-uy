#!/usr/bin/env python3
"""Cuelga las COMPRAS ADJUDICADAS 2025 (ARCE/OCDS) a la derecha de los rubros del gasto.

    rubro (objeto del gasto) → artículo comprado → proveedor

Se ejecuta DESPUÉS de etl.py y modifica data/2025/gasto/inciso_N.json (idempotente).
Usa dos tablas curadas a mano (se revisan en GitHub):
  datos_fuente/compras_unidades.csv  unidad compradora de la base → inciso / unidad ejecutora
  datos_fuente/compras_reglas.csv    artículo comprado (regex) → rubro del presupuesto

Reglas de cuadratura:
  * los montos de las compras son los REALES (no se recortan). Lo que el rubro tiene autorizado y
    no aparece comprado figura como "Resto sin detalle de compra";
  * si se adjudicó más que el crédito del rubro (contratos de varios años, otros rubros que pagan,
    etc.), el rubro queda marcado `compras.excede` y los hijos suman más que el padre;
  * un rubro presente en varios programas llena primero el de mayor crédito.
"""
from __future__ import annotations
import argparse, csv, json, re, sqlite3, unicodedata, zlib
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


PORTAL = "https://www.comprasestatales.gub.uy"


def enlaces_compra(rid, con_resolucion):
    """Páginas públicas de la compra en el portal de Compras Estatales (ARCE).
    El acta/resolución en PDF solo existe cuando la compra ya tiene resolución."""
    e = [{"t": "Ver la compra en el portal de compras estatales", "u": f"{PORTAL}/consultas/detalle/id/{rid}"}]
    if con_resolucion:
        e.append({"t": "Resolución (PDF)", "u": f"{PORTAL}/Resoluciones/acta_{rid}.pdf"})
    return e


def pslug(nombre):
    """Id estable de un proveedor: nombre acotado + código corto, porque dos nombres largos pueden empezar igual."""
    return f"{slug(nombre)[:28]}-{zlib.crc32(nombre.encode()) & 0xffff:04x}"


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
    nodo.pop("compras_sin_monto", None); nodo.pop("compras_ref", None)
    for h in nodo.get("hijos", []) or []:
        limpiar(h)
    if nodo.get("hijos") and nodo["hijos"][-1].get("compras_resto"):
        pass
    if nodo.get("compras") and nodo["compras"] is not True:
        for k in ("compras", "hijos", "nivel_hijos"):
            nodo.pop(k, None)


def buscar(nodo, id_):
    """Nodo con ese id dentro del subárbol (los ids son jerárquicos: se baja por prefijo)."""
    if nodo["id"] == id_:
        return nodo
    for h in nodo.get("hijos", []) or []:
        if id_ == h["id"] or id_.startswith(h["id"] + "/"):
            return buscar(h, id_)
    raise KeyError(id_)


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
        return [(re.compile(r["patron"]), r["rubro"].split("|"), r["tipo"]) for r in csv.DictReader(f)]


def clasificar(desc, reglas, disponibles):
    """Primera regla cuyo patrón calza Y que tenga algún rubro candidato en esta unidad ejecutora.
    Si la regla calza pero la unidad no tiene ninguno de sus rubros, se sigue con la siguiente."""
    desc = desc.split(" (Cód")[0].strip().upper()
    for pat, rubros, tipo in reglas:
        if pat.search(desc):
            for r in rubros:
                if r in disponibles:
                    return r, tipo
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
    for viejo in (a.datos / "compras").glob("*.json"):
        viejo.unlink()
    reglas = cargar_reglas()
    con = sqlite3.connect(f"file:{a.db}?mode=ro", uri=True)
    unidades = list(csv.DictReader(open(RAIZ / "datos_fuente/compras_unidades.csv", encoding="utf-8")))
    # una unidad ejecutora puede tener varias unidades compradoras en la base
    por_ue = defaultdict(list)
    for u in unidades:
        por_ue[(u["inciso"], u["ue"])].append((u["buyer_name"], u["buyer_id"]))
    por_inc = defaultdict(list)
    for (inc_, ue_), compradores in por_ue.items():
        por_inc[inc_].append({"inciso": inc_, "ue": ue_, "compradores": compradores})
    for inc, us in sorted(por_inc.items(), key=lambda kv: int(kv[0]) if kv[0].isdigit() else 0):
        ruta = a.datos / f"gasto/inciso_{inc}.json"
        doc = json.loads(ruta.read_text(encoding="utf-8"))
        raiz = doc["nodo"]
        limpiar(raiz)
        for u in us:
            ue = next(h for h in raiz["hijos"] if h["codigo"] == u["ue"])
            rubros = hojas_rubro(ue)
            filas = con.execute(
                """select i.classification_id, i.classification_description, i.supplier_name, i.monto_total,
                          r.id, r.objeto_compra, r.fecha_compra, r.resolucion, i.quantity, i.unit_name
                   from releases r join items i on i.release_id=r.id
                   where """ + " or ".join(["(r.buyer_name=? and r.buyer_id=?)"] * len(u["compradores"])),
                [x for par in u["compradores"] for x in par]).fetchall()
            res = {"adjudicado": 0, "sin_monto": 0, "sin_rubro": 0, "asignado": 0, "escalado": 0, "renglones": len(filas)}
            # rubro -> artículo(id,desc) -> proveedor -> monto (pesos enteros)
            acu = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))
            refs = {}; sin_rubro = defaultdict(float); tipo_de = {}; nom_orig = {}; det = defaultdict(dict); sin_monto = defaultdict(dict)
            for cid, desc, prov, monto, rid, objeto, fecha, estado, cant, unidad in filas:
                rubro, tipo = clasificar(desc or "", reglas, rubros)
                if rubro: tipo_de.setdefault(rubro, tipo)
                if monto is None:
                    res["sin_monto"] += 1
                    if rubro in rubros:
                        sm = sin_monto[rubro].setdefault(rid, {"rid": rid, "objeto": acentuar((objeto or "Compra sin descripción").strip()),
                            "fecha": fecha, "estado": estado, "proveedor": (prov or "Proveedor sin nombre").strip().title(),
                            "articulo": acentuar((desc or "").split(" (Cód")[0].strip().capitalize()), "cantidad": 0.0, "unidad": None})
                        sm["cantidad"] += 1; sm["unidades"] = sm.get("unidades", 0) + (cant or 0); sm["unidad"] = unidad
                    continue
                res["adjudicado"] += monto
                if rubro is None or rubro not in rubros:
                    res["sin_rubro"] += monto; sin_rubro[(desc or "").split(" (Cód")[0]] += monto; continue
                nom_orig.setdefault(str(cid), acentuar((desc or "").split(" (Cód")[0].strip().capitalize()))
                art = (str(cid), nom_orig[str(cid)])
                pnom = (prov or "Proveedor sin nombre").strip().title()
                acu[rubro][art][pnom] += monto
                d = det[(rubro, art, pnom)].setdefault(rid, [acentuar((objeto or "Compra sin descripción").strip()), fecha, estado, 0.0])
                d[3] += monto
            for rubro, arts in acu.items():
                ocurr = rubros[rubro]
                tipo_pref = tipo_de[rubro]
                # primero el programa/tipo que la regla prefiere; dentro de eso, el de mayor crédito
                ocurr = sorted(ocurr, key=lambda rt: (rt[1] != tipo_pref, -rt[0]["valor"]))
                cred_tot = sum(r["valor"] for r, _ in ocurr)
                lineas = sorted(((m, art, p) for art, pv in arts.items() for p, m in pv.items()), reverse=True)
                comp_tot = sum(m for m, _, _ in lineas)
                if comp_tot > cred_tot: res["escalado"] += comp_tot - cred_tot
                # llenado secuencial: cada ocurrencia recibe líneas hasta agotar su crédito; lo que sobra
                # (se adjudicó más que lo autorizado) va a la primera, SIN recortar los montos reales
                cola = [[m, art, p] for m, art, p in lineas]
                asignaciones = []
                for r, tipo in ocurr:
                    cap = float(r["valor"]); mios = defaultdict(lambda: defaultdict(float))
                    while cola and cap > 0.5:
                        m, art, p = cola[0]
                        t = min(m, cap)
                        mios[art][p] += t; cap -= t
                        if t >= m - 1e-9: cola.pop(0)
                        else: cola[0][0] = m - t
                    asignaciones.append(mios)
                for m, art, p in cola:
                    asignaciones[0][art][p] += m
                for (r, tipo), mios in zip(ocurr, asignaciones):
                    if not mios: continue
                    art_nodos = []
                    for art, pesos in mios.items():
                        v_art = int(sum(pesos.values()))
                        if v_art > 0: art_nodos.append((art[0], art[1], v_art, pesos))
                    art_nodos.sort(key=lambda x: -x[2])
                    hijos = []
                    for cid, nom, v_art, pesos in art_nodos:
                        pv = repartir(v_art, {p: int(m) + 1 for p, m in pesos.items()})
                        pv_nodos = []
                        for p, v in sorted(pv.items(), key=lambda x: -x[1]):
                            rel = det[(rubro, (cid, nom_orig[cid]), p)]
                            rp = repartir(v, {k: int(x[3]) + 1 for k, x in rel.items()})
                            hojas = []
                            for k, vv in sorted(rp.items(), key=lambda x: -x[1]):
                                o, fch, est, _ = rel[k]
                                hojas.append(nodo(f"{r['id']}/c{cid}/{pslug(p)}/r{k}", (o[:90] + "…") if len(o) > 90 else o, f"r{k}", vv, r["fuentes"],
                                                  compras=True, nivel="Compra", rid=str(k), fecha=fch, estado=est))
                            pv_nodos.append(nodo(f"{r['id']}/c{cid}/{pslug(p)}", p, pslug(p), v, r["fuentes"], hojas or None,
                                                 compras=True, nivel="Proveedor", nivel_hijos="Compra"))
                        hijos.append(nodo(f"{r['id']}/c{cid}", nom, f"c{cid}", v_art, r["fuentes"], pv_nodos, compras=True,
                                          nivel="Artículo comprado", nivel_hijos="Proveedor"))
                    tot_art = sum(h["valor"] for h in hijos)
                    resto = r["valor"] - tot_art
                    if resto > 0:
                        hijos.append(nodo(f"{r['id']}/resto", "Resto sin detalle de compra", "resto", resto, r["fuentes"], compras_resto=True, nivel="Resto del rubro"))
                    hijos.sort(key=lambda h: -h["valor"])
                    refs[r["id"]] = {"hijos": hijos}
                    r["nivel_hijos"] = "Artículo comprado"
                    r["compras"] = {"adjudicado": int(tot_art), "excede": tot_art > r["valor"]}
                    res["asignado"] += tot_art
            for rubro, rels in sin_monto.items():
                ocurr = sorted(rubros[rubro], key=lambda rt: (rt[1] != tipo_de.get(rubro), -rt[0]["valor"]))
                lista = sorted(rels.values(), key=lambda x: (-x.get("unidades", 0), x["rid"]))[:100]
                refs.setdefault(ocurr[0][0]["id"], {})["compras_sin_monto"] = [
                    {"rid": x["rid"], "objeto": x["objeto"], "fecha": x["fecha"], "estado": x["estado"], "proveedor": x["proveedor"],
                     "articulo": x["articulo"], "unidades": x.get("unidades"), "unidad": (x["unidad"] or "").lower(),
                     "enlaces": enlaces_compra(x["rid"], bool(x["estado"]))} for x in lista]
                ocurr[0][0].setdefault("compras", {"adjudicado": 0, "excede": False})
                res["compras_sin_monto"] = res.get("compras_sin_monto", 0) + len(rels)
            if refs:
                rel = f"compras/{inc}_{u['ue']}.json"
                for nid, dat in refs.items():
                    nodo_r = buscar(ue, nid)
                    nodo_r["compras_ref"] = rel
                (a.datos / rel).parent.mkdir(parents=True, exist_ok=True)
                (a.datos / rel).write_text(json.dumps(refs, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            ue["compras_resumen"] = {k: int(v) for k, v in res.items()}
            print(f"{inc}/{u['ue']} {ue['nombre'][:40]}: adjudicado {res['adjudicado']/1e6:.1f} M | asignado a rubro {res['asignado']/1e6:.1f} M | "
                  f"sin rubro {res['sin_rubro']/1e6:.1f} M | adjudicado por encima del crédito {res['escalado']/1e6:.1f} M | renglones sin monto {res['sin_monto']}/{res['renglones']}")
            for d, m in sorted(sin_rubro.items(), key=lambda x: -x[1])[:25]:
                print(f"     sin regla: {m/1e6:6.2f}  {d}")
        ruta.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
