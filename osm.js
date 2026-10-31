// osm.js — descarga de senderos MTB de OpenStreetMap (Overpass) y agrupado en bajadas.
// Todo corre en el navegador. Expone window.OSM.
//
// Flujo:
//   1. descargarZona(bbox)  -> candidatas (cadenas de tramos con etiqueta mtb:*), sin elevación.
//   2. evaluar(candidata, eleIni, eleFin) -> bajada orientada (inicio arriba, fin abajo)
//      o null si el sentido es dudoso (ante la duda, no se muestra).
(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // CONFIGURACIÓN
  // ---------------------------------------------------------------------------
  const OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter"
  ];
  const MAX_AREA_KM2 = 300;      // tamaño máximo de la zona a descargar
  const MIN_LENGTH_M = 150;      // bajadas más cortas se ignoran
  // Una bajada solo se muestra si el sentido es fiable. Con el DEM de 90 m de Open-Meteo,
  // las diferencias pequeñas son ruido: se exige caída y pendiente mínimas entre extremos.
  const MIN_CAIDA_M = 8;
  const MIN_PEND_PCT = 2;
  const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;   // 7 días: los senderos de OSM cambian poco
  const TIMEOUT_MS = 60000;        // espera máxima por servidor
  const ESCALONADO_MS = 7000;      // si un servidor no responde en este tiempo, se lanza también el siguiente
  const MAX_ZONAS_CACHE = 4;       // zonas recientes que se guardan para no volver a descargarlas

  // Degradado entre dos colores contiguos
  const BLEND_M = 60;
  const BLEND_STEPS = 6;
  const COLOR_HEX = { verde: "#2e9e4f", azul: "#1f6fd1", rojo: "#d62f2f", negro: "#1a1a1a", mezcla: "#888888" };
  const GRIS = "#9e9e9e";
  const hexDe = c => COLOR_HEX[c] || GRIS;

  // mtb:scale:imba (0-4) y mtb:scale (0-6): 0-1 verde, 2 azul, 3 rojo, 4+ negro
  function colorDeNivel(v) { return v <= 1 ? "verde" : v === 2 ? "azul" : v === 3 ? "rojo" : "negro"; }

  // ---------------------------------------------------------------------------
  // UTILIDADES
  // ---------------------------------------------------------------------------
  function haversine(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const p1 = a[0] * rad, p2 = b[0] * rad, dp = p2 - p1, dl = (b[1] - a[1]) * rad;
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function pathLength(pts) {
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += haversine(pts[i - 1], pts[i]);
    return d;
  }
  function parseNum(v) {
    if (v === undefined || v === null) return null;
    const n = parseFloat(String(v).replace(",", ".").replace("m", "").trim());
    return Number.isFinite(n) ? n : null;
  }
  const parseEntero = v => { const n = parseNum(v); return n === null ? null : Math.trunc(n); };
  const r6 = x => Math.round(x * 1e6) / 1e6;

  function masComun(valores) {
    const cuenta = new Map();
    for (const v of valores) {
      if (v === null || v === undefined || v === "") continue;
      cuenta.set(v, (cuenta.get(v) || 0) + 1);
    }
    let mejor = null, max = 0;
    for (const [v, n] of cuenta) if (n > max) { mejor = v; max = n; }
    return mejor;
  }

  function areaKm2(bbox) {
    const [s, w, n, e] = bbox;
    const alto = (n - s) * 111.32;
    const ancho = (e - w) * 111.32 * Math.cos(((n + s) / 2) * Math.PI / 180);
    return alto * ancho;
  }

  // ---------------------------------------------------------------------------
  // CACHÉ DE LA ÚLTIMA ZONA (IndexedDB). Sirve para reintentar sin volver a descargar.
  // ---------------------------------------------------------------------------
  function abrirDB() {
    return new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error("sin IndexedDB"));
      const r = indexedDB.open("rideplanner", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("zonas");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function cacheGet(key) {
    try {
      const db = await abrirDB();
      return await new Promise(res => {
        const q = db.transaction("zonas").objectStore("zonas").get(key);
        q.onsuccess = () => res(q.result || null);
        q.onerror = () => res(null);
      });
    } catch (e) { return null; }
  }
  async function cacheSet(key, val) {
    try {
      const db = await abrirDB();
      await new Promise(res => {
        const tx = db.transaction("zonas", "readwrite");
        tx.objectStore("zonas").put(val, key);
        tx.oncomplete = tx.onerror = tx.onabort = () => res();
      });
    } catch (e) { /* sin caché, no pasa nada */ }
  }

  // Zonas recientes en caché: si la zona pedida cabe dentro de una ya descargada, no se vuelve a pedir nada.
  const contiene = (g, p) => g[0] <= p[0] && g[1] <= p[1] && g[2] >= p[2] && g[3] >= p[3];
  async function buscarCache(bb) {
    const lista = (await cacheGet("zonas")) || [];
    const ahora = Date.now();
    return lista.find(z => ahora - z.t < CACHE_TTL_MS && contiene(z.bbox, bb)) || null;
  }
  async function guardarCache(bb, data) {
    const ahora = Date.now();
    let lista = (await cacheGet("zonas")) || [];
    lista = lista.filter(z => ahora - z.t < CACHE_TTL_MS && !contiene(bb, z.bbox));   // las que quedan dentro de la nueva sobran
    lista.unshift({ bbox: bb, t: ahora, data });
    await cacheSet("zonas", lista.slice(0, MAX_ZONAS_CACHE));
  }
  // Se queda con los tramos que tocan la zona pedida (la zona en caché puede ser mayor)
  function recortarData(data, bb) {
    const dentro = p => p.lat >= bb[0] && p.lat <= bb[2] && p.lon >= bb[1] && p.lon <= bb[3];
    return { elements: (data.elements || []).filter(el => el.type === "way" && el.geometry && el.geometry.some(dentro)) };
  }

  // ---------------------------------------------------------------------------
  // 1. DESCARGA DE OVERPASS
  // ---------------------------------------------------------------------------
  // Pide a los servidores en carrera: se empieza por el primero y, si tarda más de ESCALONADO_MS
  // (o falla), se lanza el siguiente sin esperar. Gana el primero que responde y se cancelan los demás.
  function consultarOverpass(query, estado) {
    const body = new URLSearchParams({ data: query });
    return new Promise((resolve, reject) => {
      let terminado = false, lanzados = 0, fallos = 0, ultimo = null;
      const ctrls = [], timers = [];
      function finalizar() {
        terminado = true;
        timers.forEach(clearTimeout);
        ctrls.forEach(c => { try { c.abort(); } catch (e) {} });
      }
      function lanzar() {
        if (terminado || lanzados >= OVERPASS_URLS.length) return;
        const url = OVERPASS_URLS[lanzados++], host = new URL(url).hostname;
        const ctrl = new AbortController(); ctrls.push(ctrl);
        timers.push(setTimeout(() => ctrl.abort(), TIMEOUT_MS));
        timers.push(setTimeout(lanzar, ESCALONADO_MS));
        estado(`Descargando senderos de OpenStreetMap (${host})…`);
        (async () => {
          const r = await fetch(url, { method: "POST", body, signal: ctrl.signal });
          if (!r.ok) throw new Error("HTTP " + r.status);
          const data = await r.json();
          if (data.remark && /runtime error|timed out|out of memory/i.test(data.remark)) throw new Error(data.remark);
          return data;
        })().then(data => {
          if (terminado) return;
          finalizar(); resolve(data);
        }).catch(e => {
          if (terminado) return;
          ultimo = e.name === "AbortError" ? new Error("tiempo de espera agotado") : e;
          console.warn("Overpass", host, ultimo);
          fallos++;
          if (fallos >= OVERPASS_URLS.length) {
            finalizar();
            reject(new Error("Overpass no responde (" + ultimo.message + "). Prueba con una zona más pequeña o inténtalo en unos minutos."));
          } else lanzar();   // este ha fallado: se prueba el siguiente ya
        });
      }
      lanzar();
    });
  }

  // Pistas de coche: caminos anchos y firmes para vehículos que llevan mtb:scale=0/1 por defecto
  // pero no son bajadas de MTB. Con cualquiera de estas señales, el tramo se descarta.
  const FILTRAR_PISTAS = true;
  const ANCHO_MIN_PISTA_M = 3;                                  // width >= 3 m
  const TRACKTYPE_PISTA = ["grade1", "grade2"];                 // firme sólido o casi
  const MOTOR_SI = ["yes", "designated", "permissive"];         // motor_vehicle / motorcar explícitos
  const SUPERFICIE_ASFALTO = ["asphalt", "concrete", "paved", "paving_stones", "concrete:plates", "concrete:lanes"];
  // Un track que no tiene ninguna de las señales anteriores solo se conserva si hay indicios
  // de que es un sendero MTB de verdad: nombre MTB, dificultad 2 o más, o firme muy irregular.
  const TRACKTYPE_RUDO = ["grade4", "grade5"];

  function esPistaDeCoche(tags) {
    if (MOTOR_SI.includes(tags.motor_vehicle) || MOTOR_SI.includes(tags.motorcar)) return true;
    if (SUPERFICIE_ASFALTO.includes(tags.surface)) return true;
    const ancho = parseNum(tags.width);
    if (ancho !== null && ancho >= ANCHO_MIN_PISTA_M) return true;
    if (tags.highway !== "track") return false;
    if (TRACKTYPE_PISTA.includes(tags.tracktype)) return true;
    const nivel = Math.max(parseEntero(tags["mtb:scale"]) ?? 0, parseEntero(tags["mtb:scale:imba"]) ?? 0);
    const indicios = !!(tags["mtb:name"] && tags["mtb:name"].trim()) || nivel >= 2 || TRACKTYPE_RUDO.includes(tags.tracktype);
    return !indicios;
  }

  function tramosValidos(data) {
    const ways = [];
    let pistas = 0;
    for (const el of data.elements || []) {
      if (el.type !== "way" || !el.geometry || !el.nodes) continue;
      const tags = el.tags || {};
      if (tags.bicycle === "no" || tags.bicycle === "dismount") continue;
      if (tags.access === "private" || tags.access === "no") continue;
      if (FILTRAR_PISTAS && esPistaDeCoche(tags)) { pistas++; continue; }
      ways.push({
        id: el.id,
        nodes: el.nodes,
        pts: el.geometry.map(p => [p.lat, p.lon]),
        tags
      });
    }
    return { ways, pistas };
  }

  // ---------------------------------------------------------------------------
  // 2. AGRUPAR TRAMOS EN BAJADAS (por nombre y continuidad)
  // ---------------------------------------------------------------------------
  function nombresDe(w) {
    const s = new Set();
    for (const n of [w.tags.name, w.tags["mtb:name"]]) if (n && n.trim()) s.add(n.trim().toLowerCase());
    return s;
  }
  const claveDif = w => w.tags["mtb:scale:imba"] || w.tags["mtb:scale"] || null;

  function compatibles(a, b) {
    const na = nombresDe(a), nb = nombresDe(b);
    if (na.size || nb.size) { for (const n of na) if (nb.has(n)) return true; return false; }
    return claveDif(a) === claveDif(b);
  }

  // Une tramos conectados por extremos en cadenas ordenadas: [{ways, pts, segs:[[way, pts]...]}]
  function construirCadenas(ways) {
    const unused = new Map(ways.map(w => [w.id, w]));
    const porNodo = new Map();
    const anota = (n, id) => { if (!porNodo.has(n)) porNodo.set(n, new Set()); porNodo.get(n).add(id); };
    for (const w of ways) { anota(w.nodes[0], w.id); anota(w.nodes[w.nodes.length - 1], w.id); }
    const libres = n => { let c = 0; for (const id of porNodo.get(n)) if (unused.has(id)) c++; return c; };
    const extremoLibre = w => {
      if (libres(w.nodes[0]) === 1) return "start";
      if (libres(w.nodes[w.nodes.length - 1]) === 1) return "end";
      return null;
    };
    const orden = [...ways].sort((x, y) => x.id - y.id);

    const cadenas = [];
    while (unused.size) {
      let start = null, startFree = null;
      for (const w of orden) {
        if (!unused.has(w.id)) continue;
        const fe = extremoLibre(w);
        if (fe) { start = w; startFree = fe; break; }
      }
      if (!start) { start = orden.find(w => unused.has(w.id)); startFree = "start"; }  // bucle cerrado

      let nodes = [...start.nodes], pts = [...start.pts];
      if (startFree === "end") { nodes.reverse(); pts.reverse(); }
      const used = [start], segs = [[start, [...pts]]];
      unused.delete(start.id);

      while (true) {
        const fin = nodes[nodes.length - 1];
        let nxt = null;
        for (const id of porNodo.get(fin) || []) {
          if (unused.has(id) && (!nxt || id < nxt.id)) nxt = unused.get(id);
        }
        if (!nxt) break;
        let nn = [...nxt.nodes], np = [...nxt.pts];
        if (nn[0] !== fin) { nn.reverse(); np.reverse(); }
        for (let i = 1; i < nn.length; i++) nodes.push(nn[i]);
        for (let i = 1; i < np.length; i++) pts.push(np[i]);
        used.push(nxt);
        segs.push([nxt, [...np]]);
        unused.delete(nxt.id);
      }
      cadenas.push({ ways: used, pts, segs });
    }
    return cadenas;
  }

  function agrupar(ways) {
    const parent = ways.map((_, i) => i);
    const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const porNodo = new Map();
    ways.forEach((w, i) => {
      for (const n of [w.nodes[0], w.nodes[w.nodes.length - 1]]) {
        if (!porNodo.has(n)) porNodo.set(n, []);
        porNodo.get(n).push(i);
      }
    });
    for (const idxs of porNodo.values()) {
      for (let x = 0; x < idxs.length; x++) {
        for (let y = x + 1; y < idxs.length; y++) {
          if (compatibles(ways[idxs[x]], ways[idxs[y]])) parent[find(idxs[x])] = find(idxs[y]);
        }
      }
    }
    const comps = new Map();
    ways.forEach((w, i) => {
      const r = find(i);
      if (!comps.has(r)) comps.set(r, []);
      comps.get(r).push(w);
    });
    const out = [];
    for (const grupo of comps.values()) out.push(...construirCadenas(grupo));
    return out;
  }

  function candidatas(ways) {
    const out = [];
    for (const g of agrupar(ways)) {
      const longitud = pathLength(g.pts);
      if (longitud < MIN_LENGTH_M) continue;
      out.push({
        id: "b" + Math.min(...g.ways.map(w => w.id)),
        ways: g.ways, segs: g.segs, pts: g.pts, longitud
      });
    }
    return out;
  }

  /**
   * Descarga y agrupa los senderos MTB de una zona.
   * @param {number[]} bbox [sur, oeste, norte, este]
   * @param {Function} onEstado callback(msg)
   * @returns {Promise<Array>} candidatas (sin elevación ni orientación)
   */
  async function descargarZona(bbox, onEstado) {
    const estado = onEstado || (() => {});
    const s = Math.floor(bbox[0] * 1e4) / 1e4, w = Math.floor(bbox[1] * 1e4) / 1e4;
    const n = Math.ceil(bbox[2] * 1e4) / 1e4, e = Math.ceil(bbox[3] * 1e4) / 1e4;
    const bb = [s, w, n, e];

    let data = null;
    const guardado = await buscarCache(bb);
    if (guardado) {
      estado("Usando los senderos de esta zona descargados hace poco…");
      data = guardado.bbox.every((v, i) => v === bb[i]) ? guardado.data : recortarData(guardado.data, bb);
    } else {
      const b = `${s},${w},${n},${e}`;
      const query = `[out:json][timeout:60];(`
        + `way["highway"~"^(path|track)$"]["mtb:scale"](${b});`
        + `way["highway"~"^(path|track)$"]["mtb:name"](${b});`
        + `);out body geom qt;`;
      data = await consultarOverpass(query, estado);
      guardarCache(bb, data);   // sin await: no hace falta esperar para seguir
    }
    const { ways, pistas } = tramosValidos(data);
    estado(`${ways.length} tramos con etiquetas MTB (${pistas} pistas de coche descartadas). Agrupando…`);
    return candidatas(ways);
  }

  // ---------------------------------------------------------------------------
  // 3. DIFICULTAD Y TRAMOS COLOREADOS
  // ---------------------------------------------------------------------------
  function colorTramo(tags) {
    const imba = parseEntero(tags["mtb:scale:imba"]);
    const scale = parseEntero(tags["mtb:scale"]);
    if (imba !== null) return [colorDeNivel(imba), "osm_imba"];
    if (scale !== null) return [colorDeNivel(scale), "osm_scale"];
    return [null, null];
  }

  // Color mayoritario por metros; los tramos sin etiqueta no cuentan.
  function dificultad(ways) {
    const metros = {};
    const scales = [], imbas = [];
    for (const w of ways) {
      const sc = parseEntero(w.tags["mtb:scale"]), im = parseEntero(w.tags["mtb:scale:imba"]);
      if (sc !== null) scales.push(sc);
      if (im !== null) imbas.push(im);
      const [color] = colorTramo(w.tags);
      if (color) metros[color] = (metros[color] || 0) + pathLength(w.pts);
    }
    const colores = Object.keys(metros);
    if (!colores.length) return { color: null, fuente: null, scale: null, imba: null, detalle: {} };
    const rango = { verde: 0, azul: 1, rojo: 2, negro: 3 };   // en empate, gana el más difícil
    colores.sort((a, b) => (metros[b] - metros[a]) || (rango[b] - rango[a]));
    const detalle = {};
    for (const c of colores) detalle[c] = Math.round(metros[c]);
    return {
      color: colores[0],
      fuente: imbas.length ? "osm_imba" : "osm_scale",
      scale: scales.length ? Math.max(...scales) : null,
      imba: imbas.length ? Math.max(...imbas) : null,
      detalle
    };
  }

  function hexMix(c1, c2, f) {
    const a = [1, 3, 5].map(i => parseInt(c1.slice(i, i + 2), 16));
    const b = [1, 3, 5].map(i => parseInt(c2.slice(i, i + 2), 16));
    return "#" + a.map((x, i) => Math.round(x + (b[i] - x) * f).toString(16).padStart(2, "0")).join("");
  }

  function unirTramos(tramos) {
    const runs = [];
    for (const t of tramos) {
      const ult = runs[runs.length - 1];
      if (ult && ult.color === t.color) {
        ult.b = t.b; ult.way_ids.push(t.way_id);
        if (ult.fuente !== t.fuente) ult.fuente = "mixta";
      } else {
        runs.push({ a: t.a, b: t.b, color: t.color, fuente: t.fuente, way_ids: [t.way_id] });
      }
    }
    return runs;
  }

  // Trozos consecutivos con transiciones de color entre dos tramos contiguos que tengan dificultad.
  function construirTrozos(runs) {
    const n = runs.length;
    const half = new Array(Math.max(0, n - 1)).fill(0);
    for (let i = 0; i < n - 1; i++) {
      if (runs[i].color === null || runs[i + 1].color === null) continue;
      const l1 = runs[i].b - runs[i].a, l2 = runs[i + 1].b - runs[i + 1].a;
      half[i] = Math.min(BLEND_M / 2, l1 / 3, l2 / 3);
    }
    const trozos = [];
    runs.forEach((r, i) => {
      const izq = i > 0 ? half[i - 1] : 0, der = i < n - 1 ? half[i] : 0;
      const a = r.a + izq, b = r.b - der;
      if (b - a > 0.5) trozos.push({ a, b, color: r.color, hex: hexDe(r.color), tipo: "tramo", run: i });
      if (i < n - 1 && half[i] > 0) {
        const c1 = hexDe(r.color), c2 = hexDe(runs[i + 1].color);
        const x0 = r.b - half[i], w = 2 * half[i];
        for (let k = 0; k < BLEND_STEPS; k++) {
          trozos.push({
            a: x0 + w * k / BLEND_STEPS, b: x0 + w * (k + 1) / BLEND_STEPS,
            color: "mezcla", hex: hexMix(c1, c2, (k + 0.5) / BLEND_STEPS), tipo: "transicion", run: i
          });
        }
      }
    });
    return trozos;
  }

  function puntoEn(pts, cum, x) {
    if (x <= 0) return [r6(pts[0][1]), r6(pts[0][0])];
    for (let j = 0; j < pts.length - 1; j++) {
      if (x <= cum[j + 1]) {
        const seg = cum[j + 1] - cum[j];
        const f = seg === 0 ? 0 : (x - cum[j]) / seg;
        return [r6(pts[j][1] + (pts[j + 1][1] - pts[j][1]) * f), r6(pts[j][0] + (pts[j + 1][0] - pts[j][0]) * f)];
      }
    }
    const u = pts[pts.length - 1];
    return [r6(u[1]), r6(u[0])];
  }
  function trocear(pts, cum, a, b) {
    const out = [puntoEn(pts, cum, a)];
    for (let j = 0; j < pts.length; j++) if (cum[j] > a && cum[j] < b) out.push([r6(pts[j][1]), r6(pts[j][0])]);
    out.push(puntoEn(pts, cum, b));
    return out;
  }

  // ---------------------------------------------------------------------------
  // 4. EVALUAR UNA CANDIDATA CON LA ELEVACIÓN DE SUS DOS EXTREMOS
  // ---------------------------------------------------------------------------
  /**
   * @param {Object} c candidata (de descargarZona)
   * @param {number} eIni elevación del primer punto de c.pts
   * @param {number} eFin elevación del último punto de c.pts
   * @returns {{feature:Object, tramos:Array}|null} null si el sentido no es fiable
   */
  function evaluar(c, eIni, eFin) {
    if (!Number.isFinite(eIni) || !Number.isFinite(eFin)) return null;
    let segs = c.segs, pts = c.pts, e0 = eIni, e1 = eFin;
    if (e0 < e1) {   // orientar: inicio arriba, final abajo
      segs = [...c.segs].reverse().map(([w, sp]) => [w, [...sp].reverse()]);
      pts = [...c.pts].reverse();
      [e0, e1] = [e1, e0];
    }
    const total = c.longitud;
    const caida = e0 - e1;
    const pend = caida / total * 100;
    if (caida < MIN_CAIDA_M || pend < MIN_PEND_PCT) return null;   // ante la duda, no se muestra

    const tagsList = c.ways.map(w => w.tags);
    const dif = dificultad(c.ways);
    const mtbName = masComun(tagsList.map(t => t["mtb:name"]));
    const name = masComun(tagsList.map(t => t.name));
    const anchos = tagsList.map(t => parseNum(t.width)).filter(v => v !== null);
    const id = c.id;
    const fiabilidad = (mtbName || name) && dif.color ? "osm" : "detectada";
    const coords = pts.map(([la, lo]) => [r6(lo), r6(la)]);

    const props = {
      id,
      nombre: mtbName || name || null,
      nombre_osm: name,
      mtb_name: mtbName,
      way_ids: c.ways.map(w => w.id),
      n_tramos: c.ways.length,
      longitud_m: Math.round(total),
      caida_m: Math.round(caida),
      pendiente_media_pct: Math.round(pend * 10) / 10,
      elev_inicio_m: Math.round(e0),
      elev_final_m: Math.round(e1),
      highway: masComun(tagsList.map(t => t.highway)),
      es_bajada: true,
      dificultad_color: dif.color,
      dificultad_fuente: dif.fuente,
      dificultad_detalle_m: dif.detalle,
      mtb_scale_max: dif.scale,
      mtb_scale_imba_max: dif.imba,
      mtb_type: masComun(tagsList.map(t => t["mtb:type"])),
      surface: masComun(tagsList.map(t => t.surface)),
      smoothness: masComun(tagsList.map(t => t.smoothness)),
      ancho_m: masComun(anchos),
      incline_osm: masComun(tagsList.map(t => t.incline)),
      fiabilidad,
      perfil_cargado: false,     // true cuando se ha pedido el perfil completo (Elev.cargarPerfil)
      _cat: dif.color || "sin",
      _osm: fiabilidad === "osm",
      inicio: coords[0],
      fin: coords[coords.length - 1]
    };
    const feature = { type: "Feature", properties: props, geometry: { type: "LineString", coordinates: coords } };

    // Trozos coloreados (con degradado) para dibujar el mapa, sobre la geometría original
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
    let acum = 0;
    const tramosOsm = [];
    for (const [w, sp] of segs) {
      const ln = pathLength(sp);
      const [color, fuente] = colorTramo(w.tags);
      tramosOsm.push({ a: acum, b: acum + ln, way_id: w.id, color, fuente });
      acum += ln;
    }
    const k = acum > 0 ? cum[cum.length - 1] / acum : 1;   // ajuste por redondeos
    tramosOsm.forEach(t => { t.a *= k; t.b *= k; });
    const runs = unirTramos(tramosOsm);
    const tramos = [];
    construirTrozos(runs).forEach((t, orden) => {
      const linea = trocear(pts, cum, t.a, t.b);
      if (linea.length < 2) return;
      const r = runs[t.run];
      tramos.push({
        type: "Feature",
        properties: {
          bajada_id: id, nombre: props.nombre || "", orden, tipo: t.tipo, color: t.color, stroke: t.hex,
          dificultad_fuente: r.fuente, way_ids: r.way_ids, longitud_m: Math.round(t.b - t.a),
          _cat: props._cat, _osm: props._osm
        },
        geometry: { type: "LineString", coordinates: linea }
      });
    });
    return { feature, tramos };
  }

  window.OSM = {
    descargarZona, evaluar, areaKm2,
    MAX_AREA_KM2, MIN_LENGTH_M, MIN_CAIDA_M, MIN_PEND_PCT
  };
})();
