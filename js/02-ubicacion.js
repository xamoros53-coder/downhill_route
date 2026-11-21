// 02-ubicacion.js (líneas 565-714 del index.html original)
// ---- Mi ubicación: punto azul que te sigue + botón ◎ para centrar el mapa en ti ----
// Orientación del mapa al seguir la ruta: "norte" (norte arriba) o "marcha" (el mapa gira según hacia dónde avanzas)
let orientMapa = "norte";
try { orientMapa = localStorage.getItem("orientMapa") === "marcha" ? "marcha" : "norte"; } catch (e) {}
// Marcas de km sobre la ruta (0 = ninguna) y distancia del tramo resaltado al seguir la ruta (0 = no)
let kmPaso = 1, adelanteM = 500;
try {
  const k = localStorage.getItem("kmPaso"); if (k !== null && [0, 1, 2, 5].includes(+k)) kmPaso = +k;
  const a = localStorage.getItem("adelanteM"); if (a !== null && [0, 300, 500, 1000].includes(+a)) adelanteM = +a;
} catch (e) {}
function rumboEntre(lat1, lon1, lat2, lon2) {   // rumbo en grados (0 = norte, 90 = este)
  const r = Math.PI / 180, f1 = lat1 * r, f2 = lat2 * r, dl = (lon2 - lon1) * r;
  const y = Math.sin(dl) * Math.cos(f2), x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return (Math.atan2(y, x) / r + 360) % 360;
}
const ubic = {
  rumbo: null, rumboRuta: null,
  pos: null, watchId: null, afinarId: null, afinarT: null, camSigue: false, zoomPend: 0, unaVez: 0, marker: null, btn: null, pausaT: null,
  iniciar() {
    if (this.watchId !== null) return;
    if (!navigator.geolocation) { setEstado("Tu navegador no permite acceder a la ubicación."); return; }
    this.pararAfinado();
    this.watchId = navigator.geolocation.watchPosition(
      (p) => this.alActualizar(p), (e) => this.alError(e),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
  },
  alActualizar(p) {
    const ant = this.pos, c = p.coords;
    this.pos = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, ts: p.timestamp };
    // Rumbo: el del GPS si te estás moviendo; si el navegador no da velocidad, el calculado entre dos posiciones; si no, se mantiene el último
    if (c.heading !== null && c.heading !== undefined && isFinite(c.heading) && (c.speed === null || c.speed === undefined || c.speed > 0.8)) this.rumbo = c.heading;
    else if ((c.speed === null || c.speed === undefined) && ant && haversine([ant.lat, ant.lon], [this.pos.lat, this.pos.lon]) > 8) this.rumbo = rumboEntre(ant.lat, ant.lon, this.pos.lat, this.pos.lon);
    if (!this.marker) {
      const w = document.createElement("div"); w.className = "yo-wrap";
      w.innerHTML = '<div class="yo-punto"></div>';
      this.marker = new maplibregl.Marker({ element: w }).setLngLat([this.pos.lon, this.pos.lat]).addTo(map);
    } else this.marker.setLngLat([this.pos.lon, this.pos.lat]);
    this.dibujarPrecision();
    if (this.unaVez) { this.zoomPend = this.unaVez; this.unaVez = 0; this.mover(); }   // centrado inicial, sin dejar el seguimiento activo
    else if (this.camSigue) this.mover();
    if (typeof siguiendo !== "undefined" && siguiendo) seguirActualizar();
  },
  alError(e) {
    if (e && e.code === 1) {
      if (this.watchId !== null) { navigator.geolocation.clearWatch(this.watchId); this.watchId = null; }
      this.camSigue = false; this.actualizarBtn();
      setEstado("No tengo permiso para ver tu ubicación. Actívalo en los ajustes del navegador.");
    } else if (e && e.code === 2) setEstado("No se puede determinar tu posición (¿GPS desactivado?).");
    else if (e && e.code === 3) setEstado("Tu posición tarda en llegar. Inténtalo de nuevo en un momento.");
  },
  dibujarPrecision() {
    const { lat, lon, acc } = this.pos, r = Math.min(Math.max(acc || 0, 0), 500);
    const pts = [];
    for (let i = 0; i <= 48; i++) {
      const a = i / 48 * 2 * Math.PI;
      pts.push([lon + r * Math.sin(a) / (111320 * Math.cos(lat * Math.PI / 180)), lat + r * Math.cos(a) / 111320]);
    }
    const data = { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [pts] } }] };
    const poner = () => {
      try {
        if (map.getSource("yo-precision")) map.getSource("yo-precision").setData(data);
        else {
          map.addSource("yo-precision", { type: "geojson", data });
          map.addLayer({ id: "yo-precision-fill", type: "fill", source: "yo-precision", paint: { "fill-color": "#1a73e8", "fill-opacity": 0.12 } });
          map.addLayer({ id: "yo-precision-line", type: "line", source: "yo-precision", paint: { "line-color": "#1a73e8", "line-opacity": 0.4, "line-width": 1 } });
        }
      } catch (e) {}
    };
    if (map.isStyleLoaded()) poner(); else map.once("load", poner);
  },
  mover() {
    if (!this.pos) return;
    const perfil = document.getElementById("perfilAlt");
    const conPerf = typeof siguiendo !== "undefined" && siguiendo && perfil && perfil.offsetHeight;
    const o = { center: [this.pos.lon, this.pos.lat], duration: 500, essential: true, offset: [0, conPerf ? -perfil.offsetHeight / 2 : 0] };
    if (this.zoomPend && map.getZoom() < this.zoomPend) o.zoom = this.zoomPend;
    this.zoomPend = 0;
    if (typeof siguiendo !== "undefined" && siguiendo && orientMapa === "marcha") {   // mapa girado según el sentido de la marcha
      const r = this.rumbo !== null ? this.rumbo : this.rumboRuta;
      if (r !== null && r !== undefined && Math.abs(((r - map.getBearing() + 540) % 360) - 180) >= 6) o.bearing = r;
    }
    map.easeTo(o);
  },
  activar(zoom) {      // centra el mapa en ti y lo mantiene siguiéndote
    this.camSigue = true; this.zoomPend = zoom || 15; this.actualizarBtn();
    this.iniciar();
    if (this.pos) this.mover();
  },
  centrarUnaVez(zoom) {   // te sitúa UNA vez: una lectura de GPS, centra el mapa y se acabó (sin seguimiento continuo)
    if (this.watchId !== null) {   // si ya hay seguimiento (modo «Seguir ruta»), basta con centrar en la última posición
      if (this.pos) { this.zoomPend = zoom || 15; this.mover(); } else this.unaVez = zoom || 15;
      return;
    }
    if (!navigator.geolocation) { setEstado("Tu navegador no permite acceder a la ubicación."); return; }
    this.unaVez = zoom || 15;
    // La primera lectura del móvil suele ser aproximada (antenas/WiFi, 20-50 m de error).
    // Se escucha el GPS unos segundos y se queda con la lectura más precisa.
    this.pararAfinado();
    const zm = zoom || 15, MAX_ACC = 10, MAX_MS = 15000;
    let mejor = Infinity;
    this.afinarT = setTimeout(() => this.pararAfinado(), MAX_MS);
    this.afinarId = navigator.geolocation.watchPosition(
      (p) => {
        const acc = p.coords.accuracy;
        if (acc > mejor) return;                       // ignora lecturas peores que la mejor ya vista
        const primera = mejor === Infinity;
        mejor = acc;
        if (!primera && this.afinarId !== null) this.unaVez = zm;   // recentra con la lectura mejorada (si no has movido el mapa)
        this.alActualizar(p);
        if (acc <= MAX_ACC) this.pararAfinado();       // ya es suficientemente precisa
      },
      (e) => { this.unaVez = 0; this.pararAfinado(); this.alError(e); },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  },
  pararAfinado() {
    if (this.afinarId !== null && this.afinarId !== undefined) { navigator.geolocation.clearWatch(this.afinarId); }
    this.afinarId = null; clearTimeout(this.afinarT);
  },
  detener() {          // apaga el seguimiento continuo del GPS (el punto azul se queda donde estaba)
    if (this.watchId !== null) { navigator.geolocation.clearWatch(this.watchId); this.watchId = null; }
    this.camSigue = false; this.actualizarBtn();
    this.rumbo = null; this.rumboRuta = null;
    if (orientMapa === "marcha" && Math.abs(map.getBearing()) > 0.5) map.easeTo({ bearing: 0, duration: 500 });   // al terminar, norte arriba otra vez
  },
  actualizarBtn() { if (this.btn) this.btn.classList.toggle("activo", this.camSigue); },
  pausarCam() {        // el usuario ha movido el mapa: se deja de centrar (en «Seguir ruta» se retoma a los 8 s)
    this.camSigue = false; this.actualizarBtn();
    clearTimeout(this.pausaT);
    if (typeof siguiendo !== "undefined" && siguiendo) this.pausaT = setTimeout(() => { if (siguiendo) { this.camSigue = true; this.actualizarBtn(); this.mover(); } }, 8000);
  }
};
class UbicacionControl {
  onAdd() {
    this._c = document.createElement("div");
    this._c.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const b = document.createElement("button");
    b.type = "button"; b.className = "ubic-btn"; b.title = "Mi ubicación"; b.setAttribute("aria-label", "Mostrar mi ubicación");
    b.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3.2" fill="currentColor"/><circle cx="12" cy="12" r="7.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';
    b.addEventListener("click", () => {
      if (typeof siguiendo !== "undefined" && siguiendo) ubic.activar(16);   // en «Seguir ruta» vuelve a seguirte
      else ubic.centrarUnaVez(16);                                            // si no: te sitúa una vez y nada más
    });
    ubic.btn = b; this._c.appendChild(b);
    return this._c;
  }
  onRemove() { this._c.remove(); }
}
map.addControl(new UbicacionControl(), "top-right");
map.on("dragstart", (e) => { if (!e.originalEvent) return; ubic.unaVez = 0; ubic.pararAfinado(); if (ubic.camSigue) ubic.pausarCam(); });

