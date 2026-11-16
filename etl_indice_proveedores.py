"""
etl_indice_proveedores.py - genera data/2025/indice_proveedores.json: un índice chico (un registro
por proveedor, no uno por cada vez que aparece) para que el buscador de las vistas 3D pueda ofrecer
proveedores del catálogo de compras estatales sin tener que descargar los ~100 MB de
data/2025/compras/*.json en el navegador.

Por cada nombre de proveedor (normalizado) se queda con la aparición de mayor monto, y le agrega el
nombre del organismo (vía data/2025/organismos.json) para mostrarlo como subtítulo en el buscador.

Se corre después de etl_compras.py:

    python etl_indice_proveedores.py
"""
import glob
import json
import re

RUTA_ORGANISMOS = 'data/2025/organismos.json'
RUTA_COMPRAS = 'data/2025/compras/*.json'
RUTA_SALIDA = 'data/2025/indice_proveedores.json'


def organismo_de(id_, organismos):
    m = re.match(r'^(gasto/[a-z]/\d+)', id_)
    if not m:
        return None
    o = organismos.get(m.group(1))
    return o['nombre'] if o else None


def normalizar(s):
    return ' '.join(s.split()).strip().lower()


def main():
    organismos = json.load(open(RUTA_ORGANISMOS, encoding='utf-8'))
    mejor = {}  # nombre normalizado -> {id, nombre, valor, organismo}

    def walk(n):
        if not isinstance(n, dict):
            return
        if n.get('nivel') == 'Proveedor':
            clave = normalizar(n['nombre'])
            valor = n.get('valor', 0) or 0
            actual = mejor.get(clave)
            if not actual or valor > actual['valor']:
                mejor[clave] = {
                    'id': n['id'], 'nombre': n['nombre'], 'valor': valor,
                    'organismo': organismo_de(n['id'], organismos),
                }
        for h in n.get('hijos') or []:
            walk(h)

    for ruta in sorted(glob.glob(RUTA_COMPRAS)):
        datos = json.load(open(ruta, encoding='utf-8'))
        for clave, nodo in datos.items():
            if clave == '__ue__':
                continue
            walk(nodo)

    lista = sorted(mejor.values(), key=lambda x: -x['valor'])
    salida = [{'id': x['id'], 'nombre': x['nombre'], 'valor': x['valor'], 'organismo': x['organismo']} for x in lista]
    with open(RUTA_SALIDA, 'w', encoding='utf-8') as f:
        json.dump(salida, f, ensure_ascii=False, separators=(',', ':'))
    print('proveedores únicos:', len(salida), '->', RUTA_SALIDA)


if __name__ == '__main__':
    main()
