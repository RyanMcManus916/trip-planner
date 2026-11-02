
/* Mobile reliability layer. Native anchors provide the primary navigation;
   JavaScript only adds section opening, legend control, and map resizing. */
(function () {
  "use strict";

  var mobileQuery = window.matchMedia ? window.matchMedia("(max-width: 900px)") : { matches: window.innerWidth <= 900 };
  var legendButton = document.getElementById("mobileLegendToggleBtn");

  function isMobileLayout() {
    return Boolean(mobileQuery.matches || window.innerWidth <= 900);
  }

  function getLeafletMap() {
    try {
      if (window.state && window.state.map && typeof window.state.map.invalidateSize === "function") return window.state.map;
    } catch (_) { /* state may be scoped to the core script */ }
    try {
      if (typeof state !== "undefined" && state && state.map && typeof state.map.invalidateSize === "function") return state.map;
    } catch (_) { /* lexical state is not globally visible in every browser */ }
    return null;
  }

  function refreshMapSize(delay) {
    window.setTimeout(function () {
      var leafletMap = getLeafletMap();
      if (leafletMap) leafletMap.invalidateSize(false);
    }, typeof delay === "number" ? delay : 100);
  }

  function revealSection(target) {
    var card = target && target.closest ? target.closest(".collapsible-card") : null;
    if (!card) return;

    var body = card.querySelector(".collapsible-body");
    var toggle = card.querySelector(".section-toggle");
    if (body && body.hidden) body.hidden = false;
    card.classList.remove("is-collapsed");
    if (toggle) {
      toggle.setAttribute("aria-expanded", "true");
      var label = toggle.querySelector(".toggle-label");
      var chevron = toggle.querySelector(".toggle-chevron");
      if (label) label.textContent = "Hide";
      if (chevron) chevron.textContent = "▴";
    }
  }

  function handleNativeNav(event) {
    var link = event.target && event.target.closest ? event.target.closest('a[href^="#"]') : null;
    if (!link || !isMobileLayout()) return;
    var hash = link.getAttribute("href");
    if (!hash || hash === "#") return;
    var target = document.getElementById(hash.slice(1));
    if (!target) return;

    /* Desktop map-focus state must never leave the mobile planner hidden. */
    var shell = document.querySelector(".app-shell");
    if (shell) shell.classList.remove("panel-collapsed");
    revealSection(target);

    /* Let the browser perform its native anchor navigation. A delayed map
       refresh corrects Leaflet after orientation or viewport changes. */
    if (hash === "#tripMapTop") refreshMapSize(160);
  }

  function setLegendOpen(open) {
    document.body.classList.toggle("mobile-legend-visible", open);
    if (legendButton) {
      legendButton.setAttribute("aria-pressed", String(open));
      legendButton.textContent = open ? "Hide legend" : "Legend";
    }
  }

  function bindMobileControls() {
    document.addEventListener("click", handleNativeNav, false);

    if (legendButton) {
      legendButton.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        setLegendOpen(!document.body.classList.contains("mobile-legend-visible"));
      }, false);
    }

    document.addEventListener("click", function (event) {
      if (!isMobileLayout() || !document.body.classList.contains("mobile-legend-visible")) return;
      if (event.target && event.target.closest && (event.target.closest("#mobileLegendToggleBtn") || event.target.closest(".legend"))) return;
      setLegendOpen(false);
    }, false);

    /* Mark the control layer as active. If this never runs, the visible warning
       explains that the file is being viewed in a non-interactive preview. */
    document.documentElement.classList.add("trip-planner-mobile-ready");
  }

  function handleLayoutChange() {
    var shell = document.querySelector(".app-shell");
    if (isMobileLayout() && shell) shell.classList.remove("panel-collapsed");
    if (!isMobileLayout()) setLegendOpen(false);
    refreshMapSize(140);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindMobileControls, { once: true });
  } else {
    bindMobileControls();
  }

  if (mobileQuery && typeof mobileQuery.addEventListener === "function") {
    mobileQuery.addEventListener("change", handleLayoutChange);
  } else if (mobileQuery && typeof mobileQuery.addListener === "function") {
    mobileQuery.addListener(handleLayoutChange);
  }

  window.addEventListener("resize", handleLayoutChange, { passive: true });
  window.addEventListener("orientationchange", function () { window.setTimeout(handleLayoutChange, 220); }, { passive: true });
  window.addEventListener("pageshow", function () { handleLayoutChange(); refreshMapSize(260); }, { passive: true });
  window.addEventListener("load", function () { handleLayoutChange(); refreshMapSize(300); }, { once: true });
})();
