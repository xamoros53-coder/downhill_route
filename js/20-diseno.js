// 20-diseno.js — piezas del rediseño que necesitan un poco de JS
// 1) Selector de modo de enrutamiento (4 botones) sincronizado con el <select id="perfil"> que usa el resto de la app
(function () {
  const sel = document.getElementById("perfil"), seg = document.getElementById("segModo");
  if (!sel || !seg) return;
  const pintar = () => seg.querySelectorAll("button").forEach(b => {
    const on = b.dataset.v === sel.value;
    b.classList.toggle("on", on); b.setAttribute("aria-pressed", on ? "true" : "false");
  });
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || b.dataset.v === sel.value) return;
    sel.value = b.dataset.v;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    pintar();
  });
  sel.addEventListener("change", pintar);
  pintar();
  window.addEventListener("load", pintar);
})();

// 2) Resumen en la cabecera de la hoja: «3 bajadas en tu ruta»
(function () {
  const lista = document.getElementById("miRutaLista"), out = document.getElementById("resumenSheet");
  if (!lista || !out) return;
  const act = () => {
    const n = lista.querySelectorAll(".item:not(.punto-inter)").length;
    out.textContent = n ? `${n} bajada${n === 1 ? "" : "s"} en tu ruta` : "Tu ruta";
  };
  new MutationObserver(act).observe(lista, { childList: true, subtree: true });
  act();
})();
