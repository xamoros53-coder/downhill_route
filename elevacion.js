// elevacion.js — elevación desde Open-Meteo (Copernicus DEM, ~90 m) con caché en localStorage.
// Expone window.Elev. Todo el acceso a la fuente de elevación está en este archivo:
// si algún día cambias de fuente, solo hay que tocar pedirLote().
//
// Atribución obligatoria de Open-Meteo: Copernicus DEM + Open-Meteo (ya incluida en el mapa).
(function () {
  "use strict";

  const URL_ELEV = "https://api.open-meteo.com/v1/elevation";
  const LOTE = 100;              // máximo de coordenadas por petición
  const PAUSA_MS = 250;          // pausa entre lotes
  const REINTENTOS = 5;
  const PASO_M = 30;             // distancia entre puntos del perfil
  const VENTANA_SUAVIZADO = 5;
  const STORAGE_CACHE = "elev_cache_v1";
  const MAX_CACHE = 40000;

  const api = { aviso: null };   // api.aviso(msg): el index lo usa para mostrar esperas

  // --- caché persistente ------------------------------------------------------
  const cache = new Map();
  try {
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
  const dormir = ms => new Promise(r => setTimeout(r, ms));
  const r6 = x => Math.round(x * 1e6) / 1e6;

  function haversine(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const p1 = a[0] * rad, p2 = b[0] * rad, dp = p2 - p1, dl = (b[1] - a[1]) * rad;
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // --- petición a Open-Meteo --------------------------------------------------
  async function pedirLote(lote) {
    const lats = lote.map(p => p[2].split(",")[0]).join(",");
    const lons = lote.map(p => p[2].split(",")[1]).join(",");
    const url = `${URL_ELEV}?latitude=${lats}&longitude=${lons}`;
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

  /**
   * Rellena la caché con la elevación de las coordenadas que falten.
   * @param {Array} coords [[lat, lon], ...]
   * @param {Function} onProgreso (hechos, total)
   */
  async function obtener(coords, onProgreso) {
    const faltan = [], vistos = new Set();
    for (const [lat, lon] of coords) {
      const k = clave(lat, lon);
      if (!cache.has(k) && !vistos.has(k)) { vistos.add(k); faltan.push([lat, lon, k]); }
    }
    for (let i = 0; i < faltan.length; i += LOTE) {
      const lote = faltan.slice(i, i + LOTE);
      const vals = await pedirLote(lote);
      lote.forEach((p, j) => {
        if (typeof vals[j] === "number" && Number.isFinite(vals[j])) cache.set(p[2], vals[j]);
      });
      guardarCache();
      if (onProgreso) onProgreso(Math.min(i + LOTE, faltan.length), faltan.length);
      if (i + LOTE < faltan.length) await dormir(PAUSA_MS);
    }
  }

  const ele = (lat, lon) => cache.get(clave(lat, lon));

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
   * geometría 3D remuestreada cada ~30 m y métricas. Si el perfil contradice el sentido
   * (la bajada no baja de verdad), devuelve {ok:false} y no modifica nada.
   * Lanza Error si no se puede obtener la elevación.
   */
  async function cargarPerfil(f) {
    const p = f.properties;
    if (p.perfil_cargado) return { ok: true };
    const pts = f.geometry.coordinates.map(c => [c[1], c[0]]);
    const muestras = remuestrear(pts, PASO_M);
    if (muestras.length < 2) return { ok: false, motivo: "geometría demasiado corta" };

    await obtener(muestras.map(m => [m[0], m[1]]));
    const crudas = muestras.map(m => cache.get(clave(m[0], m[1])));
    if (!crudas.some(Number.isFinite)) throw new Error("Open-Meteo no devolvió elevación para esta bajada");
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
      perfil_cargado: true
    });
    return { ok: true };
  }

  Object.assign(api, { obtener, ele, cargarPerfil });
  window.Elev = api;
})();
