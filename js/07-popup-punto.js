// 07-popup-punto.js (líneas 1063-1111 del index.html original)
// Pulsación (o clic) en un hueco del mapa: pregunta qué quieres hacer con ese punto
let popupPunto = null;
function cerrarPopupPunto() { if (popupPunto) { popupPunto.remove(); popupPunto = null; } }
map.on("click", (e) => {
  const oe = e.originalEvent;
  if (oe && oe.target && oe.target.closest && oe.target.closest(".maplibregl-marker, .maplibregl-popup")) return;
  // si se ha tocado una bajada, la gestiona su propia ficha
  const capas = ["tramos-hit", "tramos-line", "puntos-inicio", "puntos-final"].filter(l => map.getLayer(l));
  if (capas.length) {
    const p = e.point, pad = 10;
    if (map.queryRenderedFeatures([[p.x - pad, p.y - pad], [p.x + pad, p.y + pad]], { layers: capas }).some(f => f.properties && f.properties.bajada_id)) return;
  }
  const lat = e.lngLat.lat, lon = e.lngLat.lng;
  cerrarPopupPunto();
  deseleccionar();
  const lugarP = nombreDeLugar(lat, lon);   // promesa: nombre legible o null
  const cont = document.createElement("div");
  cont.innerHTML = `<h3>Añadir punto a la ruta</h3>
    <div id="lugarPunto" style="font-weight:600;color:#243746">Buscando el lugar…</div>
    <div style="color:#8a939b;font-size:11px;margin-top:2px">${lat.toFixed(5)}, ${lon.toFixed(5)}</div>
    <button class="popup-add" data-a="inter">📍 Añadir punto</button>`;
  lugarP.then(n => { const el = cont.querySelector("#lugarPunto"); if (el) el.textContent = n ? "Punto en " + n : "Punto en el mapa"; });
  cont.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("button[data-a]"); if (!btn) return;
    ev.stopPropagation();
    btn.disabled = true;
    const nombre = await lugarP;
    const id = "wp:" + Date.now();
    puntosInter.set(id, nombre ? [lat, lon, nombre] : [lat, lon]); miRuta.push(id);
    guardarMiRuta(); renderMiRuta(); actualizarBotonGenerar();
    cerrarPopupPunto();
    toast("📍 Punto añadido a tu ruta"); mostrarAnadido(id);
  });
  popupPunto = new maplibregl.Popup({ closeButton: true, maxWidth: "260px" }).setLngLat([lon, lat]).setDOMContent(cont).addTo(map);
  popupPunto.on("close", () => { popupPunto = null; });
});

// Municipio de un punto con el geocodificador inverso de CartoCiudad (IGN, CC BY 4.0). Devuelve solo el municipio
// (no la calle más cercana, que en el monte puede estar a kilómetros) o null si no hay dato.
async function nombreDeLugar(lat, lon) {
  const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const j = await cartoPedir("reverseGeocode", { lat: lat.toFixed(6), lon: lon.toFixed(6) }, ctrl.signal);
    const muni = j && typeof j.muni === "string" ? j.muni.trim() : "";
    return muni || null;
  } catch (e) { return null; }
  finally { clearTimeout(t); }
}

