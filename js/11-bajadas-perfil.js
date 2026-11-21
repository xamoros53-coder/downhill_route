// 11-bajadas-perfil.js (líneas 1467-1600 del index.html original)
// ---- Perfil completo de una bajada (se pide al abrirla o al añadirla a la ruta) ----
function asegurarPerfil(id) {
  const f = porId.get(id);
  if (!f) return Promise.resolve(false);
  if (f.properties.perfil_cargado || f.properties._precalc) return Promise.resolve(true);
  if (typeof Elev === "undefined") { descartarBajada(id, "sin perfil de elevación"); return Promise.resolve(false); }
  if (perfilesEnCurso.has(id)) return perfilesEnCurso.get(id);
  const prom = (async () => {
    try {
      const r = await Elev.cargarPerfil(f);
      if (!r.ok) { descartarBajada(id, r.motivo); return false; }
      guardarBajadasLocal();   // el perfil cambia la geometría: se actualiza la copia del móvil
      return true;
    } finally {
      perfilesEnCurso.delete(id);
    }
  })();
  perfilesEnCurso.set(id, prom);
  return prom;
}

function descartarBajada(id, motivo) {
  const f = porId.get(id);
  const nombre = f && f.properties.nombre ? `«${f.properties.nombre}»` : "Una bajada";
  porId.delete(id); tramosPorId.delete(id); tiempoCarga.delete(id); descartadas.add(id);
  guardarBajadasLocal();
  try { localStorage.setItem(STORAGE_DESCARTADAS, JSON.stringify([...descartadas])); } catch (e) {}
  if (seleccionada === id) deseleccionar();
  const i = miRuta.indexOf(id);
  if (i >= 0) { miRuta.splice(i, 1); guardarMiRuta(); renderMiRuta(); actualizarBotonGenerar(); }
  actualizarMapa();
  setEstado(`${nombre} se ha retirado: ${motivo}.`);
}

function cargarIcono(nombre, color) {
  return new Promise((resolve) => {
    if (map.hasImage(nombre)) return resolve();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect x="5" y="5" width="22" height="22" rx="2" fill="${color}" stroke="#ffffff" stroke-width="3"/></svg>`;
    const img = new Image(32, 32);
    img.onload = () => { if (!map.hasImage(nombre)) map.addImage(nombre, img); resolve(); };
    img.onerror = () => resolve();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}

async function cargarCapas() {
  map.addSource("tramos", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "tramos-halo", type: "line", source: "tramos", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": 8, "line-opacity": 0.6 } });
  map.addLayer({ id: "tramos-miruta", type: "line", source: "tramos", filter: ["==", ["get", "bajada_id"], ""], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": COLOR_RUTA, "line-opacity": 0.85, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 6, 14, 9, 17, 13] } });
  map.addLayer({ id: "tramos-sel", type: "line", source: "tramos", filter: ["==", ["get", "bajada_id"], ""], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffd400", "line-opacity": 0.9, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 6, 14, 10, 17, 14] } });
  map.addLayer({ id: "tramos-line", type: "line", source: "tramos", layout: { "line-cap": "butt", "line-join": "round" }, paint: { "line-color": ["get", "stroke"], "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 14, 4, 17, 7] } });
  // Capa invisible más ancha para facilitar el toque sin engordar el trazo visible.
  map.addLayer({ id: "tramos-hit", type: "line", source: "tramos", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#000000", "line-opacity": 0.01, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 10, 14, 14, 17, 18] } }, "tramos-line");

  map.addSource("puntos", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "puntos-inicio", type: "circle", source: "puntos", filter: ["==", ["get", "tipo"], "inicio"], paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 2.5, 14, 4, 16, 5], "circle-color": "#ffffff", "circle-stroke-color": ["get", "_color"], "circle-stroke-width": 2 } });
  await Promise.all(CATS.map(c => cargarIcono("cuadrado-" + c, COLORES[c])));
  map.addLayer({ id: "puntos-final", type: "symbol", source: "puntos", filter: ["==", ["get", "tipo"], "final"], layout: { "icon-image": ["concat", "cuadrado-", ["get", "_cat"]], "icon-size": ["interpolate", ["linear"], ["zoom"], 10, 0.3, 14, 0.45, 17, 0.65], "icon-allow-overlap": true, "icon-ignore-placement": true } });

  crearFlecha();
  map.addSource("sel-flechas", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "sel-flechas", type: "symbol", source: "sel-flechas", layout: { "symbol-placement": "line", "symbol-spacing": 55,
    "icon-image": "flecha-ruta", "icon-size": ["interpolate", ["linear"], ["zoom"], 10, 0.35, 14, 0.5, 17, 0.7],
    "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": true } }, "puntos-inicio");

  let ultimoToque = 0;
  const clic = (e) => {
    if (modoMarcar || !e.features || !e.features.length) return;
    if (Date.now() - ultimoToque < 650) return;
    ultimoToque = Date.now();
    const id = e.features[0].properties.bajada_id;
    seleccionar(id, { lngLat: e.lngLat });
  };
  map.on("click", "tramos-hit", clic);
  map.on("click", "tramos-line", clic);
  map.on("click", "puntos-inicio", clic);
  map.on("click", "puntos-final", clic);
  // En móvil solo interpretamos como selección un toque breve y casi inmóvil.
  // Los arrastres para mover el mapa no deben abrir fichas.
  let toqueInicio = null;
  map.on("touchstart", (e) => {
    if (!e.point || (e.originalEvent && e.originalEvent.touches && e.originalEvent.touches.length > 1)) { toqueInicio = null; return; }
    toqueInicio = { x: e.point.x, y: e.point.y, t: Date.now() };
  });
  map.on("touchend", (e) => {
    if (modoMarcar || !e.point || !toqueInicio) { toqueInicio = null; return; }
    const dx = e.point.x - toqueInicio.x, dy = e.point.y - toqueInicio.y, dt = Date.now() - toqueInicio.t;
    toqueInicio = null;
    if (Math.hypot(dx, dy) > 9 || dt > 500 || map.isMoving()) return;
    const p = e.point, pad = 10;
    const caja = [[p.x-pad, p.y-pad], [p.x+pad, p.y+pad]];
    const encontrados = map.queryRenderedFeatures(caja, { layers: ["tramos-hit", "tramos-line", "puntos-inicio", "puntos-final"] });
    const elegido = encontrados.find(f => f.properties && f.properties.bajada_id);
    if (!elegido) return;
    ultimoToque = Date.now();
    seleccionar(elegido.properties.bajada_id, { lngLat: e.lngLat });
  });
  ["tramos-hit", "tramos-line", "puntos-inicio", "puntos-final"].forEach(layer => {
    map.on("mouseenter", layer, () => map.getCanvas().style.cursor = "pointer");
    map.on("mouseleave", layer, () => map.getCanvas().style.cursor = "");
  });
}

function seleccionar(id, opts = {}) {
  const f = porId.get(id); if (!f) return;
  if (typeof cerrarPopupPunto === "function") cerrarPopupPunto();
  seleccionada = id;
  map.setFilter("tramos-sel", ["==", ["get", "bajada_id"], id]);
  const sf = map.getSource("sel-flechas");
  if (sf) sf.setData({ type: "Feature", properties: {}, geometry: f.geometry });
  const p = f.properties;
  let lngLat = opts.lngLat || { lng: p.inicio[0], lat: p.inicio[1] };
  if (opts.fit) {
    const b = new maplibregl.LngLatBounds(); f.geometry.coordinates.forEach(c => b.extend([c[0], c[1]]));
    const centro = b.getCenter();
    map.fitBounds(b, { padding: { top: 90, bottom: 90, left: 90, right: 90 }, maxZoom: 15, duration: 650 });
    lngLat = { lng: centro.lng, lat: centro.lat };
  }
  if (miRutaEl.classList.contains("abierto") && window.matchMedia("(max-width:720px)").matches) setPanel(false);
  mostrarPopup(f, lngLat);
  if (!p.perfil_cargado) {   // el perfil completo llega después de abrir la ficha
    asegurarPerfil(id).then(ok => {
      if (!ok || seleccionada !== id) return;
      const g = porId.get(id); if (!g) return;
      const s2 = map.getSource("sel-flechas");
      if (s2) s2.setData({ type: "Feature", properties: {}, geometry: g.geometry });
      mostrarPopup(g, lngLat);
    }).catch(e => {
      console.error(e);
      if (seleccionada === id && porId.has(id)) mostrarPopup(porId.get(id), lngLat, "No se pudo calcular el perfil: " + e.message);
    });
  }
}

