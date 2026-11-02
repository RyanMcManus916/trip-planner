
/* ========================================================================
   Complete planner enhancement layer
   Adds local trip management, dated schedules, manual ordering, fuel and
   arrival planning, exports, navigation links, and service diagnostics.
   ======================================================================== */
(() => {
  "use strict";

  const EP_VERSION = 3;
  const EP_STORAGE_KEY = "trailHistoryPlanner.savedTrips.v3";
  const EP_DRAFT_KEY = "trailHistoryPlanner.lastDraft.v3";
  const EP_TAB_SECTIONS = {
    plan: new Set(["trip", "route", "enhanced-library", "enhanced-schedule"]),
    itinerary: new Set(["summary", "itinerary", "enhanced-exports"]),
    explore: new Set(["browse", "route-assistant", "custom", "suggestions", "enhanced-service"])
  };

  let epCoreRenderAll;
  let epCoreRenderItinerary;
  let epCoreRenderSummary;
  let epCoreRenderRouteSearchResults;
  let epCoreSetStatus;
  let epCoreAddRouteSearchResultToDriveDay;
  let epCoreRebuildRoute;
  let epDragStopId = "";
  let epLastRouteCreated = false;
  let epSaveTimer = null;

  const epById = (id) => document.getElementById(id);
  const epClone = (value) => JSON.parse(JSON.stringify(value));
  const epNum = (id, fallback) => {
    const value = Number.parseFloat(epById(id)?.value);
    return Number.isFinite(value) ? value : fallback;
  };

  function epEnsureState() {
    state.enhanced = {
      version: EP_VERSION,
      activeTab: "plan",
      tripName: "My road trip",
      departureDate: "",
      dailyDepartureTime: "08:00",
      latestArrivalTime: "18:00",
      breakEveryHours: 2.5,
      breakMinutes: 15,
      mealBreakMinutes: 45,
      vehicleMpg: 22,
      tankGallons: 18,
      fuelReservePercent: 15,
      fuelPrice: 4,
      maxFuelGap: 250,
      routeStyle: "fastest",
      stopDetails: {},
      serviceLog: [],
      pendingRouteStopDuration: null,
      routeCreatedTabShown: false,
      ...(state.enhanced || {})
    };
    state.routeStops.forEach(epNormalizeStop);
    state.customStops.forEach(epNormalizeStop);
    state.plannedDriveStops.forEach(epNormalizePlannedStop);
  }

  function epNormalizeStop(stop) {
    if (!stop) return stop;
    if (typeof stop.locked !== "boolean") stop.locked = false;
    if (!stop.priorityLevel) stop.priorityLevel = stop.requiredMustSee ? "required" : "preferred";
    if (!stop.visitStyle) stop.visitStyle = "destination";
    if (stop.visitStyle === "passThrough" && !Number.isFinite(Number(stop.days))) stop.days = 0;
    return stop;
  }

  function epDefaultDuration(category) {
    return {
      fuel: 15,
      restroom: 15,
      charging: 30,
      grocery: 30,
      food: 45,
      lodging: 20,
      interesting: 60
    }[category] || 30;
  }

  function epNormalizePlannedStop(stop) {
    if (!stop) return stop;
    if (!Number.isFinite(Number(stop.durationMinutes))) stop.durationMinutes = epDefaultDuration(stop.category);
    if (!stop.planningNotes) stop.planningNotes = "";
    if (!Number.isFinite(Number(stop.routeDetourMiles))) stop.routeDetourMiles = Math.max(0, Number(stop.lateralMiles) || 0) * 2;
    if (!Number.isFinite(Number(stop.routeDetourMinutes))) stop.routeDetourMinutes = stop.routeDetourMiles / 35 * 60;
    return stop;
  }

  function epReadEnhancedControls() {
    epEnsureState();
    const e = state.enhanced;
    e.tripName = epById("enhancedTripName")?.value.trim() || "My road trip";
    e.departureDate = epById("exportDepartureDate")?.value || epById("departureDate")?.value || "";
    e.dailyDepartureTime = epById("dailyDepartureTime")?.value || "08:00";
    e.latestArrivalTime = epById("latestArrivalTime")?.value || "18:00";
    e.breakEveryHours = Math.max(1, Math.min(5, epNum("breakEveryHours", 2.5)));
    e.breakMinutes = Math.max(5, Math.min(60, epNum("breakMinutes", 15)));
    e.mealBreakMinutes = Math.max(0, Math.min(120, epNum("mealBreakMinutes", 45)));
    e.vehicleMpg = Math.max(5, Math.min(100, epNum("vehicleMpg", 22)));
    e.tankGallons = Math.max(3, Math.min(100, epNum("tankGallons", 18)));
    e.fuelReservePercent = Math.max(0, Math.min(50, epNum("fuelReservePercent", 15)));
    e.fuelPrice = Math.max(0, Math.min(20, epNum("fuelPrice", 4)));
    e.maxFuelGap = Math.max(25, Math.min(700, epNum("maxFuelGap", 250)));
    e.routeStyle = epById("routeStyle")?.value || "fastest";
    return e;
  }

  function epWriteEnhancedControls() {
    epEnsureState();
    const e = state.enhanced;
    const values = {
      enhancedTripName: e.tripName,
      departureDate: e.departureDate,
      dailyDepartureTime: e.dailyDepartureTime,
      latestArrivalTime: e.latestArrivalTime,
      breakEveryHours: e.breakEveryHours,
      breakMinutes: e.breakMinutes,
      mealBreakMinutes: e.mealBreakMinutes,
      vehicleMpg: e.vehicleMpg,
      tankGallons: e.tankGallons,
      fuelReservePercent: e.fuelReservePercent,
      fuelPrice: Number(e.fuelPrice).toFixed(2),
      maxFuelGap: e.maxFuelGap,
      routeStyle: e.routeStyle
    };
    Object.entries(values).forEach(([id, value]) => {
      const el = epById(id);
      if (el && value !== undefined && value !== null) el.value = String(value);
    });
    const exportDateField = epById("exportDepartureDate");
    if (exportDateField) exportDateField.value = e.departureDate || "";
  }

  function epLog(message, type = "info") {
    epEnsureState();
    const stamp = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
    state.enhanced.serviceLog.unshift(`[${stamp}] ${type.toUpperCase()}: ${message}`);
    state.enhanced.serviceLog = state.enhanced.serviceLog.slice(0, 40);
    epRenderServiceStatus();
  }

  function epEscapeCsv(value) {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  const epActiveDownloadUrls = new Map();
  const epPreparedExports = new Map();

  function epSyncExportState() {
    epReadEnhancedControls();
    document.querySelectorAll("[data-stop-detail]").forEach((field) => {
      const details = epDetailsForStop(field.dataset.stopDetailId);
      details[field.dataset.stopDetail] = field.value;
    });
    document.querySelectorAll("[data-enhanced-planned-note]").forEach((field) => {
      const stop = state.plannedDriveStops.find((item) => item.id === field.dataset.enhancedPlannedNote);
      if (stop) stop.planningNotes = field.value;
    });
  }

  function epFilePickerTypes(filename, type) {
    const extension = filename.includes(".") ? `.${filename.split(".").pop().toLowerCase()}` : ".txt";
    const mime = String(type || "application/octet-stream").split(";")[0] || "application/octet-stream";
    const labels = {
      ".json": "Trip JSON file",
      ".csv": "Spreadsheet CSV file",
      ".ics": "Calendar file",
      ".txt": "Text itinerary",
      ".html": "Printable HTML file"
    };
    return [{ description: labels[extension] || "Trip export file", accept: { [mime]: [extension] } }];
  }

  function epIsEmbeddedPreview() {
    try {
      return window.self !== window.top;
    } catch (_error) {
      return true;
    }
  }

  function epCanUseFilePicker() {
    return !epIsEmbeddedPreview() && window.isSecureContext && typeof window.showSaveFilePicker === "function";
  }

  function epReplaceDownloadUrl(areaId, blob) {
    const previousUrl = epActiveDownloadUrls.get(areaId);
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    const url = URL.createObjectURL(blob);
    epActiveDownloadUrls.set(areaId, url);
    return url;
  }

  async function epCopyPreparedExport(areaId) {
    const prepared = epPreparedExports.get(areaId);
    if (!prepared) return false;
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(prepared.text);
      } else {
        const preview = epById(`${areaId}-preview`);
        if (!preview) throw new Error("No copyable preview was available.");
        preview.focus();
        preview.select();
        const copied = document.execCommand("copy");
        if (!copied) throw new Error("The browser did not allow copying.");
      }
      const message = epById(`${areaId}-message`);
      if (message) message.textContent = "The export contents were copied to the clipboard.";
      return true;
    } catch (error) {
      const message = epById(`${areaId}-message`);
      if (message) message.textContent = `Copying was blocked: ${error.message}. Select the text below and copy it manually.`;
      return false;
    }
  }

  async function epSavePreparedExport(areaId) {
    const prepared = epPreparedExports.get(areaId);
    if (!prepared) return;
    const message = epById(`${areaId}-message`);

    if (epCanUseFilePicker()) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: prepared.filename,
          types: epFilePickerTypes(prepared.filename, prepared.type),
          excludeAcceptAllOption: false
        });
        const writable = await handle.createWritable();
        await writable.write(prepared.blob);
        await writable.close();
        if (message) message.textContent = `${prepared.filename} was saved to your PC.`;
        return;
      } catch (error) {
        if (error?.name === "AbortError") {
          if (message) message.textContent = "Save As was cancelled. You can still use the direct download link below.";
          return;
        }
        console.warn("Native Save As was unavailable; using the direct download link.", error);
      }
    }

    const link = epById(`${areaId}-direct-link`);
    if (link) {
      // This click occurs inside a direct user click on the Save button, which is
      // more widely permitted than an automatic download triggered during export.
      link.click();
      if (message) {
        message.textContent = epIsEmbeddedPreview()
          ? "The embedded preview may block the download. Open this HTML file directly on your PC, or use Open file / Copy contents below."
          : `A download request was sent for ${prepared.filename}. Check your browser Downloads list if no prompt appeared.`;
      }
    }
  }

  function epOpenPreparedExport(areaId) {
    const prepared = epPreparedExports.get(areaId);
    if (!prepared) return;
    const opened = window.open(prepared.url, "_blank", "noopener");
    const message = epById(`${areaId}-message`);
    if (!opened && message) {
      message.textContent = "The browser blocked the new tab. Allow pop-ups for this local file or use Copy contents.";
    } else if (message) {
      message.textContent = "The export opened in a new tab. Use Ctrl+S or the browser menu to save it.";
    }
  }

  function epShowPersistentDownload(areaId, filename, blob, textContent, type) {
    const area = epById(areaId);
    if (!area) return null;
    const url = epReplaceDownloadUrl(areaId, blob);
    const text = String(textContent ?? "");
    epPreparedExports.set(areaId, { filename, blob, text, type, url });
    area.replaceChildren();

    const heading = document.createElement("strong");
    heading.textContent = "Your export is ready to save";

    const explanation = document.createElement("p");
    explanation.textContent = "Choose Save file to PC. The direct link, new-tab view, and copyable contents remain available as fallbacks.";

    const actions = document.createElement("div");
    actions.className = "export-save-actions";

    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.className = "export-save-primary";
    saveButton.textContent = "Save file to PC";
    saveButton.addEventListener("click", () => epSavePreparedExport(areaId));

    const directLink = document.createElement("a");
    directLink.id = `${areaId}-direct-link`;
    directLink.className = "export-save-secondary";
    directLink.href = url;
    directLink.download = filename;
    directLink.textContent = `Direct download: ${filename}`;

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "export-save-secondary";
    openButton.textContent = "Open file in new tab";
    openButton.addEventListener("click", () => epOpenPreparedExport(areaId));

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "export-save-secondary";
    copyButton.textContent = "Copy contents";
    copyButton.addEventListener("click", () => epCopyPreparedExport(areaId));

    actions.append(saveButton, directLink, openButton, copyButton);

    const message = document.createElement("p");
    message.id = `${areaId}-message`;
    message.textContent = epIsEmbeddedPreview()
      ? "This page appears to be running inside an embedded preview. Embedded previews often block downloads. For dependable saving, download this HTML file itself and open it directly in Edge or Chrome."
      : "The export has been generated but has not been saved yet.";

    const compatibility = document.createElement("div");
    compatibility.className = "export-compatibility-note";
    compatibility.textContent = "If a download is blocked, right-click the Direct download link and choose Save link as. You can also open the file in a new tab and press Ctrl+S.";

    const details = document.createElement("details");
    details.className = "export-file-details";
    const summary = document.createElement("summary");
    summary.textContent = "View or manually copy the exported file";
    const preview = document.createElement("textarea");
    preview.id = `${areaId}-preview`;
    preview.className = "export-file-preview";
    preview.readOnly = true;
    preview.spellcheck = false;
    preview.value = text;
    details.append(summary, preview);

    area.append(heading, explanation, actions, message, compatibility, details);
    area.classList.add("show");
    area.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return directLink;
  }

  async function epDownload(filename, content, type = "text/plain;charset=utf-8", options = {}) {
    const { areaId = "exportDownloadArea" } = options;
    const textContent = content instanceof Blob ? await content.text() : String(content ?? "");
    const blob = content instanceof Blob ? content : new Blob([textContent], { type });
    if (!blob.size) throw new Error("The export contained no data.");
    epShowPersistentDownload(areaId, filename, blob, textContent, type);
    return { method: "prepared", filename, bytes: blob.size };
  }

  function epDownloadStatusMessage(result) {
    if (result.method === "prepared") return `${result.filename} is ready. Use “Save file to PC” in the panel below.`;
    if (result.method === "picker") return `${result.filename} was saved.`;
    if (result.method === "cancelled") return "Save As was cancelled. The file remains available below.";
    if (result.method === "legacy") return `${result.filename} was sent to the browser's file saver.`;
    if (result.method === "browser") return `A download was requested for ${result.filename}.`;
    return `${result.filename} is ready below.`;
  }

  function epSafeFilename(name, extension) {
    const base = String(name || "road-trip").trim().replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "road-trip";
    return `${base}.${extension}`;
  }

  function epGetFormValues() {
    const ids = [
      "startLocation", "endLocation", "mustSee", "historyInterests", "sceneryInterests",
      "excludePlaces", "planningNotes", "tripDays", "maxMiles", "maxHours",
      "lodgingWindowPercent", "pace", "emphasis", "stopSearch", "stopRegion",
      "stopCategory", "stopSort", "stopResultLimit", "routeSearchRadius", "routeSearchLimit"
    ];
    const values = {};
    ids.forEach((id) => {
      const el = epById(id);
      if (el) values[id] = el.value;
    });
    return values;
  }

  function epApplyFormValues(values = {}) {
    Object.entries(values).forEach(([id, value]) => {
      const el = epById(id);
      if (el && value !== undefined && value !== null) el.value = String(value);
    });
  }

  function epCollectSectionStates() {
    const result = {};
    document.querySelectorAll(".collapsible-card[data-section-id]").forEach((card) => {
      result[card.dataset.sectionId] = card.classList.contains("is-collapsed");
    });
    return result;
  }

  function epSerializeTrip() {
    epReadEnhancedControls();
    return {
      schema: "trail-history-trip",
      version: EP_VERSION,
      savedAt: new Date().toISOString(),
      name: state.enhanced.tripName,
      start: epClone(state.start),
      end: epClone(state.end),
      routeStops: epClone(state.routeStops),
      customStops: epClone(state.customStops),
      plannedDriveStops: epClone(state.plannedDriveStops),
      routeCreated: Boolean(state.routeCreated),
      lastBuildMode: state.lastBuildMode,
      lastRandomEmphasis: state.lastRandomEmphasis,
      form: epGetFormValues(),
      enhanced: epClone({ ...state.enhanced, serviceLog: state.enhanced.serviceLog.slice(0, 12) }),
      activeTab: state.enhanced.activeTab,
      sectionStates: epCollectSectionStates(),
      panelWidth: getComputedStyle(document.querySelector(".app-shell")).getPropertyValue("--planner-width").trim()
    };
  }

  function epNormalizeSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") throw new Error("The selected file does not contain a trip.");
    if (!snapshot.start || !snapshot.end) throw new Error("The trip file is missing its start or end location.");
    snapshot.routeStops = Array.isArray(snapshot.routeStops) ? snapshot.routeStops : [];
    snapshot.customStops = Array.isArray(snapshot.customStops) ? snapshot.customStops : [];
    snapshot.plannedDriveStops = Array.isArray(snapshot.plannedDriveStops) ? snapshot.plannedDriveStops : [];
    snapshot.routeStops.forEach(epNormalizeStop);
    snapshot.customStops.forEach(epNormalizeStop);
    snapshot.plannedDriveStops.forEach(epNormalizePlannedStop);
    return snapshot;
  }

  function epLoadSnapshot(rawSnapshot, { fitMap = true, announce = true } = {}) {
    const snapshot = epNormalizeSnapshot(epClone(rawSnapshot));
    cancelRoadRouteRequest();
    if (state.routeSearchController) state.routeSearchController.abort();
    state.start = snapshot.start;
    state.end = snapshot.end;
    state.routeStops = snapshot.routeStops;
    state.customStops = snapshot.customStops;
    state.plannedDriveStops = snapshot.plannedDriveStops;
    state.routeCreated = Boolean(snapshot.routeCreated);
    state.lastBuildMode = snapshot.lastBuildMode || "ideas";
    state.lastRandomEmphasis = snapshot.lastRandomEmphasis || null;
    state.roadRouteCache.clear();
    state.overnightLodgingCache.clear();
    state.overnightLookupPending.clear();
    state.routeSearchResults = [];
    state.routeSearchCache.clear();
    state.enhanced = { ...(state.enhanced || {}), ...(snapshot.enhanced || {}), activeTab: snapshot.activeTab || snapshot.enhanced?.activeTab || "plan" };
    epEnsureState();
    epApplyFormValues(snapshot.form || {});
    epById("startLocation").value = state.start.name;
    epById("endLocation").value = state.end.name;
    epWriteEnhancedControls();
    if (snapshot.panelWidth) document.querySelector(".app-shell")?.style.setProperty("--planner-width", snapshot.panelWidth);
    renderAll({ fitMap });
    Object.entries(snapshot.sectionStates || {}).forEach(([sectionId, collapsed]) => setSectionCollapsed(sectionId, Boolean(collapsed)));
    epApplyTab(state.enhanced.activeTab);
    if (announce) {
      setStatus("tripLibraryStatus", `${snapshot.name || "Trip"} was loaded. The road route is being refreshed.`, "success");
      epLog(`Loaded trip “${snapshot.name || "Trip"}”.`, "success");
    }
  }

  function epReadSavedTrips() {
    try {
      const parsed = JSON.parse(localStorage.getItem(EP_STORAGE_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      epLog(`Saved-trip storage could not be read: ${error.message}`, "warning");
      return {};
    }
  }

  function epWriteSavedTrips(trips) {
    localStorage.setItem(EP_STORAGE_KEY, JSON.stringify(trips));
  }

  function epRefreshSavedTripSelect(selectedId = "") {
    const select = epById("savedTripsSelect");
    if (!select) return;
    const trips = epReadSavedTrips();
    const entries = Object.entries(trips).sort((a, b) => String(b[1].savedAt || "").localeCompare(String(a[1].savedAt || "")));
    select.innerHTML = entries.length
      ? entries.map(([id, trip]) => `<option value="${escapeHtml(id)}">${escapeHtml(trip.name || "Untitled trip")} · ${new Date(trip.savedAt).toLocaleDateString()}</option>`).join("")
      : `<option value="">No saved trips yet</option>`;
    if (selectedId && trips[selectedId]) select.value = selectedId;
  }

  function epSaveTrip() {
    try {
      const snapshot = epSerializeTrip();
      const trips = epReadSavedTrips();
      const selected = epById("savedTripsSelect")?.value;
      const id = selected && trips[selected] ? selected : `trip-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      trips[id] = snapshot;
      epWriteSavedTrips(trips);
      epRefreshSavedTripSelect(id);
      setStatus("tripLibraryStatus", `${snapshot.name} was saved in this browser.`, "success");
      epLog(`Saved trip “${snapshot.name}”.`, "success");
    } catch (error) {
      setStatus("tripLibraryStatus", `The trip could not be saved: ${error.message}`, "error");
    }
  }

  function epLoadSavedTrip() {
    const id = epById("savedTripsSelect")?.value;
    const trip = epReadSavedTrips()[id];
    if (!trip) {
      setStatus("tripLibraryStatus", "Choose a saved trip first.", "warning");
      return;
    }
    epLoadSnapshot(trip);
  }

  function epDuplicateTrip() {
    const id = epById("savedTripsSelect")?.value;
    const trip = epReadSavedTrips()[id] || epSerializeTrip();
    const copy = epClone(trip);
    copy.name = `${copy.name || "Trip"} copy`;
    copy.enhanced = { ...(copy.enhanced || {}), tripName: copy.name };
    copy.savedAt = new Date().toISOString();
    const trips = epReadSavedTrips();
    const newId = `trip-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    trips[newId] = copy;
    epWriteSavedTrips(trips);
    epRefreshSavedTripSelect(newId);
    epById("enhancedTripName").value = copy.name;
    setStatus("tripLibraryStatus", `${copy.name} was created as a separate saved trip.`, "success");
  }

  function epDeleteSavedTrip() {
    const id = epById("savedTripsSelect")?.value;
    const trips = epReadSavedTrips();
    if (!id || !trips[id]) {
      setStatus("tripLibraryStatus", "Choose a saved trip to delete.", "warning");
      return;
    }
    const name = trips[id].name || "Trip";
    if (!window.confirm(`Delete the saved trip “${name}”? The route currently on screen will remain open.`)) return;
    delete trips[id];
    epWriteSavedTrips(trips);
    epRefreshSavedTripSelect();
    setStatus("tripLibraryStatus", `${name} was deleted from this browser.`, "info");
  }

  function epNewTrip() {
    if (state.routeCreated && !window.confirm("Start a new trip? Save or export the current trip first if you want to keep it.")) return;
    resetRoute();
    const formDefaults = {
      mustSee: "", historyInterests: "", sceneryInterests: "", excludePlaces: "", planningNotes: "",
      tripDays: "10", maxMiles: "300", maxHours: "5.5", lodgingWindowPercent: "10", pace: "balanced", emphasis: "balanced"
    };
    epApplyFormValues(formDefaults);
    state.enhanced = null;
    epEnsureState();
    epWriteEnhancedControls();
    epById("enhancedTripName").value = "My road trip";
    epApplyTab("plan");
    renderAll();
    setStatus("tripLibraryStatus", "A new blank trip is ready. Your saved trips were not changed.", "info");
  }

  async function epExportTripJson() {
    try {
      epSyncExportState();
      const snapshot = epSerializeTrip();
      const filename = epSafeFilename(snapshot.name, "json");
      const content = JSON.stringify(snapshot, null, 2);
      const result = await epDownload(filename, content, "application/json;charset=utf-8", { areaId: "tripFileDownloadArea" });
      setStatus("tripLibraryStatus", epDownloadStatusMessage(result), result.method === "cancelled" ? "warning" : "success");
    } catch (error) {
      setStatus("tripLibraryStatus", `The trip file could not be exported: ${error.message}`, "error");
    }
  }

  async function epImportTripFile(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const snapshot = JSON.parse(text);
      epLoadSnapshot(snapshot);
      setStatus("tripLibraryStatus", `${file.name} was imported. Save it to keep a browser copy.`, "success");
    } catch (error) {
      setStatus("tripLibraryStatus", `The trip file could not be imported: ${error.message}`, "error");
    } finally {
      epById("importTripFile").value = "";
    }
  }

  function epBase64UrlEncode(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
  }

  function epBase64UrlDecode(text) {
    const normalized = text.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((text.length + 3) % 4);
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  async function epCreateShareLink() {
    try {
      const snapshot = epSerializeTrip();
      const payload = epBase64UrlEncode(JSON.stringify(snapshot));
      const url = `${location.href.split("#")[0]}#trip=${payload}`;
      const output = epById("shareTripOutput");
      output.value = url;
      output.classList.remove("hidden");
      let copied = false;
      try {
        await navigator.clipboard.writeText(url);
        copied = true;
      } catch (_) {
        output.focus();
        output.select();
      }
      const sizeWarning = url.length > 24000 ? " The link is long; exporting the JSON file may be more dependable." : "";
      setStatus("tripLibraryStatus", `${copied ? "Share link copied." : "Share link created below; copy it manually."}${sizeWarning}`, copied ? "success" : "info");
    } catch (error) {
      setStatus("tripLibraryStatus", `A share link could not be created: ${error.message}`, "error");
    }
  }

  function epLoadHashTrip() {
    if (!location.hash.startsWith("#trip=")) return false;
    try {
      const snapshot = JSON.parse(epBase64UrlDecode(location.hash.slice(6)));
      epLoadSnapshot(snapshot, { announce: false });
      setStatus("tripLibraryStatus", "Shared trip loaded from the link. Save or export it if you want to keep a copy.", "success");
      return true;
    } catch (error) {
      setStatus("tripLibraryStatus", `The shared trip link could not be opened: ${error.message}`, "error");
      return false;
    }
  }

  function epApplyTab(tabName) {
    epEnsureState();
    const tab = EP_TAB_SECTIONS[tabName] ? tabName : "plan";
    state.enhanced.activeTab = tab;
    document.querySelectorAll("[data-app-tab-button]").forEach((button) => {
      button.setAttribute("aria-selected", String(button.dataset.appTabButton === tab));
    });
    document.querySelectorAll(".collapsible-card[data-section-id]").forEach((card) => {
      const sectionId = card.dataset.sectionId;
      card.classList.toggle("tab-filtered", !EP_TAB_SECTIONS[tab].has(sectionId));
    });
    window.requestAnimationFrame(() => state.map?.invalidateSize());
  }

  function epDateAtDay(dayNumber) {
    const value = state.enhanced?.departureDate || "";
    if (!value) return null;
    const date = new Date(`${value}T12:00:00`);
    if (Number.isNaN(date.getTime())) return null;
    date.setDate(date.getDate() + Math.max(0, dayNumber - 1));
    return date;
  }

  function epDateLabel(dayNumber, compact = false) {
    const date = epDateAtDay(dayNumber);
    if (!date) return "";
    return date.toLocaleDateString([], compact
      ? { weekday: "short", month: "short", day: "numeric" }
      : { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  }

  function epParseTime(value, fallback = "08:00") {
    const parts = String(value || fallback).split(":").map(Number);
    if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) return epParseTime(fallback, "08:00");
    return Math.max(0, Math.min(1439, parts[0] * 60 + parts[1]));
  }

  function epFormatMinutes(totalMinutes) {
    const dayOffset = Math.floor(totalMinutes / 1440);
    const minutes = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
    const hour24 = Math.floor(minutes / 60);
    const minute = minutes % 60;
    const suffix = hour24 >= 12 ? "PM" : "AM";
    const hour12 = hour24 % 12 || 12;
    return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}${dayOffset ? ` +${dayOffset}d` : ""}`;
  }

  function epStopFullDays(stop) {
    if (!stop) return 0;
    if (stop.visitStyle === "passThrough") return 0;
    const parsed = Number(stop.days);
    return Math.max(0, Math.min(10, Number.isFinite(parsed) ? parsed : 1));
  }

  function epBuildTravelSegments(summary = calculateRouteSummary()) {
    const segments = [];
    let day = 1;
    const enabledStops = summary.enabledStops;
    summary.legs.forEach((leg, legIndex) => {
      const plans = getLegOvernightPlans(leg);
      const breakpoints = [0];
      plans.forEach((plan) => {
        const candidate = plan.lodging?.routeMilesIntoLeg ?? plan.targetMiles;
        breakpoints.push(Math.max(breakpoints.at(-1) + 1, Math.min(leg.miles - 1, candidate)));
      });
      breakpoints.push(leg.miles);
      for (let segmentIndex = 0; segmentIndex < leg.requiredDays; segmentIndex += 1) {
        const previousPlan = plans[segmentIndex - 1];
        const currentPlan = plans[segmentIndex];
        const startMiles = breakpoints[segmentIndex];
        const endMiles = breakpoints[segmentIndex + 1];
        const miles = Math.max(0, endMiles - startMiles);
        const hours = leg.miles > 0 ? leg.hours * (miles / leg.miles) : 0;
        const from = previousPlan?.lodging || leg.from;
        const to = segmentIndex === leg.requiredDays - 1 ? leg.to : (currentPlan?.lodging || { name: "Suggested overnight area", ...pointAlongPath(leg.path, endMiles / Math.max(1, leg.miles)) });
        const plannedStops = plannedStopsForLeg(leg).filter((stop) => stop.alongMiles >= startMiles - 0.1 && stop.alongMiles <= endMiles + 0.1);
        segments.push({
          day,
          legIndex,
          segmentIndex,
          leg,
          from,
          to,
          fromName: from.name || leg.from.name,
          toName: to.name || leg.to.name,
          startMiles,
          endMiles,
          miles,
          hours,
          plannedStops
        });
        day += 1;
      }
      if (legIndex < enabledStops.length) day += epStopFullDays(enabledStops[legIndex]);
    });
    return segments;
  }

  function epTimelineForSegment(segment) {
    const e = epReadEnhancedControls();
    const departure = epParseTime(e.dailyDepartureTime);
    const driveMinutes = segment.hours * 60;
    const automaticBreaks = segment.hours > e.breakEveryHours
      ? Math.floor((segment.hours - 0.05) / e.breakEveryHours)
      : 0;
    const breakMinutes = automaticBreaks * e.breakMinutes;
    const mealMinutes = segment.hours >= 4 ? e.mealBreakMinutes : 0;
    let stopElapsed = 0;
    const items = [{ time: departure, label: `Leave ${segment.fromName}`, kind: "depart" }];
    segment.plannedStops.forEach((stop) => {
      epNormalizePlannedStop(stop);
      const fraction = segment.miles > 0 ? (stop.alongMiles - segment.startMiles) / segment.miles : 0;
      const arrival = departure + driveMinutes * Math.max(0, Math.min(1, fraction)) + stopElapsed;
      items.push({ time: arrival, label: `${stop.name} · ${Math.round(stop.durationMinutes)} min planned stop${stop.planningNotes ? ` · ${stop.planningNotes}` : ""}`, kind: "stop" });
      stopElapsed += Number(stop.durationMinutes) || 0;
      stopElapsed += Number(stop.routeDetourMinutes) || 0;
    });
    if (automaticBreaks) {
      items.push({ time: departure + driveMinutes * 0.45, label: `${automaticBreaks} rest break${automaticBreaks === 1 ? "" : "s"} · ${Math.round(breakMinutes)} min total`, kind: "break" });
    }
    if (mealMinutes) {
      items.push({ time: Math.max(departure + driveMinutes * 0.55, 12 * 60), label: `Meal break · ${Math.round(mealMinutes)} min`, kind: "meal" });
    }
    const arrival = departure + driveMinutes + breakMinutes + mealMinutes + stopElapsed;
    items.push({ time: arrival, label: `Arrive in ${segment.toName}`, kind: "arrival" });
    items.sort((a, b) => a.time - b.time || (a.kind === "arrival" ? 1 : -1));
    const latest = epParseTime(e.latestArrivalTime, "18:00");
    const late = arrival > latest;
    return { items, arrival, late, latest, automaticBreaks, breakMinutes, mealMinutes, stopMinutes: stopElapsed };
  }

  function epStopRoleLabel(stop) {
    if (stop.requiredMustSee || stop.priorityLevel === "required") return "Required";
    if (stop.priorityLevel === "optional") return "Optional";
    return "Preferred";
  }

  function epDetailsForStop(stopId) {
    epEnsureState();
    state.enhanced.stopDetails[stopId] = {
      lodgingName: "",
      address: "",
      confirmation: "",
      checkIn: "15:00",
      reservationStatus: "Researching",
      tickets: "",
      activities: "",
      restaurants: "",
      mealNotes: "",
      notes: "",
      ...(state.enhanced.stopDetails[stopId] || {})
    };
    return state.enhanced.stopDetails[stopId];
  }

  function epEnhanceItinerary() {
    if (!epById("itineraryContent")) return;
    epEnsureState();
    const summary = calculateRouteSummary();
    const segments = epBuildTravelSegments(summary);
    const destinationSchedule = new Map();
    let destinationDay = 1;
    summary.enabledStops.forEach((scheduledStop, index) => {
      destinationDay += summary.legs[index]?.requiredDays || 0;
      const days = epStopFullDays(scheduledStop);
      destinationSchedule.set(scheduledStop.id, { startDay: days === 0 ? Math.max(1, destinationDay - 1) : destinationDay, days });
      destinationDay += days;
    });
    const travelCards = [...document.querySelectorAll("#itineraryContent .travel-day")];
    travelCards.forEach((card, index) => {
      const segment = segments[index];
      if (!segment) return;
      card.dataset.enhancedDay = String(segment.day);
      card.querySelector(".timeline-panel")?.remove();
      const badge = card.querySelector(".day-badge");
      if (badge) badge.innerHTML = `Day ${segment.day}${epDateLabel(segment.day, true) ? `<span class="date-sub">${escapeHtml(epDateLabel(segment.day, true))}</span>` : ""}`;
      const timeline = epTimelineForSegment(segment);
      const panel = document.createElement("div");
      panel.className = "timeline-panel";
      panel.innerHTML = `<div class="timeline-head"><strong>Drive-day timeline</strong><span>${Math.round(segment.miles)} mi · ${round(segment.hours, 1)} hr behind the wheel</span></div>
        <ul class="timeline-list">${timeline.items.map((item) => `<li><span class="timeline-time">${escapeHtml(epFormatMinutes(item.time))}</span><span>${escapeHtml(item.label)}</span></li>`).join("")}</ul>
        <div class="${timeline.late ? "calendar-warning" : "helper"}">${timeline.late ? `<span class="late-arrival">Arrival is later than the preferred ${escapeHtml(epFormatMinutes(timeline.latest))}.</span>` : `Estimated arrival is before the preferred ${escapeHtml(epFormatMinutes(timeline.latest))}.`} Estimates include planned stop durations, routine breaks, and a meal break on drives of four hours or more.</div>`;
      card.append(panel);
    });

    document.querySelectorAll("#itineraryContent .planned-drive-stop").forEach((row) => {
      const id = row.dataset.plannedDriveStopId;
      const stop = state.plannedDriveStops.find((item) => item.id === id);
      if (!stop) return;
      epNormalizePlannedStop(stop);
      row.querySelector(".planned-stop-editor")?.remove();
      const editor = document.createElement("div");
      editor.className = "planned-stop-editor";
      editor.innerHTML = `<label>Planned visit <select class="mini-select" data-enhanced-planned-duration="${escapeHtml(id)}">
        ${[15,30,45,60,90,120].map((minutes) => `<option value="${minutes}" ${Number(stop.durationMinutes) === minutes ? "selected" : ""}>${minutes} min</option>`).join("")}
      </select></label><label>Stop note <input class="mini-input" data-enhanced-planned-note="${escapeHtml(id)}" value="${escapeHtml(stop.planningNotes || "")}" placeholder="Fuel, lunch, short walk…"></label>`;
      row.append(editor);
    });

    document.querySelectorAll("#itineraryContent .itinerary-stop").forEach((card) => {
      const stopId = card.dataset.stopId;
      const stop = state.routeStops.find((item) => item.id === stopId);
      if (!stop) return;
      epNormalizeStop(stop);
      const title = card.querySelector(".stop-title");
      if (title && !title.querySelector(".role-badge")) title.insertAdjacentHTML("beforeend", `<span class="role-badge">${escapeHtml(epStopRoleLabel(stop))}${stop.locked ? " · Locked" : ""}</span>`);
      const scheduled = destinationSchedule.get(stop.id);
      const meta = card.querySelector(".stop-meta");
      meta?.querySelector(".destination-date")?.remove();
      if (scheduled && meta && state.enhanced.departureDate) {
        const dateText = scheduled.days > 1
          ? `${epDateLabel(scheduled.startDay, true)}–${epDateLabel(scheduled.startDay + scheduled.days - 1, true)}`
          : epDateLabel(scheduled.startDay, true);
        meta.insertAdjacentHTML("beforeend", ` <span class="destination-date">· <strong>${escapeHtml(dateText)}</strong></span>`);
      }
      card.querySelector(".enhanced-stop-tools")?.remove();
      card.querySelector(".planning-details")?.remove();
      const controls = document.createElement("div");
      controls.className = "enhanced-stop-tools";
      const enabled = stop.enabled !== false;
      controls.innerHTML = `${enabled ? `<button class="drag-handle" type="button" draggable="true" data-enhanced-drag-handle="${escapeHtml(stopId)}" title="Drag to reorder" aria-label="Drag ${escapeHtml(stop.name)} to reorder">⋮⋮</button>
        <button class="btn-light btn-small" type="button" data-enhanced-action="move-up" data-stop-id="${escapeHtml(stopId)}">↑ Up</button>
        <button class="btn-light btn-small" type="button" data-enhanced-action="move-down" data-stop-id="${escapeHtml(stopId)}">↓ Down</button>` : ""}
        <label class="include-control"><input type="checkbox" data-enhanced-lock="${escapeHtml(stopId)}" ${stop.locked ? "checked" : ""}> Lock position</label>
        <label>Priority <select class="mini-select" data-enhanced-priority="${escapeHtml(stopId)}" ${stop.requiredMustSee ? "disabled" : ""}>
          <option value="required" ${stop.requiredMustSee || stop.priorityLevel === "required" ? "selected" : ""}>Required</option>
          <option value="preferred" ${!stop.requiredMustSee && stop.priorityLevel === "preferred" ? "selected" : ""}>Preferred</option>
          <option value="optional" ${stop.priorityLevel === "optional" ? "selected" : ""}>Optional</option>
        </select></label>
        <label>Visit style <select class="mini-select" data-enhanced-visit-style="${escapeHtml(stopId)}">
          <option value="destination" ${stop.visitStyle === "destination" ? "selected" : ""}>Full destination</option>
          <option value="overnightBase" ${stop.visitStyle === "overnightBase" ? "selected" : ""}>Overnight base</option>
          <option value="passThrough" ${stop.visitStyle === "passThrough" ? "selected" : ""}>Pass-through (0 full days)</option>
        </select></label>`;
      const description = card.querySelector(".stop-description");
      (description || card.querySelector(".stop-head"))?.insertAdjacentElement("afterend", controls);
      card.removeAttribute("draggable");

      const details = epDetailsForStop(stopId);
      const detailPanel = document.createElement("details");
      detailPanel.className = "planning-details";
      detailPanel.innerHTML = `<summary>Reservations, meals and activity notes</summary><div class="planning-details-grid">
        <div class="field"><label>Lodging name<input data-stop-detail="lodgingName" data-stop-detail-id="${escapeHtml(stopId)}" value="${escapeHtml(details.lodgingName)}"></label></div>
        <div class="field"><label>Reservation status<select data-stop-detail="reservationStatus" data-stop-detail-id="${escapeHtml(stopId)}"><option ${details.reservationStatus === "Researching" ? "selected" : ""}>Researching</option><option ${details.reservationStatus === "Reserved" ? "selected" : ""}>Reserved</option><option ${details.reservationStatus === "Paid" ? "selected" : ""}>Paid</option><option ${details.reservationStatus === "Not needed" ? "selected" : ""}>Not needed</option></select></label></div>
        <div class="field"><label>Address<input data-stop-detail="address" data-stop-detail-id="${escapeHtml(stopId)}" value="${escapeHtml(details.address)}"></label></div>
        <div class="field"><label>Confirmation number<input data-stop-detail="confirmation" data-stop-detail-id="${escapeHtml(stopId)}" value="${escapeHtml(details.confirmation)}"></label></div>
        <div class="field"><label>Check-in time<input type="time" data-stop-detail="checkIn" data-stop-detail-id="${escapeHtml(stopId)}" value="${escapeHtml(details.checkIn)}"></label></div>
        <div class="field"><label>Tickets / reservations<input data-stop-detail="tickets" data-stop-detail-id="${escapeHtml(stopId)}" value="${escapeHtml(details.tickets)}"></label></div>
        <div class="field full"><label>Hikes, tours and activities<textarea data-stop-detail="activities" data-stop-detail-id="${escapeHtml(stopId)}">${escapeHtml(details.activities)}</textarea></label></div>
        <div class="field full"><label>Restaurants and meal ideas<textarea data-stop-detail="restaurants" data-stop-detail-id="${escapeHtml(stopId)}">${escapeHtml(details.restaurants)}</textarea></label></div>
        <div class="field full"><label>Meal or grocery notes<textarea data-stop-detail="mealNotes" data-stop-detail-id="${escapeHtml(stopId)}">${escapeHtml(details.mealNotes)}</textarea></label></div>
        <div class="field full"><label>General notes<textarea data-stop-detail="notes" data-stop-detail-id="${escapeHtml(stopId)}">${escapeHtml(details.notes)}</textarea></label></div>
      </div>`;
      card.append(detailPanel);
    });
  }

  function epEnhanceRouteSearchResults() {
    document.querySelectorAll("#routeQuestionResults .route-search-result").forEach((card) => {
      if (card.querySelector(".route-impact")) return;
      const index = Number.parseInt(card.dataset.routeResultIndex, 10);
      const result = state.routeSearchResults[index];
      if (!result) return;
      const detourMiles = Math.max(0, Number(result.lateralMiles) || 0) * 2;
      const detourMinutes = detourMiles / 35 * 60;
      const impact = document.createElement("div");
      impact.className = "route-impact";
      impact.innerHTML = `<strong>Planning impact:</strong> about ${round(detourMiles, 1)} additional miles and ${Math.max(1, Math.round(detourMinutes))} minutes of detour driving before the visit itself.
        <div class="route-impact-controls"><label>Visit duration <select class="mini-select" data-route-result-duration>
          ${[15,30,45,60,90,120].map((minutes) => `<option value="${minutes}" ${minutes === epDefaultDuration(result.category) ? "selected" : ""}>${minutes} minutes</option>`).join("")}
        </select></label><span>Arrival estimates update after it is added.</span></div>`;
      const actions = card.querySelector(".route-result-actions");
      actions?.insertAdjacentElement("afterend", impact);
    });
  }

  function epMoveStop(stopId, direction) {
    const index = state.routeStops.findIndex((stop) => stop.id === stopId);
    if (index < 0) return;
    const target = index + direction;
    if (target < 0 || target >= state.routeStops.length) return;
    const [stop] = state.routeStops.splice(index, 1);
    state.routeStops.splice(target, 0, stop);
    state.routeSearchStale = true;
    renderAll({ fitMap: false });
    setStatus("plannerStatus", `${stop.name} was moved ${direction < 0 ? "earlier" : "later"} in the route.`, "success");
  }

  function epReorderStopBefore(sourceId, targetId) {
    if (!sourceId || sourceId === targetId) return;
    const from = state.routeStops.findIndex((stop) => stop.id === sourceId);
    const to = state.routeStops.findIndex((stop) => stop.id === targetId);
    if (from < 0 || to < 0) return;
    const [stop] = state.routeStops.splice(from, 1);
    const insertAt = from < to ? to - 1 : to;
    state.routeStops.splice(insertAt, 0, stop);
    state.routeSearchStale = true;
    renderAll({ fitMap: false });
    setStatus("plannerStatus", `${stop.name} was reordered. Road mileage and travel days are being recalculated.`, "success");
  }

  function epOptimizeUnlockedStops() {
    const original = [...state.routeStops];
    const available = original.filter((stop) => stop.enabled !== false && !stop.locked);
    if (available.length < 2) {
      setStatus("plannerStatus", "There are not enough unlocked included stops to optimize.", "info");
      return;
    }
    const remaining = new Map(available.map((stop) => [stop.id, stop]));
    const reordered = [];
    let current = state.start;
    for (let i = 0; i < original.length; i += 1) {
      const fixed = original[i];
      if (fixed.enabled === false) {
        reordered.push(fixed);
        continue;
      }
      if (fixed.locked) {
        reordered.push(fixed);
        current = fixed;
        continue;
      }
      const nextLocked = original.slice(i + 1).find((stop) => stop.enabled !== false && stop.locked) || state.end;
      let best = null;
      remaining.forEach((candidate) => {
        const score = haversineMiles(current, candidate) + 0.28 * haversineMiles(candidate, nextLocked);
        if (!best || score < best.score) best = { candidate, score };
      });
      if (best) {
        reordered.push(best.candidate);
        remaining.delete(best.candidate.id);
        current = best.candidate;
      }
    }
    remaining.forEach((stop) => reordered.push(stop));
    state.routeStops = reordered;
    renderAll({ fitMap: true });
    setStatus("plannerStatus", "Unlocked stops were optimized while locked positions were preserved.", "success");
  }

  async function epRebuildPreservingLocked() {
    const locked = state.routeStops
      .map((stop, index) => ({ stop: epClone(stop), index }))
      .filter((item) => item.stop.locked || item.stop.priorityLevel === "required" || item.stop.requiredMustSee);
    await epCoreRebuildRoute();
    if (!locked.length) return;
    locked.forEach(({ stop, index }) => {
      state.routeStops = state.routeStops.filter((item) => item.id !== stop.id);
      state.routeStops.splice(Math.min(index, state.routeStops.length), 0, stop);
    });
    renderAll({ fitMap: true });
    setStatus("plannerStatus", `Suggested plan rebuilt. ${locked.length} locked stop position${locked.length === 1 ? " was" : "s were"} preserved.`, "success");
  }

  function epFuelStats(summary = calculateRouteSummary()) {
    const e = epReadEnhancedControls();
    const detourMiles = state.plannedDriveStops.reduce((sum, stop) => sum + (Number(stop.routeDetourMiles) || 0), 0);
    const totalMiles = summary.totalMiles + detourMiles;
    const gallons = e.vehicleMpg > 0 ? totalMiles / e.vehicleMpg : 0;
    const cost = gallons * e.fuelPrice;
    const usableRange = e.vehicleMpg * e.tankGallons * (1 - e.fuelReservePercent / 100);
    const preferredGap = Math.min(usableRange, e.maxFuelGap);
    const longestTravelDay = epBuildTravelSegments(summary).reduce((max, segment) => Math.max(max, segment.miles), 0);
    const refuels = usableRange > 0 ? Math.max(0, Math.ceil(totalMiles / usableRange) - 1) : 0;
    return { totalMiles, detourMiles, gallons, cost, usableRange, preferredGap, longestTravelDay, refuels, e };
  }

  function epRenderFuelMetrics() {
    const container = epById("fuelPlanningMetrics");
    if (!container) return;
    if (!state.routeCreated) {
      container.innerHTML = `<div class="fuel-metric"><strong>${Math.round(epReadEnhancedControls().vehicleMpg * epReadEnhancedControls().tankGallons * (1 - epReadEnhancedControls().fuelReservePercent / 100))} mi</strong><span>Estimated usable range with reserve</span></div><div class="fuel-metric"><strong>Build a route</strong><span>Trip fuel and cost estimates will appear here.</span></div>`;
      return;
    }
    const stats = epFuelStats();
    const rangeWarning = stats.longestTravelDay > stats.preferredGap;
    container.innerHTML = `<div class="fuel-metric"><strong>${Math.round(stats.usableRange)} mi</strong><span>Usable tank range after ${Math.round(stats.e.fuelReservePercent)}% reserve</span></div>
      <div class="fuel-metric"><strong>${round(stats.gallons, 1)} gal</strong><span>Estimated fuel for route and mapped detours</span></div>
      <div class="fuel-metric"><strong>$${Math.round(stats.cost).toLocaleString()}</strong><span>Estimated fuel cost at $${Number(stats.e.fuelPrice).toFixed(2)}/gal</span></div>
      <div class="fuel-metric"><strong>${stats.refuels}</strong><span>Approximate en-route refuels after departure</span></div>
      ${rangeWarning ? `<div class="calendar-warning" style="grid-column:1/-1">At least one travel day is longer than the preferred ${Math.round(stats.preferredGap)}-mile fuel gap. Use “Find fuel on longest leg” to plan a stop.</div>` : ""}`;
  }

  function epRouteStyleAvoidValue() {
    const style = epReadEnhancedControls().routeStyle;
    if (style === "avoidTolls") return "tolls";
    if (style === "scenic") return "highways";
    if (style === "avoidCities") return "highways";
    return "";
  }

  function epGoogleDirectionsUrl(origin, destination, waypoints = []) {
    const params = new URLSearchParams({ api: "1", travelmode: "driving" });
    const locationText = (place) => Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lng))
      ? `${place.lat},${place.lng}`
      : place.name;
    params.set("origin", locationText(origin));
    params.set("destination", locationText(destination));
    if (waypoints.length) params.set("waypoints", waypoints.slice(0, 8).map(locationText).join("|"));
    const avoid = epRouteStyleAvoidValue();
    if (avoid) params.set("avoid", avoid);
    return `https://www.google.com/maps/dir/?${params}`;
  }

  function epRenderDailyNavigationLinks() {
    const container = epById("dailyNavigationLinks");
    if (!container) return;
    if (!state.routeCreated) {
      container.innerHTML = `<p class="helper">Build a route to create daily navigation links.</p>`;
      return;
    }
    const segments = epBuildTravelSegments();
    container.innerHTML = segments.map((segment) => {
      const waypoints = segment.plannedStops.map((stop) => ({ name: stop.name, lat: stop.lat, lng: stop.lng }));
      const url = epGoogleDirectionsUrl(segment.from, segment.to, waypoints);
      return `<div class="daily-link-row"><div><strong>Day ${segment.day}${epDateLabel(segment.day, true) ? ` · ${escapeHtml(epDateLabel(segment.day, true))}` : ""}</strong><span>${escapeHtml(segment.fromName)} → ${escapeHtml(segment.toName)} · ${Math.round(segment.miles)} miles${waypoints.length ? ` · ${waypoints.length} planned stop${waypoints.length === 1 ? "" : "s"}` : ""}</span></div><a class="btn-light btn-small" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open navigation</a></div>`;
    }).join("");
  }

  function epBuildItineraryRows() {
    const summary = calculateRouteSummary();
    const segments = epBuildTravelSegments(summary);
    const rows = [];
    segments.forEach((segment) => {
      const timeline = epTimelineForSegment(segment);
      rows.push({
        day: segment.day,
        date: epDateLabel(segment.day),
        type: "Travel",
        from: segment.fromName,
        to: segment.toName,
        name: `${segment.fromName} to ${segment.toName}`,
        miles: Math.round(segment.miles),
        drivingHours: round(segment.hours, 1),
        plannedHours: round((timeline.arrival - epParseTime(state.enhanced.dailyDepartureTime)) / 60, 1),
        notes: segment.plannedStops.map((stop) => `${stop.name} (${stop.durationMinutes} min)`).join("; ")
      });
    });
    let currentDay = 1;
    summary.enabledStops.forEach((stop, index) => {
      currentDay += summary.legs[index]?.requiredDays || 0;
      const days = epStopFullDays(stop);
      const details = epDetailsForStop(stop.id);
      for (let offset = 0; offset < days; offset += 1) {
        rows.push({
          day: currentDay + offset,
          date: epDateLabel(currentDay + offset),
          type: "Destination",
          from: "",
          to: "",
          name: stop.name,
          miles: "",
          drivingHours: "",
          plannedHours: "",
          notes: [details.activities, details.restaurants, details.mealNotes, details.notes].filter(Boolean).join(" | ")
        });
      }
      if (days === 0) {
        rows.push({ day: Math.max(1, currentDay - 1), date: epDateLabel(Math.max(1, currentDay - 1)), type: "Pass-through", from: "", to: "", name: stop.name, miles: "", drivingHours: "", plannedHours: "", notes: details.notes || "" });
      }
      currentDay += days;
    });
    return rows.sort((a, b) => a.day - b.day || (a.type === "Travel" ? -1 : 1));
  }

  async function epExportCsv() {
    if (!state.routeCreated) return setStatus("exportStatus", "Build a route before exporting an itinerary.", "warning");
    try {
      epSyncExportState();
      const rows = epBuildItineraryRows();
      if (!rows.length) throw new Error("The itinerary has no rows to export.");
      const headers = ["Day", "Date", "Type", "From", "To", "Location", "Miles", "Driving hours", "Planned hours", "Notes"];
      const csv = "\uFEFF" + [headers, ...rows.map((row) => [row.day, row.date, row.type, row.from, row.to, row.name, row.miles, row.drivingHours, row.plannedHours, row.notes])]
        .map((row) => row.map(epEscapeCsv).join(",")).join("\r\n");
      const filename = epSafeFilename(state.enhanced.tripName, "csv");
      const result = await epDownload(filename, csv, "text/csv;charset=utf-8", { areaId: "exportDownloadArea" });
      setStatus("exportStatus", epDownloadStatusMessage(result), result.method === "cancelled" ? "warning" : "success");
    } catch (error) {
      setStatus("exportStatus", `The CSV could not be exported: ${error.message}`, "error");
    }
  }

  function epIcsDate(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  }

  function epIcsDateTime(date, minutes) {
    const copy = new Date(date);
    copy.setHours(0, 0, 0, 0);
    copy.setMinutes(Number(minutes) || 0);
    const pad = (n) => String(n).padStart(2, "0");
    return `${copy.getFullYear()}${pad(copy.getMonth() + 1)}${pad(copy.getDate())}T${pad(copy.getHours())}${pad(copy.getMinutes())}00`;
  }

  function epIcsUtcStamp(date = new Date()) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  }

  function epIcsEscape(value) {
    return String(value || "")
      .replaceAll("\\", "\\\\")
      .replaceAll("\r\n", "\\n")
      .replaceAll("\n", "\\n")
      .replaceAll(";", "\\;")
      .replaceAll(",", "\\,");
  }

  // RFC 5545 recommends folding content lines at 75 octets. Folding makes the
  // file import reliably in Apple Calendar, Outlook, and Google Calendar.
  function epIcsFoldLine(line) {
    const encoder = new TextEncoder();
    const parts = [];
    let current = "";
    for (const character of String(line)) {
      const candidate = current + character;
      if (encoder.encode(candidate).length > 73 && current) {
        parts.push(current);
        current = ` ${character}`;
      } else {
        current = candidate;
      }
    }
    if (current) parts.push(current);
    return parts.join("\r\n");
  }

  function epBuildCalendarIcs() {
    const summary = calculateRouteSummary();
    const segments = epBuildTravelSegments(summary);
    const generatedAt = new Date();
    const stamp = epIcsUtcStamp(generatedAt);
    const uidSeed = `${generatedAt.getTime()}-${Math.random().toString(36).slice(2, 9)}`;
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Trail and History Road Trip Planner//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      `X-WR-CALNAME:${epIcsEscape(state.enhanced.tripName)}`,
      "X-WR-CALDESC:Road-trip itinerary generated by Trail and History Road-Trip Planner"
    ];

    segments.forEach((segment, index) => {
      const date = epDateAtDay(segment.day);
      if (!date) return;
      const timeline = epTimelineForSegment(segment);
      const startMinutes = epParseTime(state.enhanced.dailyDepartureTime);
      const stopNames = segment.plannedStops.map((stop) => stop.name).filter(Boolean);
      lines.push(
        "BEGIN:VEVENT",
        `UID:travel-${segment.day}-${index}-${uidSeed}@trail-history-planner`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${epIcsDateTime(date, startMinutes)}`,
        `DTEND:${epIcsDateTime(date, Math.max(startMinutes + 1, timeline.arrival))}`,
        `SUMMARY:${epIcsEscape(`Drive: ${segment.fromName} to ${segment.toName}`)}`,
        `LOCATION:${epIcsEscape(segment.toName)}`,
        `DESCRIPTION:${epIcsEscape(`${Math.round(segment.miles)} miles; about ${round(segment.hours, 1)} driving hours. Planned stops: ${stopNames.join(", ") || "None"}. Estimated arrival: ${epFormatMinutes(timeline.arrival)}.`)}`,
        "STATUS:CONFIRMED",
        "TRANSP:OPAQUE",
        "END:VEVENT"
      );
    });

    let currentDay = 1;
    summary.enabledStops.forEach((stop, index) => {
      currentDay += summary.legs[index]?.requiredDays || 0;
      const days = epStopFullDays(stop);
      if (days > 0) {
        const start = epDateAtDay(currentDay);
        const end = epDateAtDay(currentDay + days); // All-day DTEND is exclusive.
        const details = epDetailsForStop(stop.id);
        const description = [
          details.lodgingName && `Lodging: ${details.lodgingName}`,
          details.address && `Address: ${details.address}`,
          details.confirmation && `Confirmation: ${details.confirmation}`,
          details.activities && `Activities: ${details.activities}`,
          details.tickets && `Tickets: ${details.tickets}`,
          details.restaurants && `Meals: ${details.restaurants}`,
          details.notes
        ].filter(Boolean).join(" | ");
        lines.push(
          "BEGIN:VEVENT",
          `UID:stop-${String(stop.id).replace(/[^a-z0-9_-]/gi, "-")}-${uidSeed}@trail-history-planner`,
          `DTSTAMP:${stamp}`,
          `DTSTART;VALUE=DATE:${epIcsDate(start)}`,
          `DTEND;VALUE=DATE:${epIcsDate(end)}`,
          `SUMMARY:${epIcsEscape(`${stop.name} - ${days} full day${days === 1 ? "" : "s"}`)}`,
          `LOCATION:${epIcsEscape(stop.name)}`,
          `DESCRIPTION:${epIcsEscape(description || stop.description || "Planned destination day")}`,
          "STATUS:CONFIRMED",
          "TRANSP:TRANSPARENT",
          "END:VEVENT"
        );
      }
      currentDay += days;
    });

    lines.push("END:VCALENDAR");
    return lines.map(epIcsFoldLine).join("\r\n") + "\r\n";
  }

  function epCalendarFile(filename, ics) {
    try {
      return new File([ics], filename, { type: "text/calendar;charset=utf-8", lastModified: Date.now() });
    } catch (_error) {
      const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
      blob.name = filename;
      return blob;
    }
  }

  async function epShareCalendarFile(filename, ics) {
    const file = epCalendarFile(filename, ics);
    if (!navigator.share || !navigator.canShare) return false;
    try {
      if (!navigator.canShare({ files: [file] })) return false;
      await navigator.share({
        title: state.enhanced.tripName,
        text: "Import this road-trip itinerary into your calendar.",
        files: [file]
      });
      return true;
    } catch (error) {
      if (error?.name !== "AbortError") console.warn("Calendar sharing was unavailable.", error);
      return false;
    }
  }

  function epAddCalendarActions(filename, ics) {
    const area = epById("exportDownloadArea");
    const actions = area?.querySelector(".export-save-actions");
    if (!area || !actions) return;

    const prepared = epPreparedExports.get("exportDownloadArea");
    if (prepared) prepared.calendarText = ics;

    const shareButton = document.createElement("button");
    shareButton.type = "button";
    shareButton.className = "calendar-export-action";
    shareButton.textContent = "Share / add to calendar";
    shareButton.addEventListener("click", async () => {
      const shared = await epShareCalendarFile(filename, ics);
      const message = epById("exportDownloadArea-message");
      if (message) message.textContent = shared
        ? "The calendar file was handed to your device. Choose Calendar or Save to Files in the share sheet."
        : "This browser could not share the calendar file. Use Save file, Direct download, or Open calendar file.";
    });

    const openLink = document.createElement("a");
    openLink.className = "calendar-export-action secondary";
    openLink.href = prepared?.url || `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`;
    openLink.target = "_blank";
    openLink.rel = "noopener";
    openLink.textContent = "Open calendar file";

    actions.prepend(openLink);
    actions.prepend(shareButton);

    const directLink = epById("exportDownloadArea-direct-link");
    if (directLink) directLink.textContent = `Download calendar file: ${filename}`;
  }

  async function epExportCalendar() {
    if (!state.routeCreated) return setStatus("exportStatus", "Build a route before exporting a calendar.", "warning");

    const exportDate = epById("exportDepartureDate")?.value || epById("departureDate")?.value || "";
    if (exportDate) {
      if (epById("departureDate")) epById("departureDate").value = exportDate;
      if (epById("exportDepartureDate")) epById("exportDepartureDate").value = exportDate;
    }
    epSyncExportState();

    if (!state.enhanced.departureDate) {
      const dateField = epById("exportDepartureDate");
      setStatus("exportStatus", "Choose the Calendar departure date above, then press Export / add calendar again.", "warning");
      dateField?.focus();
      dateField?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }

    try {
      const ics = epBuildCalendarIcs();
      if (!ics.includes("BEGIN:VEVENT")) throw new Error("The itinerary did not contain any calendar events.");
      const filename = epSafeFilename(state.enhanced.tripName, "ics");
      const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
      if (isMobile) {
        const shared = await epShareCalendarFile(filename, ics);
        if (shared) {
          setStatus("exportStatus", "Calendar file shared. Choose Calendar or Save to Files in the share sheet.", "success");
          return;
        }
      }
      const result = await epDownload(filename, ics, "text/calendar;charset=utf-8", { areaId: "exportDownloadArea" });
      epAddCalendarActions(filename, ics);
      setStatus("exportStatus", `${filename} is ready. Use Share / add to calendar, Save file, or Open calendar file below.`, "success");
    } catch (error) {
      setStatus("exportStatus", `The calendar could not be exported: ${error.message}`, "error");
    }
  }

  async function epExportText() {
    if (!state.routeCreated) return setStatus("exportStatus", "Build a route before exporting an itinerary.", "warning");
    try {
      epSyncExportState();
      const summary = calculateRouteSummary();
      const stats = epFuelStats(summary);
      const rows = epBuildItineraryRows();
      if (!rows.length) throw new Error("The itinerary has no entries to export.");
      const lines = [
        state.enhanced.tripName,
        `${state.start.name} to ${state.end.name}`,
        `${summary.totalDays} days · ${Math.round(summary.totalMiles)} miles · ${round(summary.totalHours, 1)} driving hours`,
        `Estimated fuel: ${round(stats.gallons, 1)} gallons · $${Math.round(stats.cost)}`,
        ""
      ];
      rows.forEach((row) => {
        lines.push(`Day ${row.day}${row.date ? ` · ${row.date}` : ""}`);
        lines.push(row.type === "Travel" ? `  Drive: ${row.from} → ${row.to} · ${row.miles} mi · ${row.drivingHours} hr` : `  ${row.type}: ${row.name}`);
        if (row.notes) lines.push(`  Notes: ${row.notes}`);
        lines.push("");
      });
      const filename = epSafeFilename(state.enhanced.tripName, "txt");
      const result = await epDownload(filename, lines.join("\r\n"), "text/plain;charset=utf-8", { areaId: "exportDownloadArea" });
      setStatus("exportStatus", epDownloadStatusMessage(result), result.method === "cancelled" ? "warning" : "success");
    } catch (error) {
      setStatus("exportStatus", `The family itinerary could not be exported: ${error.message}`, "error");
    }
  }

  function epRenderExportPreview() {
    const container = epById("exportPreviewGrid");
    if (!container) return;
    if (!state.routeCreated) {
      container.innerHTML = `<div class="export-preview"><strong>No itinerary yet</strong><span>Build a route to enable exports.</span></div>`;
      return;
    }
    const summary = calculateRouteSummary();
    const reservationCount = Object.values(state.enhanced.stopDetails || {}).filter((details) => ["Reserved", "Paid"].includes(details.reservationStatus)).length;
    container.innerHTML = `<div class="export-preview"><strong>${summary.totalDays} days</strong><span>${state.enhanced.departureDate ? `${epDateLabel(1, true)} departure` : "Add a departure date for calendar labels"}</span></div>
      <div class="export-preview"><strong>${reservationCount} confirmed</strong><span>Destinations marked reserved or paid</span></div>`;
  }

  function epUpdateSnapshot() {
    const container = epById("enhancedTripSnapshot");
    if (!container) return;
    if (!state.routeCreated) {
      container.innerHTML = `<div class="snapshot-empty">${escapeHtml(state.start.name)} → ${escapeHtml(state.end.name)} · build a route to see mileage, dates, fuel and hotel nights.</div>`;
      epById("itineraryTabBadge").textContent = "0";
      return;
    }
    const summary = calculateRouteSummary();
    const stats = epFuelStats(summary);
    const dateRange = state.enhanced.departureDate
      ? `${epDateLabel(1, true)}–${epDateLabel(summary.totalDays, true)}`
      : `${summary.totalDays} calendar days`;
    container.innerHTML = `<div class="snapshot-item"><strong>${Math.round(summary.totalMiles).toLocaleString()} mi</strong><span>Road trip</span></div>
      <div class="snapshot-item"><strong>${dateRange}</strong><span>Schedule</span></div>
      <div class="snapshot-item"><strong>${summary.enabledStops.length} stops</strong><span>${summary.enRouteOvernights} en-route hotels</span></div>
      <div class="snapshot-item"><strong>$${Math.round(stats.cost)}</strong><span>Estimated fuel</span></div>`;
    epById("itineraryTabBadge").textContent = String(summary.totalDays);
  }

  function epRenderServiceStatus() {
    const grid = epById("serviceStatusGrid");
    if (!grid || !state.enhanced) return;
    const road = state.routeCreated
      ? (getCachedRoadRoute(getRoutePoints()) ? { cls: "good", text: "Road route ready" } : state.pendingRoadRouteKey ? { cls: "busy", text: "Road route loading" } : { cls: "warn", text: "Using estimate / retry available" })
      : { cls: "good", text: "Ready when route is built" };
    const search = state.routeSearchController
      ? { cls: "busy", text: "Searching" }
      : state.routeSearchResults.length
        ? { cls: "good", text: `${state.routeSearchResults.length} recent results` }
        : { cls: "good", text: "Ready" };
    const storageGood = (() => { try { localStorage.setItem("__trip_test__", "1"); localStorage.removeItem("__trip_test__"); return true; } catch (_) { return false; } })();
    grid.innerHTML = `<div class="service-tile"><strong>Leaflet map</strong><span class="service-state ${state.map ? "good" : "warn"}">${state.map ? "Loaded" : "Unavailable"}</span></div>
      <div class="service-tile"><strong>Road routing</strong><span class="service-state ${road.cls}">${road.text}</span></div>
      <div class="service-tile"><strong>Route discovery</strong><span class="service-state ${search.cls}">${search.text}</span></div>
      <div class="service-tile"><strong>Geocoding</strong><span class="service-state good">${state.geocodeCache.size} cached location${state.geocodeCache.size === 1 ? "" : "s"}</span></div>
      <div class="service-tile"><strong>Browser storage</strong><span class="service-state ${storageGood ? "good" : "warn"}">${storageGood ? "Available" : "Blocked"}</span></div>
      <div class="service-tile"><strong>Planner version</strong><span class="service-state good">Showcase v${EP_VERSION}</span></div>`;
    const log = epById("diagnosticLog");
    if (log) log.textContent = state.enhanced.serviceLog.length ? state.enhanced.serviceLog.join("\n") : "No diagnostic messages yet.";
  }

  function epUpdateTabVisibility() {
    epById("planTabBadge").textContent = state.routeCreated ? "✓" : "1";
    epById("exploreTabBadge").textContent = String(CANDIDATES.length + state.customStops.length);
    epApplyTab(state.enhanced.activeTab);
  }

  function epAfterRender() {
    epEnsureState();
    epEnhanceItinerary();
    epEnhanceRouteSearchResults();
    epRenderFuelMetrics();
    epRenderDailyNavigationLinks();
    epRenderExportPreview();
    epUpdateSnapshot();
    epRenderServiceStatus();
    epUpdateTabVisibility();
    if (state.routeCreated && !epLastRouteCreated && !state.enhanced.routeCreatedTabShown) {
      state.enhanced.routeCreatedTabShown = true;
      epApplyTab("itinerary");
    }
    epLastRouteCreated = state.routeCreated;
    window.clearTimeout(epSaveTimer);
    epSaveTimer = window.setTimeout(() => {
      try { localStorage.setItem(EP_DRAFT_KEY, JSON.stringify(epSerializeTrip())); } catch (_) { /* optional draft */ }
    }, 500);
  }

  function epFindFuelOnLongestLeg() {
    if (!state.routeCreated) return setStatus("plannerStatus", "Build a route before searching for fuel.", "warning");
    const summary = calculateRouteSummary();
    if (!summary.legs.length) return;
    let longestIndex = 0;
    summary.legs.forEach((leg, index) => { if (leg.miles > summary.legs[longestIndex].miles) longestIndex = index; });
    const select = epById("routeQuestionLeg");
    if (select) select.value = String(longestIndex);
    epApplyTab("explore");
    setSectionCollapsed("route-assistant", false);
    searchAlongRoute("fuel");
  }

  function epCompareWholeRoute() {
    if (!state.routeCreated) return setStatus("plannerStatus", "Build a route before opening a route comparison.", "warning");
    const waypoints = getEnabledStops().slice(0, 8);
    window.open(epGoogleDirectionsUrl(state.start, state.end, waypoints), "_blank", "noopener,noreferrer");
  }

  function epAddRouteResultWithDuration(index, duration) {
    state.enhanced.pendingRouteStopDuration = Number(duration) || null;
    addRouteSearchResultToDriveDay(index);
    state.enhanced.pendingRouteStopDuration = null;
  }

  function epInstallFunctionWrappers() {
    epCoreRenderAll = renderAll;
    epCoreRenderItinerary = renderItinerary;
    epCoreRenderSummary = renderSummary;
    epCoreRenderRouteSearchResults = renderRouteSearchResults;
    epCoreSetStatus = setStatus;
    epCoreAddRouteSearchResultToDriveDay = addRouteSearchResultToDriveDay;
    epCoreRebuildRoute = rebuildRoute;

    renderAll = function enhancedRenderAll(options = {}) {
      epCoreRenderAll(options);
      window.requestAnimationFrame(epAfterRender);
    };
    renderItinerary = function enhancedRenderItinerary() {
      epCoreRenderItinerary();
      window.requestAnimationFrame(epEnhanceItinerary);
    };
    renderSummary = function enhancedRenderSummary() {
      epCoreRenderSummary();
      window.requestAnimationFrame(() => {
        epRenderFuelMetrics();
        epUpdateSnapshot();
        epRenderExportPreview();
      });
    };
    renderRouteSearchResults = function enhancedRenderRouteSearchResults() {
      epCoreRenderRouteSearchResults();
      window.requestAnimationFrame(epEnhanceRouteSearchResults);
    };
    setStatus = function enhancedSetStatus(elementId, message, type = "info") {
      epCoreSetStatus(elementId, message, type);
      if (["plannerStatus", "routeQuestionStatus", "startStatus", "endStatus", "geocodeStatus"].includes(elementId) && message) epLog(message, type);
    };
    addRouteSearchResultToDriveDay = function enhancedAddRouteStop(index) {
      const before = new Set(state.plannedDriveStops.map((stop) => stop.id));
      const result = state.routeSearchResults[index];
      epCoreAddRouteSearchResultToDriveDay(index);
      const added = state.plannedDriveStops.find((stop) => !before.has(stop.id));
      if (added) {
        epNormalizePlannedStop(added);
        const selected = Number(state.enhanced.pendingRouteStopDuration);
        if (Number.isFinite(selected) && selected > 0) added.durationMinutes = selected;
        if (result) {
          added.routeDetourMiles = Math.max(0, Number(result.lateralMiles) || 0) * 2;
          added.routeDetourMinutes = added.routeDetourMiles / 35 * 60;
        }
        renderAll({ fitMap: false });
      }
    };
    rebuildRoute = epRebuildPreservingLocked;
  }

  function epInstallRebuildButton() {
    const oldButton = epById("rebuildBtn");
    if (!oldButton) return;
    const clone = oldButton.cloneNode(true);
    oldButton.replaceWith(clone);
    clone.addEventListener("click", epRebuildPreservingLocked);
    const optimize = document.createElement("button");
    optimize.className = "btn-gold";
    optimize.id = "optimizeUnlockedBtn";
    optimize.type = "button";
    optimize.textContent = "Optimize unlocked stops";
    clone.insertAdjacentElement("afterend", optimize);
    optimize.addEventListener("click", epOptimizeUnlockedStops);
  }

  window.addEventListener("beforeunload", () => {
    epActiveDownloadUrls.forEach((url) => URL.revokeObjectURL(url));
    epActiveDownloadUrls.clear();
  });


  let epOriginalDocumentTitle = "";

  function epPrintMercator(lat, lng) {
    const safeLat = Math.max(-85.05112878, Math.min(85.05112878, Number(lat) || 0));
    const safeLng = Number(lng) || 0;
    const sin = Math.sin(safeLat * Math.PI / 180);
    return {
      x: (safeLng + 180) / 360,
      y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)
    };
  }

  function epPrintRouteCoordinates() {
    const points = getRoutePoints();
    const road = getCachedRoadRoute(points);
    const source = road?.latLngs?.length > 1
      ? road.latLngs
      : points.map((point) => [point.lat, point.lng]);
    const step = Math.max(1, Math.ceil(source.length / 900));
    const sampled = source.filter((_point, index) => index % step === 0);
    if (source.length && sampled.at(-1) !== source.at(-1)) sampled.push(source.at(-1));
    return sampled;
  }

  function epPrintTruncate(value, max = 30) {
    const text = String(value || "");
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
  }


  function epPrintMapKey() {
    const points = getRoutePoints();
    const road = getCachedRoadRoute(points);
    return `${buildRouteKey(points)}|${road?.latLngs?.length > 1 ? "road" : "estimate"}|${road?.latLngs?.length || 0}`;
  }

  function epPrintWorldPixel(lat, lng, zoom) {
    const projected = epPrintMercator(lat, lng);
    const worldSize = 256 * (2 ** zoom);
    return { x: projected.x * worldSize, y: projected.y * worldSize };
  }

  function epPrintMapZoom(bounds, width, height, padding) {
    const spanX = Math.max(1e-7, bounds.maxX - bounds.minX);
    const spanY = Math.max(1e-7, bounds.maxY - bounds.minY);
    const usableWidth = Math.max(120, width - padding * 2);
    const usableHeight = Math.max(120, height - padding * 2);
    const scaleX = usableWidth / (spanX * 256);
    const scaleY = usableHeight / (spanY * 256);
    const zoom = Math.floor(Math.log2(Math.max(1, Math.min(scaleX, scaleY))));
    return Math.max(2, Math.min(12, zoom));
  }


  function epBuildPrintRouteMap() {
    const width = 960;
    const height = 460;
    const padding = 62;
    const coordinates = epPrintRouteCoordinates();
    const stops = getRoutePoints();
    if (coordinates.length < 2) {
      return {
        key: epPrintMapKey(),
        tileUrls: [],
        markup: `<div class="print-static-map print-static-map-unavailable" role="img" aria-label="Route overview unavailable"><p>Route overview unavailable</p></div>`
      };
    }

    const normalized = [
      ...coordinates.map(([lat, lng]) => epPrintMercator(lat, lng)),
      ...stops.map((stop) => epPrintMercator(stop.lat, stop.lng))
    ];
    let minX = Math.min(...normalized.map((point) => point.x));
    let maxX = Math.max(...normalized.map((point) => point.x));
    let minY = Math.min(...normalized.map((point) => point.y));
    let maxY = Math.max(...normalized.map((point) => point.y));
    if (maxX - minX < 0.00001) { minX -= 0.00001; maxX += 0.00001; }
    if (maxY - minY < 0.00001) { minY -= 0.00001; maxY += 0.00001; }

    const zoom = epPrintMapZoom({ minX, maxX, minY, maxY }, width, height, padding);
    const worldSize = 256 * (2 ** zoom);
    const centerX = ((minX + maxX) / 2) * worldSize;
    const centerY = ((minY + maxY) / 2) * worldSize;
    const topLeftX = centerX - width / 2;
    const topLeftY = centerY - height / 2;
    const tileCount = 2 ** zoom;
    const firstTileX = Math.floor(topLeftX / 256);
    const lastTileX = Math.floor((topLeftX + width) / 256);
    const firstTileY = Math.max(0, Math.floor(topLeftY / 256));
    const lastTileY = Math.min(tileCount - 1, Math.floor((topLeftY + height) / 256));

    const hostedPrintMap = !localFileLikeContext()
      && ["http:", "https:"].includes(String(window.location.protocol || "").toLowerCase());
    const printProviderKey = state.mapTileProvider === "topographic" ? "topographic" : "street";
    const printProvider = MAP_TILE_CONFIG.providers[printProviderKey] || MAP_TILE_CONFIG.providers.street;
    const useRemotePrintTiles = hostedPrintMap && state.mapTileProvider !== "offline";
    const tileUrls = [];
    const tiles = [];
    if (useRemotePrintTiles) {
      for (let tileY = firstTileY; tileY <= lastTileY; tileY += 1) {
        for (let tileX = firstTileX; tileX <= lastTileX; tileX += 1) {
          const wrappedX = ((tileX % tileCount) + tileCount) % tileCount;
          const url = printProvider.url
            .replace(/\{z\}/g, String(zoom))
            .replace(/\{x\}/g, String(wrappedX))
            .replace(/\{y\}/g, String(tileY));
          tileUrls.push(url);
          const x = tileX * 256 - topLeftX;
          const y = tileY * 256 - topLeftY;
          const left = x / width * 100;
          const top = y / height * 100;
          const tileWidth = 256 / width * 100;
          const tileHeight = 256 / height * 100;
          tiles.push(`<img class="print-map-tile" data-print-map-tile="true" src="${url}" alt="" aria-hidden="true" decoding="async" referrerpolicy="${MAP_TILE_CONFIG.referrerPolicy}" style="left:${left.toFixed(5)}%;top:${top.toFixed(5)}%;width:${tileWidth.toFixed(5)}%;height:${tileHeight.toFixed(5)}%">`);
        }
      }
    }

    const fit = (lat, lng) => {
      const point = epPrintWorldPixel(lat, lng, zoom);
      return { x: point.x - topLeftX, y: point.y - topLeftY };
    };

    const routePath = coordinates.map(([lat, lng], index) => {
      const point = fit(lat, lng);
      return `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`;
    }).join(" ");

    const markers = stops.map((stop, index) => {
      const point = fit(stop.lat, stop.lng);
      const isStart = index === 0;
      const isEnd = index === stops.length - 1;
      const sameEndpoint = isEnd && stops.length > 1 && Math.abs(stops[0].lat - stop.lat) < 0.00001 && Math.abs(stops[0].lng - stop.lng) < 0.00001;
      const markerX = sameEndpoint ? point.x + 14 : point.x;
      const markerY = sameEndpoint ? point.y + 2 : point.y;
      const fill = isStart ? "#174535" : isEnd ? "#c38a2d" : "#9c4337";
      const label = isStart ? "S" : isEnd ? "E" : String(index);
      const name = epPrintTruncate(stop.name, 28);
      const textAnchor = markerX > width * 0.72 ? "end" : "start";
      const labelX = textAnchor === "end" ? markerX - 12 : markerX + 12;
      const labelY = markerY < 35 ? markerY + 25 : markerY - 13;
      return `<g><circle cx="${markerX.toFixed(1)}" cy="${markerY.toFixed(1)}" r="9.5" fill="${fill}" stroke="#fff" stroke-width="2.5"/><text x="${markerX.toFixed(1)}" y="${(markerY + 3.6).toFixed(1)}" text-anchor="middle" fill="#fff" font-size="9" font-family="Arial, sans-serif" font-weight="700">${escapeHtml(label)}</text><text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="${textAnchor}" fill="#203c31" font-size="10.5" font-family="Arial, sans-serif" font-weight="700" paint-order="stroke" stroke="#fff" stroke-width="3.5" stroke-linejoin="round">${escapeHtml(name)}</text></g>`;
    }).join("");

    const overlay = `<svg class="print-map-overlay" viewBox="0 0 ${width} ${height}" role="img" aria-label="Route overview from ${escapeHtml(state.start.name)} to ${escapeHtml(state.end.name)}" preserveAspectRatio="none">
      <path d="${routePath}" fill="none" stroke="#fff" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" opacity="0.96"/>
      <path d="${routePath}" fill="none" stroke="#9c4337" stroke-width="5.4" stroke-linecap="round" stroke-linejoin="round"/>
      ${markers}
      <g transform="translate(${width - 43} 30)"><path d="M0 18L8 0L16 18L8 14Z" fill="#174535" stroke="#fff" stroke-width="1"/><text x="8" y="31" text-anchor="middle" fill="#174535" font-size="11" font-family="Arial, sans-serif" font-weight="700" paint-order="stroke" stroke="#fff" stroke-width="2">N</text></g>
      <g transform="translate(18 ${height - 28})"><rect x="-8" y="-17" width="255" height="27" rx="6" fill="#fff" opacity="0.9"/><circle cx="5" cy="-3" r="7" fill="#174535"/><text x="18" y="1" fill="#30443a" font-size="10" font-family="Arial, sans-serif">Start</text><circle cx="72" cy="-3" r="7" fill="#9c4337"/><text x="85" y="1" fill="#30443a" font-size="10" font-family="Arial, sans-serif">Destination</text><circle cx="171" cy="-3" r="7" fill="#c38a2d"/><text x="184" y="1" fill="#30443a" font-size="10" font-family="Arial, sans-serif">Finish</text></g>
      <g transform="translate(${width - 255} ${height - 12})"><rect x="-6" y="-15" width="252" height="20" rx="4" fill="#fff" opacity="0.9"/><text x="120" y="0" text-anchor="middle" fill="#53655d" font-size="9" font-family="Arial, sans-serif">${escapeHtml(useRemotePrintTiles ? printProvider.printAttribution : "Offline planning canvas · route only")} · zoom ${zoom}</text></g>
    </svg>`;

    const markup = `<div class="print-static-map" role="img" aria-label="Route overview from ${escapeHtml(state.start.name)} to ${escapeHtml(state.end.name)}"><div class="print-map-grid" aria-hidden="true"></div>${tiles.join("")}${overlay}</div>`;
    return { key: epPrintMapKey(), tileUrls: [...new Set(tileUrls)], markup };
  }


  async function epWaitForPrintMapTiles(_tileUrls, timeoutMs = 12000) {
    const container = epById("printRouteOverview");
    const images = [...(container?.querySelectorAll("img[data-print-map-tile]") || [])];
    if (!images.length) return { loaded: 0, failed: 0, timedOut: false, total: 0 };
    let loaded = images.filter((image) => image.complete && image.naturalWidth > 0).length;
    let failed = images.filter((image) => image.complete && image.naturalWidth === 0).length;
    const pending = images.filter((image) => !image.complete);
    let timedOut = false;
    await Promise.race([
      Promise.allSettled(pending.map((image) => new Promise((resolve) => {
        const finish = (ok) => {
          image.removeEventListener("load", onLoad);
          image.removeEventListener("error", onError);
          if (ok) loaded += 1; else failed += 1;
          resolve();
        };
        const onLoad = () => finish(true);
        const onError = () => finish(false);
        image.addEventListener("load", onLoad, { once: true });
        image.addEventListener("error", onError, { once: true });
      }))),
      new Promise((resolve) => setTimeout(() => { timedOut = true; resolve(); }, timeoutMs))
    ]);
    loaded = images.filter((image) => image.complete && image.naturalWidth > 0).length;
    failed = images.filter((image) => image.complete && image.naturalWidth === 0).length;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { loaded, failed, timedOut, total: images.length };
  }

  function epPreparePrintLayout() {
    if (!state.routeCreated) return false;
    epSyncExportState();
    const summary = calculateRouteSummary();
    const tripName = state.enhanced.tripName || "Road-trip itinerary";
    const startDate = state.enhanced.departureDate ? epDateAtDay(1) : null;
    const endDate = state.enhanced.departureDate ? epDateAtDay(Math.max(1, summary.totalDays)) : null;
    const dateText = startDate && endDate
      ? `${startDate.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" })} - ${endDate.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" })}`
      : "Dates not assigned";

    epById("printTripTitle").textContent = tripName;
    epById("printTripSubtitle").textContent = `${state.start.name} to ${state.end.name}`;
    epById("printTripDateRange").textContent = dateText;
    epById("printRouteSource").textContent = summary.usesRoadRouting
      ? "OpenStreetMap base map · road-following route"
      : "OpenStreetMap base map · estimated route";
    const printMap = epBuildPrintRouteMap();
    const printMapContainer = epById("printRouteOverview");
    if (printMapContainer.dataset.printMapKey !== printMap.key) {
      printMapContainer.innerHTML = printMap.markup;
      printMapContainer.dataset.printMapKey = printMap.key;
      printMapContainer._printTileUrls = printMap.tileUrls;
    }
    epById("printTripMetrics").innerHTML = [
      [summary.totalDays, "Calendar days"],
      [summary.travelDays, "Travel days"],
      [summary.fullDestinationDays, "Full destination days"],
      [`${Math.round(summary.totalMiles).toLocaleString()} mi`, "Estimated mileage"],
      [`${round(summary.totalHours, 1)} hr`, "Driving time"],
      [summary.drivingLegs, "Driving legs"],
      [summary.enabledStops.length, "Destinations"],
      [state.plannedDriveStops.length, "Drive-day stops"]
    ].map(([value, label]) => `<div class="print-metric"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span></div>`).join("");

    if (!epOriginalDocumentTitle) epOriginalDocumentTitle = document.title;
    document.title = epSafeFilename(tripName, "").replace(/\.$/, "") || "road-trip-itinerary";
    document.body.classList.add("print-layout-ready");
    return true;
  }

  function epCleanupPrintLayout() {
    document.body.classList.remove("print-layout-ready");
    if (epOriginalDocumentTitle) {
      document.title = epOriginalDocumentTitle;
      epOriginalDocumentTitle = "";
    }
  }

  async function epPrintTrip() {
    if (!state.routeCreated) {
      setStatus("exportStatus", "Build a route before printing the itinerary.", "warning");
      return;
    }
    epPreparePrintLayout();
    const printMapContainer = epById("printRouteOverview");
    const tileUrls = Array.isArray(printMapContainer?._printTileUrls) ? printMapContainer._printTileUrls : [];
    setStatus("exportStatus", "Preparing the OpenStreetMap background for the PDF…", "info");
    const tileResult = await epWaitForPrintMapTiles(tileUrls);
    if (tileResult.loaded === 0 && tileResult.total > 0) {
      setStatus("exportStatus", "The PDF was not opened because no map tiles loaded. Confirm the live map is visible, check internet access, and press Print / save formatted PDF again.", "error");
      return;
    }
    const tileMessage = tileResult.failed > 0 || tileResult.timedOut
      ? `Map ready with ${tileResult.loaded} of ${tileResult.total} tiles. Opening the formatted print view; choose Save as PDF.`
      : `Map ready (${tileResult.loaded} tiles loaded). Opening the formatted print view; choose Save as PDF.`;
    setStatus("exportStatus", tileMessage, tileResult.loaded === tileResult.total ? "success" : "warning");
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.print();
  }

  window.addEventListener("beforeprint", epPreparePrintLayout);
  window.addEventListener("afterprint", epCleanupPrintLayout);

  function epInstallEventListeners() {
    document.querySelectorAll("[data-app-tab-button]").forEach((button) => button.addEventListener("click", () => epApplyTab(button.dataset.appTabButton)));
    epById("saveTripBtn")?.addEventListener("click", epSaveTrip);
    epById("loadTripBtn")?.addEventListener("click", epLoadSavedTrip);
    epById("duplicateTripBtn")?.addEventListener("click", epDuplicateTrip);
    epById("deleteTripBtn")?.addEventListener("click", epDeleteSavedTrip);
    epById("newTripBtn")?.addEventListener("click", epNewTrip);
    epById("exportTripJsonBtn")?.addEventListener("click", epExportTripJson);
    epById("shareTripBtn")?.addEventListener("click", epCreateShareLink);
    epById("importTripFile")?.addEventListener("change", (event) => epImportTripFile(event.target.files?.[0]));
    epById("findFuelLongestLegBtn")?.addEventListener("click", epFindFuelOnLongestLeg);
    epById("compareWholeRouteBtn")?.addEventListener("click", epCompareWholeRoute);
    epById("printTripBtn")?.addEventListener("click", epPrintTrip);
    epById("exportCsvBtn")?.addEventListener("click", epExportCsv);
    epById("exportCalendarBtn")?.addEventListener("click", epExportCalendar);
    epById("exportTextBtn")?.addEventListener("click", epExportText);
    epById("retryRoadRouteBtn")?.addEventListener("click", () => {
      const routeKey = buildRouteKey(getRoutePoints());
      state.roadRouteCache.delete(routeKey);
      state.roadRouteFailureUntil?.delete(routeKey);
      scheduleRoadRoute(getRoutePoints());
      epLog("Road route retry requested.", "info");
    });
    epById("retryRouteSearchBtn")?.addEventListener("click", () => searchAlongRoute());
    epById("clearServiceCachesBtn")?.addEventListener("click", () => {
      state.roadRouteCache.clear();
      state.roadRouteFailureUntil?.clear();
      state.routeSearchCache.clear();
      state.geocodeCache.clear();
      state.overnightLodgingCache.clear();
      epLog("Routing, route-search, geocoding and lodging caches cleared.", "info");
      renderAll({ fitMap: false });
    });

    const scheduleDateField = epById("departureDate");
    const exportDateField = epById("exportDepartureDate");
    scheduleDateField?.addEventListener("input", () => {
      if (exportDateField) exportDateField.value = scheduleDateField.value;
    });
    exportDateField?.addEventListener("input", () => {
      if (scheduleDateField) scheduleDateField.value = exportDateField.value;
      state.enhanced.departureDate = exportDateField.value;
    });

    ["departureDate", "exportDepartureDate", "dailyDepartureTime", "latestArrivalTime", "breakEveryHours", "breakMinutes", "mealBreakMinutes", "vehicleMpg", "tankGallons", "fuelReservePercent", "fuelPrice", "maxFuelGap", "routeStyle", "enhancedTripName"].forEach((id) => {
      epById(id)?.addEventListener("change", () => {
        epReadEnhancedControls();
        if (state.routeCreated) renderAll({ fitMap: false });
        else epAfterRender();
      });
    });

    epById("itineraryContent")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-enhanced-action]");
      if (!button) return;
      const stopId = button.dataset.stopId;
      if (button.dataset.enhancedAction === "move-up") epMoveStop(stopId, -1);
      if (button.dataset.enhancedAction === "move-down") epMoveStop(stopId, 1);
    });

    epById("itineraryContent")?.addEventListener("change", (event) => {
      const target = event.target;
      if (target.matches("[data-enhanced-lock]")) {
        const stop = state.routeStops.find((item) => item.id === target.dataset.enhancedLock);
        if (stop) { stop.locked = target.checked; renderItinerary(); }
      }
      if (target.matches("[data-enhanced-priority]")) {
        const stop = state.routeStops.find((item) => item.id === target.dataset.enhancedPriority);
        if (stop) { stop.priorityLevel = target.value; renderItinerary(); }
      }
      if (target.matches("[data-enhanced-visit-style]")) {
        const stop = state.routeStops.find((item) => item.id === target.dataset.enhancedVisitStyle);
        if (stop) {
          stop.visitStyle = target.value;
          if (target.value === "passThrough") stop.days = 0;
          else if (Number(stop.days) < 1) stop.days = 1;
          renderAll({ fitMap: false });
        }
      }
      if (target.matches("[data-enhanced-planned-duration]")) {
        const stop = state.plannedDriveStops.find((item) => item.id === target.dataset.enhancedPlannedDuration);
        if (stop) { stop.durationMinutes = Number(target.value); renderItinerary(); }
      }
      if (target.matches("[data-stop-detail]")) {
        const details = epDetailsForStop(target.dataset.stopDetailId);
        details[target.dataset.stopDetail] = target.value;
        epRenderExportPreview();
      }
    });

    epById("itineraryContent")?.addEventListener("input", (event) => {
      const target = event.target;
      if (target.matches("[data-enhanced-planned-note]")) {
        const stop = state.plannedDriveStops.find((item) => item.id === target.dataset.enhancedPlannedNote);
        if (stop) stop.planningNotes = target.value;
      }
      if (target.matches("[data-stop-detail]")) {
        const details = epDetailsForStop(target.dataset.stopDetailId);
        details[target.dataset.stopDetail] = target.value;
      }
    });

    epById("itineraryContent")?.addEventListener("dragstart", (event) => {
      const card = event.target.closest(".itinerary-stop[data-stop-id]");
      if (!card || card.classList.contains("disabled-stop")) return;
      epDragStopId = card.dataset.stopId;
      card.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", epDragStopId);
    });
    epById("itineraryContent")?.addEventListener("dragover", (event) => {
      const card = event.target.closest(".itinerary-stop[data-stop-id]");
      if (!card || card.dataset.stopId === epDragStopId) return;
      event.preventDefault();
      document.querySelectorAll(".itinerary-stop.drag-target").forEach((item) => item.classList.remove("drag-target"));
      card.classList.add("drag-target");
    });
    epById("itineraryContent")?.addEventListener("drop", (event) => {
      const card = event.target.closest(".itinerary-stop[data-stop-id]");
      if (!card) return;
      event.preventDefault();
      epReorderStopBefore(epDragStopId || event.dataTransfer.getData("text/plain"), card.dataset.stopId);
      epDragStopId = "";
    });
    epById("itineraryContent")?.addEventListener("dragend", () => {
      epDragStopId = "";
      document.querySelectorAll(".itinerary-stop.dragging,.itinerary-stop.drag-target").forEach((item) => item.classList.remove("dragging", "drag-target"));
    });

    epById("routeQuestionResults")?.addEventListener("click", (event) => {
      const button = event.target.closest('button[data-route-result-action="plan"]');
      if (!button) return;
      const card = button.closest("[data-route-result-index]");
      if (!card) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const duration = card.querySelector("[data-route-result-duration]")?.value || epDefaultDuration(state.routeSearchResults[Number(card.dataset.routeResultIndex)]?.category);
      epAddRouteResultWithDuration(Number(card.dataset.routeResultIndex), duration);
    }, true);
  }

  function epTagCoreSectionsForTabs() {
    const groups = {
      browse: "explore",
      trip: "plan",
      route: "plan",
      "route-assistant": "explore",
      summary: "itinerary",
      itinerary: "itinerary",
      custom: "explore",
      suggestions: "explore"
    };
    Object.entries(groups).forEach(([sectionId, tab]) => {
      document.querySelector(`.collapsible-card[data-section-id="${sectionId}"]`)?.setAttribute("data-app-tab", tab);
    });
  }

  function epRestoreDraftOffer() {
    if (location.hash.startsWith("#trip=")) return;
    try {
      const draft = JSON.parse(localStorage.getItem(EP_DRAFT_KEY) || "null");
      if (!draft?.routeCreated) return;
      const age = Date.now() - new Date(draft.savedAt || 0).getTime();
      if (age > 1000 * 60 * 60 * 24 * 14) return;
      const status = epById("tripLibraryStatus");
      if (!status) return;
      status.className = "status show info";
      status.innerHTML = `A recent unsaved draft is available. <button class="btn-light btn-small" type="button" id="restoreDraftBtn">Restore draft</button>`;
      epById("restoreDraftBtn")?.addEventListener("click", () => epLoadSnapshot(draft));
    } catch (_) { /* optional draft */ }
  }

  document.addEventListener("DOMContentLoaded", () => {
    epEnsureState();
    epInstallFunctionWrappers();
    epInstallRebuildButton();
    epInstallEventListeners();
    epTagCoreSectionsForTabs();
    epWriteEnhancedControls();
    epRefreshSavedTripSelect();
    const loadedShare = epLoadHashTrip();
    if (!loadedShare) epRestoreDraftOffer();
    epAfterRender();
    epLog("Complete-planner enhancement layer loaded.", "success");
  });
})();
