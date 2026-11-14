# -*- coding: utf-8 -*-
"""
elevacion_ign.py: traducción a Python de elevacion.js.

Elevación desde el MDT05 del IGN (teselas Terrain-RGB de 512 px, malla de 5 m).
  cota = -10000 + (R*65536 + G*256 + B) * 0.1

Atribución: MDT05 © Instituto Geográfico Nacional de España (CC BY 4.0).

Las teselas se guardan en disco (carpeta cache/mdt): si la descarga se corta, al volver
a ejecutar el programa continúa donde se quedó y no vuelve a pedir lo ya descargado.
"""
import io
import math
import os
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image

from bajadas_osm import MIN_CAIDA_M, haversine, js_round, r6

URL_TESELAS = "https://xyz-mdt.idee.es/1.0.0/raster-dem/{z}/{x}/{y}.png"
ZOOM_CRIBADO = 13      # ~7 m/px: comprobar el sentido de muchas bajadas con pocas teselas
ZOOM_PERFIL = 14       # ~3,6 m/px: perfil de una bajada
MAX_TESELAS = 40       # teselas decodificadas en memoria (~1 MB cada una)
REINTENTOS = 2
PASO_M = 20            # distancia entre puntos del perfil
VENTANA_SUAVIZADO = 3
FUENTE = "ign5m"


class ErrorTesela(Exception):
    """La descarga de una tesela ha fallado de forma repetida (red, servidor caído)."""


def clave(lat, lon):
    return "%.5f,%.5f" % (lat, lon)


def coord_tesela(lat, lon, z):
    n = 2 ** z
    s = math.sin(max(-85, min(85, lat)) * math.pi / 180)
    fx = min(n - 1e-9, max(0, (lon + 180) / 360 * n))
    fy = min(n - 1e-9, max(0, (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n))
    return fx, fy, math.floor(fx), math.floor(fy)


def decodificar(png_bytes):
    """PNG -> matriz float32 de cotas (NaN = sin dato)."""
    im = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    a = np.asarray(im, dtype=np.int64)
    e = -10000.0 + (a[..., 0] * 65536 + a[..., 1] * 256 + a[..., 2]) * 0.1
    valido = (a[..., 3] == 255) & (e > -500)    # transparente o por debajo de -500 m: sin dato
    return np.where(valido, e, np.nan).astype(np.float32)


def muestrear(t, fx, fy, x, y):
    """Interpolación bilineal entre los 4 píxeles más cercanos (ignora los que no tienen dato)."""
    h, w = t.shape
    px, py = (fx - x) * w - 0.5, (fy - y) * h - 0.5
    x0, y0 = math.floor(px), math.floor(py)
    ax, ay = px - x0, py - y0
    suma, peso = 0.0, 0.0
    for dy in (0, 1):
        for dx in (0, 1):
            cx = min(w - 1, max(0, x0 + dx))
            cy = min(h - 1, max(0, y0 + dy))
            val = float(t[cy, cx])
            if not math.isfinite(val):
                continue
            wt = (ax if dx else 1 - ax) * (ay if dy else 1 - ay)
            suma += val * wt
            peso += wt
    return suma / peso if peso > 0 else float("nan")


class Elevacion:
    def __init__(self, dir_cache="cache/mdt", contacto="", hilos=4, pausa=0.05, proveedor=None, log=print):
        self.dir_cache = dir_cache
        self.contacto = contacto
        self.hilos = hilos
        self.pausa = pausa
        self.log = log
        self.proveedor = proveedor or self._proveedor_red
        self.cache = {}                 # (z, "lat,lon") -> cota redondeada a 0,1 m
        self.tesela_cache = OrderedDict()
        self._sesion = None

    # --- descarga de teselas (con caché en disco) --------------------------------
    def _proveedor_red(self, z, x, y):
        """Devuelve los bytes del PNG, o None si el IGN no tiene datos ahí. Lanza ErrorTesela si falla."""
        import requests
        base = os.path.join(self.dir_cache, str(z), str(x))
        png, vacio = os.path.join(base, "%d.png" % y), os.path.join(base, "%d.nodata" % y)
        if os.path.exists(png):
            with open(png, "rb") as f:
                return f.read()
        if os.path.exists(vacio):
            return None
        if self._sesion is None:
            self._sesion = requests.Session()
            ua = "generador-bajadas-mtb/1.0"
            if self.contacto:
                ua += " (contacto: %s)" % self.contacto
            self._sesion.headers["User-Agent"] = ua
        url = URL_TESELAS.format(z=z, x=x, y=y)
        ultimo = None
        for intento in range(REINTENTOS + 1):
            try:
                r = self._sesion.get(url, timeout=30)
                if r.status_code in (404, 204):
                    os.makedirs(base, exist_ok=True)
                    open(vacio, "wb").close()
                    return None
                if r.status_code != 200:
                    raise ErrorTesela("HTTP %d" % r.status_code)
                os.makedirs(base, exist_ok=True)
                with open(png + ".tmp", "wb") as f:
                    f.write(r.content)
                os.replace(png + ".tmp", png)
                time.sleep(self.pausa)
                return r.content
            except Exception as e:   # red, tiempo de espera, HTTP raro...
                ultimo = e
                if intento < REINTENTOS:
                    time.sleep(1 + intento)
        raise ErrorTesela("No se pudo descargar la tesela %d/%d/%d del IGN (%s). "
                          "Vuelve a ejecutar el programa: continuará donde se quedó." % (z, x, y, ultimo))

    def _tesela(self, z, x, y):
        k = (z, x, y)
        if k in self.tesela_cache:
            self.tesela_cache.move_to_end(k)
            return self.tesela_cache[k]
        datos = self.proveedor(z, x, y)
        t = None if datos is None else decodificar(datos)
        self.tesela_cache[k] = t
        while len(self.tesela_cache) > MAX_TESELAS:
            self.tesela_cache.popitem(last=False)
        return t

    # --- API equivalente a Elev.obtener / Elev.ele -------------------------------
    def obtener(self, coords, z=ZOOM_CRIBADO):
        """Rellena la caché con la elevación de las coordenadas [lat, lon] que falten."""
        faltan, vistos = [], set()
        for lat, lon in coords:
            k = clave(lat, lon)
            if k in vistos:
                continue
            vistos.add(k)
            if (z, k) in self.cache:
                continue
            faltan.append((lat, lon, k))
        if not faltan:
            return
        grupos = OrderedDict()
        for lat, lon, k in faltan:
            fx, fy, x, y = coord_tesela(lat, lon, z)
            grupos.setdefault((x, y), []).append((fx, fy, k))
        # Se descargan las teselas que falten en paralelo (a disco) y luego se leen una a una
        tiles = list(grupos.keys())
        self.log("    %d puntos en %d teselas del IGN (zoom %d)..." % (len(faltan), len(tiles), z))
        with ThreadPoolExecutor(self.hilos) as ex:
            for _ in ex.map(lambda t: self.proveedor(z, t[0], t[1]) and None, tiles):
                pass
        for (x, y), pts in grupos.items():
            tes = self._tesela(z, x, y)
            for fx, fy, k in pts:
                v = muestrear(tes, fx, fy, x, y) if tes is not None else float("nan")
                if math.isfinite(v):
                    self.cache[(z, k)] = js_round(v * 10) / 10

    def ele(self, lat, lon):
        """Cota de un punto ya obtenido con el zoom de cribado; None si no hay dato."""
        return self.cache.get((ZOOM_CRIBADO, clave(lat, lon)))

    # --- perfil de una bajada ---------------------------------------------------
    def cargar_perfil(self, f):
        """
        Calcula el perfil completo de una bajada (feature de evaluar) y lo guarda en la propia feature:
        geometría 3D remuestreada cada ~20 m y métricas. Devuelve (True, None) o (False, motivo)
        si el perfil no confirma que sea una bajada o faltan datos de elevación.
        """
        p = f["properties"]
        if p.get("perfil_cargado"):
            return True, None
        pts = [[c[1], c[0]] for c in f["geometry"]["coordinates"]]
        muestras = remuestrear(pts, PASO_M)
        if len(muestras) < 2:
            return False, "geometría demasiado corta"

        self.obtener([[m[0], m[1]] for m in muestras], ZOOM_PERFIL)
        crudas = [self.cache.get((ZOOM_PERFIL, clave(m[0], m[1]))) for m in muestras]
        con_dato = sum(1 for v in crudas if v is not None)
        # Sin cobertura del IGN (fuera de España) o parcial: un perfil con huecos grandes sería inventado.
        if con_dato < len(crudas) * 0.9:
            return False, "sin datos de elevación completos (fuera de la cobertura del IGN, solo España)"
        sm = suavizar(rellenar_huecos(crudas), VENTANA_SUAVIZADO)

        total = muestras[-1][2]
        caida = sm[0] - sm[-1]
        if caida < MIN_CAIDA_M * 0.5:
            return False, "el perfil no confirma que sea una bajada"

        sube = baja = 0.0
        for i in range(1, len(sm)):
            dz = sm[i] - sm[i - 1]
            if dz > 0:
                sube += dz
            else:
                baja -= dz
        ventana = max(1, js_round(100 / PASO_M))
        max_pend = 0.0
        for i in range(len(sm) - ventana):
            dd = muestras[i + ventana][2] - muestras[i][2]
            if dd > 0:
                max_pend = max(max_pend, (sm[i] - sm[i + ventana]) / dd * 100)

        f["geometry"]["coordinates"] = [[r6(m[1]), r6(m[0]), js_round(sm[i] * 10) / 10] for i, m in enumerate(muestras)]
        p.update({
            "caida_m": js_round(caida),
            "ascenso_m": js_round(sube),
            "descenso_acum_m": js_round(baja),
            "pendiente_media_pct": js_round(caida / total * 1000) / 10,
            "pendiente_max_100m_pct": js_round(max_pend * 10) / 10,
            "elev_inicio_m": js_round(sm[0]),
            "elev_final_m": js_round(sm[-1]),
            "fuente_elev": FUENTE,
            "perfil_cargado": True,
        })
        return True, None


def remuestrear(pts, paso):
    dist = [0.0]
    for i in range(1, len(pts)):
        dist.append(dist[i - 1] + haversine(pts[i - 1], pts[i]))
    total = dist[-1]
    if total == 0:
        return [[pts[0][0], pts[0][1], 0]]
    n = max(1, js_round(total / paso))
    out, j = [], 0
    for k in range(n + 1):
        d = total * k / n
        while j < len(dist) - 2 and dist[j + 1] < d:
            j += 1
        seg = dist[j + 1] - dist[j]
        f = 0 if seg == 0 else (d - dist[j]) / seg
        out.append([pts[j][0] + (pts[j + 1][0] - pts[j][0]) * f, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * f, d])
    return out


def suavizar(vals, ventana):
    mitad = ventana // 2
    out = []
    for i in range(len(vals)):
        trozo = vals[max(0, i - mitad): i + mitad + 1]
        out.append(sum(trozo) / len(trozo))
    return out


def rellenar_huecos(vals):
    """Huecos aislados (None) se interpolan a lo largo de la línea."""
    def ok(i):
        return vals[i] is not None
    out = []
    for i, v in enumerate(vals):
        if v is not None:
            out.append(v)
            continue
        a, b = i - 1, i + 1
        while a >= 0 and not ok(a):
            a -= 1
        while b < len(vals) and not ok(b):
            b += 1
        if a >= 0 and b < len(vals):
            out.append(vals[a] + (vals[b] - vals[a]) * (i - a) / (b - a))
        else:
            out.append(vals[a] if a >= 0 else vals[b])
    return out
