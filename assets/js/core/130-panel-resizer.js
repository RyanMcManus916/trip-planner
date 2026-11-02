"use strict";

/* ---------------------------------------------------------------------
       User-resizable desktop planner panel
       --------------------------------------------------------------------- */
    const PLANNER_WIDTH_DEFAULT = 500;
    const PLANNER_WIDTH_MIN = 360;
    const PLANNER_WIDTH_MAX = 720;
    const PLANNER_WIDTH_STORAGE_KEY = 'trailPlannerPanelWidth';

    function getPlannerWidthBounds() {
      const minimum = PLANNER_WIDTH_MIN;
      // Always preserve a useful map area, even on narrower desktop screens.
      const availableMaximum = Math.max(minimum, window.innerWidth - 420);
      return {
        minimum,
        maximum: Math.min(PLANNER_WIDTH_MAX, availableMaximum)
      };
    }

    function readStoredPlannerWidth() {
      try {
        const value = Number(window.localStorage.getItem(PLANNER_WIDTH_STORAGE_KEY));
        return Number.isFinite(value) ? value : PLANNER_WIDTH_DEFAULT;
      } catch (error) {
        return PLANNER_WIDTH_DEFAULT;
      }
    }

    function persistPlannerWidth(width) {
      try {
        window.localStorage.setItem(PLANNER_WIDTH_STORAGE_KEY, String(Math.round(width)));
      } catch (error) {
        // The resize control still works when local storage is unavailable.
      }
    }

    function setPlannerWidth(width, { persist = false, refreshMap = true } = {}) {
      if (window.innerWidth <= 820) return;
      const shell = document.querySelector('.app-shell');
      const resizer = $('panelResizer');
      if (!shell || !resizer) return;
      const bounds = getPlannerWidthBounds();
      const clampedWidth = clamp(Number(width) || PLANNER_WIDTH_DEFAULT, bounds.minimum, bounds.maximum);
      shell.style.setProperty('--planner-width', `${Math.round(clampedWidth)}px`);
      resizer.setAttribute('aria-valuemin', String(Math.round(bounds.minimum)));
      resizer.setAttribute('aria-valuemax', String(Math.round(bounds.maximum)));
      resizer.setAttribute('aria-valuenow', String(Math.round(clampedWidth)));
      resizer.setAttribute('aria-valuetext', `${Math.round(clampedWidth)} pixels wide`);
      if (persist) persistPlannerWidth(clampedWidth);
      if (refreshMap && state.map) {
        window.requestAnimationFrame(() => state.map.invalidateSize());
      }
    }

    function initializePlannerResizer() {
      const resizer = $('panelResizer');
      const planner = document.querySelector('.planner-panel');
      if (!resizer || !planner) return;

      setPlannerWidth(readStoredPlannerWidth(), { persist: false, refreshMap: false });

      let activePointerId = null;
      let startX = 0;
      let startWidth = 0;

      function finishResize(event) {
        if (activePointerId === null) return;
        if (event && resizer.hasPointerCapture?.(activePointerId)) {
          resizer.releasePointerCapture(activePointerId);
        }
        activePointerId = null;
        document.body.classList.remove('is-resizing-panel');
        const currentWidth = planner.getBoundingClientRect().width;
        setPlannerWidth(currentWidth, { persist: true });
      }

      resizer.addEventListener('pointerdown', (event) => {
        if (window.innerWidth <= 820 || document.querySelector('.app-shell')?.classList.contains('panel-collapsed')) return;
        activePointerId = event.pointerId;
        startX = event.clientX;
        startWidth = planner.getBoundingClientRect().width;
        resizer.setPointerCapture(event.pointerId);
        document.body.classList.add('is-resizing-panel');
        event.preventDefault();
      });

      resizer.addEventListener('pointermove', (event) => {
        if (activePointerId !== event.pointerId) return;
        setPlannerWidth(startWidth + (event.clientX - startX), { persist: false });
      });

      resizer.addEventListener('pointerup', finishResize);
      resizer.addEventListener('pointercancel', finishResize);

      resizer.addEventListener('dblclick', () => {
        setPlannerWidth(PLANNER_WIDTH_DEFAULT, { persist: true });
        setStatus('plannerStatus', 'Planner panel width reset.', 'info');
      });

      resizer.addEventListener('keydown', (event) => {
        if (window.innerWidth <= 820) return;
        const currentWidth = planner.getBoundingClientRect().width;
        const bounds = getPlannerWidthBounds();
        let nextWidth = null;
        const step = event.shiftKey ? 50 : 20;
        if (event.key === 'ArrowLeft') nextWidth = currentWidth - step;
        if (event.key === 'ArrowRight') nextWidth = currentWidth + step;
        if (event.key === 'Home') nextWidth = bounds.minimum;
        if (event.key === 'End') nextWidth = bounds.maximum;
        if (nextWidth === null) return;
        event.preventDefault();
        setPlannerWidth(nextWidth, { persist: true });
      });

      window.addEventListener('resize', () => {
        if (window.innerWidth > 820) {
          const currentWidth = Number.parseFloat(getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--planner-width'));
          setPlannerWidth(currentWidth || readStoredPlannerWidth(), { persist: false });
        } else if (state.map) {
          window.requestAnimationFrame(() => state.map.invalidateSize());
        }
      });
    }
