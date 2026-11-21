// 05-panel.js (líneas 820-870 del index.html original)
// Panel inferior plegable (en escritorio siempre está desplegado por CSS)
const miRutaEl = document.getElementById("miRuta");
const btnPanelToggle = document.getElementById("btnPanelToggle");
function setPanel(abierto) {
  miRutaEl.classList.toggle("abierto", abierto);
  btnPanelToggle.setAttribute("aria-expanded", String(abierto));
  [0, 260].forEach(ms => setTimeout(() => map.resize(), ms)); // el mapa cambia de alto
}
const barraRutaEl = document.getElementById("barraRuta");
let gesto = null, huboArrastre = false;
barraRutaEl.addEventListener("pointerdown", (e) => {
  if (e.target.closest("#botonesRuta, .ctl-ruta, #infoPerfil")) { gesto = null; return; }
  gesto = { y: e.clientY }; huboArrastre = false;
});
barraRutaEl.addEventListener("pointermove", (e) => {
  if (gesto && Math.abs(e.clientY - gesto.y) > 12) huboArrastre = true;
});
barraRutaEl.addEventListener("pointerup", (e) => {
  if (!gesto) return;
  const dy = e.clientY - gesto.y; gesto = null;
  if (dy < -24) setPanel(true); else if (dy > 24) setPanel(false);   // deslizar arriba / abajo
});
barraRutaEl.addEventListener("pointercancel", () => { gesto = null; });
barraRutaEl.addEventListener("click", (e) => {                       // toque en cualquier parte de la barra
  if (e.target.closest("#botonesRuta, .ctl-ruta, #infoPerfil")) return;
  if (huboArrastre) { huboArrastre = false; return; }
  setPanel(!miRutaEl.classList.contains("abierto"));
});

// Al añadir una bajada o un punto: se resalta en la lista y, en móvil, el panel inferior sube un momento para enseñarla
const PEEK_MS = 3000;       // cuánto tiempo se queda abierto el panel en móvil si el usuario no lo toca
let peekT = null, peekActivo = false;
function mostrarAnadido(id) {
  const movil = window.matchMedia("(max-width: 720px)").matches;
  const alAbrir = movil && !miRutaEl.classList.contains("abierto");
  if (movil) setPanel(true);
  setTimeout(() => {
    const el = [...document.querySelectorAll("#miRutaLista .item")].find(x => x.dataset.id === id);
    if (!el) return;
    el.classList.remove("nuevo"); void el.offsetWidth; el.classList.add("nuevo");
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setTimeout(() => el.classList.remove("nuevo"), 1900);
  }, movil ? 260 : 0);
  if (movil && (alAbrir || peekActivo)) {
    peekActivo = true; clearTimeout(peekT);
    peekT = setTimeout(() => { peekActivo = false; setPanel(false); }, PEEK_MS);
  }
}
// Si el usuario toca el panel mientras está abierto por el aviso, se queda abierto
document.getElementById("panel").addEventListener("pointerdown", () => { clearTimeout(peekT); peekActivo = false; });

