# -*- coding: utf-8 -*-
"""
diagnostico.py: explica por qué una bajada concreta sale, o no sale, en el resultado.

Uso:
    python diagnostico.py --zona maresme --nombre "glory"
    python diagnostico.py --zona maresme --cerca 41.5890 2.4930
    python diagnostico.py --zona maresme --way 1223484750
    python diagnostico.py --zona maresme --nombre "glory" --cerca 41.5890 2.4930 --contacto tu@correo.com

  --nombre  busca (sin distinguir mayúsculas ni tildes) en los nombres de OpenStreetMap.
  --way     número de vía de OpenStreetMap (el que sale en openstreetmap.org/way/NÚMERO).
  --cerca   lista todos los senderos que pasan a menos de 150 m de ese punto (latitud longitud).
            Para sacar las coordenadas: en Google Maps, clic derecho sobre la bajada y pulsa sobre los números.

Hace dos cosas:
  1. Mira en los datos que ya descargaste (datos/osm_<zona>.json) y explica qué pasó con cada tramo.
  2. Pregunta en vivo a OpenStreetMap (necesita internet) qué hay realmente ahí, con TODAS sus etiquetas,
     incluso si no tienen etiquetas MTB y por eso no se descargaron.
"""
import argparse
import glob
import json
import os
import sys
import unicodedata

from bajadas_osm import (MIN_CAIDA_M, MIN_LENGTH_M, MIN_PEND_PCT, ANCHO_MIN_PISTA_M, MOTOR_SI, SUPERFICIE_ASFALTO,
                         TRACKTYPE_PISTA, TRACKTYPE_RUDO, candidatas, es_pista_de_coche, evaluar, parse_entero,
                         parse_num, path_length, tiene_mtb, tramos_validos)
from elevacion_ign import Elevacion, ErrorTesela
from generar import OVERPASS, ZONAS


def norm(s):
    s = unicodedata.normalize("NFKD", str(s or ""))
    return "".join(c for c in s if not unicodedata.combining(c)).lower().strip()


def etiquetas_nombre(tags):
    return [tags.get(k) for k in ("name", "mtb:name", "alt_name", "ref", "official_name", "description") if tags.get(k)]


def motivo_filtro(tags):
    """Por qué tramos_validos() descartaría este tramo (o None si lo conserva)."""
    if tags.get("bicycle") in ("no", "dismount"):
        return "bicycle=%s (prohibido para bicis)" % tags.get("bicycle")
    if tags.get("access") in ("private", "no"):
        return "access=%s (acceso privado o prohibido)" % tags.get("access")
    if es_pista_de_coche(tags):
        if tags.get("motor_vehicle") in MOTOR_SI or tags.get("motorcar") in MOTOR_SI:
            return "pista de coche (motor_vehicle/motorcar permitido)"
        if tags.get("surface") in SUPERFICIE_ASFALTO:
            return "pista de coche (surface=%s)" % tags.get("surface")
        a = parse_num(tags.get("width"))
        if a is not None and a >= ANCHO_MIN_PISTA_M:
            return "pista de coche (width=%s, %s m o más)" % (tags.get("width"), ANCHO_MIN_PISTA_M)
        return "pista de coche (highway=track sin indicios MTB: tracktype=%s)" % tags.get("tracktype", "sin tracktype")
    return None


def describir(tags):
    claves = ["highway", "name", "mtb:name", "mtb:scale", "mtb:scale:imba", "mtb:type", "bicycle", "access",
              "surface", "tracktype", "width", "smoothness", "incline", "oneway", "sac_scale", "trail_visibility"]
    return ", ".join("%s=%s" % (k, tags[k]) for k in claves if k in tags) or "(sin etiquetas)"


def ids_en_resultado(salida):
    vistos = {}
    for f in glob.glob(os.path.join(salida, "celdas", "*.json")):
        with open(f, encoding="utf-8") as fh:
            for b in json.load(fh)["bajadas"]:
                for w in b["f"]["properties"]["way_ids"]:
                    vistos[w] = b["f"]["properties"]
    return vistos


def local(a, data, salida):
    print("=" * 70)
    print("1) LO QUE HAY EN TUS DATOS DESCARGADOS (solo senderos con etiquetas MTB)")
    print("=" * 70)
    elementos = [e for e in data["elements"] if e.get("type") == "way" and e.get("geometry")]
    buscados = []
    if a.way:
        buscados = [e for e in elementos if e["id"] in a.way]
        print("Tramos con ese número de vía: %d" % len(buscados))
        if not buscados:
            print("→ Esa vía NO está en los datos descargados (apartado 2 para ver por qué).")
    if a.nombre:
        n = norm(a.nombre)
        buscados = [e for e in elementos if any(n in norm(x) for x in etiquetas_nombre(e.get("tags") or {}))]
        print("Tramos cuyo nombre contiene «%s»: %d" % (a.nombre, len(buscados)))
    if a.cerca:
        lat, lon = a.cerca
        grados = 0.0015   # ~150 m
        cerca = [e for e in elementos if any(abs(p["lat"] - lat) < grados and abs(p["lon"] - lon) < grados * 1.3
                                              for p in e["geometry"])]
        ya = {e["id"] for e in buscados}
        buscados += [e for e in cerca if e["id"] not in ya]
        print("Tramos a menos de ~150 m del punto: %d" % len(cerca))
    if not buscados and not a.way:
        print("\n→ NO HAY NINGÚN TRAMO. Esa bajada no está en lo que se descargó: o no existe en OpenStreetMap,")
        print("  o existe pero SIN etiquetas MTB (mtb:scale, mtb:scale:imba, mtb:name), y el generador solo")
        print("  descarga las que las tienen. Mira el apartado 2 para saber cuál de las dos.")
        return

    ways, _ = tramos_validos(data)
    por_id = {w["id"]: w for w in ways}
    cands = candidatas(ways)
    cand_de = {}
    for c in cands:
        for w in c["ways"]:
            cand_de[w["id"]] = c
    en_resultado = ids_en_resultado(salida)
    elev = Elevacion(log=lambda *_: None)
    for e in buscados[:15]:
        tags = e.get("tags") or {}
        long_m = path_length([[p["lat"], p["lon"]] for p in e["geometry"]])
        print("\n--- tramo %d (%.0f m) ---" % (e["id"], long_m))
        print("    " + describir(tags))
        print("    https://www.openstreetmap.org/way/%d" % e["id"])
        if e["id"] in en_resultado:
            p = en_resultado[e["id"]]
            print("    ✓ SALE en el resultado, dentro de la bajada %s «%s» (%s m, caída %s m, dificultad %s)" %
                  (p["id"], p["nombre"] or "sin nombre", p["longitud_m"], p["caida_m"], p["dificultad_color"] or "sin dato"))
            continue
        m = motivo_filtro(tags)
        if m:
            print("    ✗ DESCARTADO al leer los datos: %s" % m)
            continue
        c = cand_de.get(e["id"])
        if c is None:
            print("    ✗ no forma parte de ninguna candidata")
            continue
        print("    Forma parte de la candidata %s: %d tramos unidos, %.0f m en total" %
              (c["id"], len(c["ways"]), c["longitud"]))
        if len(c["ways"]) > 1:
            print("    (tramos unidos: %s)" % ", ".join(str(w["id"]) for w in c["ways"]))
        ini, fin = c["pts"][0], c["pts"][-1]
        try:
            elev.obtener([ini, fin])
        except ErrorTesela as ex:
            print("    (no se pudo consultar la elevación: %s)" % ex)
            continue
        e0, e1 = elev.ele(ini[0], ini[1]), elev.ele(fin[0], fin[1])
        if e0 is None or e1 is None:
            print("    ✗ DESCARTADO: sin datos de elevación del IGN en un extremo (fuera de España o hueco del MDT05)")
            continue
        caida = abs(e0 - e1)
        pend = caida / c["longitud"] * 100
        print("    Extremos: %.1f m y %.1f m → caída %.1f m, pendiente media %.1f %%" % (e0, e1, caida, pend))
        if caida < MIN_CAIDA_M or pend < MIN_PEND_PCT:
            print("    ✗ DESCARTADO por sentido dudoso: se pide caída ≥ %d m y pendiente ≥ %d %%" % (MIN_CAIDA_M, MIN_PEND_PCT))
            continue
        r = evaluar(c, e0, e1)
        ok, motivo = elev.cargar_perfil(r["feature"]) if r else (False, "no supera la evaluación")
        if ok:
            print("    ✓ Debería salir. Si no la ves, vuelve a ejecutar «generar» (quizá los datos son más recientes).")
        else:
            print("    ✗ RETIRADA al calcular el perfil: %s" % motivo)
    if len(buscados) > 15:
        print("\n(Se muestran los 15 primeros de %d.)" % len(buscados))


def en_vivo(a, bbox):
    import requests
    print()
    print("=" * 70)
    print("2) LO QUE HAY REALMENTE EN OPENSTREETMAP (en vivo, con todas las etiquetas)")
    print("=" * 70)
    consultas = []
    if a.way:
        consultas.append(("con ese número de vía", '[out:json][timeout:60];way(id:%s);out tags geom;' % ",".join(str(w) for w in a.way)))
    if a.nombre:
        n = a.nombre.replace('"', "")
        s, w, nn, e = bbox
        consultas.append(("con nombre parecido a «%s» en la zona" % a.nombre,
                          '[out:json][timeout:60];(way["name"~"%s",i](%s,%s,%s,%s);way["mtb:name"~"%s",i](%s,%s,%s,%s);'
                          'way["alt_name"~"%s",i](%s,%s,%s,%s););out tags geom;' % (n, s, w, nn, e, n, s, w, nn, e, n, s, w, nn, e)))
    if a.cerca:
        lat, lon = a.cerca
        consultas.append(("a menos de 150 m del punto",
                          '[out:json][timeout:60];way["highway"~"^(path|track|footway|bridleway|cycleway|service|unclassified|tertiary|residential)$"]'
                          '(around:150,%s,%s);out tags geom;' % (lat, lon)))
    ses = requests.Session()
    ses.headers["User-Agent"] = "generador-bajadas-mtb/1.0" + (" (contacto: %s)" % a.contacto if a.contacto else "")
    for titulo, q in consultas:
        try:
            r = ses.post(a.servidor, data={"data": q}, timeout=120)
            r.raise_for_status()
            els = r.json().get("elements", [])
        except Exception as ex:
            print("\nNo se pudo consultar OpenStreetMap (%s). Prueba con --servidor https://overpass-api.de/api/interpreter" % ex)
            return
        print("\nSenderos %s: %d" % (titulo, len(els)))
        for e in els[:20]:
            tags = e.get("tags") or {}
            long_m = path_length([[p["lat"], p["lon"]] for p in e.get("geometry", [])]) if e.get("geometry") else 0
            print("\n--- tramo %d (%.0f m) ---" % (e["id"], long_m))
            print("    " + describir(tags))
            print("    https://www.openstreetmap.org/way/%d" % e["id"])
            if tiene_mtb({"tags": tags}):
                print("    Tiene etiquetas MTB → el generador SÍ la descarga (mira el apartado 1 para ver qué pasó después).")
            else:
                print("    NO tiene etiquetas MTB (mtb:scale, mtb:scale:imba, mtb:name) → por eso el generador no la descarga.")
                m = motivo_filtro(tags) if tags.get("highway") in ("path", "track") else None
                if m:
                    print("    Además, aunque se descargara, se descartaría: %s" % m)


def main():
    ap = argparse.ArgumentParser(description="Diagnóstico de una bajada concreta")
    ap.add_argument("--zona", default="maresme")
    ap.add_argument("--nombre", help="parte del nombre de la bajada")
    ap.add_argument("--way", type=int, nargs="+", help="número(s) de vía de OpenStreetMap")
    ap.add_argument("--cerca", nargs=2, type=float, metavar=("LAT", "LON"), help="punto sobre la bajada")
    ap.add_argument("--servidor", default=OVERPASS)
    ap.add_argument("--contacto", default="")
    ap.add_argument("--sin-internet", action="store_true", help="solo el apartado 1 (datos ya descargados)")
    a = ap.parse_args()
    if not a.nombre and not a.cerca and not a.way:
        sys.exit("Indica --way, --nombre o --cerca. Ejemplo: python diagnostico.py --way 1223484750")
    datos = os.path.join("datos", "osm_%s.json" % a.zona)
    if not os.path.exists(datos):
        sys.exit("Falta %s. Ejecuta primero «descargar»." % datos)
    with open(datos, encoding="utf-8") as fh:
        data = json.load(fh)
    local(a, data, os.path.join("salida", a.zona))
    if not a.sin_internet:
        en_vivo(a, ZONAS.get(a.zona, (-90, -180, 90, 180)))


if __name__ == "__main__":
    main()
