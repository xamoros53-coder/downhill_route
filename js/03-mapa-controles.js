// 03-mapa-controles.js (líneas 715-790 del index.html original)
// Botón para alternar entre el mapa normal y la vista satélite
class BaseMapaControl {
  onAdd() {
    this._c = document.createElement("div");
    this._c.className = "maplibregl-ctrl maplibregl-ctrl-group";
    this._b = document.createElement("button");
    this._b.type = "button"; this._b.className = "ctrl-base ctrl-capas";
    this._b.addEventListener("click", () => ponerBase(!baseSat));
    this._c.appendChild(this._b);
    this.refrescar();
    return this._c;
  }
  onRemove() { this._c.remove(); }
  refrescar() {
    const t = baseSat ? "Cambiar a mapa de senderos" : "Cambiar a satélite";
    this._b.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>';
    this._b.style.color = baseSat ? "#1f6fd1" : "";   // azul = satélite activo
    this._b.title = t; this._b.setAttribute("aria-label", t);
  }
}
const baseControl = new BaseMapaControl();
function ponerBase(sat) {
  baseSat = sat;
  if (!asegurarSat()) { baseSat = !sat; return; }
  map.setLayoutProperty("sat", "visibility", sat ? "visible" : "none");
  baseControl.refrescar();
  try { localStorage.setItem("baseMapa", sat ? "sat" : "osm"); } catch (e) {}
}
map.addControl(baseControl, "top-right");

// Botón 3D: activa el relieve (terreno) e inclina el mapa. Elevación: AWS Terrain Tiles (gratuito, sin clave)
let en3D = false;
class Mapa3DControl {
  onAdd() {
    this._c = document.createElement("div");
    this._c.className = "maplibregl-ctrl maplibregl-ctrl-group";
    this._b = document.createElement("button");
    this._b.type = "button"; this._b.className = "ctrl-base ctrl-3d";
    this._b.addEventListener("click", () => poner3D(!en3D));
    this._c.appendChild(this._b);
    this.refrescar();
    return this._c;
  }
  onRemove() { this._c.remove(); }
  refrescar() {
    const t = en3D ? "Volver a vista 2D" : "Activar vista 3D";
    this._b.textContent = en3D ? "2D" : "3D";   // muestra el modo al que cambiarás al pulsar
    this._b.title = t; this._b.setAttribute("aria-label", t);
    this._b.style.color = en3D ? "#1f6fd1" : "";   // azul = vista 3D activa
  }
}
const control3D = new Mapa3DControl();
function poner3D(on) {
  en3D = on;
  try {
    if (on) {
      if (!map.getSource("dem")) {
        map.addSource("dem", {
          type: "raster-dem",
          tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
          encoding: "terrarium", tileSize: 256, maxzoom: 14,   // 14 = el máximo de las teselas de OpenFreeMap; con 15 el relieve no casa con el mapa a zoom alto
          attribution: 'Relieve 3D: <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">Terrain Tiles © Mapzen y fuentes (SRTM, Copernicus, etc.)</a>'
        });
      }
      map.setTerrain({ source: "dem", exaggeration: 1.3 });
      map.easeTo({ pitch: 60, duration: 800 });
    } else {
      map.setTerrain(null);
      map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
    }
  } catch (e) { en3D = false; console.error("[3D]", e); setEstado("No se pudo activar la vista 3D."); try { toast("Vista 3D: " + e.message, 15000); } catch (e2) {} }
  control3D.refrescar();
}
map.addControl(control3D, "top-right");
map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");

