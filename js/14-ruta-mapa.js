// 14-ruta-mapa.js (líneas 1900-2015 del index.html original)
// ---- Ruta generada: dibujar, invalidar, descargar, borrar todo ----
function crearFlecha() {
  if (map.hasImage("flecha-ruta")) return;
  const s = 32, c = document.createElement("canvas"); c.width = c.height = s;
  const g = c.getContext("2d");
  g.beginPath(); g.moveTo(6, 6); g.lineTo(27, 16); g.lineTo(6, 26); g.lineTo(12, 16); g.closePath();
  g.lineJoin = "round"; g.lineWidth = 3; g.strokeStyle = "#1a1a1a"; g.stroke();
  g.fillStyle = "#ffffff"; g.fill();
  map.addImage("flecha-ruta", g.getImageData(0, 0, s, s));
}

function dibujarRuta(segmentos) {
  const feats = [];
  let prev = null;
  for (const s of segmentos) {
    const coords = s.puntos.map(p => [p[1], p[0]]);
    if (prev) coords.unshift(prev); // une con el segmento anterior sin huecos
    prev = coords[coords.length - 1];
    if (coords.length > 1) feats.push({ type: "Feature", properties: { tipo: s.tipo, nombre: s.nombre }, geometry: { type: "LineString", coordinates: coords } });
  }
  const data = { type: "FeatureCollection", features: feats };
  if (map.getSource("ruta-generada")) {
    map.getSource("ruta-generada").setData(data);
  } else {
    crearFlecha();
    const esBajada = ["==", ["get", "tipo"], "bajada"], esEnlace = ["==", ["get", "tipo"], "enlace"];
    const cap = { "line-cap": "round", "line-join": "round" };
    map.addSource("ruta-generada", { type: "geojson", data });
    // contorno morado bajo las bajadas de la ruta (conservan su color de dificultad)
    map.addLayer({ id: "ruta-bajadas-contorno", type: "line", source: "ruta-generada", filter: esBajada, layout: cap,
      paint: { "line-color": COLOR_RUTA, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 4, 14, 6, 17, 9] } },
      map.getLayer("tramos-sel") ? "tramos-sel" : undefined);
    const antes = map.getLayer("puntos-inicio") ? "puntos-inicio" : undefined;
    // enlaces: línea morada con borde blanco
    map.addLayer({ id: "ruta-enlaces-borde", type: "line", source: "ruta-generada", filter: esEnlace, layout: cap, paint: { "line-color": "#ffffff", "line-width": 6 } }, antes);
    map.addLayer({ id: "ruta-enlaces", type: "line", source: "ruta-generada", filter: esEnlace, layout: cap, paint: { "line-color": COLOR_RUTA, "line-width": 3.5 } }, antes);
    // flechas de sentido a lo largo de toda la ruta
    map.addLayer({ id: "ruta-flechas", type: "symbol", source: "ruta-generada",
      layout: { "symbol-placement": "line", "symbol-spacing": 70, "icon-image": "flecha-ruta",
        "icon-size": ["interpolate", ["linear"], ["zoom"], 10, 0.35, 14, 0.5, 17, 0.7],
        "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": true } });
  }
  asegurarCapasSeguir();
  actualizarKm();
  const bnd = new maplibregl.LngLatBounds();
  feats.forEach(f => f.geometry.coordinates.forEach(c => bnd.extend(c)));
  if (!bnd.isEmpty()) map.fitBounds(bnd, { padding: 70, duration: 600 });
}

// ---- Marcas de km (para no perderte en bucles y cruces) ----
const KM_PASO = 1;   // una marca cada km, siempre
var VACIO = { type: "FeatureCollection", features: [] };

function asegurarCapasSeguir() {
  if (!map.getSource("ruta-km")) {
    map.addSource("ruta-km", { type: "geojson", data: VACIO });
    map.addLayer({ id: "ruta-km", type: "symbol", source: "ruta-km",
      layout: { "icon-image": ["concat", "km-", ["get", "n"]], "icon-allow-overlap": true, "icon-ignore-placement": true,
        "icon-size": ["interpolate", ["linear"], ["zoom"], 10, 0.6, 14, 0.8, 17, 1] } });
  }
}

function crearIconoKm(n) {   // chapa redonda con el número (no hace falta cargar fuentes del mapa)
  const id = "km-" + n;
  if (map.hasImage(id)) return id;
  const r = 2, s = 36 * r, c = document.createElement("canvas"); c.width = c.height = s;
  const g = c.getContext("2d");
  g.beginPath(); g.arc(s / 2, s / 2, s / 2 - 3 * r, 0, Math.PI * 2);
  g.fillStyle = "#ffffff"; g.fill();
  g.lineWidth = 3 * r; g.strokeStyle = COLOR_RUTA; g.stroke();
  g.fillStyle = "#1a1a1a"; g.textAlign = "center"; g.textBaseline = "middle";
  g.font = `700 ${(String(n).length > 2 ? 12 : String(n).length > 1 ? 15 : 18) * r}px system-ui, sans-serif`;
  g.fillText(String(n), s / 2, s / 2 + r);
  map.addImage(id, g.getImageData(0, 0, s, s), { pixelRatio: r });
  return id;
}

function actualizarKm() {
  const src = map.getSource("ruta-km");
  if (!src) return;
  if (!rutaGenerada) { src.setData(VACIO); return; }
  const P = construirSeguirPts(rutaGenerada.segmentos);
  if (P.length < 2) { src.setData(VACIO); return; }
  const total = P[P.length - 1].d, feats = [];
  let j = 0;
  for (let km = KM_PASO; km * 1000 <= total - 100; km += KM_PASO) {   // sin marca pegada a la meta
    const d = km * 1000;
    while (j < P.length - 2 && P[j + 1].d < d) j++;
    const a = P[j], b = P[j + 1], t = b.d > a.d ? (d - a.d) / (b.d - a.d) : 0;
    crearIconoKm(km);
    feats.push({ type: "Feature", properties: { n: km }, geometry: { type: "Point", coordinates: [a.lon + t * (b.lon - a.lon), a.lat + t * (b.lat - a.lat)] } });
  }
  src.setData({ type: "FeatureCollection", features: feats });
}

// El resaltado del tramo siguiente se ha eliminado; se deja vacío por si algún otro script aún lo llama
function actualizarAdelante() {}
