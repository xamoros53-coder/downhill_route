// 18-gpx-import.js (líneas 2540-2869 del index.html original)
// ---- Importar GPX: la ruta se reconstruye como si la hubiera generado la app ----
// Se lee el track, se cargan las bajadas de la zona, se reconocen las que el track recorre (en su sentido)
// y se monta el mismo resultado que genera BRouter: segmentos «bajada»/«enlace», perfil, marcas de km y modo seguir.
const GPX_TOL_M = 30;          // distancia máxima entre el track y una bajada para darla por recorrida
const GPX_COBERTURA = 0.85;    // parte mínima de la bajada que debe seguir el track
const GPX_PASO_M = 10;         // el track se rellena para que no haya puntos separados más de esto
const btnImportarGPX = document.getElementById("btnImportarGPX");
const gpxInput = document.getElementById("gpxInput");

function gpxMetros(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Devuelve [[lat, lon, ele|null], ...] con todos los tracks (o, si no hay, la ruta) del archivo
function leerGPX(texto) {
  const doc = new DOMParser().parseFromString(texto, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("El archivo no es un GPX válido.");
  let nodos = [...doc.getElementsByTagName("trkpt")];
  if (nodos.length < 2) nodos = [...doc.getElementsByTagName("rtept")];
  const pts = [];
  for (const n of nodos) {
    const lat = parseFloat(n.getAttribute("lat")), lon = parseFloat(n.getAttribute("lon"));
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const e = n.getElementsByTagName("ele")[0], ele = e ? parseFloat(e.textContent) : NaN;
    pts.push([lat, lon, isFinite(ele) ? ele : null]);
  }
  const lim = [];   // quita los puntos casi repetidos (parado, GPS en reposo)
  pts.forEach((p, i) => {
    const q = lim[lim.length - 1];
    if (!q || gpxMetros(q[0], q[1], p[0], p[1]) >= 3 || i === pts.length - 1) lim.push(p);
  });
  return lim;
}

// Track con un punto cada ≤10 m y distancia acumulada (así el emparejado no depende de cada cuánto grabó el GPS)
function gpxDensificar(pts) {
  const D = [{ lat: pts[0][0], lon: pts[0][1], ele: pts[0][2], d: 0 }];
  let d = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], L = gpxMetros(a[0], a[1], b[0], b[1]);
    const n = (L > GPX_PASO_M && L <= 300) ? Math.ceil(L / GPX_PASO_M) : 1;   // un hueco grande no se rellena
    for (let k = 1; k <= n; k++) {
      const t = k / n; d += L / n;
      D.push({
        lat: a[0] + (b[0] - a[0]) * t, lon: a[1] + (b[1] - a[1]) * t,
        ele: (a[2] === null || b[2] === null) ? (k === n ? b[2] : a[2]) : a[2] + (b[2] - a[2]) * t, d
      });
    }
  }
  return D;
}

// Rejilla en metros para buscar rápido qué puntos del track hay cerca de un sitio
function gpxIndice(D) {
  const lat0 = D[0].lat, lon0 = D[0].lon, kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 111320, C = GPX_TOL_M;
  const celdas = new Map();
  D.forEach((p, i) => {
    p.x = (p.lon - lon0) * kx; p.y = (p.lat - lat0) * ky;
    const k = Math.floor(p.x / C) + "," + Math.floor(p.y / C);
    let a = celdas.get(k); if (!a) celdas.set(k, a = []);
    a.push(i);
  });
  const cerca = (x, y) => {   // índices del track a ≤ tolerancia, de menor a mayor
    const cx = Math.floor(x / C), cy = Math.floor(y / C), r = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const a = celdas.get((cx + dx) + "," + (cy + dy)); if (!a) continue;
      for (const i of a) if (Math.hypot(D[i].x - x, D[i].y - y) <= C) r.push(i);
    }
    return r.sort((p, q) => p - q);
  };
  return { lat0, lon0, kx, ky, cerca };
}

function gpxVertices(coords, ix) {   // la bajada en metros, con un punto cada ≤20 m
  const pr = c => ({ x: (c[0] - ix.lon0) * ix.kx, y: (c[1] - ix.lat0) * ix.ky });
  let prev = pr(coords[0]), L = 0;
  const V = [prev];
  for (let i = 1; i < coords.length; i++) {
    const q = pr(coords[i]), l = Math.hypot(q.x - prev.x, q.y - prev.y), n = Math.max(1, Math.ceil(l / 20));
    for (let k = 1; k <= n; k++) V.push({ x: prev.x + (q.x - prev.x) * k / n, y: prev.y + (q.y - prev.y) * k / n });
    L += l; prev = q;
  }
  return { V, L };
}

// Qué bajadas recorre el track: lo bastante pegado a ellas, de principio a fin y en su sentido de bajada.
// Devuelve las reconocidas; en .rechazadas las que pasan cerca del track pero no valen (con el motivo) y en .revisadas
// cuántas bajadas de la app hay en el área del track.
function gpxEmparejar(D, ix, feats) {
  let sMin = 90, nMax = -90, wMin = 180, eMax = -180;
  D.forEach(p => { if (p.lat < sMin) sMin = p.lat; if (p.lat > nMax) nMax = p.lat; if (p.lon < wMin) wMin = p.lon; if (p.lon > eMax) eMax = p.lon; });
  const m = 0.0006, res = [], rech = [];
  let revisadas = 0;
  for (const f of feats) {
    const c = f.geometry && f.geometry.coordinates;
    if (!c || c.length < 2) continue;
    let s0 = 90, n0 = -90, w0 = 180, e0 = -180;
    for (const q of c) { if (q[1] < s0) s0 = q[1]; if (q[1] > n0) n0 = q[1]; if (q[0] < w0) w0 = q[0]; if (q[0] > e0) e0 = q[0]; }
    if (n0 < sMin - m || s0 > nMax + m || e0 < wMin - m || w0 > eMax + m) continue;
    revisadas++;
    const { V, L } = gpxVertices(c, ix);
    if (L < 40) continue;
    const n = V.length, cand = V.map(v => ix.cerca(v.x, v.y));
    const cobAny = cand.filter(a => a.length).length / n;   // cuánto de la bajada toca el track, sin mirar orden ni sentido
    if (cobAny < 0.3) continue;                              // pasa lejos: no merece ni diagnóstico
    let k0 = -1;
    for (let k = 0; k < Math.min(3, n); k++) if (cand[k].length) { k0 = k; break; }
    let aceptada = false, mejorCob = 0, tramoMal = false;
    if (k0 >= 0) {
      const inicios = []; let ult = -1e9;   // cada pasada del track por el inicio de la bajada
      for (const i of cand[k0]) { if (i - ult > 15) inicios.push(i); ult = i; }
      for (const s of inicios) {
        let cur = s, ok = 1, fin = s;
        for (let k = k0 + 1; k < n; k++) {
          const arr = cand[k], dmin = D[cur].d - 20;
          let lo = 0, hi = arr.length;
          while (lo < hi) { const md = (lo + hi) >> 1; if (D[arr[md]].d < dmin) lo = md + 1; else hi = md; }
          if (lo < arr.length && D[arr[lo]].d - D[cur].d <= 150) { if (arr[lo] > cur) cur = arr[lo]; ok++; fin = cur; }   // siempre hacia delante: nunca retrocede
        }
        const cob = ok / n, tramo = D[fin].d - D[s].d;
        mejorCob = Math.max(mejorCob, cob);
        if (cob >= GPX_COBERTURA && tramo >= L * 0.6 && tramo <= L * 1.6) { aceptada = true; res.push({ f, s, e: fin, L, cob, score: cob * L }); }
        else if (cob >= GPX_COBERTURA) tramoMal = true;
      }
    }
    if (!aceptada) {
      let motivo;
      if (k0 < 0) motivo = "el track no pasa por su inicio";
      else if (tramoMal) motivo = "el track la toca pero con un recorrido distinto";
      else if (cobAny >= GPX_COBERTURA) motivo = "el track pasa por ella pero no de principio a fin en su sentido (¿al revés?)";
      else motivo = `el track solo sigue un ${Math.round(Math.max(mejorCob, 0) * 100)} % de su trazado`;
      rech.push({ f, motivo, cobAny });
    }
  }
  // si dos coinciden en el mismo trozo (variantes, sub-tramos, duplicados) se queda la más larga
  res.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const r of res) {
    let sol = 0;
    for (const k of kept) sol += Math.max(0, Math.min(r.e, k.e) - Math.max(r.s, k.s));
    if (sol <= 0.3 * (r.e - r.s)) kept.push(r);
  }
  kept.sort((a, b) => a.s - b.s);
  let tope = 0;
  for (const k of kept) { k.s = Math.max(k.s, tope); tope = Math.max(tope, k.e); }
  const fin = kept.filter(k => k.e - k.s >= 3);
  const ids = new Set(fin.map(k => k.f));
  fin.rechazadas = rech.filter(r => !ids.has(r.f)).sort((a, b) => b.cobAny - a.cobAny);
  fin.revisadas = revisadas;
  return fin;
}

// ¿Hay datos de bajadas en las celdas de 0,1° que toca el track? (lo más habitual cuando «no sale nada»)
function gpxDiagDatos(pts) {
  const G = 0.1, cel = new Set();
  pts.forEach(p => cel.add(Math.floor(p[0] / G + 1e-9) + "_" + Math.floor(p[1] / G + 1e-9)));
  const sin = [], fuera = [];
  for (const nom of cel) {
    const [f, c] = nom.split("_").map(Number), lat = (f + 0.5) * G, lon = (c + 0.5) * G;
    let dentro = false, hay = false;
    for (const [, idx] of zonasDatos) {
      const [s, w, n, e] = idx.bbox;
      if (lat >= s && lat <= n && lon >= w && lon <= e) { dentro = true; if (idx.celdas && nom in idx.celdas) hay = true; }
    }
    if (!hay) (dentro ? sin : fuera).push(nom);
  }
  return { sin, fuera };
}

function gpxAvisoDatos(dg) {
  const partes = [];
  if (dg.fuera.length) partes.push(`las celdas ${dg.fuera.join(", ")} están fuera de las zonas generadas`);
  if (dg.sin.length) partes.push(`las celdas ${dg.sin.join(", ")} están en una zona generada pero no contienen ninguna bajada`);
  return partes.length ? "Sin datos de bajadas: " + partes.join(" y ") + "." : "";
}

function gpxStats(pts) {   // desnivel acumulado con la cota suavizada y un umbral de 3 m contra el ruido del GPS
  const e = pts.map(p => p[2]);
  if (e.every(v => v === null)) return { sube: null, baja: null };
  let ult = null; const rell = e.map(v => (v === null ? ult : (ult = v)));
  const first = rell.find(v => v !== null);
  const lis = rell.map((v, i) => {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(rell.length - 1, i + 2); j++) { const w = rell[j] === null ? first : rell[j]; s += w; c++; }
    return s / c;
  });
  let ref = lis[0], sube = 0, baja = 0;
  for (const v of lis) { const d = v - ref; if (d >= 3) { sube += d; ref = v; } else if (d <= -3) { baja -= d; ref = v; } }
  return { sube: Math.round(sube), baja: Math.round(baja) };
}

function gpxLongitud(puntos) {
  let d = 0;
  for (let i = 1; i < puntos.length; i++) d += gpxMetros(puntos[i - 1][0], puntos[i - 1][1], puntos[i][0], puntos[i][1]);
  return d;
}

// Sin lista de bajadas (ya se ven en «Tus bajadas»): solo avisos cuando no se ha reconocido nada o faltan datos
function gpxResumen(segs, diag) {
  const el = document.getElementById("resumenRuta");
  const n = segs.filter(sg => sg.tipo === "bajada").length;
  let html = "";
  if (diag) {
    const aviso = gpxAvisoDatos(diag.datos);
    if (aviso) html += `<div class="imp-diag">⚠ ${esc(aviso)}</div>`;
    else if (!n) html += `<div class="imp-diag">No se ha reconocido ninguna bajada de la app en este recorrido. Hay ${diag.revisadas} bajada${diag.revisadas === 1 ? "" : "s"} en el área del track.</div>`;
    const rech = n ? [] : diag.rechazadas.slice(0, 6);
    if (rech.length) {
      html += `<div class="imp-diag"><b>Cerca del track pero no reconocidas:</b>`
        + rech.map(r => `<div>· ${esc(r.f.properties.nombre || ("sin nombre · " + idDe(r.f)))} — ${esc(r.motivo)}</div>`).join("")
        + (diag.rechazadas.length > 6 ? `<div>· … y ${diag.rechazadas.length - 6} más</div>` : "") + `</div>`;
    }
  }
  el.innerHTML = html;
  el.onclick = null;
}

let importandoGPX = false;
async function importarGPX(file) {
  if (importandoGPX) return;
  importandoGPX = true; document.body.classList.add("importando");
  try {
    const texto = await file.text();
    const pts = leerGPX(texto);
    if (pts.length < 2) throw new Error("El GPX no contiene ningún track con puntos.");
    if ((miRuta.length || rutaGenerada) && !confirm("Se sustituirá tu ruta actual por la del archivo GPX. ¿Continuar?")) return;
    setPanel(false);

    // 1) bajadas de la zona que cubre el track
    let S = 90, N = -90, W = 180, E = -180;
    pts.forEach(p => { if (p[0] < S) S = p[0]; if (p[0] > N) N = p[0]; if (p[1] < W) W = p[1]; if (p[1] > E) E = p[1]; });
    const mg = 0.003;
    setEstado("Cargando las bajadas de la zona del GPX…");
    while (cargandoZona) await new Promise(r => setTimeout(r, 150));
    await cargarZona(false, new maplibregl.LngLatBounds([W - mg, S - mg], [E + mg, N + mg]));

    // 2) qué bajadas recorre
    setEstado("Reconociendo las bajadas del recorrido…");
    await new Promise(r => setTimeout(r, 30));   // deja pintar el aviso
    const D = gpxDensificar(pts), ix = gpxIndice(D);
    const incluirInferidas = !!(document.getElementById("modoAmplio") || {}).checked;
    const candidatas = [...porId.values()].filter(f => !descartadas.has(idDe(f)) && (incluirInferidas || f.properties.origen !== "inferida"));
    let kept = gpxEmparejar(D, ix, candidatas);
    for (const k of kept) {   // el perfil de la bajada hace falta para tenerla en tu ruta
      const p = k.f.properties;
      if (!p.perfil_cargado && !p._precalc) { try { await asegurarPerfil(idDe(k.f)); } catch (e) {} }
    }
    kept = kept.filter(k => porId.has(idDe(k.f)));

    // 3) la lista «Tus bajadas» (guardarMiRuta borra cualquier ruta anterior, por eso va antes de fijar la nueva)
    // el punto de salida del GPX va el primero de la lista, como un punto de la ruta (📍)
    let lugarSalida = null;
    try { lugarSalida = await nombreDeLugar(pts[0][0], pts[0][1]); } catch (e) {}
    const idSalida = "wp:" + Date.now();
    puntosInter.set(idSalida, lugarSalida ? [pts[0][0], pts[0][1], lugarSalida] : [pts[0][0], pts[0][1]]);
    miRuta.length = 0; miRuta.push(idSalida);
    kept.forEach(k => { const id = idDe(k.f); if (!miRuta.includes(id)) miRuta.push(id); });
    puntoInicio = null; puntoFin = null;
    guardarMiRuta(); guardarPuntos();
    renderMiRuta(); actualizarBotonesRuta(); actualizarPopupBoton(); deseleccionar();

    // 4) segmentos como los de la ruta generada: enlace → bajada → enlace → …
    const P = D.map(q => [q.lat, q.lon, q.ele]);
    const segs = [];
    let cur = 0;
    for (const k of kept) {
      if (k.s > cur) segs.push({ tipo: "enlace", nombre: null, puntos: P.slice(cur, k.s + 1), color: COLOR_RUTA });
      segs.push({ tipo: "bajada", nombre: k.f.properties.nombre || "", puntos: P.slice(k.s, k.e + 1), color: colorDe(k.f.properties) });
      cur = k.e;
    }
    if (cur < P.length - 1) segs.push({ tipo: "enlace", nombre: null, puntos: P.slice(cur), color: COLOR_RUTA });

    const a = pts[0], z = pts[pts.length - 1];
    document.getElementById("volverInicio").checked = gpxMetros(a[0], a[1], z[0], z[1]) < 150;
    rutaGenerada = { gpx: texto, segmentos: segs, stats: gpxStats(pts), importada: true };
    actualizarBotonGenerar();
    dibujarRuta(segs);
    mostrarPerfil(segs, rutaGenerada.stats, [{ punto: true, lat: pts[0][0], lon: pts[0][1], nombre: lugarSalida ? `Punto 1 · ${lugarSalida}` : "Punto 1" }]);
    document.getElementById("btnGenerar").textContent = "Descargar GPX";
    mostrarBotonSeguir(true);
    const diag = { datos: gpxDiagDatos(pts), rechazadas: kept.rechazadas || [], revisadas: kept.revisadas || 0 };
    gpxResumen(segs, diag);
    actualizarPasos();
    const nb = kept.length, km = (D[D.length - 1].d / 1000).toFixed(1).replace(".", ",");
    setEstado(nb
      ? `GPX importado: ${km} km y ${nb} bajada${nb === 1 ? "" : "s"} reconocida${nb === 1 ? "" : "s"}. Ya puedes seguir la ruta.`
      : `GPX importado (${km} km), pero no coincide con ninguna bajada de la app. ${gpxAvisoDatos(diag.datos) || ("Hay " + diag.revisadas + " bajadas en el área del track; mira el detalle en el panel.")} Puedes seguirla igualmente.`);
    toast(nb ? `✓ GPX importado · ${nb} bajada${nb === 1 ? "" : "s"}` : "GPX importado · sin bajadas reconocidas", 3000);
  } catch (e) {
    console.error("[gpx]", e);
    setEstado("No se pudo importar el GPX: " + (e && e.message ? e.message : e));
    toast("No se pudo importar el GPX", 3500);
  } finally {
    importandoGPX = false; document.body.classList.remove("importando");
  }
}

btnImportarGPX.addEventListener("click", () => gpxInput.click());
gpxInput.addEventListener("change", () => { const f = gpxInput.files && gpxInput.files[0]; gpxInput.value = ""; if (f) importarGPX(f); });
// En escritorio también vale arrastrar el archivo sobre el mapa
mapwrapEl.addEventListener("dragover", (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
mapwrapEl.addEventListener("drop", (e) => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  e.preventDefault();
  if (/\.gpx$/i.test(f.name) || /xml|gpx/i.test(f.type)) importarGPX(f); else toast("Suelta un archivo .gpx");
});

