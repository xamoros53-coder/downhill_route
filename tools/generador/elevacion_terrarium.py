# -*- coding: utf-8 -*-
"""
elevacion_terrarium.py: elevación para zonas fuera de la cobertura del IGN español (p. ej. el Pirineo francés).

Usa AWS Terrain Tiles (Mapzen), teselas de 256 px con codificación "terrarium":
  cota = (R*256 + G + B/256) - 32768
Cada tesela se convierte al mismo formato que usa elevacion_ign.py (Terrain-RGB del IGN,
-10000 + (R*65536 + G*256 + B)*0.1), así que todo lo demás (muestreo, perfiles, caché en disco)
funciona igual. La tesela z/x/y de Terrarium cubre la misma zona que la tesela z/x/y del IGN.

Resolución: la fuente de datos en Europa ronda los 10-30 m, bastante más gruesa que el MDT05 (5 m).
Sirve para detectar bajadas y estimar caída y pendiente, pero las pendientes máximas en 100 m
saldrán algo más suavizadas que con el IGN.

Atribución de datos: https://github.com/tilezen/joerd/blob/master/docs/attribution.md
"""
import io
import os
import time

import numpy as np
from PIL import Image

from elevacion_ign import Elevacion, ErrorTesela, REINTENTOS

URL_TESELAS = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
ZOOM_MAX = 15       # el conjunto de datos no llega más allá


def terrarium_a_ign(png_bytes):
    """PNG Terrarium -> PNG con la codificación del Terrain-RGB del IGN (alfa opaco)."""
    a = np.asarray(Image.open(io.BytesIO(png_bytes)).convert("RGB"), dtype=np.float64)
    e = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
    v = np.clip(np.round((e + 10000) * 10), 0, 2 ** 24 - 1).astype(np.int64)
    out = np.empty(e.shape + (4,), dtype=np.uint8)
    out[..., 0] = v >> 16
    out[..., 1] = (v >> 8) & 255
    out[..., 2] = v & 255
    out[..., 3] = 255
    buf = io.BytesIO()
    Image.fromarray(out, "RGBA").save(buf, "PNG")
    return buf.getvalue()


class ElevacionTerrarium(Elevacion):
    atribucion = "AWS Terrain Tiles / Mapzen (SRTM, EU-DEM y otras fuentes; ver github.com/tilezen/joerd/blob/master/docs/attribution.md)"

    def __init__(self, dir_cache="cache/terrarium", **kw):
        super().__init__(dir_cache=dir_cache, **kw)
        self.fuente = "terrarium"

    def _proveedor_red(self, z, x, y):
        """Bytes del PNG ya convertido al formato del IGN, o None si no hay tesela. Lanza ErrorTesela si falla."""
        import requests
        if z > ZOOM_MAX:
            raise ErrorTesela("Terrain Tiles no tiene teselas por encima del zoom %d." % ZOOM_MAX)
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
                if r.status_code == 404:
                    os.makedirs(base, exist_ok=True)
                    open(vacio, "wb").close()
                    return None
                if r.status_code != 200:
                    raise ErrorTesela("HTTP %d" % r.status_code)
                datos = terrarium_a_ign(r.content)
                os.makedirs(base, exist_ok=True)
                with open(png + ".tmp", "wb") as f:
                    f.write(datos)
                os.replace(png + ".tmp", png)
                time.sleep(self.pausa)
                return datos
            except Exception as e:   # red, tiempo de espera, HTTP raro...
                ultimo = e
                if intento < REINTENTOS:
                    time.sleep(1 + intento)
        raise ErrorTesela("No se pudo descargar la tesela %d/%d/%d de Terrain Tiles (%s). "
                          "Vuelve a ejecutar el programa: continuará donde se quedó." % (z, x, y, ultimo))
