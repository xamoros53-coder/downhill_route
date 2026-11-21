# -*- coding: utf-8 -*-
"""
pbf_puro.py: lector mínimo de archivos .osm.pbf en Python puro (solo biblioteca estándar).

Sirve para equipos donde no se puede instalar/cargar la librería osmium (p. ej. Control de
aplicaciones / Device Guard de Windows bloquea sus módulos compilados). Es más lento que osmium,
pero para extractos de comunidad (Aragón, Cataluña...) tarda unos pocos minutos.

Hace dos pasadas al archivo:
  1) lee los caminos (ways), se queda con los que interesan y apunta los nodos que necesitan;
  2) lee los nodos y guarda solo las coordenadas de esos nodos (así no se llena la memoria).
"""
import time
import zlib
from datetime import datetime, timezone


# --- Protobuf mínimo --------------------------------------------------------------------
def _varint(b, i):
    x = b[i]
    i += 1
    if x < 128:
        return x, i
    x &= 127
    s = 7
    while True:
        c = b[i]
        i += 1
        x |= (c & 127) << s
        if c < 128:
            return x, i
        s += 7


def _campos(b):
    """Recorre los campos de un mensaje protobuf: genera (numero_campo, tipo_cable, valor)."""
    i, n = 0, len(b)
    while i < n:
        k, i = _varint(b, i)
        f, w = k >> 3, k & 7
        if w == 0:
            v, i = _varint(b, i)
        elif w == 2:
            ln, i = _varint(b, i)
            v = b[i:i + ln]
            i += ln
        elif w == 1:
            v = b[i:i + 8]
            i += 8
        elif w == 5:
            v = b[i:i + 4]
            i += 4
        else:
            raise ValueError("tipo de campo protobuf no soportado: %d" % w)
        yield f, w, v


def _varints(b):
    """Decodifica un campo 'packed' (lista de varints)."""
    out = []
    add = out.append
    i, n = 0, len(b)
    while i < n:
        x = b[i]
        i += 1
        if x >= 128:
            x &= 127
            s = 7
            while True:
                c = b[i]
                i += 1
                x |= (c & 127) << s
                if c < 128:
                    break
                s += 7
        add(x)
    return out


def _zz(x):
    return (x >> 1) ^ -(x & 1)


def _delta(vals):
    """Valores sint64 codificados como diferencias -> valores absolutos."""
    acc = 0
    out = []
    add = out.append
    for x in vals:
        acc += (x >> 1) ^ -(x & 1)
        add(acc)
    return out


def _s64(x):
    return x - (1 << 64) if x >= (1 << 63) else x


def _lista(w, v):
    """Campo repetido que puede venir empaquetado (tipo 2) o suelto (tipo 0)."""
    return _varints(v) if w == 2 else [v]


# --- Contenedor .osm.pbf ------------------------------------------------------------------
def _bloques(pbf):
    """Genera (tipo, datos_descomprimidos) de cada bloque del archivo."""
    with open(pbf, "rb") as f:
        while True:
            c = f.read(4)
            if len(c) < 4:
                return
            cab = f.read(int.from_bytes(c, "big"))
            tipo, tam = "", 0
            for fn, w, v in _campos(cab):
                if fn == 1:
                    tipo = bytes(v).decode("ascii", "replace")
                elif fn == 3:
                    tam = v
            blob = f.read(tam)
            datos = None
            for fn, w, v in _campos(blob):
                if fn == 1:
                    datos = v
                elif fn == 3:
                    datos = zlib.decompress(v)
                elif fn in (4, 5, 6, 7):
                    raise ValueError("Compresión del .pbf no soportada (solo zlib/sin comprimir).")
            yield tipo, datos


def _fecha_base(datos_cabecera):
    for f, w, v in _campos(datos_cabecera):
        if f == 32 and w == 0:      # osmosis_replication_timestamp (segundos desde 1970)
            return datetime.fromtimestamp(v, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return ""


# --- Pasada 1: caminos --------------------------------------------------------------------
def _caminos_de_bloque(blk):
    tabla_raw, grupos = None, []
    for f, w, v in _campos(blk):
        if f == 1:
            tabla_raw = v
        elif f == 2:
            grupos.append(v)
    tabla = None
    for g in grupos:
        for f, w, v in _campos(g):
            if f != 3:
                continue
            if tabla is None:
                tabla = [bytes(s).decode("utf-8", "replace")
                         for ff, ww, s in _campos(tabla_raw) if ff == 1] if tabla_raw else []
            wid, ks, vs, refs = 0, [], [], []
            for ff, ww, vv in _campos(v):
                if ff == 1:
                    wid = vv
                elif ff == 2:
                    ks += _lista(ww, vv)
                elif ff == 3:
                    vs += _lista(ww, vv)
                elif ff == 8:
                    refs += _lista(ww, vv)
            tags = {tabla[k]: tabla[x] for k, x in zip(ks, vs)}
            yield wid, tags, _delta(refs)


# --- Pasada 2: nodos ----------------------------------------------------------------------
def _nodos_de_bloque(blk, necesarios, coords):
    gran, lat0, lon0, grupos = 100, 0, 0, []
    for f, w, v in _campos(blk):
        if f == 2:
            grupos.append(v)
        elif f == 17:
            gran = v
        elif f == 19:
            lat0 = _s64(v)
        elif f == 20:
            lon0 = _s64(v)
    for g in grupos:
        for f, w, v in _campos(g):
            if f == 2:                      # nodos "densos" (lo habitual)
                ids, raw_lat, raw_lon = None, b"", b""
                for ff, ww, vv in _campos(v):
                    if ff == 1:
                        ids = _delta(_varints(vv))
                    elif ff == 8:
                        raw_lat = vv
                    elif ff == 9:
                        raw_lon = vv
                if not ids:
                    continue
                hit = [k for k, i in enumerate(ids) if i in necesarios]
                if not hit:
                    continue
                lats = _delta(_varints(raw_lat))
                lons = _delta(_varints(raw_lon))
                for k in hit:
                    coords[ids[k]] = (round(1e-9 * (lat0 + gran * lats[k]), 7),
                                      round(1e-9 * (lon0 + gran * lons[k]), 7))
            elif f == 1:                    # nodo suelto (poco frecuente)
                nid, la, lo = 0, 0, 0
                for ff, ww, vv in _campos(v):
                    if ff == 1:
                        nid = _zz(vv)
                    elif ff == 8:
                        la = _zz(vv)
                    elif ff == 9:
                        lo = _zz(vv)
                if nid in necesarios:
                    coords[nid] = (round(1e-9 * (lat0 + gran * la), 7),
                                   round(1e-9 * (lon0 + gran * lo), 7))


# --- API ------------------------------------------------------------------------------------
def leer_tramos(pbf, interesa, log=print):
    """Devuelve (tramos, sin_geometria, fecha_base).
    tramos = [(way_id, tags, [(ref, lat, lon), ...]), ...] de los caminos para los que
    interesa(tags) es True. 'sin_geometria' cuenta los caminos con nodos que faltan en el archivo."""
    t0 = time.time()
    base = ""
    elegidos, necesarios = [], set()
    log("Pasada 1/2: leyendo caminos...")
    n = 0
    for tipo, datos in _bloques(pbf):
        n += 1
        if tipo == "OSMHeader":
            base = _fecha_base(datos)
            continue
        if tipo != "OSMData":
            continue
        for wid, tags, refs in _caminos_de_bloque(datos):
            if refs and interesa(tags):
                elegidos.append((wid, tags, refs))
                necesarios.update(refs)
        if n % 100 == 0:
            log("    bloque %d, %d caminos elegidos (%.0f s)" % (n, len(elegidos), time.time() - t0))
    log("  %d caminos elegidos, %d nodos necesarios." % (len(elegidos), len(necesarios)))

    log("Pasada 2/2: leyendo coordenadas de los nodos...")
    coords = {}
    n = 0
    for tipo, datos in _bloques(pbf):
        if tipo != "OSMData":
            continue
        n += 1
        _nodos_de_bloque(datos, necesarios, coords)
        if n % 100 == 0:
            log("    bloque %d, %d/%d nodos (%.0f s)" % (n, len(coords), len(necesarios), time.time() - t0))

    tramos, sin_geom = [], 0
    for wid, tags, refs in elegidos:
        try:
            tramos.append((wid, tags, [(r,) + coords[r] for r in refs]))
        except KeyError:
            sin_geom += 1       # algún nodo cae fuera del extracto
    return tramos, sin_geom, base
