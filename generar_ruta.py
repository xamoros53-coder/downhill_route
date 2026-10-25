#!/usr/bin/env python3
"""
Genera un GPX completo a partir de una selección ordenada de bajadas.

- Lee bajadas.geojson (el catálogo).
- Para cada par consecutivo, calcula el enlace con BRouter (fin de A -> inicio de B).
- Concatena: geometría de A + enlace + geometría de B + enlace + ...
- Escribe ruta.gpx con un waypoint en el inicio de cada bajada.

Uso:
  python generar_ruta.py id1 id2 id3
  python generar_ruta.py id1 id2 --perfil trekking --salida mi_ruta.gpx

Solo usa la librería estándar de Python 3.8+.
"""

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from xml.etree import ElementTree as ET

# ---------------------------------------------------------------------------
# CONFIGURACIÓN
# ---------------------------------------------------------------------------
CATALOGO = "bajadas.geojson"
SALIDA = "ruta.gpx"
BROUTER_URL = "https://brouter.de/brouter"
PERFIL = "mtb"            # prueba también "trekking", "fastbike", "safety"
TIMEOUT_S = 60
PAUSA_ENTRE_LLAMADAS_S = 1.0   # sé amable con el servicio público
MAX_SALTO_M = 80               # si el enlace empieza/termina más lejos, avisa


# ---------------------------------------------------------------------------
# UTILIDADES
# ---------------------------------------------------------------------------
def haversine(a, b):
    """Distancia en metros entre dos puntos (lat, lon)."""
    import math
    r = 6371000.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp = p2 - p1
    dl = math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def http_get(url, retries=3):
    headers = {"User-Agent": "ride-planner-piloto/0.1"}
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                return resp.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            wait = 10 * (attempt + 1)
            print(f"  HTTP {e.code}, reintentando en {wait}s...", file=sys.stderr)
            time.sleep(wait)
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"  Error de red ({e}), reintentando...", file=sys.stderr)
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"No se pudo obtener {url}")


# ---------------------------------------------------------------------------
# CARGA DEL CATÁLOGO
# ---------------------------------------------------------------------------
def cargar_catalogo(path):
    with open(path, encoding="utf-8") as f:
        gj = json.load(f)
    por_id = {}
    for feat in gj["features"]:
        p = feat["properties"]
        if not p.get("es_bajada"):
            continue
        por_id[p["id"]] = feat
    return por_id


# ---------------------------------------------------------------------------
# LLAMADA A BROUTER
# ---------------------------------------------------------------------------
def llamar_brouter(lon1, lat1, lon2, lat2, perfil):
    """Devuelve el GPX (texto) del enlace entre dos puntos."""
    lonlats = f"{lon1},{lat1}|{lon2},{lat2}"
    params = urllib.parse.urlencode({
        "lonlats": lonlats,
        "profile": perfil,
        "format": "gpx",
    })
    url = f"{BROUTER_URL}?{params}"
    return http_get(url)


def parsear_gpx_puntos(gpx_texto):
    """Extrae lista de (lat, lon, ele|None) del GPX de BRouter."""
    puntos = []
    try:
        root = ET.fromstring(gpx_texto)
    except ET.ParseError as e:
        raise RuntimeError(f"GPX de BRouter no parseable: {e}")
    # Los GPX de BRouter usan namespace estándar
    ns = {"g": "http://www.topografix.com/GPX/1/1"}
    for trkpt in root.findall(".//g:trkpt", ns):
        lat = float(trkpt.get("lat"))
        lon = float(trkpt.get("lon"))
        ele_el = trkpt.find("g:ele", ns)
        ele = float(ele_el.text) if ele_el is not None else None
        puntos.append((lat, lon, ele))
    return puntos


# ---------------------------------------------------------------------------
# ENSAMBLADO
# ---------------------------------------------------------------------------
def punto_inicio(feat):
    p = feat["properties"]
    if p.get("inicio"):
        return (p["inicio"][1], p["inicio"][0])  # (lat, lon)
    c = feat["geometry"]["coordinates"][0]
    return (c[1], c[0])


def punto_fin(feat):
    p = feat["properties"]
    if p.get("fin"):
        return (p["fin"][1], p["fin"][0])
    c = feat["geometry"]["coordinates"][-1]
    return (c[1], c[0])


def geometria_bajada(feat):
    """Lista de (lat, lon, ele|None) de la geometría de la bajada."""
    return [(c[1], c[0], c[2] if len(c) > 2 else None)
            for c in feat["geometry"]["coordinates"]]


def escribir_gpx(puntos, waypoints, path):
    """Escribe un GPX 1.1 simple con un track y los waypoints indicados."""
    def esc(t):
        return (str(t).replace("&", "&amp;").replace("<", "&lt;")
                .replace(">", "&gt;").replace('"', "&quot;"))

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="ride-planner-piloto"',
        '     xmlns="http://www.topografix.com/GPX/1/1">',
        '  <metadata><name>Ruta Ride Planner</name></metadata>',
    ]
    for w in waypoints:
        lines.append(f'  <wpt lat="{w["lat"]:.6f}" lon="{w["lon"]:.6f}">')
        lines.append(f'    <name>{esc(w["name"])}</name>')
        lines.append('  </wpt>')
    lines.append('  <trk>')
    lines.append('    <name>Ruta</name>')
    lines.append('    <trkseg>')
    for lat, lon, ele in puntos:
        lines.append(f'      <trkpt lat="{lat:.6f}" lon="{lon:.6f}">')
        if ele is not None:
            lines.append(f'        <ele>{ele:.1f}</ele>')
        lines.append('      </trkpt>')
    lines.append('    </trkseg>')
    lines.append('  </trk>')
    lines.append('</gpx>')

    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


# ---------------------------------------------------------------------------
# PRINCIPAL
# ---------------------------------------------------------------------------
def main():
    args = sys.argv[1:]
    if not args:
        print("Uso: python generar_ruta.py id1 id2 [id3 ...] [--perfil mtb] [--salida ruta.gpx]")
        sys.exit(1)

    # Parseo simple de opciones
    ids = []
    perfil = PERFIL
    salida = SALIDA
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--perfil":
            perfil = args[i + 1]; i += 2
        elif a == "--salida":
            salida = args[i + 1]; i += 2
        else:
            ids.append(a); i += 1

    if len(ids) < 2:
        print("Necesitas al menos 2 bajadas para generar una ruta con enlaces.")
        sys.exit(1)

    print(f"Cargando catálogo {CATALOGO}...")
    catalogo = cargar_catalogo(CATALOGO)
    print(f"  {len(catalogo)} bajadas en el catálogo")

    faltan = [i for i in ids if i not in catalogo]
    if faltan:
        print(f"ERROR: estos IDs no existen en el catálogo: {faltan}")
        print("IDs disponibles (primeros 10):", list(catalogo.keys())[:10])
        sys.exit(1)

    seleccion = [catalogo[i] for i in ids]
    for n, f in enumerate(seleccion, 1):
        print(f"  {n}. {f['properties'].get('nombre', '(sin nombre)')} "
              f"({f['properties']['longitud_m']} m)")

    # Ensamblado
    puntos_finales = []
    waypoints = []
    for idx, feat in enumerate(seleccion):
        p = feat["properties"]
        nombre = p.get("nombre") or f"Bajada {idx + 1}"

        # Waypoint de inicio
        ini = punto_inicio(feat)
        waypoints.append({"lat": ini[0], "lon": ini[1], "name": f"Inicio {nombre}"})

        # Geometría de la bajada
        geo = geometria_bajada(feat)
        puntos_finales.extend(geo)
        print(f"  Bajada {idx + 1}: {len(geo)} puntos añadidos")

        # Enlace con la siguiente
        if idx < len(seleccion) - 1:
            fin = punto_fin(feat)
            ini_sig = punto_inicio(seleccion[idx + 1])
            print(f"  Calculando enlace {idx + 1}->{idx + 2} con BRouter (perfil {perfil})...")
            try:
                gpx = llamar_brouter(fin[1], fin[0], ini_sig[1], ini_sig[0], perfil)
                enlace = parsear_gpx_puntos(gpx)
            except RuntimeError as e:
                print(f"  ERROR en enlace: {e}", file=sys.stderr)
                sys.exit(1)

            if not enlace:
                print("  AVISO: BRouter no devolvió puntos para el enlace.", file=sys.stderr)
            else:
                d_ini = haversine(fin, (enlace[0][0], enlace[0][1]))
                d_fin = haversine(ini_sig, (enlace[-1][0], enlace[-1][1]))
                print(f"    {len(enlace)} puntos, salto inicio {d_ini:.0f} m, "
                      f"salto fin {d_fin:.0f} m")
                if d_ini > MAX_SALTO_M or d_fin > MAX_SALTO_M:
                    print("    AVISO: salto grande, revisa el GPX resultante.", file=sys.stderr)
                puntos_finales.extend(enlace)
            time.sleep(PAUSA_ENTRE_LLAMADAS_S)

    print(f"Escribiendo {salida}...")
    escribir_gpx(puntos_finales, waypoints, salida)
    print(f"OK. {len(puntos_finales)} puntos, {len(waypoints)} waypoints.")


if __name__ == "__main__":
    main()