# -*- coding: utf-8 -*-
"""
generar.py: genera las bajadas de una zona y las guarda en archivos listos para la app.

Uso (ver LEEME.md):
    python generar.py descargar --zona maresme --contacto tu@correo.com
    python generar.py generar   --zona maresme --contacto tu@correo.com

  descargar: baja de OpenStreetMap (Overpass) los senderos con etiquetas MTB de la zona
             y los guarda en datos/osm_<zona>.json. Sirve para zonas pequeñas (lento y limitado).
  extraer:   igual que descargar, pero leyendo un archivo local .osm.pbf (Geofabrik). Mucho más rápido
             y sin depender de servidores públicos: es la vía recomendada para zonas grandes.
             Requiere:  pip install osmium
             python generar.py extraer --zona cataluna --pbf datos/cataluna-latest.osm.pbf
  generar:   agrupa los tramos en bajadas, comprueba el sentido y calcula el perfil con la elevación
             del IGN, y escribe los resultados en salida/<zona>/ por cuadrículas de 0,1 grados.
"""
import argparse
import csv
import json
import math
import os
import shutil
import sys
import time
from datetime import datetime, timezone

from bajadas_osm import COLOR_HEX, FILTRAR_RUDAS, candidatas, evaluar, motivo_rudo, tramos_validos
from elevacion_ign import Elevacion, ErrorTesela

VERSION = 1
CELDA = 0.1   # tamaño de cuadrícula en grados (~11 km)

# [sur, oeste, norte, este]
ZONAS = {
    "maresme": (41.486080,2.263184,41.686256,2.609940),
    # Cataluña entera (aprox.). Para otras zonas: añade una línea o usa --bbox
    "cataluna": (40.52, 0.15, 42.87, 3.33),
}

OVERPASS = "https://overpass.private.coffee/api/interpreter"


def celda_de(lat, lon):
    return math.floor(lat / CELDA + 1e-9), math.floor(lon / CELDA + 1e-9)


def nombre_celda(fila, col):
    return "%d_%d" % (fila, col)


# --- 1. Descarga de OpenStreetMap -----------------------------------------------------
def consulta(s, w, n, e, sin_etiqueta=False):
    b = "%s,%s,%s,%s" % (s, w, n, e)
    hw = '["highway"~"^(path|track)$"]'
    q = ('way%s["mtb:scale"](%s);way%s["mtb:scale:imba"](%s);way%s["mtb:name"](%s);' % (hw, b, hw, b, hw, b))
    if sin_etiqueta:
        # senderos sin etiqueta MTB, excluyendo prohibidos, privados y los de senderismo duro
        q += ('way["highway"="path"]["bicycle"!~"^(no|dismount)$"]["access"!~"^(private|no)$"]'
              '["sac_scale"!~"^(demanding_mountain_hiking|alpine_hiking|demanding_alpine_hiking|difficult_alpine_hiking)$"](%s);' % b)
    return "[out:json][timeout:120];(%s);out body geom qt;" % q


SUB = 2   # cada cuadrícula de 0,1 grados se pide en SUB x SUB trozos (consultas más ligeras)


def descargar(zona, bbox, contacto, servidor, destino, sin_etiqueta=False):
    import requests
    s0, w0, n0, e0 = bbox
    f0, c0 = celda_de(s0, w0)
    f1, c1 = celda_de(n0 - 1e-9, e0 - 1e-9)
    paso = CELDA / SUB
    trozos = []
    for f in range(f0, f1 + 1):
        for c in range(c0, c1 + 1):
            for i in range(SUB):
                for j in range(SUB):
                    trozos.append((round(f * CELDA + i * paso, 4), round(c * CELDA + j * paso, 4)))
    print("Descargando %d trozos de OpenStreetMap (%s)%s..." %
          (len(trozos), servidor, " incluyendo senderos sin etiqueta MTB" if sin_etiqueta else ""))

    # Punto de control: si se corta, al volver a ejecutar continúa donde se quedó
    parcial = destino + ".parcial"
    hechos, elementos, base = set(), [], ""
    if os.path.exists(parcial):
        with open(parcial, encoding="utf-8") as fh:
            pc = json.load(fh)
        if pc.get("sin_etiqueta") == sin_etiqueta:
            hechos = {tuple(x) for x in pc["hechos"]}
            elementos, base = pc["elementos"], pc.get("base", "")
            print("Reanudando: %d trozos ya descargados." % len(hechos))
    vistos = {(el.get("type"), el.get("id")) for el in elementos}

    ses = requests.Session()
    ses.headers["User-Agent"] = "generador-bajadas-mtb/1.0" + (" (contacto: %s)" % contacto if contacto else "")
    os.makedirs(os.path.dirname(destino), exist_ok=True)
    for i, (s, w) in enumerate(trozos, 1):
        if (s, w) in hechos:
            continue
        n, e = round(s + paso, 4), round(w + paso, 4)
        data = None
        for intento in range(4):
            try:
                r = ses.post(servidor, data={"data": consulta(s, w, n, e, sin_etiqueta)}, timeout=150)
                if r.status_code != 200:
                    raise RuntimeError("HTTP %d" % r.status_code)
                data = r.json()
                if data.get("remark") and "error" in data["remark"].lower():
                    raise RuntimeError(data["remark"])
                break
            except Exception as ex:
                espera = 15 * (intento + 1)
                print("  trozo %d/%d: fallo (%s); reintento en %d s" % (i, len(trozos), ex, espera))
                time.sleep(espera)
        if data is None:
            sys.exit("No se ha podido descargar el trozo %d/%d. Vuelve a ejecutar: continuará desde aquí." % (i, len(trozos)))
        nuevos = 0
        for el in data.get("elements", []):
            k = (el.get("type"), el.get("id"))
            if k not in vistos:
                vistos.add(k)
                elementos.append(el)
                nuevos += 1
        base = max(base, (data.get("osm3s") or {}).get("timestamp_osm_base", ""))
        hechos.add((s, w))
        print("  trozo %d/%d: %d tramos nuevos" % (i, len(trozos), nuevos))
        with open(parcial, "w", encoding="utf-8") as fh:
            json.dump({"sin_etiqueta": sin_etiqueta, "hechos": sorted(hechos), "elementos": elementos, "base": base},
                      fh, ensure_ascii=False)
        time.sleep(3)   # cortesía con el servidor
    with open(destino, "w", encoding="utf-8") as fh:
        json.dump({"osm3s": {"timestamp_osm_base": base}, "elements": elementos}, fh, ensure_ascii=False)
    os.remove(parcial)
    print("Guardado %s (%d tramos). Datos de OSM de: %s" % (destino, len(elementos), base or "fecha desconocida"))


# --- 1b. Extracción desde un archivo local .osm.pbf (alternativa a Overpass) ------------------
SAC_DUROS = {"demanding_mountain_hiking", "alpine_hiking", "demanding_alpine_hiking", "difficult_alpine_hiking"}


def tramo_interesa(tags, sin_etiqueta=False):
    """Mismos criterios que consulta(): devuelve True si el tramo debe guardarse."""
    if tags.get("highway") in ("path", "track"):
        if "mtb:scale" in tags or "mtb:scale:imba" in tags or "mtb:name" in tags:
            return True
    if sin_etiqueta and tags.get("highway") == "path":
        # En Overpass, ["x"!~"..."] también cumple si la etiqueta no existe: aquí igual.
        if (tags.get("bicycle") not in ("no", "dismount") and tags.get("access") not in ("private", "no")
                and tags.get("sac_scale") not in SAC_DUROS):
            return True
    return False


def elemento_overpass(way_id, tags, nodos):
    """Convierte un tramo a la misma forma que devuelve Overpass con 'out body geom'.
    nodos = [(ref, lat, lon), ...]"""
    lats = [n[1] for n in nodos]
    lons = [n[2] for n in nodos]
    return {
        "type": "way", "id": way_id,
        "bounds": {"minlat": min(lats), "minlon": min(lons), "maxlat": max(lats), "maxlon": max(lons)},
        "nodes": [n[0] for n in nodos],
        "geometry": [{"lat": n[1], "lon": n[2]} for n in nodos],
        "tags": dict(tags),
    }


def en_bbox(nodos, bbox):
    """Como Overpass: el tramo entra si alguno de sus puntos cae dentro del bbox (se guarda entero)."""
    if bbox is None:
        return True
    s, w, n, e = bbox
    return any(s <= lat <= n and w <= lon <= e for _, lat, lon in nodos)


def extraer(zona, bbox, pbf, destino, sin_etiqueta=False, idx="flex_mem"):
    try:
        import osmium
    except ImportError:
        sys.exit("Falta la librería osmium. Instálala con:  pip install osmium")
    if not os.path.exists(pbf):
        sys.exit("No existe %s. Descárgalo de https://download.geofabrik.de/europe/spain.html" % pbf)

    elementos, vistos, sin_geom = [], set(), [0]

    class Lector(osmium.SimpleHandler):
        def way(self, w):
            tags = {t.k: t.v for t in w.tags}
            if not tramo_interesa(tags, sin_etiqueta):
                return
            try:
                nodos = [(n.ref, n.lat, n.lon) for n in w.nodes]
            except Exception:       # nodos fuera del extracto (tramo cortado en el borde)
                sin_geom[0] += 1
                return
            if len(nodos) < 2 or not en_bbox(nodos, bbox):
                return
            if w.id not in vistos:
                vistos.add(w.id)
                elementos.append(elemento_overpass(w.id, tags, nodos))

    print("Leyendo %s (puede tardar unos minutos)..." % pbf)
    t0 = time.time()
    Lector().apply_file(pbf, locations=True, idx=idx)
    base = ""
    try:
        rd = osmium.io.Reader(pbf)
        base = rd.header().get("osmosis_replication_timestamp") or ""
        rd.close()
    except Exception:
        pass
    os.makedirs(os.path.dirname(destino), exist_ok=True)
    with open(destino, "w", encoding="utf-8") as fh:
        json.dump({"osm3s": {"timestamp_osm_base": base}, "elements": elementos}, fh, ensure_ascii=False)
    print("Guardado %s: %d tramos (%d descartados por geometría incompleta). Datos de OSM de: %s. %.0f s" %
          (destino, len(elementos), sin_geom[0], base or "fecha desconocida", time.time() - t0))
    if not elementos:
        print("AVISO: no se ha encontrado ningún tramo. Revisa que el .pbf cubra la zona y el --bbox.")


# --- 2. Procesado: el mismo flujo que cargarZona() de la app -----------------------------
def procesar(data, elev, log=print):
    ways, pistas = tramos_validos(data)
    log("%d tramos con etiquetas MTB (%d pistas de coche descartadas). Agrupando..." % (len(ways), pistas))
    cands = candidatas(ways)
    log("%d candidatas a bajada (de al menos 150 m)." % len(cands))

    # Comprobar el sentido con la elevación de los dos extremos
    extremos = []
    for c in cands:
        extremos.append(c["pts"][0])
        extremos.append(c["pts"][-1])
    log("Comprobando el sentido de cada bajada...")
    elev.obtener(extremos)

    validas, dudosas, sin_cota = [], 0, 0
    for c in cands:
        ini, fin = c["pts"][0], c["pts"][-1]
        e0, e1 = elev.ele(ini[0], ini[1]), elev.ele(fin[0], fin[1])
        hay_cota = e0 is not None and e1 is not None
        r = evaluar(c, e0, e1) if hay_cota else None
        if r is None:
            if hay_cota:
                dudosas += 1
            else:
                sin_cota += 1
            continue
        validas.append(r)
    log("%d con sentido fiable, %d descartadas por sentido dudoso, %d sin datos de elevación." %
        (len(validas), dudosas, sin_cota))

    # Perfil completo de cada bajada
    log("Calculando el perfil de %d bajadas..." % len(validas))
    resultado, retiradas, rudas = [], [], 0
    for i, r in enumerate(validas, 1):
        ok, motivo = elev.cargar_perfil(r["feature"])
        if ok:
            p = r["feature"]["properties"]
            if FILTRAR_RUDAS and p["origen"] == "inferida":
                m = motivo_rudo(p)
                if m:
                    rudas += 1
                    retiradas.append((p["id"], "rudo: " + m))
                    continue
            resultado.append(r)
        else:
            retiradas.append((r["feature"]["properties"]["id"], motivo))
        if i % 50 == 0:
            log("    %d/%d" % (i, len(validas)))
    log("%d bajadas finales (%d retiradas: %d por rudeza)." % (len(resultado), len(retiradas), rudas))
    stats = {
        "tramos_mtb": len(ways), "pistas_descartadas": pistas, "candidatas": len(cands),
        "sentido_dudoso": dudosas, "sin_elevacion": sin_cota, "retiradas_en_perfil": len(retiradas) - rudas,
        "descartadas_por_rudeza": rudas,
        "bajadas": len(resultado),
    }
    return {"bajadas": resultado, "retiradas": retiradas, "stats": stats}


# --- 3. Escritura de resultados ------------------------------------------------------
def celdas_tocadas(feature):
    return sorted({celda_de(lat, lon) for lon, lat, *_ in feature["geometry"]["coordinates"]})


def escribir(zona, bbox, res, osm_base, dir_salida):
    dir_celdas = os.path.join(dir_salida, "celdas")
    dir_rev = os.path.join(dir_salida, "revision")
    for d in (dir_celdas, dir_rev):
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)

    por_celda = {}
    for r in res["bajadas"]:
        for fc in celdas_tocadas(r["feature"]):
            por_celda.setdefault(fc, []).append({"f": r["feature"], "tramos": r["tramos"]})
    generado = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    indice_celdas = {}
    for (fila, col), lista in sorted(por_celda.items()):
        nom = nombre_celda(fila, col)
        lista.sort(key=lambda b: b["f"]["properties"]["id"])
        with open(os.path.join(dir_celdas, nom + ".json"), "w", encoding="utf-8") as fh:
            json.dump({"v": VERSION, "celda": nom, "bajadas": lista}, fh, ensure_ascii=False, separators=(",", ":"))
        indice_celdas[nom] = len(lista)

    indice = {
        "v": VERSION, "zona": zona, "bbox": list(bbox), "celda_grados": CELDA,
        "generado": generado, "osm_base": osm_base, "celdas": indice_celdas,
        "estadisticas": res["stats"], "completo": True,
        "atribucion": "© colaboradores de OpenStreetMap (ODbL) · Elevación: MDT05 © IGN (CC BY 4.0)",
    }
    with open(os.path.join(dir_salida, "indice.json"), "w", encoding="utf-8") as fh:
        json.dump(indice, fh, ensure_ascii=False, indent=1)

    # Para revisar a ojo: arrastra bajadas.geojson a https://geojson.io
    feats = []
    for r in res["bajadas"]:
        f = json.loads(json.dumps(r["feature"]))
        p = f["properties"]
        f["properties"] = {
            "title": p["nombre"] or p["id"], "id": p["id"], "longitud_m": p["longitud_m"], "caida_m": p["caida_m"],
            "pend_media_%": p["pendiente_media_pct"], "dificultad": p["dificultad_color"] or "sin dato",
            "fiabilidad": p["fiabilidad"], "stroke": COLOR_HEX.get(p["dificultad_color"], "#9e9e9e"), "stroke-width": 3,
        }
        feats.append(f)
    with open(os.path.join(dir_rev, "bajadas.geojson"), "w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": feats}, fh, ensure_ascii=False)
    with open(os.path.join(dir_rev, "resumen.csv"), "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh, delimiter=";")
        w.writerow(["id", "nombre", "longitud_m", "caida_m", "pendiente_media_pct", "pendiente_max_100m_pct",
                    "dificultad", "fiabilidad", "origen", "n_tramos", "surface", "smoothness", "sac_scale", "trail_visibility"])
        for r in sorted(res["bajadas"], key=lambda r: r["feature"]["properties"]["id"]):
            p = r["feature"]["properties"]
            w.writerow([p["id"], p["nombre"] or "", p["longitud_m"], p["caida_m"], p["pendiente_media_pct"],
                        p.get("pendiente_max_100m_pct", ""), p["dificultad_color"] or "", p["fiabilidad"],
                        p["origen"], p["n_tramos"], p.get("surface") or "", p.get("smoothness") or "",
                        p.get("sac_scale") or "", p.get("trail_visibility") or ""])
    with open(os.path.join(dir_rev, "retiradas.csv"), "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh, delimiter=";")
        w.writerow(["id", "motivo"])
        w.writerows(res["retiradas"])
    print("Escrito en %s: %d bajadas en %d cuadrículas." % (dir_salida, len(res["bajadas"]), len(indice_celdas)))


# --- CLI -----------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="Generador de bajadas MTB")
    ap.add_argument("orden", choices=["descargar", "extraer", "generar"])
    ap.add_argument("--zona", default="maresme", help="nombre de la zona (por defecto, maresme)")
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("SUR", "OESTE", "NORTE", "ESTE"),
                    help="zona propia, en grados (sustituye a la zona por nombre)")
    ap.add_argument("--contacto", default="", help="tu correo: se envía a OSM e IGN para que puedan contactarte")
    ap.add_argument("--sin-etiqueta", action="store_true",
                    help="al descargar, incluir también senderos sin etiqueta MTB (se marcarán como 'inferida')")
    ap.add_argument("--pbf", help="(extraer) archivo .osm.pbf local, p. ej. datos/spain-latest.osm.pbf")
    ap.add_argument("--idx", default="flex_mem",
                    help="(extraer) índice de nodos de osmium. Para extractos enormes: sparse_file_array,datos/nodos.tmp")
    ap.add_argument("--servidor", default=OVERPASS, help="servidor Overpass (por defecto private.coffee)")
    a = ap.parse_args()

    bbox = tuple(a.bbox) if a.bbox else ZONAS.get(a.zona)
    if not bbox:
        sys.exit("Zona desconocida. Usa --bbox SUR OESTE NORTE ESTE o añádela a ZONAS en generar.py")
    datos = os.path.join("datos", "osm_%s.json" % a.zona)
    salida = os.path.join("salida", a.zona)

    if a.orden == "descargar":
        descargar(a.zona, bbox, a.contacto, a.servidor, datos, a.sin_etiqueta)
        return
    if a.orden == "extraer":
        if not a.pbf:
            sys.exit("Indica el archivo con --pbf, p. ej. --pbf datos/cataluna-latest.osm.pbf")
        extraer(a.zona, bbox, a.pbf, datos, a.sin_etiqueta, a.idx)
        return
    if not os.path.exists(datos):
        sys.exit("Falta %s. Ejecuta primero: python generar.py descargar --zona %s" % (datos, a.zona))
    with open(datos, encoding="utf-8") as fh:
        data = json.load(fh)
    t0 = time.time()
    elev = Elevacion(contacto=a.contacto)
    try:
        res = procesar(data, elev)
    except ErrorTesela as e:
        sys.exit("\n" + str(e))
    escribir(a.zona, bbox, res, (data.get("osm3s") or {}).get("timestamp_osm_base", ""), salida)
    print("Tiempo total: %.0f s" % (time.time() - t0))


if __name__ == "__main__":
    main()
