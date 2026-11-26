// 01-mapa.js (líneas 524-564 del index.html original)
const COLORES = { verde: "#2e9e4f", azul: "#1f6fd1", rojo: "#d62f2f", negro: "#1a1a1a", sin: "#9e9e9e" };
const CATS = ["verde", "azul", "rojo", "negro", "sin"];

let baseSat = false;   // false = mapa OSM, true = satélite (se recuerda la última elección)
try { baseSat = localStorage.getItem("baseMapa") === "sat"; } catch (e) {}

// ---- Mapa base: OpenFreeMap (datos de OpenStreetMap; gratuito, sin clave, uso comercial permitido) ----
// Estilos disponibles: "liberty" (el más detallado), "bright", "positron" (gris claro, ideal para resaltar las bajadas)
const ESTILO_MAPA = "liberty";

// ---- Satélite España + Francia: una sola capa que elige, trozo a trozo, la ortofoto que trae imagen ----
// PNOA (IGN España) y la ortofoto del IGN Francia devuelven teselas vacías fuera de su país, y la frontera del Pirineo es irregular,
// así que no se pueden separar con rectángulos. Solución: un protocolo propio ("satmix://") que, cerca de la frontera, pide las dos
// teselas, mira cuál tiene imagen real y devuelve esa. Lejos de la frontera pide solo la del país que toca.
// Ambas ortofotos permiten uso comercial citando la fuente. Fuera de España y Francia no hay imagen.
const URL_SAT_ES = "https://www.ign.es/wmts/pnoa-ma?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=OI.OrthoimageCoverage&STYLE=default&FORMAT=image/jpeg&TILEMATRIXSET=GoogleMapsCompatible&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}";
const URL_SAT_FR = "https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}";
const ZONA_FRONTERA = { s: 42.3, w: -2.0, n: 43.45, e: 3.5 };   // solo aquí se piden las dos ortofotos; fuera, la del país que toque
// Frontera España–Francia aproximada [lon, lat]: solo desempata cuando las dos teselas traen imagen
const FRONTERA = [[-2.0, 43.4], [-1.78, 43.37], [-1.5, 43.28], [-1.3, 43.05], [-1.0, 42.98], [-0.73, 42.93], [-0.53, 42.79], [-0.3, 42.82], [-0.15, 42.77],
  [0.03, 42.69], [0.2, 42.74], [0.45, 42.75], [0.7, 42.86], [1.0, 42.8], [1.3, 42.74], [1.45, 42.6], [1.75, 42.55], [1.95, 42.45], [2.12, 42.38],
  [2.2, 42.42], [2.3, 42.42], [2.4, 42.37], [2.45, 42.34], [2.65, 42.4], [2.87, 42.47], [3.17, 42.43], [3.4, 42.4]];
function latFrontera(lon) {
  if (lon <= FRONTERA[0][0]) return FRONTERA[0][1];
  for (let i = 1; i < FRONTERA.length; i++) if (lon <= FRONTERA[i][0]) { const [x0, y0] = FRONTERA[i - 1], [x1, y1] = FRONTERA[i]; return y0 + (y1 - y0) * (lon - x0) / (x1 - x0); }
  return FRONTERA[FRONTERA.length - 1][1];
}
function centroTile(z, x, y) {
  const n = 2 ** z;
  return [Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / n))) * 180 / Math.PI, (x + 0.5) / n * 360 - 180];   // [lat, lon]
}
function plantillaTile(url, z, x, y) { return url.replace("{z}", z).replace("{y}", y).replace("{x}", x); }
// ¿La imagen tiene contenido real (no una tesela vacía, blanca, negra o transparente)?
function tieneImagen(bmp) {
  const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(16, 16) : Object.assign(document.createElement("canvas"), { width: 16, height: 16 });
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, 16, 16);
  const d = g.getImageData(0, 0, 16, 16).data;
  let n = 0, s = 0, s2 = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 20) continue;   // transparente
    const l = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2];
    n++; s += l; s2 += l * l;
  }
  if (n < 128) return false;
  const m = s / n;
  return s2 / n - m * m > 25;   // desviación típica > 5: una tesela vacía es de un solo color
}
async function pedirTileSat(url, signal) {
  try {
    const r = await fetch(url, { signal });
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    const bmp = await createImageBitmap(new Blob([buf]));
    const ok = tieneImagen(bmp);
    if (bmp.close) bmp.close();
    return { buf, ok };
  } catch (e) { if (e && e.name === "AbortError") throw e; return null; }
}
async function cargarTileSat(params, signal) {
  const m = /satmix:\/\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
  if (!m) throw new Error("URL de satélite no válida");
  const z = +m[1], x = +m[2], y = +m[3];
  const [lat, lon] = centroTile(z, x, y);
  const enFrontera = lat >= ZONA_FRONTERA.s && lat <= ZONA_FRONTERA.n && lon >= ZONA_FRONTERA.w && lon <= ZONA_FRONTERA.e;
  const urlEs = plantillaTile(URL_SAT_ES, z, x, y), urlFr = plantillaTile(URL_SAT_FR, z, x, y);
  let res;
  if (!enFrontera) {
    const francia = (lat > ZONA_FRONTERA.n && lon > -1.8) || lon > ZONA_FRONTERA.e;   // norte de Francia o Córcega/Alpes; el resto, España
    const t = await pedirTileSat(francia ? urlFr : urlEs, signal);
    res = t && t.buf;
  } else {
    const [es, fr] = await Promise.all([pedirTileSat(urlEs, signal), pedirTileSat(urlFr, signal)]);
    if (es && es.ok && !(fr && fr.ok)) res = es.buf;
    else if (fr && fr.ok && !(es && es.ok)) res = fr.buf;
    else if (es && es.ok && fr && fr.ok) res = (lat < latFrontera(lon) ? es : fr).buf;   // las dos traen imagen: manda la frontera
    else res = ((es || fr) || {}).buf;                                                      // ninguna (mar…): da igual cuál
  }
  if (!res) throw new Error("tesela de satélite no disponible");
  return res;
}
const SAT_ATRIB = 'Ortofoto PNOA © <a href="https://www.ign.es/" target="_blank" rel="noopener">IGN España</a> (CC BY 4.0) · Ortofoto © <a href="https://www.ign.fr/" target="_blank" rel="noopener">IGN France</a> (Licence Ouverte)';
let SAT_CAPAS;
if (maplibregl.addProtocol) {
  // Compatible con MapLibre v3 (devuelve con callback) y v4+ (devuelve una promesa)
  maplibregl.addProtocol("satmix", (params, a) => {
    if (typeof a === "function") {
      const ctrl = new AbortController();
      cargarTileSat(params, ctrl.signal).then(buf => a(null, buf, null, null), e => a(e));
      return { cancel: () => ctrl.abort() };
    }
    return cargarTileSat(params, a && a.signal).then(data => ({ data }));
  });
  SAT_CAPAS = [{ id: "sat-mix", fuente: { type: "raster", tileSize: 256, maxzoom: 19, tiles: ["satmix://{z}/{x}/{y}"], attribution: SAT_ATRIB } }];
} else {
  console.warn("[satélite] esta versión de MapLibre no tiene addProtocol: solo PNOA (España)");
  SAT_CAPAS = [{ id: "sat-mix", fuente: { type: "raster", tileSize: 256, maxzoom: 19, tiles: [URL_SAT_ES], attribution: SAT_ATRIB } }];
}
const SAT_IDS = SAT_CAPAS.map(c => c.id);
// Crea (si no existen) las capas de satélite, siempre por debajo de las capas de la app
function asegurarSat() {
  try {
    const antes = ["tramos-halo", "tramos-line", "puntos-inicio"].find(id => map.getLayer(id));
    SAT_CAPAS.forEach(c => {
      if (!map.getSource(c.id)) map.addSource(c.id, c.fuente);
      if (!map.getLayer(c.id)) map.addLayer({ id: c.id, type: "raster", source: c.id, layout: { visibility: baseSat ? "visible" : "none" } }, antes);
    });
    try { ordenarRelieve(); } catch (e) {}   // curvas y picos siempre por encima del satélite
    return true;
  } catch (e) {
    console.error("[satélite]", e);
    try { toast("No se pudo preparar el satélite: " + e.message); } catch (e2) {}
    return false;
  }
}

const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/" + ESTILO_MAPA,
  center: [1.2, 42.7],   // Pirineos (España y Francia)
  zoom: 9,
  customAttribution: 'Búsqueda: © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> (Nominatim) · Bajadas: datos © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">colaboradores de OpenStreetMap</a> (ODbL)'
});

map.on("error", (ev) => {
  const m = ev && ev.error && ev.error.message ? ev.error.message : "";
  console.error("[mapa]", ev && ev.error);
  if (ev && ev.sourceId === undefined && m) { try { toast("Mapa: " + m); } catch (e) {} }   // errores de estilo (no de teselas sueltas)
});
map.addControl(new maplibregl.NavigationControl(), "top-right");

// ---- Relieve: sombreado, curvas de nivel y nombres de picos con cota ----
// Se añaden sobre el estilo de OpenFreeMap al cargarse, sin tocar el estilo en sí:
//  · Sombreado a partir de teselas de elevación abiertas (AWS Terrain Tiles, formato Terrarium; uso comercial permitido citando la fuente).
//  · Curvas de nivel calculadas en el navegador con el plugin maplibre-contour (BSD-3), a partir de esas mismas teselas. Requiere lib/maplibre-contour.min.js.
//  · Capa propia de picos (capa «mountain_peak» de OpenMapTiles) con nombre + altitud desde zoom 8. Si dos etiquetas chocan, gana el pico más alto.
// Curvas y picos quedan por encima del satélite (el sombreado no hace falta ahí: la ortofoto ya lleva sombras).
const DEM_TILES = ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"];
const DEM_ATRIB = 'Relieve: <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">Terrain Tiles © Mapzen y fuentes (SRTM, Copernicus, etc.)</a>';
let verCurvas = true;   // el botón de curvas (03-mapa-controles.js) lo cambia y lo recuerda
try { verCurvas = localStorage.getItem("curvas") !== "off"; } catch (e) {}

let demContour = null;
if (window.mlcontour && maplibregl.addProtocol) {
  try {
    demContour = new mlcontour.DemSource({ url: DEM_TILES[0], encoding: "terrarium", maxzoom: 13, worker: false, cacheSize: 100, timeoutMs: 10000 });
    demContour.setupMaplibre(maplibregl);
  } catch (e) { console.warn("[curvas] no se pudo iniciar maplibre-contour", e); demContour = null; }
} else {
  console.warn("[curvas] falta lib/maplibre-contour.min.js (o esta versión de MapLibre no tiene addProtocol): sin curvas de nivel");
}

const CAPAS_RELIEVE = ["curvas", "curvas-label", "picos-label"];   // de abajo arriba
// Las coloca justo debajo de las capas de la app (tramos…), o arriba del todo si aún no existen
function ordenarRelieve() {
  const antes = ["tramos-halo", "tramos-line", "puntos-inicio"].find(id => map.getLayer(id));
  CAPAS_RELIEVE.forEach(id => { if (map.getLayer(id)) map.moveLayer(id, antes); });
}
// Colores según la base: oscuros sobre el mapa claro, claros sobre el satélite
function colorRelieve() {
  const sat = baseSat;
  const set = (id, prop, val) => { if (map.getLayer(id)) map.setPaintProperty(id, prop, val); };
  set("curvas", "line-color", ["match", ["get", "level"], 1, sat ? "rgba(255,255,255,0.75)" : "rgba(130,85,40,0.75)", sat ? "rgba(255,255,255,0.4)" : "rgba(130,85,40,0.4)"]);
  set("curvas-label", "text-color", sat ? "#ffffff" : "#7a5028");
  set("curvas-label", "text-halo-color", sat ? "rgba(0,0,0,0.7)" : "rgba(255,255,255,0.85)");
  set("picos-label", "text-color", sat ? "#ffffff" : "#5b4636");
  set("picos-label", "text-halo-color", sat ? "rgba(0,0,0,0.75)" : "rgba(255,255,255,0.9)");
}
function asegurarRelieve() {
  try {
    const estilo = map.getStyle();
    if (!estilo) return;
    const capas = estilo.layers || [];
    const simb = capas.find(l => l.type === "symbol" && l.layout && l.layout["text-font"]);
    const fuente = simb ? simb.layout["text-font"] : ["Noto Sans Regular"];

    // 1) Elevación (compartida con la vista 3D). maxzoom 14 = el de las teselas de OpenFreeMap, para que el relieve case con el mapa
    if (!map.getSource("dem")) map.addSource("dem", { type: "raster-dem", tiles: DEM_TILES, encoding: "terrarium", tileSize: 256, maxzoom: 14, attribution: DEM_ATRIB });

    // 2) Sombreado: justo debajo de carreteras, edificios y límites, para no tapar nada de lo importante
    if (!map.getLayer("relieve")) {
      const sobre = ["waterway", "transportation", "building", "boundary", "aeroway"];
      const ref = capas.find(l => sobre.includes(l["source-layer"])) || capas.find(l => l.type === "symbol");
      map.addLayer({
        id: "relieve", type: "hillshade", source: "dem",
        paint: {
          "hillshade-exaggeration": 0.5,
          "hillshade-illumination-anchor": "map",   // la luz no gira con el mapa al seguir la ruta
          "hillshade-shadow-color": "rgba(40,50,40,0.55)",
          "hillshade-highlight-color": "rgba(255,255,255,0.45)"
        }
      }, ref && ref.id);
    }

    // 3) Curvas de nivel (cada nivel de zoom tiene su equidistancia: [fina, gruesa] en metros)
    if (demContour && !map.getSource("curvas")) {
      map.addSource("curvas", {
        type: "vector", maxzoom: 15,
        tiles: [demContour.contourProtocolUrl({ thresholds: { 11: [200, 1000], 12: [100, 500], 13: [50, 250], 14: [20, 100], 15: [20, 100] } })],
        attribution: DEM_ATRIB
      });
    }
    if (demContour && !map.getLayer("curvas")) {
      const vis = verCurvas ? "visible" : "none";
      map.addLayer({
        id: "curvas", type: "line", source: "curvas", "source-layer": "contours", minzoom: 11,
        layout: { visibility: vis },
        paint: { "line-width": ["match", ["get", "level"], 1, 1, 0.5] }
      });
      map.addLayer({
        id: "curvas-label", type: "symbol", source: "curvas", "source-layer": "contours", minzoom: 12,
        filter: [">", ["get", "level"], 0],   // solo las curvas gruesas llevan cota
        layout: {
          visibility: vis,
          "symbol-placement": "line", "text-size": 10, "text-font": fuente,
          "text-field": ["concat", ["number-format", ["get", "ele"], {}], " m"]
        },
        paint: { "text-halo-width": 1.2 }
      });
    }

    // 4) Picos: ocultamos los del estilo (salen tarde y sin cota) y ponemos los nuestros
    if (!map.getLayer("picos-label")) {
      const origen = capas.find(l => l["source-layer"] && estilo.sources[l.source] && estilo.sources[l.source].type === "vector");
      if (!origen) { console.warn("[mapa] sin fuente vectorial: no se añaden los picos"); }
      else {
        capas.filter(l => l["source-layer"] === "mountain_peak").forEach(l => map.setLayoutProperty(l.id, "visibility", "none"));
        map.addLayer({
          id: "picos-label", type: "symbol", source: origen.source, "source-layer": "mountain_peak", minzoom: 8,
          filter: ["has", "name"],
          layout: {
            "text-field": ["case", ["has", "ele"],
              ["format", ["to-string", ["get", "name"]], {}, "\n", {}, ["concat", ["to-string", ["get", "ele"]], " m"], { "font-scale": 0.85 }],
              ["to-string", ["get", "name"]]],
            "text-font": fuente,
            "text-size": ["interpolate", ["linear"], ["zoom"], 8, 10, 14, 13],
            "text-anchor": "center",
            "text-max-width": 8,
            "symbol-sort-key": ["*", -1, ["to-number", ["coalesce", ["get", "ele"], 0]]]   // los más altos se colocan primero
          },
          paint: { "text-halo-width": 1.6 }
        });
      }
    }
    colorRelieve();
    ordenarRelieve();
  } catch (e) { console.error("[relieve]", e); }
}
map.on("style.load", asegurarRelieve);
