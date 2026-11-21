// 01-mapa.js (líneas 524-564 del index.html original)
const COLORES = { verde: "#2e9e4f", azul: "#1f6fd1", rojo: "#d62f2f", negro: "#1a1a1a", sin: "#9e9e9e" };
const CATS = ["verde", "azul", "rojo", "negro", "sin"];

let baseSat = false;   // false = mapa OSM, true = satélite (se recuerda la última elección)
try { baseSat = localStorage.getItem("baseMapa") === "sat"; } catch (e) {}

// ---- Mapa base: OpenFreeMap (datos de OpenStreetMap; gratuito, sin clave, uso comercial permitido) ----
// Estilos disponibles: "liberty" (el más detallado), "bright", "positron" (gris claro, ideal para resaltar las bajadas)
const ESTILO_MAPA = "liberty";

const SAT_FUENTE = { type: "raster", tiles: ["https://www.ign.es/wmts/pnoa-ma?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=OI.OrthoimageCoverage&STYLE=default&FORMAT=image/jpeg&TILEMATRIXSET=GoogleMapsCompatible&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}"], tileSize: 256, maxzoom: 19, attribution: 'Ortofoto PNOA © <a href="https://www.ign.es/" target="_blank" rel="noopener">Instituto Geográfico Nacional</a> (CC BY 4.0)' };
// Crea (si no existe) la capa de satélite, siempre por debajo de las capas de la app
function asegurarSat() {
  try {
    if (!map.getSource("sat")) map.addSource("sat", SAT_FUENTE);
    if (!map.getLayer("sat")) {
      const antes = ["tramos-halo", "tramos-line", "puntos-inicio"].find(id => map.getLayer(id));
      map.addLayer({ id: "sat", type: "raster", source: "sat", layout: { visibility: baseSat ? "visible" : "none" } }, antes);
    }
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
  center: [2.33, 41.52],
  zoom: 12,
  customAttribution: 'Búsqueda: © <a href="https://www.cartociudad.es/" target="_blank" rel="noopener">CartoCiudad</a> IGN (CC BY 4.0) · Bajadas: datos © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">colaboradores de OpenStreetMap</a> (ODbL) · Elevación: MDT05 © <a href="https://www.ign.es/" target="_blank" rel="noopener">IGN</a> (CC BY 4.0)'
});

map.on("error", (ev) => {
  const m = ev && ev.error && ev.error.message ? ev.error.message : "";
  console.error("[mapa]", ev && ev.error);
  if (ev && ev.sourceId === undefined && m) { try { toast("Mapa: " + m); } catch (e) {} }   // errores de estilo (no de teselas sueltas)
});
map.addControl(new maplibregl.NavigationControl(), "top-right");
