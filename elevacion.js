// elevacion.js — elevación desde el MDT05 del IGN (teselas Terrain-RGB, malla de 5 m) con respaldo
// en Open-Meteo (Copernicus DEM, ~90 m) para los puntos que el IGN no cubre. Caché en localStorage.
// Expone window.Elev. Todo el acceso a las fuentes de elevación está en este archivo.
//
// Atribución: MDT05 © Instituto Geográfico Nacional de España (CC BY 4.0).
//             Respaldo: Copernicus DEM + Open-Meteo.
(function () {
  "use strict";

  // --- IGN: teselas con la cota codificada en RGB ------------------------------
  // cota = -10000 + (R*65536 + G*256 + B) * 0.1      (teselas de 512 px, zooms 5-15)
  const URL_TESELAS = "https://xyz-mdt.idee.es/1.0.0/raster-dem/{z}/{x}/{y}.png";
  const ZOOM_CRIBADO = 13;       // ~7 m/px: comprobar el sentido de muchas bajadas con pocas teselas
  const ZOOM_PERFIL = 14;        // ~3,6 m/px: perfil de una bajada
  const MAX_TESELAS = 40;        // teselas decodificadas en memoria (~1 MB cada una)
  const CONC_TESELAS = 4;        // descargas de teselas a la vez
  const REINTENTOS_TESELA = 2;

  // --- Open-Meteo (solo respaldo) ----------------------------------------------
  const URL_OM = "https://api.open-meteo.com/v1/elevation";
  const LOTE = 100;              // máximo de coordenadas por petición
  const PAUSA_MS = 150;          // pausa entre lotes de un mismo hilo
  const CONCURRENCIA = 3;        // lotes pedidos a la vez (si Open-Meteo responde 429, baja este valor)
  const REINTENTOS = 5;

  // --- Perfil de una bajada -----------------------------------------------------
  const PASO_M = 20;             // distancia entre puntos del perfil (con DEM de 90 m eran 30)
  const VENTANA_SUAVIZADO = 3;   // muestras (con DEM de 90 m eran 5)
  const FUENTE = "ign5m";        // se guarda en cada bajada para saber con qué datos se calculó su perfil
  const STORAGE_CACHE = "elev_cache_v2";
  const STORAGE_CACHE_ANTIGUA = "elev_cache_v1";   // cotas de Open-Meteo sin indicar fuente: se borra
  const MAX_CACHE = 40000;

  const api = { aviso: null, FUENTE };   // api.aviso(msg): el index lo usa para mostrar esperas

  // --- caché persistente ------------------------------------------------------
  // Claves: "<zoom>|lat,lon" (IGN, según el zoom con que se muestreó) y "om|lat,lon" (respaldo Open-Meteo).
  const cache = new Map();
  try {
    localStorage.removeItem(STORAGE_CACHE_ANTIGUA);
    const raw = localStorage.getItem(STORAGE_CACHE);
    if (raw) for (const [k, v] of JSON.parse(raw)) cache.set(k, v);
  } catch (e) { /* caché ilegible: empezamos vacía */ }

  let timerGuardar = null;
  function guardarCache() {
    clearTimeout(timerGuardar);
    timerGuardar = setTimeout(() => {
      try {
        while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
        localStorage.setItem(STORAGE_CACHE, JSON.stringify([...cache]));
      } catch (e) { /* almacenamiento lleno: seguimos solo en memoria */ }
    }, 500);
  }

  const clave = (lat, lon) => lat.toFixed(5) + "," + lon.toFixed(5);
  const kz = (z, k) => z + "|" + k;
  const kom = k => "om|" + k;
  const dormir = ms => new Promise(r => setTimeout(r, ms));
  const r6 = x => Math.round(x * 1e6) / 1e6;

  function haversine(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const p1 = a[0] * rad, p2 = b[0] * rad, dp = p2 - p1, dl = (b[1] - a[1]) * rad;
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // --- IGN: teselas -------------------------------------------------------------
  const tesCache = new Map();    // "z/x/y" -> { w, h, v: Float32Array } | null (fuera de cobertura); el orden es el LRU
  const tesPend = new Map();     // descargas en curso

  // Coordenadas de tesela (Web Mercator) y posición fraccionaria dentro del mapa de teselas
  function coordTesela(lat, lon, z) {
    const n = 2 ** z, s = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180);
    const fx = Math.min(n - 1e-9, Math.max(0, (lon + 180) / 360 * n));
    const fy = Math.min(n - 1e-9, Math.max(0, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n));
    return { fx, fy, x: Math.floor(fx), y: Math.floor(fy) };
  }

  async function bitmapDe(blob) {
    if (typeof createImageBitmap === "function") {
      // sin conversión de color ni premultiplicado: los bytes RGB son la cota, no un color
      try { return await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" }); } catch (e) { /* opciones no soportadas */ }
      try { return await createImageBitmap(blob); } catch (e) { /* seguimos con <img> */ }
    }
    const url = URL.createObjectURL(blob);
    try {
      return await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error("imagen ilegible"));
        im.src = url;
      });
    } finally { URL.revokeObjectURL(url); }
  }

  function decodificar(img) {
    const w = img.width, h = img.height;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, w, h).data;
    const v = new Float32Array(w * h);
    for (let i = 0, j = 0; i < v.length; i++, j += 4) {
      if (d[j + 3] < 255) { v[i] = NaN; continue; }                       // transparente: sin dato
      const e = -10000 + (d[j] * 65536 + d[j + 1] * 256 + d[j + 2]) * 0.1;
      v[i] = e > -500 ? e : NaN;                                           // por debajo de -500 m: sin dato
    }
    return { w, h, v };
  }

  // Devuelve la tesela decodificada, o null si no hay datos (404 / fallo repetido). null no tumba nada: el punto pasa al respaldo.
  async function cargarTesela(z, x, y) {
    const k = z + "/" + x + "/" + y;
    if (tesCache.has(k)) { const t = tesCache.get(k); tesCache.delete(k); tesCache.set(k, t); return t; }
    if (tesPend.has(k)) return tesPend.get(k);
    const prom = (async () => {
      const url = URL_TESELAS.replace("{z}", z).replace("{x}", x).replace("{y}", y);
      let tesela = null, definitivo = false;
      for (let intento = 0; intento <= REINTENTOS_TESELA; intento++) {
        try {
          const r = await fetch(url);
          if (r.status === 404 || r.status === 204) { definitivo = true; break; }   // fuera de cobertura
          if (!r.ok) throw new Error("HTTP " + r.status);
          tesela = decodificar(await bitmapDe(await r.blob()));
          definitivo = true;
          break;
        } catch (e) {
          if (intento < REINTENTOS_TESELA) await dormir(1000 * (intento + 1));
        }
      }
      if (definitivo) {   // un fallo de red no se recuerda: se reintentará la próxima vez
        tesCache.set(k, tesela);
        while (tesCache.size > MAX_TESELAS) tesCache.delete(tesCache.keys().next().value);
      }
      return tesela;
    })();
    tesPend.set(k, prom);
    try { return await prom; } finally { tesPend.delete(k); }
  }

  // Interpolación bilineal entre los 4 píxeles más cercanos (ignora los que no tienen dato)
  function muestrear(t, fx, fy, x, y) {
    const px = (fx - x) * t.w - 0.5, py = (fy - y) * t.h - 0.5;
    const x0 = Math.floor(px), y0 = Math.floor(py), ax = px - x0, ay = py - y0;
    let suma = 0, peso = 0;
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const cx = Math.min(t.w - 1, Math.max(0, x0 + dx)), cy = Math.min(t.h - 1, Math.max(0, y0 + dy));
        const val = t.v[cy * t.w + cx];
        if (!Number.isFinite(val)) continue;
        const w = (dx ? ax : 1 - ax) * (dy ? ay : 1 - ay);
        suma += val * w; peso += w;
      }
    }
    return peso > 0 ? suma / peso : NaN;
  }

  // --- Open-Meteo: respaldo -----------------------------------------------------
  async function pedirLote(lote) {
    const lats = lote.map(p => p[0].toFixed(5)).join(",");
    const lons = lote.map(p => p[1].toFixed(5)).join(",");
    const url = `${URL_OM}?latitude=${lats}&longitude=${lons}`;
    let ultimo = "";
    for (let intento = 0; intento < REINTENTOS; intento++) {
      try {
        const r = await fetch(url);
        if (r.ok) {
          const data = await r.json();
          if (!Array.isArray(data.elevation) || data.elevation.length !== lote.length) {
            throw new Error("respuesta inesperada de Open-Meteo");
          }
          return data.elevation;
        }
        if (r.status === 429 || r.status >= 500) {
          ultimo = r.status === 429 ? "Open-Meteo limita las peticiones" : "Open-Meteo no responde (HTTP " + r.status + ")";
          const espera = 10 * (intento + 1);
          if (api.aviso) api.aviso(`${ultimo}. Reintentando en ${espera} s…`);
          await dormir(espera * 1000);
          continue;
        }
        let motivo = "HTTP " + r.status;
        try { const j = await r.json(); if (j && j.reason) motivo = j.reason; } catch (e) { /* sin cuerpo */ }
        throw new Error("Open-Meteo rechazó la petición: " + motivo);
      } catch (e) {
        if (e instanceof TypeError) {   // fallo de red
          ultimo = "sin conexión con Open-Meteo";
          await dormir(3000 * (intento + 1));
          continue;
        }
        throw e;
      }
    }
    throw new Error(ultimo + ". Espera unos minutos y vuelve a intentarlo.");
  }

  // puntos: [[lat, lon, k], ...] sin cota del IGN
  async function respaldoOpenMeteo(puntos, avance) {
    const lotes = [];
    for (let i = 0; i < puntos.length; i += LOTE) lotes.push(puntos.slice(i, i + LOTE));
    let siguiente = 0, error = null;
    async function hilo() {
      while (!error) {
        const idx = siguiente++;
        if (idx >= lotes.length) return;
        const lote = lotes[idx];
        try {
          const vals = await pedirLote(lote);
          lote.forEach((p, j) => {
            if (typeof vals[j] === "number" && Number.isFinite(vals[j])) cache.set(kom(p[2]), vals[j]);
          });
          guardarCache();
          avance(lote.length);
        } catch (e) { error = e; return; }
        if (siguiente < lotes.length) await dormir(PAUSA_MS);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCIA, lotes.length) }, hilo));
    if (error) throw error;
  }

  /**
   * Rellena la caché con la elevación de las coordenadas que falten.
   * Primero el IGN (por teselas); lo que no cubra va a Open-Meteo.
   * @param {Array} coords [[lat, lon], ...]
   * @param {Function} onProgreso (hechos, total)
   * @param {number} zoom zoom de las teselas (por defecto, el de cribado)
   */
  async function obtener(coords, onProgreso, zoom) {
    const z = zoom || ZOOM_CRIBADO;
    const faltan = [], vistos = new Set();
    for (const [lat, lon] of coords) {
      const k = clave(lat, lon);
      if (vistos.has(k)) continue;
      vistos.add(k);
      if (cache.has(kz(z, k)) || cache.has(kom(k))) continue;
      faltan.push([lat, lon, k]);
    }
    if (!faltan.length) return;

    let hechos = 0;
    const avance = n => { hechos += n; if (onProgreso) onProgreso(hechos, faltan.length); };

    // 1) IGN: se agrupan los puntos por tesela y se descarga cada tesela una sola vez
    const grupos = new Map();
    for (const p of faltan) {
      const t = coordTesela(p[0], p[1], z);
      const kt = t.x + "/" + t.y;
      if (!grupos.has(kt)) grupos.set(kt, { x: t.x, y: t.y, pts: [] });
      grupos.get(kt).pts.push({ p, fx: t.fx, fy: t.fy });
    }
    const lista = [...grupos.values()], sinDato = [];
    let sig = 0;
    async function hiloTesela() {
      while (sig < lista.length) {
        const g = lista[sig++];
        const tes = await cargarTesela(z, g.x, g.y);
        let nuevos = 0;
        for (const { p, fx, fy } of g.pts) {
          const v = tes ? muestrear(tes, fx, fy, g.x, g.y) : NaN;
          if (Number.isFinite(v)) { cache.set(kz(z, p[2]), Math.round(v * 10) / 10); nuevos++; }
          else sinDato.push(p);
        }
        if (nuevos) { guardarCache(); avance(nuevos); }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC_TESELAS, lista.length) }, hiloTesela));

    // 2) respaldo: puntos sin cobertura del IGN
    if (sinDato.length) await respaldoOpenMeteo(sinDato, avance);
  }

  // Cota de un punto ya obtenido con el zoom de cribado (la que usa el index para comprobar el sentido)
  function ele(lat, lon) {
    const k = clave(lat, lon), v = cache.get(kz(ZOOM_CRIBADO, k));
    return v !== undefined ? v : cache.get(kom(k));
  }

  // --- perfil de una bajada ---------------------------------------------------
  function remuestrear(pts, paso) {
    const dist = [0];
    for (let i = 1; i < pts.length; i++) dist.push(dist[i - 1] + haversine(pts[i - 1], pts[i]));
    const total = dist[dist.length - 1];
    if (total === 0) return [[pts[0][0], pts[0][1], 0]];
    const n = Math.max(1, Math.round(total / paso));
    const out = [];
    let j = 0;
    for (let k = 0; k <= n; k++) {
      const d = total * k / n;
      while (j < dist.length - 2 && dist[j + 1] < d) j++;
      const seg = dist[j + 1] - dist[j];
      const f = seg === 0 ? 0 : (d - dist[j]) / seg;
      out.push([
        pts[j][0] + (pts[j + 1][0] - pts[j][0]) * f,
        pts[j][1] + (pts[j + 1][1] - pts[j][1]) * f,
        d
      ]);
    }
    return out;
  }

  function suavizar(vals, ventana) {
    const mitad = Math.floor(ventana / 2);
    return vals.map((_, i) => {
      const trozo = vals.slice(Math.max(0, i - mitad), i + mitad + 1);
      return trozo.reduce((a, b) => a + b, 0) / trozo.length;
    });
  }

  // Huecos aislados (sin dato) se interpolan a lo largo de la línea
  function rellenarHuecos(vals) {
    const ok = i => Number.isFinite(vals[i]);
    return vals.map((v, i) => {
      if (ok(i)) return v;
      let a = i - 1, b = i + 1;
      while (a >= 0 && !ok(a)) a--;
      while (b < vals.length && !ok(b)) b++;
      if (a >= 0 && b < vals.length) return vals[a] + (vals[b] - vals[a]) * (i - a) / (b - a);
      return a >= 0 ? vals[a] : vals[b];
    });
  }

  /**
   * Calcula el perfil completo de una bajada (feature de osm.js) y lo guarda en la propia feature:
   * geometría 3D remuestreada cada ~20 m y métricas. Si el perfil contradice el sentido
   * (la bajada no baja de verdad), devuelve {ok:false} y no modifica nada.
   * Lanza Error si no se puede obtener la elevación.
   */
  async function cargarPerfil(f) {
    const p = f.properties;
    if (p.perfil_cargado) return { ok: true };
    const pts = f.geometry.coordinates.map(c => [c[1], c[0]]);
    const muestras = remuestrear(pts, PASO_M);
    if (muestras.length < 2) return { ok: false, motivo: "geometría demasiado corta" };

    await obtener(muestras.map(m => [m[0], m[1]]), null, ZOOM_PERFIL);
    let usoRespaldo = false;
    const crudas = muestras.map(m => {
      const k = clave(m[0], m[1]), v = cache.get(kz(ZOOM_PERFIL, k));
      if (v !== undefined) return v;
      const o = cache.get(kom(k));
      if (o !== undefined) usoRespaldo = true;
      return o;
    });
    if (!crudas.some(Number.isFinite)) throw new Error("No se pudo obtener la elevación de esta bajada");
    const sm = suavizar(rellenarHuecos(crudas), VENTANA_SUAVIZADO);

    const total = muestras[muestras.length - 1][2];
    const caida = sm[0] - sm[sm.length - 1];
    // Comprobación final del sentido: si el perfil completo no confirma la caída, se retira.
    if (caida < OSM.MIN_CAIDA_M * 0.5) return { ok: false, motivo: "el perfil no confirma que sea una bajada" };

    let sube = 0, baja = 0;
    for (let i = 1; i < sm.length; i++) {
      const dz = sm[i] - sm[i - 1];
      if (dz > 0) sube += dz; else baja -= dz;
    }
    const ventana = Math.max(1, Math.round(100 / PASO_M));
    let maxPend = 0;
    for (let i = 0; i + ventana < sm.length; i++) {
      const dd = muestras[i + ventana][2] - muestras[i][2];
      if (dd > 0) maxPend = Math.max(maxPend, (sm[i] - sm[i + ventana]) / dd * 100);
    }

    f.geometry.coordinates = muestras.map((m, i) => [r6(m[1]), r6(m[0]), Math.round(sm[i] * 10) / 10]);
    Object.assign(p, {
      caida_m: Math.round(caida),
      ascenso_m: Math.round(sube),
      descenso_acum_m: Math.round(baja),
      pendiente_media_pct: Math.round(caida / total * 1000) / 10,
      pendiente_max_100m_pct: Math.round(maxPend * 10) / 10,
      elev_inicio_m: Math.round(sm[0]),
      elev_final_m: Math.round(sm[sm.length - 1]),
      fuente_elev: usoRespaldo ? "openmeteo" : FUENTE,
      perfil_cargado: true
    });
    return { ok: true };
  }

  Object.assign(api, { obtener, ele, cargarPerfil });
  window.Elev = api;
})();
