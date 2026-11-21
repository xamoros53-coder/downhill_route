// 08-ui.js (líneas 1112-1177 del index.html original)
let toastT = null;
function toast(msg, ms = 2200) {
  const el = document.getElementById("toast"); el.firstElementChild.textContent = msg; el.classList.add("on");
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("on"), ms);
}
const PASOS_INFO = {
  1: "<b>Elegir bajadas:</b> toca una bajada del mapa y pulsa «Añadir a mi ruta». Para una salida o punto intermedio, toca un hueco y pulsa «Añadir punto». Si no ves bajadas, acerca el mapa.",
  2: "<b>Generar ruta:</b> elige modo y ruta circular, y pulsa «Generar ruta»."
};
const PASO_LISTA = "<b>Ruta lista:</b> revísala en el mapa y pulsa «Descargar GPX».";
// Paso en el que está el usuario: 1 = elegir bajadas, 2 = ya hay algo en la ruta (generar)
function pasoActual() {
  return (rutaGenerada || miRuta.length) ? 2 : 1;
}
let pasoManual = null;      // paso que el usuario ha tocado para leerlo (null = sigue el paso actual)
let ultimoPasoAuto = 0;
function actualizarPasos() {
  const cur = pasoActual();
  if (cur !== ultimoPasoAuto) { ultimoPasoAuto = cur; pasoManual = null; }   // al avanzar, vuelve a mostrar el paso actual
  document.querySelectorAll("#pasos .stepper li").forEach(li => {
    const n = +li.dataset.p, hecho = n < cur, activo = n === cur;
    li.classList.toggle("hecho", hecho);
    li.classList.toggle("activo", activo);
    const b = li.querySelector("b"); if (b) b.textContent = hecho ? "✓" : String(n);
  });
  const mostrar = pasoManual || cur;
  const inf = document.getElementById("pasoInfo");
  inf.hidden = false;
  inf.innerHTML = `<span class="paso-n">Paso ${mostrar} de 2</span> · ` + ((mostrar === 2 && rutaGenerada) ? PASO_LISTA : PASOS_INFO[mostrar]);
}
document.querySelector("#pasos .stepper").addEventListener("click", (e) => {
  const li = e.target.closest("li"); if (!li) return;
  const n = +li.dataset.p; pasoManual = (n === pasoActual() || pasoManual === n) ? null : n; actualizarPasos();
});
// La altura de la tarjeta de pasos desplaza los controles del mapa (escala, ficha, aviso): se mide para que no se solapen
(function () {
  const pasos = document.getElementById("pasos"), mw = document.getElementById("mapwrap");
  if (!pasos || typeof ResizeObserver === "undefined") return;
  new ResizeObserver(() => { const h = pasos.offsetHeight; if (h > 0) mw.style.setProperty("--pasosAlto", (h + 8) + "px"); }).observe(pasos);
})();
const mapwrapEl = document.getElementById("mapwrap");
try { if (localStorage.getItem("pasosOff") === "1") mapwrapEl.classList.add("pasosOff"); } catch (e) {}
function ponerPasosOff(off) {
  mapwrapEl.classList.toggle("pasosOff", off);
  try { localStorage.setItem("pasosOff", off ? "1" : "0"); } catch (e) {}
  setTimeout(() => map.resize(), 0);
}
document.getElementById("pasosCerrar").addEventListener("click", () => ponerPasosOff(true));
document.getElementById("btnPasosVer").addEventListener("click", () => ponerPasosOff(false));
function actualizarContornoRuta() {
  if (!map.getLayer("tramos-miruta")) return;
  const ids = miRuta.filter(id => !esPunto(id));
  map.setFilter("tramos-miruta", ids.length ? ["in", ["get", "bajada_id"], ["literal", ids]] : ["==", ["get", "bajada_id"], ""]);
}
function esc(t) { return String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
const idDe = f => f.properties.id;
const catDe = p => p.dificultad_color || "sin";
const colorDe = p => COLORES[catDe(p)];
function fmtLong(m) { return m >= 1000 ? (m / 1000).toFixed(2).replace(".", ",") + " km" : m + " m"; }
function badgeFiab(p) { return p.fiabilidad === "osm" ? `<span class="badge osm">OSM</span>` : `<span class="badge det">detectada</span>`; }

function setEstado(msg) { document.getElementById("estadoRuta").textContent = msg || ""; }

