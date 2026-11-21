# -*- coding: utf-8 -*-
"""
bajadas_osm.py: traducción a Python de la lógica de osm.js (agrupar tramos en bajadas,
orientarlas con la elevación, dificultad y tramos coloreados).

Está escrita para dar el MISMO resultado que osm.js. Si cambias una regla en osm.js,
cámbiala también aquí (y vuelve a pasar las pruebas de la carpeta pruebas/).

Convención de coordenadas igual que en osm.js: los puntos de trabajo son [lat, lon];
la geometría de salida (GeoJSON) es [lon, lat].
"""
import math
import re

# --- Configuración (igual que osm.js) ---------------------------------------------
MIN_LENGTH_M = 150         # bajadas más cortas se ignoran
MIN_CAIDA_M = 8            # caída mínima entre extremos
MIN_PEND_PCT = 2           # pendiente media mínima
BLEND_M = 60               # degradado entre dos colores contiguos
BLEND_STEPS = 6
COLOR_HEX = {"verde": "#2e9e4f", "azul": "#1f6fd1", "rojo": "#d62f2f", "negro": "#1a1a1a", "mezcla": "#888888"}
GRIS = "#9e9e9e"

# Pistas de coche (se descartan)
FILTRAR_PISTAS = True
ANCHO_MIN_PISTA_M = 3
TRACKTYPE_PISTA = ("grade1", "grade2")
MOTOR_SI = ("yes", "designated", "permissive")
SUPERFICIE_ASFALTO = ("asphalt", "concrete", "paved", "paving_stones", "concrete:plates", "concrete:lanes")
TRACKTYPE_RUDO = ("grade4", "grade5")

# Filtros de rudeza (solo para bajadas inferidas, sin etiqueta MTB)
FILTRAR_RUDAS = True
MAX_PEND_100M_PCT = 30
SUPERF_RUDA = ("rock", "stone", "pebblestone", "boulders", "scree", "sett", "cobblestone")
SMOOTH_MALA = ("very_bad", "horrible", "very_horrible", "impassable")
SAC_DURO = ("mountain_hiking", "demanding_mountain_hiking", "alpine_hiking",
            "demanding_alpine_hiking", "difficult_alpine_hiking")
VIS_MALA = ("bad", "horrible", "no")


# --- Utilidades --------------------------------------------------------------------
def js_round(x):
    """Math.round de JavaScript (redondea .5 hacia arriba; el round de Python redondea al par)."""
    return math.floor(x + 0.5)


def r6(x):
    return js_round(x * 1e6) / 1e6


def haversine(a, b):
    R = 6371000.0
    rad = math.pi / 180
    p1, p2 = a[0] * rad, b[0] * rad
    dp, dl = p2 - p1, (b[1] - a[1]) * rad
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def path_length(pts):
    d = 0.0
    for i in range(1, len(pts)):
        d += haversine(pts[i - 1], pts[i])
    return d


_NUM = re.compile(r"^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?")


def parse_num(v):
    """Como parseNum de osm.js: tolera '2,5', '3 m'... Devuelve None si no es un número."""
    if v is None:
        return None
    s = str(v).replace(",", ".", 1).replace("m", "", 1).strip()
    m = _NUM.match(s)
    if not m:
        return None
    n = float(m.group(0))
    return n if math.isfinite(n) else None


def parse_entero(v):
    n = parse_num(v)
    return None if n is None else math.trunc(n)


def mas_comun(valores):
    cuenta = {}
    for v in valores:
        if v is None or v == "":
            continue
        cuenta[v] = cuenta.get(v, 0) + 1
    mejor, maximo = None, 0
    for v, n in cuenta.items():
        if n > maximo:
            mejor, maximo = v, n
    return mejor


def color_de_nivel(v):
    # mtb:scale:imba (0-4) y mtb:scale (0-6): 0-1 verde, 2 azul, 3 rojo, 4+ negro
    if v <= 1:
        return "verde"
    if v == 2:
        return "azul"
    if v == 3:
        return "rojo"
    return "negro"


def hex_de(c):
    return COLOR_HEX.get(c, GRIS)


# --- 1. Tramos válidos -------------------------------------------------------------
def es_pista_de_coche(tags):
    # En un path (sendero) las etiquetas de motor no indican pista de coche
    # (p. ej. motor_vehicle=permissive suele ser una etiqueta heredada); solo cuentan en un track.
    if tags.get("highway") != "path":
        if tags.get("motor_vehicle") in MOTOR_SI or tags.get("motorcar") in MOTOR_SI:
            return True
    if tags.get("surface") in SUPERFICIE_ASFALTO:
        return True
    ancho = parse_num(tags.get("width"))
    if ancho is not None and ancho >= ANCHO_MIN_PISTA_M:
        return True
    if tags.get("highway") != "track":
        return False
    if tags.get("tracktype") in TRACKTYPE_PISTA:
        return True
    nivel = max(parse_entero(tags.get("mtb:scale")) or 0, parse_entero(tags.get("mtb:scale:imba")) or 0)
    mtb_name = tags.get("mtb:name")
    indicios = bool(mtb_name and mtb_name.strip()) or nivel >= 2 or tags.get("tracktype") in TRACKTYPE_RUDO
    return not indicios


def tramos_validos(data):
    """data = respuesta de Overpass (out body geom). Devuelve (ways, n_pistas_descartadas)."""
    ways, pistas = [], 0
    for el in data.get("elements", []):
        if el.get("type") != "way" or not el.get("geometry") or not el.get("nodes"):
            continue
        tags = el.get("tags") or {}
        if tags.get("bicycle") in ("no", "dismount"):
            continue
        if tags.get("access") in ("private", "no"):
            continue
        if FILTRAR_PISTAS and es_pista_de_coche(tags):
            pistas += 1
            continue
        ways.append({
            "id": el["id"],
            "nodes": list(el["nodes"]),
            "pts": [[p["lat"], p["lon"]] for p in el["geometry"]],
            "tags": tags,
        })
    return ways, pistas


# --- 2. Agrupar tramos en bajadas --------------------------------------------------
def nombres_de(w):
    s = set()
    for n in (w["tags"].get("name"), w["tags"].get("mtb:name")):
        if n and n.strip():
            s.add(n.strip().lower())
    return s


def tiene_mtb(w):
    t = w["tags"]
    mn = t.get("mtb:name")
    return bool(t.get("mtb:scale") or t.get("mtb:scale:imba") or (mn and mn.strip()))


def clave_dif(w):
    t = w["tags"]
    return t.get("mtb:scale:imba") or t.get("mtb:scale") or None


def compatibles(a, b):
    na, nb = nombres_de(a), nombres_de(b)
    if na or nb:
        return bool(na & nb)
    return clave_dif(a) == clave_dif(b)


def construir_cadenas(ways):
    """Une tramos conectados por sus extremos en cadenas ordenadas."""
    cortar_en_cruces = all(not nombres_de(w) and not tiene_mtb(w) for w in ways)
    unused = {w["id"]: w for w in ways}
    por_nodo = {}

    def anota(n, wid):
        por_nodo.setdefault(n, set()).add(wid)

    for w in ways:
        anota(w["nodes"][0], w["id"])
        anota(w["nodes"][-1], w["id"])

    def libres(n):
        return sum(1 for wid in por_nodo[n] if wid in unused)

    def es_cruce(n):
        return cortar_en_cruces and len(por_nodo[n]) > 2

    def extremo_libre(w):
        a, z = w["nodes"][0], w["nodes"][-1]
        if libres(a) == 1 or es_cruce(a):
            return "start"
        if libres(z) == 1 or es_cruce(z):
            return "end"
        return None

    orden = sorted(ways, key=lambda w: w["id"])
    cadenas = []
    while unused:
        start, start_free = None, None
        for w in orden:
            if w["id"] not in unused:
                continue
            fe = extremo_libre(w)
            if fe:
                start, start_free = w, fe
                break
        if start is None:   # bucle cerrado
            start = next(w for w in orden if w["id"] in unused)
            start_free = "start"

        nodes, pts = list(start["nodes"]), [list(p) for p in start["pts"]]
        if start_free == "end":
            nodes.reverse()
            pts.reverse()
        used = [start]
        segs = [[start, [list(p) for p in pts]]]
        del unused[start["id"]]

        while True:
            fin = nodes[-1]
            if es_cruce(fin):
                break
            nxt = None
            for wid in por_nodo.get(fin, ()):
                if wid in unused and (nxt is None or wid < nxt["id"]):
                    nxt = unused[wid]
            if nxt is None:
                break
            nn, np_ = list(nxt["nodes"]), [list(p) for p in nxt["pts"]]
            if nn[0] != fin:
                nn.reverse()
                np_.reverse()
            nodes.extend(nn[1:])
            pts.extend(np_[1:])
            used.append(nxt)
            segs.append([nxt, [list(p) for p in np_]])
            del unused[nxt["id"]]
        cadenas.append({"ways": used, "pts": pts, "segs": segs})
    return cadenas


def agrupar(ways):
    parent = list(range(len(ways)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    por_nodo = {}
    for i, w in enumerate(ways):
        for n in (w["nodes"][0], w["nodes"][-1]):
            por_nodo.setdefault(n, []).append(i)
    for idxs in por_nodo.values():
        for x in range(len(idxs)):
            for y in range(x + 1, len(idxs)):
                if compatibles(ways[idxs[x]], ways[idxs[y]]):
                    parent[find(idxs[x])] = find(idxs[y])
    comps = {}
    for i, w in enumerate(ways):
        comps.setdefault(find(i), []).append(w)
    out = []
    for grupo in comps.values():
        out.extend(construir_cadenas(grupo))
    return out


def candidatas(ways):
    out = []
    for g in agrupar(ways):
        longitud = path_length(g["pts"])
        if longitud < MIN_LENGTH_M:
            continue
        out.append({
            "id": "b" + str(min(w["id"] for w in g["ways"])),
            "ways": g["ways"], "segs": g["segs"], "pts": g["pts"], "longitud": longitud,
        })
    return out


# --- 3. Dificultad y tramos coloreados ----------------------------------------------
def color_tramo(tags):
    imba = parse_entero(tags.get("mtb:scale:imba"))
    scale = parse_entero(tags.get("mtb:scale"))
    if imba is not None:
        return color_de_nivel(imba), "osm_imba"
    if scale is not None:
        return color_de_nivel(scale), "osm_scale"
    return None, None


def dificultad(ways):
    metros, scales, imbas = {}, [], []
    for w in ways:
        sc = parse_entero(w["tags"].get("mtb:scale"))
        im = parse_entero(w["tags"].get("mtb:scale:imba"))
        if sc is not None:
            scales.append(sc)
        if im is not None:
            imbas.append(im)
        color, _ = color_tramo(w["tags"])
        if color:
            metros[color] = metros.get(color, 0) + path_length(w["pts"])
    colores = list(metros.keys())
    if not colores:
        return {"color": None, "fuente": None, "scale": None, "imba": None, "detalle": {}}
    rango = {"verde": 0, "azul": 1, "rojo": 2, "negro": 3}   # en empate, gana el más difícil
    colores.sort(key=lambda c: (-metros[c], -rango[c]))
    return {
        "color": colores[0],
        "fuente": "osm_imba" if imbas else "osm_scale",
        "scale": max(scales) if scales else None,
        "imba": max(imbas) if imbas else None,
        "detalle": {c: js_round(metros[c]) for c in colores},
    }


def hex_mix(c1, c2, f):
    a = [int(c1[i:i + 2], 16) for i in (1, 3, 5)]
    b = [int(c2[i:i + 2], 16) for i in (1, 3, 5)]
    return "#" + "".join("%02x" % js_round(x + (b[i] - x) * f) for i, x in enumerate(a))


def unir_tramos(tramos):
    runs = []
    for t in tramos:
        ult = runs[-1] if runs else None
        if ult is not None and ult["color"] == t["color"]:
            ult["b"] = t["b"]
            ult["way_ids"].append(t["way_id"])
            if ult["fuente"] != t["fuente"]:
                ult["fuente"] = "mixta"
        else:
            runs.append({"a": t["a"], "b": t["b"], "color": t["color"], "fuente": t["fuente"], "way_ids": [t["way_id"]]})
    return runs


def construir_trozos(runs):
    n = len(runs)
    half = [0.0] * max(0, n - 1)
    for i in range(n - 1):
        if runs[i]["color"] is None or runs[i + 1]["color"] is None:
            continue
        l1 = runs[i]["b"] - runs[i]["a"]
        l2 = runs[i + 1]["b"] - runs[i + 1]["a"]
        half[i] = min(BLEND_M / 2, l1 / 3, l2 / 3)
    trozos = []
    for i, r in enumerate(runs):
        izq = half[i - 1] if i > 0 else 0
        der = half[i] if i < n - 1 else 0
        a, b = r["a"] + izq, r["b"] - der
        if b - a > 0.5:
            trozos.append({"a": a, "b": b, "color": r["color"], "hex": hex_de(r["color"]), "tipo": "tramo", "run": i})
        if i < n - 1 and half[i] > 0:
            c1, c2 = hex_de(r["color"]), hex_de(runs[i + 1]["color"])
            x0, w = r["b"] - half[i], 2 * half[i]
            for k in range(BLEND_STEPS):
                trozos.append({
                    "a": x0 + w * k / BLEND_STEPS, "b": x0 + w * (k + 1) / BLEND_STEPS,
                    "color": "mezcla", "hex": hex_mix(c1, c2, (k + 0.5) / BLEND_STEPS),
                    "tipo": "transicion", "run": i,
                })
    return trozos


def punto_en(pts, cum, x):
    if x <= 0:
        return [r6(pts[0][1]), r6(pts[0][0])]
    for j in range(len(pts) - 1):
        if x <= cum[j + 1]:
            seg = cum[j + 1] - cum[j]
            f = 0 if seg == 0 else (x - cum[j]) / seg
            return [r6(pts[j][1] + (pts[j + 1][1] - pts[j][1]) * f), r6(pts[j][0] + (pts[j + 1][0] - pts[j][0]) * f)]
    u = pts[-1]
    return [r6(u[1]), r6(u[0])]


def trocear(pts, cum, a, b):
    out = [punto_en(pts, cum, a)]
    for j in range(len(pts)):
        if a < cum[j] < b:
            out.append([r6(pts[j][1]), r6(pts[j][0])])
    out.append(punto_en(pts, cum, b))
    return out


# --- 4. Evaluar una candidata con la elevación de sus dos extremos -------------------
def evaluar(c, e_ini, e_fin):
    """Devuelve {"feature": ..., "tramos": [...]} o None si el sentido no es fiable."""
    if e_ini is None or e_fin is None or not math.isfinite(e_ini) or not math.isfinite(e_fin):
        return None
    segs, pts, e0, e1 = c["segs"], c["pts"], e_ini, e_fin
    if e0 < e1:   # orientar: inicio arriba, final abajo
        segs = [[w, list(reversed(sp))] for w, sp in reversed(c["segs"])]
        pts = list(reversed(c["pts"]))
        e0, e1 = e1, e0
    total = c["longitud"]
    caida = e0 - e1
    pend = caida / total * 100
    if caida < MIN_CAIDA_M or pend < MIN_PEND_PCT:
        return None   # ante la duda, no se muestra

    tags_list = [w["tags"] for w in c["ways"]]
    dif = dificultad(c["ways"])
    mtb_name = mas_comun([t.get("mtb:name") for t in tags_list])
    name = mas_comun([t.get("name") for t in tags_list])
    anchos = [v for v in (parse_num(t.get("width")) for t in tags_list) if v is not None]
    bid = c["id"]
    fiabilidad = "osm" if ((mtb_name or name) and dif["color"]) else "detectada"
    inferida = not any(tiene_mtb(w) for w in c["ways"])
    coords = [[r6(lo), r6(la)] for la, lo in pts]

    props = {
        "id": bid,
        "nombre": mtb_name or name or None,
        "nombre_osm": name,
        "mtb_name": mtb_name,
        "way_ids": [w["id"] for w in c["ways"]],
        "n_tramos": len(c["ways"]),
        "longitud_m": js_round(total),
        "caida_m": js_round(caida),
        "pendiente_media_pct": js_round(pend * 10) / 10,
        "elev_inicio_m": js_round(e0),
        "elev_final_m": js_round(e1),
        "highway": mas_comun([t.get("highway") for t in tags_list]),
        "es_bajada": True,
        "dificultad_color": dif["color"],
        "dificultad_fuente": dif["fuente"],
        "dificultad_detalle_m": dif["detalle"],
        "mtb_scale_max": dif["scale"],
        "mtb_scale_imba_max": dif["imba"],
        "mtb_type": mas_comun([t.get("mtb:type") for t in tags_list]),
        "surface": mas_comun([t.get("surface") for t in tags_list]),
        "smoothness": mas_comun([t.get("smoothness") for t in tags_list]),
        "sac_scale": mas_comun([t.get("sac_scale") for t in tags_list]),
        "trail_visibility": mas_comun([t.get("trail_visibility") for t in tags_list]),
        "ancho_m": mas_comun(anchos),
        "incline_osm": mas_comun([t.get("incline") for t in tags_list]),
        "fiabilidad": fiabilidad,
        "origen": "inferida" if inferida else "mtb",
        "perfil_cargado": False,
        "_cat": dif["color"] or "sin",
        "_osm": fiabilidad == "osm",
        "_inferida": inferida,
        "inicio": coords[0],
        "fin": coords[-1],
    }
    feature = {"type": "Feature", "properties": props, "geometry": {"type": "LineString", "coordinates": coords}}

    # Trozos coloreados (con degradado) para dibujar el mapa, sobre la geometría original
    cum = [0.0]
    for i in range(1, len(pts)):
        cum.append(cum[i - 1] + haversine(pts[i - 1], pts[i]))
    acum = 0.0
    tramos_osm = []
    for w, sp in segs:
        ln = path_length(sp)
        color, fuente = color_tramo(w["tags"])
        tramos_osm.append({"a": acum, "b": acum + ln, "way_id": w["id"], "color": color, "fuente": fuente})
        acum += ln
    k = cum[-1] / acum if acum > 0 else 1
    for t in tramos_osm:
        t["a"] *= k
        t["b"] *= k
    runs = unir_tramos(tramos_osm)
    tramos = []
    for orden, t in enumerate(construir_trozos(runs)):
        linea = trocear(pts, cum, t["a"], t["b"])
        if len(linea) < 2:
            continue
        r = runs[t["run"]]
        tramos.append({
            "type": "Feature",
            "properties": {
                "bajada_id": bid, "nombre": props["nombre"] or "", "orden": orden, "tipo": t["tipo"],
                "color": t["color"], "stroke": t["hex"], "dificultad_fuente": r["fuente"],
                "way_ids": r["way_ids"], "longitud_m": js_round(t["b"] - t["a"]),
                "_cat": props["_cat"], "_osm": props["_osm"],
            },
            "geometry": {"type": "LineString", "coordinates": linea},
        })
    return {"feature": feature, "tramos": tramos}


# --- 5. Filtro de rudeza para bajadas inferidas (tras calcular el perfil) --------------
def motivo_rudo(p):
    """Devuelve el motivo si la bajada inferida probablemente no es ciclable; None si pasa."""
    if p.get("surface") in SUPERF_RUDA:
        return "superficie rudo: %s" % p["surface"]
    if p.get("smoothness") in SMOOTH_MALA:
        return "smoothness: %s" % p["smoothness"]
    if p.get("sac_scale") in SAC_DURO:
        return "sac_scale: %s" % p["sac_scale"]
    if p.get("trail_visibility") in VIS_MALA:
        return "trail_visibility: %s" % p["trail_visibility"]
    pm = p.get("pendiente_max_100m_pct")
    if pm is not None and pm > MAX_PEND_100M_PCT:
        return "pendiente max 100 m: %s%%" % pm
    return None
