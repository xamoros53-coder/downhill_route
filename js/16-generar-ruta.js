// 16-generar-ruta.js (líneas 2253-2399 del index.html original)
// ---- Detección de saltos: huecos entre tramos o líneas rectas sin camino ----
const MAX_SALTO_M = 100;   // hueco máximo entre el final de un tramo y el inicio del siguiente (BRouter ya ajusta a su red)
const MAX_PASO_M = 1500;   // distancia máxima entre dos puntos seguidos de un mismo tramo
const MAX_RECTA_ENLACE_M = 80;   // un enlace de solo 1-2 puntos más largo que esto es una recta, no un camino
function buscarSaltos(segs) {
  const res = [];
  const nombreCerca = (i, dir) => {
    for (let j = i; j >= 0 && j < segs.length; j += dir) if (segs[j].tipo === "bajada" && segs[j].nombre) return `«${segs[j].nombre}»`;
    return dir < 0 ? "el tramo anterior" : "el tramo siguiente";
  };
  const alta = (d, p, q, iDesde, iHasta) => res.push({ d, lat: p[0], lon: p[1], lat2: q[0], lon2: q[1], desde: nombreCerca(iDesde, -1), hasta: nombreCerca(iHasta, 1) });
  let prev = null, prevIdx = -1;
  segs.forEach((sg, i) => {
    const p = sg.puntos;
    if (!p || !p.length) return;
    if (prev) { const d = haversine([prev[0], prev[1]], [p[0][0], p[0][1]]); if (d > MAX_SALTO_M) alta(d, prev, p[0], prevIdx, i); }
    for (let k = 1; k < p.length; k++) {
      const d = haversine([p[k - 1][0], p[k - 1][1]], [p[k][0], p[k][1]]);
      if (d > MAX_PASO_M) alta(d, p[k - 1], p[k], i, i);
    }
    if (sg.tipo === "enlace" && p.length <= 2) {
      const d = haversine([p[0][0], p[0][1]], [p[p.length - 1][0], p[p.length - 1][1]]);
      if (d > MAX_RECTA_ENLACE_M) alta(d, p[0], p[p.length - 1], i, i);
    }
    prev = p[p.length - 1]; prevIdx = i;
  });
  return res;
}
function avisarSaltos(saltos) {
  const m = saltos.reduce((a, x) => x.d > a.d ? x : a, saltos[0]);
  mostrarSaltos(saltos);
  const dist = fmtLong(Math.round(m.d)), de = m.desde || "el tramo anterior", a = m.hasta || "el tramo siguiente";
  const que = m.motivo === "sin-ruta"
    ? `BRouter no encuentra camino entre ${de} y ${a} (${dist} en línea recta)`
    : `hay un salto de ${dist} sin camino entre ${de} y ${a}`;
  document.getElementById("estadoRuta").textContent = `⚠ Ruta no generada: ${que}`
    + (saltos.length > 1 ? ` (y ${saltos.length - 1} más)` : "")
    + ". Está marcado en rojo en el mapa. Prueba otro modo de enrutamiento, cambia el orden o añade un punto intermedio.";
}
function mostrarSaltos(saltos) {
  const feats = [];
  saltos.forEach(sj => {
    feats.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[sj.lon, sj.lat], [sj.lon2, sj.lat2]] } });
    feats.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [sj.lon, sj.lat] } });
    feats.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [sj.lon2, sj.lat2] } });
  });
  const data = { type: "FeatureCollection", features: feats };
  if (map.getSource("ruta-salto")) map.getSource("ruta-salto").setData(data);
  else {
    map.addSource("ruta-salto", { type: "geojson", data });
    map.addLayer({ id: "ruta-salto-linea", type: "line", source: "ruta-salto", filter: ["==", ["geometry-type"], "LineString"], paint: { "line-color": "#d62f2f", "line-width": 4, "line-dasharray": [2, 1.5] } });
    map.addLayer({ id: "ruta-salto-pt", type: "circle", source: "ruta-salto", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 7, "circle-color": "#d62f2f", "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
  }
  const bnd = new maplibregl.LngLatBounds();
  saltos.forEach(sj => { bnd.extend([sj.lon, sj.lat]); bnd.extend([sj.lon2, sj.lat2]); });
  if (!bnd.isEmpty()) map.fitBounds(bnd, { padding: 90, maxZoom: 16, duration: 600 });
}

// Quita la ruta calculada (porque algo ha cambiado o se empieza de cero)
function invalidarRuta() {
  versionRuta++;
  const hab = rutaGenerada !== null;
  rutaGenerada = null;
  const src = map.getSource("ruta-generada");
  if (src) src.setData({ type: "FeatureCollection", features: [] });
  ["ruta-km", "ruta-adelante"].forEach(id => { const q = map.getSource(id); if (q) q.setData(VACIO); });
  const srcSalto = map.getSource("ruta-salto");
  if (srcSalto) srcSalto.setData({ type: "FeatureCollection", features: [] });
  document.getElementById("resumenRuta").innerHTML = "";
  document.getElementById("btnGenerar").textContent = "Generar ruta";
  detenerSeguir(); mostrarBotonSeguir(false);
  ocultarPerfil(); actualizarPasos();
  if (hab) document.getElementById("estadoRuta").textContent = "";
}

document.getElementById("btnGenerar").addEventListener("click", async () => {
  if (rutaGenerada) { descargarRuta(); return; }
  if (!puedeGenerar()) return;
  let nPunto = 0;
  const seleccion = miRuta.map(id => {
    if (esPunto(id)) { const pt = puntosInter.get(id); return pt ? { punto: true, lat: pt[0], lon: pt[1], nombre: (pt[2] ? `Punto ${++nPunto} · ${pt[2]}` : `Punto ${++nPunto}`) } : null; }
    return porId.get(id);
  }).filter(Boolean);
  const soloBajadas = seleccion.filter(x => !x.punto);
  const perfil = document.getElementById("perfil").value;
  const btn = document.getElementById("btnGenerar");
  const estado = document.getElementById("estadoRuta");
  const volver = document.getElementById("volverInicio").checked;
  const primero = seleccion[0];
  const inicioRuta = primero.punto ? [primero.lat, primero.lon]
    : (primero.properties.inicio ? [primero.properties.inicio[1], primero.properties.inicio[0]]
      : [primero.geometry.coordinates[0][1], primero.geometry.coordinates[0][0]]);
  const fin = volver ? inicioRuta : null;   // circular: vuelve al primer punto/bajada de la lista
  invalidarRuta();
  setPanel(false);
  const version = versionRuta;
  btn.disabled = true;
  estado.textContent = "Iniciando...";
  try {
    const todasLasBajadas = [...porId.values()];   // (ya no se usa: ruta.js calcula los nogos con la bajada previa y las que quedan por delante en la ruta)
    const r = await window.generarRutaGPX(seleccion, null, fin, perfil, (msg) => { if (version === versionRuta) estado.textContent = msg; }, todasLasBajadas);
    if (version !== versionRuta) { estado.textContent = "La selección cambió mientras se calculaba. Vuelve a generar."; return; }
    const saltos = buscarSaltos(r.segmentos);
    if (saltos.length) { avisarSaltos(saltos); return; }   // red de seguridad: no se da por buena una ruta con huecos o rectas
    rutaGenerada = r; actualizarPasos();
    let bi = 0;
    r.segmentos.forEach(sg => { sg.color = sg.tipo === "bajada" ? colorDe(soloBajadas[bi++].properties) : COLOR_RUTA; });
    dibujarRuta(r.segmentos);
    mostrarPerfil(r.segmentos, r.stats, seleccion.filter(x => x.punto));
    document.getElementById("btnGenerar").textContent = "Descargar GPX";
    mostrarBotonSeguir(true);
    const sinEvitar = r.segmentos.filter(sg => sg.tipo === "enlace" && sg.conNogo === false).length;
    estado.textContent = "Ruta lista. Revísala en el mapa y descarga el GPX."
      + (sinEvitar ? ` ⚠ ${sinEvitar} enlace${sinEvitar === 1 ? "" : "s"} no ha${sinEvitar === 1 ? "" : "n"} podido evitar subir por alguna bajada.` : "");
  } catch (e) {
    if (e && e.saltos && e.saltos.length) {   // ruta.js no ha podido unir algún tramo
      if (version === versionRuta) avisarSaltos(e.saltos);
    } else {
      estado.textContent = "Error: " + e.message;
      console.error(e);
    }
  } finally {
    actualizarBotonGenerar();
  }
});

function descargarRuta() {
  if (!rutaGenerada) return;
  const hoy = new Date(), z = n => String(n).padStart(2, "0");
  window.descargarGPX(rutaGenerada.gpx, `ruta-${hoy.getFullYear()}-${z(hoy.getMonth() + 1)}-${z(hoy.getDate())}.gpx`);
  document.getElementById("estadoRuta").textContent = "GPX descargado ✓";
}

document.getElementById("btnBorrarTodo").addEventListener("click", () => {
  if (miRuta.length === 0 && !puntoInicio && !puntoFin && !rutaGenerada) return;
  if (!confirm("¿Limpiar la ruta? Se quitarán las bajadas, los puntos y la ruta generada.")) return;
  cerrarPopupPunto();
  miRuta.length = 0; puntoInicio = null; puntoFin = null;
  guardarMiRuta(); guardarPuntos(); invalidarRuta();
  document.getElementById("volverInicio").checked = true;
  document.getElementById("perfil").value = "trekking"; document.getElementById("infoPerfil").hidden = true; document.getElementById("btnInfoPerfil").setAttribute("aria-expanded", "false");
  deseleccionar();
  renderMiRuta(); actualizarBotonesRuta(); actualizarPopupBoton(); actualizarUIPuntos();
  document.getElementById("estadoRuta").textContent = "";
  ajustarVista();
});

